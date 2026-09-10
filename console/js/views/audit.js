import { qawk } from '../api.js';
import { h } from '../dom.js';
import { VIEWS, debounceRender } from '../router.js';
import { tableOf } from '../table.js';
import { when } from '../util.js';

/* ------- audit log (a Qawk addition) --------------------------------- *
 *
 * Every request that changed something -- who, from where, what, and whether
 * it worked -- and every sign-in the server refused. Reads are not recorded:
 * a console refreshing every two seconds would bury everything else. */
const A = { user: '', only: '', page: 0 };
const SIZE = 100;

VIEWS.audit = {
  title: 'Audit log',
  bar: () => [
    h('input', { type: 'search', placeholder: 'user', value: A.user, style: 'width:140px',
      oninput: e => { A.user = e.target.value.trim(); A.page = 0; debounceRender(); } }),
    h('select', { onchange: e => { A.only = e.target.value; A.page = 0; debounceRender(); } },
      [['', 'everything'], ['status=ge=400', 'failures'], ['status==401', 'refused sign-ins'],
       ['method==DELETE', 'deletions']].map(([v, l]) => h('option', { value: v, selected: A.only === v }, l)))],
  async render(root) {
    const q = [A.user ? `user==*${A.user}*` : '', A.only].filter(Boolean).join(';');
    const d = await qawk.get(`/audit?limit=${SIZE}&offset=${A.page * SIZE}` + (q ? '&q=' + encodeURIComponent(q) : ''));
    const pages = Math.max(1, Math.ceil(d.total / SIZE));
    root.replaceChildren(h('div.stack',
      d.content.length
        ? tableOf(['When', 'User', 'Via', 'Request', 'Result', 'From'], d.content.map(e => ({
            cells: [h('span.mono.faint', when(e.at)), h('b.mono', e.user), h('span.dim', e.via),
              h('span.mono', h('b', e.method), ' ', e.path),
              h('span.pill' + (e.status >= 400 ? '.err' : '.ok'), String(e.status)),
              h('span.mono.faint', e.address)],
          })))
        : h('div.empty', 'Nothing recorded' + (q ? ' that matches.' : ' yet.')),
      h('div.flex', { style: 'justify-content:space-between' },
        h('span.faint', `${d.total} entries`),
        h('div.wrap',
          h('button.btn.sm', { disabled: A.page === 0, onclick: () => { A.page--; debounceRender(); } }, 'newer'),
          h('span.faint', ` page ${A.page + 1} of ${pages} `),
          h('button.btn.sm', { disabled: A.page + 1 >= pages, onclick: () => { A.page++; debounceRender(); } }, 'older')))));
  },
};
