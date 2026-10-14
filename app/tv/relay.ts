// Share one read-only upstream subscription for nearby cameras. Late joiners get a
// full snapshot; delta streams must never silently drop frames on slow connections.
export function regionFor(area: { x: number; z: number; w: number; h: number }) {
    if (![area.x, area.z, area.w, area.h].every(Number.isFinite) || area.w <= 0 || area.h <= 0 || area.w > 384 || area.h > 384 || Math.abs(area.x) > 20000 || Math.abs(area.z) > 20000) return null;
    const x = Math.floor((area.x + area.w / 2) / 128) * 128 - 128;
    const z = Math.floor((area.z + area.h / 2) / 128) * 128 - 128;
    return { key: `${x}:${z}`, x, z, w: 384, h: 384 };
}
export class SceneSnapshot {
    hello: any = null;
    roster: any = null;
    tick = 0;
    ms = 300;
    players = new Map<number, any>();
    npcs = new Map<number, any>();
    apply(m: any) {
        if (m.t === 'hello') { this.hello = m; this.players.clear(); this.npcs.clear(); }
        if (m.t === 'roster') this.roster = m;
        if (m.t !== 'tick') return;
        this.tick = m.k; this.ms = m.ms;
        if (m.reset) { this.players.clear(); this.npcs.clear(); }
        for (const [records, removed, map] of [[m.p, m.rp, this.players], [m.n, m.rn, this.npcs]] as const) {
            for (const id of removed ?? []) map.delete(id);
            for (const r of records ?? []) {
                const prev = r.f ? {} : map.get(r.i) ?? {};
                // Only persistent entity state belongs in a join snapshot. Replaying an
                // old hitsplat, chat, exact move or animation would invent a new event.
                for (const key of ['i', 'x', 'z', 'l', 'ap', 't', 'fe', 'fs', 'hp']) if (r[key] !== undefined) prev[key] = r[key];
                map.set(r.i, prev);
            }
        }
    }
    frames() {
        return [this.hello, this.roster, { t: 'tick', k: this.tick, ms: this.ms, reset: 1, p: [...this.players.values()].map(p => ({ ...p, f: 1 })), n: [...this.npcs.values()].map(n => ({ ...n, f: 1 })) }].filter(Boolean);
    }
}
