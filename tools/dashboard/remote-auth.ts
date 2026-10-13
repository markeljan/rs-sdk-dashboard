// Remote (Cloudflare tunnel) access to the dashboard. See tools/dashboard/remote/README.md.
//
// Requests that come through the tunnel carry Cloudflare headers (cf-ray / cf-connecting-ip) or the trycloudflare
// host; every one of them must hold a session cookie. A session starts from a short-lived ?vt=<token> minted by the
// Vercel launcher (behind Vercel Authentication) with the shared secret in telemetry/remote-secret.
// Direct localhost/LAN requests are untouched (they keep the DASH_TOKEN rules in server.ts).
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync, statSync } from 'fs';

export const REMOTE_COOKIE = '__Host-dash_remote';
export const SESSION_TTL_S = 30 * 24 * 3600;
const VT_MAX_TTL_S = 120;

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (secret: string, kind: string, payload: string) => createHmac('sha256', secret).update(`${kind}.${payload}`).digest('base64url');

export function sign(secret: string, kind: 'vt' | 'sess', claims: Record<string, unknown>) {
    const payload = b64u(JSON.stringify(claims));
    return `${payload}.${mac(secret, kind, payload)}`;
}

/** Returns the claims of a valid, unexpired token of this kind, else null. */
export function verify(secret: string, kind: 'vt' | 'sess', token: string | null | undefined, now = Date.now() / 1000): Record<string, any> | null {
    if (!secret || !token || token.length > 1024) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot), sig = Buffer.from(token.slice(dot + 1));
    const want = Buffer.from(mac(secret, kind, payload));
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
    try {
        const c = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (typeof c.exp !== 'number' || c.exp < now) return null;
        if (kind === 'vt' && c.exp - now > VT_MAX_TTL_S) return null;
        return c;
    } catch { return null; }
}

/** True when the request arrived through Cloudflare (the tunnel), even though cloudflared connects from loopback. */
export function isRemote(req: Request) {
    const h = req.headers;
    return h.has('cf-ray') || h.has('cf-connecting-ip') || h.has('cf-visitor') || /cloudflare/i.test(h.get('cdn-loop') ?? '')
        || /\.trycloudflare\.com(:\d+)?$/i.test(h.get('host') ?? '');
}

let cached: { at: number; mtime: number; secret: string } | null = null;
/** Shared secret, re-read when the file changes (rotate it to revoke every session). Empty = remote access disabled. */
export function remoteSecret(file: string) {
    const now = Date.now();
    if (cached && now - cached.at < 10_000) return cached.secret;
    try {
        const mtime = statSync(file).mtimeMs;
        const secret = cached?.mtime === mtime ? cached.secret : readFileSync(file, 'utf8').trim();
        cached = { at: now, mtime, secret: secret.length >= 32 ? secret : '' };
    } catch { cached = { at: now, mtime: 0, secret: '' }; }
    return cached.secret;
}

const usedVt = new Map<string, number>();
const cookieOf = (req: Request) => (req.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(REMOTE_COOKIE + '='))?.slice(REMOTE_COOKIE.length + 1);

/**
 * Gate for tunnel requests. Returns null when the request may proceed, else the response to send
 * (401, or a 302 that swaps a one-time ?vt= for the session cookie).
 */
export function remoteGate(req: Request, url: URL, secretFile: string): Response | null {
    const secret = remoteSecret(secretFile);
    const deny = (why: string) => new Response(`Unauthorized (${why}) - open the dashboard through your Vercel launcher`, { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } });
    if (!secret) return deny('remote access not configured');
    const vt = url.searchParams.get('vt');
    if (vt) {
        const c = verify(secret, 'vt', vt);
        if (!c || typeof c.n !== 'string' || usedVt.has(c.n)) return deny('invalid or used link');
        const now = Date.now() / 1000;
        for (const [n, exp] of usedVt) if (exp < now) usedVt.delete(n);
        usedVt.set(c.n, c.exp);
        const sess = sign(secret, 'sess', { exp: Math.floor(now) + SESSION_TTL_S, iat: Math.floor(now) });
        url.searchParams.delete('vt');
        return new Response(null, { status: 302, headers: {
            location: url.pathname + (url.search || ''),
            'set-cookie': `${REMOTE_COOKIE}=${sess}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Lax`,
            'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        } });
    }
    return verify(secret, 'sess', cookieOf(req)) ? null : deny('no session');
}
