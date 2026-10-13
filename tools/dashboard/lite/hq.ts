// Bot HQ: the bird's-eye feed across accounts. Each /api/hq build hands every account's latest observation to
// HqFeed, which turns changes into a short event log (level-ups, deaths, going offline, pauses, new activities)
// for the HQ chat box. Activity lines change every tick, so they are compared without their numbers and at most
// one per account per ACTIVITY_GAP_MS is kept.
export type HqObservation = {
    name: string; live: boolean; paused: boolean; dead: boolean; activity: string;
    levels: Record<string, number> | null;
};
export type HqEvent = { t: number; account: string; kind: 'level' | 'death' | 'online' | 'offline' | 'paused' | 'resumed' | 'activity'; text: string };

const ACTIVITY_GAP_MS = 30_000;
const norm = (s: string) => s.toLowerCase().replace(/[\d,.]+/g, '#').replace(/\s+/g, ' ').trim();

export class HqFeed {
    events: HqEvent[] = [];
    private prev = new Map<string, HqObservation & { actNorm: string; actAt: number }>();
    private born: number | null = null;
    /** quietMs: observers are still connecting after a dashboard restart - no online/offline noise then */
    constructor(private max = 150, private quietMs = 60_000) {}

    observe(o: HqObservation, now = Date.now()) {
        const p = this.prev.get(o.name);
        this.born ??= now;
        const actNorm = norm(o.activity);
        const push = (kind: HqEvent['kind'], text: string) => { this.events.push({ t: now, account: o.name, kind, text }); };
        if (p) {
            // only between two live, fully loaded observations: a fresh observer briefly reports every skill at 1
            const loaded = (l: Record<string, number> | null) => !!l && Object.values(l).reduce((x, y) => x + y, 0) > Object.keys(l).length + 9;
            if (o.live && p.live && loaded(o.levels) && loaded(p.levels)) for (const [skill, lvl] of Object.entries(o.levels!)) {
                const was = p.levels![skill] ?? 0;
                if (was > 0 && lvl > was) push('level', `${skill} level ${lvl}`);
            }
            if (o.dead && !p.dead) push('death', 'died');
            if (o.live !== p.live && now - this.born >= this.quietMs) push(o.live ? 'online' : 'offline', o.live ? 'back online' : 'went offline');
            if (o.paused !== p.paused) push(o.paused ? 'paused' : 'resumed', o.paused ? 'automations paused' : 'automations resumed');
        }
        let actAt = p?.actAt ?? 0;
        if (o.activity && actNorm !== p?.actNorm && now - actAt >= ACTIVITY_GAP_MS) { if (p) push('activity', o.activity); actAt = now; }
        this.prev.set(o.name, { ...o, actNorm: actAt === now ? actNorm : p?.actNorm ?? actNorm, actAt });
        if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    }
}
