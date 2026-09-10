import { qawk } from '../api.js';
import { ask, fail, modal, toast } from '../chrome.js';
import { h, icon } from '../dom.js';
import { VIEWS, render } from '../router.js';
import { serverInfo } from '../server.js';
import { tableOf } from '../table.js';
import { ago, when } from '../util.js';

/* ------- my account: who I am, my password, my API tokens (Qawk) ------ *
 *
 * A token is for a script: it signs in as you, with your permissions, and it
 * can be revoked without changing your password. It is shown once, when it is
 * made; the server keeps only its hash. */
let everyone = false;

VIEWS.account = {
  title: 'My account',
  bar: () => [h('button.btn.sm.primary', { onclick: tokenDialog }, icon('plus', 14), 'new API token')],
  async render(root) {
    const me = await qawk.get('/me');
    const ts = await qawk.get('/tokens' + (everyone && me.admin ? '?all=true' : ''));
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Signed in as'), h('div.body',
        h('div', h('b.mono', me.username), me.displayName ? h('span.faint', ' · ' + me.displayName) : null),
        h('div.wrap', { style: 'margin:6px 0' }, me.roles.map(r => h('span.pill', r))),
        h('div.faint', me.configured
          ? 'This is the administrator from the server\'s configuration: its password is QAWK_ADMIN_PASSWORD.'
          : `${me.permissions.length} permissions from your roles.`),
        me.configured ? null : h('button.btn.sm', { style: 'margin-top:8px', onclick: ownPasswordDialog }, 'change my password'))),
      h('div.panel', h('h3', 'API tokens'), h('div.body',
        me.admin ? h('label', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:8px' },
          h('input', { type: 'checkbox', checked: everyone, onchange: e => { everyone = e.target.checked; render(); } }),
          'show everyone\'s') : null,
        ts.content.length
          ? tableOf(['Name', 'Owner', 'Token', 'Created', 'Expires', 'Last used', ''], ts.content.map(t => ({
              cells: [h('b', t.name), h('span.mono', t.user), h('span.mono.faint', 'qawk_…' + t.hint),
                h('span.faint', when(t.createdAt)),
                t.expiresAt ? h('span' + (t.expiresAt < Date.now() ? '.pill.err' : '.faint'), when(t.expiresAt)) : h('span.faint', 'never'),
                h('span.faint', t.lastUsedAt ? ago(t.lastUsedAt) : 'never'),
                h('button.btn.sm.danger', { onclick: async () => {
                    if (!await ask('Revoke token', `${t.name}\nAnything using it stops working at once.`, { danger: true, okLabel: 'Revoke' })) return;
                    try { await qawk.del('/tokens/' + t.id); render(); } catch (e) { fail(e); } } }, 'revoke')],
            })))
          : h('div.empty', 'No tokens. Make one for each script or pipeline, so each can be revoked on its own.')))));
  },
};

function tokenDialog() {
  const name = h('input', { type: 'text', placeholder: 'e.g. release pipeline' });
  const days = h('select', [[30, '30 days'], [90, '90 days'], [365, 'a year'], [0, 'never: until revoked']].map(([v, l]) =>
    h('option', { value: v, selected: v === 90 }, l)));
  modal('New API token', [h('label.f', 'Name', name), h('label.f', 'Expires in', days)], async () => {
    const t = await qawk.post('/tokens', { name: name.value.trim(), expiresInDays: Number(days.value) });
    render();
    setTimeout(() => showToken(t), 0);
  }, 'Create');
}

function showToken(t) {
  const box = h('input.mono', { type: 'text', value: t.token, readonly: true, style: 'width:100%' });
  const me = serverInfo()?.me?.username || t.user;
  modal('Your new token', [
    h('p', h('b', 'Copy it now: it will not be shown again.')),
    box,
    h('p.faint', { style: 'font-size:12px' }, 'Use it as a bearer token, or as the password with your user name:'),
    h('pre.mono', { style: 'font-size:11px;white-space:pre-wrap;margin:0' },
      `curl -H "Authorization: Bearer ${t.token}" ${location.origin}/rest/v1/targets\n` +
      `curl -u ${me}:${t.token} ${location.origin}/rest/v1/targets`),
  ], async () => {
    try { await navigator.clipboard.writeText(t.token); toast('Copied', t.name, 'ok'); } catch (_) { box.select(); }
  }, 'Copy and close');
  box.select();
}

function ownPasswordDialog() {
  const cur = h('input', { type: 'password' });
  const pw = h('input', { type: 'password', placeholder: 'at least 8 characters' });
  const again = h('input', { type: 'password' });
  modal('Change my password', [h('label.f', 'Current password', cur), h('label.f', 'New password', pw),
    h('label.f', 'New password again', again)], async () => {
    if (pw.value !== again.value) throw new Error('the two new passwords differ');
    await qawk.put('/me/password', { current: cur.value, password: pw.value });
    // the console signs every request with the password: keep it in step
    const user = sessionStorage.getItem('hb-user');
    const auth = btoa(user + ':' + pw.value);
    sessionStorage.setItem('hb-auth', auth);
    const { S } = await import('../api.js');
    S.auth = auth;
    toast('Password changed', '', 'ok');
  }, 'Change');
}
