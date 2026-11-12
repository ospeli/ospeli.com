# Ospeli for AI agents

Ospeli is a healthcare operations platform. Built today: beds, engineering work orders, process maps and the numbers that go with them. Other areas, such as emergency department flow, are previews on fictional data. The bed board is one module. This guide says how an AI agent working for a member of staff may use Ospeli, and what it may not do.

The public demo at https://ospeli.com/app/ holds **synthetic data only** (the fictional Example General Hospital). Never put real patient, staff or hospital data into it.

## The rules
1. **People decide, Ospeli suggests.** You may read, and you may *propose* a change. A proposal changes nothing until a person accepts it. You never write to the event log yourself.
2. **No clinical decisions.** Ospeli is about operations (beds, queues, faults, handoffs), not diagnosis or treatment. Do not use it to recommend care.
3. **Access is off by default,** for the hospital and for each ward. Only a person (operations manager or chief operating officer) can switch it on, on the Agents screen (`ospeli_agents_set_access`). Agents cannot. The dial has two settings today: Off and Advise (read and propose). Anyone on site can stop every agent in one tap (`ospeli_agents_stop_all`).
4. **You must be on the site's list.** A person adds each agent (`ospeli_agents_add`) with its name, the one role it works for, the wards it may see and an end date of 90 days at most. If you are not listed, are past your end date or claim another role, the call is refused with `forbidden` and the message says why. In the browser demo agents are named, not verified: there are no secret keys yet (keys are planned with the site server).
5. **You act under your own name, for a role.** Every read, proposal and refused call is in the audit trail with actor type `agent`, your agent name and the role you act for. Name yourself honestly.
6. **Patient data stays on site.** Ospeli is designed to run on the hospital's own devices or server; today the demo runs in the browser and its data stays on that device. Do not copy data out of it to a cloud service. Export today is one JSON file; FHIR and CSV export and sync between devices are planned, not built.
7. **Measure flows, never people.** Report beds, queues and waits by role and place, never by named person. Process maps refuse a named person as a step or role.

## How to call Ospeli (in the browser)
The app exposes one small, read-only-by-design object, `window.ospeli`:

```js
window.ospeli.commands();                      // every command: schemas, roles, approval rule, example
window.ospeli.describe('ospeli_beds_allocate');        // one command
await window.ospeli.run('ospeli_beds_board', { wardId: 'ward-a1' }, { agent: 'flow-helper', role: 'bed-manager' });
```

- Reads (for example `ospeli_beds_board`, `ospeli_workorders_list`, `ospeli_maps_list`, `ospeli_kpi_get`, `ospeli_agents_access`, `ospeli_proposals_list`) return plain JSON with stable ids, a `synthetic` flag and, for numbers, the KPI definition beside the value.
- Writes (for example `ospeli_beds_allocate`, `ospeli_workorders_report_fault`, `ospeli_maps_step_add`) return `{ status: "proposed", proposal: { id } }`. A person sees it in the app under "Agent proposals" and accepts or declines it. Check the outcome with `ospeli_proposals_list`: `accepted`, `declined` (with a reason) or `expired` (the bed changed before anyone accepted, so nothing was done).
- **Start with the task-shaped reads.** `ospeli_beds_find_free` answers "which beds are free for this patient, and who has waited longest" in one call and gives the allocate command to propose next. `ospeli_workorders_list` with `overdue: true` and a `locationId` answers "what is overdue here". `ospeli_maps_summary` gives a process map's numbers, its biggest wait and the guide's top suggestions.
- List reads take a `limit` and return `total` and `truncated`; most take `format: "short"`. Ask for the short format unless you need every field.
- Errors say how to fix the call: a wrong ward, place or map id comes back with the ids you may use.
- Command names are `ospeli_<module>_<action>`. The dotted names used before 12 November 2026 (`beds.board`, `bed.allocate`) still work in this build and are listed as `deprecatedName` in `commands.json`; the audit trail records the new name. Use the new names.
- Pass `expectedState` with a write when you know the bed's state; a stale request is refused with `conflict` instead of acting on old data.
- A refused call throws an error with `.code`: `invalid-input`, `unknown-command`, `forbidden`, `not-found`, `conflict` or `agents-off`.
- The page does not expose its storage. Use the commands; there is no other supported way in.

Every command, with its schema, roles and whether agents may call it (the list here is not complete; that file is generated from the code): [app/api/README.md](app/api/README.md) and the JSON schemas in [app/api/commands.json](app/api/commands.json).

## Preview pages are not the agent API
Each preview under `/demo/` has a small page object (for example `window.ospeliEdFlowDemo`) so its fictional data can be read. These are preview only, not the agent API: they sit outside the command layer, the access rules and the audit trail, and they will go when the area is built in the app. Start from `commands.json`.

## Coming next
A local MCP server that runs on the hospital's own server next to the app, with a per-agent key issued by the hospital and the same audit and approval rules. Until then, the browser API above is the only agent interface.
