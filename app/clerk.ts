// Sign in with Google (or any provider enabled in Clerk) on the hosted dashboard. The page signs in with Clerk's own
// JS, then hands us the Clerk session token; we verify it against Clerk's public keys (JWKS, no secret needed) and
// start our normal session for the email in the token. Clerk setup: enable Google, and add the claim
// {"email": "{{user.primary_email_address}}"} under Sessions → Customize session token.

/** pk_test_/pk_live_ keys are base64 of "<frontend api host>$". */
export function frontendApi(publishableKey: string): string | null {
    const m = /^pk_(test|live)_(.+)$/.exec(publishableKey.trim());
    if (!m) return null;
    try { const host = Buffer.from(m[2]!, 'base64').toString('utf8').replace(/\$$/, ''); return /^[\w.-]+$/.test(host) ? host : null; } catch { return null; }
}

type Jwk = JsonWebKey & { kid?: string };
let jwks: { at: number; keys: Jwk[] } | null = null;
async function keyFor(host: string, kid: string): Promise<CryptoKey | null> {
    if (!jwks || Date.now() - jwks.at > 3_600_000 || !jwks.keys.some(k => k.kid === kid)) {
        const r = await fetch(`https://${host}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
        jwks = { at: Date.now(), keys: ((await r.json()) as { keys: Jwk[] }).keys ?? [] };
    }
    const jwk = jwks.keys.find(k => k.kid === kid);
    return jwk ? crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']) : null;
}

const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Verified email of a Clerk session token, or an error. `origins`: allowed authorized parties (azp). */
export async function verifyClerkToken(token: string, publishableKey: string, origins: string[]): Promise<{ email: string; sub: string } | { error: string }> {
    const host = frontendApi(publishableKey);
    if (!host) return { error: 'Clerk is not configured' };
    const parts = token.split('.');
    if (parts.length !== 3) return { error: 'malformed token' };
    let header: any, payload: any;
    try { header = JSON.parse(b64u(parts[0]!).toString()); payload = JSON.parse(b64u(parts[1]!).toString()); } catch { return { error: 'malformed token' }; }
    if (header.alg !== 'RS256' || !header.kid) return { error: 'unexpected token algorithm' };
    const key = await keyFor(host, header.kid);
    if (!key) return { error: 'unknown signing key' };
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return { error: 'bad signature' };
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now - 5) return { error: 'token expired' };
    if (typeof payload.nbf === 'number' && payload.nbf > now + 5) return { error: 'token not valid yet' };
    if (payload.iss !== `https://${host}`) return { error: 'wrong issuer' };
    if (payload.azp && !origins.includes(payload.azp)) return { error: `token is for ${payload.azp}` };
    const email = String(payload.email ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'no email in the Clerk session token (add the email claim in Clerk: Sessions → Customize session token)' };
    return { email, sub: String(payload.sub ?? '') };
}
