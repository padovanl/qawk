import { hasBatch, statesOf } from './batch.js';
import { start } from './auth.js';
import { serverInfo } from './server.js';
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
  ['downloading', 'live', 'fetching the package. With Qawk the percentage is the bytes it has '
                        + 'sent -- a few MB ahead of the device, for the network\'s buffers. With '
                        + 'hawkBit, fetching and writing cannot be told apart: SWUpdate reports '
                        + 'nothing in between'],
  ['installing',  'live', 'Qawk only: every byte of the part has been delivered and the device '
                        + 'has not reported yet -- it is writing and verifying it'],

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
/* A combined set is installed one part at a time, so "downloading" gains a
   "(part 2)" while the second one is under way. */
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
const IN_ASSIGNED = 1, IN_DOWNLOAD = 2;

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
    // ORDER MATTERS, AND IT IS NOT THE ORDER OF THE WORDS. hawkBit's
    // "Installing Update Chunk Artifacts" is the ANNOUNCEMENT that a part has
    // started -- the downloads follow it. Treating it as "installing" meant the
    // pill said installing for a fraction of a second and then went back to
    // downloading for the whole transfer, so "installing" was effectively never
    // seen. It marks the start of a part.
    if (t === 'running' && /Installing Update Chunk/i.test(m)) { cur = IN_DOWNLOAD; continue; }
    if (t === 'download') { cur = IN_DOWNLOAD; continue; }
    // THERE IS NO "INSTALLING" TO SHOW, and pretending otherwise was worse
    // than not offering it. SWUpdate reports nothing between asking for the
    // first artifact and finishing the write: measured on two real updates,
    // the download entry lands at 01:37:18 and "Update successful", "Installed
    // Chunk" and "All Chunks Installed" all arrive together at 01:37:29. The
    // eleven seconds in between -- the transfer AND the write -- are silent,
    // and hawkBit exposes no progress counter to fill them (a status entry
    // carries a type, messages and a timestamp, nothing else).
    //
    // So the transfer phase covers both, and its tooltip says so. Splitting it
    // would mean guessing which half of the silence we were in.
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

  if (cur === IN_DOWNLOAD)
    return { label: 'downloading' + part, cls: 'live',
             why: (why ? why + '. ' : '')
                + 'fetching AND writing: SWUpdate reports nothing between asking for the '
                + 'first artifact and finishing, so these cannot be told apart' };
  if (cur === IN_ASSIGNED) return { label: 'assigned', cls: 'live', why: 'the device has not polled yet' };
  if (done > 0) return { label: 'downloading' + part, cls: 'live', why };
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
    const ph = phaseFrom(st.content || [], ds && ds.type);
    const dl = await downloads();
    return refine(ph, dl && dl.get(a.id));
  } catch (_) { return null; }
}

/* ---- Qawk: how far a download really is ---------------------------------
 *
 * hawkBit only knows what the device says, and SWUpdate says nothing between
 * asking for a file and having written it. Qawk serves the bytes itself and
 * counts them (/qawk/v1/downloads), so the phase can say how much has gone
 * and -- once the last byte is out and the device has not reported -- that it
 * is installing. One request for every row, at most every two seconds.
 */
let DL = { at: 0, byAction: null, pending: null };

async function downloads() {
  const info = serverInfo();
  if (!info || !(info.features || []).includes('download-progress')) return null;
  if (DL.byAction && Date.now() - DL.at < 2000) return DL.byAction;
  if (!DL.pending) {
    DL.pending = get('/qawk/v1/downloads', { abs: true }).then(r => {
      const m = new Map();
      for (const d of r.content || []) {
        if (!m.has(d.actionId)) m.set(d.actionId, []);
        m.get(d.actionId).push(d);
      }
      DL = { at: Date.now(), byAction: m, pending: null };
      return m;
    }).catch(() => { DL.pending = null; return null; });
  }
  return DL.pending;
}

const mb = n => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';

function refine(ph, dls) {
  if (!ph || !dls || !dls.length || !/^downloading/.test(ph.label)) return ph;
  // the part under way is the one that started last
  const d = dls.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
  const part = ph.label.slice('downloading'.length);   // " (part 2)" or ""
  if (d.completedAt)
    return { label: 'installing' + part, cls: 'live',
             why: `all ${mb(d.size)} delivered at ${new Date(d.completedAt).toLocaleTimeString()}; `
                + 'the device is writing it and has not reported yet' };
  return Object.assign({}, ph, {
    detail: d.percent != null ? `${d.percent}%` : mb(d.bytes),
    why: (d.ranged ? `a delta: ${mb(d.bytes)} of the parts it needs so far`
                   : `${mb(d.bytes)} of ${mb(d.size)} delivered`)
       + ' -- counted by Qawk as it sends them' });
}

/* A page of devices at once (Qawk): the same phase, from one request. */
function phaseFromState(s) {
  if (!s || !s.actionId) return null;
  if (s.active === false) return { closed: true };
  return refine(phaseFrom(s.statuses || [], s.dsType), s.downloads || []);
}

async function phasesOf(ids) {
  const out = new Map();
  if (!ids.length) return out;
  if (hasBatch()) {
    try {
      const st = await statesOf(ids);
      for (const [id, s] of st) { const ph = phaseFromState(s); if (ph) out.set(id, ph); }
      return out;
    } catch (_) { /* one by one, below */ }
  }
  await Promise.all(ids.map(async id => { const ph = await phaseOf(id); if (ph) out.set(id, ph); }));
  return out;
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
  if (ph.detail) p.append(h('span.faint', { style: 'margin-left:5px' }, '\u00b7 ' + ph.detail));
  p.title = (ph.why ? ph.why + '. ' : '')
          + 'the server calls this "pending"; the phase is read from what the device last reported'
          + ' and, with Qawk, from what it has been sent';
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
  paintPhase, phaseOf, phaseFromState, phasesOf,
  phaseFrom, pill, typePill,
};
