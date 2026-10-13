import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { snapshotAccountProcess, type ProcessIdentitySnapshot } from '../quests/process-identity';

const ACCOUNT = /^[A-Za-z0-9]{1,12}$/;
const RUNNERS = /^(bun|bunx|bash|sh|zsh|node|tsx|npx)$/;

export type DashboardProcessAffiliation =
    | { kind: 'implicit' }
    | { kind: 'self'; account: string; command: string; cwd: string }
    | { kind: 'foreign'; account: string }
    | { kind: 'unknown'; reason: string };

export type DashboardProcessAffiliationOptions = {
    snapshot?: (pid: number) => ProcessIdentitySnapshot | null;
};

export function commandHasExplicitEnvFile(command: string) {
    return command.trim().split(/\s+/).some(token => token === '--env-file' || token.startsWith('--env-file='));
}

export function dashboardRunnerScript(command: string): string | null {
    const tokens = command.trim().split(/\s+/);
    if (!RUNNERS.test(basename(tokens[0] ?? ''))) return null;
    for (let i = 1; i < tokens.length && i < 8; i++) {
        const token = tokens[i]!;
        if (token === '-c' || token === '-e' || token === '--eval') return null;
        if (token === '--env-file') {
            if (i + 1 >= tokens.length) return null;
            i++;
            continue;
        }
        if (token.startsWith('--env-file=') || token.startsWith('-') || token === 'run') continue;
        if (/\.(ts|sh|js|mjs)$/.test(token)) return token;
        return null;
    }
    return null;
}

export function dashboardProcessCandidateAccepted(affiliation: DashboardProcessAffiliation,
    implicitScriptMatches: boolean) {
    if (affiliation.kind === 'foreign') return false;
    return affiliation.kind !== 'implicit' || implicitScriptMatches;
}

function explicitEnvFile(command: string, cwd: string): string | null {
    if (!command || !cwd || /["'\\;]/.test(command)) return null;
    const tokens = command.trim().split(/\s+/);
    if (basename(tokens[0] ?? '') !== 'bun') return null;
    let raw: string | null = null;
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token === '--env-file') {
            if (raw || i + 1 >= tokens.length) return null;
            raw = tokens[++i]!;
        } else if (token.startsWith('--env-file=')) {
            if (raw) return null;
            raw = token.slice('--env-file='.length);
            if (!raw) return null;
        }
    }
    return raw ? resolve(cwd, raw) : null;
}

function accountFromExactBotEnv(envFile: string): string | null {
    const resolved = resolve(envFile);
    if (!existsSync(resolved) || basename(resolved) !== 'bot.env' || basename(dirname(dirname(resolved))) !== 'bots')
        return null;
    let real: string;
    try { real = realpathSync(resolved); } catch { return null; }
    if (real !== resolved) return null;
    const folder = basename(dirname(resolved));
    if (!ACCOUNT.test(folder)) return null;
    let content: string;
    try { content = readFileSync(resolved, 'utf8'); } catch { return null; }
    const names: string[] = [];
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*BOT_USERNAME\s*=\s*(?:"([A-Za-z0-9]{1,12})"|'([A-Za-z0-9]{1,12})'|([A-Za-z0-9]{1,12}))\s*$/);
        if (match) names.push(match[1] ?? match[2] ?? match[3]!);
        else if (/^\s*BOT_USERNAME\s*=/.test(line)) return null;
    }
    if (names.length !== 1 || names[0]!.toLowerCase() !== folder.toLowerCase()) return null;
    return names[0]!;
}

export function dashboardProcessAffiliation(pid: number, expectedAccount: string, observedCommand: string,
    options: DashboardProcessAffiliationOptions = {}): DashboardProcessAffiliation {
    if (!commandHasExplicitEnvFile(observedCommand)) return { kind: 'implicit' };
    if (!ACCOUNT.test(expectedAccount) || !Number.isInteger(pid) || pid <= 1)
        return { kind: 'unknown', reason: 'invalid-account-or-pid' };
    const snapshot = (options.snapshot ?? snapshotAccountProcess)(pid);
    if (!snapshot) return { kind: 'unknown', reason: 'missing-live-process-evidence' };
    if (!snapshot.beforeStart || snapshot.beforeStart !== snapshot.afterStart
        || snapshot.command !== snapshot.afterCommand || snapshot.cwd !== snapshot.afterCwd)
        return { kind: 'unknown', reason: 'process-changed-during-read' };
    const envFile = explicitEnvFile(snapshot.command, snapshot.cwd);
    const account = envFile ? accountFromExactBotEnv(envFile) : null;
    if (!account || snapshot.environmentRead !== true
        || (snapshot.inheritedBotUsername !== null
            && snapshot.inheritedBotUsername.toLowerCase() !== account.toLowerCase()))
        return { kind: 'unknown', reason: 'effective-account-is-unproved' };
    return account.toLowerCase() === expectedAccount.toLowerCase()
        ? { kind: 'self', account, command: snapshot.command, cwd: snapshot.cwd }
        : { kind: 'foreign', account };
}
