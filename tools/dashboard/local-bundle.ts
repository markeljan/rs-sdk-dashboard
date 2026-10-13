// local-bundle.ts - serve this fork's bot client bundle (server/webclient/out/bot/client.js) to managed clients whose
// page comes from the game host. The host's /bot/client.js lacks fork-only actions (e.g. useItemOnGroundItem /
// OPOBJU, needed by Clock Tower's black cog), so drivers using them fail on managed accounts.
//
// Revision guard: a bundle built for another client revision cannot log in (a stale rev-274 build failed against the
// rev-289 server, 2026-10-12). The revision is the constant in `loginout.p2(<rev>)` (CLIENT_VERSION in
// server/webclient/src/client/Client.ts), present in both minified bundles. The local bundle is only served when its
// revision equals the host bundle's; otherwise the host bundle is used and a WARNING is logged. On a mismatch where
// the fork's source already has the host revision, the bundle is rebuilt once in the background
// (LOCAL_BOT_BUNDLE_REBUILD=0 disables that).
//
// Env: LOCAL_BOT_BUNDLE=0 disables the override (default on).
// Build by hand: bun tools/dashboard/build-bot-bundle.ts   (= cd server/webclient && BUILD_MODE=bot bun run bundle.ts)
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

export const ROOT = resolve(import.meta.dir, '../..');
export const WEBCLIENT_DIR = join(ROOT, 'server/webclient');
export const LOCAL_BUNDLE_PATH = join(WEBCLIENT_DIR, 'out/bot/client.js');
export const CLIENT_SOURCE_PATH = join(WEBCLIENT_DIR, 'src/client/Client.ts');
export const LOCAL_BUNDLE_ENABLED = process.env.LOCAL_BOT_BUNDLE !== '0';
const REBUILD_ENABLED = process.env.LOCAL_BOT_BUNDLE_REBUILD !== '0';
/** Fork-only client method: present on window.gameClient only when the page runs this fork's bundle. */
export const FORK_MARKER_JS = `typeof window.gameClient?.useItemOnGroundItem === 'function'`;
/** Matches the bot bundle request however the page spells it (`./bot/client.js?v=...`). */
export const BUNDLE_URL_PATTERN = '*/bot/client.js*';

export function bundleRevision(src: string): number | null {
    const m = /loginout\.p2\((\d+)\)/.exec(src);
    return m ? Number(m[1]) : null;
}
export function sourceRevision(): number | null {
    try { const m = /const CLIENT_VERSION\s*=\s*(\d+)/.exec(readFileSync(CLIENT_SOURCE_PATH, 'utf8')); return m ? Number(m[1]) : null; } catch { return null; }
}

type Local = { mtimeMs: number; size: number; rev: number | null; base64: string };
type HostRev = { rev: number | null; at: number };
export type BundleDecision = { serve: true; base64: string; rev: number } | { serve: false; reason: string };

const HOST_TTL_MS = 10 * 60_000;
const SETTLE_MS = 10_000; // never read a bundle the build is still writing

export class LocalBundle {
    private local: Local | null = null;
    private host = new Map<string, HostRev>();
    private hostFetch = new Map<string, Promise<HostRev>>();
    private lastNote = '';
    private rebuilding: Promise<void> | null = null;
    private rebuildTriedFor = '';

    constructor(private log: (...a: unknown[]) => void = console.log, readonly path = LOCAL_BUNDLE_PATH, private enabled = LOCAL_BUNDLE_ENABLED) {}

    private note(msg: string) { if (msg !== this.lastNote) { this.lastNote = msg; this.log(msg); } }

    private readLocal(): Local | null {
        if (!existsSync(this.path)) return null;
        const st = statSync(this.path);
        if (this.local && this.local.mtimeMs === st.mtimeMs && this.local.size === st.size) return this.local;
        if (Date.now() - st.mtimeMs < SETTLE_MS) return this.local; // mid-build: keep the previous copy (null on first sight)
        const buf = readFileSync(this.path);
        this.local = { mtimeMs: st.mtimeMs, size: st.size, rev: bundleRevision(buf.toString('utf8')), base64: buf.toString('base64') };
        return this.local;
    }

    async hostRevision(origin: string): Promise<number | null> {
        const cached = this.host.get(origin);
        if (cached && cached.rev != null && Date.now() - cached.at < HOST_TTL_MS) return cached.rev;
        let p = this.hostFetch.get(origin);
        if (!p) {
            p = (async () => {
                try {
                    const r = await fetch(`${origin}/bot/client.js`, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const v = { rev: bundleRevision(await r.text()), at: Date.now() };
                    this.host.set(origin, v);
                    return v;
                } catch (e) {
                    this.log(`local bot bundle: could not read ${origin}/bot/client.js revision (${e instanceof Error ? e.message : e})`);
                    return cached ?? { rev: null, at: 0 }; // keep the last known revision through a blip
                } finally { this.hostFetch.delete(origin); }
            })();
            this.hostFetch.set(origin, p);
        }
        return (await p).rev;
    }

    /** What to serve for `origin`'s /bot/client.js right now. Never throws. */
    async decide(origin: string): Promise<BundleDecision> {
        if (!this.enabled) return { serve: false, reason: 'LOCAL_BOT_BUNDLE=0' };
        try {
            const hostRev = await this.hostRevision(origin);
            const local = this.readLocal();
            let reason = '';
            if (hostRev == null) reason = `host revision unknown (${origin})`;
            else if (!local) reason = `${this.path} missing`;
            else if (local.rev == null) reason = `no revision found in ${this.path}`;
            else if (local.rev !== hostRev) reason = `local build is rev ${local.rev}, host is rev ${hostRev}`;
            if (!reason && local && hostRev != null) {
                this.note(`local bot bundle: serving ${this.path} (rev ${local.rev} = host rev ${hostRev}, built ${new Date(local.mtimeMs).toLocaleString()})`);
                return { serve: true, base64: local.base64, rev: hostRev };
            }
            this.note(`WARNING local bot bundle NOT served - ${reason}; managed clients fall back to the host bundle (fork-only actions such as useItemOnGroundItem will fail). Rebuild: bun tools/dashboard/build-bot-bundle.ts`);
            if (hostRev != null) this.maybeRebuild(hostRev);
            return { serve: false, reason };
        } catch (e) {
            return { serve: false, reason: `error: ${e instanceof Error ? e.message : e}` };
        }
    }

    /** Rebuild once per host revision, and only when the fork's source is already at that revision. */
    private maybeRebuild(hostRev: number) {
        if (!REBUILD_ENABLED || this.rebuilding || this.path !== LOCAL_BUNDLE_PATH) return;
        const src = sourceRevision();
        const key = `${hostRev}:${src}`;
        if (this.rebuildTriedFor === key) return;
        this.rebuildTriedFor = key;
        if (src !== hostRev) { this.log(`WARNING local bot bundle: fork source is rev ${src}, host is rev ${hostRev} - not rebuilding (needs an upstream sync)`); return; }
        this.log(`local bot bundle: rebuilding for rev ${hostRev} (BUILD_MODE=bot bun run bundle.ts)`);
        this.rebuilding = buildBotBundle().then(ok => this.log(`local bot bundle: rebuild ${ok ? 'finished' : 'FAILED'}`)).finally(() => { this.rebuilding = null; });
    }
}

/** `cd server/webclient && BUILD_MODE=bot bun run bundle.ts` (production, minified). */
export async function buildBotBundle(): Promise<boolean> {
    const p = Bun.spawn(['bun', 'run', 'bundle.ts'], { cwd: WEBCLIENT_DIR, env: { ...process.env, BUILD_MODE: 'bot' }, stdout: 'inherit', stderr: 'inherit' });
    return (await p.exited) === 0;
}

/** Keep `page`'s /bot/client.js on the local bundle for every load of this page (reload, navigation) until the
 *  CDP session ends. Requests continue to the host whenever `decide` says no (e.g. `() => bundle.decide(origin)`). Returns the CDP session. */
export async function interceptBundle(page: any, decide: () => Promise<BundleDecision>, onServed?: (served: boolean, why: string) => void): Promise<any> {
    const c = await page.createCDPSession();
    c.on('Fetch.requestPaused', async (e: any) => {
        let d: BundleDecision = { serve: false, reason: 'not handled' };
        try {
            d = await decide();
            if (d.serve) {
                await c.send('Fetch.fulfillRequest', {
                    requestId: e.requestId, responseCode: 200,
                    responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }, { name: 'Cache-Control', value: 'no-store' }],
                    body: d.base64,
                });
                onServed?.(true, `rev ${d.rev}`);
                return;
            }
        } catch { /* fall through to the host bundle */ }
        await c.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
        onServed?.(false, d.serve ? 'fulfill failed' : d.reason);
    });
    await c.send('Fetch.enable', { patterns: [{ urlPattern: BUNDLE_URL_PATTERN, requestStage: 'Request' }] });
    return c;
}
