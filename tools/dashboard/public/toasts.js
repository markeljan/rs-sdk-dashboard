// toasts.js - live pop-ups for the fleet's big moments (rare drops, 100k+ pickups, an account maxing), polled from
// /api/events. Clicking a toast opens that account. On by default; the toggle is saved per device (localStorage
// 'dash.toasts'). FleetToasts.init({ open(acct), watching() }) - watching() returns the account names to toast for
// (the dashboard's list) or null for every account; open() defaults to /?account=<name>.
(() => {
  const KEY = 'dash.toasts', POLL_MS = 5000, MAX_SHOWN = 3, FRESH_MS = 10 * 60e3;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gp = (n) => { const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)); };
  const ago = (t) => { const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000); return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
  const ICON = ['🛡️', '🐉', '💎', '⭐'];
  const TIER = ['legend', 'epic', 'rare', 'big'];

  const css = `
.ftoasts { position: fixed; z-index: 2147483000; top: calc(env(safe-area-inset-top) + 10px); left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; width: min(420px, calc(100vw - 32px)); pointer-events: none; }
.ftoast { pointer-events: auto; cursor: pointer; display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 9px 10px 9px 12px; border-radius: 12px; background: #16191cf2; color: #e8e6e1; border: 1px solid #3a3f45; box-shadow: 0 8px 28px #000a; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: ftIn .32s cubic-bezier(.2,.9,.3,1.2); transition: opacity .25s, transform .25s; -webkit-tap-highlight-color: transparent; user-select: none; }
.ftoast.out { opacity: 0; transform: translateY(-12px) scale(.97); }
.ftoast:hover { border-color: #e0a458; }
.ftoast .ic { flex: none; font-size: 22px; line-height: 1; }
.ftoast .tx { flex: 1; min-width: 0; }
.ftoast .t1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ftoast .t1 b { color: #fff; } .ftoast .it { font-weight: 700; }
.ftoast .t2 { color: #8e959c; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ftoast .go { flex: none; font-size: 11px; font-weight: 600; color: #e0a458; }
.ftoast .x { flex: none; border: 0; background: none; color: #5c636a; font-size: 16px; padding: 0 2px; cursor: pointer; }
.ftoast .x:hover { color: #e8e6e1; }
.ftoast.legend { border-color: #8a63d2; background: linear-gradient(90deg, #2a1f44f2, #16191cf2 60%); } .ftoast.legend .it { color: #c39bff; }
.ftoast.epic { border-color: #7a5a2c; } .ftoast.epic .it { color: #e0a458; }
.ftoast.rare .it { color: #7fb4ff; } .ftoast.big .it { color: #6fcf8a; }
.ftoast.legend::after { content: ''; position: absolute; inset: 0; border-radius: 12px; pointer-events: none; box-shadow: 0 0 18px #c39bff66; }
.ftoast { position: relative; }
@keyframes ftIn { from { opacity: 0; transform: translateY(-16px) scale(.96); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .ftoast { animation: none; transition: none; } }`;

  let opts = { open: (a) => { location.href = '/?account=' + encodeURIComponent(a); }, watching: () => null };
  let box = null, cursor = null, timer = null, started = false;
  const listeners = new Set();
  const enabled = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } };
  function setEnabled(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
    if (!on && box) box.replaceChildren();
    schedule();
  }

  function mount() {
    if (box) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    box = document.createElement('div'); box.className = 'ftoasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  function dismiss(el) { if (!el.isConnected || el.classList.contains('out')) return; el.classList.add('out'); setTimeout(() => el.remove(), 260); }

  const describe = (e) => {
    if (e.kind === 'maxed') return { t1: `<b>${esc(e.acct)}</b> reached <span class="it">99 in every skill</span> 🏆`, t2: ago(e.t) };
    const what = `<span class="it">${esc(e.item)}</span>${e.n > 1 ? ` ×${e.n.toLocaleString('en-US')}` : ''}`;
    const extra = [e.npc, e.kind === 'pickup' && e.value ? `${gp(e.value)} gp` : '', ago(e.t)].filter(Boolean).map(esc).join(' · ');
    return { t1: `<b>${esc(e.acct)}</b> ${e.kind === 'pickup' ? 'looted' : 'got a'} ${what}`, t2: extra };
  };
  function show(e) {
    mount();
    const d = describe(e);
    const el = document.createElement('div');
    el.className = `ftoast ${e.kind === 'maxed' ? 'legend' : TIER[e.tier] ?? 'big'}`;
    el.title = `Open ${e.acct}`;
    el.innerHTML = `<span class="ic">${e.kind === 'maxed' ? '🏆' : e.kind === 'pickup' ? '💰' : ICON[e.tier] ?? '⭐'}</span><span class="tx"><div class="t1">${d.t1}</div><div class="t2">${d.t2}</div></span><span class="go">View ›</span><button class="x" type="button" aria-label="Dismiss">×</button>`;
    el.querySelector('.x').addEventListener('click', (ev) => { ev.stopPropagation(); dismiss(el); });
    el.addEventListener('click', () => { dismiss(el); opts.open(e.acct, e); });
    let left = e.tier === 0 || e.kind === 'maxed' ? 15000 : 8000, t0 = Date.now(), hide = setTimeout(() => dismiss(el), left);
    el.addEventListener('pointerenter', () => { clearTimeout(hide); left -= Date.now() - t0; });
    el.addEventListener('pointerleave', () => { t0 = Date.now(); hide = setTimeout(() => dismiss(el), Math.max(2500, left)); });
    box.prepend(el);
    while (box.children.length > MAX_SHOWN) box.lastElementChild.remove();
  }

  async function poll() {
    timer = null;
    try {
      const r = await fetch('/api/events' + (cursor == null ? '' : `?since=${cursor}`), { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        const first = cursor == null;
        if (!first && d.seq < cursor) cursor = null; // dashboard restarted: the sequence starts over
        else {
          for (const f of listeners) try { f(d.events, first); } catch {}
          if (!first && enabled()) {
            const w = opts.watching(), set = w ? new Set(w) : null;
            const fresh = d.events.filter((e) => (!set || set.has(e.acct)) && Date.now() - Date.parse(e.t) < FRESH_MS);
            fresh.slice(-MAX_SHOWN).forEach(show);
          }
          cursor = d.seq;
        }
      }
    } catch { /* dashboard restarting */ }
    schedule();
  }
  // keep polling while hidden only for listeners (the highlights feed); toasts wait for the page to be visible
  function schedule() { if (started && !timer) timer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) { clearTimeout(timer); timer = null; schedule(); } });

  window.FleetToasts = {
    init(o = {}) { opts = { ...opts, ...o }; if (!started) { started = true; poll(); } },
    enabled, setEnabled, show,
    onEvents(f) { listeners.add(f); }, // f(events, isFirstLoad)
  };
})();
