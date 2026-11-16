// Patient feedback: the screens. Builder: fill this in.
import { h, moduleStyle } from '../ui.js';

export async function render(el) {
  await moduleStyle('feedback');
  el.classList.add('mod-feedback');
  el.append(h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Being built'), h('h1', {}, 'Patient feedback'))));
  return null;
}
