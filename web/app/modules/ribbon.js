// The walk ribbon (navigation v2, ospeli/ospeli docs/design/navigation-v2.md "Walk ribbon"; issue #179).
// While a walk runs, every page but the full-screen walk shows a navy band above the dock (on a
// wide screen, at the foot of the page beside the rail): one segment per step, what is being
// walked, which step, the state in words and a clock, and the next tap as a button.
//
// It reads the walk only through ospeli_walks_get and taps only through the walk's own commands
// (ospeli_walks_step_start, ospeli_walks_step_done, ospeli_walks_resume), so the double-tap guard
// and every rule of the walk apply exactly as on the walk screen. It is drawn again when the walk
// changes (core.onChange) and on every change of page; the only timer is the 1 s clock.
// Text people typed (the walk's title, step names) is only ever set as text, never as HTML.
import { h } from './ui.js';
import { fmtClock } from '../core/walk.js';

const WALK_HREF = '#/process/walk';
const isUnnamedTitle = (t) => /^Walk \d+$/.test(t || '');

// What the band says and offers for one walk. Pure: the walk view from ospeli_walks_get in, words out.
export function ribbonModel(w) {
  const rp = w.repeat || null;
  const under = w.state === 'paused' ? w.under : w.state;
  const done = w.steps.length;
  const last = w.steps[done - 1] || null;
  const resume = under === 'waiting' && !!w.canResume;
  // The step this moment belongs to: the one running, the interrupted one carrying on, or the next.
  const item = rp ? (under === 'step' ? rp.now : resume ? null : rp.next) : null;
  const n = item ? item.n : resume ? last.n : done + 1;
  const name = item ? item.name : resume && last.named ? last.name : null;
  const of = rp && item ? rp.list.length : null;
  const title = isUnnamedTitle(w.title) && rp ? `Walk ${rp.walkNo}` : w.title;
  const words = w.state === 'paused' ? 'Paused'
    : under === 'step' ? `Hands-on: ${name || `step ${n}`}`
      : resume ? `Step ${n} interrupted` : name ? `Waiting before ${name}` : 'Waiting';
  // Segments: steps done, the present wait or step, then the list steps still to come (repeat walk only).
  const later = rp ? rp.list.filter((p) => (p.state === 'next' || p.state === 'later') && !(item && p.n === item.n)).length : 0;
  const segs = [...Array(done).fill('done'), w.state === 'paused' ? 'paused' : under === 'step' ? 'step' : 'wait', ...Array(later).fill('later')];
  // The next tap. A step done on a first walk (or off the list) still needs its name: the tap is
  // stamped here, then the walk opens with its naming sheet, as on the walk screen.
  let act;
  if (w.state === 'paused') act = { cmd: 'ospeli_walks_resume', input: {}, label: 'I am back', said: 'You are back.' };
  else if (under === 'step') act = { cmd: 'ospeli_walks_step_done', input: {}, label: `${name || 'Step'} done`, said: `${name || `Step ${n}`} done. Waiting.`, thenOpen: !(rp && rp.now) };
  else if (resume) act = { cmd: 'ospeli_walks_step_start', input: { resume: true }, label: `${name || 'Step'} carries on`, said: 'The same step carries on. Hands-on.' };
  else act = { cmd: 'ospeli_walks_step_start', input: {}, label: `${name || 'Step'} starts`, said: `${name || `Step ${n}`} started. Hands-on.`, unnamedBefore: !!last && !last.named ? last.n : null };
  return { title, n, of, words, segs, act, state: w.state };
}

// The clock: the present wait or step without the time not seen; while paused, the pause itself.
// The same reading as the walk screen (modules/walk.js), from the times the command gave.
export function shownSec(w, nowMs) {
  const since = (iso) => Math.max(0, (nowMs - Date.parse(iso)) / 1000);
  return w.state === 'paused' ? since(w.since) : Math.max(0, since(w.presentSince || w.since) - (w.sinceNotSeenSec || 0));
}

export function installRibbon(ctx, { toast }) {
  const root = document.documentElement;
  const segs = h('span', { class: 'wr-segs', 'aria-hidden': 'true' });
  const title = h('span', { class: 'wr-title', 'data-test': 'ribbon-title' });
  const step = h('span', { class: 'wr-step', 'data-test': 'ribbon-step' });
  const words = h('span', { class: 'wr-words', 'data-test': 'ribbon-words' });
  const clock = h('span', { class: 'wr-clock', 'data-test': 'ribbon-clock', 'aria-hidden': 'true' });
  const open = h('a', { class: 'wr-open', href: WALK_HREF, 'data-test': 'ribbon-open' },
    segs, h('span', { class: 'wr-line' }, title, step), h('span', { class: 'wr-line wr-now' }, words, h('span', { class: 'wr-dot', 'aria-hidden': 'true' }, ' · '), clock));
  const act = h('button', { type: 'button', class: 'wr-act', 'data-test': 'ribbon-act' }, 'Next tap');
  // Spoken when the state changes, never for the ticking clock.
  const said = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-test': 'ribbon-status' });
  const band = h('div', { class: 'walk-ribbon', id: 'walk-ribbon', role: 'region', 'aria-label': 'Walk running', 'data-test': 'walk-ribbon', hidden: true }, open, act, said);
  // A tap anywhere on the band but the button opens the walk.
  band.addEventListener('click', (e) => { if (!e.target.closest('.wr-act, .wr-open')) location.hash = WALK_HREF; });
  document.querySelector('#dock').before(band);
  const dockWalk = document.querySelector('#dock .dock-walk');
  const dockWord = dockWalk.querySelector('.dock-word');
  const live = h('span', { class: 'dock-live', 'aria-hidden': 'true' });

  let walk = null; let offset = 0; let model = null; let timer = null; let token = 0; let busy = false; let lastWords = null;

  const showClock = () => { if (walk) clock.textContent = fmtClock(shownSec(walk, Date.now() - offset)); };
  const room = () => root.style.setProperty('--ribbon', band.hidden ? '0px' : `${Math.ceil(band.getBoundingClientRect().height) + 8}px`);

  function draw() {
    const running = !!walk && walk.status === 'walking';
    band.hidden = !running;
    if (running) root.dataset.walkRunning = walk.state; else delete root.dataset.walkRunning;
    dockWalk.classList.toggle('is-running', running);
    if (running) { dockWalk.setAttribute('aria-label', 'Walk, running'); dockWord.textContent = 'Running'; dockWalk.prepend(live); } else { dockWalk.removeAttribute('aria-label'); dockWord.textContent = 'Walk'; live.remove(); }
    if (!running) { clearInterval(timer); timer = null; model = null; lastWords = null; room(); return; }
    model = ribbonModel(walk);
    band.dataset.state = model.state;
    segs.replaceChildren(...model.segs.map((s) => h('span', { class: `wr-seg is-${s}` })));
    title.textContent = model.title;
    step.textContent = ` · step ${model.n}${model.of ? ` of ${model.of}` : ''}`;
    words.textContent = model.words;
    open.setAttribute('aria-label', `Open the walk: ${model.title}, step ${model.n}${model.of ? ` of ${model.of}` : ''}, ${model.words}`);
    act.textContent = model.act.label;
    act.dataset.cmd = model.act.cmd;
    act.disabled = busy;
    showClock();
    if (!timer) timer = setInterval(showClock, 1000);
    const now = `${model.words}, step ${model.n}`;
    if (lastWords !== null && now !== lastWords) said.textContent = `Walk: ${model.words}.`;
    lastWords = now;
    room();
  }

  async function refresh() {
    const t = ++token;
    let out = null;
    try { out = await ctx.run('ospeli_walks_get', {}); } catch { out = null; }
    if (t !== token) return;
    walk = out?.walk || null;
    offset = out?.now ? Date.now() - Date.parse(out.now) : 0;
    draw();
  }

  act.addEventListener('click', async () => {
    if (busy || !model) return;
    const a = model.act;
    busy = true; act.disabled = true;
    try {
      const out = await ctx.run(a.cmd, a.input);
      walk = out.walk; draw();
      said.textContent = a.said;
      if (a.thenOpen) { location.hash = WALK_HREF; return; }
      toast(a.unnamedBefore ? `Saved: ${a.label.toLowerCase()}. Step ${a.unnamedBefore} has no name yet; name it on the map.` : `Saved: ${a.label.toLowerCase()}. Undo is on the walk.`);
    } catch (err) {
      toast(`Not saved. ${err.message}`);
    } finally { busy = false; act.disabled = false; refresh(); }
  });

  ctx.core.onChange(({ kind, detail }) => { if (kind === 'reset' || (kind === 'meta' && detail?.id === 'process-walks') || kind === 'events') refresh(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('resize', room);
  return { refresh };
}
