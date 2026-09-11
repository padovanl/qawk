/* Imported for their side effects: each view registers itself in VIEWS,
   and these two install the background timers. */
import './notices.js';
import './idle.js';
import './views/about.js';
import './views/account.js';
import './views/audit.js';
import './views/centres.js';
import './views/config.js';
import './views/dashboard.js';
import './views/deploy.js';
import './views/deployments.js';
import './views/ds.js';
import './views/filters.js';
import './views/fleets.js';
import './views/rollouts.js';
import './views/sm.js';
import './views/systems.js';
import './views/tags.js';
import './views/users.js';
import './views/target-detail.js';
import './views/targets.js';

import { S } from './api.js';
import { signOut, start } from './auth.js';
import { closeDrawer, drawer } from './chrome.js';
import { $, h, icon } from './dom.js';
import { VIEWS, drawNav, go, render, setCollapsed } from './router.js';
import { THEMES, applyTheme, theme } from './theme.js';
import { shortcutsDialog } from './views/about.js';

$('#logout').replaceChildren(icon('exit', 14), h('span.lbl', 'exit'));
for (const id of ['#theme']) {
  $(id).replaceChildren(...THEMES.map(([v, l]) =>
    h('option', { value: v, selected: v === theme() }, l)));
  $(id).onchange = e => {
    applyTheme(e.target.value);
    // Two pickers for one setting: keep the other honest.
    $('#theme').value = e.target.value;
  };
}
$('#navtoggle').onclick = () => setCollapsed(!$('#app').classList.contains('collapsed'));
setCollapsed(localStorage.getItem('hb-nav') === '1');
$('#logout').onclick = signOut;
$('#drawer-close').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (VIEWS[id] && id !== S.view) { S.view = id; drawNav(); render(); }
});
let gPending = false;
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (gPending) {
    gPending = false;
    const to = { d: 'dash', t: 'targets', s: 'ds', m: 'sm', f: 'filters', o: 'ro' }[e.key];
    if (to) { e.preventDefault(); go(to); return; }
  }
  if (e.key === '/') { e.preventDefault(); const i = $('#bar-extra input'); if (i) i.focus(); }
  else if (e.key === '?') { e.preventDefault(); shortcutsDialog(); }
  else if (e.key === 'Escape') closeDrawer();
  else if (e.key === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 1200); }
});

if (S.auth) start();
