// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

/* Enough of a browser to load the console under node.
 *
 * The point is not to simulate rendering -- it is to let node LINK every
 * module (which proves each import names an export that really exists) and
 * then EVALUATE them (which catches anything a module references but never
 * imported). Both are mistakes a split into modules makes easy to introduce
 * and impossible to see by reading.
 */

// Detach a node from wherever it is: the DOM moves a node that is inserted
// again, it never has it in two places. dom.js's patch() relies on that.
function detach(n) {
  const p = n && n.parentNode;
  if (!p) return;
  const i = p.children.indexOf(n);
  if (i >= 0) p.children.splice(i, 1);
  n.parentNode = null;
}

function parentLink(n) {
  if (!Object.getOwnPropertyDescriptor(n, 'parentNode')) {
    Object.defineProperty(n, 'parentNode', { value: null, writable: true, enumerable: false });
  }
}

export class Text {
  constructor(t) {
    this.nodeType = 3; this.nodeName = '#text'; this.textContent = String(t);
    parentLink(this);
  }
  get nodeValue() { return this.textContent; }
  set nodeValue(v) { this.textContent = String(v); }
  replaceWith(n) { if (this.parentNode) this.parentNode._replace(this, n); }
  remove() { detach(this); }
}

export class El {
  constructor(name = 'div') {
    this.nodeName = name; this.nodeType = 1;
    this.children = []; this.dataset = {}; this.options = [];
    // custom properties are set through style.setProperty, not as fields
    const vars = {};
    this.style = {
      setProperty: (k, v) => { vars[k] = v; },
      getPropertyValue: k => vars[k] ?? '',
      removeProperty: k => { delete vars[k]; },
    };
    this.hidden = false; this.value = ''; this.disabled = false; this.title = '';
    this.id = '';
    // attributes, for dom.js's in-place update (keyed children, data-own)
    Object.defineProperty(this, '_attrs', { value: new Map(), enumerable: false });
    // Non-enumerable, or the parent link makes the tree circular and
    // JSON.stringify -- which a test uses -- throws.
    Object.defineProperty(this, 'parentNode', { value: null, writable: true, enumerable: false });
    // the console checks this before touching a node it built a frame ago
    this.isConnected = true;
    this._cls = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._cls.add(x)),
      remove: (...c) => c.forEach(x => this._cls.delete(x)),
      toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); },
      contains: c => this._cls.has(c),
    };
    // h() sets handlers as properties (onclick…), so an update in place can
    // hand them over; addEventListener ones are kept here too
    this.handlers = new Proxy({}, { get: (o, k) => o[k] || this['on' + String(k)] });
  }
  // the console asks for childNodes as well as children
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(' ').filter(Boolean)); }
  get textContent() {
    return this.children.map(c => c.nodeType === 3 ? c.textContent : (c.textContent || '')).join('');
  }
  set textContent(v) { this.children = [this._adopt(new Text(v))]; }
  setAttribute(k, v) { this.dataset['_' + k] = String(v); this._attrs.set(String(k), String(v)); }
  getAttribute(k) { return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null; }
  hasAttribute(k) { return this._attrs.has(String(k)); }
  removeAttribute(k) { delete this.dataset['_' + k]; this._attrs.delete(String(k)); }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  addEventListener(k, f) { this.handlers[k] = f; }
  removeEventListener() {}
  // The real DOM turns a bare string into a text node; the stub has to do the
  // same or a legitimate replaceChildren('finished') reads as empty.
  static _node(k) {
    return (k && typeof k === 'object') ? k : new Text(k);
  }
  // Parents are tracked, so remove() actually detaches: a no-op made every
  // "it takes itself away" test pass without the code doing anything.
  _adopt(k) {
    const n = El._node(k);
    if (n && typeof n === 'object') {
      parentLink(n);
      detach(n);
      n.parentNode = this;
    }
    return n;
  }
  _replace(old, k) {
    const i = this.children.indexOf(old);
    if (i < 0) return;
    const n = this._adopt(k);
    const j = this.children.indexOf(old);
    this.children.splice(j, 1, n);
    old.parentNode = null;
  }
  replaceWith(k) { if (this.parentNode) this.parentNode._replace(this, k); }
  append(...k) { this.children.push(...k.map(x => this._adopt(x))); }
  appendChild(k) { this.children.push(this._adopt(k)); return k; }
  insertBefore(k, ref) {
    const n = this._adopt(k);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, n); else this.children.push(n);
    return k;
  }
  prepend(...k) { this.children.unshift(...k.map(x => this._adopt(x))); }
  replaceChildren(...k) { this.children = k.map(x => this._adopt(x)); }
  remove() { detach(this); }
  /* Good enough for '#id' and '.class': the console looks elements up that
     way, and a stub that answers "here is a fresh element" to everything makes
     any assertion about presence meaningless. */
  querySelector(sel) {
    return this._find(String(sel || '')) || new El();
  }
  _find(sel) {
    if (sel.startsWith('#') && this.id === sel.slice(1)) return this;
    if (sel.startsWith('.') && this._cls.has(sel.slice(1))) return this;
    for (const c of this.children) { const r = c._find && c._find(sel); if (r) return r; }
    return null;
  }
  querySelectorAll() { return []; }
  matches() { return false; }
  contains() { return false; }
  closest() { return null; }
  focus() { globalThis.document.activeElement = this; this.focused = true; }
  blur() {} select() {} scrollIntoView() {} showModal() {} close() {}
  setSelectionRange(a) { this.caret = a; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  /* test helper: every descendant carrying a class */
  findAll(cls, out = []) {
    if (this._cls.has(cls)) out.push(this);
    for (const c of this.children) if (c.findAll) c.findAll(cls, out);
    return out;
  }
  /* test helper: first descendant carrying a class */
  find(cls) {
    if (this._cls.has(cls)) return this;
    for (const c of this.children) { const r = c.find && c.find(cls); if (r) return r; }
    return null;
  }
}

export function install() {
  const doc = new El('#document');
  doc.documentElement = new El('html');
  doc.body = new El('body');
  doc.createElement = n => new El(n);
  doc.createElementNS = (_, n) => new El(n);
  doc.createTextNode = t => new Text(t);
  /* The page's own furniture, so a lookup finds the SAME element every time
     and something genuinely absent is genuinely absent. Without this every
     querySelector answered with a fresh element, which made "is the bar gone?"
     unanswerable. */
  for (const id of ['app', 'login', 'main', 'view', 'toasts', 'conn', 'busy',
                    'nav', 'sidebar', 'title', 'bar-extra', 'refresh', 'logout',
                    'theme', 'theme-login', 'auto', 'paused', 'progress', 'scrim',
                    'drawer', 'drawer-title', 'drawer-body', 'drawer-close',
                    'modal', 'modal-title', 'modal-body', 'modal-ok', 'modal-cancel',
                    'navtoggle', 'login-form', 'login-err', 'u', 'p', 'reveal',
                    'i-user', 'i-lock', 'signin']) {
    const el = new El('div'); el.id = id; doc.body.append(el);
  }
  // NULL when it is not there, as a browser does. Handing back a spare
  // element made "is it already on the page?" always answer yes, so code that
  // guards against creating something twice never created it once.
  doc.getElementById = id => doc.body._find('#' + id);
  doc.activeElement = null;
  doc.hidden = false;
  // document.querySelector searches the body, where the furniture lives
  doc.querySelector = sel => doc.body._find(String(sel || '')) || new El();
  doc.__has = sel => !!doc.body._find(String(sel || ''));
  globalThis.document = doc;

  const store = () => {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k), clear: () => m.clear(),
    };
  };
  globalThis.localStorage = store();
  globalThis.sessionStorage = store();
  globalThis.location = { hash: '#dash', href: 'http://localhost:8090/', reload() {} };
  globalThis.window = {
    addEventListener() {}, location: globalThis.location,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  // frames are collected rather than run, so a test can fire them on purpose
  globalThis.__frames = [];
  globalThis.requestAnimationFrame = f => globalThis.__frames.push(f);
  // the console installs polling timers on load; they must not keep node alive
  globalThis.setInterval = () => 0;
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = { addEventListener() {} }; }
    open() {} send() {} setRequestHeader() {} addEventListener() {}
  };
}
