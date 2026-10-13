import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REMOTE_COOKIE, isRemote, remoteGate, sign, verify } from './remote-auth';

const SECRET = 'a'.repeat(64);
const dir = mkdtempSync(join(tmpdir(), 'remote-auth-'));
const file = join(dir, 'remote-secret');
writeFileSync(file, SECRET + '\n');
const now = () => Math.floor(Date.now() / 1000);
const req = (path: string, headers: Record<string, string> = {}) => new Request('http://localhost:8765' + path, { headers: { 'cf-ray': 'x', ...headers } });

describe('remote auth', () => {
    test('detects tunnel requests only', () => {
        expect(isRemote(new Request('http://127.0.0.1:8765/'))).toBe(false);
        expect(isRemote(new Request('http://192.168.1.5:8765/'))).toBe(false);
        expect(isRemote(req('/'))).toBe(true);
        expect(isRemote(new Request('http://x/', { headers: { host: 'abc-def.trycloudflare.com' } }))).toBe(true);
    });
    test('tokens are bound to secret, kind and expiry', () => {
        const t = sign(SECRET, 'vt', { exp: now() + 60, n: 'n1' });
        expect(verify(SECRET, 'vt', t)?.n).toBe('n1');
        expect(verify('b'.repeat(64), 'vt', t)).toBeNull();
        expect(verify(SECRET, 'sess', t)).toBeNull();
        expect(verify(SECRET, 'vt', sign(SECRET, 'vt', { exp: now() - 1, n: 'x' }))).toBeNull();
        expect(verify(SECRET, 'vt', sign(SECRET, 'vt', { exp: now() + 3600, n: 'x' }))).toBeNull(); // too long-lived
        expect(verify(SECRET, 'vt', t.slice(0, -2) + 'AA')).toBeNull();
    });
    test('gate: 401 without session, vt -> cookie once, cookie passes', () => {
        expect(remoteGate(req('/'), new URL('http://h/'), file)?.status).toBe(401);
        const vt = sign(SECRET, 'vt', { exp: now() + 60, n: 'once' });
        const r = remoteGate(req('/?vt=' + vt), new URL('http://h/?vt=' + vt), file)!;
        expect(r.status).toBe(302);
        expect(r.headers.get('location')).toBe('/');
        const sc = r.headers.get('set-cookie')!;
        expect(sc).toContain('HttpOnly');
        expect(sc).toContain('Secure');
        expect(remoteGate(req('/?vt=' + vt), new URL('http://h/?vt=' + vt), file)?.status).toBe(401); // replay
        const cookie = sc.split(';')[0]!;
        expect(remoteGate(req('/api/accounts', { cookie }), new URL('http://h/api/accounts'), file)).toBeNull();
        expect(remoteGate(req('/', { cookie: `${REMOTE_COOKIE}=forged.sig` }), new URL('http://h/'), file)?.status).toBe(401);
    });
    test('missing secret disables remote access', () => {
        expect(remoteGate(req('/'), new URL('http://h/'), join(dir, 'nope'))?.status).toBe(401);
    });
});
