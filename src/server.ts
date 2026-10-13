// HTTP + WebSocket server. Same code for both modes:
//   local  - one implicit user; optional RSD_PASSWORD; accounts also come from env / file / rs-sdk checkout
//   hosted - email + password sign-up, per-user accounts, limits on game clients
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import type { Config } from './config';
import { loadKey, randomAlnum } from './crypto';
import { Store, type User } from './db';
import { endpointsFor, fetchChat, say } from './gateway';
import { parseBotEnv, parseEnvAccounts, readAccountsFile, scanRsSdk, tailLog } from './importers';
import type { InputEvent } from './managed';
import { type AccountRuntime, Fleet, type Viewer } from './runtime';

const PUBLIC_DIR = join(import.meta.dir, '..', 'public');
const VERSION = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version as string;
const COOKIE = 'rsd_session';
const NAME_RE = /^[a-zA-Z0-9 _-]{1,12}$/;

const redact = (s: string) => s.replace(/(password=)[^&\s"']+/gi, '$1***');
export const makeLog = () => (m: string) => console.log(`${new Date().toISOString()} ${redact(m)}`);

type WsData = { user: User; watching: number | null; viewer: Viewer | null };

export function startServer(cfg: Config) {
    const log = makeLog();
    const key = loadKey(cfg.dataDir, cfg.secret);
    const store = new Store(cfg.dataDir, key);
    const fleet = new Fleet(store, cfg, log);
    const localUser = cfg.mode === 'local' ? store.ensureLocalUser() : null;

    // ------------------------------------------------------------ onboarding without the UI (local mode)
    if (localUser) {
        const imported = [
            ...parseEnvAccounts(cfg.envAccounts, cfg.defaultServer).map(a => ({ ...a, source: 'env' as const })),
            ...(cfg.accountsFile && existsSync(cfg.accountsFile) ? readAccountsFile(cfg.accountsFile, cfg.defaultServer, cfg.rsSdkDir).map(a => ({ ...a, source: 'file' as const })) : []),
            ...(cfg.rsSdkDir ? scanRsSdk(cfg.rsSdkDir, cfg.defaultServer).map(a => ({ ...a, source: 'rs-sdk' as const })) : []),
        ];
        const seen = new Set<string>();
        for (const a of imported) {
            if (seen.has(a.name.toLowerCase())) continue;
            seen.add(a.name.toLowerCase());
            store.upsertAccount(localUser.id, { name: a.name, password: a.password, server: a.server, runClient: a.runClient, source: a.source, botDir: a.botDir ?? null });
        }
        if (imported.length) log(`imported ${seen.size} account(s) from ${[cfg.envAccounts && 'RSD_ACCOUNTS', cfg.accountsFile, cfg.rsSdkDir && `${cfg.rsSdkDir}/bots`].filter(Boolean).join(', ')}`);
    }
    if (cfg.mode === 'hosted' && process.env.RSD_ADMIN_EMAIL) {
        const admin = store.getUserByEmail(process.env.RSD_ADMIN_EMAIL);
        if (admin && !admin.is_admin) store.db.query('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
    }
    fleet.start();

    // ------------------------------------------------------------ auth helpers
    const attempts = new Map<string, number[]>();
    const rateLimited = (ip: string, max = 10, windowMs = 60_000) => {
        const now = Date.now();
        const list = (attempts.get(ip) ?? []).filter(t => now - t < windowMs);
        list.push(now); attempts.set(ip, list);
        return list.length > max;
    };
    const cookieOf = (req: Request, name: string) => {
        for (const part of (req.headers.get('cookie') ?? '').split(';')) {
            const [k, ...v] = part.trim().split('=');
            if (k === name) return decodeURIComponent(v.join('='));
        }
        return '';
    };
    const isHttps = (req: Request) => new URL(req.url).protocol === 'https:' || (cfg.trustProxy && req.headers.get('x-forwarded-proto') === 'https');
    const sessionCookie = (req: Request, token: string, maxAgeSec: number) =>
        `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
    const clientIp = (req: Request, server: Server<WsData>) =>
        (cfg.trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : '') || server.requestIP(req)?.address || '?';

    function userOf(req: Request): User | null {
        const auth = req.headers.get('authorization');
        if (auth?.startsWith('Bearer rsd_')) return store.apiTokenUser(auth.slice(7));
        const qtoken = new URL(req.url).searchParams.get('token');
        if (qtoken?.startsWith('rsd_')) return store.apiTokenUser(qtoken);
        if (localUser && !cfg.localPassword) return localUser;
        const s = cookieOf(req, COOKIE);
        return s ? store.sessionUser(s) : null;
    }

    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
    const bad = (error: string, status = 400) => json({ error }, status);
    const body = async (req: Request): Promise<any> => { try { return await req.json(); } catch { return {}; } };

    // ------------------------------------------------------------ live updates
    const sockets = new Set<ServerWebSocket<WsData>>();
    const pending = new Set<AccountRuntime>();
    fleet.listeners.add(rt => pending.add(rt));
    setInterval(() => { // coalesce updates: at most 2 pushes per second per account
        if (!pending.size) return;
        const list = [...pending]; pending.clear();
        for (const ws of sockets) {
            for (const rt of list) {
                if (rt.account.user_id !== ws.data.user.id) continue;
                ws.send(JSON.stringify({ t: 'card', card: rt.card() }));
                if (ws.data.watching === rt.id) ws.send(JSON.stringify({ t: 'view', view: rt.view() }));
            }
        }
    }, 500);
    const pushList = (userId: number) => {
        const cards = fleet.forUser(userId).map(r => r.card());
        for (const ws of sockets) if (ws.data.user.id === userId) ws.send(JSON.stringify({ t: 'accounts', accounts: cards }));
    };

    function ownRuntime(user: User, ref: string): AccountRuntime | null {
        const byId = /^\d+$/.test(ref) ? fleet.get(Number(ref)) : null;
        if (byId && byId.account.user_id === user.id) return byId;
        const acct = store.findAccount(user.id, decodeURIComponent(ref));
        return acct ? fleet.get(acct.id) : null;
    }

    function clientsInUse(userId: number) { return fleet.forUser(userId).filter(r => r.account.runClient).length; }
    /** Admins (the operator) are only bound by the server-wide client cap. */
    const limitsFor = (user: User) => user.is_admin && cfg.mode === 'hosted'
        ? { accounts: Infinity, clients: cfg.maxClientsTotal } : { accounts: cfg.maxAccountsPerUser, clients: cfg.maxClientsPerUser };

    async function addAccount(user: User, b: any) {
        let a: { name: string; password: string; server: string } | null = null;
        if (typeof b.botEnv === 'string' && b.botEnv.trim()) a = parseBotEnv(b.botEnv, cfg.defaultServer);
        else if (b.name && b.password) a = { name: String(b.name).trim(), password: String(b.password), server: String(b.server || cfg.defaultServer).trim() };
        if (!a) return bad('need a username and password (or the contents of a bot.env)');
        if (!NAME_RE.test(a.name)) return bad('username: 1-12 letters, digits, spaces, - or _');
        if (!a.server || /[\s/]/.test(a.server.replace(/^wss?:\/\//, '').replace(/\/gateway$/, ''))) return bad('server: a host name like rs-sdk-demo.fly.dev');
        const exists = store.findAccount(user.id, a.name);
        const lim = limitsFor(user);
        if (!exists && store.countAccounts(user.id) >= lim.accounts) return bad(`account limit reached (${lim.accounts})`, 403);
        const runClient = b.runClient == null ? !!exists?.runClient : !!b.runClient;
        if (runClient && !exists?.runClient && clientsInUse(user.id) >= lim.clients) return bad(`game client limit reached (${lim.clients} per user)`, 403);
        const id = store.upsertAccount(user.id, { ...a, runClient, source: 'ui' });
        await fleet.refresh(id);
        pushList(user.id);
        log(`account ${exists ? 'updated' : 'added'}: ${a.name} @ ${a.server} (user ${user.id}${runClient ? ', game client' : ''})`);
        return json({ ok: true, account: fleet.get(id)?.view() });
    }

    function botEnvText(rt: AccountRuntime) {
        const a = rt.account;
        return `BOT_USERNAME=${a.name}\nPASSWORD=${a.password}\nSERVER=${a.server}\nSHOW_CHAT=true\n`;
    }

    // ------------------------------------------------------------ API
    async function api(req: Request, url: URL, server: Server<WsData>): Promise<Response> {
        const path = url.pathname, method = req.method;
        const ip = clientIp(req, server);

        if (path === '/api/me') {
            const user = userOf(req);
            return json({
                mode: cfg.mode, version: VERSION, user: user && user !== localUser ? { id: user.id, email: user.email, admin: !!user.is_admin } : user ? { id: user.id, email: null, admin: true } : null,
                needsLogin: !user, passwordLogin: cfg.mode === 'local' && !!cfg.localPassword, signups: cfg.mode === 'hosted' && cfg.signups,
                defaultServer: cfg.defaultServer, publicUrl: cfg.publicUrl || url.origin, rsSdk: !!cfg.rsSdkDir,
                limits: user ? (({ accounts, clients }) => ({ accounts: Number.isFinite(accounts) ? accounts : null, clients }))(limitsFor(user)) : { accounts: cfg.maxAccountsPerUser, clients: cfg.maxClientsPerUser },
            });
        }
        if (path === '/api/auth/signup' && method === 'POST') {
            if (cfg.mode !== 'hosted' || !cfg.signups) return bad('sign-ups are disabled', 403);
            if (rateLimited(`signup:${ip}`, 20, 3_600_000)) return bad('too many sign-ups from your network, try again later', 429);
            const b = await body(req);
            const email = String(b.email ?? '').trim(), password = String(b.password ?? '');
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return bad('enter a valid email address');
            if (password.length < 8) return bad('password: at least 8 characters');
            if (store.getUserByEmail(email)) return bad('an account with that email exists - log in instead', 409);
            const adminEmail = (process.env.RSD_ADMIN_EMAIL ?? '').toLowerCase();
            const user = await store.createUser(email, password, adminEmail ? email.toLowerCase() === adminEmail : store.userCount() === 0);
            log(`signup: user ${user.id}`);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(user.id), 30 * 86400) });
        }
        if (path === '/api/auth/login' && method === 'POST') {
            if (rateLimited(`login:${ip}`)) return bad('too many attempts, try again in a minute', 429);
            const b = await body(req);
            if (localUser) {
                if (!cfg.localPassword || String(b.password ?? '') !== cfg.localPassword) return bad('wrong password', 401);
                return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(localUser.id), 30 * 86400) });
            }
            const user = await store.checkPassword(String(b.email ?? ''), String(b.password ?? ''));
            if (!user) return bad('wrong email or password', 401);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(user.id), 30 * 86400) });
        }
        if (path === '/api/auth/logout' && method === 'POST') {
            const s = cookieOf(req, COOKIE);
            if (s) store.deleteSession(s);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
        }

        const user = userOf(req);
        if (!user) return bad('not logged in', 401);

        if (path === '/api/auth/password' && method === 'POST') {
            if (user === localUser) return bad('set RSD_PASSWORD to change the local password');
            const b = await body(req);
            if (!(await store.checkPassword(user.email, String(b.current ?? '')))) return bad('current password is wrong', 401);
            if (String(b.next ?? '').length < 8) return bad('new password: at least 8 characters');
            await store.setPassword(user.id, String(b.next));
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(user.id), 30 * 86400) });
        }
        if (path === '/api/auth/delete' && method === 'POST') {
            if (user === localUser) return bad('not available in local mode');
            const b = await body(req);
            if (!(await store.checkPassword(user.email, String(b.password ?? '')))) return bad('password is wrong', 401);
            for (const rt of fleet.forUser(user.id)) await rt.managed.destroy();
            store.deleteUser(user.id);
            await fleet.sync();
            log(`user ${user.id} deleted their account`);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
        }

        // tokens for agents and scripts
        if (path === '/api/tokens' && method === 'GET') return json({ tokens: store.listApiTokens(user.id) });
        if (path === '/api/tokens' && method === 'POST') {
            const b = await body(req);
            if (store.listApiTokens(user.id).length >= 20) return bad('token limit reached (20)');
            return json({ token: store.createApiToken(user.id, String(b.name ?? 'agent')) });
        }
        const tok = path.match(/^\/api\/tokens\/(\d+)$/);
        if (tok && method === 'DELETE') { store.deleteApiToken(user.id, Number(tok[1])); return json({ ok: true }); }

        if (path === '/api/accounts' && method === 'GET') return json({ accounts: fleet.forUser(user.id).map(r => r.card()) });
        if (path === '/api/accounts' && method === 'POST') return addAccount(user, await body(req));
        if (path === '/api/accounts/generate' && method === 'POST') {
            return json({ name: randomAlnum(1).replace(/\d/, 'b') + randomAlnum(8), password: randomAlnum(12) });
        }

        if (path === '/api/admin' && method === 'GET') {
            if (!user.is_admin) return bad('admins only', 403);
            const all = [...fleet.runtimes.values()];
            return json({ users: store.userCount(), accounts: all.length, online: all.filter(r => r.online()).length,
                clients: all.filter(r => r.managed.state === 'running').length, clientCap: cfg.maxClientsTotal });
        }

        const m = path.match(/^\/api\/accounts\/([^/]+)(?:\/(.+))?$/);
        if (m) {
            const rt = ownRuntime(user, m[1]!);
            if (!rt) return bad('no such account', 404);
            const sub = m[2] ?? '';
            if (!sub && method === 'GET') return json(rt.view());
            if (!sub && method === 'PATCH') {
                const b = await body(req);
                if (b.runClient === true && !rt.account.runClient && clientsInUse(user.id) >= limitsFor(user).clients) return bad(`game client limit reached (${limitsFor(user).clients} per user)`, 403);
                if (b.server != null && !String(b.server).trim()) return bad('server cannot be empty');
                store.updateAccount(rt.id, { password: b.password ? String(b.password) : undefined, server: b.server ? String(b.server).trim() : undefined, runClient: typeof b.runClient === 'boolean' ? b.runClient : undefined });
                await fleet.refresh(rt.id);
                pushList(user.id);
                return json({ ok: true, account: rt.view() });
            }
            if (!sub && method === 'DELETE') {
                store.deleteAccount(rt.id);
                await fleet.sync();
                pushList(user.id);
                log(`account removed: ${rt.account.name} (user ${user.id})`);
                return json({ ok: true });
            }
            if (sub === 'client/reload' && method === 'POST') { void rt.managed.reload(); return json({ ok: true }); }
            if (sub === 'say' && method === 'POST') {
                const b = await body(req);
                const text = String(b.text ?? '').trim();
                if (!text) return bad('empty message');
                return json(await say(rt.account.server, rt.account.name, rt.account.password, text.slice(0, 400)));
            }
            if (sub === 'chat' && method === 'GET') return json(await fetchChat(rt.account.server, rt.account.name, rt.account.password));
            if (sub === 'input' && method === 'POST') { const b = await body(req); return json(await rt.managed.input(b.ev as InputEvent)); }
            if (sub === 'activity' && method === 'POST') {
                const b = await body(req);
                store.setActivity(rt.id, String(b.text ?? ''));
                await fleet.sync();
                return json({ ok: true });
            }
            if (sub === 'log' && method === 'GET') {
                const t = rt.account.bot_dir ? tailLog(rt.account.bot_dir, 60) : null;
                if (t && rt.account.password) t.lines = t.lines.map(l => l.split(rt.account.password).join('***'));
                return json(t ?? { file: null, lines: [] });
            }
            if (sub === 'connect' && method === 'GET') {
                const e = endpointsFor(rt.account.server);
                return json({ botEnv: botEnvText(rt), clientUrl: `${e.web}/bot?bot=${encodeURIComponent(rt.account.name)}&password=${encodeURIComponent(rt.account.password)}`, gateway: e.ws });
            }
            return bad('not found', 404);
        }
        return bad('not found', 404);
    }

    const viewerFps = (f: unknown) => Math.min(cfg.streamFps, Math.max(1, Number(f) || cfg.streamFps));

    /** `curl -fsSL <dashboard>/connect.sh | RSD_TOKEN=... bash` inside an rs-sdk checkout uploads every bots/*\/bot.env. */
    const connectScript = (origin: string) => readFileSync(join(PUBLIC_DIR, 'connect.sh'), 'utf8').replaceAll('__DASH__', origin);

    // ------------------------------------------------------------ static files
    function serveStatic(path: string): Response {
        if (path === '/' || !path.includes('.')) path = '/index.html'; // SPA routes
        const file = normalize(join(PUBLIC_DIR, path));
        if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return new Response('not found', { status: 404 });
        const headers: Record<string, string> = { 'cache-control': path === '/index.html' || path === '/sw.js' ? 'no-cache' : 'public, max-age=300' };
        return new Response(Bun.file(file), { headers });
    }

    const server = Bun.serve<WsData>({
        port: cfg.port, hostname: cfg.host, idleTimeout: 60,
        async fetch(req, srv) {
            const url = new URL(req.url);
            if (url.pathname === '/health') return json({ ok: true, mode: cfg.mode, version: VERSION, accounts: fleet.runtimes.size });
            if (url.pathname === '/ws') {
                const user = userOf(req);
                if (!user) return new Response('not logged in', { status: 401 });
                return srv.upgrade(req, { data: { user, watching: null, viewer: null } }) ? undefined : new Response('upgrade failed', { status: 400 });
            }
            if (url.pathname === '/connect.sh') return new Response(connectScript(cfg.publicUrl || url.origin), { headers: { 'content-type': 'text/x-shellscript; charset=utf-8' } });
            if (url.pathname.startsWith('/api/')) {
                try { return await api(req, url, srv); }
                catch (e) { log(`api error ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`); return bad('internal error', 500); }
            }
            return serveStatic(url.pathname);
        },
        websocket: {
            maxPayloadLength: 64 * 1024,
            open(ws) {
                sockets.add(ws);
                ws.send(JSON.stringify({ t: 'accounts', accounts: fleet.forUser(ws.data.user.id).map(r => r.card()) }));
            },
            async message(ws, raw) {
                let msg: any;
                try { msg = JSON.parse(String(raw)); } catch { return; }
                if (msg.t === 'watch') {
                    const prev = ws.data.watching != null ? fleet.get(ws.data.watching) : null;
                    if (prev && ws.data.viewer) prev.removeViewer(ws.data.viewer);
                    ws.data.watching = null; ws.data.viewer = null;
                    const rt = msg.id != null ? fleet.get(Number(msg.id)) : null;
                    if (rt && rt.account.user_id === ws.data.user.id) {
                        ws.data.watching = rt.id;
                        ws.data.viewer = { send: d => { ws.send(d); }, buffered: () => ws.getBufferedAmount(), maxFps: viewerFps(msg.fps), lastSentAt: 0 };
                        rt.addViewer(ws.data.viewer);
                        ws.send(JSON.stringify({ t: 'view', view: rt.view() }));
                        void rt.poll();
                    }
                } else if (msg.t === 'fps' && ws.data.viewer) {
                    ws.data.viewer.maxFps = viewerFps(msg.fps);
                } else if (msg.t === 'input' && ws.data.watching != null) {
                    const rt = fleet.get(ws.data.watching);
                    if (!rt) return;
                    const r = await rt.managed.input(msg.ev as InputEvent);
                    if (!r.ok) ws.send(JSON.stringify({ t: 'inputError', error: r.error }));
                }
            },
            close(ws) {
                sockets.delete(ws);
                const rt = ws.data.watching != null ? fleet.get(ws.data.watching) : null;
                if (rt && ws.data.viewer) rt.removeViewer(ws.data.viewer);
            },
        },
    });

    const shutdown = async () => { log('shutting down'); await fleet.shutdown(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { server, store, fleet };
}
