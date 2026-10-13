// Settings come from the environment (or a .env file, which Bun loads automatically). See .env.example.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export type Mode = 'local' | 'hosted';

export function loadConfig(over: Record<string, string | undefined> = {}) {
    const e = { ...process.env, ...over };
    const mode: Mode = e.RSD_MODE === 'hosted' ? 'hosted' : 'local';
    const dataDir = resolve(e.RSD_DATA_DIR || (mode === 'hosted' ? '/data' : join(homedir(), '.rs-dashboard')));
    // Hosted: game passwords are written for the dashboard processes only into RAM (tmpfs), never to disk.
    const shm = existsSync('/dev/shm') ? '/dev/shm/rs-dashboard' : '';
    return {
        mode,
        port: num(e.PORT, 4747),
        host: e.HOST || '0.0.0.0',
        dataDir,
        runtimeDir: resolve(e.RSD_RUNTIME_DIR || (mode === 'hosted' && shm ? shm : join(dataDir, 'runtime'))),
        /** First port of the per-user dashboard processes (one per user, on 127.0.0.1). */
        instanceBasePort: num(e.RSD_INSTANCE_PORT, 47000),
        publicUrl: (e.RSD_PUBLIC_URL || '').replace(/\/$/, ''),
        /** Default game server for new accounts (same value as SERVER= in rs-sdk's bot.env). */
        defaultServer: e.RSD_SERVER || e.SERVER || 'rs-sdk-demo.fly.dev',
        /** Local mode: optional password for the web UI. */
        localPassword: e.RSD_PASSWORD || e.DASH_TOKEN || '',
        envAccounts: e.RSD_ACCOUNTS || '',
        accountsFile: e.RSD_ACCOUNTS_FILE || '',
        rsSdkDir: e.RS_SDK_DIR ? resolve(e.RS_SDK_DIR.replace(/^~(?=\/|$)/, homedir())) : '',
        signups: bool(e.RSD_SIGNUPS, true),
        adminEmail: (e.RSD_ADMIN_EMAIL || '').toLowerCase(),
        maxAccountsPerUser: num(e.RSD_MAX_ACCOUNTS, mode === 'hosted' ? 20 : 1000),
        maxClientsPerUser: num(e.RSD_MAX_CLIENTS_PER_USER, mode === 'hosted' ? 3 : 1000),
        maxClientsTotal: num(e.RSD_MAX_CLIENTS, mode === 'hosted' ? 14 : 1000),
        /** Hosted: stop a user's dashboard process after this long without requests (only if it runs no game client). */
        idleStopMin: num(e.RSD_IDLE_STOP_MIN, mode === 'hosted' ? 30 : 0),
        secret: e.RSD_SECRET || '',
        trustProxy: bool(e.RSD_TRUST_PROXY, mode === 'hosted'),
        /** Passed through to each dashboard process (FPS, QUALITY, IDLE_FPS, ...). */
        passEnv: Object.fromEntries(['FPS', 'QUALITY', 'IDLE_FPS', 'NO_HISCORES', 'OBSERVERS', 'OBSERVER_IDLE_MS', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH']
            .filter(k => e[k] != null && e[k] !== '').map(k => [k, e[k]!])),
    };
}

export type Config = ReturnType<typeof loadConfig>;
