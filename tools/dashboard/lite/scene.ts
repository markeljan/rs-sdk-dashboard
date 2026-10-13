// Compact per-tick scene for the lite view (/api/lite/scene): just what the stand-in client draws, from the
// observer's BotWorldState. Positions are world tiles; items/skills are id/number tuples to keep the poll small.
import type { BotWorldState } from '../../../sdk/types';

// Client stat order (server/webclient/src/client/Skill.ts) - interface scripts address skills by this index.
export const CLIENT_SKILLS = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting',
    'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'slayer', '-', 'runecraft'];

const near = (dx: number, dz: number, r: number) => Math.abs(dx) <= r && Math.abs(dz) <= r;

export function buildLiteScene(s: BotWorldState, opts: { redact: (t: string) => string; activity: string; stateAgeMs: number | null }) {
    const p = s.player!;
    const px = p.worldX, pz = p.worldZ;
    const stats: Array<[number, number, number] | null> = CLIENT_SKILLS.map((n) => {
        const k = s.skills.find((x) => x.name.toLowerCase() === n);
        return k ? [k.level, k.baseLevel, k.experience] : null;
    });
    const items = (list: Array<{ slot: number; id: number; count: number }> | undefined) => (list ?? []).map((i) => [i.slot, i.id, i.count] as const);
    const seenLoc = new Set<string>();
    return {
        tick: s.tick, rev: s.revision ?? null, ageMs: opts.stateAgeMs,
        me: {
            name: p.name, x: px, z: pz, lvl: p.level, hp: p.hp, maxHp: p.maxHp, cb: p.combatLevel, anim: p.animId, spot: p.spotanimId,
            run: p.runEnergy, weight: p.runWeight, fight: !!p.combat?.inCombat, tgt: p.combat?.targetIndex ?? -1, tgtType: p.combat?.targetType ?? 'none',
            dead: !!p.isDead, skull: !!s.isSkulled,
        },
        npcs: s.nearbyNpcs.filter((n) => near(n.x - px, n.z - pz, 20)).slice(0, 48).map((n) => ({
            i: n.index, id: n.id, n: n.name, x: n.x, z: n.z, sz: n.size ?? 1, cb: n.combatLevel, hp: n.healthPercent,
            anim: n.animId, tgt: n.targetIndex, fight: n.inCombat, op: n.options?.[0] ?? null,
        })),
        players: s.nearbyPlayers.filter((o) => near(o.x - px, o.z - pz, 20)).slice(0, 32).map((o) => ({ i: o.index, n: o.name, x: o.x, z: o.z, cb: o.combatLevel })),
        locs: s.nearbyLocs.filter((l) => near(l.x - px, l.z - pz, 15) && l.level === p.level).filter((l) => {
            const k = `${l.id}:${l.x}:${l.z}`;
            if (seenLoc.has(k)) return false;
            seenLoc.add(k); return true;
        }).slice(0, 60).map((l) => ({ id: l.id, n: l.name, x: l.x, z: l.z, op: l.options?.[0] ?? null })),
        ground: s.groundItems.filter((g) => near(g.x - px, g.z - pz, 15)).slice(0, 40).map((g) => ({ id: g.id, n: g.name, c: g.count, x: g.x, z: g.z })),
        inv: items(s.inventory), worn: items(s.equipment), stats,
        names: Object.fromEntries([...(s.inventory ?? []), ...(s.equipment ?? [])].map((i) => [i.id, i.name])),
        prayers: s.prayers?.activePrayers ?? [],
        dialog: s.dialog?.isOpen ? {
            text: s.dialog.text ? opts.redact(s.dialog.text) : null, waiting: !!s.dialog.isWaiting,
            options: (s.dialog.options ?? []).map((o) => opts.redact(o.text)),
            comps: (s.dialog.allComponents ?? []).slice(0, 40).map((c) => [c.id, c.type, opts.redact(c.text ?? '')]),
        } : null,
        iface: s.interface?.isOpen ? { id: s.interface.interfaceId, options: (s.interface.options ?? []).slice(0, 20).map((o: any) => opts.redact(String(o.text ?? ''))) } : null,
        shop: s.shop?.isOpen ? { title: s.shop.title, items: items(s.shop.shopItems), mine: items(s.shop.playerItems) } : null,
        bank: s.bank?.isOpen ? { items: items(s.bank.items) } : null,
        trade: s.trade?.isOpen ? { screen: s.trade.screen, partner: s.trade.partner, mine: items(s.trade.myOffer), theirs: items(s.trade.theirOffer), myAcc: s.trade.myAccepted, theirAcc: s.trade.partnerAccepted } : null,
        hits: (s.combatEvents ?? []).slice(-16).map((e) => [e.observationId ?? e.tick, e.type, e.damage, e.targetType, e.targetIndex, e.sourceType, e.sourceIndex]),
        chat: (s.gameMessages ?? []).slice(-40).map((m, i) => [m.observationId ?? m.tick * 100 + i, m.type, m.sender, opts.redact(m.text), m.fromSelf ? 1 : 0]),
        activity: opts.activity,
    };
}
export type LiteScene = ReturnType<typeof buildLiteScene>;
