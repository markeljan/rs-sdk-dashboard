// Front server. Everything a user sees is the rs-sdk fleet dashboard (tools/dashboard, synced verbatim), running as
// one process per user behind this server. This layer only adds what the fleet dashboard doesn't need:
//   - who you are: hosted sign-up/login, or local mode (optional RSD_PASSWORD)
//   - which accounts you have: /_rsd/api/accounts (web UI, env vars, rs-sdk checkout, connect.sh, agents)
//   - agent onboarding: signed API tokens (recorded on first use) and a copy-paste skill with the token built in
// and proxies every other request (HTTP + WebSocket) to the user's dashboard process.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import type { Config } from './config';
import { loadKey, makeToken, parseToken, randomAlnum } from './crypto';
import { Store, type User } from './db';
import { fetchStatus } from './gateway';
import { parseBotEnv, parseEnvAccounts, readAccountsFile, scanRsSdk } from './importers';
import { Instances } from './instances';
import { skillMarkdown, connectScript } from './skill';

const PAGES = join(import.meta.dir, 'pages');
const DASH_PUBLIC = join(import.meta.dir, '..', 'tools', 'dashboard', 'public');
const VERSION = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version as string;
const COOKIE = 'rsd_session';
const NAME_RE = /^[a-zA-Z0-9 _-]{1,12}$/;
/** Max bytes queued to one viewer before video frames are skipped (about 2 frames at High quality). */
const FRAME_BACKLOG_BYTES = Number(process.env.RSD_FRAME_BACKLOG ?? 192 * 1024);
const redact = (s: string) => s.replace(/(password=)[^&\s"']+/gi, '$1***');

type WsData = { userId: number; port: number; path: string; upstream: WebSocket | null; queue: (string | Buffer)[] };

export function startServer(cfg: Config) {
    const log = (m: string) => console.log(`${new Date().toISOString()} ${redact(m)}`);
    const key = loadKey(cfg.dataDir, cfg.secret);
    const store = new Store(cfg.dataDir, key);
    const instances = new Instances(cfg, store, log);
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
    for (const email of cfg.adminEmails) { const admin = store.getUserByEmail(email); if (admin && !admin.is_admin) store.setAdmin(admin.id); }
    void instances.bootClients();

    // ------------------------------------------------------------ auth
    const attempts = new Map<string, number[]>();
    const rateLimited = (k: string, max = 10, windowMs = 60_000) => {
        const now = Date.now();
        const list = (attempts.get(k) ?? []).filter(t => now - t < windowMs);
        list.push(now); attempts.set(k, list);
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
    const clientIp = (req: Request, srv: Server<WsData>) =>
        (cfg.trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : '') || srv.requestIP(req)?.address || '?';
    const origin = (req: Request) => cfg.publicUrl || (() => { const u = new URL(req.url); return `${isHttps(req) ? 'https' : u.protocol.replace(':', '')}://${req.headers.get('host') ?? u.host}`; })();

    function tokenUser(token: string): User | null {
        const t = parseToken(key, token);
        if (!t || store.tokenRevoked(t.nonce)) return null;
        const user = store.getUser(t.userId);
        if (user) store.recordTokenUse(t.nonce, user.id);
        return user;
    }
    function userOf(req: Request): User | null {
        const auth = req.headers.get('authorization');
        if (auth?.startsWith('Bearer rsd_')) return tokenUser(auth.slice(7));
        const q = new URL(req.url).searchParams.get('rsd_token');
        if (q?.startsWith('rsd_')) return tokenUser(q);
        if (localUser && !cfg.localPassword) return localUser;
        const s = cookieOf(req, COOKIE);
        return s ? store.sessionUser(s) : null;
    }
    const limitsFor = (user: User) => user.is_admin && cfg.mode === 'hosted'
        ? { accounts: Infinity, clients: cfg.maxClientsTotal } : { accounts: cfg.maxAccountsPerUser, clients: cfg.maxClientsPerUser };

    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
    const bad = (error: string, status = 400) => json({ error }, status);
    const body = async (req: Request): Promise<any> => { try { return await req.json(); } catch { return {}; } };
    const page = (name: string) => new Response(Bun.file(join(PAGES, name)), { headers: { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });

    // ------------------------------------------------------------ accounts
    async function addAccount(user: User, b: any) {
        let a: { name: string; password: string; server: string } | null = null;
        if (typeof b.botEnv === 'string' && b.botEnv.trim()) a = parseBotEnv(b.botEnv, cfg.defaultServer);
        else if (b.name && b.password) a = { name: String(b.name).trim(), password: String(b.password), server: String(b.server || cfg.defaultServer).trim() };
        if (!a) return bad('need a username and password (or the contents of a bot.env)');
        if (!NAME_RE.test(a.name)) return bad('username: 1-12 letters, digits, spaces, - or _');
        a.server = a.server.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (!a.server || /\s/.test(a.server)) return bad('server: a host name like rs-sdk-demo.fly.dev');
        if (/[\r\n]/.test(a.password)) return bad('password cannot contain line breaks');
        if (cfg.mode === 'hosted' && store.ownedElsewhere(user.id, a.name, a.server)) return bad(`${a.name} is already on another dashboard account`, 409);
        const exists = store.findAccount(user.id, a.name);
        const lim = limitsFor(user);
        if (!exists && store.countAccounts(user.id) >= lim.accounts) return bad(`account limit reached (${lim.accounts})`, 403);
        const runClient = b.runClient == null ? !!exists?.runClient : !!b.runClient;
        if (runClient && !exists?.runClient) {
            if (store.countClients(user.id) >= lim.clients) return bad(`game client limit reached (${lim.clients})`, 403);
            if (store.countClients() >= cfg.maxClientsTotal) return bad('the dashboard is at its game-client capacity right now', 503);
        }
        store.upsertAccount(user.id, { ...a, runClient, source: exists?.source ?? 'ui' });
        await instances.apply(user.id);
        log(`account ${exists ? 'updated' : 'added'}: ${a.name} @ ${a.server} (user ${user.id}${runClient ? ', game client' : ''})`);
        return json({ ok: true, account: publicAccount(store.findAccount(user.id, a.name)!) });
    }
    const publicAccount = (a: NonNullable<ReturnType<Store['findAccount']>>) =>
        ({ name: a.name, server: a.server, runClient: a.runClient, source: a.source, hasPassword: !!a.password, createdAt: a.created_at });

    // ------------------------------------------------------------ agent liveness
    // The dashboard shows a bot as running when it sees its process, or a fresh script-host status file
    // (bots/*/script-host.json, the rs-sdk script host). Agents elsewhere have no process here, so every activity/log
    // post marks the account as run by "<script>" for 2 minutes through such a file. Hosted, game account names are
    // unique across users, so one file per user can't mark anyone else's account.
    const agentSeen = new Map<number, Map<string, { at: number; script: string }>>();
    function writeAgentStatus(userId: number) {
        const seen = agentSeen.get(userId);
        if (!seen) return;
        const now = Date.now();
        for (const [n, v] of seen) if (now - v.at > 110_000) seen.delete(n);
        const dir = join(import.meta.dir, '..', 'bots', `agents-user-${userId}`);
        mkdirSync(dir, { recursive: true });
        const accts = new Map(store.listAccounts(userId).map(a => [a.name, a]));
        writeFileSync(join(dir, 'script-host.json'), JSON.stringify({
            pid: process.pid, at: new Date(now).toISOString(),
            bots: [...seen].filter(([n]) => accts.has(n)).map(([name, v]) => ({ name, script: v.script, entry: v.script.replace(/[^\w./-]/g, '').slice(0, 60) || 'agent', state: 'agent' })),
        }) + '\n');
    }
    function agentAlive(userId: number, name: string, script: string) {
        let seen = agentSeen.get(userId);
        if (!seen) agentSeen.set(userId, seen = new Map());
        seen.set(name, { at: Date.now(), script });
        writeAgentStatus(userId);
    }
    setInterval(() => { for (const u of agentSeen.keys()) writeAgentStatus(u); }, 30_000);

    // ------------------------------------------------------------ /_rsd API
    async function api(req: Request, url: URL, srv: Server<WsData>): Promise<Response> {
        const path = url.pathname.slice('/_rsd/api'.length), method = req.method;
        const ip = clientIp(req, srv);
        const user = userOf(req);

        if (path === '/me') {
            return json({
                mode: cfg.mode, version: VERSION, needsLogin: !user, passwordLogin: cfg.mode === 'local' && !!cfg.localPassword,
                signups: cfg.mode === 'hosted' && cfg.signups, defaultServer: cfg.defaultServer, origin: origin(req), rsSdk: !!cfg.rsSdkDir,
                user: user ? { email: user === localUser ? null : user.email, admin: !!user.is_admin, accounts: store.countAccounts(user.id), limits: (l => ({ accounts: Number.isFinite(l.accounts) ? l.accounts : null, clients: l.clients }))(limitsFor(user)) } : null,
            });
        }
        if (path === '/auth/signup' && method === 'POST') {
            if (cfg.mode !== 'hosted' || !cfg.signups) return bad('sign-ups are disabled', 403);
            if (rateLimited(`signup:${ip}`, 20, 3_600_000)) return bad('too many sign-ups from your network, try again later', 429);
            const b = await body(req);
            const email = String(b.email ?? '').trim(), password = String(b.password ?? '');
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return bad('enter a valid email address');
            if (password.length < 8) return bad('password: at least 8 characters');
            if (store.getUserByEmail(email)) return bad('an account with that email exists - log in instead', 409);
            const u = await store.createUser(email, password, cfg.adminEmails.length ? cfg.adminEmails.includes(email.toLowerCase()) : store.userCount() === 0);
            log(`signup: user ${u.id}`);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(u.id), 30 * 86400) });
        }
        if (path === '/auth/login' && method === 'POST') {
            if (rateLimited(`login:${ip}`)) return bad('too many attempts, try again in a minute', 429);
            const b = await body(req);
            if (localUser) {
                if (!cfg.localPassword || String(b.password ?? '') !== cfg.localPassword) return bad('wrong password', 401);
                return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(localUser.id), 30 * 86400) });
            }
            const u = await store.checkPassword(String(b.email ?? ''), String(b.password ?? ''));
            if (!u) return bad('wrong email or password', 401);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(u.id), 30 * 86400) });
        }
        if (path === '/auth/logout' && method === 'POST') {
            const s = cookieOf(req, COOKIE);
            if (s) store.deleteSession(s);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
        }
        if (!user) return bad('not logged in', 401);

        if (path === '/auth/password' && method === 'POST') {
            if (user === localUser) return bad('set RSD_PASSWORD to change the local password');
            const b = await body(req);
            if (!(await store.checkPassword(user.email, String(b.current ?? '')))) return bad('current password is wrong', 401);
            if (String(b.next ?? '').length < 8) return bad('new password: at least 8 characters');
            await store.setPassword(user.id, String(b.next));
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, store.createSession(user.id), 30 * 86400) });
        }
        if (path === '/auth/delete' && method === 'POST') {
            if (user === localUser) return bad('not available in local mode');
            const b = await body(req);
            if (!(await store.checkPassword(user.email, String(b.password ?? '')))) return bad('password is wrong', 401);
            await instances.apply(user.id, store.listAccounts(user.id).filter(a => a.runClient).map(a => a.name));
            await instances.purge(user.id);
            store.deleteUser(user.id);
            log(`user ${user.id} deleted their account`);
            return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
        }

        // API tokens: a fresh signed token on request; only used ones are listed (and can be revoked or renamed)
        if (path === '/token' && method === 'GET') return json({ token: makeToken(key, user.id) });
        if (path === '/tokens' && method === 'GET') return json({ tokens: store.listUsedTokens(user.id).map(t => ({ id: t.nonce, name: t.name, firstUsedAt: t.first_used_at, lastUsedAt: t.last_used_at, uses: t.uses })) });
        const tm = path.match(/^\/tokens\/([0-9a-f]{16})$/);
        if (tm && method === 'DELETE') { store.revokeToken(user.id, tm[1]!); return json({ ok: true }); }
        if (tm && method === 'PATCH') { store.renameToken(user.id, tm[1]!, String((await body(req)).name ?? 'agent')); return json({ ok: true }); }
        if (path === '/skill' && method === 'GET') return new Response(skillMarkdown(origin(req), makeToken(key, user.id), cfg.mode), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });

        if (path === '/accounts' && method === 'GET') return json({ accounts: store.listAccounts(user.id).map(publicAccount) });
        if (path === '/accounts' && method === 'POST') return addAccount(user, await body(req));
        if (path === '/accounts/generate' && method === 'POST') return json({ name: 'b' + randomAlnum(8), password: randomAlnum(12) });
        if (path === '/admin' && method === 'GET') {
            if (!user.is_admin) return bad('admins only', 403);
            return json({ users: store.userCount(), accounts: store.listAccounts().length, clients: store.countClients(), clientCap: cfg.maxClientsTotal, dashboards: instances.running() });
        }

        const m = path.match(/^\/accounts\/([^/]+)(?:\/(\w+))?$/);
        if (m) {
            const acct = store.findAccount(user.id, decodeURIComponent(m[1]!));
            if (!acct) return bad('no such account', 404);
            const sub = m[2] ?? '';
            if (!sub && method === 'GET') return json(publicAccount(acct));
            if (!sub && method === 'PATCH') {
                const b = await body(req);
                const lim = limitsFor(user);
                if (b.runClient === true && !acct.runClient) {
                    if (store.countClients(user.id) >= lim.clients) return bad(`game client limit reached (${lim.clients})`, 403);
                    if (store.countClients() >= cfg.maxClientsTotal) return bad('the dashboard is at its game-client capacity right now', 503);
                    const st = await fetchStatus(acct.server, acct.name);
                    if (st?.inGame && st.status === 'active' && !b.force) return bad(`another game client is logged in as ${acct.name} - close it first (only one client per account)`, 409);
                }
                if (b.server != null && !String(b.server).trim()) return bad('server cannot be empty');
                if (b.password != null && /[\r\n]/.test(String(b.password))) return bad('password cannot contain line breaks');
                store.updateAccount(acct.id, { password: b.password ? String(b.password) : undefined, server: b.server ? String(b.server).trim() : undefined, runClient: typeof b.runClient === 'boolean' ? b.runClient : undefined });
                await instances.apply(user.id, b.runClient === false && acct.runClient ? [acct.name] : []);
                return json({ ok: true, account: publicAccount(store.getAccount(acct.id)!) });
            }
            if (!sub && method === 'DELETE') {
                await instances.apply(user.id, acct.runClient ? [acct.name] : []);
                store.deleteAccount(acct.id);
                instances.forget(user.id, acct.name);
                await instances.apply(user.id);
                log(`account removed: ${acct.name} (user ${user.id})`);
                return json({ ok: true });
            }
            // What the bot is doing, for the dashboard's "Current activity" card (tasks.json current/goal + a log).
            const dir = acct.source === 'rs-sdk' && acct.bot_dir ? acct.bot_dir : join(instances.userDir(user.id), 'accounts', acct.name);
            if (sub === 'activity' && method === 'POST') {
                const b = await body(req);
                agentAlive(user.id, acct.name, String(b.script ?? 'agent'));
                mkdirSync(dir, { recursive: true });
                const file = join(dir, 'tasks.json');
                let tasks: any = {};
                try { tasks = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new */ }
                if (b.text != null || b.current != null) tasks.current = String(b.text ?? b.current).slice(0, 300);
                if (b.goal != null) tasks.goal = String(b.goal).slice(0, 300);
                writeFileSync(file, JSON.stringify(tasks, null, 1) + '\n');
                if (b.text != null || b.current != null) appendFileSync(join(dir, 'agent.log'), `[${new Date().toLocaleTimeString()}] ${tasks.current}\n`);
                return json({ ok: true, paused: existsSync(join(dir, 'PAUSED')) });
            }
            if (sub === 'log' && method === 'POST') {
                const b = await body(req);
                agentAlive(user.id, acct.name, String(b.script ?? 'agent'));
                const lines = (Array.isArray(b.lines) ? b.lines : String(b.text ?? '').split('\n')).map((l: unknown) => String(l).slice(0, 500)).filter(Boolean).slice(0, 200);
                mkdirSync(dir, { recursive: true });
                if (lines.length) appendFileSync(join(dir, 'agent.log'), lines.map((l: string) => `[${new Date().toLocaleTimeString()}] ${l}`).join('\n') + '\n');
                return json({ ok: true, lines: lines.length, paused: existsSync(join(dir, 'PAUSED')) });
            }
            if (sub === 'botenv' && method === 'GET') return new Response(`BOT_USERNAME=${acct.name}\nPASSWORD=${acct.password}\nSERVER=${acct.server}\nSHOW_CHAT=true\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        }
        return bad('not found', 404);
    }

    // ------------------------------------------------------------ proxy to the user's dashboard process
    const INJECT = `<script src="/_rsd/inject.js" defer></script>`;
    async function proxy(req: Request, url: URL, port: number): Promise<Response> {
        const headers = new Headers(req.headers);
        headers.delete('host'); headers.delete('authorization'); headers.delete('cookie'); headers.delete('accept-encoding');
        let r: Response;
        try {
            r = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
                method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
                redirect: 'manual', signal: req.signal,
            });
        } catch { return new Response('dashboard is starting - reload in a few seconds', { status: 503, headers: { 'retry-after': '3' } }); }
        const out = new Headers(r.headers);
        out.delete('content-encoding'); out.delete('content-length'); out.delete('set-cookie');
        if ((url.pathname === '/' || url.pathname === '/index.html') && (r.headers.get('content-type') ?? '').includes('html')) {
            const html = (await r.text()).replace('</body>', `${INJECT}\n</body>`);
            return new Response(html, { status: r.status, headers: out });
        }
        return new Response(r.body, { status: r.status, headers: out });
    }

    // ------------------------------------------------------------ HTTP
    const server = Bun.serve<WsData>({
        port: cfg.port, hostname: cfg.host, idleTimeout: 120,
        async fetch(req, srv) {
            const url = new URL(req.url);
            const path = url.pathname;
            if (path === '/_rsd/health') return json({ ok: true, mode: cfg.mode, version: VERSION, dashboards: instances.running() });
            if (path.startsWith('/_rsd/api/')) {
                try { return await api(req, url, srv); }
                catch (e) { log(`api error ${req.method} ${path}: ${(e as Error).stack ?? e}`); return bad('internal error', 500); }
            }
            if (path === '/connect.sh') return new Response(connectScript(origin(req)), { headers: { 'content-type': 'text/x-shellscript; charset=utf-8' } });
            if (path.startsWith('/_rsd/')) {
                const f = normalize(join(PAGES, path.slice('/_rsd/'.length)));
                if (f.startsWith(PAGES) && existsSync(f) && !f.endsWith('/')) return page(f.slice(PAGES.length + 1));
                if (path === '/_rsd/' || path === '/_rsd/login' || path === '/_rsd/welcome' || path === '/_rsd/manage') return page('manage.html');
                return new Response('not found', { status: 404 });
            }
            // PWA shell (no account data): served before login so the install prompt and home-screen icon work
            if (path === '/manifest.webmanifest' || path === '/sw.js' || /^\/icons\/icon(-\d+\.png|\.svg)$/.test(path)) {
                const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'application/manifest+json';
                return new Response(Bun.file(join(DASH_PUBLIC, path.slice(1))), { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
            }
            const user = userOf(req);
            if (!user) {
                if (path === '/' || path === '/index.html') return Response.redirect(`${origin(req)}/_rsd/login`, 302);
                return new Response('not logged in', { status: 401 });
            }
            const port = await instances.ensure(user.id);
            if (!port) {
                if (path === '/' || path === '/index.html') return Response.redirect(`${origin(req)}/_rsd/welcome`, 302);
                return store.countAccounts(user.id) ? new Response('dashboard failed to start - check the server log', { status: 503 }) : bad('no accounts yet', 404);
            }
            if (path === '/ws') {
                const ok = srv.upgrade(req, { data: { userId: user.id, port, path: `${path}${url.search}`, upstream: null, queue: [] } });
                return ok ? undefined : new Response('upgrade failed', { status: 400 });
            }
            return proxy(req, url, port);
        },
        websocket: {
            maxPayloadLength: 8 * 1024 * 1024, idleTimeout: 120,
            open(ws) {
                const up = new WebSocket(`ws://127.0.0.1:${ws.data.port}${ws.data.path}`);
                up.binaryType = 'arraybuffer';
                ws.data.upstream = up;
                up.onopen = () => { for (const m of ws.data.queue) up.send(m); ws.data.queue = []; };
                // The dashboard skips frames for viewers that fall behind, but it only sees this proxy's local socket, which
                // never does. Apply the same rule toward the real viewer: drop video frames (binary) while its send buffer
                // is backed up, so a slow phone link shows the newest frame instead of a growing backlog. Status and
                // other text messages always go through.
                up.onmessage = e => {
                    try {
                        if (typeof e.data === 'string') ws.send(e.data);
                        else if (ws.getBufferedAmount() < FRAME_BACKLOG_BYTES) ws.send(new Uint8Array(e.data as ArrayBuffer));
                    } catch { /* closed */ }
                };
                up.onclose = () => { try { ws.close(); } catch { /* closed */ } };
                up.onerror = () => { try { ws.close(); } catch { /* closed */ } };
            },
            message(ws: ServerWebSocket<WsData>, m) {
                const up = ws.data.upstream;
                if (up?.readyState === WebSocket.OPEN) up.send(m); else ws.data.queue.push(m);
            },
            close(ws) { try { ws.data.upstream?.close(); } catch { /* closed */ } },
        },
    });

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return; stopping = true;
        log('shutting down');
        // Local mode: quitting the dashboard also stops the game clients it ran (RSD_KEEP_CLIENTS=1 keeps them).
        if (localUser && process.env.RSD_KEEP_CLIENTS !== '1') await instances.apply(localUser.id, store.listAccounts(localUser.id).filter(a => a.runClient).map(a => a.name)).catch(() => {});
        await instances.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { server, store, instances, key, localUser };
}
