// SQLite storage (bun:sqlite): users, sessions, used API tokens, accounts. One file in the data dir.
// Everything the dashboard itself tracks (XP history, play time, ...) lives in each user's telemetry dir instead.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';

export type AccountSource = 'ui' | 'env' | 'file' | 'rs-sdk';
type AccountRow = {
    id: number; user_id: number; name: string; password_enc: string; server: string;
    run_client: number; source: AccountSource; bot_dir: string | null; created_at: number;
};
export type Account = Omit<AccountRow, 'password_enc' | 'run_client'> & { password: string; runClient: boolean };
export type User = { id: number; email: string; created_at: number; is_admin: number };
export type TokenRow = { nonce: string; user_id: number; name: string; first_used_at: number; last_used_at: number; uses: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens_used (nonce TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'agent', first_used_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens_revoked (nonce TEXT PRIMARY KEY, user_id INTEGER NOT NULL, revoked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, password_enc TEXT NOT NULL, server TEXT NOT NULL, run_client INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'ui', bot_dir TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_name ON accounts(user_id, name COLLATE NOCASE);
`;

export class Store {
    readonly db: Database;
    constructor(dataDir: string, private key: Buffer, file = 'dashboard.db') {
        mkdirSync(dataDir, { recursive: true });
        this.db = new Database(join(dataDir, file), { create: true });
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
        this.db.exec(SCHEMA);
    }

    // ---------------------------------------------------------------- users + sessions
    async createUser(email: string, password: string, isAdmin = false): Promise<User> {
        return this.db.query('INSERT INTO users (email, pass_hash, created_at, is_admin) VALUES (?, ?, ?, ?) RETURNING id, email, created_at, is_admin')
            .get(email.trim(), await Bun.password.hash(password), Date.now(), isAdmin ? 1 : 0) as User;
    }
    userCount() { return (this.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n; }
    listUsers() { return this.db.query('SELECT id, email, created_at, is_admin FROM users ORDER BY id').all() as User[]; }
    getUser(id: number) { return this.db.query('SELECT id, email, created_at, is_admin FROM users WHERE id = ?').get(id) as User | null; }
    getUserByEmail(email: string) { return this.db.query('SELECT id, email, created_at, is_admin FROM users WHERE email = ?').get(email.trim()) as User | null; }
    setAdmin(id: number) { this.db.query('UPDATE users SET is_admin = 1 WHERE id = ?').run(id); }
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

    // ---------------------------------------------------------------- API tokens: stateless, recorded on first use
    tokenRevoked(nonce: string) { return !!this.db.query('SELECT 1 FROM tokens_revoked WHERE nonce = ?').get(nonce); }
    recordTokenUse(nonce: string, userId: number) {
        const now = Date.now();
        this.db.query(`INSERT INTO tokens_used (nonce, user_id, first_used_at, last_used_at, uses) VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(nonce) DO UPDATE SET last_used_at = excluded.last_used_at, uses = uses + 1`).run(nonce, userId, now, now);
    }
    listUsedTokens(userId: number) { return this.db.query('SELECT * FROM tokens_used WHERE user_id = ? ORDER BY last_used_at DESC').all(userId) as TokenRow[]; }
    renameToken(userId: number, nonce: string, name: string) { this.db.query('UPDATE tokens_used SET name = ? WHERE user_id = ? AND nonce = ?').run(name.slice(0, 60), userId, nonce); }
    revokeToken(userId: number, nonce: string) {
        this.db.query('INSERT OR IGNORE INTO tokens_revoked (nonce, user_id, revoked_at) VALUES (?, ?, ?)').run(nonce, userId, Date.now());
        this.db.query('DELETE FROM tokens_used WHERE user_id = ? AND nonce = ?').run(userId, nonce);
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
    usersWithAccounts() { return (this.db.query('SELECT DISTINCT user_id FROM accounts').all() as { user_id: number }[]).map(r => r.user_id); }
    getAccount(id: number): Account | null {
        const r = this.db.query('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | null;
        return r ? this.toAccount(r) : null;
    }
    findAccount(userId: number, name: string): Account | null {
        const r = this.db.query('SELECT * FROM accounts WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, name) as AccountRow | null;
        return r ? this.toAccount(r) : null;
    }
    /** Another user's account with the same game name on the same server (a game account can only have one owner here). */
    ownedElsewhere(userId: number, name: string, server: string) {
        return !!this.db.query('SELECT 1 FROM accounts WHERE user_id != ? AND name = ? COLLATE NOCASE AND server = ? COLLATE NOCASE').get(userId, name, server);
    }
    countAccounts(userId: number) { return (this.db.query('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(userId) as { n: number }).n; }
    countClients(userId?: number) {
        return (userId == null ? this.db.query('SELECT COUNT(*) AS n FROM accounts WHERE run_client = 1').get()
            : this.db.query('SELECT COUNT(*) AS n FROM accounts WHERE run_client = 1 AND user_id = ?').get(userId) as any).n as number;
    }
    upsertAccount(userId: number, a: { name: string; password: string; server: string; runClient?: boolean; source?: AccountSource; botDir?: string | null }): number {
        const existing = this.findAccount(userId, a.name);
        if (existing) {
            this.db.query('UPDATE accounts SET password_enc = ?, server = ?, run_client = COALESCE(?, run_client), bot_dir = COALESCE(?, bot_dir) WHERE id = ?')
                .run(encrypt(this.key, a.password), a.server, a.runClient == null ? null : a.runClient ? 1 : 0, a.botDir ?? null, existing.id);
            return existing.id;
        }
        return (this.db.query(`INSERT INTO accounts (user_id, name, password_enc, server, run_client, source, bot_dir, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
            .get(userId, a.name, encrypt(this.key, a.password), a.server, a.runClient ? 1 : 0, a.source ?? 'ui', a.botDir ?? null, Date.now()) as { id: number }).id;
    }
    updateAccount(id: number, patch: { password?: string; server?: string; runClient?: boolean }) {
        if (patch.password != null) this.db.query('UPDATE accounts SET password_enc = ? WHERE id = ?').run(encrypt(this.key, patch.password), id);
        if (patch.server != null) this.db.query('UPDATE accounts SET server = ? WHERE id = ?').run(patch.server, id);
        if (patch.runClient != null) this.db.query('UPDATE accounts SET run_client = ? WHERE id = ?').run(patch.runClient ? 1 : 0, id);
    }
    deleteAccount(id: number) { this.db.query('DELETE FROM accounts WHERE id = ?').run(id); }
}
