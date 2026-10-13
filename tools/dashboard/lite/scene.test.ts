import { describe, expect, test } from 'bun:test';
import { buildLiteScene, CLIENT_SKILLS } from './scene';

const state: any = {
    tick: 100, revision: 7, inGame: true,
    player: { name: 'Bot', combatLevel: 3, hp: 9, maxHp: 10, x: 0, z: 0, worldX: 3200, worldZ: 3200, level: 0, runEnergy: 80, runWeight: 5, animId: 867, spotanimId: -1, combat: { inCombat: false, targetIndex: -1, targetType: 'none', lastDamageTick: -1 }, isDead: false },
    skills: [{ name: 'Woodcutting', level: 50, baseLevel: 50, experience: 100000 }, { name: 'Runecraft', level: 3, baseLevel: 3, experience: 200 }],
    inventory: [{ slot: 2, id: 1519, name: 'Willow logs', count: 1, optionsWithIndex: [] }],
    equipment: [{ slot: 3, id: 1355, name: 'Mithril axe', count: 1, optionsWithIndex: [] }],
    nearbyNpcs: [{ kind: 'npc', index: 4, id: 81, name: 'Cow', combatLevel: 2, x: 3205, z: 3201, size: 2, distance: 5, hp: null, maxHp: null, healthPercent: null, targetIndex: -1, inCombat: false, lastCombatTick: null, animId: -1, spotanimId: -1, optionsWithIndex: [], options: ['Attack'] },
        { kind: 'npc', index: 5, id: 81, name: 'Far cow', combatLevel: 2, x: 3300, z: 3300, distance: 99, options: [] }],
    nearbyPlayers: [], groundItems: [],
    nearbyLocs: [{ id: 1308, name: 'Willow', x: 3201, z: 3200, level: 0, distance: 1, optionsWithIndex: [], options: ['Chop down'] },
        { id: 1308, name: 'Willow', x: 3201, z: 3200, level: 0, distance: 1, optionsWithIndex: [], options: ['Chop down'] },
        { id: 1, name: 'Upstairs', x: 3202, z: 3200, level: 1, distance: 2, optionsWithIndex: [], options: [] }],
    gameMessages: [{ type: 0, text: 'You get some logs. password=hunter2', sender: '', tick: 99, fromSelf: false }],
    recentDialogs: [], dialog: { isOpen: false, options: [], isWaiting: false }, interface: { isOpen: false, interfaceId: -1, options: [] },
    shop: { isOpen: false, title: '', shopItems: [], playerItems: [] }, bank: { isOpen: true, items: [{ slot: 0, id: 995, name: 'Coins', count: 5 }], noteMode: false },
    modalOpen: false, modalInterface: -1, combatEvents: [], prayers: { activePrayers: [true], prayerPoints: 1, prayerLevel: 1 },
};

describe('buildLiteScene', () => {
    const s = buildLiteScene(state, { redact: (t) => t.replace(/password=\S+/, 'password=***'), activity: 'chopping', stateAgeMs: 120 });
    test('player, stats in client order, items as tuples', () => {
        expect(s.me).toMatchObject({ name: 'Bot', x: 3200, z: 3200, anim: 867 });
        expect(s.stats[CLIENT_SKILLS.indexOf('woodcutting')]).toEqual([50, 50, 100000]);
        expect(s.stats[CLIENT_SKILLS.indexOf('runecraft')]).toEqual([3, 3, 200]);
        expect(s.stats[0]).toBeNull();
        expect(s.inv).toEqual([[2, 1519, 1]]);
        expect(s.worn).toEqual([[3, 1355, 1]]);
        expect(s.names).toEqual({ 1519: 'Willow logs', 1355: 'Mithril axe' });
        expect(s.bank?.items).toEqual([[0, 995, 5]]);
    });
    test('nearby only, deduped locs on the player floor', () => {
        expect(s.npcs.map((n) => n.n)).toEqual(['Cow']);
        expect(s.npcs[0]).toMatchObject({ sz: 2, op: 'Attack' });
        expect(s.locs).toEqual([{ id: 1308, n: 'Willow', x: 3201, z: 3200, op: 'Chop down' }]);
    });
    test('chat goes through redact', () => {
        expect(s.chat[0]![3]).toBe('You get some logs. password=***');
    });
});
