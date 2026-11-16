// Patient feedback: the screens. Four parts on one page address (#/feedback/<part>):
// quick  - log a complaint, concern or compliment in a few taps, and hand the device over for a
//          feedback card (five faces, a pick, an optional short note);
// queue  - open complaints and concerns by stage, owner role and reply due date, overdue first;
// record - one record's timeline and actions, with the buttons that move it on (#/feedback/record/<id>);
// themes - counts by theme and by service, compliments beside complaints, and the four KPIs.
// The role decides which part opens first. Every read and write is a command (ctx.run), the same
// one an agent would call. Typed text is always set as text.
import { h, setKids, fmtTime, moduleStyle } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';

const C = {
  log: 'ospeli_experience_complaint_log', queue: 'ospeli_experience_queue_list', get: 'ospeli_experience_record_get',
  update: 'ospeli_experience_record_update', action: 'ospeli_experience_action_set', themes: 'ospeli_experience_themes_get', guide: 'ospeli_experience_guide_set',
};
const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const whoCan = (cmd) => (commandByName(cmd)?.roles || []).map((r) => roleById(r)?.name || r).join(', ');
const FIRST = { receptionist: 'quick', 'patient-liaison': 'queue', 'ward-nurse': 'queue', 'quality-lead': 'themes', 'ops-manager': 'queue', coo: 'themes' };
const PARTS = [['quick', 'Quick feedback', C.log], ['queue', 'Complaints queue', C.queue], ['themes', 'Themes board', C.themes]];
const ref = (id) => id.toUpperCase();
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const NOT_A_LOCK = 'The card screen hides the staff screen, but it is not a lock and not a separate sign-in: anyone holding the device can go back. Stay nearby.';

// ---- the five faces: simple drawn shapes (not the logo), each with its word under it ----
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
};
const FACE_FILL = ['', '#E0583E', '#EE9B00', '#F6F1E7', '#94D2BD', '#0A9396'];
const MOUTH = ['', 'M15 35 Q24 25 33 35', 'M16 33 Q24 28.5 32 33', 'M16 32 H32', 'M16 29.5 Q24 36 32 29.5', 'M14 28 Q24 41 34 28 Z'];
function faceSvg(n) {
  const line = { fill: 'none', stroke: '#0B2F4E', 'stroke-width': 3.2, 'stroke-linecap': 'round' };
  return svg('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true', focusable: 'false' },
    svg('circle', { cx: 24, cy: 24, r: 22, fill: FACE_FILL[n], stroke: '#0B2F4E', 'stroke-width': n === 3 ? 2 : 0 }),
    n === 1 ? svg('path', { d: 'M13 15 L20 17.5 M35 15 L28 17.5', ...line, 'stroke-width': 2.6 }) : '',
    svg('circle', { cx: 17, cy: 21, r: 2.8, fill: '#0B2F4E' }), svg('circle', { cx: 31, cy: 21, r: 2.8, fill: '#0B2F4E' }),
    svg('path', n === 5 ? { d: MOUTH[n], fill: '#0B2F4E', stroke: '#0B2F4E', 'stroke-width': 2, 'stroke-linejoin': 'round' } : { d: MOUTH[n], ...line }));
}

export async function render(el, ctx) {
  await moduleStyle('feedback');
  el.classList.add('mod-feedback');
  // The shell moves the page's children into <main> and drops the page element itself, so the
  // module's class goes on a root of its own as well.
  const root = h('div', { class: 'mod-feedback', 'data-role': ctx.role });
  el.append(root);
  el = root;
  const head = (title, lead) => h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Patient feedback'), h('h1', {}, title), lead ? h('p', {}, lead) : null));
  if (!can(ctx.role, C.themes)) {
    el.append(head('Patient feedback'), h('div', { class: 'card notice', 'data-test': 'no-rights' },
      h('p', {}, `${roleById(ctx.role).name} does not use patient feedback. It is for: ${whoCan(C.themes)}.`)));
    return null;
  }
  let base;
  try { base = await ctx.run(C.themes, {}); } catch (err) {
    el.append(head('Patient feedback'), h('div', { class: 'card notice' }, h('p', {}, `Could not open patient feedback. ${err.message}`)));
    return null;
  }
  const opt = base.options;
  if (!opt.services.length) {
    el.append(head('Patient feedback'), h('div', { class: 'card notice' }, h('p', {}, 'No hospital is loaded on this device. ', h('a', { href: '#/data' }, 'Data and audit'), ' loads Example General Hospital.')));
    return null;
  }
  const names = {
    service: new Map(opt.services.map((s) => [s.id, s.name])), theme: new Map(opt.themes.map((t) => [t.id, t])),
    channel: new Map(opt.channels.map((c) => [c.id, c.name])), owner: new Map(opt.ownerRoles.map((r) => [r.id, r.name])),
  };
  const parts = PARTS.filter(([, , cmd]) => can(ctx.role, cmd));
  const wanted = ctx.rest[0] === 'record' && /^fb-\d{5}$/.test(ctx.rest[1] || '') ? 'record' : parts.find(([id]) => id === ctx.rest[0])?.[0];
  const part = wanted === 'record' && !can(ctx.role, C.get) ? parts[0][0] : wanted || (parts.some(([id]) => id === FIRST[ctx.role]) ? FIRST[ctx.role] : parts[0][0]);
  const tabs = h('nav', { class: 'fb-tabs', 'aria-label': 'Patient feedback' }, parts.map(([id, label]) => h('a', { href: `#/feedback/${id}`, 'aria-current': id === part || (part === 'record' && id === 'queue') ? 'page' : null, 'data-tab': id }, label)));
  const empty = base.hasHistory ? null : h('p', { class: 'card notice fb-empty', 'data-test': 'no-history' },
    'No feedback is recorded on this device yet. The example hospital on this device may have been made before this module; a fresh copy from Data and audit includes a month of example feedback. Everything here still works: new feedback is counted from now.');

  const props = proposalsCard(ctx, {
    match: (p) => p.command.startsWith('ospeli_experience_'),
    describe: (p) => {
      const i = p.input || {};
      if (p.command === C.log) return `Log a ${i.kind || 'record'}: ${names.service.get(i.serviceId) || i.serviceId}, ${names.theme.get(i.theme)?.name || i.theme || 'no theme'}`;
      if (p.command === C.update) return `${ref(String(i.recordId || ''))}: ${i.step}${i.ownerRole ? ` to ${names.owner.get(i.ownerRole) || i.ownerRole}` : ''}${i.outcome ? ` (${i.outcome})` : ''}`;
      if (p.command === C.action) return `${ref(String(i.recordId || ''))}: ${i.op === 'agree' ? 'agree an action' : `close ${i.actionId}`}`;
      return p.command;
    },
  });

  const box = h('div', { class: 'fb-body' });
  const titles = { quick: ['Quick feedback', 'Log a complaint, concern or compliment in a few taps, or hand the device over for a feedback card.'],
    queue: ['Complaints queue', 'Open complaints and concerns, overdue first.'], themes: ['Themes board', 'What feedback is about, by service and month, with compliments beside complaints.'],
    record: ['Response tracker', null] };
  el.append(...[head(...titles[part]), tabs, props.el, empty, box].filter(Boolean));
  const screen = { quick: quickScreen, queue: queueScreen, themes: themesScreen, record: recordScreen }[part];
  const view = await screen(box, ctx, { opt, names, base, recordId: ctx.rest[1] });
  await props.load();

  let t = null;
  const off = ctx.core.onChange(({ kind }) => {
    if (!['event', 'events', 'reset', 'proposals', 'meta'].includes(kind)) return;
    clearTimeout(t);
    t = setTimeout(() => { view.refresh?.(); props.load(); }, 120);
  });
  return () => { off(); clearTimeout(t); view.cleanup?.(); };
}

// A KPI as a tile, with how it is counted one tap away.
function kpiTile(k) {
  const val = k.value == null ? '–' : k.unit === '%' ? `${k.value}%` : `${k.value} ${k.unit}`;
  const of = k.unit === '%' ? `${k.numerator} of ${k.denominator}` : `median of ${plural(k.denominator, 'complaint')}`;
  return h('div', { class: 'stat fb-kpi', 'data-kpi': k.id },
    h('b', { class: 'fb-kpi-value' }, val), h('span', { class: 'fb-kpi-name' }, k.name), h('span', { class: 'fb-kpi-of' }, k.denominator ? of : 'None in this period'),
    h('details', { class: 'fb-def' }, h('summary', {}, 'How it is counted'),
      h('p', {}, k.definition), h('p', {}, h('b', {}, 'Leaves out: '), k.leavesOut), h('p', {}, h('b', {}, 'Source: '), k.source), h('p', {}, k.targetText)));
}
const kpiRow = (kpis, label) => h('div', { class: 'fb-kpis', 'data-test': 'kpis' }, kpis.map(kpiTile), label ? h('p', { class: 'meta fb-kpi-note' }, label) : null);

// Radio buttons drawn as large pills: one tap each, and they work with a keyboard and a screen reader.
function picks(name, items, { value, onpick, cls = '' } = {}) {
  const box = h('div', { class: `fb-picks ${cls}`, role: 'radiogroup' });
  for (const it of items) {
    const input = h('input', { type: 'radio', name, value: it.id, checked: it.id === value, 'data-test': `${name}-${it.id}` });
    input.addEventListener('change', () => onpick?.(it.id));
    box.append(h('label', { class: 'fb-pick' }, input, h('span', {}, h('b', {}, it.name), it.hint ? h('small', {}, it.hint) : null)));
  }
  return box;
}
const picked = (form, name) => form.querySelector(`input[name="${name}"]:checked`)?.value || null;
const serviceSelect = (id, opt, value) => {
  const sel = h('select', { id, 'data-test': id }, opt.services.map((s) => new Option(s.name, s.id)));
  if (value && opt.services.some((s) => s.id === value)) sel.value = value;
  return sel;
};
// The service a desk last used, remembered on this device only as a convenience.
const SERVICE_KEY = 'ospeli.feedback.service';
const lastService = () => { try { return localStorage.getItem(SERVICE_KEY); } catch { return null; } };
const keepService = (v) => { try { localStorage.setItem(SERVICE_KEY, v); } catch { /* private window: fine */ } };

// ---------------------------------------------------------------- quick feedback
async function quickScreen(box, ctx, { opt }) {
  const KIND_HINTS = { complaint: 'They want a formal reply', concern: 'A worry to sort out quickly', compliment: 'Something that went well' };
  const kinds = opt.kinds.filter((k) => k.id !== 'card').map((k) => ({ ...k, hint: KIND_HINTS[k.id] }));
  const ui = { busy: false };
  const form = h('form', { class: 'card fb-form', 'data-test': 'log-form', 'aria-labelledby': 'fb-log-h', novalidate: true });
  const svcSel = serviceSelect('fb-service', opt, lastService());
  svcSel.addEventListener('change', () => { keepService(svcSel.value); cardSvc.value = svcSel.value; numbers(); });
  const note = h('textarea', { id: 'fb-note', rows: 2, maxlength: opt.noteMax, 'data-test': 'fb-note', 'aria-describedby': 'fb-note-hint' });
  const count = h('span', { class: 'fb-count', 'aria-live': 'polite' }, `0 of ${opt.noteMax}`);
  note.addEventListener('input', () => { count.textContent = `${note.value.length} of ${opt.noteMax}`; });
  const clinical = h('input', { type: 'checkbox', id: 'fb-clinical', 'data-test': 'fb-clinical' });
  const resolved = h('input', { type: 'checkbox', id: 'fb-resolved', 'data-test': 'fb-resolved' });
  const when = h('input', { type: 'date', id: 'fb-when', 'data-test': 'fb-when' });
  const clinicalRow = h('label', { class: 'fb-check', for: 'fb-clinical' }, clinical, h('span', {}, 'It is about clinical care. It is passed to clinical review; write nothing about the care here.'));
  const resolvedRow = h('label', { class: 'fb-check', for: 'fb-resolved' }, resolved, h('span', {}, 'Sorted out on the spot (closes it now)'));
  const saveBtn = h('button', { class: 'btn fb-save', type: 'submit', 'data-cmd': C.log }, 'Save');
  const status = h('div', { class: 'fb-status', role: 'status', 'data-test': 'log-status' });
  const showKind = (k) => { clinicalRow.hidden = !(k === 'complaint' || k === 'concern'); resolvedRow.hidden = k !== 'concern'; if (clinicalRow.hidden) clinical.checked = false; if (resolvedRow.hidden) resolved.checked = false; };
  form.append(
    h('h2', { id: 'fb-log-h' }, 'Log feedback'),
    h('fieldset', { class: 'fb-q' }, h('legend', {}, 'What is it?'), picks('fb-kind', kinds, { onpick: showKind, cls: 'fb-kinds' })),
    h('div', { class: 'fb-field' }, h('label', { for: 'fb-service' }, 'Which service'), svcSel),
    h('fieldset', { class: 'fb-q' }, h('legend', {}, 'What was it about?'), picks('fb-theme', opt.themes.map((t) => ({ id: t.id, name: t.name.replace(/ \(.*\)$/, '') })))),
    h('fieldset', { class: 'fb-q' }, h('legend', {}, 'How did it reach you?'), picks('fb-channel', opt.staffChannels, { value: 'in-person', cls: 'fb-small-picks' })),
    h('div', { class: 'fb-field' }, h('label', { for: 'fb-note' }, 'Short note (optional)'), note,
      h('p', { id: 'fb-note-hint', class: 'fb-hint' }, 'About the service or what happened, never who. No names, phone numbers or email addresses. ', count)),
    clinicalRow, resolvedRow,
    h('details', { class: 'fb-when' }, h('summary', {}, 'Received on an earlier day?'), h('div', { class: 'fb-field' }, h('label', { for: 'fb-when' }, 'Date it reached the site'), when,
      h('p', { class: 'fb-hint' }, 'The due dates count from this date. Leave it empty for today.'))),
    h('div', { class: 'actions' }, saveBtn),
    status,
    h('p', { class: 'fb-hint' }, 'If they want a reply, take their contact details at the desk in the usual way. Ospeli does not keep names or contact details and sends nothing.'));
  showKind(null);

  async function send(extra = {}) {
    const kind = picked(form, 'fb-kind'); const theme = picked(form, 'fb-theme');
    if (!kind || !theme) { status.className = 'fb-status fb-bad'; setKids(status, h('p', {}, !kind ? 'Pick what it is: complaint, concern or compliment.' : 'Pick what it was about.')); return; }
    const input = { kind, channel: picked(form, 'fb-channel') || 'in-person', serviceId: svcSel.value, theme, ...extra };
    if (note.value.trim()) input.note = note.value.trim();
    if (clinical.checked) input.clinical = true;
    if (resolved.checked) input.resolvedNow = true;
    if (when.value) {
      const t = new Date(`${when.value}T12:00`);
      input.receivedAt = (t > new Date() ? new Date() : t).toISOString();
    }
    ui.busy = true; saveBtn.disabled = true;
    try {
      const out = await ctx.run(C.log, input);
      status.className = 'fb-status fb-ok';
      setKids(status, h('p', {}, h('b', {}, `Saved: ${ref(out.recordId)}. `),
        `${opt.kinds.find((k) => k.id === kind).name}, ${serviceNames(opt).get(input.serviceId)}${out.stage === 'closed' ? ', closed as sorted out on the spot.' : out.replyDueAt ? `. Reply due by ${day(out.replyDueAt)} (example setting).` : '.'}`));
      ctx.toast(`Saved ${ref(out.recordId)}`);
      form.querySelectorAll('input[name="fb-kind"], input[name="fb-theme"]').forEach((x) => { x.checked = false; });
      note.value = ''; count.textContent = `0 of ${opt.noteMax}`; clinical.checked = false; resolved.checked = false; when.value = ''; showKind(null);
      numbers();
    } catch (err) {
      status.className = 'fb-status fb-bad';
      if (err.detail?.confirm === 'notAName') {
        setKids(status, h('p', {}, `The note may hold a person's name ("${err.detail.looksLike}"). Feedback is about the service, never a person.`),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'not-a-name', onclick: () => send({ notAName: true }) }, 'It is not a name. Save'),
            h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { setKids(status); note.focus(); } }, 'Change the note')));
      } else setKids(status, h('p', { 'data-test': 'log-error' }, `Not saved. ${err.message}`));
    } finally { ui.busy = false; saveBtn.disabled = false; }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!ui.busy) send(); });

  // The hand-over card and this service's numbers.
  const cardSvc = serviceSelect('fb-card-service', opt, svcSel.value);
  cardSvc.addEventListener('change', () => { svcSel.value = cardSvc.value; keepService(cardSvc.value); numbers(); });
  const card = feedbackCard(ctx, opt, () => cardSvc.value);
  const handover = h('section', { class: 'card fb-handover', 'aria-labelledby': 'fb-ho-h', 'data-test': 'handover' },
    h('h2', { id: 'fb-ho-h' }, 'Feedback card for a patient or visitor'),
    h('p', { class: 'fb-hint' }, 'Five faces, one pick and an optional short note. No name is asked for. Under a minute.'),
    h('div', { class: 'fb-field' }, h('label', { for: 'fb-card-service' }, 'Card for which service'), cardSvc),
    h('button', { class: 'btn fb-big', type: 'button', 'data-test': 'hand-over', onclick: () => card.open() }, 'Hand over for a feedback card'),
    h('p', { class: 'fb-hint' }, NOT_A_LOCK));
  const nums = h('section', { class: 'card fb-numbers', 'aria-labelledby': 'fb-num-h', 'data-test': 'svc-numbers' });
  async function numbers() {
    let t;
    try { t = await ctx.run(C.themes, { serviceId: svcSel.value, format: 'short' }); } catch { return; }
    const x = t.totals;
    setKids(nums, h('h2', { id: 'fb-num-h' }, `${serviceNames(opt).get(svcSel.value)}: last 30 days`),
      h('div', { class: 'stats fb-stats' },
        h('div', { class: 'stat', 'data-n': 'cards' }, h('b', {}, x.cards), h('span', {}, 'Feedback cards')),
        h('div', { class: 'stat', 'data-n': 'good' }, h('b', {}, x.cards ? `${Math.round((100 * x.cardsGood) / x.cards)}%` : '–'), h('span', {}, `Good or very good (${x.cardsGood} of ${x.cards})`)),
        h('div', { class: 'stat', 'data-n': 'compliments' }, h('b', {}, x.compliments), h('span', {}, 'Compliments')),
        h('div', { class: 'stat', 'data-n': 'complaints' }, h('b', {}, x.complaints + x.concerns), h('span', {}, 'Complaints and concerns'))),
      h('p', { class: 'fb-hint' }, 'Counts of what was recorded, not a score of the service or of anyone in it.'));
  }
  setKids(box, h('div', { class: 'fb-quick' }, form, h('div', { class: 'fb-side' }, handover, nums)), card.el);
  await numbers();
  return { refresh: numbers, cleanup: () => card.close() };
}
const serviceNames = (opt) => new Map(opt.services.map((s) => [s.id, s.name]));

// The hand-over feedback card: a full-screen dialog on a staff device. Not a security boundary.
function feedbackCard(ctx, opt, serviceOf) {
  const dlg = h('dialog', { class: 'fb-card', 'aria-labelledby': 'fbc-h', 'data-test': 'card' });
  const s = { face: 0, theme: null, note: '', sent: null, leaving: false, ask: null, error: '', busy: false };
  let timer = null;
  // Escape would drop a patient back on the staff screen: the card leaves only through its own button.
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  const fresh = () => Object.assign(s, { face: 0, theme: null, note: '', sent: null, leaving: false, ask: null, error: '', busy: false });
  function draw() {
    clearTimeout(timer);
    const svc = serviceNames(opt).get(serviceOf());
    const leave = s.leaving
      ? h('div', { class: 'fbc-leave', role: 'group', 'aria-label': 'Hand back to staff' },
        h('p', {}, 'Hand the device back to staff?'),
        h('div', { class: 'fbc-row' },
          h('button', { class: 'btn', type: 'button', 'data-test': 'card-exit-yes', onclick: () => close() }, 'Yes, staff screen'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { s.leaving = false; draw(); } }, 'No, stay on the card')))
      : h('button', { class: 'linkish fbc-staff', type: 'button', 'data-test': 'card-exit', onclick: () => { s.leaving = true; draw(); } }, 'Staff: back to the staff screen');
    if (s.sent) {
      setKids(dlg, h('div', { class: 'fbc-in fbc-thanks', 'data-test': 'card-thanks' },
        svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true', class: 'fbc-tick' }, svg('circle', { cx: 32, cy: 32, r: 30, fill: '#0A9396' }),
          svg('path', { d: 'M19 33 L28 42 L46 23', fill: 'none', stroke: '#FFFFFF', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
        h('h2', { id: 'fbc-h', tabindex: '-1' }, 'Thank you'),
        h('p', {}, 'We have your card. Your reference is ', h('b', { 'data-test': 'card-ref' }, ref(s.sent)), '.'),
        h('p', {}, 'We read every card to see what to change. If you would like a reply, please ask at the desk.'),
        h('button', { class: 'btn fbc-send', type: 'button', 'data-test': 'card-again', onclick: () => { fresh(); draw(); dlg.querySelector('[data-face="1"]')?.focus(); } }, 'Leave another card'),
        leave));
      // The next person should not see the last one's thank-you: back to a fresh card after a while.
      timer = setTimeout(() => { if (dlg.open && s.sent) { fresh(); draw(); } }, 30e3);
      dlg.querySelector('#fbc-h')?.focus();
      return;
    }
    const faces = h('div', { class: `fbc-faces${s.face ? ' chosen' : ''}`, role: 'group', 'aria-labelledby': 'fbc-q1' },
      [1, 2, 3, 4, 5].map((n) => h('button', {
        type: 'button', class: 'fbc-face', 'data-face': n, 'aria-pressed': String(s.face === n), 'data-test': `face-${n}`,
        onclick: () => { s.face = n; s.error = ''; draw(); dlg.querySelector(`[data-face="${n}"]`)?.focus(); },
      }, faceSvg(n), h('span', {}, opt.faces[n - 1].name))));
    const themes = h('div', { class: 'fbc-themes', role: 'group', 'aria-labelledby': 'fbc-q2' }, opt.themes.map((t) => h('button', {
      type: 'button', class: 'fbc-theme', 'aria-pressed': String(s.theme === t.id), 'data-theme': t.id,
      onclick: () => { s.theme = s.theme === t.id ? null : t.id; draw(); dlg.querySelector(`[data-theme="${t.id}"]`)?.focus(); },
    }, t.card)));
    const ta = h('textarea', { id: 'fbc-note', rows: 3, maxlength: opt.noteMax, 'aria-describedby': 'fbc-note-hint', 'data-test': 'card-note' });
    ta.value = s.note;
    ta.addEventListener('input', () => { s.note = ta.value; });
    const sendBtn = h('button', { class: 'btn fbc-send', type: 'button', 'data-test': 'card-send', disabled: !s.face || s.busy, onclick: () => send() }, s.face ? 'Send' : 'Choose a face to send');
    setKids(dlg, h('div', { class: 'fbc-in' },
      h('p', { class: 'fbc-eyebrow' }, 'Your feedback'),
      h('h2', { id: 'fbc-h' }, `How was your visit to ${svc}?`),
      h('p', { class: 'fbc-sub' }, 'Three quick questions. We do not ask for your name.'),
      h('section', { class: 'fbc-q' }, h('h3', { id: 'fbc-q1' }, '1. How was it today?'), faces),
      h('section', { class: 'fbc-q' }, h('h3', { id: 'fbc-q2' }, '2. What was it mostly about? (optional)'), themes),
      h('section', { class: 'fbc-q' }, h('h3', {}, h('label', { for: 'fbc-note' }, '3. Anything to add? (optional)')), ta,
        h('p', { id: 'fbc-note-hint', class: 'fbc-small' }, 'Please do not write names, phone numbers or email addresses.')),
      s.ask ? h('div', { class: 'fbc-ask', role: 'alert', 'data-test': 'card-ask' },
        h('p', {}, `Is "${s.ask}" someone's name? We do not keep names.`),
        h('div', { class: 'fbc-row' },
          h('button', { class: 'btn', type: 'button', 'data-test': 'card-not-name', onclick: () => send({ notAName: true }) }, 'No, send it'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { s.ask = null; draw(); dlg.querySelector('#fbc-note')?.focus(); } }, 'Yes, I will change it'))) : null,
      s.error ? h('p', { class: 'fbc-error', role: 'alert', 'data-test': 'card-error' }, s.error) : null,
      h('p', { class: 'fbc-small fbc-urgent' }, 'This card is not for urgent help or questions about your care. If you are worried now, please speak to a member of staff.'),
      sendBtn,
      leave));
  }
  async function send(extra = {}) {
    if (!s.face || s.busy) return;
    s.busy = true; s.error = ''; s.ask = null;
    const input = { kind: 'card', channel: 'card', serviceId: serviceOf(), rating: s.face, ...(s.theme ? { theme: s.theme } : {}), ...extra };
    if (s.note.trim()) input.note = s.note.trim();
    try {
      const out = await ctx.run(C.log, input);
      fresh(); s.sent = out.recordId;
    } catch (err) {
      s.busy = false;
      if (err.detail?.confirm === 'notAName') s.ask = err.detail.looksLike;
      else s.error = err.code === 'invalid-input' && /note/.test(err.message)
        ? 'Please take out any names, phone numbers, email addresses or record numbers, then send again.'
        : 'Sorry, the card was not sent. Please hand the device back to staff.';
    }
    draw();
  }
  function open() { fresh(); draw(); if (!dlg.open) dlg.showModal(); dlg.querySelector('[data-face="1"]')?.focus(); }
  function close() { clearTimeout(timer); if (dlg.open) dlg.close(); fresh(); document.querySelector('[data-test="hand-over"]')?.focus(); }
  return { el: dlg, open, close };
}

// ---------------------------------------------------------------- the queue
const VIEWS = [['mine', 'Mine'], ['open', 'All open'], ['overdue', 'Overdue'], ['clinical', 'Clinical review'], ['closed', 'Closed'], ['compliments', 'Compliments and cards']];
function dueText(r) {
  if (r.clinical && r.stage !== 'closed') return 'Passed to clinical review: not timed here';
  if (r.kind === 'compliment' || r.kind === 'card') return r.sharedAt ? 'Shared with the service' : 'Recorded';
  if (r.stage === 'closed') return `Closed ${day(r.closedAt || r.receivedAt)}`;
  if (r.stage === 'replied') return `Replied ${day(r.repliedAt)}`;
  if (r.daysToReplyDue == null) return '';
  const d = Math.abs(Math.round(r.daysToReplyDue));
  if (r.overdue && r.stage === 'received' && r.daysToReplyDue >= 0) return `Not acknowledged in time · reply due in ${plural(d, 'day')}`;
  return r.daysToReplyDue < 0 ? `Reply ${d === 0 ? 'less than a day' : plural(d, 'day')} late` : `Reply due in ${d === 0 ? 'less than a day' : plural(d, 'day')}`;
}
function recordRow(r) {
  const cls = r.overdue ? 'fb-row is-over' : r.dueSoon ? 'fb-row is-soon' : r.clinical ? 'fb-row is-clinical' : 'fb-row';
  return h('li', {}, h('a', { class: cls, href: `#/feedback/record/${r.id}`, 'data-record': r.id, 'data-cmd': C.get },
    h('span', { class: 'fb-row-top' }, h('b', {}, `${ref(r.id)} · ${r.kindName}`), h('span', { class: `chip fb-st-${r.stage}` }, r.stageName)),
    h('span', { class: 'fb-row-what' }, `${r.serviceName}${r.themeName ? ` · ${r.themeName.replace(/ \(.*\)$/, '')}` : ''}`),
    h('span', { class: 'fb-row-owner' }, r.ownerName ? `Owner: ${r.ownerName}` : `Received ${day(r.receivedAt)}`),
    h('span', { class: 'fb-row-due' }, dueText(r))));
}

async function queueScreen(box, ctx, { opt }) {
  const role = ctx.role;
  const ownsSome = opt.ownerRoles.some((r) => r.id === role);
  const ui = { view: role === 'ward-nurse' || role === 'ops-manager' ? 'mine' : 'open' };
  const views = VIEWS.filter(([id]) => id !== 'mine' || ownsSome);
  const chips = h('div', { class: 'chips fb-views', role: 'group', 'aria-label': 'Show' });
  const counts = h('p', { class: 'fb-counts', 'data-test': 'queue-counts' });
  const list = h('div', { 'data-test': 'queue-list' });
  const guide = h('section', { class: 'card fb-guide', 'aria-labelledby': 'fb-guide-h', 'data-test': 'guide' });
  const kpis = h('section', { class: 'section', 'aria-labelledby': 'fb-kpi-h' });
  let data = null;

  async function load() {
    const input = ui.view === 'mine' ? { view: 'open', mine: true } : { view: ui.view };
    const [q, t] = await Promise.all([ctx.run(C.queue, { ...input, limit: 200 }), ctx.run(C.themes, { format: 'short' })]);
    data = { q, t };
    draw();
  }
  function draw() {
    const { q, t } = data;
    chips.replaceChildren(...views.map(([id, label]) => h('button', {
      type: 'button', class: 'chip-btn', 'aria-pressed': String(ui.view === id), 'data-view': id,
      onclick: async () => { ui.view = id; await load(); chips.querySelector(`[data-view="${id}"]`)?.focus(); },
    }, id === 'mine' ? `${label} (${q.counts.mine})` : label)));
    const c = q.counts;
    setKids(counts, h('b', { 'data-test': 'count-open' }, c.open), ' open · ', h('b', { 'data-test': 'count-overdue' }, c.overdue), ' overdue · ',
      h('b', {}, c.dueSoon), ' due soon · ', h('b', {}, c.clinicalReview), ' at clinical review');
    setKids(list, q.records.length
      ? h('ul', { class: 'fb-rows' }, q.records.map(recordRow))
      : h('p', { class: 'fb-none' }, ui.view === 'mine' ? `Nothing open is owned by ${roleById(role).name} now.` : 'Nothing here.'),
    q.truncated ? h('p', { class: 'meta' }, `Showing ${q.records.length} of ${q.total}.`) : null,
    h('p', { class: 'meta fb-settings' }, `Due dates: ${q.settings} Records passed to clinical review are not timed here and never shown as overdue.`));
    const mayGuide = can(role, C.guide);
    const sw = mayGuide ? h('button', {
      type: 'button', class: 'chip-btn guide-switch', 'data-test': 'guide-switch', 'data-cmd': C.guide, 'aria-pressed': String(q.guideOn),
      onclick: async () => {
        try { const o = await ctx.run(C.guide, { on: !q.guideOn }); ctx.toast(o.guideOn ? 'Guide on.' : 'Guide off. The queue, timers and records all work the same.'); await load(); } catch (err) { ctx.toast(`Not saved. ${err.message}`); }
      },
    }, `Guide: ${q.guideOn ? 'On' : 'Off'}`) : h('span', { class: 'meta' }, `Guide: ${q.guideOn ? 'On' : 'Off'}`);
    setKids(guide, h('div', { class: 'guide-head' }, h('h2', { id: 'fb-guide-h' }, 'Guide'), sw, h('span', { class: 'meta' }, 'People decide; Ospeli suggests.')),
      !q.guideOn ? h('p', { class: 'meta', 'data-test': 'guide-off' }, 'The guide is off. The queue, timers and records all work the same.')
        : [
          q.suggestions.length ? h('ul', { class: 'fb-sugg', 'data-test': 'suggestions' }, q.suggestions.map((s) => h('li', { class: `fb-sg${s.overdue ? ' is-over' : ''}`, 'data-suggestion': s.id },
            h('a', { href: `#/feedback/record/${s.recordId}` }, s.title), h('span', {}, ` ${s.serviceName} · owner ${s.ownerName}. No reply recorded yet.`))))
            : h('p', { class: 'meta' }, role === 'patient-liaison' ? `No reply is due within ${opt.settings.remindDaysBefore} days.` : `No reply owned by ${roleById(role).name} is due within ${opt.settings.remindDaysBefore} days. Reminders go to the owner role and the Patient liaison officer.`),
          h('p', { class: 'meta' }, `Rule: ${t.guide.rules[0].words} ${t.guide.rules[0].basis}`),
        ]);
    setKids(kpis, h('h2', { id: 'fb-kpi-h' }, 'Response measures, last 30 days'), kpiRow(t.kpis, 'Calculated from the same event log. Tap "How it is counted" under a number. Nothing here is a score of a person.'));
  }
  const ownerFirst = role === 'ward-nurse' || role === 'ops-manager';
  setKids(box, h('div', { class: 'fb-queue', 'data-role': role },
    ownerFirst ? null : kpis,
    h('section', { class: 'section', 'aria-labelledby': 'fb-q-h' }, h('h2', { id: 'fb-q-h' }, ownerFirst ? 'Complaints for your role' : 'Open complaints and concerns'), counts, chips, list),
    guide,
    ownerFirst ? kpis : null,
    h('p', { class: 'meta fb-notfor' }, 'Ospeli does not score or rank staff and does not judge clinical care. It holds no names or contact details and sends nothing.')));
  await load();
  return { refresh: load };
}

// ---------------------------------------------------------------- one record
async function recordScreen(box, ctx, { opt, recordId }) {
  const role = ctx.role;
  const ui = { busy: false };
  async function load() {
    let d;
    try { d = await ctx.run(C.get, { recordId }); } catch (err) {
      setKids(box, h('div', { class: 'card notice', 'data-test': 'record-missing' }, h('p', {}, err.code === 'not-found' ? `There is no record ${ref(recordId)} on this device.` : `Could not open ${ref(recordId)}. ${err.message}`),
        h('p', {}, h('a', { href: '#/feedback/queue' }, 'Back to the complaints queue'))));
      return;
    }
    draw(d);
  }
  async function act(cmd, input, done) {
    if (ui.busy) return;
    ui.busy = true;
    try { await ctx.run(cmd, input); ctx.toast(done); } catch (err) { ctx.toast(`Not saved. ${err.message}`); } finally { ui.busy = false; await load(); }
  }
  const sel = (id, items, value) => { const s = h('select', { id, 'data-test': id }, items.map((x) => new Option(x.name, x.id))); if (value) s.value = value; return s; };
  const row = (k, v) => (v == null || v === '' ? null : h('div', { class: 'def-row' }, h('dt', {}, k), h('dd', {}, v)));

  function draw(d) {
    const r = d.record;
    const timed = r.kind === 'complaint' || r.kind === 'concern';
    const step = (name, label, control, extra) => h('div', { class: 'fb-step' }, control ? h('div', { class: 'fb-field' }, control.label, control.el) : null,
      h('button', { class: 'btn', type: 'button', 'data-cmd': C.update, 'data-step': name, onclick: () => act(C.update, { recordId: r.id, step: name, expectedState: r.stage, ...extra() }, `${ref(r.id)}: ${label.toLowerCase()}`) }, label));
    const next = new Set(d.next);
    const controls = [];
    if (next.has('acknowledge')) { const s = sel('fb-ack-ch', opt.replyChannels, 'letter'); controls.push(step('acknowledge', 'Record acknowledgement', { label: h('label', { for: 'fb-ack-ch' }, 'Acknowledged by'), el: s }, () => ({ channel: s.value }))); }
    if (next.has('reply')) { const s = sel('fb-reply-ch', opt.replyChannels, 'letter'); controls.push(step('reply', 'Record reply sent', { label: h('label', { for: 'fb-reply-ch' }, 'Full reply sent by'), el: s }, () => ({ channel: s.value }))); }
    if (next.has('set-owner')) { const s = sel('fb-owner', opt.ownerRoles.filter((x) => x.id !== r.ownerRole)); controls.push(step('set-owner', 'Change owner', { label: h('label', { for: 'fb-owner' }, 'Owner role'), el: s }, () => ({ ownerRole: s.value }))); }
    if (next.has('close')) {
      const s = sel('fb-outcome', r.stage === 'replied' ? opt.outcomes : opt.outcomes.filter((o) => o.id === 'withdrawn'));
      controls.push(step('close', r.stage === 'replied' ? 'Close' : 'Close as withdrawn', { label: h('label', { for: 'fb-outcome' }, 'Outcome'), el: s }, () => ({ outcome: s.value })));
    }
    if (next.has('clinical-review')) controls.push(step('clinical-review', 'Pass to clinical review', null, () => ({})));
    if (next.has('share')) controls.push(step('share', 'Mark as shared with the service', null, () => ({})));

    const due = d.due;
    const dueRow = (label, at, late, doneAt) => h('li', { class: late ? 'is-late' : '' }, h('b', {}, `${label} by ${day(at)}`), ' · ',
      doneAt ? (late ? 'done late' : 'done on time') : late ? 'late' : 'not yet');
    const actions = d.actions.map((a) => h('li', { class: `fb-action${a.closedAt ? ' is-done' : a.late ? ' is-late' : ''}`, 'data-action': a.id },
      h('b', {}, a.whatName), h('span', {}, ` · ${a.ownerName} · due ${day(a.dueAt)} · ${a.closedAt ? `closed ${day(a.closedAt)}${a.late ? ' (late)' : ''}` : a.late ? 'late' : 'open'}`),
      a.note ? h('span', { class: 'fb-typed' }, a.note) : null,
      !a.closedAt && (d.mayAgreeActions || a.ownerRole === role) ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': C.action, 'data-close-action': a.id,
        onclick: () => act(C.action, { op: 'close', recordId: r.id, actionId: a.id }, `${a.id} closed`) }, 'Mark done') : null));
    let agree = null;
    if (d.mayAgreeActions) {
      const what = sel('fb-act-what', opt.actionKinds); const who = sel('fb-act-owner', opt.ownerRoles, r.ownerRole);
      const when = sel('fb-act-due', opt.dueInDays.map((n) => ({ id: String(n), name: `In ${n} days` })), '30');
      const nt = h('input', { id: 'fb-act-note', type: 'text', maxlength: opt.noteMax, 'data-test': 'fb-act-note' });
      agree = h('details', { class: 'fb-agree' }, h('summary', {}, 'Agree an action'),
        h('div', { class: 'fb-field' }, h('label', { for: 'fb-act-what' }, 'What will change'), what),
        h('div', { class: 'fb-field' }, h('label', { for: 'fb-act-owner' }, 'Owner role'), who),
        h('div', { class: 'fb-field' }, h('label', { for: 'fb-act-due' }, 'Due'), when),
        h('div', { class: 'fb-field' }, h('label', { for: 'fb-act-note' }, 'Short note (optional, never a name)'), nt),
        h('button', { class: 'btn', type: 'button', 'data-cmd': C.action, 'data-test': 'agree-action',
          onclick: () => act(C.action, { op: 'agree', recordId: r.id, what: what.value, ownerRole: who.value, dueInDays: Number(when.value), ...(nt.value.trim() ? { note: nt.value.trim() } : {}) }, 'Action agreed') }, 'Agree action'));
    }
    const copy = d.replyTemplate ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(d.replyTemplate.text); ctx.toast('Template copied. Edit it outside Ospeli.'); } catch { ctx.toast('Could not copy. Select the text instead.'); }
    } }, 'Copy template') : null;

    setKids(box, h('div', { class: 'fb-record', 'data-test': 'record', 'data-record': r.id, 'data-stage': r.stage },
      h('p', {}, h('a', { class: 'fb-back', href: '#/feedback/queue' }, '‹ Complaints queue')),
      h('section', { class: 'card' },
        h('h2', {}, `${ref(r.id)} · ${r.kindName}`, ' ', h('span', { class: `chip fb-st-${r.stage}`, 'data-test': 'stage' }, r.stageName)),
        r.clinical ? h('p', { class: 'fb-clinical-note', 'data-test': 'clinical-note' }, 'Passed to clinical review. Ospeli records only that it was passed; nothing about the care is kept here, and it is not timed in this module.') : null,
        h('dl', { class: 'fb-facts' },
          row('Service', r.serviceName), row('About', r.themeName), row('Came in by', r.channelName), row('Rating', r.ratingName),
          row('Received', fmtTime(r.receivedAt)), row('Owner', r.ownerName), row('Outcome', r.outcome ? opt.outcomes.find((o) => o.id === r.outcome)?.name : null)),
        r.note ? h('div', { class: 'fb-note' }, h('p', { class: 'meta' }, 'Note, as typed (checked for personal details before it was kept)'), h('p', { class: 'fb-typed', 'data-test': 'record-note' }, r.note)) : null),
      timed ? h('section', { class: 'card', 'aria-labelledby': 'fb-due-h' }, h('h3', { id: 'fb-due-h' }, 'Due dates'),
        due.timed ? h('ul', { class: 'fb-due' }, dueRow('Acknowledge', due.ackDueAt, due.ackLate, r.acknowledgedAt), dueRow('Reply', due.replyDueAt, due.replyLate, r.repliedAt)) : null,
        h('p', { class: 'meta' }, due.timed ? d.settings : due.note)) : null,
      h('section', { class: 'card', 'aria-labelledby': 'fb-tl-h' }, h('h3', { id: 'fb-tl-h' }, 'Timeline'),
        h('ol', { class: 'fb-timeline', 'data-test': 'timeline' }, d.timeline.map((x) => h('li', { 'data-step': x.step },
          h('b', {}, x.stepName), h('span', {}, ` · ${fmtTime(x.at)} · ${x.roleName}${x.detail ? ` · ${x.detail}` : ''}`)))),
        h('p', { class: 'meta' }, 'The log keeps the role that acted, never a person.')),
      h('section', { class: 'card', 'aria-labelledby': 'fb-next-h', 'data-test': 'next' }, h('h3', { id: 'fb-next-h' }, 'Next step'),
        controls.length ? controls : h('p', { class: 'meta', 'data-test': 'no-steps' }, r.stage === 'closed' ? 'This record is closed.'
          : `${roleById(role).name} can see this record but not move it on. Acknowledging and replying are for the owner role (${r.ownerName || 'not set'}) or the Patient liaison officer; changing the owner and closing are for the Patient liaison officer and the Quality lead.`),
        timed ? h('p', { class: 'meta' }, 'Ospeli records that the site acknowledged or replied, and how. It sends nothing.') : null),
      timed ? h('section', { class: 'card', 'aria-labelledby': 'fb-act-h', 'data-test': 'actions' }, h('h3', { id: 'fb-act-h' }, 'Agreed actions'),
        actions.length ? h('ul', { class: 'fb-actions' }, actions) : h('p', { class: 'meta' }, 'No action agreed yet.'), agree) : null,
      d.replyTemplate ? h('details', { class: 'card fb-template', 'data-test': 'reply-template' }, h('summary', {}, 'Template reply (guide)'),
        h('p', { class: 'meta' }, d.replyTemplate.label), h('pre', { class: 'fb-pre' }, d.replyTemplate.text), copy, h('p', { class: 'meta' }, d.replyTemplate.basis)) : null));
  }
  await load();
  return { refresh: load };
}

// ---------------------------------------------------------------- themes board
async function themesScreen(box, ctx, { opt, base }) {
  const ui = { month: '', service: '' };
  const monthSel = h('select', { id: 'fb-month', 'data-test': 'fb-month' }, new Option('Last 30 days', ''), base.months.map((m) => new Option(new Date(`${m}-15T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), m)));
  const svcSel = h('select', { id: 'fb-t-service', 'data-test': 'fb-t-service' }, new Option('All services', ''), opt.services.map((s) => new Option(s.name, s.id)));
  const out = h('div', { 'data-test': 'themes' });
  monthSel.addEventListener('change', () => { ui.month = monthSel.value; load(); });
  svcSel.addEventListener('change', () => { ui.service = svcSel.value; load(); });
  async function load() {
    const t = await ctx.run(C.themes, { ...(ui.month ? { month: ui.month } : {}), ...(ui.service ? { serviceId: ui.service } : {}) });
    const x = t.totals;
    const num = (n) => h('td', { class: 'fb-n' }, n || '·');
    const themeRows = t.byTheme.filter((r) => r.complaints + r.concerns + r.compliments + r.cards);
    const maxR = Math.max(1, ...t.ratings);
    setKids(out,
      h('div', { class: 'stats fb-stats', 'data-test': 'totals' },
        h('div', { class: 'stat' }, h('b', {}, x.complaints), h('span', {}, 'Complaints')),
        h('div', { class: 'stat' }, h('b', {}, x.concerns), h('span', {}, 'Concerns')),
        h('div', { class: 'stat' }, h('b', {}, x.compliments), h('span', {}, 'Compliments')),
        h('div', { class: 'stat', 'data-n': 'cards' }, h('b', {}, x.cards), h('span', {}, `Feedback cards, ${x.cardsGood} good or very good`))),
      h('section', { class: 'section', 'aria-labelledby': 'fb-faces-h' }, h('h2', { id: 'fb-faces-h' }, 'Feedback cards'),
        h('ul', { class: 'fb-faces-bars', 'data-test': 'ratings' }, opt.faces.map((f, i) => h('li', {}, faceSvg(f.rating), h('span', { class: 'fb-fname' }, f.name),
          h('span', { class: 'fb-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.round((100 * t.ratings[i]) / maxR)}%` })), h('b', {}, t.ratings[i]))))),
      h('section', { class: 'section', 'aria-labelledby': 'fb-th-h' }, h('h2', { id: 'fb-th-h' }, 'By theme'),
        themeRows.length || t.themeNotGiven.cards ? h('div', { class: 'table-wrap' }, h('table', { 'data-test': 'by-theme' },
          h('thead', {}, h('tr', {}, ['Theme', 'Complaints', 'Concerns', 'Compliments', 'Cards (1–2 faces)', 'Actions agreed', 'Actions closed'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', {}, themeRows.map((r) => h('tr', { 'data-theme': r.theme }, h('th', { scope: 'row' }, r.themeName.replace(/ \(.*\)$/, '')), num(r.complaints), num(r.concerns), num(r.compliments),
            h('td', { class: 'fb-n' }, r.cards ? `${r.cards} (${r.cardsPoor})` : '·'), num(r.actionsAgreed), num(r.actionsClosed))),
          t.themeNotGiven.cards ? h('tr', {}, h('th', { scope: 'row' }, 'Card, no theme picked'), num(0), num(0), num(0), h('td', { class: 'fb-n' }, `${t.themeNotGiven.cards} (${t.themeNotGiven.cardsPoor})`), num(0), num(0)) : null)))
          : h('p', { class: 'fb-none' }, 'No feedback in this period.')),
      t.byService?.length ? h('section', { class: 'section', 'aria-labelledby': 'fb-sv-h' }, h('h2', { id: 'fb-sv-h' }, 'By service'),
        h('div', { class: 'table-wrap' }, h('table', { 'data-test': 'by-service' },
          h('thead', {}, h('tr', {}, ['Service', 'Complaints', 'Concerns', 'Compliments', 'Cards', 'Good or very good'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', {}, t.byService.map((r) => h('tr', { 'data-service': r.serviceId }, h('th', { scope: 'row' }, r.serviceName), num(r.complaints), num(r.concerns), num(r.compliments), num(r.cards),
            h('td', { class: 'fb-n' }, r.cards ? `${r.cardsGood} of ${r.cards}` : '·'))))))) : null,
      h('p', { class: 'meta fb-method', 'data-test': 'method' }, t.method),
      h('section', { class: 'section', 'aria-labelledby': 'fb-tk-h' }, h('h2', { id: 'fb-tk-h' }, `Response measures, ${t.period.label.toLowerCase()}`),
        kpiRow(t.kpis, 'Each number is recalculated from the event log. Due dates are example settings, set locally, not a standard.')),
      h('p', { class: 'meta fb-notfor' }, `Themes describe services and processes, never a person. ${t.guide.leftOut}`));
  }
  setKids(box, h('div', { class: 'fb-themes' },
    h('div', { class: 'fb-filters' }, h('div', { class: 'fb-field' }, h('label', { for: 'fb-month' }, 'Period'), monthSel), h('div', { class: 'fb-field' }, h('label', { for: 'fb-t-service' }, 'Service'), svcSel)),
    out));
  await load();
  return { refresh: load };
}
