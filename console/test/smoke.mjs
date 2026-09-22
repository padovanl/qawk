/* Smoke test for the console's JavaScript.  No browser, no dependencies:
 *
 *     node console/test/smoke.mjs
 *
 * It answers the questions a split into modules actually raises -- does every
 * import name a real export, does every module evaluate, does every menu entry
 * still have a view -- and then exercises the handful of helpers that are easy
 * to break and invisible until someone clicks the wrong table.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { install } from './dom-stub.mjs';

install();

const JS = fileURLToPath(new URL('../js/', import.meta.url));
let pass = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};
process.on('unhandledRejection', e => { console.log('  RIFIUTO:', e && e.stack); process.exit(1); });

/* --- 1. the whole tree links and runs ---------------------------------- */
try {
  await import(JS + 'main.js');
  ok('every import resolves and every module runs', true);
} catch (e) {
  ok('every import resolves and every module runs', false, e.message);
  console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}

/* --- 2. the view registry and the menu agree --------------------------- */
const { VIEWS } = await import(JS + 'router.js');
const ids = Object.keys(VIEWS).sort();
ok('the views register themselves', ids.length === 16, ids.join(' '));
const routerSrc = await readFile(JS + 'router.js', 'utf8');
const navBlock = routerSrc.slice(routerSrc.indexOf('const NAV'), routerSrc.indexOf('];', routerSrc.indexOf('const NAV')));
const navIds = [...navBlock.matchAll(/id: '([^']+)'/g)].map(m => m[1]);
const orphan = navIds.filter(i => !VIEWS[i]);
ok('every menu entry points at a view that exists', orphan.length === 0, orphan.join(' '));
ok('every view has a title and a render', ids.every(i => VIEWS[i].title && VIEWS[i].render));

/* --- 3. helpers that cross module boundaries --------------------------- */
const { compact, bytes } = await import(JS + 'util.js');
ok('compact rounds large numbers', compact(1482) === '1.5k' && compact(7) === '7',
   `${compact(1482)} / ${compact(7)}`);
ok('bytes reads sizes', bytes(622000000).endsWith('MiB'), bytes(622000000));

const { pg, fiqlOf, pagedPath, filterRow } = await import(JS + 'table.js');
const { cols, headsFor } = await import(JS + 'columns.js');
const { pill, typePill } = await import(JS + 'badges.js');
ok('the default columns exist', cols('targets').length === 8, cols('targets').join(','));
ok('the headers follow the chosen columns', headsFor('targets', cols('targets')).length === 8);
{
  // a browser that chose its columns before Fleet existed gets Fleet, after
  // Name; one that has seen it and taken it away does not
  const store = new Map();
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } });
  store.set('hb-cols-targets', JSON.stringify(['controllerId', 'name', 'status', 'ip']));
  const merged = cols('targets');
  ok('an older choice is given the Fleet column, after Name', merged.join() === 'controllerId,name,fleet,status,ip', merged.join());
  store.set('hb-cols-seen-targets', JSON.stringify(['controllerId', 'name', 'fleet', 'status', 'ds', 'lastPoll', 'nextPoll', 'ip']));
  ok('whoever removed it does not get it back', !cols('targets').includes('fleet'), cols('targets').join());
  if (prev) Object.defineProperty(globalThis, 'localStorage', prev); else delete globalThis.localStorage;
}
ok('the type badges agree', typePill('os_app').className.includes('ty-both'));
ok('the status pills take their class', pill('in_sync', 'ok').className.includes('ok'));
ok('pagedPath pages', pagedPath('/targets', pg('targets'), '', 'id:DESC').includes('offset=0'));

/* --- 4. the column filters: debounced, and they keep the caret --------- */
const st = pg('targets'); st.f = {}; st.page = 3;
const fields = [{}, { key: 'name', ph: 'name' }, { key: 'type' }];
let renders = 0; const onChange = () => renders++;

let row = filterRow(fields, st, onChange);
ok('the first cell stays without a filter', row.children[0].children.length === 0);
let box = row.children[1].find('fbox');
ok('the field has an icon, an input and a cross', !!box && box.children.length === 3);
ok('empty, it is not highlighted', !box.classList.contains('has'));

const inp = box.children[1];
inp.handlers.input({ target: { value: 'neo', selectionStart: 3 } });
ok('typing goes back to the first page', st.page === 0);
ok('typing does not fire a query per keystroke', renders === 0);

inp.selectionStart = 2;
globalThis.document.activeElement = inp;
row = filterRow(fields, st, onChange);
box = row.children[1].find('fbox');
const inp2 = box.children[1];
ok('the value survives a rebuild', inp2.value === 'neo', inp2.value);
ok('a filled filter shows', box.classList.contains('has'));
globalThis.__frames.splice(0).forEach(f => f());
ok('focus returns to the same column', inp2.focused === true);
ok('the caret returns where it was', inp2.caret === 2, String(inp2.caret));

globalThis.document.activeElement = inp2;
const other = filterRow(fields, st, onChange).children[2].find('fbox').children[1];
globalThis.__frames.splice(0).forEach(f => f());
ok('another column does not steal focus', other.focused !== true);

inp2.handlers.keydown({ key: 'Escape', target: inp2 });
ok('Esc clears at once', st.f.name === '' && renders > 0);
st.f.name = 'x';
const before = renders;
box.find('fx').handlers.click();
ok('the cross clears at once', st.f.name === '' && renders > before);

/* --- 5. the controls that replaced native widgets ---------------------- */
const { colourPicker, fileField } = await import(JS + 'inputs.js');
const cp = colourPicker('#12a594');
ok('the colour starts from the value given', cp.value === '#12a594', cp.value);
const sw = cp.children[0].children;
ok('the palette has ten colours plus the custom one', sw.length === 11, String(sw.length));
sw[3].handlers.click({ preventDefault() {} });          // h() aggancia come proprietà (onclick)
ok('choosing a swatch changes the value', cp.value === '#46a758', cp.value);
ok('the chosen swatch is highlighted', sw[3].classList.contains('on') && !sw[0].classList.contains('on'));
ok('no native colour input in the control',
   !JSON.stringify(cp, (k, v) => (k === 'handlers' ? undefined : v)).includes('"color"'));

const hexIn = cp.find('hexbox').children[1];
hexIn.value = 'ff0000'; hexIn.oninput();
ok('a valid hex value is taken', cp.value === '#ff0000', cp.value);
hexIn.value = 'nonsense'; hexIn.oninput();
ok('an invalid hex value is ignored', cp.value === '#ff0000', cp.value);
hexIn.onblur();     // uscendo dal campo si ripristina il valore buono
ok('the field cleans an invalid value out of itself', hexIn.value === 'ff0000', hexIn.value);
ok('the field does not show a double hash', !hexIn.value.startsWith('#'), hexIn.value);
const panel = cp.find('cpick-panel');
ok('the custom panel starts closed', panel.classList.contains('hidden'));
sw[10].handlers.click({ preventDefault() {} });
ok('custom opens our own panel', !panel.classList.contains('hidden'));

const fz = fileField({ multiple: true });
ok('the drop zone exposes its input', fz.input && fz.input.nodeName === 'input');
ok('it starts with no file', !fz.classList.contains('has'));
fz.input.files = [{ name: 'hello-1.1.3.swu', size: 622000000 }];
fz.input.onchange();
ok('it shows the chosen file', fz.classList.contains('has') && fz.textContent.includes('hello-1.1.3.swu'));

/* --- 6. the FIQL parser ------------------------------------------------ */
const { check, tokenize, contextAt } = await import(JS + 'fiql.js');
const good = [
  'name==*neo*', 'name!=x', 'id=gt=0', 'updatestatus==in_sync',
  'updatestatus=in=(in_sync,error)', 'updatestatus=out=(error)',
  'updatestatus==in_sync;name==*e*', 'updatestatus==in_sync,updatestatus==error',
  '(updatestatus==in_sync,updatestatus==error);name==*e*',
  'attribute.device_type==neo-intel', 'lastcontrollerrequestat=gt=1700000000000',
  'installedds.name==hello-full', 'name=="with spaces"', '',
  'name=gt=x',              // hawkBit confronta anche le stringhe: verificato sul server
];
const bad = [
  ['nonesuch==x', 'campo inesistente'],
  ['updatestatus==nonsense', 'valore fuori enum'],
  ['name', 'manca operatore'],
  ['name==', 'manca valore'],
  ['(name==a', 'parentesi aperta'],
  ['name==a;', 'finisce con ;'],
  ['name==a b==c', 'due condizioni senza giunzione'],
  ['attribute.==x', 'attributo senza chiave'],
  ['name=="unterminated', 'virgoletta aperta'],
];
let pOk = 0;
for (const q of good) if (check(q, 'targets').ok) pOk++;
   else console.log('       ^ rifiutata a torto:', JSON.stringify(q), '->', check(q, 'targets').msg);
ok('it takes valid queries', pOk === good.length, `${pOk}/${good.length}`);
let nOk = 0;
for (const [q, why] of bad) {
  const r = check(q, 'targets');
  if (!r.ok) nOk++; else console.log('       ^ accettata a torto:', JSON.stringify(q), '(' + why + ')');
}
ok('it refuses broken queries', nOk === bad.length, `${nOk}/${bad.length}`);
const w = check('id==abc', 'targets');
ok('a non-numeric id warns but does not block', w.ok && !!w.warn, w.warn || '(no warning)');
ok('the error says where', check('name==a;nonesuch==b', 'targets').at === 8,
   String(check('name==a;nonesuch==b', 'targets').at));
ok('the error suggests the nearest field', /did you mean name/.test(check('nam==a', 'targets').msg || ''),
   check('nam==a', 'targets').msg);
ok('the tokenizer keeps the quotes', tokenize('name=="a;b"').length === 3);
ok('at the start of a line the fields complete', contextAt('', 0).want === 'field');
// mentre il campo si sta ancora scrivendo si completano i campi; l'operatore
// arriva quando il campo e' chiuso
ok('while a field is being typed the fields complete', contextAt('name', 4).want === 'field');
ok('once the field is closed the operator completes', contextAt('name ', 5).want === 'op');
ok('after an operator the value completes', contextAt('updatestatus==', 14).want === 'value');
ok('after a value the joiner completes', contextAt('name==a ', 8).want === 'join');

/* --- 7. the query editor must not report a change nobody made ---------- */
/* This is a regression test for a render loop: the Targets toolbar passes an
   onChange that re-renders the view, so an editor that fires onChange while it
   is being built rebuilds itself forever -- the page glitched at 220ms and was
   unusable. */
{
  const { fiqlEditor } = await import(JS + 'fiql.js');
  let fired = 0;
  const ed = fiqlEditor({ entity: 'targets', value: 'name==*neo*', compact: true,
                          onChange: () => fired++ });
  ok('building the editor does not call onChange', fired === 0, `chiamate: ${fired}`);
  ok('the editor carries the initial value anyway', ed.value === 'name==*neo*', ed.value);
  // ...but typing must
  const inp = ed.find('fq-in') || ed.children[0].children[1];
  inp.value = 'name==*x*';
  inp.oninput();
  ok('typing does call it', fired === 1, `chiamate: ${fired}`);
}

/* --- 8. a closed action must not look like a running one --------------- */
/* hawkBit keeps an action's LAST reported status even after it is closed, so a
   deployment that finished and was polled again reads "retrieved" for good.
   Spinning on that says work is under way when the action is over. */
{
  const { actionPill } = await import(JS + 'badges.js');
  const live = actionPill({ status: 'retrieved', active: true });
  ok('an open action spins', live.className.includes('live'), live.className);
  const closed = actionPill({ status: 'retrieved', active: false });
  ok('a closed action does not spin', !closed.className.includes('live'), closed.className);
  ok('and says it is closed', closed.textContent.includes('closed'), closed.textContent);
  const done = actionPill({ status: 'finished', active: false });
  ok('a result stays a result', done.className.includes('ok') && !done.textContent.includes('closed'));
  const err = actionPill({ status: 'error', active: false });
  ok('an error stays an error', err.className.includes('err'));
}

/* --- 9. "pending" broken down into what it is actually doing ----------- */
/* Built from a real action's status history, ids and all -- copied out of a
   combined deployment on a neo-intel. The ids matter: progress is the furthest
   point the chain reached, not the newest entry. */
{
  const { phaseFrom } = await import(JS + 'badges.js');
  const E = (id, type, msg) => ({ id, type, messages: msg ? [msg] : [] });
  const lab  = e => (phaseFrom(e) || {}).label;
  const lab2 = (e, kind) => (phaseFrom(e, kind) || {}).label;

  const assigned  = [E(193, 'running', "Assignment initiated by user 'admin'")];
  const retrieved = assigned.concat(E(194, 'retrieved', 'Target retrieved update action'));
  const dl1       = retrieved.concat(E(195, 'running', 'Installing Update Chunk Artifacts.'),
                                     E(196, 'download', 'Target downloads /DEFAULT/...'));
  // "Installing Update Chunk Artifacts" is hawkBit ANNOUNCING the part; the
  // real install is SWUpdate's own message, once the bytes are in
  const inst1     = dl1.concat(E(197, 'running', '[lua_handlers_init] Installation in progress'));
  const chunk1    = inst1.concat(E(198, 'running', '[server_install_update] : Update successful'),
                               E(199, 'running', 'Installed Chunk.'));
  const dl2       = chunk1.concat(E(200, 'running', 'Installing Update Chunk Artifacts.'),
                                  E(201, 'download', 'Target downloads /DEFAULT/...'));
  const chunk2    = dl2.concat(E(204, 'running', 'Installed Chunk.'),
                               E(205, 'running', 'All Chunks Installed.'));
  const polled    = chunk2.concat(E(206, 'retrieved', 'Target retrieved update action'));

  ok('assigned but not yet collected', lab(assigned) === 'assigned');
  ok('collected means it is downloading', lab(retrieved) === 'downloading');
  // hawkBit notes "Installing Update Chunk Artifacts" and the downloads follow,
  // so at that point the device really is downloading
  ok('the first chunk: it is downloading', lab(dl1) === 'downloading', lab(dl1));
  // THERE IS NO SEPARATE "INSTALLING" TO SEE. Measured on two real updates:
  // the download entry lands, then eleven seconds of silence, then "Update
  // successful", "Installed Chunk" and "All Chunks Installed" all arrive in
  // the same second. The transfer and the write cannot be told apart, so one
  // label covers both rather than guessing.
  ok('through the silence it stays one phase', lab(inst1) === 'downloading', lab(inst1));
  ok('e senza "(part N)" quando ce n e una sola', !/part/.test(lab(dl1)), lab(dl1));
  // "Update successful" arrives after EVERY chunk, so it cannot mean the end
  ok('after the first chunk it does not say reboot yet', lab(chunk1) !== 'waiting for reboot', lab(chunk1));
  ok('and says we are on the second part', /part 2/.test(lab(chunk1)), lab(chunk1));
  ok('the second part, downloading', /downloading \(part 2\)/.test(lab(dl2)), lab(dl2));
  // WHAT "DONE" MEANS DEPENDS ON THE KIND OF SET. An application reboots
  // nothing; only a system part waits for a boot. "waiting for reboot" was on
  // screen during an application delta, which is simply false.
  ok('a system set ends up waiting for a reboot',
     lab2(chunk2, 'os') === 'waiting for reboot', lab2(chunk2, 'os'));
  ok('a combined one too', lab2(chunk2, 'os_app') === 'waiting for reboot', lab2(chunk2, 'os_app'));
  ok('an application, instead, reads as simply installed',
     lab2(chunk2, 'app') === 'installed', lab2(chunk2, 'app'));
  ok('not knowing the type, it does not promise an application reboot',
     lab(chunk2) === 'waiting for reboot', lab(chunk2));
  // THE REGRESSION: a poll after the end used to drag it back to downloading
  ok('a poll after the end does not go backwards', lab(polled) === 'waiting for reboot', lab(polled));

  ok('waiting for someone to confirm',
     lab([E(1, 'wait_for_confirmation', '')]) === 'waiting for confirmation');
  ok('being cancelled', lab([E(1, 'canceling', '')]) === 'cancelling');
  ok('with nothing useful to read it invents nothing', phaseFrom([]) === null);
}

/* --- 10. the legend explains every word the column can show ------------ */
/* Derived from the source, not from the cases above: a phase nobody thought to
   test would still have to be described. This is how the legend fell behind
   the column in the first place. */
{
  const { PHASE_WORDS } = await import(JS + 'badges.js');
  const src = await readFile(JS + 'badges.js', 'utf8');
  const fn = src.slice(src.indexOf('function phaseFrom'), src.indexOf('function explainPending'));
  const produced = [...fn.matchAll(/label:\s*'([^']+)'/g)].map(m => m[1]);
  const described = new Set(PHASE_WORDS.map(([k]) => k));
  const missing = produced.filter(l => !described.has(l));
  ok('every phase it produces is described in the legend', missing.length === 0,
     missing.join(', ') || `${produced.length} fasi`);
  const dead = [...described].filter(k => !produced.includes(k));
  ok('the legend describes no phase that does not exist', dead.length === 0, dead.join(', '));

  // and the Targets legend is built from that same list
  const tsrc = await readFile(JS + 'views/targets.js', 'utf8');
  ok('the target legend uses that list', tsrc.includes('PHASE_WORDS'));
}

/* --- 11. a toast can be dismissed ------------------------------------- */
{
  const { toast } = await import(JS + 'chrome.js');
  const t = toast('Deployed', 'to one device', 'ok');
  const x = t.find('toast-x');
  ok('the toast has its cross', !!x);
  let removed = false;
  t.remove = () => { removed = true; };
  if (x) x.handlers.click();
  ok('the cross closes it', removed);
}

/* --- 12. h() understands an id -------------------------------------- */
/* The compatibility bar is the one element written as 'div#compat...', and
   before this the whole string went to createElement -- which throws in a
   browser. It was created inside a promise nobody awaited, so the bar simply
   never appeared and nothing said why. */
{
  const { h } = await import(JS + 'dom.js');
  const e = h('div#compat.compat.warn', 'x');
  ok('h() takes the id from the tag', e.id === 'compat', e.id || '(vuoto)');
  ok('and the classes stay as they were', e.className === 'compat warn', e.className);
  ok('with no id it works as before', h('span.mono').id === '');
}

/* --- 13. the page is covered while the server is missing --------------- */
{
  const { serverGate } = await import(JS + 'chrome.js');
  const has = () => globalThis.document.__has('#offline');
  serverGate(false);
  ok('with no server the page is covered', has());
  serverGate(false);
  ok('it does not put up two', globalThis.document.body.findAll('gate').length === 1);
  serverGate(true);
  ok('when it comes back it takes itself away', !has());
}

/* --- 14. notifications can be turned off, and are all on by default ---- */
{
  const { NOTICES, noticeOn, setNotice } = await import(JS + 'prefs.js');
  ok('there are six categories', NOTICES.length === 6, String(NOTICES.length));
  ok('all on, with nothing chosen', NOTICES.every(([id]) => noticeOn(id)));
  setNotice('deploy', false);
  ok('turning one off works', !noticeOn('deploy'));
  ok('and does not touch the others', noticeOn('rollout') && noticeOn('devices'));
  setNotice('deploy', true);
  ok('and it comes back on', noticeOn('deploy'));
  // every category must be routed through the switch, or turning one off
  // silences most of it and not all
  const src = await readFile(JS + 'notices.js', 'utf8');
  const raised = [...src.matchAll(/notify\('([a-z]+)'/g)].map(m => m[1]);
  const known = new Set(NOTICES.map(([id]) => id));
  ok('every notification goes through a known category',
     raised.every(k => known.has(k)), [...new Set(raised)].join(','));
  ok('no toast escapes the switches',
     !/\n\s*toast\(/.test(src.replace(/const notify[\s\S]*?;\n/, '')),
     'toasts raised directly in notices.js');
}

console.log(`\n  ${pass} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
