// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { S, fiql, get, qawk } from '../api.js';
import { PHASE_WORDS, phasesOf } from '../badges.js';
import { bars } from '../bars.js';
import { hasBatch, hasFeature, statesOf } from '../batch.js';
import { ask, toast } from '../chrome.js';
import { fleetBadge, typeBadge } from '../chips.js';
import { h, icon, patch } from '../dom.js';
import { VIEWS, drawNav, go, render } from '../router.js';
import { serverInfo } from '../server.js';
import { ago } from '../util.js';
import { hasDeployments, setQuery } from './deployments.js';
import { openTarget } from './target-detail.js';

/* ------- dashboard: an eye on the whole console ---------------------------
 *
 * Laid out as Tabler's dashboards are (tabler.io, MIT), with its icons. From
 * the top: the numbers; the channels, dev to prod; what is moving and what
 * needs someone; how the devices stand -- by update, by type, by centre; the
 * orchestrator, the rollouts, the catalogue; and who did what, on which
 * server. Every widget opens its page. Every row is a list row: a tile with
 * an icon in its tone, a title with its badges, a line under it, a number on
 * the right, a chevron when it opens something. A widget with nothing to say
 * says so, and how to get something there.
 *
 * EVERYTHING AT ONCE. Every request leaves together, and the page is as slow
 * as its slowest answer, not as the sum of them. The counts are limit=1
 * queries: the server counts, the browser does not. */
const phaseClass = label => {
  const base = label.replace(/ \(part \d+\)$/, '');
  const hit = PHASE_WORDS.find(([k]) => k === base);
  return hit ? hit[1] : 'live';
};

// How long after its last poll a device counts as overdue: hawkBit's polling
// interval plus its grace, read once a minute.
const hms = v => { const [hh, m, s] = String(v).split(':').map(Number); return ((hh * 60 + m) * 60 + s) * 1000; };
let pollCfg = null;
async function overdueCutoff() {
  try {
    if (!pollCfg || Date.now() - pollCfg.at > 60000) {
      const [p, o] = await Promise.all([get('/system/configs/pollingTime'), get('/system/configs/pollingOverdueTime')]);
      const ms = hms(p.value) + hms(o.value);
      if (!Number.isFinite(ms)) return null;
      pollCfg = { at: Date.now(), ms, poll: p.value, grace: o.value };
    }
    return Date.now() - pollCfg.ms;
  } catch (_) { return null; }
}

const STATUSES = ['registered', 'pending', 'in_sync', 'error', 'unknown'];
const DEVICE_TYPES = ['neo-intel', '6hd', 'st05', 'hyper'];
const fmt = n => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const TROUBLE = ['halted', 'paused', 'rolling_back', 'waiting_for_approval'];
const soft = p => p.catch(() => null);

const clickable = (node, onclick, title) => h('div', { style: 'cursor:pointer', title, onclick }, node);

/* Tabler's stat card: a tinted icon tile, the label, the number, a line
 * under it, and a thin bar when the number is a share of something. The
 * tone follows the number: red only when something failed, amber only when
 * something waits; a tile whose card is at work breathes. */
function stat(label, n, sub, ico, tone, bar) {
  return h('div.card.stat.' + tone,
    h('div.stat-ico', icon(ico, 20)),
    h('div.stat-body', h('div.k', label),
      h('div.v', { 'data-n': n ?? '' }, n === null || n === undefined ? '—' : fmt(n)),
      sub ? h('div.sub', sub) : null,
      bar !== undefined ? h('div.stat-bar', h('i', { style: `width:${bar.toFixed(1)}%` })) : null));
}

/* The numbers count up to what they became: from nothing when the page
 * opens, from the old value when the live update changes them. */
const shownN = new WeakMap();
function countUp(el) {
  const to = Number(el.getAttribute('data-n'));
  if (el.getAttribute('data-n') === '' || !Number.isFinite(to)) return;
  const from = shownN.has(el) ? shownN.get(el) : 0;
  shownN.set(el, to);
  if (from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), ms = 700;
  const step = t => {
    const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (k < 1 && shownN.get(el) === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
if (typeof MutationObserver !== 'undefined' && document.getElementById('view')) {
  new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'attributes') { if (m.target.matches('.stat .v')) countUp(m.target); continue; }
      for (const n of m.addedNodes) if (n.querySelectorAll) n.querySelectorAll('.stat .v[data-n]').forEach(countUp);
    }
  }).observe(document.getElementById('view'), { subtree: true, childList: true, attributes: true, attributeFilter: ['data-n'] });
}

function targetOf(a) {
  const m = (((a._links || {}).self || {}).href || '').match(/\/targets\/([^/]+)\/actions\//);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ------- the layout: Basic, Full, or one's own ---------------------------
 *
 * Eleven widgets are a lot to take in at once. The page starts BASIC -- the
 * channels, what is moving, what needs someone, the devices by update -- and
 * FULL is one click away. "customize" goes further: the widgets sit on a
 * twelve-column grid -- Gridstack (MIT, js/vendor) -- and one is picked up by
 * its bar and follows the pointer; where it would land is drawn as it goes,
 * the others make room, and everything slides up into the gaps, so a short
 * widget leaves no hole under it. A side pulls it wider or narrower, a column
 * at a time; its height is its content's. The gallery puts widgets on the
 * page and takes them off. What someone arranges stays in their browser, for
 * them. While a widget is moved or resized the live beat waits: it would put
 * everything back. The live merge leaves the grid to Gridstack (data-own);
 * each widget's content is merged into its place here. */
const WIDGETS = {           // id: [name, icon, what it shows]
  channels: ['Channels', 'route', 'dev → beta → prod: each channel with its release, how far it got, what waits'],
  inprog: ['In progress', 'rocket', 'every deployment going on: channel releases, rollouts, the orchestrator, sets given by hand'],
  attention: ['Needs attention', 'alert-triangle', 'failed devices, halted releases, approvals waiting, devices not polling'],
  update: ['Devices by update', 'activity', 'every device by where its last update stands'],
  types: ['Device types', 'cpu', 'neo-intel, 6hd, st05, hyper, and those that do not say'],
  centres: ['Centres', 'building-store', 'the biggest centres, their channel, those in none'],
  orchestrator: ['Orchestrator', 'sitemap', 'systems updated as a whole: the latest orchestrator deployments'],
  rollouts: ['Rollouts', 'stack-2', "hawkBit's rollouts, the latest, with how far their groups got"],
  catalogue: ['Catalogue', 'package', 'the latest distribution sets and what they carry'],
  activity: ['Recent activity', 'history', 'who changed what, from the audit log'],
  server: ['Server', 'server-2', 'which server, what it speaks, how the devices poll'],
};
const COLS = 12;
const SIZE_WORD = { 3: 'a quarter', 4: 'a third', 6: 'half', 8: 'two thirds', 12: 'full width' };
const sizeWord = w => SIZE_WORD[w] || `${w} of ${COLS} columns`;
const PRESETS = {
  basic: [['channels', 8], ['attention', 4], ['inprog', 8], ['update', 4]],
  full: [['channels', 8], ['attention', 4], ['inprog', 8], ['centres', 4], ['update', 4], ['types', 4],
    ['catalogue', 4], ['orchestrator', 6], ['rollouts', 6], ['activity', 8], ['server', 4]],
};
// a preset as places on the grid: left to right, a new row when one is full;
// the rows slide up to meet once the heights are known
function pack(list) {
  const pos = {};
  let x = 0, y = 0;
  for (const [id, w] of list) {
    if (x + w > COLS) { x = 0; y += 1; }
    pos[id] = { x, y: y * 100, w };
    x += w;
  }
  return pos;
}
const LAYOUT_KEY = 'qawk-dash-grid';
const OLD_KEY = 'qawk-dash-layout';          // an order and widths, before the grid
const fromPreset = p => ({ pos: pack(PRESETS[p]), preset: p });
const defaultW = id => (PRESETS.full.find(([k]) => k === id) || [0, 6])[1];
function loadLayout() {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    if (v && v.pos) {
      const pos = {};
      for (const [k, q] of Object.entries(v.pos)) {
        if (WIDGETS[k] && q && [q.x, q.y, q.w].every(Number.isFinite)) pos[k] = { x: q.x, y: q.y, w: q.w, h: q.h };
      }
      return { pos, preset: v.preset || 'custom' };
    }
    const o = JSON.parse(localStorage.getItem(OLD_KEY));
    if (o && Array.isArray(o.order)) {
      return { pos: pack(o.order.filter(id => WIDGETS[id]).map(id => [id, (o.size || {})[id] || defaultW(id)])), preset: o.preset || 'custom' };
    }
  } catch (_) { /* no storage: the default */ }
  return fromPreset('basic');
}
const L = Object.assign({ edit: false, dragging: false }, loadLayout());
function saveLayout() {
  if (L.edit) return;                         // a draft until Save
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ pos: L.pos, preset: L.preset })); } catch (_) { /* per viewer only */ }
}
// A change of layout -- customize, done, reset, Basic, Full, a widget added
// or taken off -- is drawn again AT ONCE, from the answers the page was last
// drawn with (LAST): asking the server again made every click wait for the
// slowest count of ten thousand devices, and looked like a page reloading.
// The live beat brings the numbers up to date a few seconds later, as always.
let LAST = null;
function relayout() {
  const be = document.getElementById('bar-extra');
  if (be && VIEWS.dash.bar) be.replaceChildren(...VIEWS.dash.bar().filter(Boolean));   // a button not shown is null, not "null"
  const view = document.getElementById('view');
  if (!LAST || !view || !view.querySelector('.dash')) { render(); return; }
  const tmp = h('div');
  const W = LAST(tmp);
  patch(view, tmp);
  sync(W);
}
function usePreset(p) { Object.assign(L, fromPreset(p)); G.reset = true; dirty(); saveLayout(); relayout(); }
function toggleWidget(id, at) {
  if (L.pos[id]) delete L.pos[id]; else L.pos[id] = at || { x: 0, y: 10000, w: defaultW(id) };
  L.preset = 'custom'; dirty(); saveLayout(); relayout();
}

// Customizing is a DRAFT. What was there is kept until Save; Cancel puts it
// back (the widgets slide home). Leaving the page is leaving customize: with
// nothing changed, silently; with changes, the page asks first -- Save,
// Discard, or Stay -- and closing the tab gets the browser's own warning.
const E = { from: null, dirty: false };
const dirty = () => { if (L.edit) E.dirty = true; };
// "add widget": customize, and the tray in view, lit for a moment
function openAdd() {
  if (!L.edit) startEdit();
  requestAnimationFrame(() => {
    const t = document.querySelector('.wtray');
    if (!t) return;
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    t.classList.remove('lit'); void t.offsetWidth; t.classList.add('lit');
  });
}
function startEdit() { E.from = JSON.stringify({ pos: L.pos, preset: L.preset }); E.dirty = false; L.edit = true; relayout(); }
function endEdit(save) {
  if (!save && E.from) { const f = JSON.parse(E.from); L.pos = f.pos; L.preset = f.preset; G.reset = true; }
  L.edit = false; E.dirty = false; E.from = null;
  saveLayout();
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', ev => { if (L.edit && E.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
}

// The grid: made once per visit of the page. Every live beat merges each
// widget's content into its place and lets it take the height it needs.
const G = { grid: null, el: null, items: new Map(), reset: false };
function keep() {
  if (!G.grid || G.grid.getColumn() !== COLS) return;      // a narrow screen rearranges for itself
  for (const n of G.grid.save(false)) if (n.id && L.pos[n.id]) L.pos[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h };
  saveLayout();
}
const tools = id => (L.edit ? h('div.dw-tools', { title: 'drag to move it' },
  h('span.dw-grip', icon('grip-vertical', 16)), h('span.dw-name', WIDGETS[id][0]),
  h('span.dw-size', sizeWord((L.pos[id] || {}).w)),
  h('button.dw-hide', { title: 'take it off the page (it goes back to the tray)', onclick: () => toggleWidget(id) }, icon('x', 14), 'remove')) : null);

function sync(W) {
  const el = document.querySelector('#view .dgrid');
  if (!el || !window.GridStack || L.dragging) return;
  if (G.el !== el) {
    if (G.grid) G.grid.destroy(false);
    el.replaceChildren(); G.items.clear();
    G.el = el; G.reset = false;
    G.grid = window.GridStack.init({
      column: COLS, cellHeight: 8, margin: 8, float: false, animate: true, sizeToContent: true,
      staticGrid: !L.edit, draggable: { handle: '.dw-tools' }, resizable: { handles: 'e, w', autoHide: false },
      columnOpts: { breakpoints: [{ w: 720, c: 1 }, { w: 1150, c: 6 }] },
      acceptWidgets: w => w.classList.contains('wadd'),
    }, el);
    G.grid.on('dragstart resizestart', () => { L.dragging = true; });
    G.grid.on('dragstop resizestop', () => { L.dragging = false; L.preset = 'custom'; dirty(); keep(); relayout(); });
    G.grid.on('change', () => keep());
    // a card of the tray let go on the grid: the widget, where it was let go
    G.grid.on('dropped', (_, __, node) => {
      const id = node && node.el && node.el.dataset.id;
      const at = node ? { x: node.x, y: node.y, w: node.w } : null;
      setTimeout(() => {
        if (node && node.el) G.grid.removeWidget(node.el, true, false);
        L.adding = false;
        if (id && WIDGETS[id] && !L.pos[id]) toggleWidget(id, at); else relayout();
      }, 0);
    });
    G.grid.on('resize', (_, item) => {
      const t = item.querySelector('.dw-size');
      if (t && item.gridstackNode) t.textContent = sizeWord(item.gridstackNode.w);
    });
  }
  if (G.grid.opts.staticGrid !== !L.edit) G.grid.setStatic(!L.edit);
  const ids = Object.keys(L.pos).filter(id => W[id]);
  const moving = G.reset;             // Basic, Full, reset: every widget slides to its new place
  G.reset = false;
  G.grid.batchUpdate();
  for (const [id, item] of G.items) if (!ids.includes(id)) { G.grid.removeWidget(item); G.items.delete(id); }
  for (const id of ids) {
    const content = h('div', h('div.dw', { 'data-id': id }, tools(id), W[id]));
    let item = G.items.get(id);
    if (item) {
      patch(item.querySelector('.grid-stack-item-content'), content);
      if (moving) G.grid.update(item, { x: L.pos[id].x, y: L.pos[id].y, w: Math.min(L.pos[id].w, COLS) });
    } else {
      // filled before it is made a widget: Gridstack measures it at once
      const q = L.pos[id];
      item = h('div.grid-stack-item', { 'data-id': id }, h('div.grid-stack-item-content', ...content.childNodes));
      el.append(item);
      G.grid.makeWidget(item, { id, x: q.x, y: q.y, w: Math.min(q.w, COLS), h: q.h || 24, minW: 3 });
      G.items.set(id, item);
    }
  }
  G.grid.batchUpdate(false);
  for (const item of G.items.values()) G.grid.resizeToContent(item);
  if (L.edit) window.GridStack.setupDragIn('.wtray .wadd', { appendTo: 'body', helper: 'clone' });
}
const grid = () => h('div.dgrid.grid-stack', { 'data-key': 'grid', 'data-own': '' });

// Customizing: what can be done, and the widgets not on the page -- each with
// a live preview, drawn from the same answers as the page. One is dragged onto
// the grid, where it should go, or put at the bottom with its +.
function editTray(W) {
  const off = Object.keys(WIDGETS).filter(id => !L.pos[id]);
  return h('div.dtray-wrap', { 'data-key': 'tray' },
    h('div.dtray',
      h('span.dtray-k', 'Customizing'),
      h('span.faint', 'drag a widget by its bar: the others make room and the gaps close · pull a side to make it wider or narrower'),
      h('span.grow'),
      h('button.btn.sm', { title: 'start again from Basic', onclick: () => usePreset('basic') }, icon('rotate', 14), 'Reset to Basic'),
      h('button.btn.sm', { title: 'put the layout back as it was', onclick: () => { endEdit(false); relayout(); } }, 'Cancel'),
      h('button.btn.sm.primary', { title: 'keep this layout',
        onclick: () => { endEdit(true); relayout(); toast('Layout saved', 'the dashboard stays like this, in this browser', 'ok'); } },
      icon('device-floppy', 14), 'Save')),
    h('div.wtray',
      h('div.wtray-head', h('b', 'Add a widget'),
        h('span.faint', off.length ? 'drag one onto the page, where you want it — or + puts it at the bottom'
          : 'every widget is on the page: remove one and it comes back here'),
        h('span.grow'), h('span.faint', `${Object.keys(WIDGETS).length - off.length} of ${Object.keys(WIDGETS).length} on the page`)),
      off.length ? h('div.wtray-list', off.map(id => addCard(id, W[id]))) : null));
}
function addCard(id, node) {
  const [name, ico, desc] = WIDGETS[id];
  return h('div.wadd', { 'data-key': 'add-' + id, 'data-id': id, 'gs-w': String(defaultW(id)), 'gs-h': '34',
    title: node ? 'drag it onto the page' : 'this server has nothing for it', onpointerdown: () => { L.adding = true; } },
  h('div.wadd-prev', node ? h('div.wadd-in', node) : h('div.wadd-none', icon(ico, 26), h('span', 'nothing for it on this server'))),
  h('div.wadd-foot',
    h('span.wadd-ico', icon(ico, 16)),
    h('div.wadd-t', h('b', name), h('span', desc)),
    h('button.wadd-plus', { title: 'put it at the bottom of the page', onclick: e => { e.stopPropagation(); L.adding = false; toggleWidget(id); } },
      icon('plus', 16))));
}
if (typeof window !== 'undefined') window.addEventListener('pointerup', () => { setTimeout(() => { L.adding = false; }, 400); });

/* ------- the widgets' parts: a card with a header, and list rows --------- */
const widget = (title, ico, extra, body, page) => h('div.panel.w',
  h('h3.whead', h('span.wtitle', icon(ico, 16), title), h('span.wextra', extra || null,
    page ? h('button.wlink', { title: 'open the page', onclick: () => go(page) }, 'open', icon('chevron-right', 14)) : null)),
  body);

function row({ key, tile, tone, colour, title, meta, right, below, onclick }) {
  return h('div.lrow' + (onclick ? '.click' : '') + (tone ? '.tone-' + tone : ''),
    { 'data-key': key, onclick, style: colour ? `--tone:${colour}` : null },
    h('div.ltile', icon(tile, 18)),
    h('div.lmain', h('div.ltitle', title), meta ? h('div.lmeta', meta) : null, below || null),
    right ? h('div.lright', right) : null,
    onclick ? h('span.lchev', icon('chevron-right', 16)) : null);
}

const emptyRow = (tile, title, text, tone = 'mute') => h('div.lrow.tone-' + tone,
  h('div.ltile', icon(tile, 18)), h('div.lmain', h('div.ltitle', h('b', title)), h('div.lmeta', text)));

// a share of a whole: a bar with its legend, each part opening what it counts
function share(parts, total, open, badge) {
  return [
    h('div.dist', parts.map(([k, n, c, word]) => h('i', { 'data-key': k, style: `flex:${n} 1 0;background:${c}`,
      title: `${word} · ${fmt(n)}` }))),
    h('div.dlegend', parts.map(([k, n, c, word, tip]) => h('button.ditem', { 'data-key': k, title: tip || word, onclick: () => open(k) },
      h('span.ddot', { style: `background:${c}` }), h('span.dword', badge ? badge(k, word) : word), h('b', fmt(n)),
      h('span.faint', `${Math.round(100 * n / (total || 1))}%`)))),
  ];
}

VIEWS.dash = {
  title: 'Dashboard',
  bar: () => [
    h('div.seg', ['basic', 'full'].map(p => h('button.btn.sm' + (L.preset === p ? '.primary' : ''),
      { title: p === 'basic' ? 'the essentials' : 'every widget', onclick: () => usePreset(p) }, p === 'basic' ? 'Basic' : 'Full'))),
    // adding a widget is where people look for it: here, always
    h('button.btn.sm', { title: 'put another widget on the dashboard', onclick: openAdd }, icon('plus', 14), 'add widget'),
    L.edit ? null : h('button.btn.sm', { title: 'move, resize, add and remove widgets', onclick: startEdit },
      icon('adjustments-horizontal', 14), 'customize')],
  // leaving the page leaves customize; unsaved changes are asked about first
  async leave() {
    if (!L.edit) return true;
    if (E.dirty) {
      const a = await ask('Save the layout?',
        'You changed the dashboard and have not saved it.\nSaved, it stays as it is now; discarded, it goes back to how it was.',
        { okLabel: 'Save', altLabel: 'Discard changes', cancelLabel: 'Stay' });
      if (a === false) return false;
      endEdit(a === true);
    } else endEdit(false);
    return true;
  },
  async render(root) {
    if (L.dragging || L.adding) throw new Error('the layout is being changed');
    const count = q => get('/targets?limit=1&q=' + fiql(q)).then(r => r.total);
    const cutoffP = overdueCutoff();
    const [tg, totals, installedInSync, cutoff, over, deps, fails, fleets, centres, sdeps, stypes, ros, dss, sms, audit, types] =
      await Promise.all([
        get('/targets?limit=60&sort=lastControllerRequestAt:DESC'),
        Promise.all(STATUSES.map(s => count(`updatestatus==${s}`).catch(() => 0))),
        count('updatestatus==in_sync;installedat=ge=0').catch(() => null),
        cutoffP,
        cutoffP.then(c => (c === null ? null : count(`lastcontrollerrequestat=lt=${c}`))).catch(() => null),
        hasDeployments() ? qawk.get('/deployments').then(r => r.content || []).catch(() => []) : Promise.resolve(null),
        get('/actions?limit=6&sort=id:DESC&q=' + fiql('status==error')).catch(() => ({ content: [], total: 0 })),
        hasFeature('fleets') ? qawk.get('/fleets').then(r => r.content || []).catch(() => []) : Promise.resolve(null),
        hasFeature('centres') ? soft(qawk.get('/centres')) : Promise.resolve(null),
        hasFeature('systems') ? soft(qawk.get('/systemdeployments')) : Promise.resolve(null),
        hasFeature('systems') ? soft(qawk.get('/systemtypes')) : Promise.resolve(null),
        soft(get('/rollouts?limit=4&sort=id:DESC')),
        soft(get('/distributionsets?limit=4&sort=id:DESC')),
        soft(get('/softwaremodules?limit=1')),
        hasFeature('audit') ? soft(qawk.get('/audit?limit=60')) : Promise.resolve(null),
        Promise.all(DEVICE_TYPES.map(t => count(`attribute.device_type==${t}`).catch(() => 0))),
      ]);
    S.counts.targets = tg.total;
    drawNav();

    // The targets table refuses to call a device that has never installed
    // anything "in sync"; counting it green here would contradict that on the
    // same screen. It gets a bucket of its own.
    const byStatus = {};
    STATUSES.forEach((s, i) => { if (totals[i]) byStatus[s] = totals[i]; });
    let virgin = 0;
    if (byStatus.in_sync && installedInSync !== null) {
      virgin = byStatus.in_sync - installedInSync;
      byStatus.in_sync = installedInSync;
      if (!byStatus.in_sync) delete byStatus.in_sync;
    }

    // What the pending devices are doing (a sample: the sixty seen last) and
    // what the failed ones said -- two batch requests, together.
    const failed = (fails.content || []).map(a => Object.assign({ _t: targetOf(a) }, a)).filter(a => a._t);
    const [phs, fstates] = await Promise.all([
      phasesOf(tg.content.filter(t => t.updateStatus === 'pending').map(t => t.controllerId)).catch(() => new Map()),
      hasBatch() && failed.length ? statesOf(failed.map(a => a._t)).catch(() => new Map()) : Promise.resolve(new Map()),
    ]);
    const phases = {};
    phs.forEach(ph => { if (ph && ph.label) phases[ph.label] = (phases[ph.label] || 0) + 1; });

    const errors = byStatus.error || 0;
    const upToDate = byStatus.in_sync || 0;
    const trouble = (deps || []).filter(d => TROUBLE.includes(d.status));
    const approvals = trouble.filter(d => d.status === 'waiting_for_approval');
    const updating = (deps || []).reduce((n, d) => n + (d.open || 0), 0);
    const cl = centres ? centres.content || [] : [];
    const placed = cl.filter(c => c.fleetId).length;

    // drawn from these answers -- and kept, so that a change of layout is
    // drawn again from them at once (relayout)
    const paint = target => {
      const W = {
        channels: fleets ? pipelineWidget(fleets) : null,
        inprog: deps ? progressWidget(deps) : null,
        update: updateWidget(byStatus, virgin, phases, tg.content.length),
        types: typesWidget(types, tg.total),
        orchestrator: sdeps ? orchestratorWidget(sdeps.content || [], stypes ? stypes.content || [] : []) : null,
        rollouts: ros ? rolloutsWidget(ros) : null,
        activity: audit ? activityWidget(audit.content || [], fleets || []) : null,
        attention: attentionWidget({ errors, failed, fstates, trouble, over, cutoff }),
        centres: centres ? centresWidget(cl, fleets || [], centres.field) : null,
        catalogue: dss ? catalogueWidget(dss, sms) : null,
        server: serverWidget(),
      };
      target.replaceChildren(h('div.stack.dash' + (L.edit ? '.editing' : ''),
        h('div.cards',
          clickable(stat('Devices', tg.total, over ? `${fmt(over)} not polling` : 'all polling on time', 'device-desktop',
            over ? 'warn' : 'info', tg.total ? 100 * (tg.total - (over || 0)) / tg.total : 0),
            () => { S.q = over && cutoff ? `lastcontrollerrequestat=lt=${cutoff}` : ''; S.status = ''; go('targets'); }),
          clickable(stat('Up to date', upToDate, tg.total ? `${Math.round(100 * upToDate / tg.total)}% of the devices` : 'no device',
            'rosette-discount-check', upToDate ? 'ok' : 'mute', tg.total ? 100 * upToDate / tg.total : 0),
            () => { S.q = ''; S.status = 'in_sync'; go('targets'); }),
          clickable(stat('In progress', deps ? deps.length : null,
            deps ? `${plural(updating, 'device')} updating` : 'needs Qawk', 'rocket',
            deps && deps.length ? 'info.live' : 'mute'), () => go('inprog')),
          clickable(stat('Failed', errors, errors ? 'their last update failed' : 'no device in error', 'alert-triangle',
            errors ? 'err' : 'ok'), () => { S.q = ''; S.status = 'error'; go('targets'); }),
          clickable(stat('To approve', approvals.length, approvals.length ? 'waiting for a second person' : 'nothing waiting',
            'clock', approvals.length ? 'warn.live' : 'mute'), () => go('fleets')),
          centres ? clickable(stat('Centres', cl.length, cl.length ? `${fmt(placed)} in a channel` : 'none reported yet',
            'building-store', cl.length ? 'info' : 'mute'), () => go('centres')) : null),
        L.edit ? editTray(W) : null,
        grid()));
      return W;
    };
    LAST = paint;
    const W = paint(root);
    setTimeout(() => sync(W), 0);
  },
};

/* ------- the channels: dev -> beta -> prod, and the temporary ones apart --- */
function pipelineWidget(fleets) {
  const byId = new Map(fleets.map(f => [f.id, f]));
  // follow the upstream links: the channels with none first, then their
  // downstream, in order; the temporary ones at the end
  const chain = [], seen = new Set();
  const add = f => {
    if (seen.has(f.id)) return;
    seen.add(f.id); chain.push(f);
    fleets.filter(d => d.upstreamId === f.id && !d.temporary).forEach(add);
  };
  fleets.filter(f => !f.temporary && !(f.upstreamId && byId.has(f.upstreamId))).forEach(add);
  fleets.filter(f => !f.temporary).forEach(add);
  const temps = fleets.filter(f => f.temporary);
  const step = (f, kind) => {
    const p = f.progress, r = f.release;
    const pct = p && p.members ? Math.round(100 * p.onRelease / p.members) : 0;
    const halted = r && r.status === 'halted';
    return h('div.pstep.' + kind + (halted ? '.bad' : ''), { 'data-key': 'p' + f.id, style: `--tone:${f.colour || '#8b8f98'}`,
      title: f.description || f.name, onclick: () => go('fleets') },
    h('div.ptop', fleetBadge(f.name, f.colour), h('span.faint', plural(f.members, 'device'))),
    h('div.prel', f.distributionSet ? h('b', f.distributionSet) : h('span.faint', 'no release yet')),
    h('div.ppills',
      r ? h('span.pill.' + (halted ? 'err' : r.status === 'completed' ? 'ok' : r.status === 'active' ? 'live' : 'mute'), r.status) : null,
      f.temporary ? h('span.pill', { title: 'a temporary channel: machines lent for a while' }, 'lent') : null,
      f.pending ? h('span.pill.amber', 'awaiting approval') : null,
      f.freeze && f.freeze.active ? h('span.pill.info', 'frozen') : null,
      f.upstream ? h('span.pill', f.autoPromote ? 'promotes itself' : 'promoted by hand') : null,
      f.inSystems ? h('span.pill', { title: 'updated by the orchestrator, not by this release' }, `${fmt(f.inSystems)} in systems`) : null,
      p && p.failed ? h('span.pill.err', `${fmt(p.failed)} failed`) : null),
    f.systems && f.systems.total ? h('div.psys', { title: `${f.manifest || ''}: the orchestrator on ${f.name}'s systems` },
      icon('sitemap', 13), `${fmt((f.systems.counts || {}).succeeded)}/${fmt(f.systems.total)} systems`,
      f.systems.centre ? h('span.faint', '· centre ' + f.systems.centre) : null) : null,
    f.distributionSet && p && p.members ? h('div.pbar',
      bars([[p.onRelease, 'ok'], [p.active, 'run'], [p.failed, 'err']], p.members, { key: 'pipe' + f.id }),
      h('span.ppct', { title: 'of its devices run the release' }, `${pct}%`)) : null);
  };
  const flow = [...chain.map(f => step(f, 'chain')), ...temps.map(f => step(f, 'temp'))];
  return widget('Channels', 'route', h('span.faint.wcount', plural(fleets.length, 'channel')), h('div.body',
    fleets.length ? h('div.pipe', flow)
      : emptyRow('route', 'No channel yet', 'create dev, beta and prod on the Fleets page; each release goes through them in order')),
  'fleets');
}

/* ------- in progress: every deployment going on, with how far it got ----- */
const KIND_ICON = { fleet: 'route', rollout: 'stack-2', manual: 'hand-finger', system: 'sitemap' };
const KIND_WORD = { fleet: 'channel release', rollout: 'rollout', manual: 'assigned by hand', system: 'orchestrator' };

function openDeployment(d) {
  S.q = ''; S.fleet = ''; S.status = '';
  if (d.kind === 'rollout') { go('ro'); return; }
  if (d.kind === 'system') { go('systems'); return; }
  if (d.kind === 'fleet') S.fleet = d.title;
  else S.q = setQuery(d);
  go('targets');
}

function progressWidget(deps) {
  const list = deps.slice(0, 5);
  return widget('In progress', 'rocket', deps.length ? h('span.pill.info', String(deps.length)) : null, h('div.body.list',
    list.length ? list.map(d => {
      const pct = d.total ? Math.round(100 * d.done / d.total) : 0;
      const work = (d.downloading || 0) + (d.installing || 0) + (d.confirming || 0);
      const bad = d.status === 'halted' || d.status === 'paused';
      return row({ key: `${d.kind}:${d.title}`, tile: KIND_ICON[d.kind] || 'rocket', tone: bad ? 'err' : 'info',
        colour: d.kind === 'fleet' ? d.colour : null,
        title: [d.kind === 'fleet' ? fleetBadge(d.title, d.colour) : h('b', d.title), h('span.faint', KIND_WORD[d.kind] || d.kind),
          d.distributionSet && d.kind !== 'manual' ? h('span.pill.ok', d.distributionSet) : null,
          h('span.pill.' + (bad ? 'err' : d.status === 'waiting_for_approval' ? 'amber' : 'live'), String(d.status).replace(/_/g, ' '))],
        meta: `${fmt(d.done)} of ${fmt(d.total)} done` + (work ? ` · ${fmt(work)} at work` : '')
          + (d.failed ? ` · ${fmt(d.failed)} failed` : '')
          + ((d.waiting || 0) + (d.scheduled || 0) ? ` · ${fmt((d.waiting || 0) + (d.scheduled || 0))} waiting` : '')
          + (d.since ? ' · started ' + ago(d.since) : '') + (d.by && d.by.length ? ' · by ' + d.by.slice(0, 2).join(', ') : ''),
        right: h('div.lpct', `${pct}%`, h('small', 'done')),
        below: h('div', { style: 'margin-top:9px' },
          bars([[d.done, 'ok'], [work, 'run'], [d.failed, 'err']], d.total, { key: `dash:${d.kind}:${d.title}` })),
        onclick: () => openDeployment(d) });
    }) : emptyRow('rocket', 'Nothing is being deployed',
      'channel releases, rollouts, orchestrator deployments and sets assigned by hand show here while devices work on them'),
    deps.length > list.length ? h('div.lmore', { onclick: () => go('inprog') }, `all ${deps.length} in progress`) : null),
  'inprog');
}

/* ------- needs attention: what someone has to look at, or all clear ------ */
function attentionWidget({ errors, failed, fstates, trouble, over, cutoff }) {
  const rows = [];
  for (const d of trouble) {
    const wait = d.status === 'waiting_for_approval';
    rows.push(row({ key: `t:${d.kind}:${d.title}`, tile: wait ? 'clock' : 'alert-triangle', tone: wait ? 'warn' : 'err',
      title: [d.kind === 'fleet' ? fleetBadge(d.title, d.colour) : h('b', d.title),
        h('span.pill.' + (wait ? 'amber' : 'err'), String(d.status).replace(/_/g, ' '))],
      meta: (d.distributionSet && d.kind !== 'manual' ? d.distributionSet + ' · ' : '') + (d.detail || '').split('\n').pop(),
      onclick: () => go(d.kind === 'fleet' ? 'fleets' : d.kind === 'rollout' ? 'ro' : d.kind === 'system' ? 'systems' : 'inprog') }));
  }
  if (errors) {
    rows.push(row({ key: 'errors', tile: 'circle-x', tone: 'err',
      title: h('b', `${plural(errors, 'device')} in error`), meta: 'their last update failed',
      below: failed.length ? h('div.lsub', failed.map(a => {
        const st = fstates.get(a._t);
        const msg = st && st.statuses && st.statuses.length ? (st.statuses[0].messages || []).join(' ') : '';
        const set = st && st.assigned ? `${st.assigned.name} ${st.assigned.version}` : '';
        return h('div.lsubrow', { 'data-key': 'e' + a.id, title: msg, onclick: e => { e.stopPropagation(); openTarget(a._t); } },
          h('span.mono', { title: a._t }, a._t), h('span.faint', set), h('span.lmsg', msg || 'failed'),
          h('span.faint', ago(a.lastModifiedAt || a.createdAt)));
      })) : null,
      onclick: () => { S.q = ''; S.status = 'error'; go('targets'); } }));
  }
  if (over) {
    rows.push(row({ key: 'over', tile: 'wifi-off', tone: 'warn', title: h('b', `${fmt(over)} not polling`),
      meta: 'no poll within the polling interval and its grace',
      onclick: () => { S.q = cutoff ? `lastcontrollerrequestat=lt=${cutoff}` : ''; S.status = ''; go('targets'); } }));
  }
  return widget('Needs attention', 'alert-triangle', rows.length ? h('span.pill.err', String(rows.length)) : null, h('div.body.list',
    rows.length ? rows : emptyRow('circle-check', 'All clear',
      'no failed device, no halted release, no approval waiting, every device polling', 'ok')));
}

/* ------- devices by update: one bar over all of them, and its legend ----- */
/* hawkBit's words mean something else on a dashboard: five thousand devices
 * online and polling, simply never given an update, showed as "registered"
 * -- read as "just arrived", or "stuck". Plain words, hawkBit's in the tip. */
const WORD = {
  in_sync: ['up to date', 'in_sync: running what it was last given'],
  virgin: ['never installed', 'in sync for hawkBit -- nothing pending -- but this server has never installed anything on them'],
  pending: ['updating', 'pending: an update is on its way to it, or being installed'],
  error: ['update failed', 'error: its last update failed'],
  registered: ['never updated', 'registered: known to the server and polling, never given an update'],
  unknown: ['unknown', 'unknown: the server has no status for it yet'],
};
const DIST = [
  ['in_sync', 'var(--ok)'], ['virgin', 'color-mix(in srgb, var(--ok) 45%, transparent)'], ['pending', 'var(--info)'],
  ['error', 'var(--err)'], ['registered', 'color-mix(in srgb, var(--fg) 32%, transparent)'], ['unknown', 'var(--warn)'],
];

function updateWidget(byStatus, virgin, phases, sample) {
  const parts = DIST.map(([k, c]) => [k, k === 'virgin' ? virgin : byStatus[k] || 0, c, WORD[k][0], WORD[k][1]]).filter(([, n]) => n);
  const total = parts.reduce((a, [, n]) => a + n, 0);
  return widget('Devices by update', 'activity', h('span.faint.wcount', plural(total, 'device')), h('div.body',
    total ? [
      share(parts, total, k => { S.q = ''; S.fleet = ''; S.status = k === 'virgin' ? 'in_sync' : k; go('targets'); }),
      Object.keys(phases).length ? h('div.dphases', h('span.faint', `updating, of the ${sample} seen last:`),
        Object.entries(phases).map(([l, n]) => h('span.pill.' + phaseClass(l), `${l} · ${n}`))) : null,
    ] : h('div.faint', 'no device registered yet')), 'targets');
}

/* ------- device types: neo-intel alone, the 6hd with its st05 and hyper --- */
const TYPE_COLOUR = { 'neo-intel': 'var(--info)', '6hd': 'var(--accent)', st05: 'var(--ok)', hyper: 'var(--warn)' };
function typesWidget(types, total) {
  const known = types.reduce((a, n) => a + n, 0);
  const parts = DEVICE_TYPES.map((t, i) => [t, types[i], TYPE_COLOUR[t], t, `attribute.device_type==${t}`]).filter(([, n]) => n);
  if (total > known) parts.push(['other', total - known, 'color-mix(in srgb, var(--fg) 22%, transparent)', 'not reported',
    'devices that do not report attribute.device_type (simulated ones, older images)']);
  return widget('Device types', 'cpu', h('span.faint.wcount', `${fmt(known)} report${known === 1 ? 's' : ''} it`), h('div.body',
    total ? share(parts, total, k => { S.q = k === 'other' ? '' : `attribute.device_type==${k}`; S.status = ''; S.fleet = ''; go('targets'); },
      (k, word) => (k === 'other' ? word : typeBadge(k)))
      : h('div.faint', 'no device registered yet')), 'targets');
}

/* ------- centres: the biggest, their channel, those in none -------------- */
function centresWidget(cl, fleets, field) {
  const byId = new Map(fleets.map(f => [f.id, f]));
  const top = [...cl].sort((a, b) => b.devices - a.devices).slice(0, 5);
  const loose = cl.filter(c => !c.fleetId).length;
  return widget('Centres', 'building-store', h('span.faint.wcount', plural(cl.length, 'centre')), h('div.body.list',
    cl.length ? [
      top.map(c => {
        const f = byId.get(c.fleetId);
        return row({ key: 'c' + c.centre, tile: 'map-pin', colour: f ? f.colour : null, tone: f ? null : 'mute',
          title: [h('b.mono', c.centre), f ? fleetBadge(f.name, f.colour) : h('span.pill.amber', 'no channel')],
          meta: plural(c.devices, 'device'),
          onclick: () => { S.q = `${field}==${c.centre}`; S.status = ''; S.fleet = ''; go('targets'); } });
      }),
      loose ? h('div.lmore', { onclick: () => go('centres') }, `${plural(loose, 'centre')} in no channel — put them in one`) : null,
    ] : emptyRow('building-store', 'No centre yet', `no device reports ${field}; the devices of a centre follow its channel`)),
  'centres');
}

/* ------- orchestrator: systems updated as a whole ------------------------ */
const SD_CLS = { draft: 'mute', running: 'live', paused: 'amber', finished: 'ok', failed: 'err', aborted: 'mute' };
function orchestratorWidget(sdeps, stypes) {
  const list = [...sdeps].sort((a, b) => b.id - a.id).slice(0, 4);
  return widget('Orchestrator', 'sitemap', h('span.faint.wcount', plural(stypes.length, 'system type')), h('div.body.list',
    list.length ? list.map(d => {
      const c = d.counts || {};
      const back = (c.rolled_back || 0) + (c.rolling_back || 0);
      return row({ key: 'sd' + d.id, tile: 'sitemap',
        tone: d.status === 'failed' ? 'err' : back ? 'warn' : d.status === 'running' ? 'info' : 'mute',
        title: [h('b', d.name), h('span.pill.' + (SD_CLS[d.status] || 'mute'), d.status)],
        meta: `${d.manifest} · ${d.fleet ? 'channel ' + d.fleet : 'every channel'} · ${fmt(c.succeeded)} of ${plural(d.total || 0, 'system')} updated`
          + (back ? ` · ${fmt(back)} rolled back` : ''),
        below: d.total ? h('div', { style: 'margin-top:8px' }, bars([[c.succeeded, 'ok'], [c.running, 'run'],
          [c.rolling_back, 'back'], [c.rolled_back, 'err']], d.total, { key: 'dsd' + d.id })) : null,
        onclick: () => go('systems') });
    }) : emptyRow('sitemap', stypes.length ? 'Nothing orchestrated yet' : 'No system type yet',
      stypes.length ? 'deploy a manifest: each system in order, one that fails goes back as a whole'
        : 'describe a system -- a 6hd, its two st05 and a hyper -- then write a manifest for it')),
  'systems');
}

/* ------- rollouts: hawkBit's, the latest ---------------------------------- */
const RO_CLS = { running: 'live', ready: 'info', starting: 'info', creating: 'mute', paused: 'amber', finished: 'ok',
  stopped: 'mute', deleting: 'mute', waiting_for_approval: 'amber', approval_denied: 'err', error_creating: 'err', error_starting: 'err' };
function rolloutsWidget(ros) {
  const list = ros.content || [];
  return widget('Rollouts', 'stack-2', h('span.faint.wcount', plural(ros.total || 0, 'rollout')), h('div.body.list',
    list.length ? list.map(r => {
      const p = r.totalTargetsPerStatus || {};
      const done = p.finished || 0, err = p.error || 0, run = p.running || 0;
      return row({ key: 'ro' + r.id, tile: 'stack-2', tone: err ? 'err' : r.status === 'running' ? 'info' : 'mute',
        title: [h('b', r.name), h('span.pill.' + (RO_CLS[r.status] || 'mute'), String(r.status).replace(/_/g, ' '))],
        meta: `${fmt(done)} of ${plural(r.totalTargets || 0, 'device')} done` + (err ? ` · ${fmt(err)} failed` : '')
          + (r.createdAt ? ' · ' + ago(r.createdAt) : '') + (r.createdBy ? ' · by ' + r.createdBy : ''),
        below: r.totalTargets ? h('div', { style: 'margin-top:8px' },
          bars([[done, 'ok'], [run, 'run'], [err, 'err']], r.totalTargets, { key: 'dro' + r.id })) : null,
        onclick: () => go('ro') });
    }) : emptyRow('stack-2', 'No rollout yet', 'a rollout updates a filter of devices in groups, the next when the last is done')),
  'ro');
}

/* ------- catalogue: what can be deployed --------------------------------- */
function catalogueWidget(dss, sms) {
  const list = dss.content || [];
  return widget('Catalogue', 'package', h('span.faint.wcount', `${plural(dss.total || 0, 'set')} · ${plural(sms ? sms.total : 0, 'module')}`),
    h('div.body.list',
      list.length ? list.map(d => row({ key: 'ds' + d.id, tile: 'package', tone: 'info',
        title: [h('b', d.name), h('span.pill.ok', d.version)],
        meta: (d.modules || []).map(m => m.typeName || m.type).join(' + ') + (d.createdAt ? ' · added ' + ago(d.createdAt) : '')
          + (d.createdBy ? ' by ' + d.createdBy : ''),
        onclick: () => go('ds') }))
        : emptyRow('package', 'Nothing to deploy yet', 'upload a module, then put it in a distribution set')),
    'ds');
}

/* ------- activity: who changed what, from the audit log ------------------- */
const DONE = { approve: 'approved', reject: 'rejected', promote: 'promoted', start: 'started', pause: 'paused',
  resume: 'resumed', abort: 'aborted', rollback: 'rolled back', halt: 'halted', freeze: 'froze', unfreeze: 'unfroze' };
const VERB = { POST: 'created', PUT: 'changed', PATCH: 'changed', DELETE: 'deleted' };
const NOUN = { fleets: 'channel', releases: 'release', distributionsets: 'set', softwaremodules: 'module', targets: 'device',
  rollouts: 'rollout', systemdeployments: 'orchestrator deployment', systemtypes: 'system type', manifests: 'manifest',
  centres: 'centres', users: 'user', tokens: 'API token', targetfilters: 'filter', targettags: 'tag', system: 'configuration' };
function said(e, fleets) {
  const p = e.path.replace(/^\/(rest|qawk)\/v1\//, '').split('/').filter(Boolean);
  let verb = VERB[e.method] || e.method.toLowerCase();
  if (DONE[p[p.length - 1]]) verb = e.method === 'DELETE' && p[p.length - 1] === 'freeze' ? (p.pop(), 'unfroze') : DONE[p.pop()];
  if (p[p.length - 1] === 'assignedTargets') { p.pop(); verb = 'assigned'; }
  if (p[p.length - 1] === 'targets' && p[0] === 'fleets') { p.pop(); verb = 'moved devices into'; }
  const [kind, id] = p;
  const f = kind === 'fleets' && id ? fleets.find(x => String(x.id) === id) : null;
  const what = f ? fleetBadge(f.name, f.colour)
    : h('span', (NOUN[kind] || kind || '') + (id && !/^(settings|configs)$/.test(id) ? ' ' + decodeURIComponent(id) : ''));
  return [verb, what, verb === 'assigned' ? h('span', 'to devices') : null];
}
function activityWidget(audit, fleets) {
  const writes = audit.filter(e => e.method !== 'GET' && e.status < 400).slice(0, 8);
  return widget('Recent activity', 'history', null, h('div.body.list',
    writes.length ? writes.map(e => {
      const [verb, what, tail] = said(e, fleets);
      const tone = e.method === 'DELETE' && verb !== 'unfroze' ? 'err' : verb === 'approved' ? 'ok' : verb === 'rolled back' ? 'warn' : 'info';
      return h('div.arow.tone-' + tone, { 'data-key': 'au' + e.id, title: `${e.method} ${e.path} · from ${e.address}`, onclick: () => go('audit') },
        h('span.adot'), h('span.atext', h('b', e.user), ' ', verb, ' ', what, tail ? [' ', tail] : null),
        h('span.faint.atime', ago(e.at)));
    }) : emptyRow('history', 'Nothing changed lately', 'every change made on this server, by whom, shows here')),
  'audit');
}

/* ------- the server: which, what it can do, how the devices poll --------- */
function serverWidget() {
  const i = serverInfo() || {};
  const kv = (k, v) => h('div.skv', h('span.faint', k), h('span', v));
  return widget('Server', 'server-2', i.name ? h('span.pill.live', 'online') : null, h('div.body',
    h('div.skvs',
      kv('server', `${i.name || 'hawkBit'} ${i.version || ''}`),
      i.hawkbit ? kv('speaks', `hawkBit ${i.hawkbit} (DDI and management API)`) : null,
      i.tenant ? kv('tenant', i.tenant) : null,
      pollCfg ? kv('polling', `every ${pollCfg.poll.replace(/^00:/, '')}, late after ${pollCfg.grace.replace(/^00:/, '')} more`) : null,
      kv('features', `${(i.features || []).length} of Qawk's on`)),
    null), 'about');
}
