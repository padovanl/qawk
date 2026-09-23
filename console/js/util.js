// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { $, h } from './dom.js';

const pad = n => String(n).padStart(2, '0');
function when(ms) {
  if (!ms) return '—';
  const d = new Date(ms), now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? hm
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}
function ago(ms) {
  if (!ms) return '—';
  let s = Math.round((Date.now() - ms) / 1000);
  const fut = s < 0; s = Math.abs(s);
  const t = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m`
          : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return fut ? `in ${t}` : `${t} ago`;
}
// Counts in the sidebar: exact while it is worth reading, compact once it is
// not. A fleet of 1,482 is '1.5k' -- the digit that matters is the first one.
function compact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function bytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB']; let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + u[i];
}

function download(name, text) {
  // The page is served locally, so a blob link just works: no sandbox, no
  // server round trip, and the log lands where the browser puts downloads.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export {
  ago, bytes, compact, download, when,
};
