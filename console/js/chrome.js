import { S } from './api.js';
import { $, h, icon, patch } from './dom.js';

/* --------------------------------------------------------------- chrome */
/* NOTIFICATIONS. With a live console several arrive at once -- "Started" and
 * "Rollout running" for the same rollout, a device failing and its release
 * halting -- and they piled up over whatever someone was reading. So:
 *
 *   - a toast about the SAME THING (an id both mention: a rollout, a device)
 *     joins the card already showing it, as one more line;
 *   - the same toast again is counted (x2), not repeated;
 *   - at most three cards show; the rest wait behind "+N more";
 *   - every one is kept in the bell, top right: the last fifty, unread counted;
 *   - with the drawer open they sit to its left, not on it.
 *
 * A cross on each, because six seconds is either too long for something you
 * have already read or too short for something you have not; the timer stops
 * while the pointer is over a card. */
const NOTES = [];               // newest first: {title, msg, kind, at, read}
const MAX_SHOWN = 3;
let hiddenN = 0;
// what a toast is about: the ids it mentions (a rollout's at-1789..., a device's
// sim-dev-003) -- long tokens with a digit, not a set's name:version
const about = s => new Set((String(s).match(/[\w.+-]*\d[\w.+-]*/g) || []).filter(t => t.length >= 8 && /-/.test(t)));
const RANK = { info: 0, ok: 1, warn: 2, err: 3 };

function arm(card, ms) {
  clearTimeout(card.__timer);
  card.__ms = ms;
  card.__timer = ms && !card.__hover ? setTimeout(() => dismiss(card), ms) : null;
}
function dismiss(card) {
  clearTimeout(card.__timer);
  card.remove();
  if (!$('#toasts').querySelector('.toast')) { hiddenN = 0; drawMore(); }
}
function drawMore() {
  const wrap = $('#toasts');
  let more = wrap.querySelector('.toast-more');
  if (!hiddenN) { if (more) more.remove(); return; }
  if (!more) {
    more = h('button.toast-more', { onclick: () => { openBell(); } });
    wrap.prepend(more);
  }
  more.textContent = `+${hiddenN} more \u2014 open the notifications`;
}

function toast(title, msg, kind = 'info', ms = 6000) {
  NOTES.unshift({ title, msg: msg || '', kind, at: Date.now(), read: false });
  NOTES.length = Math.min(NOTES.length, 50);
  drawBell();
  const wrap = $('#toasts');
  const cards = [...wrap.querySelectorAll('.toast')];
  const text = msg || '';

  const same = cards.find(c => c.__title === title && c.__msg === text);
  if (same) {
    same.__n = (same.__n || 1) + 1;
    same.querySelector('.toast-n').textContent = '\u00d7' + same.__n;
    arm(same, ms);
    return same;
  }
  const keys = about(`${title} ${text}`);
  const kin = keys.size ? cards.find(c => [...keys].some(k => c.__keys.has(k))) : null;
  if (kin) {
    keys.forEach(k => kin.__keys.add(k));
    kin.__title = title; kin.__msg = text;
    kin.querySelector('b.tt').textContent = title;
    const lines = kin.querySelector('.tlines');
    lines.append(h('div.m', h('span.tsub', title), ' ', text));
    while (lines.children.length > 4) lines.firstChild.remove();
    if (RANK[kind] > RANK[kin.__kind]) { kin.classList.replace(kin.__kind, kind); kin.__kind = kind; }
    arm(kin, Math.max(ms, kin.__ms || 0));
    return kin;
  }

  const t = h('div.toast.' + kind,
    h('button.toast-x', { title: 'dismiss', onclick: () => dismiss(t) }, '\u00d7'),
    h('b.tt', title), h('span.toast-n'), h('div.tlines', text ? h('div.m', text) : null));
  Object.assign(t, { __title: title, __msg: text, __keys: keys, __kind: kind });
  t.addEventListener('pointerenter', () => { t.__hover = true; clearTimeout(t.__timer); });
  t.addEventListener('pointerleave', () => { t.__hover = false; if (t.__ms) t.__timer = setTimeout(() => dismiss(t), 1800); });
  wrap.append(t);
  arm(t, ms);
  const shown = [...wrap.querySelectorAll('.toast')];
  for (const old of shown.slice(0, Math.max(0, shown.length - MAX_SHOWN))) { dismiss(old); hiddenN++; }
  drawMore();
  return t;
}

/* The bell: every notification of this session, newest first. */
function drawBell() {
  const b = document.getElementById('bell');
  if (!b) return;
  if (!b.firstChild) {
    b.append(icon('bell', 17), h('span.bell-n'));
    b.onclick = () => (document.getElementById('bellpanel') ? closeBell() : openBell());
  }
  const n = NOTES.filter(x => !x.read).length;
  const badge = b.querySelector('.bell-n');
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n;
  b.title = n ? `${n} unread notification${n === 1 ? '' : 's'}` : 'notifications';
  const panel = document.getElementById('bellpanel');
  if (panel) fillBell(panel);
}
const since = at => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
function fillBell(panel) {
  panel.querySelector('.bp-list').replaceChildren(...(NOTES.length ? NOTES.map(x =>
    h('div.bp-row.' + x.kind + (x.read ? '' : '.unread'), h('span.adot'), h('b', x.title), h('span.faint', since(x.at)),
      x.msg ? h('div.m', x.msg) : null))
    : [h('div.empty', 'Nothing yet \u2014 deployments, devices and the catalogue will say things here')]));
}
function openBell() {
  closeBell();
  const panel = h('div#bellpanel.bellpanel',
    h('div.bp-head', h('b', 'Notifications'),
      h('button.btn.sm', { onclick: () => { NOTES.length = 0; drawBell(); } }, 'clear'),
      h('button.btn.sm', { onclick: closeBell }, '\u00d7')),
    h('div.bp-list'));
  document.body.append(panel);
  fillBell(panel);
  NOTES.forEach(x => { x.read = true; });
  [...$('#toasts').querySelectorAll('.toast')].forEach(dismiss);
  hiddenN = 0; drawMore();
  setTimeout(() => drawBell(), 1200);
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
}
function outside(e) {
  if (e.target.closest && (e.target.closest('#bellpanel') || e.target.closest('#bell'))) return;
  closeBell();
}
function closeBell() {
  const p = document.getElementById('bellpanel');
  if (p) p.remove();
  document.removeEventListener('pointerdown', outside);
}
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('bell')) drawBell();
const fail = e => toast('Failed', e.message || String(e), 'err', 12000);

function modal(title, bodyNodes, onOk, okLabel = 'OK') {
  const d = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...bodyNodes);
  $('#modal-ok').textContent = okLabel;
  $('#modal-ok').onclick = async () => {
    try { if (await onOk() !== false) d.close(); } catch (e) { fail(e); }
  };
  $('#modal-cancel').onclick = () => d.close();
  d.showModal();
}
/* Asking "are you sure?" used to be window.confirm: a dialog drawn by the
 * browser, in the browser's language and the operating system's theme, that
 * says the page's hostname and cannot be styled. This is ours.
 *
 * It builds its own <dialog> rather than reusing #modal, because several of
 * these are asked from inside an open modal -- confirming a deploy while the
 * deploy dialog is up -- and one element cannot hold both.
 */
function ask(title, message, opts = {}) {
  return new Promise(resolve => {
    const d = h('dialog.ask');
    let answer = false;
    const done = v => { answer = v; d.close(); };
    const lines = String(message).split('\n').map(l =>
      l.trim() ? h('p', l) : h('div', { style: 'height:6px' }));
    d.append(
      h('div.ask-head',
        h('span.ask-ico' + (opts.danger ? '.danger' : ''), icon(opts.danger ? 'trash' : 'info', 17)),
        h('h3', title)),
      h('div.dc', lines),
      h('div.da',
        h('button.btn', { onclick: () => done(false) }, opts.cancelLabel || 'Cancel'),
        h('button.btn.' + (opts.danger ? 'danger' : 'primary'),
          { onclick: () => done(true) }, opts.okLabel || (opts.danger ? 'Delete' : 'Confirm'))));
    d.addEventListener('close', () => { d.remove(); resolve(answer); });
    d.addEventListener('cancel', () => { answer = false; });   // Escape
    document.body.append(d);
    d.showModal();
    d.querySelector('.btn.primary, .btn.danger').focus();
  });
}

/* WAITING FOR THE SERVER.
 *
 * When hawkBit is not answering, a console full of empty tables is worse than
 * no console: every panel says "none", the counts read zero, and it all looks
 * like a server that lost its data rather than one that has not answered yet.
 * hawkBit takes about a minute to come up, which is exactly when someone is
 * most likely to be looking.
 *
 * So the page is covered until the server is back, and the cover takes itself
 * away -- nobody should have to reload to find out.
 */
let gateTimer = null;

function serverGate(reachable) {
  const on = document.getElementById('offline');
  if (reachable) {
    if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
    if (on) on.remove();
    return;
  }
  if (on) return;                                  // already covering

  const since = Date.now();
  const said = h('span.gate-since', 'trying…');
  const bar = h('i.gate-bar');
  const gate = h('div#offline.gate',
    h('div.gate-glow'),
    h('div.gate-card',
      h('img.gate-logo', { src: 'logo.png', alt: 'QubicaAMF' }),
      h('h2', 'Waiting for the server'),
      h('p', 'hawkBit is not answering yet. It takes about a minute to start, '
           + 'so this usually clears itself.'),
      h('div.gate-track', bar),
      h('div.gate-foot', h('span.spin'), said),
      h('p.gate-hint', 'Nothing is lost, and no reload is needed — the console '
                     + 'goes back to what it was showing as soon as the server answers.')));
  document.body.append(gate);

  const tick = () => {
    const s = Math.round((Date.now() - since) / 1000);
    said.textContent = s < 60 ? `trying for ${s}s`
                              : `trying for ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    // hawkBit is usually up inside 90 seconds, so the bar is a rough "how far
    // along a normal start are we" rather than a promise.
    bar.style.width = Math.min(96, Math.round((s / 90) * 100)) + '%';
    // A request of our own, so recovery is noticed even when nothing else is
    // asking: an idle page would otherwise sit here for ever.
    fetch('/rest/v1/targets?limit=1', {
      headers: { Authorization: 'Basic ' + (sessionStorage.getItem('hb-auth') || '') },
    }).then(r => { if (r.ok || r.status === 401) serverGate(true); }).catch(() => {});
  };
  tick();
  gateTimer = setInterval(tick, 4000);
}

/* A drawer given a build function follows what it shows: the live loop
 * (router.js) calls refreshDrawer, which builds it again and merges it in
 * place -- a device's status, a deployment's systems move while it is open. */
let drawerBuild = null;
function drawer(title, node, build) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').replaceChildren(node);
  drawerBuild = build || null;
  $('#drawer').classList.add('open'); $('#scrim').classList.add('open');
  document.body.classList.add('drawer-open');
}
async function refreshDrawer() {
  const build = drawerBuild;
  if (!build || !$('#drawer').classList.contains('open')) return;
  try {
    const node = await build();
    if (build === drawerBuild && node) patch($('#drawer-body'), h('div', node));
  } catch (_) { /* the next beat tries again */ }
}
function closeDrawer() {
  $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open');
  document.body.classList.remove('drawer-open');
  drawerBuild = null;
  S.sel = null;
}

export {
  ask, closeDrawer, drawer, fail, modal, refreshDrawer, serverGate, toast,
};
