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
// Counts in the sidebar: exact while it is worth reading, compact once it is
// not. A fleet of 1,482 is '1.5k' -- the digit that matters is the first one.
function compact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
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

/* Dates are picked, never typed. hawkBit speaks epoch milliseconds, which is
 * the right thing on the wire and the wrong thing to ask a person for. */
// A number field with our own stepper: the native one cannot be themed, and a
// group count or a percentage is something you nudge rather than type.
function numInput(value, min, max, step = 1) {
  const inp = h('input', { type: 'number', value, min, max });
  const bump = d => {
    const v = Math.max(min, Math.min(max, (Number(inp.value) || 0) + d * step));
    inp.value = v; inp.dispatchEvent(new Event('change'));
  };
  const box = h('div.stepper',
    h('button', { type: 'button', onclick: e => { e.preventDefault(); bump(-1); } }, '\u2212'),
    inp,
    h('button', { type: 'button', onclick: e => { e.preventDefault(); bump(1); } }, '+'));
  box.input = inp;
  return box;
}

function dtInput(ms) {
  const v = ms ? new Date(ms - new Date().getTimezoneOffset() * 60000)
                  .toISOString().slice(0, 16) : '';
  return h('input', { type: 'datetime-local', value: v });
}

const dtSet = (el, d) => {
  el.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  el.dispatchEvent(new Event('change'));
};

// The maintenance window is nearly always tonight or tomorrow at three, so
// those are buttons rather than eight keystrokes in four spinners.
function dtQuick(el) {
  const at = (days, hh) => {
    const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, 0, 0, 0); return d;
  };
  const plus = mins => new Date(Date.now() + mins * 60000);
  const mk = (label, fn) => h('button.chip', {
    onclick: e => { e.preventDefault(); if (!el.disabled) dtSet(el, fn()); },
  }, label);
  return h('div.when-quick',
    mk('in 1h', () => plus(60)),
    mk('in 4h', () => plus(240)),
    mk('tonight 03:00', () => at(new Date().getHours() < 3 ? 0 : 1, 3)),
    mk('tomorrow 03:00', () => at(1, 3)),
    mk('next Monday 03:00', () => {
      const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
      d.setHours(3, 0, 0, 0); return d;
    }),
    h('button.chip', { onclick: e => { e.preventDefault(); el.value = ''; el.dispatchEvent(new Event('change')); } }, 'clear'));
}
const dtMs = el => {
  const v = (el.value || '').trim();
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

function download(name, text) {
  // The page is served locally, so a blob link just works: no sandbox, no
  // server round trip, and the log lands where the browser puts downloads.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

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


/* ---------------------------------------------------------------- icons */
/* Inline SVG, stroked in currentColor: no icon font, no sprite sheet, nothing
 * to fetch. They are there to make a row scannable, not decorative -- one
 * stroke weight, one size, no fills. */
const ICONS = {
  dash:    'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  target:  'M3 5h18v11H3zM8 20h8M12 16v4',
  filter:  'M3 5h18l-7 8v6l-4 2v-8z',
  tag:     'M3 12V4h8l9 9-8 8-9-9zM7.5 7.5h.01',
  rollout: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  package: 'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8',
  module:  'M9 3h6v3h3v6h3v6h-6v-3H9v-3H6V9H3V3z',
  cfg:     'M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4',
  info:    'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01',
  chip:    'M7 7h10v10H7zM4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3',
  box:     'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8',
  plus:    'M12 5v14M5 12h14',
  columns: 'M3 4h18v16H3zM9 4v16M15 4v16',
  deploy:  'M12 19V5M12 5l-6 6M12 5l6 6',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  exit:    'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h9',
  save:    'M5 4h11l3 3v13H5zM8 4v5h7M8 14h8v6H8z',
  left:    'M14 6l-6 6 6 6',
  right:   'M10 6l6 6-6 6',
};
function icon(name, size = 15) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('ico');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.info);
  svg.append(path);
  return svg;
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
// 'live' spins: an action on its way is the one thing you sit and watch, and a
// coloured box that never moves is indistinguishable from a stuck one.
const ACTION_PILL = {
  finished: 'ok', error: 'err', canceled: 'mute', cancel_rejected: 'warn',
  running: 'live', retrieved: 'live', download: 'live', downloaded: 'live',
  warning: 'warn', scheduled: 'mute', canceling: 'live', pending: 'live',
  wait_for_confirmation: 'warn pulse',
};
// 'pending' means the server has given this device something it has not
// finished yet: amber, because it is a state you want to notice, and spinning,
// because it is supposed to end.
const TARGET_PILL = {
  in_sync: 'ok', pending: 'live amber', error: 'err', registered: 'mute', unknown: 'mute',
};
/* Types are a small closed set that you scan down a column, so they are read
 * as colour first and text second: system and application are different kinds
 * of update, and a combined set is a third thing rather than a bit of both. */
/* ONE VOCABULARY ACROSS THE TWO TABLES.
 *
 * hawkBit calls the module type 'application' and the distribution set type
 * 'app'. They are the same thing to anyone using this, and two words for it in
 * two adjacent tables reads as two different concepts. The badge says 'app' in
 * both places; the underlying key is untouched, so filters and the API still
 * work in hawkBit's own words. */
const TYPE_PILL  = { os: 'ty-os', app: 'ty-app', application: 'ty-app', os_app: 'ty-both' };
const TYPE_LABEL = { os: 'os', app: 'app', application: 'app', os_app: 'os+app' };
const TYPE_ICON = { os: 'chip', app: 'box', application: 'box', os_app: 'package' };
const typePill = t => h('span.pill.' + (TYPE_PILL[t] || 'mute'),
  TYPE_ICON[t] ? icon(TYPE_ICON[t], 12) : null, TYPE_LABEL[t] || String(t || '—'));

const pill = (t, k) => h('span.pill.' + (k || 'mute'), String(t || '—').toLowerCase().replace(/_/g, ' '));

function tableOf(heads, rows, filters) {
  return h('table.t',
    h('thead', h('tr', heads.map(x => h('th', x))), filters || null),
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
    // 200 is a window, not the fleet: the counts come from 'total', and the
    // per-target lookup below is capped so a thousand devices do not become a
    // thousand requests every five seconds.
    const [tg, ds, sm, ro] = await Promise.all([
      get('/targets?limit=60&sort=lastControllerRequestAt:DESC'),
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
    const SAMPLE = 20;
    const recent = (await Promise.all(tg.content.slice(0, SAMPLE).map(async t => {
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
      h('div.panel', h('h3', tg.total > SAMPLE
          ? `Latest action · ${SAMPLE} most recently seen of ${tg.total}`
          : 'Latest action per target'),
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
  controllerId: { label: 'Controller', cell: t => h('span.mono', t.controllerId) },
  name:         { label: 'Name', cell: t => h('span.dim', t.name !== t.controllerId ? t.name : '—') },
  status:       { label: 'Status', cell: t => pill(t.updateStatus, TARGET_PILL[t.updateStatus]) },
  ds:           { label: 'Assigned / installed', cell: t => {
                    const c = h('span.faint', '…'); loadAssignedInstalled(t.controllerId, c); return c; } },
  lastPoll:     { label: 'Last poll', cell: t => h('span.faint.nowrap', ago(t.lastControllerRequestAt)) },
  nextPoll:     { label: 'Next', cell: t => t.pollStatus && t.pollStatus.overdue
                    ? h('span.pill.warn.pulse', 'overdue')
                    : h('span.faint.nowrap', t.pollStatus ? ago(t.pollStatus.nextExpectedRequestAt) : '—') },
  ip:           { label: 'IP', cell: t => h('span.mono.faint', t.ipAddress || '—') },
  targetType:   { label: 'Type', cell: t => h('span.dim', (t.targetType && (t.targetType.name || t.targetType)) || '—') },
  created:      { label: 'Registered', cell: t => h('span.faint.nowrap', when(t.createdAt)) },
  security:     { label: 'Token', cell: t => h('span.mono.faint', t.securityToken || '—') },
};
const T_COLS_DEFAULT = ['controllerId', 'name', 'status', 'ds', 'lastPoll', 'nextPoll', 'ip'];

const D_COLS = {
  id:      { label: 'Id', cell: x => h('span.mono', x.id) },
  name:    { label: 'Name', cell: x => x.name, f: 'name' },
  version: { label: 'Version', cell: x => h('span.mono', x.version), f: 'version' },
  type:    { label: 'Type', cell: x => typePill(x.type), f: 'type' },
  // Not shown by default: on a healthy server it is 'yes' on every row, and a
  // column that never varies is width spent on nothing. Add it when you are
  // hunting for the set that will not assign -- then it has to say both things.
  complete:{ label: 'Complete', cell: x => x.complete ? h('span.pill.ok', 'complete') : h('span.pill.err', 'incomplete') },
  desc:    { label: 'Description', cell: x => h('span.faint', x.description || '—'), f: 'description' },
  created: { label: 'Created', cell: x => h('span.faint.nowrap', { title: when(x.createdAt) }, ago(x.createdAt)) },
};
const M_COLS = {
  id:      { label: 'Id', cell: m => h('span.mono', m.id) },
  name:    { label: 'Name', cell: m => m.name, f: 'name' },
  version: { label: 'Version', cell: m => h('span.mono', m.version), f: 'version' },
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
  created: { label: 'Created', cell: m => h('span.faint.nowrap', { title: when(m.createdAt) }, ago(m.createdAt)) },
};
const COLSETS = {
  targets: { defs: T_COLS, def: T_COLS_DEFAULT, attrs: true },
  ds: { defs: D_COLS, def: ['id', 'name', 'version', 'type', 'created'], attrs: false },
  sm: { defs: M_COLS, def: ['id', 'name', 'version', 'type', 'base', 'created'], attrs: false },
};

// Filter fields follow the chosen columns, so a column you added is a column
// you can search.
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

// Attributes are one request per target, so they are fetched once per render
// and shared by every attribute column.
/* AT TWO HUNDRED ROWS the per-row lookups are hundreds of requests, and a
 * browser will happily open all of them at once: the page stalls, and hawkBit
 * sees a burst that looks like an attack. Six at a time keeps the table filling
 * visibly from the top without ever queueing the whole page. */
let inFlight = 0;
const waiting = [];
function limited(fn) {
  return new Promise((res, rej) => {
    const run = () => {
      inFlight++;
      fn().then(res, rej).finally(() => {
        inFlight--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (inFlight < 6) run(); else waiting.push(run);
  });
}

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
    h('button.btn.sm', { onclick: registerTargetDialog }, icon('plus', 14), 'register'),
    h('button.btn.sm', { onclick: () => saveFilterDialog(currentQuery()) }, icon('save', 14), 'save filter'),
    h('button.btn.sm.primary', { onclick: () => assignDialog(null) }, icon('deploy', 14), 'deploy to…'),
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
    try { data = await get(pagedPath('/targets', st, q, 'controllerId:ASC')); }
    catch (e) {
      return root.replaceChildren(chips, h('div.empty', h('b', 'That filter was refused'), e.message));
    }
    if (!data.content.length) {
      return root.replaceChildren(chips,
        tableOf(cols().map(c => colLabel(c)).concat(['']), [], filterRow(fields, st, render)),
        h('div.empty', h('b', q ? 'Nothing matches' : 'No targets yet'),
          q ? 'Try a substring, or FIQL such as attribute.device_type==neo-intel'
            : 'A device registers itself on its first poll.'));
    }

    attrCache.clear();
    waiting.length = 0;      // rows from the previous page are no longer wanted
    const chosen = cols();
    const rows = data.content.map(t => ({
      sel: S.sel === t.controllerId,
      onclick: () => openTarget(t.controllerId),
      cells: chosen.map(id => {
        if (id.startsWith('attr:')) {
          const key = id.slice(5), c = h('span.mono.faint', '…');
          attrsOf(t.controllerId).then(a => { c.textContent = (a && a[key]) || '—'; });
          return c;
        }
        return T_COLS[id] ? T_COLS[id].cell(t) : '—';
      }).concat([
        h('button.btn.sm.ghost', { onclick: e => { e.stopPropagation(); assignDialog(t.controllerId); } }, 'deploy'),
      ]),
    }));
    root.replaceChildren(chips,
      tableOf(chosen.map(c => colLabel(c)).concat(['']), rows, filterRow(fields, st, render)),
      pager(st, data.total, render));
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
    const [a, i] = await limited(() => Promise.all([
      get(`/targets/${enc(id)}/assignedDS`).catch(() => null),
      get(`/targets/${enc(id)}/installedDS`).catch(() => null),
    ]));
    const name = d => d ? `${d.name} ${d.version}` : '—';
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

  const all = h('button.btn.sm', { onclick: async e => {
    const b = e.currentTarget; b.classList.add('loading');
    try {
      const parts = [];
      for (const a of actions) parts.push(await actionLogText(id, a));
      download(`actions-${id}.log`, parts.join('\n' + '-'.repeat(72) + '\n\n'));
    } catch (er) { fail(er); } finally { b.classList.remove('loading'); }
  } }, 'download all logs');
  const expand = h('button.btn.sm', { onclick: () => {
    const shut = [...wrap.querySelectorAll('.acc:not(.open) .ahead')];
    if (shut.length) shut.forEach(x => x.click());
    else [...wrap.querySelectorAll('.acc.open .ahead')].forEach(x => x.click());
  } }, 'expand / collapse all');
  wrap.append(h('div.wrap', all, expand));

  actions.forEach((a, idx) => {
    const st = String(a.status || '').toLowerCase();
    // Open the newest one and anything still moving; the rest stay shut. Thirty
    // expanded logs is not a history, it is a wall, and it also meant thirty
    // requests every time a target was opened.
    const openByDefault = idx === 0 || a.active;

    const chev = h('span.chev', '▸');
    const summary = h('span.faint.sum', '');
    const head = h('div.ahead',
      chev, h('span.mono', '#' + a.id), pill(st, ACTION_PILL[st]),
      a.active ? h('span.pill.live', 'active') : null,
      h('span.faint', a.type || ''), summary,
      h('span.faint.nowrap.when', when(a.lastModifiedAt || a.createdAt)));

    const cancelOne = async () => {
      try {
        await del(`/targets/${enc(id)}/actions/${a.id}`);
        toast('Cancelled', '#' + a.id, 'ok'); openTarget(id);
      } catch (e) { fail(e); }
    };
    const acts = h('div.wrap',
      h('button.btn.sm', { onclick: async () => {
          try { download(`action-${a.id}-${id}.log`, await actionLogText(id, a)); }
          catch (e) { fail(e); } } }, 'download log'),
      a.active ? h('button.btn.sm.danger', { onclick: cancelOne }, 'cancel') : null,
      st === 'wait_for_confirmation'
        ? [h('button.btn.sm.primary', { onclick: () => confirmAction(id, a.id, 'confirmed') }, 'confirm'),
           h('button.btn.sm.danger', { onclick: () => confirmAction(id, a.id, 'denied') }, 'deny')]
        : null);

    const log = h('div.log', 'loading…');
    const guts = h('div.abody.stack', acts, log);
    const panel = h('div.panel.acc', head, guts);
    wrap.append(panel);

    let loaded = false;
    const load = async () => {
      if (loaded) return; loaded = true;
      try {
        const r = await get(`/targets/${enc(id)}/actions/${a.id}/status?limit=30&sort=id:DESC`);
        const lines = (r.content || []).map(e => {
          const m = (e.messages || []).filter(Boolean);
          return h('div', h('span.t', when(e.reportedAt) + '  '), e.type, m.length ? '  ' + m.join(' | ') : '');
        });
        log.replaceChildren(...lines);
        if (!lines.length) log.textContent = 'no feedback recorded';
      } catch (e) { log.textContent = e.message; }
    };

    // The collapsed header still says how it ended, so the history reads at a
    // glance without opening anything.
    get(`/targets/${enc(id)}/actions/${a.id}/status?limit=1&sort=id:DESC`)
      .then(r => {
        const e = (r.content || [])[0];
        if (!e) return;
        const m = (e.messages || []).filter(Boolean).join(' | ');
        summary.textContent = (m || e.type || '').slice(0, 90);
      }).catch(() => {});

    const toggle = () => {
      const open = panel.classList.toggle('open');
      chev.textContent = open ? '▾' : '▸';
      if (open) load();
    };
    head.addEventListener('click', toggle);
    if (openByDefault) toggle();
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
/* WHICH MODELS ARE OUT THERE. hawkBit has no "distinct values of an attribute"
 * call, so this is the union of two things: the target types someone defined on
 * the server, and the device_type the devices actually report. They usually
 * agree; when they do not, the one from the devices is the true one, because a
 * target type is a label a device cannot set. */
async function deviceTypes() {
  const out = new Set();
  const [types, sample] = await Promise.all([
    get('/targettypes?limit=50').catch(() => ({ content: [] })),
    get('/targets?limit=50').catch(() => ({ content: [] })),
  ]);
  types.content.forEach(t => out.add(t.name));
  await Promise.all(sample.content.map(async t => {
    const a = await limited(() => get(`/targets/${enc(t.controllerId)}/attributes`)).catch(() => ({}));
    if (a && a.device_type) out.add(a.device_type);
  }));
  return [...out].sort();
}

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
  const at = dtInput(null);
  at.disabled = true;
  const atHint = h('span.faint', 'only for timeforced: when a soft assignment turns forced');
  type.addEventListener('change', () => {
    at.disabled = type.value !== 'timeforced';
    if (at.disabled) at.value = '';
  });
  const confirmReq = h('input', { type: 'checkbox' });
  // Picking who gets it is the part people do most, so it is a choice, not a
  // query language: one device, a model, everything, or FIQL when none of those
  // is enough.
  const mode = h('select',
    h('option', { value: 'one', selected: !!targetId }, 'this device'),
    h('option', { value: 'type', selected: !targetId }, 'by device type'),
    h('option', { value: 'all' }, 'every registered device'),
    h('option', { value: 'fiql' }, 'by query (FIQL)'));
  const one = h('input', { type: 'text', value: targetId || '', placeholder: 'controllerId' });
  const typeSel = h('select', h('option', { value: '' }, 'loading…'));
  const fq = h('input', { type: 'text', placeholder: 'attribute.slot==B' });
  const count = h('span.faint', '');
  const row = h('div');

  deviceTypes().then(list => {
    typeSel.replaceChildren(...(list.length
      ? list.map(x => h('option', { value: x }, x))
      : [h('option', { value: '' }, 'no device has reported one yet')]));
    recount();
  });

  const queryOf = () => {
    switch (mode.value) {
      case 'one':  return one.value.trim() ? `controllerid==${one.value.trim()}` : '';
      case 'type': return typeSel.value ? `attribute.device_type==${typeSel.value}` : '';
      case 'all':  return '';
      default:     return fq.value.trim();
    }
  };
  async function recount() {
    const q = queryOf();
    if (mode.value === 'one') { count.textContent = one.value.trim() ? '1 device' : 'name a device'; return; }
    try {
      const r = await get('/targets?limit=1' + (q ? '&q=' + fiql(q) : ''));
      count.textContent = `${r.total} device(s) match`;
    } catch (e) { count.textContent = 'invalid query: ' + e.message; }
  }
  const paint = () => {
    row.replaceChildren(mode.value === 'one' ? one : mode.value === 'type' ? typeSel
      : mode.value === 'fiql' ? fq : h('span.faint', 'no filter: everything registered'));
    recount();
  };
  mode.addEventListener('change', paint);
  [one, typeSel, fq].forEach(el => { el.addEventListener('change', recount); el.addEventListener('input', recount); });
  paint();

  modal(targetId ? 'Deploy to ' + targetId : 'Deploy', [
    h('label.f', 'Distribution set', sel), h('label.f', 'Mode', type),
    h('label.f', 'Force time', at), dtQuick(at), atHint,
    h('label.f', h('span.flex', confirmReq, 'require confirmation on the device'), h('span')),
    h('label.f', 'Send it to', mode), row, count,
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'A set is refused if it is incomplete, or if its type is not among those the target type ' +
      'accepts. forced is re-offered at every poll until the action closes.'),
  ], async () => {
    let ids;
    if (mode.value === 'one') {
      if (!one.value.trim()) throw new Error('name a device');
      ids = [one.value.trim()];
    } else {
      const q = queryOf();
      if (mode.value === 'type' && !q) throw new Error('pick a device type');
      if (mode.value === 'fiql' && !q) throw new Error('write a query, or pick another mode');
      // Paged: a fleet does not fit in one response, and assigning to "all"
      // has to mean all of them.
      ids = [];
      for (let off = 0; ; off += 200) {
        const r = await get(`/targets?limit=200&offset=${off}` + (q ? '&q=' + fiql(q) : ''));
        ids.push(...r.content.map(t => t.controllerId));
        if (ids.length >= r.total || !r.content.length) break;
      }
      if (!ids.length) throw new Error('that matches no device');
      if (ids.length > 1 && !confirm(`Deploy to ${ids.length} devices?`)) return false;
    }
    const body = ids.map(id => {
      const o = { id, type: type.value };
      const ft = dtMs(at);
      if (ft) o.forcetime = ft;
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
  bar: () => [
    h('button.btn.sm', { onclick: () => columnsDialog('ds') }, icon('columns', 14), 'columns'),
    h('button.btn.sm.primary', { onclick: newDsDialog }, icon('plus', 14), 'new set'),
  ],
  async render(root) {
    const st = pg('ds');
    const fields = fieldsFor('ds');
    const chosen = cols('ds');
    const d = await get(pagedPath('/distributionsets', st, fiqlOf(fields.filter(f => f.key), st), 'id:DESC'));
    if (!d.content.length && !Object.values(st.f).some(Boolean)) return root.replaceChildren(h('div.empty',
      h('b', 'No distribution sets'), 'A set is what you assign to devices.'));
    root.replaceChildren(
      tableOf(chosen.map(c => colLabel(c, 'ds')).concat(['']),
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
  bar: () => [
    h('button.btn.sm', { onclick: () => columnsDialog('sm') }, icon('columns', 14), 'columns'),
    h('button.btn.sm.primary', { onclick: newSmDialog }, icon('plus', 14), 'new module'),
  ],
  async render(root) {
    const st = pg('sm');
    metaCache.clear(); waiting.length = 0;
    const fields = fieldsFor('sm');
    const chosen = cols('sm');
    const d = await get(pagedPath('/softwaremodules', st, fiqlOf(fields.filter(f => f.key), st), 'id:DESC'));
    if (!d.content.length && !Object.values(st.f).some(Boolean)) return root.replaceChildren(h('div.empty',
      h('b', 'No modules'), 'A module holds the .swu, and for a delta its .zck as well.'));
    root.replaceChildren(
      tableOf(chosen.map(c => colLabel(c, 'sm')).concat(['']),
        d.content.map(m => ({
          onclick: () => openSm(m),
          cells: chosen.map(c => M_COLS[c].cell(m)).concat([h('span')]),
        })), filterRow(fields, st, render)),
      pager(st, d.total, render));
  },
};

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

async function openSm(m) {
  const body = h('div', h('div.empty', h('span.spin')));
  drawer(`${m.name} ${m.version}`, body);
  const draw = async () => {
    const arts = await get(`/softwaremodules/${m.id}/artifacts`).catch(() => []);
    const list = Array.isArray(arts) ? arts : (arts.content || []);
    const file = h('input', { type: 'file' });
    const bar = h('i.run', { style: 'width:0%' });
    const pct = h('b', '0%');
    const prog = h('div.upl', { style: 'display:none' }, h('div.bars', bar), pct);
    body.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Module'), h('div.body', h('dl.kv',
        [['id', m.id], ['name', m.name], ['version', m.version], ['type', m.type],
         ['vendor', m.vendor || '—'], ['description', m.description || '—'],
         ['encrypted', String(!!m.encrypted)]].map(([k, v]) => [h('dt', k), h('dd', v)]),
        h('dt', 'delta base'), h('dd', baseCell(m.id))))),
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
            prog.style.display = '';
            try {
              await upload(m.id, file.files[0], f => {
                bar.style.width = (f * 100).toFixed(1) + '%';
                pct.textContent = (f * 100).toFixed(0) + '%';
              });
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
                if (!confirm(`Delete rollout ${r.name}? Running actions are cancelled.`)) throw new Error('cancelled by you');
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
}, label);

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
      h('button.btn', { onclick: () => openRollout(r) }, '← back to the rollout'),
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

async function newRolloutDialog() {
  const sets = await distributionSets(true);
  const name = h('input', { type: 'text', placeholder: 'neo-intel 25.7.3' });
  const desc = h('input', { type: 'text' });
  const ds = h('select', sets.content.filter(d => d.complete)
    .map(d => h('option', { value: d.id }, `${d.name} ${d.version} · ${d.type}`)));
  const q = h('input', { type: 'text', value: 'attribute.device_type==neo-intel' });
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
  const preview = h('span.faint', '—');
  const check = async () => {
    try { preview.textContent = `${(await get('/targets?limit=1&q=' + fiql(q.value.trim()))).total} target(s) match`; }
    catch (e) { preview.textContent = 'invalid query: ' + e.message; }
  };
  q.addEventListener('change', check); q.addEventListener('input', check); check();

  // Shortcut for the query almost every fleet rollout uses.
  const rollTypes = h('div.wrap');
  deviceTypes().then(list => rollTypes.replaceChildren(...list.map(x =>
    h('button.chip', { onclick: () => { q.value = `attribute.device_type==${x}`; check(); } },
      h('span.plus', '+'), x))));

  modal('Create rollout', [
    h('label.f', 'Name', name), h('label.f', 'Description', desc),
    h('label.f', 'Distribution set', ds),
    h('label.f', 'Target filter (FIQL)', q), preview, rollTypes,
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

/* ------- tags -------------------------------------------------------- */
VIEWS.tags = {
  title: 'Tags',
  bar: () => [h('button.btn.sm.primary', { onclick: () => newTagDialog(render) }, icon('plus', 14), 'new tag')],
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

    const refresh = h('select', REFRESH_CHOICES.map(([v, l]) =>
      h('option', { value: v, selected: v === refreshMs() }, l)));
    refresh.onchange = e => { setRefreshMs(Number(e.target.value)); toast('Saved', 'refresh ' + e.target.selectedOptions[0].text, 'ok'); };

    const swatches = h('div.themes', THEMES.map(([v, l]) => {
      const chip = h('button.theme' + (v === theme() ? '.on' : ''),
        { 'data-t': v === 'auto' ? '' : v, title: l, onclick: () => { applyTheme(v); render(); } },
        h('span.sw', h('i.a'), h('i.b'), h('i.c')), h('span.tn', l));
      return chip;
    }));

    const idle = h('select', IDLE_CHOICES.map(([v, l]) =>
      h('option', { value: v, selected: v === idleMin() }, l)));
    idle.onchange = e => {
      setIdleMin(Number(e.target.value));
      toast('Saved', 'sign out after ' + e.target.selectedOptions[0].text, 'ok');
    };

    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Theme'), h('div.body', swatches)),
      h('div.panel', h('h3', 'Sign out when idle'), h('div.body.flex',
        h('div', { style: 'flex:0 0 320px' }, h('div.mono', 'idle timeout'),
          h('div.faint', { style: 'font-size:11px' },
            'the tab forgets the credentials after this long with no mouse or ' +
            'keyboard. Auto-refresh does not count as activity.')),
        idle)),
      h('div.panel', h('h3', 'This console'), h('div.body.flex',
        h('div', { style: 'flex:0 0 320px' }, h('div.mono', 'auto-refresh'),
          h('div.faint', { style: 'font-size:11px' },
            'how often the tables reload — suspended anyway while a dialog is open ' +
            'or the pointer is over the table')),
        refresh)),
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

/* ------------------------------------------------------------ idle logout */
/* The credentials live in this tab and nowhere else, so closing it is logging
 * out -- but a console left open on a bench is a console anyone walking past
 * can deploy from. After a period with no mouse, key or touch, the tab forgets
 * them by itself.
 *
 * It counts real interaction, not requests: auto-refresh keeps talking to the
 * server on its own, and letting that count as presence would mean the timer
 * never fires. */
const IDLE_CHOICES = [
  [0, 'never'], [5, '5 min'], [15, '15 min'], [30, '30 min'],
  [60, '1 hour'], [240, '4 hours'],
];
function idleMin() {
  const v = Number(localStorage.getItem('hb-idle'));
  return IDLE_CHOICES.some(([n]) => n === v) ? v : 30;
}
function setIdleMin(v) {
  try { localStorage.setItem('hb-idle', String(v)); } catch (_) {}
  S.lastSeen = Date.now(); S.idleWarned = false;
}
S.lastSeen = Date.now();
S.idleWarned = false;

function idleTick() {
  const mins = idleMin();
  if (!mins || !S.auth) return;
  const left = mins * 60000 - (Date.now() - S.lastSeen);
  if (left <= 0) {
    signOut();
    toast('Signed out', `no activity for ${mins} minutes`, 'info', 15000);
    return;
  }
  // One warning, a minute out, so a long read is not thrown away silently.
  if (left <= 60000 && !S.idleWarned) {
    S.idleWarned = true;
    toast('About to sign out', 'a minute with no activity left — move the mouse to stay', 'err', 55000);
  }
}
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { S.lastSeen = Date.now(); S.idleWarned = false; },
    { passive: true, capture: true }));
setInterval(idleTick, 10000);

/* ---------------------------------------------------------------- themes */
/* Every theme is a palette in style.css, nothing more: the rest of the sheet is
 * derived from those variables with color-mix, so adding one is adding twelve
 * colours and never a special case. 'auto' sets no attribute and lets the
 * prefers-color-scheme media query decide. */
const THEMES = [
  ['auto', 'auto (system)'], ['dark', 'dark'], ['light', 'light'],
  ['midnight', 'midnight'], ['ocean', 'ocean'], ['forest', 'forest'],
  ['nord', 'nord'], ['dracula', 'dracula'], ['gruvbox', 'gruvbox'],
  ['solarized-dark', 'solarized dark'], ['solarized-light', 'solarized light'],
  ['amber', 'amber'], ['mono', 'mono'], ['paper', 'paper'],
];
function theme() {
  const v = localStorage.getItem('hb-theme');
  return THEMES.some(([k]) => k === v) ? v : 'auto';
}
function applyTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  try { localStorage.setItem('hb-theme', v); } catch (_) {}
  const sel = $('#theme');
  if (sel) sel.value = v;
}
applyTheme(theme());

/* ---------------------------------------------------------------- shell */
const NAV = [
  { id: 'dash', label: 'Dashboard', ico: 'dash' },
  { sep: 'Fleet' },
  { id: 'targets', label: 'Targets', count: 'targets', ico: 'target' },
  { id: 'filters', label: 'Filters', ico: 'filter' },
  { id: 'tags', label: 'Tags', ico: 'tag' },
  { id: 'ro', label: 'Rollouts', count: 'ro', ico: 'rollout' },
  { sep: 'Software' },
  { id: 'ds', label: 'Distribution sets', count: 'ds', ico: 'package' },
  { id: 'sm', label: 'Modules', count: 'sm', ico: 'module' },
  { sep: 'Server' },
  { id: 'cfg', label: 'Configuration', ico: 'cfg' },
  { id: 'about', label: 'About', ico: 'info' },
];

function setCollapsed(v) {
  document.getElementById('app').classList.toggle('collapsed', v);
  try { localStorage.setItem('hb-nav', v ? '1' : '0'); } catch (_) {}
  const b = $('#navtoggle');
  if (b) { b.replaceChildren(icon(v ? 'right' : 'left', 14)); b.title = v ? 'expand' : 'collapse'; }
}

function drawNav() {
  $('#nav').replaceChildren(...NAV.map(n => n.sep
    ? h('div.sep', h('span.lbl', n.sep))
    : h('button', { class: S.view === n.id ? 'on' : '', title: n.label, onclick: () => go(n.id) },
        icon(n.ico), h('span.lbl', n.label),
        n.count && S.counts[n.count] !== undefined
          ? h('span.ct', { title: S.counts[n.count] + ' total' }, compact(S.counts[n.count]))
          : null)));
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
  const first = !root.childNodes.length;
  if (first) root.replaceChildren(skeleton());
  // A page that answers at once should show nothing at all; one that does not
  // has to say so, or it reads as broken.
  const slow = setTimeout(() => {
    if (mine !== renderToken) return;
    $('#progress').classList.add('on');
    if (!first) root.classList.add('stale');
  }, 150);
  try {
    const tmp = h('div');
    await v.render(tmp);
    if (mine !== renderToken) return;
    root.replaceChildren(...tmp.childNodes);
  } catch (e) {
    if (mine !== renderToken) return;
    root.replaceChildren(h('div.empty', h('b', 'Could not load'), e.message));
  } finally {
    clearTimeout(slow);
    if (mine === renderToken) {
      $('#progress').classList.remove('on');
      root.classList.remove('stale');
    }
  }
}

const skeleton = (n = 7) => h('div.skel', Array.from({ length: n }, () => h('i')));

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

function filterRow(fields, state, onChange) {
  return h('tr.filters', fields.map(f => h('th',
    f.key ? h('input', {
      type: 'text', value: state.f[f.key] || '', placeholder: f.ph || '',
      oninput: e => { state.f[f.key] = e.target.value; state.page = 0; onChange(); },
    }) : null)));
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
  if (sort) p += '&sort=' + sort;
  if (q) p += '&q=' + fiql(q);
  return p;
}

let debounceT = null;
function debounceRender() { clearTimeout(debounceT); debounceT = setTimeout(render, 220); }

/* AUTO-REFRESH.
 *
 * A table that rebuilds itself under the cursor is worse than a stale one: the
 * row you were about to click moves, a half-typed filter is thrown away, and a
 * hover menu closes on its own. So this is both configurable and, whatever the
 * interval, suspended whenever someone is plainly in the middle of something:
 * a dialog or the drawer open, the tab in the background, or the pointer or the
 * keyboard focus inside the table itself.
 *
 * Off is a first-class choice, and it is remembered. */
const REFRESH_CHOICES = [
  [0, 'off'], [5000, '5s'], [10000, '10s'], [30000, '30s'], [60000, '1m'], [300000, '5m'],
];
function refreshMs() {
  const v = Number(localStorage.getItem('hb-refresh'));
  return Number.isFinite(v) && REFRESH_CHOICES.some(([n]) => n === v) ? v : 10000;
}
function setRefreshMs(v) {
  try { localStorage.setItem('hb-refresh', String(v)); } catch (_) {}
  tick();
}

let pointerInside = false;
function busyInteracting() {
  if (document.hidden) return true;
  if ($('#modal').open || $('#drawer').classList.contains('open')) return true;
  if (pointerInside) return true;
  const a = document.activeElement;
  return !!(a && a.matches('input, select, textarea') && $('#view').contains(a));
}

function tick() {
  clearInterval(S.timer);
  const ms = refreshMs();
  const sel = $('#auto');
  if (sel && !sel.options.length) {
    sel.replaceChildren(...REFRESH_CHOICES.map(([v, l]) =>
      h('option', { value: v, selected: v === ms }, l)));
    sel.onchange = e => setRefreshMs(Number(e.target.value));
  } else if (sel) {
    sel.value = String(ms);
  }
  $('#paused').classList.add('hidden');
  if (!ms) return;
  S.timer = setInterval(() => {
    if (busyInteracting()) { $('#paused').classList.remove('hidden'); return; }
    $('#paused').classList.add('hidden');
    render();
  }, ms);
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

$('#refresh').replaceChildren(icon('refresh', 14), 'refresh');
$('#logout').replaceChildren(icon('exit', 14), h('span.lbl', 'exit'));
$('#theme').replaceChildren(...THEMES.map(([v, l]) =>
  h('option', { value: v, selected: v === theme() }, l)));
$('#theme').onchange = e => applyTheme(e.target.value);
$('#navtoggle').onclick = () => setCollapsed(!$('#app').classList.contains('collapsed'));
setCollapsed(localStorage.getItem('hb-nav') === '1');
$('#refresh').onclick = render;
$('#view').addEventListener('pointerenter', () => { pointerInside = true; });
$('#view').addEventListener('pointerleave', () => { pointerInside = false; });
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
