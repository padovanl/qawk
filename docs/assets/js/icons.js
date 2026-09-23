// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

/* Icons for the documentation, drawn inline.
 *
 * The same Tabler outlines the console uses, so a reader who knows the product
 * recognises the shapes in the page that describes it. Inline SVG rather than
 * a font or a sprite: nothing to fetch, nothing to fail, and they take the
 * colour of the text around them.
 *
 * Every path is drawn in a 24x24 box with a 2px stroke and no fill. */

(function () {
  'use strict';

  var P = {
    // concepts
    rocket: '<path d="M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3-5a9 9 0 0 0 6-8a3 3 0 0 0-3-3a9 9 0 0 0-8 6a6 6 0 0 0-5 3"/><path d="M7 14a6 6 0 0 0-3 6a6 6 0 0 0 6-3"/><circle cx="15" cy="9" r="1"/>',
    cursor: '<path d="M7.904 17.563a1.2 1.2 0 0 0 2.228.308l2.09-3.093 4.907 4.907a1.067 1.067 0 0 0 1.509 0l1.047-1.047a1.067 1.067 0 0 0 0-1.509l-4.907-4.907 3.113-2.09a1.2 1.2 0 0 0-.309-2.228L4 4z"/>',
    puzzle: '<path d="M4 7h3a1 1 0 0 0 1-1V5a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1a2 2 0 0 0-4 0v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a2 2 0 0 0 0-4H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h0M18 14h0M10 14h4"/>',
    route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-8a3.5 3.5 0 0 1 0-7H12"/>',
    building: '<path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/><path d="M9 9v0M9 12v0M9 15v0M9 18v0"/>',
    device: '<rect x="7" y="4" width="10" height="16" rx="1"/><path d="M11 5h2M12 17v.01"/>',
    server: '<rect x="3" y="4" width="18" height="8" rx="3"/><rect x="3" y="12" width="18" height="8" rx="3"/><path d="M7 8v.01M7 16v.01"/>',
    users: '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.85"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    bee: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M5 9h14M4.5 15h15"/>',
    scale: '<path d="M12 3v18M7 7l-4 7h8zM17 7l-4 7h8zM8 21h8M5 7h14"/>',
    // states and actions
    check: '<path d="M5 12l5 5L20 7"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    alert: '<path d="M12 9v4M12 17v.01"/><path d="M10.24 3.957l-8.422 14.06A1.989 1.989 0 0 0 3.518 21h16.964c1.556 0 2.474-1.696 1.7-3.017L13.76 3.957a1.989 1.989 0 0 0-3.52 0"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 12h1v4h1"/>',
    bulb: '<path d="M3 12h1M12 3v1M20 12h1M5.6 5.6l.7.7M18.4 5.6l-.7.7"/><path d="M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0-1 3a2 2 0 0 1-4 0a3.5 3.5 0 0 0-1-3"/><path d="M9.7 17h4.6"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
    back: '<path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><circle cx="12" cy="16" r="1"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10c-4-1.5-7-5.5-7-10V6z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    snow: '<path d="M12 3v18M7.5 5.5L12 9l4.5-3.5M7.5 18.5L12 15l4.5 3.5M3.3 7.5l17.4 9M3.3 16.5l17.4-9"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    terminal: '<path d="M5 7l5 5-5 5M13 17h6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    send: '<path d="M10 14l11-11M21 3l-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1z"/>',
    book: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0v13a9 9 0 0 0-9 0a9 9 0 0 0-9 0z"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="M21 21l-6-6"/>',
    github: '<path fill="currentColor" stroke="none" d="M12 1.3a10.7 10.7 0 0 0-3.4 20.9c.5.1.7-.2.7-.5v-1.9c-3 .6-3.6-1.4-3.6-1.4-.5-1.2-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 1.7 2.5 1.2 3.2.9.1-.7.4-1.2.7-1.5-2.4-.3-5-1.2-5-5.4 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1a10.3 10.3 0 0 1 5.4 0c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.8 1.1 3 0 4.2-2.6 5.1-5 5.4.4.3.8 1 .8 2.1v3.2c0 .3.2.6.7.5A10.7 10.7 0 0 0 12 1.3z"/>',
    'arrow-left': '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',

    // Filled marks for the admonition headers. A 1.8px outline is unreadable
    // at 16px; a solid shape with the symbol knocked out of it is not.
    'info-fill': '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/>' +
      '<path d="M12 7.2v.02M11.1 11h1.2v5.4h1.1" stroke="var(--bg-2)" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="7.4" r="1.15" fill="var(--bg-2)" stroke="none"/>',
    'alert-fill': '<path d="M10.3 3.2 1.9 17.3A2 2 0 0 0 3.6 20.3h16.8a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" ' +
      'fill="currentColor" stroke="none"/>' +
      '<path d="M12 9v4.6" stroke="var(--bg-2)" stroke-width="2.1" stroke-linecap="round"/>' +
      '<circle cx="12" cy="17" r="1.2" fill="var(--bg-2)" stroke="none"/>',
    'bulb-fill': '<path d="M12 2.5a6.5 6.5 0 0 0-3.9 11.7c.6.5.9 1.1.9 1.8v.5h6v-.5c0-.7.3-1.3.9-1.8A6.5 6.5 0 0 0 12 2.5z" ' +
      'fill="currentColor" stroke="none"/>' +
      '<path d="M9.5 19h5M10.2 21.3h3.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    // languages, for the code sample tabs
    curl: '<path d="M5 7l5 5-5 5M13 17h6"/>',
    python: '<path d="M12 3c-3 0-4 1-4 3v2h4v1H6.5C5 9 4 10 4 12s1 3 2.5 3H8v-2c0-2 1-3 3-3h3c1.5 0 2-1 2-2V6c0-2-1-3-4-3"/><path d="M12 21c3 0 4-1 4-3v-2h-4v-1h5.5C19 15 20 14 20 12s-1-3-2.5-3H16v2c0 2-1 3-3 3h-3c-1.5 0-2 1-2 2v2c0 2 1 3 4 3"/><path d="M10 6.5v.01M14 17.5v.01"/>',
    javascript: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M11 9v5a2 2 0 1 1-4 0"/><path d="M17.5 10.5A1.5 1.5 0 0 0 16 9.5h-.5a1.5 1.5 0 0 0 0 3h.5a1.5 1.5 0 0 1 0 3H15"/>',
    go: '<path d="M2 10h4M3 13h4"/><circle cx="14" cy="12" r="5"/><path d="M12 10.5v.01"/><path d="M19 9h3M19 15h3"/>',
    powershell: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 9l4 3-4 3M13 15h4"/>',
  };

  // svg(name, size) -> an <svg> element, or null when there is no such icon.
  function svg(name, size) {
    if (!P[name]) return null;
    var n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    n.setAttribute('viewBox', '0 0 24 24');
    n.setAttribute('width', size || 18);
    n.setAttribute('height', size || 18);
    n.setAttribute('fill', 'none');
    n.setAttribute('stroke', 'currentColor');
    n.setAttribute('stroke-width', '1.8');
    n.setAttribute('stroke-linecap', 'round');
    n.setAttribute('stroke-linejoin', 'round');
    n.setAttribute('aria-hidden', 'true');
    n.classList.add('ico');
    n.innerHTML = P[name];
    return n;
  }

  // markup(name, size) -> the same thing as a string, for innerHTML.
  function markup(name, size) {
    if (!P[name]) return '';
    return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" class="ico">' + P[name] + '</svg>';
  }

  window.QawkIcons = { svg: svg, markup: markup, has: function (n) { return !!P[n]; } };
})();

/* Fill the <span class="ico-slot" data-ico="..."> the pages carry. They are
 * written in the HTML rather than injected by a rule so the markup says what
 * it means, and a page with no JavaScript simply has no icons rather than
 * broken ones. */
(function () {
  function fill() {
    document.querySelectorAll('.ico-slot[data-ico]').forEach(function (slot) {
      var svg = window.QawkIcons.svg(slot.getAttribute('data-ico'),
        +slot.getAttribute('data-size') || 17);
      if (svg) slot.replaceWith(svg);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})();
