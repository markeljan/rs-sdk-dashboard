import type { Player } from './director';

export const CATEGORIES = [
    { id: 'overall', name: 'Overall', path: '/hiscores?category=0', unit: 'level' },
    { id: 'bank', name: 'Bank value', path: '/hiscores/bank', unit: 'GP' },
    { id: 'equipment', name: 'Equipment value', path: '/hiscores/outfit', unit: 'GP' },
    { id: 'quests', name: 'Quest points', path: '/hiscores?category=100', unit: 'QP' },
    { id: 'combat', name: 'Combat level', path: '', unit: 'combat' },
    ...['Attack','Defence','Strength','Hitpoints','Ranged','Prayer','Magic','Cooking','Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore','Agility','Thieving','Runecraft'].map((name, i) => ({ id: name.toLowerCase(), name, path: `/hiscores?category=${i === 18 ? 21 : i + 1}`, unit: 'level' })),
];
export type Item = { name: string; value: number };
export type Score = { name: string; rank: number; value: number; time?: string; items?: Item[] };
export type Skill = { name: string; category: number; rank: number | null; level: number | null; time: string };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, e => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '}[e]!));
const plain = (s: string) => decode(s.replace(/<[^>]*>/g, '')).trim();
const number = (s: string) => /^\d[\d,]*$/.test(plain(s)) ? Number(plain(s).replaceAll(',', '')) : null;
export const nameKey = (s: string) => s.toLowerCase().replaceAll('_', ' ').trim().replace(/\s+/g, ' ');
export function parseBoard(html: string, values = false): Score[] {
    if (values) {
        const rows = [...html.matchAll(/<tr>\s*<td align="right">(\d+)<\/td>([\s\S]*?)<\/tr>/g)].map(m => {
            const name = m[2]!.match(/href="\/hiscores\/player\/[^"]+"[^>]*>([^<]+)<\/a>/)?.[1];
            const value = m[2]!.match(/class="yellow" title="([\d,]+) gp"/); if (!name || !value) return null;
            const items = [...m[2]!.matchAll(/title="([^"]+) \(([\d,]+) gp\)"/g)].map(item => ({ name: decode(item[1]!), value: Number(item[2]!.replaceAll(',', '')) }));
            return { name: decode(name), rank: Number(m[1]), value: Number(value[1]!.replaceAll(',', '')), items };
        }).filter((v): v is NonNullable<typeof v> => v !== null);
        if (!rows.length) throw new Error('Published value table unavailable');
        return rows;
    }
    const column = (label: string) => html.match(new RegExp(`<b>${label}</b><br>([\\s\\S]*?)</td>`))?.[1] ?? '';
    const lines = (label: string) => column(label).split(/<br\s*\/?>/).map(plain).filter(Boolean);
    const names = [...column('Name').matchAll(/href="\/hiscores\/player\/[^"]+"[^>]*>([^<]+)<\/a>/g)].map(m => decode(m[1]!));
    const ranks = lines('Rank'), levels = lines('Level').length ? lines('Level') : lines('Points'), times = lines('Time');
    if (!names.length || names.length !== ranks.length || names.length !== levels.length || names.length !== times.length) throw new Error('Published skill table unavailable');
    return names.map((name, i) => {
        const rank = number(ranks[i]!), value = number(levels[i]!);
        if (rank === null || value === null) throw new Error('Invalid published score');
        return { name, rank, value, time: times[i]! };
    });
}
export function parseProfile(html: string): Skill[] {
    const rows = [...html.matchAll(/<tr>\s*<td><a href="\/hiscores\?category=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a><\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g)];
    if (!rows.length) throw new Error('No public skill profile available');
    return rows.map(m => ({ name: plain(m[2]!), category: Number(m[1]), rank: number(m[3]!), level: number(m[4]!), time: plain(m[5]!) }));
}
type Snapshot<T> = { value: T; fetchedAt: number; source: string; stale: boolean };
type Entry = { snapshot?: Snapshot<any>; pending?: Promise<Snapshot<any>>; retryAt?: number };
export class PublicHiscores {
    private cache = new Map<string, Entry>();
    private active = 0;
    constructor(readonly origin = 'https://rs-sdk-demo.fly.dev', readonly request: (url: string, init?: RequestInit) => Promise<Response> = fetch, readonly now = Date.now) {}
    private async cached<T>(key: string, source: string, load: () => Promise<T>): Promise<Snapshot<T>> {
        const at = this.now(), existing = this.cache.get(key);
        if (existing?.pending) return existing.pending;
        if (existing?.snapshot && at - existing.snapshot.fetchedAt < 300_000) return existing.snapshot;
        if (existing?.retryAt && at < existing.retryAt) {
            if (existing.snapshot) return { ...existing.snapshot, stale: true };
            throw new Error('Public hiscores temporarily unavailable');
        }
        if (this.active >= 4) throw new Error('Hiscores busy; try again shortly');
        // Bound user-supplied profile cache keys; active requests and recent entries stay intact.
        if (this.cache.size >= 256) for (const [k, e] of this.cache) { if (!e.pending) { this.cache.delete(k); break; } }
        const entry: Entry = { snapshot: existing?.snapshot }; this.cache.set(key, entry); this.active++;
        entry.pending = (async () => {
            try { const value = await load(); const snapshot = { value, source, fetchedAt: this.now(), stale: false }; entry.snapshot = snapshot; return snapshot; }
            catch (e) { entry.retryAt = this.now() + 30_000; if (entry.snapshot) return { ...entry.snapshot, stale: true }; throw e; }
            finally { entry.pending = undefined; this.active--; }
        })();
        return entry.pending;
    }
    private async html(path: string) {
        const r = await this.request(this.origin + path, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'RS-SDK-TV/1.0 public-hiscores' } });
        if (!r.ok) throw new Error(r.status === 404 ? 'No public profile found' : 'Public hiscores temporarily unavailable');
        return r.text();
    }
    async board(id: string) {
        const category = CATEGORIES.find(c => c.id === id && c.path); if (!category) throw new Error('Unknown ranking category');
        return this.cached<Score[]>(`board:${id}`, this.origin + category.path, async () => {
            if (category.unit === 'GP') return parseBoard(await this.html(category.path), true);
            // Five published pages, not one request per online account. Keep upstream load bounded.
            const rows: Score[] = [];
            for (let rank = 1; rank <= 85; rank += 21) {
                const page = parseBoard(await this.html(`${category.path}&rank=${rank}`)); rows.push(...page);
                if (page.length < 21) break;
            }
            return [...new Map(rows.map(row => [nameKey(row.name), row])).values()].sort((a,b) => a.rank - b.rank);
        });
    }
    async profile(name: string) {
        const key = nameKey(name); if (!/^[a-z0-9 _-]{1,12}$/.test(key)) throw new Error('Invalid player name');
        const path = `/hiscores/player/${encodeURIComponent(key.replaceAll(' ', '_'))}`;
        const stats = await this.cached<Skill[]>(`profile:${key}`, this.origin + path, async () => parseProfile(await this.html(path)));
        const wealth = await Promise.allSettled([this.board('bank'), this.board('equipment')]);
        const published = (index: number) => {
            const r = wealth[index]; if (r?.status !== 'fulfilled') return { entry: null, status: 'unavailable', source: this.origin + (index ? '/hiscores/outfit' : '/hiscores/bank'), fetchedAt: null };
            return { entry: r.value.value.find(p => nameKey(p.name) === key) ?? null, status: r.value.stale ? 'stale' : 'published', source: r.value.source, fetchedAt: r.value.fetchedAt };
        };
        return { name, skills: stats.value, fetchedAt: stats.fetchedAt, stale: stats.stale, source: stats.source, bank: published(0), equipment: published(1) };
    }
}
export function joinOnline(scores: Score[], players: Player[], fresh: boolean) {
    const online = new Map(players.map(p => [nameKey(p[1]), p]));
    return scores.map(p => ({ ...p, online: fresh ? online.has(nameKey(p.name)) : null, followName: fresh ? online.get(nameKey(p.name))?.[1] ?? null : null }));
}
