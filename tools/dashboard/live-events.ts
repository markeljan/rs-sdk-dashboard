// live-events.ts - the fleet's big moments as they happen (GET /api/events?since=<seq>), for the dashboard's toasts and
// the live feed on /highlights. Tails telemetry/ incrementally: per-file byte offsets, only the bytes appended since the
// last scan are parsed (xp-history alone is hundreds of MB). Startup seeds the ring from each drop log's recent tail.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { join } from 'path';

export type LiveEvent = {
    seq: number; t: string; acct: string;
    kind: 'drop' | 'pickup' | 'maxed';
    tier: 0 | 1 | 2 | 3; // 0 legendary (left half, d chain) · 1 dragon / lava · 2 dragonstone / top rune · 3 other big
    item: string; n: number; npc: string; value?: number;
};

// Drops that make a toast, best first (shared ranking with highlights.ts' HEADLINE list).
const BIG = ['Shield left half', 'Dragon chainbody', 'Dragon spear', 'Dragon med helm', 'Dragon vambraces', 'Lava battlestaff',
    'Dragonstone', 'Uncut dragonstone', 'Rune 2h sword', 'Rune kiteshield', 'Rune battleaxe', 'Rune sq shield', 'Rune spear', 'Runite bar'];
export const BIG_PICKUP_GP = 100_000; // any single pickup worth this much (logged shop/alch value) is an event too
const MAXED_TOTAL = 1881;
const RING = 200;
const SEED_BYTES = 256 * 1024; // per drop log at startup
const DROP_FILE = /^(loot|kbd-drops|alt-drops)-.*\.jsonl$/;

export function tierOf(item: string): LiveEvent['tier'] | null {
    const k = BIG.findIndex(b => b.toLowerCase() === item.toLowerCase());
    if (k < 0) return null;
    return k <= 1 ? 0 : k <= 5 ? 1 : k <= 8 ? 2 : 3;
}

function readRange(file: string, from: number, to: number): string {
    if (to <= from) return '';
    const fd = openSync(file, 'r');
    try { const b = Buffer.alloc(to - from); const n = readSync(fd, b, 0, b.length, from); return b.toString('utf8', 0, n); }
    finally { closeSync(fd); }
}

export class LiveEvents {
    private dir: string;
    private off = new Map<string, number>();
    private maxed = new Map<string, boolean>();
    private seen = new Set<string>();
    private ring: LiveEvent[] = [];
    private seq = 0;
    private timer: ReturnType<typeof setInterval> | null = null;

    /** dir: the telemetry dir (the dashboard's DATA_DIR; defaults to <root>/telemetry). */
    constructor(root: string, dir = join(root, 'telemetry')) { this.dir = dir; }

    start(everyMs = 4000) {
        this.scan(true);
        this.timer = setInterval(() => { try { this.scan(false); } catch { /* next scan */ } }, everyMs);
        (this.timer as any).unref?.();
        return this;
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    // since: the last seq the caller saw (omitted: the newest `limit` events, so a fresh page has a feed to show)
    list(since?: number, limit = 40) {
        const ev = since == null || !Number.isFinite(since) ? this.ring.slice(-limit) : this.ring.filter(e => e.seq > since).slice(-limit);
        return { seq: this.seq, events: ev };
    }

    private push(e: Omit<LiveEvent, 'seq'>) {
        const key = e.t.slice(0, 16) + e.acct + e.item; // the same drop is often logged by two scripts (loot + megarare)
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
        this.ring.push({ ...e, seq: ++this.seq });
        if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    }

    private lines(file: string, seed: boolean, seedBytes: number): string[] {
        let size: number;
        try { size = statSync(file).size; } catch { return []; }
        let from = this.off.get(file);
        if (from == null) from = seed ? Math.max(0, size - seedBytes) : 0; // a file that appears later is new: read it all
        if (size < from) from = 0; // truncated / rotated
        // only consume whole lines; a half-written last line is read next scan
        const raw = readRange(file, from, size);
        const end = raw.lastIndexOf('\n');
        if (end < 0) { this.off.set(file, from); return []; }
        this.off.set(file, from + Buffer.byteLength(raw.slice(0, end + 1)));
        const L = raw.slice(0, end).split('\n');
        if (from > 0 && seed) L.shift(); // seeded mid-file: the first line is partial
        return L;
    }

    scan(seed: boolean) {
        if (!existsSync(this.dir)) return;
        const files = readdirSync(this.dir);
        const batch: Omit<LiveEvent, 'seq'>[] = [];
        for (const f of files) {
            const file = join(this.dir, f);
            if (DROP_FILE.test(f) || f === 'megarare-drops.jsonl') {
                for (const l of this.lines(file, seed, SEED_BYTES)) {
                    let r: any; try { r = JSON.parse(l); } catch { continue; }
                    const item = String(r.item ?? ''); if (!item || !r.t || /\(sold\)/.test(item)) continue;
                    const acct = String(r.acct ?? r.alt ?? r.account ?? f.replace(/^[a-z-]+-|\.jsonl$/g, ''));
                    if (/slave/i.test(acct)) continue;
                    const n = Number(r.qty ?? r.count ?? r.n ?? 1) || 1;
                    const npc = f === 'megarare-drops.jsonl' ? 'Fire giant (Brimhaven)' : String(r.npc ?? '');
                    const tier = tierOf(item);
                    if (tier != null) batch.push({ t: r.t, acct, kind: 'drop', tier, item, n, npc, value: r.value });
                    else if (typeof r.value === 'number' && r.value >= BIG_PICKUP_GP) batch.push({ t: r.t, acct, kind: 'pickup', tier: 3, item, n, npc, value: r.value });
                }
            } else if (/^xp-history-.*\.jsonl$/.test(f)) {
                const acct = f.slice(11, -6); if (/slave/i.test(acct)) continue;
                // seeding: just learn whether the account is already maxed (last line only)
                const L = this.lines(file, seed, 4096);
                for (const l of L) {
                    let r: any; try { r = JSON.parse(l); } catch { continue; }
                    if (!r.totalLevel) continue;
                    const was = this.maxed.get(acct), now = r.totalLevel >= MAXED_TOTAL;
                    this.maxed.set(acct, now);
                    if (!seed && was === false && now) batch.push({ t: r.ts ?? r.t ?? new Date().toISOString(), acct, kind: 'maxed', tier: 0, item: '99 in every skill', n: 1, npc: '' });
                }
            }
        }
        batch.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
        for (const e of batch) this.push(e);
    }
}
