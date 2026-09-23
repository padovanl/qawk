/* Syntax highlighting and line numbers for the code in this documentation.
 *
 * Small on purpose: a reader is looking at a curl line, a bit of YAML or a
 * twelve-line Go sample, not reading a codebase. So this knows the seven
 * languages the documentation actually uses and nothing else, which is a few
 * hundred lines rather than the hundred kilobytes a general highlighter costs
 * — and the documentation site has no build step to hide that behind.
 *
 * It tokenises the RAW text and escapes each token as it emits it. It never
 * runs a regular expression over HTML, which is how highlighters end up
 * colouring the inside of a tag and breaking the page. */

(function () {
  'use strict';

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Each language is a list of [class, pattern]. Order matters: whatever can
  // swallow another thing comes first, so a '#' inside a string stays a string
  // rather than starting a comment.
  var STR = "'(?:\\\\.|[^'\\\\])*'|\"(?:\\\\.|[^\"\\\\])*\"";

  var LANGS = {
    shell: [
      ['c', /#[^\n]*/],
      ['s', new RegExp(STR)],
      ['v', /\$\{[^}]*\}|\$[A-Za-z_]\w*/],
      ['f', /(?:^|[\s(])--?[A-Za-z][\w-]*/],
      ['k', /\b(?:curl|docker|docker-compose|python3|node|git|openssl|cd|mkdir|cp|mv|rm|chmod|export|echo|cat|sudo|apt|update-ca-certificates|pg_dump|tar|kubectl|set|for|do|done|if|then|fi)\b/],
      ['u', /https?:\/\/[^\s'"`]+/],
      ['n', /\b\d+(?:\.\d+)*\b/]
    ],
    json: [
      ['p', /"(?:\\.|[^"\\])*"(?=\s*:)/],
      ['s', /"(?:\\.|[^"\\])*"/],
      ['k', /\b(?:true|false|null)\b/],
      ['n', /-?\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b/]
    ],
    yaml: [
      ['c', /#[^\n]*/],
      ['p', /^[ \t-]*[\w.$-]+(?=\s*:)/m],
      ['s', new RegExp(STR)],
      ['k', /\b(?:true|false|null|yes|no)\b/],
      ['u', /https?:\/\/[^\s'"`]+/],
      ['n', /\b\d+(?:\.\d+)*\b/]
    ],
    python: [
      ['c', /#[^\n]*/],
      ['s', /[frbFRB]?(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/],
      ['k', /\b(?:import|from|as|with|def|class|return|if|elif|else|for|in|not|and|or|try|except|raise|while|pass|lambda|None|True|False|print|open)\b/],
      ['n', /\b\d+(?:\.\d+)?\b/]
    ],
    javascript: [
      ['c', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
      ['s', /`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/],
      ['k', /\b(?:const|let|var|function|async|await|return|if|else|for|of|in|new|throw|try|catch|class|import|export|from|true|false|null|undefined|console|JSON|fetch)\b/],
      ['n', /\b\d+(?:\.\d+)?\b/]
    ],
    go: [
      ['c', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
      ['s', /`[^`]*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/],
      ['k', /\b(?:package|import|func|var|const|type|struct|interface|return|if|else|for|range|defer|go|chan|map|nil|true|false|panic|make|new|string|int|int64|byte|error)\b/],
      ['n', /\b\d+(?:\.\d+)?\b/]
    ],
    powershell: [
      ['c', /#[^\n]*/],
      ['s', /@'[\s\S]*?'@|@"[\s\S]*?"@|'(?:''|[^'])*'|"(?:`.|[^"`])*"/],
      ['v', /\$\w+(?::\w+)?|\$\([^)]*\)/],
      ['k', /\b(?:Invoke-RestMethod|Invoke-WebRequest|ConvertTo-Json|ConvertFrom-Json|Write-Host|Get-Content|Set-Content|param|if|else|foreach)\b/],
      ['f', /(?:^|\s)-[A-Za-z]\w*/],
      ['n', /\b\d+(?:\.\d+)?\b/]
    ],
    http: [
      ['k', /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/m],
      ['p', /^[A-Za-z-]+(?=:)/m],
      ['u', /https?:\/\/[^\s]+|\/[^\s]*/],
      ['s', new RegExp(STR)],
      ['n', /\b\d+\b/]
    ],
    // nothing to say about it: still gets line numbers
    text: []
  };

  // One regex per language, built once: alternation in the order above, with
  // each branch remembered by index so the class is known from which one hit.
  var COMPILED = {};
  function compile(lang) {
    if (COMPILED[lang]) return COMPILED[lang];
    var rules = LANGS[lang] || [];
    if (!rules.length) return (COMPILED[lang] = null);
    var src = rules.map(function (r) { return '(' + r[1].source + ')'; }).join('|');
    var flags = 'g';
    if (rules.some(function (r) { return r[1].flags.indexOf('m') >= 0; })) flags += 'm';
    return (COMPILED[lang] = { re: new RegExp(src, flags), rules: rules });
  }

  // highlight(text, lang) -> HTML, escaped, with <span class="t-…"> around
  // what was recognised.
  function highlight(text, lang) {
    var c = compile(lang);
    if (!c) return esc(text);
    var out = '', last = 0, m;
    c.re.lastIndex = 0;
    while ((m = c.re.exec(text)) !== null) {
      // a zero-length match would spin for ever
      if (m[0] === '') { c.re.lastIndex++; continue; }
      var which = -1;
      for (var i = 1; i < m.length; i++) {
        if (m[i] !== undefined) { which = i - 1; break; }
      }
      if (which < 0) continue;
      out += esc(text.slice(last, m.index));
      // some patterns take a leading space or bracket so they only match at a
      // boundary: that character is not part of the token
      var tok = m[0], lead = '';
      if (/^[\s(]/.test(tok) && (c.rules[which][0] === 'f')) {
        lead = tok[0];
        tok = tok.slice(1);
      }
      out += esc(lead) + '<span class="t-' + c.rules[which][0] + '">' + esc(tok) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  // Wrap each line so CSS can number it. A block element per line, rather than
  // a separate gutter column, keeps the numbers beside the right line when a
  // long line wraps and keeps them out of what is copied.
  function withLines(html) {
    return html.split('\n')
      .map(function (l) { return '<span class="li">' + (l || '\u200b') + '</span>'; })
      .join('');
  }

  // What is this? Guessed only when nobody said, for the hand-written blocks
  // in the guides -- the API reference always knows its language.
  function guess(text) {
    var t = text.trim();
    if (/^[{[]/.test(t) && /[:,]/.test(t)) return 'json';
    if (/^(?:GET|POST|PUT|DELETE|PATCH|HEAD)\s+\//m.test(t)) return 'http';
    if (/^package\s+\w|^func\s/m.test(t)) return 'go';
    if (/^(?:import|from)\s+\w+|^\s*def\s/m.test(t)) return 'python';
    if (/^\s*(?:const|let|async function|await)\s/m.test(t)) return 'javascript';
    if (/^\$\w+\s*=|Invoke-RestMethod/m.test(t)) return 'powershell';
    if (/^\s*[\w.-]+:\s*($|[^\/])/m.test(t) && !/^\s*(?:curl|docker|python3)/m.test(t)) return 'yaml';
    if (/^\s*(?:curl|docker|git|python3|node|openssl|cd|mkdir|V=|A=|Q=|#)/m.test(t)) return 'shell';
    return 'text';
  }

  // paint(pre, lang) turns one <pre><code> into highlighted, numbered lines.
  // It reads textContent, so running it twice is harmless.
  function paint(pre, lang) {
    var code = pre.querySelector('code') || pre;
    var text = code.textContent.replace(/\n$/, '');
    var l = lang || pre.getAttribute('data-lang') || guess(text);
    code.innerHTML = withLines(highlight(text, l));
    pre.classList.add('hl');
    pre.setAttribute('data-lang', l);
    // one line needs no numbering: it is a command, not a listing
    if (text.indexOf('\n') < 0) pre.classList.add('one');
    return pre;
  }

  function paintAll(root) {
    (root || document).querySelectorAll('pre:not(.hl)').forEach(function (pre) { paint(pre); });
  }

  window.QawkHL = { highlight: highlight, withLines: withLines, paint: paint, paintAll: paintAll };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { paintAll(); });
  } else {
    paintAll();
  }
})();
