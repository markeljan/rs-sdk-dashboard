// Run against a running TV server. Production verification never posts chat messages.
import assert from 'node:assert/strict';
import puppeteer, { KnownDevices } from 'puppeteer';
const base=process.env.TV_URL??'http://127.0.0.1:4750';const local=base.includes('127.0.0.1');
const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
const page=await browser.newPage();await page.setViewport({width:1440,height:900});const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
async function click(label:string){assert(await page.evaluate(label=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);b?.click();return!!b;},label));}
const html=await(await fetch(base)).text();assert(html.includes('summary_large_image'));assert(html.includes('https://live.soko.tools/og-tv.jpg'));
await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForSelector('.tv-tabs');await click('Rankings');await page.waitForSelector('.tv-ranking-list .tv-rank-row',{timeout:30000});
await click('Equipment');await page.waitForFunction(()=>document.querySelector('.tv-ranking-list .tv-source-link')?.getAttribute('href')?.includes('/outfit'),{timeout:30000});
assert.equal(await page.$eval('button[aria-label="Rank by Equipment"]',e=>e.getAttribute('aria-pressed')),'true');
await page.select('select[aria-label="Other rankings"]','quests');await page.waitForFunction(()=>document.querySelector('.tv-ranking-list .tv-source-link')?.getAttribute('href')?.includes('category=100'),{timeout:30000});
await click('Overall');await page.waitForFunction(()=>document.querySelector('.tv-ranking-list .tv-source-link')?.getAttribute('href')?.includes('category=0'),{timeout:30000});
await click('Bank');await page.waitForFunction(()=>document.querySelector('.tv-rank-row small')?.textContent?.includes('GP'),{timeout:30000});
assert.equal(await page.$eval('button[aria-label="Rank by Bank"]',e=>e.getAttribute('aria-pressed')),'true');
await page.waitForFunction(()=>[...document.querySelectorAll('.tv-ranking-shortcuts img')].every(e=>(e as HTMLImageElement).naturalWidth>0));
assert(await page.$$eval('select[aria-label="Other rankings"] option',es=>!es.some(e=>['overall','bank','equipment'].includes((e as HTMLOptionElement).value))));
console.log('BANK',await page.$eval('.tv-rank-row',e=>e.textContent));await page.screenshot({path:'/tmp/rs-tv-rankings.png'});
await page.click('.tv-watch:not([disabled])');await page.waitForSelector('.tv-stat-summary',{timeout:30000});assert.equal(await page.$$eval('.tv-skill-grid>div',e=>e.length),19);console.log('PLAYER',await page.$eval('.tv-player-details',e=>e.textContent?.slice(0,400)));await page.screenshot({path:'/tmp/rs-tv-player.png'});
await page.waitForSelector('.tv-chat-heading .connected');
assert(await page.evaluate(()=>!document.querySelector('.tv-panel .tv-chat-dock') && !!document.querySelector('.tv-chat-dock')), 'Chat stays outside explorer');
await page.$eval('.tv-chat-dock',e=>(e as HTMLElement).dataset.testIdentity='persistent');await click('Cinema');assert(await page.evaluate(()=>document.querySelector<HTMLElement>('.tv-chat-dock')?.dataset.testIdentity==='persistent'&&!document.querySelector('.tv-panel')),'Cinema keeps the same live chat mounted');await click('Show controls');

await page.$eval('input[aria-label="Chat nickname"]',(e)=>{const input=e as HTMLInputElement;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;setter.call(input,'Local viewer');input.dispatchEvent(new Event('input',{bubbles:true}));});
if(local){const ws=new WebSocket('ws://127.0.0.1:4750/chat');await new Promise<void>(resolve=>{ws.onmessage=()=>resolve();});const received=new Promise<void>(resolve=>{ws.onmessage=e=>{if(JSON.parse(String(e.data)).message?.text==='Local browser acceptance check')resolve();};});await page.type('input[aria-label="Chat message"]','Local browser acceptance check');await page.$eval('.tv-chat form',(e)=>(e as HTMLFormElement).requestSubmit());await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(new Error('chat delivery timeout')),5000))]);ws.close();console.log('CHAT delivered from browser to second anonymous connection');}
await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.tv-tabs');assert.equal(await page.evaluate(()=>localStorage.getItem('rs-tv.nickname')),'Local viewer');await page.waitForSelector('.tv-chat-dock');await page.screenshot({path:'/tmp/rs-tv-chat.png'});
await page.setViewport({width:390,height:844});await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.tv-panel');assert(await page.evaluate(()=>{const r=document.querySelector('.tv-chat-dock')!.getBoundingClientRect();return r.left>=0&&r.bottom<=innerHeight&&r.top>innerHeight/2;}),'Mobile chat stays bottom left');await page.click('.tv-panel-heading');await click('Rankings');await page.waitForSelector('.tv-ranking-list .tv-rank-row',{timeout:30000});assert(await page.evaluate(()=>document.documentElement.scrollWidth===window.innerWidth));await page.screenshot({path:'/tmp/rs-tv-rankings-mobile.png'});
for(const device of ['iPhone 13','iPhone 13 landscape'] as const){
    await page.emulate(KnownDevices[device]);await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForSelector('.tv-chat-dock');await page.waitForSelector('.joystick-container');
    assert(await page.evaluate(()=>{const chat=document.querySelector('.tv-chat-dock')!.getBoundingClientRect();return [...document.querySelectorAll('.joystick-container')].every(e=>{const r=e.getBoundingClientRect();return r.bottom<=chat.top||r.right<=chat.left||r.left>=chat.right;});}), `${device}: camera joysticks stay clear of chat`);
}
assert.deepEqual(errors,[]);console.log('PASS: server share metadata, bank rankings, online watch, 19 skills, published items, persistent bottom-left chat, icon rankings, nickname, mobile and no page errors');
}finally{await browser.close();}
