import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { latestAccountActivityLog } from './activity-log';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-activity-'));
    roots.push(root);
    const botDir = join(root, 'bots', 'account');
    const telemetry = join(botDir, 'telemetry');
    mkdirSync(telemetry, { recursive: true });
    return { root, botDir, telemetry };
}

function writeAt(path: string, seconds: number) {
    writeFileSync(path, `${path}\n`);
    utimesSync(path, seconds, seconds);
}

describe('dashboard account activity logs', () => {
    test('selects the freshest root or telemetry log and preserves root labels', () => {
        const { botDir, telemetry } = fixture();
        const rootLog = join(botDir, 'q_dragonslayer.log');
        const nestedLog = join(telemetry, 'q_sheepherder.log');
        writeAt(rootLog, 100);
        writeAt(nestedLog, 200);

        expect(latestAccountActivityLog(botDir, botDir)).toMatchObject({
            path: realpathSync(nestedLog),
            file: 'telemetry/q_sheepherder.log',
            mtime: 200_000,
        });

        writeAt(rootLog, 300);
        expect(latestAccountActivityLog(botDir, botDir)).toMatchObject({
            path: realpathSync(rootLog),
            file: 'q_dragonslayer.log',
            mtime: 300_000,
        });
    });

    test('does not follow telemetry or log symlinks and rejects a foreign logDir', () => {
        const { root, botDir, telemetry } = fixture();
        const rootLog = join(botDir, 'q_safe.log');
        const foreign = join(root, 'bots', 'other');
        mkdirSync(foreign, { recursive: true });
        const foreignLog = join(foreign, 'q_foreign.log');
        writeAt(rootLog, 100);
        writeAt(foreignLog, 500);
        symlinkSync(foreignLog, join(telemetry, 'q_link.log'));

        expect(latestAccountActivityLog(botDir, botDir)?.file).toBe('q_safe.log');
        expect(latestAccountActivityLog(foreign, botDir)).toBeNull();

        rmSync(telemetry, { recursive: true, force: true });
        symlinkSync(foreign, telemetry);
        expect(latestAccountActivityLog(botDir, botDir)?.file).toBe('q_safe.log');
    });
});
