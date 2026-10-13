import { expect, test } from 'bun:test';
import { HqFeed } from './hq';

test('HqFeed reports level-ups, deaths, presence and throttled activity changes', () => {
    const f = new HqFeed(150, 0);
    const base = { name: 'w1', live: true, paused: false, dead: false, activity: 'chop 1 log', levels: { Woodcutting: 50, Hitpoints: 10 } };
    f.observe(base, 0);
    expect(f.events).toEqual([]); // first sight is the baseline
    f.observe({ ...base, activity: 'chop 2 logs', levels: { Woodcutting: 51, Hitpoints: 10 } }, 1000);
    expect(f.events.map(e => e.text)).toEqual(['Woodcutting level 51']); // same activity apart from numbers
    f.observe({ ...base, activity: 'bank trip', levels: { Woodcutting: 51, Hitpoints: 10 } }, 5000);
    expect(f.events).toHaveLength(1); // activity throttled within 30 s of the baseline
    f.observe({ ...base, activity: 'bank trip', levels: { Woodcutting: 51 }, live: false, dead: true }, 40_000);
    expect(f.events.map(e => e.kind)).toEqual(['level', 'death', 'offline', 'activity']);
});

test('a freshly connected observer (every skill at 1) does not count as level-ups', () => {
    const f = new HqFeed();
    const o = { name: 'w2', live: true, paused: false, dead: false, activity: 'x' };
    f.observe({ ...o, levels: { Woodcutting: 1, Hitpoints: 1 } }, 0);
    f.observe({ ...o, levels: { Woodcutting: 60, Hitpoints: 10 } }, 1000);
    expect(f.events).toEqual([]);
});
