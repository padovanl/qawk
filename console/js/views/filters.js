import { S, del, distributionSets, fiql, get, post, put } from '../api.js';
import { ask, fail, modal, toast } from '../chrome.js';
import { $, h, icon } from '../dom.js';
import { VIEWS, go, render } from '../router.js';
import { tableOf } from '../table.js';

/* ------- target filters (saved filters + auto-assignment) ------------ */
VIEWS.filters = {
  title: 'Target filters',
  bar: () => [h('button.btn.sm.primary', { onclick: () => saveFilterDialog('') }, icon('plus', 14), 'new filter')],
  async render(root) {
    const d = await get('/targetfilters?limit=100&sort=id:DESC');
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'What these are for'), h('div.body.faint',
        'A saved query. With a distribution set attached it also becomes how a device that has ' +
        'never been seen ends up on the current release: hawkBit assigns it the moment the device ' +
        'registers. Auto-assignment is for arrivals; a rollout is for moving a fleet already there.')),
      d.content.length
        ? tableOf(['Id', 'Name', 'Query', 'Auto-assign', 'Mode', ''], d.content.map(f => ({
            cells: [h('span.mono', f.id), f.name, h('span.mono.faint', f.query),
              f.autoAssignDistributionSet
                ? h('span.pill.ok', 'DS ' + (f.autoAssignDistributionSet.id ?? f.autoAssignDistributionSet))
                : h('span.faint', 'none'),
              h('span.dim', f.autoAssignActionType || '—'),
              h('div.wrap',
                h('button.btn.sm', { onclick: () => { S.q = f.query; S.status = ''; go('targets'); } }, 'use'),
                h('button.btn.sm', { onclick: () => autoAssignDialog(f) }, 'auto-assign'),
                h('button.btn.sm', { onclick: () => saveFilterDialog(f.query, f) }, 'edit'),
                h('button.btn.sm.danger', { onclick: async () => {
                    if (!await ask('Delete filter', f.name, { danger: true })) return;
                    try { await del('/targetfilters/' + f.id); render(); } catch (e) { fail(e); } } }, 'delete'))],
          })))
        : h('div.empty', h('b', 'No filters'), 'Create one to auto-assign a release to new devices.')));
  },
};

async function saveFilterDialog(query, existing) {
  const name = h('input', { type: 'text', value: existing ? existing.name : '' });
  const q = h('input', { type: 'text', value: (existing ? existing.query : query) || 'attribute.device_type==neo-intel' });
  const preview = h('span.faint', '—');
  const check = async () => {
    try { preview.textContent = `${(await get('/targets?limit=1&q=' + fiql(q.value.trim()))).total} target(s) match right now`; }
    catch (e) { preview.textContent = 'invalid: ' + e.message; }
  };
  q.addEventListener('change', check); check();
  modal(existing ? 'Update filter' : 'Save filter as', [
    h('label.f', 'Name', name), h('label.f', 'Query (FIQL)', q), preview,
  ], async () => {
    if (!name.value.trim()) throw new Error('a name is required');
    const b = { name: name.value.trim(), query: q.value.trim() };
    if (existing) await put('/targetfilters/' + existing.id, b);
    else await post('/targetfilters', b);
    toast('Saved', b.name, 'ok'); render();
  }, 'Save');
}

async function autoAssignDialog(f) {
  const sets = await distributionSets(true);
  const ds = h('select', h('option', { value: '' }, '— none: stop auto-assigning —'),
    sets.content.filter(d => d.complete).map(d => h('option',
      { value: d.id, selected: f.autoAssignDistributionSet && f.autoAssignDistributionSet.id === d.id },
      `${d.name} ${d.version} · ${d.type}`)));
  const type = h('select', h('option', { value: 'forced' }, 'forced'), h('option', { value: 'soft' }, 'soft'));
  modal('Auto-assign for ' + f.name, [
    h('label.f', 'Distribution set', ds), h('label.f', 'Mode', type),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'Every target matching this filter gets it, including devices that register later. ' +
      'No groups and no error threshold: for a staged move, use a rollout.'),
  ], async () => {
    if (!ds.value) { await del(`/targetfilters/${f.id}/autoAssignDS`); toast('Auto-assign removed', '', 'ok'); }
    else {
      // The endpoint is autoAssignDS while the field in the body is
      // autoAssignDistributionSet; using the field name as the path gives a 404
      // that reads like a missing feature.
      await post(`/targetfilters/${f.id}/autoAssignDS`, { id: Number(ds.value), type: type.value });
      toast('Auto-assign set', '', 'ok');
    }
    render();
  }, 'Save');
}

export {
  saveFilterDialog,
};
