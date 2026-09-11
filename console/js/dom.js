/* ------------------------------------------------------------------ utils */
const $ = (s, r = document) => r.querySelector(s);

function h(tag, attrs, ...kids) {
  // 'div#compat.compat.warn' -> <div id="compat" class="compat warn">.
  // The id was NOT understood before: the whole 'div#compat' went to
  // createElement, which throws InvalidCharacterError in a browser -- so the
  // compatibility bar, the one element written with an id, was never created
  // at all. It failed inside a promise nobody awaited, so nothing said so.
  const [head, ...cls] = tag.split('.');
  const [name, id] = head.split('#');
  const e = document.createElement(name || 'div');
  if (id) e.id = id;
  if (cls.length) e.className = cls.join(' ');
  if (attrs && (attrs.nodeType || typeof attrs !== 'object' || Array.isArray(attrs))) {
    kids.unshift(attrs);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className += ' ' + v;
      // a property, not addEventListener: an update in place (morph) hands the
      // element on screen the handler of the new render, with its new data
      else if (k.startsWith('on')) { e[k] = v; (e.__on || (e.__on = {}))[k.slice(2)] = v; }
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
      else e.setAttribute(k, v);
    }
  }
  for (const k of kids.flat(9)) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}

/* ---------------------------------------------------------------- icons */
/* Inline SVG, stroked in currentColor: no icon font, no sprite sheet, nothing
 * to fetch. They are there to make a row scannable, not decorative -- one
 * stroke weight, one size, no fills. */
const ICONS = {
  dash:    'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  target:  'M3 5h18v11H3zM8 20h8M12 16v4',
  filter:  'M3 5h18l-7 8v6l-4 2v-8z',
  fleet:   'M3 7h6v5H3zM15 7h6v5h-6zM9 15h6v5H9zM6 12v1.5h12V12M12 13.5V15',
  tag:     'M3 12V4h8l9 9-8 8-9-9zM7.5 7.5h.01',
  rollout: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  package: 'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8',
  module:  'M9 3h6v3h3v6h3v6h-6v-3H9v-3H6V9H3V3z',
  cfg:     'M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4',
  info:    'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01',
  chip:    'M7 7h10v10H7zM4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3',
  box:     'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8',
  plus:    'M12 5v14M5 12h14',
  columns: 'M3 4h18v16H3zM9 4v16M15 4v16',
  deploy:  'M12 19V5M12 5l-6 6M12 5l6 6',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  user:    'M4 21v-1.6A5.4 5.4 0 019.4 14h5.2a5.4 5.4 0 015.4 5.4V21M12 3.2a4.1 4.1 0 100 8.2 4.1 4.1 0 000-8.2',
  lock:    'M5 10.8h14v10.4H5zM8.2 10.8V7a3.8 3.8 0 017.6 0v3.8',
  eye:     'M2.2 12S6 5.8 12 5.8 21.8 12 21.8 12 18 18.2 12 18.2 2.2 12 2.2 12zM12 9.2a2.8 2.8 0 100 5.6 2.8 2.8 0 000-5.6',
  eyeoff:  'M3 3l18 18M10 10a2.8 2.8 0 004 4M6.6 6.7C3.8 8.4 2.2 12 2.2 12s3.8 6.2 9.8 6.2c1.8 0 3.4-.5 4.7-1.3M20 15c1.2-1.4 1.8-3 1.8-3S18 5.8 12 5.8c-.7 0-1.3.1-1.9.2',
  exit:    'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h9',
  save:    'M5 4h11l3 3v13H5zM8 4v5h7M8 14h8v6H8z',
  left:    'M14 6l-6 6 6 6',
  right:   'M10 6l6 6-6 6',
  trash:   'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  check:   'M4 12l5 5L20 6',
  x:       'M6 6l12 12M18 6L6 18',
  upload:  'M12 19V7M12 7l-5 5M12 7l5 5M5 21h14',
  play:    'M7 5l12 7-12 7z',
  pause:   'M8 5h3v14H8zM13 5h3v14h-3z',
  next:    'M6 5l9 7-9 7zM17 5h2v14h-2z',
  edit:    'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
  add:     'M12 5v14M5 12h14',
  alert:   'M12 4l9.5 16h-19zM12 10v4.5M12 17.5h.01',
  clock:   'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5V12l3 2',
};
function icon(name, size = 15) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('ico');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.info);
  svg.append(path);
  return svg;
}

const skeleton = (n = 7) => h('div.skel', Array.from({ length: n }, () => h('i')));

/* ------- updating in place -------------------------------------------------
 *
 * A page is drawn once and then kept up to date where it stands: every few
 * seconds it is built again from what the server says, and the new build is
 * MERGED into what is on screen -- a number that changed is changed, a badge
 * that changed colour changes colour, a bar's width changes (and slides), a
 * row that appeared is inserted, one that went is removed. Nothing is redrawn:
 * no flicker, the scroll stays, the field someone is typing in keeps what they
 * typed, a panel they opened stays open. Rows carry data-key (a controller
 * id, a centre) so a list that reorders moves its rows instead of rewriting
 * them.
 *
 * A value that arrives after the build (data-pending: a cell filled by its
 * own request) is not overwritten with its "…": the element on screen keeps
 * what it shows, and the request, when it answers, writes to the element on
 * screen -- live(node) -- not to the copy that was merged away. */
const twin = new WeakMap();      // node of a later build -> node on screen it was merged into
const FORM = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);

function live(n) {
  let x = n;
  while (twin.has(x)) x = twin.get(x);
  return x;
}

const keyOf = n => (n.nodeType === 1 ? n.getAttribute('data-key') : null);

function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName || keyOf(from) !== keyOf(to)) {
    from.replaceWith(to);
    return to;
  }
  twin.set(to, from);
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return from;
  }
  if (to.hasAttribute('data-pending') && !from.hasAttribute('data-pending')) return from;
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  const on = to.__on || {};
  for (const ev of Object.keys(from.__on || {})) if (!(ev in on)) from['on' + ev] = null;
  for (const [ev, fn] of Object.entries(on)) from['on' + ev] = fn;
  from.__on = to.__on;
  patch(from, to);
  if (FORM.has(from.nodeName)) {
    // what someone is typing is theirs until they leave the field
    if (from !== document.activeElement && from.value !== to.value) from.value = to.value;
    if (from.checked !== to.checked) from.checked = to.checked;
    if (from.disabled !== to.disabled) from.disabled = to.disabled;
    if (from.nodeName === 'OPTION' && from.selected !== to.selected) from.selected = to.selected;
  }
  return from;
}

// patch(el, built): make el's children what built's children are, in place.
function patch(from, to) {
  const olds = [...from.childNodes], news = [...to.childNodes];
  const keyed = new Map();
  for (const o of olds) { const k = keyOf(o); if (k !== null) keyed.set(k, o); }
  const used = new Set();
  let oi = 0;
  news.forEach((n, i) => {
    let m = null;
    const k = keyOf(n);
    if (k !== null) {
      const o = keyed.get(k);
      if (o && !used.has(o) && o.nodeName === n.nodeName) m = o;
    } else {
      while (oi < olds.length && (used.has(olds[oi]) || keyOf(olds[oi]) !== null)) oi++;
      const o = olds[oi];
      if (o && o.nodeType === n.nodeType && o.nodeName === n.nodeName) { m = o; oi++; }
    }
    let node = n;
    if (m) { used.add(m); node = morph(m, n); }
    const at = from.childNodes[i];
    if (at !== node) from.insertBefore(node, at || null);
  });
  for (const o of olds) if (!used.has(o) && o.parentNode === from) o.remove();
}

export {
  $, h, icon, live, morph, patch, skeleton,
};
