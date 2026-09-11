import { attributesOf, hasBatch, sampleAttributes, statesOf } from './batch.js';
import { enc, get, limited } from './api.js';
import { TARGET_PILL, explainPending, paintPhase, phaseFromState, phaseOf, pill, typePill } from './badges.js';
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
                    // "pending" covers assigned, downloading, installing and
                    // waiting-for-reboot. Say which -- and say it straight
                    // away: the view looks the phases up before it builds the
                    // rows, so the pill is never drawn as "pending" and then
                    // rewritten a moment later. That flicker was visible on
                    // every refresh of a device taking an update.
                    if (t.updateStatus === 'pending') {
                      if (PHASES.has(t.controllerId)) paintPhase(p, PHASES.get(t.controllerId));
                      else explainPending(p, t.controllerId);
                    }
                    return p; } },
  ds:           { label: 'Assigned / installed', cell: t => {
                    const c = h('span.faint', '…'); loadAssignedInstalled(t.controllerId, c); return c; } },
  lastPoll:     { label: 'Last poll', s: 'lastControllerRequestAt', cell: t => h('span.faint.nowrap', ago(t.lastControllerRequestAt)) },
  nextPoll:     { label: 'Next', cell: t => t.pollStatus && t.pollStatus.overdue
                    ? h('span.pill.warn.pulse', 'overdue')
                    : h('span.faint.nowrap', t.pollStatus ? ago(t.pollStatus.nextExpectedRequestAt) : '—') },
  // the fleet, in its own colour -- the same dot as on the Fleets page and
  // the Targets quick filters (Qawk; read with the page's batch)
  fleet:        { label: 'Fleet', cell: t => {
    const f = FLEET_OF.get(t.controllerId);
    return f ? h('span.flex', { style: 'gap:6px;white-space:nowrap' },
      h('span.swatch-dot', { style: `--sw:${f.colour || '#8b8f98'}` }), f.name) : h('span.faint.nowrap', { title: 'in no fleet' }, 'no fleet');
  } },
  ip:           { label: 'IP', cell: t => h('span.mono.faint', t.ipAddress || '—') },
  targetType:   { label: 'Type', cell: t => h('span.dim', (t.targetType && (t.targetType.name || t.targetType)) || '—') },
  created:      { label: 'Registered', s: 'createdAt', cell: t => h('span.faint.nowrap', when(t.createdAt)) },
  security:     { label: 'Token', cell: t => h('span.mono.faint', t.securityToken || '—') },
};
const T_COLS_DEFAULT = ['controllerId', 'name', 'fleet', 'status', 'ds', 'lastPoll', 'nextPoll', 'ip'];

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
/* A column added to the defaults after someone saved their choice joins that
 * choice, at its place: otherwise a browser that ever chose its columns never
 * sees a new one -- the Fleet column stayed invisible to exactly the people
 * who use the console most. Along with the choice goes the list of defaults
 * it was made against ("seen"); a default missing from it is new. One taken
 * away after that stays away. Choices saved before "seen" existed were made
 * against the defaults minus those listed in ADDED. */
const ADDED = { targets: ['fleet'] };
function cols(view = 'targets') {
  const def = COLSETS[view].def;
  try {
    const v = JSON.parse(localStorage.getItem('hb-cols-' + view) || 'null');
    if (Array.isArray(v) && v.length) {
      const seen = JSON.parse(localStorage.getItem('hb-cols-seen-' + view) || 'null')
        || def.filter(id => !(ADDED[view] || []).includes(id));
      const out = v.slice();
      def.forEach((id, i) => {
        if (seen.includes(id) || out.includes(id)) return;
        const after = i ? out.indexOf(def[i - 1]) : -1;
        out.splice(after >= 0 ? after + 1 : (i ? out.length : 0), 0, id);
      });
      return out;
    }
  } catch (_) {}
  return def.slice();
}
function setCols(v, view = 'targets') {
  try {
    localStorage.setItem('hb-cols-' + view, JSON.stringify(v));
    localStorage.setItem('hb-cols-seen-' + view, JSON.stringify(COLSETS[view].def));
  } catch (_) {}
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

/* Phases looked up before a render, keyed by controllerId. Filled by
   loadPhases() and read by the status cell, so the two happen in the right
   order instead of racing. */
const PHASES = new Map();
const aiFresh = new Map();   // controllerId -> {a, i, at}: read with the page's batch
const FLEET_OF = new Map();  // controllerId -> {name, colour}: read with the page's batch
async function loadPhases(targets) {
  PHASES.clear();
  const list = targets || [];
  if (!list.length) return;
  // ONE REQUEST FOR THE PAGE (Qawk): what every row's device is doing, and
  // what it was assigned and runs -- the status column and the
  // assigned/installed column both read it. Against hawkBit, row by row.
  if (hasBatch()) {
    try {
      const st = await statesOf(list.map(t => t.controllerId));
      const now = Date.now();
      for (const t of list) {
        const s = st.get(t.controllerId);
        if (!s) continue;
        aiFresh.set(t.controllerId, { a: s.assigned, i: s.installed, at: now });
        if (s.fleet) FLEET_OF.set(t.controllerId, s.fleet); else FLEET_OF.delete(t.controllerId);
        if (t.updateStatus === 'pending') {
          const ph = phaseFromState(s);
          if (ph) PHASES.set(t.controllerId, ph);
        }
      }
      return;
    } catch (_) { /* row by row, below */ }
  }
  const pending = list.filter(t => t.updateStatus === 'pending');
  await Promise.all(pending.map(async t => {
    const ph = await phaseOf(t.controllerId);
    if (ph) PHASES.set(t.controllerId, ph);
  }));
}

const attrCache = new Map();
/* Attributes are cached with an age, not cleared on every render. Clearing
   made every attribute cell re-fetch and blink on each automatic refresh;
   never expiring would mean a device that reports a new value never shows it.
   A device reports them once per poll at most, so a minute is generous. */
const ATTR_TTL = 60000;
async function attrsOf(id) {
  const hit = attrCache.get(id);
  if (hit && Date.now() - hit.at < ATTR_TTL) return hit.v;
  const v = limited(() => get(`/targets/${enc(id)}/attributes`)).catch(() => ({}));
  attrCache.set(id, { at: Date.now(), v });
  return v;
}

/* The attributes of a whole page in one request, before its cells ask. */
async function prefetchAttrs(ids) {
  const need = ids.filter(id => { const hit = attrCache.get(id); return !hit || Date.now() - hit.at >= ATTR_TTL; });
  if (!need.length || !hasBatch()) return;
  try {
    const m = await attributesOf(need);
    const now = Date.now();
    need.forEach(id => attrCache.set(id, { at: now, v: Promise.resolve(m.get(id) || {}) }));
  } catch (_) { /* each cell asks for itself */ }
}


/* WHAT THE CELL LOOKED LIKE LAST TIME, so a refresh does not blink.
 *
 * This cell fetches two things per row. Built fresh on every render it starts
 * as "…" and fills in a moment later, which on a ten-second auto-refresh means
 * the whole column visibly reforms every ten seconds. Whatever it showed last
 * time is almost always still true, so it is painted straight away and quietly
 * corrected if the server says otherwise. */
const aiCache = new Map();

function renderAI(cell, a, i) {
  const name = d => (d ? `${d.name} ${d.version}` : '—');
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
}

async function loadAssignedInstalled(id, cell) {
  const seen = aiCache.get(id);
  if (seen) renderAI(cell, seen.a, seen.i);      // no "…" on a refresh
  const fresh = aiFresh.get(id);
  if (fresh && Date.now() - fresh.at < 15000) {  // read with the page: no request of its own
    const key = `${fresh.a && fresh.a.id}/${fresh.i && fresh.i.id}`;
    if (!seen || seen.key !== key) { aiCache.set(id, { a: fresh.a, i: fresh.i, key }); renderAI(cell, fresh.a, fresh.i); }
    return;
  }
  try {
    const [a, i] = await limited(() => Promise.all([
      get(`/targets/${enc(id)}/assignedDS`).catch(() => null),
      get(`/targets/${enc(id)}/installedDS`).catch(() => null),
    ]));
    const key = `${a && a.id}/${i && i.id}`;
    if (!seen || seen.key !== key) { aiCache.set(id, { a, i, key }); renderAI(cell, a, i); }
  } catch (_) { if (!seen) cell.textContent = '—'; }
}


async function columnsDialog(view = 'targets') {
  // Checkboxes could say which columns, never in what order -- and the order is
  // half the point: whoever is looking wants their own two or three first.
  const CS = COLSETS[view];
  let chosen = cols(view).slice();

  const keys = new Set();
  if (CS.attrs) {
    (await sampleAttributes(50).catch(() => [])).forEach(a => Object.keys(a || {}).forEach(k => keys.add(k)));
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
  loadPhases, prefetchAttrs, D_COLS, M_COLS, T_COLS, attrsOf, baseCell, cols, columnsDialog, fieldsFor, headsFor, loadAssignedInstalled, metaCache,
};
