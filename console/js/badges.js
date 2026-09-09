import { start } from './auth.js';
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
function actionPill(a) {
  const st = String(a.status || '').toLowerCase();
  if (a.active !== false) return pill(st, ACTION_PILL[st]);
  if (TERMINAL.has(st)) return pill(st, ACTION_PILL[st]);
  const p = pill(st, 'mute');
  p.title = `the action is closed; "${st}" is only the last thing the device `
          + 'reported about it, which can arrive after the closing feedback';
  p.append(h('span', { style: 'opacity:.7;margin-left:5px' }, '\u00b7 closed'));
  return p;
}

export {
  ACTION_PILL, ACT_ICON, TARGET_PILL, actionPill, pill, typePill,
};
