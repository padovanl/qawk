import { get } from './api.js';
import { $, h, icon } from './dom.js';

/* Is this the hawkBit the console was written against?
 *
 * The console is not a generic client. It knows that an action carries no
 * detailStatus, that deactivating auto-confirmation is a POST and not a
 * DELETE, that an incomplete distribution set is refused with
 * hawkbit.server.error.distributionset.incomplete, and which endpoints exist.
 * Those are facts about one release. Pointed at another, it can be subtly
 * wrong -- a button that does nothing, a count that never fills in -- and
 * whoever is using it deserves to be told rather than to find out during a
 * rollout.
 *
 * hawkBit does not publish its release over HTTP. /actuator is off, and the
 * OpenAPI document reports the API version ("v1"), not the product's -- 1.1.0
 * is only in the jar manifest, which the browser cannot reach. So the check is
 * not a version string comparison: it asks the server for its own API
 * description and verifies that every endpoint this console calls is really
 * there, with the methods it uses.
 *
 * That is the more useful question anyway. A release that renames nothing the
 * console touches will not raise a false alarm, and one that removes something
 * is caught by name.
 */

const EXPECTED_VERSION = '1.1.0';       // the hawkBit release the console is checked against
const EXPECTED_API = 'v1';
const DOC = '/v3/api-docs/Management%20API';

/* Every path the console calls, with the methods it uses on it -- derived from
   the source, and kept honest by a test that re-derives it (see
   test/compat.mjs, which fails if the code calls something not listed here). */
const NEEDED = {
  // the console watches every deployment, not only its own
  '/rest/v1/actions': ['get'],
  '/rest/v1/targets': ['get', 'post'],
  '/rest/v1/targets/{targetId}': ['get', 'delete'],
  '/rest/v1/targets/{targetId}/actions': ['get'],
  '/rest/v1/targets/{targetId}/actions/{actionId}': ['get', 'delete'],
  '/rest/v1/targets/{targetId}/actions/{actionId}/status': ['get'],
  '/rest/v1/targets/{targetId}/actions/{actionId}/confirmation': ['put'],
  '/rest/v1/targets/{targetId}/attributes': ['get'],
  '/rest/v1/targets/{targetId}/assignedDS': ['get'],
  '/rest/v1/targets/{targetId}/installedDS': ['get'],
  '/rest/v1/targets/{targetId}/tags': ['get'],
  '/rest/v1/targets/{targetId}/autoConfirm': ['get'],
  // one call site, two literal endpoints -- deactivating is a POST here, not
  // a DELETE, which is the kind of thing this whole check exists for
  '/rest/v1/targets/{targetId}/autoConfirm/activate': ['post'],
  '/rest/v1/targets/{targetId}/autoConfirm/deactivate': ['post'],
  '/rest/v1/targettags': ['get'],
  '/rest/v1/targettags/{targetTagId}/assigned': ['post'],
  '/rest/v1/targettags/{targetTagId}/assigned/{controllerId}': ['delete'],
  '/rest/v1/targettypes': ['get'],
  '/rest/v1/targetfilters': ['get', 'post'],
  '/rest/v1/targetfilters/{filterId}': ['put', 'delete'],
  '/rest/v1/targetfilters/{filterId}/autoAssignDS': ['post', 'delete'],
  '/rest/v1/distributionsets': ['get', 'post'],
  '/rest/v1/distributionsets/{distributionSetId}': ['get', 'delete'],
  '/rest/v1/distributionsets/{distributionSetId}/assignedSM': ['get', 'post'],
  '/rest/v1/distributionsets/{distributionSetId}/assignedSM/{softwareModuleId}': ['delete'],
  '/rest/v1/distributionsets/{distributionSetId}/assignedTargets': ['post'],
  '/rest/v1/distributionsettags': ['get'],
  '/rest/v1/distributionsettypes': ['get'],
  '/rest/v1/softwaremodules': ['get', 'post'],
  '/rest/v1/softwaremodules/{softwareModuleId}': ['delete'],
  '/rest/v1/softwaremodules/{softwareModuleId}/artifacts': ['get'],
  '/rest/v1/softwaremodules/{softwareModuleId}/artifacts/{artifactId}': ['delete'],
  '/rest/v1/softwaremodules/{softwareModuleId}/metadata': ['get'],
  '/rest/v1/softwaremoduletypes': ['get'],
  '/rest/v1/rollouts': ['get', 'post'],
  '/rest/v1/rollouts/{rolloutId}': ['get', 'delete'],
  '/rest/v1/rollouts/{rolloutId}/start': ['post'],
  '/rest/v1/rollouts/{rolloutId}/pause': ['post'],
  '/rest/v1/rollouts/{rolloutId}/resume': ['post'],
  '/rest/v1/rollouts/{rolloutId}/approve': ['post'],
  '/rest/v1/rollouts/{rolloutId}/deny': ['post'],
  '/rest/v1/rollouts/{rolloutId}/triggerNextGroup': ['post'],
  '/rest/v1/rollouts/{rolloutId}/deploygroups': ['get'],
  '/rest/v1/rollouts/{rolloutId}/deploygroups/{groupId}/targets': ['get'],
  // the About page reads the whole tenant configuration at once
  '/rest/v1/system/configs': ['get'],
  '/rest/v1/system/configs/{keyName}': ['get', 'put'],
};


/* A path is named by its shape, not by its parameter names: hawkBit is free to
   rename {targetId} without breaking anything. */
const shape = p => p.replace(/\{[^}]*\}/g, '{}');

async function inspect() {
  let doc;
  try {
    doc = await get(DOC, { abs: true });
  } catch (e) {
    return { known: false, why: 'this server does not publish an API description ('
                              + (e.message || 'request failed') + ')' };
  }
  const api = (doc.info || {}).version || '?';
  const have = new Map();
  for (const [p, ops] of Object.entries(doc.paths || {})) {
    have.set(shape(p), new Set(Object.keys(ops).map(m => m.toLowerCase())));
  }
  const missing = [];
  for (const [p, methods] of Object.entries(NEEDED)) {
    const got = have.get(shape(p));
    if (!got) { missing.push(`${p} — not on this server`); continue; }
    const gone = methods.filter(m => !got.has(m));
    if (gone.length) missing.push(`${p} — no ${gone.join(', ').toUpperCase()}`);
  }
  return { known: true, api, missing, total: Object.keys(NEEDED).length };
}

/* The bar. It sits above everything, is not a toast (a toast goes away), and
   can be put aside for the session but comes back on the next sign-in. */
function banner(kind, headline, detail, lines) {
  if ($('#compat')) $('#compat').remove();
  const list = lines && lines.length
    ? h('ul.compat-list.hidden', lines.map(l => h('li', l)))
    : null;
  const bar = h('div#compat.compat.' + kind,
    h('div.compat-row',
      icon(kind === 'bad' ? 'x' : 'info', 16),
      h('div.compat-t', h('b', headline), h('span', detail)),
      list ? h('button.btn.sm', {
        onclick: e => {
          list.classList.toggle('hidden');
          e.target.closest('button').textContent =
            list.classList.contains('hidden') ? 'what is missing' : 'hide';
        },
      }, 'what is missing') : null,
      h('button.btn.sm.ghost', {
        title: 'hide until the next sign-in',
        onclick: () => { sessionStorage.setItem('hb-compat-hidden', '1'); bar.remove(); },
      }, '×')),
    list);
  $('#main').prepend(bar);
}

/* Run after sign-in, and again if the server was not answering yet.
 *
 * hawkBit takes about a minute to answer after its container starts, so a
 * console opened alongside it asks a server that is not there and says "cannot
 * tell which hawkBit this is". That was then on screen for good: the check ran
 * once. A warning that outlives the thing it warned about teaches people to
 * ignore warnings.
 *
 * So while the verdict is "cannot tell" it keeps asking, quietly, and the bar
 * removes itself the moment the answer is good.
 */
let compatTimer = null;

function clearBanner() {
  const b = $('#compat');
  if (b) b.remove();
}

async function checkCompat() {
  if (sessionStorage.getItem('hb-compat-hidden')) return;
  const r = await inspect();

  if (!r.known) {
    banner('warn', 'Cannot tell which hawkBit this is',
      `the console is written for ${EXPECTED_VERSION}; ${r.why}. `
      + 'Still trying — this clears itself as soon as the server answers.');
    if (!compatTimer) compatTimer = setInterval(retry, 15000);
    return;
  }

  // We got an answer: stop asking, whatever it says.
  if (compatTimer) { clearInterval(compatTimer); compatTimer = null; }

  if (r.api !== EXPECTED_API) {
    banner('bad', `This hawkBit speaks API ${r.api}, not ${EXPECTED_API}`,
      `the console is written for hawkBit ${EXPECTED_VERSION}. Things may not work.`);
    return;
  }
  if (r.missing.length) {
    banner('bad', 'This is not the hawkBit the console was written for',
      `${r.missing.length} of the ${r.total} endpoints it uses are missing or changed — `
      + `it expects ${EXPECTED_VERSION}. Whatever depends on them will not work.`,
      r.missing);
    return;
  }
  // Everything matches: nothing to say, and nothing left on screen.
  clearBanner();
}

async function retry() {
  if (sessionStorage.getItem('hb-compat-hidden')) {
    clearInterval(compatTimer); compatTimer = null; return;
  }
  await checkCompat();
}

export { EXPECTED_API, EXPECTED_VERSION, NEEDED, checkCompat, inspect, shape };
