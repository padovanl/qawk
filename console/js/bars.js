import { h, live } from './dom.js';

/* ------- progress bars: one look everywhere ---------------------------
 *
 * A bar is segments of one total: ok (done), run (working on it), back
 * (going back), err (failed). What has not started is the empty track -- a
 * grey segment for it read as progress of some other kind. The segments sit
 * in one capsule, rounded at its end, that slides to its new length; a light
 * runs along it and its end pulses (style.css).
 *
 * The page redraws itself every few seconds, which used to throw the bar away
 * and draw it again at its new width: a jump, or a bar growing from nothing
 * each time. Given a key, a bar starts at the length it had last time and
 * slides from there, so a release going from 40% to 45% is seen moving. */
const last = new Map();
const raf = globalThis.requestAnimationFrame || (f => setTimeout(f, 16));

function bars(segs, total, opts = {}) {
  const shown = segs.filter(([n, cls]) => n > 0 && cls !== 'wait');
  const filled = shown.reduce((a, [n]) => a + n, 0);
  const t = total || filled || 1;
  const want = Math.max(0, Math.min(100, 100 * filled / t));
  const from = opts.key && last.has(opts.key) ? last.get(opts.key) : 0;
  const fill = h('div.fill', { style: `width:${from.toFixed(2)}%` },
    shown.map(([n, cls, title]) => h('i.' + cls, { style: `flex:${n} 1 0`, title: title || `${n} ${cls}` })));
  const full = want >= 99.95 && shown.length === 1 && shown[0][1] === 'ok';
  const working = shown.some(([, cls]) => cls === 'run');
  const bar = h('div.bars' + (full ? '.full' : '') + (working ? '.live' : ''),
    { style: opts.height ? `--bh:${opts.height}px` : '', title: `${Math.round(want)}%` }, fill);
  if (opts.key) last.set(opts.key, want);
  // two frames: the first paints the old length, the second slides to the new
  raf(() => raf(() => { live(fill).style.width = want.toFixed(2) + '%'; }));   // the bar on screen
  return bar;
}

export { bars };
