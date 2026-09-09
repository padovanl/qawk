/* What does the console show for one device, right now?
 *
 *     node ota/hawkbit-ui/test/gui-target.mjs <controllerId>
 *     node ota/hawkbit-ui/test/gui-target.mjs <controllerId> --expect-status in_sync \
 *                                             --expect-installed "app-full 1.1.0"
 *
 * Used between the steps of a deployment pass. After each install there are two
 * separate claims -- the device is running the new version, and the console
 * says so -- and only the second is what anyone looks at. This renders the
 * targets table and the device's own drawer through the real modules and reads
 * them back.
 *
 * Exit code is 1 if an --expect is not met, so it can sit in a script.
 */
import { renderView, settle, mod } from './live-harness.mjs';

const args = process.argv.slice(2);
const id = args[0];
if (!id || id.startsWith('--')) {
  console.log('usage: gui-target.mjs <controllerId> [--expect-status X] [--expect-installed "name version"]');
  process.exit(2);
}
const opt = n => { const i = args.indexOf('--' + n); return i === -1 ? null : args[i + 1]; };

const { get, enc } = await mod('api.js');
const { S } = await mod('api.js');

/* ---- the row, as the table draws it ----------------------------------- */
S.q = id;
const { root, text } = await renderView('targets');
await settle(4000);

// Only the table: the state legend on the same page carries one pill per
// state, and counting those would make every assertion pass.
const table = root.find('t') || root;
const pills = table.findAll('pill').map(p => p.textContent.trim()).filter(Boolean);
const row = table.textContent.replace(/\s+/g, ' ').trim();

/* ---- and what the server says, for comparison -------------------------- */
const t = await get(`/targets/${enc(id)}`);
const inst = await get(`/targets/${enc(id)}/installedDS`).catch(() => null);
const asg = await get(`/targets/${enc(id)}/assignedDS`).catch(() => null);
const acts = await get(`/targets/${enc(id)}/actions?limit=3&sort=id:DESC`).catch(() => ({ content: [] }));

const nv = d => (d && d.name ? `${d.name} ${d.version}` : '—');
console.log(`  device     : ${id}`);
console.log(`  server says: status=${t.updateStatus}  assigned=${nv(asg)}  installed=${nv(inst)}`);
console.log(`  last action: ${acts.content[0]
  ? `#${acts.content[0].id} ${acts.content[0].status}${acts.content[0].active ? ' (active)' : ''}`
  : 'none'}`);
console.log(`  gui pills  : ${pills.join(' | ') || '(none)'}`);
console.log(`  gui row    : ${row.slice(0, 220)}`);

let bad = 0;
const check = (what, cond, extra) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${extra ? '  ' + extra : ''}`);
  if (!cond) bad++;
};

/* The table must agree with the server: that is the whole point. */
check('la GUI mostra lo stato del server',
      pills.some(p => p.replace(/\s/g, '_').includes(t.updateStatus)),
      `server=${t.updateStatus} gui=[${pills.join(',')}]`);

if (inst && inst.name) {
  check("la GUI mostra la versione installata",
        row.includes(inst.name) && row.includes(inst.version), nv(inst));
}

const wantStatus = opt('expect-status');
if (wantStatus) {
  check(`lo stato è ${wantStatus}`, t.updateStatus === wantStatus, `è ${t.updateStatus}`);
  check(`la GUI lo mostra come ${wantStatus}`,
        pills.some(p => p.replace(/\s/g, '_').includes(wantStatus)));
}
const wantInstalled = opt('expect-installed');
if (wantInstalled) {
  check(`l'installato è ${wantInstalled}`, nv(inst) === wantInstalled, `è ${nv(inst)}`);
  check('la GUI mostra quell installato', row.includes(wantInstalled.split(' ')[0])
        && row.includes(wantInstalled.split(' ')[1]));
}
const wantAction = opt('expect-action');
if (wantAction) {
  const a = acts.content[0];
  check(`l'ultima azione è ${wantAction}`, a && a.status === wantAction, a ? a.status : 'nessuna');
}

process.exit(bad ? 1 : 0);
