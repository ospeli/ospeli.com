# Ospeli command API

Generated from `core/commands.js` by `scripts/build-commands.mjs`. Do not edit by hand.
The full schemas and examples are in [commands.json](commands.json).

Every action in the app is a named command. The screens call these commands, and so can an agent working for a member of staff.

## Rules for agents
- People decide, Ospeli suggests: an agent may read, and its write commands become proposals that wait for a person.
- Agent access is off by default, for the hospital and for each ward (agents.set-access, people only).
- Every agent read, proposal and refusal is in the audit trail with actor type "agent", the agent name and the role it acts for.
- Nothing leaves the site: commands run on this device or the hospital's own server, never through a cloud relay.

## How to call
- In the browser: `window.ospeli.commands()`, `window.ospeli.describe(name)`, `await window.ospeli.run(name, input, { agent, role })`.
- A refused call throws an error with .code: invalid-input, unknown-command, forbidden, not-found, conflict or agents-off.
- Write commands take an optional `expectedState`: if the bed changed since you looked, the command is refused with `conflict` instead of acting on stale data.
- An agent's write returns `{ status: "proposed", proposal: { id } }`. A person accepts or declines it on the bed board (`proposal.accept`, `proposal.decline`); the agent reads the outcome with `proposals.list` (accepted, declined, or expired if the bed changed first).
- More for agents: [/agents.md](../../agents.md) and [/llms.txt](../../llms.txt).

## Commands (36)
| Command | Kind | Roles | Needs a person | What it does |
|---|---|---|---|---|
| `beds.board` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Live bed state for every ward (or one ward), the waiting-for-a-bed list and any conflicting events, derived from the event log. |
| `bed.get` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | One bed: its state and the commands the caller's role may run on it next. |
| `bed.flag-expected-discharge` | write | ward-nurse, bed-manager | yes (agents propose) | Flag that the patient in this bed is expected to go home today. |
| `bed.cancel-expected-discharge` | write | ward-nurse, bed-manager | yes (agents propose) | Cancel an expected discharge; the patient stays. |
| `bed.mark-vacated` | write | ward-nurse, bed-manager | yes (agents propose) | The patient has left: discharge them from the bed and mark it to clean. |
| `bed.start-clean` | write | ward-nurse, bed-manager | yes (agents propose) | Cleaning of a vacated bed has started. |
| `bed.finish-clean` | write | ward-nurse, bed-manager | yes (agents propose) | Cleaning is finished: the bed is ready for the next patient. |
| `bed.allocate` | write | bed-manager, ae-nic, ward-nurse | yes (agents propose) | Hold an available bed for a patient waiting for a bed. |
| `bed.cancel-allocation` | write | bed-manager, ae-nic, ward-nurse | yes (agents propose) | Release a held bed; the patient goes back on the waiting list. |
| `bed.admit` | write | ward-nurse, bed-manager | yes (agents propose) | The patient the bed was held for has arrived in it. |
| `bed.take-out-of-service` | write | ward-nurse, bed-manager, estates-tech | yes (agents propose) | Take an empty bed out of service, with a reason. |
| `bed.return-to-service` | write | ward-nurse, bed-manager, estates-tech | yes (agents propose) | Put an out-of-service bed back into use. |
| `kpi.list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Every KPI definition: numerator, denominator, exclusions, source standard, owner and target. |
| `kpi.value` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Calculate one KPI from the event log, with its definition beside the number. |
| `agents.access` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Whether agents may work on this hospital, and on which wards. Off by default. |
| `agents.set-access` | write | ops-manager, coo | yes (agents propose) | Switch agent access on or off for the hospital and for each ward. People only. |
| `proposals.list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Agent proposals and what happened to them. People see every proposal; an agent sees only its own. |
| `proposal.accept` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Accept an agent's proposal: its command runs now, as you, against the bed as the agent saw it. People only. |
| `proposal.decline` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Decline an agent's proposal, with a reason. Nothing changes. People only. |
| `assets.list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Assets that can have a fault, with where they are and the faults that can be reported for each. |
| `workorders.list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | The work-order queue: open (or completed) work orders with priority, team, SLA due time, overdue flag and repeat-fault count, most urgent first. |
| `fault.report` | write | ward-nurse, bed-manager, ae-nic, estates-tech, ops-manager | yes (agents propose) | Report a fault on an asset. Opens a work order with a priority and an SLA due time, and says if it is a repeat fault. |
| `workorder.assign` | write | estates-tech, ops-manager | yes (agents propose) | Assign (or re-assign) an open work order to a team. Teams, not named people. |
| `workorder.complete` | write | estates-tech | yes (agents propose) | Close a work order with its outcome: fixed, escalated or no fault found. |
| `maps.list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | The process maps on this device, with steps and start-to-finish time for Today and Proposed, plus the example processes a new map can start from. Read-only. |
| `map.get` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | One process map: its steps (Today and Proposed) and the numbers for each: start to finish, hands-on time, waiting, handoffs and the biggest wait. Use "short" for the numbers only. Read-only. |
| `map.suggest` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | The guide's suggestions for one version of a map: biggest waits, steps that only pass on information, handoffs, steps that could run alongside, missing times and walk questions. Each says why. Rule-based; empty when the guide is switched off. Suggests only; changes nothing. |
| `map.create` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Start a new process map, from one of the example processes (see maps.list) or blank. Proposed starts as a copy of Today. |
| `map.step.add` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Add a step to one version of a map: what happens, who does it, minutes waiting before it and hands-on minutes. Added at the end unless a position is given. |
| `map.step.update` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Change a step in one version of a map: its wording, who does it, its times or its flags. Only the fields given change. |
| `map.step.move` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Move a step one place up or down in one version of a map. |
| `map.step.remove` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Remove a step from one version of a map. |
| `map.try-suggestion` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Apply one of the guide's suggestions (from map.suggest on the proposed version, where tryable is true) to the Proposed version only. Today never changes. A what-if, not a prediction. |
| `map.hide-suggestion` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Hide one guide suggestion on this map (not useful here). Changes no steps. |
| `map.reset-proposed` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Throw away every change in the Proposed version: it becomes a copy of Today again, and hidden suggestions come back. |
| `map.guide.set` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Switch the process-map guide on or off on this device. With it off, maps, times and editing all still work. People only. |
