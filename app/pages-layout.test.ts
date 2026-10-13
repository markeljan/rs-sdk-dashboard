import { afterAll, beforeAll, expect, test } from 'bun:test';
import puppeteer, { type Browser } from 'puppeteer';

// Real onboarding and account pages, synthetic HTTP responses; mutations are rejected.
const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    if (req.method !== 'GET') return new Response('read-only fixture', { status: 405 });
    if (p === '/_rsd/api/me') return Response.json({ mode: 'hosted', needsLogin: url.searchParams.has('login'), signups: true,
        origin: 'https://dashboard.example.test', defaultServer: 'rs-sdk-demo.fly.dev', version: 'test', user: { email: 'test@example.test', limits: { accounts: 100, clients: 30 } } });
    if (p === '/_rsd/api/accounts') return Response.json({ accounts: [{ name: 'testmain', server: 'https://' + 'long-hostname.'.repeat(8) + 'example.test', runClient: true, source: 'ui' }] });
    if (p === '/_rsd/api/token') return Response.json({ token: 'synthetic-test-token' });
    if (p === '/_rsd/api/tokens') return Response.json({ tokens: [] });
    if (p === '/_rsd/api/skill') return new Response('Synthetic agent setup instructions');
    if (p.startsWith('/_rsd/api/')) return Response.json(null);
    if (p === '/_rsd/manage.js') return new Response(Bun.file(new URL('./pages/manage.js', import.meta.url)), { headers: { 'content-type': 'application/javascript' } });
    if (p === '/') return new Response(Bun.file(new URL('./pages/landing.html', import.meta.url)));
    if (p.startsWith('/_rsd/')) return new Response(Bun.file(new URL('./pages/manage.html', import.meta.url)));
    return new Response('', { status: 404 });
} });
let browser: Browser;
beforeAll(async () => { browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); });
afterAll(async () => { await browser?.close(); server.stop(true); });
for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932], [844, 390], [768, 1024], [1440, 900]]) {
    for (const route of ['/', '/_rsd/manage', '/_rsd/login']) {
        test(`front page ${route} ${w}×${h} fits viewport`, async () => {
            const page = await browser.newPage();
            const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)));
            await page.setViewport({ width: w!, height: h!, isMobile: w! < 1000, hasTouch: w! < 1000 });
            if (route.includes('login')) {
                await page.setRequestInterception(true);
                page.on('request', req => { if (req.url().includes('/api/me')) void req.continue({ url: req.url() + '?login=1' }); else void req.continue(); });
            }
            await page.goto(`http://localhost:${server.port}${route}`);
            await page.waitForSelector(route === '/' ? '.hero' : route.includes('login') ? '#f' : '.acct');
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            if (route.includes('manage')) {
                expect(await page.$eval('.acct', e => { const r = e.getBoundingClientRect(); return Array.from(e.querySelectorAll('button')).every(b => {
                    const s = b.getBoundingClientRect(); return s.left >= r.left && s.right <= r.right + 1;
                }); })).toBe(true);
            }
            expect(errors).toEqual([]);
            await page.close();
        }, 15000);
    }
}
