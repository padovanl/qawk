import { enc, get, limited } from './api.js';
import { h, icon } from './dom.js';

/* A small editor for hawkBit's query language.
 *
 * FIQL/RSQL is typed into a plain box in the stock interface, and a query is
 * either accepted or refused by the server with "rsqlInvalidField" and no hint
 * as to which field. Since the whole point of a filter is to aim a release at
 * the right machines, getting one subtly wrong is expensive: it silently
 * matches nothing, or worse, matches more than was meant.
 *
 * So this knows the grammar, knows which fields each entity really accepts,
 * and completes them -- along with the operators, the enum values, and the
 * device attribute names and values read from the fleet itself.
 *
 * Every field and value listed here was checked against the running server:
 * hawkBit answers 400 rsqlInvalidField for a name it does not know, and for a
 * value outside an enum, so the list is what it accepted rather than what the
 * documentation claims.
 */

const TIME = 'epoch milliseconds — use the date picker in the dialogs, or =gt=';
const FIELDS = {
  targets: [
    { f: 'controllerid', d: 'the id the device reports to hawkBit' },
    { f: 'name', d: 'display name' },
    { f: 'description', d: 'free text' },
    { f: 'updatestatus', d: 'where the device stands',
      v: ['in_sync', 'pending', 'error', 'registered', 'unknown'] },
    { f: 'ipaddress', d: 'last address it polled from' },
    { f: 'attribute.', d: 'anything the device reports about itself', dyn: 'attr' },
    { f: 'tag', d: 'a target tag', dyn: 'tag' },
    { f: 'targettype.name', d: 'target type' },
    { f: 'targettype.key', d: 'target type key' },
    { f: 'assignedds.name', d: 'set it was told to install', dyn: 'ds' },
    { f: 'assignedds.version', d: 'version it was told to install' },
    { f: 'installedds.name', d: 'set it actually runs', dyn: 'ds' },
    { f: 'installedds.version', d: 'version it actually runs' },
    { f: 'lastcontrollerrequestat', d: 'last poll — ' + TIME, t: 'num' },
    { f: 'createdat', d: 'registered — ' + TIME, t: 'num' },
    { f: 'lastmodifiedat', d: 'changed — ' + TIME, t: 'num' },
    { f: 'createdby', d: 'who registered it' },
    { f: 'lastmodifiedby', d: 'who last touched it' },
    { f: 'metadata.', d: 'a metadata key you set' },
    { f: 'id', d: 'hawkBit internal id', t: 'num' },
  ],
  distributionsets: [
    { f: 'name' }, { f: 'version' }, { f: 'description' },
    { f: 'type', d: 'os, app or os_app', v: ['os', 'app', 'os_app'] },
    { f: 'complete', d: 'has every module its type demands', v: ['true', 'false'] },
    { f: 'valid', d: 'still assignable', v: ['true', 'false'] },
    { f: 'tag' }, { f: 'metadata.' },
    { f: 'createdat', d: TIME, t: 'num' }, { f: 'lastmodifiedat', d: TIME, t: 'num' },
    { f: 'createdby' }, { f: 'id', t: 'num' },
  ],
  softwaremodules: [
    { f: 'name' }, { f: 'version' }, { f: 'description' },
    { f: 'type', d: 'os or application', v: ['os', 'application'] },
    { f: 'metadata.' },
    { f: 'createdat', d: TIME, t: 'num' }, { f: 'lastmodifiedat', d: TIME, t: 'num' },
    { f: 'createdby' }, { f: 'id', t: 'num' },
  ],
  rollouts: [
    { f: 'name' }, { f: 'description' },
    { f: 'status', v: ['creating', 'ready', 'starting', 'running', 'paused',
                       'stopped', 'finished', 'deleting', 'waiting_for_approval'] },
    { f: 'createdat', d: TIME, t: 'num' }, { f: 'lastmodifiedat', d: TIME, t: 'num' },
    { f: 'createdby' }, { f: 'id', t: 'num' },
  ],
};

const OPS = [
  { o: '==', d: 'equals — * matches anything' },
  { o: '!=', d: 'does not equal' },
  { o: '=in=', d: 'one of (a,b,c)' },
  { o: '=out=', d: 'none of (a,b,c)' },
  { o: '=gt=', d: 'greater than' },
  { o: '=ge=', d: 'at least' },
  { o: '=lt=', d: 'less than' },
  { o: '=le=', d: 'at most' },
];
const JOIN = [
  { o: ';', d: 'and — both must hold' },
  { o: ',', d: 'or — either will do' },
];

/* ------------------------------------------------------------- the grammar */
/* Tokens carry their position so an error can be pointed at rather than
   described. */
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { out.push({ k: c, at: i, s: c }); i++; continue; }
    if (c === ';' || c === ',') { out.push({ k: 'join', at: i, s: c }); i++; continue; }
    const op = ['=in=', '=out=', '=gt=', '=ge=', '=lt=', '=le=', '==', '!=']
      .find(o => s.startsWith(o, i));
    if (op) { out.push({ k: 'op', at: i, s: op }); i += op.length; continue; }
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      const raw = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      out.push({ k: 'word', at: i, s: raw, quoted: true, unterminated: end === -1 });
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s;,()]/.test(s[j]) &&
           !['=in=', '=out=', '=gt=', '=ge=', '=lt=', '=le=', '==', '!=']
             .some(o => s.startsWith(o, j))) j++;
    if (j === i) j++;                       // never stall on something unexpected
    out.push({ k: 'word', at: i, s: s.slice(i, j) });
    i = j;
  }
  return out;
}

/* expr := term (join term)* ; term := '(' expr ')' | word op value */
function check(text, entity) {
  const q = (text || '').trim();
  if (!q) return { ok: true, empty: true };
  const ts = tokenize(text);
  const known = FIELDS[entity] || [];
  let p = 0, warn = null;
  const err = (msg, tok) => ({ ok: false, msg, at: tok ? tok.at : text.length });

  function expr() {
    let e = term();
    if (!e.ok) return e;
    while (ts[p] && ts[p].k === 'join') {
      p++;
      if (!ts[p]) return err('the query ends on ' + ts[p - 1].s + ', which needs another condition after it', ts[p - 1]);
      e = term();
      if (!e.ok) return e;
    }
    return { ok: true };
  }
  function term() {
    const t = ts[p];
    if (!t) return err('a condition was expected here');
    if (t.k === '(') {
      p++;
      const e = expr();
      if (!e.ok) return e;
      if (!ts[p] || ts[p].k !== ')') return err('this bracket is never closed', t);
      p++;
      return { ok: true };
    }
    if (t.k !== 'word') return err(`"${t.s}" cannot start a condition`, t);
    // field
    const name = t.s.toLowerCase();
    const entry = known.find(k => k.f === name ||
      (k.f.endsWith('.') && name.startsWith(k.f) && name.length > k.f.length));
    if (known.length && !entry) {
      const near = known.map(k => k.f).filter(f => f.startsWith(name.slice(0, 3)))[0];
      return err(`hawkBit has no field called "${t.s}"` + (near ? ` — did you mean ${near}?` : ''), t);
    }
    if (entry && entry.f.endsWith('.') && name === entry.f) {
      return err(`"${entry.f}" needs a key after the dot`, t);
    }
    p++;
    if (!ts[p] || ts[p].k !== 'op') {
      return err(`"${t.s}" needs an operator after it (== != =in= =gt= …)`, ts[p] || t);
    }
    const opTok = ts[p];
    p++;
    // value
    const v = ts[p];
    if (!v || (v.k !== 'word' && v.k !== '(')) return err('this comparison has no value', opTok);
    if (v.k === '(') {                        // =in=(a,b,c)
      if (opTok.s !== '=in=' && opTok.s !== '=out=') {
        return err(`a list in brackets only works with =in= or =out=`, opTok);
      }
      p++;
      let n = 0;
      while (ts[p] && ts[p].k === 'word') {
        n++; p++;
        if (ts[p] && ts[p].k === 'join') p++;
      }
      if (!n) return err('this list is empty', v);
      if (!ts[p] || ts[p].k !== ')') return err('this list is never closed', v);
      p++;
      return { ok: true };
    }
    if (v.unterminated) return err('this quote is never closed', v);
    if (entry && entry.v && !v.s.includes('*')) {
      const vals = entry.v;
      if (!vals.includes(v.s.toLowerCase())) {
        return err(`"${v.s}" is not one of ${entry.f}: ${vals.join(', ')}`, v);
      }
    }
    // hawkBit takes this rather than refusing it -- it simply matches nothing --
    // so the editor must not block it either. Saying so is still worth it.
    if (entry && entry.t === 'num' && !/^\d+$/.test(v.s) && !v.s.includes('*')) {
      warn = `${entry.f} holds a number, and "${v.s}" is not one: hawkBit will accept this and match nothing`;
    }
    p++;
    return { ok: true };
  }

  const r = expr();
  if (!r.ok) return r;
  if (p < ts.length) return err(`"${ts[p].s}" is left over — conditions join with ; (and) or , (or)`, ts[p]);
  return warn ? { ok: true, warn } : { ok: true };
}

/* ---------------------------------------------------------- completion */
/* What can come next depends only on what the caret has just passed. */
function contextAt(text, caret) {
  const before = text.slice(0, caret);
  const ts = tokenize(before);
  const partial = /[A-Za-z0-9_.\-*]+$/.exec(before);
  const word = partial ? partial[0] : '';
  const solid = word ? ts.slice(0, -1) : ts;      // tokens fully behind the caret
  const last = solid[solid.length - 1];
  if (!last || last.k === 'join' || last.k === '(') return { want: 'field', word };
  if (last.k === 'word') {
    const prev = solid[solid.length - 2];
    if (prev && prev.k === 'op') return { want: 'join', word, field: null };
    return { want: 'op', word, field: last.s.toLowerCase() };
  }
  if (last.k === 'op') {
    const f = solid[solid.length - 2];
    return { want: 'value', word, field: f ? f.s.toLowerCase() : null, op: last.s };
  }
  if (last.k === ')') return { want: 'join', word };
  return { want: 'field', word };
}

/* Values that only the fleet knows: attribute names and their values, tag
   names, distribution set names. Read once and kept. */
const live = new Map();
function cached(key, fn) {
  if (!live.has(key)) live.set(key, fn().catch(() => []));
  return live.get(key);
}
async function attributeKeys() {
  return cached('attrkeys', async () => {
    const s = await get('/targets?limit=12');
    const keys = new Set();
    await Promise.all((s.content || []).map(async t => {
      const a = await limited(() => get(`/targets/${enc(t.controllerId)}/attributes`)).catch(() => ({}));
      Object.keys(a || {}).forEach(k => keys.add(k));
    }));
    return [...keys].sort();
  });
}
async function attributeValues(key) {
  return cached('attrval:' + key, async () => {
    const s = await get('/targets?limit=25');
    const vals = new Set();
    await Promise.all((s.content || []).map(async t => {
      const a = await limited(() => get(`/targets/${enc(t.controllerId)}/attributes`)).catch(() => ({}));
      if (a && a[key] != null) vals.add(String(a[key]));
    }));
    return [...vals].sort();
  });
}
const namesOf = (path, key = 'name') => cached(path, async () => {
  const r = await get(path);
  return [...new Set((r.content || []).map(x => x[key]).filter(Boolean))].sort();
});

async function suggestions(text, caret, entity) {
  const c = contextAt(text, caret);
  const known = FIELDS[entity] || [];
  const pre = c.word.toLowerCase();
  const like = s => s.toLowerCase().startsWith(pre);

  if (c.want === 'field') {
    const out = known.filter(k => like(k.f))
      .map(k => ({ text: k.f, hint: k.d || '', kind: 'field', keep: k.f.endsWith('.') }));
    // attribute.<key> is not one field but as many as the fleet reports
    if ('attribute.'.startsWith(pre) || pre.startsWith('attribute.')) {
      const keys = await attributeKeys();
      const rest = pre.startsWith('attribute.') ? pre.slice(10) : '';
      out.push(...keys.filter(k => k.toLowerCase().startsWith(rest))
        .map(k => ({ text: 'attribute.' + k, hint: 'reported by the devices', kind: 'field' })));
    }
    return out;
  }
  if (c.want === 'op') {
    const entry = known.find(k => k.f === c.field ||
      (k.f.endsWith('.') && (c.field || '').startsWith(k.f)));
    // every operator is offered for every field: hawkBit compares strings
    // lexicographically too, so =gt= on a name is legal and occasionally what
    // someone wants -- checked against the running server.
    return OPS.map(o => ({ text: o.o, hint: o.d, kind: 'op' }));
  }
  if (c.want === 'value') {
    const entry = known.find(k => k.f === c.field ||
      (k.f.endsWith('.') && (c.field || '').startsWith(k.f)));
    let vals = [];
    if (entry && entry.v) vals = entry.v;
    else if (c.field && c.field.startsWith('attribute.')) vals = await attributeValues(c.field.slice(10));
    else if (entry && entry.dyn === 'tag') vals = await namesOf('/targettags?limit=50');
    else if (entry && entry.dyn === 'ds') vals = await namesOf('/distributionsets?limit=50');
    return vals.filter(like).map(v => ({ text: v, hint: '', kind: 'value' }));
  }
  return JOIN.map(o => ({ text: o.o, hint: o.d, kind: 'op' }));
}

/* ------------------------------------------------------------- the editor */
/* An input with the completions under it, the parser's verdict beside it, and
 * whatever the caller wants to say about the result (usually a live count). */
function fiqlEditor(opts = {}) {
  const entity = opts.entity || 'targets';
  // Rebuilt on every render, so remember who was typing and where.
  const key = opts.key || (opts.entity + (opts.compact ? ':compact' : ''));
  const live = document.activeElement;
  const keep = !!(live && live.dataset && live.dataset.fq === key);
  const caret = keep ? live.selectionStart : null;

  const inp = h('input.fq-in', {
    type: 'text', value: opts.value || '', spellcheck: 'false',
    autocomplete: 'off', placeholder: opts.placeholder || 'e.g. attribute.device_type==neo-intel',
  });
  const status = h('div.fq-status');
  const list = h('div.fq-list.hidden');
  inp.dataset.fq = key;
  const box = h('div.fq' + (opts.compact ? '.compact' : ''),
    h('div.fq-field', icon('filter', 14), inp),
    list, opts.compact ? null : status);
  let items = [], sel = -1, timer = null;

  Object.defineProperty(box, 'value', {
    get: () => inp.value,
    set: v => { inp.value = v; verdict(); },
  });
  box.input = inp;

  /* silent: the verdict computed while the field is being BUILT must not call
     onChange. In the Targets toolbar that callback re-renders the view, which
     rebuilds this field, which computes its verdict again -- a render loop
     every 220ms that made the page unusable. onChange means "someone typed",
     and nobody has typed at construction time. */
  function verdict(silent) {
    const r = check(inp.value, entity);
    box.classList.toggle('bad', !r.ok);
    box.classList.toggle('warn', !!r.ok && !!r.warn);
    box.classList.toggle('good', !!r.ok && !r.warn && !r.empty && !!inp.value.trim());
    if (opts.compact) {
      // no room for a sentence in a toolbar: the field's own colour says it,
      // and the reason is on hover
      box.title = r.ok ? (r.warn || '') : r.msg;
    } else if (!r.ok) {
      status.replaceChildren(h('span.fq-bad', icon('x', 12), r.msg));
    } else if (r.empty) {
      status.replaceChildren(h('span.faint', 'empty matches every ' + entity.replace(/s$/, '')));
    } else if (r.warn) {
      status.replaceChildren(h('span.fq-warn', icon('info', 12), r.warn));
    } else {
      status.replaceChildren(h('span.fq-ok', icon('check', 12), 'valid'));
    }
    if (!silent && opts.onChange) opts.onChange(inp.value, r);
    return r;
  }

  function close() { list.classList.add('hidden'); sel = -1; }

  /* THE LIST IS ANCHORED TO THE VIEWPORT, not to the field.
     Inside a <dialog> an absolutely positioned list is laid out in the dialog's
     own scrolling box: it stretches it, pushes the buttons off the bottom, or
     gets clipped -- which is what made this unusable in the Save filter and
     Create rollout dialogs. Fixed positioning takes it out of that box; the
     coordinates are recomputed every time it opens, and it flips above the
     field when there is more room up there. */
  function place() {
    const r = box.querySelector('.fq-field').getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 180 && above > below;
    list.style.left = r.left + 'px';
    list.style.width = r.width + 'px';
    list.style.maxHeight = Math.max(120, Math.min(260, up ? above : below)) + 'px';
    if (up) { list.style.top = ''; list.style.bottom = (window.innerHeight - r.top + 6) + 'px'; }
    else { list.style.bottom = ''; list.style.top = (r.bottom + 6) + 'px'; }
  }
  function accept(it) {
    const caret = inp.selectionStart;
    const before = inp.value.slice(0, caret);
    const m = /[A-Za-z0-9_.\-*]+$/.exec(before);
    const cut = m ? caret - m[0].length : caret;
    inp.value = inp.value.slice(0, cut) + it.text + inp.value.slice(caret);
    const at = cut + it.text.length;
    inp.focus(); inp.setSelectionRange(at, at);
    close(); verdict();
    show();                       // a field taken usually wants an operator next
  }
  function draw() {
    list.replaceChildren(...items.map((it, i) => h('div.fq-item' + (i === sel ? '.on' : ''), {
      onmousedown: e => { e.preventDefault(); accept(it); },
    }, h('span.t', it.text), it.hint ? h('span.hh', it.hint) : null,
       h('span.k', it.kind))));
    list.classList.toggle('hidden', !items.length);
  }
  async function show() {
    try {
      items = (await suggestions(inp.value, inp.selectionStart, entity)).slice(0, 40);
    } catch (_) { items = []; }
    sel = items.length ? 0 : -1;
    draw();
    if (items.length) place();
  }

  inp.oninput = () => { verdict(); clearTimeout(timer); timer = setTimeout(show, 90); };
  inp.onclick = show;
  inp.onblur = () => setTimeout(close, 120);
  inp.onkeydown = e => {
    if (list.classList.contains('hidden')) {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === ' ')) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; draw(); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (sel >= 0) { e.preventDefault(); accept(items[sel]); }
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  // a row of the operators, because knowing they exist is most of the problem
  if (opts.legend !== false && !opts.compact) {
    box.append(h('div.fq-legend',
      ...JOIN.concat(OPS).map(o => h('button.chip', {
        type: 'button', title: o.d,
        onmousedown: e => {
          e.preventDefault();
          const at = inp.selectionStart;
          inp.value = inp.value.slice(0, at) + o.o + inp.value.slice(at);
          inp.focus(); inp.setSelectionRange(at + o.o.length, at + o.o.length);
          verdict();
        },
      }, o.o))));
  }
  verdict(true);
  if (keep) requestAnimationFrame(() => {
    if (!inp.isConnected) return;
    inp.focus();
    try { inp.setSelectionRange(caret, caret); } catch (_) {}
  });
  return box;
}

export {
  FIELDS, OPS, check, contextAt, fiqlEditor, suggestions, tokenize,
};
