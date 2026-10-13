// All settings come from the environment (or a .env file, which Bun loads automatically).
// See .env.example for the full list with explanations.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const env = process.env;
const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export type Mode = 'local' | 'hosted';

export function loadConfig(over: Record<string, string | undefined> = {}) {
    const e = { ...env, ...over };
    const mode: Mode = e.RSD_MODE === 'hosted' ? 'hosted' : 'local';
    const dataDir = resolve(e.RSD_DATA_DIR || (mode === 'hosted' ? '/data' : join(homedir(), '.rs-dashboard')));
    return {
        mode,
        port: num(e.PORT, 4747),
        host: e.HOST || (mode === 'hosted' ? '0.0.0.0' : '0.0.0.0'),
        dataDir,
        /** Public URL of this dashboard, used in links shown to users (agent setup, invites). */
        publicUrl: (e.RSD_PUBLIC_URL || '').replace(/\/$/, ''),
        /** Default game server for new accounts (same value as SERVER= in rs-sdk's bot.env). */
        defaultServer: e.RSD_SERVER || e.SERVER || 'rs-sdk-demo.fly.dev',
        /** Local mode: optional password for the web UI. Without it, anyone who can reach the port has access. */
        localPassword: e.RSD_PASSWORD || e.DASH_TOKEN || '',
        /** Accounts from the environment: "name:password[@server], name2:password2". */
        envAccounts: e.RSD_ACCOUNTS || '',
        /** JSON file with accounts (see accounts.example.json). */
        accountsFile: e.RSD_ACCOUNTS_FILE || '',
        /** Path to an rs-sdk checkout: every bots/<name>/bot.env is imported and its logs are shown. */
        rsSdkDir: e.RS_SDK_DIR ? resolve(e.RS_SDK_DIR) : '',
        /** Hosted mode: allow anyone to sign up. */
        signups: bool(e.RSD_SIGNUPS, true),
        maxAccountsPerUser: num(e.RSD_MAX_ACCOUNTS, mode === 'hosted' ? 20 : 1000),
        maxClientsPerUser: num(e.RSD_MAX_CLIENTS_PER_USER, mode === 'hosted' ? 3 : 1000),
        maxClientsTotal: num(e.RSD_MAX_CLIENTS, mode === 'hosted' ? 14 : 1000),
        /** Live view frame rate while someone watches, and JPEG quality 1-100. */
        streamFps: num(e.RSD_FPS, mode === 'hosted' ? 12 : 20),
        streamQuality: num(e.RSD_QUALITY, mode === 'hosted' ? 65 : 75),
        /** Render rate of game clients nobody is watching (game logic is unaffected). */
        idleFps: num(e.RSD_IDLE_FPS, 5),
        chromePath: e.CHROME_PATH || e.PUPPETEER_EXECUTABLE_PATH || '',
        /** Seconds between gateway polls for accounts nobody is looking at. */
        idlePollSec: num(e.RSD_IDLE_POLL, 30),
        /** Secret for encrypting stored game passwords; generated into the data dir when unset. */
        secret: e.RSD_SECRET || '',
        trustProxy: bool(e.RSD_TRUST_PROXY, mode === 'hosted'),
    };
}

export type Config = ReturnType<typeof loadConfig>;
