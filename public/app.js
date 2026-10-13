// RS-SDK Dashboard web UI (no build step). State comes from /api/* and a WebSocket (/ws) that pushes account
// updates and, for the account being viewed, JPEG frames of its game client.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null ? '–' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString();
const ago = t => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const app = $('#app');

const FPS_KEY = 'rsd.fps';
function defaultFps() { const c = navigator.connection; return c && (c.saveData || c.type === 'cellular' || /2g|3g/.test(c.effectiveType || '')) ? 3 : 10; }
function viewFps() { try { return Number(localStorage.getItem(FPS_KEY)) || defaultFps(); } catch { return defaultFps(); } }
const S = { me: null, accounts: new Map(), view: null, ws: null, wsDown: 0, tab: 'overview', frames: 0, lastFrameAt: 0, rightMode: false, keysOn: false, logTimer: null };

function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }

async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/api/auth')) { S.me.needsLogin = true; render(); throw new Error('not logged in'); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed - select and copy manually'); } }

// ------------------------------------------------------------------ routing
const route = () => { const m = location.hash.match(/^#\/a\/(\d+)/); return m ? Number(m[1]) : null; };
window.addEventListener('hashchange', () => { render(); watch(); });

async function boot() {
  try { S.me = await (await fetch('/api/me', { credentials: 'same-origin' })).json(); }
  catch { app.innerHTML = '<div class="boot">Dashboard unreachable - retrying…</div>'; return setTimeout(boot, 3000); }
  render();
  if (!S.me.needsLogin) connect();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function render() {
  if (S.me.needsLogin) return renderAuth();
  const id = route();
  if (!$('header.top')) app.innerHTML = `<header class="top"></header><main id="main"></main><footer class="foot"></footer>`;
  renderHeader();
  if (id != null && S.accounts.has(id)) renderAccount(id); else renderHome();
  $('footer.foot').innerHTML = `RS-SDK Dashboard v${esc(S.me.version)} · ${S.me.mode === 'hosted' ? 'hosted' : 'local'} · <a href="https://github.com/markeljan/rs-sdk-dashboard" target="_blank" rel="noopener">open source</a> · for <a href="https://github.com/MaxBittker/rs-sdk" target="_blank" rel="noopener">rs-sdk</a>`;
}

// ------------------------------------------------------------------ auth
function renderAuth(mode = S.me.signups ? 'signup' : 'login') {
  const local = S.me.mode === 'local';
  app.innerHTML = `<div class="auth">
    <div class="brand"><img src="/icon.svg" alt=""> RS-SDK Dashboard</div>
    <form class="card" id="authForm">
      <h2>${local ? 'Enter the dashboard password' : mode === 'signup' ? 'Create your free account' : 'Log in'}</h2>
      ${local ? '' : `<div class="field"><label for="email">Email</label><input class="input" id="email" type="email" autocomplete="email" required></div>`}
      <div class="field"><label for="pw">Password</label><input class="input" id="pw" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required minlength="${local ? 1 : 8}"></div>
      <div class="err" id="authErr"></div>
      <button class="btn primary" style="width:100%">${local ? 'Unlock' : mode === 'signup' ? 'Sign up' : 'Log in'}</button>
      ${!local && mode === 'signup' ? '<p class="small muted">Your game account passwords are stored encrypted and only used to connect to the game server you choose.</p>' : ''}
    </form>
    ${local ? '' : `<div class="switch">${mode === 'signup' ? 'Already have an account? <button class="linkbtn" id="sw">Log in</button>' : S.me.signups ? 'New here? <button class="linkbtn" id="sw">Create an account</button>' : ''}</div>`}
  </div>`;
  $('#sw')?.addEventListener('click', () => renderAuth(mode === 'signup' ? 'login' : 'signup'));
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api(mode === 'signup' && !local ? '/api/auth/signup' : '/api/auth/login', { body: { email: $('#email')?.value, password: $('#pw').value } });
      S.me = await api('/api/me'); app.innerHTML = ''; render(); connect();
    } catch (err) { $('#authErr').textContent = err.message; }
  });
  (local ? $('#pw') : $('#email')).focus();
}

// ------------------------------------------------------------------ header
function statusDot(c) { return c.online ? 'on' : c.gatewayError && !/no game client/.test(c.gatewayError) ? 'err' : c.client === 'starting' ? 'warn' : ''; }
function renderHeader() {
  const id = route();
  const cards = [...S.accounts.values()];
  $('header.top').innerHTML = `
    <a class="brand" href="#/"><img src="/icon.svg" alt=""><span class="hide-sm">RS Dashboard</span></a>
    <nav class="pills">${cards.map(c => `<a class="pill ${c.id === id ? 'active' : ''}" href="#/a/${c.id}"><span class="dot ${statusDot(c)}"></span>${esc(c.name)}</a>`).join('')}</nav>
    <button class="iconbtn" id="addBtn" title="Add account" aria-label="Add account">＋</button>
    <button class="iconbtn" id="setBtn" title="Settings" aria-label="Settings">⚙</button>`;
  $('#addBtn').onclick = () => openAdd();
  $('#setBtn').onclick = () => openSettings();
}

// ------------------------------------------------------------------ home
function renderHome() {
  watch(null);
  const cards = [...S.accounts.values()];
  const main = $('#main');
  if (!cards.length) { main.innerHTML = onboarding(); bindOnboarding(); return; }
  const online = cards.filter(c => c.online).length;
  main.innerHTML = `
    <div class="row" style="margin-bottom:12px"><h2 style="margin:0;font-size:18px">Accounts</h2><span class="muted small">${online}/${cards.length} online</span><span class="spacer"></span>
      <button class="btn sm" id="addBtn2">＋ Add account</button></div>
    <div class="grid">${cards.map(cardHtml).join('')}</div>`;
  $('#addBtn2').onclick = () => openAdd();
  main.querySelectorAll('.acct').forEach(el => el.onclick = () => { location.hash = `#/a/${el.dataset.id}`; });
}

function cardHtml(c) {
  const st = c.online ? 'online' : c.gatewayError || (c.botStatus === 'dead' ? 'offline' : c.botStatus);
  return `<button class="card acct" data-id="${c.id}">
    <div class="row"><span class="dot ${statusDot(c)}"></span><span class="name">${esc(c.name)}</span>${c.runClient ? `<span class="badge client">client ${esc(c.client)}</span>` : ''}<span class="spacer"></span></div>
    <div class="stats"><span>Combat <b>${c.combat ?? '–'}</b></span><span>Total <b>${c.totalLevel ?? '–'}</b></span><span>HP <b>${c.hp ? `${c.hp[0]}/${c.hp[1]}` : '–'}</b></span><span>XP/h <b>${fmt(c.xpPerHour)}</b></span></div>
    <div class="small muted">${esc(st)}${c.activity ? ` · ${esc(c.activity)}` : ''}</div>
  </button>`;
}

function onboarding() {
  const origin = S.me.publicUrl;
  return `<div class="hero"><h1>Watch and control your rs-sdk bots from anywhere</h1>
    <p class="muted">Add a game account to see its live stats, XP rates and messages. Turn on <b>Run game client</b> and the dashboard keeps the account logged in ${S.me.mode === 'hosted' ? 'in the cloud, 24/7' : 'on this machine'}, so your agents and scripts can drive it, and you can watch and tap in the game from your phone.</p></div>
  <div class="ways">
    <div class="card"><h2>1 · Add an account here</h2><p>Username and password from your bot's <span class="mono">bot.env</span>, or paste the whole file. New to rs-sdk? Generate a fresh account.</p><button class="btn primary" id="obAdd">＋ Add account</button></div>
    <div class="card"><h2>2 · ${S.me.mode === 'hosted' ? 'From your agent or terminal' : 'From the environment'}</h2>
      ${S.me.mode === 'hosted'
        ? `<p>Got an rs-sdk checkout with many bots? Create an API token in ⚙ Settings, then run this inside the checkout to add every <span class="mono">bots/*/bot.env</span>:</p><pre class="code">curl -fsSL ${esc(origin)}/connect.sh | RSD_TOKEN=rsd_… bash</pre><p>Or use <b>Import many</b> in ＋ Add account to pick the <span class="mono">bots</span> folder.</p>`
        : `<p>Start the dashboard with your accounts, or point it at your rs-sdk checkout:</p><pre class="code">RS_SDK_DIR=~/rs-sdk bun start
RSD_ACCOUNTS="mybot:secret, alt2:pw!" bun start
bun src/cli.ts import ~/rs-sdk/bots/mybot/bot.env</pre>`}
    </div>
    <div class="card"><h2>3 · Connect your agent</h2><p>Your Claude Code / Codex agent keeps using rs-sdk as usual (<span class="mono">bot.env</span> + MCP). Every account page has a <b>Connect agent</b> tab with the exact <span class="mono">bot.env</span> and an activity hook your scripts can post to.</p></div>
  </div>`;
}
function bindOnboarding() { $('#obAdd').onclick = () => openAdd(); }

// ------------------------------------------------------------------ account view
function renderAccount(id) {
  const c = S.accounts.get(id);
  const main = $('#main');
  if (!main.querySelector(`.view[data-id="${id}"]`)) {
    main.innerHTML = `<div class="view" data-id="${id}">
      <section>
        <div class="stage" id="stage"><canvas id="screen" width="765" height="503" tabindex="0" aria-label="Game view"></canvas><div class="overlay" id="overlay"></div></div>
        <div class="controls" id="controls"></div>
        <div id="belowStage" style="margin-top:12px"></div>
      </section>
      <aside class="side" id="side"></aside>
    </div>`;
    bindStage();
    watch(id);
  }
  updateAccount(c);
}

function updateAccount(c, live = false) {
  const v = S.view && S.view.id === c.id ? S.view : null;
  // stage overlay
  const ov = $('#overlay');
  const streaming = c.runClient && c.client === 'running' && Date.now() - S.lastFrameAt < 5000;
  if (streaming) ov.classList.add('hidden');
  else {
    ov.classList.remove('hidden');
    const note = v?.client?.note;
    ov.innerHTML = c.runClient
      ? `<div><h2>${c.client === 'running' ? 'Connecting to the game view…' : c.client === 'starting' ? 'Starting game client…' : c.client === 'error' ? 'Game client error' : 'Game client stopped'}</h2>
         <p>${esc(note || v?.client?.error || (c.client === 'running' ? 'Frames start once the page has loaded.' : 'The dashboard runs a headless game client for this account.'))}</p>
         ${c.client === 'error' || note ? `<button class="btn" id="ovRetry">Retry</button>` : ''}</div>`
      : `<div><h2>Observing via the gateway</h2><p>Stats come straight from the game server. To see and control the game here, let the dashboard run this account's game client${S.me.mode === 'hosted' ? ' in the cloud (it stays online when your computer is off)' : ''}. Close any other client logged in as <b>${esc(c.name)}</b> first.</p>
         <button class="btn primary" id="ovRun">▶ Run game client here</button></div>`;
    $('#ovRun')?.addEventListener('click', () => setRunClient(c.id, true));
    $('#ovRetry')?.addEventListener('click', () => setRunClient(c.id, true, true));
  }
  // controls (re-rendered only when the client mode changes, so held buttons survive live updates)
  const ctl = $('#controls');
  const sig = `${c.id}|${c.runClient}`;
  if (ctl.dataset.sig !== sig) { ctl.dataset.sig = sig; renderControls(c, ctl); }
  if (live && !['overview', 'skills', 'items'].includes(S.tab)) return;
  $('#side').innerHTML = sideHtml(c, v);
  bindSide(c, v);
}

function renderControls(c, ctl) {
  ctl.innerHTML = `
    ${c.runClient ? `
      <button class="btn ${S.rightMode ? 'on' : ''}" id="cRight" title="Next tap is a right click (or long-press)">Right-click</button>
      <button class="btn" data-key="left" title="Rotate camera">⟲</button><button class="btn" data-key="right" title="Rotate camera">⟳</button>
      <button class="btn" data-key="up">▲</button><button class="btn" data-key="down">▼</button>
      <button class="btn" id="cType">⌨ Type</button>
      <button class="btn" data-press="Escape">Esc</button>
      <span class="spacer"></span>
      <select class="btn" id="cFps" title="Live view frame rate (lower uses less mobile data)">${[[2, 'Data saver'], [5, '5 fps'], [10, '10 fps'], [20, '20 fps']].map(([f, l]) => `<option value="${f}" ${viewFps() === f ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" id="cReload" title="Reload the game page">↻</button>
      <button class="btn danger" id="cStop">■ Stop client</button>`
    : `<span class="muted small">Observe-only</span><span class="spacer"></span><button class="btn primary" id="cRun">▶ Run game client</button>`}`;
  $('#cRun')?.addEventListener('click', () => setRunClient(c.id, true));
  $('#cStop')?.addEventListener('click', () => { if (confirm(`Stop the game client for ${c.name}? Its bot scripts lose their client until it runs again.`)) setRunClient(c.id, false); });
  $('#cReload')?.addEventListener('click', async () => { await api(`/api/accounts/${c.id}/client/reload`, { method: 'POST' }); toast('Reloading game page'); });
  $('#cRight')?.addEventListener('click', e => { S.rightMode = !S.rightMode; e.currentTarget.classList.toggle('on', S.rightMode); });
  $('#cType')?.addEventListener('click', () => typeText());
  $('#cFps')?.addEventListener('change', e => { const f = Number(e.target.value); try { localStorage.setItem(FPS_KEY, String(f)); } catch {} if (S.ws?.readyState === 1) S.ws.send(JSON.stringify({ t: 'fps', fps: f })); });
  ctl.querySelectorAll('[data-key]').forEach(b => holdKey(b, b.dataset.key));
  ctl.querySelectorAll('[data-press]').forEach(b => b.onclick = () => send({ kind: 'key', key: b.dataset.press, action: 'press' }));
}

function sideHtml(c, v) {
  const s = v?.summary;
  const p = s?.player;
  const status = c.online ? `<span class="dot on"></span> Online` : `<span class="dot ${statusDot(c)}"></span> ${esc(c.gatewayError || 'Offline')}`;
  const tabs = ['overview', 'skills', 'items', 'chat', 'agent', 'settings'];
  const labels = { overview: 'Overview', skills: 'Skills', items: 'Items', chat: 'Chat', agent: 'Connect agent', settings: 'Account' };
  let body = '';
  if (S.tab === 'overview') body = `
    <div class="row small" style="margin-bottom:10px">${status}<span class="spacer"></span><span class="muted">${v?.stateAt ? 'updated ' + ago(v.stateAt) : ''}</span></div>
    ${c.activity ? `<div class="notice ok" style="margin-bottom:10px"><b>Activity:</b> ${esc(c.activity)} <span class="muted small">${ago(v?.activityAt)}</span></div>` : ''}
    <div class="kv">
      <div><span>Combat</span><b>${p?.combatLevel ?? '–'}</b></div>
      <div><span>Total lvl</span><b>${s?.totalLevel ?? '–'}</b></div>
      <div><span>XP / h</span><b>${fmt(v?.xpPerHour)}</b></div>
      <div><span>HP</span><b>${p ? `${p.hp}/${p.maxHp}` : '–'}</b><div class="bar"><i style="width:${p && p.maxHp ? Math.round(100 * p.hp / p.maxHp) : 0}%"></i></div></div>
      <div><span>Prayer</span><b>${s?.prayer ? `${s.prayer.level}/${s.prayer.base}` : '–'}</b></div>
      <div><span>Run</span><b>${p ? Math.round(p.runEnergy) + '%' : '–'}</b></div>
    </div>
    <p class="small muted" style="margin:10px 0 4px">${p ? `Position ${p.x}, ${p.z}${p.plane ? ' (floor ' + p.plane + ')' : ''} · <a href="https://mejrs.github.io/historical?m=-1&z=2&p=${p.plane}&x=${p.x}&y=${p.z}" target="_blank" rel="noopener">map</a>` : ''} ${s ? '· Total XP ' + fmt(s.totalXp) : ''}</p>
    ${spark(v?.history)}
    ${s?.dialog ? `<h3 style="margin-top:12px">Dialog</h3><div class="small">${esc(s.dialog.text || '')}${s.dialog.options?.length ? '<br>' + s.dialog.options.map(o => '• ' + esc(o)).join('<br>') : ''}</div>` : ''}
    <h3 style="margin-top:12px">Game messages</h3>
    <div class="msgs">${(s?.messages ?? []).slice(-12).map(m => `<div class="${m.sender ? 'player' : 'sys'}">${m.sender ? esc(m.sender) + ': ' : ''}${esc(m.text)}</div>`).join('') || '<span class="muted">none yet</span>'}</div>
    ${v?.botDir ? `<h3 style="margin-top:12px">Script log <span class="muted" id="logFile"></span></h3><div class="msgs" id="logBox"><span class="muted">loading…</span></div>` : ''}`;
  else if (S.tab === 'skills') body = s ? `<div class="skills">${s.skills.map(k => `<div class="skill ${k.level > k.base ? 'boost' : k.level < k.base ? 'drain' : ''}" title="${esc(k.name)}: ${k.xp.toLocaleString()} xp"><span>${esc(k.name.slice(0, 8))}</span><b>${k.level}${k.level !== k.base ? '/' + k.base : ''}</b></div>`).join('')}</div><p class="small muted">Total level ${s.totalLevel} · ${s.totalXp.toLocaleString()} xp</p>` : noState(c);
  else if (S.tab === 'items') body = s ? `<h3>Inventory (${s.inventory.length}/28)</h3><div class="inv">${s.inventory.map(i => `<div class="slot" title="${esc(i.name)}">${esc(i.name)}${i.count > 1 ? `<span class="c">${fmt(i.count)}</span>` : ''}</div>`).join('') || '<span class="muted small">empty</span>'}</div>
      <h3 style="margin-top:12px">Equipment</h3><div class="inv">${s.equipment.map(i => `<div class="slot">${esc(i.name)}${i.count > 1 ? `<span class="c">${fmt(i.count)}</span>` : ''}</div>`).join('') || '<span class="muted small">nothing worn</span>'}</div>` : noState(c);
  else if (S.tab === 'chat') body = `<p class="small muted">Say something in game through ${esc(c.name)}'s client (public chat).</p>
      <form id="sayForm" class="row"><input class="input grow" id="sayText" maxlength="400" placeholder="Message" autocomplete="off"><button class="btn primary">Send</button></form>
      <h3 style="margin-top:12px">Recent chat</h3><div class="msgs" id="chatBox"><span class="muted">loading…</span></div>`;
  else if (S.tab === 'agent') body = `<p class="small">Agents and scripts use rs-sdk exactly as before. Put this in <span class="mono">bots/${esc(c.name)}/bot.env</span> of your rs-sdk checkout:</p>
      <div class="copywrap"><pre class="code" id="botEnv">loading…</pre><button class="btn sm copy" id="copyEnv">Copy</button></div>
      <p class="small">${c.runClient ? `The game client runs on this dashboard, so <b>don't open another one</b>: run scripts with <span class="mono">bun bots/${esc(c.name)}/script.ts</span> or MCP <span class="mono">execute_code</span> and they drive this client.` : `No client runs here: open the game client yourself, or press <b>Run game client</b> so this dashboard hosts it.`}</p>
      <h3 style="margin-top:12px">Report activity to the dashboard</h3>
      <p class="small muted">Scripts can post what they're doing; it shows on the account card. Create a token in ⚙ Settings.</p>
      <pre class="code">curl -X POST ${esc(S.me.publicUrl)}/api/accounts/${esc(c.name)}/activity \\
  -H "Authorization: Bearer $RSD_TOKEN" \\
  -H "content-type: application/json" -d '{"text":"Mining iron at Al Kharid"}'</pre>
      <p class="small muted">Read state as JSON: <span class="mono">GET ${esc(S.me.publicUrl)}/api/accounts/${esc(c.name)}</span> with the same header.</p>`;
  else if (S.tab === 'settings') body = `
      <form id="editForm">
        <div class="field"><label>Game server</label><input class="input" id="eServer" value="${esc(c.server)}"></div>
        <div class="field"><label>Game password (leave empty to keep)</label><input class="input" id="ePw" type="password" autocomplete="new-password"></div>
        <label class="check"><input type="checkbox" id="eRun" ${c.runClient ? 'checked' : ''}><span>Run this account's game client on the dashboard${S.me.mode === 'hosted' ? ' (cloud, 24/7)' : ''}</span></label>
        <div class="err" id="eErr"></div>
        <div class="row"><button class="btn primary">Save</button><span class="spacer"></span><button type="button" class="btn danger" id="eDel">Remove account</button></div>
      </form>
      ${v?.botDir ? '<p class="small muted">Imported from your rs-sdk checkout.</p>' : ''}`;
  return `<div class="card"><div class="tabs">${tabs.map(t => `<button data-tab="${t}" class="${S.tab === t ? 'on' : ''}">${labels[t]}</button>`).join('')}</div>${body}</div>`;
}

function noState(c) { return `<p class="muted">${esc(c.gatewayError || 'No state yet.')} ${c.runClient ? '' : 'Stats appear when a game client is logged in as this account.'}</p>`; }

function spark(history) {
  if (!history || history.length < 2) return '';
  const xs = history.map(h => h[0]), ys = history.map(h => h[1]);
  const x0 = xs[0], x1 = xs[xs.length - 1], y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 === x0 || y1 === y0) return '';
  const pts = history.map(h => `${((h[0] - x0) / (x1 - x0) * 300).toFixed(1)},${(46 - (h[1] - y0) / (y1 - y0) * 42).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 48" preserveAspectRatio="none" aria-label="XP over the last 6 hours"><polyline fill="none" stroke="#e8b64c" stroke-width="2" points="${pts}"/></svg><div class="small muted">XP, last ${Math.max(1, Math.round((x1 - x0) / 3600000))} h (+${fmt(y1 - y0)})</div>`;
}

function bindSide(c, v) {
  const side = $('#side');
  side.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; updateAccount(S.accounts.get(c.id)); });
  const timerKey = `${c.id}|${S.tab}`;
  if (S.logTimerKey !== timerKey) { clearInterval(S.logTimer); S.logTimer = null; S.logTimerKey = null; }
  if (S.tab === 'overview' && v?.botDir && S.logTimer) { S.logLoad?.(); }
  else if (S.tab === 'overview' && v?.botDir) {
    const load = async () => { try { const l = await api(`/api/accounts/${c.id}/log`); const box = $('#logBox'); if (!box) return; $('#logFile').textContent = l.file ? `(${l.file})` : ''; box.innerHTML = l.lines.slice(-25).map(x => `<div>${esc(x)}</div>`).join('') || '<span class="muted">no log</span>'; box.scrollTop = box.scrollHeight; } catch {} };
    load(); S.logTimer = setInterval(load, 5000); S.logTimerKey = timerKey; S.logLoad = load;
  }
  if (S.tab === 'chat') {
    const load = async () => { try { const r = await api(`/api/accounts/${c.id}/chat`); const box = $('#chatBox'); if (!box) return; box.innerHTML = r.messages.slice(-40).map(m => `<div class="${m.type === 0 ? 'sys' : 'player'}">${m.sender ? esc(m.sender) + ': ' : ''}${esc(m.text)}</div>`).join('') || `<span class="muted">${esc(r.error || 'no messages')}</span>`; box.scrollTop = box.scrollHeight; } catch {} };
    load(); clearInterval(S.logTimer); S.logTimer = setInterval(load, 4000); S.logTimerKey = timerKey;
    $('#sayForm').onsubmit = async e => { e.preventDefault(); const t = $('#sayText').value.trim(); if (!t) return; try { const r = await api(`/api/accounts/${c.id}/say`, { body: { text: t } }); if (!r.ok) throw new Error(r.error); $('#sayText').value = ''; toast('Sent'); setTimeout(load, 800); } catch (err) { toast(err.message); } };
  }
  if (S.tab === 'agent') {
    api(`/api/accounts/${c.id}/connect`).then(r => { $('#botEnv').textContent = r.botEnv; $('#copyEnv').onclick = () => copy(r.botEnv); }).catch(() => {});
  }
  if (S.tab === 'settings') {
    $('#editForm').onsubmit = async e => {
      e.preventDefault();
      try { await api(`/api/accounts/${c.id}`, { method: 'PATCH', body: { server: $('#eServer').value.trim(), password: $('#ePw').value || undefined, runClient: $('#eRun').checked } }); toast('Saved'); }
      catch (err) { $('#eErr').textContent = err.message; }
    };
    $('#eDel').onclick = async () => {
      if (!confirm(`Remove ${c.name} from the dashboard? This doesn't touch the game account itself.`)) return;
      await api(`/api/accounts/${c.id}`, { method: 'DELETE' }); S.accounts.delete(c.id); location.hash = '#/'; toast('Removed');
    };
  }
}

async function setRunClient(id, on, retry = false) {
  try {
    if (retry) await api(`/api/accounts/${id}`, { method: 'PATCH', body: { runClient: false } });
    await api(`/api/accounts/${id}`, { method: 'PATCH', body: { runClient: on } });
    toast(on ? 'Starting game client…' : 'Game client stopped');
  } catch (err) { toast(err.message, 4000); }
}

// ------------------------------------------------------------------ live view: frames + input
let ctx = null;
function bindStage() {
  const cv = $('#screen');
  ctx = cv.getContext('2d');
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  let press = null, lpTimer = null;
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    cv.focus();
    if (e.pointerType === 'mouse') {
      send({ kind: 'click', ...pos(e), button: e.button === 2 || S.rightMode ? 'right' : 'left' });
      if (S.rightMode) { S.rightMode = false; $('#cRight')?.classList.remove('on'); }
      return;
    }
    press = { ...pos(e), at: Date.now(), long: false };
    lpTimer = setTimeout(() => { if (press) { press.long = true; send({ kind: 'click', x: press.x, y: press.y, button: 'right' }); navigator.vibrate?.(20); } }, 480);
  });
  cv.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') { const now = Date.now(); if (now - (cv._mv || 0) > 120) { cv._mv = now; send({ kind: 'move', ...pos(e) }); } return; }
    if (press) { const p = pos(e); if (Math.hypot(p.x - press.x, p.y - press.y) > 0.03) { clearTimeout(lpTimer); press = null; } }
  });
  cv.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse' || !press) return;
    clearTimeout(lpTimer);
    if (!press.long) {
      const right = S.rightMode; if (right) { S.rightMode = false; $('#cRight')?.classList.remove('on'); }
      send({ kind: 'click', x: press.x, y: press.y, button: right ? 'right' : 'left' });
    }
    press = null;
  });
  cv.addEventListener('pointercancel', () => { clearTimeout(lpTimer); press = null; });
  // desktop keyboard: typing goes to the game while the view has focus
  cv.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey) return;
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    e.preventDefault();
    if (map[e.key]) { if (!e.repeat) send({ kind: 'key', key: map[e.key], action: 'down', holdMs: 4000 }); return; }
    if (e.key.length === 1 || ['Enter', 'Backspace', 'Escape', 'Tab', 'Space', 'Delete'].includes(e.key)) send({ kind: 'key', key: e.key === ' ' ? 'Space' : e.key, action: 'press' });
  });
  cv.addEventListener('keyup', e => {
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (map[e.key]) send({ kind: 'key', key: map[e.key], action: 'up' });
  });
}

function holdKey(btn, key) {
  let t = null;
  const start = e => { e.preventDefault(); send({ kind: 'key', key, action: 'down', holdMs: 1200 }); t = setInterval(() => send({ kind: 'key', key, action: 'down', holdMs: 1200 }), 800); };
  const stop = () => { if (!t) return; clearInterval(t); t = null; send({ kind: 'key', key, action: 'up' }); };
  btn.addEventListener('pointerdown', start); btn.addEventListener('pointerup', stop); btn.addEventListener('pointerleave', stop); btn.addEventListener('pointercancel', stop);
}

function typeText() {
  const text = prompt('Type into the game (Enter is pressed after):');
  if (text != null && text !== '') send({ kind: 'text', text, enter: true });
}

function send(ev) {
  if (S.ws?.readyState === 1) S.ws.send(JSON.stringify({ t: 'input', ev }));
}

async function drawFrame(buf) {
  const dv = new DataView(buf);
  const id = dv.getUint32(0), w = dv.getUint16(4), h = dv.getUint16(6);
  if (id !== route()) return;
  const bmp = await createImageBitmap(new Blob([buf.slice(8)], { type: 'image/jpeg' }));
  const cv = $('#screen');
  if (!cv) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; cv.style.aspectRatio = `${w} / ${h}`; }
  ctx.drawImage(bmp, 0, 0); bmp.close?.();
  const first = Date.now() - S.lastFrameAt > 5000;
  S.lastFrameAt = Date.now();
  if (first) $('#overlay')?.classList.add('hidden');
}

// ------------------------------------------------------------------ websocket
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  ws.onopen = () => { S.wsDown = 0; watch(); };
  ws.onmessage = ev => {
    if (typeof ev.data !== 'string') return void drawFrame(ev.data);
    const m = JSON.parse(ev.data);
    if (m.t === 'accounts') { S.accounts = new Map(m.accounts.map(c => [c.id, c])); render(); }
    else if (m.t === 'card') {
      const isNew = !S.accounts.has(m.card.id);
      S.accounts.set(m.card.id, m.card);
      if (isNew || route() == null) render(); else { renderHeader(); if (route() === m.card.id && !isTyping()) updateAccount(m.card, true); }
    } else if (m.t === 'view') { S.view = m.view; if (route() === m.view.id && S.accounts.has(m.view.id) && !isTyping()) updateAccount(S.accounts.get(m.view.id), true); }
    else if (m.t === 'inputError') toast(m.error);
  };
  ws.onclose = async () => {
    S.ws = null;
    const wait = Math.min(15000, 1000 * 2 ** S.wsDown++);
    try { const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json(); if (me.needsLogin) { S.me = me; return render(); } } catch {}
    setTimeout(connect, wait);
  };
}
function isTyping() { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && $('#side')?.contains(a); }
let watching;
function watch(id = route()) {
  if (watching === id && S.ws?.readyState === 1 && watch.sent === S.ws) return;
  watching = id; S.view = null; S.lastFrameAt = 0;
  if (S.ws?.readyState === 1) { S.ws.send(JSON.stringify({ t: 'watch', id, fps: viewFps() })); watch.sent = S.ws; }
}

// ------------------------------------------------------------------ modals
function modal(html, bind) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(bg);
  bind?.(bg, close);
  bg.querySelector('input, textarea')?.focus();
  return close;
}

function openAdd() {
  modal(`<h2>Add an account</h2>
    <div class="tabs"><button class="on" data-m="form">Username + password</button><button data-m="env">Paste bot.env</button><button data-m="bulk">Import many</button></div>
    <form id="addForm">
      <div id="mForm">
        <div class="field"><label for="aName">Game username</label><div class="row"><input class="input grow" id="aName" maxlength="12" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="mybot"><button type="button" class="btn sm" id="aGen" title="Create a brand-new random account">Generate new</button></div></div>
        <div class="field"><label for="aPw">Game password</label><input class="input" id="aPw" type="password" autocomplete="off"></div>
        <div class="field"><label for="aServer">Game server</label><input class="input" id="aServer" value="${esc(S.me.defaultServer)}" autocapitalize="off" spellcheck="false"></div>
      </div>
      <div id="mEnv" class="hidden"><div class="field"><label for="aEnv">Contents of bots/&lt;name&gt;/bot.env</label><textarea class="input" id="aEnv" placeholder="BOT_USERNAME=mybot&#10;PASSWORD=…&#10;SERVER=rs-sdk-demo.fly.dev"></textarea></div></div>
      <div id="mBulk" class="hidden">
        <div class="field"><label for="aDir">Pick your rs-sdk <b>bots</b> folder (every <span class="mono">bot.env</span> inside is added)</label><input class="input" id="aDir" type="file" webkitdirectory multiple></div>
        <p class="small muted">Or from a terminal in your rs-sdk checkout (needs an API token from ⚙ Settings):</p>
        <div class="copywrap"><pre class="code" id="bulkCmd">curl -fsSL ${esc(S.me.publicUrl)}/connect.sh | RSD_TOKEN=rsd_… bash</pre><button type="button" class="btn sm copy" id="cpBulk">Copy</button></div>
        <div class="msgs" id="bulkLog"></div>
      </div>
      <label class="check"><input type="checkbox" id="aRun"><span><b>Run the game client on this dashboard</b><br><span class="small muted">${S.me.mode === 'hosted' ? 'Keeps the account logged in from our servers 24/7, so your scripts work while your computer is off, and you can watch/tap in the game.' : 'A headless browser on this machine keeps the account logged in; you can watch and tap in the game from any device.'} Only one client can be logged in per account: close yours first.</span></span></label>
      <div class="err" id="aErr"></div>
      <div class="actions"><button type="button" class="btn ghost" id="aCancel">Cancel</button><button class="btn primary">Add account</button></div>
      <p class="small muted" id="genNote"></p>
    </form>`, (bg, close) => {
    let m = 'form';
    bg.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { m = b.dataset.m; bg.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b)); $('#mForm', bg).classList.toggle('hidden', m !== 'form'); $('#mEnv', bg).classList.toggle('hidden', m !== 'env'); $('#mBulk', bg).classList.toggle('hidden', m !== 'bulk'); });
    $('#cpBulk', bg).onclick = () => copy($('#bulkCmd', bg).textContent);
    $('#aCancel', bg).onclick = close;
    $('#aGen', bg).onclick = async () => {
      const g = await api('/api/accounts/generate', { method: 'POST' });
      $('#aName', bg).value = g.name; $('#aPw', bg).value = g.password; $('#aPw', bg).type = 'text'; $('#aRun', bg).checked = true;
      $('#genNote', bg).innerHTML = 'A new game account is created on the server the first time it logs in. New characters start on Tutorial Island: run <span class="mono">await bot.skipTutorial()</span> once from your agent (MCP <span class="mono">execute_code</span>) to skip it. Save the password somewhere: it is shown again under <b>Connect agent</b>.';
    };
    $('#addForm', bg).onsubmit = async e => {
      e.preventDefault();
      if (m === 'bulk') {
        const files = [...($('#aDir', bg).files || [])].filter(f => f.name === 'bot.env' && !/(^|\/)_[^/]*\//.test(f.webkitRelativePath || ''));
        const log = $('#bulkLog', bg);
        if (!files.length) { $('#aErr', bg).textContent = 'No bot.env files in that folder - pick the bots/ folder of your rs-sdk checkout.'; return; }
        let ok = 0;
        for (const f of files) {
          const text = await f.text();
          try { const r = await api('/api/accounts', { body: { botEnv: text, runClient: $('#aRun', bg).checked } }); ok++; log.insertAdjacentHTML('beforeend', `<div>✓ ${esc(r.account.name)}</div>`); }
          catch (err) { log.insertAdjacentHTML('beforeend', `<div class="sys">✗ ${esc(f.webkitRelativePath || f.name)}: ${esc(err.message)}</div>`); if (/limit/.test(err.message)) break; }
          log.scrollTop = log.scrollHeight;
        }
        toast(`Added ${ok} of ${files.length} accounts`);
        return;
      }
      const payload = m === 'env' ? { botEnv: $('#aEnv', bg).value, runClient: $('#aRun', bg).checked }
        : { name: $('#aName', bg).value.trim(), password: $('#aPw', bg).value, server: $('#aServer', bg).value.trim(), runClient: $('#aRun', bg).checked };
      try { const r = await api('/api/accounts', { body: payload }); close(); toast(`Added ${r.account.name}`); location.hash = `#/a/${r.account.id}`; }
      catch (err) { $('#aErr', bg).textContent = err.message; }
    };
  });
}

function openSettings() {
  const hosted = S.me.mode === 'hosted';
  modal(`<h2>Settings</h2>
    ${hosted ? `<p class="small muted">Signed in as <b>${esc(S.me.user?.email)}</b></p>` : `<p class="small muted">Local dashboard${S.me.passwordLogin ? ' (password protected)' : ''}${S.me.rsSdk ? ' · rs-sdk checkout linked' : ''}</p>`}
    <h3>API tokens</h3>
    <p class="small muted">For agents and scripts: add accounts, read state, post activity. Send as <span class="mono">Authorization: Bearer &lt;token&gt;</span>.</p>
    <div id="tokList" class="small"></div>
    <form id="tokForm" class="row" style="margin:8px 0 16px"><input class="input grow" id="tokName" placeholder="Token name, e.g. laptop agent" maxlength="60"><button class="btn">Create</button></form>
    <div id="tokNew"></div>
    ${hosted ? `<h3>Change password</h3>
      <form id="pwForm"><div class="row"><input class="input grow" id="pwCur" type="password" placeholder="Current" autocomplete="current-password"><input class="input grow" id="pwNew" type="password" placeholder="New (8+ chars)" autocomplete="new-password"><button class="btn">Change</button></div></form>
      <div class="actions" style="justify-content:space-between;margin-top:18px"><button class="btn danger" id="delMe">Delete my dashboard account</button><button class="btn" id="logout">Log out</button></div>`
    : S.me.passwordLogin ? `<div class="actions"><button class="btn" id="logout">Log out</button></div>` : ''}
    <h3 style="margin-top:16px">Install on your phone</h3>
    <p class="small muted">Open this page on your phone and use <b>Share → Add to Home Screen</b> (iOS) or <b>Install app</b> (Android).${hosted ? '' : ' Your phone must reach this machine (same Wi-Fi), or use the hosted dashboard for access from anywhere.'}</p>`,
  (bg, close) => {
    const load = async () => { const r = await api('/api/tokens'); $('#tokList', bg).innerHTML = r.tokens.map(t => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0"><span><b>${esc(t.name)}</b> <span class="mono muted">${esc(t.prefix)}…</span></span><span class="muted">${t.last_used_at ? 'used ' + ago(t.last_used_at) : 'unused'} <button class="btn sm danger" data-del="${t.id}">Revoke</button></span></div>`).join('') || '<span class="muted">No tokens yet.</span>';
      bg.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api(`/api/tokens/${b.dataset.del}`, { method: 'DELETE' }); load(); }); };
    load();
    $('#tokForm', bg).onsubmit = async e => { e.preventDefault(); const r = await api('/api/tokens', { body: { name: $('#tokName', bg).value || 'agent' } }); $('#tokNew', bg).innerHTML = `<div class="notice ok small">New token (shown once):<div class="copywrap"><pre class="code">${esc(r.token)}</pre><button class="btn sm copy" id="cpTok">Copy</button></div></div>`; $('#cpTok', bg).onclick = () => copy(r.token); $('#tokName', bg).value = ''; load(); };
    $('#pwForm', bg)?.addEventListener('submit', async e => { e.preventDefault(); try { await api('/api/auth/password', { body: { current: $('#pwCur', bg).value, next: $('#pwNew', bg).value } }); toast('Password changed'); close(); } catch (err) { toast(err.message); } });
    $('#logout', bg)?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
    $('#delMe', bg)?.addEventListener('click', async () => {
      const pw = prompt('Delete your dashboard account and stop all its game clients. Enter your password to confirm:');
      if (!pw) return;
      try { await api('/api/auth/delete', { body: { password: pw } }); location.reload(); } catch (err) { toast(err.message); }
    });
  });
}

boot();
