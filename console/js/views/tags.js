import { del, get, post } from '../api.js';
import { fail, modal, toast } from '../chrome.js';
import { $, h, icon } from '../dom.js';
import { VIEWS, render } from '../router.js';
import { tableOf } from '../table.js';

/* ------- tags -------------------------------------------------------- */
VIEWS.tags = {
  title: 'Tags',
  bar: () => [h('button.btn.sm.primary', { onclick: () => newTagDialog(render) }, icon('plus', 14), 'new tag')],
  async render(root) {
    const [tt, dt] = await Promise.all([
      get('/targettags?limit=100&sort=id:DESC'),
      get('/distributionsettags?limit=100&sort=id:DESC').catch(() => ({ content: [] }))]);
    const tbl = (rows, kind) => rows.length
      ? tableOf(['Id', 'Name', 'Colour', 'Description', ''], rows.map(t => ({
          cells: [h('span.mono', t.id), t.name,
            h('span.flex', h('span', { style: `display:inline-block;width:12px;height:12px;border-radius:3px;background:${t.colour || '#555'}` }),
              h('span.mono.faint', t.colour || '—')),
            h('span.faint', t.description || '—'),
            h('button.btn.sm.danger', { onclick: async () => {
                if (!confirm('Delete tag ' + t.name + '?')) return;
                try { await del(`/${kind}/${t.id}`); render(); } catch (e) { fail(e); } } }, 'delete')],
        })))
      : h('div.empty', 'none');
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Target tags'), h('div.body', tbl(tt.content, 'targettags'))),
      h('div.panel', h('h3', 'Distribution set tags'), h('div.body', tbl(dt.content, 'distributionsettags')))));
  },
};

async function newTagDialog(after) {
  const name = h('input', { type: 'text' });
  const colour = h('input', { type: 'color', value: '#3ba9a1' });
  const desc = h('input', { type: 'text' });
  const kind = h('select', h('option', { value: 'targettags' }, 'target tag'),
    h('option', { value: 'distributionsettags' }, 'distribution set tag'));
  modal('New tag', [h('label.f', 'Kind', kind), h('label.f', 'Name', name),
    h('label.f', 'Colour', colour), h('label.f', 'Description', desc)], async () => {
    if (!name.value.trim()) throw new Error('a name is required');
    const b = { name: name.value.trim(), colour: colour.value };
    if (desc.value.trim()) b.description = desc.value.trim();
    await post('/' + kind.value, [b]);
    toast('Created', b.name, 'ok'); if (after) after();
  }, 'Create');
}

export {
  newTagDialog,
};
