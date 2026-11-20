// "Suggested changes" card (issue #17; words from #86), shared by every module: what agents asked
// for, waiting for a person. Accept runs the command as that person; Decline takes a listed reason.
// On a connected device with no connection (html[data-site="offline"]) the buttons cannot be
// tapped and say "Not connected"; a change that fails says so inside the card (issue #86).
import { h } from './ui.js';
import { roleById } from '../core/model.js';
import { since } from '../core/beds.js';
import { declineReasonsFor, commandByName } from '../core/commands.js';
import { MODULES } from './registry.js';
import { SCREENS, decideAt } from './screens.js';

const SHOW_FIRST = 3;

// describe(p) -> one line in plain words; match(p) -> whether this page shows it.
export function proposalsCard(ctx, { describe: describeOwn, match = () => true }) {
  // A card never shows a raw command name (#148): a page with no words of its own for a command
  // says what the command does, from its summary.
  const describe = (p) => {
    const s = describeOwn(p);
    if (s && s !== p.command && !/^ospeli_\w+$/.test(s)) return s;
    const what = (commandByName(p.command)?.summary || 'A change').split(/[.:]/)[0];
    return `Suggested: ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  };
  const box = h('div', { 'data-test': 'proposals' });
  let list = [];
  let busy = false;
  let showAll = false; // issue #72: the newest three first; the rest one tap away
  let msg = ''; // issue #86: why the last answer was not saved, shown in the card
  const offline = () => document.documentElement.dataset.site === 'offline';
  // Redraw when the device loses or gets back its connection; stop watching once the card is gone.
  const watch = new MutationObserver(() => { if (!box.isConnected) { watch.disconnect(); return; } render(); });
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-site'] });

  async function load() {
    try { list = (await ctx.run('ospeli_proposals_list', { status: 'pending', limit: 200 })).proposals.filter(match).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1)); } catch { list = []; }
    render();
  }

  async function decide(p, verb, reason) {
    if (busy) return;
    busy = true;
    try {
      const out = verb === 'accept' ? await ctx.run('ospeli_proposals_accept', { id: p.id }) : await ctx.run('ospeli_proposals_decline', { id: p.id, reason });
      msg = '';
      ctx.toast(out.status === 'accepted' ? `Accepted: ${describe(p)}`
        : out.status === 'expired' ? `Not done. ${out.message} The proposal is closed.` : `Declined: ${describe(p)}`);
    } catch (err) {
      msg = `Not saved. ${err.message}`;
    } finally {
      busy = false;
      await load();
    }
  }

  function render() {
    if (!list.length) { showAll = false; msg = ''; box.replaceChildren(); return; }
    const off = offline();
    const shown = showAll ? list : list.slice(0, SHOW_FIRST);
    const mine = list.filter((p) => p.canDecide);
    const now = Date.now();
    box.replaceChildren(h('section', { class: 'card proposals', 'aria-labelledby': 'prop-h' },
      h('h2', { id: 'prop-h' }, `Suggested changes (${list.length})`),
      h('p', { class: 'meta' }, mine.length
        ? 'An agent suggested these. Nothing changes until you say yes. Your yes is recorded under your role.'
        : `An agent suggested these. ${roleById(ctx.role).name} cannot decide on them.`),
      msg ? h('p', { class: 'proposal-msg', role: 'status', 'data-test': 'proposal-msg' }, msg) : null,
      h('ul', { class: 'proposal-list' }, shown.map((p) => {
        // Accept stands alone. The reason belongs to Decline, so it sits with it under a visible label.
        const selId = `why-${p.id}`;
        const sel = h('select', { id: selId, 'aria-label': `Reason to decline: ${describe(p)}` }, declineReasonsFor(p.command).map((r) => new Option(r, r)));
        return h('li', { class: 'proposal-item', 'data-proposal': p.id },
          h('div', {},
            h('b', {}, describe(p)),
            h('div', { class: 'meta' }, `Agent ${p.agent} for ${roleById(p.role)?.name || p.role} · ${since(p.at, now)} ago`)),
          p.canDecide ? h('div', { class: 'proposal-actions' },
            off ? h('span', { class: 'proposal-offline', 'data-test': 'proposal-offline' }, 'Not connected') : null,
            h('button', { class: 'btn btn-small proposal-yes', type: 'button', disabled: off, 'data-cmd': 'ospeli_proposals_accept', 'aria-label': `Accept: ${describe(p)}`, onclick: () => decide(p, 'accept') }, 'Accept'),
            h('div', { class: 'proposal-no' },
              h('label', { for: selId }, 'If no, why?'),
              sel,
              h('button', { class: 'btn btn-ghost btn-small', type: 'button', disabled: off, 'data-cmd': 'ospeli_proposals_decline', 'aria-label': `Decline: ${describe(p)}`, onclick: () => decide(p, 'decline', sel.value) }, 'Decline'))) : null);
      })),
      list.length > SHOW_FIRST ? h('button', { class: 'btn btn-ghost btn-small proposal-more', type: 'button', 'data-test': 'proposals-more', 'aria-expanded': String(showAll), onclick: () => { showAll = !showAll; render(); } },
        showAll ? `Show the newest ${SHOW_FIRST} only` : `See all ${list.length}`) : null));
  }

  return { el: box, load };
}

// Issue #52: which proposals wait for this role, by the page where each is decided. One read
// (ospeli_proposals_list already says canDecide); Today and the menu both use it.
// A module's page decides the proposals for its own commands (registry: `commands`, a prefix or a list of them).
// Issue #148: each line is the screen that shows the proposal with Accept and Decline, one line per
// screen however many command prefixes lead there, and a proposal no screen of this role shows is not counted.
const DECIDED_ON = [['ospeli_beds_', 'beds'], ['ospeli_workorders_', 'engineering'], ['ospeli_maps_', 'process'],
  ...MODULES.flatMap((m) => [].concat(m.commands || []).map((prefix) => [prefix, m.id]))];
const moduleOf = (command) => DECIDED_ON.find(([prefix]) => command.startsWith(prefix))?.[1] || null;
export async function waitingDecisions(ctx) {
  let list = [];
  try { list = (await ctx.run('ospeli_proposals_list', { status: 'pending', limit: 200 })).proposals.filter((p) => p.canDecide); } catch { list = []; }
  let linenIds = new Set();
  if (list.some((p) => p.command.startsWith('ospeli_stock_'))) {
    try { linenIds = new Set((await ctx.run('ospeli_stock_items', { category: 'linen', limit: 500 })).items.map((i) => i.id)); } catch { /* no linen on this site */ }
  }
  const byHref = new Map();
  for (const p of list) {
    const at = decideAt(p, ctx.role, moduleOf, { linenIds });
    if (!at) continue;
    const href = at.screen ? `#/${at.moduleId}/${at.screen}` : `#/${at.moduleId}`;
    const page = byHref.get(href) || { id: at.moduleId, screen: at.screen, screenName: at.screen ? SCREENS[at.moduleId].titles[at.screen] : null, href, count: 0 };
    page.count += 1;
    byHref.set(href, page);
  }
  // In the menu's order of modules, as before (#52), then by screen.
  const order = (id) => DECIDED_ON.findIndex(([, m]) => m === id);
  const pages = [...byHref.values()].sort((a, b) => order(a.id) - order(b.id) || String(a.screen).localeCompare(String(b.screen)));
  // The menu shows one count per module: the screens of one module added up.
  const modules = [];
  for (const x of pages) { const m = modules.find((y) => y.id === x.id); if (m) m.count += x.count; else modules.push({ id: x.id, count: x.count }); }
  return { total: pages.reduce((n, x) => n + x.count, 0), pages, modules };
}
export const proposalWords = (n) => `${n} proposal${n === 1 ? '' : 's'}`;
