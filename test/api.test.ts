// Hosted-mode API flow against a real server instance (no game server needed: accounts point at an unreachable host).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { startServer } from '../src/server';

const dataDir = mkdtempSync(join(tmpdir(), 'rsd-api-'));
const cfg = loadConfig({ RSD_MODE: 'hosted', RSD_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', RSD_SERVER: 'unreachable.invalid', RSD_MAX_ACCOUNTS: '2' });
const { server } = startServer(cfg);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function client() {
    let cookie = '';
    return async (path: string, body?: unknown, method?: string) => {
        const r = await fetch(base + path, { method: method ?? (body ? 'POST' : 'GET'), headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const set = r.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0]!;
        return { status: r.status, body: await r.json().catch(() => null) as any };
    };
}

describe('hosted mode', () => {
    const alice = client(), bob = client();
    test('anonymous users must log in', async () => {
        expect((await alice('/api/me')).body).toMatchObject({ mode: 'hosted', needsLogin: true, signups: true });
        expect((await alice('/api/accounts')).status).toBe(401);
    });
    test('sign up, validation, log in', async () => {
        expect((await alice('/api/auth/signup', { email: 'nope', password: 'longenough' })).status).toBe(400);
        expect((await alice('/api/auth/signup', { email: 'alice@example.com', password: 'short' })).status).toBe(400);
        expect((await alice('/api/auth/signup', { email: 'alice@example.com', password: 'longenough' })).status).toBe(200);
        expect((await alice('/api/me')).body.user.email).toBe('alice@example.com');
        expect((await bob('/api/auth/signup', { email: 'ALICE@example.com', password: 'longenough' })).status).toBe(409);
        expect((await bob('/api/auth/login', { email: 'alice@example.com', password: 'wrong' })).status).toBe(401);
        expect((await bob('/api/auth/signup', { email: 'bob@example.com', password: 'longenough' })).status).toBe(200);
    });
    test('accounts are private per user, limits apply', async () => {
        const add = await alice('/api/accounts', { name: 'alicebot', password: 'pw' });
        expect(add.status).toBe(200);
        const id = add.body.account.id;
        expect((await alice('/api/accounts', { botEnv: 'BOT_USERNAME=alice2\nPASSWORD=x\nSERVER=localhost' })).body.account.server).toBe('localhost');
        expect((await alice('/api/accounts', { name: 'third', password: 'pw' })).status).toBe(403);
        expect((await alice('/api/accounts', { name: 'bad name!', password: 'pw' })).status).toBe(400);
        expect((await bob('/api/accounts')).body.accounts).toEqual([]);
        expect((await bob(`/api/accounts/${id}`)).status).toBe(404);
        expect((await bob(`/api/accounts/${id}`, undefined, 'DELETE')).status).toBe(404);
        const conn = await alice(`/api/accounts/alicebot/connect`);
        expect(conn.body.botEnv).toContain('PASSWORD=pw');
        expect((await alice(`/api/accounts/${id}`, { runClient: false, server: 'other.invalid' }, 'PATCH')).body.account.server).toBe('other.invalid');
        expect((await alice(`/api/accounts/${id}`, undefined, 'DELETE')).status).toBe(200);
        expect((await alice('/api/accounts')).body.accounts.map((a: any) => a.name)).toEqual(['alice2']);
    });
    test('api tokens work as bearer auth for agents', async () => {
        const tok = (await bob('/api/tokens', { name: 'agent' })).body.token as string;
        const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bobbot', password: 'pw' }) });
        expect(r.status).toBe(200);
        const act = await fetch(`${base}/api/accounts/bobbot/activity`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Fishing shrimp' }) });
        expect(act.status).toBe(200);
        expect((await bob('/api/accounts/bobbot')).body.activity).toBe('Fishing shrimp');
        expect((await fetch(`${base}/api/accounts`, { headers: { authorization: 'Bearer rsd_wrong' } })).status).toBe(401);
    });
    test('logout ends the session', async () => {
        await alice('/api/auth/logout', {});
        expect((await alice('/api/accounts')).status).toBe(401);
    });
});
