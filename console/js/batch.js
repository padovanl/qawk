import { enc, get, limited } from './api.js';
import { serverInfo } from './server.js';

/* ONE REQUEST PER PAGE, NOT ONE PER ROW.
 *
 * hawkBit answers one target at a time, so a table of fifty devices asked for
 * each one's action, history, sets and attributes separately: a hundred and
 * fifty requests every few seconds, per browser, while a release was going
 * out -- the console crawled at ten thousand devices. Qawk answers a page of
 * them at once (/qawk/v1/targets/state and /attributes). Against a server
 * without it, these fall back to one request per target, as before. */
const hasFeature = f => ((serverInfo() || {}).features || []).includes(f);
const hasBatch = () => hasFeature('batch');

const chunks = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// What each device is doing: latest action, its history, downloads, sets.
async function statesOf(ids) {
  const m = new Map();
  if (!ids.length) return m;
  await Promise.all(chunks([...new Set(ids)], 200).map(async part => {
    const r = await get('/qawk/v1/targets/state?ids=' + part.map(enc).join(','), { abs: true });
    (r.content || []).forEach(s => m.set(s.controllerId, s));
  }));
  return m;
}

async function attributesOf(ids) {
  const m = new Map();
  if (!ids.length) return m;
  if (hasBatch()) {
    await Promise.all(chunks([...new Set(ids)], 200).map(async part => {
      const r = await get('/qawk/v1/targets/attributes?ids=' + part.map(enc).join(','), { abs: true });
      Object.entries(r.content || {}).forEach(([k, v]) => m.set(k, v));
    }));
    return m;
  }
  await Promise.all(ids.map(async id => {
    m.set(id, await limited(() => get(`/targets/${enc(id)}/attributes`)).catch(() => ({})));
  }));
  return m;
}

// The attributes of n devices, for completing names and values in editors.
async function sampleAttributes(n) {
  const s = await get(`/targets?limit=${n}`).catch(() => ({ content: [] }));
  const m = await attributesOf((s.content || []).map(t => t.controllerId));
  return [...m.values()];
}

export { attributesOf, hasBatch, hasFeature, sampleAttributes, statesOf };
