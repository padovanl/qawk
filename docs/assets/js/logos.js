/* The language logos on the code-sample tabs.
 *
 * Not the line icons the rest of the site draws: these are the real marks, in
 * their own colours, because that is what a reader recognises at a glance --
 * the yellow JS square, Python's two snakes, Go's cyan. They are drawn inline
 * so nothing is fetched and nothing can fail to load.
 *
 * Each is an approximation of the mark, built from paths and letterforms
 * here; none is the rights holder's own file. They are used nominatively, to
 * say which language a sample is written in, which is what the marks are for.
 * See NOTICE for the trademark note. */

(function () {
  'use strict';

  // A shared frame so every logo sits on the same 24x24 grid.
  function svg(body, size, extra) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 22) + '" height="' + (size || 22) +
      '" fill="none" aria-hidden="true" class="logo"' + (extra || '') + '>' + body + '</svg>';
  }

  var L = {
    // curl: the wordmark is lettering, so the mark here is its terminal --
    // which is where a curl line is typed anyway.
    curl: function (s) {
      return svg(
        '<rect x="1.5" y="3.5" width="21" height="17" rx="3" fill="#1a1e24" stroke="#8a97a6" stroke-width="1.2"/>' +
        '<path d="M6 9.5l3 2.5-3 2.5" stroke="#22c55e" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M12 15h5.5" stroke="#8a97a6" stroke-width="1.9" stroke-linecap="round"/>', s);
    },

    // Python: the two interlocking snakes, blue over yellow.
    python: function (s) {
      return svg(
        '<path fill="#3776AB" d="M11.9 1.2c-1.7 0-3 .2-3.9.5-1.1.4-1.6 1.1-1.6 2.1v1.9h5.6v.8H4.3c-1.1 0-2 .6-2.6 1.8C1 9.6.8 11 .8 12.6c0 1.5.2 2.8.7 3.9.6 1.3 1.5 1.9 2.7 1.9h1.6v-2.3c0-1.2.4-2.1 1.2-2.8.7-.6 1.6-.9 2.7-.9h3.6c1 0 1.8-.3 2.4-.8.6-.6.9-1.3.9-2.2V4c0-.9-.5-1.6-1.6-2.1-.9-.4-2.1-.6-3.6-.7zM8.8 2.8c.6 0 1 .5 1 1.1s-.4 1-1 1-1-.5-1-1 .4-1.1 1-1.1z"/>' +
        '<path fill="#FFD343" d="M12.1 22.8c1.7 0 3-.2 3.9-.5 1.1-.4 1.6-1.1 1.6-2.1v-1.9h-5.6v-.8h7.7c1.1 0 2-.6 2.6-1.8.7-1.3.9-2.7.9-4.3 0-1.5-.2-2.8-.7-3.9-.6-1.3-1.5-1.9-2.7-1.9h-1.6v2.3c0 1.2-.4 2.1-1.2 2.8-.7.6-1.6.9-2.7.9h-3.6c-1 0-1.8.3-2.4.8-.6.6-.9 1.3-.9 2.2V20c0 .9.5 1.6 1.6 2.1.9.4 2.1.6 3.6.7zm3.1-1.6c-.6 0-1-.5-1-1.1s.4-1 1-1 1 .5 1 1-.4 1.1-1 1.1z"/>', s);
    },

    // JavaScript: the yellow square with the letters in the corner.
    javascript: function (s) {
      return svg(
        '<rect x="1" y="1" width="22" height="22" rx="2.5" fill="#F7DF1E"/>' +
        '<text x="21.5" y="20" text-anchor="end" font-family="Helvetica,Arial,sans-serif" ' +
        'font-size="11.5" font-weight="700" fill="#000">JS</text>', s);
    },

    // Go: the wordmark, cyan, with its speed lines.
    go: function (s) {
      return svg(
        '<path d="M.8 9.6h4M2.2 12.4h3.4" stroke="#00ADD8" stroke-width="1.5" stroke-linecap="round"/>' +
        '<text x="7" y="16.4" font-family="Helvetica,Arial,sans-serif" font-size="11.5" ' +
        'font-weight="700" fill="#00ADD8" letter-spacing="-.5">GO</text>', s);
    },

    // PowerShell: the blue tile with the prompt.
    powershell: function (s) {
      return svg(
        '<rect x="1" y="3" width="22" height="18" rx="2.5" fill="#2671BE"/>' +
        '<path d="M7 8.5l4.2 3.5L7 15.5" stroke="#fff" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M12.5 16h5" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>', s);
    }
  };

  window.QawkLogos = {
    markup: function (name, size) { return L[name] ? L[name](size) : ''; },
    has: function (name) { return !!L[name]; }
  };
})();
