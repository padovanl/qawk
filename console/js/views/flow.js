import { distributionSets, qawk } from '../api.js';
import { fail, toast } from '../chrome.js';
import { h, icon } from '../dom.js';
import { render } from '../router.js';
import { dump as yamlDump, load as yamlLoad } from '../vendor/js-yaml.mjs';

/* ------- the orchestrator, drawn ------------------------------------------
 *
 * A manifest as the system it updates: a node for each component -- the 6hd,
 * the st05, the hyper, each with how the devices say what they are, how many
 * there are, and the set they should run -- and an arrow for "first": st05 →
 * 6hd, the st05 are updated, and must succeed, before the 6hd starts. Laid out
 * like the hardware -- the terminals below, the 6hd above them -- with dagre
 * (MIT); drawn with React Flow (MIT): nodes that move, arrows pulled from a
 * node's dot, a minimap, zoom. "Play the order" lights the components in the
 * order they will be updated. Beside it, the Mender YAML, written with
 * js-yaml (MIT) as the picture changes; a YAML pasted in and applied is drawn.
 * The server keeps orders: what comes first is 10, what comes after it 20.
 * React, ReactDOM, React Flow and dagre load when the editor opens. */
const loaded = {};
const script = src => loaded[src] || (loaded[src] = new Promise((ok, no) => {
  const s = document.createElement('script');
  s.src = src; s.onload = ok; s.onerror = () => no(new Error('cannot load ' + src));
  document.head.append(s);
}));
const styles = href => { if (!document.querySelector(`link[href="${href}"]`)) document.head.append(h('link', { rel: 'stylesheet', href })); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const paint = y => esc(y).split('\n').map(l => l
  .replace(/^(\s*-?\s*)([\w.-]+)(:)/, '$1<span class="yk">$2</span>$3')
  .replace(/(&quot;[^&]*&quot;)/g, '<span class="ys">$1</span>')
  .replace(/([{\s,:])(\d+)(?=[,}\s]|$)/g, '$1<span class="yn">$2</span>')).join('\n');
const hue = s => { let x = 0; for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x % 360; };
const fmt = n => Number(n || 0).toLocaleString('en-US');
const nth = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)] || 'th');
const ICON = { '6hd': 'device-desktop', 'neo-intel': 'device-desktop', st05: 'cpu', hyper: 'server-2' };
const NW = 280, NH = 176;

let Editor = null;
function makeEditor() {
  const R = window.React, RF = window.ReactFlow, e = R.createElement;
  const { useState, useMemo, useCallback, useEffect, useRef } = R;
  const { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, Panel, useReactFlow, useNodesState, useEdgesState } = RF;
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3ba9a1';
  const edge = (a, b) => ({ id: `${a}->${b}`, source: a, target: b, type: 'smoothstep', pathOptions: { borderRadius: 18 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: accent() } });
  const levels = (ids, es) => {
    const lv = new Map(ids.map(i => [i, 0]));
    for (let k = 0; k < ids.length; k++) for (const x of es) if (lv.has(x.source) && lv.has(x.target)) lv.set(x.target, Math.max(lv.get(x.target), lv.get(x.source) + 1));
    return lv;
  };
  const reaches = (es, from, to) => {
    const seen = new Set([from]), todo = [from];
    while (todo.length) { const x = todo.pop(); if (x === to) return true; for (const y of es) if (y.source === x && !seen.has(y.target)) { seen.add(y.target); todo.push(y.target); } }
    return false;
  };
  // like the hardware: what goes first below, what it leads to above
  const layout = (ns, es) => {
    const g = new window.dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'BT', nodesep: 70, ranksep: 130, marginx: 40, marginy: 40 });
    g.setDefaultEdgeLabel(() => ({}));
    ns.forEach(n => g.setNode(n.id, { width: NW, height: NH }));
    es.forEach(x => g.setEdge(x.source, x.target));
    window.dagre.layout(g);
    return ns.map(n => { const p = g.node(n.id); return { ...n, position: { x: p.x - NW / 2, y: p.y - NH / 2 } }; });
  };

  function CompNode({ data, selected }) {
    return e('div', { className: 'rfc' + (data.lit ? ' lit' : '') + (data.done ? ' done' : '') + (selected ? ' sel' : ''), style: { '--hue': data.hue } },
      e(Handle, { type: 'source', position: Position.Top, className: 'rfh' }),
      e('div', { className: 'rfc-top' },
        e('span', { className: 'rfc-ico', dangerouslySetInnerHTML: { __html: data.icon } }),
        e('div', { className: 'rfc-t' }, e('b', null, data.comp), e('span', null, data.count)),
        e('span', { className: 'rfc-step', title: 'when it is updated' }, data.done ? '✓' : data.step)),
      e('div', { className: 'rfc-match', title: data.match }, data.match),
      e('select', { className: 'rfc-ds nodrag', value: data.ds || '', onChange: ev => data.onDs(data.comp, Number(ev.target.value) || '') },
        e('option', { value: '' }, '— which set —'),
        data.sets.map(s => e('option', { key: s.id, value: s.id }, `${s.name} ${s.version}`))),
      e('div', { className: 'rfc-bar' }, e('i')),
      e(Handle, { type: 'target', position: Position.Bottom, className: 'rfh' }));
  }
  const nodeTypes = { comp: CompNode };

  return function Ed({ m, types, sets, close }) {
    const rf = useReactFlow();
    const [type, setType] = useState(types.find(t => t.id === (m && m.systemTypeId)) || types[0]);
    const [name, setName] = useState((m && m.name) || '');
    const [ds, setDs] = useState(() => Object.fromEntries(((m && m.components) || []).map(c => [c.componentType, c.distributionSetId])));
    const [dev, setDev] = useState({ total: {}, per: {}, n: 0 });
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const [play, setPlay] = useState(null);
    const [yin, setYin] = useState(null);
    const [sliding, setSliding] = useState(false);
    const box = useRef(null), first = useRef(true);

    useEffect(() => {
      qawk.get(`/systemtypes/${type.id}/systems`).then(r => {
        const s = r.content || [], total = {};
        for (const x of s) for (const [k, v] of Object.entries(x.components || {})) total[k] = (total[k] || 0) + v;
        setDev({ total, per: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, Math.round(v / (s.length || 1))])), n: s.length });
      }).catch(() => setDev({ total: {}, per: {}, n: 0 }));
    }, [type.id]);

    const build = useCallback((comps, arrows) => {
      const orders = [...new Set(comps.map(c => Number(c.order) || 10))].sort((a, b) => a - b), at = c => orders.indexOf(Number(c.order) || 10);
      const ns = comps.map(c => ({ id: c.componentType, type: 'comp', position: { x: 0, y: 0 }, data: {} }));
      const es = [];
      if (arrows) for (const a of comps) for (const b of comps) if (at(b) === at(a) + 1) es.push(edge(a.componentType, b.componentType));
      setNodes(layout(ns, es)); setEdges(es);
      setTimeout(() => rf.fitView({ padding: 0.38, duration: 700 }), 60);
    }, []);
    useEffect(() => {
      if (first.current && m && m.components && m.components.length) build(m.components, true);
      else build(type.components.map(c => ({ componentType: c.componentType, order: 10 })), false);
      first.current = false;
    }, [type.id]);

    const lv = useMemo(() => levels(nodes.map(n => n.id), edges), [nodes, edges]);
    const steps = useMemo(() => {
      const out = [];
      for (const n of nodes) { const l = lv.get(n.id) || 0; (out[l] = out[l] || []).push(n.id); }
      return out.filter(Boolean);
    }, [nodes, lv]);
    const onDs = useCallback((comp, v) => setDs(d => ({ ...d, [comp]: v })), []);
    const view = nodes.map(n => {
      const l = lv.get(n.id) || 0, t = type.components.find(c => c.componentType === n.id) || {};
      return { ...n, data: { comp: n.id, hue: hue(n.id), icon: icon(ICON[n.id] || 'cpu', 20).outerHTML, match: t.match || '',
        count: dev.total[n.id] ? `${dev.per[n.id] > 1 ? `×${dev.per[n.id]} per system · ` : ''}${fmt(dev.total[n.id])} devices` : '',
        step: `${nth(l + 1)}`, ds: ds[n.id], sets, onDs,
        lit: play !== null && play === l, done: play !== null && (play === 'end' || l < play) } };
    });
    const edgesView = edges.map(x => {
      const hot = play !== null && play !== 'end' && lv.get(x.target) === play;
      return { ...x, animated: hot, className: hot ? 'hot' : '' };
    });

    const onConnect = useCallback(c => setEdges(es => {
      if (c.source === c.target || es.some(x => x.source === c.source && x.target === c.target)) return es;
      if (reaches(es, c.target, c.source)) { setTimeout(() => toast('That would make a loop', `${c.target} already comes before ${c.source}`, 'err')); return es; }
      return [...es, edge(c.source, c.target)];
    }), []);
    const tidy = () => {
      setSliding(true); setNodes(ns => layout(ns, edges));
      setTimeout(() => { rf.fitView({ padding: 0.38, duration: 600 }); setTimeout(() => setSliding(false), 650); }, 30);
    };
    const add = (comp, where) => {
      const r = box.current.getBoundingClientRect();
      const p = rf.screenToFlowPosition(where || { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      setNodes(ns => ns.some(n => n.id === comp) ? ns : [...ns, { id: comp, type: 'comp', position: { x: p.x - NW / 2, y: p.y - NH / 2 }, data: {} }]);
    };
    const run = () => {
      if (!steps.length) return;
      let k = 0;
      setPlay(0);
      const next = () => { k += 1; if (k < steps.length) { setPlay(k); setTimeout(next, 1700); } else { setPlay('end'); setTimeout(() => setPlay(null), 2600); } };
      setTimeout(next, 1700);
    };

    const doc = () => {
      const d = { api_version: 'mender/v1', kind: 'manifest', name: name.trim() || `${type.name}-${new Date().toISOString().slice(0, 7)}`,
        system_types_compatible: [type.name], component_types: {} };
      steps.forEach((list, i) => list.forEach(c => {
        const s = sets.find(x => x.id === ds[c]);
        d.component_types[c] = { artifact_name: s ? `${s.name}:${s.version}` : '?', update_strategy: { order: (i + 1) * 10 } };
      }));
      return d;
    };
    const yamlText = yamlDump(doc(), { flowLevel: 2, lineWidth: 160 });
    const apply = () => {
      if (yin === null) { setYin(yamlText); return; }
      try {
        const y = yamlLoad(yin) || {};
        const comps = Object.entries(y.component_types || {}).map(([k, v]) => {
          const [nm, ver] = String((v || {}).artifact_name || '').split(':');
          const s = sets.find(x => x.name === nm && x.version === ver);
          return { componentType: k, distributionSetId: s ? s.id : '', order: Number(((v || {}).update_strategy || {}).order) || 10 };
        });
        if (!comps.length) throw new Error('no component_types in it');
        const t = types.find(x => (y.system_types_compatible || []).includes(x.name));
        if (t && t.id !== type.id) { first.current = true; setType(t); }
        if (y.name) setName(y.name);
        setDs(d => ({ ...d, ...Object.fromEntries(comps.map(c => [c.componentType, c.distributionSetId])) }));
        build(comps, true); setYin(null);
      } catch (err) { toast('That YAML does not read', err.message.split('\n')[0], 'err'); }
    };
    const save = async () => {
      const d = doc();
      const comps = Object.entries(d.component_types).map(([c, v]) => ({ componentType: c, distributionSetId: Number(ds[c]) || 0, order: v.update_strategy.order }));
      if (!comps.length) { toast('Nothing to update', 'put at least one component on the canvas', 'info'); return; }
      const missing = comps.filter(c => !c.distributionSetId).map(c => c.componentType);
      if (missing.length) { toast('A set for every component', `${missing.join(', ')}: which set?`, 'err'); return; }
      try {
        const b = { name: d.name, systemTypeId: type.id, components: comps };
        if (m && m.id) await qawk.put('/manifests/' + m.id, b); else await qawk.post('/manifests', b);
        toast('Saved', `${b.name}: ${comps.length} components, ${steps.length} step${steps.length === 1 ? '' : 's'}`, 'ok');
        close(); render();
      } catch (err) { fail(err); }
    };

    const unused = type.components.map(c => c.componentType).filter(c => !nodes.some(n => n.id === c));
    const totalDev = nodes.reduce((a, n) => a + (dev.total[n.id] || 0), 0);
    return e('div', { className: 'rfx-shell' },
      e('div', { className: 'rfx-head' },
        e('span', { className: 'rfx-title', dangerouslySetInnerHTML: { __html: icon('sitemap', 18).outerHTML + esc(m && m.id ? `Orchestrator · ${m.name}` : 'Orchestrator · a new manifest') } }),
        e('span', { className: 'rfx-legend' }, 'an arrow means "first": pull one from a component\'s top dot to the one that comes after'),
        e('span', { className: 'grow' }),
        e('button', { className: 'btn sm', onClick: close }, '×')),
      e('div', { className: 'rfx-main' },
        e('div', { className: 'rfx-stage' + (sliding ? ' sliding' : ''), ref: box,
          onDragOver: ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; },
          onDrop: ev => { ev.preventDefault(); const c = ev.dataTransfer.getData('application/x-comp'); if (c) add(c, { x: ev.clientX, y: ev.clientY }); } },
        e(ReactFlow, { nodes: view, edges: edgesView, nodeTypes, onNodesChange, onEdgesChange, onConnect,
          deleteKeyCode: ['Backspace', 'Delete'], minZoom: 0.3, maxZoom: 1.8, proOptions: { hideAttribution: true },
          connectionLineStyle: { stroke: accent(), strokeWidth: 2.5, strokeDasharray: '7 6' }, fitView: true },
          e(Background, { variant: 'dots', gap: 22, size: 1.4, color: 'rgba(160,190,200,.22)' }),
          e(MiniMap, { pannable: true, zoomable: true, style: { width: 150, height: 96 }, nodeColor: n => `hsl(${hue(n.id)} 65% 55%)`, nodeBorderRadius: 8, maskColor: 'rgba(8,12,16,.55)' }),
          e(Controls, { showInteractive: false }),
          e(Panel, { position: 'top-left' }, e('div', { className: 'rfx-tools' },
            e('button', { className: 'rfx-play', onClick: run, disabled: play !== null || !steps.length }, play !== null ? 'playing…' : '▶  Play the order'),
            e('button', { className: 'rfx-tool', onClick: tidy }, 'Auto layout'))),
          unused.length ? e(Panel, { position: 'top-right' }, e('div', { className: 'rfx-pal' },
            e('span', null, 'Not in it yet'),
            unused.map(c => e('button', { key: c, className: 'rfx-chip', draggable: true, style: { '--hue': hue(c) }, title: 'click, or drag onto the canvas',
              onDragStart: ev => { ev.dataTransfer.setData('application/x-comp', c); ev.dataTransfer.effectAllowed = 'move'; },
              onClick: () => add(c) }, '+ ' + c)))) : null)),
        e('div', { className: 'rfx-side' },
          e('label', { className: 'f' }, 'Name', e('input', { type: 'text', value: name, placeholder: `${type.name}-${new Date().toISOString().slice(0, 7)}`, onChange: ev => setName(ev.target.value) })),
          e('label', { className: 'f' }, 'For systems of type', e('select', { value: type.id, onChange: ev => setType(types.find(t => t.id === Number(ev.target.value))) },
            types.map(t => e('option', { key: t.id, value: t.id }, t.name)))),
          e('div', { className: 'rfx-sum' },
            [[nodes.length, nodes.length === 1 ? 'component' : 'components'], [steps.length, steps.length === 1 ? 'step' : 'steps'],
              [fmt(dev.n), dev.n === 1 ? 'system' : 'systems'], [fmt(totalDev), 'devices']].map(([v, l]) => e('div', { key: l }, e('b', null, v), e('span', null, l)))),
          e('div', { className: 'f' }, e('span', null, 'How each system is updated'),
            e('ol', { className: 'rfx-seq' },
              steps.length ? steps.map((list, i) => e('li', { key: i, className: play === i ? 'lit' : (play === 'end' || (typeof play === 'number' && i < play)) ? 'done' : '' },
                e('span', { className: 'n' }, String(i + 1)),
                e('div', null, e('b', null, list.map(c => (dev.per[c] > 1 ? `${c} ×${dev.per[c]}` : c)).join(' + ')),
                  e('div', { className: 'faint' }, i ? `once step ${i} has succeeded${list.length > 1 ? ' — together' : ''}` : list.length > 1 ? 'first — together' : 'first')))) : null,
              steps.length ? e('li', { className: 'fail' }, e('span', { className: 'n' }, '!'),
                e('div', null, e('b', null, 'a system that fails at any step'), e('div', { className: 'faint' }, 'goes back as a whole — its 6hd, st05 and hyper — and the others go on'))) : null)),
          e('div', { className: 'f' }, e('span', { className: 'rfx-yhead' }, 'Mender YAML', e('span', { className: 'grow' }),
            e('button', { className: 'btn sm', onClick: apply }, yin === null ? 'edit' : 'apply')),
          yin === null ? e('pre', { className: 'rfx-yaml', dangerouslySetInnerHTML: { __html: paint(yamlText) } })
            : e('textarea', { className: 'rfx-yin', value: yin, spellCheck: false, onChange: ev => setYin(ev.target.value) })),
          e('div', { className: 'rfx-actions' }, e('button', { className: 'btn', onClick: close }, 'Cancel'), e('button', { className: 'btn primary', onClick: save }, 'Save')))));
  };
}

export async function manifestEditor(m) {
  styles('js/vendor/reactflow.css');
  await script('js/vendor/react.production.min.js');
  await script('js/vendor/react-dom.production.min.js');
  await Promise.all([script('js/vendor/reactflow.umd.js'), script('js/vendor/dagre.min.js')]);
  const [types, all] = await Promise.all([qawk.get('/systemtypes'), distributionSets(true)]);
  if (!types.content.length) { toast('No system type', 'describe a system type first', 'info'); return; }
  Editor = Editor || makeEditor();
  const dlg = h('dialog.flow.rfx'), mount = h('div.rfx-mount');
  dlg.append(mount);
  document.body.append(dlg);
  dlg.showModal();
  const root = window.ReactDOM.createRoot(mount);
  const R = window.React;
  root.render(R.createElement(window.ReactFlow.ReactFlowProvider, null,
    R.createElement(Editor, { m, types: types.content, sets: all.content.filter(d => d.complete), close: () => dlg.close() })));
  dlg.addEventListener('close', () => { root.unmount(); dlg.remove(); });
}
