// Added to the dashboard page by the front server: an "Accounts" group at the top of Settings (manage accounts,
// connect an agent, log out). Everything else on the page is the rs-sdk dashboard, unchanged.
(async () => {
  const sheet = document.querySelector('#moreSheet .in');
  if (!sheet) return;
  let me = null;
  try { me = await (await fetch('/_rsd/api/me', { credentials: 'same-origin' })).json(); } catch { /* offline */ }
  const row = (href, title, sub) => `<a class="srow" href="${href}" style="text-decoration:none"><span>${title}<small>${sub}</small></span><span class="muted">›</span></a>`;
  const g = document.createElement('section');
  g.className = 'grp';
  g.innerHTML = `<h3>Accounts</h3>
    ${row('/_rsd/manage', 'Manage accounts', 'Add, remove, reorder, game clients on/off')}
    ${row('/_rsd/manage#agent', 'Connect your agent', 'Copy the setup skill for Claude, Codex…')}
    ${me?.user?.email || me?.passwordLogin ? `<button class="srow" type="button" id="rsdLogout"><span>Log out<small>${me?.user?.email ?? ''}</small></span><span class="muted">›</span></button>` : ''}`;
  sheet.insertBefore(g, sheet.querySelector('.grp') ?? null);
  document.getElementById('rsdLogout')?.addEventListener('click', async () => {
    await fetch('/_rsd/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/_rsd/login?logout=1';
  });
})();
