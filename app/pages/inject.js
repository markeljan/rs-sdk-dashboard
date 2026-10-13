// Added to the fleet dashboard page by the front server: an "Accounts & agents" row at the top of its Settings sheet
// (add/manage accounts, connect an agent, log out). Everything else on the page is the fleet dashboard, unchanged.
(async () => {
  const sheet = document.querySelector('#moreSheet .in');
  if (!sheet) return;
  let me = null;
  try { me = await (await fetch('/_rsd/api/me', { credentials: 'same-origin' })).json(); } catch { /* offline */ }
  const h = document.createElement('h3');
  h.textContent = 'Accounts & agents';
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<a class="btn" href="/_rsd/manage#add" style="text-decoration:none;color:inherit">＋ Add account</a>
    <a class="btn" href="/_rsd/manage" style="text-decoration:none;color:inherit">Manage accounts</a>
    <a class="btn" href="/_rsd/manage#agent" style="text-decoration:none;color:inherit">Connect your agent</a>
    ${me?.user?.email || me?.passwordLogin ? '<button class="btn" type="button" id="rsdLogout">Log out</button>' : ''}`;
  const anchor = [...sheet.children].find(el => el.tagName === 'H3');
  sheet.insertBefore(h, anchor ?? null);
  sheet.insertBefore(row, anchor ?? null);
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = me?.user?.email ? `Signed in as ${me.user.email}.` : 'Add or remove accounts, turn game clients on/off, and copy the setup skill for your AI agent.';
  sheet.insertBefore(hint, anchor ?? null);
  document.getElementById('rsdLogout')?.addEventListener('click', async () => {
    await fetch('/_rsd/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/_rsd/login';
  });
})();
