import { S, qawk } from '../api.js';
import { fail, modal, toast } from '../chrome.js';
import { fleetBadge } from '../chips.js';
import { h, icon } from '../dom.js';
import { VIEWS, go, render } from '../router.js';
import { tableOf } from '../table.js';

/* ------- centres: a device's centre is in a channel (Qawk) ---------------
 *
 * A device says which centre it is in (attribute.centerid). A centre is put
 * in a channel, and every device of it follows -- the 6hd with its st05 and
 * hyper, the neo-intel -- so moving a centre from beta to prod moves them
 * all. A single machine goes to a trade show through a temporary channel
 * (expo, Fleets → manage) and comes back when sent home. */
const fmt = n => Number(n || 0).toLocaleString('en-US');
const picked = new Set();
let filter = '', chanFilter = '';

function channel(c) {
  return c.fleet ? fleetBadge(c.fleet, c.colour) : h('span.faint', 'no channel');
}

function onChannel(c) {
  if (!c.fleetId) return h('span.faint', '—');
  if (c.onChannel === c.devices) return h('span.pill.ok', `all ${fmt(c.devices)}`);
  return h('span.pill.live', { title: 'the others are on their way, or lent to a temporary channel' },
    `${fmt(c.onChannel)} of ${fmt(c.devices)}`);
}

VIEWS.centres = {
  title: 'Centres',
  live: 5000,
  bar: () => [h('button.btn.sm', { onclick: settingsDialog }, icon('cfg', 14), 'centre field')],
  async render(root) {
    const [d, fleets] = await Promise.all([qawk.get('/centres'), qawk.get('/fleets').then(r => r.content).catch(() => [])]);
    VIEWS.centres.field = d.field;
    const channels = fleets.filter(f => !f.temporary);
    for (const k of [...picked]) if (!d.content.some(c => c.centre === k)) picked.delete(k);
    const count = id => d.content.filter(c => (id === '-' ? !c.fleetId : c.fleetId === id)).length;
    const chip = (v, label, n, colour) => h('button.btn.sm' + (chanFilter === v ? '.primary' : ''),
      { onclick: () => { chanFilter = chanFilter === v ? '' : v; render(); } },
      colour ? h('span.swatch-dot', { style: `--sw:${colour}` }) : null, `${label} · ${fmt(n)}`);

    const tableBox = h('div');
    const drawTable = () => {
      const q = filter.toLowerCase();
      const shown = d.content.filter(c => (!q || c.centre.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
        && (!chanFilter || (chanFilter === '-' ? !c.fleetId : String(c.fleetId) === chanFilter)));
      const all = h('input', { type: 'checkbox', checked: shown.length > 0 && shown.every(c => picked.has(c.centre)),
        title: 'select every centre shown',
        onclick: e => { shown.forEach(c => (e.target.checked ? picked.add(c.centre) : picked.delete(c.centre))); drawTable(); drawBulk(); } });
      tableBox.replaceChildren(shown.length
        ? tableOf([all, 'Centre', 'Channel', 'Devices', 'In its channel'], shown.map(c => ({
            key: c.centre,
            sel: picked.has(c.centre),
            onclick: () => { S.q = `${d.field}==${c.centre}`; S.status = ''; S.fleet = ''; go('targets'); },
            cells: [h('input', { type: 'checkbox', checked: picked.has(c.centre),
              onclick: e => { e.stopPropagation(); if (e.target.checked) picked.add(c.centre); else picked.delete(c.centre); drawTable(); drawBulk(); } }),
            h('b.mono', c.centre), channel(c), fmt(c.devices), onChannel(c)],
          })))
        : h('div.empty', d.total ? 'No centre matches.' : h('span', h('b', 'No centre yet'),
            ` — no device reports ${d.field}. Set the centre field if your devices say it elsewhere.`)));
    };

    const target = h('select', h('option', { value: '' }, '— to channel —'),
      channels.map(f => h('option', { value: f.id }, f.name)), h('option', { value: '0' }, 'no channel'));
    const bulk = h('div.flex', { style: 'gap:8px;flex-wrap:wrap;align-items:center' });
    const drawBulk = () => bulk.replaceChildren(
      h('span.faint', picked.size ? `${picked.size} centre${picked.size === 1 ? '' : 's'} selected` : 'select centres to move them'),
      target,
      h('button.btn.sm.primary', { disabled: !picked.size, onclick: async () => {
        if (target.value === '') { toast('Choose a channel', 'where the centres go', 'info'); return; }
        const n = picked.size;
        try {
          await qawk.put('/centres', { centres: [...picked], fleetId: Number(target.value) });
          toast('Moved', `${n} centre${n === 1 ? '' : 's'}: their devices follow`, 'ok');
          picked.clear(); render();
        } catch (e) { fail(e); }
      } }, 'move'));

    const search = h('input', { type: 'text', value: filter, placeholder: 'centre',
      oninput: e => { filter = e.target.value; drawTable(); } });
    drawTable(); drawBulk();
    root.replaceChildren(h('div.stack',
      h('div.panel', h('div.body.stack', { style: 'gap:10px' },
        h('div.wrap', { style: 'gap:6px' }, chip('', 'all', d.total),
          ...channels.map(f => chip(String(f.id), f.name, count(f.id), f.colour)), chip('-', 'no channel', count('-'))),
        h('div.flex', { style: 'gap:10px;flex-wrap:wrap;align-items:center' },
          h('div.search', { style: 'flex:1;min-width:200px' }, search), bulk))),
      h('div.panel', h('div.body', tableBox)),
      h('div.panel', h('h3', 'How it works'), h('div.body.faint',
        `A device says its centre with ${d.field}. A centre is in a channel, and every device of it follows — the 6hd `
        + 'with its st05 and hyper, and the neo-intel: move a centre and they all move, and get that channel\'s release '
        + '(the devices of a system: its system deployments). One machine going to a trade show is lent to a temporary '
        + 'channel from Fleets → manage, and comes back when sent home.'))));
  },
};

function settingsDialog() {
  const field = h('input.mono', { type: 'text', value: VIEWS.centres.field || 'attribute.centerid', placeholder: 'attribute.centerid' });
  modal('Centre field', [h('label.f', 'Where a device says which centre it is in', field),
    h('p.faint', { style: 'margin:0;font-size:12px' }, 'attribute.<key> (the device reports it) or metadata.<key> (set in Targets).')],
  async () => {
    await qawk.put('/centres/settings', { field: field.value.trim() });
    toast('Saved', field.value.trim(), 'ok'); render();
  }, 'Save');
}
