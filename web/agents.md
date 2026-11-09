# Ospeli for AI agents

Ospeli is a healthcare operations platform: beds, engineering work orders, emergency department flow, process maps and the numbers that go with them. The bed board is one module. This guide says how an AI agent working for a member of staff may use Ospeli, and what it may not do.

The public demo at https://ospeli.com/app/ holds **synthetic data only** (the fictional Example General Hospital). Never put real patient, staff or hospital data into it.

## The rules
1. **People decide, Ospeli suggests.** You may read, and you may *propose* a change. A proposal changes nothing until a person accepts it. You never write to the event log yourself.
2. **No clinical decisions.** Ospeli is about operations (beds, queues, faults, handoffs), not diagnosis or treatment. Do not use it to recommend care.
3. **Access is off by default,** for the hospital and for each ward. Only a person (operations manager or chief operating officer) can switch it on, with `agents.set-access`. Agents cannot.
4. **You act under your own name, for a role.** Every read, proposal and refusal is in the audit trail with actor type `agent`, your agent name and the role you act for. Name yourself honestly.
5. **Patient data stays on site.** Ospeli runs on the hospital's own devices or server. Do not copy data out of it to a cloud service.
6. **Measure flows, never people.** Report beds, queues and waits by role and place, never by named person.

## How to call Ospeli (in the browser)
The app exposes one small, read-only-by-design object, `window.ospeli`:

```js
window.ospeli.commands();                      // every command: schemas, roles, approval rule, example
window.ospeli.describe('bed.allocate');        // one command
await window.ospeli.run('beds.board', { wardId: 'ward-a1' }, { agent: 'flow-helper', role: 'bed-manager' });
```

- Reads (`beds.board`, `bed.get`, `kpi.list`, `kpi.value`, `agents.access`, `proposals.list`) return plain JSON with stable ids, a `synthetic` flag and, for numbers, the KPI definition beside the value.
- Writes (for example `bed.allocate`) return `{ status: "proposed", proposal: { id } }`. A person sees it on the bed board under "Agent proposals" and accepts or declines it. Check the outcome with `proposals.list`: `accepted`, `declined` (with a reason) or `expired` (the bed changed before anyone accepted, so nothing was done).
- Pass `expectedState` with a write when you know the bed's state; a stale request is refused with `conflict` instead of acting on old data.
- A refused call throws an error with `.code`: `invalid-input`, `unknown-command`, `forbidden`, `not-found`, `conflict` or `agents-off`.
- The page does not expose its storage. Use the commands; there is no other supported way in.

Full list: [app/api/README.md](app/api/README.md) and the JSON schemas in [app/api/commands.json](app/api/commands.json).

## Coming next
A local MCP server that runs on the hospital's own server next to the app, with a per-agent key issued by the hospital and the same audit and approval rules. Until then, the browser API above is the only agent interface.
