// Minimal RGBA PNG encoder (no dependencies): the lite view's assets are small sprites and map squares.
import { deflateSync } from 'zlib';

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
}
function crc32(buf: Uint8Array, start: number, end: number): number {
    let c = -1;
    for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
}

/** Encode width x height RGBA bytes as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
    const raw = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width); dv.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** 0xRRGGBB pixels where `transparent(i)` marks see-through pixels -> RGBA bytes. */
export function rgbToRgba(px: Int32Array, transparent: (v: number, i: number) => boolean): Uint8Array {
    const out = new Uint8Array(px.length * 4);
    for (let i = 0; i < px.length; i++) {
        const v = px[i]!;
        if (transparent(v, i)) continue;
        out[i * 4] = (v >> 16) & 0xff; out[i * 4 + 1] = (v >> 8) & 0xff; out[i * 4 + 2] = v & 0xff; out[i * 4 + 3] = 255;
    }
    return out;
}
