// Quests view data for the dashboard: live quest telemetry, the quest loop's current/recent runs
// (quests-run.log), and fast-travel outcomes scraped from per-quest q_*.log files.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

export interface QuestRunResult { key: string; rc: number; ok: boolean; at: string | null }
export interface QuestRunState {
    current: { key: string; startedAt: string | null } | null;
    results: QuestRunResult[]; // newest first
}
export interface FastTravelLine { file: string; kind: 'ok' | 'failed' | 'plan' | 'blocked'; line: string }
export interface FastTravelStats {
    counts: { ok: number; failed: number; plan: number; blocked: number };
    recent: FastTravelLine[]; // newest first
    files: number;
}

const HEADER_RE = /^=== (.+?) QLOOP (\S+)\s*$/;
const RESULT_RE = /^QLOOP_RESULT (\S+) rc=(-?\d+)/;

function parseLogDate(s: string): string | null {
    const t = Date.parse(s.replace(/\s+/g, ' ').trim());
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Parse quests-run.log text. `current` is the last `=== <date> QLOOP <key>` header with no
 *  `QLOOP_RESULT <key>` after it; results carry the timestamp of their preceding header. */
export function parseQuestRunLog(text: string, maxResults = 30): QuestRunState {
    let pending: { key: string; startedAt: string | null } | null = null;
    let lastHeaderAt: string | null = null;
    const results: QuestRunResult[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        const h = HEADER_RE.exec(line);
        if (h) {
            lastHeaderAt = parseLogDate(h[1]!);
            pending = { key: h[2]!, startedAt: lastHeaderAt };
            continue;
        }
        const r = RESULT_RE.exec(line);
        if (r) {
            const key = r[1]!, rc = Number(r[2]);
            const at = pending && pending.key === key ? pending.startedAt : lastHeaderAt;
            results.push({ key, rc, ok: rc === 0, at });
            if (pending && pending.key === key) pending = null;
        }
    }
    return { current: pending, results: results.slice(-maxResults).reverse() };
}

export function classifyFastTravel(line: string): FastTravelLine['kind'] | null {
    if (line.includes('fast-travel plan')) return 'plan';
    if (!line.includes('fast-travel:')) return null;
    if (line.includes('FAILED')) return 'failed';
    if (/ ok( |$)/.test(line)) return 'ok';
    if (line.includes(' blocked: ')) return 'blocked';
    return null;
}

/** Count fast-travel outcomes across log texts (given oldest file first). */
export function parseFastTravel(files: { name: string; text: string }[], maxRecent = 20): FastTravelStats {
    const counts = { ok: 0, failed: 0, plan: 0, blocked: 0 };
    const all: FastTravelLine[] = [];
    for (const f of files) {
        for (const raw of f.text.split('\n')) {
            const kind = classifyFastTravel(raw);
            if (!kind) continue;
            counts[kind]++;
            all.push({ file: f.name, kind, line: raw.trim().slice(0, 300) });
        }
    }
    return { counts, recent: all.slice(-maxRecent).reverse(), files: files.length };
}

/** Last `bytes` of a file, starting at a line boundary when truncated. */
export function readTail(path: string, bytes = 200_000): string {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        let s = buf.toString('utf8');
        if (start > 0) { const nl = s.indexOf('\n'); s = nl >= 0 ? s.slice(nl + 1) : ''; }
        return s;
    } finally { closeSync(fd); }
}

function recentQLogs(dir: string, sinceMs: number): { path: string; mtime: number }[] {
    if (!existsSync(dir)) return [];
    const out: { path: string; mtime: number }[] = [];
    for (const n of readdirSync(dir)) {
        if (!/^q_.*\.log$/.test(n)) continue;
        try { const st = statSync(join(dir, n)); if (st.mtimeMs >= sinceMs) out.push({ path: join(dir, n), mtime: st.mtimeMs }); } catch { /* raced */ }
    }
    return out;
}

export function buildQuestsPayload(opts: { account: string; botDir: string; sokoDir: string; now?: number }) {
    const now = opts.now ?? Date.now();
    let live: any = null;
    let liveError: string | null = null;
    const liveFile = join(opts.botDir, 'telemetry', 'quests-live.json');
    try {
        const j = JSON.parse(readFileSync(liveFile, 'utf8'));
        live = {
            observedAt: j.observedAt ?? null,
            questPoints: j.questPoints ?? null,
            totalQuestPoints: j.totalQuestPoints ?? null,
            completed: j.completed ?? j.complete ?? null,
            total: j.total ?? (Array.isArray(j.quests) ? j.quests.length : null),
            quests: (Array.isArray(j.quests) ? j.quests : []).map((q: any) => ({ key: q.key, name: q.name, questPoints: q.questPoints ?? 0, status: q.status ?? 'unknown' })),
        };
    } catch (e: any) { liveError = existsSync(liveFile) ? `unreadable: ${e?.message ?? e}` : 'no quests-live.json yet'; }

    const runLog = join(opts.botDir, 'quests-run.log');
    let run: QuestRunState & { logMtime: string | null } = { current: null, results: [], logMtime: null };
    if (existsSync(runLog)) {
        try { run = { ...parseQuestRunLog(readTail(runLog)), logMtime: new Date(statSync(runLog).mtimeMs).toISOString() }; } catch { /* keep empty */ }
    }

    const since = now - 24 * 3600_000;
    const dirs = [...new Set([resolve(opts.botDir), resolve(opts.sokoDir)])];
    const logs = dirs.flatMap(d => recentQLogs(d, since)).sort((a, b) => a.mtime - b.mtime);
    const texts: { name: string; text: string }[] = [];
    for (const l of logs) { try { texts.push({ name: `${basename(resolve(l.path, '..'))}/${basename(l.path)}`, text: readTail(l.path) }); } catch { /* raced */ } }
    const fastTravel = parseFastTravel(texts);

    return { account: opts.account, generatedAt: new Date(now).toISOString(), live, liveError, run, fastTravel };
}
