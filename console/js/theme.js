import { $ } from './dom.js';

/* ---------------------------------------------------------------- themes */
/* Every theme is a palette in style.css, nothing more: the rest of the sheet is
 * derived from those variables with color-mix, so adding one is adding twelve
 * colours and never a special case. 'auto' sets no attribute and lets the
 * prefers-color-scheme media query decide. */
const THEMES = [
  ['auto', 'auto (system)'], ['dark', 'dark'], ['light', 'light'],
  ['midnight', 'midnight'], ['ocean', 'ocean'], ['forest', 'forest'],
  ['nord', 'nord'], ['dracula', 'dracula'], ['gruvbox', 'gruvbox'],
  ['solarized-dark', 'solarized dark'], ['solarized-light', 'solarized light'],
  ['amber', 'amber'], ['mono', 'mono'], ['paper', 'paper'],
];
function theme() {
  const v = localStorage.getItem('hb-theme');
  return THEMES.some(([k]) => k === v) ? v : 'auto';
}
function applyTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  try { localStorage.setItem('hb-theme', v); } catch (_) {}
  const sel = $('#theme');
  if (sel) sel.value = v;
}
applyTheme(theme());

export {
  THEMES, applyTheme, theme,
};
