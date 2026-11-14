// "Connect this device": the first screen when the app is opened from a site's own server.
// One field, one button. The code comes from the server's window (a person types: add device).
import { h } from './ui.js';

// Resolves with { device } once the server accepted the code.
export function renderConnect(el, link) {
  return new Promise((done) => {
    const input = h('input', {
      id: 'connect-code', 'data-test': 'connect-code', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters',
      spellcheck: 'false', maxlength: '12', placeholder: 'ABCD-2345', 'aria-describedby': 'connect-help connect-msg', required: true,
    });
    const msg = h('p', { id: 'connect-msg', class: 'connect-msg', role: 'alert', 'data-test': 'connect-msg' });
    const btn = h('button', { class: 'btn connect-btn', type: 'submit', 'data-test': 'connect-btn' }, 'Connect');
    const form = h('form', { class: 'card connect', 'data-test': 'connect', 'aria-labelledby': 'connect-h', novalidate: true },
      h('h1', { id: 'connect-h' }, 'Connect this device'),
      h('p', { id: 'connect-help' }, 'Ask the person who looks after Ospeli here for a code.'),
      h('div', { class: 'field' }, h('label', { for: 'connect-code' }, 'Code'), input),
      msg,
      btn,
      h('p', { class: 'meta' }, 'You type the code once. After that this device opens Ospeli straight away.'));
    // The dash is added while typing; lower case is fine.
    input.addEventListener('input', () => {
      const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      input.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
      msg.textContent = '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      if (input.value.replace(/[^A-Za-z0-9]/g, '').length < 8) { msg.textContent = 'The code has 8 letters and numbers.'; input.focus(); return; }
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      const out = await link.connect(input.value);
      if (out.device) { done({ device: out.device }); return; }
      btn.disabled = false;
      btn.textContent = 'Connect';
      msg.textContent = out.error;
      input.focus();
      input.select();
    });
    el.replaceChildren(form);
    input.focus();
  });
}
