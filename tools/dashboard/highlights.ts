// highlights.ts - fleet highlights for /highlights (GET /api/highlights): best drops, achievements, richest accounts,
// best money-lab methods and the farms/groups running. Read-only over telemetry/ and tools/money-lab/results.tsv;
// the server caches the payload (HIGHLIGHTS_TTL_MS) because the loot logs are tens of thousands of lines.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export type EarnerRow = { name: string; gphRecent?: number; gphOverall?: number; total?: number };

// Drops worth a headline, best first. Anything else flagged `rare` in the logs lands in "other rares".
const HEADLINE = ['Shield left half', 'Dragon chainbody', 'Dragon spear', 'Dragon med helm', 'Dragon vambraces', 'Lava battlestaff',
    'Dragonstone', 'Uncut dragonstone', 'Rune 2h sword', 'Rune kiteshield', 'Rune battleaxe', 'Rune sq shield', 'Rune spear', 'Runite bar'];

// Milestones the logs cannot derive (dates from learnings/*.md); everything else below is computed.
const MILESTONES = [
    { at: '2026-10-08', text: 'Equipment hiscore rank 1: SOKO 1,187K wearing 1,949 rune thrownaxes (back to #2 after upstream counted worn stacks once)' },
    { at: '2026-10-07', text: 'sokobot finished all 63 quests' },
    { at: '2026-10-08', text: '0hyl8LmRi reached 99 in every skill and handed its loot to SOKO' },
];

const jsonl = (f: string): any[] => {
    if (!existsSync(f)) return [];
    const out: any[] = [];
    for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
    return out;
};
const lastJson = (f: string): any => {
    const raw = readFileSync(f, 'utf8').trimEnd();
    try { return JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1)); } catch { return null; }
};
const isLegacy = (a: string) => /slave/i.test(a); // retired account names (memory: banned), not shown

export function buildHighlights(root: string, earners: EarnerRow[] = [], telemetryDir = join(root, 'telemetry')) {
    const T = telemetryDir;
    const files = existsSync(T) ? readdirSync(T) : [];

    // ---- drops: per-account loot logs, KBD logs, alt logs, Brimhaven megarare log (deduped across them)
    type Drop = { t: string; acct: string; npc: string; item: string; n: number; value?: number };
    const drops: Drop[] = [], all: Drop[] = [];
    const seen = new Set<string>();
    const add = (d: Drop, rare: boolean) => {
        if (!d.item || !d.t) return;
        if (rare) { const k = d.t.slice(0, 16) + d.acct + d.item; if (!seen.has(k)) { seen.add(k); drops.push(d); } }
    };
    for (const f of files.filter(f => /^(loot|kbd-drops|alt-drops)-.*\.jsonl$/.test(f))) {
        for (const r of jsonl(join(T, f))) {
            const d = { t: r.t, acct: r.acct ?? r.alt ?? f.replace(/^[a-z-]+-|\.jsonl$/g, ''), npc: r.npc ?? '', item: r.item, n: r.qty ?? r.count ?? 1, value: r.value };
            if (f.startsWith('loot-') && typeof r.value === 'number' && !/\(sold\)/.test(r.item ?? '')) all.push(d);
            add(d, !!r.rare);
        }
    }
    for (const r of jsonl(join(T, 'megarare-drops.jsonl'))) add({ t: r.t, acct: r.acct, npc: 'Fire giant (Brimhaven)', item: r.item, n: r.n ?? 1 }, true);
    drops.sort((a, b) => (a.t < b.t ? 1 : -1));

    const byItem = new Map<string, { item: string; n: number; accts: Set<string>; last: string }>();
    for (const d of drops) {
        const e = byItem.get(d.item) ?? { item: d.item, n: 0, accts: new Set<string>(), last: '' };
        e.n += d.n || 1; e.accts.add(d.acct); if (d.t > e.last) e.last = d.t; byItem.set(d.item, e);
    }
    const rank = (i: string) => { const k = HEADLINE.findIndex(h => h.toLowerCase() === i.toLowerCase()); return k < 0 ? 99 : k; };
    const items = [...byItem.values()].map(e => ({ item: e.item, n: e.n, accts: [...e.accts].filter(Boolean).sort(), last: e.last, headline: rank(e.item) < 99 }))
        .sort((a, b) => rank(a.item) - rank(b.item) || b.n - a.n);
    const best = drops.filter(d => rank(d.item) <= 5).slice(0, 30); // dragon items, dragonstones, the shield, ... newest first
    const topValue = [...all].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 12);
    const lootValue = all.reduce((s, d) => s + (d.value ?? 0), 0);

    // ---- accounts: total level (xp-history), wealth now and its first sample
    const levels: { acct: string; totalLevel: number }[] = [];
    for (const f of files.filter(f => /^xp-history-.*\.jsonl$/.test(f))) {
        const acct = f.slice(11, -6); if (isLegacy(acct)) continue;
        const r = lastJson(join(T, f)); if (r?.totalLevel) levels.push({ acct, totalLevel: r.totalLevel });
    }
    levels.sort((a, b) => b.totalLevel - a.totalLevel);
    const wealth: { acct: string; total: number; first: number; firstAt: string; d24: number }[] = [];
    for (const f of files.filter(f => /^wealth-.*\.jsonl$/.test(f))) {
        const acct = f.slice(7, -6); if (isLegacy(acct)) continue;
        const L = jsonl(join(T, f)).map(r => ({ t: typeof r.t === 'number' ? r.t : Date.parse(r.t ?? r.ts), v: r.total })).filter(r => Number.isFinite(r.v) && r.t);
        if (!L.length) continue;
        const last = L[L.length - 1]!, day = L.find(r => r.t >= last.t - 24 * 3.6e6) ?? L[0]!;
        wealth.push({ acct, total: last.v, first: L[0]!.v, firstAt: new Date(L[0]!.t).toISOString(), d24: last.v - day.v });
    }
    wealth.sort((a, b) => b.total - a.total);

    // ---- money lab: methods by average gp/h over metered runs >= 15 min (one row per method family, -vN folded)
    const methods: { method: string; runs: number; avg: number; best: number; accts: number; last: string }[] = [];
    const tsvFile = join(root, 'tools/money-lab/results.tsv');
    if (existsSync(tsvFile)) {
        const [head, ...lines] = readFileSync(tsvFile, 'utf8').trim().split('\n');
        const H = (head ?? '').split('\t');
        const agg = new Map<string, { n: number; sum: number; max: number; accts: Set<string>; last: string }>();
        for (const l of lines) {
            const r = Object.fromEntries(l.split('\t').map((v, i) => [H[i], v])) as Record<string, string>;
            if (!/^(ok|run)/.test(r.status ?? '') || r.gp_h === '' || !(Number(r.metered_min) >= 15)) continue;
            const m = (r.method ?? '').replace(/-v\d+$/, ''), g = Number(r.gp_h);
            if (!Number.isFinite(g)) continue;
            const e = agg.get(m) ?? { n: 0, sum: 0, max: -Infinity, accts: new Set<string>(), last: '' };
            e.n++; e.sum += g; e.max = Math.max(e.max, g); e.accts.add(r.account ?? ''); if ((r.ended ?? '') > e.last) e.last = r.ended ?? '';
            agg.set(m, e);
        }
        for (const [method, e] of agg) methods.push({ method, runs: e.n, avg: Math.round(e.sum / e.n), best: Math.round(e.max), accts: e.accts.size, last: e.last });
        methods.sort((a, b) => b.avg - a.avg);
    }

    // ---- farms / groups
    let brim: { accounts: number; kills: number; deaths: number; top: { acct: string; kills: number; kph: number }[] } | null = null;
    if (existsSync(join(T, 'megarare-farm.json'))) {
        try {
            const b = JSON.parse(readFileSync(join(T, 'megarare-farm.json'), 'utf8')) as Record<string, any>;
            const v = Object.entries(b);
            brim = { accounts: v.length, kills: v.reduce((s, [, x]) => s + (x.kills ?? 0), 0), deaths: v.reduce((s, [, x]) => s + (x.deaths ?? 0), 0),
                top: v.map(([acct, x]) => ({ acct, kills: x.kills ?? 0, kph: x.kphAvg ?? x.kph ?? 0 })).sort((a, b) => b.kills - a.kills).slice(0, 5) };
        } catch { /* mid-write */ }
    }
    const clues = files.filter(f => /^clues-.*\.jsonl$/.test(f)).map(f => {
        const L = jsonl(join(T, f));
        return { acct: f.slice(6, -6), done: L.filter(r => r.outcome === 'completed').length, total: L.length };
    }).filter(c => c.done > 0).sort((a, b) => b.done - a.done);
    const kqKills = jsonl(join(T, 'kq-team-kills.jsonl')).length;
    const groups: { group: string; accounts: number; what: string }[] = [];
    const fleetFile = join(root, 'tools/fleet-manager/fleet.json');
    if (existsSync(fleetFile)) {
        try {
            const f = JSON.parse(readFileSync(fleetFile, 'utf8'));
            const ents: any[] = Array.isArray(f) ? f : (f.entries ?? f.processes ?? []);
            const g = new Map<string, { accts: Set<string>; what: string }>();
            for (const e of ents) {
                if (e.kind !== 'bot' || e.enabled === false || !e.group) continue;
                const x = g.get(e.group) ?? { accts: new Set<string>(), what: '' };
                for (const a of e.accounts ?? []) x.accts.add(a);
                if (!x.what && e.notes) x.what = String(e.notes).split(/(?<=\.)\s/)[0]!.slice(0, 160);
                g.set(e.group, x);
            }
            for (const [group, x] of g) if (x.accts.size) groups.push({ group, accounts: x.accts.size, what: x.what });
            groups.sort((a, b) => b.accounts - a.accounts);
        } catch { /* mid-write */ }
    }

    const maxed = levels.filter(l => l.totalLevel >= 1881).map(l => l.acct);
    return {
        at: new Date().toISOString(),
        totals: { rareDrops: drops.length, lootPickups: all.length, lootValue, wealth: wealth.reduce((s, w) => s + w.total, 0), accounts: wealth.length, maxed: maxed.length, kqKills, brimKills: brim?.kills ?? 0 },
        best, items, topValue,
        achievements: { maxed, topLevels: levels.slice(0, 12), clues, milestones: MILESTONES },
        wealth: wealth.slice(0, 15),
        earners: earners.filter(e => Number.isFinite(e.gphRecent) || Number.isFinite(e.gphOverall))
            .map(e => ({ acct: e.name, gphRecent: Math.round(e.gphRecent ?? 0), gphOverall: Math.round(e.gphOverall ?? 0), total: e.total ?? null }))
            .sort((a, b) => b.gphRecent - a.gphRecent).slice(0, 12),
        methods: methods.slice(0, 12),
        farms: { brim, kqKills, groups },
    };
}
