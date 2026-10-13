import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export type DashboardAutomationProc = {
    pid?: unknown;
    stopped?: unknown;
    cmd?: unknown;
    script?: unknown;
    [key: string]: unknown;
};

export type ProcessIdentitySnapshot = {
    beforeStart: string;
    afterStart: string;
    command: string;
    cwd: string;
    afterCommand: string;
    afterCwd: string;
    environmentRead: boolean;
    /** Inherited OS environment reduced to this non-secret field. Bun applies
     * --env-file inside its runtime, so a successful read with null means no
     * inherited override; the one exact env-file then determines identity. */
    inheritedBotUsername: string | null;
};

export type ProvenAccountProcess = {
    pid: number;
    account: string;
    envFile: string;
    script: string;
    start: string;
};

type DirectBunLaunch = {
    envFile: string;
    script: string;
    /** The Lost City kit helper deliberately selects and validates one account
     * before it creates the account-local PID receipt or opens a controller. */
    qualifiedAccount?: string;
};

export type ProcessAttribution =
    | { kind: 'foreign'; proof: ProvenAccountProcess }
    | { kind: 'self'; proof: ProvenAccountProcess }
    | { kind: 'unknown'; pid: number | null; reason: string };

export type ProcessIdentityOptions = {
    root?: string;
    snapshot?: (pid: number) => ProcessIdentitySnapshot | null | Promise<ProcessIdentitySnapshot | null>;
};

const ROOT = resolve(import.meta.dir, '../..');
const ACCOUNT = /^[A-Za-z0-9]{1,12}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_./:=-]+$/;

function capture(args: string[]) {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim();
}

function effectiveBotUsername(pid: number): { read: boolean; value: string | null } {
    // macOS ps exposes argv plus environment. Keep the raw buffer private and
    // reduce it immediately to BOT_USERNAME; never include argv/environment in
    // an error or returned object.
    const raw = capture(['ps', 'eww', '-p', String(pid), '-o', 'command=']);
    if (raw === null) return { read: false, value: null };
    const matches = [...raw.matchAll(/(?:^|\s)BOT_USERNAME=(.*?)(?=\s+[^\s=]+=|$)/g)]
        .map(match => match[1]!);
    if (matches.length > 1 || matches.some(value => !ACCOUNT.test(value)))
        return { read: false, value: null };
    return { read: true, value: matches[0] ?? null };
}

export function snapshotAccountProcess(pid: number): ProcessIdentitySnapshot | null {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const beforeStart = capture(['ps', '-p', String(pid), '-o', 'lstart=']);
    if (!beforeStart) return null;
    const command = capture(['ps', '-ww', '-p', String(pid), '-o', 'command=']);
    if (!command) return null;
    const cwdRaw = capture(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const cwd = cwdRaw?.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? '';
    if (!cwd) return null;
    const effective = effectiveBotUsername(pid);
    const afterCommand = capture(['ps', '-ww', '-p', String(pid), '-o', 'command=']);
    const afterCwdRaw = capture(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const afterCwd = afterCwdRaw?.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? '';
    const afterStart = capture(['ps', '-p', String(pid), '-o', 'lstart=']);
    if (!afterStart || !afterCommand || !afterCwd) return null;
    return { beforeStart, afterStart, command, cwd, afterCommand, afterCwd,
        inheritedBotUsername: effective.value, environmentRead: effective.read };
}

function contained(root: string, path: string) {
    const rel = relative(root, path);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function directBunLaunch(command: string, cwd: string, root = ROOT): DirectBunLaunch | null {
    if (!command || !cwd || /["'\\;]/.test(command)) return null;
    const tokens = command.trim().split(/\s+/);
    if (tokens.length < 3 || basename(tokens[0]!) !== 'bun' || tokens.some(token => !SAFE_TOKEN.test(token)))
        return null;
    let envRaw: string | null = null;
    let scriptRaw: string | null = null;
    let accountRaw: string | null = null;
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token === '--env-file') {
            if (envRaw || i + 1 >= tokens.length) return null;
            envRaw = tokens[++i]!;
            continue;
        }
        if (token.startsWith('--env-file=')) {
            if (envRaw) return null;
            envRaw = token.slice('--env-file='.length);
            if (!envRaw) return null;
            continue;
        }
        if (!scriptRaw && token.endsWith('.ts')) { scriptRaw = token; continue; }
        if (scriptRaw && !accountRaw && ACCOUNT.test(token)) { accountRaw = token; continue; }
        return null; // inline/eval/run flags, overrides and script arguments stay blocking
    }
    if (!scriptRaw || (envRaw && accountRaw) || (!envRaw && !accountRaw)) return null;
    const repo = resolve(root), script = resolve(cwd, scriptRaw);
    const envFile = envRaw ? resolve(cwd, envRaw) : resolve(repo, 'bots', accountRaw!, 'bot.env');
    if (!contained(repo, envFile) || !contained(repo, script)) return null;
    if (!accountRaw) return { envFile, script };

    // This is intentionally one exact, reviewed account-portable helper. Its
    // main path selects argv[2], scrubs credential/control variables, loads
    // bots/<account>/bot.env, and acquires the selected account's PID lock
    // before passive dashboard admission and runScript. Other helpers and
    // symlinked aliases remain ambiguous even when they accept an account arg.
    const helper = resolve(repo, 'bots', 'SOKO', 'prepare-lostcity-kit.ts');
    let realScript: string;
    try { realScript = realpathSync(script); } catch { return null; }
    if (script !== helper || realScript !== helper) return null;
    return { envFile, script, qualifiedAccount: accountRaw };
}

function qualifiedLaunchReceipt(pid: number, account: string, root: string) {
    const receipt = resolve(root, 'bots', account, 'telemetry', 'quests-run.lock');
    if (!contained(resolve(root, 'bots'), receipt) || !existsSync(receipt)) return false;
    try {
        const stat = lstatSync(receipt);
        return stat.isFile() && !stat.isSymbolicLink() && realpathSync(receipt) === receipt
            && readFileSync(receipt, 'utf8').trim() === String(pid);
    } catch { return false; }
}

export function accountFromBotEnv(envFile: string, root = ROOT): string | null {
    const repo = resolve(root), bots = resolve(repo, 'bots'), resolved = resolve(envFile);
    if (!contained(bots, resolved) || !existsSync(resolved)) return null;
    let real: string;
    try { real = realpathSync(resolved); } catch { return null; }
    if (real !== resolved) return null;
    const rel = relative(bots, resolved).split(sep);
    if (rel.length !== 2 || rel[1] !== 'bot.env' || !ACCOUNT.test(rel[0]!)) return null;
    let content: string;
    try { content = readFileSync(resolved, 'utf8'); } catch { return null; }
    const names: string[] = [];
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*BOT_USERNAME\s*=\s*(?:"([A-Za-z0-9]{1,12})"|'([A-Za-z0-9]{1,12})'|([A-Za-z0-9]{1,12}))\s*$/);
        if (match) names.push(match[1] ?? match[2] ?? match[3]!);
        else if (/^\s*BOT_USERNAME\s*=/.test(line)) return null;
    }
    if (names.length !== 1 || names[0]!.toLowerCase() !== rel[0]!.toLowerCase()) return null;
    return names[0]!;
}

function accountScript(script: string, root: string, account: string): string | null {
    let real: string;
    try { real = realpathSync(script); } catch { return null; }
    if (!contained(root, real)) return null;
    if (real === script) return real;
    let stat;
    try { stat = lstatSync(script); } catch { return null; }
    if (!stat.isSymbolicLink()) return null;
    const rel = relative(root, script).split(sep);
    if (rel.length !== 5 || rel[0] !== 'bots' || rel[2] !== 'telemetry'
        || rel[3] !== 'quest-entrypoints' || !ACCOUNT.test(rel[1]!)
        || rel[1]!.toLowerCase() !== account.toLowerCase()
        || !/^[a-z0-9_-]+\.ts$/i.test(rel[4]!)) return null;
    return real;
}

export async function attributeAccountProcess(proc: DashboardAutomationProc, account: string,
    options: ProcessIdentityOptions = {}): Promise<ProcessAttribution> {
    const pid = Number(proc.pid);
    if (!ACCOUNT.test(account) || !Number.isInteger(pid) || pid <= 1)
        return { kind: 'unknown', pid: Number.isInteger(pid) ? pid : null, reason: 'invalid-account-or-pid' };
    if (proc.stopped === true) return { kind: 'unknown', pid, reason: 'stopped-process' };
    const snapshot = await (options.snapshot ?? snapshotAccountProcess)(pid);
    if (!snapshot) return { kind: 'unknown', pid, reason: 'missing-live-process-evidence' };
    if (!snapshot.beforeStart || snapshot.beforeStart !== snapshot.afterStart
        || !snapshot.afterCommand || snapshot.command !== snapshot.afterCommand
        || !snapshot.afterCwd || snapshot.cwd !== snapshot.afterCwd)
        return { kind: 'unknown', pid, reason: 'process-changed-during-read' };
    const root = resolve(options.root ?? ROOT);
    const launch = directBunLaunch(snapshot.command, snapshot.cwd, root);
    if (!launch) return { kind: 'unknown', pid, reason: 'unsupported-or-ambiguous-launch' };
    const launchedAccount = accountFromBotEnv(launch.envFile, root);
    if (!launchedAccount
        || launch.qualifiedAccount !== undefined
            && (launch.qualifiedAccount.toLowerCase() !== launchedAccount.toLowerCase()
                || !qualifiedLaunchReceipt(pid, launchedAccount, root))
        || snapshot.environmentRead !== true
        || (snapshot.inheritedBotUsername !== null
            && snapshot.inheritedBotUsername.toLowerCase() !== launchedAccount.toLowerCase()))
        return { kind: 'unknown', pid, reason: 'effective-account-is-unproved' };
    const realScript = accountScript(launch.script, root, launchedAccount);
    if (!realScript) return { kind: 'unknown', pid, reason: 'script-is-not-a-repository-file' };
    const proof = { pid, account: launchedAccount, envFile: launch.envFile,
        script: realScript, start: snapshot.beforeStart };
    return launchedAccount.toLowerCase() === account.toLowerCase()
        ? { kind: 'self', proof }
        : { kind: 'foreign', proof };
}

export async function partitionAccountAutomationProcs<T>(account: string,
    procs: readonly T[], options: ProcessIdentityOptions = {}) {
    const blocking: T[] = [], foreign: ProvenAccountProcess[] = [];
    for (const raw of procs) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { blocking.push(raw); continue; }
        const proc = raw as DashboardAutomationProc;
        const result = await attributeAccountProcess(proc, account, options);
        if (result.kind === 'foreign') foreign.push(result.proof);
        else blocking.push(raw);
    }
    return { blocking, foreign };
}
