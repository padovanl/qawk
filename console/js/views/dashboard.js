import { S, fiql, get, qawk } from '../api.js';
import { PHASE_WORDS, TARGET_PILL, phasesOf } from '../badges.js';
import { hasBatch, statesOf } from '../batch.js';
import { fleetBadge } from '../chips.js';
import { h } from '../dom.js';
import { VIEWS, drawNav, go } from '../router.js';
import { card } from '../table.js';
import { ago } from '../util.js';
import { hasDeployments, inProgressPanelFrom } from './deployments.js';
import { openTarget } from './target-detail.js';

/* ------- dashboard: what needs someone, what is moving, how the fleet stands
 *
 * EVERYTHING AT ONCE. This page used to ask in rounds -- the counts, then
 * the overdue, then the phases, then what was in progress, then the latest
 * actions -- each waiting for the one before, so every slow answer added to
 * the next. Now every request leaves together, and the page is as slow as
 * its slowest answer, not as the sum of them.
 *
 * AND ONLY WHAT SAYS SOMETHING. "Latest actions" listed the twenty newest
 * actions of anything: at ten thousand devices, twenty idle simulated ones.
 * In its place: what needs someone -- devices whose update failed, with what
 * they said; releases halted by their threshold; rollouts paused; systems
 * rolled back; approvals waiting; devices that stopped polling. */
const phaseClass = label => {
  const base = label.replace(/ \(part \d+\)$/, '');
  const hit = PHASE_WORDS.find(([k]) => k === base);
  return hit ? hit[1] : 'live';
};

// How long after its last poll a device counts as overdue: hawkBit's polling
// interval plus its grace, read once a minute.
const hms = v => { const [hh, m, s] = String(v).split(':').map(Number); return ((hh * 60 + m) * 60 + s) * 1000; };
let pollCfg = null;
async function overdueCutoff() {
  try {
    if (!pollCfg || Date.now() - pollCfg.at > 60000) {
      const [p, o] = await Promise.all([get('/system/configs/pollingTime'), get('/system/configs/pollingOverdueTime')]);
      const ms = hms(p.value) + hms(o.value);
      if (!Number.isFinite(ms)) return null;
      pollCfg = { at: Date.now(), ms };
    }
    return Date.now() - pollCfg.ms;
  } catch (_) { return null; }
}

const STATUSES = ['registered', 'pending', 'in_sync', 'error', 'unknown'];
const fmt = n => Number(n || 0).toLocaleString('en-US');
const TROUBLE = ['halted', 'paused', 'rolling_back', 'waiting_for_approval'];

const clickable = (node, onclick, title) => h('div', { style: 'cursor:pointer', title, onclick }, node);

function targetOf(a) {
  const m = (((a._links || {}).self || {}).href || '').match(/\/targets\/([^/]+)\/actions\//);
  return m ? decodeURIComponent(m[1]) : null;
}

VIEWS.dash = {
  title: 'Dashboard',
  async render(root) {
    const count = q => get('/targets?limit=1&q=' + fiql(q)).then(r => r.total);
    const cutoffP = overdueCutoff();
    const [tg, totals, installedInSync, cutoff, over, deps, fails] = await Promise.all([
      get('/targets?limit=60&sort=lastControllerRequestAt:DESC'),
      Promise.all(STATUSES.map(s => count(`updatestatus==${s}`).catch(() => 0))),
      count('updatestatus==in_sync;installedat=ge=0').catch(() => null),
      cutoffP,
      cutoffP.then(c => (c === null ? null : count(`lastcontrollerrequestat=lt=${c}`))).catch(() => null),
      hasDeployments() ? qawk.get('/deployments').then(r => r.content || []).catch(() => []) : Promise.resolve(null),
      get('/actions?limit=6&sort=id:DESC&q=' + fiql('status==error')).catch(() => ({ content: [], total: 0 })),
    ]);
    S.counts.targets = tg.total;
    drawNav();

    // The targets table refuses to call a device that has never installed
    // anything "in sync"; counting it green here would contradict that on the
    // same screen. It gets a bucket of its own.
    const byStatus = {};
    STATUSES.forEach((s, i) => { if (totals[i]) byStatus[s] = totals[i]; });
    let virgin = 0;
    if (byStatus.in_sync && installedInSync !== null) {
      virgin = byStatus.in_sync - installedInSync;
      byStatus.in_sync = installedInSync;
      if (!byStatus.in_sync) delete byStatus.in_sync;
    }

    // What the pending devices are doing (a sample: the sixty seen last) and
    // what the failed ones said -- two batch requests, together.
    const failed = (fails.content || []).map(a => Object.assign({ _t: targetOf(a) }, a)).filter(a => a._t);
    const [phs, fstates] = await Promise.all([
      phasesOf(tg.content.filter(t => t.updateStatus === 'pending').map(t => t.controllerId)).catch(() => new Map()),
      hasBatch() && failed.length ? statesOf(failed.map(a => a._t)).catch(() => new Map()) : Promise.resolve(new Map()),
    ]);
    const phases = {};
    phs.forEach(ph => { if (ph && ph.label) phases[ph.label] = (phases[ph.label] || 0) + 1; });

    const errors = byStatus.error || 0;
    const trouble = (deps || []).filter(d => TROUBLE.includes(d.status));
    const approvals = trouble.filter(d => d.status === 'waiting_for_approval');
    const updating = (deps || []).reduce((n, d) => n + (d.open || 0), 0);

    root.replaceChildren(h('div.stack',
      h('div.cards',
        clickable(card('Devices', fmt(tg.total), over ? `${fmt(over)} not polling` : 'all polling on time'),
          () => { S.q = over && cutoff ? `lastcontrollerrequestat=lt=${cutoff}` : ''; S.status = ''; go('targets'); },
          over ? 'the devices that stopped polling' : 'every device'),
        clickable(card('In progress', deps ? fmt(deps.length) : '—',
          deps ? `${fmt(updating)} device${updating === 1 ? '' : 's'} updating` : 'needs Qawk'), () => go('inprog')),
        clickable(card('Failed', fmt(errors), errors ? 'their last update failed' : 'no device in error'),
          () => { S.q = ''; S.status = 'error'; go('targets'); }, 'the devices in error'),
        clickable(card('To approve', fmt(approvals.length), approvals.length ? 'releases waiting for a second person' : 'nothing waiting'),
          () => go('fleets'))),
      attentionPanel({ errors, failed, fstates, trouble, over, cutoff }),
      deps ? inProgressPanelFrom(deps, 5) : null,
      fleetStatus(byStatus, virgin, phases, tg.content.length)));
  },
};

function attentionPanel({ errors, failed, fstates, trouble, over, cutoff }) {
  const rows = [];
  for (const d of trouble) {
    rows.push(h('div', { style: 'cursor:pointer;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap',
      onclick: () => go(d.kind === 'fleet' ? 'fleets' : d.kind === 'rollout' ? 'ro' : d.kind === 'system' ? 'systems' : 'inprog') },
    h('span.pill.' + (d.status === 'waiting_for_approval' ? 'amber' : 'err'), String(d.status).replace(/_/g, ' ')),
    d.kind === 'fleet' ? fleetBadge(d.title, d.colour) : h('b', d.title), d.distributionSet && d.kind !== 'manual' ? h('span.faint', d.distributionSet) : null,
    h('span.faint', { style: 'font-size:12px' }, (d.detail || '').split('\n').pop())));
  }
  if (errors) {
    rows.push(h('div', { style: 'cursor:pointer;margin-top:4px', onclick: () => { S.q = ''; S.status = 'error'; go('targets'); } },
      h('span.pill.err', `${fmt(errors)} device${errors === 1 ? '' : 's'} in error`),
      h('span.faint', { style: 'margin-left:8px;font-size:12px' }, 'their last update failed — show them')));
    for (const a of failed) {
      const st = fstates.get(a._t);
      const msg = st && st.statuses && st.statuses.length ? (st.statuses[0].messages || []).join(' ') : '';
      const set = st && st.assigned ? `${st.assigned.name} ${st.assigned.version}` : '';
      rows.push(h('div', { style: 'cursor:pointer;display:flex;gap:10px;align-items:baseline;padding-left:12px;font-size:12px',
        title: msg, onclick: () => openTarget(a._t) },
      h('span.mono', { style: 'white-space:nowrap' }, a._t), set ? h('span.faint', { style: 'white-space:nowrap' }, set) : null,
      h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0' }, msg || 'failed'),
      h('span.faint', { style: 'white-space:nowrap' }, ago(a.lastModifiedAt || a.createdAt))));
    }
  }
  if (over) {
    rows.push(h('div', { style: 'cursor:pointer;margin-top:4px',
      onclick: () => { S.q = cutoff ? `lastcontrollerrequestat=lt=${cutoff}` : ''; S.status = ''; go('targets'); } },
    h('span.pill.amber', `${fmt(over)} not polling`),
    h('span.faint', { style: 'margin-left:8px;font-size:12px' }, 'no poll within the polling interval and its grace — show them')));
  }
  return h('div.panel', h('h3', 'Needs attention'), h('div.body.stack', { style: 'gap:6px' },
    rows.length ? rows : h('div', h('span.pill.ok', 'nothing'), h('span.faint', { style: 'margin-left:8px' },
      'no failed device, no halted release, no approval waiting, every device polling'))));
}

function fleetStatus(byStatus, virgin, phases, sample) {
  return h('div.panel', h('h3', 'Fleet status'), h('div.body.wrap',
    Object.keys(byStatus).length || virgin
      ? Object.entries(byStatus).flatMap(([k, v]) => {
          // "pending" is broken out into what those devices are doing; the
          // bucket itself stays clickable, since hawkBit's filter only knows
          // the five words.
          const bucket = h('button.btn.sm', { onclick: () => { S.q = ''; S.status = k; go('targets'); } },
            h('span.pill.' + (TARGET_PILL[k] || 'mute'), `${k.replace(/_/g, ' ')} · ${fmt(v)}`));
          if (k !== 'pending' || !Object.keys(phases).length) return [bucket];
          return [bucket].concat(Object.entries(phases).map(([label, n]) =>
            h('button.btn.sm', {
              title: `of the ${sample} devices seen most recently: what they report doing`,
              onclick: () => { S.q = ''; S.status = 'pending'; go('targets'); },
            }, h('span.pill.' + phaseClass(label), `${label} · ${n} of the last ${sample}`))));
        })
        .concat(virgin ? [h('button.btn.sm', {
            title: 'in sync as far as hawkBit is concerned: nothing pending, '
                 + 'but this server has never installed anything on them',
            onclick: () => { S.q = ''; S.status = 'in_sync'; go('targets'); } },
          h('span.pill.mute', `never installed · ${fmt(virgin)}`))] : [])
      : h('span.faint', 'no targets registered yet')));
}
