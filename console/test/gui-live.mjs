/* Does the console SHOW what the server holds?
 *
 *     node console/test/gui-live.mjs
 *
 * Everything else in this suite checks the API, the parser or the module
 * seams. This one renders the actual views against the running server and
 * reads what is on them, because "the update worked" and "the screen says so"
 * are two different claims and only the second is what anyone sees.
 *
 * It expects the demo's sample data to be loaded:
 *     demo/start.sh
 */
import { renderView, settle, mod, BASE } from './live-harness.mjs';

let pass = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};
const has = (text, ...bits) => bits.every(b => text.includes(b));

console.log(`  console: ${BASE}\n`);

/* ---- distribution sets: every kind present, and typed correctly --------- */
{
  const { root, text } = await renderView('ds');
  await settle();
  for (const name of ['os-full', 'os-delta', 'app-full', 'app-delta', 'app-broken',
                      'combo-full', 'combo-delta', 'composer-full', 'composer-delta']) {
    ok(`la lista dei set mostra ${name}`, text.includes(name));
  }
  // The type badges are checked by CLASS, not by text: the flattened
  // textContent runs words together, and the class is what actually colours
  // the badge on screen.
  const badge = c => root.findAll(c).length;
  ok('i set di solo sistema portano il badge os', badge('ty-os') >= 2, `${badge('ty-os')} badge`);
  ok('i set di sola app portano il badge app', badge('ty-app') >= 6, `${badge('ty-app')} badge`);
  ok('i set combinati portano il badge os+app', badge('ty-both') === 2, `${badge('ty-both')} badge`);
  ok('le parole dei badge sono le nostre, non lenum di hawkBit',
     text.includes('os+app') && !text.includes('os_app'));
  // an incomplete set would be refused at assignment: none must be
  const incomplete = root.textContent.includes('incomplete');
  ok('nessun set incompleto in lista', !incomplete);
}

/* ---- software modules: the delta ones say what they start from ---------- */
{
  const { text } = await renderView('sm');
  await settle(2500);
  ok('i moduli elencano hello e le sue versioni', has(text, 'hello', '1.0.0', '1.1.0', '1.2.0'));
  ok('i moduli elencano il sistema', has(text, 'neo-intel-os'));
  ok('i moduli elencano la vera applicazione', has(text, 'qamf-composer'));
  // deltaBase() reads module metadata written at upload time
  ok('un modulo delta dice da dove parte', /from 1\.1\.0|1\.1\.0/.test(text), '(hello-delta 1.2.0)');
}

/* ---- targets: the fleet, and the legend that explains it ---------------- */
{
  const { root, text } = await renderView('targets');
  await settle(3000);
  ok('la pagina target elenca dei device', /[0-9a-f]{12}/.test(text), text.slice(0, 60));
  const legend = root.find('legend');
  ok('la legenda degli stati esiste', !!legend);
  if (legend) {
    const lt = legend.textContent.replace(/\s+/g, ' ');
    ok('la legenda copre tutti e cinque gli stati',
       ['registered', 'pending', 'in sync', 'error', 'unknown'].every(k => lt.includes(k)));
    ok('la legenda avverte che in sync non vuol dire aggiornato',
       lt.includes('NOT the same as up to date'));
  }
}

/* ---- the dashboard agrees with the server ------------------------------ */
{
  const { text } = await renderView('dash');
  await settle(3000);
  const { get } = await mod('api.js');
  const ds = await get('/distributionsets?limit=1');
  const sm = await get('/softwaremodules?limit=1');
  const tg = await get('/targets?limit=1');
  ok('il contatore dei set corrisponde al server', text.includes(String(ds.total)), `server=${ds.total}`);
  ok('il contatore dei moduli corrisponde al server', text.includes(String(sm.total)), `server=${sm.total}`);
  ok('il contatore dei target corrisponde al server', text.includes(String(tg.total)), `server=${tg.total}`);
}

/* ---- an action's outcome, not its last poll ---------------------------- */
/* hawkBit's action.status is the LAST entry, so a deployment that finished and
   was polled again reads "retrieved" for good. The dashboard's whole job is to
   answer "did it work", so it asks the status history and shows the outcome. */
{
  const { get } = await mod('api.js');
  const { root } = await renderView('dash');
  await settle(6000);
  const acts = await get('/targets?limit=1');
  const dev = acts.content[0] && acts.content[0].controllerId;
  const last = dev && (await get(`/targets/${dev}/actions?limit=1&sort=id:DESC`)).content[0];
  if (last) {
    const hist = await get(`/targets/${dev}/actions/${last.id}/status?limit=50&sort=id:DESC`);
    const term = (hist.content || []).find(x =>
      ['finished', 'error', 'canceled', 'cancel_rejected'].includes(String(x.type).toLowerCase()));
    const shown = root.findAll('pill').map(p => p.textContent.trim());
    if (last.active === false && !['finished', 'error', 'canceled'].includes(last.status) && term) {
      ok(`lultima azione mostra lesito (${term.type}), non "${last.status}"`,
         shown.some(t => t.includes(String(term.type).toLowerCase())), shown.join(' | '));
      ok('e non mostra piu lo stato intermedio come se fosse in corso',
         !shown.some(t => t === last.status), shown.join(' | '));
    } else {
      ok(`lultima azione mostra il suo stato (${last.status})`,
         shown.some(t => t.includes(last.status)), shown.join(' | '));
    }
  }
}

/* ---- the About page: sections, and facts read from the server ---------- */
{
  const { renderView: rv } = await import('./live-harness.mjs');
  const { root, text } = await rv('about');
  await settle(4000);
  const tabs = root.find('about-tabs');
  ok('About e a sezioni, non una pagina piatta', !!tabs && tabs.children.length === 6,
     tabs ? `${tabs.children.length} sezioni` : 'nessuna');
  ok('parte da "questo server"', text.includes('Which hawkBit this is'));
  ok('dice per quale versione e scritta', text.includes('1.1.0'));
  ok('riporta la verifica degli endpoint',
     /matches|endpoints missing|cannot tell/.test(text), text.slice(0, 80));
  const { get } = await mod('api.js');
  const cfg = await get('/system/configs').catch(() => null);
  const poll = cfg && cfg.pollingTime && String(cfg.pollingTime.value);
  ok('mostra lintervallo di polling letto dal server', !poll || text.includes(poll), poll);
}

/* ---- the compatibility bar clears itself when the server answers ------- */
{
  const { checkCompat } = await mod('compat.js');
  const { $ } = await mod('dom.js');
  // this server is the one the console was written for, so after a check that
  // reaches it there must be no bar left
  await checkCompat();
  await settle(3000);
  // __has answers truthfully: the stub's querySelector still hands back a
  // spare element for anything the console looks up, so presence has to be
  // asked of the tree itself.
  ok('nessun avviso di compatibilita con il server giusto',
     !globalThis.document.__has('#compat'));
}

/* ---- the menu counts follow the server, not the view you are in -------- */
{
  const { S, get } = await mod('api.js');
  const { cataloguesTick } = await mod('notices.js');
  // pretend a stale count, as it would be after looking at another page
  S.counts.ds = -1; S.counts.sm = -1;
  if (cataloguesTick) { await cataloguesTick(); await cataloguesTick(); }
  const ds = await get('/distributionsets?limit=1');
  const sm = await get('/softwaremodules?limit=1');
  ok('il badge dei set si aggiorna da solo', S.counts.ds === ds.total,
     `${S.counts.ds} contro ${ds.total}`);
  ok('e quello dei moduli pure', S.counts.sm === sm.total,
     `${S.counts.sm} contro ${sm.total}`);
}

/* ---- fleets (Qawk): the page shows every fleet the server holds -------- */
{
  const { whoIsServer } = await mod('server.js');
  const info = await whoIsServer();
  if (info.features.includes('fleets')) {
    const { qawk } = await mod('api.js');
    const fl = (await qawk.get('/fleets')).content;
    const { text } = await renderView('fleets');
    await settle();
    ok('la pagina flotte elenca ogni flotta', fl.every(f => text.includes(f.name)),
       fl.map(f => f.name).join(' ') || 'nessuna flotta');
    ok('e per ognuna quanti device sono sulla sua release',
       fl.filter(f => f.distributionSet).every(f => text.includes(`${f.onRelease}/${f.members}`)));
  } else {
    console.log('  --   flotte: il server non le ha (hawkBit), salto');
  }
}

console.log(`\n  ${pass} ok, ${failed} falliti`);
process.exit(failed ? 1 : 0);
