import { afterAll, describe, expect, test } from 'bun:test';
import { skillBoard, valueBoard, profile } from './test-fixtures/tv-hiscores';
import { Director } from './tv/director';
import { regionFor, SceneSnapshot } from './tv/relay';

describe('TV director', () => {
    test('favors real event locations, holds a shot, rotates, and releases logged-out players', () => {
        const d = new Director();
        d.roster([[1,'Duelist',3360,3250,0,100],[2,'Farmer',3200,3200,0,100]], 1_000_000);
        expect(d.shot?.follow).toBe('Duelist');
        d.roster([[1,'Duelist',3361,3251,0,100],[2,'Farmer',3200,3200,0,100]], 1_010_000);
        expect(d.shot?.x).toBe(3361);
        expect(d.shot?.since).toBe(1_000_000);
        d.choose(1_040_000);
        expect(d.shot?.follow).toBe('Farmer');
        d.roster([[1,'Duelist',3361,3251,0,100]], 1_041_000);
        expect(d.shot?.follow).toBe('Duelist');
        d.roster([], 1_042_000); expect(d.shot).toBeNull();
    });
    test('combat is observed, then expires instead of being labeled live forever', () => {
        const d = new Director();
        d.roster([[1,'Fighter',3000,3000,0,80]], 1_000_000);
        d.activity([{i:1,hm:[[12,1]]}], 1_000_001);
        expect(d.candidates(1_000_002)[0]?.reason).toContain('Live combat');
        expect(d.candidates(1_040_000)[0]?.reason).not.toContain('combat');
    });
});

describe('TV scene relay', () => {
    test('shares nearby cameras and rejects invalid subscriptions', () => {
        expect(regionFor({x:3200,z:3200,w:128,h:128})?.key).toBe(regionFor({x:3201,z:3201,w:128,h:128})?.key);
        for (const w of [NaN,Infinity,-1,0,385]) expect(regionFor({x:0,z:0,w,h:1})).toBeNull();
    });
    test('late join snapshots retain appearance and movement, without replaying old events', () => {
        const s = new SceneSnapshot();
        s.apply({t:'hello',v:1});
        s.apply({t:'tick',k:1,ms:300,p:[{i:7,f:1,x:10,z:20,l:0,ap:'body',ch:'old chat',hm:[[2,1]],an:[3,0]}]});
        s.apply({t:'tick',k:2,ms:300,p:[{i:7,x:11,z:21,m:[1]}]});
        expect(s.frames().at(-1)).toMatchObject({reset:1,k:2,p:[{i:7,f:1,x:11,z:21,ap:'body'}]});
        expect(s.players.get(7).hm).toBeUndefined(); expect(s.players.get(7).ch).toBeUndefined(); expect(s.players.get(7).an).toBeUndefined();
        s.apply({t:'tick',k:3,ms:300,rp:[7]}); expect(s.players.size).toBe(0);
        s.apply({t:'tick',k:4,ms:300,n:[{i:1,f:1,t:2,x:3,z:4}]});
        s.apply({t:'tick',k:5,ms:300,reset:1}); expect(s.npcs.size).toBe(0);
    });
});

// Exercise the real server against a local feed; never touch an account or production.
const feed = Bun.serve({port:0,hostname:'127.0.0.1',fetch(req,srv){ const p=new URL(req.url).pathname;if(p.startsWith('/hiscores'))return new Response(p.includes('/player/')?profile:p.endsWith('/bank')||p.endsWith('/outfit')?valueBoard:skillBoard);return srv.upgrade(req) ? undefined : new Response('no'); },websocket:{open(ws){ws.send(JSON.stringify({t:'hello',v:1,rev:289,tick:1,tickMs:300,players:1}));},message(ws,raw){const m=JSON.parse(String(raw));if(m.t==='roster')ws.send(JSON.stringify({t:'roster',k:1,p:[[1,'Public Hero',3222,3218,0,50]],npcs:1}));if(m.t==='sub')ws.send(JSON.stringify({t:'tick',k:2,ms:300,p:[{i:1,f:1,x:3222,z:3218,l:0,ap:'body'}]}));}}});
const proc = Bun.spawn([process.execPath,'app/tv-server.ts'],{env:{...process.env,PORT:'0',TV_CHAT_DB:':memory:',TV_HISCORES_ORIGIN:`http://127.0.0.1:${feed.port}`,TV_WORLD_FEED:`ws://127.0.0.1:${feed.port}`},stdout:'pipe',stderr:'pipe'});
const reader=proc.stdout.getReader();
let serverUrl='';
for(let i=0;i<20 && !serverUrl;i++){const {value,done}=await reader.read();if(done)break;serverUrl=/listening on (http:\/\/[^\s]+)/.exec(new TextDecoder().decode(value))?.[1]??'';}
afterAll(async()=>{proc.kill();await proc.exited;feed.stop(true);});
test('public TV health, safe routes, and shared live scene snapshots',async()=>{
    expect(serverUrl).not.toBe('');
    const health=await (await fetch(serverUrl+'api/tv')).json();expect(health).toHaveProperty('players');expect(JSON.stringify(health)).not.toContain('password');
    expect((await fetch(serverUrl+'api/accounts')).status).toBe(404);
    const a = new WebSocket(serverUrl.replace('http:','ws:')+'worldfeed');
    const b = new WebSocket(serverUrl.replace('http:','ws:')+'worldfeed');
    const collect=(ws:WebSocket)=>new Promise<any[]>((resolve,reject)=>{const frames:any[]=[];const timer=setTimeout(()=>reject(new Error('snapshot timeout')),4000);ws.onopen=()=>ws.send(JSON.stringify({t:'sub',x:3200,z:3200,w:128,h:128}));ws.onmessage=e=>{const m=JSON.parse(String(e.data));frames.push(m);if(m.t==='tick' && m.p?.length){clearTimeout(timer);resolve(frames);}};});
    try { const result = await Promise.all([collect(a),collect(b)]); expect(result.every(frames=>frames.some(f=>f.p?.[0]?.ap==='body'))).toBe(true); const info=await(await fetch(serverUrl+'health')).json();expect(info.upstreamConnections).toBe(4);expect(info.viewers).toBe(2); }
    finally {a.close();b.close();}
},8000);

test('TV rankings and player routes use public scores and live online names',async()=>{
    const result=await(await fetch(serverUrl+'api/rankings?category=bank&online=1')).json();
    expect(result.entries[0]).toMatchObject({value:1234567,followName:'Public Hero',online:true});
    expect((await fetch(serverUrl+'api/rankings?category=bad')).status).toBe(400);
    expect((await fetch(serverUrl+'api/player?name=bad!')).status).toBe(400);
    const player=await(await fetch(serverUrl+'api/player?name=Public%20Hero')).json();expect(player.skills[1].level).toBe(99);expect(player.bank.entry.value).toBe(1234567);
});
test('anonymous chat broadcasts to two viewers and supplies history on reconnect',async()=>{
    const connect=()=>new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(serverUrl.replace('http:','ws:')+'chat');ws.onmessage=e=>{if(JSON.parse(String(e.data)).type==='history')resolve(ws);};ws.onerror=()=>reject(new Error('chat connection failed'));});
    const a=await connect(),b=await connect();
    try{
        const received=new Promise<any>(resolve=>{b.onmessage=e=>resolve(JSON.parse(String(e.data)));});
        a.send(JSON.stringify({name:'Test viewer',text:'Local test message'}));
        expect((await received).message).toMatchObject({name:'Test viewer',text:'Local test message'});
        const c=new WebSocket(serverUrl.replace('http:','ws:')+'chat');
        const history=await new Promise<any>(resolve=>{c.onmessage=e=>resolve(JSON.parse(String(e.data)));});expect(history.messages.at(-1).text).toBe('Local test message');c.close();
    }finally{a.close();b.close();}
},5000);
