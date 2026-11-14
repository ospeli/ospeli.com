// "Agent proposals" card (issue #17), shared by every module: what agents asked for, waiting
// for a person. Accept runs the command as that person; Decline takes a listed reason.
import { h } from './ui.js';
import { roleById } from '../core/model.js';
import { since } from '../core/beds.js';
import { DECLINE_REASONS } from '../core/commands.js';

// describe(p) -> one line in plain words; match(p) -> whether this page shows it.
export function proposalsCard(ctx, { describe, match = () => true }) {
  const box = h('div', { 'data-test': 'proposals' });
  let list = [];
  let busy = false;

  async function load() {
    try { list = (await ctx.run('ospeli_proposals_list', { status: 'pending', limit: 200 })).proposals.filter(match); } catch { list = []; }
    render();
  }

  async function decide(p, verb, reason) {
    if (busy) return;
    busy = true;
    try {
      const out = verb === 'accept' ? await ctx.run('ospeli_proposals_accept', { id: p.id }) : await ctx.run('ospeli_proposals_decline', { id: p.id, reason });
      ctx.toast(out.status === 'accepted' ? `Accepted: ${describe(p)}`
        : out.status === 'expired' ? `Not done. ${out.message} The proposal is closed.` : `Declined: ${describe(p)}`);
    } catch (err) {
      ctx.toast(`Not saved. ${err.message}`);
    } finally {
      busy = false;
      await load();
    }
  }

  function render() {
    if (!list.length) { box.replaceChildren(); return; }
    const mine = list.filter((p) => p.canDecide);
    const now = Date.now();
    box.replaceChildren(h('section', { class: 'card proposals', 'aria-labelledby': 'prop-h' },
      h('h2', { id: 'prop-h' }, `Agent proposals (${list.length})`),
      h('p', { class: 'meta' }, mine.length
        ? 'An agent suggested these. Nothing changes until you accept. If you accept, it is recorded as done by you.'
        : `An agent suggested these. ${roleById(ctx.role).name} cannot decide on them.`),
      h('ul', { class: 'proposal-list' }, list.map((p) => {
        // Accept stands alone. The reason belongs to Decline, so it sits with it under a visible label.
        const selId = `why-${p.id}`;
        const sel = h('select', { id: selId, 'aria-label': `Reason to decline: ${describe(p)}` }, DECLINE_REASONS.map((r) => new Option(r, r)));
        return h('li', { class: 'proposal-item', 'data-proposal': p.id },
          h('div', {},
            h('b', {}, describe(p)),
            h('div', { class: 'meta' }, `Agent ${p.agent} for ${roleById(p.role)?.name || p.role} · ${since(p.at, now)} ago`)),
          p.canDecide ? h('div', { class: 'proposal-actions' },
            h('button', { class: 'btn btn-small proposal-yes', type: 'button', 'data-cmd': 'ospeli_proposals_accept', 'aria-label': `Accept: ${describe(p)}`, onclick: () => decide(p, 'accept') }, 'Accept'),
            h('div', { class: 'proposal-no' },
              h('label', { for: selId }, 'If no, why?'),
              sel,
              h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_proposals_decline', 'aria-label': `Decline: ${describe(p)}`, onclick: () => decide(p, 'decline', sel.value) }, 'Decline'))) : null);
      }))));
  }

  return { el: box, load };
}
