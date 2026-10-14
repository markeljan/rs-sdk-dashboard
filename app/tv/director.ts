// Public spectator data only. No gateway credentials or gameplay controls.
export type Player = [number, string, number, number, number, number];
export type Shot = { id: string; name: string; reason: string; x: number; z: number; level: number; follow?: string; score: number; since: number };
export const PLACES = [
    { name: 'Duel Arena', x: 3360, z: 3250, radius: 65, priority: 28 },
    { name: 'Castle Wars', x: 2400, z: 3100, radius: 75, priority: 26 },
    { name: 'Kalphite Queen', x: 3480, z: 9500, radius: 35, priority: 32 },
    { name: 'King Black Dragon', x: 2273, z: 4695, radius: 24, priority: 30 },
    { name: 'Wilderness', x: 3288, z: 3886, radius: 52, priority: 24 },
    { name: 'Varrock', x: 3210, z: 3424, radius: 80, priority: 4 },
    { name: 'Falador', x: 2964, z: 3378, radius: 60, priority: 2 },
    { name: 'Lumbridge', x: 3222, z: 3218, radius: 60, priority: 2 },
    { name: 'Fishing Guild', x: 2597, z: 3415, radius: 40, priority: 1 },
];
export function placeAt(x: number, z: number): string {
    return PLACES.find(p => Math.hypot(p.x - x, p.z - z) <= p.radius)?.name ?? (z > 9000 ? 'Underground' : z > 3520 && z < 4000 ? 'Wilderness' : `World ${x}, ${z}`);
}

type Action = { at: number; weight: number; combat: boolean; text?: string };
export class Director {
    players: Player[] = [];
    shot: Shot | null = null;
    rosterAt = 0;
    private actions = new Map<number, Action>();
    private visited = new Map<string, number>();
    roster(players: Player[], now = Date.now()) { this.players = players; this.rosterAt = now; this.choose(now); }
    activity(records: any[], now = Date.now()) {
        for (const r of records) {
            if (r.hm || r.ch || r.sy) this.actions.set(r.i, { at: now, weight: r.hm ? 28 : 10, combat: !!r.hm, text: String(r.ch ?? r.sy ?? '').slice(0, 220) || undefined });
        }
        for (const [id, a] of this.actions) if (now - a.at > 30_000) this.actions.delete(id);
    }
    candidates(now = Date.now()): Shot[] {
        const groups = new Map<string, Player[]>();
        for (const p of this.players) {
            const key = `${p[2] >> 5}:${p[3] >> 5}:${p[4]}`;
            const group = groups.get(key) ?? []; group.push(p); groups.set(key, group);
        }
        const candidates: Shot[] = [];
        for (const [key, group] of groups) {
            const ranked = [...group].sort((a, b) => this.actionScore(b, now) - this.actionScore(a, now) || b[5] - a[5] || a[1].localeCompare(b[1]));
            const p = ranked[0]!;
            const place = PLACES.find(loc => Math.hypot(loc.x - p[2], loc.z - p[3]) <= loc.radius);
            const action = this.actions.get(p[0]);
            const active = action && now - action.at < 15_000;
            const comedy = group.find(v => v[1].toLowerCase() === 'voltbot');
            const chosen = comedy && !active ? comedy : p;
            const score = Math.min(18, Math.sqrt(group.length) * 3) + (place?.priority ?? 0) + this.actionScore(chosen, now) + (comedy ? 16 : 0);
            candidates.push({ id: key, name: comedy && chosen === comedy ? 'Voltbot' : place?.name ?? placeAt(p[2], p[3]), reason: active && action.combat ? `Live combat · ${p[1]}` : active && action.text ? `${p[1]}: ${action.text}` : comedy ? 'Hanging out with the server’s comedian' : `${group.length} player${group.length === 1 ? '' : 's'} in this area`, x: chosen[2], z: chosen[3], level: chosen[4], follow: chosen[1], score, since: now });
        }
        return candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }
    private actionScore(p: Player, now: number) { const a = this.actions.get(p[0]); return a ? a.weight * Math.max(0, 1 - (now - a.at) / 30_000) : 0; }
    choose(now = Date.now(), force = false) {
        if (!this.players.length) { this.shot = null; return; }
        const candidates = this.candidates(now);
        const current = this.shot;
        const currentPlayer = current?.follow && this.players.find(p => p[1] === current.follow);
        if (!force && current && currentPlayer && now - current.since < 35_000) {
            current.x = currentPlayer[2]; current.z = currentPlayer[3]; current.level = currentPlayer[4]; return;
        }
        const next = [...candidates].sort((a, b) => {
            const adjusted = (s: Shot) => s.score - ((now - (this.visited.get(s.id) ?? 0) < 180_000) ? 45 : 0);
            return adjusted(b) - adjusted(a);
        })[0];
        if (next) { this.shot = next; this.visited.set(next.id, now); }
    }
}
