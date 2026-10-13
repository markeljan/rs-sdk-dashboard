// Dashboard side of the lite-view assets: a lazily started worker (assets-worker.ts) plus the HTTP handlers for
// /lite/*. Nothing runs until a viewer opens a lite account; rendered assets are cached in memory and on disk.
import { homedir } from 'os';
import { join } from 'path';

type Pending = { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> };
type Reply = { ok: boolean; data?: Uint8Array | string | null; meta?: any };

export class LiteAssets {
    private worker: Worker | null = null;
    private seq = 0;
    private pending = new Map<number, Pending>();
    private mem = new Map<string, { body: Uint8Array | string; type: string; meta?: string }>();
    private memBytes = 0;
    private failedAt = 0;
    private lastError = '';
    private lastUse = 0;
    private idleTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private opts: { root: string; origin: () => string | null; log: (m: string) => void; cacheDir?: string }) {}

    private start(): Worker | null {
        if (this.worker) return this.worker;
        if (Date.now() - this.failedAt < 60_000) return null;
        const origin = this.opts.origin();
        if (!origin) { this.lastError = 'no game server origin (bot.env SERVER)'; return null; }
        try {
            const w = new Worker(new URL('./assets-worker.ts', import.meta.url).href);
            w.onmessage = (e: MessageEvent) => {
                const p = this.pending.get(e.data.id);
                if (!p) return;
                this.pending.delete(e.data.id); clearTimeout(p.timer); p.resolve(e.data);
            };
            w.onerror = (e) => { this.lastError = String((e as ErrorEvent).message ?? e); this.opts.log(`lite assets worker error: ${this.lastError}`); this.stop(); this.failedAt = Date.now(); };
            w.postMessage({ type: 'init', cfg: { origin, cacheDir: this.opts.cacheDir ?? join(homedir(), '.cache', 'rs-sdk-lite'), root: this.opts.root } });
            this.worker = w;
            this.opts.log(`lite assets worker started (${origin})`);
            return w;
        } catch (e) {
            this.lastError = String((e as Error)?.message ?? e);
            this.failedAt = Date.now();
            return null;
        }
    }
    stop() {
        try { this.worker?.terminate(); } catch { /* */ }
        this.worker = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, data: 'worker stopped' }); }
        this.pending.clear();
    }
    private ask(msg: Record<string, unknown>, timeoutMs = 90_000): Promise<Reply> {
        this.lastUse = Date.now();
        // nobody watching a lite account for 10 min: drop the worker and its unpacked cache (disk cache stays)
        this.idleTimer ??= setInterval(() => {
            if (this.worker && !this.pending.size && Date.now() - this.lastUse > 600_000) { this.opts.log('lite assets worker idle - stopped'); this.stop(); }
        }, 60_000);
        const w = this.start();
        if (!w) return Promise.resolve({ ok: false, data: this.lastError || 'assets unavailable' });
        const id = ++this.seq;
        return new Promise((resolve) => {
            const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, data: 'timeout' }); }, timeoutMs);
            this.pending.set(id, { resolve, timer });
            w.postMessage({ ...msg, id });
        });
    }
    private remember(key: string, v: { body: Uint8Array | string; type: string; meta?: string }) {
        const size = typeof v.body === 'string' ? v.body.length : v.body.byteLength;
        this.mem.set(key, v); this.memBytes += size;
        // keep the memory cache bounded (~64 MB); oldest entries go first, the disk cache still has them
        for (const [k, old] of this.mem) {
            if (this.memBytes < 64e6) break;
            this.memBytes -= typeof old.body === 'string' ? old.body.length : old.body.byteLength;
            this.mem.delete(k);
        }
    }
    private async cached(key: string, type: string, msg: Record<string, unknown>): Promise<Response> {
        let hit = this.mem.get(key);
        if (!hit) {
            const r = await this.ask(msg);
            if (!r.ok || r.data == null) return new Response(String(r.data ?? 'not found'), { status: r.data === 'timeout' ? 504 : 404 });
            hit = { body: r.data, type, meta: r.meta ? JSON.stringify(r.meta) : undefined };
            this.remember(key, hit);
        }
        const headers: Record<string, string> = { 'content-type': hit.type, 'cache-control': 'private, max-age=86400' };
        if (hit.meta) headers['x-lite-meta'] = hit.meta;
        return new Response(hit.body, { headers });
    }

    /** /lite/ui.json, /lite/labels.json, /lite/if/<id>.json, /lite/icon/<obj>.png, /lite/{map,ground}/<mx>_<mz>.png, /lite/walls/<mx>_<mz>.json, /lite/model.png?spec= */
    async handle(path: string, url: URL): Promise<Response | null> {
        if (path === '/lite/ui.json') return this.cached('ui', 'application/json', { type: 'ui' });
        if (path === '/lite/labels.json') return this.cached('labels', 'application/json', { type: 'labels' });
        if (path === '/lite/overview.png') return this.cached('overview', 'image/png', { type: 'overview' });
        let m = /^\/lite\/if\/(\d+)\.json$/.exec(path);
        if (m) return this.cached(`if-${m[1]}`, 'application/json', { type: 'if', root: Number(m[1]) });
        m = /^\/lite\/icon\/(\d+)\.png$/.exec(path);
        if (m) return this.cached(`icon-${m[1]}`, 'image/png', { type: 'icon', obj: Number(m[1]) });
        m = /^\/lite\/(map|ground)\/(\d+)_(\d+)\.png$/.exec(path);
        if (m) return this.cached(`${m[1]}-${m[2]}_${m[3]}`, 'image/png', { type: 'map', mx: Number(m[2]), mz: Number(m[3]), terrain: m[1] === 'ground' });
        m = /^\/lite\/walls\/(\d+)_(\d+)\.json$/.exec(path);
        if (m) return this.cached(`walls-${m[1]}_${m[2]}`, 'application/json', { type: 'walls', mx: Number(m[1]), mz: Number(m[2]) });
        if (path === '/lite/model.png') {
            let spec: any;
            try { spec = JSON.parse(url.searchParams.get('spec') ?? ''); } catch { return new Response('bad spec', { status: 400 }); }
            if (!spec || !['player', 'npc', 'loc'].includes(spec.kind)) return new Response('bad spec', { status: 400 });
            const clean = spec.kind === 'player'
                ? { kind: 'player', equip: (Array.isArray(spec.equip) ? spec.equip : []).slice(0, 14).map((e: any) => [Number(e?.[0]) | 0, Number(e?.[1]) | 0]), seed: String(spec.seed ?? '').slice(0, 40), seq: Number(spec.seq) | 0, dir: Number(spec.dir) & 7 }
                : { kind: spec.kind, id: Number(spec.id) | 0, seq: Number(spec.seq ?? -1) | 0, dir: Number(spec.dir) & 7 };
            return this.cached(`model-${JSON.stringify(clean)}`, 'image/png', { type: 'model', spec: clean });
        }
        return null;
    }
}
