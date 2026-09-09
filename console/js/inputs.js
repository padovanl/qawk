import { busy } from './api.js';
import { fail } from './chrome.js';
import { h, icon } from './dom.js';
import { bytes } from './util.js';

/* A tag colour is picked here, in the page. The native <input type=color> is
 * a grey box that opens the operating system's colour dialog -- a window from
 * another application, in another language, drawn in another theme -- so it is
 * not used at all: a palette of ten colours that stay legible as a small pill
 * on all thirteen themes, and, for anything else, a hue strip and a
 * saturation/brightness square of our own.
 */
const TAG_COLOURS = [
  '#e5484d', '#e97b1f', '#e2b203', '#46a758', '#12a594',
  '#3b9eff', '#6e56cf', '#d6409f', '#8b8f98', '#5b6673',
];
const clamp01 = v => Math.max(0, Math.min(1, v));
function hsvToHex(hh, ss, vv) {
  const f = n => {
    const k = (n + hh / 60) % 6;
    return Math.round(255 * (vv - vv * ss * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return '#' + [f(5), f(3), f(1)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) hh = mx === r ? 60 * (((g - b) / d) % 6)
           : mx === g ? 60 * ((b - r) / d + 2)
                      : 60 * ((r - g) / d + 4);
  return [(hh + 360) % 360, mx ? d / mx : 0, mx];
}

function colourPicker(value = '#12a594', opts = {}) {
  let cur = value, [hue, sat, val] = hexToHsv(value);
  const box = h('div.cpick');

  const preview = h('span.tag-preview');
  const hex = h('input', { type: 'text', maxlength: 6, spellcheck: 'false' });
  const swatches = TAG_COLOURS.map(c => h('button.swatch', {
    type: 'button', title: c, style: `--sw:${c}`,
    onclick: e => { e.preventDefault(); [hue, sat, val] = hexToHsv(c); set(c); },
  }, icon('check', 13)));

  // the custom panel, folded away until it is asked for
  const svDot = h('i.dot'), hueDot = h('i.dot');
  const sv = h('div.sv', h('i.sv-sat'), h('i.sv-val'), svDot);
  const hueBar = h('div.hue', hueDot);
  const panel = h('div.cpick-panel.hidden', sv, hueBar);
  const more = h('button.swatch.custom', {
    type: 'button', title: 'any other colour',
    onclick: e => {
      e.preventDefault();
      panel.classList.toggle('hidden');
      more.classList.toggle('on', !panel.classList.contains('hidden'));
      if (!panel.classList.contains('hidden')) place();
    },
  }, icon('edit', 12));

  function place() {
    sv.style.background = `hsl(${hue} 100% 50%)`;
    svDot.style.left = (sat * 100) + '%';
    svDot.style.top = ((1 - val) * 100) + '%';
    svDot.style.background = cur;
    hueDot.style.left = (hue / 360 * 100) + '%';
    hueDot.style.background = `hsl(${hue} 100% 50%)`;
  }
  function set(c, fromHex) {
    cur = c;
    box.value = c;
    if (!fromHex) hex.value = c.slice(1);
    preview.style.setProperty('--sw', c);
    swatches.forEach((s, i) => s.classList.toggle('on', TAG_COLOURS[i].toLowerCase() === c.toLowerCase()));
    if (!panel.classList.contains('hidden')) place();
    if (opts.onChange) opts.onChange(c);
  }
  // dragging: one handler for both strips, because they differ only in what
  // the position means
  const drag = (el, move) => {
    const run = e => {
      const r = el.getBoundingClientRect();
      move(clamp01((e.clientX - r.left) / (r.width || 1)),
           clamp01((e.clientY - r.top) / (r.height || 1)));
    };
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.setPointerCapture && el.setPointerCapture(e.pointerId); run(e);
      const mv = ev => run(ev);
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
  };
  drag(sv, (x, y) => { sat = x; val = 1 - y; set(hsvToHex(hue, sat, val)); });
  drag(hueBar, x => { hue = x * 360; set(hsvToHex(hue, sat, val)); });

  hex.oninput = () => {
    let v = hex.value.trim();
    if (v && v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) { [hue, sat, val] = hexToHsv(v); set(v, true); }
  };
  hex.onblur = () => { hex.value = cur.slice(1); };

  box.append(
    h('div.cpick-row', swatches, more),
    panel,
    h('div.cpick-row',
      h('span.fld.hexbox', h('span.hash', '#'), hex),
      preview));
  set(value);
  // the preview shows the tag as it will look, name and all
  const label = () => (opts.nameEl && opts.nameEl.value.trim()) || 'tag';
  preview.textContent = label();
  if (opts.nameEl) opts.nameEl.addEventListener('input', () => { preview.textContent = label(); });
  return box;
}

/* The browser's file button is the one control that cannot be themed at all --
 * it is drawn by the platform, in the platform's language. This is a drop area
 * that also opens the picker, and it says what it is holding. */
function fileField(opts = {}) {
  const inp = h('input.hidden-native', { type: 'file', multiple: !!opts.multiple });
  const list = h('div.fz-list');
  const zone = h('label.fz', icon('upload', 18),
    h('span.fz-t', opts.label || (opts.multiple ? 'Choose files, or drop them here'
                                                : 'Choose a file, or drop it here')),
    inp, list);
  const show = () => {
    const fs = [...(inp.files || [])];
    zone.classList.toggle('has', fs.length > 0);
    list.replaceChildren(...fs.map(f => h('span.fz-f',
      h('span.n', f.name), h('span.s', bytes(f.size)))));
  };
  inp.onchange = show;
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.remove('over');
  }));
  zone.addEventListener('drop', e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    inp.files = e.dataTransfer.files;         // a DataTransfer's list is assignable
    show();
  });
  zone.input = inp;
  return zone;
}

/* Dates are picked, never typed. hawkBit speaks epoch milliseconds, which is
 * the right thing on the wire and the wrong thing to ask a person for. */
// A number field with our own stepper: the native one cannot be themed, and a
// group count or a percentage is something you nudge rather than type.
function numInput(value, min, max, step = 1) {
  const inp = h('input', { type: 'number', value, min, max });
  const bump = d => {
    const v = Math.max(min, Math.min(max, (Number(inp.value) || 0) + d * step));
    inp.value = v; inp.dispatchEvent(new Event('change'));
  };
  const box = h('div.stepper',
    h('button', { type: 'button', onclick: e => { e.preventDefault(); bump(-1); } }, '\u2212'),
    inp,
    h('button', { type: 'button', onclick: e => { e.preventDefault(); bump(1); } }, '+'));
  box.input = inp;
  return box;
}

function dtInput(ms) {
  const v = ms ? new Date(ms - new Date().getTimezoneOffset() * 60000)
                  .toISOString().slice(0, 16) : '';
  return h('input', { type: 'datetime-local', value: v });
}

const dtSet = (el, d) => {
  el.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  el.dispatchEvent(new Event('change'));
};

// The maintenance window is nearly always tonight or tomorrow at three, so
// those are buttons rather than eight keystrokes in four spinners.
function dtQuick(el) {
  const at = (days, hh) => {
    const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, 0, 0, 0); return d;
  };
  const plus = mins => new Date(Date.now() + mins * 60000);
  const mk = (label, fn) => h('button.chip', {
    onclick: e => { e.preventDefault(); if (!el.disabled) dtSet(el, fn()); },
  }, label);
  return h('div.when-quick',
    mk('in 1h', () => plus(60)),
    mk('in 4h', () => plus(240)),
    mk('tonight 03:00', () => at(new Date().getHours() < 3 ? 0 : 1, 3)),
    mk('tomorrow 03:00', () => at(1, 3)),
    mk('next Monday 03:00', () => {
      const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
      d.setHours(3, 0, 0, 0); return d;
    }),
    h('button.chip', { onclick: e => { e.preventDefault(); el.value = ''; el.dispatchEvent(new Event('change')); } }, 'clear'));
}
const dtMs = el => {
  const v = (el.value || '').trim();
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/* An on/off control that looks like one. A checkbox says "there is a choice";
 * a switch says "this is a state, and it is currently this one" -- which is
 * what auto-confirmation, gateway tokens and the rest actually are.
 * It is a real <input type=checkbox> underneath, so it keeps the keyboard and
 * the accessibility for free; only the paint is ours. */
function toggle(on, onChange, opts = {}) {
  const input = h('input', { type: 'checkbox', checked: !!on, disabled: !!opts.disabled });
  const el = h('label.switch' + (opts.disabled ? '.off' : ''), { title: opts.title || '' },
    input, h('span.track', h('span.knob')),
    opts.label ? h('span.swl', opts.label) : null);
  el.input = input;
  input.addEventListener('change', async () => {
    if (!onChange) return;          // a plain field: read el.input.checked later
    el.classList.add('busy');
    try { await onChange(input.checked); }
    catch (e) { input.checked = !input.checked; fail(e); }
    finally { el.classList.remove('busy'); }
  });
  return el;
}

export {
  colourPicker, fileField, dtInput, dtMs, dtQuick, numInput, toggle,
};
