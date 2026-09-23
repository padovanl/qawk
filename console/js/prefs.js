// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

/* What the console is allowed to interrupt you about.
 *
 * A LEAF MODULE ON PURPOSE: it imports nothing. This list is read by the
 * watchers in notices.js, by api.js when the server comes back, and by the
 * Configuration view. Putting it in notices.js made api.js import notices.js,
 * which imports api.js -- and the cycle meant notices.js was evaluated before
 * api.js had created S, so the page died on load with "Cannot access 'S'
 * before initialization". Nothing here depends on anything, so nothing can.
 *
 * All on until someone says otherwise: a notification you did not ask for is
 * easy to turn off, one you never saw is not. The choice is per browser --
 * two people watching the same server want different things from it.
 */
const NOTICES = [
  ['deploy',     'Deployments',       'when one starts, and how it ended'],
  ['catalogue',  'Modules and sets',  'uploaded, created or deleted, by anyone'],
  ['rollout',    'Rollouts',          'created, deleted, and every status change'],
  ['devices',    'Devices',           'arriving and leaving the fleet'],
  ['watched',    'What you deployed', 'the result of a deployment started here'],
  ['connection', 'The server',        'when it comes back after being unreachable'],
];

const noticeOn = id => {
  try { return localStorage.getItem('hb-notice-' + id) !== '0'; } catch (_) { return true; }
};
const setNotice = (id, on) => {
  try { localStorage.setItem('hb-notice-' + id, on ? '1' : '0'); } catch (_) {}
};

export { NOTICES, noticeOn, setNotice };
