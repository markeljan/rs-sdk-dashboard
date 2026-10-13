// Managed game clients outlive the dashboard process: each account's headless Chrome is spawned detached with a
// remote-debugging port, and its endpoint is saved, so a restarted dashboard reattaches to the running browser and its
// logged-in page instead of launching a fresh client (which reset every bot's client epoch on every restart).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** puppeteer's expected Chrome, or (when a puppeteer upgrade hasn't downloaded it yet) the newest cached one. */
export function resolveChrome(preferred: string): string {
    if (existsSync(preferred)) return preferred;
    const root = join(homedir(), '.cache', 'puppeteer', 'chrome');
    const builds = (() => { try { return readdirSync(root); } catch { return []; } })()
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const b of builds) {
        const mac = join(root, b, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        const macX = join(root, b, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        const linux = join(root, b, 'chrome-linux64', 'chrome');
        for (const c of [mac, macX, linux]) if (existsSync(c)) return c;
    }
    return preferred; // let spawn report the missing binary
}

export type SavedBrowser = { pid: number; wsEndpoint: string; userDataDir: string; startedAt: number };

export const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function stateFile(dataDir: string, name: string) { return join(dataDir, 'managed-chrome', `${name}.json`); }

export function readSaved(dataDir: string, name: string): SavedBrowser | null {
    try {
        const s = JSON.parse(readFileSync(stateFile(dataDir, name), 'utf8')) as SavedBrowser;
        return s && Number.isInteger(s.pid) && typeof s.wsEndpoint === 'string' ? s : null;
    } catch { return null; }
}

export function forget(dataDir: string, name: string) { try { rmSync(stateFile(dataDir, name)); } catch { /* none */ } }

/** Spawn a detached headless Chrome for `name` and wait for its DevTools endpoint. */
export async function launchDetached(opts: { dataDir: string; name: string; executablePath: string | Promise<string>; args: string[]; timeoutMs?: number }): Promise<SavedBrowser> {
    const userDataDir = join(opts.dataDir, 'managed-chrome', `profile-${opts.name}`);
    mkdirSync(userDataDir, { recursive: true });
    const portFile = join(userDataDir, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    const child = spawn(resolveChrome(await opts.executablePath), [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
        '--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic', '--use-mock-keychain',
        ...opts.args, 'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref(); // the dashboard may exit; Chrome keeps running
    const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
    while (Date.now() < deadline) {
        if (child.exitCode != null) throw new Error(`chrome exited during launch (code ${child.exitCode})`);
        if (existsSync(portFile)) {
            const [port, path] = readFileSync(portFile, 'utf8').split('\n');
            if (port && path) {
                const saved: SavedBrowser = { pid: child.pid!, wsEndpoint: `ws://127.0.0.1:${port.trim()}${path.trim()}`, userDataDir, startedAt: Date.now() };
                mkdirSync(join(opts.dataDir, 'managed-chrome'), { recursive: true });
                writeFileSync(stateFile(opts.dataDir, opts.name), JSON.stringify(saved, null, 1) + '\n');
                return saved;
            }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    try { process.kill(child.pid!, 'SIGKILL'); } catch { /* gone */ }
    throw new Error('chrome did not publish a DevTools endpoint');
}

export function killSaved(dataDir: string, name: string) {
    const s = readSaved(dataDir, name);
    if (s && isAlive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } }
    forget(dataDir, name);
}
