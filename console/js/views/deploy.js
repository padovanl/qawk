// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { sampleAttributes } from '../batch.js';
import { S, distributionSets, enc, fiql, get, limited, post } from '../api.js';
import { ask, fail, modal, toast } from '../chrome.js';
import { $, h, icon } from '../dom.js';
import { fiqlEditor } from '../fiql.js';
import { dtInput, dtMs, dtQuick, toggle } from '../inputs.js';
import { watchAction } from '../notices.js';
import { render } from '../router.js';
import { when } from '../util.js';

/* ------- deploy ------------------------------------------------------ */
/* WHICH MODELS ARE OUT THERE. hawkBit has no "distinct values of an attribute"
 * call, so this is the union of two things: the target types someone defined on
 * the server, and the device_type the devices actually report. They usually
 * agree; when they do not, the one from the devices is the true one, because a
 * target type is a label a device cannot set. */
async function deviceTypes() {
  const out = new Set();
  const [types, attrs] = await Promise.all([
    get('/targettypes?limit=50').catch(() => ({ content: [] })),
    sampleAttributes(200).catch(() => []),
  ]);
  types.content.forEach(t => out.add(t.name));
  attrs.forEach(a => { if (a && a.device_type) out.add(a.device_type); });
  return [...out].sort();
}

/* ------------------------------------------------------------- preflight
 *
 * An application delta names ONE file as its term of comparison:
 *
 *   source = "/data/apps/hello/versions/1.1.0.img"
 *
 * On a device that is not on 1.1.0 that file does not exist, the handler has
 * nothing to open, and the update aborts -- it does not fall back to sending
 * everything. So a delta pointed at a fleet on mixed versions fails on every
 * device except the ones already at the base.
 *
 * Everything needed to say so in advance is already on the server: delta_source
 * in the module's metadata, and app_<name> among the attributes each device
 * reports. This puts the two together BEFORE the assignment instead of after,
 * and says which devices and why. */
async function deltaNeedsOf(dsId) {
  const sm = await get(`/distributionsets/${dsId}/assignedSM?limit=50`).catch(() => ({ content: [] }));
  const needs = [];
  for (const m of sm.content || []) {
    let md;
    try { md = await get(`/softwaremodules/${m.id}/metadata`); } catch (_) { continue; }
    const list = Array.isArray(md) ? md : (md.content || []);
    const src = (list.find(x => x.key === 'delta_source') || {}).value || '';
    const base = (list.find(x => x.key === 'delta_base') || {}).value || '';
    const mm = src.match(/^\/data\/apps\/([^/]+)\/versions\/(.+)\.img$/);
    if (mm) needs.push({ module: `${m.name} ${m.version}`, app: mm[1], version: mm[2], source: src });
    else if (base === 'the other slot') needs.push({ module: `${m.name} ${m.version}`, slot: true });
  }
  return needs;
}

async function preflight(dsId, ids) {
  const needs = await deltaNeedsOf(dsId);
  const app = needs.filter(n => n.app);
  if (!app.length) {
    return { ok: true, lines: needs.some(n => n.slot)
      ? ['a system delta: no fixed base, it installs from any version']
      : [] };
  }
  const sample = ids.slice(0, 200);
  const bad = [];
  await Promise.all(sample.map(async id => {
    const a = await limited(() => get(`/targets/${enc(id)}/attributes`)).catch(() => ({}));
    for (const n of app) {
      const have = (a || {})['app_' + n.app];
      if (have !== n.version) bad.push({ id, app: n.app, want: n.version, have: have || 'not installed' });
    }
  }));
  const lines = [];
  for (const n of app) {
    const mine = bad.filter(b => b.app === n.app);
    if (!mine.length) {
      lines.push(`every device is on ${n.app} ${n.version}: the delta applies`);
    } else {
      lines.push(`${mine.length} of ${sample.length} device(s) are NOT on ${n.app} ${n.version}, and the update will fail on them.`);
      lines.push(`Why: the package compares against ${n.source}. That file is only there on a device already running ${n.version}; without it SWUpdate aborts rather than sending the whole image.`);
      const shown = mine.slice(0, 6).map(b => `${b.id.slice(0, 16)} has ${b.have}`);
      lines.push(shown.join(' · ') + (mine.length > shown.length ? ` · and ${mine.length - shown.length} more` : ''));
      lines.push(`Send them the full package, or a delta built from what they are running.`);
    }
  }
  return { ok: !bad.length, lines, bad: bad.length };
}

async function assignDialog(targetId, presetDs, explicitIds) {
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
  const confirmReq = toggle(false, null, { label: 'require confirmation on the device' });
  // A maintenance window: the device may download at once, and installs only
  // while the window is open. hawkBit's three fields: when it opens (a Quartz
  // cron -- seconds first, and ? in one of the two day fields), how long it
  // stays open, and the offset the schedule is read in.
  const offset = (() => {
    const m = -new Date().getTimezoneOffset(), a = Math.abs(m);
    return (m >= 0 ? '+' : '-') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
  })();
  const mwOn = toggle(false, null, { label: 'install only inside a maintenance window' });
  const mwCron = h('input.mono', { type: 'text', value: '0 0 2 * * ?', placeholder: '0 0 2 * * ?' });
  const mwDur = h('input.mono', { type: 'text', value: '02:00:00', placeholder: 'HH:mm:ss', style: 'width:110px' });
  const mwTz = h('input.mono', { type: 'text', value: offset, placeholder: '+01:00', style: 'width:90px' });
  const mwPresets = h('div.wrap', [
    ['every night 02:00', '0 0 2 * * ?'], ['weeknights 22:30', '0 30 22 ? * MON-FRI'],
    ['Sunday 06:00', '0 0 6 ? * SUN'], ['every hour', '0 0 * * * ?'],
  ].map(([l, c]) => h('button.chip', { onclick: () => { mwCron.value = c; } }, l)));
  const mwBox = h('div.hidden', { style: 'border-left:3px solid var(--line,#ddd);padding-left:10px;margin:4px 0' },
    h('label.f', 'Opens at (cron: sec min hour day month weekday)', mwCron), mwPresets,
    h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' },
      h('label.f', 'Stays open', mwDur), h('label.f', 'Time zone offset', mwTz)),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'Outside the window the device is told to download and wait; the server refuses a window that never comes.'));
  mwOn.input.addEventListener('change', () => mwBox.classList.toggle('hidden', !mwOn.input.checked));
  // Picking who gets it is the part people do most, so it is a choice, not a
  // query language: one device, a model, everything, or FIQL when none of those
  // is enough.
  const mode = h('select',
    explicitIds ? h('option', { value: 'picked', selected: true },
      `the ${explicitIds.length} selected device(s)`) : null,
    h('option', { value: 'one', selected: !!targetId }, 'this device'),
    h('option', { value: 'type', selected: !targetId }, 'by device type'),
    h('option', { value: 'all' }, 'every registered device'),
    h('option', { value: 'fiql' }, 'by query (FIQL)'));
  const one = h('input', { type: 'text', value: targetId || '', placeholder: 'controllerId' });
  const typeSel = h('select', h('option', { value: '' }, 'loading…'));
  // The same editor as the filter and rollout dialogs: aiming a release at the
  // wrong machines is the expensive mistake here, so the field knows the
  // fields, completes the device attributes from the fleet, and says when the
  // query does not parse before anything is assigned.
  const fq = fiqlEditor({
    entity: 'targets', placeholder: 'attribute.device_type==neo-intel',
    onChange: () => { if (mode.value === 'fiql') recount(); },
  });
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
      case 'picked': return '';
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
      : mode.value === 'fiql' ? fq
      : mode.value === 'picked' ? h('span.faint', explicitIds.join(', ').slice(0, 200))
      : h('span.faint', 'no filter: everything registered'));
    if (mode.value === 'picked') { count.textContent = `${explicitIds.length} device(s)`; return; }
    recount();
  };
  mode.addEventListener('change', paint);
  [one, typeSel, fq].forEach(el => { el.addEventListener('change', recount); el.addEventListener('input', recount); });
  paint();

  const pre = h('div.checks.hidden');
  let lastPlan = null;
  const runPreflight = async () => {
    pre.classList.remove('hidden');
    pre.replaceChildren(h('div.faint', h('span.spin'), ' checking the devices…'));
    try {
      const ids = await resolveIds();
      const r = await preflight(sel.value, ids);
      lastPlan = { ids, ok: r.ok };
      pre.replaceChildren(...(r.lines.length
        ? r.lines.map(l => h('div.' + (r.ok ? 'good' : 'bad'), l))
        : [h('div.good', 'nothing to check: not a delta')]));
    } catch (e) { pre.replaceChildren(h('div.bad', e.message)); lastPlan = null; }
  };
  sel.addEventListener('change', () => { pre.classList.add('hidden'); lastPlan = null; });

  async function resolveIds() {
    if (mode.value === 'picked') return explicitIds;
    if (mode.value === 'one') {
      if (!one.value.trim()) throw new Error('name a device');
      return [one.value.trim()];
    }
    const q = queryOf();
    if (mode.value === 'type' && !q) throw new Error('pick a device type');
    if (mode.value === 'fiql' && !q) throw new Error('write a query, or pick another mode');
    const out = [];
    for (let off = 0; ; off += 200) {
      const r = await get(`/targets?limit=200&offset=${off}` + (q ? '&q=' + fiql(q) : ''));
      out.push(...r.content.map(t => t.controllerId));
      if (out.length >= r.total || !r.content.length) break;
    }
    if (!out.length) throw new Error('that matches no device');
    return out;
  }

  modal(targetId ? 'Deploy to ' + targetId : 'Deploy', [
    h('label.f', 'Distribution set', sel), h('label.f', 'Mode', type),
    h('label.f', 'Force time', at), dtQuick(at), atHint,
    confirmReq, mwOn, mwBox,
    h('label.f', 'Send it to', mode), row, count,
    h('div.flex', h('button.btn.sm', { onclick: runPreflight }, icon('check', 14), 'check the devices first'),
      h('span.faint', 'a delta only applies to the version it was built from')),
    pre,
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'A set is refused if it is incomplete, or if its type is not among those the target type ' +
      'accepts. forced is re-offered at every poll until the action closes.'),
  ], async () => {
    const ids = await resolveIds();
    if (ids.length > 1 && !await ask('Deploy to the whole selection',
        `${ids.length} devices will be told to install this set.`,
        { okLabel: 'Deploy' })) return false;
    // If the check has been run and found trouble, say so once more here: the
    // panel is easy to scroll past, an assignment is not easy to take back.
    if (lastPlan && !lastPlan.ok &&
        !await ask('The check says this will fail',
                   'This delta needs a base that some of these devices do not have.\n\nAssigning it anyway means those devices will fail the update.',
                   { okLabel: 'Assign anyway', danger: true })) {
      return false;
    }
    const body = ids.map(id => {
      const o = { id, type: type.value };
      const ft = dtMs(at);
      if (ft) o.forcetime = ft;
      if (confirmReq.input.checked) o.confirmationRequired = true;
      if (mwOn.input.checked) {
        o.maintenanceWindow = { schedule: mwCron.value.trim(), duration: mwDur.value.trim(), timezone: mwTz.value.trim() };
      }
      return o;
    });
    const r = await post(`/distributionsets/${sel.value}/assignedTargets`, body);
    // Not from assignedActions: that list carries ids without saying which
    // target each belongs to, and pairing them by position is a guess. Asking
    // each target for its newest action is one request per device just
    // assigned, and it is right.
    const label = sel.selectedOptions[0].text.split(' · ').slice(0, 2).join(' ');
    await Promise.all(ids.slice(0, 25).map(async id => {
      try {
        const a = await get(`/targets/${enc(id)}/actions?limit=1&sort=id:DESC`);
        const act = (a.content || [])[0];
        if (act && act.active) watchAction(act.id, id, label);
      } catch (_) {}
    }));
    toast('Assigned', `${r.assigned} new, ${r.alreadyAssigned} already had it` +
      (S.watched.size ? ' — you will be told how it ends' : ''), 'ok');
    render();
  }, 'Deploy');
}

export {
  assignDialog, deviceTypes,
};
