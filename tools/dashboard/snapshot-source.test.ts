import { describe, expect, test } from 'bun:test';
import { managedSnapshot, observerWanted, parseLiteHostStatus, parsePs, parseScriptHostStatus, pickSnapshot, psCandidates, snapshotFresh, type AccountSnapshot } from './snapshot-source';

const snap = (over: Partial<AccountSnapshot>): AccountSnapshot => ({ source: 'observer', at: 0, inGame: true, xp: { Attack: 1 }, levels: null, hp: null, pos: null, invUsed: null, inv: null, ...over });

describe('pickSnapshot', () => {
    test('prefers the first fresh in-game candidate in order', () => {
        const now = 100_000;
        const obs = snap({ source: 'observer', at: now - 1000 });
        const lite = snap({ source: 'lite-host', at: now - 500 });
        expect(pickSnapshot([obs, lite], now)!.source).toBe('observer');
        expect(pickSnapshot([null, lite], now)!.source).toBe('lite-host');
    });
    test('skips stale or logged-out candidates, then falls back to the newest one', () => {
        const now = 100_000;
        const stale = snap({ source: 'observer', at: now - 90_000 });
        const out = snap({ source: 'lite-host', at: now - 100, inGame: false });
        const managed = snap({ source: 'managed', at: now - 2000 });
        expect(pickSnapshot([stale, out, managed], now)!.source).toBe('managed');
        expect(pickSnapshot([stale, out], now)!.source).toBe('lite-host'); // newest, even though not in game
        expect(snapshotFresh(pickSnapshot([stale, out], now), now)).toBe(false);
        expect(pickSnapshot([], now)).toBeNull();
    });
});

describe('observerWanted', () => {
    test('viewer selected, recent API request, or OBSERVERS=always', () => {
        const base = { always: false, viewers: 0, lastRequestAt: 0, now: 1_000_000, idleMs: 180_000 };
        expect(observerWanted(base)).toBe(false);
        expect(observerWanted({ ...base, viewers: 1 })).toBe(true);
        expect(observerWanted({ ...base, lastRequestAt: base.now - 60_000 })).toBe(true);
        expect(observerWanted({ ...base, lastRequestAt: base.now - 200_000 })).toBe(false);
        expect(observerWanted({ ...base, always: true })).toBe(true);
    });
});

describe('lite-host status', () => {
    test('rows with xp become snapshots, rows without still register the name', () => {
        const at = Date.now();
        const m = parseLiteHostStatus({ at: new Date(at).toISOString(), bots: [
            { name: 'Soko1', state: 'online', inGame: true, xp: { Attack: 5 }, levels: { Attack: 2 }, hp: [9, 10], pos: [3222, 3218, 0], invUsed: 4, at },
            { name: 'soko2', state: 'logging in' },
        ] });
        expect(m.get('soko1')!.snapshot).toMatchObject({ source: 'lite-host', inGame: true, xp: { Attack: 5 }, hp: [9, 10], pos: [3222, 3218, 0], invUsed: 4, at });
        expect(m.get('soko2')).toEqual({ snapshot: null, state: 'logging in' });
        expect(parseLiteHostStatus(null).size).toBe(0);
    });
});

describe('managed snapshot', () => {
    test('maps the client skill tables to named skills and tile coordinates', () => {
        const xp = new Array(21).fill(0); xp[0] = 1154; xp[20] = 50;
        const base = new Array(21).fill(1); base[3] = 10;
        const eff = new Array(21).fill(1); eff[3] = 7;
        const s = managedSnapshot({ ingame: true, xp, base, eff, x: 3222, z: 3218, level: 0, inv: 3 }, 5000)!;
        expect(s.source).toBe('managed');
        expect(s.xp!.Attack).toBe(1154); expect(s.xp!.Runecraft).toBe(50); expect('Stat18' in s.xp!).toBe(false);
        expect(s.hp).toEqual([7, 10]); expect(s.pos).toEqual([3222, 3218, 0]); expect(s.invUsed).toBe(3); expect(s.at).toBe(5000);
        expect(managedSnapshot(null)).toBeNull();
        expect(managedSnapshot({ ingame: false, xp: [], base: [], eff: [], x: null, z: null, level: 0, inv: null })).toBeNull();
    });
});

describe('ps snapshot', () => {
    test('parses rows and filters candidates by bot-dir needle', () => {
        const rows = parsePs('  123 S+   bun --env-file=bots/soko1/bot.env bots/soko1/bows.ts soko1\n 456 T  bash bots/money/supervise.sh sokogp1\n 789 S tail -f bots/soko1/bows.log\n');
        expect(rows).toHaveLength(3);
        expect(rows[1]).toEqual({ pid: 456, stat: 'T', cmd: 'bash bots/money/supervise.sh sokogp1' });
        expect(psCandidates(rows, ['soko1/']).map(r => r.pid)).toEqual([123, 789]);
        expect(psCandidates(rows, ['soko1/'], [789]).map(r => r.pid)).toEqual([123]);
    });
});

describe('script-host status', () => {
    test('hosted bots carry the host pid and pause flag', () => {
        const m = parseScriptHostStatus({ pid: 42, bots: [{ name: 'soko1', script: 'bows', state: 'running', restarts: 1, paused: true }] }, '/x/script-host.json');
        expect(m.get('soko1')).toMatchObject({ name: 'soko1', script: 'bows', state: 'running', restarts: 1, hostPid: 42, paused: true });
        expect(parseScriptHostStatus({ bots: [{ name: 'x' }] }, '/x').size).toBe(0); // no host pid -> not running
    });
});
