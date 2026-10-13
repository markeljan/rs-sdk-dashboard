import { afterAll, beforeAll, expect, test } from 'bun:test';
import puppeteer, { type Browser, type Page } from 'puppeteer';

// No gateway, observers, game clients or bot controls: exercise the real page against fixture HTTP data.
const current = 'accept-queue (agent) · fgmain: F G MAIN E ring RoW kills 0 (0/h) | loot 0k = 0k gp/h | ' +
    'Att 99 (0k/h) Str 99 (0k/h) Def 99 (0k/h) Hit 99 (0k/h) Pra 99 (0k/h) | '.repeat(6) + 'resets 0 |';
const accounts = Array.from({ length: 89 }, (_, i) => ({ name: i ? `testbot${i}` : 'testmain', lite: i > 6,
    live: true, totalLevel: 1881, questPoints: 100, activity: current, bank: { total: 1234567, coins: 12345, at: Date.now() } }));
const state = { now: Date.now(), account: { name: 'testmain', client: 'managed', lite: false }, accounts,
    bot: 'testmain', player: 'Test main', conn: { fresh: true }, character: null,
    totals: { level: 1881, maxed: 19, rate60: 0 }, skills: [],
    automation: { paused: false, takeover: false, procs: [], runningWhilePaused: 0 },
    stream: { client: 'managed', managed: { state: 'running' } },
    activity: { current, goal: 'A goal with a long unbroken suffix ' + 'x'.repeat(200), log: { file: 'fgmain.log', mtime: Date.now(), lines: Array(30).fill(current) } },
};
const server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/') {
        let html = await Bun.file(new URL('./public/index.html', import.meta.url)).text();
        if (new URL(req.url).searchParams.has('safe')) {
            html = html.replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, 'var(--safe-$1)')
                .replace('</style>', ':root { --safe-top: 47px; --safe-bottom: 34px; --safe-left: 0px; --safe-right: 0px; } @media (orientation: landscape) { :root { --safe-top: 0px; --safe-bottom: 21px; --safe-left: 44px; --safe-right: 44px; } }</style>');
        }
        return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    if (path === '/api/state') return Response.json(state);
    if (path === '/api/hq') return Response.json({ accounts, events: [] });
    if (path === '/api/chat') return Response.json({ messages: [] });
    if (path.startsWith('/api/')) return Response.json([]);
    return new Response('', { status: 404 });
} });
let browser: Browser;
beforeAll(async () => { browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); });
afterAll(async () => { await browser?.close(); server.stop(true); });

async function open(width: number, height: number, touch = true, dynamic = true, native = false, safe = false) {
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    await page.setViewport({ width, height, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument((dynamic, native) => {
        localStorage.setItem('dash.betaFs', dynamic ? '1' : '0');
        if (!native) Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined, configurable: true });
    }, dynamic, native);
    const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://localhost:${server.port}/?account=testmain${safe ? "&safe=1" : ""}`);
    await page.waitForFunction(() => document.querySelector('#curTask')?.textContent?.includes('accept-queue'));
    await page.waitForFunction(() => !document.body.classList.contains('mobile') || !matchMedia('(orientation: landscape)').matches || document.body.classList.contains('fs'));
    expect(errors).toEqual([]);
    return page;
}
async function geometry(page: Page) {
    return page.evaluate(() => {
        const box = (selector: string) => { const e = document.querySelector(selector)!; const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; };
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
            bar: box('#acctBar'), pill: box('#acctBar .acct'), second: box('#acctBar .acct .ast'),
            cur: box('#curTask'), card: box('#cardActivity'), stage: box('#stage'), controls: box('.controls'),
            scrollHeight: document.documentElement.scrollHeight };
    });
}
for (const [w, h] of [[320, 568], [360, 640], [375, 667], [390, 844], [430, 932], [768, 1024], [667, 375], [844, 390], [1024, 768]]) {
    test(`mobile website ${w}×${h}: account stats and controls fit; activity is compact`, async () => {
        const page = await open(w!, h!);
        if (w! > h!) { await page.waitForFunction(() => document.body.classList.contains('fs')); await page.click('#fsMore'); await page.waitForSelector('#moreSheet[open]', {timeout: 3000}); await page.click('#sheetExit'); }
        const g = await geometry(page);
        expect(g.scrollWidth).toBeLessThanOrEqual(g.width);
        expect(g.second.bottom).toBeLessThanOrEqual(g.pill.bottom);
        expect(g.pill.bottom).toBeLessThanOrEqual(g.bar.bottom);
        expect(g.cur.h).toBeLessThanOrEqual(38);
        expect(g.card.w).toBeGreaterThan(w! > h! ? 220 : w! - 40);
        await page.click('#activityDetails summary');
        expect(await page.$eval('#activityFull', e => e.textContent)).toContain('resets 0');
        expect(await page.$eval('#logLines', e => e.scrollHeight > e.clientHeight)).toBe(true);
        await page.$eval('#btnMore2', e => e.scrollIntoView({ block: 'center' }));
        await page.click('#btnMore2');
        await page.waitForSelector('#moreSheet[open]', { timeout: 3000 });
        expect(await page.$eval('#moreSheet .in', e => e.scrollWidth <= e.clientWidth)).toBe(true);
        await page.click('#btnMoreClose');
        await page.close();
    }, 15000);
}
for (const dynamic of [false, true]) for (const [w, h] of [[320, 568], [390, 664], [390, 844], [430, 932], [667, 375], [844, 390], [932, 430], [768, 1024], [1024, 768], [1440, 900]]) {
    test(`${dynamic ? 'dynamic' : 'regular'} fullscreen ${w}×${h}: regions and controls stay in bounds`, async () => {
        const touch = w! < 1400, page = await open(w!, h!, touch, dynamic);
        if (w! <= h! || !touch) await page.click(touch ? '#btnFs2' : '#btnFs');
        await page.waitForFunction(() => document.body.classList.contains('fs'));
        await page.waitForFunction(() => document.getElementById('stage')!.clientHeight === innerHeight);
        const invalid = await page.evaluate(() => {
            const st = document.getElementById('stage')!.getBoundingClientRect();
            return [...document.querySelectorAll('.region, .fsside .btn, .fspad, .fsacct')].filter(e => {
                const r = e.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(e).display === 'none') return false;
                return r.left < st.left - 1 || r.top < st.top - 1 || r.right > st.right + 1 || r.bottom > st.bottom + 1;
            }).map(e => e.className + ':' + (e as HTMLElement).dataset.region);
        });
        expect(invalid).toEqual([]);
        if (dynamic && touch) expect(await page.$eval('.fsacct', e => {
            if ((e as HTMLElement).hidden) return true;
            const r = e.getBoundingClientRect(), p = document.querySelector('.fspad')!.getBoundingClientRect();
            return r.bottom <= p.top + 1 || r.right <= p.left || r.left >= p.right;
        })).toBe(true);
        // Browser chrome expanding/collapsing: the same page must relayout without a reload.
        await page.setViewport({ width: w!, height: h! - 70, isMobile: touch, hasTouch: touch });
        await page.waitForFunction(() => document.getElementById('stage')!.clientHeight === innerHeight);
        expect((await geometry(page)).stage.h).toBe(h! - 70);
        await page.waitForFunction(() => Array.from(document.querySelectorAll('.region, .fsside .btn, .fspad, .fsacct')).every(e => {
            const r = e.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(e).display === 'none') return true;
            return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        }));
        await page.close();
    }, 15000);
}
for (const [w, h] of [[900, 520], [1280, 720], [1440, 900], [1920, 1080]]) {
    test(`desktop ${w}×${h}: no page overflow, bounded side panel`, async () => {
        const page = await open(w!, h!, false);
        const g = await geometry(page);
        expect(g.scrollWidth).toBe(g.width);
        expect(g.scrollHeight).toBe(g.height);
        expect(g.card.bottom).toBeLessThanOrEqual(g.height);
        expect(g.stage.right).toBeLessThanOrEqual(g.card.x);
        await page.close();
    }, 15000);
}
test('native fullscreen enters and exits through the actual API', async () => {
    const page = await open(1280, 720, false, false, true);
    await page.click('#btnFs');
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.click('#fsExit');
    await page.waitForFunction(() => !document.fullscreenElement && !document.body.classList.contains('fs'));
    await page.close();
}, 15000);

for (const [w, h] of [[390, 844], [844, 390], [430, 932]]) {
    test(`standalone safe areas ${w}×${h}: controls fit outside notch and home indicator`, async () => {
        const page = await open(w!, h!, true, true, false, true);
        const cdp = await page.createCDPSession();
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
        if (w! <= h!) {
            const g = await geometry(page);
            expect(g.pill.y).toBeGreaterThanOrEqual(47);
            expect(g.second.bottom).toBeLessThanOrEqual(g.bar.bottom);
            await page.click('#btnFs2');
        }
        await page.waitForFunction(() => document.body.classList.contains('fs'));
        expect(await page.evaluate(() => {
            const stage = document.getElementById('stage')!.getBoundingClientRect();
            return [...document.querySelectorAll('.fsside .btn, .fspad')].every(e => {
                const r = e.getBoundingClientRect(); if (!r.width || !r.height) return true;
                return r.top >= stage.top && r.bottom <= stage.bottom - (innerWidth > innerHeight ? 21 : 34) + 1;
            });
        })).toBe(true);
        await page.close();
    }, 15000);
}

for (const [w, h] of [[320, 568], [390, 844], [768, 1024], [1280, 720]]) {
    test(`Bot HQ ${w}×${h}: fleet rows scroll within a bounded card`, async () => {
        const page = await open(w!, h!, w! < 1000);
        await page.click('[data-acct="@hq"]');
        await page.waitForFunction(() => document.querySelectorAll('#hqRows .hqrow').length === 89);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.$eval('#hqRows', e => e.scrollHeight > e.clientHeight)).toBe(true);
        expect(await page.$eval('#cardHqList', e => e.getBoundingClientRect().height < innerHeight)).toBe(true);
        await page.close();
    }, 15000);
}
