import { S, del, enc, get, post, put } from '../api.js';
import { actionPill, pill } from '../badges.js';
import { fleetBadge } from '../chips.js';
import { hasBatch, statesOf } from '../batch.js';
import { ask, closeDrawer, drawer, fail, refreshDrawer, toast } from '../chrome.js';
import { loadAssignedInstalled } from '../columns.js';
import { h, icon, live } from '../dom.js';
import { toggle } from '../inputs.js';
import { go, render } from '../router.js';
import { ago, download, when } from '../util.js';
import { assignDialog } from './deploy.js';
import { newTagDialog } from './tags.js';

async function actionLogText(id, a) {
  const r = await get(`/targets/${enc(id)}/actions/${a.id}/status?limit=200&sort=id:ASC`).catch(() => ({ content: [] }));
  const head = [
    `# target      ${id}`,
    `# action      ${a.id}`,
    `# type        ${a.type || '-'}   force: ${a.forceType || '-'}`,
    `# status      ${a.status}${a.active ? ' (active)' : ''}`,
    `# created     ${new Date(a.createdAt).toISOString()}`,
    `# last change ${new Date(a.lastModifiedAt || a.createdAt).toISOString()}`,
    '',
  ];
  const body = (r.content || []).map(e => {
    const m = (e.messages || []).filter(Boolean);
    return `${new Date(e.reportedAt).toISOString()}  ${e.type}` +
           (m.length ? '\n    ' + m.join('\n    ') : '');
  });
  return head.concat(body.length ? body : ['(no feedback recorded)']).join('\n') + '\n';
}

/* A device's drawer follows the device. It is built from what the server says
 * now and rebuilt every few seconds in place (chrome.js, refreshDrawer): the
 * status, the last poll, a new action, its log -- each changes where it
 * stands, while the tab you are on, the actions you opened and the attribute
 * filter you typed stay. What costs a request per action (how it ended, its
 * log) is asked once, and again only while the action is still moving. */
const T = { id: null, tab: 'overview', open: null, attrQ: '', summaries: new Map(), logs: new Map() };

async function openTarget(id) {
  if (T.id !== id) Object.assign(T, { id, tab: 'overview', open: null, attrQ: '', summaries: new Map(), logs: new Map() });
  S.sel = id;
  const build = () => buildTarget(id);
  drawer(id, h('div.empty', h('span.spin')), build);
  try {
    const node = await build();
    if (T.id === id) drawer(id, node, build);
  } catch (e) { drawer(id, h('div.empty', e.message), build); }
}

async function buildTarget(id) {
  const [t, attrs, acts, tags, autoc, state, allTags] = await Promise.all([
    get('/targets/' + enc(id)),
    get(`/targets/${enc(id)}/attributes`).catch(() => ({})),
    get(`/targets/${enc(id)}/actions?limit=30&sort=id:DESC`).catch(() => ({ content: [] })),
    get(`/targets/${enc(id)}/tags`).catch(() => []),
    get(`/targets/${enc(id)}/autoConfirm`).catch(() => null),
    hasBatch() ? statesOf([id]).then(m => m.get(id) || null).catch(() => null) : Promise.resolve(null),
    T.tab === 'tags' ? get('/targettags?limit=100').then(r => r.content || []).catch(() => []) : Promise.resolve([]),
  ]);
  const actions = acts.content || [];
  // open the newest one and anything still moving, the first time; then what you choose
  if (T.open === null) T.open = new Set(actions.filter((a, i) => i === 0 || a.active).map(a => a.id));
  if (T.tab === 'actions') {
    await Promise.all(actions.map(async a => {
      if (!T.summaries.has(a.id) || a.active) {
        try {
          const r = await get(`/targets/${enc(id)}/actions/${a.id}/status?limit=1&sort=id:DESC`);
          const e = (r.content || [])[0];
          T.summaries.set(a.id, e ? ((e.messages || []).filter(Boolean).join(' | ') || e.type || '').slice(0, 90) : '');
        } catch (_) { /* no summary: the header still says the status */ }
      }
      if (T.open.has(a.id) && (!T.logs.has(a.id) || a.active)) {
        try {
          const r = await get(`/targets/${enc(id)}/actions/${a.id}/status?limit=30&sort=id:DESC`);
          T.logs.set(a.id, r.content || []);
        } catch (e) { T.logs.set(a.id, e.message); }
      }
    }));
  }
  const tab = (key, label) => h('button' + (T.tab === key ? '.on' : ''),
    { onclick: () => { T.tab = key; refreshDrawer(); } }, label);
  const pane = T.tab === 'actions' ? actionsPane(id, actions)
    : T.tab === 'tags' ? tagsPane(id, tags || [], allTags)
    : overviewPane(t, attrs, autoc, id, state);
  return h('div',
    h('div.wrap', { style: 'margin-bottom:12px' },
      h('button.btn.primary.sm', { onclick: () => assignDialog(id) }, icon('deploy', 14), 'deploy'),
      h('button.btn.sm.danger', { onclick: () => cancelLatest(id, false) }, 'cancel action'),
      h('button.btn.sm.danger', { onclick: () => cancelLatest(id, true) }, 'force cancel'),
      h('button.btn.sm.danger', { onclick: async () => {
          if (!await ask('Delete target', `${id}\n\nIts history goes with it.`, { danger: true })) return;
          try {
            await del('/targets/' + enc(id));
            S.picked.delete(id);        // or the bulk bar counts a device that is gone
            toast('Deleted', id, 'ok'); closeDrawer(); render();
          }
          catch (e) { fail(e); }
        } }, 'delete')),
    h('div.tabs', tab('overview', 'Overview'), tab('actions', `Actions (${actions.length})`),
      tab('tags', `Tags (${(tags || []).length})`)),
    pane);
}

function overviewPane(t, attrs, autoc, id, state) {
  const dsBox = h('span.faint', { 'data-pending': '' }, '…');
  loadAssignedInstalled(t.controllerId, dsBox);
  // its fleet, in the fleet's colour (Qawk): a click shows the fleet's devices
  const f = state && state.fleet;
  const fleetBox = !hasBatch() ? h('span.faint', '—') : f
    ? h('span.flex', { style: 'gap:6px;cursor:pointer', title: 'its fleet\'s devices',
        onclick: () => { closeDrawer(); S.fleet = f.name; S.status = ''; S.q = ''; go('targets'); } },
      fleetBadge(f.name, f.colour))
    : h('span.faint', 'none');
  const kv = [
    ['controller id', t.controllerId], ['name', t.name], ['fleet', fleetBox],
    ['description', t.description || '—'], ['status', t.updateStatus],
    ['ip', t.ipAddress || '—'], ['security token', t.securityToken || '—'],
    ['last poll', `${when(t.lastControllerRequestAt)}  (${ago(t.lastControllerRequestAt)})`],
    ['next poll', t.pollStatus ? when(t.pollStatus.nextExpectedRequestAt) : '—'],
    ['registered', when(t.createdAt)],
  ];
  const rows = Object.entries(attrs || {}).sort(([a], [b]) => a.localeCompare(b));
  return h('div.stack',
    h('div.panel', h('h3', 'Target'), h('div.body.stack',
      h('dl.kv', kv.map(([k, v]) => [h('dt', k), h('dd', v ?? '—')]),
        h('dt', 'assigned / installed'), h('dd', dsBox)))),
    autoc ? h('div.panel', h('h3', 'Auto-confirmation'), h('div.body.flex',
      toggle(autoc.active, async v => {
        // Both directions are POST. DELETE on deactivate answers 405 and leaves
        // it switched on, which reads as a control that does nothing.
        await post(`/targets/${enc(id)}/autoConfirm/${v ? 'activate' : 'deactivate'}`, {});
        toast('Auto-confirmation', v ? 'on' : 'off', 'ok');
        refreshDrawer();
      }),
      h('span.faint', 'off means an update that needs confirmation waits for a human'))) : null,
    attrPanel(rows));
}

/* Five attributes today, fifty when every application reports its version.
 * The list gets its own scroll rather than pushing the panel off the drawer, a
 * filter once there are enough to hunt through, and values that wrap instead of
 * widening the panel -- a long one used to stretch the whole drawer. */
function attrPanel(rows) {
  if (!rows.length) {
    return h('div.panel', h('h3', 'Attributes reported by the device'),
      h('div.body', h('span.faint', 'none yet — the device sends these on its next poll')));
  }
  const list = h('dl.kv.attrs');
  const paint = (el, q) => {
    const f = q ? rows.filter(([k, v]) =>
      (k + ' ' + v).toLowerCase().includes(q.toLowerCase())) : rows;
    el.replaceChildren(...(f.length
      ? f.flatMap(([k, v]) => [h('dt', { title: k }, k), h('dd', { title: v }, v)])
      : [h('dt', ''), h('dd', h('span.faint', 'nothing matches'))]));
  };
  paint(list, T.attrQ);
  const search = rows.length > 8
    ? h('div.search', { style: 'flex:1;margin-bottom:8px' },
        h('input', { type: 'text', placeholder: 'filter attributes', value: T.attrQ,
                     oninput: e => { T.attrQ = e.target.value; paint(live(list), T.attrQ); } }))
    : null;
  return h('div.panel', h('h3', `Attributes reported by the device (${rows.length})`),
    h('div.body', search, list));
}

/* An assignment with a maintenance window installs only while it is open. The
 * pill says when it opens next; "scheduled" is the device having acknowledged
 * the skip -- SWUpdate says "Skipped Update." -- and waiting for it. */
function windowPill(a) {
  const w = a.maintenanceWindow;
  if (!w) return null;
  const next = w.nextStartAt ? when(w.nextStartAt) : '—';
  return h('span.pill', {
    title: `maintenance window: ${w.schedule} (cron: sec min hour day month weekday), open ${w.duration}, ` +
      `offset ${w.timezone}. Outside it the device downloads and waits` +
      (String(a.status).toLowerCase() === 'scheduled' ? '; it has acknowledged the skip and installs when the window opens.' : '.'),
  }, a.active ? `window · opens ${next}` : 'window');
}

function actionsPane(id, actions) {
  if (!actions.length) return h('div.empty', 'no deployment has ever been sent here');
  const all = h('button.btn.sm', { onclick: async e => {
    const b = e.currentTarget; b.classList.add('loading');
    try {
      const parts = [];
      for (const a of actions) parts.push(await actionLogText(id, a));
      download(`actions-${id}.log`, parts.join('\n' + '-'.repeat(72) + '\n\n'));
    } catch (er) { fail(er); } finally { b.classList.remove('loading'); }
  } }, icon('save', 13), 'download all logs');
  const expand = h('button.btn.sm', { onclick: () => {
    if (actions.some(a => !T.open.has(a.id))) actions.forEach(a => T.open.add(a.id));
    else T.open.clear();
    refreshDrawer();
  } }, 'expand / collapse all');

  return h('div.stack', h('div.wrap', all, expand), actions.map(a => {
    const st = String(a.status || '').toLowerCase();
    const open = T.open.has(a.id);
    const head = h('div.ahead', { onclick: () => { if (open) T.open.delete(a.id); else T.open.add(a.id); refreshDrawer(); } },
      h('span.chev', open ? '▾' : '▸'), h('span.mono', '#' + a.id), actionPill(a, id),
      a.active ? h('span.pill.live', 'active') : null,
      h('span.faint', a.type || ''), windowPill(a), h('span.faint.sum', T.summaries.get(a.id) || ''),
      h('span.faint.nowrap.when', when(a.lastModifiedAt || a.createdAt)));
    const acts = h('div.wrap',
      // Send the same thing again. The action does not carry its distribution
      // set in the body, but _links does, and the id is the tail of that URL.
      h('button.btn.sm', { onclick: async () => {
          try {
            const href = ((a._links || {}).distributionset || {}).href || '';
            const dsId = (href.match(/\/distributionsets\/(\d+)/) || [])[1];
            if (!dsId) throw new Error('this action no longer names a distribution set');
            await get('/distributionsets/' + dsId);   // gone? say so before opening a dialog
            assignDialog(id, Number(dsId));
          } catch (e) { fail(e); }
        } }, 'deploy this again'),
      h('button.btn.sm', { onclick: async () => {
          try { download(`action-${a.id}-${id}.log`, await actionLogText(id, a)); }
          catch (e) { fail(e); } } }, icon('save', 13), 'download log'),
      a.active ? h('button.btn.sm.danger', { onclick: async () => {
          try { await del(`/targets/${enc(id)}/actions/${a.id}`); toast('Cancelled', '#' + a.id, 'ok'); refreshDrawer(); }
          catch (e) { fail(e); } } }, 'cancel') : null,
      st === 'wait_for_confirmation'
        ? [h('button.btn.sm.primary', { onclick: () => confirmAction(id, a.id, 'confirmed') }, 'confirm'),
           h('button.btn.sm.danger', { onclick: () => confirmAction(id, a.id, 'denied') }, 'deny')]
        : null);
    const lines = T.logs.get(a.id);
    const log = h('div.log', lines === undefined ? 'loading…'
      : typeof lines === 'string' ? lines
      : lines.length ? lines.map(e => {
          const m = (e.messages || []).filter(Boolean);
          return h('div', h('span.t', when(e.reportedAt) + '  '), e.type, m.length ? '  ' + m.join(' | ') : '');
        })
      : 'no feedback recorded');
    return h('div.panel.acc' + (open ? '.open' : ''), { 'data-key': 'a' + a.id }, head,
      h('div.abody.stack', acts, log));
  }));
}

async function confirmAction(id, aid, decision) {
  try {
    // PUT, not POST: hawkBit answers 405 to a POST here. Its sibling
    // autoConfirm/activate is a POST, which is what made this easy to get
    // wrong -- test/compat.mjs --live catches it against the server.
    await put(`/targets/${enc(id)}/actions/${aid}/confirmation`, { confirmation: decision });
    toast('Action ' + decision, '#' + aid, 'ok'); refreshDrawer();
  } catch (e) { fail(e); }
}

function tagsPane(id, tags, allTags) {
  const have = new Set(tags.map(t => t.id));
  const free = allTags.filter(t => !have.has(t.id));
  const sel = h('select', free.length
    ? free.map(t => h('option', { value: t.id }, t.name))
    : h('option', { value: '' }, '— no other tags —'));
  return h('div.stack',
    h('div.panel', h('h3', 'Tags on this target'), h('div.body', h('div.wrap', tags.length
      ? tags.map(t => h('span.pill', { style: t.colour ? `color:${t.colour}` : '', 'data-key': 't' + t.id }, t.name,
          h('button.btn.sm', { style: 'margin-left:6px;padding:0 5px', onclick: async () => {
              try { await del(`/targettags/${t.id}/assigned/${enc(id)}`); toast('Untagged', t.name, 'ok'); refreshDrawer(); }
              catch (e) { fail(e); } } }, '×')))
      : h('span.faint', 'no tags')))),
    h('div.panel', h('h3', 'Add a tag'), h('div.body.flex',
      sel,
      h('button.btn', { onclick: async () => {
          const v = live(sel).value;
          if (!v) return;
          try { await post(`/targettags/${v}/assigned`, [id]); toast('Tagged', '', 'ok'); refreshDrawer(); }
          catch (e) { fail(e); } } }, 'assign'),
      h('button.btn', { onclick: () => newTagDialog(() => refreshDrawer()) }, 'new tag'))));
}

async function cancelLatest(id, force) {
  try {
    const a = await get(`/targets/${enc(id)}/actions?limit=1&sort=id:DESC`);
    const act = a.content[0];
    if (!act) return toast('Nothing to cancel', 'this target has no action', 'info');
    if (!act.active) return toast('Nothing to cancel', `action #${act.id} is already closed`, 'info');
    await del(`/targets/${enc(id)}/actions/${act.id}` + (force ? '?force=true' : ''));
    toast('Cancelled', `action #${act.id}${force ? ' (forced)' : ''}`, 'ok');
    refreshDrawer(); render();
  } catch (e) { fail(e); }
}

export {
  openTarget,
};
