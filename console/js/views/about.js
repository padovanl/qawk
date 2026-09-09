import { get } from '../api.js';
import { modal } from '../chrome.js';
import { h } from '../dom.js';
import { VIEWS, go, render } from '../router.js';
import { tableOf } from '../table.js';

/* ------- about ------------------------------------------------------- */
VIEWS.about = {
  title: 'About',
  async render(root) {
    const types = await Promise.all([
      get('/targettypes?limit=50').catch(() => ({ content: [] })),
      get('/distributionsettypes?limit=50').catch(() => ({ content: [] })),
      get('/softwaremoduletypes?limit=50').catch(() => ({ content: [] })),
    ]);
    const list = (title, r, f) => h('div.panel', h('h3', title), h('div.body',
      r.content.length ? tableOf(['Id', 'Name', 'Key', 'Description'], r.content.map(x => ({
        cells: [h('span.mono', x.id), x.name, h('span.mono', x.key || '—'),
                h('span.faint', x.description || '—')],
      }))) : h('span.faint', 'none')));
    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'QubicaAMF hawkBit console'), h('div.body.stack',
        h('div', 'A replacement for hawkbit-simple-ui with the same features and a few more: ' +
          'a dashboard, assigned/installed at a glance, SWUpdate feedback inline in the action ' +
          'history, FIQL with a live match count, and bulk deployment by query.'),
        h('div.faint', 'Served by ota/hawkbit-ui/serve.py, which also proxies /rest to hawkBit so ' +
          'the page and the API share one origin. Credentials stay in this tab.'),
        h('div.faint', 'The original UI is still there on its own port; both talk to the same server.'))),
      list('Target types', types[0]), list('Distribution set types', types[1]),
      list('Software module types', types[2])));
  },
};

const SHORTCUTS = [
  ['/', 'focus the search box'],
  ['r', 'reload the current view'],
  ['?', 'this list'],
  ['Esc', 'close the panel, or leave a field'],
  ['g then d / t / s / m', 'go to dashboard, targets, distribution sets, modules'],
];
function shortcutsDialog() {
  modal('Keyboard', [h('dl.kv', SHORTCUTS.flatMap(([k, w]) =>
    [h('dt', h('kbd', k)), h('dd', w)]))], async () => {}, 'Close');
}

export {
  shortcutsDialog,
};
