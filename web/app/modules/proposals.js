// "Suggested changes" card (issue #17; words from #86), shared by every module: what agents asked
// for, waiting for a person. Accept runs the command as that person; Decline takes a listed reason.
// On a connected device with no connection (html[data-site="offline"]) the buttons cannot be
// tapped and say "Not connected"; a change that fails says so inside the card (issue #86).
import { h } from './ui.js';
import { roleById } from '../core/model.js';
import { since } from '../core/beds.js';
import { declineReasonsFor } from '../core/commands.js';
import { MODULES } from './registry.js';

const SHOW_FIRST = 3;

// describe(p) -> one line in plain words; match(p) -> whether this page shows it.
export function proposalsCard(ctx, { describe, match = () => true }) {
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
        ? 'A bot suggested these. Nothing changes until you say yes. Your yes is recorded under your role.'
        : `A bot suggested these. ${roleById(ctx.role).name} cannot decide on them.`),
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
const DECIDED_ON = [['ospeli_beds_', 'beds'], ['ospeli_workorders_', 'engineering'], ['ospeli_maps_', 'process'],
  ...MODULES.flatMap((m) => [].concat(m.commands || []).map((prefix) => [prefix, m.id]))];
export async function waitingDecisions(ctx) {
  let list = [];
  try { list = (await ctx.run('ospeli_proposals_list', { status: 'pending', limit: 200 })).proposals.filter((p) => p.canDecide); } catch { list = []; }
  const pages = DECIDED_ON.map(([prefix, id]) => ({ id, count: list.filter((p) => p.command.startsWith(prefix)).length })).filter((x) => x.count > 0);
  return { total: pages.reduce((n, x) => n + x.count, 0), pages };
}
export const proposalWords = (n) => `${n} proposal${n === 1 ? '' : 's'}`;
