/* Smoke test for the console's JavaScript.  No browser, no dependencies:
 *
 *     node ota/hawkbit-ui/test/smoke.mjs
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
  ok('ogni import risolve e ogni modulo viene eseguito', true);
} catch (e) {
  ok('ogni import risolve e ogni modulo viene eseguito', false, e.message);
  console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}

/* --- 2. the view registry and the menu agree --------------------------- */
const { VIEWS } = await import(JS + 'router.js');
const ids = Object.keys(VIEWS).sort();
ok('le viste si registrano da sole', ids.length === 9, ids.join(' '));
const routerSrc = await readFile(JS + 'router.js', 'utf8');
const navBlock = routerSrc.slice(routerSrc.indexOf('const NAV'), routerSrc.indexOf('];', routerSrc.indexOf('const NAV')));
const navIds = [...navBlock.matchAll(/id: '([^']+)'/g)].map(m => m[1]);
const orphan = navIds.filter(i => !VIEWS[i]);
ok('ogni voce di menù punta a una vista esistente', orphan.length === 0, orphan.join(' '));
ok('ogni vista ha titolo e render', ids.every(i => VIEWS[i].title && VIEWS[i].render));

/* --- 3. helpers that cross module boundaries --------------------------- */
const { compact, bytes } = await import(JS + 'util.js');
ok('compact arrotonda i numeri grandi', compact(1482) === '1.5k' && compact(7) === '7',
   `${compact(1482)} / ${compact(7)}`);
ok('bytes legge le dimensioni', bytes(622000000).endsWith('MiB'), bytes(622000000));

const { pg, fiqlOf, pagedPath, filterRow } = await import(JS + 'table.js');
const { cols, headsFor } = await import(JS + 'columns.js');
const { pill, typePill } = await import(JS + 'badges.js');
ok('le colonne di default esistono', cols('targets').length === 7, cols('targets').join(','));
ok('le intestazioni seguono le colonne scelte', headsFor('targets', cols('targets')).length === 7);
ok('i badge di tipo sono coerenti', typePill('os_app').className.includes('ty-both'));
ok('i pill di stato prendono la classe', pill('in_sync', 'ok').className.includes('ok'));
ok('pagedPath impagina', pagedPath('/targets', pg('targets'), '', 'id:DESC').includes('offset=0'));

/* --- 4. the column filters: debounced, and they keep the caret --------- */
const st = pg('targets'); st.f = {}; st.page = 3;
const fields = [{}, { key: 'name', ph: 'name' }, { key: 'type' }];
let renders = 0; const onChange = () => renders++;

let row = filterRow(fields, st, onChange);
ok('la prima cella resta senza filtro', row.children[0].children.length === 0);
let box = row.children[1].find('fbox');
ok('il campo ha icona, input e croce', !!box && box.children.length === 3);
ok('a vuoto non è evidenziato', !box.classList.contains('has'));

const inp = box.children[1];
inp.handlers.input({ target: { value: 'neo', selectionStart: 3 } });
ok('scrivere riporta alla prima pagina', st.page === 0);
ok('scrivere non spara una query per tasto', renders === 0);

inp.selectionStart = 2;
globalThis.document.activeElement = inp;
row = filterRow(fields, st, onChange);
box = row.children[1].find('fbox');
const inp2 = box.children[1];
ok('il valore sopravvive alla ricostruzione', inp2.value === 'neo', inp2.value);
ok('un filtro pieno si vede', box.classList.contains('has'));
globalThis.__frames.splice(0).forEach(f => f());
ok('il fuoco torna nella stessa colonna', inp2.focused === true);
ok('il caret torna dove era', inp2.caret === 2, String(inp2.caret));

globalThis.document.activeElement = inp2;
const other = filterRow(fields, st, onChange).children[2].find('fbox').children[1];
globalThis.__frames.splice(0).forEach(f => f());
ok('unaltra colonna non ruba il fuoco', other.focused !== true);

inp2.handlers.keydown({ key: 'Escape', target: inp2 });
ok('Esc svuota subito', st.f.name === '' && renders > 0);
st.f.name = 'x';
const before = renders;
box.find('fx').handlers.click();
ok('la croce svuota subito', st.f.name === '' && renders > before);

/* --- 5. the controls that replaced native widgets ---------------------- */
const { colourPicker, fileField } = await import(JS + 'inputs.js');
const cp = colourPicker('#12a594');
ok('il colore parte dal valore dato', cp.value === '#12a594', cp.value);
const sw = cp.children[0].children;
ok('la tavolozza ha dieci colori piu il custom', sw.length === 11, String(sw.length));
sw[3].handlers.click({ preventDefault() {} });          // h() aggancia con addEventListener
ok('scegliere una tessera cambia il valore', cp.value === '#46a758', cp.value);
ok('la tessera scelta si evidenzia', sw[3].classList.contains('on') && !sw[0].classList.contains('on'));
ok('nessun input nativo di colore nel controllo',
   !JSON.stringify(cp, (k, v) => (k === 'handlers' ? undefined : v)).includes('"color"'));

const hexIn = cp.find('hexbox').children[1];
hexIn.value = 'ff0000'; hexIn.oninput();
ok('lesadecimale valido viene accettato', cp.value === '#ff0000', cp.value);
hexIn.value = 'nonsense'; hexIn.oninput();
ok('lesadecimale non valido viene ignorato', cp.value === '#ff0000', cp.value);
hexIn.onblur();     // uscendo dal campo si ripristina il valore buono
ok('il campo si ripulisce da un valore non valido', hexIn.value === 'ff0000', hexIn.value);
ok('il campo non mostra un doppio cancelletto', !hexIn.value.startsWith('#'), hexIn.value);
const panel = cp.find('cpick-panel');
ok('il pannello custom parte chiuso', panel.classList.contains('hidden'));
sw[10].handlers.click({ preventDefault() {} });
ok('il custom apre il pannello nostro', !panel.classList.contains('hidden'));

const fz = fileField({ multiple: true });
ok('la zona di rilascio espone il suo input', fz.input && fz.input.nodeName === 'input');
ok('parte senza file', !fz.classList.contains('has'));
fz.input.files = [{ name: 'hello-1.1.3.swu', size: 622000000 }];
fz.input.onchange();
ok('mostra il file scelto', fz.classList.contains('has') && fz.textContent.includes('hello-1.1.3.swu'));

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
ok('accetta le query valide', pOk === good.length, `${pOk}/${good.length}`);
let nOk = 0;
for (const [q, why] of bad) {
  const r = check(q, 'targets');
  if (!r.ok) nOk++; else console.log('       ^ accettata a torto:', JSON.stringify(q), '(' + why + ')');
}
ok('respinge le query rotte', nOk === bad.length, `${nOk}/${bad.length}`);
const w = check('id==abc', 'targets');
ok('un id non numerico avverte ma non blocca', w.ok && !!w.warn, w.warn || '(nessun avviso)');
ok('lerrore indica la posizione', check('name==a;nonesuch==b', 'targets').at === 8,
   String(check('name==a;nonesuch==b', 'targets').at));
ok('lerrore suggerisce il campo vicino', /did you mean name/.test(check('nam==a', 'targets').msg || ''),
   check('nam==a', 'targets').msg);
ok('il tokenizer tiene le virgolette', tokenize('name=="a;b"').length === 3);
ok('a inizio riga si completano i campi', contextAt('', 0).want === 'field');
// mentre il campo si sta ancora scrivendo si completano i campi; l'operatore
// arriva quando il campo e' chiuso
ok('mentre si scrive il campo si completano i campi', contextAt('name', 4).want === 'field');
ok('a campo chiuso si completa loperatore', contextAt('name ', 5).want === 'op');
ok('dopo un operatore si completa il valore', contextAt('updatestatus==', 14).want === 'value');
ok('dopo un valore si completa la giunzione', contextAt('name==a ', 8).want === 'join');

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
  ok('costruire leditor non chiama onChange', fired === 0, `chiamate: ${fired}`);
  ok('leditor porta comunque il valore iniziale', ed.value === 'name==*neo*', ed.value);
  // ...but typing must
  const inp = ed.find('fq-in') || ed.children[0].children[1];
  inp.value = 'name==*x*';
  inp.oninput();
  ok('scrivere invece lo chiama', fired === 1, `chiamate: ${fired}`);
}

/* --- 8. a closed action must not look like a running one --------------- */
/* hawkBit keeps an action's LAST reported status even after it is closed, so a
   deployment that finished and was polled again reads "retrieved" for good.
   Spinning on that says work is under way when the action is over. */
{
  const { actionPill } = await import(JS + 'badges.js');
  const live = actionPill({ status: 'retrieved', active: true });
  ok('unazione attiva gira', live.className.includes('live'), live.className);
  const closed = actionPill({ status: 'retrieved', active: false });
  ok('unazione chiusa non gira', !closed.className.includes('live'), closed.className);
  ok('e dice che e chiusa', closed.textContent.includes('closed'), closed.textContent);
  const done = actionPill({ status: 'finished', active: false });
  ok('un esito resta un esito', done.className.includes('ok') && !done.textContent.includes('closed'));
  const err = actionPill({ status: 'error', active: false });
  ok('un errore resta un errore', err.className.includes('err'));
}

/* --- 9. "pending" broken down into what it is actually doing ----------- */
/* Built from a real action's status history, ids and all -- copied out of a
   combined deployment on a neo-intel. The ids matter: progress is the furthest
   point the chain reached, not the newest entry. */
{
  const { phaseFrom } = await import(JS + 'badges.js');
  const E = (id, type, msg) => ({ id, type, messages: msg ? [msg] : [] });
  const lab = e => (phaseFrom(e) || {}).label;

  const assigned  = [E(193, 'running', "Assignment initiated by user 'admin'")];
  const retrieved = assigned.concat(E(194, 'retrieved', 'Target retrieved update action'));
  const dl1       = retrieved.concat(E(195, 'running', 'Installing Update Chunk Artifacts.'),
                                     E(196, 'download', 'Target downloads /DEFAULT/...'));
  const chunk1    = dl1.concat(E(198, 'running', '[server_install_update] : Update successful'),
                               E(199, 'running', 'Installed Chunk.'));
  const dl2       = chunk1.concat(E(200, 'running', 'Installing Update Chunk Artifacts.'),
                                  E(201, 'download', 'Target downloads /DEFAULT/...'));
  const chunk2    = dl2.concat(E(204, 'running', 'Installed Chunk.'),
                               E(205, 'running', 'All Chunks Installed.'));
  const polled    = chunk2.concat(E(206, 'retrieved', 'Target retrieved update action'));

  ok('assegnata ma non ancora ritirata', lab(assigned) === 'assigned');
  ok('ritirata = sta scaricando', lab(retrieved) === 'downloading');
  // hawkBit notes "Installing Update Chunk Artifacts" and the downloads follow,
  // so at that point the device really is downloading
  ok('primo chunk: sta scaricando', lab(dl1) === 'downloading', lab(dl1));
  ok('e senza "(part N)" quando ce n e una sola', !/part/.test(lab(dl1)), lab(dl1));
  // "Update successful" arrives after EVERY chunk, so it cannot mean the end
  ok('dopo il primo chunk non dice ancora riavvio', lab(chunk1) !== 'waiting for reboot', lab(chunk1));
  ok('e dice che siamo alla seconda parte', /part 2/.test(lab(chunk1)), lab(chunk1));
  ok('seconda parte in download', /downloading \(part 2\)/.test(lab(dl2)), lab(dl2));
  ok('solo All Chunks Installed vale come fine', lab(chunk2) === 'waiting for reboot', lab(chunk2));
  // THE REGRESSION: a poll after the end used to drag it back to downloading
  ok('un poll dopo la fine non fa tornare indietro', lab(polled) === 'waiting for reboot', lab(polled));

  ok('in attesa di conferma umana',
     lab([E(1, 'wait_for_confirmation', '')]) === 'waiting for confirmation');
  ok('annullamento in corso', lab([E(1, 'canceling', '')]) === 'cancelling');
  ok('senza voci utili non inventa nulla', phaseFrom([]) === null);
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
  ok('ogni fase prodotta e descritta nella legenda', missing.length === 0,
     missing.join(', ') || `${produced.length} fasi`);
  const dead = [...described].filter(k => !produced.includes(k));
  ok('la legenda non descrive fasi che non esistono', dead.length === 0, dead.join(', '));

  // and the Targets legend is built from that same list
  const tsrc = await readFile(JS + 'views/targets.js', 'utf8');
  ok('la legenda dei target usa quella lista', tsrc.includes('PHASE_WORDS'));
}

console.log(`\n  ${pass} ok, ${failed} falliti`);
process.exit(failed ? 1 : 0);
