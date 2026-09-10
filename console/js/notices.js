import { S, enc, get, waiting } from './api.js';
import { toast } from './chrome.js';
import { noticeOn } from './prefs.js';
import { $, h, icon } from './dom.js';
import { go } from './router.js';

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
const notify = (kind, ...args) => { if (noticeOn(kind)) toast(...args); };

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

/* EVERY deployment, not only the ones started from this tab.
 *
 * S.watched above follows what this browser assigned. During a rollout, or
 * when someone else is driving, the interesting things happen elsewhere --
 * and a console that says nothing while the fleet moves is not much of a
 * console. This watches the server's own action list.
 *
 * The first pass only records what is already there: announcing a deployment
 * that started before the page was opened would be noise, and on a busy server
 * it would be a wall of it. */
S.actionsSeen = null;          // id -> active, or null before the first look

async function deploymentsTick() {
  if (!S.auth) return;
  let list;
  try {
    list = await get('/actions?limit=25&sort=id:DESC');
  } catch (_) { return; }

  const now = new Map((list.content || []).map(a => [a.id, a]));
  if (S.actionsSeen === null) {
    S.actionsSeen = new Map([...now].map(([id, a]) => [id, a.active]));
    return;
  }

  for (const [id, a] of now) {
    const before = S.actionsSeen.get(id);
    if (before === undefined) {
      if (a.active) notify('deploy', 'Deployment started', `#${id} · ${a.type || 'update'}`, 'info', 6000);
    } else if (before === true && a.active === false) {
      // 'finished' only means it closed; a failure closes too, and the verdict
      // is the last thing the device said.
      const bad = ['error', 'canceled', 'cancel_rejected'].includes(String(a.status).toLowerCase());
      notify('deploy', bad ? 'Deployment ' + a.status : 'Deployment finished',
             `#${id}`, bad ? 'err' : 'ok', bad ? 20000 : 7000);
    }
    S.actionsSeen.set(id, a.active);
  }
  // keep the map from growing for ever on a long-lived tab
  if (S.actionsSeen.size > 400) {
    S.actionsSeen = new Map([...S.actionsSeen].slice(-200));
  }
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
  let sm, ds, ro;
  try {
    [sm, ds, ro] = await Promise.all([
      get('/softwaremodules?limit=50&sort=id:DESC'),
      get('/distributionsets?limit=50&sort=id:DESC'),
      get('/rollouts?limit=25&sort=id:DESC').catch(() => ({ content: [] })),
    ]);
  } catch (_) { return; }

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
  noteTargets, watchAction,
};
