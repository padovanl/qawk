import { S, del, enc, get, post, put } from '../api.js';
import { actionPill, pill } from '../badges.js';
import { ask, closeDrawer, drawer, fail, toast } from '../chrome.js';
import { loadAssignedInstalled } from '../columns.js';
import { $, h, icon } from '../dom.js';
import { toggle } from '../inputs.js';
import { render } from '../router.js';
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
      toggle(autoc.active, async v => {
        // Both directions are POST. DELETE on deactivate answers 405 and leaves
        // it switched on, which reads as a control that does nothing.
        await post(`/targets/${enc(id)}/autoConfirm/${v ? 'activate' : 'deactivate'}`, {});
        toast('Auto-confirmation', v ? 'on' : 'off', 'ok');
        openTarget(id);
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
  const paint = q => {
    const f = q ? rows.filter(([k, v]) =>
      (k + ' ' + v).toLowerCase().includes(q.toLowerCase())) : rows;
    list.replaceChildren(...(f.length
      ? f.flatMap(([k, v]) => [h('dt', { title: k }, k), h('dd', { title: v }, v)])
      : [h('dt', ''), h('dd', h('span.faint', 'nothing matches'))]));
  };
  paint('');
  const search = rows.length > 8
    ? h('div.search', { style: 'flex:1;margin-bottom:8px' },
        h('input', { type: 'text', placeholder: 'filter attributes',
                     oninput: e => paint(e.target.value) }))
    : null;
  return h('div.panel', h('h3', `Attributes reported by the device (${rows.length})`),
    h('div.body', search, list));
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
  } }, icon('save', 13), 'download all logs');
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
      chev, h('span.mono', '#' + a.id), actionPill(a),
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
    // PUT, not POST: hawkBit answers 405 to a POST here. Its sibling
    // autoConfirm/activate is a POST, which is what made this easy to get
    // wrong -- test/compat.mjs --live catches it against the server.
    await put(`/targets/${enc(id)}/actions/${aid}/confirmation`, { confirmation: decision });
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

export {
  openTarget,
};
