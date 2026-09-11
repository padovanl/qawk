import { S, get } from './api.js';
import { closeDrawer, drawer, modal, refreshDrawer } from './chrome.js';
import { $, h, icon, patch, skeleton } from './dom.js';
import { serverInfo } from './server.js';
import { compact } from './util.js';

/* ---------------------------------------------------------------- views */
const VIEWS = {};

/* ---------------------------------------------------------------- shell */
const NAV = [
  { id: 'dash', label: 'Dashboard', ico: 'dash' },
  { id: 'inprog', label: 'In progress', ico: 'deploy', feature: 'deployments' },
  { sep: 'Fleet' },
  { id: 'targets', label: 'Targets', count: 'targets', ico: 'target' },
  { id: 'fleets', label: 'Fleets', ico: 'fleet', feature: 'fleets' },
  { id: 'centres', label: 'Centres', ico: 'chip', feature: 'centres' },
  { id: 'systems', label: 'Systems', ico: 'box', feature: 'systems' },
  { id: 'filters', label: 'Filters', ico: 'filter' },
  { id: 'tags', label: 'Tags', ico: 'tag' },
  { id: 'ro', label: 'Rollouts', count: 'ro', ico: 'rollout' },
  { sep: 'Software' },
  { id: 'ds', label: 'Distribution sets', count: 'ds', ico: 'package' },
  { id: 'sm', label: 'Modules', count: 'sm', ico: 'module' },
  { sep: 'Server' },
  { id: 'cfg', label: 'Configuration', ico: 'cfg' },
  { id: 'users', label: 'Users and roles', ico: 'user', feature: 'users', perm: 'SYSTEM_ADMIN' },
  { id: 'audit', label: 'Audit log', ico: 'eye', feature: 'audit', perm: 'SYSTEM_ADMIN' },
  { id: 'account', label: 'My account', ico: 'lock', feature: 'tokens' },
  { id: 'about', label: 'About', ico: 'info' },
];

function setCollapsed(v) {
  document.getElementById('app').classList.toggle('collapsed', v);
  try { localStorage.setItem('hb-nav', v ? '1' : '0'); } catch (_) {}
  const b = $('#navtoggle');
  if (b) { b.replaceChildren(icon(v ? 'right' : 'left', 14)); b.title = v ? 'expand' : 'collapse'; }
}

/* The counts belonged to the dashboard, so they only existed once you had been
 * there: reload on Targets and the sidebar came up bare. They are their own
 * thing now -- four limit=1 requests, which return a total and no rows -- kept
 * up to date by the live loop, and each list view also refreshes its own from
 * the page it just fetched, for free. Rounded once they stop being worth
 * reading exactly: 1482 -> 1.5k. */
async function refreshCounts() {
  const ask = async (path, key) => {
    try { S.counts[key] = (await get(path + '?limit=1')).total; } catch (_) {}
  };
  await Promise.all([
    ask('/targets', 'targets'), ask('/distributionsets', 'ds'),
    ask('/softwaremodules', 'sm'), ask('/rollouts', 'ro'),
  ]);
  drawNav();
}

// An entry with a feature is a page of Qawk's own: shown only once the server
// has said it has that feature (server.js asks, then draws the menu again).
// One with a permission only to someone who has it: the page would be a 403.
const offered = n => {
  const i = serverInfo();
  if (n.feature && !(i?.features || []).includes(n.feature)) return false;
  return !n.perm || (i?.me?.permissions || []).includes(n.perm);
};

function drawNav() {
  patch($('#nav'), h('div', NAV.filter(offered).map(n => n.sep
    ? h('div.sep', h('span.lbl', n.sep))
    : h('button', { class: S.view === n.id ? 'on' : '', title: n.label, onclick: () => go(n.id) },
        icon(n.ico), h('span.lbl', n.label),
        n.count && S.counts[n.count] !== undefined
          ? h('span.ct', { title: S.counts[n.count] + ' total' }, compact(S.counts[n.count]))
          : null))));
}

function go(id) {
  S.view = id;
  if (id !== 'targets') { S.q = ''; S.status = ''; S.fleet = ''; S.picked.clear(); }
  location.hash = id;
  closeDrawer(); drawNav(); render();
}

/* RENDERING. A page is drawn anew only when you arrive on it -- the skeleton,
 * then the page. From then on the same page is built again and MERGED into
 * what is on screen (dom.js, patch): what changed changes where it stands,
 * the rest is not touched. A change you make (a filter, a page of the table)
 * goes the same way. A slow answer shows the thin bar at the top; a live
 * update that fails leaves on screen what was there. */
let renderToken = 0, shown = null;
async function render(opts = {}) {
  const v = VIEWS[S.view] || VIEWS.dash;
  const fresh = shown !== S.view;
  $('#title').textContent = v.title;
  // The tab says where you are: with three consoles open on three servers, the
  // browser's tab strip is the only place that distinguishes them.
  document.title = `${v.title} · hawkBit · QubicaAMF`;
  const bar = h('div', ...(v.bar ? v.bar() : []));
  if (fresh) $('#bar-extra').replaceChildren(...bar.childNodes); else patch($('#bar-extra'), bar);
  const mine = ++renderToken;
  const root = $('#view');
  if (fresh) root.replaceChildren(skeleton());
  const slow = opts.silent ? null : setTimeout(() => {
    if (mine === renderToken) $('#progress').classList.add('on');
  }, 300);
  try {
    const tmp = h('div');
    await v.render(tmp);
    if (mine !== renderToken) return;
    if (fresh) root.replaceChildren(...tmp.childNodes); else patch(root, tmp);
    shown = S.view;
  } catch (e) {
    if (mine !== renderToken || opts.silent) return;
    root.replaceChildren(h('div.empty', h('b', 'Could not load'), e.message));
    shown = null;
  } finally {
    clearTimeout(slow);
    if (mine === renderToken) {
      $('#progress').classList.remove('on');
      live();
    }
  }
}

/* LIVE. Nothing is refreshed; everything follows the server. Every few
 * seconds (5, or the page's own `live`) the page on screen is built again and
 * merged in place, the open drawer too, and every third beat the counts in
 * the menu. Every number, badge, bar and relative time moves by itself, with
 * the pointer on it or not, a dialog open or not; only a hidden tab waits. */
/* A new console deployed reaches the screens already open: the build id the
 * image carries (Dockerfile) is read every 30 s, and when it changes the page
 * reloads itself -- the same page, the same sign-in (sessionStorage). Without
 * a build id (the console run from a checkout) nothing happens. */
let buildId = null, buildAt = 0;
async function checkBuild() {
  if (Date.now() - buildAt < 30000) return;
  buildAt = Date.now();
  try {
    const r = await fetch('/build-id', { cache: 'no-store' });
    if (!r.ok) return;
    const v = (await r.text()).trim();
    if (buildId === null) buildId = v;
    else if (v && v !== buildId) location.reload();
  } catch (_) { /* the next beat tries again */ }
}

const LIVE_MS = 5000;
let liveT = null, beats = 0;
function live() {
  clearTimeout(liveT);
  if (!S.auth) return;
  const view = S.view;
  liveT = setTimeout(() => {
    if (!S.auth || S.view !== view) return;
    if (document.hidden) { live(); return; }
    if (++beats % 3 === 0) refreshCounts();
    checkBuild();
    refreshDrawer();
    render({ silent: true });
  }, (VIEWS[view] || {}).live || LIVE_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) live(); });

let debounceT = null;
function debounceRender() { clearTimeout(debounceT); debounceT = setTimeout(render, 220); }

export {
  VIEWS, debounceRender, drawNav, go, refreshCounts, render, setCollapsed,
};
