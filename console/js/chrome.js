import { S } from './api.js';
import { $, h } from './dom.js';

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
  closeDrawer, drawer, fail, modal, toast,
};
