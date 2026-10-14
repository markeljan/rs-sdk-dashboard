// Export authentic ranking icons from the game's public sprites/cache. No account connection.
import '../server/webclient/src/lite/dom-shim.ts';
import JagFile from '../server/webclient/src/io/JagFile.ts';
import Pix8 from '../server/webclient/src/graphics/Pix8.ts';
import { encodePng, rgbToRgba } from '../tools/dashboard/lite/png';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const origin = 'https://rs-sdk-demo.fly.dev';
const out = join(import.meta.dir, '../tv/public/ranking-icons');
mkdirSync(out, { recursive: true });
async function bytes(path: string) { const r = await fetch(origin + path); if (!r.ok) throw new Error(`${path}: ${r.status}`); return new Uint8Array(await r.arrayBuffer()); }
const crc = new DataView((await bytes('/crc')).buffer).getInt32(4 * 4);
const media = new JagFile(await bytes(`/media${crc}`));
const sprite = Pix8.depack(media, 'sideicons', 1); // the actual Skills tab icon
const px = new Int32Array(sprite.wi * sprite.hi);
for (let i = 0; i < px.length; i++) px[i] = sprite.bpal[sprite.data[i]! & 255]!;
await Bun.write(join(out, 'skills.png'), encodePng(sprite.wi, sprite.hi, rgbToRgba(px, v => v === 0)));
await Promise.all([
    bytes('/sprite/item/995-100000.png').then(data => Bun.write(join(out, 'coins.png'), data)),
    bytes('/sprite/item/3140.png').then(data => Bun.write(join(out, 'dragon-chainbody.png'), data)),
]);
console.log('Exported Skills, coins, and dragon chainbody ranking icons.');
