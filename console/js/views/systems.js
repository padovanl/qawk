import { S, distributionSets, qawk } from '../api.js';
import { bars } from '../bars.js';
import { fleetBadge } from '../chips.js';
import { ask, drawer, fail, modal, refreshDrawer, toast } from '../chrome.js';
import { h, icon } from '../dom.js';
import { check as fiqlCheck } from '../fiql.js';
import { VIEWS, render } from '../router.js';
import { tableOf } from '../table.js';
import { ago, download } from '../util.js';

/* ------- systems: updated as a whole, after Mender Orchestrator (Qawk) --
 *
 * A system is devices that work together -- a 6hd and the two st05 and the
 * hyper under it; a centre has many -- a hundred or more -- and a neo-intel
 * stands alone. Its
 * TYPE (Mender's topology) lists the components, each recognised by a query,
 * and names the field a device carries to say which system it is in
 * (metadata.system). A
 * MANIFEST says what a type should run: a set per component, and an order --
 * lower first, equal together. A DEPLOYMENT applies a manifest to the systems
 * of the type, a few at a time; when one device of a system fails, the whole
 * system goes back to what it ran before, and the others go on.
 *
 * Mender runs this on a device of each system; Qawk runs it on the server.
 * Nothing on the devices changes. Topologies and manifests also come and go
 * as Mender's YAML. */
const fmt = n => Number(n || 0).toLocaleString('en-US');
const RUN_CLS = { pending: 'mute', running: 'live', succeeded: 'ok', rolling_back: 'amber', rolled_back: 'err', skipped: 'mute' };
const SD_CLS = { draft: 'mute', running: 'live', paused: 'amber', finished: 'ok', failed: 'err', aborted: 'mute' };

async function rawPost(path, text) {
  const r = await fetch('/qawk/v1' + path, {
    method: 'POST', body: text,
    headers: { Authorization: 'Basic ' + S.auth, 'Content-Type': 'application/yaml' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'HTTP ' + r.status);
  return j;
}

async function rawGet(path) {
  const r = await fetch('/qawk/v1' + path, { headers: { Authorization: 'Basic ' + S.auth } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

VIEWS.systems = {
  title: 'Systems',
  live: 4000,
  bar: () => [
    h('button.btn.sm.primary', { onclick: () => deploymentDialog() }, icon('deploy', 14), 'deploy a manifest'),
    h('button.btn.sm', { onclick: () => typeDialog() }, icon('plus', 14), 'system type'),
    h('button.btn.sm', { onclick: () => manifestDialog() }, icon('plus', 14), 'manifest'),
    h('button.btn.sm', { onclick: importDialog }, icon('upload', 14), 'import YAML')],
  async render(root) {
    const [types, mans, deps] = await Promise.all([
      qawk.get('/systemtypes'), qawk.get('/manifests'), qawk.get('/systemdeployments')]);
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Deployments'), h('div.body',
        deps.content.length ? tableOf(['Deployment', 'Manifest', 'Systems', 'Status', ''], deps.content.map(d => ({
          onclick: () => runsDrawer(d.id),
          cells: [h('div', h('b', d.name), h('div.faint', { style: 'font-size:11px' },
            (d.fleet ? 'channel ' + d.fleet : 'every channel') + (d.groups && d.groups.length ? ' · ' + d.groups.join(', ') : ''))),
            h('span.mono', d.manifest), systemsBar(d),
            h('span', h('span.pill.' + (SD_CLS[d.status] || 'mute'), d.status),
              d.reason ? h('div.faint', { style: 'font-size:11px;max-width:320px' }, d.reason) : null),
            h('div.wrap', { onclick: e => e.stopPropagation() }, commands(d))],
        }))) : h('div.empty', h('b', 'Nothing deployed yet'),
          'Describe a system type, write a manifest for it, then deploy the manifest.'))),
      h('div.panel', h('h3', 'System types'), h('div.body',
        types.content.length ? tableOf(['Type', 'System key', 'Components', ''], types.content.map(t => ({
          cells: [h('b', t.name), h('span.mono', t.systemKey),
            h('div.wrap', t.components.map(c => h('span.pill', { title: c.match }, c.componentType))),
            h('div.wrap',
              h('button.btn.sm', { onclick: () => systemsDrawer(t) }, 'systems'),
              h('button.btn.sm', { onclick: () => typeDialog(t) }, 'edit'),
              h('button.btn.sm', { onclick: async () => download(`${t.name}-topology.yaml`, await rawGet(`/systemtypes/${t.id}/topology.yaml`)) }, 'YAML'),
              h('button.btn.sm.danger', { onclick: async () => {
                if (!await ask('Delete system type', `${t.name}\nIts manifests go with it.`, { danger: true })) return;
                try { await qawk.del('/systemtypes/' + t.id); render(); } catch (e) { fail(e); } } }, 'delete'))],
        }))) : h('div.empty', 'No system type yet: describe one, or import a Mender topology.'))),
      h('div.panel', h('h3', 'Manifests'), h('div.body',
        mans.content.length ? tableOf(['Manifest', 'Type', 'Components in order', ''], mans.content.map(m => ({
          cells: [h('b', m.name), m.systemType, orderLine(m.components),
            h('div.wrap',
              h('button.btn.sm', { onclick: () => deploymentDialog(m) }, 'deploy'),
              h('button.btn.sm', { onclick: () => manifestDialog(m) }, 'edit'),
              h('button.btn.sm', { onclick: async () => download(`${m.name}.yaml`, await rawGet(`/manifests/${m.id}/manifest.yaml`)) }, 'YAML'),
              h('button.btn.sm.danger', { onclick: async () => {
                if (!await ask('Delete manifest', m.name, { danger: true })) return;
                try { await qawk.del('/manifests/' + m.id); render(); } catch (e) { fail(e); } } }, 'delete'))],
        }))) : h('div.empty', 'No manifest yet.'))),
      h('div.panel', h('h3', 'How it works'), h('div.body.faint',
        'Inside each system the components go in the manifest\'s order — lower first, equal together — and a component ' +
        'already on its set is left alone. When one device of a system fails, every device of that system the deployment ' +
        'updated goes back to what it ran before; the other systems go on. "Systems at a time" limits how many are updated ' +
        'together; once more systems have failed than allowed, no new one is started.'))));
  },
};

// "st05 · hyper → hd": the orders, as steps.
function orderLine(comps) {
  const byOrder = new Map();
  comps.forEach(c => { if (!byOrder.has(c.order)) byOrder.set(c.order, []); byOrder.get(c.order).push(c); });
  const steps = [...byOrder.entries()].sort((a, b) => a[0] - b[0]);
  return h('span.flex', { style: 'gap:6px;flex-wrap:wrap' }, steps.flatMap(([o, cs], i) => [
    i ? h('span.faint', '→') : null,
    h('span', { title: `order ${o}` }, cs.map((c, j) => [j ? ' · ' : '', h('b', c.componentType), h('span.faint', ' ' + c.distributionSet)]))]));
}

function systemsBar(d) {
  const c = d.counts || {};
  const tot = d.total || 0;
  return h('div', { style: 'min-width:160px' },
    bars([[c.succeeded, 'ok', `${fmt(c.succeeded)} updated`], [c.running, 'run', `${fmt(c.running)} updating`],
      [c.rolling_back, 'back', `${fmt(c.rolling_back)} going back`], [c.rolled_back, 'err', `${fmt(c.rolled_back)} rolled back`]],
    tot, { key: 'sd' + d.id }),
    h('div.faint', { style: 'font-size:11px;margin-top:3px' },
      `${fmt(c.succeeded)} updated · ${fmt(c.running)} updating` + (c.rolled_back ? ` · ${fmt(c.rolled_back)} rolled back` : '')
      + ` · of ${fmt(tot)}`));
}

function commands(d) {
  const cmd = (name, label, cls = '') => h('button.btn.sm' + cls, { onclick: async () => {
    try { await qawk.post(`/systemdeployments/${d.id}/${name}`, {}); toast(label, d.name, 'ok'); render(); } catch (e) { fail(e); }
  } }, label);
  return [
    d.status === 'draft' ? cmd('start', 'start', '.primary') : null,
    d.status === 'running' ? cmd('pause', 'pause') : null,
    d.status === 'paused' ? cmd('resume', 'resume', '.primary') : null,
    ['running', 'paused'].includes(d.status) ? cmd('abort', 'abort', '.danger') : null,
    !['running', 'paused'].includes(d.status) ? h('button.btn.sm.danger', { onclick: async () => {
      if (!await ask('Delete deployment', d.name, { danger: true })) return;
      try { await qawk.del('/systemdeployments/' + d.id); render(); } catch (e) { fail(e); } } }, 'delete') : null,
  ];
}

async function runsDrawer(id) {
  const load = async () => {
    const d = await qawk.get('/systemdeployments/' + id);
    return h('div.stack',
      h('div.flex', { style: 'gap:8px;flex-wrap:wrap' }, h('span.pill.' + (SD_CLS[d.status] || 'mute'), d.status),
        h('span.faint', `${d.manifest} · ${d.maxParallel} at a time · up to ${d.maxFailed} may fail`)),
      d.reason ? h('div.faint', { style: 'font-size:12px' }, d.reason) : null,
      systemsBar(d),
      tableOf(['System', 'Status', 'Components', ''], (d.runs || []).map(r => ({
        key: r.system,
        cells: [h('b.mono', { style: 'white-space:nowrap' }, r.system),
          h('span', h('span.pill.' + (RUN_CLS[r.status] || 'mute'), r.status.replace(/_/g, ' ')),
            r.currentOrder != null && r.status === 'running' ? h('span.faint', { style: 'margin-left:6px;font-size:11px' }, `order ${r.currentOrder}`) : null,
            r.reason ? h('div.faint', { style: 'font-size:11px;max-width:300px' }, r.reason) : null),
          h('div.wrap', { style: 'gap:4px' }, (r.components || []).map(c => {
            // going back, or gone back: how many are on their previous set again,
            // not how many are on the new one -- "0/1" with a spinner read as stuck
            const back = r.status === 'rolling_back' || r.status === 'rolled_back';
            const cls = back ? (r.status === 'rolling_back' ? 'amber' : 'mute')
              : c.onSet === c.devices ? 'ok' : r.status === 'running' ? 'live' : 'mute';
            return h('span.pill.' + cls, { title: `order ${c.order}` + (c.back ? ` · ${c.back} back on the previous set` : '') },
              back ? `${c.componentType} back ${c.back}/${c.devices}` : `${c.componentType} ${c.onSet}/${c.devices}`);
          })),
          ['running', 'succeeded'].includes(r.status) ? h('button.btn.sm.danger', { onclick: async () => {
            if (!await ask('Roll back ' + r.system, 'Every device of this system the deployment updated goes back to what it ran before.',
              { okLabel: 'Roll back', danger: true })) return;
            try { await qawk.post(`/systemdeployments/${id}/runs/${r.id}/rollback`, {}); refreshDrawer(); } catch (e) { fail(e); }
          } }, 'roll back') : null],
      }))));
  };
  // it follows the deployment while it is open (chrome.js, refreshDrawer)
  drawer('Deployment', h('div.empty', h('span.spin')), load);
  try { drawer('Deployment', await load(), load); } catch (e) { fail(e); }
}

// A system's channel: the one all its devices are in, in its colour.
function channelOf(s) {
  return s.fleet
    ? fleetBadge(s.fleet, s.colour)
    : h('span.faint', { title: s.mixed ? 'its devices are not all in the same channel: a channel deployment leaves it out' : '' },
      s.mixed ? 'mixed channels' : 'no channel');
}

// The systems of a type, by centre: each a 6hd with its st05 and hyper, in its channel.
async function systemsDrawer(t) {
  const d = await qawk.get(`/systemtypes/${t.id}/systems`);
  if (!d.content.length) {
    drawer(`${t.name} — no system`, h('div.empty',
      `No device says which ${t.name} it is in: set ${t.systemKey} on them (Targets → metadata), or have them report it.`));
    return;
  }
  const byCentre = new Map();
  d.content.forEach(s => {
    const g = s.group || (t.groupKey ? 'no centre' : '');
    if (!byCentre.has(g)) byCentre.set(g, []);
    byCentre.get(g).push(s);
  });
  const table = list => tableOf(['System', 'Channel', 'Devices', ...t.components.map(c => c.componentType)],
    list.map(s => ({ cells: [h('b.mono', s.system), channelOf(s), fmt(s.devices),
      ...t.components.map(c => fmt((s.components || {})[c.componentType] || 0))] })));
  drawer(`${t.name} — ${d.total} systems` + (t.groupKey ? `, ${byCentre.size} centres` : ''),
    h('div.stack', [...byCentre.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, list]) => (g
      ? h('div', h('div.flex', { style: 'gap:8px;margin:6px 0 4px' }, h('b', g),
          h('span.faint', `${list.length} system${list.length === 1 ? '' : 's'}`)), table(list))
      : table(list)))));
}

function typeDialog(t) {
  t = t || { name: '', description: '', systemKey: 'metadata.system', components: [{ componentType: '', match: '' }] };
  const name = h('input', { type: 'text', value: t.name, placeholder: '6hd-system' });
  const key = h('input.mono', { type: 'text', value: t.systemKey, placeholder: 'metadata.system' });
  const group = h('input.mono', { type: 'text', value: t.groupKey || '', placeholder: 'attribute.centerid' });
  const rows = h('div.stack', { style: 'gap:6px' });
  const addRow = (c = { componentType: '', match: '' }) => {
    const type = h('input', { type: 'text', value: c.componentType, placeholder: '6hd', style: 'width:110px' });
    const match = h('input.mono', { type: 'text', value: c.match, placeholder: 'attribute.device_type==6hd', style: 'flex:1;min-width:0' });
    const row = h('div.flex', { style: 'gap:6px' }, type, match,
      h('button.btn.sm.ghost', { title: 'remove', onclick: () => row.remove() }, '×'));
    row._v = () => ({ componentType: type.value.trim(), match: match.value.trim() });
    rows.append(row);
  };
  t.components.forEach(addRow);
  modal(t.id ? 'Edit ' + t.name : 'New system type', [
    h('label.f', 'Name', name),
    h('label.f', 'How a device says which system it is in', key),
    h('p.faint', { style: 'margin:0;font-size:12px' }, 'attribute.<key> (the device reports it) or metadata.<key> (set it in Targets).'),
    h('label.f', 'Centre (optional): the field that says which centre a system is in', group),
    h('div.f', h('span', 'Components: a name, and the query that recognises its devices'), rows,
      h('button.btn.sm', { onclick: () => addRow() }, icon('plus', 13), 'component')),
  ], async () => {
    const comps = [...rows.children].map(r => r._v()).filter(c => c.componentType);
    for (const c of comps) { const v = fiqlCheck(c.match, 'targets'); if (!v.ok) throw new Error(`${c.componentType}: ${v.msg}`); }
    const b = { name: name.value.trim(), description: t.description || '', systemKey: key.value.trim(),
      groupKey: group.value.trim(), components: comps };
    if (t.id) await qawk.put('/systemtypes/' + t.id, b); else await qawk.post('/systemtypes', b);
    toast('Saved', b.name, 'ok'); render();
  }, 'Save');
}

async function manifestDialog(m) {
  const [types, sets] = await Promise.all([qawk.get('/systemtypes'), distributionSets(true)]);
  if (!types.content.length) { toast('No system type', 'describe a system type first', 'info'); return; }
  m = m || { name: '', systemTypeId: types.content[0].id, components: [] };
  const name = h('input', { type: 'text', value: m.name, placeholder: '6hd-system-2026.09' });
  const type = h('select', types.content.map(t => h('option', { value: t.id, selected: t.id === m.systemTypeId }, t.name)));
  const rows = h('div.stack', { style: 'gap:6px' });
  const draw = () => {
    const t = types.content.find(x => x.id === Number(type.value));
    rows.replaceChildren(...t.components.map(c => {
      const cur = m.components.find(x => x.componentType === c.componentType) || {};
      const ds = h('select', h('option', { value: '' }, '— not in this manifest —'),
        sets.content.filter(d => d.complete).map(d => h('option', { value: d.id, selected: cur.distributionSetId === d.id }, `${d.name} ${d.version}`)));
      const order = h('input', { type: 'number', min: 1, max: 1000, value: cur.order || 10, style: 'width:80px' });
      const row = h('div.flex', { style: 'gap:6px' }, h('b', { style: 'width:90px' }, c.componentType), ds,
        h('span.faint', 'order'), order);
      row._v = () => (ds.value ? { componentType: c.componentType, distributionSetId: Number(ds.value), order: Number(order.value) } : null);
      return row;
    }));
  };
  type.addEventListener('change', draw);
  draw();
  modal(m.id ? 'Edit ' + m.name : 'New manifest', [
    h('label.f', 'Name', name), h('label.f', 'For systems of type', type),
    h('div.f', h('span', 'What each component should run — lower orders first, equal orders together'), rows),
  ], async () => {
    const b = { name: name.value.trim(), systemTypeId: Number(type.value), components: [...rows.children].map(r => r._v()).filter(Boolean) };
    if (m.id) await qawk.put('/manifests/' + m.id, b); else await qawk.post('/manifests', b);
    toast('Saved', b.name, 'ok'); render();
  }, 'Save');
}

/* Deploy a manifest to the systems of a channel -- and of some centres only,
 * or all of them. A system is in a channel when all its devices are; one
 * whose devices are in different channels is left out, and the deployment
 * says so. Inside each system the manifest's order holds, and a system that
 * fails goes back alone: the rest of the channel goes on. */
async function deploymentDialog(preset) {
  const [mans, fleets] = await Promise.all([qawk.get('/manifests').then(r => r.content),
    qawk.get('/fleets').then(r => r.content).catch(() => [])]);
  if (!mans.length) { toast('No manifest', 'write a manifest first', 'info'); return; }
  const man = h('select', mans.map(m => h('option', { value: m.id, selected: preset && preset.id === m.id }, `${m.name} · ${m.systemType}`)));
  const name = h('input', { type: 'text', value: (preset ? preset.name : mans[0].name) + ' ' + new Date().toISOString().slice(0, 10) });
  const chan = h('select', h('option', { value: '' }, '— every channel —'), fleets.map(f => h('option', { value: f.id }, f.name)));
  const par = h('input', { type: 'number', min: 1, value: 2, style: 'width:80px' });
  const maxf = h('input', { type: 'number', min: 0, value: 1, style: 'width:80px' });
  const centres = h('div.wrap', { style: 'gap:8px' });
  const centresBox = h('div.f', h('span', 'Centres (none ticked: every centre)'), centres);
  const list = h('div.wrap', { style: 'gap:6px;max-height:200px;overflow:auto' });
  const count = h('span.faint');
  const every = h('input', { type: 'checkbox', checked: true });
  let sys = [];
  const pickedCentres = () => [...centres.querySelectorAll('input:checked')].map(i => i.value);
  const redraw = () => {
    const f = Number(chan.value), cs = new Set(pickedCentres());
    const shown = sys.filter(x => (!f || (x.fleetId === f && !x.mixed)) && (!cs.size || cs.has(x.group)));
    const out = f ? sys.filter(x => x.mixed && (!cs.size || cs.has(x.group))).length : 0;
    list.replaceChildren(...shown.map(x => h('label', { style: 'display:flex;gap:4px;align-items:center' },
      h('input', { type: 'checkbox', value: x.system, checked: true }), x.system,
      h('span.faint', x.group ? `${x.group} · ${x.devices}` : `(${x.devices})`))));
    count.textContent = `${shown.length} system${shown.length === 1 ? '' : 's'} in scope`
      + (out ? ` · ${out} left out: their devices are in different channels` : '');
  };
  const loadSystems = async () => {
    const m = mans.find(x => x.id === Number(man.value));
    sys = (await qawk.get(`/systemtypes/${m.systemTypeId}/systems`)).content;
    const groups = [...new Set(sys.map(x => x.group).filter(Boolean))].sort();
    centres.replaceChildren(...groups.map(g => h('label', { style: 'display:flex;gap:4px;align-items:center' },
      h('input', { type: 'checkbox', value: g, onchange: redraw }), g)));
    centresBox.hidden = !groups.length;
    redraw();
  };
  man.addEventListener('change', loadSystems);
  chan.addEventListener('change', redraw);
  await loadSystems();
  modal('Deploy a manifest', [
    h('label.f', 'Manifest', man), h('label.f', 'Name', name),
    h('label.f', 'Channel: only systems whose devices are all in it', chan),
    centresBox,
    h('label', { style: 'display:flex;gap:6px;align-items:center' }, every,
      'every system in scope, including ones that join it before the deployment starts'),
    h('div.f', h('span', 'or these systems'), list, count),
    h('div.flex', { style: 'gap:12px;flex-wrap:wrap' }, h('label.f', 'Systems at a time', par), h('label.f', 'Systems that may fail', maxf)),
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'A system that fails goes back alone — its 6hd, st05 and hyper — and the others go on. It is created as a draft: press start when ready.'),
  ], async () => {
    const picked = [...list.querySelectorAll('input:checked')].map(i => i.value);
    const b = { name: name.value.trim(), manifestId: Number(man.value), maxParallel: Number(par.value), maxFailed: Number(maxf.value) };
    if (chan.value) b.fleetId = Number(chan.value);
    if (pickedCentres().length) b.groups = pickedCentres();
    if (!every.checked) b.systems = picked;
    await qawk.post('/systemdeployments', b);
    toast('Created', b.name + ' — press start', 'ok'); render();
  }, 'Create');
}

function importDialog() {
  const text = h('textarea.mono', { rows: 16, style: 'width:100%;font-size:12px',
    placeholder: 'api_version: mender/v1\nkind: topology   # or: manifest\n...' });
  modal('Import Mender YAML', [text,
    h('p.faint', { style: 'margin:0;font-size:12px' },
      'A topology (kind: topology) or a manifest (kind: manifest). Qawk reads qawk_system_key and each component\'s qawk_match; ' +
      'without them, the key is metadata.system and a component matches attribute.device_type==<component_type>. ' +
      'artifact_name is a distribution set, name:version.')],
  async () => {
    const kind = /kind:\s*["']?manifest/.test(text.value) ? 'manifests' : 'systemtypes';
    const r = await rawPost(`/${kind}/import`, text.value);
    toast('Imported', r.name, 'ok'); render();
  }, 'Import');
}
