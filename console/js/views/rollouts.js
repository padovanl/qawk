import { del, distributionSets, fiql, get, post, waiting } from '../api.js';
import { start } from '../auth.js';
import { ACT_ICON, TARGET_PILL, pill } from '../badges.js';
import { ask, drawer, fail, modal, toast } from '../chrome.js';
import { $, h, icon, skeleton } from '../dom.js';
import { fiqlEditor } from '../fiql.js';
import { dtInput, dtMs, dtQuick, numInput } from '../inputs.js';
import { VIEWS, render } from '../router.js';
import { filterRow, fiqlOf, pagedPath, pager, pg, tableOf } from '../table.js';
import { ago, download, when } from '../util.js';
import { deviceTypes } from './deploy.js';
import { openTarget } from './target-detail.js';

/* ------- rollouts ---------------------------------------------------- */
VIEWS.ro = {
  title: 'Rollouts',
  bar: () => [h('button.btn.sm.primary', { onclick: newRolloutDialog }, icon('plus', 14), 'new rollout')],
  async render(root) {
    const st = pg('ro');
    const fields = [{}, { key: 'name', ph: 'filter' }, {}, {}, {}, {}, {}];
    const q = fiqlOf(fields.filter(f => f.key), st);
    const d = await get(pagedPath('/rollouts', st, q, 'id:DESC') + '&representation=full')
      .catch(() => ({ content: [], total: 0 }));
    if (!d.content.length && !Object.values(st.f).some(Boolean)) return root.replaceChildren(h('div.empty',
      h('b', 'No rollouts'),
      'A rollout deploys group by group and pauses itself when too many fail. ' +
      'Use one for a fleet; a direct assignment has no brake.'));
    root.replaceChildren(tableOf(['Id', 'Name', 'Status', 'Groups', 'Progress', 'Created', ''],
      d.content.map(r => {
        const t = r.totalTargets || 0, c = r.totalTargetsPerStatus || {};
        const seg = (n, cls) => n ? h('i.' + cls, { style: `width:${(n / t * 100).toFixed(1)}%` }) : null;
        const st = String(r.status || '').toLowerCase();
        return {
          onclick: () => openRollout(r),
          cells: [h('span.mono', r.id), r.name,
            pill(st, st === 'finished' ? 'ok' : st === 'paused' ? 'warn' : st === 'ready' ? 'mute' : 'info'),
            h('span.mono', r.totalGroups ?? '—'),
            h('div.flex', h('div.bars', seg(c.finished, 'ok'), seg(c.running, 'run'),
              seg(c.error, 'err'), seg((c.scheduled || 0) + (c.notstarted || 0), 'wait')),
              h('span.faint.nowrap', `${c.finished || 0}/${t}`)),
            h('span.faint.nowrap', { title: when(r.createdAt) }, ago(r.createdAt)),
            h('div.wrap',
              st === 'waiting_for_approval' ? actBtn('approve', () => post(`/rollouts/${r.id}/approve`)) : null,
              st === 'ready' ? actBtn('start', () => post(`/rollouts/${r.id}/start`)) : null,
              st === 'running' ? actBtn('pause', () => post(`/rollouts/${r.id}/pause`)) : null,
              st === 'paused' ? actBtn('resume', () => post(`/rollouts/${r.id}/resume`)) : null,
              actBtn('delete', async () => {
                if (!await ask('Delete rollout', `${r.name}\n\nAny action it started and is still running gets cancelled.`,
                               { danger: true })) throw new Error('cancelled by you');
                return del('/rollouts/' + r.id);
              })),
          ],
        };
      }), filterRow(fields, st, render)),
      pager(st, d.total, render));
  },
};
const actBtn = (label, fn) => h('button.btn.sm', {
  onclick: async e => {
    e.stopPropagation();
    try { await fn(); toast(label + ' ok', '', 'ok'); render(); }
    catch (er) { if (er.message !== 'cancelled by you') fail(er); }
  },
}, ACT_ICON[label] ? icon(ACT_ICON[label], 13) : null, label);

async function openRollout(r) {
  const body = h('div', h('div.empty', h('span.spin')));
  drawer(r.name, body);
  const g = await get(`/rollouts/${r.id}/deploygroups?limit=50&representation=full`).catch(() => ({ content: [] }));
  const c = r.totalTargetsPerStatus || {};
  const st = String(r.status || '').toLowerCase();

  // One group at a time is the point of a rollout: this is the button for
  // pushing the next one out without waiting for the success threshold.
  const controls = h('div.wrap',
    st === 'waiting_for_approval' ? actBtn('approve', () => post(`/rollouts/${r.id}/approve`)) : null,
    st === 'ready' ? actBtn('start', () => post(`/rollouts/${r.id}/start`)) : null,
    st === 'running' ? actBtn('pause', () => post(`/rollouts/${r.id}/pause`)) : null,
    st === 'paused' ? actBtn('resume', () => post(`/rollouts/${r.id}/resume`)) : null,
    st === 'running' || st === 'paused'
      ? actBtn('trigger next group', () => post(`/rollouts/${r.id}/triggerNextGroup`)) : null);
  body.replaceChildren(h('div.stack',
    controls,
    h('div.panel', h('h3', 'Rollout'), h('div.body', h('dl.kv',
      [['id', r.id], ['status', r.status], ['description', r.description || '—'],
       ['targets', r.totalTargets], ['groups', r.totalGroups],
       ['query', r.targetFilterQuery || '—'], ['distribution set', r.distributionSetId ?? '—'],
       ['action type', r.type || '—'], ['created', when(r.createdAt)]]
        .map(([k, v]) => [h('dt', k), h('dd', String(v))])))),
    h('div.panel', h('h3', 'Stats'), h('div.body.wrap',
      Object.entries(c).map(([k, v]) => h('span.pill.' +
        (k === 'finished' ? 'ok' : k === 'error' ? 'err' : k === 'running' ? 'info' : 'mute'),
        `${k} · ${v}`)))),
    h('div.panel', h('h3', 'Groups'), h('div.body',
      g.content.length
        ? tableOf(['#', 'Name', 'Status', 'Progress', 'Targets', 'Finished', 'Error'],
            g.content.map(x => {
              const gs = String(x.status || '').toLowerCase();
              const gc = x.totalTargetsPerStatus || {};
              const tot = x.totalTargets || 0;
              const seg = (n, cls) => n ? h('i.' + cls, { style: `width:${(n / tot * 100).toFixed(1)}%` }) : null;
              return {
                onclick: () => openRolloutGroup(r, x),
                cells: [h('span.mono', x.id), x.name,
                  pill(gs, gs === 'finished' ? 'ok' : gs === 'error' ? 'err'
                    : gs === 'running' ? 'live' : 'mute'),
                  h('div.bars', seg(gc.finished, 'ok'), seg(gc.running, 'run'),
                    seg(gc.error, 'err'), seg((gc.scheduled || 0) + (gc.notstarted || 0), 'wait')),
                  h('span.mono', tot || '—'),
                  h('span.mono', gc.finished ?? 0), h('span.mono', gc.error ?? 0)],
              };
            }))
        : h('span.faint', 'no groups')))));
}

async function openRolloutGroup(r, g) {
  const body = h('div', skeleton(5));
  drawer(`${r.name} · ${g.name}`, body);
  try {
    const t = await get(`/rollouts/${r.id}/deploygroups/${g.id}/targets?limit=200`);
    body.replaceChildren(h('div.stack',
      h('button.btn', { onclick: () => openRollout(r) }, icon('left', 14), 'back to the rollout'),
      h('div.panel', h('h3', `Targets in this group (${t.total})`), h('div.body',
        t.content.length
          ? tableOf(['Controller', 'Status', 'Last poll'], t.content.map(x => ({
              onclick: () => openTarget(x.controllerId),
              cells: [h('span.mono', x.controllerId),
                pill(x.updateStatus, TARGET_PILL[x.updateStatus]),
                h('span.faint.nowrap', ago(x.lastControllerRequestAt))],
            })))
          : h('span.faint', 'none')))));
  } catch (e) { body.replaceChildren(h('div.empty', e.message)); }
}

async function newRolloutDialog(presetQuery) {
  const sets = await distributionSets(true);
  const name = h('input', { type: 'text', placeholder: 'neo-intel 25.7.3' });
  const desc = h('input', { type: 'text' });
  const ds = h('select', sets.content.filter(d => d.complete)
    .map(d => h('option', { value: d.id }, `${d.name} ${d.version} · ${d.type}`)));
  const preview = h('div.fq-count', h('span.faint', '—'));
  const check = async () => {
    const v = q.value.trim();
    if (!v) { preview.replaceChildren(h('span.faint', 'a rollout needs a query to aim at')); return; }
    preview.replaceChildren(h('span.faint', h('span.spin'), ' counting…'));
    try {
      const r = await get('/targets?limit=1&q=' + fiql(v));
      preview.replaceChildren(h('b', String(r.total)),
        h('span.faint', ` target${r.total === 1 ? '' : 's'} would be rolled out to`));
    } catch (e) {
      preview.replaceChildren(h('span.fq-bad', 'hawkBit refused this query: ' + e.message));
    }
  };

  let qTimer = null;
  const q = fiqlEditor({
    entity: 'targets', value: presetQuery || '',
    onChange: (_, verdict) => {
      clearTimeout(qTimer);
      if (!verdict.ok) { preview.replaceChildren(h('span.faint', 'fix the query to see the count')); return; }
      qTimer = setTimeout(check, 350);
    },
  });
  const groupsBox = numInput(3, 1, 50), groups = groupsBox.input;
  const errThBox = numInput(10, 0, 100, 5), errTh = errThBox.input;
  const okThBox = numInput(100, 0, 100, 5), okTh = okThBox.input;
  const actType = h('select',
    h('option', { value: 'forced' }, 'forced'), h('option', { value: 'soft' }, 'soft'),
    h('option', { value: 'timeforced' }, 'timeforced'),
    h('option', { value: 'downloadonly' }, 'download only'));
  const startType = h('select',
    h('option', { value: 'manual' }, 'manual — create it ready, press start'),
    h('option', { value: 'auto' }, 'auto — start immediately'),
    h('option', { value: 'scheduled' }, 'scheduled — start at a time'));
  const startAt = dtInput(null);
  startAt.disabled = true;
  startType.addEventListener('change', () => {
    startAt.disabled = startType.value !== 'scheduled';
    if (startAt.disabled) startAt.value = '';
  });


  // Shortcut for the query almost every fleet rollout uses.
  const rollTypes = h('div.wrap');
  deviceTypes().then(list => rollTypes.replaceChildren(...list.map(x =>
    h('button.chip', { onclick: () => { q.value = `attribute.device_type==${x}`; check(); } },
      h('span.plus', '+'), x))));

  modal('Create rollout', [
    h('label.f', 'Name', name), h('label.f', 'Description', desc),
    h('label.f', 'Distribution set', ds),
    h('label.f', 'Target filter', q), preview, rollTypes,
    h('label.f', 'Group count', groupsBox),
    h('label.f', 'Action type', actType),
    h('label.f', 'Start type', startType),
    h('label.f', 'Scheduled at', startAt), dtQuick(startAt),
    h('label.f', 'Success threshold, %', okThBox),
    h('label.f', 'Error threshold, % per group', errThBox),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'The rollout pauses itself when a group exceeds the error threshold, so a bad build stops ' +
      'after the first group instead of taking down a venue.'),
  ], async () => {
    if (!name.value.trim()) throw new Error('a name is required');
    if (!ds.value) throw new Error('no complete distribution set to roll out');
    const b = {
      name: name.value.trim(), distributionSetId: Number(ds.value),
      targetFilterQuery: q.value.trim(), amountGroups: Number(groups.value),
      type: actType.value, startAt: undefined,
      successCondition: { condition: 'THRESHOLD', expression: String(okTh.value) },
      successAction: { action: 'NEXTGROUP', expression: '' },
      errorCondition: { condition: 'THRESHOLD', expression: String(errTh.value) },
      errorAction: { action: 'PAUSE', expression: '' },
    };
    if (desc.value.trim()) b.description = desc.value.trim();
    const sa = startType.value === 'scheduled' ? dtMs(startAt) : null;
    if (sa) b.startAt = sa; else delete b.startAt;
    if (startType.value === 'scheduled' && !sa) throw new Error('pick a date and time, or choose another start type');
    const r = await post('/rollouts', b);
    if (startType.value === 'auto') await post(`/rollouts/${r.id}/start`).catch(() => {});
    toast('Created', startType.value === 'auto' ? 'started' : 'press start when ready', 'ok');
    render();
  }, 'Create');
}

export {
  newRolloutDialog,
};
