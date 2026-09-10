import { qawk } from '../api.js';
import { ask, fail, modal, toast } from '../chrome.js';
import { h, icon } from '../dom.js';
import { VIEWS, render } from '../router.js';
import { tableOf } from '../table.js';
import { ago } from '../util.js';

/* ------- users and roles (a Qawk addition) --------------------------- *
 *
 * hawkBit has one kind of user, written in its configuration file. Qawk keeps
 * them in its database: each with roles, a role being a named set of
 * hawkBit's own permissions. The administrator from the server's environment
 * is not listed here -- it always works, whatever these tables say. */
VIEWS.users = {
  title: 'Users and roles',
  bar: () => [
    h('button.btn.sm.primary', { onclick: () => userDialog() }, icon('plus', 14), 'new user'),
    h('button.btn.sm', { onclick: () => roleDialog() }, icon('plus', 14), 'new role')],
  async render(root) {
    const [us, rs] = await Promise.all([qawk.get('/users'), qawk.get('/roles')]);
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Users'), h('div.body',
        us.content.length
          ? tableOf(['User', 'Roles', 'State', 'Last sign-in', ''], us.content.map(u => ({
              cells: [
                h('span', h('b.mono', u.username), u.displayName ? h('span.faint', ' · ' + u.displayName) : null),
                u.roles.length ? h('span.wrap', u.roles.map(r => h('span.pill', r))) : h('span.faint', 'no role: can do nothing'),
                u.enabled ? h('span.pill.ok', 'enabled') : h('span.pill.err', 'disabled'),
                h('span.faint', u.lastLoginAt ? ago(u.lastLoginAt) : 'never'),
                h('div.wrap',
                  h('button.btn.sm', { onclick: () => userDialog(u, rs.content) }, 'edit'),
                  h('button.btn.sm', { onclick: () => passwordDialog(u) }, 'password'),
                  h('button.btn.sm.danger', { onclick: async () => {
                      if (!await ask('Delete user', `${u.username}\nTheir API tokens stop working too.`, { danger: true })) return;
                      try { await qawk.del('/users/' + u.id); render(); } catch (e) { fail(e); } } }, 'delete'))],
            })))
          : h('div.empty', h('b', 'No users yet'),
              'Only the administrator from the server\'s configuration can sign in. Add people with the roles they need.'))),
      h('div.panel', h('h3', 'Roles'), h('div.body',
        tableOf(['Role', 'Permissions', ''], rs.content.map(r => ({
          cells: [
            h('span', h('b', r.name), r.builtin ? h('span.pill', { style: 'margin-left:6px' }, 'built in') : null,
              r.description ? h('div.faint', r.description) : null),
            r.permissions.includes('*') ? h('span.pill.ok', 'every permission')
              : h('span.wrap', r.permissions.map(p => h('span.pill.mono', { style: 'font-size:11px' }, p))),
            r.builtin ? h('span.faint', '—') : h('div.wrap',
              h('button.btn.sm', { onclick: () => roleDialog(r) }, 'edit'),
              h('button.btn.sm.danger', { onclick: async () => {
                  if (!await ask('Delete role', `${r.name}\nUsers who have it lose it.`, { danger: true })) return;
                  try { await qawk.del('/roles/' + encodeURIComponent(r.name)); render(); } catch (e) { fail(e); } } }, 'delete'))],
        })))))));
  },
};

const checks = (all, on) => {
  const boxes = all.map(([value, label, hint]) => {
    const i = h('input', { type: 'checkbox', value, checked: on.includes(value) });
    return { i, el: h('label', { style: 'display:flex;gap:8px;align-items:baseline;margin:3px 0;cursor:pointer' },
      i, h('span', h('span.mono', label), hint ? h('span.faint', ' — ' + hint) : null)) };
  });
  return { el: h('div', { style: 'max-height:260px;overflow:auto' }, boxes.map(b => b.el)),
           value: () => boxes.filter(b => b.i.checked).map(b => b.i.value) };
};

async function userDialog(existing, roles) {
  roles = roles || (await qawk.get('/roles')).content;
  const u = existing || { username: '', displayName: '', roles: ['viewer'], enabled: true };
  const name = h('input', { type: 'text', value: u.username, disabled: !!existing });
  const display = h('input', { type: 'text', value: u.displayName || '' });
  const pw = h('input', { type: 'password', placeholder: existing ? 'leave empty to keep it' : 'at least 8 characters' });
  const enabled = h('select', h('option', { value: '1', selected: u.enabled }, 'enabled'),
    h('option', { value: '0', selected: !u.enabled }, 'disabled: cannot sign in'));
  const rc = checks(roles.map(r => [r.name, r.name, r.description]), u.roles);
  modal(existing ? 'Edit ' + u.username : 'New user', [
    h('label.f', 'User name', name), h('label.f', 'Display name', display),
    h('label.f', existing ? 'New password' : 'Password', pw),
    h('label.f', 'State', enabled), h('div.f', h('span', 'Roles'), rc.el),
  ], async () => {
    const b = { displayName: display.value.trim(), roles: rc.value(), enabled: enabled.value === '1' };
    if (pw.value) b.password = pw.value;
    if (existing) await qawk.put('/users/' + existing.id, b);
    else await qawk.post('/users', Object.assign(b, { username: name.value.trim() }));
    toast('Saved', existing ? u.username : name.value.trim(), 'ok'); render();
  }, 'Save');
}

function passwordDialog(u) {
  const pw = h('input', { type: 'password', placeholder: 'at least 8 characters' });
  modal('Password of ' + u.username, [h('label.f', 'New password', pw)], async () => {
    await qawk.put(`/users/${u.id}/password`, { password: pw.value });
    toast('Password changed', u.username, 'ok');
  }, 'Set');
}

async function roleDialog(existing) {
  const perms = (await qawk.get('/permissions')).content;
  const r = existing || { name: '', description: '', permissions: [] };
  const name = h('input', { type: 'text', value: r.name, disabled: !!existing });
  const desc = h('input', { type: 'text', value: r.description });
  const pc = checks(perms.map(p => [p.name, p.name, p.description]), r.permissions);
  modal(existing ? 'Edit role ' + r.name : 'New role', [
    h('label.f', 'Name', name), h('label.f', 'Description', desc), h('div.f', h('span', 'Permissions'), pc.el),
  ], async () => {
    const b = { name: name.value.trim(), description: desc.value.trim(), permissions: pc.value() };
    if (existing) await qawk.put('/roles/' + encodeURIComponent(r.name), b);
    else await qawk.post('/roles', b);
    toast('Saved', b.name, 'ok'); render();
  }, 'Save');
}

export { checks };
