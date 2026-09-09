import { S, del, enc, get, post, waiting } from '../api.js';
import { modal, toast } from '../chrome.js';
import { T_COLS, attrCache, attrsOf, cols, columnsDialog, headsFor } from '../columns.js';
import { $, h, icon } from '../dom.js';
import { noteTargets } from '../notices.js';
import { VIEWS, debounceRender, drawNav, render } from '../router.js';
import { exportCsv, filterRow, fiqlOf, pagedPath, pager, pg, tableOf } from '../table.js';
import { assignDialog } from './deploy.js';
import { saveFilterDialog } from './filters.js';
import { newRolloutDialog } from './rollouts.js';
import { openTarget } from './target-detail.js';

/* ------- targets ---------------------------------------------------- */
const T_STATUS = ['', 'in_sync', 'pending', 'error', 'registered', 'unknown'];

/* BULK SELECTION.
 *
 * One device at a time is fine on a bench and hopeless on a fleet: the whole
 * point of a filter is to act on what it returned. Ticking rows and acting on
 * the lot is the difference between a viewer and a console.
 *
 * The set holds controllerIds, not row indexes, so it survives a re-render, a
 * sort and a page change -- and the bar says how many are held from pages you
 * are no longer looking at. */
let SELECT_HEAD = null;   // rebuilt on every render: it knows the current page

function selectHead(ids) {
  const box = h('input', { type: 'checkbox' });
  const allOn = ids.length > 0 && ids.every(i => S.picked.has(i));
  box.checked = allOn;
  box.indeterminate = !allOn && ids.some(i => S.picked.has(i));
  box.title = allOn ? 'clear this page' : 'select this page';
  box.onclick = e => {
    e.stopPropagation();
    ids.forEach(i => allOn ? S.picked.delete(i) : S.picked.add(i));
    render();
  };
  return box;
}

function bulkBar() {
  const n = S.picked.size;
  if (!n) return null;
  const ids = [...S.picked];
  return h('div.bulk',
    h('b', n), h('span', n === 1 ? 'device selected' : 'devices selected'),
    h('div.grow'),
    h('button.btn.sm.primary', { onclick: () => assignDialog(null, null, ids) },
      icon('deploy', 14), 'deploy to these'),
    h('button.btn.sm', { onclick: () => bulkTag(ids) }, icon('tag', 14), 'tag'),
    h('button.btn.sm.danger', { onclick: () => bulkCancel(ids) }, 'cancel actions'),
    h('button.btn.sm.ghost', { onclick: () => { S.picked.clear(); render(); } }, 'clear'));
}

async function bulkCancel(ids) {
  if (!confirm(`Cancel the running action on ${ids.length} device(s)?`)) return;
  let done = 0, none = 0, bad = 0;
  for (const id of ids) {
    try {
      const a = await get(`/targets/${enc(id)}/actions?limit=1&sort=id:DESC`);
      const act = a.content[0];
      if (!act || !act.active) { none++; continue; }
      await del(`/targets/${enc(id)}/actions/${act.id}`);
      done++;
    } catch (_) { bad++; }
  }
  toast('Cancelled', `${done} cancelled, ${none} had nothing running` + (bad ? `, ${bad} failed` : ''),
    bad ? 'err' : 'ok');
  render();
}

async function bulkTag(ids) {
  const tags = await get('/targettags?limit=100').catch(() => ({ content: [] }));
  if (!tags.content.length) return toast('No tags yet', 'create one under Tags', 'info');
  const sel = h('select', tags.content.map(t => h('option', { value: t.id }, t.name)));
  modal(`Tag ${ids.length} device(s)`, [h('label.f', 'Tag', sel)], async () => {
    await post(`/targettags/${sel.value}/assigned`, ids);
    toast('Tagged', `${ids.length} device(s)`, 'ok');
    render();
  }, 'Apply');
}

VIEWS.targets = {
  title: 'Targets',
  bar: () => [
    h('div.search',
      h('input', {
        type: 'text', value: S.q,
        placeholder: 'name, id, or FIQL — attribute.device_type==neo-intel',
        oninput: e => { S.q = e.target.value; debounceRender(); },
      }), h('kbd', '/')),
    h('div.vsep'),
    h('button.btn.sm', { onclick: () => columnsDialog('targets') }, icon('columns', 14), 'columns'),
    h('button.btn.sm', { onclick: () => exportCsv('targets.csv') }, icon('save', 14), 'export'),
    h('button.btn.sm', { onclick: registerTargetDialog }, icon('plus', 14), 'register'),
    h('button.btn.sm', { onclick: () => saveFilterDialog(currentQuery()) }, icon('save', 14), 'save filter'),
    h('button.btn.sm.primary', { onclick: () => assignDialog(null) }, icon('deploy', 14), 'deploy to…'),
    // A query that has already selected the fleet should not have to be typed
    // again in the rollout dialog.
    h('button.btn.sm', { onclick: () => newRolloutDialog(currentQuery()) },
      icon('rollout', 14), 'roll out this filter'),
  ],
  async render(root) {
    const chips = h('div', { style: 'margin-bottom:12px' },
      h('div.seg', T_STATUS.map(x => h('button', {
        class: S.status === x ? 'on' : '',
        onclick: () => { S.status = x; render(); },
      }, x === '' ? 'all' : x.replace(/_/g, ' ')))));

    const st = pg('targets');
    const fields = cols().map(id => id.startsWith('attr:')
      ? { key: 'attribute.' + id.slice(5), ph: 'filter' }
      : ({ controllerId: { key: 'controllerid', ph: 'filter' },
           name: { key: 'name', ph: 'filter' },
           ip: { key: 'ipaddress', ph: 'filter' } }[id] || {}));
    fields.push({});   // the actions column

    const q = [currentQuery(), fiqlOf(fields.filter(f => f.key), st)].filter(Boolean).join(';');
    let data;
    try {
      data = await get(pagedPath('/targets', st, q, 'controllerId:ASC'));
      if (!q) { noteTargets(data.content); S.counts.targets = data.total; drawNav(); }
    }
    catch (e) {
      return root.replaceChildren(chips, h('div.empty', h('b', 'That filter was refused'), e.message));
    }
    if (!data.content.length) {
      SELECT_HEAD = selectHead([]);
      return root.replaceChildren(chips,
        tableOf([SELECT_HEAD].concat(headsFor('targets', cols())).concat(['']), [],
          filterRow([{}].concat(fields), st, render)),
        h('div.empty', h('b', q ? 'Nothing matches' : 'No targets yet'),
          q ? 'Try a substring, or FIQL such as attribute.device_type==neo-intel'
            : 'A device registers itself on its first poll.'));
    }

    attrCache.clear();
    waiting.length = 0;      // rows from the previous page are no longer wanted
    const chosen = cols();
    const pageIds = data.content.map(t => t.controllerId);
    SELECT_HEAD = selectHead(pageIds);

    const rows = data.content.map(t => ({
      sel: S.sel === t.controllerId || S.picked.has(t.controllerId),
      onclick: () => openTarget(t.controllerId),
      cells: [h('input', {
        type: 'checkbox', checked: S.picked.has(t.controllerId),
        onclick: e => {
          e.stopPropagation();
          if (e.target.checked) S.picked.add(t.controllerId); else S.picked.delete(t.controllerId);
          render();
        },
      })].concat(chosen.map(id => {
        if (id.startsWith('attr:')) {
          const key = id.slice(5), c = h('span.mono.faint', '…');
          attrsOf(t.controllerId).then(a => { c.textContent = (a && a[key]) || '—'; });
          return c;
        }
        return T_COLS[id] ? T_COLS[id].cell(t) : '—';
      })).concat([
        h('button.btn.sm.ghost', { onclick: e => { e.stopPropagation(); assignDialog(t.controllerId); } }, 'deploy'),
      ]),
    }));
    root.replaceChildren(...[chips, bulkBar(),
      tableOf([SELECT_HEAD].concat(headsFor('targets', chosen)).concat(['']), rows,
        filterRow([{}].concat(fields), st, render)),
      pager(st, data.total, render)].filter(Boolean));
  },
};

function currentQuery() {
  const parts = [];
  const q = S.q.trim();
  if (q) parts.push(/[=!<>]=|==/.test(q) ? q : `(name==*${q}*,controllerId==*${q}*)`);
  if (S.status) parts.push(`updatestatus==${S.status}`);
  return parts.join(';');
}

async function registerTargetDialog() {
  const id = h('input', { type: 'text', placeholder: 'controllerId' });
  const name = h('input', { type: 'text' });
  const desc = h('input', { type: 'text' });
  const type = h('select', h('option', { value: '' }, '— none —'));
  get('/targettypes?limit=50').then(r => r.content.forEach(t =>
    type.append(h('option', { value: t.id }, t.name)))).catch(() => {});
  modal('Register target', [
    h('label.f', 'Controller id', id), h('label.f', 'Name', name),
    h('label.f', 'Description', desc), h('label.f', 'Target type', type),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'Devices register themselves on their first poll. Do this only to create one in advance — ' +
      'the controllerId must be the one the device will use, which here is /data/swupdate/device-id.'),
  ], async () => {
    if (!id.value.trim()) throw new Error('a controller id is required');
    const b = { controllerId: id.value.trim(), name: name.value.trim() || id.value.trim() };
    if (desc.value.trim()) b.description = desc.value.trim();
    if (type.value) b.targetType = Number(type.value);
    await post('/targets', [b]);
    toast('Registered', b.controllerId, 'ok'); render();
  }, 'Register');
}
