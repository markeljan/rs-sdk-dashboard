// Game passwords are stored encrypted (AES-256-GCM) with a key derived from RSD_SECRET or a generated key file.
// Session cookies and API tokens are random; only their SHA-256 is stored.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
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
