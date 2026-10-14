// Compose the share card from a real game screenshot. Optional input: path to a screenshot.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    let background: string;
    if (process.argv[2]) background = readFileSync(process.argv[2]).toString('base64');
    else {
        await page.goto('https://live.soko.tools/?clean=1&follow=Voltbot', { waitUntil: 'networkidle0' });
        await page.waitForSelector('.tv-caption');
        await new Promise(r => setTimeout(r, 3000));
        await page.addStyleTag({ content: '.tv-caption,.tv-top{display:none!important}' });
        background = Buffer.from(await page.screenshot()).toString('base64');
    }
    await page.setContent(`<!DOCTYPE html><html><head><style>
        *{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#f4f6ed;background:#101812}.world{position:absolute;inset:0;background:url(data:image/png;base64,${background}) center/cover;filter:saturate(.85)}.shade{position:absolute;inset:0;background:linear-gradient(90deg,#0b130cf5 0%,#0b130ce3 32%,#0b130c65 72%,#0b130c30),linear-gradient(0deg,#0b130cf0,transparent 45%)}.border{position:absolute;inset:20px;border:1px solid #d5ff7038;border-radius:12px}.brand{position:absolute;left:64px;top:58px;font-size:27px;font-weight:900;letter-spacing:1px}.brand b{background:#d5ff70;color:#16220d;border-radius:4px;margin-left:7px;padding:4px 8px;font-size:23px}.live{position:absolute;right:64px;top:61px;color:#d5ff70;font-size:13px;font-weight:700;letter-spacing:2px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d5ff70;margin-right:9px}h1{position:absolute;left:62px;top:158px;font-size:72px;line-height:1.02;letter-spacing:-3px;font-weight:900;margin:0}h1 span{color:#d5ff70}.desc{position:absolute;left:65px;top:345px;max-width:510px;color:#c3cdbb;font-size:21px;line-height:1.5}.chips{position:absolute;left:64px;bottom:87px;display:flex;gap:10px}.chips span{border:1px solid #cdd9c138;border-radius:30px;padding:10px 16px;font-size:12px;color:#dce5d5;background:#172111b0}.url{position:absolute;left:65px;bottom:45px;color:#d5ff70;font-size:15px;letter-spacing:.5px}.foot{position:absolute;right:64px;bottom:45px;color:#bac9ad;font-size:11px;letter-spacing:2px}
    </style></head><body><div class="world"></div><div class="shade"></div><div class="border"></div><div class="brand">RS-SDK <b>TV</b></div><div class="live"><span class="dot"></span>LIVE FROM GIELINOR</div><h1>THE WHOLE SERVER.<br/><span>ONE LIVE CAMERA.</span></h1><div class="desc">Watch the battles. Follow the players.<br/>See what happens next.</div><div class="chips"><span>LIVE WORLD</span><span>PLAYER RANKINGS</span><span>VIEWER CHAT</span></div><div class="url">live.soko.tools ↗</div><div class="foot">GIELINOR, AS IT HAPPENS.</div></body></html>`);
    await page.screenshot({ path: join(import.meta.dir, '../tv/public/og-tv.jpg'), type: 'jpeg', quality: 92 });
} finally { await browser.close(); }
