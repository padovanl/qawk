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
/* The phases, in the order a device passes through them. ONE list: the legend
   on the Targets page and the About page both read it, and a test checks that
   every label phaseFrom() can produce is described here -- otherwise the
   column shows a word the legend does not explain, which is how this drifted
   in the first place. */
const PHASE_WORDS = [
  ['assigned',    'live', 'created; the device has not polled yet'],
  ['downloading', 'live', 'fetching the package, or the chunks it is missing'],
  ['installing',  'live', 'writing the payload'],
  ['installed',   'ok',   'an application update is done: it needs no reboot and the '
                        + 'action closes itself within a moment'],
  ['waiting for reboot', 'warn',
   'a system update is written to the spare slot and becomes active at the next boot'],
  ['waiting for confirmation', 'warn pulse',
   'the update needs a human to allow it on the device'],
  ['cancelling',  'live', 'someone stopped it and the device is being told'],
  ['error',       'err',  'the device reported a failure while the action is still open — '
                        + 'usually it is retrying, or about to give up'],
];
/* A combined set is installed one part at a time, so "downloading" and
   "installing" gain a "(part 2)" while the second one is under way. */
const PHASE_NOTE = 'a set that carries both a system and an application is '
                 + 'installed in two parts, one after the other — the phase says which';

/* THE FURTHEST IT GOT, NOT THE LAST THING IT SAID.
 *
 * Taking the newest recognisable entry is wrong, and wrong in a way that shows:
 * a device that has finished installing polls again, hawkBit records another
 * "retrieved", and the row falls back to "downloading" -- where it then sits
 * through the reboot until the action closes. Seen exactly that.
 *
 * So the chain is walked in order and the HIGHEST point reached wins. A late
 * poll cannot undo progress that was already reported.
 *
 * A combined set is two chunks and SWUpdate installs them as two runs, one
 * after the other -- that is how hawkBit and SWUpdate do it, not a fault. The
 * chain says so plainly:
 *
 *     Installing Update Chunk Artifacts.     chunk 1 starts
 *     Installed Chunk.                       chunk 1 done
 *     Installing Update Chunk Artifacts.     chunk 2 starts
 *     Installed Chunk.                       chunk 2 done
 *     All Chunks Installed.                  the deployment is complete
 *
 * so the phase says which chunk it is on, and only calls it done at the last
 * line.
 */
/* Two things move independently, and conflating them is what made this wrong
   twice: how many PARTS are done (only ever goes up), and where the CURRENT
   part is (down, then install, then done -- and it starts over on the next
   part). SWUpdate announces the install before it downloads, so within a part
   the newest word wins; across parts, progress cannot go backwards. And once
   the deployment says "All Chunks Installed", nothing after it counts -- a
   poll arriving later used to drag the row back to "downloading" and leave it
   there through the reboot. */
const IN_ASSIGNED = 1, IN_DOWNLOAD = 2, IN_INSTALL = 3;

function phaseFrom(entries, kind) {
  if (!entries || !entries.length) return null;
  const chain = entries.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  let done = 0, cur = 0, complete = false, special = null;

  for (const e of chain) {
    const t = String(e.type || '').toLowerCase();
    const m = (e.messages || []).join(' ');
    if (t === 'wait_for_confirmation') { special = 'confirm'; continue; }
    if (t === 'canceling') { special = 'cancel'; continue; }
    if (t === 'error') { special = 'error'; continue; }
    if (complete) continue;                       // the deployment is over
    if (t === 'running' && /All Chunks Installed/i.test(m)) { complete = true; continue; }
    if (t === 'running' && /Installed Chunk/i.test(m)) { done++; cur = 0; continue; }
    if (t === 'running' && /Installing Update Chunk/i.test(m)) { cur = IN_INSTALL; continue; }
    if (t === 'download') { cur = IN_DOWNLOAD; continue; }
    if (t === 'retrieved') { cur = Math.max(cur, IN_DOWNLOAD); continue; }
    if (t === 'running' && /Assignment initiated/i.test(m)) cur = Math.max(cur, IN_ASSIGNED);
  }

  if (special === 'confirm')
    return { label: 'waiting for confirmation', cls: 'warn pulse',
             why: 'the update needs a human to allow it on the device' };
  if (special === 'cancel') return { label: 'cancelling', cls: 'live' };
  if (special === 'error')
    return { label: 'error', cls: 'err',
             why: 'the device reported a failure while the action is still open' };
  if (complete) {
    // WHAT "DONE" MEANS DEPENDS ON WHAT WAS INSTALLED. An application update
    // touches no slot and reboots nothing: it closes its own action within a
    // second, so telling someone to expect a reboot is simply false -- and it
    // was on screen during an application delta. Only a set carrying a system
    // part waits for a boot.
    if (kind === 'app')
      return { label: 'installed', cls: 'ok',
               why: 'an application needs no reboot; the action closes itself in a moment' };
    return { label: 'waiting for reboot', cls: 'warn',
             why: kind === 'os_app'
               ? 'both parts are written; the system half becomes active at the next boot'
               : 'written to the spare slot; it becomes active at the next boot' };
  }

  // "part N" only means something once a part has finished, which is exactly
  // when there is more than one.
  const part = done > 0 ? ` (part ${done + 1})` : '';
  const why  = done > 0 ? 'a set carrying both a system and an application is installed '
                        + 'in parts, one after the other' : null;
  if (cur === IN_INSTALL)  return { label: 'installing' + part,  cls: 'live', why: why || 'writing the payload' };
  if (cur === IN_DOWNLOAD) return { label: 'downloading' + part, cls: 'live', why: why || 'fetching the package' };
  if (cur === IN_ASSIGNED) return { label: 'assigned', cls: 'live', why: 'the device has not polled yet' };
  if (done > 0)            return { label: 'installing' + part,  cls: 'live', why };
  return null;
}

/* Asks what a pending device is actually doing. Two requests, and only for
   rows that are pending -- an idle fleet asks nothing. */
async function phaseOf(targetId) {
  try {
    const r = await limited(() => get(`/targets/${enc(targetId)}/actions?limit=1&sort=id:DESC`));
    const a = (r.content || [])[0];
    if (!a) return null;
    if (a.active === false) return { closed: true };
    // The action carries no distribution set, so the kind comes from what the
    // device has been assigned. It decides whether "done" means a reboot.
    const [st, ds] = await Promise.all([
      limited(() => get(`/targets/${enc(targetId)}/actions/${a.id}/status?limit=40&sort=id:DESC`)),
      limited(() => get(`/targets/${enc(targetId)}/assignedDS`)).catch(() => null),
    ]);
    return phaseFrom(st.content || [], ds && ds.type);
  } catch (_) { return null; }
}

/* Draws a phase into a pill. Separate from the asking so a caller that already
   knows the phase can paint it with no flicker. */
function paintPhase(p, ph) {
  if (!ph) return p;
  if (ph.closed) {
    p.classList.remove('live'); p.classList.add('mute');
    p.append(h('span.faint', { style: 'margin-left:5px' }, '\u00b7 just closed'));
    p.title = 'the last action has closed; this row was read a moment earlier. '
            + 'It settles at the next refresh';
    return p;
  }
  p.className = 'pill ' + ph.cls;
  p.replaceChildren(ph.label);
  p.title = (ph.why ? ph.why + '. ' : '')
          + 'hawkBit calls this "pending"; the phase is read from what the device last reported';
  return p;
}

/* The old asynchronous path, kept for callers that have no phase to hand. */
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
  ACTION_PILL, ACT_ICON, PHASE_NOTE, PHASE_WORDS, TARGET_PILL, actionPill, explainPending,
  paintPhase, phaseOf,
  phaseFrom, pill, typePill,
};
