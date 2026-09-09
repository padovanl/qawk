import { start } from './auth.js';
import { enc, get, limited } from './api.js';
import { h, icon } from './dom.js';
import { download } from './util.js';

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

const ACT_ICON = { start: 'play', pause: 'pause', resume: 'play',
  delete: 'trash', approve: 'check', 'trigger next group': 'next' };

/* An action's status is the LAST thing the device reported about it, not its
 * outcome. hawkBit keeps that even after the action is closed, so a deployment
 * that finished at 21:46:07 and was polled again twelve seconds later ends up
 * reading "retrieved" for good -- with active:false.
 *
 * Spinning on that is a lie: it says work is under way when the action is
 * over. So the spinner belongs to ACTIVE actions only, and a closed one whose
 * last word was not an outcome says as much rather than looking stuck.
 */
const TERMINAL = new Set(['finished', 'error', 'canceled', 'cancel_rejected']);

function actionPill(a, targetId) {
  const st = String(a.status || '').toLowerCase();
  if (a.active !== false) return pill(st, ACTION_PILL[st]);
  if (TERMINAL.has(st)) return pill(st, ACTION_PILL[st]);

  const p = pill(st, 'mute');
  p.title = `the action is closed; "${st}" is only the last thing the device `
          + 'reported about it, which can arrive after the closing feedback';
  p.append(h('span.faint', { style: 'margin-left:5px' }, '\u00b7 closed'));

  /* HOW IT ENDED IS NOT IN THE ACTION. There is no detailStatus and no result
     field on this hawkBit: the outcome only exists as an entry in the status
     history. So for a closed action whose last word was not an outcome, ask --
     one request, through the same concurrency gate as everything else -- and
     say what it actually was. */
  if (targetId) {
    limited(() => get(`/targets/${enc(targetId)}/actions/${a.id}/status`
                      + '?limit=50&sort=id:DESC'))
      .then(r => {
        const hit = (r.content || [])
          .find(x => TERMINAL.has(String(x.type).toLowerCase()));
        if (!hit) return;
        const real = String(hit.type).toLowerCase();
        p.className = 'pill ' + (ACTION_PILL[real] || 'mute');
        p.replaceChildren(real);
        p.title = `the device reported "${real}". hawkBit still shows "${st}" `
                + 'because it keeps the LAST status entry, and the device polled '
                + 'again after closing the action';
      })
      .catch(() => { /* leave the honest "closed": we simply could not ask */ });
  }
  return p;
}

/* WHAT "pending" IS ACTUALLY DOING.
 *
 * A target's updateStatus is a fixed hawkBit enum -- in_sync, pending, error,
 * registered, unknown -- and "pending" covers everything from "assigned, the
 * device has not polled yet" to "written to the spare slot, waiting for the
 * reboot". Those are very different things to be looking at during a rollout.
 *
 * There is no finer field: a status entry carries only type, messages and a
 * timestamp, and no progress counter. But the MESSAGES are SWUpdate's own
 * words, and they say exactly where it is. So the phase below is DERIVED from
 * the newest entries of the active action -- read, not reported.
 */
function phaseFrom(entries) {          // newest first
  for (const e of entries) {
    const t = String(e.type || '').toLowerCase();
    const m = (e.messages || []).join(' ');
    if (t === 'wait_for_confirmation')
      return { label: 'waiting for confirmation', cls: 'warn pulse',
               why: 'the update needs a human to allow it on the device' };
    if (t === 'canceling') return { label: 'cancelling', cls: 'live' };
    if (t === 'error')     return { label: 'error', cls: 'err' };
    if (t === 'download')  return { label: 'downloading', cls: 'live',
                                    why: 'fetching the artifacts' };
    if (t === 'running') {
      // An application update closes itself within a second of this, so an
      // action still open here is a system one: everything is on the spare
      // slot and only the reboot is left.
      if (/All Chunks Installed|SWUPDATE successful/i.test(m))
        return { label: 'waiting for reboot', cls: 'warn',
                 why: 'written to the spare slot; it becomes active at the next boot' };
      if (/Installing/i.test(m))
        return { label: 'installing', cls: 'live', why: 'writing the payload' };
      if (/Assignment initiated/i.test(m))
        return { label: 'assigned', cls: 'live',
                 why: 'the device has not polled yet' };
      return { label: 'running', cls: 'live' };
    }
    if (t === 'retrieved')
      return { label: 'downloading', cls: 'live',
               why: 'the device has taken the deployment and is fetching it' };
  }
  return null;
}

/* Fills a "pending" pill in with the phase, once the two requests it takes
   have answered. Costs nothing on a fleet that is idle: only pending rows ask. */
function explainPending(p, targetId) {
  limited(() => get(`/targets/${enc(targetId)}/actions?limit=1&sort=id:DESC`))
    .then(r => {
      const a = (r.content || [])[0];
      if (!a) return null;
      /* The row said "pending" and the action is already closed. Not a
         contradiction, a race: the target list and the actions are two
         separate reads, and the action finished between them. Say so instead
         of leaving a stale word on screen. */
      if (a.active === false) {
        p.classList.remove('live'); p.classList.add('mute');
        p.append(h('span.faint', { style: 'margin-left:5px' }, '\u00b7 just closed'));
        p.title = 'the last action has closed; this row was read a moment earlier. '
                + 'It settles at the next refresh';
        return null;
      }
      return limited(() => get(`/targets/${enc(targetId)}/actions/${a.id}/status`
                               + '?limit=20&sort=id:DESC'));
    })
    .then(r => {
      if (!r) return;
      const ph = phaseFrom(r.content || []);
      if (!ph) return;
      p.className = 'pill ' + ph.cls;
      p.replaceChildren(ph.label);
      p.title = (ph.why ? ph.why + '. ' : '')
              + 'hawkBit calls this "pending"; the phase is read from what the '
              + 'device last reported';
    })
    .catch(() => { /* leave the plain "pending" */ });
  return p;
}

export {
  ACTION_PILL, ACT_ICON, TARGET_PILL, actionPill, explainPending, phaseFrom, pill, typePill,
};
