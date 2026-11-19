// Facilities and utilities: the screens (skeleton; the builder writes this file).
import { h, moduleStyle } from '../ui.js';
export async function render(el) {
  await moduleStyle('facilities');
  el.append(h('div', { class: 'mod-facilities' }, h('p', { class: 'meta' }, 'Facilities and utilities is being built.')));
  return null;
}
