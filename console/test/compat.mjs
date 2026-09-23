// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

/* Keeps the compatibility check honest.
 *
 *     node console/test/compat.mjs           # list only, no server
 *     node console/test/compat.mjs --live    # also ask hawkBit
 *
 * js/compat.js carries the list of endpoints the console needs, and warns on
 * screen when the server it is pointed at does not have them. A list like that
 * rots the moment someone calls a new endpoint and forgets it, and the warning
 * would then be silent about exactly the thing that broke. So this re-derives
 * the calls from the source and compares.
 *
 * With --live it also asks the running hawkBit for its own API description and
 * checks the list against it, which is what proves the console really is
 * talking to the release it was pinned to.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { install } from './dom-stub.mjs';

const realFetch = globalThis.fetch.bind(globalThis);
install();

const JS = fileURLToPath(new URL('../js/', import.meta.url));
const { NEEDED, EXPECTED_VERSION, shape } = await import(JS + 'compat.js');

let pass = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};

/* ---- 1. what the source actually calls -------------------------------- */
async function sources(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...await sources(dir + e.name + '/'));
    else if (e.name.endsWith('.js')) out.push(dir + e.name);
  }
  return out;
}
/* A template literal may hold quotes inside its ${...}, so it cannot be read
   with the same rule as a quoted string. And a path built by concatenation --
   del('/targets/' + id) -- ends at the slash, which stands for a parameter. */
/* Not preceded by a dot: `qawk.get('/fleets')` is a call to Qawk's own API,
   which is not hawkBit's and is not in the compatibility list. \b would match
   after the dot and file it under /rest/v1/fleets, which does not exist. */
const CALL = /(?<![.\w$])(get|post|put|del|upload)\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g;
const called = new Map();
for (const f of await sources(JS)) {
  const src = await readFile(f, 'utf8');
  for (const m of src.matchAll(CALL)) {
    const verb = m[1];
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    if (!raw.startsWith('/')) continue;             // a variable, checked below
    if (raw.startsWith('/v3/')) continue;           // the API description itself
    if (raw.startsWith('/qawk/')) continue;         // Qawk's own additions, not hawkBit's API
    // the ${...} go first: a ternary inside one contains a '?', which would
    // otherwise be mistaken for the start of the query string
    let path = raw.replace(/\$\{[^}]*\}/g, '{}').split('?')[0];
    // '/targets/' + id : the trailing slash is where the parameter goes
    path = path.endsWith('/') ? path + '{}' : path;
    const p = '/rest/v1' + path;
    const method = ({ del: 'delete', upload: 'post' })[verb] || verb;
    if (!called.has(p)) called.set(p, new Set());
    called.get(p).add(method);
  }
}

/* A couple of call sites build the last segment from a word rather than an id,
   so one call stands for several real endpoints. */
const EXPANDS = {
  '/rest/v1/targets/{}/autoConfirm/{}': [
    '/rest/v1/targets/{}/autoConfirm/activate',
    '/rest/v1/targets/{}/autoConfirm/deactivate',
  ],
};
// the tag delete builds its whole path from variables ('/' + kind + '/' + id):
// there is no name to match, and its endpoints are listed under their tags
const UNNAMEABLE = new Set(['/rest/v1/{}', '/rest/v1/{}/{}']);

const listed = new Map(Object.entries(NEEDED).map(([p, ms]) => [shape(p), new Set(ms)]));

/* A call site may spell a parameter out -- get('/system/configs/pollingTime')
   -- where the list names the shape it belongs to,
   /rest/v1/system/configs/{keyName}. Try the path as written first, then with
   each single segment stood in for, and take the listed shape that matches. */
function find(path) {
  const exact = listed.get(shape(path));
  if (exact) return exact;
  const parts = path.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i] === '{}' || parts[i] === '') continue;
    const tried = parts.slice();
    tried[i] = '{}';
    const have = listed.get(tried.join('/'));
    if (have) return have;
  }
  return undefined;
}

const unlisted = [];
for (const [p, methods] of called) {
  if (UNNAMEABLE.has(p)) continue;
  for (const real of EXPANDS[p] || [p]) {
    const have = find(real);
    if (!have) { unlisted.push(`${real} (${[...methods].join(',')})`); continue; }
    const gone = [...methods].filter(m => !have.has(m));
    if (gone.length) unlisted.push(`${real} — ${gone.join(',')} not listed`);
  }
}
ok("every endpoint the source calls is in compat.js's list",
   unlisted.length === 0, unlisted.join(' | '));

const reachable = new Set();
for (const p of called.keys()) for (const real of EXPANDS[p] || [p]) reachable.add(shape(real));
const dead = [...listed.keys()].filter(p => !reachable.has(p));
ok('the list holds no endpoint nobody calls', dead.length === 0, dead.join(' '));
console.log(`       ${listed.size} endpoints listed, ${called.size} called by the source`);

/* ---- 2. against a running hawkBit ------------------------------------- */
if (process.argv.includes('--live')) {
  const BASE = (process.argv[3] || 'http://localhost:8080').replace(/\/$/, '');
  const AUTH = 'Basic ' + Buffer.from('admin:changeme').toString('base64');
  let doc;
  try {
    const r = await realFetch(`${BASE}/v3/api-docs/Management%20API`, { headers: { Authorization: AUTH } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    doc = await r.json();
  } catch (e) {
    console.log(`\n  hawkBit is not reachable at ${BASE}: ${e.message}`);
    process.exit(2);
  }
  const have = new Map(Object.entries(doc.paths || {})
    .map(([p, ops]) => [shape(p), new Set(Object.keys(ops).map(m => m.toLowerCase()))]));
  const missing = [];
  for (const [p, methods] of Object.entries(NEEDED)) {
    const got = have.get(shape(p));
    if (!got) { missing.push(p + ' is absent'); continue; }
    const gone = methods.filter(m => !got.has(m));
    if (gone.length) missing.push(`${p} without ${gone.join(',')}`);
  }
  ok(`the server has every endpoint hawkBit ${EXPECTED_VERSION} is expected to have`,
     missing.length === 0, missing.join(' | '));
  ok('the server declares API v1', ((doc.info || {}).version) === 'v1', (doc.info || {}).version);
}

console.log(`\n  ${pass} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
