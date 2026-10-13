// Talks to an rs-sdk gateway. The `server` value is the same one rs-sdk's bot.env uses (SERVER=...).
//
//   rs-sdk-demo.fly.dev  -> web client https://rs-sdk-demo.fly.dev/bot, gateway wss://rs-sdk-demo.fly.dev/gateway
//   localhost[:8888]     -> web client http://localhost:8888/bot,         gateway ws://localhost:7780
//
// State is read with the gateway's HTTP endpoints (GET /status/:bot, GET /state/:bot, GET /chat/:bot,
// POST /say/:bot). Some deployments only expose them on a direct port (the demo: :7443), so the HTTP base is
// probed once per server. A gateway with no HTTP endpoints falls back to a read-only observe WebSocket.

export type Endpoints = { web: string; ws: string; httpCandidates: string[] };

export function endpointsFor(server: string): Endpoints {
    const s = server.trim().replace(/\/+$/, '');
    if (/^wss?:\/\//.test(s)) {
        const u = new URL(s);
        const http = s.replace(/^ws/, 'http');
        return { web: `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`, ws: s, httpCandidates: [http.replace(/\/gateway$/, ''), http] };
    }
    if (/^https?:\/\//.test(s)) return endpointsFor(s.replace(/^https?:\/\//, ''));
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(s);
    if (isLocal) {
        const host = s.split(':')[0];
        const webPort = s.includes(':') ? s.split(':').pop() : '8888';
        return { web: `http://${host}:${webPort}`, ws: `ws://${host}:7780`, httpCandidates: [`http://${host}:7780`] };
    }
    return { web: `https://${s}`, ws: `wss://${s}/gateway`, httpCandidates: [`https://${s.split(':')[0]}:7443`, `https://${s}/gateway`] };
}

export const clientUrl = (server: string, user: string, pass: string) =>
    `${endpointsFor(server).web}/bot?bot=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

const httpBase = new Map<string, Promise<string | null>>();

/** First candidate whose /status answers JSON; null = HTTP endpoints unavailable (use the observe socket). */
export function resolveHttpBase(server: string): Promise<string | null> {
    let p = httpBase.get(server);
    if (!p) {
        p = (async () => {
            for (const base of endpointsFor(server).httpCandidates) {
                try {
                    const r = await fetch(`${base}/status`, { signal: AbortSignal.timeout(6000) });
                    if ((r.headers.get('content-type') ?? '').includes('json')) return base;
                } catch { /* next */ }
            }
            return null;
        })();
        httpBase.set(server, p);
        // re-probe failed resolutions later (server might have been down)
        p.then(b => { if (!b) setTimeout(() => httpBase.delete(server), 60_000); });
    }
    return p;
}

export type BotStatus = { status: string; inGame: boolean; stateAge?: number; controllers?: string[]; observers?: string[]; player?: { name: string; worldX: number; worldZ: number } | null };
export type StateResult = { state: any | null; stateAge: number | null; botStatus: string; error?: string };

async function getJson(url: string, password?: string, timeout = 8000) {
    const r = await fetch(url, { headers: password ? { authorization: `Bearer ${password}` } : {}, signal: AbortSignal.timeout(timeout) });
    const body: any = await r.json().catch(() => null);
    return { status: r.status, body };
}

export async function fetchStatus(server: string, user: string): Promise<BotStatus | null> {
    const base = await resolveHttpBase(server);
    if (!base) return null;
    try {
        const { status, body } = await getJson(`${base}/status/${encodeURIComponent(user)}`);
        if (status === 200 && body) return body as BotStatus;
        return { status: body?.status ?? 'dead', inGame: false };
    } catch { return null; }
}

export async function fetchState(server: string, user: string, password: string): Promise<StateResult> {
    const base = await resolveHttpBase(server);
    if (!base) return observeOnce(server, user, password);
    try {
        const { status, body } = await getJson(`${base}/state/${encodeURIComponent(user)}`, password);
        if (status === 401) return { state: null, stateAge: null, botStatus: 'unknown', error: 'wrong password (gateway rejected the credentials)' };
        if (status === 404) return { state: null, stateAge: null, botStatus: body?.botStatus ?? 'dead', error: 'no game client is logged in' };
        if (status !== 200 || !body) return { state: null, stateAge: null, botStatus: 'unknown', error: `gateway answered ${status}` };
        return { state: body.state ?? null, stateAge: Number(body.stateAge) || 0, botStatus: body.botStatus ?? 'active' };
    } catch (e) {
        return { state: null, stateAge: null, botStatus: 'unknown', error: `gateway unreachable: ${(e as Error).message}` };
    }
}

export async function fetchChat(server: string, user: string, password: string, limit = 50): Promise<{ messages: any[]; error?: string }> {
    const base = await resolveHttpBase(server);
    if (!base) return { messages: [], error: 'gateway has no chat endpoint' };
    try {
        const { status, body } = await getJson(`${base}/chat/${encodeURIComponent(user)}?limit=${limit}&system=1`, password);
        if (status !== 200) return { messages: [], error: body?.error ?? `gateway answered ${status}` };
        return { messages: Array.isArray(body?.messages) ? body.messages : [] };
    } catch (e) { return { messages: [], error: (e as Error).message }; }
}

export async function say(server: string, user: string, password: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const base = await resolveHttpBase(server);
    if (!base) return { ok: false, error: 'gateway has no say endpoint' };
    try {
        const r = await fetch(`${base}/say/${encodeURIComponent(user)}`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${password}` },
            body: JSON.stringify({ text }), signal: AbortSignal.timeout(20_000),
        });
        const body: any = await r.json().catch(() => null);
        return r.ok ? { ok: true } : { ok: false, error: body?.error ?? body?.results?.[0]?.message ?? `gateway answered ${r.status}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Fallback for gateways without HTTP endpoints: connect in observe mode (read-only), take one state frame, close. */
export function observeOnce(server: string, user: string, password: string, timeoutMs = 10_000): Promise<StateResult> {
    return new Promise(resolve => {
        let done = false;
        const ws = new WebSocket(endpointsFor(server).ws);
        const finish = (r: StateResult) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch { /* closed */ } resolve(r); };
        const t = setTimeout(() => finish({ state: null, stateAge: null, botStatus: 'unknown', error: 'no state from gateway (is a game client logged in?)' }), timeoutMs);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'sdk_connect', username: user, password, clientId: `dash-${Date.now()}`, mode: 'observe' }));
        ws.onerror = () => finish({ state: null, stateAge: null, botStatus: 'unknown', error: 'gateway unreachable' });
        ws.onmessage = ev => {
            try {
                const m = JSON.parse(String(ev.data));
                if (m.type === 'sdk_error') finish({ state: null, stateAge: null, botStatus: 'unknown', error: m.error ?? 'gateway refused' });
                if (m.type === 'sdk_state' && m.state) finish({ state: m.state, stateAge: m.stateReceivedAt ? Math.max(0, Date.now() - m.stateReceivedAt) : 0, botStatus: 'active' });
            } catch { /* ignore */ }
        };
    });
}
