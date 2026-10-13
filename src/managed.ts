// A game client the dashboard runs for an account: headless Chrome on the rs-sdk web client (/bot?bot=&password=).
// The gateway sees it like any browser tab, so the account's bot scripts and agents drive it as usual, and it keeps
// running when your own computer sleeps (hosted mode). While someone watches, the canvas is captured as JPEG frames;
// viewers' clicks and keys are replayed into the page.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome } from './chrome';
import { clientUrl } from './gateway';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, sleep(ms).then(() => fallback)]);

export type ClientState = 'stopped' | 'starting' | 'running' | 'error';
export type InputEvent =
    | { kind: 'click' | 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' }
    | { kind: 'key'; key: string; action?: 'down' | 'up' | 'press'; holdMs?: number }
    | { kind: 'text'; text: string; enter?: boolean }
    | { kind: 'releaseAll' };

export type ManagedOptions = {
    dataDir: string; chromePath: string; fps: number; idleFps: number; quality: number;
    log: (msg: string) => void;
};

export class ManagedClient {
    state: ClientState = 'stopped';
    error = '';
    wanted = false;
    startedAt = 0;
    loadedAt = 0;
    inGame = false;
    restarts = 0;
    private browser: any = null;
    private page: any = null;
    private captureTimer: ReturnType<typeof setInterval> | null = null;
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private relaunchTimer: ReturnType<typeof setTimeout> | null = null;
    private capturing = false;
    private lastCaptureAt = 0;
    private notInGameSince = 0;
    private reloads: number[] = [];
    private canvasInfo: { box: { x: number; y: number; width: number; height: number }; w: number; h: number; at: number } | null = null;
    private mouseAt: { x: number; y: number } | null = null;
    private mouseHeld: 'left' | 'right' | null = null;
    private held = new Map<string, ReturnType<typeof setTimeout>>();
    private inputChain: Promise<any> = Promise.resolve();
    private gameFps: number | null = null;
    private boostUntil = 0;
    viewers = 0;

    constructor(
        readonly key: string,
        private creds: () => { name: string; password: string; server: string },
        private opts: ManagedOptions,
        private onFrame: (jpeg: Buffer, w: number, h: number) => void,
        private onChange: () => void,
    ) {}

    info() {
        return { state: this.state, error: this.error, startedAt: this.startedAt, inGame: this.inGame, restarts: this.restarts, viewers: this.viewers };
    }

    private log(m: string) { this.opts.log(`[client ${this.creds().name}] ${m}`); }
    private profileDir() { return join(this.opts.dataDir, 'chrome-profiles', this.key); }

    async start() {
        this.wanted = true;
        if (this.state === 'starting' || this.state === 'running') return;
        this.state = 'starting'; this.error = ''; this.onChange();
        try {
            const puppeteer = (await import('puppeteer-core')).default;
            const executablePath = await findChrome(this.opts.dataDir, this.opts.chromePath);
            mkdirSync(this.profileDir(), { recursive: true });
            this.browser = await puppeteer.launch({
                executablePath, headless: true, userDataDir: this.profileDir(), defaultViewport: { width: 1000, height: 700 },
                // The game draws into a 2D canvas: GPU process, extensions and caches are pure overhead.
                args: ['--no-sandbox', '--mute-audio', '--disable-gpu', '--disable-extensions', '--disable-component-update',
                    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows', '--disk-cache-size=1', '--no-first-run', '--window-size=1000,700'],
            });
            const browser = this.browser;
            browser.on('disconnected', () => {
                if (this.browser !== browser) return;
                this.browser = null; this.page = null; this.resetInput();
                if (this.wanted) { this.state = 'error'; this.error = 'browser exited'; this.log('browser exited - relaunching'); this.scheduleRelaunch(5000); }
                else this.state = 'stopped';
                this.onChange();
            });
            this.page = (await browser.pages())[0] ?? await browser.newPage();
            const c = this.creds();
            await this.page.goto(clientUrl(c.server, c.name, c.password), { waitUntil: 'domcontentloaded', timeout: 60_000 });
            this.startedAt = Date.now(); this.loadedAt = Date.now(); this.notInGameSince = 0; this.gameFps = null;
            this.state = 'running';
            this.log('started');
            this.syncCapture();
            this.healthTimer ??= setInterval(() => void this.health(), 10_000);
        } catch (e) {
            this.error = errMsg(e); this.state = 'error';
            this.log(`start failed: ${this.error}`);
            await this.closeBrowser();
            if (this.wanted) this.scheduleRelaunch(20_000);
        }
        this.onChange();
    }

    private scheduleRelaunch(ms: number) {
        if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
        this.relaunchTimer = setTimeout(() => {
            this.relaunchTimer = null;
            if (this.wanted && this.state !== 'running' && this.state !== 'starting') { this.restarts++; void this.start(); }
        }, ms);
    }

    async stop() {
        this.wanted = false;
        if (this.relaunchTimer) { clearTimeout(this.relaunchTimer); this.relaunchTimer = null; }
        if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
        if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
        await this.closeBrowser();
        this.state = 'stopped'; this.inGame = false;
        this.log('stopped');
        this.onChange();
    }

    /** Stop and delete the browser profile (account removed). */
    async destroy() { await this.stop(); rmSync(this.profileDir(), { recursive: true, force: true }); }

    private async closeBrowser() {
        const b = this.browser;
        this.browser = null; this.page = null; this.resetInput();
        if (b) await withTimeout(b.close().catch(() => {}), 5000, undefined);
    }
    private resetInput() {
        this.canvasInfo = null; this.mouseAt = null; this.mouseHeld = null; this.gameFps = null;
        for (const t of this.held.values()) clearTimeout(t);
        this.held.clear();
    }

    async relaunch() { this.restarts++; await this.closeBrowser(); this.state = 'stopped'; if (this.wanted) await this.start(); }

    async reload() {
        if (!this.page) return this.start();
        this.reloads.push(Date.now()); this.resetInput();
        this.log('reloading page');
        try { await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); this.loadedAt = Date.now(); this.notInGameSince = 0; }
        catch (e) { this.error = errMsg(e); }
    }

    /** Relaunch a dead page; reload a page that hasn't been in game for 90 s (gateway restarts, kicked sessions). */
    private async health() {
        if (!this.wanted || this.state === 'starting') return;
        if (!this.browser?.connected || !this.page) { this.log('not connected - relaunching'); return void this.relaunch(); }
        const ingame = await withTimeout(this.page.evaluate(() => !!(window as any).gameClient?.ingame).catch(() => null), 8000, null);
        if (ingame === null) { this.log('page unresponsive - relaunching'); return void this.relaunch(); }
        if (ingame !== this.inGame) { this.inGame = ingame; this.onChange(); }
        this.gameFps = null; void this.applyGameFps();
        const now = Date.now();
        if (ingame) { this.notInGameSince = 0; return; }
        this.notInGameSince ||= now;
        if (now - this.notInGameSince < 90_000 || now - this.loadedAt < 90_000) return;
        this.reloads = this.reloads.filter(t => now - t < 15 * 60_000);
        if (this.reloads.length >= 3) { this.log('not in game after 3 reloads - relaunching browser'); this.reloads = []; return void this.relaunch(); }
        this.log('not in game for 90s - reloading');
        await this.reload();
    }

    setViewers(n: number) { this.viewers = n; this.syncCapture(); }

    private syncCapture() {
        const want = !!this.page && this.viewers > 0;
        if (want && !this.captureTimer) this.captureTimer = setInterval(() => void this.captureTick(), 1000 / 30);
        else if (!want && this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
        void this.applyGameFps();
    }

    /** Watched clients render at the stream rate; idle ones at idleFps (game logic is unaffected). */
    private async applyGameFps() {
        const page = this.page;
        const want = this.viewers > 0 || Date.now() < this.boostUntil ? Math.max(this.opts.fps, 20) : this.opts.idleFps;
        if (!page || this.gameFps === want) return;
        const ok = await withTimeout(page.evaluate((f: number) => {
            const g = (window as any).gameClient; if (!g || typeof g.tfps !== 'number') return false; g.tfps = f; return true;
        }, want).catch(() => false), 3000, false);
        if (ok && this.page === page) this.gameFps = want;
    }

    private async captureTick() {
        const page = this.page;
        if (!page || this.capturing || this.viewers === 0) return;
        const now = Date.now();
        if (now - this.lastCaptureAt < 1000 / this.opts.fps - 4) return;
        this.lastCaptureAt = now; this.capturing = true;
        try {
            const r = await withTimeout(page.evaluate((q: number) => {
                const c = (document.getElementById('canvas') || document.querySelector('canvas')) as HTMLCanvasElement | null;
                return c && c.width ? { d: c.toDataURL('image/jpeg', q / 100), w: c.width, h: c.height } : null;
            }, this.opts.quality).catch(() => null), 3000, null) as { d: string; w: number; h: number } | null;
            if (r) this.onFrame(Buffer.from(r.d.slice(r.d.indexOf(',') + 1), 'base64'), r.w, r.h);
        } finally { this.capturing = false; }
    }

    private async canvas() {
        if (this.canvasInfo && Date.now() - this.canvasInfo.at < 3000) return this.canvasInfo;
        const h = (await this.page.$('#canvas')) ?? (await this.page.$('canvas'));
        if (!h) throw new Error('no game canvas yet');
        const box = await h.boundingBox();
        const dims = await this.page.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height }), h);
        if (!box) throw new Error('canvas not visible');
        this.canvasInfo = { box, w: dims.w, h: dims.h, at: Date.now() };
        return this.canvasInfo;
    }

    private keyName(k: string) {
        const map: Record<string, string> = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', esc: 'Escape', escape: 'Escape',
            enter: 'Enter', space: 'Space', ' ': 'Space', backspace: 'Backspace', tab: 'Tab', delete: 'Delete', ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt' };
        return map[k.toLowerCase()] ?? map[k] ?? k;
    }

    // Puppeteer rolls a failed mouse.up back to "pressed", after which every mouse.down throws: self-heal.
    private async press(button: 'left' | 'right') {
        try { await this.page.mouse.down({ button }); }
        catch (e) { if (!/already pressed/.test(errMsg(e))) throw e; await this.release(button); await this.page.mouse.down({ button }); }
    }
    private async release(button: 'left' | 'right') {
        for (let i = 0; i < 2; i++) {
            try { await this.page.mouse.up({ button }); return; } catch (e) { if (/not pressed/.test(errMsg(e))) return; }
        }
        await this.page.mouse.reset().catch(() => {}); this.mouseAt = null;
    }

    /** x/y are 0..1 of the game canvas. Input is serialised so a quick double tap can't interleave down/up pairs. */
    input(ev: InputEvent): Promise<{ ok: boolean; error?: string }> {
        const run = async () => {
            const page = this.page;
            if (!page) return { ok: false, error: 'game client not running' };
            this.boostUntil = Date.now() + 120_000;
            const prevFps = this.gameFps ?? this.opts.idleFps;
            await this.applyGameFps();
            const frameMs = 1000 / Math.max(1, Math.min(prevFps, this.gameFps ?? prevFps));
            switch (ev.kind) {
                case 'click': case 'move': case 'down': case 'up': {
                    const c = await this.canvas();
                    const px = Math.min(c.w - 1, Math.max(0, Math.floor(ev.x * c.w))), py = Math.min(c.h - 1, Math.max(0, Math.floor(ev.y * c.h)));
                    const x = c.box.x + (px + 0.5) * c.box.width / c.w, y = c.box.y + (py + 0.5) * c.box.height / c.h;
                    const moved = !this.mouseAt || Math.abs(this.mouseAt.x - x) > 0.5 || Math.abs(this.mouseAt.y - y) > 0.5;
                    if (moved) { await page.mouse.move(x, y); this.mouseAt = { x, y }; }
                    if (ev.kind === 'move') return { ok: true };
                    // The game picks a click's action from the hover menu of the last drawn frame: let it redraw first.
                    if (moved && ev.kind !== 'up') await sleep(Math.max(90, Math.ceil(2 * frameMs) + 10));
                    const button = ev.button === 'right' ? 'right' : 'left';
                    if (ev.kind === 'down') { if (this.mouseHeld) await this.release(this.mouseHeld); await this.press(button); this.mouseHeld = button; return { ok: true }; }
                    if (ev.kind === 'up') { await this.release(this.mouseHeld ?? button); this.mouseHeld = null; return { ok: true }; }
                    if (this.mouseHeld) { await this.release(this.mouseHeld); this.mouseHeld = null; }
                    await this.press(button); await sleep(60); await this.release(button);
                    return { ok: true };
                }
                case 'key': {
                    const key = this.keyName(String(ev.key ?? ''));
                    if (!key) return { ok: false, error: 'no key' };
                    await page.evaluate(() => (document.getElementById('canvas') as HTMLElement | null)?.focus());
                    if (ev.action === 'down') {
                        clearTimeout(this.held.get(key));
                        if (!this.held.has(key)) await page.keyboard.down(key);
                        this.held.set(key, setTimeout(() => { this.held.delete(key); void page.keyboard.up(key).catch(() => {}); }, Math.min(10_000, Math.max(300, ev.holdMs || 1500))));
                    } else if (ev.action === 'up') {
                        clearTimeout(this.held.get(key)); this.held.delete(key);
                        await page.keyboard.up(key);
                    } else await page.keyboard.press(key);
                    return { ok: true };
                }
                case 'text': {
                    await page.evaluate(() => (document.getElementById('canvas') as HTMLElement | null)?.focus());
                    await page.keyboard.type(String(ev.text ?? '').slice(0, 120), { delay: 10 });
                    if (ev.enter) await page.keyboard.press('Enter');
                    return { ok: true };
                }
                case 'releaseAll':
                    for (const [k, t] of this.held) { clearTimeout(t); await page.keyboard.up(k).catch(() => {}); }
                    this.held.clear();
                    await page.mouse.reset().catch(() => {}); this.mouseHeld = null; this.mouseAt = null;
                    return { ok: true };
            }
            return { ok: false, error: 'unknown input kind' };
        };
        const p = this.inputChain.then(run, run).catch((e: unknown) => ({ ok: false, error: errMsg(e) }));
        this.inputChain = p;
        return p;
    }
}
