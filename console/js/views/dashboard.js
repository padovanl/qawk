import { S, enc, fiql, get } from '../api.js';
import { PHASE_WORDS, TARGET_PILL, actionPill, phaseOf, pill } from '../badges.js';
import { $, h } from '../dom.js';
import { noteTargets } from '../notices.js';
import { VIEWS, drawNav, go, render } from '../router.js';
import { card, tableOf } from '../table.js';
import { when } from '../util.js';
import { openTarget } from './target-detail.js';

/* ------- dashboard (EXTRA: the simple UI has no overview) ----------- */
// The class a phase pill wears, from the one list the legend also reads.
const phaseClass = label => {
  const base = label.replace(/ \(part \d+\)$/, '');
  const hit = PHASE_WORDS.find(([k]) => k === base);
  return hit ? hit[1] : 'live';
};

// How long after its last poll a device counts as overdue: hawkBit's polling
// interval plus its grace, read once a minute.
const hms = v => { const [h, m, s] = String(v).split(':').map(Number); return ((h * 60 + m) * 60 + s) * 1000; };
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
    noteTargets(tg.content);
    drawNav();

    // THE FLEET, NOT THE WINDOW. These were counted over the sixty devices
    // fetched above, which was the whole fleet on the bench and a sixtieth of
    // it at ten thousand: "registered 60" with 8000 registered. The server
    // counts each status (limit=1 returns only the total), and the overdue.
    const count = q => get('/targets?limit=1&q=' + fiql(q)).then(r => r.total);
    const [totals, installedInSync, cutoff] = await Promise.all([
      Promise.all(STATUSES.map(s => count(`updatestatus==${s}`).catch(() => 0))),
      count('updatestatus==in_sync;installedat=ge=0').catch(() => null),
      overdueCutoff(),
    ]);
    const over = cutoff !== null
      ? await count(`lastcontrollerrequestat=lt=${cutoff}`).catch(() => 0)
      : tg.content.filter(t => t.pollStatus && t.pollStatus.overdue).length;
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

    // THE SAME WORDS AS THE TARGETS TABLE. Counting raw "pending" here while
    // the table showed "downloading" for the same device meant the two screens
    // contradicted each other on the one thing you look at during a rollout.
    // What a device is doing costs a request per device, so this part stays a
    // sample -- the sixty seen last -- and says so; the pending total above
    // is the fleet's.
    const phases = {};
    await Promise.all(tg.content
      .filter(t => t.updateStatus === 'pending')
      .map(async t => {
        const ph = await phaseOf(t.controllerId);
        if (ph && ph.label) phases[ph.label] = (phases[ph.label] || 0) + 1;
      }));

    // The latest actions of the whole fleet, newest first, in one request:
    // /actions is the fleet-wide feed, and each action names its target in its
    // self link. (This used to ask the twenty devices seen last for their own
    // latest action -- at ten thousand devices those were twenty idle ones,
    // and the panel said "nothing deployed" in the middle of a release.)
    const SAMPLE = 20;
    const feed = await get(`/actions?limit=${SAMPLE}&sort=id:DESC`).catch(() => ({ content: [], total: 0 }));
    const recent = feed.content.map(a => {
      const href = ((a._links || {}).self || {}).href || '';
      const m = href.match(/\/targets\/([^/]+)\/actions\//);
      return m ? Object.assign({ _t: decodeURIComponent(m[1]) }, a) : null;
    }).filter(Boolean);

    root.replaceChildren(h('div.stack',
      h('div.cards',
        card('Targets', tg.total, over ? `${over} overdue` : 'all polling on time'),
        card('Distribution sets', ds.total), card('Software modules', sm.total),
        card('Rollouts', ro.total)),
      h('div.panel', h('h3', 'Fleet status'), h('div.body.wrap',
        Object.keys(byStatus).length || virgin
          ? Object.entries(byStatus).flatMap(([k, v]) => {
              // "pending" is broken out into what those devices are doing; the
              // bucket itself stays clickable, since hawkBit's filter only
              // knows the five words.
              const bucket = h('button.btn.sm', { onclick: () => { S.status = k; go('targets'); } },
                h('span.pill.' + (TARGET_PILL[k] || 'mute'), `${k.replace(/_/g, ' ')} · ${v}`));
              if (k !== 'pending' || !Object.keys(phases).length) return [bucket];
              return [bucket].concat(Object.entries(phases).map(([label, n]) =>
                h('button.btn.sm', {
                  title: `of the ${tg.content.length} devices seen most recently: what they report doing`,
                  onclick: () => { S.status = 'pending'; go('targets'); },
                }, h('span.pill.' + phaseClass(label), `${label} · ${n} of the last ${tg.content.length}`))));
            })
            .concat(virgin ? [h('button.btn.sm', {
                title: 'in sync as far as hawkBit is concerned: nothing pending, '
                     + 'but this server has never installed anything on them',
                onclick: () => { S.status = 'in_sync'; go('targets'); } },
              h('span.pill.mute', `never installed \u00b7 ${virgin}`))] : [])
          : h('span.faint', 'no targets registered yet'))),
      h('div.panel', h('h3', feed.total > SAMPLE
          ? `Latest actions · the ${SAMPLE} newest of ${feed.total}`
          : 'Latest actions'),
        recent.length
          ? tableOf(['Target', 'Action', 'Status', 'Type', 'When'], recent.map(a => ({
              onclick: () => openTarget(a._t),
              cells: [h('span.mono', a._t.slice(0, 16)), h('span.mono', '#' + a.id),
                      actionPill(a, a._t), h('span.dim', a.type || '—'),
                      h('span.faint.nowrap', when(a.lastModifiedAt || a.createdAt))],
            })))
          : h('div.empty', 'nothing has been deployed yet'))));
  },
};
