/* Qawk documentation: the chrome every page shares.
 *
 * A page is a plain HTML file holding its own content and nothing else. This
 * builds the header, the sidebar, the breadcrumbs, the table of contents, the
 * copy buttons and the previous/next links around it, so the whole site has
 * one nav to keep and every page stays readable on its own -- and with no
 * JavaScript at all, the words are still there. */

(function () {
  'use strict';

  // ---------------------------------------------------------------- the map
  // Numbered sections, as Mender's documentation is: a reader who is told
  // "see 7.2" can find it without searching.

  var NAV = [
    { t: 'Get started', n: 1, items: [
      { t: 'What Qawk is', h: 'start/' },
      { t: 'Try it in five minutes', h: 'start/#demo' },
      { t: 'Build it and run it', h: 'start/#run' },
      { t: 'Your first update', h: 'start/#first-update' }
    ] },
    { t: 'Concepts', n: 2, items: [
      { t: 'How Qawk is put together', h: 'concepts/' },
      { t: 'Devices, modules and sets', h: 'concepts/#catalogue' },
      { t: 'Channels, centres, systems', h: 'concepts/#grouping' },
      { t: 'Glossary', h: 'concepts/#glossary' }
    ] },
    { t: 'Using the console', n: 3, items: [
      { t: 'A tour of the console', h: 'console/' },
      { t: 'Ship an update, step by step', h: 'console/#ship' },
      { t: 'Reading what you see', h: 'console/#reading' },
      { t: 'When something goes wrong', h: 'console/#wrong' },
      { t: 'A fleet to practise on', h: 'console/#practise' },
      { t: 'Making it yours', h: 'console/#yours' }
    ] },
    { t: 'Channels and releases', n: 4, items: [
      { t: 'The release pipeline', h: 'channels/' },
      { t: 'Gates and approvals', h: 'channels/#gates' },
      { t: 'Waves and error thresholds', h: 'channels/#waves' },
      { t: 'Freezes and maintenance', h: 'channels/#freezes' },
      { t: 'Temporary channels', h: 'channels/#temporary' }
    ] },
    { t: 'Centres', n: 5, items: [
      { t: 'Centres in channels', h: 'centres/' },
      { t: 'Moving a centre', h: 'centres/#moving' }
    ] },
    { t: 'The orchestrator', n: 6, items: [
      { t: 'Systems updated as a whole', h: 'orchestrator/' },
      { t: 'Topologies (system types)', h: 'orchestrator/#topology' },
      { t: 'Manifests', h: 'orchestrator/#manifest' },
      { t: 'Running a deployment', h: 'orchestrator/#deployment' },
      { t: 'Rollback', h: 'orchestrator/#rollback' },
      { t: 'A system rolled back. Now what?', h: 'orchestrator/#recovery' },
      { t: 'Releases through the orchestrator', h: 'orchestrator/#releases' },
      { t: 'Mender YAML', h: 'orchestrator/#yaml' }
    ] },
    { t: 'Connecting devices', n: 7, items: [
      { t: 'How a device talks to Qawk', h: 'devices/' },
      { t: 'SWUpdate (suricatta)', h: 'devices/#swupdate' },
      { t: 'HTTPS on a device', h: 'devices/#tls' },
      { t: 'Attributes that matter', h: 'devices/#attributes' },
      { t: 'Simulated devices', h: 'devices/#simulate' }
    ] },
    { t: 'Installing the server', n: 8, items: [
      { t: 'Docker and compose', h: 'install/' },
      { t: 'Configuration', h: 'install/#config' },
      { t: 'Kubernetes', h: 'install/#kubernetes' },
      { t: 'HTTPS', h: 'install/#tls' },
      { t: 'A test certificate', h: 'install/#testcert' },
      { t: 'Mutual TLS', h: 'install/#mtls' },
      { t: 'Letting a browser call it', h: 'install/#cors' },
      { t: 'Backup and upgrade', h: 'install/#backup' }
    ] },
    { t: 'Users and audit', n: 9, items: [
      { t: 'Users, roles and tokens', h: 'users/' },
      { t: 'The audit log', h: 'users/#audit' }
    ] },
    { t: 'Operations', n: 10, items: [
      { t: 'Metrics and tracing', h: 'operations/' },
      { t: 'Scaling', h: 'operations/#scaling' },
      { t: 'Troubleshooting', h: 'operations/#troubleshooting' }
    ] },
    { t: 'API reference', n: 11, items: [
      { t: 'Introduction', h: 'api/' },
      { t: 'Qawk API', h: 'api/#/qawk' },
      { t: 'Device API (DDI)', h: 'api/#/ddi' },
      { t: 'Management API', h: 'api/#/mgmt' }
    ] },
    { t: 'About', n: 12, items: [
      { t: 'hawkBit compatibility', h: 'hawkbit/' },
      { t: 'Licence', h: 'about/' }
    ] }
  ];

  // Reading order for the previous/next links: the first page of each section.
  var FLOW = ['start/', 'concepts/', 'console/', 'channels/', 'centres/',
    'orchestrator/', 'devices/', 'install/', 'users/', 'operations/', 'api/',
    'hawkbit/', 'about/'];

  var TITLES = {
    '': 'Qawk', 'start/': 'Get started', 'concepts/': 'Concepts',
    'console/': 'Using the console', 'channels/': 'Channels and releases',
    'centres/': 'Centres', 'orchestrator/': 'The orchestrator',
    'devices/': 'Connecting devices', 'install/': 'Installing the server',
    'users/': 'Users and audit', 'operations/': 'Operations',
    'api/': 'API reference', 'hawkbit/': 'hawkBit compatibility', 'about/': 'About'
  };

  // Pages the search box can reach, with what they are about. Small enough to
  // ship whole: a documentation site that needs an index server is a
  // documentation site that breaks.
  var SEARCH = [
    ['start/', 'Get started', 'demo docker install try quickstart first update five minutes'],
    ['concepts/', 'Concepts and glossary', 'target device distribution set software module action channel fleet centre system manifest glossary'],
    ['console/', 'Using the console', 'gui buttons screens dashboard targets deployments how to ship an update operator'],
    ['channels/', 'Channels and the release pipeline', 'fleet dev beta prod promote gate approval wave error threshold freeze rollout'],
    ['centres/', 'Centres', 'centerid site location move centre channel'],
    ['orchestrator/', 'The orchestrator', 'system topology manifest component order rollback retry recover take again mender orchestrate yaml'],
    ['devices/', 'Connecting devices', 'swupdate suricatta gateway token ddi poll attributes register simulate'],
    ['install/', 'Installing the server', 'docker compose kubernetes postgres environment variables https tls certificate self-signed mutual mtls cors proxy backup upgrade'],
    ['users/', 'Users, roles and the audit log', 'permission role admin operator release-manager viewer token password audit'],
    ['operations/', 'Operations', 'prometheus metrics opentelemetry tracing health live scaling load backup'],
    ['api/', 'API reference', 'rest api curl python go javascript endpoints'],
    ['api/#/qawk', 'Qawk API', 'fleets releases centres systemtypes manifests systemdeployments users roles tokens audit'],
    ['api/#/ddi', 'Device API (DDI)', 'controller poll deploymentBase feedback configData artifacts download'],
    ['api/#/mgmt', 'Management API', 'hawkbit rest v1 targets distributionsets softwaremodules rollouts targetfilters'],
    ['hawkbit/', 'hawkBit compatibility', 'parity differences contract test migrate from hawkbit'],
    ['about/', 'Licence and credits', 'agpl licence copyright commercial third party']
  ];

  // --------------------------------------------------------------- helpers

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]);
    }
    if (html != null) n.innerHTML = html;
    return n;
  }

  // Where the site root is, from this page's depth: every link is relative so
  // the site works at a user/project path on GitHub Pages, at a domain of its
  // own, and from a file:// checkout alike.
  var here = (function () {
    var p = location.pathname.replace(/index\.html$/, '');
    var m = p.match(/(?:^|\/)((?:start|concepts|console|channels|centres|orchestrator|devices|install|users|operations|api|hawkbit|about)\/)$/);
    return m ? m[1] : '';
  })();
  var root = here ? '../' : './';

  function url(h) { return root + h; }

  // ---------------------------------------------------------------- header

  function header() {
    var h = el('header', { class: 'top' });
    var brand = el('a', { class: 'brand', href: url('') },
      '<img src="' + url('assets/img/qawk-logo.svg') + '" alt=""><b>Qawk</b><span>docs</span>');
    h.appendChild(el('button', { class: 'icon-btn', id: 'menu-btn', 'aria-label': 'Menu' }, '☰'));
    h.appendChild(brand);
    var links = el('nav', { class: 'links' });
    [['start/', 'Get started'], ['console/', 'Console'], ['orchestrator/', 'Orchestrator'],
     ['api/', 'API']].forEach(function (l) {
      var a = el('a', { href: url(l[0]) }, l[1]);
      if (here === l[0]) a.className = 'on';
      links.appendChild(a);
    });
    h.appendChild(links);
    h.appendChild(el('span', { class: 'spacer' }));

    var sw = el('div', { class: 'search-wrap' });
    sw.appendChild(el('input', { id: 'search', type: 'search', placeholder: 'Search   /',
      'aria-label': 'Search the documentation', autocomplete: 'off' }));
    sw.appendChild(el('div', { id: 'results' }));
    h.appendChild(sw);

    h.appendChild(el('a', { class: 'icon-btn', href: 'https://github.com/padovanl/qawk',
      title: 'Qawk on GitHub', 'aria-label': 'GitHub' }, '⌂'));
    var t = el('button', { class: 'icon-btn', id: 'theme-btn', 'aria-label': 'Light or dark' }, '◐');
    h.appendChild(t);
    document.body.appendChild(h);

    t.onclick = function () {
      var dark = !(document.documentElement.getAttribute('data-theme') === 'dark');
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      try { localStorage.setItem('qawk-docs-theme', dark ? 'dark' : 'light'); } catch (e) {}
    };
    return h;
  }

  // --------------------------------------------------------------- sidebar

  // ownTree: this page draws its own sidebar tree and marks its own place in
  // it (the API reference, which routes on the hash). The section links here
  // must then not also light up: two highlighted entries read as "you are in
  // two places". It is passed in rather than looked up, because by the time
  // this runs the page's content has been lifted out of the document.
  function sidebar(ownTree) {
    var a = el('aside', { class: 'side' });
    NAV.forEach(function (sec) {
      var g = el('div', { class: 'grp' });
      var b = el('button', { type: 'button' },
        '<span class="n">' + sec.n + '</span><span>' + sec.t + '</span><span class="caret">▶</span>');
      var ul = el('ul');
      var mine = false;
      sec.items.forEach(function (it) {
        var li = el('li');
        var link = el('a', { href: url(it.h) }, it.t);
        if (here && it.h.split('#')[0] === here) {
          mine = true;
          // remember which anchor this entry stands for; which one is lit is
          // decided afterwards, by syncActive
          if (!ownTree) link.setAttribute('data-frag', it.h.split('#')[1] || '');
          // on the API reference these are routes, not anchors: tag them the
          // way its own tree is tagged so one marker lights them all
          else link.setAttribute('data-h', (it.h.split('#')[1] || '').replace(/^\//, ''));
        }
        li.appendChild(link); ul.appendChild(li);
      });
      if (mine) g.className = 'grp open';
      b.onclick = function () { g.classList.toggle('open'); };
      g.appendChild(b); g.appendChild(ul); a.appendChild(g);
    });
    document.body.appendChild(a);

    var btn = document.getElementById('menu-btn');
    var back = null;
    btn.onclick = function () {
      a.classList.toggle('open');
      if (a.classList.contains('open')) {
        back = el('div', { class: 'backdrop' });
        back.onclick = function () { a.classList.remove('open'); back.remove(); back = null; };
        document.body.appendChild(back);
      } else if (back) { back.remove(); back = null; }
    };
    return a;
  }

  // ------------------------------------------------------- content chrome

  // Put the highlighted entry where the eye is: a sidebar of twelve sections
  // opens on whichever one you are in, and the entry itself can still be
  // below the fold. Scrolling the container rather than calling
  // scrollIntoView keeps the page itself where it was.
  function centreActive(aside) {
    var on = aside.querySelector('a.on');
    if (!on) return;
    var want = on.offsetTop - (aside.clientHeight / 2) + (on.offsetHeight / 2);
    aside.scrollTop = Math.max(0, want);
  }

  // Which sidebar entry is lit: the section actually being read, not the first
  // one of the page. Clicking "Kubernetes" and watching "Docker and compose"
  // light up is worse than no highlight at all -- it says you are somewhere
  // you are not.
  function syncActive(aside, wrap) {
    var links = aside.querySelectorAll('a[data-frag]');
    if (!links.length) return;
    var marks = [];
    links.forEach(function (a) {
      var f = a.getAttribute('data-frag');
      var h = f ? wrap.querySelector('[id="' + f + '"]') : null;
      marks.push({ a: a, top: h ? h.getBoundingClientRect().top + window.scrollY : 0 });
    });
    var best = marks[0], y = window.scrollY + 130;
    marks.forEach(function (m) { if (m.top <= y && m.top >= best.top) best = m; });
    // at the very bottom the last section is the one being read, whatever the
    // arithmetic says
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      best = marks[marks.length - 1];
    }
    links.forEach(function (a) { a.className = a === best.a ? 'on' : ''; });
  }

  function crumbs(page) {
    var c = el('div', { class: 'crumbs' });
    c.innerHTML = '<a href="' + url('') + '">Docs</a>';
    if (here) {
      c.innerHTML += ' <span class="sep">›</span> ' + (TITLES[here] || '');
      var t = page.querySelector('h1');
      if (t && t.textContent.trim() !== (TITLES[here] || '')) {
        c.innerHTML += ' <span class="sep">›</span> <span style="color:var(--fg-dim)">' +
          t.textContent.trim() + '</span>';
      }
    }
    return c;
  }

  function toc(page, main) {
    var hs = page.querySelectorAll('h2[id], h3[id]');
    if (hs.length < 3) return;
    var t = el('nav', { class: 'toc' }, '<b>On this page</b>');
    hs.forEach(function (h) {
      var a = el('a', { href: '#' + h.id }, h.textContent.replace('#', '').trim());
      if (h.tagName === 'H3') a.className = 'h3';
      t.appendChild(a);
    });
    main.appendChild(t);
    main.className += ' has-toc';

    var links = t.querySelectorAll('a');
    function light(best) {
      for (var j = 0; j < links.length; j++) links[j].className =
        (hs[j].tagName === 'H3' ? 'h3' : '') + (j === best ? ' on' : '');
    }
    // What the reader clicked wins at once and keeps winning for a moment:
    // the scroll to the heading is animated, so working the answer out from
    // the position mid-flight lights whatever is passing by.
    var held = 0;
    function mark() {
      if (Date.now() < held) return;
      var best = 0;
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].getBoundingClientRect().top < 140) best = i;
      }
      light(best);
    }
    for (var k = 0; k < links.length; k++) {
      (function (i, a) {
        a.addEventListener('click', function () { held = Date.now() + 900; light(i); });
      })(k, links[k]);
    }
    mark();
    window.addEventListener('load', mark);
    var pending = false;
    window.addEventListener('scroll', function () {
      if (pending) return; pending = true;
      requestAnimationFrame(function () { pending = false; mark(); });
    }, { passive: true });
    ['wheel', 'touchmove', 'keydown'].forEach(function (e) {
      window.addEventListener(e, function () { held = 0; }, { passive: true });
    });
  }

  function anchors(page) {
    page.querySelectorAll('h2[id], h3[id]').forEach(function (h) {
      var a = el('a', { class: 'anchor', href: '#' + h.id, 'aria-label': 'Link to this section' }, '#');
      h.appendChild(a);
    });
  }

  function copyButtons(page) {
    page.querySelectorAll('pre').forEach(function (pre) {
      var w = el('div', { class: 'pre-wrap' });
      pre.parentNode.insertBefore(w, pre);
      w.appendChild(pre);
      var b = el('button', { class: 'copy', type: 'button' }, 'copy');
      w.appendChild(b);
      b.onclick = function () {
        var txt = pre.innerText;
        var done = function () {
          b.textContent = 'copied'; b.className = 'copy done';
          setTimeout(function () { b.textContent = 'copy'; b.className = 'copy'; }, 1400);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, function () {});
        else {
          var ta = el('textarea'); ta.value = txt; document.body.appendChild(ta);
          ta.select(); try { document.execCommand('copy'); done(); } catch (e) {}
          ta.remove();
        }
      };
    });
  }

  function pager(page) {
    var i = FLOW.indexOf(here);
    if (i < 0) return;
    var p = el('div', { class: 'pager' });
    var arrow = function (n) {
      return window.QawkIcons ? window.QawkIcons.markup(n, 18) : '';
    };
    if (i > 0) p.appendChild(el('a', { class: 'prev', href: url(FLOW[i - 1]) },
      arrow('arrow-left') + '<span><small>Previous</small><b>' + TITLES[FLOW[i - 1]] + '</b></span>'));
    if (i < FLOW.length - 1) p.appendChild(el('a', { class: 'next', href: url(FLOW[i + 1]) },
      '<span><small>Next</small><b>' + TITLES[FLOW[i + 1]] + '</b></span>' + arrow('arrow-right')));
    if (p.children.length) page.appendChild(p);
  }

  // ---------------------------------------------------------------- search

  function search() {
    var input = document.getElementById('search');
    var box = document.getElementById('results');
    var sel = -1, shown = [];

    function render(q) {
      q = q.trim().toLowerCase();
      if (!q) { box.className = ''; return; }
      var words = q.split(/\s+/);
      shown = SEARCH.map(function (row) {
        var hay = (row[1] + ' ' + row[2]).toLowerCase();
        var score = 0;
        words.forEach(function (w) {
          if (row[1].toLowerCase().indexOf(w) >= 0) score += 3;
          else if (hay.indexOf(w) >= 0) score += 1;
        });
        return { row: row, score: score };
      }).filter(function (r) { return r.score > 0; })
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, 8).map(function (r) { return r.row; });

      box.innerHTML = '';
      if (!shown.length) { box.innerHTML = '<div class="none">Nothing here for that.</div>'; }
      shown.forEach(function (row, i) {
        var a = el('a', { href: url(row[0]) },
          '<div class="r-t">' + row[1] + '</div><div class="r-s">' + row[2].split(' ').slice(0, 9).join(' ') + '</div>');
        if (i === sel) a.className = 'sel';
        box.appendChild(a);
      });
      box.className = 'open';
    }

    input.addEventListener('input', function () { sel = -1; render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { box.className = ''; input.blur(); return; }
      if (!shown.length) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0) { location.href = url(shown[sel][0]); return; }
      else return;
      render(input.value);
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search-wrap')) box.className = '';
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== input &&
          !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); input.focus();
      }
    });
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    try {
      var saved = localStorage.getItem('qawk-docs-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (e) {}

    var page = document.querySelector('.page-content');
    if (!page) return;
    var ownTree = !!page.querySelector('#api-crumbs');
    page.remove();

    header();
    var aside = sidebar(ownTree);

    var shell = el('div', { class: 'shell' });
    var main = el('main');
    var wrap = el('div', { class: page.classList.contains('wide') ? 'page wide' : 'page' });
    // a page that draws its own breadcrumbs (the API reference, which routes
    // on the hash) keeps them
    if (here && !ownTree) wrap.appendChild(crumbs(page));
    while (page.firstChild) wrap.appendChild(page.firstChild);
    main.appendChild(wrap);
    shell.appendChild(main);
    document.body.appendChild(shell);

    anchors(wrap);
    copyButtons(wrap);
    if (!wrap.classList.contains('wide')) toc(wrap, main);
    // Previous/next belongs to pages that are read in order. The API
    // reference is looked things up in, and its columns scroll on their own,
    // so a pager would sit below them taking a strip of screen for ever.
    if (!ownTree) pager(wrap);
    search();

    if (!ownTree) {
      // A hash is what the reader just asked for, so it wins outright -- and
      // it keeps winning for a moment, because the browser's own jump to the
      // anchor raises a scroll event, and because the screenshots on these
      // pages load late and move every heading while they do. Working out the
      // position before that has settled gets the answer confidently wrong.
      var held = 0;
      var byHash = function () {
        var f = decodeURIComponent(location.hash.slice(1));
        var a = f && aside.querySelector('a[data-frag="' + CSS.escape(f) + '"]');
        if (!a) return false;
        aside.querySelectorAll('a[data-frag]').forEach(function (x) { x.className = ''; });
        a.className = 'on';
        held = Date.now() + 900;
        return true;
      };
      var follow = function () {
        if (Date.now() < held) return;
        syncActive(aside, wrap);
      };

      if (!byHash()) follow();
      centreActive(aside);
      // images change every heading's position: work it out again once they
      // have arrived
      window.addEventListener('load', function () {
        if (!byHash()) follow();
        centreActive(aside);
      });
      window.addEventListener('hashchange', function () { if (!byHash()) follow(); });

      var pending = false;
      window.addEventListener('scroll', function () {
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () { pending = false; follow(); });
      }, { passive: true });
      // a deliberate scroll by the reader takes the highlight back
      ['wheel', 'touchmove', 'keydown'].forEach(function (e) {
        window.addEventListener(e, function () { held = 0; }, { passive: true });
      });
    }

    document.title = (wrap.querySelector('h1') ?
      wrap.querySelector('h1').textContent.replace('#', '').trim() + ' · ' : '') + 'Qawk documentation';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.QawkDocs = { url: url, el: el, here: here, centreActive: centreActive };
})();
