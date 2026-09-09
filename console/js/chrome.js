import { S } from './api.js';
import { $, h, icon } from './dom.js';

/* --------------------------------------------------------------- chrome */
function toast(title, msg, kind = 'info', ms = 6000) {
  const t = h('div.toast.' + kind, h('b', title), msg ? h('div.m', msg) : null);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
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
  ask, closeDrawer, drawer, fail, modal, toast,
};
