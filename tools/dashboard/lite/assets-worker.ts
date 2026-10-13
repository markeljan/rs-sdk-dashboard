// Lite-view asset renderer (Bun Worker). Accounts on the lite client have no game canvas, so the dashboard draws a
// stand-in client from their observed state. Everything that needs real game art comes from here, rendered with the
// browser client's own code against the game server's cache: world-map squares, item icons, player/NPC/loc models
// (posed with real animation frames), the 2004 frame/sidebar sprites, bitmap fonts and interface layouts.
//
// It runs in a Worker so the DOM shim the client modules need never leaks into the dashboard's globals, and it is only
// started when someone opens a lite account. Every asset is rendered once and cached on disk (keyed by the cache CRCs).
import '../../../server/webclient/src/lite/dom-shim.ts';

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync, unzipSync } from '../../../server/webclient/node_modules/fflate';

import JagFile from '../../../server/webclient/src/io/JagFile.ts';
import Packet from '../../../server/webclient/src/io/Packet.ts';
import Pix2D from '../../../server/webclient/src/graphics/Pix2D.ts';
import Pix8 from '../../../server/webclient/src/graphics/Pix8.ts';
import Pix32 from '../../../server/webclient/src/graphics/Pix32.ts';
import PixFont from '../../../server/webclient/src/graphics/PixFont.ts';
import Pix3D from '../../../server/webclient/src/dash3d/Pix3D.ts';
import Model from '../../../server/webclient/src/dash3d/Model.ts';
import AnimFrame from '../../../server/webclient/src/dash3d/AnimFrame.ts';
import ClientPlayer from '../../../server/webclient/src/dash3d/ClientPlayer.ts';
import ObjType from '../../../server/webclient/src/config/ObjType.ts';
import NpcType from '../../../server/webclient/src/config/NpcType.ts';
import LocType from '../../../server/webclient/src/config/LocType.ts';
import SeqType from '../../../server/webclient/src/config/SeqType.ts';
import IdkType from '../../../server/webclient/src/config/IdkType.ts';
import IfType from '../../../server/webclient/src/config/IfType.ts';
import FloType from '../../../server/webclient/src/config/FloType.ts';
import SpotType from '../../../server/webclient/src/config/SpotType.ts';
import VarpType from '../../../server/webclient/src/config/VarpType.ts';
import VarBitType from '../../../server/webclient/src/config/VarBitType.ts';

import { drawOverlayShape } from './overlay-shape';
import { encodePng, rgbToRgba } from './png';

declare const self: Worker;

type Init = { origin: string; cacheDir: string; root: string };
let cfg: Init;
let ready: Promise<void> | null = null;
let assetDir = '';

// ------------------------------------------------------------------ cache bootstrap
async function fetchBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}
/** Same on-disk naming as the lite client's cache (server/webclient/src/lite/cache.ts), so the archives are shared. */
async function archive(name: string, crc: number): Promise<JagFile> {
    const path = join(cfg.cacheDir, `${name}${crc >>> 0}.jag`);
    if (existsSync(path)) {
        const data = new Uint8Array(readFileSync(path));
        if (Packet.getcrc(data, 0, data.length) === crc) return new JagFile(data);
    }
    const data = await fetchBytes(`${cfg.origin}/${name}${crc}`);
    try { writeFileSync(path, data); } catch { /* read-only cache dir: fine */ }
    return new JagFile(data);
}

let media: JagFile, title: JagFile;
let fonts: Record<string, PixFont> = {};
let ondemand: Record<string, Uint8Array> = {};

async function init(): Promise<void> {
    mkdirSync(cfg.cacheDir, { recursive: true });
    const crcBuf = new Packet(await fetchBytes(`${cfg.origin}/crc`));
    const crcs: number[] = [];
    for (let i = 0; i < 9; i++) crcs.push(crcBuf.g4());
    assetDir = join(cfg.cacheDir, 'dashboard-lite', `${(crcs[2]! >>> 0).toString(36)}-${(crcs[3]! >>> 0).toString(36)}-${(crcs[5]! >>> 0).toString(36)}-v2`);
    mkdirSync(assetDir, { recursive: true });

    title = await archive('title', crcs[1]!);
    const config = await archive('config', crcs[2]!);
    const interfaces = await archive('interface', crcs[3]!);
    media = await archive('media', crcs[4]!);
    const textures = await archive('textures', crcs[6]!);

    // ondemand.zip = cache idx1-4 (models, anims, midi, maps); keep the zip on disk next to the archives
    const zipPath = join(cfg.cacheDir, `ondemand-${crcs[5]! >>> 0}.zip`);
    const zip = existsSync(zipPath) ? new Uint8Array(readFileSync(zipPath)) : await fetchBytes(`${cfg.origin}/ondemand.zip`);
    if (!existsSync(zipPath)) { try { writeFileSync(zipPath, zip); } catch { /* */ } }
    ondemand = unzipSync(zip, { filter: (f) => f.name.startsWith('1.') || f.name.startsWith('2.') });

    fonts = { p11: PixFont.depack(title, 'p11_full', false), p12: PixFont.depack(title, 'p12_full', false), b12: PixFont.depack(title, 'b12_full', false), q8: PixFont.depack(title, 'q8_full', true) };

    Pix3D.unpackTextures(textures);
    Pix3D.initColourTable(0.8);
    Pix3D.initPool(20);

    SeqType.init(config);
    LocType.init(config);
    FloType.init(config);
    ObjType.init(config, true);
    NpcType.init(config);
    IdkType.init(config);
    SpotType.init(config);
    VarpType.init(config);
    VarBitType.init(config);
    IfType.init(interfaces, media, [fonts.p11!, fonts.p12!, fonts.b12!, fonts.q8!]);

    Model.init(65536, { requestModel(id: number) { const e = ondemand[`1.${id}`]; Model.unpack(id, e ? gunzipSync(e) : null); } } as any);
    AnimFrame.init(65535);
    for (const [k, v] of Object.entries(ondemand)) if (k.startsWith('2.')) { try { AnimFrame.unpack(gunzipSync(v)); } catch { /* bad anim file */ } }
    loadHideTable();
}

// Worn items that hide body parts (platebody hides arms, full helm hides hair/beard). The client never learns this -
// the server bakes it into the appearance packet - so read it from the server's own content when it is checked out.
const hides = new Map<number, number[]>();
function loadHideTable() {
    const content = join(cfg.root, 'server', 'content');
    const packFile = join(content, 'pack', 'obj.pack');
    if (!existsSync(packFile)) return;
    const ids = new Map<string, number>();
    for (const line of readFileSync(packFile, 'utf8').split('\n')) { const i = line.indexOf('='); if (i > 0) ids.set(line.slice(i + 1).trim(), Number(line.slice(0, i))); }
    const POS: Record<string, number> = { hat: 0, back: 1, front: 2, righthand: 3, torso: 4, lefthand: 5, arms: 6, legs: 7, head: 8, hands: 9, feet: 10, jaw: 11 };
    const walk = (dir: string) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.name.endsWith('.obj')) {
                let cur = -1;
                for (const line of readFileSync(p, 'utf8').split('\n')) {
                    const m = /^\[(.+)\]/.exec(line);
                    if (m) { cur = ids.get(m[1]!) ?? -1; continue; }
                    const w = /^wearpos[23]=(\w+)/.exec(line);
                    if (w && cur >= 0 && POS[w[1]!] !== undefined) hides.set(cur, [...(hides.get(cur) ?? []), POS[w[1]!]!]);
                }
            }
        }
    };
    try { walk(join(content, 'scripts')); } catch { /* partial table is fine */ }
}

// ------------------------------------------------------------------ helpers
const pngOfPix32 = (s: Pix32) => encodePng(s.wi, s.hi, rgbToRgba(s.data, (v) => v === 0));
function pngOfPix8(s: Pix8) {
    const px = new Int32Array(s.wi * s.hi);
    const transparent = new Uint8Array(px.length);
    for (let i = 0; i < px.length; i++) { const p = s.data[i]! & 0xff; if (p === 0) transparent[i] = 1; else px[i] = s.bpal[p]!; }
    return encodePng(s.wi, s.hi, rgbToRgba(px, (_v, i) => transparent[i] === 1));
}
const dataUrl = (png: Uint8Array) => 'data:image/png;base64,' + Buffer.from(png).toString('base64');
function spriteEntry(s: Pix32 | Pix8 | null | undefined) {
    if (!s) return null;
    return { u: dataUrl(s instanceof Pix32 ? pngOfPix32(s) : pngOfPix8(s)), x: s.xof, y: s.yof, w: s.wi, h: s.hi };
}
const tryDepack = <T>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };
function diskCached(name: string, make: () => Uint8Array | null): Uint8Array | null {
    const p = join(assetDir, name);
    if (existsSync(p)) return new Uint8Array(readFileSync(p));
    const v = make();
    if (v) { try { writeFileSync(p, v); } catch { /* */ } }
    return v;
}

// ------------------------------------------------------------------ UI: frame, sidebar sprites, fonts
function fontAtlas(f: PixFont) {
    const glyphs: Record<number, number[]> = {};
    let x = 0, maxH = 0;
    const places: Array<[number, number]> = [];
    for (let c = 32; c < 256; c++) { places.push([c, x]); x += f.charMaskWidth[c]! + 1; maxH = Math.max(maxH, f.charMaskHeight[c]!); }
    const W = Math.max(1, x), H = Math.max(1, maxH);
    const rgba = new Uint8Array(W * H * 4);
    for (const [c, ox] of places) {
        const w = f.charMaskWidth[c]!, h = f.charMaskHeight[c]!, m = f.charMask[c]!;
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (m[xx + yy * w]) { const o = ((ox + xx) + yy * W) * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 255; }
        glyphs[c] = [ox, w, h, f.charOffsetX[c]!, f.charOffsetY[c]!, f.charAdvance[c]!];
    }
    return { u: dataUrl(encodePng(W, H, rgba)), height: f.height, glyphs };
}

function buildUi() {
    const cached = join(assetDir, 'ui.json');
    if (existsSync(cached)) return readFileSync(cached, 'utf8');
    const M = (n: string, i = 0) => tryDepack(() => Pix32.depack(media, n, i));
    const M8 = (n: string, i = 0) => tryDepack(() => Pix8.depack(media, n, i));

    // The static 765x503 frame exactly as Client.ts lays it out, with the empty panels (game view black).
    const frame = new Int32Array(765 * 503);
    const solid = new Uint8Array(765 * 503);
    Pix2D.setPixels(frame, 765, 503);
    const at = (s: Pix32 | Pix8 | null, x: number, y: number) => s?.plotSprite(x, y);
    at(M('backleft1'), 0, 4); at(M('backleft2'), 0, 357); at(M('backright1'), 722, 4); at(M('backright2'), 743, 205);
    at(M('backtop1'), 0, 0); at(M('backvmid1'), 516, 4); at(M('backvmid2'), 516, 205); at(M('backvmid3'), 496, 357);
    at(M('backhmid2'), 0, 338);
    at(M8('backhmid1'), 516, 160); at(M8('backbase2'), 496, 466); at(M8('backbase1'), 0, 453);
    at(M8('invback'), 553, 205); at(M8('chatback'), 17, 357); at(M8('mapback'), 550, 4);
    for (let i = 0; i < frame.length; i++) solid[i] = 1;
    const framePng = encodePng(765, 503, rgbToRgba(frame, () => false));

    const flip = (n: string, h: boolean, v: boolean) => { const s = M8(n); if (s && h) s.hflip(); if (s && v) s.vflip(); return spriteEntry(s); };
    const sprites: Record<string, any> = {
        redstone1: flip('redstone1', false, false), redstone2: flip('redstone2', false, false), redstone3: flip('redstone3', false, false),
        redstone1h: flip('redstone1', true, false), redstone2h: flip('redstone2', true, false),
        redstone1v: flip('redstone1', false, true), redstone2v: flip('redstone2', false, true), redstone3v: flip('redstone3', false, true),
        redstone1hv: flip('redstone1', true, true), redstone2hv: flip('redstone2', true, true),
        compass: spriteEntry(M('compass')), mapback: spriteEntry(M8('mapback')), scrollbar1: spriteEntry(M8('scrollbar', 0)), scrollbar2: spriteEntry(M8('scrollbar', 1)),
        mapmarker0: spriteEntry(M('mapmarker', 0)), mapmarker1: spriteEntry(M('mapmarker', 1)),
    };
    for (let i = 0; i < 13; i++) sprites[`sideicons${i}`] = spriteEntry(M8('sideicons', i));
    for (let i = 0; i < 4; i++) sprites[`mapdots${i}`] = spriteEntry(M('mapdots', i));
    for (let i = 0; i < 4; i++) sprites[`hitmarks${i}`] = spriteEntry(M('hitmarks', i));
    for (let i = 0; i < 8; i++) sprites[`headicons${i}`] = spriteEntry(M('headicons', i));
    for (let i = 0; i < 8; i++) sprites[`cross${i}`] = spriteEntry(M('cross', i));
    for (let i = 0; i < 2; i++) sprites[`mod_icons${i}`] = spriteEntry(M8('mod_icons', i));
    for (const k of Object.keys(sprites)) if (!sprites[k]) delete sprites[k];

    // Items whose icon depends on the stack size (coins, arrows): the client picks the icon by count thresholds.
    const countco: Record<number, number[][]> = {};
    for (let id = 0; id < ObjType.numDefinitions; id++) {
        const o = ObjType.list(id);
        if (o.countobj && o.countco) countco[id] = [Array.from(o.countco), Array.from(o.countobj)];
    }
    const stack: number[] = [];
    for (let id = 0; id < ObjType.numDefinitions; id++) if (ObjType.list(id).stackable) stack.push(id);
    const ui = JSON.stringify({ frame: dataUrl(framePng), sprites, fonts: Object.fromEntries(Object.entries(fonts).map(([k, f]) => [k, fontAtlas(f)])), countco, stack });
    try { writeFileSync(cached, ui); } catch { /* */ }
    return ui;
}

// ------------------------------------------------------------------ interfaces (IfType trees)
function exportInterface(anyId: number) {
    // a chat dialog only tells us its components; climb to the interface that owns them
    let rootId = anyId;
    for (let i = 0; i < 20; i++) { const c = IfType.list[rootId]; if (!c || c.layerId < 0 || c.layerId === rootId) break; rootId = c.layerId; }
    const fontName = new Map<PixFont, string>(Object.entries(fonts).map(([k, f]) => [f, k]));
    const spriteKeys = new Map<object, string>();
    const sprites: Record<string, any> = {};
    const spr = (s: Pix32 | null) => {
        if (!s) return null;
        let k = spriteKeys.get(s);
        if (!k) { k = 's' + spriteKeys.size; spriteKeys.set(s, k); sprites[k] = spriteEntry(s); }
        return k;
    };
    const comps: Record<number, any> = {};
    const visit = (id: number) => {
        const c = IfType.list[id];
        if (!c || comps[id]) return;
        const o: any = { id, t: c.type, bt: c.buttonType, cc: c.clientCode, x: c.x, y: c.y, w: c.width, h: c.height };
        if (c.hide) o.hide = 1;
        if (c.scrollHeight) o.sh = c.scrollHeight;
        if (c.children) { o.ch = c.children.map((cid, i) => [cid, c.childX![i], c.childY![i]]); }
        if (c.scripts) o.scripts = c.scripts.map((s) => (s ? Array.from(s) : null));
        if (c.scriptComparator) o.cmp = Array.from(c.scriptComparator);
        if (c.scriptOperand) o.opnd = Array.from(c.scriptOperand);
        if (c.type === 2 || c.type === 7) { o.mx = c.marginX; o.my = c.marginY; }
        if (c.type === 2 && c.invBackground) o.bg = c.invBackground.map((s, i) => (s ? [spr(s), c.invBackgroundX![i], c.invBackgroundY![i]] : null));
        if (c.type === 3 || c.type === 4 || c.type === 7) { o.c = c.colour; o.c2 = c.colour2; o.co = c.colourOver; o.c2o = c.colour2Over; }
        if (c.type === 3) { o.fill = c.fill ? 1 : 0; o.trans = c.trans; }
        if (c.type === 4 || c.type === 7) { o.f = c.font ? fontName.get(c.font) ?? 'p12' : null; o.txt = c.text; o.txt2 = c.text2; o.ctr = c.centre ? 1 : 0; o.sh2 = c.shadow ? 1 : 0; }
        if (c.type === 5) { o.g = spr(c.graphic); o.g2 = spr(c.graphic2); }
        if (c.type === 6) { o.m = [c.model1Type, c.model1Id, c.model2Type, c.model2Id, c.modelZoom, c.modelXAn, c.modelYAn, c.modelAnim]; }
        if (c.buttonText) o.btn = c.buttonText;
        if (c.iop) o.iop = c.iop;
        comps[id] = o;
        if (c.children) for (const cid of c.children) visit(cid);
    };
    visit(rootId);
    return JSON.stringify({ root: rootId, comps, sprites });
}

// ------------------------------------------------------------------ items
function itemIcon(id: number): Uint8Array | null {
    if (id < 0 || id >= ObjType.numDefinitions) return null;
    return diskCached(`icon-${id}.png`, () => {
        const s = ObjType.getSprite(id, 1, 0);
        return s ? encodePng(32, 32, rgbToRgba(s.data, (v) => v === 0)) : null;
    });
}

// ------------------------------------------------------------------ world map squares
type Square = { under: Uint8Array; over: Int32Array; shape: Uint8Array; wall: Uint8Array; scene: Uint8Array; func: Uint8Array };
let squares: Map<number, Square> | null = null;
let floorcol1: number[] = [0], floorcol2: number[] = [0];
let mapscene: (Pix8 | null)[] = [], mapfunction: (Pix32 | null)[] = [];
let labels: Array<{ t: string; x: number; z: number; s: number }> = [];
const sq = (mx: number, mz: number) => { const k = (mx << 8) | mz; let s = squares!.get(k); if (!s) { s = { under: new Uint8Array(4096), over: new Int32Array(4096), shape: new Uint8Array(4096), wall: new Uint8Array(4096), scene: new Uint8Array(4096), func: new Uint8Array(4096) }; squares!.set(k, s); } return s; };
async function loadWorldmap() {
    if (squares) return;
    const local = join(cfg.root, 'server', 'engine', 'data', 'pack', 'mapview', 'worldmap.jag');
    const wm = new JagFile(existsSync(local) ? new Uint8Array(readFileSync(local)) : await fetchBytes(`${cfg.origin}/worldmap.jag`));
    squares = new Map();
    const fc = new Packet(wm.read('floorcol.dat'));
    const n = fc.g2();
    for (let i = 0; i < n; i++) { floorcol1[i + 1] = fc.g4(); floorcol2[i + 1] = fc.g4(); }
    // byte order per square: x 0..63, then z 0..63 northwards (MapView.loadUnderlay with its display flip undone)
    const under = new Packet(wm.read('underlay.dat'));
    while (under.available > 0) { const s = sq(under.g1(), under.g1()); for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) s.under[x + z * 64] = under.g1(); }
    const over = new Packet(wm.read('overlay.dat'));
    while (over.available > 0) {
        const s = sq(over.g1(), over.g1());
        for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) { const op = over.g1(); if (op) { s.shape[x + z * 64] = over.g1(); s.over[x + z * 64] = floorcol2[op]!; } }
    }
    const loc = new Packet(wm.read('loc.dat'));
    while (loc.available > 0) {
        const s = sq(loc.g1(), loc.g1());
        for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
            for (;;) {
                const op = loc.g1();
                if (op === 0) break;
                if (op < 29) s.wall[x + z * 64] = op; else if (op < 160) s.scene[x + z * 64] = op - 28; else s.func[x + z * 64] = op - 159;
            }
        }
    }
    for (let i = 0; i < 100; i++) mapscene[i] = tryDepack(() => Pix8.depack(wm, 'mapscene', i));
    for (let i = 0; i < 100; i++) mapfunction[i] = tryDepack(() => Pix32.depack(wm, 'mapfunction', i));
    const lb = new Packet(wm.read('labels.dat'));
    const ln = lb.g2();
    for (let i = 0; i < ln; i++) {
        const t = lb.gjstr(); const x = lb.g2(); let z = lb.g2(); const s = lb.g1();
        // labels are authored in MapView's unified display space; move them back to world coordinates
        const mz = z >> 6;
        if (mz >= 62 && mz < 80) z += 82 << 6; else if (mz >= 80 && mz <= 86) z -= 10 << 6;
        labels.push({ t, x, z, s });
    }
}
function tileAt(wx: number, wz: number): [Square | undefined, number] { return [squares!.get(((wx >> 6) << 8) | (wz >> 6)), (wx & 63) + (wz & 63) * 64]; }

// MapView.getRgb (HSL -> RGB as the 2004 world map does it)
function getRgb(hue: number, sat: number, light: number): number {
    let r = light, g = light, b = light;
    if (sat !== 0) {
        const q = light < 0.5 ? light * (sat + 1) : light + sat - light * sat;
        const p = light * 2 - q;
        const ch = (t: number) => { if (t > 1) t--; if (t < 0) t++; return t * 6 < 1 ? p + (q - p) * 6 * t : t * 2 < 1 ? q : t * 3 < 2 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
        r = ch(hue + 1 / 3); g = ch(hue); b = ch(hue - 1 / 3);
    }
    return (((r * 256) | 0) << 16) + (((g * 256) | 0) << 8) + ((b * 256) | 0);
}
// MapView.getBlendedGroundColour: each tile's underlay HSL averaged over a 10x10 window (dx -4..5, dz -5..4),
// computed for a whole T x T block at once with summed-area tables.
function blendedBlock(x0: number, z0: number, T: number): Int32Array {
    const P = T + 10, N = P + 1; // padded block with a leading zero row/column for the prefix sums
    const H = new Float64Array(N * N), S = new Float64Array(N * N), L = new Float64Array(N * N), A = new Int32Array(N * N);
    for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
        const [q, k] = tileAt(x0 - 5 + i, z0 - 5 + j);
        const u = q ? q.under[k]! : 0, v = floorcol1[u] ?? 0, o = (i + 1) + (j + 1) * N;
        H[o] = (v >> 20) + H[o - 1]! + H[o - N]! - H[o - N - 1]!;
        S[o] = ((v >> 10) & 0x3ff) + S[o - 1]! + S[o - N]! - S[o - N - 1]!;
        L[o] = (v & 0x3ff) + L[o - 1]! + L[o - N]! - L[o - N - 1]!;
        A[o] = (u ? 1 : 0) + A[o - 1]! + A[o - N]! - A[o - N - 1]!;
    }
    const sum = (G: Float64Array | Int32Array, i0: number, j0: number, i1: number, j1: number) => G[i1 + j1 * N]! - G[i0 + j1 * N]! - G[i1 + j0 * N]! + G[i0 + j0 * N]!;
    const out = new Int32Array(T * T);
    for (let tz = 0; tz < T; tz++) for (let tx = 0; tx < T; tx++) {
        // window tiles x: tx-4..tx+5, z: tz-5..tz+4 -> padded indices (+5), prefix bounds exclusive/inclusive
        const i0 = tx + 1, i1 = tx + 11, j0 = tz, j1 = tz + 10;
        const l = sum(L, i0, j0, i1, j1);
        out[tx + tz * T] = sum(A, i0, j0, i1, j1) > 0 && l > 0 ? getRgb(sum(H, i0, j0, i1, j1) / 8533, sum(S, i0, j0, i1, j1) / 8533, l / 8533) : 0;
    }
    return out;
}

// Two looks per map square: 'map' = the 2004 world map at 4 px/tile (walls, trees, icons) for the minimap; 'ground' =
// terrain only at 8 px/tile, the floor of the simulated 3D view (walls are extruded and locs drawn as models there).
function mapSquare(mx: number, mz: number, terrain = false): Uint8Array | null {
    const TPX = terrain ? 8 : 4;
    return diskCached(`${terrain ? 'ground' : 'map'}-${mx}_${mz}.png`, () => {
        if (!squares!.has((mx << 8) | mz)) return encodePng(1, 1, new Uint8Array(4));
        // render with a 4-tile margin so icons that straddle the square edge are drawn whole, then crop
        const M = 4, T = 64 + 2 * M, W = T * TPX;
        const px = new Int32Array(W * W), has = new Uint8Array(W * W);
        Pix2D.setPixels(px, W, W);
        const x0 = mx * 64 - M, z0 = mz * 64 - M;
        const sx = (tx: number) => tx * TPX, sy = (tz: number) => (T - 1 - tz) * TPX; // north up
        const blend = blendedBlock(x0, z0, T);
        for (let tx = 0; tx < T; tx++) for (let tz = 0; tz < T; tz++) {
            const [q, i] = tileAt(x0 + tx, z0 + tz);
            if (!q) continue;
            const X = sx(tx), Y = sy(tz);
            for (let yy = 0; yy < TPX; yy++) has.fill(1, X + (Y + yy) * W, X + (Y + yy) * W + TPX);
            const ground = blend[tx + tz * T]!, ov = q.over[i]!;
            if (ov === 0) Pix2D.fillRect(X, Y, TPX, TPX, ground);
            else {
                const info = q.shape[i]!, shape = info & 0xfc;
                if (shape === 0) Pix2D.fillRect(X, Y, TPX, TPX, ov);
                else drawOverlayShape(px, Y * W + X, ground, ov, TPX, TPX, shape >> 2, info & 3, W);
            }
        }
        const funcs: Array<[number, number, number]> = [];
        if (!terrain) for (let tx = 0; tx < T; tx++) for (let tz = 0; tz < T; tz++) {
            const [q, i] = tileAt(x0 + tx, z0 + tz);
            if (!q) continue;
            const X = sx(tx), Y = sy(tz), E = X + TPX - 1, B = Y + TPX - 1;
            let wall = q.wall[i]!;
            if (wall) {
                let rgb = 0xcccccc;
                if ((wall >= 5 && wall <= 8) || (wall >= 13 && wall <= 16) || (wall >= 21 && wall <= 24)) { rgb = 0xcc0000; wall -= 4; }
                if (wall === 27 || wall === 28) { rgb = 0xcc0000; wall -= 2; }
                if (wall === 1) Pix2D.vline(X, Y, TPX, rgb);
                else if (wall === 2) Pix2D.hline(X, Y, TPX, rgb);
                else if (wall === 3) Pix2D.vline(E, Y, TPX, rgb);
                else if (wall === 4) Pix2D.hline(X, B, TPX, rgb);
                else if (wall === 9) { Pix2D.vline(X, Y, TPX, 0xffffff); Pix2D.hline(X, Y, TPX, rgb); }
                else if (wall === 10) { Pix2D.vline(E, Y, TPX, 0xffffff); Pix2D.hline(X, Y, TPX, rgb); }
                else if (wall === 11) { Pix2D.vline(E, Y, TPX, 0xffffff); Pix2D.hline(X, B, TPX, rgb); }
                else if (wall === 12) { Pix2D.vline(X, Y, TPX, 0xffffff); Pix2D.hline(X, B, TPX, rgb); }
                else if (wall === 17) Pix2D.hline(X, Y, 1, rgb);
                else if (wall === 18) Pix2D.hline(E, Y, 1, rgb);
                else if (wall === 19) Pix2D.hline(E, B, 1, rgb);
                else if (wall === 20) Pix2D.hline(X, B, 1, rgb);
                else if (wall === 25) for (let k = 0; k < TPX; k++) Pix2D.hline(X + k, B - k, 1, rgb);
                else if (wall === 26) for (let k = 0; k < TPX; k++) Pix2D.hline(X + k, Y + k, 1, rgb);
            }
            const sc = q.scene[i]!;
            if (sc) mapscene[sc - 1]?.scalePlotSprite(X - TPX / 2, Y - TPX / 2, TPX * 2, TPX * 2);
            const fn = q.func[i]!;
            if (fn) funcs.push([fn - 1, X + TPX / 2, Y + TPX / 2]);
        }
        for (const [f, x, y] of funcs) mapfunction[f]?.plotSprite(x - 7, y - 7);
        const S = 64 * TPX, out = new Int32Array(S * S), oHas = new Uint8Array(S * S);
        for (let y = 0; y < S; y++) { out.set(px.subarray((y + M * TPX) * W + M * TPX, (y + M * TPX) * W + M * TPX + S), y * S); oHas.set(has.subarray((y + M * TPX) * W + M * TPX, (y + M * TPX) * W + M * TPX + S), y * S); }
        return encodePng(S, S, rgbToRgba(out, (_v, i) => !oHas[i]));
    });
}

/** The whole surface world at 1 px per tile (ground colours only), for Bot HQ's zoomed-out fleet map. */
function overview(): { png: Uint8Array; meta: any } {
    const metaPath = join(assetDir, 'overview.json'), pngPath = join(assetDir, 'overview.png');
    if (existsSync(metaPath) && existsSync(pngPath)) return { png: new Uint8Array(readFileSync(pngPath)), meta: JSON.parse(readFileSync(metaPath, 'utf8')) };
    let mx0 = 255, mx1 = 0, mz0 = 255, mz1 = 0;
    for (const k of squares!.keys()) { const mx = k >> 8, mz = k & 255; if (mz >= 100) continue; mx0 = Math.min(mx0, mx); mx1 = Math.max(mx1, mx); mz0 = Math.min(mz0, mz); mz1 = Math.max(mz1, mz); }
    const W = (mx1 - mx0 + 1) * 64, H = (mz1 - mz0 + 1) * 64;
    const px = new Int32Array(W * H), has = new Uint8Array(W * H);
    for (let mx = mx0; mx <= mx1; mx++) for (let mz = mz0; mz <= mz1; mz++) {
        const q = squares!.get((mx << 8) | mz);
        if (!q) continue;
        const blend = blendedBlock(mx * 64, mz * 64, 64);
        for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
            const i = x + z * 64, o = ((mx - mx0) * 64 + x) + (H - 1 - ((mz - mz0) * 64 + z)) * W;
            px[o] = q.over[i] || blend[i]!; has[o] = 1;
            if (q.wall[i]) px[o] = (q.wall[i]! >= 5 && q.wall[i]! <= 8) || (q.wall[i]! >= 13 && q.wall[i]! <= 16) ? 0xcc0000 : 0xcccccc;
        }
    }
    const png = encodePng(W, H, rgbToRgba(px, (_v, i) => !has[i]));
    const meta = { x0: mx0 * 64, z1: (mz1 + 1) * 64, w: W, h: H };
    try { writeFileSync(pngPath, png); writeFileSync(metaPath, JSON.stringify(meta)); } catch { /* */ }
    return { png, meta };
}

/** Wall segments of a square as [localX, localZ, op] (MapView loc.dat wall opcodes 1-28), for the 3D view. */
function wallsJson(mx: number, mz: number): string {
    const q = squares!.get((mx << 8) | mz);
    const out: number[][] = [];
    if (q) for (let i = 0; i < 4096; i++) if (q.wall[i]) out.push([i & 63, i >> 6, q.wall[i]!]);
    return JSON.stringify(out);
}

// ------------------------------------------------------------------ models (players, NPCs, locs)
const sin = () => Pix3D.sinTable, cos = () => Pix3D.cosTable;
const SCR_W = 360, SCR_H = 400, ORG_X = 180, ORG_Y = 330;
export const TILE_PX = 32;        // sprite scale: one 128-unit tile = 32 px
const ZOOM = (512 * 128) / TILE_PX;
const PITCH = 210;                // camera pitch in 2048ths of a turn (~37 degrees), matched by the client's ground

function renderStrip(models: Array<() => Model | null>, yaw: number): { png: Uint8Array; meta: any } | null {
    const frames: Int32Array[] = [];
    let minX = SCR_W, minY = SCR_H, maxX = -1, maxY = -1;
    const eyeY = (sin()[PITCH]! * ZOOM) >> 16, eyeZ = (cos()[PITCH]! * ZOOM) >> 16;
    for (const make of models) {
        const px = new Int32Array(SCR_W * SCR_H);
        const m = make(); // rendered before the next frame reuses the client's shared temp model
        if (m) {
            Pix2D.setPixels(px, SCR_W, SCR_H);
            Pix3D.setRenderClipping();
            Pix3D.originX = ORG_X; Pix3D.originY = ORG_Y;
            m.objRender(0, yaw & 2047, 0, PITCH, 0, eyeY, eyeZ);
            for (let y = 0; y < SCR_H; y++) for (let x = 0; x < SCR_W; x++) if (px[x + y * SCR_W]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        }
        frames.push(px);
    }
    if (maxX < 0) return null;
    minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1); maxX = Math.min(SCR_W - 1, maxX + 1); maxY = Math.min(SCR_H - 1, maxY + 1);
    const fw = maxX - minX + 1, fh = maxY - minY + 1, n = frames.length;
    const strip = new Int32Array(fw * n * fh);
    frames.forEach((px, f) => { for (let y = 0; y < fh; y++) strip.set(px.subarray((y + minY) * SCR_W + minX, (y + minY) * SCR_W + minX + fw), y * fw * n + f * fw); });
    return { png: encodePng(fw * n, fh, rgbToRgba(strip, (v) => v === 0)), meta: { fw, fh, n, ax: ORG_X - minX, ay: ORG_Y - minY } };
}

function seqFrames(seqId: number): { ids: number[]; delays: number[] } {
    const seq = seqId >= 0 ? SeqType.list[seqId] : null;
    if (!seq?.frames) return { ids: [-1], delays: [1] };
    const ids: number[] = [], delays: number[] = [];
    for (let i = 0; i < seq.frames.length && i < 48; i++) {
        ids.push(seq.frames[i]!);
        let d = seq.delay?.[i] ?? 0;
        if (!d) d = AnimFrame.get(seq.frames[i]!)?.delay ?? 1;
        delays.push(Math.max(1, d));
    }
    return { ids, delays };
}

// Deterministic look per account: hair/clothes/colours seeded by the account name.
function seeded(seed: string) { let h = 2166136261; for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; }; }
const PART_SLOT = [8, 11, 4, 6, 9, 7, 10]; // idk part (hair, jaw, torso, arms, hands, legs, feet) -> appearance slot
let playerSeq = 0;
function playerModels(equip: Array<[number, number]>, seed: string, seqId: number) {
    const rnd = seeded(seed);
    const p = new ClientPlayer();
    p.gender = 0;
    const worn = new Map(equip);
    const hidden = new Set<number>();
    for (const [, id] of equip) for (const s of hides.get(id) ?? []) hidden.add(s);
    for (let part = 0; part < 7; part++) {
        const slot = PART_SLOT[part]!;
        const kits = IdkType.list.map((k, i) => [k, i] as const).filter(([k]) => k.part === part && !k.disable);
        if (worn.has(slot) || hidden.has(slot)) continue;
        if (kits.length) p.appearance[slot] = 0x100 + kits[Math.floor(rnd() * kits.length)]![1];
    }
    for (const [slot, id] of worn) if (slot < 12 && !hidden.has(slot) && id >= 0 && id < ObjType.numDefinitions) p.appearance[slot] = 0x200 + id;
    for (let i = 0; i < 5; i++) p.colour[i] = Math.floor(rnd() * ClientPlayer.recol1d[i]!.length);
    p.ready = true;
    p.baseId = BigInt(++playerSeq) << 32n; // unique model-cache key per render
    const { ids, delays } = seqFrames(seqId);
    const models = ids.map((fid, i) => () => {
        if (fid < 0) { p.primaryAnim = -1; p.secondaryAnim = -1; }
        else { p.primaryAnim = seqId; p.primaryAnimFrame = i; p.primaryAnimDelay = 0; p.secondaryAnim = -1; }
        return p.getTempModel2();
    });
    return { models, delays };
}
function npcModels(id: number, seqId: number) {
    const t = NpcType.list(id);
    const { ids, delays } = seqFrames(seqId >= 0 ? seqId : seqId === -2 && t.walkanim >= 0 ? t.walkanim : t.readyanim);
    return { models: ids.map((f) => () => t.getTempModel(f, -1, null)), delays };
}
function locModels(id: number, angle: number) {
    const t = LocType.list(id);
    const shapes = t.shape ? Array.from(t.shape) : [10];
    const shape = shapes.includes(10) ? 10 : shapes.includes(11) ? 11 : shapes.includes(22) ? 22 : shapes[0] ?? 10;
    if (shape < 10) return { models: [], delays: [], size: [t.width, t.length], skip: true }; // walls/doors: the 3D view extrudes them from the world map
    const { ids, delays } = seqFrames(t.anim);
    return { models: ids.map((f) => () => t.getModel(shape, angle & 3, 0, 0, 0, 0, f)), delays, size: [t.width, t.length] };
}

function modelAsset(spec: any): { png: Uint8Array; meta: any } | null {
    const dir = (Number(spec.dir) || 0) & 7;
    const key = spec.kind === 'player'
        ? `p-${Bun.hash(JSON.stringify([spec.equip, spec.seed])).toString(36)}-${spec.seq}-${dir}`
        : spec.kind === 'npc' ? `n-${spec.id}-${spec.seq}-${dir}` : `l-${spec.id}-${dir}`;
    const metaPath = join(assetDir, key + '.json');
    if (existsSync(metaPath) && existsSync(join(assetDir, key + '.png'))) return { png: new Uint8Array(readFileSync(join(assetDir, key + '.png'))), meta: JSON.parse(readFileSync(metaPath, 'utf8')) };
    let r: { models: Array<() => Model | null>; delays: number[]; size?: number[]; skip?: boolean };
    if (spec.kind === 'player') r = playerModels((spec.equip ?? []).map((e: any) => [Number(e[0]), Number(e[1])]), String(spec.seed ?? ''), Number(spec.seq ?? -1));
    else if (spec.kind === 'npc') r = npcModels(Number(spec.id), Number(spec.seq ?? -1));
    else r = locModels(Number(spec.id), dir >> 1);
    // dir is the 8-way facing relative to the camera: 0 = away from it, 2 = screen-left, 4 = towards it
    const out = r.skip ? { png: encodePng(1, 1, new Uint8Array(4)), meta: { fw: 1, fh: 1, n: 1, ax: 0, ay: 0, skip: 1 } as any } : renderStrip(r.models, spec.kind === 'loc' ? 0 : dir * 256);
    if (!out) return null;
    out.meta.delays = r.delays;
    if (r.size) out.meta.size = r.size;
    try { writeFileSync(join(assetDir, key + '.png'), out.png); writeFileSync(metaPath, JSON.stringify(out.meta)); } catch { /* */ }
    return out;
}

// ------------------------------------------------------------------ message loop
// One request at a time, most useful first: a freshly opened view asks for everything at once, and the frame,
// interfaces and floor matter more than the 60th tree model.
const PRIORITY: Record<string, number> = { ui: 0, if: 1, labels: 2, overview: 2, walls: 2, map: 3, icon: 4, model: 5 };
const queue: any[] = [];
let pumping = false;
async function handle(m: any) {
    const reply = (ok: boolean, data?: Uint8Array | string | null, extra?: any) => self.postMessage({ id: m.id, ok, data, ...extra });
    try {
        await ready;
        if (m.type === 'ui') return reply(true, buildUi());
        if (m.type === 'if') { const id = Number(m.root); return IfType.list[id] ? reply(true, exportInterface(id)) : reply(false, 'no such interface'); }
        if (m.type === 'icon') { const d = itemIcon(Number(m.obj)); return reply(!!d, d); }
        if (m.type === 'map') { await loadWorldmap(); return reply(true, mapSquare(Number(m.mx), Number(m.mz), !!m.terrain)); }
        if (m.type === 'walls') { await loadWorldmap(); return reply(true, wallsJson(Number(m.mx), Number(m.mz))); }
        if (m.type === 'overview') { await loadWorldmap(); const r = overview(); return reply(true, r.png, { meta: r.meta }); }
        if (m.type === 'labels') { await loadWorldmap(); return reply(true, JSON.stringify(labels)); }
        if (m.type === 'model') { const r = modelAsset(m.spec); return reply(!!r, r?.png ?? null, { meta: r?.meta ?? null }); }
        reply(false, `unknown request ${m.type}`);
    } catch (err) {
        reply(false, String((err as Error)?.stack ?? err));
    }
}
async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
        let best = 0;
        for (let i = 1; i < queue.length; i++) if ((PRIORITY[queue[i].type] ?? 9) < (PRIORITY[queue[best].type] ?? 9)) best = i;
        await handle(queue.splice(best, 1)[0]);
    }
    pumping = false;
}
self.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'init') { cfg = m.cfg; ready = init(); ready.catch(() => {}); return; }
    queue.push(m);
    void pump();
};
