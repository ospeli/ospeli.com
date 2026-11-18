// Stores and supplies: the screens (skeleton; the builder writes this file).
import { h, moduleStyle } from '../ui.js';
export async function render(el) {
  await moduleStyle('stores');
  el.append(h('div', { class: 'mod-stores' }, h('p', { class: 'meta' }, 'Stores and supplies is being built.')));
  return null;
}
