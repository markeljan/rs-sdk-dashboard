import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export type ChatMessage = { id: number; at: number; name: string; text: string };
export function validateChat(value: unknown): { name: string; text: string } | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (typeof v.name !== 'string' || typeof v.text !== 'string') return null;
    const name = v.name.trim(), text = v.text.trim();
    if (!/^[\p{L}\p{N} _.-]{1,20}$/u.test(name) || !text || text.length > 400 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return null;
    return { name, text };
}
export class PublicChat {
    readonly db: Database;
    private sent = new Map<string, number[]>();
    constructor(path: string) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        this.db = new Database(path, { create: true });
        this.db.exec('CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL)');
    }
    history(): ChatMessage[] { return (this.db.query('SELECT * FROM chat ORDER BY id DESC LIMIT 80').all() as ChatMessage[]).reverse(); }
    post(ip: string, value: unknown, at = Date.now()): ChatMessage | string {
        const valid = validateChat(value); if (!valid) return 'Use a nickname up to 20 characters and a message up to 400 characters.';
        const recent = (this.sent.get(ip) ?? []).filter(t => at - t < 10_000);
        if (recent.length >= 5) return 'Slow down a little. Try again in a few seconds.';
        recent.push(at); this.sent.set(ip, recent);
        if (this.sent.size > 2000) for (const [key, times] of this.sent) if (at - times.at(-1)! > 10_000) this.sent.delete(key);
        const result = this.db.query('INSERT INTO chat(at,name,text) VALUES(?,?,?)').run(at, valid.name, valid.text);
        this.db.exec('DELETE FROM chat WHERE id <= (SELECT MAX(id)-500 FROM chat)');
        return { id: Number(result.lastInsertRowid), at, ...valid };
    }
    close() { this.db.close(); }
}
