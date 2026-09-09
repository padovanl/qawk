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
ok('la tavolozza ha dieci colori piu custom', sw.length === 12, String(sw.length));
sw[3].handlers.click({ preventDefault() {} });          // h() aggancia con addEventListener
ok('scegliere una tessera cambia il valore', cp.value === '#46a758', cp.value);
ok('la tessera scelta si evidenzia', sw[3].classList.contains('on') && !sw[0].classList.contains('on'));
const hexIn = cp.children[1].children[0].children[1];
hexIn.value = '#ff0000'; hexIn.oninput();
ok('lesadecimale valido viene accettato', cp.value === '#ff0000', cp.value);
hexIn.value = 'nonsense'; hexIn.oninput();
ok('lesadecimale non valido viene ignorato', cp.value === '#ff0000', cp.value);

const fz = fileField({ multiple: true });
ok('la zona di rilascio espone il suo input', fz.input && fz.input.nodeName === 'input');
ok('parte senza file', !fz.classList.contains('has'));
fz.input.files = [{ name: 'hello-1.1.3.swu', size: 622000000 }];
fz.input.onchange();
ok('mostra il file scelto', fz.classList.contains('has') && fz.textContent.includes('hello-1.1.3.swu'));

console.log(`\n  ${pass} ok, ${failed} falliti`);
process.exit(failed ? 1 : 0);
