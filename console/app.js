/* QubicaAMF - hawkBit console.
 *
 * Vanilla, no build step, no CDN: this has to run on a build machine and on a
 * venue laptop with no internet. Everything talks to /rest/v1, which serve.py
 * proxies to hawkBit so the page and the API share one origin.
 *
 * Rendering goes through h() rather than innerHTML on purpose: target names and
 * attributes are written by the devices, and a controllerId is not a place to
 * trust markup.
 *
 * Feature parity with hawkbit-simple-ui is deliberate and was taken from its
 * own view classes, one by one: targets (register, tags, assigned/installed,
 * status filter, saved filters, action history, cancel, confirm), distribution
 * sets (create, add modules), software modules (create, artifacts), rollouts
 * (create with start type and action type, start/pause/resume/delete, groups),
 * configuration, about. What is here beyond it is marked EXTRA.
 */
'use strict';

/* ------------------------------------------------------------------ utils */
const $ = (s, r = document) => r.querySelector(s);

function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  if (attrs && (attrs.nodeType || typeof attrs !== 'object' || Array.isArray(attrs))) {
    kids.unshift(attrs);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className += ' ' + v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
      else e.setAttribute(k, v);
    }
  }
  for (const k of kids.flat(9)) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}

const pad = n => String(n).padStart(2, '0');
function when(ms) {
  if (!ms) return '—';
  const d = new Date(ms), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? hm
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}
function ago(ms) {
  if (!ms) return '—';
  let s = Math.round((Date.now() - ms) / 1000);
  const fut = s < 0; s = Math.abs(s);
  const t = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m`
          : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return fut ? `in ${t}` : `${t} ago`;
}
function bytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB']; let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + u[i];
}

/* --------------------------------------------------------------- the API */
const S = {
  auth: sessionStorage.getItem('hb-auth') || '',
  user: sessionStorage.getItem('hb-user') || '',
  view: 'dash', timer: null, busy: 0, counts: {}, sel: null,
  q: '', status: '',        // targets: free text / updateStatus chip
  dsCache: null,
};

function busy(d) {
  S.busy += d;
  $('#busy').replaceChildren(S.busy > 0 ? h('span.spin') : '');
}

async function api(path, opts = {}) {
  const o = Object.assign({ headers: {} }, opts);
  o.headers = Object.assign({ Authorization: 'Basic ' + S.auth }, o.headers);
  if (o.json !== undefined) {
    o.body = JSON.stringify(o.json);
    o.headers['Content-Type'] = 'application/json;charset=UTF-8';
    delete o.json;
  }
  busy(1);
  let r;
  try { r = await fetch('/rest/v1' + path, o); }
  catch (e) { busy(-1); throw new Error('the console cannot reach its own server: ' + e.message); }
  busy(-1);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!r.ok) {
    if (r.status === 401) { signOut(); throw new Error('not authorised'); }
    const err = new Error((data && (data.message || data.errorCode)) || ('HTTP ' + r.status));
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}
const get = p => api(p);
const post = (p, json) => api(p, { method: 'POST', json });
const put = (p, json) => api(p, { method: 'PUT', json });
const del = p => api(p, { method: 'DELETE' });
const fiql = s => encodeURIComponent(s);
const enc = encodeURIComponent;

async function upload(smId, file, onProgress) {
  // XHR, not fetch: a .swu is hundreds of megabytes and upload.onprogress is
  // the only way to show how far it has got. fetch has no equivalent.
  return new Promise((res, rej) => {
    const fd = new FormData(); fd.append('file', file);
    const x = new XMLHttpRequest();
    x.open('POST', `/rest/v1/softwaremodules/${smId}/artifacts`);
    x.setRequestHeader('Authorization', 'Basic ' + S.auth);
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return res(JSON.parse(x.responseText || '{}'));
      let m = 'HTTP ' + x.status;
      try { m = JSON.parse(x.responseText).message || m; } catch (_) {}
      rej(new Error(m));
    };
    x.onerror = () => rej(new Error('upload failed'));
    x.send(fd);
  });
}

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

/* ------------------------------------------------------------ status maps */
// The Action object in this hawkBit build has no detailStatus: 'status' itself
// carries running / retrieved / finished, and the verdict of a finished action
// lives in the type of its last status entry.
const ACTION_PILL = {
  finished: 'ok', error: 'err', canceled: 'mute', cancel_rejected: 'warn',
  running: 'info', retrieved: 'info', download: 'info', downloaded: 'info',
  warning: 'warn', scheduled: 'mute', canceling: 'warn', pending: 'info',
  wait_for_confirmation: 'warn',
};
const TARGET_PILL = {
  in_sync: 'ok', pending: 'info', error: 'err', registered: 'mute', unknown: 'mute',
};
const pill = (t, k) => h('span.pill.' + (k || 'mute'), String(t || '—').toLowerCase().replace(/_/g, ' '));

function tableOf(heads, rows) {
  return h('table.t',
    h('thead', h('tr', heads.map(x => h('th', x)))),
    h('tbody', rows.map(r =>
      h('tr', { onclick: r.onclick, class: r.sel ? 'sel' : null }, r.cells.map(c => h('td', c))))));
}
const card = (k, v, sub) => h('div.card', h('div.k', k), h('div.v', v ?? '—'), sub ? h('div.sub', sub) : null);

async function distributionSets(force) {
  if (!S.dsCache || force) S.dsCache = await get('/distributionsets?limit=200&sort=id:DESC');
  return S.dsCache;
}

/* ---------------------------------------------------------------- views */
const VIEWS = {};

/* ------- dashboard (EXTRA: the simple UI has no overview) ----------- */
VIEWS.dash = {
  title: 'Dashboard',
  async render(root) {
    const [tg, ds, sm, ro] = await Promise.all([
      get('/targets?limit=200&sort=lastControllerRequestAt:DESC'),
      get('/distributionsets?limit=1'), get('/softwaremodules?limit=1'),
      get('/rollouts?limit=1').catch(() => ({ total: 0 })),
    ]);
    S.counts = { targets: tg.total, ds: ds.total, sm: sm.total, ro: ro.total };
    drawNav();

    const over = tg.content.filter(t => t.pollStatus && t.pollStatus.overdue).length;
    const byStatus = {};
    tg.content.forEach(t => { byStatus[t.updateStatus] = (byStatus[t.updateStatus] || 0) + 1; });

    // hawkBit has no fleet-wide action feed, so this asks the most recently
    // seen targets for their latest one.
    const recent = (await Promise.all(tg.content.slice(0, 25).map(async t => {
      try {
        const a = await get(`/targets/${enc(t.controllerId)}/actions?limit=1&sort=id:DESC`);
        return a.content[0] ? Object.assign({ _t: t.controllerId }, a.content[0]) : null;
      } catch (_) { return null; }
    }))).filter(Boolean).sort((a, b) => b.id - a.id);

    root.replaceChildren(h('div.stack',
      h('div.cards',
        card('Targets', tg.total, over ? `${over} overdue` : 'all polling on time'),
        card('Distribution sets', ds.total), card('Software modules', sm.total),
        card('Rollouts', ro.total)),
      h('div.panel', h('h3', 'Fleet status'), h('div.body.wrap',
        Object.keys(byStatus).length
          ? Object.entries(byStatus).map(([k, v]) =>
              h('button.btn.sm', { onclick: () => { S.status = k; go('targets'); } },
                h('span.pill.' + (TARGET_PILL[k] || 'mute'), `${k.replace(/_/g, ' ')} · ${v}`)))
          : h('span.faint', 'no targets registered yet'))),
      h('div.panel', h('h3', 'Latest action per target'),
        recent.length
          ? tableOf(['Target', 'Action', 'Status', 'Type', 'When'], recent.map(a => ({
              onclick: () => openTarget(a._t),
              cells: [h('span.mono', a._t.slice(0, 16)), h('span.mono', '#' + a.id),
                      pill(a.status, ACTION_PILL[a.status]), h('span.dim', a.type || '—'),
                      h('span.faint.nowrap', when(a.lastModifiedAt || a.createdAt))],
            })))
          : h('div.empty', 'nothing has been deployed yet'))));
  },
};

/* ------- targets ---------------------------------------------------- */
const T_STATUS = ['', 'in_sync', 'pending', 'error', 'registered', 'unknown'];

VIEWS.targets = {
  title: 'Targets',
  bar: () => [
    h('div.search',
      h('input', {
        type: 'text', value: S.q,
        placeholder: 'name, id, or FIQL — attribute.device_type==neo-intel',
        oninput: e => { S.q = e.target.value; debounceRender(); },
      }), h('kbd', '/')),
    h('button.btn.sm', { onclick: registerTargetDialog }, 'register'),
    h('button.btn.sm', { onclick: () => saveFilterDialog(currentQuery()) }, 'save filter'),
    h('button.btn.sm', { onclick: () => assignDialog(null) }, 'deploy to…'),
  ],
  async render(root) {
    const chips = h('div.wrap', { style: 'margin-bottom:12px' },
      T_STATUS.map(s => h('button.btn.sm', {
        class: S.status === s ? 'primary' : '',
        onclick: () => { S.status = s; render(); },
      }, s === '' ? 'all' : s.replace(/_/g, ' '))));

    let path = '/targets?limit=200&sort=controllerId:ASC';
    const q = currentQuery();
    if (q) path += '&q=' + fiql(q);

    let data;
    try { data = await get(path); }
    catch (e) {
      return root.replaceChildren(chips, h('div.empty', h('b', 'That filter was refused'), e.message));
    }
    if (!data.content.length) {
      return root.replaceChildren(chips, h('div.empty',
        h('b', q ? 'Nothing matches' : 'No targets yet'),
        q ? 'Try a substring, or FIQL such as attribute.device_type==neo-intel'
          : 'A device registers itself on its first poll.'));
    }

    const rows = data.content.map(t => {
      // Assigned vs installed, as the simple UI shows them. hawkBit does not
      // put these in the list, so each cell fills itself in afterwards.
      const dsCell = h('span.faint', '…');
      loadAssignedInstalled(t.controllerId, dsCell);
      return {
        sel: S.sel === t.controllerId,
        onclick: () => openTarget(t.controllerId),
        cells: [
          h('span.mono', t.controllerId),
          h('span.dim', t.name !== t.controllerId ? t.name : '—'),
          pill(t.updateStatus, TARGET_PILL[t.updateStatus]),
          dsCell,
          h('span.faint.nowrap', ago(t.lastControllerRequestAt)),
          t.pollStatus && t.pollStatus.overdue ? h('span.pill.warn', 'overdue')
            : h('span.faint.nowrap', t.pollStatus ? ago(t.pollStatus.nextExpectedRequestAt) : '—'),
          h('span.mono.faint', t.ipAddress || '—'),
          h('button.btn.sm', { onclick: e => { e.stopPropagation(); assignDialog(t.controllerId); } }, 'deploy'),
        ],
      };
    });
    root.replaceChildren(chips, tableOf(
      ['Controller', 'Name', 'Status', 'Assigned / installed', 'Last poll', 'Next', 'IP', ''], rows));
  },
};

function currentQuery() {
  const parts = [];
  const q = S.q.trim();
  if (q) parts.push(/[=!<>]=|==/.test(q) ? q : `(name==*${q}*,controllerId==*${q}*)`);
  if (S.status) parts.push(`updatestatus==${S.status}`);
  return parts.join(';');
}

async function loadAssignedInstalled(id, cell) {
  try {
    const [a, i] = await Promise.all([
      get(`/targets/${enc(id)}/assignedDS`).catch(() => null),
      get(`/targets/${enc(id)}/installedDS`).catch(() => null),
    ]);
    const name = d => d ? `${d.name} ${d.version}` : '—';
    const same = a && i && a.id === i.id;
    cell.replaceChildren(same
      ? h('span.mono', name(i))
      : h('span', h('span.mono', name(a)), h('span.faint', ' → '), h('span.mono', name(i))));
    if (a && !same) cell.title = 'assigned but not yet installed';
  } catch (_) { cell.textContent = '—'; }
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

async function openTarget(id) {
  S.sel = id;
  const body = h('div', h('div.empty', h('span.spin')));
  drawer(id, body);
  try {
    const [t, attrs, acts, tags, autoc] = await Promise.all([
      get('/targets/' + enc(id)),
      get(`/targets/${enc(id)}/attributes`).catch(() => ({})),
      get(`/targets/${enc(id)}/actions?limit=30&sort=id:DESC`).catch(() => ({ content: [] })),
      get(`/targets/${enc(id)}/tags`).catch(() => []),
      get(`/targets/${enc(id)}/autoConfirm`).catch(() => null),
    ]);
    const tabs = h('div.tabs'); const pane = h('div');
    const mk = (label, fn) => {
      const b = h('button', { onclick: () => {
        [...tabs.children].forEach(x => x.classList.remove('on')); b.classList.add('on');
        pane.replaceChildren(fn());
      } }, label);
      tabs.append(b); return b;
    };
    mk('Overview', () => overviewPane(t, attrs, autoc, id));
    mk(`Actions (${acts.content.length})`, () => actionsPane(id, acts.content));
    mk(`Tags (${(tags || []).length})`, () => tagsPane(id, tags || []));
    tabs.firstChild.classList.add('on');
    pane.replaceChildren(overviewPane(t, attrs, autoc, id));
    body.replaceChildren(
      h('div.wrap', { style: 'margin-bottom:12px' },
        h('button.btn.primary.sm', { onclick: () => assignDialog(id) }, 'deploy'),
        h('button.btn.sm.danger', { onclick: () => cancelLatest(id, false) }, 'cancel action'),
        h('button.btn.sm.danger', { onclick: () => cancelLatest(id, true) }, 'force cancel'),
        h('button.btn.sm.danger', { onclick: async () => {
            if (!confirm(`Delete target ${id}?`)) return;
            try { await del('/targets/' + enc(id)); toast('Deleted', id, 'ok'); closeDrawer(); render(); }
            catch (e) { fail(e); }
          } }, 'delete')),
      tabs, pane);
  } catch (e) { body.replaceChildren(h('div.empty', e.message)); }
}

function overviewPane(t, attrs, autoc, id) {
  const dsBox = h('span.faint', '…');
  loadAssignedInstalled(t.controllerId, dsBox);
  const kv = [
    ['controller id', t.controllerId], ['name', t.name],
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
      pill(autoc.active ? 'on' : 'off', autoc.active ? 'ok' : 'mute'),
      h('button.btn.sm', { onclick: async () => {
          try {
            if (autoc.active) await del(`/targets/${enc(id)}/autoConfirm/deactivate`);
            else await post(`/targets/${enc(id)}/autoConfirm/activate`, {});
            toast('Auto-confirmation', autoc.active ? 'off' : 'on', 'ok'); openTarget(id);
          } catch (e) { fail(e); }
        } }, autoc.active ? 'turn off' : 'turn on'),
      h('span.faint', 'with it off, an update that needs confirmation waits for a human'))) : null,
    h('div.panel', h('h3', 'Attributes reported by the device'), h('div.body',
      rows.length ? h('dl.kv', rows.map(([k, v]) => [h('dt', k), h('dd', v)]))
                  : h('span.faint', 'none yet — the device sends these on its next poll'))));
}

function actionsPane(id, actions) {
  if (!actions.length) return h('div.empty', 'no deployment has ever been sent here');
  const wrap = h('div.stack');
  actions.forEach(a => {
    const head = h('div.flex', { style: 'justify-content:space-between' },
      h('div.flex', h('span.mono', '#' + a.id), pill(a.status, ACTION_PILL[a.status]),
        a.active ? h('span.pill.info', 'active') : null, h('span.faint', a.type || '')),
      h('span.faint.nowrap', when(a.lastModifiedAt || a.createdAt)));
    const cancelOne = async () => {
      try {
        await del(`/targets/${enc(id)}/actions/${a.id}`);
        toast('Cancelled', '#' + a.id, 'ok');
        openTarget(id);
      } catch (e) { fail(e); }
    };
    const acts = h('div.wrap',
      a.active ? h('button.btn.sm.danger', { onclick: cancelOne }, 'cancel') : null,
      String(a.status).toLowerCase() === 'wait_for_confirmation'
        ? [h('button.btn.sm.primary', { onclick: () => confirmAction(id, a.id, 'confirmed') }, 'confirm'),
           h('button.btn.sm.danger', { onclick: () => confirmAction(id, a.id, 'denied') }, 'deny')]
        : null);
    const log = h('div.log', 'loading…');
    wrap.append(h('div.panel', h('div.body.stack', head, acts, log)));
    get(`/targets/${enc(id)}/actions/${a.id}/status?limit=30&sort=id:DESC`)
      .then(s => {
        const lines = (s.content || []).map(e => {
          const m = (e.messages || []).filter(Boolean);
          return h('div', h('span.t', when(e.reportedAt) + '  '), e.type, m.length ? '  ' + m.join(' | ') : '');
        });
        log.replaceChildren(...lines);
        if (!lines.length) log.textContent = 'no feedback recorded';
      })
      .catch(e => { log.textContent = e.message; });
  });
  return wrap;
}

async function confirmAction(id, aid, decision) {
  try {
    await post(`/targets/${enc(id)}/actions/${aid}/confirmation`, { confirmation: decision });
    toast('Action ' + decision, '#' + aid, 'ok'); openTarget(id);
  } catch (e) { fail(e); }
}

function tagsPane(id, tags) {
  const wrap = h('div.stack');
  const list = h('div.wrap');
  const draw = () => list.replaceChildren(...(tags.length
    ? tags.map(t => h('span.pill', { style: t.colour ? `color:${t.colour}` : '' }, t.name,
        h('button.btn.sm', { style: 'margin-left:6px;padding:0 5px', onclick: async () => {
            try { await del(`/targettags/${t.id}/assigned/${enc(id)}`); toast('Untagged', t.name, 'ok'); openTarget(id); }
            catch (e) { fail(e); } } }, '×')))
    : [h('span.faint', 'no tags')]));
  draw();
  wrap.append(h('div.panel', h('h3', 'Tags on this target'), h('div.body', list)));

  const sel = h('select');
  get('/targettags?limit=100').then(r => {
    const have = new Set(tags.map(t => t.id));
    const free = r.content.filter(t => !have.has(t.id));
    sel.replaceChildren(...(free.length
      ? free.map(t => h('option', { value: t.id }, t.name))
      : [h('option', { value: '' }, '— no other tags —')]));
  }).catch(() => {});
  wrap.append(h('div.panel', h('h3', 'Add a tag'), h('div.body.flex',
    sel,
    h('button.btn', { onclick: async () => {
        if (!sel.value) return;
        try { await post(`/targettags/${sel.value}/assigned`, [id]); toast('Tagged', '', 'ok'); openTarget(id); }
        catch (e) { fail(e); } } }, 'assign'),
    h('button.btn', { onclick: () => newTagDialog(() => openTarget(id)) }, 'new tag'))));
  return wrap;
}

async function cancelLatest(id, force) {
  try {
    const a = await get(`/targets/${enc(id)}/actions?limit=1&sort=id:DESC`);
    const act = a.content[0];
    if (!act) return toast('Nothing to cancel', 'this target has no action', 'info');
    if (!act.active) return toast('Nothing to cancel', `action #${act.id} is already closed`, 'info');
    await del(`/targets/${enc(id)}/actions/${act.id}` + (force ? '?force=true' : ''));
    toast('Cancelled', `action #${act.id}${force ? ' (forced)' : ''}`, 'ok');
    openTarget(id); render();
  } catch (e) { fail(e); }
}

/* ------- deploy ------------------------------------------------------ */
async function assignDialog(targetId, presetDs) {
  let sets;
  try { sets = await distributionSets(true); } catch (e) { return fail(e); }
  if (!sets.content.length) return toast('Nothing to deploy', 'create a distribution set first', 'info');

  const sel = h('select', sets.content.map(d => h('option',
    { value: d.id, selected: presetDs === d.id },
    `${d.name} · ${d.version} · ${d.type}${d.complete ? '' : '  (incomplete!)'}`)));
  const type = h('select',
    h('option', { value: 'forced' }, 'forced — install at the next poll'),
    h('option', { value: 'soft' }, 'soft — the device may defer'),
    h('option', { value: 'timeforced' }, 'timeforced — soft, then forced'),
    h('option', { value: 'downloadonly' }, 'downloadonly — fetch, do not install'));
  const at = h('input', { type: 'text', placeholder: 'forced from (epoch ms) — timeforced only' });
  const confirmReq = h('input', { type: 'checkbox' });
  const who = h('input', { type: 'text', value: targetId || '',
    placeholder: 'controllerId, or a FIQL query for many' });
  const count = h('span.faint', '');
  who.addEventListener('change', async () => {
    const q = who.value.trim();
    if (!/[=!<>*]/.test(q)) return count.textContent = '';
    try { count.textContent = `${(await get('/targets?limit=1&q=' + fiql(q))).total} target(s)`; }
    catch (e) { count.textContent = 'invalid query'; }
  });

  modal(targetId ? 'Deploy to ' + targetId : 'Deploy', [
    h('label.f', 'Distribution set', sel), h('label.f', 'Mode', type),
    h('label.f', 'Force time', at),
    h('label.f', h('span.flex', confirmReq, 'require confirmation on the device'), h('span')),
    h('label.f', 'Targets', who), count,
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'A set whose type is not compatible with the target type is refused. forced is re-offered ' +
      'at every poll until the action closes.'),
  ], async () => {
    const q = who.value.trim();
    if (!q) throw new Error('name at least one target');
    let ids = [q];
    if (/[=!<>*]/.test(q)) {
      const r = await get('/targets?limit=500&q=' + fiql(q));
      ids = r.content.map(t => t.controllerId);
      if (!ids.length) throw new Error('that query matches no target');
    }
    const body = ids.map(id => {
      const o = { id, type: type.value };
      if (at.value.trim()) o.forcetime = Number(at.value.trim());
      if (confirmReq.checked) o.confirmationRequired = true;
      return o;
    });
    const r = await post(`/distributionsets/${sel.value}/assignedTargets`, body);
    toast('Assigned', `${r.assigned} new, ${r.alreadyAssigned} already had it`, 'ok');
    render();
  }, 'Deploy');
}

/* ------- distribution sets ------------------------------------------ */
VIEWS.ds = {
  title: 'Distribution sets',
  bar: () => [h('button.btn.sm', { onclick: newDsDialog }, 'new set')],
  async render(root) {
    const d = await distributionSets(true);
    if (!d.content.length) return root.replaceChildren(h('div.empty',
      h('b', 'No distribution sets'), 'A set is what you assign to devices.'));
    root.replaceChildren(tableOf(['Id', 'Name', 'Version', 'Type', 'Complete', 'Created', ''],
      d.content.map(x => ({
        onclick: () => openDs(x),
        cells: [h('span.mono', x.id), x.name, h('span.mono', x.version), h('span.dim', x.type),
                x.complete ? pill('yes', 'ok') : pill('no', 'err'),
                h('span.faint.nowrap', when(x.createdAt)),
                h('button.btn.sm', { onclick: e => { e.stopPropagation(); assignDialog(null, x.id); } }, 'deploy')],
      }))));
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
              cells: [h('span.mono', m.id), m.name, h('span.mono', m.version), h('span.dim', m.type),
                h('button.btn.sm.danger', { onclick: async e => {
                    e.stopPropagation();
                    try { await del(`/distributionsets/${x.id}/assignedSM/${m.id}`); draw(); }
                    catch (er) { fail(er); } } }, 'remove')],
            })))
          : h('span.faint', 'no modules — an incomplete set is never offered to any device'),
        h('button.btn', { onclick: () => addModulesDialog(x, draw) }, 'add software modules'))),
      h('div.wrap',
        h('button.btn.primary', { onclick: () => assignDialog(null, x.id) }, 'deploy this set'),
        h('button.btn.danger', { onclick: async () => {
            if (!confirm(`Delete ${x.name} ${x.version}?\n\nhawkBit only marks it deleted: the name and version stay reserved for good.`)) return;
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

/* ------- software modules ------------------------------------------- */
VIEWS.sm = {
  title: 'Software modules',
  bar: () => [h('button.btn.sm', { onclick: newSmDialog }, 'new module')],
  async render(root) {
    const d = await get('/softwaremodules?limit=200&sort=id:DESC');
    if (!d.content.length) return root.replaceChildren(h('div.empty',
      h('b', 'No modules'), 'A module holds the .swu, and for a delta its .zck as well.'));
    root.replaceChildren(tableOf(['Id', 'Name', 'Version', 'Type', 'Vendor', 'Created'],
      d.content.map(m => ({
        onclick: () => openSm(m),
        cells: [h('span.mono', m.id), m.name, h('span.mono', m.version), h('span.dim', m.type),
                h('span.faint', m.vendor || '—'), h('span.faint.nowrap', when(m.createdAt))],
      }))));
  },
};

async function openSm(m) {
  const body = h('div', h('div.empty', h('span.spin')));
  drawer(`${m.name} ${m.version}`, body);
  const draw = async () => {
    const arts = await get(`/softwaremodules/${m.id}/artifacts`).catch(() => []);
    const list = Array.isArray(arts) ? arts : (arts.content || []);
    const file = h('input', { type: 'file' });
    const prog = h('div.bars', { style: 'display:none' }, h('i.run', { style: 'width:0%' }));
    body.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Module'), h('div.body', h('dl.kv',
        [['id', m.id], ['name', m.name], ['version', m.version], ['type', m.type],
         ['vendor', m.vendor || '—'], ['description', m.description || '—'],
         ['encrypted', String(!!m.encrypted)]].map(([k, v]) => [h('dt', k), h('dd', v)])))),
      h('div.panel', h('h3', `Artifacts (${list.length})`), h('div.body',
        list.length
          ? tableOf(['File', 'Size', 'SHA-256', ''], list.map(a => ({
              cells: [h('span.mono', a.providedFilename), h('span.nowrap', bytes(a.size)),
                h('span.mono.faint', ((a.hashes && a.hashes.sha256) || '').slice(0, 16) + '…'),
                h('button.btn.sm.danger', { onclick: async () => {
                    if (!confirm('Delete ' + a.providedFilename + '?')) return;
                    try { await del(`/softwaremodules/${m.id}/artifacts/${a.id}`); draw(); }
                    catch (e) { fail(e); } } }, 'delete')],
            })))
          : h('span.faint', 'nothing uploaded yet'))),
      h('div.panel', h('h3', 'Add artifacts'), h('div.body.stack', file, prog,
        h('button.btn.primary', { onclick: async () => {
            if (!file.files[0]) return toast('Pick a file first', '', 'info');
            prog.style.display = ''; const bar = prog.firstChild;
            try {
              await upload(m.id, file.files[0], f => { bar.style.width = (f * 100).toFixed(1) + '%'; });
              toast('Uploaded', file.files[0].name, 'ok'); draw();
            } catch (e) { fail(e); prog.style.display = 'none'; }
          } }, 'upload'),
        h('p.faint', { style: 'margin:0;font-size:12px' },
          'A delta needs both files in this same module — the .swu and the .zck it names — and they ' +
          'must come from the same build. ota/hawkbit/upload-swu.sh checks that for you.'))),
      h('button.btn.danger', { onclick: async () => {
          if (!confirm(`Delete module ${m.name} ${m.version}?`)) return;
          try { await del('/softwaremodules/' + m.id); toast('Deleted', '', 'ok'); closeDrawer(); render(); }
          catch (e) { fail(e); } } }, 'delete module')));
  };
  draw();
}

async function newSmDialog() {
  const types = await get('/softwaremoduletypes?limit=50');
  const name = h('input', { type: 'text' });
  const ver = h('input', { type: 'text' });
  const desc = h('input', { type: 'text' });
  const vendor = h('input', { type: 'text', value: 'QubicaAMF' });
  const type = h('select', types.content.map(t => h('option', { value: t.key }, `${t.name} (${t.key})`)));
  const encrypt = h('input', { type: 'checkbox' });
  modal('New software module', [
    h('label.f', 'Name', name), h('label.f', 'Version', ver),
    h('label.f', 'Description', desc), h('label.f', 'Vendor', vendor), h('label.f', 'Type', type),
    h('label.f', h('span.flex', encrypt, 'enable artifact encryption'), h('span')),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'os for a system update, application for an app: the type is what tells hawkBit which it is, ' +
      'and an app given the os type would be treated as a slot change.'),
  ], async () => {
    if (!name.value.trim() || !ver.value.trim()) throw new Error('name and version are required');
    const b = { name: name.value.trim(), version: ver.value.trim(), type: type.value,
                vendor: vendor.value.trim() };
    if (desc.value.trim()) b.description = desc.value.trim();
    if (encrypt.checked) b.encrypted = true;
    await post('/softwaremodules', [b]);
    toast('Created', '', 'ok'); render();
  }, 'Create');
}

/* ------- rollouts ---------------------------------------------------- */
VIEWS.ro = {
  title: 'Rollouts',
  bar: () => [h('button.btn.sm', { onclick: newRolloutDialog }, 'new rollout')],
  async render(root) {
    const d = await get('/rollouts?limit=100&representation=full&sort=id:DESC').catch(() => ({ content: [] }));
    if (!d.content.length) return root.replaceChildren(h('div.empty',
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
            h('span.faint.nowrap', when(r.createdAt)),
            h('div.wrap',
              st === 'ready' ? actBtn('start', () => post(`/rollouts/${r.id}/start`)) : null,
              st === 'running' ? actBtn('pause', () => post(`/rollouts/${r.id}/pause`)) : null,
              st === 'paused' ? actBtn('resume', () => post(`/rollouts/${r.id}/resume`)) : null,
              actBtn('delete', async () => {
                if (!confirm(`Delete rollout ${r.name}? Running actions are cancelled.`)) throw new Error('cancelled by you');
                return del('/rollouts/' + r.id);
              })),
          ],
        };
      })));
  },
};
const actBtn = (label, fn) => h('button.btn.sm', {
  onclick: async e => {
    e.stopPropagation();
    try { await fn(); toast(label + ' ok', '', 'ok'); render(); }
    catch (er) { if (er.message !== 'cancelled by you') fail(er); }
  },
}, label);

async function openRollout(r) {
  const body = h('div', h('div.empty', h('span.spin')));
  drawer(r.name, body);
  const g = await get(`/rollouts/${r.id}/deploygroups?limit=50&representation=full`).catch(() => ({ content: [] }));
  const c = r.totalTargetsPerStatus || {};
  body.replaceChildren(h('div.stack',
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
        ? tableOf(['#', 'Name', 'Status', 'Targets', 'Finished', 'Error'], g.content.map(x => ({
            cells: [h('span.mono', x.id), x.name,
              pill(x.status, String(x.status).toLowerCase() === 'finished' ? 'ok'
                : String(x.status).toLowerCase() === 'error' ? 'err' : 'info'),
              h('span.mono', x.totalTargets ?? '—'),
              h('span.mono', (x.totalTargetsPerStatus || {}).finished ?? 0),
              h('span.mono', (x.totalTargetsPerStatus || {}).error ?? 0)],
          })))
        : h('span.faint', 'no groups')))));
}

async function newRolloutDialog() {
  const sets = await distributionSets(true);
  const name = h('input', { type: 'text', placeholder: 'neo-intel 25.7.3' });
  const desc = h('input', { type: 'text' });
  const ds = h('select', sets.content.filter(d => d.complete)
    .map(d => h('option', { value: d.id }, `${d.name} ${d.version} · ${d.type}`)));
  const q = h('input', { type: 'text', value: 'attribute.device_type==neo-intel' });
  const groups = h('input', { type: 'number', value: 3, min: 1, max: 50 });
  const errTh = h('input', { type: 'number', value: 10, min: 0, max: 100 });
  const okTh = h('input', { type: 'number', value: 100, min: 0, max: 100 });
  const actType = h('select',
    h('option', { value: 'forced' }, 'forced'), h('option', { value: 'soft' }, 'soft'),
    h('option', { value: 'timeforced' }, 'timeforced'),
    h('option', { value: 'downloadonly' }, 'download only'));
  const startType = h('select',
    h('option', { value: 'manual' }, 'manual — create it ready, press start'),
    h('option', { value: 'auto' }, 'auto — start immediately'),
    h('option', { value: 'scheduled' }, 'scheduled — start at a time'));
  const startAt = h('input', { type: 'text', placeholder: 'epoch ms (scheduled only)' });
  const preview = h('span.faint', '—');
  const check = async () => {
    try { preview.textContent = `${(await get('/targets?limit=1&q=' + fiql(q.value.trim()))).total} target(s) match`; }
    catch (e) { preview.textContent = 'invalid query: ' + e.message; }
  };
  q.addEventListener('change', check); check();

  modal('Create rollout', [
    h('label.f', 'Name', name), h('label.f', 'Description', desc),
    h('label.f', 'Distribution set', ds),
    h('label.f', 'Target filter (FIQL)', q), preview,
    h('label.f', 'Group count', groups),
    h('label.f', 'Action type', actType),
    h('label.f', 'Start type', startType), h('label.f', 'Scheduled at', startAt),
    h('label.f', 'Success threshold, %', okTh),
    h('label.f', 'Error threshold, % per group', errTh),
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
    if (startType.value === 'scheduled' && startAt.value.trim()) b.startAt = Number(startAt.value.trim());
    else delete b.startAt;
    const r = await post('/rollouts', b);
    if (startType.value === 'auto') await post(`/rollouts/${r.id}/start`).catch(() => {});
    toast('Created', startType.value === 'auto' ? 'started' : 'press start when ready', 'ok');
    render();
  }, 'Create');
}

/* ------- tags -------------------------------------------------------- */
VIEWS.tags = {
  title: 'Tags',
  bar: () => [h('button.btn.sm', { onclick: () => newTagDialog(render) }, 'new tag')],
  async render(root) {
    const [tt, dt] = await Promise.all([
      get('/targettags?limit=100&sort=id:DESC'),
      get('/distributionsettags?limit=100&sort=id:DESC').catch(() => ({ content: [] }))]);
    const tbl = (rows, kind) => rows.length
      ? tableOf(['Id', 'Name', 'Colour', 'Description', ''], rows.map(t => ({
          cells: [h('span.mono', t.id), t.name,
            h('span.flex', h('span', { style: `display:inline-block;width:12px;height:12px;border-radius:3px;background:${t.colour || '#555'}` }),
              h('span.mono.faint', t.colour || '—')),
            h('span.faint', t.description || '—'),
            h('button.btn.sm.danger', { onclick: async () => {
                if (!confirm('Delete tag ' + t.name + '?')) return;
                try { await del(`/${kind}/${t.id}`); render(); } catch (e) { fail(e); } } }, 'delete')],
        })))
      : h('div.empty', 'none');
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Target tags'), h('div.body', tbl(tt.content, 'targettags'))),
      h('div.panel', h('h3', 'Distribution set tags'), h('div.body', tbl(dt.content, 'distributionsettags')))));
  },
};

async function newTagDialog(after) {
  const name = h('input', { type: 'text' });
  const colour = h('input', { type: 'color', value: '#3ba9a1' });
  const desc = h('input', { type: 'text' });
  const kind = h('select', h('option', { value: 'targettags' }, 'target tag'),
    h('option', { value: 'distributionsettags' }, 'distribution set tag'));
  modal('New tag', [h('label.f', 'Kind', kind), h('label.f', 'Name', name),
    h('label.f', 'Colour', colour), h('label.f', 'Description', desc)], async () => {
    if (!name.value.trim()) throw new Error('a name is required');
    const b = { name: name.value.trim(), colour: colour.value };
    if (desc.value.trim()) b.description = desc.value.trim();
    await post('/' + kind.value, [b]);
    toast('Created', b.name, 'ok'); if (after) after();
  }, 'Create');
}

/* ------- target filters (saved filters + auto-assignment) ------------ */
VIEWS.filters = {
  title: 'Target filters',
  bar: () => [h('button.btn.sm', { onclick: () => saveFilterDialog('') }, 'new filter')],
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
                    if (!confirm('Delete filter ' + f.name + '?')) return;
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

/* ------- config ------------------------------------------------------ */
VIEWS.cfg = {
  title: 'Configuration',
  async render(root) {
    // Only the keys this server actually exposes: asking for one it does not
    // know costs a 400 on every load, and the row would be dropped anyway.
    const keys = ['pollingTime', 'pollingOverdueTime',
      'authentication.gatewaytoken.key', 'authentication.gatewaytoken.enabled',
      'authentication.targettoken.enabled', 'authentication.header.enabled',
      'rollout.approval.enabled', 'user.confirmation.flow.enabled'];
    const vals = {};
    await Promise.all(keys.map(async k => {
      try { vals[k] = await get('/system/configs/' + k); } catch (_) { vals[k] = null; }
    }));
    const hint = {
      pollingTime: 'HH:MM:SS — how often devices ask for work',
      pollingOverdueTime: 'HH:MM:SS — after this a device counts as overdue',
      'rollout.approval.enabled': 'a rollout must be approved before it starts',
      'user.confirmation.flow.enabled': 'updates wait for a human on the device',
    };
    const rows = keys.map(k => {
      const v = vals[k];
      if (!v) return null;
      const inp = typeof v.value === 'boolean'
        ? h('input', { type: 'checkbox', checked: v.value })
        : h('input', { type: 'text', value: v.value ?? '' });
      return h('div.flex', { style: 'gap:10px' },
        h('div', { style: 'flex:0 0 320px' }, h('div.mono', k),
          hint[k] ? h('div.faint', { style: 'font-size:11px' }, hint[k]) : null),
        inp,
        h('button.btn.sm', { onclick: async () => {
            try {
              await put('/system/configs/' + k, { value: inp.type === 'checkbox' ? inp.checked : inp.value });
              toast('Saved', k, 'ok');
            } catch (e) { fail(e); } } }, 'save'));
    }).filter(Boolean);

    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Tenant configuration'), h('div.body.stack', rows)),
      h('div.panel', h('h3', 'Careful'), h('div.body.faint',
        'This hawkBit keeps its database in memory: restarting the container wipes targets, ' +
        'modules, sets and these values. Deleting a module or a set does not free its name — the ' +
        'row stays, marked deleted, and name+version stay reserved for good.'))));
  },
};

/* ------- about ------------------------------------------------------- */
VIEWS.about = {
  title: 'About',
  async render(root) {
    const types = await Promise.all([
      get('/targettypes?limit=50').catch(() => ({ content: [] })),
      get('/distributionsettypes?limit=50').catch(() => ({ content: [] })),
      get('/softwaremoduletypes?limit=50').catch(() => ({ content: [] })),
    ]);
    const list = (title, r, f) => h('div.panel', h('h3', title), h('div.body',
      r.content.length ? tableOf(['Id', 'Name', 'Key', 'Description'], r.content.map(x => ({
        cells: [h('span.mono', x.id), x.name, h('span.mono', x.key || '—'),
                h('span.faint', x.description || '—')],
      }))) : h('span.faint', 'none')));
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'QubicaAMF hawkBit console'), h('div.body.stack',
        h('div', 'A replacement for hawkbit-simple-ui with the same features and a few more: ' +
          'a dashboard, assigned/installed at a glance, SWUpdate feedback inline in the action ' +
          'history, FIQL with a live match count, and bulk deployment by query.'),
        h('div.faint', 'Served by ota/hawkbit-ui/serve.py, which also proxies /rest to hawkBit so ' +
          'the page and the API share one origin. Credentials stay in this tab.'),
        h('div.faint', 'The original UI is still there on its own port; both talk to the same server.'))),
      list('Target types', types[0]), list('Distribution set types', types[1]),
      list('Software module types', types[2])));
  },
};

/* ---------------------------------------------------------------- shell */
const NAV = [
  { id: 'dash', label: 'Dashboard' },
  { sep: 'Fleet' },
  { id: 'targets', label: 'Targets', count: 'targets' },
  { id: 'filters', label: 'Filters' },
  { id: 'tags', label: 'Tags' },
  { id: 'ro', label: 'Rollouts', count: 'ro' },
  { sep: 'Software' },
  { id: 'ds', label: 'Distribution sets', count: 'ds' },
  { id: 'sm', label: 'Modules', count: 'sm' },
  { sep: 'Server' },
  { id: 'cfg', label: 'Configuration' },
  { id: 'about', label: 'About' },
];

function drawNav() {
  $('#nav').replaceChildren(...NAV.map(n => n.sep
    ? h('div.sep', n.sep)
    : h('button', { class: S.view === n.id ? 'on' : '', onclick: () => go(n.id) },
        n.label, n.count && S.counts[n.count] !== undefined ? h('span.ct', S.counts[n.count]) : null)));
}

function go(id) {
  S.view = id;
  if (id !== 'targets') { S.q = ''; S.status = ''; }
  location.hash = id;
  closeDrawer(); drawNav(); render();
}

let renderToken = 0;
async function render() {
  const v = VIEWS[S.view] || VIEWS.dash;
  $('#title').textContent = v.title;
  $('#bar-extra').replaceChildren(...(v.bar ? v.bar() : []));
  const mine = ++renderToken;
  const root = $('#view');
  if (!root.childNodes.length) root.replaceChildren(h('div.empty', h('span.spin')));
  try {
    const tmp = h('div');
    await v.render(tmp);
    if (mine !== renderToken) return;
    root.replaceChildren(...tmp.childNodes);
  } catch (e) {
    if (mine !== renderToken) return;
    root.replaceChildren(h('div.empty', h('b', 'Could not load'), e.message));
  }
}

let debounceT = null;
function debounceRender() { clearTimeout(debounceT); debounceT = setTimeout(render, 220); }

function tick() {
  clearInterval(S.timer);
  // Auto-refresh is off while a dialog or the drawer is open: re-rendering
  // under someone's cursor loses what they were typing.
  if ($('#auto').checked) S.timer = setInterval(() => {
    if (document.hidden || $('#modal').open || $('#drawer').classList.contains('open')) return;
    render();
  }, 5000);
}

/* ---------------------------------------------------------------- auth */
function signOut() {
  sessionStorage.removeItem('hb-auth'); sessionStorage.removeItem('hb-user');
  S.auth = ''; clearInterval(S.timer);
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
}

async function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#conn').textContent = S.user + ' @ hawkBit';
  S.view = (location.hash || '#dash').slice(1);
  if (!VIEWS[S.view]) S.view = 'dash';
  drawNav(); await render(); tick();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  S.auth = btoa($('#u').value + ':' + $('#p').value); S.user = $('#u').value;
  try {
    await get('/targets?limit=1');
    sessionStorage.setItem('hb-auth', S.auth); sessionStorage.setItem('hb-user', S.user);
    $('#login-err').classList.add('hidden');
    start();
  } catch (err) {
    S.auth = '';
    $('#login-err').textContent = err.message;
    $('#login-err').classList.remove('hidden');
  }
});

$('#refresh').onclick = render;
$('#auto').onchange = tick;
$('#logout').onclick = signOut;
$('#drawer-close').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (VIEWS[id] && id !== S.view) { S.view = id; drawNav(); render(); }
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === '/') { e.preventDefault(); const i = $('#bar-extra input'); if (i) i.focus(); }
  else if (e.key === 'r') render();
  else if (e.key === 'Escape') closeDrawer();
  else if (e.key === 'g') { const i = NAV.filter(n => n.id); S.navHint = true; }
});

if (S.auth) start();
