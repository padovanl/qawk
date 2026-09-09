import { S, del, get, post, upload, waiting } from '../api.js';
import { ask, closeDrawer, drawer, fail, modal, toast } from '../chrome.js';
import { M_COLS, baseCell, cols, columnsDialog, fieldsFor, headsFor, metaCache } from '../columns.js';
import { $, h, icon } from '../dom.js';
import { fileField, toggle } from '../inputs.js';
import { VIEWS, drawNav, render } from '../router.js';
import { validateUpload } from '../swu.js';
import { exportCsv, filterRow, fiqlOf, pagedPath, pager, pg, tableOf } from '../table.js';
import { bytes } from '../util.js';

/* ------- software modules ------------------------------------------- */
VIEWS.sm = {
  title: 'Software modules',
  bar: () => [
    h('button.btn.sm', { onclick: () => columnsDialog('sm') }, icon('columns', 14), 'columns'),
    h('button.btn.sm', { onclick: () => exportCsv('software-modules.csv') }, icon('save', 14), 'export'),
    h('button.btn.sm.primary', { onclick: newSmDialog }, icon('plus', 14), 'new module'),
  ],
  async render(root) {
    const st = pg('sm');
    metaCache.clear(); waiting.length = 0;
    const fields = fieldsFor('sm');
    const chosen = cols('sm');
    const d = await get(pagedPath('/softwaremodules', st, fiqlOf(fields.filter(f => f.key), st), 'id:DESC'));
    if (!Object.values(st.f).some(Boolean)) { S.counts.sm = d.total; drawNav(); }
    if (!d.content.length && !Object.values(st.f).some(Boolean)) return root.replaceChildren(h('div.empty',
      h('b', 'No modules'), 'A module holds the .swu, and for a delta its .zck as well.'));
    root.replaceChildren(
      tableOf(headsFor('sm', chosen).concat(['']),
        d.content.map(m => ({
          onclick: () => openSm(m),
          cells: chosen.map(c => M_COLS[c].cell(m)).concat([h('span')]),
        })), filterRow(fields, st, render)),
      pager(st, d.total, render));
  },
};

async function openSm(m) {
  const body = h('div', h('div.empty', h('span.spin')));
  drawer(`${m.name} ${m.version}`, body);
  const draw = async () => {
    const arts = await get(`/softwaremodules/${m.id}/artifacts`).catch(() => []);
    const list = Array.isArray(arts) ? arts : (arts.content || []);
    const drop = fileField({ multiple: true });
    const file = drop.input;
    const checks = h('div.checks.hidden');
    const runChecks = async () => {
      const picked = [...file.files];
      checks.classList.remove('hidden');
      if (!picked.length) { checks.replaceChildren(h('div.bad', 'pick a file first')); return null; }
      checks.replaceChildren(h('div.faint', h('span.spin'), ' reading…'));
      try {
        const plan = await validateUpload(picked, m, list.map(a => a.providedFilename));
        checks.replaceChildren(...plan.notes.map(n => h('div.good', n)));
        return plan;
      } catch (e) {
        checks.replaceChildren(...String(e.message).split('\n').map(l => h('div.bad', l)));
        return null;
      }
    };
    const bar = h('i.run', { style: 'width:0%' });
    const pct = h('b', '0%');
    const prog = h('div.upl', { style: 'display:none' }, h('div.bars', bar), pct);
    body.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Module'), h('div.body', h('dl.kv',
        [['id', m.id], ['name', m.name], ['version', m.version], ['type', m.type],
         ['vendor', m.vendor || '—'], ['description', m.description || '—'],
         ['encrypted', String(!!m.encrypted)]].map(([k, v]) => [h('dt', k), h('dd', v)]),
        h('dt', 'delta base'), h('dd', baseCell(m.id))))),
      h('div.panel', h('h3', `Artifacts (${list.length})`), h('div.body',
        list.length
          ? tableOf(['File', 'Size', 'SHA-256', ''], list.map(a => ({
              cells: [h('span.mono', a.providedFilename), h('span.nowrap', bytes(a.size)),
                h('span.mono.faint', ((a.hashes && a.hashes.sha256) || '').slice(0, 16) + '…'),
                h('button.btn.sm.danger', { title: 'delete', onclick: async () => {
                    if (!await ask('Delete artifact', a.providedFilename, { danger: true })) return;
                    try { await del(`/softwaremodules/${m.id}/artifacts/${a.id}`); draw(); }
                    catch (e) { fail(e); } } }, 'delete')],
            })))
          : h('span.faint', 'nothing uploaded yet'))),
      h('div.panel', h('h3', 'Add artifacts'), h('div.body.stack',
        drop, checks, prog,
        h('div.wrap',
          h('button.btn', { onclick: () => runChecks() }, icon('check', 14), 'check'),
          h('button.btn.primary', { onclick: async e => {
              const b = e.currentTarget;
              const plan = await runChecks();
              if (!plan) return;
              b.classList.add('loading');
              prog.style.display = '';
              try {
                for (const f of plan.files) {
                  pct.textContent = f.name + ' 0%';
                  await upload(m.id, f, p => {
                    bar.style.width = (p * 100).toFixed(1) + '%';
                    pct.textContent = f.name + ' ' + (p * 100).toFixed(0) + '%';
                  });
                }
                toast('Uploaded', plan.files.map(f => f.name).join(', '), 'ok');
                draw();
              } catch (er) { fail(er); prog.style.display = 'none'; }
              finally { b.classList.remove('loading'); }
            } }, icon('upload', 14), 'upload')),
        h('p.faint', { style: 'margin:0;font-size:12px' },
          'Pick the .swu and, for a delta, its .zck together — the same checks ' +
          'upload-swu.sh makes are made here, before anything is sent.'))),

      h('button.btn.danger', { onclick: async () => {
          if (!await ask('Delete module', `${m.name} ${m.version}`, { danger: true })) return;
          try { await del('/softwaremodules/' + m.id); toast('Deleted', '', 'ok'); closeDrawer(); render(); }
          catch (e) { fail(e); } } }, icon('trash', 13), 'delete module')));
  };
  draw();
}

async function newSmDialog() {
  const types = await get('/softwaremoduletypes?limit=50');
  const name = h('input', { type: 'text' });
  const ver = h('input', { type: 'text' });
  const desc = h('input', { type: 'text' });
  const vendor = h('input', { type: 'text', value: 'QubicaAMF' });
  const type = h('select', types.content.map(t => h('option', { value: t.key }, `${t.name} (${t.key})`)));
  const encrypt = toggle(false, null, { label: 'enable artifact encryption' });
  modal('New software module', [
    h('label.f', 'Name', name), h('label.f', 'Version', ver),
    h('label.f', 'Description', desc), h('label.f', 'Vendor', vendor), h('label.f', 'Type', type),
    encrypt,
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'os for a system update, application for an app: the type is what tells hawkBit which it is, ' +
      'and an app given the os type would be treated as a slot change.'),
  ], async () => {
    if (!name.value.trim() || !ver.value.trim()) throw new Error('name and version are required');
    const b = { name: name.value.trim(), version: ver.value.trim(), type: type.value,
                vendor: vendor.value.trim() };
    if (desc.value.trim()) b.description = desc.value.trim();
    if (encrypt.input.checked) b.encrypted = true;
    await post('/softwaremodules', [b]);
    toast('Module created', `${b.name} ${b.version} · ${b.type}`, 'ok'); render();
  }, 'Create');
}

export {
  openSm,
};
