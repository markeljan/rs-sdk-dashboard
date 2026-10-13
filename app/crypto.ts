// Game passwords are stored encrypted (AES-256-GCM) with a key derived from RSD_SECRET or a generated key file.
// Session cookies and API tokens are random; only their SHA-256 is stored.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadKey(dataDir: string, secret: string): Buffer {
    if (secret) return createHash('sha256').update(secret).digest();
    const file = join(dataDir, 'secret.key');
    if (!existsSync(file)) {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    return createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest();
}

export function encrypt(key: Buffer, plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decrypt(key: Buffer, blob: string): string {
    const [v, iv, tag, body] = blob.split(':');
    if (v !== 'v1' || !iv || !tag || body == null) throw new Error('bad ciphertext');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (prefix = '') => prefix + randomBytes(24).toString('base64url');

/** rs-sdk style credentials: alphanumeric, username max 12 chars. */
export function randomAlnum(n: number) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const b = randomBytes(n);
    let s = '';
    for (let i = 0; i < n; i++) s += chars[b[i]! % chars.length];
    return s;
}

// API tokens are signed, not stored: `rsd_<user>_<nonce>_<sig>`. The dashboard hands out a fresh one on every visit
// (pre-filled in the agent skill) and only records a token once it is actually used; revoking stores its nonce.
const tokenSig = (key: Buffer, userId: number, nonce: string) => createHmac('sha256', key).update(`api-token:${userId}:${nonce}`).digest('hex').slice(0, 32);
export function makeToken(key: Buffer, userId: number): string {
    const nonce = randomBytes(8).toString('hex');
    return `rsd_${userId}_${nonce}_${tokenSig(key, userId, nonce)}`;
}
export function parseToken(key: Buffer, token: string): { userId: number; nonce: string } | null {
    const m = /^rsd_(\d+)_([0-9a-f]{16})_([0-9a-f]{32})$/.exec(token.trim());
    if (!m) return null;
    const userId = Number(m[1]), nonce = m[2]!;
    const want = Buffer.from(tokenSig(key, userId, nonce)), got = Buffer.from(m[3]!);
    return want.length === got.length && timingSafeEqual(want, got) ? { userId, nonce } : null;
}
