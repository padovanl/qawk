import { S, distributionSets, qawk } from '../api.js';
import { bars } from '../bars.js';
import { fleetBadge } from '../chips.js';
import { ask, closeDrawer, drawer, fail, modal, toast } from '../chrome.js';
import { h, icon } from '../dom.js';
import { check as fiqlCheck, fiqlEditor } from '../fiql.js';
import { colourPicker } from '../inputs.js';
import { VIEWS, go, render } from '../router.js';
import { serverInfo } from '../server.js';
import { tableOf } from '../table.js';
import { ago, when } from '../util.js';

/* ------- fleets and the release pipeline (a Qawk addition) ----------- *
 *
 * dev -> beta -> prod: a release reaches a fleet with an upstream only by
 * promotion from it, through the fleet's gate and, when the fleet asks, a
 * second person's approval; inside the fleet it goes out in waves and halts
 * by itself when too many devices fail. A fleet with no upstream (dev, expo)
 * is given releases directly. A temporary fleet -- expo, the machines taken
 * to a trade show -- remembers where its devices came from and sends them
 * back. A frozen fleet gets nothing.
 *
 * The device knows none of this: it is still plain hawkBit DDI. */
const can = p => (serverInfo()?.me?.permissions || []).includes(p);
const me = () => serverInfo()?.me?.username || '';

VIEWS.fleets = {
  title: 'Fleets',
  live: 5000,
  bar: () => [h('button.btn.sm.primary', { onclick: () => fleetDialog(null, VIEWS.fleets.last || []) },
    icon('plus', 14), 'new fleet')],
  async render(root) {
    const [d, pend] = await Promise.all([qawk.get('/fleets'), qawk.get('/releases?status=waiting_for_approval')]);
    const fleets = d.content;
    VIEWS.fleets.last = fleets;
    root.replaceChildren(h('div.stack',
      pend.content.length ? approvals(pend.content) : null,
      fleets.length
        ? h('div.panel', h('h3', 'Pipeline'), h('div.body', lanes(fleets)))
        : h('div.empty', h('b', 'No fleets'),
            'Create dev, then beta and prod with their upstream, and expo as a temporary fleet.'),
      h('div.panel', h('h3', 'How releases move'), h('div.body.faint',
        'A fleet with an upstream takes releases only by promotion from it, through its gate: so many devices ' +
        'of the upstream run the release, such a share of them, for so long. It may also need a second person ' +
        'to approve. Inside a fleet a release goes out in waves and halts by itself when failures pass the ' +
        'threshold. A frozen fleet gets nothing. Devices lent to a temporary fleet go back where they came from.'))));
  },
};

/* The chains, each on its own line, then their branches -- a fleet taking
 * releases from one that already has a follower (dev -> qa beside dev ->
 * beta) -- each followed to its end and saying where it hangs from. */
function lanes(fleets) {
  const byId = new Map(fleets.map(f => [f.id, f]));
  const lines = [], seen = new Set();
  const follow = start => {
    const line = [];
    for (let f = start; f && !seen.has(f.id);
      f = fleets.find(c => c.upstreamId === f.id && !seen.has(c.id))) { line.push(f); seen.add(f.id); }
    return line;
  };
  for (const root of fleets.filter(f => !f.upstreamId || !byId.has(f.upstreamId))) lines.push(follow(root));
  lines.sort((a, b) => (b.length - a.length) || (a[0].temporary - b[0].temporary));
  for (let more = true; more;) {
    more = false;
    for (const f of fleets) if (!seen.has(f.id) && seen.has(f.upstreamId)) { lines.push(follow(f)); more = true; }
  }
  return h('div.stack', lines.map(line => {
    const from = byId.get(line[0].upstreamId);
    return h('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;align-items:stretch' },
      from ? h('div.faint', { style: 'align-self:center;display:flex;gap:6px;align-items:center;font-size:12px' },
        '↳ from', fleetBadge(from.name, from.colour),
        h('span', { style: 'font-size:22px;opacity:.5' }, '→')) : null,
      line.flatMap((f, i) => [i ? h('div', { style: 'align-self:center;font-size:22px;opacity:.5' }, '→') : null,
        card(f, fleets)]));
  }));
}

function statusPill(r) {
  if (!r) return h('span.faint', 'no release');
  const cls = { active: '', completed: '.ok', halted: '.err' }[r.status] ?? '';
  return h('span.pill' + cls, r.status);
}

function card(f, fleets) {
  const p = f.progress, r = f.release;
  const pct = p && p.members ? Math.round(100 * p.onRelease / p.members) : 0;
  const frozen = f.freeze && f.freeze.active;
  return h('div', { style: 'border:1px solid var(--line,#ddd);border-radius:10px;padding:10px 12px;min-width:250px;flex:1;max-width:380px' +
      (frozen ? ';background:repeating-linear-gradient(135deg,transparent 0 10px,rgba(90,150,255,.07) 10px 20px)' : '') },
    h('div.flex', { style: 'justify-content:space-between;gap:6px' },
      h('span.flex', fleetBadge(f.name, f.colour),
        f.temporary ? h('span.pill', 'temporary') : null),
      h('span.faint', `${f.members} device${f.members === 1 ? '' : 's'}`)),
    f.description ? h('div.faint', f.description) : null,
    f.inSystems ? h('div.faint', { style: 'font-size:12px', title: 'a 6hd, its st05 and hyper: system deployments update them, not this release' },
      `${f.inSystems.toLocaleString('en-US')} in systems — updated by system deployments`) : null,
    h('div', { style: 'margin:8px 0 4px' },
      f.distributionSet ? h('span.pill.ok', f.distributionSet) : h('span.faint', 'no release'), ' ', statusPill(r),
      r && r.forced ? h('span.pill.err', { title: r.reason }, 'forced') : null),
    p ? h('div', h('div', { style: 'margin:6px 0 4px' }, bars([[p.onRelease, 'ok', `${p.onRelease} on it (${pct}%)`],
          [p.active, 'run', `${p.active} updating`], [p.failed, 'err', `${p.failed} failed`]], p.members, { key: 'fleet' + f.id })),
        h('div.faint', { style: 'font-size:12px' },
          `${p.onRelease}/${p.members} on it`, p.active ? ` · ${p.active} updating` : '',
          p.failed ? ` · ${p.failed} failed` : '', f.wavePercent && r ? ` · wave ${r.waves} of ${f.wavePercent}%` : ''))
      : null,
    r && r.status === 'halted' ? h('div', { style: 'color:var(--err,#e5484d);font-size:12px;margin-top:4px' },
      r.reason.split('\n').pop()) : null,
    frozen ? h('div', { style: 'font-size:12px;margin-top:4px' }, '❄ frozen: ', h('b', f.freeze.reason),
      f.freeze.until ? h('span.faint', ' until ' + when(f.freeze.until)) : null) : null,
    f.freeze && !f.freeze.active ? h('div.faint', { style: 'font-size:12px' },
      `❄ freeze planned: ${f.freeze.reason}`, f.freeze.from ? ' from ' + when(f.freeze.from) : '') : null,
    f.pending ? h('div', { style: 'font-size:12px;margin-top:4px' },
      h('span.pill', 'awaiting approval'), ` ${f.pending.distributionSet} from ${f.pending.from || 'direct'}`) : null,
    h('div.faint', { style: 'font-size:11px;margin-top:6px' },
      f.upstream ? `from ${f.upstream} when ≥${f.gate.minDevices} devices and ≥${f.gate.minSuccess}% run it` +
        (f.gate.soakMinutes ? `, ${f.gate.soakMinutes} min soak` : '') + (f.gate.approvalRequired ? ', approved' : '')
        + (f.autoPromote ? ' · promotes itself when the gate opens' : ' · promoted by hand')
        : 'takes releases directly', f.rule ? ` · rule ${f.rule}` : ''),
    h('div.wrap', { style: 'margin-top:8px' },
      f.upstream
        ? h('button.btn.sm.primary', { onclick: () => promoteDialog(f, fleets) }, 'promote from ' + f.upstream)
        : h('button.btn.sm.primary', { onclick: () => releaseDialog(f) }, 'release'),
      r && r.status === 'halted' ? h('button.btn.sm', { onclick: () => resume(f) }, 'resume') : null,
      h('button.btn.sm', { title: 'its devices, in Targets', onclick: () => openInTargets(f) }, 'devices'),
      h('button.btn.sm', { title: 'add devices by id; send expo devices home', onclick: () => membersDrawer(f) }, 'manage'),
      h('button.btn.sm', { onclick: () => historyDrawer(f) }, 'history'),
      f.freeze ? h('button.btn.sm', { onclick: () => thaw(f) }, 'thaw') : h('button.btn.sm', { onclick: () => freezeDialog(f) }, 'freeze'),
      f.temporary ? h('button.btn.sm', { onclick: () => sendHome(f) }, 'send devices home') : null,
      h('button.btn.sm', { onclick: () => fleetDialog(f, fleets) }, 'edit'),
      f.temporary ? null : h('button.btn.sm', { title: 'a new fleet that takes its releases from this one',
        onclick: () => fleetDialog(null, fleets, { upstreamId: f.id }) }, icon('plus', 13), 'next'),
      h('button.btn.sm.danger', { onclick: async () => {
          if (!await ask('Delete fleet', `${f.name}\nIts ${f.members} devices stay, in no fleet.`, { danger: true })) return;
          try { await qawk.del('/fleets/' + f.id); render(); } catch (e) { fail(e); } } }, 'delete')));
}

function approvals(list) {
  return h('div.panel', h('h3', 'Waiting for approval'), h('div.body',
    tableOf(['Fleet', 'Release', 'From', 'Asked by', 'Gate', ''], list.map(r => ({
      cells: [h('b', r.fleet), h('span.pill', r.distributionSet), r.from || h('span.faint', 'direct'),
        h('span', r.requestedBy, h('span.faint', ' · ' + ago(r.requestedAt))),
        h('span.faint', { title: r.gateReport, style: 'white-space:pre-line;font-size:11px' },
          r.forced ? 'forced: ' + r.reason : (r.gateReport || '—')),
        can('APPROVE_ROLLOUT') ? h('div.wrap',
          h('button.btn.sm.primary', {
            disabled: r.requestedBy.toLowerCase() === me().toLowerCase(),
            title: r.requestedBy.toLowerCase() === me().toLowerCase() ? 'four eyes: someone else approves what you asked for' : '',
            onclick: () => decide(r, true) }, 'approve'),
          h('button.btn.sm.danger', { onclick: () => decide(r, false) }, 'deny'))
          : h('span.faint', 'needs APPROVE_ROLLOUT')],
    })))));
}

function decide(r, approve) {
  const note = h('input', { type: 'text', placeholder: approve ? 'change ticket, remarks…' : 'why not' });
  modal(`${approve ? 'Approve' : 'Deny'} ${r.distributionSet} for ${r.fleet}`, [
    h('pre.mono', { style: 'font-size:11px;white-space:pre-wrap;margin:0' }, r.gateReport || ''),
    h('label.f', 'Note', note)], async () => {
    await qawk.post(`/releases/${r.id}/${approve ? 'approve' : 'deny'}`, { note: note.value.trim() });
    toast(approve ? 'Approved' : 'Denied', `${r.distributionSet} → ${r.fleet}`, 'ok'); render();
  }, approve ? 'Approve' : 'Deny');
}

async function promoteDialog(to, fleets) {
  const from = fleets.find(f => f.id === to.upstreamId);
  if (!from || !from.distributionSet) { toast('Nothing to promote', `${to.upstream} runs no release`, 'info'); return; }
  const g = await qawk.get(`/fleets/${to.id}/gate?from=${from.id}`);
  const reason = h('input', { type: 'text', placeholder: 'why the gate is forced: it goes in the history' });
  const canForce = can('APPROVE_ROLLOUT');
  modal(`Promote ${from.distributionSet} to ${to.name}`, [
    h('div', { style: 'margin-bottom:6px' }, g.open ? h('span.pill.ok', 'gate open') : h('span.pill.err', 'gate closed')),
    h('pre.mono', { style: 'font-size:12px;white-space:pre-wrap;margin:0 0 8px' }, g.report),
    !g.open && canForce ? h('label.f', 'Force it anyway, because', reason) : null,
    !g.open && !canForce ? h('p.faint', 'Only someone with APPROVE_ROLLOUT can force a closed gate.') : null,
    to.gate.approvalRequired ? h('p.faint', { style: 'font-size:12px' },
      `${to.name} needs approval: the release waits until someone other than you approves it.`) : null,
    to.wavePercent ? h('p.faint', { style: 'font-size:12px' },
      `It goes out ${to.wavePercent}% of the fleet at a time; it halts if more than ${to.errorThreshold}% fail.`) : null,
  ], async () => {
    if (!g.open && !canForce) return false;
    const r = await qawk.post(`/fleets/${to.id}/promote`,
      { from: from.id, force: !g.open, reason: reason.value.trim() });
    toast(r.status === 'waiting_for_approval' ? 'Waiting for approval' : 'Promoted',
      `${r.distributionSet} → ${to.name}`, 'ok');
    render();
  }, g.open ? 'Promote' : 'Force');
}

async function releaseDialog(f) {
  const sets = await distributionSets(true);
  const ds = h('select', h('option', { value: '0' }, '— none: devices are left alone —'),
    sets.content.filter(d => d.complete).map(d => h('option',
      { value: d.id, selected: f.distributionSetId === d.id }, `${d.name} ${d.version} · ${d.type}`)));
  modal('Release for ' + f.name, [h('label.f', 'Distribution set', ds),
    f.gate.approvalRequired ? h('p.faint', 'This fleet needs approval: the release waits for it.') : null],
  async () => {
    await qawk.put('/fleets/' + f.id, { distributionSetId: Number(ds.value) });
    toast('Release set', f.name, 'ok'); render();
  }, 'Release');
}

async function resume(f) {
  if (!await ask('Resume ' + f.name, `${f.release.reason.split('\n').pop()}\nThe devices that failed stay as they are; the rest go on.`,
    { okLabel: 'Resume' })) return;
  try { await qawk.post(`/fleets/${f.id}/resume`, {}); render(); } catch (e) { fail(e); }
}

const dt = ms => {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function freezeDialog(f) {
  const reason = h('input', { type: 'text', placeholder: f.temporary ? 'e.g. ISE Barcelona' : 'e.g. season opening' });
  const from = h('input', { type: 'datetime-local' });
  const until = h('input', { type: 'datetime-local' });
  modal('Freeze ' + f.name, [h('label.f', 'Reason', reason),
    h('label.f', 'From (empty: now)', from), h('label.f', 'Until (empty: until thawed)', until),
    h('p.faint', { style: 'font-size:12px' },
      'No release reaches the fleet while it is frozen. Someone can still assign a single device by hand; the audit log records who.')],
  async () => {
    const b = { reason: reason.value.trim() };
    if (from.value) b.from = new Date(from.value).getTime();
    if (until.value) b.until = new Date(until.value).getTime();
    await qawk.put(`/fleets/${f.id}/freeze`, b); toast('Frozen', f.name, 'ok'); render();
  }, 'Freeze');
}

async function thaw(f) {
  if (!await ask('Thaw ' + f.name, `${f.freeze.reason}\nReleases reach the fleet again.`, { okLabel: 'Thaw' })) return;
  try { await qawk.del(`/fleets/${f.id}/freeze`); render(); } catch (e) { fail(e); }
}

async function sendHome(f, ids) {
  if (!ids && !await ask('Send home', `Every device in ${f.name} goes back to the fleet it came from,\nand gets that fleet's release again.`,
    { okLabel: 'Send home' })) return;
  try {
    const r = await qawk.post(`/fleets/${f.id}/return`, ids ? { controllerIds: ids } : {});
    toast('Sent home', `${r.returned} device${r.returned === 1 ? '' : 's'}` +
      (r.stayed ? `, ${r.stayed} with no home stay` : ''), 'ok');
    render();
  } catch (e) { fail(e); }
}

// preset: what a new fleet starts with -- "next" on a card presets its upstream.
async function fleetDialog(existing, fleets, preset = {}) {
  const f = existing || Object.assign({ gate: { minDevices: 1, minSuccess: 100, soakMinutes: 0, approvalRequired: false },
    wavePercent: 0, waveTimeoutMinutes: 60, errorThreshold: 0, actionType: 'forced' }, preset);
  const num = (v, min, max) => h('input', { type: 'number', value: v, min, max, style: 'width:90px' });
  const name = h('input', { type: 'text', value: f.name || '' });
  const desc = h('input', { type: 'text', value: f.description || '' });
  const colour = colourPicker(f.colour || '#12a594', { nameEl: name });
  const rule = fiqlEditor({ entity: 'targets', value: f.rule || '' });
  const up = h('select', h('option', { value: '0' }, '— none: releases are given directly —'),
    fleets.filter(o => !existing || o.id !== existing.id).map(o =>
      h('option', { value: o.id, selected: f.upstreamId === o.id }, o.name)));
  const temp = h('input', { type: 'checkbox', checked: !!f.temporary });
  // by hand by default: someone looks at the gate, decides, and promotes
  const mode = h('select', [['manual', 'by hand: someone looks at the gate and promotes'],
    ['auto', 'by itself, as soon as the gate opens']].map(([v, l]) =>
    h('option', { value: v, selected: (f.autoPromote ? 'auto' : 'manual') === v }, l)));
  const minDev = num(f.gate.minDevices, 0), minOk = num(f.gate.minSuccess, 0, 100), soak = num(f.gate.soakMinutes, 0);
  const appr = h('input', { type: 'checkbox', checked: f.gate.approvalRequired });
  const wave = num(f.wavePercent, 0, 100), waveT = num(f.waveTimeoutMinutes, 1), thr = num(f.errorThreshold, 0, 100);
  const type = h('select', ['forced', 'soft'].map(t => h('option', { value: t, selected: f.actionType === t }, t)));
  const row = (...n) => h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:end' }, ...n);
  modal(existing ? 'Edit ' + f.name : 'New fleet', [
    h('label.f', 'Name', name), h('label.f', 'Description', desc), h('label.f', 'Colour', colour),
    h('label.f', 'Rule: devices in no fleet that match join this one', rule),
    h('label.f', 'Takes releases from', up),
    h('label.f', 'Promotion from it', mode),
    h('label', { style: 'display:flex;gap:6px;align-items:center' }, temp,
      'temporary: devices come back to the fleet they came from (a trade show)'),
    h('div.f', h('span', 'Gate, checked on the upstream'), row(
      h('label.f', 'devices on it', minDev), h('label.f', '% of the fleet', minOk), h('label.f', 'soak, minutes', soak)),
      h('label', { style: 'display:flex;gap:6px;align-items:center;margin-top:4px' }, appr,
        'a second person approves every release')),
    h('div.f', h('span', 'Delivery'), row(
      h('label.f', 'wave, % (0: all)', wave), h('label.f', 'next wave after, min', waveT),
      h('label.f', 'halt over, % failed', thr), h('label.f', 'mode', type))),
  ], async () => {
    if (!name.value.trim()) throw new Error('a name is required');
    if (rule.value.trim()) { const v = fiqlCheck(rule.value, 'targets'); if (!v.ok) throw new Error(v.msg); }
    const b = { name: name.value.trim(), description: desc.value.trim(), colour: colour.value,
      rule: rule.value.trim(), upstreamId: Number(up.value), temporary: temp.checked, autoPromote: mode.value === 'auto',
      gate: { minDevices: Number(minDev.value), minSuccess: Number(minOk.value), soakMinutes: Number(soak.value),
        approvalRequired: appr.checked },
      wavePercent: Number(wave.value), waveTimeoutMinutes: Number(waveT.value), errorThreshold: Number(thr.value),
      actionType: type.value };
    if (existing) await qawk.put('/fleets/' + existing.id, b);
    else await qawk.post('/fleets', b);
    toast('Saved', b.name, 'ok'); render();
  }, 'Save');
}

async function historyDrawer(f) {
  const d = await qawk.get(`/fleets/${f.id}/releases?limit=100`);
  drawer(f.name + ' — releases', d.content.length
    ? tableOf(['When', 'Release', 'From', 'Status', 'Asked by', 'Decided by', 'Waves'], d.content.map(r => ({
        cells: [h('span.faint', when(r.requestedAt)), h('span.pill', r.distributionSet), r.from || h('span.faint', 'direct'),
          h('span', statusPill(r), r.forced ? h('span.pill.err', { title: r.reason }, 'forced') : null,
            r.reason ? h('div.faint', { style: 'font-size:11px;white-space:pre-line' }, r.reason) : null),
          r.requestedBy, r.decidedBy || h('span.faint', '—'), String(r.waves)],
      })))
    : h('div.empty', 'No release yet.'));
}

// A fleet's devices are a Targets page: paged, searchable, with its columns
// and status counts -- prod holds ten thousand of them.
function openInTargets(f, status = '') {
  S.fleet = f.name; S.status = status; S.q = '';
  go('targets');
}

async function membersDrawer(f) {
  const box = h('div.stack');
  const nowrap = 'white-space:nowrap';
  const load = async () => {
    const d = await qawk.get(`/fleets/${f.id}/targets?limit=${f.temporary ? 100 : 1}`);
    const add = h('input', { type: 'text', placeholder: 'controller ids, comma separated', style: 'flex:1;min-width:0' });
    box.replaceChildren(
      h('div.flex', add, h('button.btn.sm.primary', { onclick: async () => {
        const ids = add.value.split(/[\s,]+/).filter(Boolean);
        if (!ids.length) return;
        try { await qawk.put(`/fleets/${f.id}/targets`, ids); toast('Added', `${ids.length} to ${f.name}`, 'ok'); await load(); render(); }
        catch (e) { fail(e); }
      } }, 'add')),
      h('div.flex', { style: 'justify-content:space-between;gap:8px' },
        h('span.faint', `${d.total.toLocaleString('en-US')} device${d.total === 1 ? '' : 's'}`
          + (f.temporary ? ' · each remembers the fleet it came from' : '')),
        h('button.btn.sm', { onclick: () => { closeDrawer(); openInTargets(f); } }, 'open them in Targets')),
      f.temporary && d.content.length
        ? tableOf(['Device', 'Runs', 'Home', ''], d.content.map(t => ({
            cells: [h('span.mono', { style: nowrap }, t.controllerId),
              h('span.mono', { style: nowrap }, (t.installed || '—').replace(':', ' ')),
              h('span', { style: nowrap }, t.home || h('span.faint', 'none')),
              h('div.flex', { style: nowrap + ';gap:4px' },
                t.home ? h('button.btn.sm', { onclick: async () => { await sendHome(f, [t.controllerId]); await load(); } }, 'send home') : null,
                h('button.btn.sm.ghost', { title: 'take it out of this fleet', onclick: async () => {
                  try { await qawk.delJSON(`/fleets/${f.id}/targets`, [t.controllerId]); await load(); render(); }
                  catch (e) { fail(e); } } }, '\u00d7'))],
          })))
        : null,
      f.temporary ? null : h('p.faint', { style: 'margin:0;font-size:12px' },
        'A fleet can hold thousands of devices: they are listed, searched and paged in Targets, filtered on this fleet.'));
  };
  drawer(f.name + ' — devices', box);
  try { await load(); } catch (e) { fail(e); }
}
