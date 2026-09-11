import { S, get } from './api.js';
import { closeDrawer, drawer, modal } from './chrome.js';
import { $, h, icon, skeleton } from './dom.js';
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
 * thing now -- four limit=1 requests, which return a total and no rows -- and
 * each list view also refreshes its own from the page it just fetched, for
 * free. Rounded once they stop being worth reading exactly: 1482 -> 1.5k. */
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
  $('#nav').replaceChildren(...NAV.filter(offered).map(n => n.sep
    ? h('div.sep', h('span.lbl', n.sep))
    : h('button', { class: S.view === n.id ? 'on' : '', title: n.label, onclick: () => go(n.id) },
        icon(n.ico), h('span.lbl', n.label),
        n.count && S.counts[n.count] !== undefined
          ? h('span.ct', { title: S.counts[n.count] + ' total' }, compact(S.counts[n.count]))
          : null)));
}

function go(id) {
  S.view = id;
  if (id !== 'targets') { S.q = ''; S.status = ''; S.fleet = ''; S.picked.clear(); }
  location.hash = id;
  closeDrawer(); drawNav(); render();
}

let renderToken = 0;
async function render() {
  const v = VIEWS[S.view] || VIEWS.dash;
  $('#title').textContent = v.title;
  // The tab says where you are: with three consoles open on three servers, the
  // browser's tab strip is the only place that distinguishes them.
  document.title = `${v.title} · hawkBit · QubicaAMF`;
  $('#bar-extra').replaceChildren(...(v.bar ? v.bar() : []));
  const mine = ++renderToken;
  const root = $('#view');
  const first = !root.childNodes.length;
  if (first) root.replaceChildren(skeleton());
  // A page that answers at once should show nothing at all; one that does not
  // has to say so, or it reads as broken.
  const slow = setTimeout(() => {
    if (mine !== renderToken) return;
    $('#progress').classList.add('on');
    if (!first) root.classList.add('stale');
  }, 150);
  try {
    const tmp = h('div');
    await v.render(tmp);
    if (mine !== renderToken) return;
    root.replaceChildren(...tmp.childNodes);
  } catch (e) {
    if (mine !== renderToken) return;
    root.replaceChildren(h('div.empty', h('b', 'Could not load'), e.message));
  } finally {
    clearTimeout(slow);
    if (mine === renderToken) {
      $('#progress').classList.remove('on');
      root.classList.remove('stale');
    }
  }
}

let debounceT = null;
function debounceRender() { clearTimeout(debounceT); debounceT = setTimeout(render, 220); }

/* AUTO-REFRESH.
 *
 * A table that rebuilds itself under the cursor is worse than a stale one: the
 * row you were about to click moves, a half-typed filter is thrown away, and a
 * hover menu closes on its own. So this is both configurable and, whatever the
 * interval, suspended whenever someone is plainly in the middle of something:
 * a dialog or the drawer open, the tab in the background, or the pointer or the
 * keyboard focus inside the table itself.
 *
 * Off is a first-class choice, and it is remembered. */
/* 2s is for watching one device take an update, which is the whole reason
   anyone stares at this page. It is affordable because a refresh no longer
   re-fetches everything: the assigned/installed cell keeps what it showed and
   corrects it, attributes are cached for a minute, and the whole thing pauses
   while a pointer is over the table or a field has the caret. On a large fleet
   leave it at 10s -- every visible row still costs the server a request. */
const REFRESH_CHOICES = [
  [0, 'off'], [2000, '2s'], [5000, '5s'], [10000, '10s'],
  [30000, '30s'], [60000, '1m'], [300000, '5m'],
];
function refreshMs() {
  const v = Number(localStorage.getItem('hb-refresh'));
  return Number.isFinite(v) && REFRESH_CHOICES.some(([n]) => n === v) ? v : 10000;
}
function setRefreshMs(v) {
  try { localStorage.setItem('hb-refresh', String(v)); } catch (_) {}
  tick();
}

let pointerInside = false;
function busyInteracting() {
  if (document.hidden) return true;
  if ($('#modal').open || $('#drawer').classList.contains('open')) return true;
  if (pointerInside) return true;
  const a = document.activeElement;
  return !!(a && a.matches('input, select, textarea') && $('#view').contains(a));
}

function tick() {
  clearInterval(S.timer);
  const ms = refreshMs();
  const sel = $('#auto');
  if (sel && !sel.options.length) {
    sel.replaceChildren(...REFRESH_CHOICES.map(([v, l]) =>
      h('option', { value: v, selected: v === ms }, l)));
    sel.onchange = e => setRefreshMs(Number(e.target.value));
  } else if (sel) {
    sel.value = String(ms);
  }
  $('#paused').classList.add('hidden');
  if (!ms) return;
  S.timer = setInterval(() => {
    if (busyInteracting()) { $('#paused').classList.remove('hidden'); return; }
    $('#paused').classList.add('hidden');
    render();
  }, ms);
}

$('#view').addEventListener('pointerenter', () => { pointerInside = true; });
$('#view').addEventListener('pointerleave', () => { pointerInside = false; });

export {
  REFRESH_CHOICES, VIEWS, debounceRender, drawNav, go, refreshCounts, refreshMs, render, setCollapsed, setRefreshMs, tick,
};
