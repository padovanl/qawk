import { h } from './dom.js';

/* ------- progress bars: one look everywhere ---------------------------
 *
 * A bar is segments of one total: ok (done), run (working on it), back
 * (going back), err (failed), wait (not started). The page redraws itself
 * every few seconds, which used to throw the bar away and draw it again at
 * its new width: a jump, or, animated, a bar growing from nothing each time.
 * Given a key, a bar starts at the widths it had last time and slides to the
 * new ones, so a release going from 40% to 45% is seen moving. The last
 * filled segment carries the glowing head; a bar all done glows (style.css). */
const last = new Map();
const raf = globalThis.requestAnimationFrame || (f => setTimeout(f, 16));

function bars(segs, total, opts = {}) {
  const t = total || segs.reduce((a, [n]) => a + (n || 0), 0) || 1;
  const want = segs.map(([n]) => Math.max(0, Math.min(100, 100 * (n || 0) / t)));
  const from = (opts.key && last.get(opts.key)) || want.map(() => 0);
  let head = -1;
  segs.forEach(([n, cls], i) => { if (n && cls !== 'wait') head = i; });
  const els = segs.map(([n, cls, title], i) => h('i.' + cls + (i === head ? '.head' : ''), {
    style: `width:${(from[i] ?? 0).toFixed(2)}%`, title: title || (n ? `${n} ${cls}` : ''),
  }));
  const full = segs[0] && segs[0][1] === 'ok' && want[0] >= 99.95;
  const bar = h('div.bars' + (full ? '.full' : ''), { style: opts.height ? `--bh:${opts.height}px` : '' }, els);
  if (opts.key) last.set(opts.key, want);
  // two frames: the first paints the old widths, the second slides to the new
  raf(() => raf(() => els.forEach((e, i) => { e.style.width = want[i].toFixed(2) + '%'; })));
  return bar;
}

export { bars };
