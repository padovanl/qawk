// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

/* Cross-checks the FIQL editor's opinion against a running hawkBit.
 *
 *     node console/test/fiql-live.mjs [url] [user] [password]
 *
 * The editor's field lists were read off a live server rather than out of the
 * documentation, and this is what keeps them honest: for every field it claims
 * exists, and every enum value it offers, it asks the server. A disagreement
 * in either direction is a bug --
 *
 *   the editor says valid, hawkBit says 400  -> it will let someone save a
 *                                               filter that matches nothing
 *   the editor says invalid, hawkBit says OK -> it refuses a legal query
 *
 * Needs the server; the rest of the suite (smoke.mjs) does not.
 */
import { install } from './dom-stub.mjs';

// the stub replaces globalThis.fetch with one that always says OK, so the real
// one has to be kept before the console's modules are loaded
const realFetch = globalThis.fetch.bind(globalThis);
install();

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'changeme';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const { FIELDS, OPS, check } = await import(new URL('../js/fiql.js', import.meta.url).href);

const ENTITY_PATH = {
  targets: '/rest/v1/targets',
  distributionsets: '/rest/v1/distributionsets',
  softwaremodules: '/rest/v1/softwaremodules',
  rollouts: '/rest/v1/rollouts',
};

async function server(entity, q) {
  const u = `${BASE}${ENTITY_PATH[entity]}?limit=1&q=${encodeURIComponent(q)}`;
  const r = await realFetch(u, { headers: { Authorization: AUTH } });
  if (r.ok) return { ok: true };
  const b = await r.json().catch(() => ({}));
  return { ok: false, code: (b.errorCode || String(r.status)).replace('hawkbit.server.error.', '') };
}

try {
  const probe = await realFetch(`${BASE}/rest/v1/targets?limit=1`, { headers: { Authorization: AUTH } });
  if (!probe.ok) throw new Error('HTTP ' + probe.status);
} catch (e) {
  console.log(`  hawkBit non raggiungibile su ${BASE}: ${e.message}`);
  console.log('  (questo test richiede il server; smoke.mjs no)');
  process.exit(2);
}

let checked = 0, disagree = 0;
const note = (entity, q, mine, theirs) => {
  checked++;
  if (mine === theirs) return;
  disagree++;
  console.log(`  DISACCORDO  ${entity}  ${q}`);
  console.log(`      editor: ${mine ? 'valida' : 'non valida'} | hawkBit: ${theirs ? 'accettata' : 'rifiutata'}`);
};

/* 1. every field the editor offers must exist on the server */
for (const [entity, list] of Object.entries(FIELDS)) {
  for (const f of list) {
    // a prefix field ("attribute.", "metadata.") needs a key after the dot
    const name = f.f.endsWith('.') ? f.f + 'probe_key' : f.f;
    const value = f.v ? f.v[0] : (f.t === 'num' ? '1' : 'x');
    const q = `${name}==${value}`;
    note(entity, q, check(q, entity).ok, (await server(entity, q)).ok);
  }
}

/* 2. every enum value the editor offers must be one the server knows */
for (const [entity, list] of Object.entries(FIELDS)) {
  for (const f of list.filter(x => x.v)) {
    for (const v of f.v) {
      const q = `${f.f}==${v}`;
      note(entity, q, check(q, entity).ok, (await server(entity, q)).ok);
    }
  }
}

/* 3. every operator, on a field where it makes sense */
for (const o of OPS) {
  const q = o.o === '=in=' || o.o === '=out=' ? `updatestatus${o.o}(in_sync,error)` : `id${o.o}1`;
  note('targets', q, check(q, 'targets').ok, (await server('targets', q)).ok);
}

/* 4. things the editor refuses had better be refused there too */
for (const q of ['nonesuch==x', 'updatestatus==nonsense', 'attribute.==x', 'id==abc']) {
  note('targets', q, check(q, 'targets').ok, (await server('targets', q)).ok);
}

console.log(`\n  ${checked} query confrontate con ${BASE}, ${disagree} disaccordi`);
process.exit(disagree ? 1 : 0);
