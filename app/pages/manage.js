// Login / welcome / account management for the RS-SDK Dashboard. The dashboard itself is the rs-sdk fleet dashboard
// at "/"; this page only manages who you are, which accounts it shows and how your agent connects.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = t => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const app = $('#app');
let me = null, token = '', skill = '';

function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }
async function api(path, opts = {}) {
  const r = await fetch('/_rsd/api' + path, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  const ct = r.headers.get('content-type') || '';
  const j = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function copy(text, what = 'Copied') { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy failed - select the text and copy it'); } }

async function boot() {
  me = await api('/me');
  if (me.needsLogin) return renderAuth(me.signups && new URLSearchParams(location.search).get('mode') !== 'login' ? 'signup' : 'login');
  [{ token }, skill] = await Promise.all([api('/token'), api('/skill')]);
  render();
}

// ------------------------------------------------------------------ auth
function renderAuth(mode) {
  const local = me.mode === 'local';
  history.replaceState(null, '', '/_rsd/login');
  app.innerHTML = `<div class="auth">
    <div class="brand"><img src="/icons/icon.svg" alt="">RS-SDK Dashboard</div>
    <form class="card" id="f" style="display:grid;gap:12px">
      <h2>${local ? 'Dashboard password' : mode === 'signup' ? 'Create your free account' : 'Log in'}</h2>
      ${local ? '' : `<label class="f">Email<input class="input" id="email" type="email" autocomplete="email" required></label>`}
      <label class="f">Password<input class="input" id="pw" type="password" required minlength="${local ? 1 : 8}" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>
      <div class="err" id="err"></div>
      <button class="btn primary">${local ? 'Unlock' : mode === 'signup' ? 'Sign up' : 'Log in'}</button>
      ${!local && mode === 'signup' ? '<span class="hint">Watch and control your rs-sdk bots from anywhere. Game passwords are stored encrypted and only sent to the game server you pick.</span>' : ''}
    </form>
    ${local ? '' : `<p class="hint" style="text-align:center">${mode === 'signup' ? 'Have an account? <a href="#" id="sw">Log in</a>' : me.signups ? 'New here? <a href="#" id="sw">Create an account</a>' : ''}</p>`}
  </div>`;
  $('#sw')?.addEventListener('click', e => { e.preventDefault(); renderAuth(mode === 'signup' ? 'login' : 'signup'); });
  $('#f').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api(mode === 'signup' && !local ? '/auth/signup' : '/auth/login', { body: { email: $('#email')?.value, password: $('#pw').value } }); await boot(); }
    catch (err) { $('#err').textContent = err.message; }
  });
  (local ? $('#pw') : $('#email')).focus();
}

// ------------------------------------------------------------------ main
async function render() {
  const { accounts } = await api('/accounts');
  const first = accounts.length === 0;
  history.replaceState(null, '', first ? '/_rsd/welcome' : '/_rsd/manage' + location.hash);
  app.innerHTML = `
  <header class="top"><a class="brand" href="/"><img src="/icons/icon.svg" alt="">RS-SDK Dashboard</a><span class="grow"></span>
    ${accounts.length ? '<a class="btn primary" href="/">Open dashboard →</a>' : ''}</header>
  <main>
    ${first ? `<section class="hero"><h1>Set up your dashboard</h1><p>Add your rs-sdk bot accounts. Fastest: paste the skill below into your AI agent (Claude Code, Codex, ChatGPT…) and it connects every bot in your rs-sdk checkout.</p></section>` : ''}
    <div class="grid2">
      <section class="card" id="agent">
        <h2>Connect your agent</h2>
        <p class="small" style="margin:0 0 10px">Copy this into your agent. It contains your dashboard URL and an API token, and tells the agent how to add your bots, host their game clients and report what they're doing.</p>
        <div class="row" style="margin-bottom:10px"><button class="btn primary" id="cpSkill">Copy agent skill</button><button class="btn" id="showSkill">Show</button><a class="btn" id="dlSkill" download="SKILL.md">Download SKILL.md</a></div>
        <pre class="code" id="skillText" hidden></pre>
        <h2 style="margin-top:14px">Or from a terminal in your rs-sdk checkout</h2>
        <div class="copywrap"><pre class="code" id="connectCmd">curl -fsSL ${esc(me.origin)}/connect.sh | RSD_TOKEN=${esc(token)} bash</pre><button class="btn sm" id="cpCmd">Copy</button></div>
        <span class="hint">Adds every <code>bots/*/bot.env</code>. Put <code>RUN_CLIENT=1</code> before <code>bash</code> to also host their game clients here.</span>
        <h2 style="margin-top:14px">Show what the bots are doing <span id="connState" class="muted"></span></h2>
        <div class="copywrap"><pre class="code" id="connectorCmd">curl -fsSL ${esc(me.origin)}/connector.ts -o .rsd-connector.ts && RSD_TOKEN=${esc(token)} bun .rsd-connector.ts</pre><button class="btn sm" id="cpConn">Copy</button></div>
        <span class="hint">Run it next to your bots (in the rs-sdk checkout) and leave it running: it sends each bot's log, running script, gold and drops here, and applies Pause from the dashboard.</span>
      </section>
      <section class="card" id="add">
        <h2>Add an account</h2>
        <div class="tabs"><button class="on" data-m="form">Username + password</button><button data-m="env">Paste bot.env</button><button data-m="bulk">Import bots folder</button></div>
        <form id="addForm" style="display:grid;gap:10px">
          <div id="mForm" style="display:grid;gap:10px">
            <label class="f">Game username<div class="row"><input class="input grow" id="aName" maxlength="12" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="mybot"><button type="button" class="btn sm" id="aGen" title="Make up a brand-new account">New account</button></div></label>
            <label class="f">Game password<input class="input" id="aPw" type="password" autocomplete="off"></label>
            <label class="f">Game server<input class="input" id="aServer" value="${esc(me.defaultServer)}" autocapitalize="off" spellcheck="false"></label>
          </div>
          <div id="mEnv" hidden><label class="f">Contents of bots/&lt;name&gt;/bot.env<textarea class="input" id="aEnv" placeholder="BOT_USERNAME=mybot&#10;PASSWORD=…&#10;SERVER=rs-sdk-demo.fly.dev"></textarea></label></div>
          <div id="mBulk" hidden><label class="f">Your rs-sdk <b>bots</b> folder (every bot.env inside is added)<input class="input" id="aDir" type="file" webkitdirectory multiple></label><pre class="code" id="bulkLog" hidden></pre></div>
          <label class="check"><input type="checkbox" id="aRun"><span><b>Run the game client here</b><br><span class="hint">${me.mode === 'hosted' ? 'Keeps the account logged in from our servers 24/7: your scripts keep working while your computer sleeps, and you get the live game view.' : 'A headless Chrome on this machine keeps the account logged in and streams the live game view.'} Only one client per account: close yours first. Without this the account is shown as a lite (drawn) view from its own client.</span></span></label>
          <div class="err" id="aErr"></div>
          <div class="row"><button class="btn primary">Add account</button><span class="hint" id="genNote"></span></div>
        </form>
      </section>
    </div>
    ${accounts.length ? `<section class="card"><h2>Your accounts <span class="muted">${accounts.length}${me.user.limits.accounts ? ' / ' + me.user.limits.accounts : ''}</span></h2>
      ${accounts.map((a, i) => `<div class="acct" data-name="${esc(a.name)}">
        <div><span class="nm">${esc(a.name)}</span><span class="tag ${a.runClient ? 'managed' : ''}">${a.runClient ? 'game client here' : 'lite'}</span>${a.source !== 'ui' ? `<span class="tag">${esc(a.source)}</span>` : ''}<br><span class="hint">${esc(a.server)}</span></div>
        <div class="row"><span class="ord"><button class="btn sm" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move ${esc(a.name)} up">▲</button><button class="btn sm" data-act="down" ${i === accounts.length - 1 ? 'disabled' : ''} title="Move down" aria-label="Move ${esc(a.name)} down">▼</button><button class="btn sm" data-act="top" ${i === 0 ? 'disabled' : ''} title="Move to the top">⤒</button></span><button class="btn sm toggle ${a.runClient ? 'on' : ''}" data-act="client">${a.runClient ? 'Client: on' : 'Client: off'}</button><button class="btn sm" data-act="edit">Edit</button><button class="btn sm danger" data-act="del">Remove</button></div>
      </div>`).join('')}
      <span class="hint">Client on = this dashboard runs the account's game client (live view, tap to play). Off = shown as a lite view while its client runs elsewhere (your browser tab, the lite runner).${me.user.limits.clients < 1000 ? ` Up to ${me.user.limits.clients} game clients.` : ''}</span>
    </section>` : ''}
    <section class="card"><h2>API tokens in use</h2><div id="tokens" class="small"></div>
      <span class="hint">Every visit hands out a fresh token (above). A token is saved here the first time something uses it; revoke any you don't recognise.</span></section>
    ${me.mode === 'hosted' ? `<section class="card"><h2>Your dashboard account</h2>
      <p class="small" style="margin:0 0 10px">Signed in as <b>${esc(me.user.email)}</b></p>
      <form id="pwForm" class="row"><input class="input grow" id="pwCur" type="password" placeholder="Current password" autocomplete="current-password"><input class="input grow" id="pwNew" type="password" placeholder="New password (8+)" autocomplete="new-password"><button class="btn">Change password</button></form>
      <div class="row" style="margin-top:10px;justify-content:space-between"><button class="btn" id="logout">Log out</button><button class="btn danger" id="delMe">Delete my account</button></div></section>`
    : me.passwordLogin ? `<section class="card"><button class="btn" id="logout">Log out</button></section>` : ''}
    <p class="hint" style="text-align:center">RS-SDK Dashboard v${esc(me.version)} · ${me.mode}${me.rsSdk ? ' · rs-sdk checkout linked' : ''}</p>
  </main>`;
  bind(accounts);
  loadTokens();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

function bind(accounts) {
  $('#skillText').textContent = skill;
  $('#cpSkill').onclick = () => copy(skill, 'Agent skill copied - paste it into your agent');
  $('#showSkill').onclick = () => { const p = $('#skillText'); p.hidden = !p.hidden; };
  $('#dlSkill').href = URL.createObjectURL(new Blob([skill], { type: 'text/markdown' }));
  $('#cpCmd').onclick = () => copy($('#connectCmd').textContent);
  $('#cpConn').onclick = () => copy($('#connectorCmd').textContent);
  api('/connect/status').then(c => { $('#connState').textContent = c ? `· connected from ${c.host}, ${ago(Date.now() - c.ageMs)} (${c.accounts} bots)` : '· not connected'; }).catch(() => {});
  const order = accounts.map(a => a.name);
  const reorder = async (name, to) => {
    const next = order.filter(n => n !== name); next.splice(Math.max(0, Math.min(next.length, to)), 0, name);
    try { await api('/accounts/order', { body: { names: next } }); await render(); } catch (err) { toast(err.message); }
  };
  let m = 'form';
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    m = b.dataset.m; document.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b));
    $('#mForm').hidden = m !== 'form'; $('#mEnv').hidden = m !== 'env'; $('#mBulk').hidden = m !== 'bulk';
  });
  $('#aGen').onclick = async () => {
    const g = await api('/accounts/generate', { method: 'POST' });
    $('#aName').value = g.name; $('#aPw').value = g.password; $('#aPw').type = 'text'; $('#aRun').checked = true;
    $('#genNote').textContent = 'A new character is created when it first logs in (on Tutorial Island: have your agent run bot.skipTutorial()).';
  };
  $('#addForm').onsubmit = async e => {
    e.preventDefault();
    const run = $('#aRun').checked;
    $('#aErr').textContent = '';
    if (m === 'bulk') {
      const files = [...($('#aDir').files || [])].filter(f => f.name === 'bot.env' && !/(^|\/)_[^/]*\//.test(f.webkitRelativePath || ''));
      if (!files.length) { $('#aErr').textContent = 'No bot.env files in that folder - pick the bots/ folder of your rs-sdk checkout.'; return; }
      const log = $('#bulkLog'); log.hidden = false; log.textContent = '';
      let ok = 0;
      for (const f of files) {
        try { const r = await api('/accounts', { body: { botEnv: await f.text(), runClient: run } }); ok++; log.textContent += `✓ ${r.account.name}\n`; }
        catch (err) { log.textContent += `✗ ${f.webkitRelativePath || f.name}: ${err.message}\n`; if (/limit|capacity/.test(err.message)) break; }
      }
      toast(`Added ${ok} of ${files.length}`);
      if (ok) setTimeout(render, 800);
      return;
    }
    const payload = m === 'env' ? { botEnv: $('#aEnv').value, runClient: run }
      : { name: $('#aName').value.trim(), password: $('#aPw').value, server: $('#aServer').value.trim(), runClient: run };
    try { const r = await api('/accounts', { body: payload }); toast(`Added ${r.account.name}`); await render(); }
    catch (err) { $('#aErr').textContent = err.message; }
  };
  document.querySelectorAll('.acct').forEach(row => {
    const name = row.dataset.name, a = accounts.find(x => x.name === name);
    const path = `/accounts/${encodeURIComponent(name)}`;
    const at = order.indexOf(name);
    row.querySelector('[data-act=up]').onclick = () => reorder(name, at - 1);
    row.querySelector('[data-act=down]').onclick = () => reorder(name, at + 1);
    row.querySelector('[data-act=top]').onclick = () => reorder(name, 0);
    row.querySelector('[data-act=client]').onclick = async e => {
      const b = e.currentTarget; b.disabled = true;
      try { await api(path, { method: 'PATCH', body: { runClient: !a.runClient } }); toast(a.runClient ? `Stopped ${name}'s game client` : `Starting ${name}'s game client`); await render(); }
      catch (err) { toast(err.message, 4500); b.disabled = false; }
    };
    row.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`Remove ${name} from the dashboard? The game account itself is untouched.`)) return;
      try { await api(path, { method: 'DELETE' }); toast(`Removed ${name}`); await render(); } catch (err) { toast(err.message); }
    };
    row.querySelector('[data-act=edit]').onclick = async () => {
      const server = prompt(`Game server for ${name}:`, a.server); if (server == null) return;
      const password = prompt(`New game password for ${name} (leave empty to keep):`, '') ?? '';
      try { await api(path, { method: 'PATCH', body: { server: server.trim(), password: password || undefined } }); toast('Saved'); await render(); } catch (err) { toast(err.message); }
    };
  });
  $('#pwForm')?.addEventListener('submit', async e => { e.preventDefault(); try { await api('/auth/password', { body: { current: $('#pwCur').value, next: $('#pwNew').value } }); toast('Password changed'); $('#pwCur').value = $('#pwNew').value = ''; } catch (err) { toast(err.message); } });
  $('#logout')?.addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/_rsd/login'; });
  $('#delMe')?.addEventListener('click', async () => {
    const pw = prompt('This deletes your dashboard account, its accounts list and stops its game clients. Enter your password to confirm:');
    if (!pw) return;
    try { await api('/auth/delete', { body: { password: pw } }); location.href = '/_rsd/login'; } catch (err) { toast(err.message); }
  });
}

async function loadTokens() {
  const { tokens } = await api('/tokens');
  const el = $('#tokens');
  el.innerHTML = tokens.length ? tokens.map(t => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
    <span><b>${esc(t.name)}</b> <span class="muted">…${esc(t.id.slice(-6))} · first used ${ago(t.firstUsedAt)} · last ${ago(t.lastUsedAt)} · ${t.uses} calls</span></span>
    <span class="row"><button class="btn sm" data-ren="${t.id}">Rename</button><button class="btn sm danger" data-rev="${t.id}">Revoke</button></span></div>`).join('')
    : '<p class="muted" style="margin:0 0 8px">None used yet.</p>';
  el.querySelectorAll('[data-rev]').forEach(b => b.onclick = async () => { if (!confirm('Revoke this token? Agents using it lose access.')) return; await api(`/tokens/${b.dataset.rev}`, { method: 'DELETE' }); loadTokens(); });
  el.querySelectorAll('[data-ren]').forEach(b => b.onclick = async () => { const n = prompt('Name this token (e.g. laptop Claude):'); if (n) { await api(`/tokens/${b.dataset.ren}`, { method: 'PATCH', body: { name: n } }); loadTokens(); } });
}

boot().catch(err => { app.innerHTML = `<p class="err" style="text-align:center;margin-top:30vh">${esc(err.message)}</p>`; });
