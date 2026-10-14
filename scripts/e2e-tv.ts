// Verify a running TV site, including real changing world ticks. No account control.
// TV_URL=https://live.soko.tools bun scripts/e2e-tv.ts
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const url = process.env.TV_URL ?? 'http://127.0.0.1:4750';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const errors: string[] = [], ticks = new Set<number>(), positions = new Set<string>();
    page.on('pageerror', e => errors.push(String(e)));
    page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    const cdp = await page.createCDPSession(); await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameReceived', e => {
        try { const m = JSON.parse(e.response.payloadData); if (m.t === 'tick') { ticks.add(m.k); for (const p of m.p ?? []) if (p.x !== undefined) positions.add(`${p.i}:${p.x}:${p.z}`); } } catch { /* non-JSON frame */ }
    });
    const click = async (label: string) => {
        assert(await page.evaluate(label => {
            const b = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.querySelector('strong')?.textContent === label);
            b?.click(); return !!b;
        }, label), `Missing button: ${label}`);
    };
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForSelector('.tv-panel', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('.tv-signal')?.textContent?.includes('LIVE'), { timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));
    assert(await page.evaluate(() => [...document.querySelectorAll('canvas')].every(c => c.width === 1440 && c.height === 900)), '3D and overlay canvases fill the viewport');
    await page.screenshot({ path: '/tmp/rs-tv-desktop.png' });
    await click('Players'); await page.type('.tv-search', 'Voltbot');
    await page.waitForSelector('.tv-player'); await page.click('.tv-player');
    await page.waitForFunction(() => document.querySelector('.tv-eyebrow')?.textContent === 'FOLLOWING');
    assert.equal(await page.$eval('h1', e => e.textContent), 'Voltbot');
    await click('Places'); await click('Duel Arena');
    await page.waitForFunction(() => document.querySelector('.tv-eyebrow')?.textContent === 'FREE CAMERA');
    assert.equal(await page.$eval('h1', e => e.textContent), 'Duel Arena');
    await click('Castle Wars');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Castle Wars');
    await click('Map'); await page.waitForSelector('.worldmap-modal');
    const map = await page.$('.worldmap-modal'); const rect = await map!.boundingBox();
    assert(rect, 'World map opened');
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { clickCount: 2 });
    await page.waitForFunction(() => !document.querySelector('.worldmap-modal'));
    assert.equal(await page.$eval('.tv-eyebrow', e => e.textContent), 'FREE CAMERA');
    await click('◉ Auto TV'); await page.waitForFunction(() => document.querySelector('.tv-eyebrow')?.textContent === 'AUTO DIRECTOR');
    // Moving the camera must leave auto; the director must not take it back.
    await page.mouse.click(600, 450); await page.keyboard.down('w');
    await new Promise(r => setTimeout(r, 200)); await page.keyboard.up('w');
    await page.waitForFunction(() => document.querySelector('.tv-eyebrow')?.textContent === 'FREE CAMERA');
    await click('◉ Auto TV');
    await click('Cinema'); assert.equal(await page.$('.tv-panel'), null);
    await page.screenshot({ path: '/tmp/rs-tv-cinema.png' }); await click('Show controls');
    assert(ticks.size >= 3 && positions.size >= 3, 'World data changes across real ticks');
    assert.deepEqual(errors, [], 'No page or HTTP errors');
    console.log(`Desktop passed: ${ticks.size} ticks, ${positions.size} entity positions; follow, places, map, camera, cinema.`);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.tv-panel');
    assert(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth), 'Mobile page fits viewport');
    await page.screenshot({ path: '/tmp/rs-tv-mobile.png' });
    await page.click('.tv-panel-heading');
    await click('Players'); await page.type('.tv-search', 'Voltbot'); await page.waitForSelector('.tv-player');
    assert(await page.evaluate(() => document.querySelector('.tv-panel')!.getBoundingClientRect().bottom <= window.innerHeight), 'Expanded mobile panel fits viewport');
    await page.screenshot({ path: '/tmp/rs-tv-mobile-expanded.png' });
    console.log('Mobile page fits 390×844.');
} finally { await browser.close(); }
