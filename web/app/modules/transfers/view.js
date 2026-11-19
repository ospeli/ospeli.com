// Transfers and vehicles: the screens (skeleton; the builder writes this file).
import { h, moduleStyle } from '../ui.js';
export async function render(el) {
  await moduleStyle('transfers');
  el.append(h('div', { class: 'mod-transfers' }, h('p', { class: 'meta' }, 'Transfers and vehicles is being built.')));
  return null;
}
