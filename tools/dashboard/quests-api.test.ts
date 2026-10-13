import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildQuestsPayload, classifyFastTravel, parseFastTravel, parseQuestRunLog, readTail } from './quests-api';

const RUN_LOG = `=== Mon Oct  5 12:51:35 EDT 2026 QLOOP fortress
START fortress account=sokobot
QLOOP_RESULT fortress rc=0
=== Mon Oct  5 12:58:57 EDT 2026 QLOOP haunted
Error: Quest haunted: script-escalation
QLOOP_RESULT haunted rc=1
=== Mon Oct  5 13:51:15 EDT 2026 QLOOP tree
START tree account=sokobot
`;

describe('parseQuestRunLog', () => {
    test('current = last header without a result; results newest first with header timestamps', () => {
        const r = parseQuestRunLog(RUN_LOG);
        expect(r.current).toEqual({ key: 'tree', startedAt: '2026-10-05T17:51:15.000Z' });
        expect(r.results).toEqual([
            { key: 'haunted', rc: 1, ok: false, at: '2026-10-05T16:58:57.000Z' },
            { key: 'fortress', rc: 0, ok: true, at: '2026-10-05T16:51:35.000Z' },
        ]);
    });
    test('no current when the last header has its result', () => {
        expect(parseQuestRunLog(RUN_LOG + 'QLOOP_RESULT tree rc=0\n').current).toBeNull();
    });
    test('a header superseded by a newer one (killed run) is not current', () => {
        const r = parseQuestRunLog('=== Mon Oct  5 10:00:00 EDT 2026 QLOOP a\n=== Mon Oct  5 10:05:00 EDT 2026 QLOOP b\nQLOOP_RESULT b rc=0\n');
        expect(r.current).toBeNull();
        expect(r.results.map(x => x.key)).toEqual(['b']);
    });
    test('caps results', () => {
        const text = Array.from({ length: 40 }, (_, i) => `=== Mon Oct  5 10:00:00 EDT 2026 QLOOP q${i}\nQLOOP_RESULT q${i} rc=0`).join('\n');
        const r = parseQuestRunLog(text);
        expect(r.results.length).toBe(30);
        expect(r.results[0]!.key).toBe('q39');
    });
});

describe('fast-travel parsing', () => {
    test('classifies lines', () => {
        expect(classifyFastTravel('fast-travel: Charter ship ok (3000,3200) -> (2800,3100,L0)')).toBe('ok');
        expect(classifyFastTravel('fast-travel: Gnome glider FAILED (1,2) -> (3,4,L0)')).toBe('failed');
        expect(classifyFastTravel('fast-travel plan (1,2) -> (3,4): A + B ~40t vs walk 300t (planned in 3ms)')).toBe('plan');
        expect(classifyFastTravel('fast-travel: Canoe blocked: no axe')).toBe('blocked');
        expect(classifyFastTravel('fast-travel: Canoe: npc not found')).toBeNull();
        expect(classifyFastTravel('walking to (1,2)')).toBeNull();
    });
    test('counts and keeps newest lines first', () => {
        const s = parseFastTravel([
            { name: 'a.log', text: 'fast-travel plan (1,2) -> (3,4): X\nfast-travel: X ok (1,2) -> (3,4,L0)\n' },
            { name: 'b.log', text: 'fast-travel: Y FAILED (1,2) -> (1,2,L0)\nnoise\n' },
        ], 2);
        expect(s.counts).toEqual({ ok: 1, failed: 1, plan: 1, blocked: 0 });
        expect(s.recent.map(r => `${r.file}:${r.kind}`)).toEqual(['b.log:failed', 'a.log:ok']);
    });
});

describe('readTail + buildQuestsPayload', () => {
    test('readTail drops the partial first line', () => {
        const d = mkdtempSync(join(tmpdir(), 'qapi-'));
        const f = join(d, 'x.log');
        writeFileSync(f, 'aaaa\nbbbb\ncccc\n');
        expect(readTail(f, 7)).toBe('cccc\n');
        expect(readTail(f, 1000)).toBe('aaaa\nbbbb\ncccc\n');
    });
    test('assembles live, run and fast-travel (24h window)', () => {
        const root = mkdtempSync(join(tmpdir(), 'qapi-'));
        const bot = join(root, 'bot'), soko = join(root, 'SOKO');
        mkdirSync(join(bot, 'telemetry'), { recursive: true }); mkdirSync(soko);
        writeFileSync(join(bot, 'telemetry', 'quests-live.json'), JSON.stringify({ observedAt: 'x', questPoints: 5, totalQuestPoints: 10, completed: 1, total: 2, quests: [{ key: 'a', name: 'A', questPoints: 1, status: 'complete', extra: 1 }, { key: 'b', name: 'B', questPoints: 4, status: 'not-started' }] }));
        writeFileSync(join(bot, 'quests-run.log'), RUN_LOG);
        writeFileSync(join(bot, 'q_new.log'), 'fast-travel: X ok (1,2) -> (3,4,L0)\n');
        writeFileSync(join(soko, 'q_old.log'), 'fast-travel: Y FAILED (1,2) -> (1,2,L0)\n');
        const old = (Date.now() - 48 * 3600_000) / 1000;
        utimesSync(join(soko, 'q_old.log'), old, old);
        const p = buildQuestsPayload({ account: 'bot', botDir: bot, sokoDir: soko });
        expect(p.live.questPoints).toBe(5);
        expect(p.live.quests[0]).toEqual({ key: 'a', name: 'A', questPoints: 1, status: 'complete' });
        expect(p.run.current?.key).toBe('tree');
        expect(p.fastTravel.counts).toEqual({ ok: 1, failed: 0, plan: 0, blocked: 0 });
        expect(p.fastTravel.recent[0]!.file).toBe('bot/q_new.log');
    });
    test('missing files degrade gracefully', () => {
        const root = mkdtempSync(join(tmpdir(), 'qapi-'));
        const p = buildQuestsPayload({ account: 'x', botDir: join(root, 'nope'), sokoDir: join(root, 'nope2') });
        expect(p.live).toBeNull();
        expect(p.liveError).toBe('no quests-live.json yet');
        expect(p.run.current).toBeNull();
        expect(p.fastTravel.files).toBe(0);
    });
});
