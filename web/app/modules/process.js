// Process maps (backlog PM1): map a process step by step and role by role, see where the time
// goes, and try a change in a Proposed version beside Today. Every control runs a named command
// (core/commands.js: maps.list, map.get, map.suggest, map.create, map.step.*, map.try-suggestion,
// map.hide-suggestion, map.reset-proposed, map.guide.set), the same ones an agent would.
// Deep link: #/process/<mapId>. The guide is rule-based, says why, and has an off switch.
import { h } from './ui.js';
import { fmtMinutes } from '../core/processmap.js';
import { proposalsCard } from './proposals.js';

const ROLE_COLOURS = ['#0A9396', '#EE9B00', '#E0583E', '#0B2F4E', '#94D2BD', '#7A5C9E', '#3E7CB1', '#A0522D', '#5B8C5A', '#C2185B'];
const SOURCE_TEXT = {
  discharge: 'From the decision to go home to the bed being ready again.',
  fault: 'From a nurse finding broken equipment to it being back in service.',
  ed: 'From arrival at the emergency department to a ward bed.',
};
const phone = () => window.matchMedia('(max-width: 640px)').matches;

export async function render(el, ctx) {
  const { core } = ctx;
  const ui = { mapId: ctx.rest[0] || null, version: 'today', view: phone() ? 'list' : 'map', editing: null, busy: false };
  const body = h('div', { 'data-test': 'process-body' });
  const props = proposalsCard(ctx, {
    match: (p) => p.command.startsWith('map.'),
    describe: (p) => {
      const what = {
        'map.create': `Start a map from ${p.input.from}`, 'map.step.add': `Add step "${p.input.name}"`, 'map.step.update': `Change step ${p.input.stepId}`,
        'map.step.move': `Move step ${p.input.stepId} ${p.input.direction}`, 'map.step.remove': `Remove step ${p.input.stepId}`,
        'map.try-suggestion': `Try in Proposed: ${p.input.suggestionId}`, 'map.hide-suggestion': `Hide suggestion ${p.input.suggestionId}`,
        'map.reset-proposed': 'Reset Proposed',
      }[p.command] || p.command;
      return `${p.input.mapId ? `${p.input.mapId}: ` : ''}${what}`;
    },
  });
  const guideBtn = h('button', { type: 'button', class: 'chip-btn guide-switch', 'data-test': 'guide-switch', 'data-cmd': 'map.guide.set', 'aria-pressed': 'true' }, 'Guide: On');
  el.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Process maps'),
        h('h1', {}, 'See where time goes, and try a change safely'),
        h('p', {}, 'Map how work flows, step by step and role by role. See where the time goes, then try a change in a Proposed version before anything changes for real.')),
      h('div', { class: 'guide-head' }, guideBtn, h('span', { class: 'meta' }, 'People decide; Ospeli suggests.'))),
    props.el, body);

  let list = { maps: [], examples: [], guideOn: true };
  const run = async (name, input) => {
    if (ui.busy) return null;
    ui.busy = true;
    try { return await ctx.run(name, input); } catch (err) { ctx.toast(`Not saved. ${err.message}`); return null; } finally { ui.busy = false; }
  };

  guideBtn.addEventListener('click', async () => {
    const out = await run('map.guide.set', { on: !list.guideOn });
    if (out) { ctx.toast(out.guideOn ? 'Guide on.' : 'Guide off. Maps, times and editing all still work.'); await draw(); }
  });

  async function create(from) {
    const out = await run('map.create', { from });
    if (out) { location.hash = `#/process/${out.mapId}`; }
  }

  function chooser(withHeading) {
    return h('section', { class: 'card map-chooser', 'aria-labelledby': 'chooser-h', 'data-test': 'map-chooser' },
      h('h2', { id: 'chooser-h' }, withHeading),
      h('p', { class: 'meta' }, 'Open an example to see how it works, or start a blank map for your own process. Lanes use your own words, from a small clinic to a large hospital.'),
      h('div', { class: 'chooser-grid' },
        list.examples.map((e) => h('button', { type: 'button', class: 'choice', 'data-cmd': 'map.create', 'data-from': e.from, onclick: () => create(e.from) },
          h('b', {}, e.title), h('span', {}, SOURCE_TEXT[e.from] || 'An example process.'), h('span', { class: 'tag' }, 'Example'))),
        h('button', { type: 'button', class: 'choice blank', 'data-cmd': 'map.create', 'data-from': 'blank', onclick: () => create('blank') },
          h('b', {}, 'Blank map'), h('span', {}, 'Describe your own process, step by step.'))));
  }

  async function draw() {
    list = await ctx.run('maps.list', {});
    guideBtn.setAttribute('aria-pressed', String(list.guideOn));
    guideBtn.textContent = `Guide: ${list.guideOn ? 'On' : 'Off'}`;
    if (ui.mapId && !list.maps.some((m) => m.id === ui.mapId)) ui.mapId = null;
    if (!ui.mapId) {
      body.replaceChildren(
        list.maps.length ? h('section', { class: 'section', 'aria-labelledby': 'maps-h' },
          h('h2', { id: 'maps-h' }, 'Your maps'),
          h('ul', { class: 'map-list' }, list.maps.map((m) => h('li', {},
            h('a', { href: `#/process/${m.id}`, 'data-test': 'map-link' }, h('b', {}, m.title),
              h('span', { class: 'meta' }, `${m.steps} steps · ${fmtMinutes(m.elapsedToday)} start to finish${m.elapsedProposed !== m.elapsedToday ? ` · Proposed ${fmtMinutes(m.elapsedProposed)}` : ''}`)))))) : null,
        chooser(list.maps.length ? 'Start another map' : 'No maps yet'));
      return;
    }
    await drawMap();
  }

  async function drawMap() {
    const m = await ctx.run('map.get', { mapId: ui.mapId });
    const sugg = await ctx.run('map.suggest', { mapId: ui.mapId, version: ui.version });
    const v = m[ui.version]; const t = m.today.stats;
    const steps = v.steps; const a = v.stats;
    const roles = [...new Set([...m.today.steps, ...m.proposed.steps].map((s) => s.role))];
    const colour = (r) => ROLE_COLOURS[Math.max(0, roles.indexOf(r)) % ROLE_COLOURS.length];
    const isP = ui.version === 'proposed';

    const seg = (id, label, on, onclick, extra = {}) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(on), 'data-test': id, onclick, ...extra }, label);
    const head = h('div', { class: 'map-head' },
      h('div', {},
        h('a', { href: '#/process', class: 'back' }, '← All maps'),
        h('h2', { id: 'map-h', 'data-test': 'map-title' }, `${m.title} · ${isP ? 'Proposed' : 'Today'}`),
        m.start ? h('p', { class: 'meta' }, `Starts when: ${m.start}`) : null),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Version' },
        seg('v-today', 'Today', !isP, () => { ui.version = 'today'; ui.editing = null; drawMap(); }),
        seg('v-proposed', m.changed ? 'Proposed •' : 'Proposed', isP, () => { ui.version = 'proposed'; ui.editing = null; drawMap(); })));

    const stat = (val, label, was, better) => h('div', { class: 'pm-stat' }, h('b', {}, val), h('span', {}, label),
      isP && was != null && was !== val ? h('span', { class: `was${better ? ' better' : ''}` }, `today: ${was}`) : null);
    const stats = h('div', { class: 'pm-stats', 'data-test': 'pm-stats' },
      stat(fmtMinutes(a.elapsed), 'start to finish', fmtMinutes(t.elapsed), a.elapsed < t.elapsed),
      stat(fmtMinutes(a.work), 'hands-on work', fmtMinutes(t.work), false),
      stat(a.workShare == null ? '–' : `${a.workShare}%`, 'of the time is work', t.workShare == null ? null : `${t.workShare}%`, a.elapsed < t.elapsed),
      stat(String(a.handoffs), 'handoffs between roles', String(t.handoffs), a.handoffs < t.handoffs));

    // Time bars: one for Today; once Proposed differs, both stacked, on the same scale.
    const bar = (label, s, scale, testId) => {
      const total = s.work + s.wait || 1; const width = Math.max(8, (100 * total) / scale);
      const b = h('div', { class: 'flowbar', role: 'img', style: `width:${width}%`, 'data-test': testId,
        'aria-label': `${label}: of ${fmtMinutes(s.work + s.wait)} of step time, ${fmtMinutes(s.wait)} is waiting and ${fmtMinutes(s.work)} is hands-on work.` });
      if (s.wait) b.append(h('i', { class: 'w', style: `width:${(100 * s.wait) / total}%` }));
      if (s.work) b.append(h('i', { class: 'k', style: `width:${(100 * s.work) / total}%` }));
      return h('div', { class: 'bar-row' }, h('span', { class: 'bar-label' }, `${label} ${fmtMinutes(s.elapsed)}`), b);
    };
    const scale = Math.max(m.today.stats.work + m.today.stats.wait, m.proposed.stats.work + m.proposed.stats.wait) || 1;
    const bars = h('section', { class: 'card bars', 'aria-labelledby': 'bars-h' },
      h('h3', { id: 'bars-h' }, 'Where the time goes'),
      bar('Today', m.today.stats, scale, 'bar-today'),
      m.changed ? bar('Proposed', m.proposed.stats, scale, 'bar-proposed') : null,
      h('p', { class: 'legend meta' }, h('span', { class: 'sw w' }), 'Waiting ', h('span', { class: 'sw k' }), 'Hands-on work'),
      m.changed ? h('p', { class: 'meta', 'data-test': 'whatif-note' }, 'A what-if from your map, not a prediction. Test it and measure.',
        ' ', h('button', { type: 'button', class: 'linkish', 'data-cmd': 'map.reset-proposed', onclick: async () => { if (await run('map.reset-proposed', { mapId: m.id })) { ctx.toast('Proposed is a copy of Today again.'); drawMap(); } } }, 'Reset Proposed')) : null);

    // The guide.
    const guide = h('section', { class: 'card guide', 'aria-labelledby': 'guide-h', 'data-test': 'guide' },
      h('h3', { id: 'guide-h' }, 'Guide'),
      !sugg.guideOn ? h('p', { class: 'meta' }, 'The guide is off. The map, times and editing all work without it.')
        : [
          h('p', { class: 'meta' }, `The guide uses simple rules you can check, on this device. Suggestions only change the Proposed version.${sugg.hidden ? ` ${sugg.hidden} hidden.` : ''}`),
          suggList(sugg.suggestions.map((sg) => h('li', { class: `sg ${sg.kind}`, 'data-suggestion': sg.id },
            h('b', {}, sg.title), h('p', {}, sg.text), h('p', { class: 'why' }, `Why: ${sg.why}`),
            h('div', { class: 'sg-actions' },
              sg.tryable ? h('button', { type: 'button', class: 'btn btn-small', 'data-cmd': 'map.try-suggestion', disabled: sg.tried && isP ? true : null,
                onclick: async () => {
                  const out = await run('map.try-suggestion', { mapId: m.id, suggestionId: sg.id, expectedRevision: m.revision });
                  if (out) { ui.version = 'proposed'; ctx.toast('Tried in Proposed. Today has not changed.'); drawMap(); }
                } }, sg.tried && isP ? 'Tried in Proposed' : sg.tryLabel) : null,
              h('button', { type: 'button', class: 'btn btn-ghost btn-small', 'data-cmd': 'map.hide-suggestion',
                onclick: async () => { if (await run('map.hide-suggestion', { mapId: m.id, suggestionId: sg.id })) { ctx.toast('Hidden for this map.'); drawMap(); } } }, 'Hide'))))),
        ]);

    // Steps: swimlane map or list.
    function suggList(items) {
      // Phones: the answer first. The top suggestion shows; the rest fold under one row.
      if (!phone() || items.length <= 1) return h('ol', { class: 'sugg' }, items);
      return [h('ol', { class: 'sugg' }, items[0]),
        h('details', { class: 'more-sugg', 'data-test': 'more-sugg' }, h('summary', {}, `${items.length - 1} more suggestion${items.length > 2 ? 's' : ''}`),
          h('ol', { class: 'sugg', start: '2' }, items.slice(1)))];
    }

    const stepsBox = h('section', { class: 'section steps-box', 'aria-labelledby': 'steps-h' },
      h('div', { class: 'steps-head' },
        h('h3', { id: 'steps-h' }, `Steps (${steps.length})`),
        h('div', { class: 'chips', role: 'group', 'aria-label': 'View' },
          seg('view-list', 'List', ui.view === 'list', () => { ui.view = 'list'; drawMap(); }),
          seg('view-map', 'Swimlanes', ui.view === 'map', () => { ui.view = 'map'; drawMap(); }))),
      !steps.length ? h('p', { class: 'card empty', 'data-test': 'steps-empty' }, 'Add the first step: what happens, and who does it. Rough times are fine; the guide points out missing ones.')
        : ui.view === 'map' ? lanes(steps, a, colour) : stepList(steps, a, colour, m));

    const editor = stepEditor(m, steps);
    const layout = h('div', { class: 'pm-layout' },
      h('div', { class: 'pm-main' }, stats, bars), h('div', { class: 'pm-guide' }, guide), h('div', { class: 'pm-steps' }, stepsBox, editor));
    body.replaceChildren(head, layout);
  }

  function lanes(steps, a, colour) {
    const roles = [...new Set(steps.map((s) => s.role))];
    const grid = h('div', { class: 'lanegrid', style: `grid-template-columns: 120px repeat(${steps.length}, 172px)` });
    roles.forEach((r, ri) => {
      grid.append(h('div', { class: 'lanename', style: `grid-row:${ri + 1};grid-column:1` }, h('span', { class: 'role-dot', style: `background:${colour(r)}` }), r));
      steps.forEach((s, i) => {
        const cell = h('div', { class: 'cell', style: `grid-row:${ri + 1};grid-column:${i + 2}` });
        if (s.role === r) cell.append(stepCard(s, i, a, colour));
        grid.append(cell);
      });
    });
    return h('div', {},
      h('p', { class: 'meta scroll-hint' }, 'Scroll sideways for later steps. Tap a step to change it.'),
      h('div', { class: 'lanes', tabindex: '0', role: 'region', 'aria-label': 'Swimlane map, scroll sideways for later steps' }, grid));
  }
  function stepCard(s, i, a, colour) {
    const hot = a.biggestWaitStepId === s.id;
    return h('button', { type: 'button', class: `pm-step${hot ? ' hot' : ''}${s.par ? ' par' : ''}`, style: `border-left-color:${colour(s.role)}`, 'data-step': s.id,
      'aria-label': `Step ${i + 1}: ${s.name}, ${s.role}, waits ${fmtMinutes(s.wait)}, work ${fmtMinutes(s.work)}. Change it.`, onclick: () => edit(s.id) },
      h('span', { class: 'n' }, `Step ${i + 1}`), s.name,
      h('span', { class: 't' }, s.wait ? h('span', { class: 'wt' }, `waits ${fmtMinutes(s.wait)}`) : null, h('span', {}, `work ${fmtMinutes(s.work)}`)));
  }
  function stepList(steps, a, colour, m) {
    return h('ol', { class: 'pm-list', 'data-test': 'step-list' }, steps.map((s, i) => {
      const hot = a.biggestWaitStepId === s.id;
      const mv = (dir) => async () => { if (await run('map.step.move', { mapId: m.id, version: ui.version, stepId: s.id, direction: dir, expectedRevision: m.revision })) drawMap(); };
      return h('li', { 'data-step': s.id },
        s.wait || s.par ? h('div', { class: `wait${hot ? ' hot' : ''}` }, s.par ? `Starts alongside the step before${s.wait ? `, after ${fmtMinutes(s.wait)}` : ''}` : `Waits ${fmtMinutes(s.wait)}${hot ? ' · the biggest wait' : ''}`) : null,
        h('div', { class: 'row' },
          h('span', { class: 'num' }, String(i + 1)),
          h('div', { class: 'what' }, h('b', {}, s.name),
            h('span', {}, h('span', { class: 'role-dot', style: `background:${colour(s.role)}` }), `${s.role} · work ${fmtMinutes(s.work)}${s.msg ? ' · passes on information' : ''}`)),
          h('div', { class: 'ctl' },
            h('button', { type: 'button', class: 'icon', 'data-cmd': 'map.step.move', 'aria-label': `Move step ${i + 1} up`, disabled: i === 0 ? true : null, onclick: mv('up') }, '↑'),
            h('button', { type: 'button', class: 'icon', 'data-cmd': 'map.step.move', 'aria-label': `Move step ${i + 1} down`, disabled: i === steps.length - 1 ? true : null, onclick: mv('down') }, '↓'),
            h('button', { type: 'button', class: 'icon', 'aria-label': `Change step ${i + 1}`, onclick: () => edit(s.id) }, '✎'))));
    }));
  }
  function edit(stepId) { ui.editing = stepId; drawMap().then(() => { const f = document.getElementById('st-name'); if (f) { f.focus(); f.scrollIntoView({ block: 'center' }); } }); }

  function stepEditor(m, steps) {
    const s = steps.find((x) => x.id === ui.editing) || null;
    const num = (id, label, val, help) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, type: 'number', min: '0', max: '10080', step: '1', inputmode: 'numeric', value: String(val ?? 0) }), help ? h('span', { class: 'meta' }, help) : null);
    const roles = [...new Set([...m.today.steps, ...m.proposed.steps].map((x) => x.role))];
    const form = h('form', { class: 'card step-form', 'data-test': 'step-form', 'aria-labelledby': 'st-h' },
      h('h3', { id: 'st-h' }, s ? `Change step ${steps.indexOf(s) + 1}` : `Add a step to ${ui.version === 'proposed' ? 'Proposed' : 'Today'}`),
      h('div', { class: 'field' }, h('label', { for: 'st-name' }, 'What happens'), h('input', { id: 'st-name', maxlength: '140', required: true, value: s?.name || '', placeholder: 'e.g. Bed cleaned' })),
      h('div', { class: 'field' }, h('label', { for: 'st-role' }, 'Who does it (a role, never a name)'), h('input', { id: 'st-role', maxlength: '140', required: true, list: 'st-roles', value: s?.role || '', placeholder: 'e.g. Housekeeping' }),
        h('datalist', { id: 'st-roles' }, roles.map((r) => h('option', { value: r })))),
      h('div', { class: 'two' }, num('st-wait', 'Waiting before (min)', s?.wait), num('st-work', 'Hands-on (min)', s?.work)),
      h('label', { class: 'check' }, h('input', { id: 'st-msg', type: 'checkbox', checked: s?.msg ? true : null }), 'Only passes on information (a call, message or form)'),
      h('label', { class: 'check' }, h('input', { id: 'st-par', type: 'checkbox', checked: s?.par ? true : null }), 'Starts alongside the step before'),
      h('div', { class: 'form-actions' },
        h('button', { type: 'submit', class: 'btn', 'data-cmd': s ? 'map.step.update' : 'map.step.add' }, s ? 'Save step' : 'Add step'),
        s ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.editing = null; drawMap(); } }, 'Cancel') : null,
        s ? h('button', { type: 'button', class: 'btn btn-danger', 'data-cmd': 'map.step.remove',
          onclick: async () => { if (await run('map.step.remove', { mapId: m.id, version: ui.version, stepId: s.id, expectedRevision: m.revision })) { ui.editing = null; ctx.toast('Step removed.'); drawMap(); } } }, 'Remove') : null));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = (id) => form.querySelector(`#${id}`);
      const input = { mapId: m.id, version: ui.version, name: val('st-name').value.trim(), role: val('st-role').value.trim(),
        wait: Math.max(0, Math.round(+val('st-wait').value || 0)), work: Math.max(0, Math.round(+val('st-work').value || 0)),
        msg: val('st-msg').checked, par: val('st-par').checked, expectedRevision: m.revision };
      const out = s ? await run('map.step.update', { ...input, stepId: s.id }) : await run('map.step.add', input);
      if (out) { ctx.toast(s ? 'Step saved.' : 'Step added.'); ui.editing = null; await drawMap(); }
    });
    return form;
  }

  await Promise.all([draw(), props.load()]);
  let t = null;
  const off = core.onChange(({ kind, detail }) => {
    // Our own writes redraw themselves. Redraw for another tab's change, a reset, or an
    // accepted agent proposal.
    if (kind === 'proposals') props.load();
    if (!(kind === 'reset' || kind === 'proposals' || (kind === 'events' && detail?.from === 'another tab'))) return;
    clearTimeout(t);
    t = setTimeout(() => { if (!ui.busy) draw(); }, 150);
  });
  return () => { off(); clearTimeout(t); };
}
