import { S, enc, fiql, get, qawk, waiting } from './api.js';
import { serverInfo } from './server.js';
import { toast } from './chrome.js';
import { noticeOn } from './prefs.js';
import { $, h, icon } from './dom.js';
import { drawNav, go } from './router.js';

/* ------------------------------------------------------- background notices */
/* THE TOASTS WORTH HAVING ARE THE ONES YOU DID NOT ASK FOR.
 *
 * Everything else here already answers a click, and a message that only repeats
 * what you just did is noise. What was missing is the other direction: things
 * that happen while you are looking somewhere else.
 *
 * Three, and no more, because a console that cries wolf gets ignored:
 *
 *   1. an action THIS console started reaching its end. You deploy, you go
 *      read something, and it tells you whether it landed. Only actions
 *      started here are watched: polling the whole fleet's history every ten
 *      seconds to find out would cost more than it is worth, and would report
 *      things nobody in this tab did.
 *   2. losing and regaining the server -- once per transition, not once per
 *      request. With auto-refresh on, a server that goes away would otherwise
 *      produce a failure every ten seconds.
 *   3. a target registering for the first time. That is the factory-device
 *      moment: it is the arrival you are waiting for and there is nothing else
 *      on screen that announces it. */
/* Every toast raised by a watcher goes through here, so turning a kind off
   turns off all of it and not merely most of it. */
const notify = (kind, ...args) => (noticeOn(kind) ? toast(...args) : null);

S.watched = new Map();      // actionId -> {target, label}
S.offline = false;
S.known = null;             // controllerIds seen so far, or null before the first list

function watchAction(actionId, target, label) {
  if (actionId) S.watched.set(String(actionId), { target, label });
}

async function noticesTick() {
  if (!S.auth) return;

  for (const [id, w] of [...S.watched]) {
    let a;
    try {
      a = await get(`/targets/${enc(w.target)}/actions/${id}`);
    } catch (_) { S.watched.delete(id); continue; }   // deleted, or no longer visible
    if (a.active) continue;

    // 'finished' only says it closed: a failed update closes too, and the
    // verdict is in the last status entry.
    let verdict = String(a.status || '').toLowerCase();
    try {
      const st = await get(`/targets/${enc(w.target)}/actions/${id}/status?limit=1&sort=id:DESC`);
      const e = (st.content || [])[0];
      if (e && ['error', 'canceled', 'cancel_rejected'].includes(String(e.type).toLowerCase())) {
        verdict = String(e.type).toLowerCase();
      }
    } catch (_) {}
    S.watched.delete(id);
    const ok = verdict === 'finished';
    notify('watched', ok ? 'Deployment finished' : 'Deployment ' + verdict,
      `${w.label} on ${w.target.slice(0, 16)}`, ok ? 'ok' : 'err', ok ? 8000 : 20000);
  }
}

// Called with each fresh target listing: the first one only records what is
// there, so opening the console does not announce the whole fleet.
function noteTargets(list) {
  // NOT FROM A PAGE ANY MORE: new devices are counted by the server, in
  // cataloguesTick. At ten thousand devices the sixty a page had just fetched
  // changed at every refresh, and each stranger in them was announced as new.
  return;
  // eslint-disable-next-line no-unreachable
  const ids = list.map(t => t.controllerId);
  if (S.known === null) { S.known = new Set(ids); return; }
  const fresh = ids.filter(i => !S.known.has(i));
  fresh.forEach(i => S.known.add(i));
  if (fresh.length === 1) notify('devices', 'New device', fresh[0], 'info', 12000);
  else if (fresh.length > 1) notify('devices', 'New devices', `${fresh.length} registered`, 'info', 12000);
  // ...and the mirror of it. This list is a page, so only say a device is gone
  // when the page is not simply showing different devices.
  if (list.length && ids.length >= S.known.size) {
    for (const old of [...S.known]) {
      if (ids.includes(old)) continue;
      S.known.delete(old);
      notify('devices', 'Device removed', old.slice(0, 24), 'mute', 9000);
    }
  }
}

/* EVERY DEPLOYMENT, AS AN OPERATOR THINKS OF ONE -- not every action.
 *
 * This used to announce each new action: "Deployment started #4127" --
 * nothing about which devices, which set or why -- and a wave of two thousand
 * devices buried the screen in two thousand of them. Against Qawk it follows
 * /qawk/v1/deployments instead: a fleet release, a rollout, a set assigned by
 * hand, a system deployment, each announced once when it starts, again when
 * its status changes (halted, paused, rolling back, waiting for approval),
 * when more of its devices fail, and when it is done -- with what it is and
 * how far it got. A click opens "In progress". Against hawkBit, one summary
 * toast per look, never one per action.
 *
 * The first look only records what is there: opening the page announces
 * nothing. */
S.deploySeen = null;
S.actionsSeen = null;
const fmtN = n => Number(n || 0).toLocaleString('en-US');
const KIND_WORD = { fleet: 'fleet', rollout: 'rollout', manual: 'assigned by hand:', system: 'system deployment' };

function openable(t) {
  if (t) { t.style.cursor = 'pointer'; t.title = 'open In progress'; t.addEventListener('click', () => go('inprog')); }
  return t;
}

async function deploymentsTick() {
  if (!S.auth) return;
  if (((serverInfo() || {}).features || []).includes('deployments')) return deploymentsTickQawk();
  let list;
  try { list = await get('/actions?limit=100&sort=id:DESC'); } catch (_) { return; }
  const now = new Map((list.content || []).map(a => [a.id, a]));
  if (S.actionsSeen === null) { S.actionsSeen = new Map([...now].map(([id, a]) => [id, a.active])); return; }
  let started = 0, finished = 0, failed = 0;
  for (const [id, a] of now) {
    const before = S.actionsSeen.get(id);
    if (before === undefined && a.active) started++;
    else if (before === true && a.active === false) {
      if (['error', 'canceled', 'cancel_rejected'].includes(String(a.status).toLowerCase())) failed++; else finished++;
    }
    S.actionsSeen.set(id, a.active);
  }
  if (started) notify('deploy', 'Deployments started', `${fmtN(started)} device${started === 1 ? '' : 's'} given an update`, 'info', 7000);
  if (finished || failed) {
    notify('deploy', failed ? 'Deployments closed, some failed' : 'Deployments finished',
      `${fmtN(finished)} finished${failed ? `, ${fmtN(failed)} failed` : ''}`, failed ? 'err' : 'ok', failed ? 15000 : 7000);
  }
  if (S.actionsSeen.size > 1000) S.actionsSeen = new Map([...S.actionsSeen].slice(-500));
}

async function deploymentsTickQawk() {
  let list;
  try { list = (await qawk.get('/deployments')).content || []; } catch (_) { return; }
  const key = d => `${d.kind}|${d.title}|${d.distributionSet}`;
  const now = new Map(list.map(d => [key(d), d]));
  if (S.deploySeen === null) { S.deploySeen = now; return; }
  const what = d => `${KIND_WORD[d.kind] || d.kind} ${d.title}`
    + (d.kind !== 'manual' && d.distributionSet ? ` · ${d.distributionSet}` : '');
  for (const [k, d] of now) {
    const was = S.deploySeen.get(k);
    if (!was) {
      openable(notify('deploy', d.status === 'waiting_for_approval' ? 'Waiting for approval' : 'Started',
        `${what(d)} — ${fmtN(d.total)} device${d.total === 1 ? '' : 's'}`
        + (d.detail && d.status === 'waiting_for_approval' ? ` (${d.detail})` : ''),
        d.status === 'waiting_for_approval' ? 'warn' : 'info', 9000));
      continue;
    }
    if (was.status !== d.status) {
      const bad = ['halted', 'paused', 'rolling_back', 'failed'].includes(d.status);
      openable(notify('deploy', bad ? `${what(d)}: ${String(d.status).replace(/_/g, ' ')}` : `Now ${String(d.status).replace(/_/g, ' ')}`,
        bad ? (d.detail || '').split('\n').pop() : what(d), bad ? 'err' : 'info', bad ? 30000 : 8000));
    }
    if ((d.failed || 0) > (was.failed || 0)) {
      openable(notify('deploy', `${fmtN(d.failed - was.failed)} more failed`,
        `${what(d)} — ${fmtN(d.failed)} of ${fmtN(d.total)} failed so far`, 'err', 15000));
    }
  }
  for (const [k, was] of S.deploySeen) {
    if (now.has(k)) continue;
    openable(notify('deploy', 'Done', `${what(was)} — ${fmtN(was.done)} of ${fmtN(was.total)} on it`
      + (was.failed ? `, ${fmtN(was.failed)} failed` : ''), was.failed ? 'warn' : 'ok', 9000));
  }
  S.deploySeen = now;
}

/* THE CATALOGUE FILLING UP, from wherever it is being filled.
 *
 * Most of what lands on this server is put there by a script -- the upload
 * tools, load-demo-catalogue.sh -- not by anyone clicking in this tab. A
 * console that only reports its own clicks says nothing at exactly the moment
 * a demonstration is being set up in front of you.
 *
 * As with deployments, the first look only records what is already there:
 * opening the page must not announce the whole catalogue. */
S.catalogueSeen = null;        // { sm:Set, ds:Set } or null before the first look

async function cataloguesTick() {
  if (!S.auth) return;
  let sm, ds, ro, tg;
  try {
    [sm, ds, ro, tg] = await Promise.all([
      get('/softwaremodules?limit=50&sort=id:DESC'),
      get('/distributionsets?limit=50&sort=id:DESC'),
      get('/rollouts?limit=25&sort=id:DESC').catch(() => ({ content: [] })),
      get('/targets?limit=5&sort=createdAt:DESC').catch(() => null),
    ]);
  } catch (_) { return; }

  /* THE COUNTS BESIDE THE MENU, kept honest from here.
   *
   * Each view used to set only its own: open Targets and the Targets badge was
   * right while Distribution sets stayed at whatever it said when you last
   * looked at it. Since this already asks for the totals every few seconds,
   * they cost nothing extra -- only the target count is an added request, and
   * it is limit=1. */
  S.counts.sm = sm.total;
  S.counts.ds = ds.total;
  if (ro && ro.total !== undefined) S.counts.ro = ro.total;
  if (tg && tg.total !== undefined) S.counts.targets = tg.total;
  drawNav();

  // NEW DEVICES, counted by the server: those registered after the newest one
  // seen before. Removed ones: the total going down.
  if (tg && tg.content) {
    const newest = Math.max(0, ...tg.content.map(t => t.createdAt || 0));
    if (S.newestSeen == null) S.newestSeen = newest;
    else if (newest > S.newestSeen) {
      const since = S.newestSeen;
      S.newestSeen = newest;
      const n = await get('/targets?limit=1&q=' + fiql(`createdat=gt=${since}`)).then(r => r.total).catch(() => 0);
      if (n === 1) notify('devices', 'New device', tg.content[0].controllerId, 'info', 12000);
      else if (n > 1) notify('devices', 'New devices', `${n.toLocaleString('en-US')} registered`, 'info', 12000);
    }
    if (S.targetTotal != null && tg.total < S.targetTotal) {
      const gone = S.targetTotal - tg.total;
      notify('devices', gone === 1 ? 'Device removed' : 'Devices removed', `${gone.toLocaleString('en-US')} fewer`, 'mute', 9000);
    }
    S.targetTotal = tg.total;
  }

  const seenOf = r => new Map((r.content || []).map(x => [x.id, x]));
  const now = { sm: seenOf(sm), ds: seenOf(ds), ro: seenOf(ro) };
  if (S.catalogueSeen === null) {
    S.catalogueSeen = {
      sm: new Map([...now.sm].map(([k, v]) => [k, v.name + ' ' + v.version])),
      ds: new Map([...now.ds].map(([k, v]) => [k, v.name + ' ' + v.version])),
      ro: new Map([...now.ro].map(([k, v]) => [k, v.status])),
    };
    return;
  }

  /* GONE MEANS DELETED, but only inside the window we can see. These lists are
     the newest 50: an id can leave because fifty newer ones arrived, which is
     not a deletion. Anything below the oldest id still on the page is out of
     view, so it is left alone rather than announced as removed. */
  const floor = list => ((list.content || []).length
    ? Math.min(...list.content.map(x => x.id)) : 0);

  const watch = (kind, list, label, describe, newTitle, goneTitle) => {
    const was = S.catalogueSeen[kind];
    const low = floor(list);
    for (const [id, x] of now[kind]) {
      if (!was.has(id)) notify('catalogue', newTitle, describe(x), label(x), 7000);
      was.set(id, kind === 'ro' ? x.status : x.name + ' ' + x.version);
    }
    for (const [id, what] of [...was]) {
      if (now[kind].has(id) || id < low) continue;
      was.delete(id);
      notify('catalogue', goneTitle, what, 'mute', 7000);
    }
  };

  watch('sm', sm, () => 'ok',
        m => `${m.name} ${m.version} · ${m.type}`,
        'Software module uploaded', 'Software module deleted');
  watch('ds', ds, d => (d.complete ? 'ok' : 'warn'),
        d => `${d.name} ${d.version} · ${d.type}${d.complete ? '' : ' — INCOMPLETE'}`,
        'Distribution set created', 'Distribution set deleted');

  // A rollout is worth hearing about when it appears AND when it moves: it is
  // the one thing here that runs for a while on its own.
  const wasRo = S.catalogueSeen.ro;
  for (const [id, r] of now.ro) {
    const before = wasRo.get(id);
    if (before === undefined) notify('rollout', 'Rollout created', `${r.name} · ${r.status}`, 'info', 7000);
    else if (before !== r.status) {
      const done = ['finished', 'stopped'].includes(String(r.status).toLowerCase());
      notify('rollout', 'Rollout ' + r.status, r.name, done ? 'ok' : 'info', 7000);
    }
    wasRo.set(id, r.status);
  }
  const roLow = floor(ro);
  for (const [id, name] of [...wasRo]) {
    if (now.ro.has(id) || id < roLow) continue;
    wasRo.delete(id);
    notify('rollout', 'Rollout deleted', String(name), 'mute', 7000);
  }
}

setInterval(noticesTick, 10000);
deploymentsTick();
setInterval(deploymentsTick, 8000);
cataloguesTick();
setInterval(cataloguesTick, 8000);

/* A tab opened before the last rebuild goes on running the JavaScript it
   already holds: no-store stops the cache, it does not reload a live page.
   The server says which build it is serving, so a stale tab can say so itself
   instead of letting someone chase a fix that has already shipped. */
let BUILD = null, buildAnnounced = false;
async function buildTick() {
  try {
    const r = await fetch('_build', { cache: 'no-store' });
    if (!r.ok) return;
    const { build } = await r.json();
    if (!BUILD) { BUILD = build; return; }
    if (build === BUILD || buildAnnounced) return;
    buildAnnounced = true;
    $('#toasts').append(h('div.toast.info.sticky',
      h('b', 'Console updated'),
      h('div.m', 'This tab is still running the previous build.'),
      h('button.btn.sm.primary', { onclick: () => location.reload() },
        icon('refresh', 13), 'reload')));
  } catch (_) { /* the page is static: a hiccup here is not worth a noise */ }
}
buildTick();
setInterval(buildTick, 15000);

export {
  cataloguesTick, noteTargets, watchAction,
};
