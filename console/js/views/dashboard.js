import { S, enc, get } from '../api.js';
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

    const over = tg.content.filter(t => t.pollStatus && t.pollStatus.overdue).length;
    // The targets table refuses to call a device that has never installed
    // anything "in sync"; counting it green here would contradict that on the
    // same screen. It gets a bucket of its own.
    const byStatus = {};
    let virgin = 0;
    tg.content.forEach(t => {
      if (t.updateStatus === 'in_sync' && !t.installedAt) { virgin++; return; }
      byStatus[t.updateStatus] = (byStatus[t.updateStatus] || 0) + 1;
    });

    // THE SAME WORDS AS THE TARGETS TABLE. Counting raw "pending" here while
    // the table showed "downloading" for the same device meant the two screens
    // contradicted each other on the one thing you look at during a rollout.
    const phases = {};
    await Promise.all(tg.content
      .filter(t => t.updateStatus === 'pending')
      .map(async t => {
        const ph = await phaseOf(t.controllerId);
        if (ph && ph.label) phases[ph.label] = (phases[ph.label] || 0) + 1;
      }));

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
        Object.keys(byStatus).length || virgin
          ? Object.entries(byStatus).flatMap(([k, v]) => {
              // "pending" is broken out into what those devices are doing; the
              // bucket itself stays clickable, since hawkBit's filter only
              // knows the five words.
              if (k !== 'pending' || !Object.keys(phases).length) {
                return [h('button.btn.sm', { onclick: () => { S.status = k; go('targets'); } },
                  h('span.pill.' + (TARGET_PILL[k] || 'mute'), `${k.replace(/_/g, ' ')} · ${v}`))];
              }
              return Object.entries(phases).map(([label, n]) =>
                h('button.btn.sm', {
                  title: 'hawkBit calls this pending; the phase is read from what the device reported',
                  onclick: () => { S.status = 'pending'; go('targets'); },
                }, h('span.pill.' + phaseClass(label), `${label} · ${n}`)));
            })
            .concat(virgin ? [h('button.btn.sm', {
                title: 'in sync as far as hawkBit is concerned: nothing pending, '
                     + 'but this server has never installed anything on them',
                onclick: () => { S.status = 'in_sync'; go('targets'); } },
              h('span.pill.mute', `never installed \u00b7 ${virgin}`))] : [])
          : h('span.faint', 'no targets registered yet'))),
      h('div.panel', h('h3', tg.total > SAMPLE
          ? `Latest action · ${SAMPLE} most recently seen of ${tg.total}`
          : 'Latest action per target'),
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
