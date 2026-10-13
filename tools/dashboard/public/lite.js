// Lite view: a stand-in 2004 game client for accounts on the headless lite client (no canvas to stream).
//
// The dashboard polls /api/lite/scene (one compact game tick of observed state) while someone watches, and this draws
// it into the same 765x503 canvas a real client stream would use - so dynamic fullscreen and the panel crops work
// unchanged. All art is real game data rendered by the server's asset worker (tools/dashboard/lite):
//   frame/sidebar sprites + bitmap fonts (/lite/ui.json), interface layouts (/lite/if/<id>.json), item icons,
//   world-map squares for the minimap (/lite/map) and the 3D floor (/lite/ground), wall segments (/lite/walls), and
//   player/NPC/loc models posed with their real animation frames (/lite/model.png).
// Nothing here talks to the game: clicks only switch tabs, hover shows names, arrow keys turn the simulated camera.
(() => {
  'use strict';
  const FW = 765, FH = 503;
  const VP = { x: 4, y: 4, w: 512, h: 334 };
  // the simulated client draws at the game's frame size; a stream frame that lands late can leave the canvas at another size
  const fitCanvas = (c) => { if (c.width !== FW || c.height !== FH) { c.width = FW; c.height = FH; c.style.aspectRatio = `${FW} / ${FH}`; } };
  const SIDE = { x: 553, y: 205 }, CHAT = { x: 17, y: 357 }, MAPA = { x: 550, y: 4 };
  const MM = { cx: 550 + 98, cy: 4 + 79, rx: 73, ry: 76 }; // minimap circle (client draws it at areaMap+25,5 146x151)
  const TICK_MS = 600;
  // sidebar tab -> interface (Client sideTabInterfaceId defaults for a logged-in player; 7 is unused)
  const TAB_IF = [5855, 3917, 638, 3213, 1644, 5608, 1151, -1, 5065, 5715, 2449, 904, 147, 962];
  const TAB_HIT = [[539, 169, 573, 205], [569, 168, 599, 205], [597, 168, 627, 205], [625, 168, 669, 203], [666, 168, 696, 205], [694, 168, 724, 205], [722, 169, 756, 205],
    [540, 466, 574, 502], [572, 466, 602, 503], [599, 466, 629, 503], [627, 467, 671, 502], [669, 466, 699, 503], [696, 466, 726, 503], [724, 466, 758, 502]];
  const HQ_TAB = 7; // the unused first bottom tab (left of the smiley): the fleet list (account switcher) on every account
  // the world-map button in the minimap's bottom-left corner (the compass sits top-left): opens the Bot HQ map
  const WORLD_BTN = { cx: 588, cy: 148, r: 10 };
  // minimap fleet dots as HQ-map skill badges (dashboard setting, saved per device)
  let mmBadges = true;
  try { mmBadges = localStorage.getItem('dash.mmBadges') !== '0'; } catch {}
  const TAB_NAMES = ['Combat Options', 'Stats', 'Quest List', 'Inventory', 'Worn Equipment', 'Prayer', 'Magic', 'Bot HQ', 'Friends List', 'Ignore List', 'Logout', 'Game Options', 'Player Controls', 'Music Player'];
  const INV_COM = { inv: 3214, worn: 1688, bank: 5382, bankSide: 2006, shop: 3900, shopSide: 3823, tradeMine: 3415, tradeTheirs: 3416, tradeSide: 3322 };
  const SKILL_NAMES = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Slayer', '', 'Runecraft'];
  const LEVEL_XP = (() => { const t = []; let acc = 0; for (let i = 0; i < 99; i++) { const l = i + 1; acc += (l + Math.pow(2, l / 10) * 300) | 0; t[i] = (acc / 4) | 0; } return t; })();
  const COL = { red: 0xff0000, gre: 0xff00, blu: 0xff, yel: 0xffff00, cya: 0xffff, mag: 0xff00ff, whi: 0xffffff, bla: 0, lre: 0xff9040, dre: 0x800000, dbl: 0x80, or1: 0xffb000, or2: 0xff7000, or3: 0xff3000, gr1: 0xc0ff00, gr2: 0x80ff00, gr3: 0x40ff00 };
  const hex = (c) => '#' + (c & 0xffffff).toString(16).padStart(6, '0');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now();

  // ------------------------------------------------------------------ asset loading (lazy, memoised)
  const imgCache = new Map();
  function image(url) {
    let e = imgCache.get(url);
    if (!e) {
      e = { img: new Image(), ok: false, failed: false };
      e.img.decoding = 'async';
      e.img.onload = () => { e.ok = true; };
      e.img.onerror = () => { e.failed = true; };
      e.img.src = url;
      imgCache.set(url, e);
    }
    return e.ok ? e.img : null;
  }
  const jsonCache = new Map();
  function json(url) {
    let e = jsonCache.get(url);
    if (!e) {
      e = { v: null, failed: false };
      jsonCache.set(url, e);
      fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((v) => { e.v = v; }).catch(() => { e.failed = true; setTimeout(() => jsonCache.delete(url), 15000); });
    }
    return e.v;
  }
  const modelCache = new Map();
  function model(spec) {
    const key = JSON.stringify(spec);
    let e = modelCache.get(key);
    if (!e) {
      e = { img: null, meta: null, failed: false };
      modelCache.set(key, e);
      fetch('/lite/model.png?spec=' + encodeURIComponent(key)).then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        e.meta = JSON.parse(r.headers.get('x-lite-meta') || 'null');
        const bmp = await createImageBitmap(await r.blob());
        e.meta.total = e.meta.delays.reduce((a, b) => a + b, 0);
        e.img = bmp;
      }).catch(() => { e.failed = true; setTimeout(() => modelCache.delete(key), 20000); });
      if (modelCache.size > 600) { const k = modelCache.keys().next().value; modelCache.delete(k); }
    }
    return e.img ? e : null;
  }

  // ------------------------------------------------------------------ UI: sprites + bitmap fonts
  let UI = null, uiLoading = false, uiError = '';
  const spr = {};
  function loadUi() {
    if (UI || uiLoading) return;
    uiLoading = true;
    fetch('/lite/ui.json').then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((u) => {
      const frame = new Image(); frame.src = u.frame;
      const sprites = {};
      for (const [k, s] of Object.entries(u.sprites)) { const im = new Image(); im.src = s.u; sprites[k] = { img: im, x: s.x, y: s.y, w: s.w, h: s.h }; }
      const fonts = {};
      for (const [k, f] of Object.entries(u.fonts)) { const im = new Image(); im.src = f.u; fonts[k] = { img: im, height: f.height, g: f.glyphs, tint: new Map() }; }
      Object.assign(spr, sprites);
      UI = { frame, fonts, countco: u.countco || {}, stack: new Set(u.stack || []) };
    }).catch((e) => { uiError = `game art unavailable (${e})`; setTimeout(() => { uiLoading = false; }, 10000); });
  }
  function plot(ctx, name, x, y) { const s = spr[name]; if (s && s.img.complete) ctx.drawImage(s.img, x + s.x, y + s.y); }
  function tinted(font, rgb) {
    let c = font.tint.get(rgb);
    if (!c) {
      if (!font.img.complete || !font.img.naturalWidth) return null;
      c = document.createElement('canvas'); c.width = font.img.naturalWidth; c.height = font.img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(font.img, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = hex(rgb); x.fillRect(0, 0, c.width, c.height);
      font.tint.set(rgb, c);
    }
    return c;
  }
  const font = (n) => UI?.fonts[n];
  function textWidth(fn, str) {
    const f = font(fn); if (!f) return str.length * 6;
    let w = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '@' && i + 4 < str.length && str[i + 4] === '@') { i += 4; continue; }
      const g = f.g[str.charCodeAt(i)]; w += g ? g[5] : 4;
    }
    return w;
  }
  // PixFont.drawStringTag: y is the baseline, @col@ tags switch colour, optional 1px black shadow
  function drawText(ctx, fn, str, x, y, rgb, shadow = false, centre = false, right = false) {
    const f = font(fn); if (!f || str == null) return;
    str = String(str);
    if (centre) x -= (textWidth(fn, str) / 2) | 0;
    else if (right) x -= textWidth(fn, str);
    x |= 0; y = (y | 0) - f.height;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '@' && i + 4 < str.length && str[i + 4] === '@') { const c = COL[str.slice(i + 1, i + 4)]; if (c !== undefined) rgb = c; i += 4; continue; }
      const code = str.charCodeAt(i), g = f.g[code];
      if (!g) { x += 4; continue; }
      if (code !== 32 && g[1] && g[2]) {
        if (shadow) { const sh = tinted(f, 0); if (sh) ctx.drawImage(sh, g[0], 0, g[1], g[2], x + g[3] + 1, y + g[4] + 1, g[1], g[2]); }
        const t = tinted(f, rgb); if (t) ctx.drawImage(t, g[0], 0, g[1], g[2], x + g[3], y + g[4], g[1], g[2]);
      }
      x += g[5];
    }
  }
  const invNumber = (n) => (n < 100000 ? String(n) : n < 10000000 ? ((n / 1000) | 0) + 'K' : ((n / 1000000) | 0) + 'M');
  function iconFor(id, count) {
    const co = UI?.countco[id];
    if (co && count > 1) { let pick = -1; for (let i = 0; i < 10; i++) if (count >= co[0][i] && co[0][i] !== 0) pick = co[1][i]; if (pick > 0) id = pick; }
    return image(`/lite/icon/${id}.png`);
  }

  // ------------------------------------------------------------------ interfaces (port of Client.drawInterface)
  function ifVar(env, com, sid) {
    const script = com.scripts?.[sid];
    if (!com.scripts || sid >= com.scripts.length) return -2;
    if (!script) return -1;
    let acc = 0, pc = 0, arith = 0;
    for (let guard = 0; guard < 200; guard++) {
      let reg = 0, next = 0;
      const op = script[pc++];
      if (op === 0 || op === undefined) return acc;
      if (op === 1) reg = env.stat(script[pc++], 0);
      else if (op === 2) reg = env.stat(script[pc++], 1);
      else if (op === 3) reg = env.stat(script[pc++], 2);
      else if (op === 4) { const c = script[pc++], o = script[pc++]; reg = env.invCount(c, o); }
      else if (op === 5) reg = env.varp(script[pc++]);
      else if (op === 6) reg = LEVEL_XP[env.stat(script[pc++], 1) - 1] ?? 0;
      else if (op === 7) reg = ((env.varp(script[pc++]) * 100) / 46875) | 0;
      else if (op === 8) reg = env.combat();
      else if (op === 9) { for (let i = 0; i < 21; i++) if (i !== 18 && i !== 19) reg += env.stat(i, 1); }
      else if (op === 10) { const c = script[pc++], o = script[pc++]; reg = env.invCount(c, o) > 0 ? 999999999 : 0; }
      else if (op === 11) reg = env.run();
      else if (op === 12) reg = env.weight();
      else if (op === 13) { const v = env.varp(script[pc++]), b = script[pc++]; reg = (v & (1 << b)) === 0 ? 0 : 1; }
      else if (op === 14) { pc++; reg = 0; }
      else if (op === 15) next = 1; else if (op === 16) next = 2; else if (op === 17) next = 3;
      else if (op === 18) reg = env.coord(0); else if (op === 19) reg = env.coord(1);
      else if (op === 20) reg = script[pc++];
      if (next === 0) {
        if (arith === 0) acc += reg; else if (arith === 1) acc -= reg; else if (arith === 2 && reg !== 0) acc = (acc / reg) | 0; else if (arith === 3) acc = (acc * reg) | 0;
        arith = 0;
      } else arith = next;
    }
    return acc;
  }
  function ifActive(env, com) {
    if (!com.cmp) return false;
    for (let i = 0; i < com.cmp.length; i++) {
      if (!com.opnd) return false;
      const v = ifVar(env, com, i), o = com.opnd[i], c = com.cmp[i];
      if (c === 2) { if (v >= o) return false; } else if (c === 3) { if (v <= o) return false; } else if (c === 4) { if (v === o) return false; } else if (v !== o) return false;
    }
    return true;
  }
  const ifSprites = new Map();
  function ifSprite(tree, key) {
    if (!key) return null;
    const k = tree.root + ':' + key;
    let s = ifSprites.get(k);
    if (!s) { const d = tree.sprites[key]; if (!d) return null; const im = new Image(); im.src = d.u; s = { img: im, x: d.x, y: d.y }; ifSprites.set(k, s); }
    return s.img.complete ? s : null;
  }
  function drawScrollbar(ctx, x, y, scrollY, sh, h) {
    plot(ctx, 'scrollbar1', x, y); plot(ctx, 'scrollbar2', x, y + h - 16);
    ctx.fillStyle = hex(0x23201b); ctx.fillRect(x, y + 16, 16, h - 32);
    let grip = (((h - 32) * h) / sh) | 0; if (grip < 8) grip = 8;
    const gy = (((h - grip - 32) * scrollY) / Math.max(1, sh - h)) | 0;
    ctx.fillStyle = hex(0x4d4233); ctx.fillRect(x, y + gy + 16, 16, grip);
    ctx.fillStyle = hex(0x766654); ctx.fillRect(x, y + gy + 16, 2, grip); ctx.fillRect(x, y + gy + 16, 16, 2);
    ctx.fillStyle = hex(0x332d25); ctx.fillRect(x + 14, y + gy + 17, 2, grip - 1); ctx.fillRect(x + 1, y + gy + grip + 14, 15, 2);
  }
  function drawIf(ctx, tree, id, x, y, env, scroll = 0) {
    const com = tree.comps[id];
    if (!com || com.t !== 0 || !com.ch || com.hide) return;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, com.w, com.h); ctx.clip();
    for (const [cid, cx, cy] of com.ch) {
      const c = tree.comps[cid]; if (!c) continue;
      const X = cx + x + c.x, Y = cy + y - scroll + c.y;
      if (c.t === 0) {
        const sp = env.scroll?.[cid] ?? 0;
        drawIf(ctx, tree, cid, X, Y, env, sp);
        if (c.sh > c.h) drawScrollbar(ctx, X + c.w, Y, sp, c.sh, c.h);
      } else if (c.t === 2) {
        const items = env.inv[cid] || [];
        let slot = 0;
        for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++, slot++) {
          let sx = X + col * (c.mx + 32), sy = Y + row * (c.my + 32);
          const bg = c.bg?.[slot];
          if (slot < 20 && bg) { sx += bg[1]; sy += bg[2]; }
          const it = items[slot];
          if (it && it[0] >= 0) {
            const icon = iconFor(it[0], it[1]);
            if (icon) ctx.drawImage(icon, sx, sy);
            if (UI?.stack.has(it[0]) || it[1] !== 1) { drawText(ctx, 'p11', invNumber(it[1]), sx + 1, sy + 10, 0); drawText(ctx, 'p11', invNumber(it[1]), sx, sy + 9, 0xffff00); }
            env.hits?.push({ x: sx, y: sy, w: 32, h: 32, label: `@whi@${(c.iop?.[0] || 'Use')} @or1@${env.name?.(it[0]) ?? ''}` });
          } else if (slot < 20 && bg) {
            const s = ifSprite(tree, bg[0]); if (s) ctx.drawImage(s.img, sx + s.x, sy + s.y);
          }
        }
      } else if (c.t === 3) {
        const col = ifActive(env, c) ? c.c2 : c.c;
        ctx.fillStyle = hex(col);
        if (c.trans) ctx.globalAlpha = (256 - (c.trans & 0xff)) / 256;
        if (c.fill) ctx.fillRect(X, Y, c.w, c.h); else { ctx.strokeStyle = hex(col); ctx.lineWidth = 1; ctx.strokeRect(X + 0.5, Y + 0.5, c.w - 1, c.h - 1); }
        ctx.globalAlpha = 1;
      } else if (c.t === 4) {
        let text = env.text?.[cid] ?? c.txt;
        if (env.text?.[cid] === undefined && typeof text === 'string') text = text.replace(/: \+120$/, ':'); // server-set bonus values we can't see
        let col = c.c;
        if (ifActive(env, c)) { col = c.c2; if (c.txt2) text = c.txt2; }
        if (env.chat) { if (col === 0xffff00) col = 0xff; if (col === 0x00c000) col = 0xffffff; }
        const f = font(c.f || 'p12');
        if (!f || !text) continue;
        let t = String(text);
        t = t.replace(/%([1-5])/g, (_m, n) => { const v = ifVar(env, c, Number(n) - 1); return v < 999999999 ? String(v) : '*'; });
        let ly = Y + f.height;
        for (const line of t.split('\\n')) {
          if (c.ctr) drawText(ctx, c.f, line, X + ((c.w / 2) | 0), ly, col, !!c.sh2, true);
          else drawText(ctx, c.f, line, X, ly, col, !!c.sh2);
          ly += f.height;
        }
      } else if (c.t === 5) {
        const s = ifSprite(tree, ifActive(env, c) ? c.g2 : c.g);
        if (s) ctx.drawImage(s.img, X + s.x, Y + s.y);
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ world: ground mosaic, walls, projection
  const ground = { canvas: document.createElement('canvas'), key: '', ox: 0, oz: 0, n: 3, ready: false, missing: 0 };
  const GPX = 8; // ground texels per tile
  ground.canvas.width = ground.canvas.height = 64 * GPX * 3;
  function updateGround(px, pz) {
    const mx = px >> 6, mz = pz >> 6;
    const key = `${mx},${mz}`;
    if (ground.key !== key || ground.missing > 0) {
      const g = ground.canvas.getContext('2d');
      if (ground.key !== key) { g.fillStyle = '#000'; g.fillRect(0, 0, ground.canvas.width, ground.canvas.height); }
      let missing = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const im = image(`/lite/ground/${mx + dx}_${mz + dz}.png`);
        if (!im) { missing++; continue; }
        if (im.naturalWidth > 1) g.drawImage(im, (dx + 1) * 64 * GPX, (1 - dz) * 64 * GPX);
      }
      ground.key = key; ground.ox = (mx - 1) * 64; ground.oz = (mz + 2) * 64; ground.missing = missing; ground.ready = missing < 9;
    }
  }
  const minimapTex = { canvas: document.createElement('canvas'), key: '', missing: 0, ox: 0, oz: 0 };
  minimapTex.canvas.width = minimapTex.canvas.height = 64 * 4 * 3;
  function updateMinimapTex(px, pz) {
    const mx = px >> 6, mz = pz >> 6, key = `${mx},${mz}`;
    if (minimapTex.key !== key || minimapTex.missing > 0) {
      const g = minimapTex.canvas.getContext('2d');
      if (minimapTex.key !== key) { g.fillStyle = '#000'; g.fillRect(0, 0, 768, 768); }
      let missing = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const im = image(`/lite/map/${mx + dx}_${mz + dz}.png`);
        if (!im) { missing++; continue; }
        if (im.naturalWidth > 1) g.drawImage(im, (dx + 1) * 256, (1 - dz) * 256);
      }
      minimapTex.key = key; minimapTex.ox = (mx - 1) * 64; minimapTex.oz = (mz + 2) * 64; minimapTex.missing = missing;
    }
  }
  function wallsNear(px, pz) {
    const out = [];
    const mx = px >> 6, mz = pz >> 6;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const w = json(`/lite/walls/${mx + dx}_${mz + dz}.json`);
      if (!w) continue;
      const bx = (mx + dx) * 64, bz = (mz + dz) * 64;
      for (const [lx, lz, op] of w) { const x = bx + lx, z = bz + lz; if (Math.abs(x - px) <= 18 && Math.abs(z - pz) <= 18) out.push([x, z, op]); }
    }
    return out;
  }
  // wall opcode -> segments in tile-local units (x east, z north; tile spans 0..1); door = red on the world map
  function wallSegs(op) {
    let door = false;
    if ((op >= 5 && op <= 8) || (op >= 13 && op <= 16) || (op >= 21 && op <= 24)) { door = true; op -= 4; }
    if (op === 27 || op === 28) { door = true; op -= 2; }
    const W = [[0, 0, 0, 1]], N = [[0, 1, 1, 1]], E = [[1, 0, 1, 1]], S = [[0, 0, 1, 0]];
    const m = { 1: W, 2: N, 3: E, 4: S, 9: [...W, ...N], 10: [...E, ...N], 11: [...E, ...S], 12: [...W, ...S], 17: [[0, 1, 0.12, 1]], 18: [[0.88, 1, 1, 1]], 19: [[0.88, 0, 1, 0]], 20: [[0, 0, 0.12, 0]], 25: [[0, 0, 1, 1]], 26: [[0, 1, 1, 0]] };
    return { segs: m[op] || [], door };
  }

  // Camera: pinhole with a horizontal axis and a lens shift (verticals stay vertical, like the models' pre-rendered
  // pitch). The player stands D tiles in front of the camera; one tile there is 32 px, the model sprites' scale.
  const CAM = { f: 330, D: 10.3, H: 7.7, cx: VP.x + VP.w / 2, playerY: VP.y + 214 };
  CAM.horizon = CAM.playerY - CAM.H * CAM.f / CAM.D;
  function project(cam, wx, wz, h = 0) {
    const rx = wx - cam.x, rz = wz - cam.z;
    const lat = rx * cam.rx + rz * cam.rz, dep = rx * cam.fx + rz * cam.fz;
    if (dep < 0.6) return null;
    const k = CAM.f / dep;
    return { x: CAM.cx + lat * k, y: CAM.horizon + (CAM.H - h) * k, k: k / 32, d: dep };
  }

  // ------------------------------------------------------------------ the view
  class LiteView {
    constructor(canvas, hooks) {
      this.canvas = canvas; this.hooks = hooks || {};
      this.ctx = canvas.getContext('2d');
      this.account = null; this.scene = null; this.prev = null; this.sceneAt = 0; this.err = '';
      this.on = false; this.raf = 0; this.pollTimer = 0; this.lastDraw = 0;
      this.tab = 3; this.camYaw = 0; this.camVel = 0; this.mouse = null; this.hoverLabel = null;
      this.ents = new Map(); // key -> { x, z, tx, tz, sx, sz, yaw, moving, seen }
      this.splats = []; this.seenHits = new Set(); this.xpDrops = []; this.lastXp = null; this.levelUps = [];
      this.chatLines = []; this.chatSeen = new Set(); this.overhead = [];
      this.labels = null; this.fps = 30; this.list = { scroll: 0 };
    }
    // opts.tab: side tab to open (HQ_TAB, the fleet list, when arriving from HQ); opts.map: open on the fleet map
    start(account, opts = {}) {
      if (this.on && this.account === account) return;
      this.stop();
      this.account = account; this.on = true; this.scene = null; this.prev = null; this.err = ''; this.worldMap = !!opts.map;
      this.tab = opts.tab ?? this.tab ?? 3; this.list = { scroll: 0 };
      Fleet.sub(this);
      this.ents.clear(); this.splats = []; this.seenHits.clear(); this.xpDrops = []; this.lastXp = null; this.chatLines = []; this.chatSeen.clear(); this.overhead = [];
      if (opts.scene) this.ingest(opts.scene); // prefetched by the dashboard while the old view stayed up: no empty client
      loadUi();
      fitCanvas(this.canvas);
      this.poll();
      const loop = (t) => { if (!this.on) return; this.raf = requestAnimationFrame(loop); if (t - this.lastDraw < 1000 / this.fps - 2) return; this.lastDraw = t; this.draw(t); };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      this.on = false; cancelAnimationFrame(this.raf); clearTimeout(this.pollTimer); Fleet.unsub(this);
    }
    async poll() {
      if (!this.on) return;
      const acct = this.account;
      try {
        const r = await fetch(`/api/lite/scene?account=${encodeURIComponent(acct)}`, { cache: 'no-store' }); // explicit: HQ's minimap view runs while the page is on '@hq'
        const j = await r.json();
        if (acct !== this.account || !this.on) return;
        if (j.ok) { this.ingest(j.scene); this.err = ''; } else this.err = j.error || 'no state';
      } catch { this.err = 'dashboard unreachable'; }
      if (this.on && acct === this.account) this.pollTimer = setTimeout(() => this.poll(), document.visibilityState === 'hidden' ? 3000 : TICK_MS);
    }
    ingest(s) {
      const t = now();
      if (this.scene && this.scene.tick === s.tick && this.scene.rev === s.rev) return;
      this.prev = this.scene; this.scene = s; this.sceneAt = t;
      const seen = new Set();
      const track = (key, x, z, extra) => {
        seen.add(key);
        let e = this.ents.get(key);
        if (!e) { e = { x, z, sx: x, sz: z, tx: x, tz: z, yaw: 1024, moving: 0, born: t }; this.ents.set(key, e); }
        const cur = this.entPos(e, t);
        const jump = Math.hypot(x - cur.x, z - cur.z);
        if (jump > 12) { e.sx = e.tx = x; e.sz = e.tz = z; } // teleport: snap
        else { e.sx = cur.x; e.sz = cur.z; e.tx = x; e.tz = z; }
        e.t0 = t; e.speed = jump;
        if (jump > 0.05) { e.yaw = Math.atan2(-(x - cur.x), z - cur.z) * 1024 / Math.PI; e.movedAt = t; }
        Object.assign(e, extra);
        return e;
      };
      track('me', s.me.x, s.me.z, { kind: 'me' });
      for (const n of s.npcs) track('n' + n.i, n.x, n.z, { kind: 'npc', d: n });
      for (const p of s.players) if (p.n !== s.me.name) track('p' + p.i, p.x, p.z, { kind: 'player', d: p });
      for (const k of [...this.ents.keys()]) if (!seen.has(k)) this.ents.delete(k);
      // face what we work on: an adjacent loc/npc while animating, or the combat target
      const me = this.ents.get('me');
      if (me && (s.me.anim !== -1 || s.me.fight) && t - (me.movedAt || 0) > 900) {
        let target = null;
        if (s.me.fight && s.me.tgtType === 'npc') { const n = s.npcs.find((q) => q.i === s.me.tgt); if (n) target = [n.x, n.z]; }
        if (!target) {
          let best = 2.3;
          for (const l of s.locs) { const d = Math.hypot(l.x - s.me.x, l.z - s.me.z); if (d > 0 && d < best && l.op) { best = d; target = [l.x, l.z]; } }
          for (const n of s.npcs) { const d = Math.hypot(n.x - s.me.x, n.z - s.me.z); if (d > 0 && d < best && n.op) { best = d; target = [n.x, n.z]; } }
        }
        if (target) me.yaw = Math.atan2(-(target[0] - s.me.x), target[1] - s.me.z) * 1024 / Math.PI;
      }
      // hitsplats
      for (const h of s.hits) {
        const [id, type, dmg, tgtType, tgtIdx] = h;
        if (this.seenHits.has(id)) continue;
        this.seenHits.add(id);
        if (!this.prev) continue; // don't replay history on the first poll
        const key = tgtType === 'player' ? 'me' : tgtType === 'npc' ? 'n' + tgtIdx : 'p' + tgtIdx;
        const slot = this.splats.filter((q) => q.key === key && t - q.t < 1400).length % 4;
        this.splats.push({ key, dmg, t, slot, kind: type });
      }
      if (this.seenHits.size > 400) this.seenHits = new Set([...this.seenHits].slice(-200));
      // xp drops + level ups
      const xp = s.stats.map((q) => (q ? q[2] : 0)), lv = s.stats.map((q) => (q ? q[1] : 0));
      if (this.lastXp) for (let i = 0; i < xp.length; i++) {
        const d = xp[i] - this.lastXp.xp[i];
        if (d > 0 && d < 1e6) this.xpDrops.push({ skill: i, amt: d, t });
        if (lv[i] > this.lastXp.lv[i] && this.lastXp.lv[i] > 0) this.levelUps.push({ skill: i, level: lv[i], t });
      }
      this.lastXp = { xp, lv };
      // chat: newest last; overhead text for public chat
      for (const m of s.chat) {
        const [id, type, sender, text] = m;
        if (this.chatSeen.has(id)) continue;
        this.chatSeen.add(id);
        this.chatLines.push({ type, sender, text });
        if (this.prev && (type === 1 || type === 2)) {
          const key = sender === s.me.name ? 'me' : [...this.ents.entries()].find(([, e]) => e.kind === 'player' && e.d?.n === sender)?.[0];
          if (key) this.overhead.push({ key, text, t });
        }
      }
      if (this.chatLines.length > 100) this.chatLines.splice(0, this.chatLines.length - 100);
      if (this.chatSeen.size > 600) this.chatSeen = new Set([...this.chatSeen].slice(-300));
    }
    entPos(e, t) {
      const a = clamp((t - (e.t0 || 0)) / TICK_MS, 0, 1);
      return { x: e.sx + (e.tx - e.sx) * a, z: e.sz + (e.tz - e.sz) * a, moving: a < 1 && (e.speed || 0) > 0.05 };
    }

    // -------------------------------------------------------------- input (local only)
    // pointer: 'down' | 'move' | 'up' | 'leave' in 0..1 frame coordinates. A still 'up' is a click; drags pan the map.
    pointer(kind, fx, fy, button) {
      if (kind === 'leave') { this.mouse = null; FleetMap.drag = null; return true; }
      const x = fx * FW, y = fy * FH;
      this.mouse = { x, y };
      const inVp = x >= VP.x && x < VP.x + VP.w && y >= VP.y && y < VP.y + VP.h;
      const inList = this.tab === HQ_TAB && x >= SIDE.x && x < SIDE.x + 190 && y >= SIDE.y + 24 && y < SIDE.y + 261;
      if (kind === 'down') { this.downAt = { x, y }; this.listDrag = inList ? { y, scroll: this.list.scroll } : null; if (this.worldMap && inVp) FleetMap.down(x, y); return true; }
      if (kind === 'move') { const d = this.listDrag; if (d && Math.abs(y - d.y) > 4) { this.list.scroll = d.scroll - (y - d.y); return true; } if (this.worldMap) FleetMap.move(x, y); return true; }
      if (kind !== 'up') return true;
      this.listDrag = null;
      const h = this.hitAt(x, y);
      if (this.worldMap && FleetMap.drag) {
        const act = FleetMap.up(x, y, h);
        if (act?.select) { if (act.select === this.account) this.worldMap = false; else this.hooks.onSelect?.(act.select); }
        else if (act?.button) this.button(act.button);
        return true;
      }
      if (this.downAt && Math.hypot(x - this.downAt.x, y - this.downAt.y) > 8) return true; // a swipe, not a click
      if (h?.button) { this.button(h.button); return true; }
      if (h?.account) { if (h.account !== this.account) this.hooks.onSelect?.(h.account, { tab: this.tab }); return true; }
      for (let i = 0; i < TAB_HIT.length; i++) {
        const [a, b, c, d] = TAB_HIT[i];
        if (x >= a && x <= c && y >= b && y < d && i === HQ_TAB) { if (this.tab !== HQ_TAB) { this.tab = HQ_TAB; this.list = { scroll: 0 }; } return true; }
        if (x >= a && x <= c && y >= b && y < d && TAB_IF[i] !== -1) { this.tab = i; return true; }
      }
      if (button !== 'right' && x >= MAPA.x && x < MAPA.x + 40 && y >= MAPA.y && y < MAPA.y + 40) { this.camYaw = 0; return true; } // compass: face north
      if (((x - MM.cx) / MM.rx) ** 2 + ((y - MM.cy) / MM.ry) ** 2 <= 1) { this.toggleMap(); return true; } // minimap: the fleet map
      if (x >= 412 && x <= 506 && y >= 466 && y <= 501) { this.toggleMap(); return true; } // 'World map' (the Report abuse button)
      return true;
    }
    toggleMap() {
      this.worldMap = !this.worldMap;
      if (this.worldMap) FleetMap.centreOn(Fleet.get(this.account)?.pos ?? (this.scene ? [this.scene.me.x, this.scene.me.z] : null), Math.max(FleetMap.K, 2.5));
    }
    button(id) {
      if (listButton(id)) return;
      if (id === 'close') this.worldMap = false;
      else if (id === 'hq') this.hooks.onHq?.();
      else if (id === 'me') FleetMap.centreOn(Fleet.get(this.account)?.pos ?? (this.scene ? [this.scene.me.x, this.scene.me.z] : null));
      else FleetMap.button(id);
    }
    hitAt(x, y) { let r = null; for (const h of this.hits || []) if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) r = h; return r; }
    wheel(dy, mode, fx, fy) {
      const x = fx * FW, y = fy * FH;
      if (this.worldMap && x >= VP.x && x < VP.x + VP.w && y >= VP.y && y < VP.y + VP.h) { FleetMap.wheel(dy, mode, x, y); return true; }
      if (this.tab === HQ_TAB && x >= SIDE.x && x < SIDE.x + 190 && y >= SIDE.y && y < SIDE.y + 261) { this.list.scroll += Math.sign(dy) * Math.max(15, Math.min(60, Math.abs(dy))); return true; }
      return false;
    }
    pinch(f, fx, fy) { if (this.worldMap) FleetMap.pinch(f, fx * FW, fy * FH); }
    key(code, down) {
      if (this.worldMap) { if (down) FleetMap.keyPan(code); return true; }
      if (code === 'ArrowLeft' || code === 'ArrowRight') { this.camVel = down ? (code === 'ArrowLeft' ? -1 : 1) : 0; return true; } // same way round as the real client
      return false;
    }

    // -------------------------------------------------------------- frame
    draw(t) {
      const ctx = this.ctx;
      fitCanvas(this.canvas);
      ctx.imageSmoothingEnabled = false;
      if (this.camVel) this.camYaw = (this.camYaw + this.camVel * 24 + 2048) % 2048;
      if (!UI || !UI.frame.complete) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, FW, FH);
        drawFallback(ctx, uiError ? `Lite view: ${uiError} - retrying` : 'Loading game art…');
        this.hooks.onFrame?.();
        return;
      }
      ctx.drawImage(UI.frame, 0, 0);
      const s = this.scene;
      this.hits = [];
      if (!s) { this.drawLoading(ctx); this.hooks.onFrame?.(); return; }
      if (this.miniOnly) { this.drawMinimap(ctx, s, t); this.hits = [...(this.mmBadges || [])]; return; } // Bot HQ shows just this minimap
      if (this.worldMap) this.drawWorldMap(ctx, s, t); else this.drawWorld(ctx, s, t);
      this.drawMinimap(ctx, s, t);
      this.drawSide(ctx, s, t);
      this.drawChat(ctx, s, t);
      this.drawModal(ctx, s);
      this.drawHud(ctx, s, t);
      this.hooks.onFrame?.();
    }
    drawLoading(ctx) {
      ctx.fillStyle = '#000'; ctx.fillRect(VP.x, VP.y, VP.w, VP.h);
      drawText(ctx, 'b12', this.err ? `Lite client: ${this.err}` : 'Connecting to the lite client…', VP.x + VP.w / 2, VP.y + VP.h / 2, 0xffff00, true, true);
    }
    camera(s, t) {
      const me = this.ents.get('me');
      const p = me ? this.entPos(me, t) : { x: s.me.x, z: s.me.z };
      const ang = this.camYaw / 1024 * Math.PI;
      const fx = -Math.sin(ang), fz = Math.cos(ang);
      const px = p.x + 0.5, pz = p.z + 0.5;
      return { px, pz, x: px - fx * CAM.D, z: pz - fz * CAM.D, fx, fz, rx: fz, rz: -fx };
    }
    drawWorld(ctx, s, t) {
      const cam = this.camera(s, t);
      updateGround(Math.floor(cam.px), Math.floor(cam.pz));
      ctx.save();
      ctx.beginPath(); ctx.rect(VP.x, VP.y, VP.w, VP.h); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(VP.x, VP.y, VP.w, VP.h);
      // floor: one affine-mapped band per few screen rows (mode-7 style) from the stitched terrain texture
      if (ground.ready) {
        ctx.imageSmoothingEnabled = true;
        const G = ground.canvas, maxD = 30;
        const yStart = Math.max(VP.y, Math.ceil(CAM.horizon + CAM.H * CAM.f / maxD));
        for (let y = yStart; y < VP.y + VP.h;) {
          const d = CAM.H * CAM.f / (y + 0.5 - CAM.horizon);
          const band = d > 18 ? 1 : d > 9 ? 2 : 3;
          const k = CAM.f / d;                 // screen px per tile across the row
          const dy = -(CAM.H * CAM.f) / (d * d); // screen px per tile of depth (negative: farther = up)
          // texture (u,v) -> world (x,z): x = ox + u/GPX, z = oz - v/GPX; world -> screen (local linearisation at depth d)
          const cxw = cam.x + cam.fx * d, czw = cam.z + cam.fz * d; // world point at screen centre of this row
          const a = cam.rx * k / GPX, b = cam.fx * dy / GPX;   // d(sx)/du, d(sy)/du
          const c = -cam.rz * k / GPX, e = -cam.fz * dy / GPX; // d(sx)/dv, d(sy)/dv
          const u0 = (cxw - ground.ox) * GPX, v0 = (ground.oz - czw) * GPX;
          ctx.save();
          ctx.beginPath(); ctx.rect(VP.x, y, VP.w, band); ctx.clip();
          ctx.setTransform(a, b, c, e, CAM.cx - a * u0 - c * v0, y + 0.5 - b * u0 - e * v0);
          ctx.drawImage(G, 0, 0);
          ctx.restore();
          y += band;
        }
        ctx.imageSmoothingEnabled = false;
        // distance fog: fade the far floor to the black of the unloaded world, like the real client's draw distance
        const fy = Math.max(VP.y, CAM.horizon + CAM.H * CAM.f / maxD);
        const g = ctx.createLinearGradient(0, fy, 0, fy + 70);
        g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(VP.x, VP.y, VP.w, fy + 70 - VP.y);
      } else {
        drawText(ctx, 'b12', 'Loading map…', VP.x + VP.w / 2, VP.y + 30, 0xffff00, true, true);
      }

      // drawables, painter-sorted far to near
      const list = [];
      for (const [x, z, op] of wallsNear(cam.px, cam.pz)) {
        const { segs, door } = wallSegs(op);
        for (const [x1, z1, x2, z2] of segs) {
          const a = project(cam, x + x1, z + z1), b = project(cam, x + x2, z + z2);
          if (!a || !b) continue;
          list.push({ d: (a.d + b.d) / 2 + 0.01, draw: () => this.drawWall(ctx, cam, x + x1, z + z1, x + x2, z + z2, door) });
        }
      }
      for (const l of s.locs) {
        const p = project(cam, l.x + 0.5, l.z + 0.5); if (!p) continue;
        list.push({ d: p.d, draw: () => this.drawLoc(ctx, cam, l, p, t) });
      }
      for (const g of s.ground) {
        const p = project(cam, g.x + 0.5, g.z + 0.5); if (!p) continue;
        list.push({ d: p.d - 0.02, draw: () => { const im = iconFor(g.id, g.c); if (im) { const sz = 24 * p.k; ctx.imageSmoothingEnabled = true; ctx.drawImage(im, p.x - sz / 2, p.y - sz * 0.7, sz, sz); ctx.imageSmoothingEnabled = false; this.hit(p.x - sz / 2, p.y - sz * 0.7, sz, sz, `@whi@Take @or1@${g.n}`); } } });
      }
      // the local player's screen box: scenery in front of it is drawn see-through so the bot never disappears
      this.meBox = null;
      { const me = this.ents.get('me'); if (me) { const mp = this.entPos(me, t); const p = project(cam, mp.x + 0.5, mp.z + 0.5); if (p) this.meBox = { x0: p.x - 14 * p.k, x1: p.x + 14 * p.k, y0: p.y - 56 * p.k, y1: p.y, d: p.d }; } }
      for (const [key, e] of this.ents) {
        const pos = this.entPos(e, t);
        const sz = e.kind === 'npc' ? e.d.sz || 1 : 1;
        const p = project(cam, pos.x + sz / 2, pos.z + sz / 2); if (!p) continue;
        list.push({ d: p.d - 0.05, draw: () => this.drawEntity(ctx, cam, key, e, pos, p, s, t) });
      }
      list.sort((a, b) => b.d - a.d);
      for (const it of list) it.draw();
      this.drawOverlays(ctx, cam, s, t);
      ctx.restore();
    }
    drawWall(ctx, cam, x1, z1, x2, z2, door) {
      const h = door ? 1.25 : 1.55;
      const a = project(cam, x1, z1), b = project(cam, x2, z2), at = project(cam, x1, z1, h), bt = project(cam, x2, z2, h);
      if (!a || !b || !at || !bt) return;
      // light from the north-west: shade by the face direction relative to the camera
      const nx = -(z2 - z1), nz = x2 - x1;
      const lit = 0.62 + 0.25 * Math.abs((nx * 0.6 + nz * 0.8) / (Math.hypot(nx, nz) || 1));
      const fog = clamp(1.25 - a.d / 26, 0, 1);
      const base = door ? [112, 74, 44] : [128, 124, 116];
      const c = base.map((v) => Math.round(v * lit * fog));
      const mb = this.meBox;
      const see = mb && (a.d + b.d) / 2 < mb.d && Math.min(a.x, b.x) < mb.x1 && Math.max(a.x, b.x) > mb.x0 && Math.min(at.y, bt.y) < mb.y1 && Math.max(a.y, b.y) > mb.y0;
      ctx.globalAlpha = see ? 0.45 : 1;
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(at.x, at.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = `rgba(0,0,0,${0.35 * fog})`; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${0.12 * fog})`; ctx.fillRect(Math.min(at.x, bt.x), Math.min(at.y, bt.y) - 1, Math.abs(bt.x - at.x) + 1, 2);
      ctx.globalAlpha = 1;
    }
    sprite(spec, p, t, phase = 0, alpha = 1) {
      const m = model(spec);
      if (!m) return null;
      const M = m.meta;
      let f = 0;
      if (M.n > 1) { let tt = Math.floor((t + phase) / 20) % M.total; while (f < M.n - 1 && tt >= M.delays[f]) { tt -= M.delays[f]; f++; } }
      const k = p.k;
      const w = M.fw * k, h = M.fh * k;
      const x = p.x - M.ax * k, y = p.y - M.ay * k;
      if (alpha < 1) this.ctx.globalAlpha = alpha;
      this.ctx.imageSmoothingEnabled = k < 0.98;
      this.ctx.drawImage(m.img, f * M.fw, 0, M.fw, M.fh, x, y, w, h);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.globalAlpha = 1;
      return { x, y, w, h, top: y };
    }
    drawLoc(ctx, cam, l, p, t) {
      const spec = { kind: 'loc', id: l.id, dir: 0 };
      const m = model(spec);
      if (m?.meta.skip) { this.hit(p.x - 16 * p.k, p.y - 40 * p.k, 32 * p.k, 40 * p.k, `@whi@${l.op || 'Examine'} @cya@${l.n}`); return; } // wall/door: extruded
      const sz = m?.meta.size;
      if (sz && (sz[0] > 1 || sz[1] > 1)) p = project(cam, l.x + sz[0] / 2, l.z + sz[1] / 2) || p; // multi-tile locs stand on their centre
      let alpha = 1;
      const mb = this.meBox, M = m?.meta;
      if (mb && M && p.d < mb.d) { const x = p.x - M.ax * p.k, y = p.y - M.ay * p.k; if (x < mb.x1 && x + M.fw * p.k > mb.x0 && y < mb.y1 && y + M.fh * p.k > mb.y0) alpha = 0.42; }
      const rect = this.sprite(spec, p, t, l.x * 37 + l.z * 11, alpha);
      if (rect) this.hit(rect.x, rect.y, rect.w, rect.h, `@whi@${l.op || 'Examine'} @cya@${l.n}`);
    }
    relDir(yaw) { return ((Math.round((yaw - this.camYaw) / 256) % 8) + 8) % 8; }
    drawEntity(ctx, cam, key, e, pos, p, s, t) {
      // blob shadow
      ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 13 * p.k * (e.kind === 'npc' ? e.d.sz || 1 : 1), 5 * p.k, 0, 0, 7); ctx.fill();
      const moving = pos.moving;
      const dir = this.relDir(e.yaw);
      let rect = null, label = '';
      if (e.kind === 'me' || e.kind === 'player') {
        const isMe = e.kind === 'me';
        const anim = isMe ? s.me.anim : -1;
        const run = (e.speed || 0) > 1.6;
        const seq = anim !== -1 ? anim : moving ? (run ? 824 : 819) : 808;
        const equip = isMe ? s.worn.map((w) => [w[0], w[1]]) : [];
        const seed = isMe ? s.me.name : e.d.n;
        rect = this.sprite({ kind: 'player', equip, seed, seq, dir }, p, t) || this.sprite({ kind: 'player', equip, seed, seq: 808, dir }, p, t);
        label = isMe ? null : `@whi@Follow @whi@${e.d.n}@gre@ (level-${e.d.cb})`;
      } else {
        const n = e.d;
        const seq = n.anim !== -1 ? n.anim : moving ? -2 : -1;
        rect = this.sprite({ kind: 'npc', id: n.id, seq, dir }, p, t, n.i * 131) || this.sprite({ kind: 'npc', id: n.id, seq: -1, dir }, p, t);
        label = `@whi@${n.op || 'Examine'} @yel@${n.n}${n.cb ? ` @gre@(level-${n.cb})` : ''}`;
      }
      if (!rect) { // model still rendering: a faint marker where it stands
        ctx.fillStyle = e.kind === 'npc' ? 'rgba(255,255,0,.35)' : 'rgba(255,255,255,.35)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y - 2 * p.k, 6 * p.k, 3 * p.k, 0, 0, 7); ctx.fill();
        rect = { x: p.x - 10 * p.k, y: p.y - 48 * p.k, w: 20 * p.k, h: 48 * p.k, top: p.y - 48 * p.k };
      }
      e.screen = { x: p.x, top: rect.top, mid: rect.top + rect.h * 0.45, k: p.k };
      if (label) this.hit(rect.x, rect.y, rect.w, rect.h, label);
    }
    drawOverlays(ctx, cam, s, t) {
      // health bars (while fighting) and hitsplats, as Client.drawEntityOverlays
      for (const [key, e] of this.ents) {
        if (!e.screen) continue;
        const fighting = key === 'me' ? s.me.fight || s.me.hp < s.me.maxHp && this.splats.some((q) => q.key === 'me' && t - q.t < 6000) : e.kind === 'npc' && (e.d.fight || e.d.hp != null && e.d.hp < 100);
        if (fighting) {
          const pct = key === 'me' ? s.me.hp / Math.max(1, s.me.maxHp) : (e.d.hp ?? 100) / 100;
          const w = Math.round(clamp(pct, 0, 1) * 30), x = Math.round(e.screen.x - 15), y = Math.round(e.screen.top - 12);
          ctx.fillStyle = '#00ff00'; ctx.fillRect(x, y, w, 5); ctx.fillStyle = '#ff0000'; ctx.fillRect(x + w, y, 30 - w, 5);
        }
      }
      this.splats = this.splats.filter((q) => t - q.t < 1400);
      for (const q of this.splats) {
        const e = this.ents.get(q.key); if (!e?.screen) continue;
        let x = e.screen.x, y = e.screen.mid;
        if (q.slot === 1) y -= 20; else if (q.slot === 2) { x -= 15; y -= 10; } else if (q.slot === 3) { x += 15; y -= 10; }
        plot(ctx, q.dmg > 0 ? 'hitmarks1' : 'hitmarks0', Math.round(x - 12), Math.round(y - 12));
        drawText(ctx, 'p11', String(q.dmg), x, y + 4, 0, false, true); drawText(ctx, 'p11', String(q.dmg), x - 1, y + 3, 0xffffff, false, true);
      }
      // overhead public chat (yellow, b12)
      this.overhead = this.overhead.filter((o) => t - o.t < 3000);
      for (const o of this.overhead) {
        const e = this.ents.get(o.key); if (!e?.screen) continue;
        drawText(ctx, 'b12', o.text, e.screen.x, e.screen.top - 4, 0xffff00, true, true);
      }
      // xp drops: rise from the player's head (not in the 2004 client, but it is the best tell of what the bot is doing)
      const me = this.ents.get('me');
      this.xpDrops = this.xpDrops.filter((d) => t - d.t < 2200);
      if (me?.screen) this.xpDrops.forEach((d, i) => {
        const a = (t - d.t) / 2200, y = me.screen.top - 18 - a * 46 - i * 2;
        ctx.globalAlpha = a > 0.75 ? (1 - a) * 4 : 1;
        drawText(ctx, 'b12', `+${d.amt.toLocaleString('en-US')} ${SKILL_NAMES[d.skill]} xp`, me.screen.x + 26, y, 0xffffff, true, false);
        ctx.globalAlpha = 1;
      });
      // level up: fireworks + the 2004 congratulations line
      this.levelUps = this.levelUps.filter((u) => t - u.t < 4000);
      for (const u of this.levelUps) {
        if (!me?.screen) break;
        const a = (t - u.t) / 4000;
        for (let i = 0; i < 26; i++) {
          const ang = i / 26 * Math.PI * 2 + u.skill, r = 8 + a * 60;
          ctx.fillStyle = `hsla(${(i * 40 + u.skill * 25) % 360},100%,60%,${1 - a})`;
          ctx.fillRect(me.screen.x + Math.cos(ang) * r, me.screen.top + 10 + Math.sin(ang) * r * 0.7 - a * 20, 3, 3);
        }
        drawText(ctx, 'b12', `${SKILL_NAMES[u.skill]} level ${u.level}!`, me.screen.x, me.screen.top - 40 - a * 10, 0xffb000, true, true);
      }
    }
    hit(x, y, w, h, label) { this.hits.push({ x, y, w, h, label }); }

    // World map (click the minimap): the 2004 world map around the bot at 2 px per tile, with its place names.
    // the minimap opens the fleet map (every account), centred on this one; another account's marker follows it
    drawWorldMap(ctx, s, t) {
      FleetMap.draw(ctx, t, this.hits, { focus: this.account, hover: this.hoverAccount,
        buttons: [['Bot HQ', 'hq', 'Open Bot HQ (all accounts)'], [`Find ${this.account}`, 'me', 'Centre on this account'], ['Close map', 'close', 'Back to the game view']] });
    }

    drawMinimap(ctx, s, t) {
      const me = this.ents.get('me');
      const pos = me ? this.entPos(me, t) : { x: s.me.x, z: s.me.z };
      updateMinimapTex(Math.floor(pos.x), Math.floor(pos.z));
      const ang = this.camYaw / 1024 * Math.PI;
      ctx.save();
      ctx.beginPath(); ctx.ellipse(MM.cx, MM.cy, MM.rx, MM.ry, 0, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(MM.cx - MM.rx, MM.cy - MM.ry, MM.rx * 2, MM.ry * 2);
      ctx.translate(MM.cx, MM.cy); ctx.rotate(ang);
      const u = (pos.x + 0.5 - minimapTex.ox) * 4, v = (minimapTex.oz - pos.z - 0.5) * 4;
      ctx.drawImage(minimapTex.canvas, -u, -v);
      ctx.rotate(-ang); ctx.translate(-MM.cx, -MM.cy);
      const dot = (name, wx, wz) => {
        const dx = (wx - pos.x) * 4, dz = (wz - pos.z) * 4;
        if (dx * dx + dz * dz > 6400) return;
        const sx = dx * Math.cos(ang) + dz * Math.sin(ang), sy = -dz * Math.cos(ang) + dx * Math.sin(ang);
        const sp = spr[name]; if (!sp) return;
        ctx.drawImage(sp.img, Math.round(MM.cx + sx - 2), Math.round(MM.cy + sy - 2));
      };
      for (const g of s.ground) dot('mapdots0', g.x + 0.5, g.z + 0.5);
      for (const [k, e] of this.ents) { if (k === 'me') continue; const p = this.entPos(e, t); dot(e.kind === 'npc' ? 'mapdots1' : 'mapdots2', p.x + 0.5, p.z + 0.5); }
      // fleet = friends: the HQ map's skill badges (hover: info, click: follow), or green dots with the setting off
      this.mmBadges = [];
      for (const a of Fleet.accounts()) {
        if (a.name === this.account || !a.pos || a.pos[2] !== s.me.lvl) continue;
        if (!mmBadges) { dot('mapdots3', a.pos[0] + 0.5, a.pos[1] + 0.5); continue; }
        const dx = (a.pos[0] - pos.x) * 4, dz = (a.pos[1] - pos.z) * 4;
        if (dx * dx + dz * dz > 68 * 68) continue;
        const x = MM.cx + dx * Math.cos(ang) + dz * Math.sin(ang), y = MM.cy - dz * Math.cos(ang) + dx * Math.sin(ang);
        drawSkillBadge(ctx, a, x, y, 7, this.hoverAccount === a.name);
        this.mmBadges.push({ x: x - 7, y: y - 7, w: 14, h: 14, label: `@whi@Follow @yel@${a.name}`, account: a.name });
      }
      ctx.restore();
      ctx.fillStyle = '#fff'; ctx.fillRect(MAPA.x + 97, MAPA.y + 78, 3, 3);
      // compass (rotates with the camera), clipped to its round socket
      const c = spr.compass;
      if (c) { ctx.save(); ctx.beginPath(); ctx.arc(MAPA.x + 25 - 8, MAPA.y + 25 - 8, 16.5, 0, Math.PI * 2); ctx.clip(); ctx.translate(MAPA.x + 17, MAPA.y + 17); ctx.rotate(ang); ctx.drawImage(c.img, -c.w / 2, -c.h / 2); ctx.restore(); }
      // where am I: nearest world-map label, as a quiet caption under the orb
      if (!this.labels) this.labels = json('/lite/labels.json');
      if (this.labels && s.me.z < 6400) {
        let best = null, bd = 60 * 60;
        for (const l of this.labels) { const d = (l.x - s.me.x) ** 2 + (l.z - s.me.z) ** 2; if (l.s < 2 && d < bd) { bd = d; best = l; } }
        if (best) drawText(ctx, 'p11', best.t.replace('/', ' '), MAPA.x + 98, MAPA.y + 154, 0xffb000, true, true);
      }
    }
    env(s) {
      const inv = {};
      const slots = (list, n) => { const a = new Array(n); for (const [slot, id, c] of list) if (slot < n) a[slot] = [id, c]; return a; };
      inv[INV_COM.inv] = inv[INV_COM.bankSide] = inv[INV_COM.shopSide] = inv[INV_COM.tradeSide] = slots(s.inv, 28);
      inv[INV_COM.worn] = slots(s.worn, 14);
      if (s.bank) inv[INV_COM.bank] = slots(s.bank.items, 800);
      if (s.shop) inv[INV_COM.shop] = slots(s.shop.items, 40);
      if (s.trade) { inv[INV_COM.tradeMine] = slots(s.trade.mine, 28); inv[INV_COM.tradeTheirs] = slots(s.trade.theirs, 28); }
      return {
        inv, hits: this.hits,
        stat: (i, which) => s.stats[i]?.[which] ?? 0,
        varp: (id) => (id >= 83 && id <= 97 ? (s.prayers[id - 83] ? 1 : 0) : 0),
        invCount: (com, obj) => (inv[com] || []).reduce((a, it) => a + (it && it[0] === obj ? it[1] : 0), 0),
        combat: () => s.me.cb, run: () => s.me.run, weight: () => s.me.weight,
        coord: (axis) => (axis ? s.me.z : s.me.x),
        name: (id) => s.names?.[id] ?? '',
      };
    }
    drawSide(ctx, s, t) {
      // tab row highlights + icons (Client: redstones under the active tab, sideicons on top)
      const top = [['redstone1', 22, 10], ['redstone2', 54, 8], ['redstone2', 82, 8], ['redstone3', 110, 8], ['redstone2h', 153, 8], ['redstone2h', 181, 8], ['redstone1h', 209, 9]];
      const bot = [['redstone1v', 42, 0], ['redstone2v', 74, 0], ['redstone2v', 102, 0], ['redstone3v', 130, 1], ['redstone2hv', 173, 0], ['redstone2hv', 201, 0], ['redstone1hv', 229, 0]];
      if (this.tab < 7) { const [n, x, y] = top[this.tab]; plot(ctx, n, 516 + x, 160 + y); } else { const [n, x, y] = bot[this.tab - 7]; plot(ctx, n, 496 + x, 466 + y); }
      [[29, 13], [53, 11], [82, 11], [115, 12], [153, 13], [180, 11], [208, 13]].forEach(([x, y], i) => plot(ctx, 'sideicons' + i, 516 + x, 160 + y));
      [[74, 2], [102, 3], [137, 4], [174, 2], [201, 2], [226, 2]].forEach(([x, y], i) => plot(ctx, 'sideicons' + (i + 7), 496 + x, 466 + y));
      // panel: the side modal while a bank/shop/trade is open, else the selected tab's interface
      for (let i = 0; i < TAB_HIT.length; i++) { const [a, b, c, d] = TAB_HIT[i]; if (TAB_NAMES[i]) this.hit(a, b, c - a, d - b, `@whi@${TAB_NAMES[i]}`); }
      this.hit(MM.cx - 50, MM.cy - 50, 100, 100, this.worldMap ? '@whi@Close @or1@Map' : '@whi@Open @or1@Map @whi@(all accounts)');
      for (const b of this.mmBadges || []) this.hits.push(b); // over the minimap's own hit (last hit wins)
      drawWorldBtn(ctx);
      this.hits.push({ x: WORLD_BTN.cx - WORLD_BTN.r, y: WORLD_BTN.cy - WORLD_BTN.r, w: WORLD_BTN.r * 2, h: WORLD_BTN.r * 2, label: '@whi@World map: @yel@Bot HQ @whi@(every account)', button: 'hq' });
      drawHqTab(ctx, this.tab === HQ_TAB);
      // HQ tab: the fleet list, even over a bank/shop/trade side panel (the modal still shows in the game view)
      if (this.tab === HQ_TAB) { drawFleetList(ctx, this.hits, { focus: this.account, hover: this.hoverAccount, state: this.list }); return; }
      const side = s.bank ? 2005 : s.shop ? 3822 : s.trade ? 3321 : TAB_IF[this.tab];
      const tree = side > 0 ? json(`/lite/if/${side}.json`) : null;
      if (tree) drawIf(ctx, tree, tree.root, SIDE.x, SIDE.y, this.env(s));
    }
    drawChat(ctx, s, t) {
      const x0 = CHAT.x, y0 = CHAT.y;
      const d = s.dialog;
      if (d && (d.comps?.length || d.text || d.options?.length)) { this.drawDialog(ctx, s, d); }
      else {
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, 463, 77); ctx.clip();
        let line = 0;
        for (let i = this.chatLines.length - 1; i >= 0 && line < 6; i--) {
          const m = this.chatLines[i], y = y0 + 70 - line * 14;
          if (m.type === 0) drawText(ctx, 'p12', m.text, x0 + 4, y, 0);
          else if (m.type === 1 || m.type === 2) { const who = `${m.sender}:`; drawText(ctx, 'p12', who, x0 + 4, y, 0); drawText(ctx, 'p12', m.text, x0 + 4 + textWidth('p12', m.sender) + 8, y, 0xff); }
          else if (m.type === 3 || m.type === 7) { drawText(ctx, 'p12', `From ${m.sender}:`, x0 + 4, y, 0); drawText(ctx, 'p12', m.text, x0 + 4 + textWidth('p12', `From ${m.sender}`) + 8, y, 0x800000); }
          else if (m.type === 6) { drawText(ctx, 'p12', `To ${m.sender}:`, x0 + 4, y, 0); drawText(ctx, 'p12', m.text, x0 + 12 + textWidth('p12', `To ${m.sender}`), y, 0x800000); }
          else if (m.type === 4 || m.type === 8) drawText(ctx, 'p12', `${m.sender} ${m.text}`, x0 + 4, y, m.type === 4 ? 0x800080 : 0x7e3200);
          else drawText(ctx, 'p12', m.text, x0 + 4, y, 0x800000);
          line++;
        }
        ctx.restore();
        drawScrollbar(ctx, x0 + 463, y0, 0, 78, 77);
        // input line: the bot's current activity, as if it were typing its status (never sent anywhere)
        const name = s.me.name || 'Bot';
        drawText(ctx, 'p12', `${name}:`, x0 + 4, y0 + 90, 0);
        const act = (s.activity || '').replace(/^[a-z]+ · /i, '').replace(/[@]/g, '');
        const room = 470 - textWidth('p12', `${name}: `) - 6;
        let txt = act; while (txt && textWidth('p12', txt + '*') > room) txt = txt.slice(0, -1);
        drawText(ctx, 'p12', txt + (Math.floor(t / 500) % 2 ? '*' : ''), x0 + 6 + textWidth('p12', `${name}: `), y0 + 90, 0xff);
        ctx.fillStyle = '#000'; ctx.fillRect(x0, y0 + 77, 479, 1);
      }
      // chat-mode bar (backbase1): the lite client has no settings to read, so show the defaults
      const bx = 0, by = 453;
      drawText(ctx, 'p12', 'Public chat', bx + 55, by + 28, 0xffffff, true, true); drawText(ctx, 'p12', 'On', bx + 55, by + 41, 0xff00, true, true);
      drawText(ctx, 'p12', 'Private chat', bx + 184, by + 28, 0xffffff, true, true); drawText(ctx, 'p12', 'On', bx + 184, by + 41, 0xff00, true, true);
      drawText(ctx, 'p12', 'Trade/duel', bx + 324, by + 28, 0xffffff, true, true); drawText(ctx, 'p12', 'On', bx + 324, by + 41, 0xff00, true, true);
      // the Report abuse button opens the fleet map (Bot HQ itself is the HQ tab beside the smiley)
      drawText(ctx, 'p12', this.worldMap ? 'Close' : 'World', bx + 458, by + 28, 0xffffff, true, true); drawText(ctx, 'p12', 'map', bx + 458, by + 41, 0xffff00, true, true);
      this.hit(412, 466, 94, 35, this.worldMap ? '@whi@Close the map' : '@whi@Open the @or1@World map @whi@(every account)');
    }
    drawDialog(ctx, s, d) {
      // the real chat interface when we know its components, with the texts the server set; else a plain rendering
      const comp = d.comps?.find((c) => c[0] > 0);
      const tree = comp ? json(`/lite/if/${comp[0]}.json`) : null;
      if (tree) {
        const env = this.env(s); env.chat = true; env.text = {};
        for (const [id, , text] of d.comps) if (text) env.text[id] = text;
        drawIf(ctx, tree, tree.root, CHAT.x, CHAT.y, env);
        return;
      }
      const lines = [...(d.text ? d.text.split('\n') : []), ...(d.options || []).map((o, i) => `${i + 1}. ${o}`)];
      lines.slice(0, 5).forEach((l, i) => drawText(ctx, 'p12', l, CHAT.x + 239, CHAT.y + 22 + i * 15, i === 0 && d.text ? 0x800000 : 0, false, true));
      if (d.waiting) drawText(ctx, 'p12', 'Click here to continue', CHAT.x + 239, CHAT.y + 90, 0xff, false, true);
    }
    drawModal(ctx, s) {
      const main = s.bank ? 5292 : s.shop ? 3824 : s.trade ? (s.trade.screen === 'confirm' ? 3443 : 3323) : s.iface?.id > 0 ? s.iface.id : -1;
      if (main < 0) return;
      const tree = json(`/lite/if/${main}.json`);
      if (!tree) return;
      const env = this.env(s);
      env.text = {};
      if (s.trade?.partner) env.text[3417] = `Trading With: ${s.trade.partner}`;
      ctx.save(); ctx.beginPath(); ctx.rect(VP.x, VP.y, VP.w, VP.h); ctx.clip();
      drawIf(ctx, tree, tree.root, VP.x, VP.y, env);
      ctx.restore();
    }
    drawHud(ctx, s, t) {
      // hover: the hit list is built front-to-back as drawn, so the last match is on top - like the client's menu
      const h = this.mouse ? this.hitAt(this.mouse.x, this.mouse.y) : null;
      this.hoverAccount = h?.account ?? null;
      let label = h?.label ?? null;
      const inVp = this.mouse && this.mouse.x >= VP.x && this.mouse.x < VP.x + VP.w && this.mouse.y >= VP.y && this.mouse.y < VP.y + VP.h;
      if (!label && inVp) label = this.worldMap ? '@whi@Drag to move · scroll or pinch to zoom · click an account to follow it' : '@whi@Walk here';
      if (label) drawText(ctx, 'b12', label, VP.x + 4, VP.y + 15, 0xffffff, true);
      if (this.hoverAccount && this.hoverAccount !== this.account) drawAccountCard(ctx, Fleet.get(this.hoverAccount), this.mouse);
      // lite badge: this is a reconstruction from observed state, not the game's own picture
      const pulse = 0.55 + 0.45 * Math.sin(t / 420);
      const bw = 92, bx = VP.x + VP.w - bw - 4, by = VP.y + 4;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx, by, bw, 16);
      ctx.fillStyle = `rgba(111,207,138,${pulse})`; ctx.beginPath(); ctx.arc(bx + 8, by + 8, 3, 0, 7); ctx.fill();
      drawText(ctx, 'p11', 'LITE CLIENT', bx + 15, by + 12, 0x6fcf8a, true);
      if (this.hovering(bx, by, bw, 16)) drawText(ctx, 'p11', 'No game canvas: drawn from live state', bx + bw, by + 28, 0xffffff, true, false, true);
      // stale state warning
      const age = (s.ageMs ?? 0) + (now() - this.sceneAt);
      if (age > 6000 || this.err) drawText(ctx, 'b12', this.err ? `Lite client: ${this.err}` : `State ${Math.round(age / 1000)}s old`, VP.x + VP.w / 2, VP.y + VP.h - 8, 0xff3000, true, true);
      if (s.me.lvl > 0) drawText(ctx, 'p11', `Floor ${s.me.lvl} (ground floor map)`, VP.x + 6, VP.y + VP.h - 6, 0xffb000, true);
      if (s.me.dead) drawText(ctx, 'b12', 'Oh dear, you are dead!', VP.x + VP.w / 2, VP.y + VP.h / 2, 0xff0000, true, true);
    }
    hovering(x, y, w, h) { return !!this.mouse && this.mouse.x >= x && this.mouse.x < x + w && this.mouse.y >= y && this.mouse.y < y + h; }
  }
  // ------------------------------------------------------------------ Bot HQ: every account on one map
  // Shared by both views: Fleet (one /api/hq poller), FleetMap (one map whose position survives switching between HQ
  // and an account), and the fleet list. HQ shows the map in the game view; an account shows it when you click its
  // minimap and the list on its friends tab, so the whole fleet is always one click away.
  const HQ_POLL_MS = 2000;
  let overview = null; // { img, meta } of /lite/overview.png
  function loadOverview() {
    if (overview) return overview.img ? overview : null;
    overview = { img: null, meta: null };
    fetch('/lite/overview.png').then(async (r) => {
      if (!r.ok) throw new Error(String(r.status));
      overview.meta = JSON.parse(r.headers.get('x-lite-meta') || 'null');
      overview.img = await createImageBitmap(await r.blob());
    }).catch(() => { setTimeout(() => { overview = null; }, 20000); });
    return null;
  }
  const SKILL_SHORT = { Attack: 'Att', Defence: 'Def', Strength: 'Str', Hitpoints: 'HP', Ranged: 'Rng', Prayer: 'Pray', Magic: 'Mage', Cooking: 'Cook', Woodcutting: 'WC', Fletching: 'Flet', Fishing: 'Fish', Firemaking: 'FM', Crafting: 'Craft', Smithing: 'Smith', Mining: 'Mine', Herblore: 'Herb', Agility: 'Agil', Thieving: 'Thiev', Runecraft: 'RC' };
  const fmtK = (n) => (n == null || !isFinite(n) ? '-' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(Math.abs(n) >= 1e7 ? 0 : 1) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(Math.abs(n) >= 1e5 ? 0 : 1) + 'K' : String(Math.round(n)));
  // nearest named place (world-map labels) for a position; also used by the dashboard's HQ cards
  function placeName(x, z) {
    const labels = json('/lite/labels.json');
    if (!labels || z >= 6400) return z >= 6400 ? 'Underground' : '';
    let best = null, bd = 90 * 90;
    for (const l of labels) { const d = (l.x - x) ** 2 + (l.z - z) ** 2; if (l.s < 2 && d < bd) { bd = d; best = l; } }
    return best ? best.t.replace('/', ' ') : '';
  }

  const Fleet = {
    data: null, err: '', trails: new Map(), subs: new Set(), listeners: new Set(), timer: 0, busy: false,
    sub(o) { this.subs.add(o); if (this.subs.size === 1) { clearTimeout(this.timer); this.poll(); } },
    unsub(o) { this.subs.delete(o); if (!this.subs.size) clearTimeout(this.timer); },
    accounts(liteOnly = false) { return (this.data?.accounts || []).filter((a) => !liteOnly || a.lite); },
    get(name) { return this.data?.accounts.find((a) => a.name === name) || null; },
    async poll() {
      if (this.busy) return;
      this.busy = true;
      try {
        const d = await (await fetch('/api/hq', { cache: 'no-store' })).json();
        this.data = d; this.err = '';
        const t = Date.now();
        for (const a of d.accounts) {
          if (!a.pos) continue;
          const tr = this.trails.get(a.name) || [];
          const last = tr[tr.length - 1];
          if (!last || last[0] !== a.pos[0] || last[1] !== a.pos[1]) tr.push([a.pos[0], a.pos[1], t]);
          while (tr.length > 240 || (tr.length && t - tr[0][2] > 20 * 60_000)) tr.shift();
          this.trails.set(a.name, tr);
        }
        for (const f of this.listeners) f(d);
      } catch { this.err = 'dashboard unreachable'; }
      this.busy = false;
      clearTimeout(this.timer);
      if (this.subs.size) this.timer = setTimeout(() => this.poll(), document.visibilityState === 'hidden' ? 6000 : HQ_POLL_MS);
    },
  };

  // The fleet map. Zoom is continuous and always about a point (the cursor for wheel/pinch/double-click, the centre
  // for buttons); buttons, fit and "zoom into a crowd" glide there instead of jumping. The coarse whole-world image is
  // always drawn underneath, so detail squares fade in over it rather than leaving holes.
  const MAP_MIN_K = 0.3, MAP_MAX_K = 8;
  const FleetMap = {
    cx: 3150, cz: 3300, K: 1.5, anim: null, fitted: false, markers: [], drag: null, lastTap: 0,
    sx(x) { return VP.x + VP.w / 2 + (x - this.cx) * this.K; },
    sy(z) { return VP.y + VP.h / 2 - (z - this.cz) * this.K; },
    wx(px) { return this.cx + (px - (VP.x + VP.w / 2)) / this.K; },
    wz(py) { return this.cz - (py - (VP.y + VP.h / 2)) / this.K; },
    clampCentre() {
      const m = overview?.meta;
      if (m && this.cz < 6400) { this.cx = clamp(this.cx, m.x0, m.x0 + m.w); this.cz = clamp(this.cz, m.z1 - m.h, m.z1); }
    },
    // zoom by f keeping world point under (px, py) fixed
    zoomAt(f, px = VP.x + VP.w / 2, py = VP.y + VP.h / 2) {
      const k2 = clamp(this.K * f, MAP_MIN_K, MAP_MAX_K);
      const wx = this.wx(px), wz = this.wz(py);
      this.K = k2; this.cx = wx - (px - (VP.x + VP.w / 2)) / k2; this.cz = wz + (py - (VP.y + VP.h / 2)) / k2;
      this.anim = null; this.fitted = true; this.clampCentre();
    },
    glide(cx, cz, K) { this.anim = { from: { cx: this.cx, cz: this.cz, K: this.K }, to: { cx, cz, K: clamp(K, MAP_MIN_K, MAP_MAX_K) }, t0: now(), dur: 380 }; this.fitted = true; },
    glideZoom(f, px, py) { // like zoomAt, animated
      const k2 = clamp(this.K * f, MAP_MIN_K, MAP_MAX_K), wx = this.wx(px), wz = this.wz(py);
      this.glide(wx - (px - (VP.x + VP.w / 2)) / k2, wz + (py - (VP.y + VP.h / 2)) / k2, k2);
    },
    step() {
      const a = this.anim; if (!a) return;
      const u = clamp((now() - a.t0) / a.dur, 0, 1), e = 1 - (1 - u) ** 3; // ease out
      this.K = Math.exp(Math.log(a.from.K) + (Math.log(a.to.K) - Math.log(a.from.K)) * e);
      this.cx = a.from.cx + (a.to.cx - a.from.cx) * e; this.cz = a.from.cz + (a.to.cz - a.from.cz) * e;
      if (u >= 1) this.anim = null;
    },
    fitTargets(names = null, instant = false) {
      let use = Fleet.accounts(true).filter((a) => a.pos && a.pos[1] < 6400 && (!names || names.includes(a.name))).map((a) => a.pos);
      if (!use.length) use = Fleet.accounts().filter((a) => a.pos && a.pos[1] < 6400).map((a) => a.pos);
      if (!use.length) return;
      const xs = use.map((p) => p[0]), zs = use.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const K = clamp(Math.min((VP.w - 90) / Math.max(1, x1 - x0), (VP.h - 80) / Math.max(1, z1 - z0)), MAP_MIN_K, 4);
      if (instant) { this.cx = (x0 + x1) / 2; this.cz = (z0 + z1) / 2; this.K = K; this.fitted = true; } else this.glide((x0 + x1) / 2, (z0 + z1) / 2, K);
    },
    centreOn(pos, K = Math.max(this.K, 2.5), instant = false) {
      if (!pos) return;
      if (instant) { this.cx = pos[0] + 0.5; this.cz = pos[1] + 0.5; this.K = K; this.anim = null; this.fitted = true; } else this.glide(pos[0] + 0.5, pos[1] + 0.5, K);
    },
    // ---- input (frame coordinates). Returns an action for the caller: { select: name } | { button: id } | null
    down(x, y) { this.drag = { x, y, cx: this.cx, cz: this.cz, moved: false }; this.anim = null; },
    move(x, y) {
      const d = this.drag; if (!d) return;
      if (!d.moved && Math.hypot(x - d.x, y - d.y) > 4) d.moved = true;
      if (d.moved) { this.cx = d.cx - (x - d.x) / this.K; this.cz = d.cz + (y - d.y) / this.K; this.fitted = true; this.clampCentre(); }
    },
    up(x, y, hit) {
      const d = this.drag; this.drag = null;
      if (d?.moved) return null;
      if (hit?.button) return { button: hit.button };
      const t = now(), dbl = t - this.lastTap < 320; this.lastTap = t;
      const near = this.markers.filter((m) => Math.hypot(m.x - x, m.y - y) <= 10).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
      if (near.length > 1 && this.K < MAP_MAX_K * 0.7) { this.glideZoom(2.5, near[0].x, near[0].y); return null; } // split a crowd
      if (near.length) return { select: near[0].name };
      if (dbl) this.glideZoom(2, x, y);
      return null;
    },
    wheel(dy, mode, x, y) { this.zoomAt(Math.exp(-dy * (mode === 1 ? 0.05 : mode === 2 ? 1 : 0.0018)), x, y); },
    pinch(f, x, y) { this.zoomAt(f, x, y); },
    // ---- drawing into the game view; registers hit boxes on `hits`
    draw(ctx, t, hits, opts = {}) {
      if (!this.fitted && Fleet.data) { if (opts.focus) this.centreOn(Fleet.get(opts.focus)?.pos, 2.5, true); else this.fitTargets(null, true); }
      this.step();
      ctx.save(); ctx.beginPath(); ctx.rect(VP.x, VP.y, VP.w, VP.h); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(VP.x, VP.y, VP.w, VP.h);
      const ov = loadOverview();
      const under = this.cz >= 6400;
      if (ov && !under) { ctx.imageSmoothingEnabled = true; ctx.drawImage(ov.img, this.sx(ov.meta.x0), this.sy(ov.meta.z1), ov.meta.w * this.K, ov.meta.h * this.K); }
      if (this.K >= 1.4 || under) { // detail: the 4 px/tile world-map squares (walls, trees, icons)
        ctx.imageSmoothingEnabled = this.K < 4;
        const halfW = VP.w / 2 / this.K, halfH = VP.h / 2 / this.K;
        for (let mx = Math.floor((this.cx - halfW) / 64); mx <= Math.floor((this.cx + halfW) / 64); mx++)
          for (let mz = Math.floor((this.cz - halfH) / 64); mz <= Math.floor((this.cz + halfH) / 64); mz++) {
            const im = image(`/lite/map/${mx}_${mz}.png`);
            if (im && im.naturalWidth > 1) ctx.drawImage(im, Math.floor(this.sx(mx * 64)), Math.floor(this.sy((mz + 1) * 64)), Math.ceil(64 * this.K) + 1, Math.ceil(64 * this.K) + 1);
          }
      }
      if (!ov && this.K < 1.4) drawText(ctx, 'b12', 'Loading world map…', VP.x + VP.w / 2, VP.y + VP.h / 2, 0xffff00, true, true);
      ctx.imageSmoothingEnabled = false;
      for (const l of json('/lite/labels.json') || []) {
        if ((l.z >= 6400) !== under || (this.K < 0.8 && l.s < 1) || (this.K < 0.5 && l.s < 2)) continue;
        const x = this.sx(l.x), y = this.sy(l.z);
        if (x < VP.x - 60 || x > VP.x + VP.w + 60 || y < VP.y - 20 || y > VP.y + VP.h + 20) continue;
        const parts = l.t.split('/');
        parts.forEach((p, i) => drawText(ctx, l.s >= 2 ? 'b12' : 'p11', p, x, y + i * 13 - (parts.length - 1) * 6, l.s >= 2 ? 0xffaa00 : 0xffffff, true, true));
      }
      const accts = Fleet.accounts().filter((a) => a.pos && (a.pos[1] >= 6400) === under);
      for (const a of accts) {
        const tr = Fleet.trails.get(a.name); if (!tr || tr.length < 2) continue;
        ctx.strokeStyle = a.name === opts.focus ? 'rgba(255,255,255,.7)' : a.lite ? 'rgba(255,230,80,.5)' : 'rgba(110,220,255,.4)'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
        ctx.beginPath(); tr.forEach(([x, z], i) => (i ? ctx.lineTo(this.sx(x + 0.5), this.sy(z + 0.5)) : ctx.moveTo(this.sx(x + 0.5), this.sy(z + 0.5)))); ctx.stroke();
        ctx.setLineDash([]);
      }
      accts.sort((a, b) => Number(a.lite) - Number(b.lite) || Number(a.name === opts.focus) - Number(b.name === opts.focus));
      const placed = [];
      this.markers = [];
      for (const a of accts) {
        const x = this.sx(a.pos[0] + 0.5), y = this.sy(a.pos[1] + 0.5);
        if (x < VP.x - 10 || x > VP.x + VP.w + 10 || y < VP.y - 10 || y > VP.y + VP.h + 10) continue;
        const me = a.name === opts.focus;
        // a badge: the skill it last trained, ringed in its group colour (lite yellow, main cyan); paused orange,
        // fighting red, offline greyed out; the followed account ringed white
        const ring = me ? '#ffffff' : a.paused ? '#ff8040' : a.fight ? '#ff3030' : a.lite ? '#ffe600' : '#55d8ff';
        const r = this.K < 0.9 ? 7 : 9;
        const icon = a.lastSkill ? image(`/skill/${a.lastSkill.skill.toLowerCase()}.png`) : null;
        ctx.globalAlpha = a.live ? 1 : 0.45;
        if (me || (a.live && !a.paused && a.lastSkill?.xph)) { const p = 0.5 + 0.5 * Math.sin(t / 300 + a.name.length); ctx.fillStyle = me ? `rgba(255,255,255,${0.3 * p})` : a.lite ? `rgba(255,230,0,${0.18 * p})` : `rgba(85,216,255,${0.18 * p})`; ctx.beginPath(); ctx.arc(x, y, r + 3 + p * 3, 0, 7); ctx.fill(); }
        ctx.fillStyle = '#16120c'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
        if (icon) { const k = (r * 2 - 4) / 16; ctx.imageSmoothingEnabled = k < 1; ctx.drawImage(icon, Math.round(x - 8 * k), Math.round(y - 8 * k), 16 * k, 16 * k); ctx.imageSmoothingEnabled = false; }
        else { ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, 7); ctx.fill(); }
        ctx.strokeStyle = '#000'; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
        ctx.strokeStyle = a.live ? ring : '#888'; ctx.lineWidth = me ? 2.5 : 2; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
        ctx.globalAlpha = 1;
        if (opts.hover === a.name) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, 7); ctx.stroke(); }
        const w = textWidth('p11', a.name), box = [x - w / 2 - 2, y - r - 14, w + 4, 12];
        if (me || opts.hover === a.name || (this.K >= 1.2 && !placed.some((b) => box[0] < b[0] + b[2] && box[0] + box[2] > b[0] && box[1] < b[1] + b[3] && box[1] + box[3] > b[1]))) {
          placed.push(box);
          drawText(ctx, 'p11', a.name, x, y - r - 3, me ? 0xffffff : a.lite ? 0xffff00 : 0x80e0ff, true, true);
        }
        this.markers.push({ x, y, name: a.name });
        hits.push({ x: x - r, y: y - r, w: r * 2, h: r * 2, label: me ? `@whi@${a.name} @gre@(you are here)` : `@whi@Follow @yel@${a.name}`, account: a.name });
      }
      // controls: zoom, fit, and whatever the caller adds (close, HQ)
      const btns = [['-', 'zoomOut', 'Zoom out'], ['+', 'zoomIn', 'Zoom in'], // stacked bottom-up: + sits above -
        ['#', 'fit', 'Show every lite account'], ...(opts.buttons || [])];
      btns.forEach(([label, id, tip], i) => {
        const w = label.length > 1 ? textWidth('p12', label) + 12 : 22, bx = VP.x + VP.w - w - 4, by = VP.y + VP.h - 24 - i * 23;
        ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(bx, by, w, 20); ctx.strokeStyle = '#7a6a50'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 19);
        drawText(ctx, label.length > 1 ? 'p12' : 'b12', label, bx + w / 2, by + 15, 0xffff00, true, true);
        hits.push({ x: bx, y: by, w, h: 20, label: `@whi@${tip}`, button: id });
      });
      ctx.restore();
    },
    // map buttons shared by every caller
    button(id) {
      if (id === 'zoomIn') this.glideZoom(1.8, VP.x + VP.w / 2, VP.y + VP.h / 2);
      else if (id === 'zoomOut') this.glideZoom(1 / 1.8, VP.x + VP.w / 2, VP.y + VP.h / 2);
      else if (id === 'fit') this.fitTargets();
      else return false;
      return true;
    },
    keyPan(code) {
      const step = 80 / this.K;
      if (code === 'ArrowLeft') this.cx -= step; else if (code === 'ArrowRight') this.cx += step;
      else if (code === 'ArrowUp') this.cz += step; else if (code === 'ArrowDown') this.cz -= step; else return false;
      this.anim = null; this.fitted = true; this.clampCentre(); return true;
    },
  };

  // the dashboard's HTML HQ list still alternates skill/xp and wealth/gp-h on this period
  const WEALTH_FLIP_MS = 4000;
  // What the side-panel account list shows per account (its order never changes): picked with the buttons on top,
  // saved per device. skill: last-trained skill + xp/h · gold: wealth + gp/h · level: total level + xp/h ·
  // qp: quest points · doing: a short phrase of the current activity
  const LIST_MODES = [['skill', 'Skill', 'Last-trained skill and its xp/h'], ['gold', 'Gold', 'Wealth (coins + items) and gp/h'],
    ['level', 'Level', 'Total level and xp/h'], ['qp', 'QP', 'Quest points'], ['doing', 'Doing', 'What each account is doing']];
  let listMode = 'skill';
  try { const m = localStorage.getItem('dash.listMode'); if (LIST_MODES.some(([k]) => k === m)) listMode = m; } catch {}
  const setListMode = (m) => { if (!LIST_MODES.some(([k]) => k === m)) return false; listMode = m; try { localStorage.setItem('dash.listMode', m); } catch {} return true; };
  // list-mode buttons send 'list:<mode>'; every view routes its buttons through this first
  const listButton = (id) => typeof id === 'string' && id.startsWith('list:') && setListMode(id.slice(5));
  // activity -> a few words: drop the script prefix ('kq-quartermaster · '), idle notes, and long tails
  const shortActivity = (t) => {
    t = String(t || '').replace(/@[a-z0-9]{3}@/gi, '').replace(/@/g, '').trim();
    if (!t) return '';
    if (/^idle\b/i.test(t)) return 'Idle';
    t = t.split(' · ').pop();
    return t.replace(/\s*\(.*$/, '').replace(/\s+/g, ' ');
  };
  const fitText = (font, t, w) => { if (textWidth(font, t) <= w) return t; while (t && textWidth(font, t + '…') > w) t = t.slice(0, -1); return t + '…'; };
  // Fleet list in the side panel (the friends tab of the 2004 client is a list of players, so it is that tab).
  function drawFleetList(ctx, hits, opts) {
    // same order as the dashboard's top account bar: main accounts first, then lite, each in the server's order
    const all = Fleet.accounts();
    const main = all.filter((a) => !a.lite), lite = all.filter((a) => a.lite);
    const X = SIDE.x, Y = SIDE.y, W = 190, H = 261;
    // header: what the list shows
    const bw = (W - 12) / LIST_MODES.length;
    LIST_MODES.forEach(([k, label, tip], i) => {
      const bx = X + 6 + i * bw, on = k === listMode;
      ctx.fillStyle = on ? 'rgba(255,176,0,.28)' : 'rgba(0,0,0,.35)'; ctx.fillRect(bx + 1, Y + 4, bw - 2, 18);
      if (on) { ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 1; ctx.strokeRect(bx + 1.5, Y + 4.5, bw - 3, 17); }
      drawText(ctx, 'p11', label, bx + bw / 2, Y + 17, on ? 0xffffff : 0xffb000, true, true);
      hits.push({ x: bx, y: Y + 4, w: bw, h: 18, label: `@whi@Show: @yel@${tip}`, button: 'list:' + k });
    });
    ctx.save(); ctx.beginPath(); ctx.rect(X, Y + 24, W, H - 26); ctx.clip();
    const on = (l) => l.filter((a) => a.live).length;
    const rows = [...(main.length ? [{ head: `Main accounts ${on(main)}/${main.length}` }] : []), ...main.map((a) => ({ a })),
      ...(lite.length ? [{ head: `Lite accounts ${on(lite)}/${lite.length}` }] : []), ...lite.map((a) => ({ a }))];
    const maxScroll = Math.max(0, rows.length * 15 - (H - 34));
    opts.state.scroll = clamp(opts.state.scroll ?? 0, 0, maxScroll);
    if (opts.focus && !opts.state.scrolledTo) { // bring the followed account into view once
      const i = rows.findIndex((r) => r.a?.name === opts.focus);
      if (i >= 0) opts.state.scroll = clamp(i * 15 - 90, 0, maxScroll);
      opts.state.scrolledTo = true;
    }
    const RATE_R = X + W - 22, VAL_R = RATE_R - 46, ICON_X = VAL_R - 30 - 15;
    rows.forEach((r, i) => {
      const y = Y + 38 + i * 15 - opts.state.scroll;
      if (y < Y + 14 || y > Y + H + 12) return;
      if (r.head) { drawText(ctx, 'b12', r.head, X + 95, y, 0xff9900, true, true); return; }
      const a = r.a, me = a.name === opts.focus;
      if (me) { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(X + 4, y - 12, W - 8, 15); }
      else if (opts.hover === a.name) { ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(X + 4, y - 12, W - 8, 15); }
      const nameCol = me ? 0xffffff : a.lite ? 0xffff00 : 0x80e0ff;
      const st = a.paused ? ['Paused', 0xff3000] : !a.live ? ['Offline', 0xff0000] : a.fight ? ['Fighting', 0xff9040] : null;
      if (listMode === 'doing') { // name (short) | the phrase, in the status colour when paused/offline/fighting
        drawText(ctx, 'p12', fitText('p12', a.name, 62), X + 8, y, nameCol, true);
        const phrase = st && st[0] !== 'Fighting' ? st[0] : shortActivity(a.activity) || (st ? st[0] : '-');
        drawText(ctx, 'p11', fitText('p11', phrase, RATE_R - X - 74), X + 74, y, st ? st[1] : 0xdddddd, true);
      } else {
        drawText(ctx, 'p12', a.name, X + 8, y, nameCol, true);
        // fixed columns so nothing jumps between modes: icon | value (right-aligned) | rate per hour (right-aligned)
        const ls = a.lastSkill, wealth = a.gold?.total ?? a.bank?.total ?? null, gph = a.gold?.gphRecent ?? a.wealthGph ?? null;
        let icon = null, val = '', rate = '', valCol = 0xffffff, rateCol = 0x00ff00;
        if (listMode === 'gold') { icon = iconFor(995, 10000); val = wealth != null ? fmtK(wealth) : '-'; valCol = 0xffff00; rate = gph != null ? `${gph < 0 ? '' : '+'}${fmtK(gph)}/h` : ''; rateCol = gph < 0 ? 0xff3000 : 0x00ff00; }
        else if (listMode === 'level') { val = a.totalLevel != null ? `Lv ${a.totalLevel}` : '-'; rate = a.xph ? `${fmtK(a.xph)}/h` : ''; }
        else if (listMode === 'qp') { val = a.questPoints != null ? `${a.questPoints} QP` : '-'; valCol = 0x80e0ff; }
        else { icon = ls ? image(`/skill/${ls.skill.toLowerCase()}.png`) : null; val = ls ? String(ls.level) : ''; rate = ls?.xph ? `${fmtK(ls.xph)}/h` : ls ? '' : 'Online'; rateCol = ls?.xph ? 0x00ff00 : 0x00c000; }
        // paused / offline / fighting take the rate column (gold and level keep their value beside it)
        if (st) { rate = st[0]; rateCol = st[1]; if (listMode === 'skill') { icon = null; val = ''; } }
        if (icon) ctx.drawImage(icon, ICON_X, y - 11, 13, 13);
        drawText(ctx, 'p11', val, VAL_R, y, valCol, true, false, true);
        drawText(ctx, 'p11', rate, RATE_R, y, rateCol, true, false, true);
      }
      // only rows wholly inside the list's clip are clickable: a row peeking past the bottom edge is drawn clipped,
      // and its hit box would otherwise cover the HQ/back tab slot just below the list (last hit wins)
      if (y - 12 >= Y + 24 && y + 3 <= Y + H - 2) hits.push({ x: X + 4, y: y - 12, w: W - 26, h: 15, label: me ? `@whi@${a.name} @gre@(following)` : `@whi@Follow @yel@${a.name}@whi@: ${(a.activity || '').replace(/@/g, '').slice(0, 60)}`, account: a.name });
    });
    if (!Fleet.data) drawText(ctx, 'p12', 'Loading…', X + 95, Y + 60, 0xffff00, true, true);
    ctx.restore();
    if (maxScroll > 0) drawScrollbar(ctx, X + W - 16 + 4, Y + 24, opts.state.scroll, rows.length * 15 + 10, H - 26);
    return { inList: (x, y) => x >= X && x < X + W && y >= Y + 24 && y < Y + H, maxScroll };
  }

  class HqView {
    constructor(canvas, hooks) {
      this.canvas = canvas; this.hooks = hooks || {}; this.ctx = canvas.getContext('2d');
      this.on = false; this.raf = 0; this.lastDraw = 0;
      this.mouse = null; this.list = { scroll: 0 }; this.hits = []; this.hover = null; this.fps = 30;
    }
    start() {
      if (this.on) return;
      this.on = true;
      loadUi(); loadOverview(); json('/lite/labels.json');
      fitCanvas(this.canvas);
      Fleet.sub(this);
      const loop = (t) => { if (!this.on) return; this.raf = requestAnimationFrame(loop); if (t - this.lastDraw < 1000 / this.fps - 2) return; this.lastDraw = t; this.draw(t); };
      this.raf = requestAnimationFrame(loop);
    }
    stop() { this.on = false; cancelAnimationFrame(this.raf); Fleet.unsub(this); this.mini?.stop(); }
    // Opened from an account: the minimap stays that account's (a minimap-only LiteView drawn off screen), with its
    // fleet badges; clicking elsewhere on it finds the account on the big map. Opened directly: the whole world.
    drawAcctMini(ctx, name) {
      if (!this.mini) { this.mini = new LiteView(document.createElement('canvas'), {}); this.mini.miniOnly = true; this.mini.fps = 15; }
      const m = this.mini;
      if (!m.on || m.account !== name) m.start(name, {});
      if (!m.scene) return false;
      ctx.drawImage(m.canvas, MAPA.x, 0, FW - MAPA.x, 166, MAPA.x, 0, FW - MAPA.x, 166);
      this.hits.push({ x: MM.cx - MM.rx, y: MM.cy - MM.ry, w: MM.rx * 2, h: MM.ry * 2, label: `@whi@Find @yel@${name} @whi@on the map`, act: () => FleetMap.centreOn(Fleet.get(name)?.pos, Math.max(FleetMap.K, 2.5)) });
      for (const b of m.mmBadges || []) this.hits.push(b);
      return true;
    }
    accounts(liteOnly = false) { return Fleet.accounts(liteOnly); }
    hitAt(x, y) { let r = null; for (const h of this.hits) if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) r = h; return r; }
    inVp(x, y) { return x >= VP.x && x < VP.x + VP.w && y >= VP.y && y < VP.y + VP.h; }

    // -------------------------------------------------------------- input (frame coordinates via fx/fy 0..1)
    pointer(kind, fx, fy) {
      if (kind === 'leave') { this.mouse = null; FleetMap.drag = null; this.listDrag = null; return true; }
      const x = fx * FW, y = fy * FH;
      this.mouse = { x, y };
      const inList = x >= SIDE.x && x < SIDE.x + 190 && y >= SIDE.y + 24 && y < SIDE.y + 261;
      if (kind === 'down') {
        if (this.inVp(x, y)) FleetMap.down(x, y);
        else if (inList) this.listDrag = { y, scroll: this.list.scroll, moved: false };
        return true;
      }
      if (kind === 'move') {
        const d = this.listDrag;
        if (d) { if (Math.abs(y - d.y) > 4) d.moved = true; if (d.moved) this.list.scroll = d.scroll - (y - d.y); return true; }
        FleetMap.move(x, y); return true;
      }
      if (kind === 'up') {
        const ld = this.listDrag; this.listDrag = null;
        if (ld?.moved) return true; // dragged the list: not a click
        const h = this.hitAt(x, y);
        if (FleetMap.drag) {
          const act = FleetMap.up(x, y, h);
          if (act?.select) this.hooks.onSelect?.(act.select);
          else if (act?.button) this.button(act.button);
          return true;
        }
        if (h?.button) this.button(h.button);
        else if (h?.account) this.hooks.onSelect?.(h.account);
        else if (h?.act) h.act();
      }
      return true;
    }
    button(id) { if (!listButton(id)) FleetMap.button(id); }
    wheel(dy, mode, fx, fy) {
      const x = fx * FW, y = fy * FH;
      if (x >= SIDE.x && x < SIDE.x + 190 && y >= SIDE.y && y < SIDE.y + 261) { this.list.scroll += Math.sign(dy) * Math.max(15, Math.min(60, Math.abs(dy))); return true; }
      if (this.inVp(x, y)) { FleetMap.wheel(dy, mode, x, y); return true; }
      return false;
    }
    pinch(f, fx, fy) { FleetMap.pinch(f, fx * FW, fy * FH); }
    key(code, down) { if (down) FleetMap.keyPan(code); return true; }

    // -------------------------------------------------------------- frame
    draw(t) {
      const ctx = this.ctx;
      fitCanvas(this.canvas);
      ctx.imageSmoothingEnabled = false;
      if (!UI || !UI.frame.complete) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, FW, FH); drawFallback(ctx, uiError ? `Bot HQ: ${uiError} - retrying` : 'Loading Bot HQ…'); this.hooks.onFrame?.(); return; }
      ctx.drawImage(UI.frame, 0, 0);
      this.hits = [];
      FleetMap.draw(ctx, t, this.hits, { hover: this.hover });
      const from = this.hooks.backTo?.();
      if (!from) this.mini?.stop();
      if (!from || !this.drawAcctMini(ctx, from)) this.drawMini(ctx, t); // the world until that account's scene arrives
      const back = this.hooks.backTo?.();
      if (back) { // the world-map button becomes an X: close the map, back to the account it was opened from
        drawWorldBtn(ctx, true);
        this.hits.push({ x: WORLD_BTN.cx - WORLD_BTN.r, y: WORLD_BTN.cy - WORLD_BTN.r, w: WORLD_BTN.r * 2, h: WORLD_BTN.r * 2, label: `@whi@Close the map: back to @yel@${back}`, act: () => this.hooks.onBack?.(back) });
      }
      drawHqTab(ctx, true, !!back);
      this.hits.push({ x: 540, y: 466, w: 34, h: 36, label: back ? `@whi@Back to @yel@${back}` : '@whi@Bot HQ', act: back ? () => this.hooks.onBack?.(back) : null });
      [[29, 13], [53, 11], [82, 11], [115, 12], [153, 13], [180, 11], [208, 13]].forEach(([x, y], i) => plot(ctx, 'sideicons' + i, 516 + x, 160 + y));
      [[74, 2], [102, 3], [137, 4], [174, 2], [201, 2], [226, 2]].forEach(([x, y], i) => plot(ctx, 'sideicons' + (i + 7), 496 + x, 466 + y));
      drawFleetList(ctx, this.hits, { focus: null, hover: this.hover, state: this.list });
      this.drawFeed(ctx, t);
      this.drawHud(ctx, t);
      this.hooks.onFrame?.();
    }
    drawMini(ctx, t) {
      const ov = loadOverview();
      const S = 0.3; // px per tile: most of the surface world in the orb, centred on the map view
      ctx.save(); ctx.beginPath(); ctx.ellipse(MM.cx, MM.cy, MM.rx, MM.ry, 0, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(MM.cx - MM.rx, MM.cy - MM.ry, MM.rx * 2, MM.ry * 2);
      const cz = Math.min(FleetMap.cz, 6399), cx = FleetMap.cx;
      const mx = (x) => MM.cx + (x - cx) * S, my = (z) => MM.cy - (z - cz) * S;
      if (ov) { ctx.imageSmoothingEnabled = true; ctx.drawImage(ov.img, mx(ov.meta.x0), my(ov.meta.z1), ov.meta.w * S, ov.meta.h * S); ctx.imageSmoothingEnabled = false; }
      for (const a of Fleet.accounts()) {
        if (!a.pos || a.pos[1] >= 6400) continue;
        ctx.fillStyle = !a.live ? '#888' : a.lite ? '#ffe600' : '#55d8ff';
        ctx.fillRect(Math.round(mx(a.pos[0])) - 1, Math.round(my(a.pos[1])) - 1, 3, 3);
      }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.strokeRect(mx(cx - VP.w / 2 / FleetMap.K), my(cz + VP.h / 2 / FleetMap.K), VP.w / FleetMap.K * S, VP.h / FleetMap.K * S);
      ctx.restore();
      const c = spr.compass;
      if (c) { ctx.save(); ctx.beginPath(); ctx.arc(MAPA.x + 17, MAPA.y + 17, 16.5, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(c.img, MAPA.x + 17 - c.w / 2, MAPA.y + 17 - c.h / 2); ctx.restore(); }
      drawText(ctx, 'p11', 'Bot HQ', MAPA.x + 98, MAPA.y + 154, 0xffb000, true, true);
      this.hits.push({ x: MM.cx - MM.rx, y: MM.cy - MM.ry, w: MM.rx * 2, h: MM.ry * 2, label: '@whi@Look here', act: () => {
        if (!this.mouse) return;
        FleetMap.glide(cx + (this.mouse.x - MM.cx) / S, cz - (this.mouse.y - MM.cy) / S, FleetMap.K);
      } });
    }
    drawFeed(ctx, t) {
      const x0 = CHAT.x, y0 = CHAT.y;
      const ev = Fleet.data?.events || [];
      const COLS = { level: 0x006000, death: 0x800000, offline: 0x800000, online: 0x006000, paused: 0x7e3200, resumed: 0x006000, activity: 0x0000ff };
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, 463, 77); ctx.clip();
      let line = 0;
      for (let i = ev.length - 1; i >= 0 && line < 6; i--, line++) {
        const e = ev[i], y = y0 + 70 - line * 14;
        const head = `${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${e.account}:`;
        drawText(ctx, 'p12', head, x0 + 4, y, 0);
        drawText(ctx, 'p12', e.text.replace(/@/g, ''), x0 + 10 + textWidth('p12', head), y, COLS[e.kind] ?? 0xff);
        this.hits.push({ x: x0, y: y - 12, w: 463, h: 14, label: `@whi@Follow @yel@${e.account}`, account: e.account });
      }
      if (!ev.length) drawText(ctx, 'p12', 'Fleet events (level-ups, deaths, logins, new tasks) appear here.', x0 + 4, y0 + 70, 0x800000);
      ctx.restore();
      drawScrollbar(ctx, x0 + 463, y0, 0, 78, 77);
      const lite = Fleet.accounts(true), main = Fleet.accounts().filter((a) => !a.lite);
      const on = (l) => l.filter((a) => a.live).length;
      // coins and item value across every account: money-fleet samples, else bank snapshots
      const gold = Fleet.accounts().reduce((t, a) => t + (a.gold?.coins ?? a.bank?.coins ?? 0), 0);
      const items = Fleet.accounts().reduce((t, a) => t + (a.gold ? a.gold.items ?? 0 : a.bank ? a.bank.total - a.bank.coins : 0), 0);
      drawText(ctx, 'p12', 'Bot HQ:', x0 + 4, y0 + 90, 0);
      drawText(ctx, 'p12', `${on(main)}/${main.length} main · ${on(lite)}/${lite.length} lite online · ${fmtK(gold)} gp · ${fmtK(items)} in items`, x0 + 6 + textWidth('p12', 'Bot HQ: '), y0 + 90, 0xff);
      ctx.fillStyle = '#000'; ctx.fillRect(x0, y0 + 77, 479, 1);
      const by = 453;
      drawText(ctx, 'p12', 'Lite', 55, by + 28, 0xffffff, true, true); drawText(ctx, 'p12', `${lite.filter((a) => a.live).length} online`, 55, by + 41, 0xff00, true, true);
      drawText(ctx, 'p12', 'Fighting', 184, by + 28, 0xffffff, true, true); drawText(ctx, 'p12', String(Fleet.accounts().filter((a) => a.fight).length), 184, by + 41, 0xffff00, true, true);
      const off = lite.filter((a) => !a.live || a.paused);
      drawText(ctx, 'p12', 'Need a look', 324, by + 28, 0xffffff, true, true); drawText(ctx, 'p12', String(off.length), 324, by + 41, off.length ? 0xff0000 : 0xff00, true, true);
      if (off.length) this.hits.push({ x: 270, y: 466, w: 110, h: 35, label: `@whi@Show @red@${off.map((a) => a.name).join(', ').slice(0, 60)}`, act: () => FleetMap.fitTargets(off.map((a) => a.name)) });
      // the account that opened HQ: one click back to it (the HQ pill / Back to Bot HQ remember it)
      const back = this.hooks.backTo?.();
      drawText(ctx, 'p12', 'Back to', 458, by + 28, back ? 0xffffff : 0x808080, true, true);
      drawText(ctx, 'p12', back || 'an account', 458, by + 41, back ? 0xffff00 : 0x808080, true, true);
      if (back) this.hits.push({ x: 412, y: 466, w: 94, h: 35, label: `@whi@Back to @yel@${back}`, act: () => this.hooks.onBack?.(back) });
    }
    drawHud(ctx, t) {
      const m = this.mouse;
      const h = m ? this.hitAt(m.x, m.y) : null;
      this.hover = h?.account ?? null;
      const crowd = m && FleetMap.K < MAP_MAX_K * 0.7 && !h?.button ? FleetMap.markers.filter((q) => Math.hypot(q.x - m.x, q.y - m.y) <= 9) : [];
      let label = h?.label || (m && this.inVp(m.x, m.y) ? '@whi@Drag to move · scroll or pinch to zoom · double-click to zoom in' : null);
      if (crowd.length > 1) { this.hover = null; label = `@whi@${crowd.length} here: @yel@${crowd.slice(0, 4).map((q) => q.name).join(', ')}${crowd.length > 4 ? '…' : ''} @whi@(click to zoom in)`; }
      if (label) drawText(ctx, 'b12', label, VP.x + 4, VP.y + 15, 0xffffff, true);
      if (this.hover && m) drawAccountCard(ctx, Fleet.get(this.hover), m);
      const pulse = 0.55 + 0.45 * Math.sin(t / 420);
      const bw = 70, bx = VP.x + VP.w - bw - 4, by = VP.y + 4;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx, by, bw, 16);
      ctx.fillStyle = `rgba(111,207,138,${pulse})`; ctx.beginPath(); ctx.arc(bx + 8, by + 8, 3, 0, 7); ctx.fill();
      drawText(ctx, 'p11', 'BOT HQ', bx + 15, by + 12, 0x6fcf8a, true);
      if (Fleet.err) drawText(ctx, 'b12', Fleet.err, VP.x + VP.w / 2, VP.y + VP.h - 8, 0xff3000, true, true);
    }
  }
  // a small HQ-map badge (for the minimap): last-trained skill icon, ringed lite yellow / main cyan / fighting red /
  // paused orange, greyed out when offline
  function drawSkillBadge(ctx, a, x, y, r, hover) {
    const ring = a.paused ? '#ff8040' : a.fight ? '#ff3030' : a.lite ? '#ffe600' : '#55d8ff';
    const icon = a.lastSkill ? image(`/skill/${a.lastSkill.skill.toLowerCase()}.png`) : null;
    ctx.globalAlpha = a.live ? 1 : 0.45;
    ctx.fillStyle = '#16120c'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    if (icon) { const k = (r * 2 - 4) / 16; ctx.imageSmoothingEnabled = true; ctx.drawImage(icon, x - 8 * k, y - 8 * k, 16 * k, 16 * k); ctx.imageSmoothingEnabled = false; }
    else { ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, 7); ctx.fill(); }
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    ctx.strokeStyle = a.live ? ring : '#888'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
    if (hover) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 7); ctx.stroke(); }
  }
  // Fleet badges on a streamed (managed) account's own minimap, placed exactly like the game places its dots: same
  // camera yaw + the client's deliberate minimap angle/zoom wobble (cam from /api/camera). st.hits: for hover/click.
  function paintFleetOnMinimap(ctx, w, h, cam, me, st) {
    st.hits = [];
    if (!cam || !mmBadges) return;
    const ang = ((cam.yaw + cam.mmAngle) & 2047) / 1024 * Math.PI, zf = 256 / (cam.mmZoom + 256);
    const sn = Math.sin(ang) * zf, cs = Math.cos(ang) * zf, lx = cam.lx >> 5, lz = cam.lz >> 5;
    ctx.save(); ctx.scale(w / FW, h / FH);
    ctx.beginPath(); ctx.ellipse(MM.cx, MM.cy, MM.rx, MM.ry, 0, 0, Math.PI * 2); ctx.clip();
    for (const a of Fleet.accounts()) {
      if (a.name === me || !a.pos || a.pos[2] !== cam.level) continue;
      const dx = (a.pos[0] - cam.baseX) * 4 + 2 - lx, dy = (a.pos[1] - cam.baseZ) * 4 + 2 - lz;
      if (dx * dx + dy * dy > 6400) continue;
      const x = MM.cx + dy * sn + dx * cs, y = MM.cy - (dy * cs - dx * sn);
      drawSkillBadge(ctx, a, x, y, 7, st.hover === a.name);
      st.hits.push({ x: x - 7, y: y - 7, w: 14, h: 14, account: a.name });
    }
    ctx.restore();
  }
  const mmHit = (st, fx, fy) => { const x = fx * FW, y = fy * FH; let r = null; for (const h of st?.hits || []) if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) r = h; return r; };
  // the hover card over a streamed frame (frame coords)
  function paintCard(ctx, w, h, name, mouse) {
    const a = Fleet.get(name); if (!a || !mouse) return;
    ctx.save(); ctx.scale(w / FW, h / FH); drawAccountCard(ctx, a, mouse); ctx.restore();
  }
  // hover card for an account: where it is, what it does, what it trains
  function drawAccountCard(ctx, a, m) {
    if (!a) return;
    const lines = [`${a.name}${a.lite ? ' (lite)' : ''} · ${a.pos ? placeName(a.pos[0], a.pos[1]) || `${a.pos[0]},${a.pos[1]}` : 'no position'}`,
      ...(a.activity ? [(a.activity || '').replace(/@/g, '').slice(0, 70)] : []),
      `${a.lastSkill ? `${a.lastSkill.skill} ${a.lastSkill.level}${a.lastSkill.xph ? ` · ${fmtK(a.lastSkill.xph)} xp/h` : a.lastSkill.capped ? ' (max)' : ''}` : 'no recent xp'}${a.hp ? ` · HP ${a.hp[0]}/${a.hp[1]}` : ''}`];
    const w = Math.max(...lines.map((l) => textWidth('p11', l))) + 10, hh = lines.length * 12 + 6;
    const bx = clamp(m.x + 12, 4, FW - w - 4), by = clamp(m.y + 14, 4, FH - hh - 4);
    ctx.fillStyle = 'rgba(0,0,0,.82)'; ctx.fillRect(bx, by, w, hh); ctx.strokeStyle = '#7a6a50'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, hh - 1);
    lines.forEach((l, i) => drawText(ctx, 'p11', l, bx + 5, by + 14 + i * 12, i ? 0xdddddd : 0xffff00, true));
  }

  // The Bot HQ button: 'HQ' in the empty first bottom tab slot (frame 540,466 34x37, left of the smiley), lit like a
  // selected tab while HQ is open. Drawn by both views, and over every streamed account's frames (paintHqTab).
  const HQ_SLOT = { x: 540, y: 466, w: 34, h: 37 };
  // back: on HQ with an account to return to - the button becomes a back arrow (it leads back to that account)
  function drawHqTab(ctx, active, back = false) {
    if (active) plot(ctx, 'redstone1v', 496 + 42, 466);
    if (back) {
      const cx = HQ_SLOT.x + 17, cy = HQ_SLOT.y + 18;
      ctx.beginPath(); // left arrow: head + shaft, gold with a black outline like the tab icons
      ctx.moveTo(cx - 10, cy); ctx.lineTo(cx - 2, cy - 8); ctx.lineTo(cx - 2, cy - 4); ctx.lineTo(cx + 9, cy - 4);
      ctx.lineTo(cx + 9, cy + 4); ctx.lineTo(cx - 2, cy + 4); ctx.lineTo(cx - 2, cy + 8); ctx.closePath();
      ctx.lineJoin = 'miter'; ctx.lineWidth = 2.5; ctx.strokeStyle = '#000'; ctx.stroke();
      ctx.fillStyle = '#ffb000'; ctx.fill();
      return;
    }
    drawText(ctx, 'b12', 'HQ', HQ_SLOT.x + 17 + 1, HQ_SLOT.y + 24, 0x000000, false, true); // heavy outline like the tab icons
    drawText(ctx, 'b12', 'HQ', HQ_SLOT.x + 17 - 1, HQ_SLOT.y + 22, 0x000000, false, true);
    drawText(ctx, 'b12', 'HQ', HQ_SLOT.x + 17, HQ_SLOT.y + 23, 0x000000, false, true);
    drawText(ctx, 'b12', 'HQ', HQ_SLOT.x + 17, HQ_SLOT.y + 22, active ? 0xffffff : 0xffb000, false, true);
  }
  // The world-map button: a small globe in a gold-ringed socket, mirroring the compass in the opposite corner.
  // close: the same socket with a gold X (on the Bot HQ map, which the button opened)
  function drawWorldBtn(ctx, close = false) {
    const { cx, cy, r } = WORLD_BTN;
    ctx.save();
    if (close) {
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(cx, cy, r + 1.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#3a2a1a'; ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, 7); ctx.fill();
      ctx.lineCap = 'round'; const d = r * 0.45;
      for (const [w, c] of [[4, '#000'], [2.2, '#ffb000']]) {
        ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath();
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d); ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d); ctx.stroke();
      }
      ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(cx, cy, r + 1.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#3d6fa8'; ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, 7); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, 7); ctx.clip(); // land
    ctx.fillStyle = '#5f9a3c';
    ctx.beginPath(); ctx.ellipse(cx - 3, cy - 3, 4.5, 3, -0.5, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + 4, cy + 3, 3.5, 4, 0.4, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 0.8; // meridian + equator
    ctx.beginPath(); ctx.ellipse(cx, cy, (r - 1) * 0.45, r - 1, 0, 0, 7); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    ctx.restore();
  }
  // w/h: the stream canvas size (the 765x503 game canvas at any scale). side ({ scroll, focus } from the dashboard):
  // the streamed account was opened from HQ, so the fleet list covers its side panel until another tab is clicked
  function paintHqTab(ctx, w, h, side = null) {
    loadUi();
    if (!UI?.fonts.b12?.img.complete) return;
    ctx.save(); ctx.scale(w / FW, h / FH);
    if (side && UI.frame.complete) {
      ctx.drawImage(UI.frame, SIDE.x, SIDE.y, 190, 261, SIDE.x, SIDE.y, 190, 261);
      side.hits = [];
      drawFleetList(ctx, side.hits, { focus: side.focus, hover: side.hover, state: side });
    }
    drawHqTab(ctx, !!side);
    drawWorldBtn(ctx);
    ctx.restore();
  }
  const isHqTab = (fx, fy) => { const x = fx * FW, y = fy * FH; return x >= HQ_SLOT.x && x <= HQ_SLOT.x + HQ_SLOT.w && y >= HQ_SLOT.y && y <= HQ_SLOT.y + HQ_SLOT.h; };
  const inSide = (fx, fy) => { const x = fx * FW, y = fy * FH; return x >= SIDE.x && x < SIDE.x + 190 && y >= SIDE.y && y < SIDE.y + 261; };
  // the stream overlay's last-drawn hit under a point ({ account } or { button: 'hq' })
  const sideHit = (side, fx, fy) => { const x = fx * FW, y = fy * FH; let r = null; for (const h of side?.hits || []) if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) r = h; return r; };
  const isWorldBtn = (fx, fy) => Math.hypot(fx * FW - WORLD_BTN.cx, fy * FH - WORLD_BTN.cy) <= WORLD_BTN.r + 2;
  const tabAt = (fx, fy) => { const x = fx * FW, y = fy * FH; return TAB_HIT.findIndex(([a, b, c, d]) => x >= a && x <= c && y >= b && y < d); };

  function drawFallback(ctx, msg) { ctx.fillStyle = '#e8c35a'; ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText(msg, FW / 2, FH / 2); ctx.textAlign = 'start'; }

  window.LiteView = LiteView;
  window.HqView = HqView;
  LiteView.placeName = placeName;
  LiteView.Fleet = Fleet;
  LiteView.WEALTH_FLIP_MS = WEALTH_FLIP_MS;
  LiteView.paintHqTab = paintHqTab;
  LiteView.isHqTab = isHqTab;
  LiteView.HQ_TAB = HQ_TAB;
  LiteView.isWorldBtn = isWorldBtn;
  LiteView.listButton = listButton;
  LiteView.paintFleetOnMinimap = paintFleetOnMinimap;
  LiteView.mmHit = mmHit;
  LiteView.paintCard = paintCard;
  LiteView.badges = (on) => { if (on !== undefined) { mmBadges = !!on; try { localStorage.setItem('dash.mmBadges', mmBadges ? '1' : '0'); } catch {} } return mmBadges; };
  LiteView.hqSide = { inSide, hit: sideHit, tabAt };
})();
