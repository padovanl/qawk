/* The API reference checks itself.
 *
 *   node docs/check.mjs
 *
 * The spec must parse, every endpoint must carry what the page needs to draw
 * it, and every one of the five code generators must produce something for
 * every endpoint -- so a spec entry that would render a blank sample, or an
 * endpoint with no description, fails here rather than in front of a reader. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stub = () => ({
  classList: { add() {}, contains: () => false }, style: {},
  appendChild() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null,
});
globalThis.window = { QawkDocs: { el: stub, url: (x) => x } };
globalThis.localStorage = { getItem: () => null, setItem() {} };
// node 21+ has a real navigator, and it is read-only; only define one if it is
// not already there
if (!globalThis.navigator) globalThis.navigator = {};
globalThis.document = {
  readyState: 'complete', getElementById: () => null, addEventListener() {},
  querySelector: () => null, querySelectorAll: () => [], createElement: stub,
};

const LANGS = ['curl', 'python', 'javascript', 'go', 'powershell'];
let bad = 0;
const fail = (...m) => { console.error('  FAIL', ...m); bad++; };

eval(readFileSync(join(here, 'assets/api/spec.js'), 'utf8'));
const SPEC = window.QAWK_API;

eval(readFileSync(join(here, 'assets/js/apidoc.js'), 'utf8')
  .replace('})();', 'window.__T = { GEN, ALL, SLOTS, pathParams };})();'));
const { GEN, ALL, SLOTS, pathParams } = window.__T;

for (const key of Object.keys(SPEC)) {
  const api = SPEC[key];
  for (const f of ['id', 'title', 'base', 'prefix', 'auth', 'blurb']) {
    if (!api[f]) fail(key, 'the API has no', f);
  }
}

const seen = new Set();
let n = 0;
for (const key of Object.keys(ALL)) {
  const ep = ALL[key], api = SPEC[ep.api];
  n++;
  if (seen.has(key)) fail(key, 'two endpoints share an id');
  seen.add(key);
  if (!ep.t) fail(key, 'no title');
  if (!ep.p || !ep.p.startsWith('/')) fail(key, 'a path must start with /');
  if (!/^(GET|POST|PUT|DELETE|PATCH|HEAD)$/.test(ep.m)) fail(key, 'odd method', ep.m);
  if (!ep.res || !Object.keys(ep.res).length) fail(key, 'no responses');
  for (const [code, r] of Object.entries(ep.res || {})) {
    if (!/^\d{3}$/.test(code)) fail(key, 'odd status code', code);
    if (!r.d) fail(key, code, 'has no description');
  }
  // every {slot} in the path must be described, and must have an example
  // value, or a generated sample would be handed to a reader with a
  // placeholder still in it
  const documented = pathParams(ep, api);
  const slots = [...ep.p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  for (const slot of slots) {
    const row = documented.find((p) => p[0] === slot);
    if (!row || !row[3]) fail(key, 'path has {' + slot + '} but does not describe it');
    if (!SLOTS[slot]) fail(key, 'no example value for {' + slot + '}: samples would show the placeholder');
  }
  for (const L of LANGS) {
    let out;
    try { out = GEN[L](ep, api); } catch (e) { fail(key, L, e.message); continue; }
    if (!out || out.length < 20) fail(key, L, 'generated nothing usable');
    // {BASE} and ${base} belong to the sample; a path slot left in does not
    for (const slot of slots) {
      if (out.includes('{' + slot + '}')) fail(key, L, 'left {' + slot + '} unfilled');
    }
  }
}

console.log(`${n} endpoints, ${n * LANGS.length} generated samples, ${bad} problems`);
process.exit(bad ? 1 : 0);
