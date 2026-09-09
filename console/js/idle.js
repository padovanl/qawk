import { S } from './api.js';
import { signOut } from './auth.js';
import { toast } from './chrome.js';
import { $ } from './dom.js';

/* ------------------------------------------------------------ idle logout */
/* The credentials live in this tab and nowhere else, so closing it is logging
 * out -- but a console left open on a bench is a console anyone walking past
 * can deploy from. After a period with no mouse, key or touch, the tab forgets
 * them by itself.
 *
 * It counts real interaction, not requests: auto-refresh keeps talking to the
 * server on its own, and letting that count as presence would mean the timer
 * never fires. */
const IDLE_CHOICES = [
  [0, 'never'], [5, '5 min'], [15, '15 min'], [30, '30 min'],
  [60, '1 hour'], [240, '4 hours'],
];
function idleMin() {
  const v = Number(localStorage.getItem('hb-idle'));
  return IDLE_CHOICES.some(([n]) => n === v) ? v : 30;
}
function setIdleMin(v) {
  try { localStorage.setItem('hb-idle', String(v)); } catch (_) {}
  S.lastSeen = Date.now(); S.idleWarned = false;
}
S.lastSeen = Date.now();
S.idleWarned = false;

function idleTick() {
  const mins = idleMin();
  if (!mins || !S.auth) return;
  const left = mins * 60000 - (Date.now() - S.lastSeen);
  if (left <= 0) {
    signOut();
    toast('Signed out', `no activity for ${mins} minutes`, 'info', 15000);
    return;
  }
  // One warning, a minute out, so a long read is not thrown away silently.
  if (left <= 60000 && !S.idleWarned) {
    S.idleWarned = true;
    toast('About to sign out', 'a minute with no activity left — move the mouse to stay', 'err', 55000);
  }
}
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { S.lastSeen = Date.now(); S.idleWarned = false; },
    { passive: true, capture: true }));
setInterval(idleTick, 10000);

export {
  IDLE_CHOICES, idleMin, setIdleMin,
};
