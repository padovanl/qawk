// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { S, qawk } from '../api.js';
import { bars } from '../bars.js';
import { fleetBadge } from '../chips.js';
import { h, icon } from '../dom.js';
import { VIEWS, go } from '../router.js';
import { serverInfo } from '../server.js';
import { ago } from '../util.js';

/* ------- in progress: every deployment going on, in one request (Qawk) ---
 *
 * "What is being deployed right now, and how far has it got?" had no answer
 * on one screen: the fleets page knew its releases, the rollouts page its
 * rollouts, and a set assigned by hand to a hundred devices showed only as a
 * hundred rows saying pending. Qawk groups every open action on the server
 * (/qawk/v1/deployments): by fleet release, by rollout, by set assigned by
 * hand -- with what the devices are doing -- whatever the size of the fleet.
 * Clicking one opens its devices. */
const has = () => ((serverInfo() || {}).features || []).includes('deployments');
const fmt = n => Number(n || 0).toLocaleString('en-US');
const KIND = { fleet: ['fleet', 'fleet release'], rollout: ['rollout', 'rollout'], manual: ['deploy', 'assigned by hand'],
  system: ['box', 'orchestrator'] };

// "name:version" -> the devices told to install that set
function setQuery(d) {
  const nv = String(d.distributionSet || d.title || '');
  const i = nv.lastIndexOf(':');
  return i > 0 ? `assignedds.name==${nv.slice(0, i)};assignedds.version==${nv.slice(i + 1)}` : `assignedds.id==${d.distributionSetId}`;
}

function open(d, status) {
  S.q = ''; S.fleet = ''; S.status = status || '';
  if (d.kind === 'rollout') { go('ro'); return; }
  if (d.kind === 'system') { go('systems'); return; }
  if (d.kind === 'fleet') S.fleet = d.title;
  else S.q = setQuery(d);
  go('targets');
}

function row(d, compact) {
  const pct = d.total ? Math.round(100 * d.done / d.total) : 0;
  const bad = d.status === 'halted' || d.status === 'paused';
  const seg = (n, label, cls, status) => (n ? h('button.btn.sm', {
    title: `${fmt(n)} ${label} -- show them`,
    onclick: e => { e.stopPropagation(); open(d, status); },
  }, h('span.pill.' + cls, `${label} · ${fmt(n)}`)) : null);
  const stCls = bad ? '.err' : d.status === 'waiting_for_approval' ? '.amber' : '.live';
  return h('div', {
    'data-key': `${d.kind}:${d.title}`,
    style: 'cursor:pointer;padding:10px 12px;border:1px solid color-mix(in srgb, var(--fg) 14%, transparent);border-radius:10px'
      + (bad ? ';border-color:var(--err)' : ''),
    title: 'open its devices',
    onclick: () => open(d),
  },
  h('div.flex', { style: 'justify-content:space-between;gap:8px;flex-wrap:wrap' },
    h('span.flex', { style: 'gap:8px;flex-wrap:wrap' }, icon(KIND[d.kind][0], 15),
      d.kind === 'fleet' ? fleetBadge(d.title, d.colour) : h('b', d.title),
      h('span.faint', KIND[d.kind][1]),
      d.distributionSet && d.kind !== 'manual' ? h('span.pill.ok', d.distributionSet) : null,
      h('span.pill' + stCls, String(d.status).replace(/_/g, ' '))),
    h('span.faint', { style: 'font-size:12px' },
      `${fmt(d.done)} of ${fmt(d.total)} done` + (d.since ? ' · started ' + ago(d.since) : '')
      + (d.by && d.by.length ? ' · by ' + d.by.slice(0, 3).join(', ') : ''))),
  h('div', { style: 'margin:8px 0 6px' }, bars([
    [d.done, 'ok', `${fmt(d.done)} done (${pct}%)`],
    [(d.downloading || 0) + (d.installing || 0) + (d.confirming || 0), 'run', 'working on it'],
    [d.failed, 'err', `${fmt(d.failed)} failed`],
    [(d.waiting || 0) + (d.scheduled || 0), 'wait', 'waiting'],
  ], d.total, { key: `dep:${d.kind}:${d.title}` })),
  !compact && d.detail ? h('div.faint', { style: 'font-size:12px;margin-bottom:4px;white-space:pre-line' }, d.detail) : null,
  h('div.wrap', { style: 'gap:4px' },
    seg(d.waiting, 'waiting', 'mute', 'pending'), seg(d.scheduled, 'waiting for its window', 'mute', 'pending'),
    seg(d.downloading, 'downloading', 'live', 'pending'), seg(d.installing, 'installing', 'live', 'pending'),
    seg(d.confirming, 'to confirm', 'amber', 'pending'), seg(d.canceling, 'cancelling', 'mute', 'pending'),
    seg(d.failed, 'failed', 'err', 'error'),
    !d.open && !d.failed
      ? h('span.faint', { style: 'font-size:12px' },
          d.status === 'waiting_for_approval' ? d.detail : 'no device is working on it right now')
      : null));
}

// The dashboard's panel: the first few, and a way to all of them.
async function inProgressPanel(max) {
  if (!has()) return null;
  return inProgressPanelFrom((await qawk.get('/deployments')).content || [], max);
}

function inProgressPanelFrom(list, max) {
  return h('div.panel',
    h('h3', 'In progress', list.length > max
      ? h('button.btn.sm.ghost', { style: 'float:right', onclick: () => go('inprog') }, `all ${list.length}`) : null),
    h('div.body.stack', list.length
      ? list.slice(0, max).map(x => row(x, true))
      : h('div.faint', 'Nothing is being deployed right now.')));
}

VIEWS.inprog = {
  title: 'In progress',
  live: 3000,
  async render(root) {
    if (!has()) {
      root.replaceChildren(h('div.empty', 'This server does not say what is in progress: it is not Qawk.'));
      return;
    }
    const list = (await qawk.get('/deployments')).content || [];
    const sum = k => list.reduce((a, x) => a + (x[k] || 0), 0);
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'What the devices are doing'), h('div.body.wrap',
        [['open', 'with an update open', 'mute'], ['downloading', 'downloading', 'live'],
         ['installing', 'installing', 'live'], ['waiting', 'waiting to start', 'mute'],
         ['scheduled', 'waiting for their window', 'mute'], ['confirming', 'to confirm', 'amber'],
         ['failed', 'failed', 'err']].map(([k, l, c]) =>
          h('span.pill.' + (sum(k) ? c : 'mute'), `${l} · ${fmt(sum(k))}`)))),
      list.length
        ? h('div.stack', list.map(x => row(x, false)))
        : h('div.empty', h('b', 'Nothing in progress'),
            'Fleet releases, rollouts and sets assigned by hand appear here while devices are working on them.')));
  },
};

export { KIND, has as hasDeployments, setQuery, inProgressPanel, inProgressPanelFrom };
