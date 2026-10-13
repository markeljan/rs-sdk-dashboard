import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LiveEvents, tierOf } from './live-events';

describe('live events', () => {
    test('tiers', () => {
        expect(tierOf('Shield left half')).toBe(0);
        expect(tierOf('dragon med helm')).toBe(1);
        expect(tierOf('Rune longsword')).toBeNull();
    });
    test('seeds from the tail, then emits only appended big events, deduped across logs', () => {
        const root = mkdtempSync(join(tmpdir(), 'live-')), T = join(root, 'telemetry');
        mkdirSync(T);
        const line = (o: object) => JSON.stringify(o) + '\n';
        writeFileSync(join(T, 'loot-a.jsonl'), line({ t: '2026-10-13T10:00:00Z', alt: 'a', npc: 'KBD', item: 'Dragon med helm', qty: 1 }) + line({ t: '2026-10-13T10:01:00Z', alt: 'a', item: 'Blood rune', value: 500 }));
        writeFileSync(join(T, 'xp-history-a.jsonl'), line({ ts: '2026-10-13T10:00:00Z', totalLevel: 1880 }));
        const L = new LiveEvents(root);
        L.scan(true);
        const s0 = L.list();
        expect(s0.events.map(e => e.item)).toEqual(['Dragon med helm']);
        appendFileSync(join(T, 'loot-a.jsonl'), line({ t: '2026-10-13T11:00:00Z', alt: 'a', item: 'Rune platebody', value: 150000 }) + '{"t":"2026-10-13T11:0');
        writeFileSync(join(T, 'megarare-drops.jsonl'), line({ t: '2026-10-13T11:05:00Z', acct: 'b', item: 'Shield left half', n: 1 }));
        writeFileSync(join(T, 'alt-drops-b.jsonl'), line({ t: '2026-10-13T11:05:01Z', alt: 'b', npc: 'Fire giant', item: 'Shield left half', count: 1 }));
        appendFileSync(join(T, 'xp-history-a.jsonl'), line({ ts: '2026-10-13T11:06:00Z', totalLevel: 1881 }));
        L.scan(false);
        const s1 = L.list(s0.seq);
        expect(s1.events.map(e => `${e.kind}:${e.acct}:${e.item}`)).toEqual(['pickup:a:Rune platebody', 'drop:b:Shield left half', 'maxed:a:99 in every skill']);
        expect(L.list(s1.seq).events).toEqual([]);
    });
});
