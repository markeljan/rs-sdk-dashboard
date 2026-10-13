// Account onboarding without the web UI: environment variable, accounts JSON file, or an rs-sdk checkout.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type ImportedAccount = { name: string; password: string; server: string; runClient?: boolean; botDir?: string };

/** rs-sdk bot.env -> credentials. Accepts BOT_USERNAME/USERNAME, PASSWORD, SERVER. */
export function parseBotEnv(text: string, defaultServer: string): ImportedAccount | null {
    const v: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (m) v[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
    const name = v.BOT_USERNAME || v.USERNAME;
    if (!name || !v.PASSWORD) return null;
    return { name, password: v.PASSWORD, server: v.SERVER || defaultServer };
}

/** RSD_ACCOUNTS="name:password[@server][!client], other:pw" - a trailing ! runs a game client on the dashboard. */
export function parseEnvAccounts(spec: string, defaultServer: string): ImportedAccount[] {
    const out: ImportedAccount[] = [];
    for (const raw of spec.split(/[,\n;]/)) {
        let s = raw.trim();
        if (!s) continue;
        const runClient = s.endsWith('!');
        if (runClient) s = s.slice(0, -1);
        const at = s.lastIndexOf('@');
        const server = at > 0 ? s.slice(at + 1) : defaultServer;
        const cred = at > 0 ? s.slice(0, at) : s;
        const i = cred.indexOf(':');
        if (i <= 0) continue;
        out.push({ name: cred.slice(0, i), password: cred.slice(i + 1), server, runClient });
    }
    return out;
}

/** accounts.json: {"accounts":[{name, password, server?, runClient?}]} or entries pointing at an rs-sdk bot dir
 *  ({name, botDir}) whose bot.env holds the credentials. */
export function readAccountsFile(file: string, defaultServer: string, rsSdkDir = ''): ImportedAccount[] {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.accounts) ? json.accounts : [];
    const out: ImportedAccount[] = [];
    for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const runClient = e.runClient ?? (e.client === 'managed' ? true : undefined);
        if (e.botDir) {
            const dir = isAbsolute(e.botDir) ? e.botDir : resolve(rsSdkDir || dirname(file), e.botDir);
            const envFile = join(dir, 'bot.env');
            if (!existsSync(envFile)) continue;
            const a = parseBotEnv(readFileSync(envFile, 'utf8'), defaultServer);
            if (a) out.push({ ...a, runClient, botDir: dir });
        } else if (e.name && e.password) {
            out.push({ name: String(e.name), password: String(e.password), server: String(e.server || defaultServer), runClient });
        }
    }
    return out;
}

/** Every bots/<name>/bot.env of an rs-sdk checkout (the template dir is skipped). */
export function scanRsSdk(rsSdkDir: string, defaultServer: string): ImportedAccount[] {
    const bots = join(rsSdkDir, 'bots');
    if (!existsSync(bots)) return [];
    const out: ImportedAccount[] = [];
    for (const d of readdirSync(bots)) {
        if (d.startsWith('_') || d.startsWith('.')) continue;
        const envFile = join(bots, d, 'bot.env');
        if (!existsSync(envFile)) continue;
        const a = parseBotEnv(readFileSync(envFile, 'utf8'), defaultServer);
        if (a) out.push({ ...a, botDir: join(bots, d) });
    }
    return out;
}

/** Last lines of the newest *.log in a bot dir (rs-sdk scripts log there by convention). */
export function tailLog(botDir: string, lines = 40): { file: string; lines: string[]; mtime: number } | null {
    try {
        const logs = readdirSync(botDir).filter(f => f.endsWith('.log'))
            .map(f => ({ f, m: statSync(join(botDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
        const newest = logs[0];
        if (!newest) return null;
        const fd = Bun.file(join(botDir, newest.f));
        const size = fd.size;
        const text = readFileSync(join(botDir, newest.f)).subarray(Math.max(0, size - 64 * 1024)).toString('utf8');
        return { file: newest.f, lines: text.split(/\r?\n/).filter(Boolean).slice(-lines), mtime: newest.m };
    } catch { return null; }
}
