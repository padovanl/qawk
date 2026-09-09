import { S } from './api.js';
import { $, h, icon } from './dom.js';

/* --------------------------------------------------------------- chrome */
function toast(title, msg, kind = 'info', ms = 6000) {
  /* A cross, because six seconds is either too long for something you have
     already read or too short for something you have not. The timer also stops
     while the pointer is over it: a failure worth reading is exactly the one
     that slides away as you reach for it. */
  const t = h('div.toast.' + kind,
    h('button.toast-x', { title: 'dismiss', onclick: () => t.remove() }, '\u00d7'),
    h('b', title), msg ? h('div.m', msg) : null);
  $('#toasts').append(t);
  let timer = ms ? setTimeout(() => t.remove(), ms) : null;
  if (timer) {
    t.addEventListener('pointerenter', () => { clearTimeout(timer); timer = null; });
    t.addEventListener('pointerleave', () => { timer = setTimeout(() => t.remove(), 1800); });
  }
  return t;
}
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

function drawer(title, node) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').replaceChildren(node);
  $('#drawer').classList.add('open'); $('#scrim').classList.add('open');
}
function closeDrawer() {
  $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open');
  S.sel = null;
}

export {
  ask, closeDrawer, drawer, fail, modal, serverGate, toast,
};
