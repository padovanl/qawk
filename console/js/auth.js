import { S, get } from './api.js';
import { checkCompat } from './compat.js';
import { whoIsServer } from './server.js';
import { $, h, icon } from './dom.js';
import { VIEWS, drawNav, refreshCounts, render, tick } from './router.js';
import { theme } from './theme.js';

/* ---------------------------------------------------------------- auth */
function signOut() {
  sessionStorage.removeItem('hb-auth'); sessionStorage.removeItem('hb-user');
  S.auth = ''; clearInterval(S.timer);
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
}

async function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#conn').textContent = S.user + ' @ hawkBit';
  S.view = (location.hash || '#dash').slice(1);
  if (!VIEWS[S.view]) S.view = 'dash';
  drawNav(); refreshCounts(); await render(); tick();
  // Asked once, in the background: it costs one request and must never hold
  // up the first screen.
  checkCompat();
  whoIsServer().then(drawNav);
}

/* Sign-in dressing: the field icons, a reveal for the password, and a theme
   picker here too -- the choice should not have to wait until you are in. */
$('#i-user').append(icon('user', 15));
$('#i-lock').append(icon('lock', 15));
$('#reveal').append(icon('eye', 15));
$('#reveal').onclick = () => {
  const p = $('#p'), shown = p.type === 'text';
  p.type = shown ? 'password' : 'text';
  $('#reveal').replaceChildren(icon(shown ? 'eye' : 'eyeoff', 15));
  $('#reveal').title = shown ? 'show password' : 'hide password';
  p.focus();
};

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#signin');
  if (btn.disabled) return;                       // no double submit on a slow server
  S.auth = btoa($('#u').value + ':' + $('#p').value); S.user = $('#u').value;
  btn.disabled = true;
  btn.replaceChildren(h('span.spin'), 'signing in…');
  try {
    await get('/targets?limit=1');
    sessionStorage.setItem('hb-auth', S.auth); sessionStorage.setItem('hb-user', S.user);
    $('#login-err').classList.add('hidden');
    start();
  } catch (err) {
    S.auth = '';
    // 401 is the ordinary case and deserves plain words; anything else is the
    // server or the network, and the raw message is the useful thing.
    const bad = /401|unauthor/i.test(err.message || '');
    const box = $('#login-err');
    box.replaceChildren(icon('info', 14),
      h('span', bad ? 'Wrong user or password.' : err.message));
    box.classList.remove('hidden');
    box.classList.remove('banner-err'); void box.offsetWidth;   // replay the shake
    box.classList.add('banner-err');
    $('#p').focus(); $('#p').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

export {
  signOut, start,
};
