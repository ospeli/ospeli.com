// Agents (issues #25, #20; spec A9, first step): a person sets the dial. Off by default.
// Advise: agents on this site's list may read and suggest; a person accepts or declines.
// Everything here calls a command (agents.list, agents.set-access, agent.add, agent.remove,
// agents.stop-all); the same commands are in api/commands.json. Agents cannot run any of them.
import { h } from './ui.js';
import { ROLES, roleById } from '../core/model.js';
import { since } from '../core/beds.js';
import { MAX_AGENT_DAYS } from '../core/commands.js';

const ADMIN_NAMES = ['ops-manager', 'coo'].map((r) => roleById(r).name).join(' or ');
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function render(el, ctx) {
  const wards = (await ctx.core.listEntities('ward')).sort((a, b) => a.name.localeCompare(b.name));
  const wardName = (id) => wards.find((w) => w.id === id)?.name || id;
  const body = h('div', { 'data-test': 'agents' });
  const status = h('p', { class: 'ag-status', role: 'status', 'data-test': 'agents-status' });
  const dialog = h('dialog', { class: 'kpi-dialog ag-dialog', 'aria-labelledby': 'ag-dlg-h' });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  let wardsOpen = false;
  let busy = false;

  async function act(name, input, done) {
    if (busy) return;
    busy = true;
    try {
      await ctx.run(name, input);
      status.textContent = done;
    } catch (err) {
      status.textContent = `Not saved. ${err.message}`;
    } finally {
      busy = false;
      await draw();
    }
  }

  function openAdd(view) {
    const name = h('input', { id: 'ag-name', type: 'text', maxlength: 41, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'night-flow-helper' });
    const role = h('select', { id: 'ag-role' }, ROLES.map((r) => new Option(r.name, r.id)));
    const days = h('select', { id: 'ag-days' }, [[7, '7 days'], [30, '30 days'], [MAX_AGENT_DAYS, `${MAX_AGENT_DAYS} days (the most)`]].map(([v, t]) => new Option(t, v, v === 30, v === 30)));
    const ticks = wards.map((w) => h('label', { class: 'ag-tick' },
      h('input', { type: 'checkbox', value: w.id }), h('span', {}, w.name, view.wards[w.id] === true ? '' : ' (switched off)')));
    const err = h('p', { class: 'ag-err', role: 'alert' });
    const save = async () => {
      const input = { name: name.value.trim(), role: role.value, days: +days.value, wards: ticks.map((t) => t.firstChild).filter((c) => c.checked).map((c) => c.value) };
      if (!input.name) { err.textContent = 'Give the agent a name.'; name.focus(); return; }
      try {
        await ctx.run('agent.add', input);
        dialog.close();
        status.textContent = `${input.name} is on the list. It can read and suggest for ${roleById(input.role).name} until ${day(new Date(Date.now() + input.days * 864e5).toISOString())}.`;
        await draw();
      } catch (e) {
        err.textContent = /pattern/.test(e.message) ? 'Use 2 to 41 letters, numbers, spaces, dots or dashes for the name.' : e.message;
      }
    };
    dialog.replaceChildren(
      h('h2', { id: 'ag-dlg-h' }, 'Add an agent'),
      h('div', { class: 'field' }, h('label', { for: 'ag-name' }, 'Name'), name, h('span', { class: 'ag-hint' }, 'The name the agent gives when it calls. Say what it does; never a person\'s name.')),
      h('div', { class: 'field' }, h('label', { for: 'ag-role' }, 'Works for'), role, h('span', { class: 'ag-hint' }, 'One role. The agent can do no more than this role can, and can only suggest.')),
      h('fieldset', { class: 'ag-wards-pick' }, h('legend', {}, 'Wards it may see'), ticks,
        h('span', { class: 'ag-hint' }, 'Tick none for an agent that needs no ward data, such as one that reads process maps.')),
      h('div', { class: 'field' }, h('label', { for: 'ag-days' }, 'Stops working after'), days),
      err,
      h('div', { class: 'form-actions ag-dialog-actions' },
        h('button', { class: 'btn', type: 'button', 'data-cmd': 'agent.add', onclick: save }, 'Add agent'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Cancel')));
    dialog.showModal();
    name.focus();
  }

  async function draw() {
    const view = await ctx.run('agents.list', {});
    const on = view.dial === 'advise';
    const can = view.canChange;
    const now = Date.now();
    const onCount = wards.filter((w) => view.wards[w.id] === true).length;
    const seen = new Map(view.recent.map((r) => [r.agent.toLowerCase(), r]));

    const dialBtn = (id, label, text) => h('button', {
      type: 'button', class: 'ag-dial-btn', 'data-dial': id, 'aria-pressed': String(view.dial === id), disabled: !can && view.dial !== id,
      'data-cmd': 'agents.set-access',
      onclick: () => {
        if (view.dial === id) return;
        if (!can) return;
        if (id === 'advise') {
          if (!confirm('Turn agents on to Advise?\n\nAgents on your list can read and suggest. Nothing changes until a person accepts.')) return;
          act('agents.set-access', { allowed: true }, 'Agents are on: Advise. Next, choose where they can work and add an agent.');
        } else {
          act('agents.set-access', { allowed: false }, 'Agents are off. Nothing was changed.');
        }
      },
    }, h('b', {}, label, view.dial === id ? h('span', { class: 'pill pill-ok' }, 'Now') : null), h('span', {}, text));

    const stop = on ? h('button', { type: 'button', class: 'btn ag-stop', 'data-cmd': 'agents.stop-all', 'data-test': 'agents-stop',
      onclick: () => act('agents.stop-all', {}, 'Stopped. Every agent is off, on every ward. Nothing else was changed.') }, 'Stop all agents') : null;

    const wardRows = wards.map((w) => {
      const isOn = view.wards[w.id] === true;
      return h('li', { class: 'ag-row' },
        h('span', {}, w.name),
        h('button', { type: 'button', class: 'ag-switch', 'aria-pressed': String(isOn), 'aria-label': `${w.name}: agents ${isOn ? 'on' : 'off'}`, 'data-ward': w.id, disabled: !can, 'data-cmd': 'agents.set-access',
          onclick: () => act('agents.set-access', { allowed: true, wards: { [w.id]: !isOn } }, `${w.name}: agents ${isOn ? 'off' : 'on'}.`) }, isOn ? 'On' : 'Off'));
    });
    const wardBox = h('details', { class: 'ag-details', 'data-test': 'agents-wards' },
      h('summary', {}, h('b', {}, 'Where agents can work'), h('span', {}, `${onCount} of ${wards.length} wards on`)),
      h('p', { class: 'ag-text' }, 'Turning a ward on lets the agents you allow read that ward\'s operational data, including bed and patient-flow details. They still cannot change anything. Wards are off until you turn them on.'),
      h('ul', { class: 'ag-list' }, wardRows));
    wardBox.open = wardsOpen;
    wardBox.addEventListener('toggle', () => { wardsOpen = wardBox.open; });

    const agentRows = view.agents.map((a) => {
      const r = seen.get(a.name.toLowerCase());
      const did = r ? `Last active ${since(r.lastAt, now)} ago: ${plural(r.reads, 'read')}, ${plural(r.proposals, 'suggestion')}, ${r.refused} refused` : 'Not used in the last 7 days';
      return h('li', { class: 'ag-row ag-agent', 'data-agent': a.name },
        h('div', {},
          h('b', {}, a.name, a.ended ? h('span', { class: 'pill pill-bad' }, 'Ended') : null),
          h('span', {}, `Works for ${a.roleName} · ${a.wards.length ? a.wards.map(wardName).join(', ') : 'no wards'} · ${a.ended ? 'ended' : 'ends'} ${day(a.until)}`),
          h('span', {}, did)),
        can ? h('button', { type: 'button', class: 'btn btn-ghost btn-small', 'data-cmd': 'agent.remove', 'aria-label': `Remove ${a.name}`,
          onclick: () => { if (confirm(`Remove ${a.name}? It stops at once.`)) act('agent.remove', { name: a.name }, `${a.name} removed. It is refused from now on.`); } }, 'Remove') : null);
    });
    const strangers = view.recent.filter((r) => !r.onList);

    body.replaceChildren(...[
      view.stopped ? h('p', { class: 'ag-banner', 'data-test': 'agents-stopped' }, `All agents stopped by ${view.stopped.byRoleName}, ${since(view.stopped.at, now)} ago.`) : null,
      h('section', { class: 'card ag-card', 'aria-labelledby': 'ag-dial-h' },
        h('h2', { id: 'ag-dial-h' }, 'Agents for this site'),
        h('div', { class: 'ag-dial', role: 'group', 'aria-labelledby': 'ag-dial-h', 'data-test': 'agents-dial', 'data-dial-now': view.dial },
          dialBtn('off', 'Off', 'Agents cannot read or suggest anything. Ospeli works fully without them.'),
          dialBtn('advise', 'Advise', 'Agents you allow can read and suggest. A person accepts or declines each one.')),
        stop,
        h('p', { class: 'ag-text' }, 'Today the dial stops at Advise. No agent can act by itself.'),
        can ? null : h('p', { class: 'ag-text', 'data-test': 'agents-readonly' }, `Only the ${ADMIN_NAMES} can change these settings.${on ? ' Anyone can stop all agents.' : ''}`)),
      on ? wardBox : null,
      on || view.agents.length ? h('section', { class: 'card ag-card', 'aria-labelledby': 'ag-list-h' },
        h('h2', { id: 'ag-list-h' }, `Agents you allow (${view.agents.length})`),
        view.agents.length ? h('ul', { class: 'ag-list', 'data-test': 'agents-list' }, agentRows)
          : h('p', { class: 'ag-text' }, 'No agents yet. An agent that is not on this list is refused.'),
        can ? h('button', { type: 'button', class: 'btn', 'data-test': 'agents-add', onclick: () => openAdd(view) }, 'Add an agent') : null) : null,
      strangers.length ? h('section', { class: 'card ag-card', 'data-test': 'agents-strangers' },
        h('h2', {}, 'Refused in the last 7 days'),
        h('p', { class: 'ag-text' }, 'These names tried to call and are not on your list. Each try is in the audit trail.'),
        h('ul', { class: 'ag-list' }, strangers.map((r) => h('li', { class: 'ag-row' }, h('span', {}, r.agent), h('span', {}, `${r.refused} refused · ${since(r.lastAt, now)} ago`))))) : null,
      h('details', { class: 'ag-details' },
        h('summary', {}, h('b', {}, 'What this list is, and is not')),
        h('p', { class: 'ag-text' }, 'The list is a control and a record, not security. This app runs in your browser with no server, so an agent gives its name and there is no secret key to check it. Keys are planned with the site server. Until then, treat agents here as named, not verified.'),
        h('p', { class: 'ag-text' }, 'Every agent read, suggestion and refused call is in the audit trail, marked as an agent. ', h('a', { href: '#/data' }, 'Open Data and audit'), '.')),
    ].filter(Boolean));
  }

  el.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'You set the dial'),
        h('h1', {}, 'Agents'),
        h('p', { class: 'ag-intro' }, 'Agents are AI helpers: programs that can look at beds, work orders and process maps and suggest changes. They are off until you turn them on, and nothing changes until a person accepts.'))),
    status, body, dialog);
  await draw();
  return () => { if (dialog.open) dialog.close(); };
}
