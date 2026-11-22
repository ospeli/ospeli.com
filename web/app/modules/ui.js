// Tiny DOM helper. Text is always set as text, never as HTML.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Replace an element's children, skipping null, undefined and false. The DOM's own
// replaceChildren() turns a null argument into the text "null" (issue #28).
export function setKids(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

// Redraw a page when the stored data changes: another tab or device, an agent's proposal, a reset,
// or this page's own action. `reload` is called a short moment after the last change.
// One case is left out. When the only changes were made by this page's own action, and the page
// has already started reading again since that action was saved, the page is redrawing itself and
// a second redraw a tenth of a second later would only close what the person has just opened
// (ospeli/ospeli#153; the same kind of fault as #95). `ctx.flow` is kept by the shell (app.js):
// how many of the person's own changes are being saved, and counters for "last change saved" and
// "last read started". With no `ctx.flow` every change redraws, as before.
// The rule a page must keep to use this: after every change it saves with ctx.run it calls its own
// full reload (the one passed in here), never only a part of it.
export function redrawOnChange(ctx, reload, { kinds = ['event', 'events', 'reset', 'proposals'], wait = 100 } = {}) {
  const { flow } = ctx;
  let t = null;
  let own = true; // every change since the last redraw came while this page's own action was being saved
  const fire = () => {
    t = null;
    if (flow && own) {
      if (flow.writing > 0) { t = setTimeout(fire, wait); return; } // still being saved: look again
      if (flow.readStartedAt > flow.writeDoneAt) return; // the page is already drawing what was saved
    }
    own = true;
    reload();
  };
  const off = ctx.core.onChange(({ kind, detail }) => {
    if (!kinds.includes(kind)) return;
    if (!flow || flow.writing === 0 || detail?.from === 'another tab') own = false;
    clearTimeout(t);
    t = setTimeout(fire, wait);
  });
  return () => { off(); clearTimeout(t); };
}

export const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// A module's own stylesheet (modules/<id>/style.css), added to the page once, the first time the
// module is opened. Its rules must all start with the module's own class (.mod-<id>), so one
// module can never restyle another or the shell. Resolves when the sheet has loaded (or failed:
// the page then shows unstyled, and still works).
export function moduleStyle(id) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('bad module id');
  const href = `modules/${id}/style.css`;
  const have = document.querySelector(`link[data-module-style="${id}"]`);
  if (have) return have.sheet ? Promise.resolve() : new Promise((done) => { have.addEventListener('load', done, { once: true }); have.addEventListener('error', done, { once: true }); });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.moduleStyle = id;
  return new Promise((done) => {
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    document.head.append(link);
  });
}

// Minutes as people say them: "35 min", "3 h 05 min", "2 d 4 h".
export function fmtWait(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(hrs / 24)} d ${hrs % 24} h`;
}

// A quick second or third tap on a dialog button must not fall through to what lies under it
// once the dialog has closed (issue #147: a double tap on "Patient has left" opened the next
// bed's dialog with the same button under the finger). Installed once for the whole app, so
// every module's dialog has it. A click outside any open dialog, within 600 ms and 40 px of a
// click inside a dialog (or of a click already swallowed), does nothing. Taps somewhere else,
// and keyboard presses (which have no spot), are never held back.
export const TAP_GUARD_MS = 600;
export const TAP_GUARD_PX = 40;
export function installDialogTapGuard(doc = document) {
  if (doc.__ospeliTapGuard) return;
  doc.__ospeliTapGuard = true;
  let last = null; // { x, y, t } of the last tap that was inside a dialog, or swallowed
  doc.addEventListener('click', (e) => {
    if (e.detail === 0) return; // keyboard or a script's click(): no spot to compare
    const now = Date.now();
    const inDialog = e.target instanceof Element && e.target.closest('dialog[open]');
    if (inDialog) { last = { x: e.clientX, y: e.clientY, t: now }; return; }
    if (last && now - last.t < TAP_GUARD_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < TAP_GUARD_PX) {
      e.preventDefault();
      e.stopImmediatePropagation();
      last = { x: last.x, y: last.y, t: now }; // a run of taps in one spot is held back until it pauses
      return;
    }
    last = null;
  }, true);
}
