// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { h } from './dom.js';

/* ------- badges for names that carry a colour --------------------------
 *
 * A channel (fleet) in its own colour, and a device type in a colour worked
 * out from its name: one look on every page -- Targets, a device's drawer,
 * Fleets, Centres, Systems, In progress, the dashboard -- so prod reads as
 * prod at a glance, wherever it is written. */
function fleetBadge(name, colour, title = 'channel') {
  return h('span.pill.fb', { style: `--c:${colour || '#8b8f98'}`, title }, name);
}

function typeBadge(v) {
  let x = 0;
  for (const ch of v) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return h('span.pill.dt', { style: `--h:${x % 360}`, title: 'device type' }, v);
}

export { fleetBadge, typeBadge };
