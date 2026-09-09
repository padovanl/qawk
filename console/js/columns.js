import { enc, get, limited } from './api.js';
import { TARGET_PILL, pill, typePill } from './badges.js';
import { modal } from './chrome.js';
import { $, h } from './dom.js';
import { render } from './router.js';
import { pg } from './table.js';
import { ago, when } from './util.js';

/* COLUMNS ARE CHOSEN BY WHOEVER IS LOOKING.
 *
 * The fixed part is here; anything a device reports about itself becomes a
 * column of its own, discovered from the fleet rather than hardcoded. So
 * device_type, slot and os_version are available today and centerid becomes
 * available the day the first device sends it, with nothing to change here.
 *
 * The choice is per browser (localStorage): two people watching the same fleet
 * usually want different columns. */
const T_COLS = {
  controllerId: { label: 'Controller', s: 'controllerId', cell: t => h('span.mono', t.controllerId) },
  name:         { label: 'Name', s: 'name', cell: t => h('span.dim', t.name !== t.controllerId ? t.name : '—') },
  status:       { label: 'Status', s: 'updateStatus', cell: t => {
                    const p = pill(t.updateStatus, TARGET_PILL[t.updateStatus]);
                    // in_sync on a device that has never installed anything is
                    // hawkBit saying "nothing pending", which is not the same
                    // as "up to date". Worth a mark rather than a false calm.
                    if (t.updateStatus === 'in_sync' && !t.installedAt) {
                      p.classList.remove('ok'); p.classList.add('mute');
                      p.title = 'nothing pending — but this server has never installed anything here';
                      p.append(h('span', { style: 'opacity:.7;margin-left:5px' }, '·  never installed'));
                    }
                    return p; } },
  ds:           { label: 'Assigned / installed', cell: t => {
                    const c = h('span.faint', '…'); loadAssignedInstalled(t.controllerId, c); return c; } },
  lastPoll:     { label: 'Last poll', s: 'lastControllerRequestAt', cell: t => h('span.faint.nowrap', ago(t.lastControllerRequestAt)) },
  nextPoll:     { label: 'Next', cell: t => t.pollStatus && t.pollStatus.overdue
                    ? h('span.pill.warn.pulse', 'overdue')
                    : h('span.faint.nowrap', t.pollStatus ? ago(t.pollStatus.nextExpectedRequestAt) : '—') },
  ip:           { label: 'IP', cell: t => h('span.mono.faint', t.ipAddress || '—') },
  targetType:   { label: 'Type', cell: t => h('span.dim', (t.targetType && (t.targetType.name || t.targetType)) || '—') },
  created:      { label: 'Registered', s: 'createdAt', cell: t => h('span.faint.nowrap', when(t.createdAt)) },
  security:     { label: 'Token', cell: t => h('span.mono.faint', t.securityToken || '—') },
};
const T_COLS_DEFAULT = ['controllerId', 'name', 'status', 'ds', 'lastPoll', 'nextPoll', 'ip'];

const D_COLS = {
  id:      { label: 'Id', s: 'id', cell: x => h('span.mono', x.id) },
  name:    { label: 'Name', s: 'name', cell: x => x.name, f: 'name' },
  version: { label: 'Version', s: 'version', cell: x => h('span.mono', x.version), f: 'version' },
  type:    { label: 'Type', cell: x => typePill(x.type), f: 'type' },
  // Not shown by default: on a healthy server it is 'yes' on every row, and a
  // column that never varies is width spent on nothing. Add it when you are
  // hunting for the set that will not assign -- then it has to say both things.
  complete:{ label: 'Complete', cell: x => x.complete ? h('span.pill.ok', 'complete') : h('span.pill.err', 'incomplete') },
  desc:    { label: 'Description', cell: x => h('span.faint', x.description || '—'), f: 'description' },
  created: { label: 'Created', s: 'createdAt', cell: x => h('span.faint.nowrap', { title: when(x.createdAt) }, ago(x.createdAt)) },
};
const M_COLS = {
  id:      { label: 'Id', s: 'id', cell: m => h('span.mono', m.id) },
  name:    { label: 'Name', s: 'name', cell: m => m.name, f: 'name' },
  version: { label: 'Version', s: 'version', cell: m => h('span.mono', m.version), f: 'version' },
  type:    { label: 'Type', cell: m => typePill(m.type), f: 'type' },
  vendor:  { label: 'Vendor', cell: m => h('span.faint', m.vendor || '—'), f: 'vendor' },
  desc:    { label: 'Description', cell: m => h('span.faint', m.description || '—'), f: 'description' },
  enc:     { label: 'Encrypted', cell: m => m.encrypted ? h('span.pill.info', 'yes') : h('span.faint', '—') },
  // WHAT A DELTA STARTS FROM. For an application a delta applied to the wrong
  // base does not merely save less: it fails. Worth a column of its own.
  // WHAT A DELTA STARTS FROM -- and the two cases are not the same warning:
  //
  //   application: the manifest names one exact file, so a device on any other
  //                version fails the update outright. Amber: check first.
  //   system:      it compares against the other slot, whatever is in it. It
  //                always works; only how much it saves varies. Grey: nothing
  //                to check.
  //
  // Showing both as "from X" made the second look like a requirement it is not.
  base:    { label: 'Delta base', cell: m => {
              const c = h('span.faint', '');
              deltaBase(m.id).then(v => {
                if (!v) { c.textContent = '—'; c.title = 'not a delta package'; return; }
                if (v === 'the other slot') {
                  c.className = 'faint nowrap'; c.textContent = 'no base needed';
                  c.title = 'It rebuilds the image chunk by chunk against whatever is in the ' +
                            'other slot, so it installs correctly from any version. What ' +
                            'changes is the saving: the further apart the two images are, the ' +
                            'more is downloaded, and from something very different it can move ' +
                            'MORE than the full package would.';
                } else {
                  c.className = 'pill amber'; c.textContent = 'needs ' + v;
                  c.title = 'fails unless the device is already on ' + v;
                }
              });
              return c; } },
  created: { label: 'Created', s: 'createdAt', cell: m => h('span.faint.nowrap', { title: when(m.createdAt) }, ago(m.createdAt)) },
};
const COLSETS = {
  targets: { defs: T_COLS, def: T_COLS_DEFAULT, attrs: true },
  ds: { defs: D_COLS, def: ['id', 'name', 'version', 'type', 'created'], attrs: false },
  sm: { defs: M_COLS, def: ['id', 'name', 'version', 'type', 'base', 'created'], attrs: false },
};

// Filter fields follow the chosen columns, so a column you added is a column
// you can search.
// Column ids -> header descriptors, carrying the sort key when the server can
// order by that field.
function headsFor(view, chosen) {
  const st = pg(view);
  return chosen.map(id => {
    const d = COLSETS[view].defs[id];
    return d && d.s ? { label: colLabel(id, view), key: d.s, state: st }
                    : colLabel(id, view);
  });
}

function fieldsFor(view) {
  return cols(view).map(id => {
    const d = COLSETS[view].defs[id];
    return d && d.f ? { key: d.f, ph: 'filter' } : {};
  }).concat([{}]);
}
function cols(view = 'targets') {
  try {
    const v = JSON.parse(localStorage.getItem('hb-cols-' + view) || 'null');
    if (Array.isArray(v) && v.length) return v;
  } catch (_) {}
  return COLSETS[view].def.slice();
}
function setCols(v, view = 'targets') {
  try { localStorage.setItem('hb-cols-' + view, JSON.stringify(v)); } catch (_) {}
  render();
}
const colLabel = (id, view = 'targets') => id.startsWith('attr:')
  ? id.slice(5) : ((COLSETS[view].defs[id] || {}).label || id);

// Delta base, from the module's metadata. One request per row, so it goes
// through the same limiter as everything else that is fetched per row.
const metaCache = new Map();
async function deltaBase(smId) {
  if (!metaCache.has(smId)) {
    metaCache.set(smId, limited(() => get(`/softwaremodules/${smId}/metadata`))
      .then(r => {
        const list = Array.isArray(r) ? r : (r.content || []);
        const e = list.find(x => x.key === 'delta_base');
        return e ? e.value : '';
      }).catch(() => ''));
  }
  return metaCache.get(smId);
}

const attrCache = new Map();
async function attrsOf(id) {
  if (!attrCache.has(id)) {
    attrCache.set(id, limited(() => get(`/targets/${enc(id)}/attributes`)).catch(() => ({})));
  }
  return attrCache.get(id);
}

async function loadAssignedInstalled(id, cell) {
  try {
    const [a, i] = await limited(() => Promise.all([
      get(`/targets/${enc(id)}/assignedDS`).catch(() => null),
      get(`/targets/${enc(id)}/installedDS`).catch(() => null),
    ]));
    const name = d => d ? `${d.name} ${d.version}` : '—';
    // NOTHING AT ALL is one state, not two empty ones. A target whose only
    // action was cancelled has neither, and hawkBit still calls it in_sync --
    // which means "nothing outstanding", not "running what it should".
    if (!a && !i) {
      cell.replaceChildren(h('span.faint', '—'));
      cell.title = 'this server has never installed anything here';
      return;
    }
    const same = a && i && a.id === i.id;
    // Two long names on one line wrap into porridge. One line each, labelled,
    // clipped, with the whole thing in the tooltip -- and the second line only
    // when the device is actually between two versions.
    const line = (lab, d, cls) => h('div.ai-row',
      h('span.ai-k' + (cls ? '.' + cls : ''), lab),
      h('span.ai-v.mono', { title: name(d) }, name(d)));
    cell.replaceChildren(same
      ? h('div.ai', line('inst', i))
      : h('div.ai', line('inst', i), line('asgn', a, 'wait')));
    cell.title = same ? '' : 'assigned, not yet installed';
  } catch (_) { cell.textContent = '—'; }
}

async function columnsDialog(view = 'targets') {
  // Checkboxes could say which columns, never in what order -- and the order is
  // half the point: whoever is looking wants their own two or three first.
  const CS = COLSETS[view];
  let chosen = cols(view).slice();

  const keys = new Set();
  if (CS.attrs) {
    const sample = await get('/targets?limit=12').catch(() => ({ content: [] }));
    await Promise.all(sample.content.map(async t => {
      const a = await get(`/targets/${enc(t.controllerId)}/attributes`).catch(() => ({}));
      Object.keys(a || {}).forEach(k => keys.add(k));
    }));
    chosen.filter(c => c.startsWith('attr:')).forEach(c => keys.add(c.slice(5)));
  }

  const shown = h('div.colpick-list');
  const pool = h('div.wrap');

  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= chosen.length) return;
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    draw();
  };

  let dragFrom = null;
  function draw() {
    shown.replaceChildren(...chosen.map((id, i) => {
      const row = h('div.colrow', { draggable: 'true' },
        h('span.grip', '⠿'),
        h('span.cl', colLabel(id, view)),
        id.startsWith('attr:') ? h('span.tag', 'attribute') : null,
        h('div.flex',
          h('button.btn.sm.ghost', { disabled: i === 0, onclick: () => move(i, -1), title: 'up' }, '↑'),
          h('button.btn.sm.ghost', { disabled: i === chosen.length - 1, onclick: () => move(i, 1), title: 'down' }, '↓'),
          h('button.btn.sm.ghost.danger', {
            onclick: () => { chosen.splice(i, 1); draw(); }, title: 'remove',
          }, '×')));
      row.addEventListener('dragstart', () => { dragFrom = i; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { dragFrom = null; row.classList.remove('dragging'); });
      row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('over'); });
      row.addEventListener('dragleave', () => row.classList.remove('over'));
      row.addEventListener('drop', e => {
        e.preventDefault(); row.classList.remove('over');
        if (dragFrom === null || dragFrom === i) return;
        const [m] = chosen.splice(dragFrom, 1);
        chosen.splice(i, 0, m);
        draw();
      });
      return row;
    }));
    if (!chosen.length) shown.append(h('div.faint', { style: 'padding:10px' }, 'no columns — add at least one'));

    const avail = Object.keys(CS.defs).filter(id => !chosen.includes(id))
      .map(id => ['f', id, CS.defs[id].label])
      .concat([...keys].sort().filter(k => !chosen.includes('attr:' + k))
        .map(k => ['a', 'attr:' + k, k]));
    pool.replaceChildren(...(avail.length
      ? avail.map(([kind, id, label]) => h('button.chip' + (kind === 'a' ? '.attr' : ''), {
          onclick: () => { chosen.push(id); draw(); },
        }, h('span.plus', '+'), label))
      : [h('span.faint', 'everything is already shown')]));
  }
  draw();

  modal('Columns', [
    h('div.colpick',
      h('div.colpick-h', 'Shown, in order', h('div.grow'),
        h('button.btn.sm.ghost', {
          onclick: () => { chosen = CS.def.slice(); draw(); },
        }, 'reset')),
      shown,
      h('div.colpick-h', 'Add a column'),
      pool,
      CS.attrs ? h('p.faint', { style: 'margin:6px 0 0;font-size:12px' },
        'Attributes are what the devices report about themselves, so the list grows on its own: ' +
        'a new one appears here as soon as the first device sends it. Those columns cost one ' +
        'request per row, so add them when you need them.') : null),
  ], async () => {
    if (!chosen.length) throw new Error('keep at least one column');
    setCols(chosen, view);
  }, 'Apply');
}

const baseCell = id => {
  const c = h('span.faint', '…');
  deltaBase(id).then(v => {
    c.textContent = !v ? 'not a delta'
      : v === 'the other slot'
        ? 'none — rebuilt against whatever is in the other slot; only the saving varies'
        : `only from ${v} — it fails on a device running anything else`;
  });
  return c;
};

export {
  D_COLS, M_COLS, T_COLS, attrCache, attrsOf, baseCell, cols, columnsDialog, fieldsFor, headsFor, loadAssignedInstalled, metaCache,
};
