// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { fiql, put } from './api.js';
import { toast } from './chrome.js';
import { $, h, icon } from './dom.js';
import { render } from './router.js';
import { download, when } from './util.js';

/* Whatever is on screen, as a file. Reads the rendered table rather than the
 * API so that what lands in the spreadsheet is what was being looked at --
 * same columns, same order, same filter. */
function exportCsv(name) {
  const t = $('#view table.t');
  if (!t) return toast('Nothing to export', '', 'info');
  const esc = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const rows = [];
  const heads = [...t.querySelectorAll('thead tr:first-child th')]
    .map(th => th.textContent.replace(/[▲▼]/g, '').trim());
  rows.push(heads.map(esc).join(','));
  t.querySelectorAll('tbody tr').forEach(tr => {
    rows.push([...tr.children].map(td => esc(td.textContent.trim())).join(','));
  });
  download(name, rows.join('\n') + '\n');
  toast('Exported', `${rows.length - 1} rows`, 'ok');
}

/* Sortable headers. A head may be a plain string or {label, key, state}: with a
 * key it becomes a button that asks the SERVER for the order, because sorting
 * the fifty rows on screen would be sorting a page and calling it a fleet. */
function headCell(x) {
  if (x && x.nodeType) return h('th', x);
  if (typeof x !== 'object' || !x || !x.key) return h('th', x && x.label !== undefined ? x.label : x);
  const st = x.state;
  const on = st.sortKey === x.key;
  const dir = on && st.sortDir === 'ASC' ? '▲' : on && st.sortDir === 'DESC' ? '▼' : '';
  return h('th.sortable', {
    class: on ? 'on' : '', title: 'sort by ' + x.label,
    onclick: () => {
      if (st.sortKey === x.key) st.sortDir = st.sortDir === 'ASC' ? 'DESC' : 'ASC';
      else { st.sortKey = x.key; st.sortDir = 'ASC'; }
      st.page = 0; render();
    },
  }, x.label, h('span.arrow', dir));
}

function tableOf(heads, rows, filters) {
  return h('table.t',
    h('thead', h('tr', heads.map(headCell)), filters || null),
    h('tbody', rows.map(r =>
      h('tr', { onclick: r.onclick, class: r.sel ? 'sel' : null, 'data-key': r.key ?? null },
        r.cells.map(c => h('td', c))))));
}
const card = (k, v, sub) => h('div.card', h('div.k', k), h('div.v', v ?? '—'), sub ? h('div.sub', sub) : null);

/* PAGING AND PER-COLUMN FILTERS.
 *
 * Written for a fleet that does not fit on a screen: nothing here ever asks for
 * "all of them". Every list is a server-side page, every filter becomes part of
 * the FIQL query hawkBit resolves in the database, and the per-row lookups that
 * cost one request each (assigned/installed, attributes) only ever run for the
 * rows on the page in front of you.
 *
 * At a thousand devices the difference is not cosmetic: fetching the lot and
 * filtering in the browser is a request per row plus a table the browser
 * struggles to lay out. */
const PG = {};
function pg(view) {
  if (!PG[view]) PG[view] = { page: 0, size: 50, f: {} };
  return PG[view];
}
const esc = v => String(v).replace(/([\\;,()])/g, '\\$1');

// A blank box means "no condition", so an empty filter row costs nothing.
function fiqlOf(fields, state) {
  return fields.map(f => {
    const v = (state.f[f.key] || '').trim();
    if (!v) return null;
    if (f.exact) return `${f.key}==${esc(v)}`;
    return /[*]/.test(v) ? `${f.key}==${esc(v)}` : `${f.key}==*${esc(v)}*`;
  }).filter(Boolean).join(';');
}

/* One shared timer: typing in a column must not fire a query per keystroke,
   and the table is rebuilt underneath the box, so the caret has to be put
   back where the person left it. */
let filterTimer = null;
function filterRow(fields, state, onChange) {
  return h('tr.filters', fields.map(f => {
    if (!f.key) return h('th');
    const key = f.key;
    // Read this before the rebuild replaces the row: whoever is focused now
    // is the box being typed in.
    const live = document.activeElement;
    const keep = !!(live && live.dataset && live.dataset.fk === key);
    const caret = keep ? live.selectionStart : null;

    const run = now => {
      clearTimeout(filterTimer);
      if (now) onChange(); else filterTimer = setTimeout(onChange, 250);
    };
    const inp = h('input', {
      type: 'text', value: state.f[key] || '', placeholder: f.ph || 'filter',
      oninput: e => { state.f[key] = e.target.value; state.page = 0; run(false); },
      onkeydown: e => {
        if (e.key === 'Enter') run(true);
        if (e.key === 'Escape' && state.f[key]) {
          state.f[key] = ''; e.target.value = ''; state.page = 0; run(true);
        }
      },
    });
    inp.dataset.fk = key;
    // A cross only when there is something to clear: an always-on one is a
    // second thing to ignore in every column.
    const clear = h('button.fx', { title: 'clear (esc)', onclick: () => {
      state.f[key] = ''; state.page = 0; run(true);
    } }, '\u00d7');
    const box = h('div.fbox', icon('filter', 12), inp, clear);
    if (state.f[key]) box.classList.add('has');
    if (keep) requestAnimationFrame(() => {
      if (!inp.isConnected) return;
      inp.focus();
      try { inp.setSelectionRange(caret, caret); } catch (_) {}
    });
    return h('th', box);
  }));
}

function pager(state, total, onChange) {
  const from = total ? state.page * state.size + 1 : 0;
  const to = Math.min(total, (state.page + 1) * state.size);
  const last = Math.max(0, Math.ceil(total / state.size) - 1);
  const jump = p => { state.page = Math.max(0, Math.min(last, p)); onChange(); };
  return h('div.pager',
    h('span.faint', total ? `${from}–${to} of ${total}` : 'nothing'),
    h('div.grow'),
    h('select', {
      onchange: e => { state.size = Number(e.target.value); state.page = 0; onChange(); },
    }, [25, 50, 100, 200].map(n => h('option', { value: n, selected: state.size === n }, n + ' / page'))),
    h('button.btn.sm', { disabled: state.page === 0, onclick: () => jump(0) }, '«'),
    h('button.btn.sm', { disabled: state.page === 0, onclick: () => jump(state.page - 1) }, '‹'),
    h('span.faint.nowrap', `${state.page + 1} / ${last + 1}`),
    h('button.btn.sm', { disabled: state.page >= last, onclick: () => jump(state.page + 1) }, '›'),
    h('button.btn.sm', { disabled: state.page >= last, onclick: () => jump(last) }, '»'));
}

// One place that builds a paged, filtered, sorted request.
function pagedPath(base, state, q, sort) {
  let p = `${base}?limit=${state.size}&offset=${state.page * state.size}`;
  if (state.sortKey) sort = `${state.sortKey}:${state.sortDir || 'ASC'}`;
  if (sort) p += '&sort=' + sort;
  if (q) p += '&q=' + fiql(q);
  return p;
}

export {
  card, exportCsv, filterRow, fiqlOf, pagedPath, pager, pg, tableOf,
};
