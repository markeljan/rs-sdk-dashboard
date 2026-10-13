import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandHasExplicitEnvFile, dashboardProcessAffiliation,
    dashboardProcessCandidateAccepted, dashboardRunnerScript } from './process-affiliation';
import type { ProcessIdentitySnapshot } from '../quests/process-identity';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-proc-affiliation-')));
    roots.push(root);
    for (const account of ['SOKO', 'sokobot']) {
        mkdirSync(join(root, 'bots', account), { recursive: true });
        writeFileSync(join(root, 'bots', account, 'bot.env'), `BOT_USERNAME=${account}\nPASSWORD=secret-not-returned\n`);
    }
    const command = 'bun --env-file=bots/sokobot/bot.env bots/SOKO/quests/naturespirit.ts';
    const snapshot = (overrides: Partial<ProcessIdentitySnapshot> = {}): ProcessIdentitySnapshot => ({
        beforeStart: 'start-a', afterStart: 'start-a', command, afterCommand: command,
        cwd: root, afterCwd: root, environmentRead: true, inheritedBotUsername: null,
        ...overrides,
    });
    return { root, command, snapshot };
}

describe('dashboard process account affiliation', () => {
    test('assigns shared SOKO quest code to the explicit sokobot environment only', () => {
        const { command, snapshot } = fixture();
        expect(dashboardProcessAffiliation(61_753, 'SOKO', command, { snapshot: () => snapshot() })).toEqual({
            kind: 'foreign', account: 'sokobot',
        });
        expect(dashboardProcessAffiliation(61_753, 'sokobot', command, { snapshot: () => snapshot() })).toMatchObject({
            kind: 'self', account: 'sokobot', command,
        });
    });

    test('keeps a matching explicit environment under its own account', () => {
        const { root, snapshot } = fixture();
        const command = 'bun --env-file=bots/SOKO/bot.env bots/SOKO/quests/naturespirit.ts';
        expect(dashboardProcessAffiliation(100, 'SOKO', command, {
            snapshot: () => snapshot({ command, afterCommand: command, cwd: root, afterCwd: root }),
        })).toMatchObject({ kind: 'self', account: 'SOKO' });
    });

    test('fails closed on inherited overrides, malformed env files and process races', () => {
        const { root, command, snapshot } = fixture();
        expect(dashboardProcessAffiliation(101, 'sokobot', command, {
            snapshot: () => snapshot({ inheritedBotUsername: 'SOKO' }),
        })).toEqual({ kind: 'unknown', reason: 'effective-account-is-unproved' });
        const duplicate = `${command} --env-file=bots/SOKO/bot.env`;
        expect(dashboardProcessAffiliation(102, 'SOKO', duplicate, {
            snapshot: () => snapshot({ command: duplicate, afterCommand: duplicate }),
        })).toEqual({ kind: 'unknown', reason: 'effective-account-is-unproved' });
        expect(dashboardProcessAffiliation(103, 'sokobot', command, {
            snapshot: () => snapshot({ afterStart: 'start-b' }),
        })).toEqual({ kind: 'unknown', reason: 'process-changed-during-read' });
        writeFileSync(join(root, 'bots/sokobot/bot.env'), 'BOT_USERNAME=SOKO\n');
        expect(dashboardProcessAffiliation(104, 'sokobot', command, { snapshot: () => snapshot() })).toEqual({
            kind: 'unknown', reason: 'effective-account-is-unproved',
        });
    });

    test('legacy direct scripts without an env-file retain path-based matching', () => {
        let snapshots = 0;
        const command = 'bun bots/SOKO/quests/naturespirit.ts';
        expect(commandHasExplicitEnvFile(command)).toBe(false);
        expect(dashboardProcessAffiliation(105, 'SOKO', command, {
            snapshot: () => { snapshots++; return null; },
        })).toEqual({ kind: 'implicit' });
        expect(snapshots).toBe(0);
    });

    test('server excludes only proven foreign processes and keeps unknown evidence blocking', () => {
        const unknown = { kind: 'unknown', reason: 'missing-live-process-evidence' } as const;
        expect(dashboardProcessCandidateAccepted(unknown, false)).toBe(true);
        expect(dashboardProcessCandidateAccepted({ kind: 'unknown', reason: 'process-changed-during-read' }, false)).toBe(true);
        expect(dashboardProcessCandidateAccepted({ kind: 'unknown', reason: 'effective-account-is-unproved' }, false)).toBe(true);
        expect(dashboardProcessCandidateAccepted({ kind: 'foreign', account: 'sokobot' }, true)).toBe(false);
        expect(dashboardProcessCandidateAccepted({ kind: 'implicit' }, false)).toBe(false);
        expect(dashboardProcessCandidateAccepted({ kind: 'implicit' }, true)).toBe(true);
    });

    test('server parser supports equals and split env-file forms without matching shell wrappers', () => {
        expect(dashboardRunnerScript('bun --env-file=bots/sokobot/bot.env bots/SOKO/quests/naturespirit.ts'))
            .toBe('bots/SOKO/quests/naturespirit.ts');
        expect(dashboardRunnerScript('bun --env-file bots/sokobot/bot.env bots/SOKO/quests/naturespirit.ts'))
            .toBe('bots/SOKO/quests/naturespirit.ts');
        expect(dashboardRunnerScript('zsh -c "bun --env-file=bots/sokobot/bot.env bots/SOKO/quests/naturespirit.ts"'))
            .toBeNull();
    });

    test('quoted and unreadable explicit environments never fall back to the script folder', () => {
        const { root, snapshot } = fixture();
        const quoted = `bun --env-file='bots/sokobot/bot.env' bots/SOKO/quests/naturespirit.ts`;
        expect(dashboardProcessAffiliation(106, 'SOKO', quoted, {
            snapshot: () => snapshot({ command: quoted, afterCommand: quoted, cwd: root, afterCwd: root }),
        })).toEqual({ kind: 'unknown', reason: 'effective-account-is-unproved' });
        const missing = 'bun --env-file=bots/missing/bot.env bots/SOKO/quests/naturespirit.ts';
        expect(dashboardProcessAffiliation(107, 'SOKO', missing, {
            snapshot: () => snapshot({ command: missing, afterCommand: missing, cwd: root, afterCwd: root }),
        })).toEqual({ kind: 'unknown', reason: 'effective-account-is-unproved' });
    });
});
