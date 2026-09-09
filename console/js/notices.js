import { S, enc, get, waiting } from './api.js';
import { toast } from './chrome.js';
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
    toast(ok ? 'Deployment finished' : 'Deployment ' + verdict,
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
  if (fresh.length === 1) toast('New device', fresh[0], 'info', 12000);
  else if (fresh.length > 1) toast('New devices', `${fresh.length} registered`, 'info', 12000);
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
      if (a.active) toast('Deployment started', `#${id} · ${a.type || 'update'}`, 'info', 6000);
    } else if (before === true && a.active === false) {
      // 'finished' only means it closed; a failure closes too, and the verdict
      // is the last thing the device said.
      const bad = ['error', 'canceled', 'cancel_rejected'].includes(String(a.status).toLowerCase());
      toast(bad ? 'Deployment ' + a.status : 'Deployment finished',
            `#${id}`, bad ? 'err' : 'ok', bad ? 20000 : 7000);
    }
    S.actionsSeen.set(id, a.active);
  }
  // keep the map from growing for ever on a long-lived tab
  if (S.actionsSeen.size > 400) {
    S.actionsSeen = new Map([...S.actionsSeen].slice(-200));
  }
}

setInterval(noticesTick, 10000);
deploymentsTick();
setInterval(deploymentsTick, 8000);

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
