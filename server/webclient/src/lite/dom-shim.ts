// Minimal DOM shim so browser-targeted client modules can be imported under Bun.
//
// The lite client reuses the real config decoders (IfType/ObjType/NpcType/LocType).
// Those pull in graphics/Pix32.ts -> graphics/Jpeg.ts, which touches
// `document.createElement` at MODULE SCOPE. Nothing the bot does ever calls into
// that path (JPEG decoding is only used for title-screen art), so the stubs only
// have to survive construction - they never have to work.
//
// Import this before anything under '#/'. See main.ts.

type AnyRecord = Record<string, unknown>;

function stubElement(): AnyRecord {
    const el: AnyRecord = {
        width: 0,
        height: 0,
        style: {},
        getContext: () => stubContext(),
        addEventListener: () => {},
        removeEventListener: () => {},
        appendChild: (c: unknown) => c,
        setAttribute: () => {},
        focus: () => {},
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
    };
    return el;
}

function stubContext(): AnyRecord {
    return {
        canvas: null,
        clearRect: () => {},
        drawImage: () => {},
        fillRect: () => {},
        putImageData: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(Math.max(0, w * h * 4))
        }),
        createImageData: (w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(Math.max(0, w * h * 4))
        })
    };
}

const g = globalThis as AnyRecord;

if (typeof g.document === 'undefined') {
    g.document = {
        createElement: () => stubElement(),
        getElementById: () => stubElement(),
        querySelector: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
        body: stubElement(),
        head: stubElement()
    };
}

// localStorage and audioContext are touched at MODULE scope by MobileKeyboard.ts
// and 3rdparty/tinymidipcm.js. The lite client never imports either, but the
// collision oracle test (world/CollisionBuilder.test.ts) pulls in ClientBuild,
// which reaches them transitively. Stub rather than skip, so the test can use
// the browser's own scene builder as ground truth.
if (typeof g.localStorage === 'undefined') {
    const store = new Map<string, string>();
    g.localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear()
    };
}

if (typeof g.window === 'undefined') {
    g.window = g;
}

const win = g.window as AnyRecord;
if (typeof win.audioContext === 'undefined') {
    const node = (): AnyRecord => ({
        connect: () => {},
        disconnect: () => {},
        gain: { value: 0, setValueAtTime: () => {} }
    });
    win.audioContext = {
        currentTime: 0,
        destination: node(),
        createGain: node,
        createBufferSource: node,
        createBuffer: () => ({ getChannelData: () => new Float32Array(0) }),
        decodeAudioData: () => Promise.reject(new Error('lite client: no audio')),
        resume: () => Promise.resolve()
    };
}

if (typeof g.self === 'undefined') {
    g.self = g;
}

// Jpeg.ts calls URL.revokeObjectURL/createObjectURL at decode time only, but keep
// them present so a stray call throws something legible instead of a TypeError.
if (typeof URL.createObjectURL === 'undefined') {
    (URL as unknown as AnyRecord).createObjectURL = () => {
        throw new Error('lite client: object URLs are not available headless');
    };
    (URL as unknown as AnyRecord).revokeObjectURL = () => {};
}

// 3rdparty/tinymidipcm.js runs an async IIFE at import time that does
// `await fetch('/client/SCC1_Florestan.sf2')`. Bun's fetch rejects relative URLs,
// and because nothing awaits that IIFE the rejection is unhandled - harmless in a
// script, but bun:test counts it as a failure. There is no asset server headless, so
// park relative-URL fetches on a promise that never settles: the IIFE suspends
// and no rejection escapes. Absolute URLs (the game server) pass straight through.
{
    const realFetch = g.fetch as typeof fetch;
    if (typeof realFetch === 'function' && !(realFetch as unknown as AnyRecord).__liteShim) {
        const shimmed = ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (url.startsWith('/')) {
                return new Promise<Response>(() => {});
            }
            return realFetch(input, init);
        }) as typeof fetch;
        (shimmed as unknown as AnyRecord).__liteShim = true;
        g.fetch = shimmed;
    }
}

export {};
