// fresh-reload.ts - reload one managed client with a cleared HTTP cache. With --local, the page's bot client bundle
// (/bot/client.js) is served from this checkout's server/webclient/out/bot/client.js instead of the game host, so
// webclient patches (e.g. interface inventories + OPHELD for puzzle boxes, 30c2aaeaa) reach a managed client whose
// page is loaded from a remote host. Same revision guard as the dashboard (local-bundle.ts): a build whose client
// revision differs from the host's is not served. The dashboard itself now serves the local bundle on every managed
// page load (LOCAL_BOT_BUNDLE, default on), so a plain reload is normally enough; --local only matters with it off.
// Usage: bun tools/dashboard/fresh-reload.ts <account> [--local]
import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LocalBundle } from './local-bundle';

const acct = process.argv[2];
const LOCAL = process.argv.includes('--local');
if (!acct) { console.error('usage: bun tools/dashboard/fresh-reload.ts <account> [--local]'); process.exit(2); }
const ROOT = join(import.meta.dir, '../..');
const saved = JSON.parse(readFileSync(join(ROOT, 'telemetry/managed-chrome', `${acct}.json`), 'utf8'));
const browser = await puppeteer.connect({ browserWSEndpoint: saved.wsEndpoint, defaultViewport: null });
const pages = (await browser.pages()).filter(p => /\/bot\b/.test(p.url()));
let bundle: Buffer | null = null;
if (LOCAL && pages.length) {
    const d = await new LocalBundle().decide(new URL(pages[0].url()).origin);
    if (d.serve) bundle = Buffer.from(d.base64, 'base64');
    else console.error(`WARNING --local ignored: ${d.reason}`);
}
if (!pages.length) { console.error(`${acct}: no game page found`); browser.disconnect(); process.exit(1); }
for (const page of pages) {
    const c = await page.createCDPSession();
    await c.send('Network.clearBrowserCache');
    let served = 0;
    if (bundle) {
        await c.send('Fetch.enable', { patterns: [{ urlPattern: '*/bot/client.js*', requestStage: 'Request' }] });
        c.on('Fetch.requestPaused', async (e: any) => {
            served++;
            await c.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Cache-Control', value: 'no-store' }],
                body: bundle.toString('base64') }).catch(() => {});
        });
    }
    await page.reload({ waitUntil: 'load', timeout: 90_000 });
    if (bundle) { await new Promise(r => setTimeout(r, 3000)); await c.send('Fetch.disable').catch(() => {}); }
    await c.detach().catch(() => {});
    console.log(`${acct}: reloaded ${page.url().replace(/password=[^&]*/, 'password=***')} (cache cleared${bundle ? `, local bundle served ${served}x` : ''})`);
}
browser.disconnect();
