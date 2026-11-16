// Cleaning and portering: the screens. Builder: fill this in.
import { h, moduleStyle } from '../ui.js';

export async function render(el) {
  await moduleStyle('support');
  el.classList.add('mod-support');
  el.append(h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Being built'), h('h1', {}, 'Cleaning and portering'))));
  return null;
}
