/* Enough of a browser to load the console under node.
 *
 * The point is not to simulate rendering -- it is to let node LINK every
 * module (which proves each import names an export that really exists) and
 * then EVALUATE them (which catches anything a module references but never
 * imported). Both are mistakes a split into modules makes easy to introduce
 * and impossible to see by reading.
 */

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
    // the console checks this before touching a node it built a frame ago
    this.isConnected = true;
    this._cls = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._cls.add(x)),
      remove: (...c) => c.forEach(x => this._cls.delete(x)),
      toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); },
      contains: c => this._cls.has(c),
    };
    this.handlers = {};
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(' ').filter(Boolean)); }
  get textContent() {
    return this.children.map(c => c.nodeType === 3 ? c.textContent : (c.textContent || '')).join('');
  }
  set textContent(v) { this.children = [{ nodeType: 3, textContent: String(v) }]; }
  setAttribute(k, v) { this.dataset['_' + k] = String(v); }
  getAttribute() { return null; }
  removeAttribute() {}
  addEventListener(k, f) { this.handlers[k] = f; }
  removeEventListener() {}
  append(...k) { this.children.push(...k); }
  appendChild(k) { this.children.push(k); return k; }
  insertBefore(k) { this.children.push(k); return k; }
  replaceChildren(...k) { this.children = k; }
  remove() {}
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  matches() { return false; }
  contains() { return false; }
  closest() { return null; }
  focus() { globalThis.document.activeElement = this; this.focused = true; }
  blur() {} select() {} scrollIntoView() {} showModal() {} close() {}
  setSelectionRange(a) { this.caret = a; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
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
  doc.createTextNode = t => ({ nodeType: 3, textContent: String(t) });
  doc.getElementById = () => new El();
  doc.activeElement = null;
  doc.hidden = false;
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
