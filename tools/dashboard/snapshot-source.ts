// Observer-less account snapshots for the dashboard (docs/plan-fleet-scaling-2026-10-07.md Phase 2).
//
// With 40 accounts one SDK observer each cost ~4.5 MB/s and most of the dashboard's CPU, feeding only a 60 s XP
// sample and a few summary fields. Observers are now on demand (someone is looking at the account); the rest of the
// time the same fields come from cheaper sources, in this order:
//   observer   - a connected observe-mode SDK with fresh state (the account is being watched)
//   lite-host  - bots/*/lite-host.json, written every 15 s by bots/lite-host.ts for headless lite clients
//   managed    - a 15 s page.evaluate on the managed headless Chrome reading the client's skill tables
// Pure functions here; server.ts wires them to timers and sockets. Keep them testable.

export type SnapshotSource = 'observer' | 'lite-host' | 'managed';
export type AccountSnapshot = {
    source: SnapshotSource;
    at: number;
    inGame: boolean;
    xp: Record<string, number> | null;
    levels: Record<string, number> | null;
    hp: [number, number] | null;
    pos: [number, number, number] | null;
    invUsed: number | null;
    /** item name -> count; null when the source does not list items (managed/lite-host) */
    inv: Array<[string, number]> | null;
};

export const SNAPSHOT_MAX_AGE_MS = 75_000;

/** The newest-first usable snapshot: candidates are ordered by preference, the first one fresh and in game wins;
 *  failing that the freshest candidate at all (so "offline" still carries the last known levels). */
export function pickSnapshot(candidates: Array<AccountSnapshot | null | undefined>, now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS): AccountSnapshot | null {
    const list = candidates.filter((c): c is AccountSnapshot => !!c);
    const fresh = list.find(c => c.inGame && now - c.at <= maxAgeMs);
    if (fresh) return fresh;
    return list.sort((a, b) => b.at - a.at)[0] ?? null;
}

export function snapshotFresh(s: AccountSnapshot | null, now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
    return !!s && s.inGame && now - s.at <= maxAgeMs;
}

export type ObserverDemand = { always: boolean; viewers: number; lastRequestAt: number; now: number; idleMs: number };
/** An observer is wanted while a viewer websocket has the account selected or an API consumer asked for it within idleMs. */
export function observerWanted(d: ObserverDemand) {
    return d.always || d.viewers > 0 || (d.lastRequestAt > 0 && d.now - d.lastRequestAt < d.idleMs);
}

/** Rows of a lite-host status file (bots/lite-host.ts) -> snapshots by lower-cased name. Rows without xp (an older
 *  host) still report presence so the account counts as lite-hosted. */
export function parseLiteHostStatus(json: unknown): Map<string, { snapshot: AccountSnapshot | null; state: string }> {
    const out = new Map<string, { snapshot: AccountSnapshot | null; state: string }>();
    const bots = (json as any)?.bots;
    if (!Array.isArray(bots)) return out;
    const fileAt = Date.parse(String((json as any)?.at ?? '')) || 0;
    for (const b of bots) {
        if (!b?.name) continue;
        const at = Number(b.at) || fileAt;
        const snapshot: AccountSnapshot | null = b.xp && typeof b.xp === 'object' ? {
            source: 'lite-host', at, inGame: !!b.inGame, xp: b.xp, levels: b.levels ?? null,
            hp: Array.isArray(b.hp) && b.hp.length === 2 ? [Number(b.hp[0]), Number(b.hp[1])] : null,
            pos: Array.isArray(b.pos) && b.pos.length === 3 ? [Number(b.pos[0]), Number(b.pos[1]), Number(b.pos[2])] : null,
            invUsed: Number.isFinite(b.invUsed) ? Number(b.invUsed) : null, inv: null,
        } : null;
        out.set(String(b.name).toLowerCase(), { snapshot, state: String(b.state ?? '') });
    }
    return out;
}

/** What the managed page's `window.gameClient` is asked for (see MANAGED_SNAPSHOT_JS) -> snapshot. */
export type ManagedPageRaw = { ingame: boolean; xp: number[]; base: number[]; eff: number[]; x: number | null; z: number | null; level: number; inv: number | null };
export const SKILL_ORDER = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching',
    'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Stat18', 'Stat19', 'Runecraft'];
export function managedSnapshot(raw: ManagedPageRaw | null | undefined, now = Date.now()): AccountSnapshot | null {
    if (!raw || !Array.isArray(raw.xp) || raw.xp.length < SKILL_ORDER.length) return null;
    const xp: Record<string, number> = {}, levels: Record<string, number> = {};
    SKILL_ORDER.forEach((k, i) => { if (!k.startsWith('Stat')) { xp[k] = raw.xp[i] ?? 0; levels[k] = raw.base?.[i] ?? 0; } });
    return {
        source: 'managed', at: now, inGame: !!raw.ingame, xp, levels,
        hp: raw.base?.[3] ? [raw.eff?.[3] ?? 0, raw.base[3]] : null,
        pos: raw.x != null && raw.z != null ? [raw.x, raw.z, raw.level ?? 0] : null,
        invUsed: raw.inv ?? null, inv: null,
    };
}
/** Evaluated inside the managed Chrome page (plain JS, no TS). Reads the same client fields StateCollector does. */
export const MANAGED_SNAPSHOT_JS = `(() => {
    const g = window.gameClient; if (!g) return null;
    const p = g.localPlayer;
    let inv = null;
    try { const c = g.interfaces && g.interfaces.list ? g.interfaces.list[3214] : (window.IfType && window.IfType.list ? window.IfType.list[3214] : null);
        if (c && c.linkObjType) { inv = 0; for (let s = 0; s < c.linkObjType.length; s++) if (c.linkObjType[s] > 0) inv++; } } catch (e) {}
    return { ingame: !!g.ingame, xp: Array.from(g.statXP || []), base: Array.from(g.statBaseLevel || []), eff: Array.from(g.statEffectiveLevel || []),
        x: p ? (g.mapBuildBaseX || 0) + ((p.x || 0) >> 7) : null, z: p ? (g.mapBuildBaseZ || 0) + ((p.z || 0) >> 7) : null, level: g.minusedlevel || 0, inv };
})()`;

// ---------------------------------------------------------------- process snapshot (one `ps` for every account)
export type PsRow = { pid: number; stat: string; cmd: string };
export function parsePs(text: string): PsRow[] {
    const rows: PsRow[] = [];
    for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), stat: m[2]!, cmd: m[3]!.trim() });
    }
    return rows;
}
/** Candidate rows for an account: any command mentioning one of its bot-dir needles ("bots/soko1/"). */
export function psCandidates(rows: PsRow[], needles: string[], exclude: number[] = []) {
    const ex = new Set(exclude);
    return rows.filter(r => !ex.has(r.pid) && needles.some(n => r.cmd.includes(n)));
}

// ---------------------------------------------------------------- script-host status (Phase 5)
export type HostedBot = { name: string; script: string; entry: string; state: string; restarts: number; lastError: string; hostPid: number; paused: boolean; statusFile: string };
export function parseScriptHostStatus(json: unknown, statusFile: string): Map<string, HostedBot> {
    const out = new Map<string, HostedBot>();
    const bots = (json as any)?.bots;
    const hostPid = Number((json as any)?.pid) || 0;
    if (!Array.isArray(bots) || !hostPid) return out;
    for (const b of bots) {
        if (!b?.name) continue;
        out.set(String(b.name).toLowerCase(), { name: String(b.name), script: String(b.script ?? ''), entry: String(b.entry ?? ''), state: String(b.state ?? ''), restarts: Number(b.restarts) || 0,
            lastError: String(b.lastError ?? ''), hostPid, paused: !!b.paused, statusFile });
    }
    return out;
}
