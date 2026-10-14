// Front-server API (hosted mode): auth, per-user accounts, stateless tokens, skill. Dashboard processes are not
// spawned here (no account runs a game client and no dashboard page is requested).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { decrypt, encrypt, loadKey, makeToken, parseToken } from './crypto';
import { endpointsFor } from './gateway';
import { parseBotEnv, parseEnvAccounts, readAccountsFile, scanRsSdk } from './importers';
import { startServer } from './server';
import { frontendApi, verifyClerkToken } from './clerk';

process.env.RSD_ADMIN_EMAIL = 'operator@example.com';
const dataDir = mkdtempSync(join(tmpdir(), 'rsd-app-'));
const cfg = loadConfig({ RSD_MODE: 'hosted', RSD_DATA_DIR: dataDir, RSD_RUNTIME_DIR: join(dataDir, 'rt'), PORT: '0', HOST: '127.0.0.1', RSD_MAX_ACCOUNTS: '2', RSD_INSTANCE_PORT: '48100' });
const { server } = startServer(cfg);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function client() {
    let cookie = '';
    return async (path: string, body?: unknown, method?: string, headers: Record<string, string> = {}) => {
        const r = await fetch(base + path, { method: method ?? (body ? 'POST' : 'GET'), redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
        const set = r.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0]!;
        const text = await r.text();
        let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: r.status, body: json, text, location: r.headers.get('location') };
    };
}

describe('pure helpers', () => {
    test('gateway endpoints', () => {
        expect(endpointsFor('rs-sdk-demo.fly.dev').httpCandidates[0]).toBe('https://rs-sdk-demo.fly.dev:7443');
        expect(endpointsFor('localhost').ws).toBe('ws://localhost:7780');
    });
    test('importers', () => {
        expect(parseBotEnv('BOT_USERNAME=a\nPASSWORD="p"\n', 'd')).toEqual({ name: 'a', password: 'p', server: 'd' });
        expect(parseEnvAccounts('a:pw, b:p:w@localhost!', 'd').map(a => [a.name, a.password, a.server, a.runClient])).toEqual([['a', 'pw', 'd', false], ['b', 'p:w', 'localhost', true]]);
        const dir = mkdtempSync(join(tmpdir(), 'rsd-imp-'));
        for (const n of ['one', '_template']) { mkdirSync(join(dir, 'bots', n), { recursive: true }); writeFileSync(join(dir, 'bots', n, 'bot.env'), `BOT_USERNAME=${n}\nPASSWORD=x\n`); }
        expect(scanRsSdk(dir, 'd').map(a => a.name)).toEqual(['one']);
        writeFileSync(join(dir, 'a.json'), JSON.stringify({ accounts: [{ name: 'one', botDir: 'bots/one', client: 'managed' }] }));
        expect(readAccountsFile(join(dir, 'a.json'), 'd', dir)[0]).toMatchObject({ name: 'one', runClient: true });
    });
    test('encryption + signed tokens', () => {
        const key = loadKey(mkdtempSync(join(tmpdir(), 'rsd-k-')), '');
        expect(decrypt(key, encrypt(key, 'pw'))).toBe('pw');
        const t = makeToken(key, 7);
        expect(parseToken(key, t)?.userId).toBe(7);
        expect(parseToken(key, t.replace(/_(\d+)_/, '_8_'))).toBeNull(); // another user id breaks the signature
        expect(parseToken(loadKey(mkdtempSync(join(tmpdir(), 'rsd-k-')), ''), t)).toBeNull();
    });
});

describe('clerk (Google sign-in)', () => {
    test('publishable key -> frontend api host', () => {
        expect(frontendApi('pk_test_a2Vlbi1lYWdsZS02NjguY2xlcmsuYWNjb3VudHMuZGV2JA')).toBe('keen-eagle-668.clerk.accounts.dev');
        expect(frontendApi('sk_test_nope')).toBeNull();
    });
    test('rejects malformed and unsigned tokens', async () => {
        const pk = 'pk_test_a2Vlbi1lYWdsZS02NjguY2xlcmsuYWNjb3VudHMuZGV2JA';
        expect(await verifyClerkToken('nope', pk, [])).toMatchObject({ error: 'malformed token' });
        const fake = [{ alg: 'none' }, { email: 'x@y.z' }].map(o => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.sig';
        expect(await verifyClerkToken(fake, pk, [])).toMatchObject({ error: 'unexpected token algorithm' });
    });
    test('the endpoint is off unless a publishable key is configured', async () => {
        const r = await fetch(`${base}/_rsd/api/auth/clerk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"x"}' });
        expect(r.status).toBe(404);
    });
});

describe('hosted mode', () => {
    const alice = client(), bob = client();
    test('anonymous visitors go to the login page', async () => {
        const landing = await alice('/');
        expect(landing.status).toBe(200);
        expect(landing.text).toContain('Pick a setup');
        expect((await alice('/_rsd/api/me')).body).toMatchObject({ mode: 'hosted', needsLogin: true, signups: true });
        expect((await alice('/api/accounts')).status).toBe(401);
        expect((await alice('/_rsd/api/accounts')).status).toBe(401);
        expect((await alice('/manifest.webmanifest')).status).toBe(200);
    });
    test('sign up; a user without accounts lands on the welcome page', async () => {
        expect((await alice('/_rsd/api/auth/signup', { email: 'nope', password: 'longenough' })).status).toBe(400);
        expect((await alice('/_rsd/api/auth/signup', { email: 'alice@example.com', password: 'short' })).status).toBe(400);
        expect((await alice('/_rsd/api/auth/signup', { email: 'alice@example.com', password: 'longenough' })).status).toBe(200);
        expect((await bob('/_rsd/api/auth/signup', { email: 'ALICE@example.com', password: 'longenough' })).status).toBe(409);
        expect((await bob('/_rsd/api/auth/login', { email: 'alice@example.com', password: 'wrong' })).status).toBe(401);
        expect((await bob('/_rsd/api/auth/signup', { email: 'bob@example.com', password: 'longenough' })).status).toBe(200);
        expect((await alice('/')).location).toBe(`${base}/_rsd/welcome`);
    });
    test('accounts: validation, limits, one owner per game account', async () => {
        expect((await alice('/_rsd/api/accounts', { name: 'alicebot', password: 'pw' })).status).toBe(200);
        expect((await alice('/_rsd/api/accounts', { botEnv: 'BOT_USERNAME=alice2\nPASSWORD=x\nSERVER=localhost' })).body.account.server).toBe('localhost');
        expect((await alice('/_rsd/api/accounts', { name: 'third', password: 'pw' })).status).toBe(403);
        expect((await alice('/_rsd/api/accounts', { name: 'bad name!', password: 'pw' })).status).toBe(400);
        expect((await bob('/_rsd/api/accounts', { name: 'ALICEBOT', password: 'pw' })).status).toBe(409);
        expect((await bob('/_rsd/api/accounts')).body.accounts).toEqual([]);
        expect((await bob('/_rsd/api/accounts/alicebot', undefined, 'DELETE')).status).toBe(404);
        expect((await alice('/_rsd/api/accounts/alicebot/botenv')).text).toContain('PASSWORD=pw');
        expect((await alice('/_rsd/api/accounts/alicebot', { server: 'other.invalid' }, 'PATCH')).body.account.server).toBe('other.invalid');
        expect((await alice('/_rsd/api/accounts/alicebot', undefined, 'DELETE')).status).toBe(200);
        expect((await alice('/_rsd/api/accounts')).body.accounts.map((a: any) => a.name)).toEqual(['alice2']);
    });
    test('tokens are handed out freely, recorded on first use, revocable', async () => {
        const tok = (await bob('/_rsd/api/token')).body.token as string;
        expect((await bob('/_rsd/api/tokens')).body.tokens).toEqual([]); // not stored until used
        const agent = (path: string, b?: unknown, m?: string) => fetch(base + path, { method: m ?? (b ? 'POST' : 'GET'), headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        expect((await agent('/_rsd/api/accounts', { name: 'bobbot', password: 'pw' })).status).toBe(200);
        expect((await agent('/_rsd/api/accounts/bobbot/activity', { text: 'Fishing shrimp', goal: '99 fishing' })).status).toBe(200);
        expect((await agent('/_rsd/api/accounts/bobbot/log', { lines: ['caught a shrimp'] })).status).toBe(200);
        const used = (await bob('/_rsd/api/tokens')).body.tokens;
        expect(used).toHaveLength(1);
        expect(used[0].uses).toBe(3);
        await bob(`/_rsd/api/tokens/${used[0].id}`, undefined, 'DELETE');
        expect((await agent('/_rsd/api/accounts')).status).toBe(401);
        expect((await fetch(`${base}/_rsd/api/accounts`, { headers: { authorization: 'Bearer rsd_2_0000000000000000_00000000000000000000000000000000' } })).status).toBe(401);
    });
    test('the skill has the dashboard URL and a working token', async () => {
        const md = (await bob('/_rsd/api/skill')).text;
        const tok = /RSD_TOKEN=(rsd_\S+)/.exec(md)?.[1]!;
        expect(md).toContain(`RSD_URL=${base}`);
        expect((await fetch(`${base}/_rsd/api/accounts`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(200);
        expect((await bob("/connect.sh")).text).toContain(`DASH="${"$"}{DASH:-${base}}"`);
    });
    test('logout ends the session', async () => {
        await alice('/_rsd/api/auth/logout', {});
        expect((await alice('/_rsd/api/accounts')).status).toBe(401);
    });
});
