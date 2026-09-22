/* The API reference: three columns, and the call in five languages.
 *
 * Everything here is generated from assets/api/spec.js. The code samples are
 * generated too, not written: a sample that is typed by hand goes stale the
 * first time a parameter is renamed, and a reader who copies a stale sample
 * blames the server. */

(function () {
  'use strict';

  var D = window.QawkDocs, SPEC = window.QAWK_API;
  var el = D.el, url = D.url;

  var LANGS = ['curl', 'python', 'javascript', 'go', 'powershell'];
  var lang = 'curl';
  try { lang = localStorage.getItem('qawk-docs-lang') || 'curl'; } catch (e) {}
  if (LANGS.indexOf(lang) < 0) lang = 'curl';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function json(v) { return JSON.stringify(v, null, 2); }

  // Every endpoint, flat, so the router can find one by id.
  var ALL = {};
  Object.keys(SPEC).forEach(function (k) {
    SPEC[k].groups.forEach(function (g) {
      g.eps.forEach(function (e) { e.api = k; e.group = g.t; ALL[k + '/' + e.id] = e; });
    });
  });

  // ------------------------------------------------------- example values

  // A path with its {slots} filled in, so a sample can be pasted and run.
  var SLOTS = {
    fleetId: '2', releaseId: '44', tid: '1', mid: '3', did: '51', rid: '700',
    userId: '5', tokenId: '4', actionId: '9120', name: 'centre-manager',
    tenant: 'DEFAULT', controllerId: 'device-0001', smId: '8',
    fileName: 'app-1.2.0.swu', dsId: '7', group: 'Management API'
  };
  function fill(p) {
    return p.replace(/\{(\w+)\}/g, function (m, k) { return SLOTS[k] || m; });
  }

  function fullURL(ep, api) {
    var u = api.base + fill(ep.p);
    var qs = (ep.q || []).filter(function (q) { return q[2]; })
      .map(function (q) { return q[0] + '=' + (q[0] === 'from' ? '1' : q[0] === 'ids' ? 'device-0001,device-0002' : 'value'); });
    return u + (qs.length ? '?' + qs.join('&') : '');
  }

  function authHeader(ep, api) {
    var a = ep.auth || api.auth;
    if (a === 'none') return null;
    if (a === 'device') return ['Authorization', 'GatewayToken a-random-token'];
    return ['Authorization', 'Basic ' + '<base64 of user:password>'];
  }

  function payload(ep) {
    if (ep.raw) return { raw: ep.raw, ctype: ep.ctype || 'application/yaml' };
    if (ep.body !== undefined) return { json: ep.body, ctype: 'application/json' };
    return null;
  }

  // ------------------------------------------------------ code generators

  function genCurl(ep, api) {
    var a = ep.auth || api.auth, p = payload(ep);
    var L = ["curl -X " + ep.m + " '" + fullURL(ep, api) + "'"];
    if (a === 'basic') L.push('-u "$QAWK_USER:$QAWK_PASSWORD"');
    else if (a === 'device') L.push('-H "Authorization: GatewayToken $QAWK_TOKEN"');
    if (p) {
      L.push("-H 'Content-Type: " + p.ctype + "'");
      if (p.raw) L.push('--data-binary @' + (ep.id.indexOf('mf-') === 0 ? 'manifest' : 'topology') + '.yaml');
      else L.push("-d '" + json(p.json).replace(/\n\s*/g, ' ') + "'");
    } else if (ep.m !== 'HEAD') {
      L.push("-H 'Accept: application/json'");
    }
    // one flag per line, joined with a continuation, the way it is pasted
    return L.map(function (s, i) { return i === 0 ? s : '  ' + s; })
      .join(' \\\n');
  }

  function genPython(ep, api) {
    var p = payload(ep), a = ep.auth || api.auth;
    var L = ['import os, requests', ''];
    L.push('BASE = "' + api.base + '"');
    if (a === 'basic') L.push('AUTH = (os.environ["QAWK_USER"], os.environ["QAWK_PASSWORD"])');
    var args = ['f"{BASE}' + fill(ep.p) + '"'];
    if (a === 'basic') args.push('auth=AUTH');
    if (a === 'device') args.push('headers={"Authorization": f"GatewayToken {os.environ[\'QAWK_TOKEN\']}"}');
    var qs = (ep.q || []).filter(function (q) { return q[2]; });
    if (qs.length) args.push('params={' + qs.map(function (q) {
      return '"' + q[0] + '": ' + (q[0] === 'from' ? '1' : '"value"'); }).join(', ') + '}');
    if (p && p.raw) {
      L.push('', 'with open("topology.yaml", "rb") as f:', '    body = f.read()');
      args.push('data=body'); args.push('headers={"Content-Type": "' + p.ctype + '"}');
    } else if (p) {
      L.push('', 'body = ' + json(p.json).replace(/"(\w+)":/g, '"$1":').replace(/\btrue\b/g, 'True')
        .replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None'));
      args.push('json=body');
    }
    L.push('', 'r = requests.' + ep.m.toLowerCase() + '(' + args.join(', ') + ', timeout=30)');
    L.push('r.raise_for_status()');
    L.push(ep.m === 'DELETE' ? 'print(r.status_code)' : 'print(r.json())');
    return L.join('\n');
  }

  function genJS(ep, api) {
    var p = payload(ep), a = ep.auth || api.auth;
    var L = ['const base = "' + api.base + '";'];
    if (a === 'basic') L.push('const auth = "Basic " + btoa(`${process.env.QAWK_USER}:${process.env.QAWK_PASSWORD}`);');
    var hdr = [];
    if (a === 'basic') hdr.push('    Authorization: auth,');
    if (a === 'device') hdr.push('    Authorization: `GatewayToken ${process.env.QAWK_TOKEN}`,');
    if (p) hdr.push('    "Content-Type": "' + p.ctype + '",');
    hdr.push('    Accept: "application/json",');
    L.push('', 'const res = await fetch(`${base}' + fill(ep.p) + '`, {');
    L.push('  method: "' + ep.m + '",');
    L.push('  headers: {'); L.push(hdr.join('\n')); L.push('  },');
    if (p && p.raw) L.push('  body: yamlText,');
    else if (p) L.push('  body: JSON.stringify(' + json(p.json).split('\n').join('\n  ') + '),');
    L.push('});');
    L.push('if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);');
    L.push(ep.m === 'DELETE' ? 'console.log(res.status);' : 'console.log(await res.json());');
    return L.join('\n');
  }

  function genGo(ep, api) {
    var p = payload(ep), a = ep.auth || api.auth;
    var needOS = a !== 'none' || (p && p.raw);
    var L = ['package main', '', 'import (', '\t"fmt"', '\t"io"', '\t"net/http"'];
    if (needOS) L.push('\t"os"');
    if (p && !p.raw) L.push('\t"strings"');
    L.push(')', '');
    L.push('func main() {');
    if (p && !p.raw) {
      L.push('\tbody := `' + json(p.json) + '`');
      L.push('\treq, _ := http.NewRequest("' + ep.m + '", "' + fullURL(ep, api) + '", strings.NewReader(body))');
      L.push('\treq.Header.Set("Content-Type", "' + p.ctype + '")');
    } else if (p && p.raw) {
      L.push('\tf, _ := os.Open("topology.yaml")');
      L.push('\tdefer f.Close()');
      L.push('\treq, _ := http.NewRequest("' + ep.m + '", "' + fullURL(ep, api) + '", f)');
      L.push('\treq.Header.Set("Content-Type", "' + p.ctype + '")');
    } else {
      L.push('\treq, _ := http.NewRequest("' + ep.m + '", "' + fullURL(ep, api) + '", nil)');
    }
    if (a === 'basic') L.push('\treq.SetBasicAuth(os.Getenv("QAWK_USER"), os.Getenv("QAWK_PASSWORD"))');
    if (a === 'device') L.push('\treq.Header.Set("Authorization", "GatewayToken "+os.Getenv("QAWK_TOKEN"))');
    L.push('', '\tres, err := http.DefaultClient.Do(req)');
    L.push('\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer res.Body.Close()', '');
    L.push('\tout, _ := io.ReadAll(res.Body)');
    L.push('\tfmt.Println(res.Status, string(out))');
    L.push('}');
    return L.join('\n');
  }

  function genPS(ep, api) {
    var p = payload(ep), a = ep.auth || api.auth;
    var L = [];
    if (a === 'basic') {
      L.push('$pair  = "$($env:QAWK_USER):$($env:QAWK_PASSWORD)"');
      L.push('$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))');
      L.push('$headers = @{ Authorization = "Basic $basic" }');
    } else if (a === 'device') {
      L.push('$headers = @{ Authorization = "GatewayToken $($env:QAWK_TOKEN)" }');
    } else {
      L.push('$headers = @{}');
    }
    if (p && !p.raw) {
      L.push('');
      L.push("$body = @'");
      L.push(json(p.json));
      L.push("'@");
    }
    L.push('');
    var call = 'Invoke-RestMethod -Method ' + ep.m + " -Uri '" + fullURL(ep, api) + "' -Headers $headers";
    if (p && !p.raw) call += " -ContentType '" + p.ctype + "' -Body $body";
    else if (p && p.raw) call += " -ContentType '" + p.ctype + "' -InFile topology.yaml";
    L.push(call + ' | ConvertTo-Json -Depth 8');
    return L.join('\n');
  }

  var GEN = { curl: genCurl, python: genPython, javascript: genJS, go: genGo, powershell: genPS };

  // -------------------------------------------------------------- drawing

  function pill(m) {
    return '<span class="pill ' + m.toLowerCase() + '">' + m + '</span>';
  }

  function ic(name, size) {
    return window.QawkIcons ? window.QawkIcons.markup(name, size) : '';
  }

  function copyText(text, btn) {
    var done = function () {
      btn.innerHTML = ic('check', 12) + 'copied';
      btn.classList.add('done');
      setTimeout(function () {
        btn.innerHTML = ic('copy', 12) + 'copy';
        btn.classList.remove('done');
      }, 1500);
    };
    if (navigator.clipboard) { navigator.clipboard.writeText(text).then(done, function () {}); return; }
    var ta = el('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    ta.remove();
  }

  // ------------------------------------------------------------ try it out

  // Where the requests go, and who they go as. Kept in the browser only: the
  // password never leaves this page except to the server it is typed for.
  function saved(k, d) {
    try { return localStorage.getItem('qawk-try-' + k) || d; } catch (e) { return d; }
  }
  function save(k, v) { try { localStorage.setItem('qawk-try-' + k, v); } catch (e) {} }

  // tryPanel: fill in the parameters, press send, read the answer.
  function tryPanel(ep, api) {
    var p = el('div', { class: 'panel try' });
    p.appendChild(el('div', { class: 'ph' }, ic('send', 13) + 'Send this request'));
    var body = el('div', { class: 'pb' });

    function field(label, attrs, hint) {
      var w = el('label', { class: 'fld' }, '<span>' + label + '</span>');
      var i = el('input', attrs);
      w.appendChild(i);
      if (hint) w.appendChild(el('small', null, hint));
      return { wrap: w, input: i };
    }

    var base = field('Base URL', { type: 'url', value: saved('base', api.base), spellcheck: 'false' });
    base.input.oninput = function () { save('base', base.input.value); };
    body.appendChild(base.wrap);

    var auth = ep.auth || api.auth;
    var user, pass, token;
    if (auth === 'basic') {
      user = field('User', { type: 'text', value: saved('user', 'admin'), autocomplete: 'off' });
      pass = field('Password or API token', { type: 'password', value: '', autocomplete: 'off' },
        'Kept in this page only, and sent to the base URL above and nowhere else.');
      user.input.oninput = function () { save('user', user.input.value); };
      body.appendChild(user.wrap);
      body.appendChild(pass.wrap);
    } else if (auth === 'device') {
      token = field('Gateway token', { type: 'password', value: '', autocomplete: 'off' });
      body.appendChild(token.wrap);
    }

    // one input per {slot} and per query parameter
    var slots = [...ep.p.matchAll(/\{(\w+)\}/g)].map(function (m) { return m[1]; });
    var inputs = {};
    pathParams(ep, api).forEach(function (row) {
      if (slots.indexOf(row[0]) < 0) return;
      var f = field(row[0] + ' — path', { type: 'text', value: SLOTS[row[0]] || '' });
      inputs['path:' + row[0]] = f.input;
      body.appendChild(f.wrap);
    });
    (ep.q || []).forEach(function (q) {
      var f = field(q[0] + ' — query' + (q[2] ? ' *' : ''), { type: 'text', value: '' });
      inputs['query:' + q[0]] = f.input;
      body.appendChild(f.wrap);
    });

    var bodyBox = null;
    if (ep.body !== undefined || ep.raw) {
      var w = el('label', { class: 'fld' }, '<span>Body</span>');
      bodyBox = el('textarea', { rows: '6', spellcheck: 'false' });
      bodyBox.value = ep.raw ? ep.raw : json(ep.body);
      w.appendChild(bodyBox);
      body.appendChild(w);
    }

    var send = el('button', { class: 'btn-send', type: 'button' }, ic('send', 14) + 'Send request');
    body.appendChild(send);
    var out = el('div', { class: 'resp' });
    body.appendChild(out);
    p.appendChild(body);

    send.onclick = function () {
      var url = (base.input.value || api.base).replace(/\/$/, '');
      var path = ep.p.replace(/\{(\w+)\}/g, function (m, k) {
        var i = inputs['path:' + k];
        return i && i.value ? encodeURIComponent(i.value) : m;
      });
      var qs = [];
      (ep.q || []).forEach(function (q) {
        var i = inputs['query:' + q[0]];
        if (i && i.value) qs.push(encodeURIComponent(q[0]) + '=' + encodeURIComponent(i.value));
      });
      var full = url + path + (qs.length ? '?' + qs.join('&') : '');

      var headers = { Accept: 'application/json' };
      if (auth === 'basic' && pass.input.value) {
        headers.Authorization = /^qawk_/.test(pass.input.value)
          ? 'Bearer ' + pass.input.value
          : 'Basic ' + btoa(user.input.value + ':' + pass.input.value);
      } else if (auth === 'device' && token.input.value) {
        headers.Authorization = 'GatewayToken ' + token.input.value;
      }
      var init = { method: ep.m, headers: headers };
      if (bodyBox && ep.m !== 'GET' && ep.m !== 'HEAD') {
        headers['Content-Type'] = ep.ctype || 'application/json';
        init.body = bodyBox.value;
      }

      out.className = 'resp busy';
      out.textContent = 'Sending…';
      var t0 = Date.now();
      fetch(full, init).then(function (r) {
        return r.text().then(function (t) { return { r: r, t: t }; });
      }).then(function (x) {
        var ms = Date.now() - t0;
        var pretty = x.t;
        try { pretty = json(JSON.parse(x.t)); } catch (e) {}
        out.className = 'resp ' + (x.r.ok ? 'ok' : 'bad');
        out.innerHTML = '<div class="rline"><span class="pill ' + (x.r.ok ? 'get' : 'delete') + '">' +
          x.r.status + '</span> <span>' + esc(x.r.statusText || '') + '</span>' +
          '<span class="ms">' + ms + ' ms</span></div>' +
          '<pre><code>' + esc(pretty || '(no body)') + '</code></pre>';
      }).catch(function (e) {
        // A browser refuses to hand this page an answer from another origin
        // unless that server says it may. That is not a bug in either of them.
        out.className = 'resp bad';
        out.innerHTML = '<div class="rline"><span class="pill delete">blocked</span></div>' +
          '<p>' + esc(String(e && e.message || e)) + '</p>' +
          '<p>Almost always this is the browser refusing a cross-origin request, ' +
          'not the server refusing you. Start Qawk with the origin of this page allowed:</p>' +
          '<pre><code>QAWK_CORS_ORIGINS=' + esc(location.origin) + '</code></pre>' +
          '<p>Or copy the sample above and run it in a terminal, where no such rule applies.</p>';
      });
    };
    return p;
  }

  // An endpoint's path parameters: the API's common ones that its path really
  // uses, then its own, in the order the path names them.
  function pathParams(ep, api) {
    var have = (api.pp || []).concat(ep.pp || []);
    var out = [];
    var seen = {};
    var m = ep.p.match(/\{(\w+)\}/g) || [];
    m.forEach(function (slot) {
      var name = slot.slice(1, -1);
      if (seen[name]) return;
      seen[name] = true;
      for (var i = 0; i < have.length; i++) {
        if (have[i][0] === name) { out.push(have[i]); return; }
      }
      out.push([name, 'string', 1, '']);
    });
    // a documented parameter the path does not name is still worth showing
    (ep.pp || []).forEach(function (p) { if (!seen[p[0]]) out.push(p); });
    return out;
  }

  function paramBlock(title, rows) {
    if (!rows || !rows.length) return '';
    var h = '<h3 id="' + title.toLowerCase().replace(/\W+/g, '-') + '">' + title + '</h3><div class="params">';
    rows.forEach(function (r) {
      h += '<div class="param"><span class="rq">' +
        (r[2] ? '<span class="pill req">required</span>' : '<span class="pill opt">optional</span>') +
        '</span><span class="nm">' + esc(r[0]) + '</span><span class="ty">' + esc(r[1]) + '</span>' +
        '<div class="ds">' + r[3] + '</div></div>';
    });
    return h + '</div>';
  }

  function drawEndpoint(ep, api, main) {
    var left = el('div');
    var head = el('div');
    head.innerHTML = '<div class="ep-head">' + pill(ep.m) +
      '<span style="color:var(--fg-faint);font-size:12.5px">' + esc(api.title) + ' · ' + esc(ep.group) + '</span></div>' +
      '<h1>' + esc(ep.t) + '</h1>' +
      '<div class="ep-url"><span class="base">' + esc(api.base) + '</span><span class="path">' + esc(ep.p) + '</span></div>';
    left.appendChild(head);

    if (ep.d) left.appendChild(el('p', { class: 'lead' }, ep.d));

    var perm = ep.perm ? (ep.perm === 'admin' ? 'the <b>administrator</b>, or a role with every permission'
      : 'the <code>' + ep.perm + '</code> permission') : null;
    var a = ep.auth || api.auth;
    var authTxt = a === 'none' ? 'No credentials needed.'
      : a === 'device' ? 'A device\'s <b>gateway token</b> or <b>target token</b>.'
      : 'A user (HTTP Basic) or an API token (<code>Authorization: Bearer qawk_…</code>)' +
        (perm ? ', with ' + perm : '') + '.';
    left.appendChild(el('div', { class: 'note' }, '<b>Authorisation.</b> ' + authTxt));

    var req = el('div');
    var body = '';
    // the parameters every path of this API carries (the tenant and the
    // device, on the DDI) are documented once, on the API, and shown on each
    body += paramBlock('Path parameters', pathParams(ep, api));
    body += paramBlock('Query parameters', ep.q);
    body += paramBlock('Body', ep.bf);
    if (body) { req.innerHTML = '<h2 id="request">Request</h2>' + body; left.appendChild(req); }

    // the body, when it is shown as an example rather than field by field
    if (ep.body !== undefined && !ep.bf) {
      var b = el('div');
      b.innerHTML = (body ? '' : '<h2 id="request">Request</h2>') +
        '<h3>Body</h3><pre><code>' + esc(json(ep.body)) + '</code></pre>';
      left.appendChild(b);
    }
    if (ep.raw) {
      var rb = el('div');
      rb.innerHTML = (body ? '' : '<h2 id="request">Request</h2>') +
        '<h3>Body <span style="color:var(--fg-faint);font-weight:400">(' + ep.ctype + ')</span></h3>' +
        '<pre><code>' + esc(ep.raw) + '</code></pre>';
      left.appendChild(rb);
    }

    // responses, with the status codes as tabs
    if (ep.res) {
      var codes = Object.keys(ep.res);
      var rw = el('div');
      rw.innerHTML = '<h2 id="responses">Responses</h2>';
      var tabs = el('div', { class: 'tabs' });
      var pane = el('div');
      codes.forEach(function (c, i) {
        var b = el('button', { type: 'button', class: (c[0] === '2' ? 'code-200' : 'code-err') + (i === 0 ? ' on' : '') }, c);
        b.onclick = function () {
          tabs.querySelectorAll('button').forEach(function (x) {
            x.className = x.className.replace(' on', '');
          });
          b.className += ' on';
          showCode(c);
        };
        tabs.appendChild(b);
      });
      function showCode(c) {
        var r = ep.res[c];
        pane.innerHTML = '<p>' + r.d + '</p>' +
          (r.ex ? '<pre><code>' + esc(json(r.ex)) + '</code></pre>' : '');
      }
      showCode(codes[0]);
      rw.appendChild(tabs); rw.appendChild(pane);
      left.appendChild(rw);
    }

    // ------------------------------------------------------- right column
    var right = el('div', { class: 'rightcol' });

    var lp = el('div', { class: 'panel' });
    lp.appendChild(el('div', { class: 'ph' }, ic('terminal', 13) + 'Request sample'));
    var lt = el('div', { class: 'lang-tabs' });
    var codeBox = el('div', { class: 'pb' });
    function drawCode() {
      var text = GEN[lang](ep, api);
      codeBox.innerHTML = '';
      var wrap = el('div', { class: 'pre-wrap' });
      wrap.innerHTML = '<pre><code>' + esc(text) + '</code></pre>';
      var cb = el('button', { class: 'copy always', type: 'button' }, ic('copy', 12) + 'copy');
      wrap.appendChild(cb);
      codeBox.appendChild(wrap);
      cb.onclick = function () { copyText(text, cb); };
    }
    LANGS.forEach(function (L) {
      var b = el('button', { type: 'button', class: L === lang ? 'on' : '' },
        ic(L, 14) + (L === 'javascript' ? 'JS' : L === 'powershell' ? 'PS' : L));
      b.onclick = function () {
        lang = L;
        try { localStorage.setItem('qawk-docs-lang', L); } catch (e) {}
        lt.querySelectorAll('button').forEach(function (x) { x.className = ''; });
        b.className = 'on';
        drawCode();
      };
      lt.appendChild(b);
    });
    lp.appendChild(lt); lp.appendChild(codeBox); drawCode();
    right.appendChild(lp);

    right.appendChild(tryPanel(ep, api));

    var ip = el('div', { class: 'panel' });
    ip.appendChild(el('div', { class: 'ph' }, 'Endpoint'));
    var ib = el('div', { class: 'pb' });
    ib.style.fontSize = '13px';
    ib.innerHTML =
      '<div style="margin-bottom:8px"><span style="color:var(--fg-faint)">Method</span><br>' + pill(ep.m) + '</div>' +
      '<div style="margin-bottom:8px"><span style="color:var(--fg-faint)">Base URL</span><br>' +
      '<code>' + esc(api.base) + '</code></div>' +
      '<div style="margin-bottom:8px"><span style="color:var(--fg-faint)">Path</span><br>' +
      '<code>' + esc(ep.p) + '</code></div>' +
      (ep.perm ? '<div><span style="color:var(--fg-faint)">Permission</span><br><code>' +
        esc(ep.perm) + '</code></div>' : '');
    ip.appendChild(ib);
    right.appendChild(ip);

    var lay = el('div', { class: 'api-layout' });
    lay.appendChild(left); lay.appendChild(right);
    main.appendChild(lay);
  }

  function drawIndex(api, main) {
    var h = el('div');
    h.innerHTML = '<h1>' + esc(api.title) + '</h1><p class="lead">' + api.blurb + '</p>' +
      (api.note ? '<div class="note">' + api.note + '</div>' : '') +
      '<div class="ep-url"><span class="base">' + esc(api.base) + '</span><span class="path">' +
      esc(api.prefix) + '</span></div>';
    main.appendChild(h);
    api.groups.forEach(function (g) {
      var s = el('div');
      s.innerHTML = '<h2 id="' + g.t.toLowerCase().replace(/\W+/g, '-') + '">' + esc(g.t) + '</h2>';
      var list = el('div', { class: 'ep-list' });
      g.eps.forEach(function (e) {
        var a = el('a', { href: '#/' + api.id + '/' + e.id },
          pill(e.m) + '<span class="p">' + esc(e.p.replace(api.prefix, '') || '/') + '</span>' +
          '<span class="s">' + esc(e.t) + '</span>');
        list.appendChild(a);
      });
      s.appendChild(list);
      main.appendChild(s);
    });
  }

  function drawHome(main) {
    var h = el('div');
    h.innerHTML =
      '<h1>API reference</h1>' +
      '<p class="lead">Qawk serves three APIs. Two of them are hawkBit\'s, unchanged — that is the ' +
      'whole point of it — and the third is everything Qawk adds.</p>' +
      '<div class="cards">' +
      '<a class="card" href="#/qawk"><span class="ic">🛠️</span><b>Qawk API</b>' +
      '<span><code>/qawk/v1</code> — channels, releases, centres, the orchestrator, users and the ' +
      'audit log.</span></a>' +
      '<a class="card" href="#/ddi"><span class="ic">📟</span><b>Device API (DDI)</b>' +
      '<span><code>/{tenant}/controller/v1</code> — what a device speaks. hawkBit\'s, exactly.</span></a>' +
      '<a class="card" href="#/mgmt"><span class="ic">🗃️</span><b>Management API</b>' +
      '<span><code>/rest/v1</code> — hawkBit\'s 153 management operations, unchanged.</span></a>' +
      '</div>' +

      '<h2 id="auth">Authenticating</h2>' +
      '<p>Everything but <code>/qawk/v1/info</code> and the OpenAPI documents needs credentials. ' +
      'There are three kinds, and they are checked in this order:</p>' +
      '<table><thead><tr><th>Kind</th><th>Header</th><th>For</th></tr></thead><tbody>' +
      '<tr><td>User</td><td><code>Authorization: Basic &lt;base64 user:password&gt;</code></td>' +
      '<td>People, and the console on their behalf.</td></tr>' +
      '<tr><td>API token</td><td><code>Authorization: Bearer qawk_…</code></td>' +
      '<td>Scripts and CI. Acts with its owner\'s permissions <i>at the time of use</i>, so revoking ' +
      'a role revokes the token with it.</td></tr>' +
      '<tr><td>Device</td><td><code>Authorization: GatewayToken &lt;key&gt;</code><br>' +
      '<code>Authorization: TargetToken &lt;key&gt;</code></td>' +
      '<td>Devices, on the DDI API only.</td></tr>' +
      '</tbody></table>' +
      '<div class="tip"><b>Set the administrator\'s password.</b> Without ' +
      '<code>QAWK_ADMIN_PASSWORD</code> it is <code>admin</code>. The administrator is never stored: ' +
      'it always works, which is how a new server is set up and how a lost password is fixed.</div>' +

      '<h2 id="conventions">Conventions</h2>' +
      '<h3>Paging</h3>' +
      '<p>Collections take <code>offset</code> and <code>limit</code> and answer ' +
      '<code>{ "total": n, "size": m, "content": [...] }</code>. <code>total</code> is how many there ' +
      'are, <code>size</code> how many came back.</p>' +
      '<h3>Queries</h3>' +
      '<p>Where a <code>q</code> parameter exists it is hawkBit\'s FIQL: ' +
      '<code>name==shop-prod-*</code>, <code>attribute.ring==beta;updatestatus==error</code>. ' +
      '<code>;</code> is and, <code>,</code> is or, <code>*</code> is a wildcard. The console\'s query ' +
      'editor writes the same language.</p>' +
      '<h3>Times</h3>' +
      '<p>Every timestamp is milliseconds since the epoch, UTC — hawkBit\'s convention, kept.</p>' +
      '<h3>Errors</h3>' +
      '<p>hawkBit\'s error shape, with hawkBit\'s codes where the operation is hawkBit\'s:</p>' +
      '<pre><code>' + esc(json({ exceptionClass: 'org.eclipse.hawkbit.repository.exception.EntityNotFoundException',
        errorCode: 'hawkbit.server.error.repo.entitiyNotFound',
        message: 'Target with given identifier {shop-prod-017} does not exist.' })) + '</code></pre>' +
      '<p>What Qawk adds uses its own codes under the same shape — ' +
      '<code>qawk.fleet.gateClosed</code>, <code>qawk.system.state</code>, ' +
      '<code>qawk.release.fourEyes</code> — so a client that already handles hawkBit\'s errors ' +
      'handles these without a new branch.</p>' +

      '<h2 id="try">Sending a request from this page</h2>' +
      '<p>Every endpoint page has a <b>Send this request</b> panel: put in your server\'s address ' +
      'and credentials, fill the parameters, press send, read the answer. What you type stays in ' +
      'this page and goes to the base URL you gave it, nowhere else.</p>' +
      '<p>A browser will not hand a page an answer from another origin unless that server says it ' +
      'may, so the server has to allow this documentation\'s origin — off by default, because a ' +
      'server that only devices and scripts talk to gains nothing from it:</p>' +
      '<pre><code>QAWK_CORS_ORIGINS=' + esc(location.origin) + '</code></pre>' +
      '<p>Without it the panel says so and points at the sample, which runs in a terminal where no ' +
      'such rule applies. Never point the panel at the server that updates real machines: the ' +
      'requests are real.</p>' +

      '<h2 id="generated">Generated clients</h2>' +
      '<p>For the two hawkBit APIs, ask the server itself for its OpenAPI document and generate from ' +
      'that. It lists <b>only</b> the operations the server really implements, so a generated client ' +
      'cannot call something that is not there:</p>' +
      '<pre><code>curl -s \'https://qawk.example.com/v3/api-docs/swagger-config\'\n' +
      'curl -s \'https://qawk.example.com/v3/api-docs/Management%20API\' &gt; management.json\n' +
      'openapi-generator-cli generate -i management.json -g python -o ./client</code></pre>';
    main.appendChild(h);
  }

  // --------------------------------------------------------------- router

  function route() {
    var main = document.getElementById('api-main');
    main.innerHTML = '';
    var h = location.hash.replace(/^#\/?/, '');
    var crumb = document.getElementById('api-crumbs');
    var parts = h.split('/').filter(Boolean);

    if (!parts.length) {
      crumb.innerHTML = '<a href="' + url('') + '">Docs</a> <span class="sep">›</span> API reference';
      drawHome(main);
    } else if (parts.length === 1 && SPEC[parts[0]]) {
      crumb.innerHTML = '<a href="' + url('') + '">Docs</a> <span class="sep">›</span> ' +
        '<a href="#/">API reference</a> <span class="sep">›</span> ' + esc(SPEC[parts[0]].title);
      drawIndex(SPEC[parts[0]], main);
    } else if (ALL[parts[0] + '/' + parts[1]]) {
      var ep = ALL[parts[0] + '/' + parts[1]], api = SPEC[parts[0]];
      crumb.innerHTML = '<a href="' + url('') + '">Docs</a> <span class="sep">›</span> ' +
        '<a href="#/">API reference</a> <span class="sep">›</span> ' +
        '<a href="#/' + api.id + '">' + esc(api.title) + '</a> <span class="sep">›</span> ' +
        '<span style="color:var(--fg-dim)">' + esc(ep.t) + '</span>';
      drawEndpoint(ep, api, main);
    } else {
      crumb.innerHTML = '<a href="#/">API reference</a>';
      main.innerHTML = '<h1>Not here</h1><p>No such endpoint. <a href="#/">Start from the top.</a></p>';
    }
    markSide();
    window.scrollTo(0, 0);
    document.title = (parts.length ? (ALL[parts[0] + '/' + parts[1]] ?
      ALL[parts[0] + '/' + parts[1]].t : SPEC[parts[0]] ? SPEC[parts[0]].title : 'API') + ' · ' : '') +
      'Qawk API reference';
  }

  // The endpoint tree in the sidebar, under the API section.
  function apiSidebar() {
    var side = document.querySelector('aside.side');
    if (!side) return;
    var host = el('div');
    host.appendChild(el('div', { class: 'sec-label' }, 'API reference'));
    Object.keys(SPEC).forEach(function (k) {
      var api = SPEC[k];
      var g = el('div', { class: 'grp' });
      var b = el('button', { type: 'button' },
        '<span class="n">·</span><span>' + esc(api.title) + '</span><span class="caret">▶</span>');
      var ul = el('ul');
      ul.appendChild(el('li', null, '<a href="#/' + api.id + '" data-h="' + api.id + '"><b>Overview</b></a>'));
      api.groups.forEach(function (grp) {
        ul.appendChild(el('li', null, '<div class="sec-label" style="padding:9px 10px 3px">' +
          esc(grp.t) + '</div>'));
        grp.eps.forEach(function (e) {
          ul.appendChild(el('li', null, '<a href="#/' + api.id + '/' + e.id + '" data-h="' +
            api.id + '/' + e.id + '">' + esc(e.t) + '</a>'));
        });
      });
      b.onclick = function () { g.classList.toggle('open'); };
      g.appendChild(b); g.appendChild(ul); host.appendChild(g);
    });
    side.appendChild(host);
  }

  function markSide() {
    var h = location.hash.replace(/^#\/?/, '');
    document.querySelectorAll('aside.side a[data-h]').forEach(function (a) {
      var on = a.getAttribute('data-h') === h;
      a.className = on ? 'on' : '';
      if (on) {
        var g = a.closest('.grp');
        if (g) g.classList.add('open');
      }
    });
  }

  function boot() {
    if (!document.getElementById('api-main')) return;
    apiSidebar();
    window.addEventListener('hashchange', route);
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
