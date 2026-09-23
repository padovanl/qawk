// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

import { get, put } from '../api.js';
import { fail, toast } from '../chrome.js';
import { $, h, icon } from '../dom.js';
import { IDLE_CHOICES, idleMin, setIdleMin } from '../idle.js';
import { toggle } from '../inputs.js';
import { NOTICES, noticeOn, setNotice } from '../prefs.js';
import { VIEWS, render } from '../router.js';
import { THEMES, applyTheme, theme } from '../theme.js';
import { when } from '../util.js';

/* ------- config ------------------------------------------------------ */
VIEWS.cfg = {
  title: 'Configuration',
  async render(root) {
    // Only the keys this server actually exposes: asking for one it does not
    // know costs a 400 on every load, and the row would be dropped anyway.
    const keys = ['pollingTime', 'pollingOverdueTime',
      'authentication.gatewaytoken.key', 'authentication.gatewaytoken.enabled',
      'authentication.targettoken.enabled', 'authentication.header.enabled',
      'rollout.approval.enabled', 'user.confirmation.flow.enabled'];
    const vals = {};
    await Promise.all(keys.map(async k => {
      try { vals[k] = await get('/system/configs/' + k); } catch (_) { vals[k] = null; }
    }));
    const hint = {
      pollingTime: 'HH:MM:SS — how often devices ask for work',
      pollingOverdueTime: 'HH:MM:SS — after this a device counts as overdue',
      'rollout.approval.enabled': 'a rollout must be approved before it starts',
      'user.confirmation.flow.enabled': 'updates wait for a human on the device',
    };
    const rows = keys.map(k => {
      const v = vals[k];
      if (!v) return null;
      const label = h('div', { style: 'flex:0 0 320px' }, h('div.mono', k),
        hint[k] ? h('div.faint', { style: 'font-size:11px' }, hint[k]) : null);
      // A boolean is a switch that saves itself; anything else keeps its field
      // and its button, because half-typed text must not be sent.
      if (typeof v.value === 'boolean') {
        return h('div.flex', { style: 'gap:10px' }, label,
          toggle(v.value, async on => {
            await put('/system/configs/' + k, { value: on });
            toast('Saved', `${k} ${on ? 'on' : 'off'}`, 'ok');
          }));
      }
      const inp = h('input', { type: 'text', value: v.value ?? '' });
      return h('div.flex', { style: 'gap:10px' }, label, inp,
        h('button.btn.sm', { onclick: async () => {
            try { await put('/system/configs/' + k, { value: inp.value }); toast('Saved', k, 'ok'); }
            catch (e) { fail(e); } } }, icon('save', 13), 'save'));
    }).filter(Boolean);

    const swatches = h('div.themes', THEMES.map(([v, l]) => {
      const chip = h('button.theme' + (v === theme() ? '.on' : ''),
        { 'data-t': v === 'auto' ? '' : v, title: l, onclick: () => { applyTheme(v); render(); } },
        h('span.sw', h('i.a'), h('i.b'), h('i.c')), h('span.tn', l));
      return chip;
    }));

    const idle = h('select', IDLE_CHOICES.map(([v, l]) =>
      h('option', { value: v, selected: v === idleMin() }, l)));
    idle.onchange = e => {
      setIdleMin(Number(e.target.value));
      toast('Saved', 'sign out after ' + e.target.selectedOptions[0].text, 'ok');
    };

    root.replaceChildren(h('div.stack',
      h('div.panel', h('h3', 'Theme'), h('div.body', swatches)),
      matchMedia('(prefers-reduced-motion: reduce)').matches
        ? h('div.panel', h('h3', 'Reduced motion'), h('div.body.faint',
            'This browser is asking for less animation — your system has that setting on, ' +
            'so the decorative loops here are still. Spinners and progress bars keep moving: ' +
            'they are how you tell "working" from "stuck". Layout transitions still run. ' +
            'On Windows it is Settings → Accessibility → Visual effects → Animation effects.'))
        : null,
      h('div.panel', h('h3', 'Notifications'), h('div.body.stack',
        h('p.faint', { style: 'margin:0;font-size:12px' },
          'Everything this server does is announced, whoever did it — a script '
          + 'loading the catalogue, a rollout moving, someone else deploying. '
          + 'Turn off what you do not want to hear about; the choice is kept in '
          + 'this browser.'),
        ...NOTICES.map(([id, label, what]) => h('div.notice-row',
          toggle(noticeOn(id), on => setNotice(id, on), { label }),
          h('span.faint', what))))),
      h('div.panel', h('h3', 'Sign out when idle'), h('div.body.flex',
        h('div', { style: 'flex:0 0 320px' }, h('div.mono', 'idle timeout'),
          h('div.faint', { style: 'font-size:11px' },
            'the tab forgets the credentials after this long with no mouse or ' +
            'keyboard. The pages keeping themselves up to date do not count as activity.')),
        idle)),
      h('div.panel', h('h3', 'Tenant configuration'), h('div.body.stack', rows)),
      h('div.panel', h('h3', 'Careful'), h('div.body.faint',
        'This hawkBit keeps its database in memory: restarting the container wipes targets, ' +
        'modules, sets and these values. Deleting a module or a set does not free its name — the ' +
        'row stays, marked deleted, and name+version stay reserved for good.'))));
  },
};
