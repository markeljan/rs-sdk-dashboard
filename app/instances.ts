// One dashboard process (tools/dashboard/server.ts, the same code the rs-sdk fleet runs) per user, on 127.0.0.1.
// This file turns the user's accounts into that process's accounts.json + bot.env files and keeps it running.
//
//   <dataDir>/users/<id>/telemetry/        DATA_DIR of the process: accounts.json, XP history, play time, prefs
//   <dataDir>/users/<id>/accounts/<name>/  the account's botDir: logs, tasks.json, plan.json (agents post here), bot.env
//   <runtimeDir>/<id>/<name>.env           hosted: the credentials bot.env links to (tmpfs, never on disk)
//
// rs-sdk accounts (local mode, RS_SDK_DIR) point at the real bots/<name> dir instead, so logs, plan, tasks and
// pause/resume work exactly like in the rs-sdk fleet.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './config';
import type { Account, Store } from './db';

const ROOT = resolve(import.meta.dir, '..');
const SERVER = join(ROOT, 'tools', 'dashboard', 'server.ts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Instance = { userId: number; port: number; proc: ChildProcess | null; ready: Promise<boolean> | null; lastUsed: number; restarting: Promise<void> | null; sig: string };

export class Instances {
    private map = new Map<number, Instance>();
    constructor(private cfg: Config, private store: Store, private log: (m: string) => void) {
        if (cfg.idleStopMin > 0) setInterval(() => void this.reapIdle(), 60_000);
        // A dashboard process that died (crash, OOM) comes back on the next request; ones that run game clients come back now.
        setInterval(() => { for (const i of this.map.values()) if (!i.proc && this.store.countClients(i.userId) > 0) void this.ensure(i.userId); }, 30_000);
    }

    userDir(userId: number) { return join(this.cfg.dataDir, 'users', String(userId)); }
    port(userId: number) { return this.cfg.instanceBasePort + userId; }

    /** accounts.json for the user's dashboard process. Returns a signature: same signature = no restart needed. */
    private writeConfig(userId: number, accounts: Account[]) {
        const user = this.userDir(userId);
        const telemetry = join(user, 'telemetry');
        mkdirSync(telemetry, { recursive: true });
        const entries = accounts.map(a => {
            const persistent = join(user, 'accounts', a.name);
            mkdirSync(persistent, { recursive: true });
            const managed = a.runClient;
            if (a.source === 'rs-sdk' && a.bot_dir && existsSync(join(a.bot_dir, 'bot.env'))) {
                return { name: a.name, botDir: a.bot_dir, procMatch: [`${a.bot_dir.replace(/\/$/, '')}/`], client: managed ? 'managed' : 'lite', autostart: managed };
            }
            // The account dir doubles as the fleet dashboard's botDir (logs/tasks/plan must live inside it). Hosted, its
            // bot.env is a symlink into tmpfs so game passwords never touch the disk.
            const envText = `BOT_USERNAME=${a.name}\nPASSWORD=${a.password}\nSERVER=${a.server}\n`;
            const envLink = join(persistent, 'bot.env');
            rmSync(envLink, { force: true });
            if (this.cfg.runtimeDir.startsWith(this.cfg.dataDir + '/')) writeFileSync(envLink, envText, { mode: 0o600 });
            else {
                const dir = join(this.cfg.runtimeDir, String(userId));
                mkdirSync(dir, { recursive: true, mode: 0o700 });
                writeFileSync(join(dir, `${a.name}.env`), envText, { mode: 0o600 });
                symlinkSync(join(dir, `${a.name}.env`), envLink);
            }
            return { name: a.name, botDir: persistent, procMatch: [], client: managed ? 'managed' : 'lite', autostart: managed };
        });
        writeFileSync(join(telemetry, 'accounts.json'), JSON.stringify({ accounts: entries }, null, 1) + '\n', { mode: 0o600 });
        return JSON.stringify(accounts.map(a => [a.name, a.server, a.password, a.runClient, a.bot_dir]));
    }

    /** Running (or started) dashboard for the user; null when the user has no accounts yet. */
    async ensure(userId: number): Promise<number | null> {
        const accounts = this.store.listAccounts(userId);
        if (!accounts.length) return null;
        let inst = this.map.get(userId);
        if (!inst) { inst = { userId, port: this.port(userId), proc: null, ready: null, lastUsed: Date.now(), restarting: null, sig: '' }; this.map.set(userId, inst); }
        inst.lastUsed = Date.now();
        if (inst.restarting) await inst.restarting;
        if (!inst.proc) {
            inst.sig = this.writeConfig(userId, accounts);
            this.spawn(inst);
        }
        return (await inst.ready) ? inst.port : null;
    }

    private spawn(inst: Instance) {
        const telemetry = join(this.userDir(inst.userId), 'telemetry');
        const env: Record<string, string> = {
            ...process.env as Record<string, string>, ...this.cfg.passEnv,
            PORT: String(inst.port), HOST: '127.0.0.1', DATA_DIR: telemetry, ACCOUNTS_FILE: join(telemetry, 'accounts.json'),
            // The rs-sdk fork's bot bundle (server/webclient/out/bot/client.js, synced) is served to game clients only while its
            // revision equals the game server's; it adds fork-only bot actions. RSD_FORK_BUNDLE=0 always uses the server's own.
            LOCAL_BOT_BUNDLE: process.env.RSD_FORK_BUNDLE === '0' ? '0' : '1', LOCAL_BOT_BUNDLE_REBUILD: '0',
            LITE_HOST_STATUS: join(telemetry, 'no-lite-host.json'),
        };
        delete env.DASH_TOKEN;
        if (this.cfg.passEnv.CHROME_PATH && !env.PUPPETEER_EXECUTABLE_PATH) env.PUPPETEER_EXECUTABLE_PATH = this.cfg.passEnv.CHROME_PATH;
        const proc = spawn(process.execPath, [SERVER], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        inst.proc = proc;
        const tag = `[user ${inst.userId}]`;
        const pipe = (s: NodeJS.ReadableStream | null) => s?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) this.log(`${tag} ${l}`); });
        pipe(proc.stdout); pipe(proc.stderr);
        proc.on('exit', code => { if (inst.proc === proc) { inst.proc = null; inst.ready = null; this.log(`${tag} dashboard exited (${code})`); } });
        inst.ready = (async () => {
            for (let i = 0; i < 120; i++) {
                if (inst.proc !== proc) return false;
                try { if ((await fetch(`http://127.0.0.1:${inst.port}/health`, { signal: AbortSignal.timeout(1000) })).ok) return true; } catch { /* starting */ }
                await sleep(250);
            }
            return false;
        })();
    }

    private async stopProc(inst: Instance) {
        const p = inst.proc;
        if (!p) return;
        inst.proc = null; inst.ready = null;
        const exited = new Promise(r => p.once('exit', r));
        p.kill('SIGTERM'); // the dashboard detaches its game clients on SIGTERM; the next process reattaches them
        await Promise.race([exited, sleep(10_000)]);
        if (p.exitCode == null) p.kill('SIGKILL');
    }

    /** Accounts changed: stop game clients that must go away, rewrite the config, restart if anything changed. */
    async apply(userId: number, stopClients: string[] = []) {
        const inst = this.map.get(userId);
        if (inst?.proc && stopClients.length && (await inst.ready)) {
            for (const name of stopClients) {
                await fetch(`http://127.0.0.1:${inst.port}/api/client/stop?account=${encodeURIComponent(name)}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => {});
            }
        }
        const accounts = this.store.listAccounts(userId);
        if (!inst) { if (accounts.some(a => a.runClient)) await this.ensure(userId); return; }
        const run = async () => {
            if (!accounts.length) { await this.stopProc(inst); this.map.delete(userId); return; }
            const sig = this.writeConfig(userId, accounts);
            if (sig === inst.sig && inst.proc) return;
            inst.sig = sig;
            if (inst.proc) { this.log(`[user ${userId}] accounts changed - restarting dashboard`); await this.stopProc(inst); }
            this.spawn(inst);
            await inst.ready;
        };
        const prev = inst.restarting ?? Promise.resolve();
        inst.restarting = prev.then(run, run).finally(() => { if (inst.restarting === p) inst.restarting = null; });
        const p = inst.restarting;
        await p;
    }

    /** Account removed: delete its credentials (its history stays until the user is deleted). */
    forget(userId: number, name: string) {
        rmSync(join(this.cfg.runtimeDir, String(userId), `${name}.env`), { force: true });
        rmSync(join(this.userDir(userId), 'accounts', name, 'bot.env'), { force: true });
    }
    /** User deleted: remove everything of theirs. */
    async purge(userId: number) {
        const inst = this.map.get(userId);
        if (inst) { await this.stopProc(inst); this.map.delete(userId); }
        rmSync(this.userDir(userId), { recursive: true, force: true });
        rmSync(join(this.cfg.runtimeDir, String(userId)), { recursive: true, force: true });
    }

    private async reapIdle() {
        const cutoff = Date.now() - this.cfg.idleStopMin * 60_000;
        for (const inst of this.map.values()) {
            if (inst.proc && inst.lastUsed < cutoff && this.store.countClients(inst.userId) === 0) {
                this.log(`[user ${inst.userId}] idle - stopping dashboard process`);
                await this.stopProc(inst);
            }
        }
    }

    /** Boot every user who has game clients (after a deploy/restart, so cloud clients come straight back). */
    async bootClients() { for (const u of this.store.usersWithAccounts()) if (this.store.countClients(u) > 0) void this.ensure(u); }

    running() { return [...this.map.values()].filter(i => i.proc).length; }
    async shutdown() { await Promise.all([...this.map.values()].map(i => this.stopProc(i))); }
}
