import { distributionSets, qawk } from '../api.js';
import { ask, drawer, fail, modal, toast } from '../chrome.js';
import { h, icon } from '../dom.js';
import { check as fiqlCheck, fiqlEditor } from '../fiql.js';
import { colourPicker } from '../inputs.js';
import { VIEWS, render } from '../router.js';
import { tableOf } from '../table.js';
import { ago } from '../util.js';

/* ------- fleets (a Qawk addition) ------------------------------------ *
 *
 * Beta, production, staging: sets of devices that should run the same release.
 * A device is in at most one fleet. It gets there by hand, or by the fleet's
 * rule -- a target query, checked every ten seconds against devices that are
 * in no fleet yet, so a machine that registers for the first time lands where
 * it belongs from what it says about itself. A fleet with a release gives it
 * to every member that does not run it; "promote" copies one fleet's release
 * to another, which is the whole beta -> production step in one click.
 *
 * Nothing here needs the device to know: it is still plain hawkBit DDI. */
VIEWS.fleets = {
  title: 'Fleets',
  bar: () => [h('button.btn.sm.primary', { onclick: () => fleetDialog() }, icon('plus', 14), 'new fleet')],
  async render(root) {
    const d = await qawk.get('/fleets');
    const fleets = d.content;
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'What these are for'), h('div.body.faint',
        'A fleet is a group of devices that should run the same release — beta, production, a customer site. ' +
        'Devices join by hand or by the fleet\'s rule, a target query checked against devices in no fleet yet. ' +
        'Give a fleet a release and every member gets it; promote copies one fleet\'s release to another.')),
      fleets.length
        ? tableOf(['Fleet', 'Rule', 'Release', 'Members', 'On release', ''], fleets.map(f => ({
            cells: [
              h('span.flex', h('span.swatch-dot', { style: `--sw:${f.colour || '#8b8f98'}` }),
                h('b', f.name), f.description ? h('span.faint', ' · ' + f.description) : null),
              f.rule ? h('span.mono.faint', f.rule) : h('span.faint', 'by hand'),
              f.distributionSet
                ? h('span', h('span.pill.ok', f.distributionSet), h('span.dim', ' ' + f.actionType))
                : h('span.faint', 'none'),
              h('span.mono', String(f.members)),
              progress(f),
              h('div.wrap',
                h('button.btn.sm', { onclick: () => membersDrawer(f) }, 'members'),
                h('button.btn.sm', { onclick: () => promoteDialog(f, fleets) }, 'promote'),
                h('button.btn.sm', { onclick: () => fleetDialog(f) }, 'edit'),
                h('button.btn.sm.danger', { onclick: async () => {
                    if (!await ask('Delete fleet', `${f.name}\nIts ${f.members} devices stay, in no fleet.`, { danger: true })) return;
                    try { await qawk.del('/fleets/' + f.id); render(); } catch (e) { fail(e); } } }, 'delete'))],
          })))
        : h('div.empty', h('b', 'No fleets'), 'Create beta and production, then promote from one to the other.')));
  },
};

function progress(f) {
  if (!f.distributionSet) return h('span.faint', '—');
  const pct = f.members ? Math.round(100 * f.onRelease / f.members) : 0;
  return h('span.flex',
    h('span.mono', `${f.onRelease}/${f.members}`),
    h('span.bar', { style: 'display:inline-block;width:70px;height:6px;border-radius:3px;background:var(--line,#ddd);overflow:hidden' },
      h('span', { style: `display:block;height:100%;width:${pct}%;background:var(--ok,#12a594)` })),
    f.updating ? h('span.pill', `${f.updating} updating`) : null,
    f.failed ? h('span.pill.err', `${f.failed} failed`) : null);
}

async function fleetDialog(existing) {
  const f = existing || {};
  const name = h('input', { type: 'text', value: f.name || '' });
  const desc = h('input', { type: 'text', value: f.description || '' });
  const colour = colourPicker(f.colour || '#12a594', { nameEl: name });
  const rule = fiqlEditor({ entity: 'targets', value: f.rule || '' });
  const sets = await distributionSets(true);
  const ds = h('select', h('option', { value: '0' }, '— none: members are left alone —'),
    sets.content.filter(d => d.complete).map(d => h('option',
      { value: d.id, selected: f.distributionSetId === d.id }, `${d.name} ${d.version} · ${d.type}`)));
  const type = h('select', ['forced', 'soft'].map(t =>
    h('option', { value: t, selected: (f.actionType || 'forced') === t }, t)));
  modal(existing ? 'Edit fleet' : 'New fleet', [
    h('label.f', 'Name', name), h('label.f', 'Description', desc), h('label.f', 'Colour', colour),
    h('label.f', 'Rule (optional)', rule),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'Devices in no fleet that match the rule join this one, including devices that register later. ' +
      'Leave it empty to add members by hand.'),
    h('label.f', 'Release', ds), h('label.f', 'Mode', type),
  ], async () => {
    if (!name.value.trim()) throw new Error('a name is required');
    if (rule.value.trim()) {
      const v = fiqlCheck(rule.value, 'targets');
      if (!v.ok) throw new Error(v.msg);
    }
    const b = { name: name.value.trim(), description: desc.value.trim(), colour: colour.value,
      rule: rule.value.trim(), distributionSetId: Number(ds.value), actionType: type.value };
    if (existing) await qawk.put('/fleets/' + existing.id, b);
    else await qawk.post('/fleets', b);
    toast('Saved', b.name, 'ok'); render();
  }, 'Save');
}

function promoteDialog(to, fleets) {
  const others = fleets.filter(o => o.id !== to.id && o.distributionSetId);
  if (!others.length) { toast('Nothing to promote', 'no other fleet runs a release yet', 'info'); return; }
  const from = h('select', others.map(o => h('option', { value: o.id }, `${o.name} — ${o.distributionSet}`)));
  modal('Promote to ' + to.name, [
    h('label.f', 'Take the release of', from),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      `Every device in ${to.name} that does not run it gets it within ten seconds.`),
  ], async () => {
    const r = await qawk.post(`/fleets/${to.id}/promote`, { from: Number(from.value) });
    toast('Promoted', `${to.name} now gets ${r.distributionSet}`, 'ok'); render();
  }, 'Promote');
}

async function membersDrawer(f) {
  const box = h('div.stack');
  const load = async () => {
    const d = await qawk.get(`/fleets/${f.id}/targets?limit=500`);
    const add = h('input', { type: 'text', placeholder: 'controller ids, comma separated' });
    box.replaceChildren(
      h('div.flex', add, h('button.btn.sm.primary', { onclick: async () => {
        const ids = add.value.split(/[\s,]+/).filter(Boolean);
        if (!ids.length) return;
        try { await qawk.put(`/fleets/${f.id}/targets`, ids); await load(); render(); } catch (e) { fail(e); }
      } }, 'add')),
      h('div.faint', `${d.total} device${d.total === 1 ? '' : 's'}`),
      d.content.length
        ? tableOf(['Device', 'Status', 'Runs', 'Should run', 'Last poll', ''], d.content.map(t => ({
            cells: [h('span.mono', t.controllerId), h('span.dim', t.updateStatus),
              t.installed || h('span.faint', '—'), t.assigned || h('span.faint', '—'),
              t.lastControllerRequestAt ? h('span.faint', ago(t.lastControllerRequestAt)) : h('span.faint', 'never'),
              h('button.btn.sm', { onclick: async () => {
                try { await qawk.delJSON(`/fleets/${f.id}/targets`, [t.controllerId]); await load(); render(); }
                catch (e) { fail(e); } } }, 'remove')],
          })))
        : h('div.empty', 'no members'));
  };
  drawer(f.name, box);
  try { await load(); } catch (e) { fail(e); }
}
