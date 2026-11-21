// Process maps (backlog PM1): map a process step by step and role by role, see where the time
// goes, and try a change in a Proposed version beside Today. Every control runs a named command
// (core/commands.js: ospeli_maps_list, ospeli_maps_get, ospeli_maps_suggest, ospeli_maps_create, map.step.*, ospeli_maps_try_suggestion,
// ospeli_maps_hide_suggestion, ospeli_maps_reset_proposed, ospeli_maps_guide_set), the same ones an agent would.
// Walk mode (backlog PM2): #/process/walk is the walk in progress (modules/walk.js); a finished walk
// opens here as a map whose times are shown in seconds and labelled as measured on one walk.
// Deep link: #/process/<mapId>. The guide is rule-based, says why, and has an off switch.
import { h } from './ui.js';
import { fmtMinutes, EXAMPLES } from '../core/processmap.js';
import { fmtSeconds, stepsInSeconds, longestWaits, waitWords, notSeenWords, MIN_LONGEST_WAIT_SEC, PLANNED_WAIT_RULE, NOT_ALWAYS_WASTE, fmtRange } from '../core/walk.js';
import { renderWalk } from './walk.js';
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
  const ui = { mapId: ctx.rest[0] || null, version: 'today', view: phone() ? 'list' : 'map', editing: null, busy: false, waitOpen: null };
  const body = h('div', { 'data-test': 'process-body' });
  // T: how a time reads on the map in view (minutes, or seconds for a map made from a walk).
  let T = fmtMinutes; let todayView = []; let walkOff = null; let walkNow = null;
  // On a map made from a walk: the step or steps with the longest wait, when it reaches the floor
  // and the clock did not move. Null on other maps, which ring the biggest wait as before.
  let hotIds = null; let walkedNow = false;
  // On a map with two or more walks, in its walks version: each step's range across the walks, by step id.
  let rangeOf = null;
  const isHot = (a, s) => (hotIds ? hotIds.includes(s.id) : a.biggestWaitStepId === s.id);
  // What the first version is called: "Today", or "This walk" on a map made from one walk.
  let NOW = 'Today';
  const props = proposalsCard(ctx, {
    match: (p) => p.command.startsWith('ospeli_maps_'),
    describe: (p) => {
      const what = {
        // Issue #106: the title the agent gave and the example's own name, so two proposals can be told apart.
        'ospeli_maps_create': `${EXAMPLES[p.input.from] ? `Start a map from the example "${EXAMPLES[p.input.from].title}"` : 'Start a blank map'}${p.input.title ? ` called "${p.input.title}"` : ''}`, 'ospeli_maps_step_add': `Add step "${p.input.name}"`, 'ospeli_maps_step_update': `Change step ${p.input.stepId}`,
        'ospeli_maps_step_move': `Move step ${p.input.stepId} ${p.input.direction}`, 'ospeli_maps_step_remove': `Remove step ${p.input.stepId}`,
        'ospeli_maps_try_suggestion': `Try in Proposed: ${p.input.suggestionId}`, 'ospeli_maps_hide_suggestion': `Hide suggestion ${p.input.suggestionId}`,
        'ospeli_maps_reset_proposed': 'Reset Proposed',
      }[p.command] || p.command;
      return `${p.input.mapId ? `${p.input.mapId}: ` : ''}${what}`;
    },
  });
  const guideBtn = h('button', { type: 'button', class: 'chip-btn guide-switch', 'data-test': 'guide-switch', 'data-cmd': 'ospeli_maps_guide_set', 'aria-pressed': 'true' }, 'Guide: On');
  const guideHome = h('div', { class: 'guide-head' }, guideBtn, h('span', { class: 'meta' }, 'People decide; Ospeli suggests.'));
  const pageHead =
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Process maps'),
        h('h1', {}, 'See where the time goes'),
        h('p', {}, 'Walk a visit and get a timed map, or map how work flows step by step and role by role. Changes you try go into a Proposed version; Today stays as it is.')),
      guideHome);
  el.append(pageHead, props.el, body);

  let list = { maps: [], examples: [], guideOn: true };
  const run = async (name, input) => {
    if (ui.busy) return null;
    ui.busy = true;
    try { return await ctx.run(name, input); } catch (err) { ctx.toast(`Not saved. ${err.message}`); return null; } finally { ui.busy = false; }
  };

  guideBtn.addEventListener('click', async () => {
    const out = await run('ospeli_maps_guide_set', { on: !list.guideOn });
    if (out) { ctx.toast(out.guideOn ? 'Guide on.' : 'Guide off. Maps, times and editing all still work.'); await draw(); }
  });

  async function create(from) {
    const out = await run('ospeli_maps_create', { from });
    if (out) { location.hash = `#/process/${out.mapId}`; }
  }

  // Walk mode entry: first on the page. A walk in progress (a reload, a phone handed over) is offered again.
  function walkCard() {
    if (walkNow) {
      return h('section', { class: 'card walk-card', 'aria-labelledby': 'walkcard-h', 'data-test': 'walk-card' },
        h('h2', { id: 'walkcard-h' }, 'Walk in progress'),
        h('p', {}, `${walkNow.title} · ${walkNow.steps.length} ${walkNow.steps.length === 1 ? 'step' : 'steps'} saved. The clock is still running.`),
        h('div', { class: 'form-actions' },
          h('a', { class: 'btn', href: '#/process/walk', 'data-test': 'walk-continue' }, 'Continue walk'),
          h('button', { type: 'button', class: 'btn btn-ghost', 'data-cmd': 'ospeli_walks_discard', 'data-test': 'walk-card-delete',
            onclick: async () => { if (!window.confirm('Delete this walk? Its times are not kept.')) return; if (await run('ospeli_walks_discard', {})) { ctx.toast('Walk deleted.'); draw(); } } }, 'Delete walk')));
    }
    return h('section', { class: 'card walk-card', 'aria-labelledby': 'walkcard-h', 'data-test': 'walk-card' },
      h('h2', { id: 'walkcard-h' }, 'Walk it and time it'),
      h('p', {}, 'Follow one visit with your phone and time each step as it happens. Finish, and you get a timed map. No names, no patient details. Works with no connection.'),
      // One tap opens the before-you-walk points (modules/walk.js); the walk and its clock start there.
      h('a', { class: 'btn walk-start', href: '#/process/walk', 'data-test': 'walk-start' }, 'Start a walk'));
  }

  function chooser(withHeading) {
    return h('section', { class: 'card map-chooser', 'aria-labelledby': 'chooser-h', 'data-test': 'map-chooser' },
      h('h2', { id: 'chooser-h' }, withHeading),
      h('p', { class: 'meta' }, 'Walk a visit, open an example to see how it works, or start a blank map for your own process. Lanes use your own words, from a small clinic to a large hospital.'),
      h('div', { class: 'chooser-grid' },
        list.examples.map((e) => h('button', { type: 'button', class: 'choice', 'data-cmd': 'ospeli_maps_create', 'data-from': e.from, onclick: () => create(e.from) },
          h('b', {}, e.title), h('span', {}, SOURCE_TEXT[e.from] || 'An example process.'), h('span', { class: 'tag' }, 'Example'))),
        h('button', { type: 'button', class: 'choice blank', 'data-cmd': 'ospeli_maps_create', 'data-from': 'blank', onclick: () => create('blank') },
          h('b', {}, 'Blank map'), h('span', {}, 'Describe your own process, step by step.'))));
  }

  async function draw() {
    if (walkOff) { walkOff(); walkOff = null; }
    if (guideBtn.parentNode !== guideHome) guideHome.prepend(guideBtn);
    walkNow = (await ctx.run('ospeli_walks_get', {})).walk;
    const walking = ui.mapId === 'walk';
    // During a walk the screen holds the walk and nothing else.
    pageHead.hidden = walking; props.el.hidden = walking;
    if (walking) { walkOff = await renderWalk(body, ctx, ctx.rest[1] || null); return; }
    list = await ctx.run('ospeli_maps_list', { limit: 200 });
    guideBtn.setAttribute('aria-pressed', String(list.guideOn));
    guideBtn.textContent = `Guide: ${list.guideOn ? 'On' : 'Off'}`;
    if (ui.mapId && !list.maps.some((m) => m.id === ui.mapId)) ui.mapId = null;
    headFor();
    if (!ui.mapId) {
      body.replaceChildren(...[
        list.maps.length ? h('section', { class: 'section', 'aria-labelledby': 'maps-h' },
          h('h2', { id: 'maps-h' }, 'Your maps'),
          h('ul', { class: 'map-list' }, list.maps.map((m) => h('li', {},
            h('a', { href: `#/process/${m.id}`, 'data-test': 'map-link' }, h('b', {}, m.title),
              h('span', { class: 'meta' }, m.walk && m.walkCount > 1 ? `${m.steps} steps · ${m.walkCount} walks`
                : m.walk ? `${m.steps} steps · ${fmtSeconds(m.elapsedSecToday)} start to finish · measured on one walk`
                : `${m.steps} steps · ${fmtMinutes(m.elapsedToday)} start to finish${m.elapsedProposed !== m.elapsedToday ? ` · Proposed ${fmtMinutes(m.elapsedProposed)}` : ''}`)))))) : null,
        chooser(list.maps.length ? 'Start another map' : 'No maps yet')].filter(Boolean));
      body.prepend(walkCard());
      return;
    }
    await drawMap();
  }
  // On a phone, an open map starts at its title: the page heading is kept for screen readers only.
  const headFor = () => pageHead.classList.toggle('on-map', !!ui.mapId && ui.mapId !== 'walk');

  async function drawMap() {
    const m = await ctx.run('ospeli_maps_get', { mapId: ui.mapId });
    const sugg = await ctx.run('ospeli_maps_suggest', { mapId: ui.mapId, version: ui.version });
    const walked = !!m.walk;
    // Two or more walks of one step list (issue #124 item 1): the map reads as a range, lowest to
    // highest, in whole minutes, with no percentage. One walk reads as before.
    const rg = walked ? m.range : null;
    const multi = !!rg && rg.count > 1;
    T = walked ? fmtSeconds : fmtMinutes;
    NOW = multi ? 'The walks' : walked ? 'This walk' : 'Today';
    // A walked map says "measured" only where that is true: on the walk version, and only while
    // no time was changed by hand and no step was added by hand.
    const byHand = walked && m.today.steps.some((x) => x.edited || (x.waitSec == null && x.workSec == null));
    const measuredView = walked && ui.version === 'today';
    // The device's own date and time format (issue #41), like the rest of the app.
    const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const statsOf = (part) => (walked ? part.statsSec : part.stats);
    const inView = (list) => (walked ? stepsInSeconds(list) : list);
    todayView = inView(m.today.steps);
    const v = m[ui.version]; const t = statsOf(m.today);
    const steps = inView(v.steps); const a = statsOf(v);
    const roles = [...new Set([...m.today.steps, ...m.proposed.steps].map((s) => s.role))];
    const colour = (r) => ROLE_COLOURS[Math.max(0, roles.indexOf(r)) % ROLE_COLOURS.length];
    const isP = ui.version === 'proposed';
    walkedNow = walked;
    const moved = walked && !!m.walk.clockMoved;
    const top = walked && !moved ? longestWaits(steps) : [];
    hotIds = walked ? top.map((x) => x.id) : null;
    const rangeView = multi && measuredView;
    rangeOf = rangeView ? new Map(rg.steps.map((x) => [x.stepId, x])) : null;
    // On the walks version the ring goes to every step that was a walk's longest wait.
    if (rangeView) hotIds = rg.longest.map((l) => l.stepId).filter(Boolean);
    const first = multi ? rg.walks[0] : null;
    // "Walk it again (walk 2 of 3)": the walk and its clock start on the before-you-walk points.
    const nextNo = walked ? rg.count + 1 : 0;
    const againBtn = walked && !walkNow && m.today.steps.length ? h('div', { class: 'walk-again-box' },
      h('a', { class: 'btn walk-again', href: `#/process/walk/${m.id}`, 'data-test': 'walk-again' }, `Walk it again (walk ${nextNo}${nextNo <= rg.aim ? ` of ${rg.aim}` : ''})`),
      h('p', { class: 'meta' }, 'Same steps. Saved on this phone only.')) : null;

    const seg = (id, label, on, onclick, extra = {}) => h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(on), 'data-test': id, onclick, ...extra }, label);
    const head = h('div', { class: 'map-head' },
      h('div', {},
        h('a', { href: '#/process', class: 'back' }, '← All maps'),
        h('h2', { id: 'map-h', 'data-test': 'map-title' }, `${m.title} · ${isP ? 'Proposed' : NOW}`),
        multi ? h('p', { class: 'walk-when' }, h('span', { class: 'chip walk-badge', 'data-test': 'walk-badge' }, !measuredView ? 'What-if, not measured' : `${rg.count} walks`),
          !measuredView ? ` From walk 1's times (${day(first.startedAt)}, ${clock(first.startedAt)})` : null)
        : walked ? h('p', { class: 'walk-when' }, h('span', { class: 'chip walk-badge', 'data-test': 'walk-badge' }, !measuredView ? 'What-if, not measured' : byHand ? 'One walk, changed by hand' : 'Measured on one walk'),
          ` Walked ${day(m.walk.startedAt)}, started ${clock(m.walk.startedAt)}`) : null,
        m.start ? h('p', { class: 'meta' }, `Starts when: ${m.start}`) : null),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Version' },
        seg('v-today', NOW, !isP, () => { ui.version = 'today'; ui.editing = null; drawMap(); }),
        seg('v-proposed', m.changed ? 'Proposed (changed)' : 'Proposed', isP, () => { ui.version = 'proposed'; ui.editing = null; drawMap(); })));

    const stat = (val, label, was, better) => h('div', { class: 'pm-stat' }, h('b', {}, val), h('span', {}, label),
      isP && was != null && was !== val ? h('span', { class: `was${better ? ' better' : ''}` }, `${NOW.toLowerCase()}: ${was}`) : null);
    // Waiting share (local definition): waiting time divided by start to finish, as a whole percent.
    const waitShare = (x) => (x.elapsed ? Math.round((100 * x.wait) / x.elapsed) : null);
    // On a walked map: waiting a person marked planned or required (still waiting), and time not seen (paused).
    const extrasOf = (list) => ({ planned: list.reduce((n, x) => n + (x.plannedWait ? x.wait || 0 : 0), 0), notSeen: list.reduce((n, x) => n + (x.waitNotSeenSec || 0) + (x.workNotSeenSec || 0), 0) });
    const extra = walked ? extrasOf(steps) : { planned: 0, notSeen: 0 };
    // A walked map opens with the answer: how long, how much of it was waiting, and the longest wait.
    const walkWord = (w) => `Walk ${w.n}: ${day(w.startedAt)}, ${clock(w.startedAt)}${w.clockMoved ? ' · the phone\'s clock changed, left out' : w.stoppedEarly ? ' · stopped early, left out of the totals' : ''}`;
    const nameQ = (l) => `“${l.name}”`;
    const lo = rangeView ? rg.longest : [];
    const longestLine = !lo.length ? `No wait of ${MIN_LONGEST_WAIT_SEC} seconds or more on these walks.`
      : lo.length === 1 && lo[0].walks.length === rg.longestOf ? `before ${nameQ(lo[0])} on ${rg.longestOf === 2 ? 'both' : `all ${rg.longestOf}`} walks`
        : lo.every((l) => l.walks.length === 1) ? `it moved: ${lo.map((l) => `before ${nameQ(l)} on walk ${l.walks[0]}`).join('; ')}`
          : `before ${nameQ(lo[0])} on ${lo[0].walks.length} of ${rg.longestOf} walks; ${lo.slice(1).map((l) => `before ${nameQ(l)} on walk ${l.walks.join(' and ')}`).join('; ')}`;
    const partOf = (r) => (r.n < rg.count ? ` (${r.n} of ${rg.count} walks)` : '');
    const rangeAnswer = rangeView ? h('section', { class: 'card walk-answer', 'data-test': 'walk-answer', 'aria-label': 'What these walks showed' },
      rg.totals.elapsed.n ? h('p', { class: 'wa-big', 'data-test': 'walk-range' }, h('b', {}, fmtRange(rg.totals.elapsed, { count: false })), ` start to finish${partOf(rg.totals.elapsed)}`)
        : h('p', { class: 'wa-line', 'data-test': 'walk-range' }, 'No walk has been walked to the end of the list yet, so there is no start-to-finish time.'),
      rg.totals.elapsed.n ? h('p', { class: 'wa-line', 'data-test': 'walk-range-parts' }, h('b', {}, `Waiting ${fmtRange(rg.totals.wait, { count: false })}`), ` · hands-on ${fmtRange(rg.totals.work, { count: false })}`) : null,
      h('p', { class: 'wa-line wa-wait', 'data-test': 'walk-longest' }, lo.length ? h('b', {}, 'Longest wait: ') : null, longestLine),
      rg.totals.notSeen.n ? h('p', { class: 'wa-line', 'data-test': 'walk-not-seen' }, `Not seen (walk paused) on ${rg.totals.notSeen.n} ${rg.totals.notSeen.n === 1 ? 'walk' : 'walks'}: ${fmtRange(rg.totals.notSeen, { count: false })}. It is inside start to finish, and in neither waiting nor hands-on.`) : null,
      h('p', { class: 'wa-line wa-count', 'data-test': 'walk-count' }, rg.count < rg.aim
        ? `${rg.count} of ${rg.aim} walks: shortest to longest. These are examples, not an average. Walk the ${rg.count === 2 ? 'third' : 'next'} on another day or at another hour.`
        : `Shortest to longest from ${rg.count} walks. These are examples, not an average or a fixed number. Ask why the time changes from walk to walk.`),
      h('p', { class: 'wa-line wa-waste', 'data-test': 'walk-waste' }, NOT_ALWAYS_WASTE),
      // Each walk's day and hour is on its bar below; a walk that is left out is also said here.
      rg.walks.some((w) => !w.complete) ? h('ul', { class: 'wa-walks', 'data-test': 'walk-list' }, rg.walks.filter((w) => !w.complete).map((w) => h('li', {}, walkWord(w)))) : null,
      againBtn) : null;
    const answer = rangeView ? rangeAnswer : measuredView ? h('section', { class: `card walk-answer${moved ? ' is-warn' : ''}`, 'data-test': 'walk-answer', 'aria-label': 'What this walk showed' },
      moved ? h('p', { class: 'walk-clock', role: 'alert', 'data-test': 'walk-clock' }, h('b', {}, 'The phone\'s clock changed during this walk.'), ' The times on this map may be wrong. Walk it again to get times you can use.') : null,
      h('p', { class: 'wa-big' }, h('b', {}, T(a.elapsed + extra.notSeen)), moved ? ' (may be wrong) start to finish on this walk' : ' start to finish on this walk'),
      h('p', { class: 'wa-line' }, h('b', {}, `${T(a.wait)} waiting`), waitShare(a) == null ? '' : ` (${waitShare(a)}% of ${extra.notSeen ? 'the time seen on this walk' : 'this walk'})`, ` · ${T(a.work)} hands-on`),
      extra.planned ? h('p', { class: 'wa-line', 'data-test': 'walk-planned' }, `Of the waiting, ${T(extra.planned)} was marked planned or required.`) : null,
      extra.notSeen ? h('p', { class: 'wa-line', 'data-test': 'walk-not-seen' }, `${T(extra.notSeen)} not seen (walk paused): not counted as waiting or hands-on.`) : null,
      moved ? null : top.length
        ? h('p', { class: 'wa-line wa-wait', 'data-test': 'walk-longest' }, h('b', {}, top.length === 1 ? 'Longest wait: ' : 'Longest waits, tied: '), top.length === 1 ? `${waitWords(top[0])} before “${top[0].name}”${notSeenWords(top[0])}` : `${T(top[0].wait)}${top.some((x) => x.waitNotSeenSec) ? ' or more' : ''} before ${top.map((x) => `“${x.name}”`).join(' and ')}`)
        : h('p', { class: 'wa-line', 'data-test': 'walk-longest' }, `No wait of ${MIN_LONGEST_WAIT_SEC} seconds or more on this walk.`),
      h('p', { class: 'wa-line wa-waste', 'data-test': 'walk-waste' }, NOT_ALWAYS_WASTE),
      h('p', { class: 'wa-line', 'data-test': 'walk-handoffs' }, `${a.handoffs} ${a.handoffs === 1 ? 'handoff' : 'handoffs'} between roles`),
      h('p', { class: 'meta wa-note' }, 'One walk, one observation. Ask what the wait was for, and walk it again before changing anything.'),
      againBtn) : null;
    const stats = measuredView ? h('div', { class: 'pm-stats is-answer', 'data-test': 'pm-stats' }, answer) : h('div', { class: 'pm-stats', 'data-test': 'pm-stats' },
      stat(T(a.elapsed), measuredView ? 'start to finish on this walk' : 'start to finish', T(t.elapsed), a.elapsed < t.elapsed),
      stat(T(a.work), 'hands-on work', T(t.work), false),
      walked ? stat(waitShare(a) == null ? '–' : `${waitShare(a)}%`, measuredView ? 'of this walk is waiting' : 'of the time is waiting', waitShare(t) == null ? null : `${waitShare(t)}%`, waitShare(a) < waitShare(t))
        : stat(a.workShare == null ? '–' : `${a.workShare}%`, 'of the time is work', t.workShare == null ? null : `${t.workShare}%`, a.elapsed < t.elapsed),
      stat(String(a.handoffs), 'handoffs between roles', String(t.handoffs), a.handoffs < t.handoffs));

    // Time bars: one for Today; once Proposed differs, both stacked, on the same scale.
    // Waiting is never shown by colour alone (issue #124): it is hatched, and the legend names each
    // part with its time. A planned or required wait and time not seen each have their own pattern.
    const bar = (label, s, scale, testId, x = { planned: 0, notSeen: 0 }) => {
      const total = s.work + s.wait + x.notSeen || 1; const width = Math.max(8, (100 * total) / scale);
      const b = h('div', { class: 'flowbar', role: 'img', style: `width:${width}%`, 'data-test': testId,
        'aria-label': `${label}: of ${T(s.work + s.wait)} of step time, ${T(s.wait)} is waiting${x.planned ? ` (${T(x.planned)} of it planned or required)` : ''} and ${T(s.work)} is hands-on work.${x.notSeen ? ` ${T(x.notSeen)} more was not seen.` : ''}` });
      if (s.wait - x.planned > 0) b.append(h('i', { class: 'w', style: `width:${(100 * (s.wait - x.planned)) / total}%` }));
      if (x.planned) b.append(h('i', { class: 'p', style: `width:${(100 * x.planned) / total}%` }));
      if (s.work) b.append(h('i', { class: 'k', style: `width:${(100 * s.work) / total}%` }));
      if (x.notSeen) b.append(h('i', { class: 'n', style: `width:${(100 * x.notSeen) / total}%` }));
      const diff = label === 'Proposed' ? statsOf(m.today).elapsed - s.elapsed : 0;
      return h('div', { class: 'bar-row' }, h('span', { class: 'bar-label' }, `${label} ${T(s.elapsed + x.notSeen)}${diff > 0 ? ` · ${T(diff)} shorter` : diff < 0 ? ` · ${T(-diff)} longer` : ''}`), b);
    };
    const xToday = walked ? extrasOf(inView(m.today.steps)) : undefined; const xProp = walked ? extrasOf(inView(m.proposed.steps)) : undefined;
    const scale = Math.max(statsOf(m.today).work + statsOf(m.today).wait + (xToday?.notSeen || 0), statsOf(m.proposed).work + statsOf(m.proposed).wait + (xProp?.notSeen || 0)) || 1;
    const key = (cls, text) => h('span', { class: 'key' }, h('span', { class: `sw ${cls}` }), text);
    // One bar per walk, on one scale: the walks are seen side by side, never averaged.
    const walkBar = (w, max) => {
      const total = w.elapsedSec || 1; const other = w.waitSec - w.plannedWaitSec;
      const b = h('div', { class: 'flowbar', role: 'img', style: `width:${Math.max(8, (100 * total) / max)}%`, 'data-test': 'bar-walk',
        'aria-label': `Walk ${w.n}: ${T(w.waitSec)} waiting${w.plannedWaitSec ? ` (${T(w.plannedWaitSec)} of it planned or required)` : ''} and ${T(w.workSec)} hands-on.${w.notSeenSec ? ` ${T(w.notSeenSec)} more was not seen.` : ''}` });
      if (other > 0) b.append(h('i', { class: 'w', style: `width:${(100 * other) / total}%` }));
      if (w.plannedWaitSec) b.append(h('i', { class: 'p', style: `width:${(100 * w.plannedWaitSec) / total}%` }));
      if (w.workSec) b.append(h('i', { class: 'k', style: `width:${(100 * w.workSec) / total}%` }));
      if (w.notSeenSec) b.append(h('i', { class: 'n', style: `width:${(100 * w.notSeenSec) / total}%` }));
      return h('div', { class: 'bar-row' }, h('span', { class: 'bar-label' }, `Walk ${w.n} · ${day(w.startedAt)}, ${clock(w.startedAt)} · ${T(w.elapsedSec)}${w.clockMoved ? ' (may be wrong)' : w.stoppedEarly ? ' (stopped early)' : ''}`), b);
    };
    const walkBars = rangeView ? h('section', { class: 'card bars', 'aria-labelledby': 'bars-h', 'data-test': 'walk-bars' },
      h('h3', { id: 'bars-h' }, 'Where the time went'),
      rg.walks.map((w) => walkBar(w, Math.max(...rg.walks.map((y) => y.elapsedSec)) || 1)),
      h('p', { class: 'legend meta', 'data-test': 'bar-legend' },
        key('w', 'Waiting'), rg.walks.some((w) => w.plannedWaitSec) ? key('p', 'Planned or required wait') : null, key('k', 'Hands-on work'), rg.walks.some((w) => w.notSeenSec) ? key('n', 'Not seen') : null),
      h('p', { class: 'meta notice walk-note', 'data-test': 'walk-note' },
        `Same step list, one bar per walk. This is what happened on ${rg.count} visits, not how the process usually runs. Time after the last step is not recorded.${rg.walks.some((w) => w.guidanceSeen === false) ? ' The before-you-walk points were not confirmed for every walk.' : ''}`)) : null;
    const bars = walkBars || h('section', { class: 'card bars', 'aria-labelledby': 'bars-h' },
      h('h3', { id: 'bars-h' }, walked ? 'Where the time went' : 'Where the time goes'),
      bar(multi ? 'Walk 1' : NOW, statsOf(m.today), scale, 'bar-today', xToday),
      m.changed ? bar('Proposed', statsOf(m.proposed), scale, 'bar-proposed', xProp) : null,
      h('p', { class: 'legend meta', 'data-test': 'bar-legend' },
        key('w', `${extra.planned ? 'Other waiting' : 'Waiting'} ${T(a.wait - extra.planned)}`),
        extra.planned ? key('p', `Planned or required wait ${T(extra.planned)}`) : null,
        key('k', `Hands-on work ${T(a.work)}`),
        extra.notSeen ? key('n', `Not seen ${T(extra.notSeen)}`) : null),
      walked ? h('p', { class: 'meta notice walk-note', 'data-test': 'walk-note' },
        `Times from ${multi ? 'walk 1' : 'one walk'} on ${day(m.walk.startedAt)}, started ${clock(m.walk.startedAt)}. This is what happened once, not how the process usually runs. Time after the last step is not recorded.${byHand ? ' Some times or steps were changed by hand after the walk.' : ''}${m.walk.guidanceSeen === false ? ' The before-you-walk points were not confirmed for this walk.' : ''}`) : null,
      m.changed ? h('p', { class: 'meta', 'data-test': 'whatif-note' }, 'A what-if from your map, not a prediction. Test it and measure.',
        ' ', h('button', { type: 'button', class: 'linkish', 'data-cmd': 'ospeli_maps_reset_proposed', onclick: async () => { if (await run('ospeli_maps_reset_proposed', { mapId: m.id })) { ctx.toast(`Proposed is a copy of ${NOW} again.`); drawMap(); } } }, 'Reset Proposed')) : null);

    // The guide.
    const guide = h('section', { class: 'card guide', 'aria-labelledby': 'guide-h', 'data-test': 'guide' },
      h('h3', { id: 'guide-h' }, 'Guide'),
      !sugg.guideOn ? h('p', { class: 'meta' }, 'The guide is off. The map, times and editing all work without it.')
        : [
          h('p', { class: 'meta' }, `${rangeView ? 'The guide uses simple rules you can check, on this device. It reads the range across the walks, asks questions and offers no change to try.' : walked ? 'The guide uses simple rules you can check, on this device. One walk is one observation, so it asks questions and offers no change to try.' : 'The guide uses simple rules you can check, on this device. Suggestions only change the Proposed version.'}${sugg.hidden ? ` ${sugg.hidden} hidden.` : ''}`),
          suggList(sugg.suggestions.map((sg) => h('li', { class: `sg ${sg.kind}`, 'data-suggestion': sg.id },
            h('b', {}, sg.title), h('p', {}, sg.text), h('p', { class: 'why' }, `Why: ${sg.why}`), sg.basis ? h('p', { class: 'why basis', 'data-test': 'sg-basis' }, sg.basis) : null,
            h('div', { class: 'sg-actions' },
              sg.tryable ? h('button', { type: 'button', class: 'btn btn-small', 'data-cmd': 'ospeli_maps_try_suggestion', disabled: sg.tried && isP ? true : null,
                onclick: async () => {
                  const out = await run('ospeli_maps_try_suggestion', { mapId: m.id, suggestionId: sg.id, expectedRevision: m.revision });
                  if (out) { ui.version = 'proposed'; ctx.toast(`Tried in Proposed. ${NOW} has not changed.`); drawMap(); }
                } }, sg.tried && isP ? 'Tried in Proposed' : sg.tryLabel) : null,
              h('button', { type: 'button', class: 'btn btn-ghost btn-small', 'data-cmd': 'ospeli_maps_hide_suggestion',
                onclick: async () => { if (await run('ospeli_maps_hide_suggestion', { mapId: m.id, suggestionId: sg.id })) { ctx.toast('Hidden for this map.'); drawMap(); } } }, 'Hide'))))),
        ]);

    // Steps: swimlane map or list.
    function suggList(items) {
      // Phones: the answer first. The top suggestion shows; the rest fold under one row.
      if (!phone() || items.length <= 1) return h('ol', { class: 'sugg' }, items);
      return [h('ol', { class: 'sugg' }, items[0]),
        h('details', { class: 'more-sugg', 'data-test': 'more-sugg' }, h('summary', {}, `${items.length - 1} more ${walkedNow ? 'note' : 'suggestion'}${items.length > 2 ? 's' : ''}`),
          h('ol', { class: 'sugg', start: '2' }, items.slice(1)))];
    }

    const stepsBox = h('section', { class: 'section steps-box', 'aria-labelledby': 'steps-h' },
      h('div', { class: 'steps-head' },
        h('h3', { id: 'steps-h' }, `Steps (${steps.length})`),
        h('div', { class: 'chips', role: 'group', 'aria-label': 'View' },
          seg('view-list', 'List', ui.view === 'list', () => { ui.view = 'list'; drawMap(); }),
          seg('view-map', 'Swimlanes', ui.view === 'map', () => { ui.view = 'map'; drawMap(); }))),
      !steps.length ? h('p', { class: 'card empty', 'data-test': 'steps-empty' }, 'Add the first step: what happens, and who does it. Rough times are fine; the guide points out missing ones.')
        : ui.view === 'map' ? lanes(steps, a, colour, m) : stepList(steps, a, colour, m));

    const editor = stepEditor(m, v.steps); // the form works in minutes, on the stored steps
    const layout = h('div', { class: 'pm-layout' },
      h('div', { class: 'pm-main' }, stats, bars), h('div', { class: 'pm-guide' }, guide), h('div', { class: 'pm-steps' }, stepsBox, editor));
    // On a phone the guide switch sits in the Guide card of an open map, so the map starts at its
    // title and the answer is on the first screen (at the card's foot, clear of the short messages). It is the same button either way.
    if (phone()) guide.append(h('div', { class: 'guide-head in-card' }, guideBtn, h('span', { class: 'meta' }, 'People decide; Ospeli suggests.')));
    else if (guideBtn.parentNode !== guideHome) guideHome.prepend(guideBtn);
    body.replaceChildren(head, layout);
  }

  function lanes(steps, a, colour, m) {
    const roles = [...new Set(steps.map((s) => s.role))];
    const grid = h('div', { class: 'lanegrid', style: `grid-template-columns: 120px repeat(${steps.length}, 172px)` });
    roles.forEach((r, ri) => {
      grid.append(h('div', { class: 'lanename', style: `grid-row:${ri + 1};grid-column:1` }, h('span', { class: 'role-dot', style: `background:${colour(r)}` }), r));
      steps.forEach((s, i) => {
        const cell = h('div', { class: 'cell', style: `grid-row:${ri + 1};grid-column:${i + 2}` });
        if (s.role === r) cell.append(stepCard(s, i, a, colour, m));
        grid.append(cell);
      });
    });
    return h('div', {},
      h('p', { class: 'meta scroll-hint' }, 'Scroll sideways for later steps. Tap a step to change it.'),
      h('div', { class: 'lanes', tabindex: '0', role: 'region', 'aria-label': 'Swimlane map, scroll sideways for later steps' }, grid));
  }
  function stepCard(s, i, a, colour, m) {
    const hot = isHot(a, s); const note = changedNote(s, m);
    return h('button', { type: 'button', class: `pm-step${hot ? ' hot' : ''}${s.par ? ' par' : ''}${note ? ' changed' : ''}`, style: `border-left-color:${colour(s.role)}`, 'data-step': s.id,
      'aria-label': `Step ${i + 1}: ${s.name}, ${s.role}, waits ${waitOf(s)}, work ${workOf(s)}. Change it.`, onclick: () => edit(s.id) },
      h('span', { class: 'n' }, `Step ${i + 1}`), s.name, note,
      h('span', { class: 't' }, s.wait || rangeOf ? h('span', { class: `wt${s.plannedWait ? ' planned' : ''}` }, `waits ${waitOf(s)}${s.plannedWait ? ' (planned)' : ''}`) : null, h('span', {}, `work ${workOf(s)}`)));
  }
  // How a step's wait and hands-on time read: one time, or the range across the walks with the
  // number of walks it rests on when that is not all of them.
  const stepRange = (s) => (rangeOf ? rangeOf.get(s.id) || null : null);
  const waitOf = (s) => { const r = stepRange(s); return r ? `${fmtRange(r.wait, { count: false })}${r.wait.n && r.wait.n < r.of ? ` (${r.wait.n} of ${r.of} walks)` : ''}` : T(s.wait); };
  const workOf = (s) => { const r = stepRange(s); return r ? fmtRange(r.work, { count: false }) : T(s.work); };
  const walksNote = (s) => { const r = stepRange(s); if (!r) return ''; return `${r.happened < r.of ? ` · on ${r.happened} of ${r.of} walks` : ''}${r.again ? ` · done again on ${r.again} ${r.again === 1 ? 'walk' : 'walks'}` : ''}`; };
  // The wait before a step. On a walked map it opens one choice: mark the wait as planned or
  // required (ospeli_maps_step_update with plannedWait). Two taps; the rule is shown with the choice.
  function waitLine(s, hot, m) {
    const seen = s.waitNotSeenSec ? ` or more · ${T(s.waitNotSeenSec)} more not seen` : '';
    const r = stepRange(s);
    if (!r && !(s.wait || s.par || s.waitNotSeenSec || s.plannedWait)) return null;
    const text = r ? `Waits ${waitOf(s)}${s.plannedWait ? ' · planned or required' : ''}${hot ? ' · longest wait' : ''}` : s.par ? `Starts alongside the step before${s.wait ? `, after ${T(s.wait)}` : ''}`
      : `Waits ${T(s.wait)}${seen}${s.plannedWait ? ' · planned or required' : ''}${hot ? (T === fmtSeconds ? ' · the longest wait on this walk' : ' · the biggest wait') : ''}`;
    const cls = `wait${hot ? ' hot' : ''}${s.plannedWait ? ' planned' : ''}`;
    if (!walkedNow || s.par) return h('div', { class: cls }, text);
    const open = ui.waitOpen === s.id;
    const mark = async () => {
      if (await run('ospeli_maps_step_update', { mapId: m.id, version: ui.version, stepId: s.id, plannedWait: !s.plannedWait, expectedRevision: m.revision })) {
        ui.waitOpen = null; ctx.toast(s.plannedWait ? 'Mark removed.' : 'Marked as planned or required. It still counts as waiting.'); drawMap();
      }
    };
    return h('div', { class: `${cls} wait-pick` },
      h('button', { type: 'button', class: 'wait-btn', 'data-test': 'wait-btn', 'aria-expanded': String(open), onclick: () => { ui.waitOpen = open ? null : s.id; drawMap(); } }, text, h('span', { class: 'wait-more', 'aria-hidden': 'true' }, open ? ' ▴' : ' ▾')),
      open ? h('div', { class: 'wait-choice', 'data-test': 'wait-choice' },
        h('p', {}, s.plannedWait ? 'This wait is marked planned or required. It still counts as waiting and is left out of the longest wait.' : PLANNED_WAIT_RULE),
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'wait-planned', 'data-cmd': 'ospeli_maps_step_update', onclick: mark }, s.plannedWait ? 'Remove the mark' : 'Planned or required wait')) : null);
  }
  function stepList(steps, a, colour, m) {
    return h('ol', { class: 'pm-list', 'data-test': 'step-list' }, steps.map((s, i) => {
      const hot = isHot(a, s);
      const mv = (dir) => async () => { if (await run('ospeli_maps_step_move', { mapId: m.id, version: ui.version, stepId: s.id, direction: dir, expectedRevision: m.revision })) drawMap(); };
      return h('li', { 'data-step': s.id },
        waitLine(s, hot, m),
        changedNote(s, m),
        h('div', { class: `row${changedNote(s, m) ? ' changed' : ''}` },
          h('span', { class: 'num' }, String(i + 1)),
          h('div', { class: 'what' }, h('b', {}, s.name),
            h('span', {}, h('span', { class: 'role-dot', style: `background:${colour(s.role)}` }), `${s.role} · ${T === fmtSeconds ? 'hands-on' : 'work'} ${workOf(s)}${walksNote(s)}${s.msg ? ' · passes on information' : ''}${rangeOf ? '' : s.interrupted ? ' · interrupted' : ''}${s.workNotSeenSec ? ` · ${T(s.workNotSeenSec)} more not seen` : ''}${s.edited ? ' · time changed by hand' : ''}${T === fmtSeconds && s.waitSec == null && s.workSec == null && !s.edited ? ' · added by hand' : ''}`)),
          h('div', { class: 'ctl' },
            h('button', { type: 'button', class: 'icon', 'data-cmd': 'ospeli_maps_step_move', 'aria-label': `Move step ${i + 1} up`, disabled: i === 0 ? true : null, onclick: mv('up') }, '↑'),
            h('button', { type: 'button', class: 'icon', 'data-cmd': 'ospeli_maps_step_move', 'aria-label': `Move step ${i + 1} down`, disabled: i === steps.length - 1 ? true : null, onclick: mv('down') }, '↓'),
            h('button', { type: 'button', class: 'icon', 'aria-label': `Change step ${i + 1}`, onclick: () => edit(s.id) }, '✎'))));
    }));
  }
  // In Proposed, say what differs from Today for a step (same step id), in plain words.
  function changedNote(s, m) {
    if (ui.version !== 'proposed') return null;
    const was = todayView.find((x) => x.id === s.id);
    if (!was) return h('div', { class: 'changed-note' }, 'New in Proposed');
    const bits = [];
    if (was.wait !== s.wait) bits.push(`wait ${T(was.wait)} → ${T(s.wait)}`);
    if (was.work !== s.work) bits.push(`work ${T(was.work)} → ${T(s.work)}`);
    if (!was.par && s.par) bits.push('now starts alongside the step before');
    if (was.name !== s.name || was.role !== s.role) bits.push('wording or role changed');
    return bits.length ? h('div', { class: 'changed-note' }, `Changed in Proposed: ${bits.join(', ')}`) : null;
  }
  function edit(stepId) { ui.editing = stepId; drawMap().then(() => { const f = document.getElementById('st-name'); if (f) { f.focus(); f.scrollIntoView({ block: 'center' }); } }); }

  function stepEditor(m, steps) {
    const s = steps.find((x) => x.id === ui.editing) || null;
    // On a map with two or more walks the list is shared by every walk: a name or role can change, measured times cannot.
    const locked = !!rangeOf;
    const num = (id, label, val) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, type: 'number', min: '0', max: '10080', step: '1', inputmode: 'numeric', placeholder: 'e.g. 15', value: val ? String(val) : null, disabled: locked && s ? true : null }));
    const roles = [...new Set([...m.today.steps, ...m.proposed.steps].map((x) => x.role))];
    const form = h('form', { class: 'card step-form', 'data-test': 'step-form', 'aria-labelledby': 'st-h' },
      h('h3', { id: 'st-h' }, s ? `Change step ${steps.indexOf(s) + 1}` : `Add a step to ${ui.version === 'proposed' ? 'Proposed' : NOW}`),
      h('div', { class: 'field' }, h('label', { for: 'st-name' }, 'What happens'), h('input', { id: 'st-name', maxlength: '140', required: true, value: s?.name || '', placeholder: 'e.g. Bed cleaned', 'aria-describedby': 'st-shared' }),
        h('p', { class: 'field-note', id: 'st-shared', 'data-test': 'shared-note' }, 'No names or numbers of patients or staff. A map is shared with everyone who uses this site\'s data.')),
      h('div', { class: 'field' }, h('label', { for: 'st-role' }, 'Who does it (a role, never a name)'), h('input', { id: 'st-role', maxlength: '140', required: true, list: 'st-roles', value: s?.role || '', placeholder: 'e.g. Housekeeping' }),
        h('datalist', { id: 'st-roles' }, roles.map((r) => h('option', { value: r })))),
      locked ? h('p', { class: 'field-note', 'data-test': 'list-shared' }, s ? 'A name or role changes for every walk. Measured times cannot be changed here.' : 'A step added here was not timed on any walk. It is on the list for the next walk.') : null,
      locked && !s ? null : h('div', { class: 'two' }, num('st-wait', 'Waiting before (min)', s?.wait), num('st-work', 'Hands-on (min)', s?.work)),
      h('label', { class: 'check' }, h('input', { id: 'st-msg', type: 'checkbox', checked: s?.msg ? true : null }), 'Only passes on information (a call, message or form)'),
      h('label', { class: 'check' }, h('input', { id: 'st-par', type: 'checkbox', checked: s?.par ? true : null }), 'Starts alongside the step before'),
      h('div', { class: 'form-actions' },
        h('button', { type: 'submit', class: 'btn', 'data-cmd': s ? 'ospeli_maps_step_update' : 'ospeli_maps_step_add' }, s ? 'Save step' : 'Add step'),
        s ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.editing = null; drawMap(); } }, 'Cancel') : null,
        s ? h('button', { type: 'button', class: 'btn btn-danger', 'data-cmd': 'ospeli_maps_step_remove',
          onclick: async () => { if (await run('ospeli_maps_step_remove', { mapId: m.id, version: ui.version, stepId: s.id, expectedRevision: m.revision })) { ui.editing = null; ctx.toast('Step removed.'); drawMap(); } } }, 'Remove') : null));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = (id) => form.querySelector(`#${id}`);
      const input = { mapId: m.id, version: ui.version, name: val('st-name').value.trim(), role: val('st-role').value.trim(),
        wait: Math.max(0, Math.round(+(val('st-wait')?.value) || 0)), work: Math.max(0, Math.round(+(val('st-work')?.value) || 0)),
        msg: val('st-msg').checked, par: val('st-par').checked, expectedRevision: m.revision };
      // A change sends only the wording that changed, so a step already saved is not asked about again.
      if (s) { if (input.name === s.name) delete input.name; if (input.role === s.role) delete input.role; }
      const send = async (extra = {}) => {
        if (ui.busy) return;
        ui.busy = true;
        let out = null;
        try {
          out = s ? await ctx.run('ospeli_maps_step_update', { ...input, ...extra, stepId: s.id }) : await ctx.run('ospeli_maps_step_add', { ...input, ...extra });
        } catch (err) {
          // The command asks once when the text may hold a name with no title (issue #38).
          const looks = err.detail?.confirm === 'notAName' ? err.detail.looksLike : (/"notAName": true/.test(err.message) ? (/\("([^"]+)"\)/.exec(err.message) || [])[1] : null);
          if (looks) askAboutName(looks, send); else ctx.toast(`Not saved. ${err.message}`);
          return;
        } finally { ui.busy = false; }
        if (out) { ctx.toast(s ? 'Step saved.' : 'Step added.'); ui.editing = null; await drawMap(); }
      };
      await send();
    });
    // The question sits in the form, above the buttons: nothing is saved until one is chosen.
    function askAboutName(looks, send) {
      form.querySelector('[data-test="name-question"]')?.remove();
      const close = () => box.remove();
      const box = h('div', { class: 'name-question', role: 'alert', 'data-test': 'name-question' },
        h('p', {}, h('b', {}, `Is \u201c${looks}\u201d a person's name?`)),
        h('p', {}, 'A map is shared, and Ospeli times steps, never people. Use a role instead, for example Doctor, Charge nurse or Pharmacy.'),
        h('div', { class: 'form-actions' },
          h('button', { type: 'button', class: 'btn', 'data-test': 'name-change', onclick: () => { close(); const f = form.querySelector('#st-name'); f.focus(); f.scrollIntoView({ block: 'center' }); } }, 'Change the wording'),
          h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'name-keep', onclick: () => { close(); send({ notAName: true }); } }, 'Not a name. Save it')));
      form.insertBefore(box, form.querySelector('.form-actions'));
      box.scrollIntoView({ block: 'center' });
    }
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
  return () => { off(); clearTimeout(t); if (walkOff) walkOff(); };
}
