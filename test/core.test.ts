import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decrypt, encrypt, loadKey } from '../src/crypto';
import { Store } from '../src/db';
import { clientUrl, endpointsFor } from '../src/gateway';
import { parseBotEnv, parseEnvAccounts, readAccountsFile, scanRsSdk } from '../src/importers';
import { summarize, xpRate } from '../src/runtime';

const tmp = () => mkdtempSync(join(tmpdir(), 'rsd-test-'));

describe('gateway endpoints', () => {
    test('public server', () => {
        const e = endpointsFor('rs-sdk-demo.fly.dev');
        expect(e.web).toBe('https://rs-sdk-demo.fly.dev');
        expect(e.ws).toBe('wss://rs-sdk-demo.fly.dev/gateway');
        expect(e.httpCandidates).toEqual(['https://rs-sdk-demo.fly.dev:7443', 'https://rs-sdk-demo.fly.dev/gateway']);
    });
    test('localhost uses the engine web port and gateway port 7780', () => {
        expect(endpointsFor('localhost')).toEqual({ web: 'http://localhost:8888', ws: 'ws://localhost:7780', httpCandidates: ['http://localhost:7780'] });
        expect(endpointsFor('localhost:8080').web).toBe('http://localhost:8080');
    });
    test('explicit ws url', () => {
        const e = endpointsFor('wss://example.com/gateway');
        expect(e.web).toBe('https://example.com');
        expect(e.httpCandidates[0]).toBe('https://example.com');
    });
    test('client url escapes credentials', () => {
        expect(clientUrl('rs-sdk-demo.fly.dev', 'a b', 'p&q')).toBe('https://rs-sdk-demo.fly.dev/bot?bot=a%20b&password=p%26q');
    });
});

describe('importers', () => {
    test('bot.env', () => {
        expect(parseBotEnv('BOT_USERNAME=mybot\nPASSWORD="pw1"\nSERVER=localhost\n', 'x')).toEqual({ name: 'mybot', password: 'pw1', server: 'localhost' });
        expect(parseBotEnv('BOT_USERNAME=mybot\nPASSWORD=pw\n', 'def')?.server).toBe('def');
        expect(parseBotEnv('SERVER=x', 'def')).toBeNull();
    });
    test('RSD_ACCOUNTS', () => {
        expect(parseEnvAccounts('a:pw, b:p:w@localhost!, bad', 'def')).toEqual([
            { name: 'a', password: 'pw', server: 'def', runClient: false },
            { name: 'b', password: 'p:w', server: 'localhost', runClient: true },
        ]);
    });
    test('accounts file + rs-sdk checkout', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'bots', 'one'), { recursive: true });
        mkdirSync(join(dir, 'bots', '_template'), { recursive: true });
        writeFileSync(join(dir, 'bots', 'one', 'bot.env'), 'BOT_USERNAME=one\nPASSWORD=x\n');
        writeFileSync(join(dir, 'bots', '_template', 'bot.env'), 'BOT_USERNAME={{USERNAME}}\nPASSWORD={{PASSWORD}}\n');
        expect(scanRsSdk(dir, 'def').map(a => a.name)).toEqual(['one']);
        const f = join(dir, 'accounts.json');
        writeFileSync(f, JSON.stringify({ accounts: [{ name: 'two', password: 'y', runClient: true }, { name: 'one', botDir: 'bots/one', client: 'managed' }] }));
        const list = readAccountsFile(f, 'def');
        expect(list.map(a => [a.name, a.runClient])).toEqual([['two', true], ['one', true]]);
    });
});

describe('storage', () => {
    test('passwords are encrypted at rest and round-trip', () => {
        const dir = tmp();
        const key = loadKey(dir, '');
        expect(decrypt(key, encrypt(key, 'hunter2'))).toBe('hunter2');
        const s = new Store(dir, key);
        const u = s.ensureLocalUser();
        const id = s.upsertAccount(u.id, { name: 'Bob', password: 'secret', server: 'srv' });
        const raw = s.db.query('SELECT password_enc FROM accounts WHERE id = ?').get(id) as { password_enc: string };
        expect(raw.password_enc).not.toContain('secret');
        expect(s.findAccount(u.id, 'bob')?.password).toBe('secret');
        expect(s.upsertAccount(u.id, { name: 'BOB', password: 'new', server: 'srv' })).toBe(id); // same account, case-insensitive
        expect(s.getAccount(id)?.password).toBe('new');
    });
    test('users, sessions and api tokens', async () => {
        const dir = tmp();
        const s = new Store(dir, loadKey(dir, 'k'));
        const u = await s.createUser('A@x.io', 'password1');
        expect(await s.checkPassword('a@x.io', 'password1')).toMatchObject({ id: u.id });
        expect(await s.checkPassword('a@x.io', 'nope')).toBeNull();
        const sess = s.createSession(u.id);
        expect(s.sessionUser(sess)?.id).toBe(u.id);
        s.deleteSession(sess);
        expect(s.sessionUser(sess)).toBeNull();
        const tok = s.createApiToken(u.id, 'agent');
        expect(tok.startsWith('rsd_')).toBe(true);
        expect(s.apiTokenUser(tok)?.id).toBe(u.id);
        expect(s.listApiTokens(u.id)[0]?.last_used_at).toBeGreaterThan(0);
        const other = await s.createUser('b@x.io', 'password2');
        s.upsertAccount(u.id, { name: 'mine', password: 'p', server: 'srv' });
        expect(s.listAccounts(other.id)).toEqual([]);
    });
});

describe('state summary', () => {
    test('summarize + xp rate', () => {
        const s = summarize({
            inGame: true, tick: 5,
            player: { name: 'Bob', combatLevel: 3, hp: 9, maxHp: 10, worldX: 3222, worldZ: 3218, level: 0, runEnergy: 100 },
            skills: [{ name: 'Hitpoints', level: 9, baseLevel: 10, experience: 1154 }, { name: 'Attack', level: 1, baseLevel: 1, experience: 0 }],
            inventory: [{ slot: 0, id: 995, name: 'Coins', count: 25 }, { slot: 1, id: -1, name: '', count: 0 }],
            equipment: [], gameMessages: [{ type: 0, text: 'Welcome' }],
        })!;
        expect(s.skills.map(k => k.name)).toEqual(['Attack', 'Hitpoints']);
        expect(s.totalLevel).toBe(11);
        expect(s.inventory).toHaveLength(1);
        const now = 10_000_000;
        expect(xpRate([{ at: now - 30 * 60_000, total_xp: 1000 }, { at: now, total_xp: 6000 }], now)).toBe(10_000);
        expect(xpRate([{ at: now - 60_000, total_xp: 1000 }, { at: now, total_xp: 6000 }], now)).toBeNull();
    });
});
