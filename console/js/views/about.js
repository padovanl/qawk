import { enc, get } from '../api.js';
import { ACTION_PILL, PHASE_WORDS, TARGET_PILL, pill, typePill } from '../badges.js';
import { modal } from '../chrome.js';
import { $, h, icon } from '../dom.js';
import { EXPECTED_VERSION, inspect } from '../compat.js';
import { serverInfo, whoIsServer } from '../server.js';
import { VIEWS, go, render } from '../router.js';
import { tableOf } from '../table.js';

/* ------- about -------------------------------------------------------
 *
 * Not one long page. What belongs here is reference material -- what the words
 * mean, what this server is, what to do when something reads wrong -- and a
 * wall of it is the same as not having it. So it is in sections, one at a
 * time, and the choice is remembered.
 *
 * Everything on the Server tab is READ from the server. Nothing here claims a
 * version or a setting it has not asked for: this page exists to be trusted
 * when something else is already confusing.
 */

const TABS = [
  ['server',  'This server',   'cfg'],
  ['kinds',   'Update kinds',  'package'],
  ['states',  'What the words mean', 'info'],
  ['trouble', 'When it reads wrong', 'x'],
  ['types',   'Type registry', 'chip'],
  ['keys',    'Keyboard',      'edit'],
];

const p = (...kids) => h('p.about-p', ...kids);
const panel = (title, ...body) => h('div.panel', h('h3', title), h('div.body.stack', ...body));

/* ---------------------------------------------------------------- server */
async function serverTab(root) {
  root.replaceChildren(h('div.empty', h('span.spin'), ' asking the server…'));
  if (!serverInfo()) await whoIsServer();

  const [compat, cfg, counts] = await Promise.all([
    inspect().catch(e => ({ known: false, why: e.message })),
    get('/system/configs').catch(() => null),
    Promise.all([
      get('/targets?limit=1').catch(() => ({ total: '?' })),
      get('/distributionsets?limit=1').catch(() => ({ total: '?' })),
      get('/softwaremodules?limit=1').catch(() => ({ total: '?' })),
      get('/rollouts?limit=1').catch(() => ({ total: '?' })),
    ]),
  ]);

  const cfgVal = k => (cfg && cfg[k] && cfg[k].value !== undefined ? String(cfg[k].value) : '—');
  const verdict = !compat.known
    ? pill('cannot tell', 'warn')
    : compat.missing && compat.missing.length
      ? pill(`${compat.missing.length} endpoints missing`, 'err')
      : pill('matches', 'ok');

  root.replaceChildren(h('div.stack',
    panel('Which hawkBit this is',
      h('dl.kv',
        h('dt', 'server'), h('dd', (() => { const i = serverInfo(); return i ? i.name + (i.version ? ' ' + i.version : '') : '—'; })()),
        h('dt', 'written for'), h('dd', 'hawkBit ' + EXPECTED_VERSION),
        h('dt', 'API version'), h('dd', compat.api || '—'),
        h('dt', 'endpoints'), h('dd', verdict),
        h('dt', 'checked'), h('dd', compat.known
          ? `${compat.total} of them, against the server's own API description`
          : compat.why || 'the server would not describe itself')),
      p('hawkBit publishes no version over HTTP — ', h('code', '/actuator'),
        ' is off and the OpenAPI document carries the API version, not the ',
        'product’s. So this is not a version comparison: the console asks the ',
        'server to describe its own API and checks that every endpoint it calls ',
        'is really there, with the methods it uses. A release that renames ',
        'nothing we touch raises no alarm; one that removes something is named.')),

    panel('What is on it',
      h('div.cards',
        card2('Targets', counts[0].total, 'targets'),
        card2('Distribution sets', counts[1].total, 'ds'),
        card2('Software modules', counts[2].total, 'sm'),
        card2('Rollouts', counts[3].total, 'ro'))),

    panel('Tenant settings that change behaviour',
      h('dl.kv',
        h('dt', 'polling interval'), h('dd', h('span.mono', cfgVal('pollingTime'))),
        h('dt', 'overdue after'), h('dd', h('span.mono', cfgVal('pollingOverdueTime'))),
        h('dt', 'action autoclose'), h('dd', cfgVal('repository.actionsAutoclose')),
        h('dt', 'confirmation required'), h('dd', cfgVal('user.confirmation.flow')),
        h('dt', 'artifact encryption'), h('dd', cfgVal('repository.actionsAutocleanup.enabled'))),
      p('A device asks for work every ', h('b', cfgVal('pollingTime')),
        ', so nothing here happens sooner than that. Change them under ',
        h('a.link', { onclick: () => go('cfg') }, 'Configuration'), '.')),

    panel('This console',
      p('Served by ', h('code', 'ota/hawkbit-ui/serve.py'), ', which also proxies ',
        h('code', '/rest'), ' and ', h('code', '/v3/api-docs'),
        ' to hawkBit so the page and the API share one origin. Credentials stay ',
        'in this tab and are sent straight to hawkBit; nothing is stored server-side.'),
      p('The stock interface is still on its own port and talks to the same ',
        'server, so anything done in one appears in the other. Which one starts ',
        'is ', h('code', 'start-hawkbit.sh --ui console|stock|both|none'), '.'))));
}

const card2 = (k, v, view) => {
  const c = h('div.card', h('div.k', k), h('div.v', v ?? '—'));
  c.style.cursor = 'pointer';
  c.onclick = () => go(view);
  return c;
};

/* ----------------------------------------------------------------- kinds */
function kindsTab(root) {
  const row = (t, what, needs) => ({ cells: [typePill(t), what, h('span.faint', needs)] });
  root.replaceChildren(h('div.stack',
    panel('The three set types',
      tableOf(['type', 'what it carries', 'mandatory module'], [
        row('os', 'the system image only', 'one os module'),
        row('app', 'one or more applications', 'one application module'),
        row('os_app', 'system and applications in one action', 'os; applications optional'),
      ]),
      p('A set of type ', h('code', 'os_app'), ' reaches the device as ',
        h('b', 'two chunks'), ', installed as two separate runs: the application ',
        'first, then the system. So between them the device is legitimately ',
        'running the new application on the old rootfs — that is not a ',
        'half-failure, it is why applications live on ', h('code', '/data'), '.')),

    panel('Full and delta',
      p(h('b', 'A full package'), ' carries the whole payload. A ', h('b', 'delta'),
        ' carries only a chunk index, and the device fetches the ranges it is ',
        'missing from a ', h('code', '.zck'), ' held in the same software module.'),
      p(h('b', 'A delta needs its base already on the device.'), ' For an ',
        'application that base is ', h('code', '/data/apps/<name>/versions/<v>.img'),
        ' — which only exists if that version arrived as an image-format ',
        'package. Install a tar one instead and the next delta fails, saying ',
        'nothing about why. For the system the base is the other slot, so any ',
        'base works and only the saving changes.'),
      p('What is stored and what is transferred are different numbers: a ',
        '119 MB ', h('code', '.zck'), ' can cost the device two megabytes, ',
        'because it asks for byte ranges.')),

    panel('Where an application lives',
      h('dl.kv',
        h('dt', '/data/apps/<name>/versions/'), h('dd', 'every version kept, as directories or .img'),
        h('dt', '/data/apps/<name>/current'), h('dd', 'symlink to the active one'),
        h('dt', '/opt/qubicaamf/services/<name>'), h('dd', 'symlink into the above, for qsystem'),
        h('dt', '/data/apps/<name>/state'), h('dd', 'current, previous, how many to keep')),
      p('An application update needs no reboot and touches no slot. A system ',
        'update writes the spare slot and waits: when it stops waiting is the ',
        'device’s reboot policy, not something this server decides.'))));
}

/* ---------------------------------------------------------------- states */
const TARGET_WORDS = [
  ['registered', 'has introduced itself and has never been given anything'],
  ['pending', 'an update is assigned and not finished — the console shows which phase'],
  ['in_sync', 'nothing outstanding. NOT the same as up to date: a device never given anything is in sync too'],
  ['error', 'the last update failed. It is running whatever it ran before'],
  ['unknown', 'no state — usually a target created through the API that has never polled'],
];
const ACTION_WORDS = [
  ['running', 'assigned; the device may not have polled yet'],
  ['retrieved', 'the device has taken the deployment. NOT an outcome'],
  ['download', 'it is fetching the artifacts'],
  ['finished', 'it ended well'],
  ['error', 'it failed. For an application, the device has rolled back by itself'],
  ['canceled', 'someone stopped it'],
  ['wait_for_confirmation', 'it needs a human to allow it on the device'],
];
function statesTab(root) {
  const t = (rows, map) => tableOf(['word', 'what it means'], rows.map(([k, w]) => ({
    cells: [pill(k, map[k] || 'mute'), w],
  })));
  root.replaceChildren(h('div.stack',
    panel('A device', t(TARGET_WORDS, TARGET_PILL),
      p('These five are a fixed hawkBit enum. ', h('b', 'in_sync means "nothing ',
        'outstanding"'), ', which is not the same as up to date — the Targets ',
        'table marks a device that has never installed anything.')),
    panel('An action', t(ACTION_WORDS, ACTION_PILL),
      p('An action’s status is ', h('b', 'the last thing the device reported'),
        ', not how it ended, and hawkBit keeps it after the action closes. A ',
        'device that closes a deployment and polls again adds a fresh ',
        h('code', 'retrieved'), ', so a perfect update can read that for good. ',
        'The console asks the status history and shows the real outcome.')),
    panel('Inside "pending"',
      tableOf(['word', 'what it means'], PHASE_WORDS.map(([k, cls, w]) => ({
        cells: [pill(k, cls), w] }))),
      p('There is no field for this: a status entry carries a type, messages ',
        'and a timestamp, and no progress counter. The phase is ', h('b', 'read'),
        ' out of what SWUpdate said, not reported as such.'))));
}

/* -------------------------------------------------------------- trouble */
const TROUBLE = [
  ['"No suitable .swu image found"',
   'Never the cause. SWUpdate prints it after any failed streamed install, as the last line. The real error is above it — read the whole block.',
   'ssh ale@<ip> \'sudo journalctl -u swupdate --since "5 min ago" --no-pager | tail -40\''],
  ['A delta fails and says nothing useful',
   'Its base is missing. An application delta rebuilds from versions/<base>.img, and that only exists if the base arrived as an image-format package.',
   "ssh ale@<ip> 'sudo ls /data/apps/<name>/versions/'"],
  ['The device stopped accepting updates after a local install',
   'It used to: a local install removed the daemon’s IPC sockets. Fixed — qamf-ota install goes through swupdate-client now. If it happens on an old image, restart swupdate.',
   "ssh ale@<ip> 'sudo ls /run/swupdate/'"],
  ['A row says pending but the action is finished',
   'Two separate reads with the action closing between them. It settles at the next refresh; the console marks it "just closed".', ''],
  ['SSH refuses the host key after a system update',
   'Expected: each slot carries its own /etc/ssh, so an A/B swap changes the key.',
   'ssh-keygen -R <ip> && ssh-keyscan -t ed25519,ecdsa <ip> >> ~/.ssh/known_hosts'],
  ['A system update installed but nothing rebooted',
   'That is the reboot policy. manual waits for a human; window waits for its hours; immediate goes at once.',
   "ssh ale@<ip> 'qamf-ota reboot-policy'"],
];

function troubleTab(root) {
  root.replaceChildren(h('div.stack', ...TROUBLE.map(([q, a, cmd]) =>
    h('div.panel', h('h3', q), h('div.body.stack',
      p(a), cmd ? h('pre.cmd', cmd) : null)))));
}

/* ----------------------------------------------------------------- types */
async function typesTab(root) {
  root.replaceChildren(h('div.empty', h('span.spin'), ' loading…'));
  const [tt, dt, st] = await Promise.all([
    get('/targettypes?limit=50').catch(() => ({ content: [] })),
    get('/distributionsettypes?limit=50').catch(() => ({ content: [] })),
    get('/softwaremoduletypes?limit=50').catch(() => ({ content: [] })),
  ]);
  const list = (title, r) => panel(title,
    r.content.length ? tableOf(['Id', 'Name', 'Key', 'Description'], r.content.map(x => ({
      cells: [h('span.mono', x.id), x.name, h('span.mono', x.key || '—'),
              h('span.faint', x.description || '—')],
    }))) : h('span.faint', 'none'));
  root.replaceChildren(h('div.stack',
    list('Target types', tt), list('Distribution set types', dt),
    list('Software module types', st),
    panel('Why these matter',
      p('A distribution set type declares which module types a set ',
        h('b', 'must'), ' carry. A set missing one is created happily and ',
        'refused at assignment, with an error that names nothing useful — so ',
        'the console checks completeness when it builds one.'))));
}

/* ------------------------------------------------------------- keyboard */
const SHORTCUTS = [
  ['/', 'focus the search box'],
  ['r', 'reload the current view'],
  ['?', 'this list, as a dialog'],
  ['Esc', 'close the panel, or leave a field'],
  ['g then d / t / s / m', 'go to dashboard, targets, distribution sets, modules'],
  ['↑ ↓', 'move through the query completions'],
  ['Tab / Enter', 'take a completion'],
];
function keysTab(root) {
  root.replaceChildren(h('div.stack', panel('Keyboard',
    h('dl.kv', SHORTCUTS.flatMap(([k, w]) => [h('dt', h('kbd', k)), h('dd', w)])))));
}

function shortcutsDialog() {
  modal('Keyboard', [h('dl.kv', SHORTCUTS.flatMap(([k, w]) =>
    [h('dt', h('kbd', k)), h('dd', w)]))], async () => {}, 'Close');
}

/* ------------------------------------------------------------------ view */
const DRAW = { server: serverTab, kinds: kindsTab, states: statesTab,
               trouble: troubleTab, types: typesTab, keys: keysTab };

VIEWS.about = {
  title: 'About',
  async render(root) {
    let cur = localStorage.getItem('hb-about') || 'server';
    if (!DRAW[cur]) cur = 'server';
    const body = h('div');
    const strip = h('div.seg.about-tabs');
    const paint = () => {
      strip.replaceChildren(...TABS.map(([id, label, ico]) => h('button', {
        class: id === cur ? 'on' : '',
        onclick: () => {
          cur = id;
          try { localStorage.setItem('hb-about', id); } catch (_) {}
          paint();
          DRAW[id](body);
        },
      }, icon(ico, 13), label)));
    };
    paint();
    root.replaceChildren(h('div.stack', strip, body));
    await DRAW[cur](body);
  },
};

export {
  shortcutsDialog,
};
