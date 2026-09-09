/* Runs the console's real views against a real hawkBit, under node.
 *
 * Not a mock and not a second implementation: it imports the same modules the
 * browser loads, points their fetch at the running proxy, and renders a view
 * into a stub element. What comes back is what the page would show.
 *
 * That is the only way to check the thing that actually matters during a test
 * pass -- not "the API returned 200" but "the screen says what happened". A
 * device can be updated correctly and the console still show it yellow, or
 * green, or with an empty version, and every one of those has happened here.
 */
import { install } from './dom-stub.mjs';

const realFetch = globalThis.fetch.bind(globalThis);
install();

export const BASE = process.env.HB_CONSOLE || 'http://localhost:8090';
const USER = process.env.HB_USER || 'admin';
const PASS = process.env.HB_PASS || 'changeme';
const AUTH = Buffer.from(`${USER}:${PASS}`).toString('base64');

/* The console fetches relative URLs ('/rest/v1/targets'), which node cannot
   resolve, and sends its own Authorization from sessionStorage. Both are
   supplied here so the modules are used exactly as written. */
globalThis.fetch = (url, opts = {}) => {
  const u = String(url).startsWith('http') ? String(url) : BASE + String(url);
  const headers = Object.assign({}, opts.headers, { Authorization: 'Basic ' + AUTH });
  return realFetch(u, Object.assign({}, opts, { headers }));
};
globalThis.sessionStorage.setItem('hb-auth', AUTH);

const JS = new URL('../js/', import.meta.url).href;
export const mod = name => import(JS + name);

const { S } = await mod('api.js');
S.auth = AUTH;
S.user = USER;
await mod('main.js');                       // registers every view
export const { VIEWS } = await mod('router.js');

/* Render one view and hand back the element plus its flattened text. Views
   fill nav counts and other page furniture that does not exist here; the stub
   swallows it. */
export async function renderView(id, prepare) {
  const { El } = await import('./dom-stub.mjs');
  const root = new El('div');
  if (prepare) await prepare(S);
  await VIEWS[id].render(root);
  return { root, text: root.textContent.replace(/\s+/g, ' ').trim() };
}

/* Some cells fill themselves in after the render (assigned/installed, delta
   base, attributes): they each start a request and replace their own content.
   This waits for those to settle rather than guessing with a fixed delay. */
export async function settle(ms = 1500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 60));
    const { S: st } = await mod('api.js');
    if (st.busy === 0) { await new Promise(r => setTimeout(r, 120)); if (st.busy === 0) return; }
  }
}

export const reset = async () => {
  const { S: st } = await mod('api.js');
  st.q = ''; st.status = ''; st.picked.clear(); st.dsCache = null;
  const { PG } = await mod('table.js').then(m => ({ PG: m.pg }));
  for (const v of ['targets', 'ds', 'sm', 'ro']) { const p = PG(v); p.f = {}; p.page = 0; }
};
