import { describe, expect, test } from 'bun:test';
import { questLoopTasks, runningLabel, summarizeActivity } from './activity-summary';

const NOW = Date.parse('2026-10-06T00:00:00Z');
const loopProc = { kind: 'supervisor', stopped: false, cmd: '/bin/bash bots/sokobot/questloop.sh crest druidspirit murder', script: '/r/bots/sokobot/questloop.sh' };
const runProc = { kind: 'script', stopped: false, cmd: 'bun tools/quests/run.ts sokobot crest', script: '/r/tools/quests/run.ts' };

describe('activity summary', () => {
    test('labels the leaf script with its args, minus the account name', () => {
        expect(runningLabel([loopProc, runProc], 'sokobot')).toBe('run crest');
        expect(runningLabel([], 'sokobot')).toBeNull();
    });

    test('quest loop queue drives the task list', () => {
        const run = { current: { key: 'crest', startedAt: null }, results: [{ key: 'murder', rc: 1, ok: false, at: null }] };
        const q = questLoopTasks(['crest', 'druidspirit', 'murder'], run, [{ key: 'druidspirit', name: 'Nature Spirit', status: 'complete' }, { key: 'crest', name: 'Family Crest', status: 'in-progress' }]);
        expect(q.tasks).toEqual([
            { title: 'Family Crest', status: 'current' },
            { title: 'Nature Spirit', status: 'done' },
            { title: 'murder', status: 'blocked' },
        ]);
        expect(q.current).toBe('Quest loop: Family Crest (1/3 of queue done)');
    });

    test('stale tasks.json current is replaced by the running script and latest log line', () => {
        const a = summarizeActivity({
            account: 'sokobot', now: NOW, tasks: { current: 'Gear up -> Dragons', tasks: [] }, tasksMtime: NOW - 3 * 86_400_000,
            procs: [{ kind: 'script', stopped: false, cmd: 'bun bots/sokogp1/money.ts', script: '/r/bots/sokogp1/money.ts' }],
            lastLogLine: '[8:24:34 PM] [thief] pickpocket guard', logMtime: NOW - 1000,
        });
        expect(a.current).toBe('money · thief: pickpocket guard');
        expect(a.stale).toBe(true);
    });

    test('fresh tasks.json current wins while a script runs', () => {
        const a = summarizeActivity({ account: 'x', now: NOW, tasks: { current: 'Dwarf Cannon' }, tasksMtime: NOW - 60_000, procs: [runProc], lastLogLine: 'step', logMtime: NOW });
        expect(a.current).toBe('Dwarf Cannon');
    });

    test('no running script reads as idle', () => {
        const a = summarizeActivity({ account: 'x', now: NOW, tasks: null, tasksMtime: null, procs: [], lastLogLine: '[supervise] STOP file present - exiting', logMtime: NOW });
        expect(a.current).toBe('Idle - no bot script running (last: STOP file present - exiting)');
    });
});
