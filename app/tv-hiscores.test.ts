import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoard, parseProfile, joinOnline, PublicHiscores } from './tv/hiscores';
import { PublicChat, validateChat } from './tv/chat';
import { skillBoard, valueBoard, profile } from './test-fixtures/tv-hiscores';

test('public parsers preserve exact bank totals, ranks, items, time and missing scores', () => {
    expect(parseBoard(skillBoard)[0]).toMatchObject({ name: 'Public_Hero', value:1881, rank:1, time:'47h 54m' });
    expect(parseBoard(valueBoard,true)[0]).toMatchObject({value:1234567,items:[{name:'Air rune 2K',value:234567},{name:'Coins',value:1000000}]});
    expect(parseProfile(profile)).toHaveLength(3);
    expect(parseProfile(profile)[2]).toMatchObject({level:null,rank:null});
    expect(() => parseBoard('<html>server error</html>')).toThrow();
});
test('online joins normalize display names, preserve official ranks, and disable stale joins', () => {
    const scores=parseBoard(skillBoard), players: [number,string,number,number,number,number][]=[[1,'Public Hero',3200,3200,0,126]];
    expect(joinOnline(scores,players,true)[0]).toMatchObject({rank:1,online:true,followName:'Public Hero'});
    expect(joinOnline(scores,players,true)[1]?.online).toBe(false);
    expect(joinOnline(scores,players,false)[0]).toMatchObject({online:null,followName:null});
});
test('public hiscores deduplicate fetches, cache, and retain labeled snapshots after failures',async()=>{
    let now=1000000,calls=0,fail=false;
    const request=(async()=>{calls++;if(fail)throw new Error('upstream offline');await Promise.resolve();return new Response(skillBoard);});
    const source=new PublicHiscores('https://example.test',request,()=>now);
    const [a,b]=await Promise.all([source.board('overall'),source.board('overall')]);expect(calls).toBe(1);expect(a.fetchedAt).toBe(b.fetchedAt);
    await source.board('overall');expect(calls).toBe(1);
    now+=300001;fail=true;const saved=await source.board('overall');expect(saved.stale).toBe(true);expect(saved.fetchedAt).toBe(1000000);
    await source.board('overall');expect(calls).toBe(2);
    await expect(source.board('not-a-category')).rejects.toThrow('Unknown');
});
test('public player details combine skills with published items, never invent a bank balance',async()=>{
    const request=(async(url:string|URL|Request)=>new Response(String(url).includes('/player/')?profile:valueBoard));
    const source=new PublicHiscores('https://example.test',request);
    const found=await source.profile('Public Hero');expect(found.bank.entry?.value).toBe(1234567);expect(found.skills[1]?.level).toBe(99);
    const unknown=await source.profile('Other');expect(unknown.bank.entry).toBeNull();
});
test('anonymous chat validates input, limits bursts, and survives service restarts',()=>{
    const dir=mkdtempSync(join(tmpdir(),'rs-tv-chat-')),path=join(dir,'chat.sqlite');
    try{
        const chat=new PublicChat(path);
        expect(validateChat({name:'Guest',text:'<b>plain text</b>'})?.text).toBe('<b>plain text</b>');
        expect(validateChat({name:'bad<script>',text:'hello'})).toBeNull();expect(validateChat({name:'Guest',text:'x'.repeat(401)})).toBeNull();
        for(let i=0;i<5;i++)expect(typeof chat.post('ip',{name:'Viewer',text:`message ${i}`},1000)).toBe('object');
        expect(typeof chat.post('ip',{name:'Viewer',text:'too fast'},1001)).toBe('string');chat.close();
        const next=new PublicChat(path);expect(next.history()).toHaveLength(5);expect(next.history()[0]?.name).toBe('Viewer');next.close();
    }finally{rmSync(dir,{recursive:true,force:true});}
});
