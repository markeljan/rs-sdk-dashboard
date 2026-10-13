// SQLite storage (bun:sqlite): users, sessions, API tokens, accounts and XP samples. One file in the data dir.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';

export type AccountSource = 'ui' | 'env' | 'file' | 'rs-sdk';
export type AccountRow = {
    id: number; user_id: number; name: string; password_enc: string; server: string;
    run_client: number; source: AccountSource; bot_dir: string | null; created_at: number;
    activity: string | null; activity_at: number | null;
};
export type Account = Omit<AccountRow, 'password_enc' | 'run_client'> & { password: string; runClient: boolean };
export type User = { id: number; email: string; created_at: number; is_admin: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, password_enc TEXT NOT NULL, server TEXT NOT NULL, run_client INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'ui', bot_dir TEXT, created_at INTEGER NOT NULL, activity TEXT, activity_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_name ON accounts(user_id, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS xp_samples (account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, total_xp INTEGER NOT NULL, total_level INTEGER NOT NULL, PRIMARY KEY (account_id, at));
`;

export class Store {
    readonly db: Database;
    constructor(dataDir: string, private key: Buffer, file = 'dashboard.db') {
        mkdirSync(dataDir, { recursive: true });
        this.db = new Database(file === ':memory:' ? ':memory:' : join(dataDir, file), { create: true });
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
        this.db.exec(SCHEMA);
    }

    // ---------------------------------------------------------------- users + sessions
    async createUser(email: string, password: string, isAdmin = false): Promise<User> {
        const hash = await Bun.password.hash(password);
        const r = this.db.query('INSERT INTO users (email, pass_hash, created_at, is_admin) VALUES (?, ?, ?, ?) RETURNING id, email, created_at, is_admin')
            .get(email.trim(), hash, Date.now(), isAdmin ? 1 : 0) as User;
        return r;
    }
    userCount() { return (this.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n; }
    getUser(id: number) { return this.db.query('SELECT id, email, created_at, is_admin FROM users WHERE id = ?').get(id) as User | null; }
    getUserByEmail(email: string) { return this.db.query('SELECT id, email, created_at, is_admin FROM users WHERE email = ?').get(email.trim()) as User | null; }
    async checkPassword(email: string, password: string): Promise<User | null> {
        const row = this.db.query('SELECT id, pass_hash FROM users WHERE email = ?').get(email.trim()) as { id: number; pass_hash: string } | null;
        if (!row) { await Bun.password.hash(password); return null; } // equalise timing
        return (await Bun.password.verify(password, row.pass_hash)) ? this.getUser(row.id) : null;
    }
    async setPassword(userId: number, password: string) {
        this.db.query('UPDATE users SET pass_hash = ? WHERE id = ?').run(await Bun.password.hash(password), userId);
        this.db.query('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    deleteUser(userId: number) { this.db.query('DELETE FROM users WHERE id = ?').run(userId); }
    ensureLocalUser(): User {
        return this.getUserByEmail('local@localhost') ?? (this.db.query('INSERT INTO users (email, pass_hash, created_at, is_admin) VALUES (?, ?, ?, 1) RETURNING id, email, created_at, is_admin')
            .get('local@localhost', '!', Date.now()) as User);
    }

    createSession(userId: number, days = 30) {
        const token = randomToken('s_');
        this.db.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
            .run(sha256(token), userId, Date.now(), Date.now() + days * 86_400_000);
        return token;
    }
    sessionUser(token: string): User | null {
        const r = this.db.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as { user_id: number; expires_at: number } | null;
        if (!r || r.expires_at < Date.now()) return null;
        return this.getUser(r.user_id);
    }
    deleteSession(token: string) { this.db.query('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); }

    // ---------------------------------------------------------------- API tokens (agents, scripts)
    createApiToken(userId: number, name: string) {
        const token = randomToken('rsd_');
        this.db.query('INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(userId, name.slice(0, 60) || 'token', sha256(token), token.slice(0, 10), Date.now());
        return token;
    }
    listApiTokens(userId: number) {
        return this.db.query('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id').all(userId) as
            { id: number; name: string; prefix: string; created_at: number; last_used_at: number | null }[];
    }
    deleteApiToken(userId: number, id: number) { this.db.query('DELETE FROM api_tokens WHERE user_id = ? AND id = ?').run(userId, id); }
    apiTokenUser(token: string): User | null {
        const r = this.db.query('SELECT id, user_id FROM api_tokens WHERE token_hash = ?').get(sha256(token)) as { id: number; user_id: number } | null;
        if (!r) return null;
        this.db.query('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), r.id);
        return this.getUser(r.user_id);
    }

    // ---------------------------------------------------------------- accounts
    private toAccount(r: AccountRow): Account {
        const { password_enc, run_client, ...rest } = r;
        let password = '';
        try { password = decrypt(this.key, password_enc); } catch { /* key changed: needs re-entry */ }
        return { ...rest, password, runClient: !!run_client };
    }
    listAccounts(userId?: number): Account[] {
        const rows = (userId == null
            ? this.db.query('SELECT * FROM accounts ORDER BY id').all()
            : this.db.query('SELECT * FROM accounts WHERE user_id = ? ORDER BY id').all(userId)) as AccountRow[];
        return rows.map(r => this.toAccount(r));
    }
    getAccount(id: number): Account | null {
        const r = this.db.query('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | null;
        return r ? this.toAccount(r) : null;
    }
    findAccount(userId: number, name: string): Account | null {
        const r = this.db.query('SELECT * FROM accounts WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, name) as AccountRow | null;
        return r ? this.toAccount(r) : null;
    }
    countAccounts(userId: number) { return (this.db.query('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(userId) as { n: number }).n; }
    /** Insert, or update the existing account of that name. Returns the account id. */
    upsertAccount(userId: number, a: { name: string; password: string; server: string; runClient?: boolean; source?: AccountSource; botDir?: string | null }): number {
        const existing = this.findAccount(userId, a.name);
        if (existing) {
            this.db.query('UPDATE accounts SET password_enc = ?, server = ?, run_client = COALESCE(?, run_client), bot_dir = COALESCE(?, bot_dir) WHERE id = ?')
                .run(encrypt(this.key, a.password), a.server, a.runClient == null ? null : a.runClient ? 1 : 0, a.botDir ?? null, existing.id);
            return existing.id;
        }
        const r = this.db.query(`INSERT INTO accounts (user_id, name, password_enc, server, run_client, source, bot_dir, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
            .get(userId, a.name, encrypt(this.key, a.password), a.server, a.runClient ? 1 : 0, a.source ?? 'ui', a.botDir ?? null, Date.now()) as { id: number };
        return r.id;
    }
    updateAccount(id: number, patch: { password?: string; server?: string; runClient?: boolean }) {
        if (patch.password != null) this.db.query('UPDATE accounts SET password_enc = ? WHERE id = ?').run(encrypt(this.key, patch.password), id);
        if (patch.server != null) this.db.query('UPDATE accounts SET server = ? WHERE id = ?').run(patch.server, id);
        if (patch.runClient != null) this.db.query('UPDATE accounts SET run_client = ? WHERE id = ?').run(patch.runClient ? 1 : 0, id);
    }
    setActivity(id: number, text: string) { this.db.query('UPDATE accounts SET activity = ?, activity_at = ? WHERE id = ?').run(text.slice(0, 500), Date.now(), id); }
    deleteAccount(id: number) { this.db.query('DELETE FROM accounts WHERE id = ?').run(id); }

    // ---------------------------------------------------------------- XP samples
    addSample(accountId: number, totalXp: number, totalLevel: number, at = Date.now()) {
        this.db.query('INSERT OR REPLACE INTO xp_samples (account_id, at, total_xp, total_level) VALUES (?, ?, ?, ?)').run(accountId, at, totalXp, totalLevel);
    }
    samples(accountId: number, sinceMs: number) {
        return this.db.query('SELECT at, total_xp, total_level FROM xp_samples WHERE account_id = ? AND at >= ? ORDER BY at').all(accountId, sinceMs) as
            { at: number; total_xp: number; total_level: number }[];
    }
    pruneSamples(olderThanMs: number) { this.db.query('DELETE FROM xp_samples WHERE at < ?').run(olderThanMs); }
}
