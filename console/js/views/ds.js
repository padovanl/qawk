// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { S, del, get, post } from '../api.js';
import { typePill } from '../badges.js';
import { ask, closeDrawer, drawer, fail, modal, toast } from '../chrome.js';
import { D_COLS, cols, columnsDialog, fieldsFor, headsFor } from '../columns.js';
import { $, h, icon } from '../dom.js';
import { VIEWS, drawNav, render } from '../router.js';
import { exportCsv, filterRow, fiqlOf, pagedPath, pager, pg, tableOf } from '../table.js';
import { when } from '../util.js';
import { assignDialog } from './deploy.js';
import { openSm } from './sm.js';

/* ------- distribution sets ------------------------------------------ */
VIEWS.ds = {
  title: 'Distribution sets',
  bar: () => [
    h('button.btn.sm', { onclick: () => columnsDialog('ds') }, icon('columns', 14), 'columns'),
    h('button.btn.sm', { onclick: () => exportCsv('distribution-sets.csv') }, icon('save', 14), 'export'),
    h('button.btn.sm.primary', { onclick: newDsDialog }, icon('plus', 14), 'new set'),
  ],
  async render(root) {
    const st = pg('ds');
    const fields = fieldsFor('ds');
    const chosen = cols('ds');
    const d = await get(pagedPath('/distributionsets', st, fiqlOf(fields.filter(f => f.key), st), 'id:DESC'));
    if (!Object.values(st.f).some(Boolean)) { S.counts.ds = d.total; drawNav(); }
    if (!d.content.length && !Object.values(st.f).some(Boolean)) return root.replaceChildren(h('div.empty',
      h('b', 'No distribution sets'), 'A set is what you assign to devices.'));
    root.replaceChildren(
      tableOf(headsFor('ds', chosen).concat(['']),
        d.content.map(x => ({
          onclick: () => openDs(x),
          cells: chosen.map(c => D_COLS[c].cell(x)).concat([
            h('button.btn.sm.ghost', { onclick: e => { e.stopPropagation(); assignDialog(null, x.id); } }, 'deploy'),
          ]),
        })), filterRow(fields, st, render)),
      pager(st, d.total, render));
  },
};

async function openDs(x) {
  const body = h('div', h('div.empty', h('span.spin')));
  drawer(`${x.name} ${x.version}`, body);
  const draw = async () => {
    const sm = await get(`/distributionsets/${x.id}/assignedSM?limit=50`).catch(() => ({ content: [] }));
    body.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Set'), h('div.body', h('dl.kv',
        [['id', x.id], ['name', x.name], ['version', x.version], ['type', x.type],
         ['description', x.description || '—'], ['complete', String(x.complete)],
         ['created', when(x.createdAt)]].map(([k, v]) => [h('dt', k), h('dd', v)])))),
      h('div.panel', h('h3', `Modules (${sm.content.length})`), h('div.body.stack',
        sm.content.length
          ? tableOf(['Id', 'Name', 'Version', 'Type', ''], sm.content.map(m => ({
              onclick: () => openSm(m),
              cells: [h('span.mono', m.id), m.name, h('span.mono', m.version), typePill(m.type),
                h('button.btn.sm.danger', { onclick: async e => {
                    e.stopPropagation();
                    try { await del(`/distributionsets/${x.id}/assignedSM/${m.id}`); draw(); }
                    catch (er) { fail(er); } } }, 'remove')],
            })))
          : h('span.faint', 'no modules — an incomplete set is never offered to any device'),
        h('button.btn', { onclick: () => addModulesDialog(x, draw) }, icon('add', 14), 'add software modules'))),
      h('div.wrap',
        h('button.btn.primary', { onclick: () => assignDialog(null, x.id) }, icon('deploy', 14), 'deploy this set'),
        h('button.btn.danger', { onclick: async () => {
            if (!await ask('Delete distribution set',
              `${x.name} ${x.version}\n\nhawkBit only marks it deleted: this name and version stay reserved for good.`,
              { danger: true })) return;
            try { await del('/distributionsets/' + x.id); toast('Deleted', '', 'ok'); closeDrawer(); render(); }
            catch (e) { fail(e); } } }, 'delete'))));
  };
  draw();
}

async function addModulesDialog(ds, after) {
  const mods = await get('/softwaremodules?limit=200&sort=id:DESC');
  const box = h('div.stack', { style: 'max-height:300px;overflow:auto' },
    mods.content.map(m => h('label.flex',
      h('input', { type: 'checkbox', value: m.id }),
      h('span', `${m.name} ${m.version} `, h('span.faint', '· ' + m.type)))));
  modal('Add software modules to ' + ds.name, [box,
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'A set becomes complete when it holds a module of every type its own type requires.'),
  ], async () => {
    const ids = [...box.querySelectorAll('input:checked')].map(i => ({ id: Number(i.value) }));
    if (!ids.length) throw new Error('pick at least one module');
    await post(`/distributionsets/${ds.id}/assignedSM`, ids);
    toast('Added', `${ids.length} module(s)`, 'ok');
    if (after) after();
  }, 'Add');
}

async function newDsDialog() {
  const [types, mods] = await Promise.all([
    get('/distributionsettypes?limit=50'), get('/softwaremodules?limit=200&sort=id:DESC')]);
  const name = h('input', { type: 'text', placeholder: 'neo-intel-os' });
  const ver = h('input', { type: 'text', placeholder: '25.7.3' });
  const desc = h('input', { type: 'text' });
  const type = h('select', types.content.map(t => h('option', { value: t.key }, `${t.name} (${t.key})`)));
  const mod = h('select', h('option', { value: '' }, '— none for now —'),
    mods.content.map(m => h('option', { value: m.id }, `${m.name} ${m.version} · ${m.type}`)));
  modal('New distribution set', [
    h('label.f', 'Name', name), h('label.f', 'Version', ver),
    h('label.f', 'Description', desc), h('label.f', 'Type', type), h('label.f', 'Module', mod),
  ], async () => {
    if (!name.value.trim() || !ver.value.trim()) throw new Error('name and version are required');
    const b = { name: name.value.trim(), version: ver.value.trim(), type: type.value, requiredMigrationStep: false };
    if (desc.value.trim()) b.description = desc.value.trim();
    if (mod.value) b.modules = [{ id: Number(mod.value) }];
    await post('/distributionsets', [b]);
    toast('Created', `${b.name} ${b.version}`, 'ok'); render();
  }, 'Create');
}
