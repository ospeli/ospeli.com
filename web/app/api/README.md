# Ospeli command API

Generated from `core/commands.js` by `scripts/build-commands.mjs`. Do not edit by hand.
The full schemas and examples are in [commands.json](commands.json).

Every action in the app is a named command. The screens call these commands, and so can an agent working for a member of staff.

## Rules for agents
- People decide, Ospeli suggests: an agent may read, and its write commands become proposals that wait for a person.
- Agent access is off by default, for the hospital and for each ward (ospeli_agents_set_access, people only).
- Only agents on the site's list may call (ospeli_agents_add, people only): each has one role, its wards and an end date of 90 days at most. An agent that is not listed, is past its end date or claims another role is refused. Agents are named, not verified: the browser app has no secret keys; the first version of the site server gives each agent one.
- Anyone on site can stop every agent at once (ospeli_agents_stop_all); only the operations manager or chief operating officer can switch agents on again.
- Agent reads, proposals and refusals made through window.ospeli.run are designed to be recorded in the audit trail with actor type "agent", the agent name and the role it acts for.
- In the browser app these rules are kept by the app's own code and are not a security boundary: a script running in the page can load the app's modules and act as a person, and the trail would then record a person. The first version of the site server (tools/ospeli-server/, run on a site's own computer) checks agent keys and records every call made with a key as that agent, never as a person; sign-in for people is not built yet.
- Nothing leaves the site: commands run on this device or the hospital's own server, never through a cloud relay.

## How to call
- In the browser: `window.ospeli.commands()`, `window.ospeli.describe(name)`, `await window.ospeli.run(name, input, { agent, role })`.
- Command names are ospeli_<module>_<action>. The dotted names used before 12 Nov 2026 still work in this build; each is listed as deprecatedName. The audit trail and the proposal queue always record the new name. Use the new names.
- List reads take a limit and return total and truncated; most take format: "short". Start with the task-shaped reads: ospeli_beds_find_free, ospeli_workorders_list (overdue, locationId) and ospeli_maps_summary.
- A refused call throws an error with .code: invalid-input, unknown-command, forbidden, not-found, conflict or agents-off. Errors say how to fix the call: a wrong ward, place or map id comes back with the ids you may use.
- Write commands take an optional `expectedState`: if the bed changed since you looked, the command is refused with `conflict` instead of acting on stale data.
- An agent's write returns `{ status: "proposed", proposal: { id } }`. A person accepts or declines it on the bed board (`ospeli_proposals_accept`, `ospeli_proposals_decline`); the agent reads the outcome with `ospeli_proposals_list` (accepted, declined, or expired if the bed changed first).
- More for agents: [/agents.md](../../agents.md) and [/llms.txt](../../llms.txt).

## Commands (44)
| Command | Kind | Roles | Agents: needs a person | What it does |
|---|---|---|---|---|
| `ospeli_beds_board` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Live bed state for every ward (or one ward), the waiting-for-a-bed list and any conflicting events, derived from the event log. To find a free bed for a waiting patient use ospeli_beds_find_free instead: it answers in one short call. Read-only. |
| `ospeli_beds_get` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | One bed: its state and the commands the caller's role may run on it next. |
| `ospeli_beds_find_free` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Find a free bed for a patient who is waiting: the beds that are available now (the ward the patient was requested for first), and who has waited longest. One call instead of reading the whole board. It lists; it does not judge whether a bed suits a patient, and it holds nothing. To hold a bed, a person runs ospeli_beds_allocate (an agent's allocate becomes a proposal). Read-only. |
| `ospeli_beds_flag_expected_discharge` | write | ward-nurse, bed-manager | yes (agents propose) | Flag that the patient in this bed is expected to go home today. |
| `ospeli_beds_cancel_expected_discharge` | write | ward-nurse, bed-manager | yes (agents propose) | Cancel an expected discharge; the patient stays. |
| `ospeli_beds_mark_vacated` | write | ward-nurse, bed-manager | yes (agents propose) | The patient has left: discharge them from the bed and mark it to clean. |
| `ospeli_beds_start_clean` | write | ward-nurse, bed-manager | yes (agents propose) | Cleaning of a vacated bed has started. |
| `ospeli_beds_finish_clean` | write | ward-nurse, bed-manager | yes (agents propose) | Cleaning is finished: the bed is ready for the next patient. |
| `ospeli_beds_allocate` | write | bed-manager, ae-nic, ward-nurse | yes (agents propose) | Hold an available bed for a patient waiting for a bed. |
| `ospeli_beds_cancel_allocation` | write | bed-manager, ae-nic, ward-nurse | yes (agents propose) | Release a held bed; the patient goes back on the waiting list. |
| `ospeli_beds_admit` | write | ward-nurse, bed-manager | yes (agents propose) | The patient the bed was held for has arrived in it. |
| `ospeli_beds_take_out_of_service` | write | ward-nurse, bed-manager, estates-tech | yes (agents propose) | Take an empty bed out of service, with a reason. |
| `ospeli_beds_return_to_service` | write | ward-nurse, bed-manager, estates-tech | yes (agents propose) | Put an out-of-service bed back into use. |
| `ospeli_kpi_list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Every KPI definition: numerator, denominator, exclusions, source standard, owner and target. Use ospeli_kpi_get for a number. Read-only. |
| `ospeli_kpi_get` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Calculate one KPI from the event log, with its definition beside the number. |
| `ospeli_agents_access` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Whether agents may work on this hospital, and on which wards. Off by default. |
| `ospeli_agents_set_access` | write | ops-manager, coo | people only | Switch agent access on or off for the hospital and for each ward. People only. |
| `ospeli_agents_list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | people only | The Agents screen as data: the dial (off or advise), the agents this site allows, and what each agent did in the last 7 days. People only. |
| `ospeli_agents_add` | write | ops-manager, coo | people only | Put an agent on this site's list: its name, the one role it works for, the wards it may see and how many days until it ends (90 at most). Adding a name again replaces its entry. People only. |
| `ospeli_agents_remove` | write | ops-manager, coo | people only | Take an agent off this site's list. It is refused from its next call. Its proposals still waiting are marked so nobody accepts them without looking. People only. |
| `ospeli_agents_stop_all` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | people only | Stop every agent on this site now: the dial goes to off and every ward is switched off. Anyone can stop; only the operations manager or chief operating officer can start again. People only. |
| `ospeli_proposals_list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Agent proposals and what happened to them. People see every proposal; an agent sees only its own. |
| `ospeli_proposals_accept` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | people only | Accept an agent's proposal: its command runs now, as you, against the bed as the agent saw it. People only. |
| `ospeli_proposals_decline` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | people only | Decline an agent's proposal, with a reason. Nothing changes. People only. |
| `ospeli_assets_list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | Assets that can have a fault, with where they are and the faults that can be reported for each. Read-only. |
| `ospeli_workorders_list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | The work-order queue: open (or completed) work orders with priority, team, due time, overdue flag and repeat-fault count (failed again after a fix), overdue and most urgent first. For "what is overdue on this ward" pass overdue: true and locationId. Read-only. |
| `ospeli_workorders_report_fault` | write | ward-nurse, bed-manager, ae-nic, estates-tech, ops-manager | yes (agents propose) | Report a fault on an asset. Opens a work order with a priority and an SLA due time, and says if it is a repeat fault (failed again after a fix). If a work order is already open for the same fault on the same asset, nothing new is opened: the answer is a conflict that names it in detail.existing. |
| `ospeli_workorders_assign` | write | estates-tech, ops-manager | yes (agents propose) | Assign (or re-assign) an open work order to a team. Teams, not named people. |
| `ospeli_workorders_start` | write | estates-tech, ops-manager | yes (agents propose) | Start work on an open work order: it shows as In progress, so the rest of the team can see someone is on it. The log keeps the role, never a person. A job in progress can still be assigned to another team or closed. Starting a job that is already in progress, or completed, is refused. |
| `ospeli_workorders_next` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | What should this team do next? The suggested work order for a team, by a fixed rule (not AI): highest priority first, then the most late, then the oldest report. The answer says why, and its place in the line ("1 of 7"). skip moves on through the same line ("Pick another"). Jobs in progress are listed apart and never suggested. A person decides which job to start. Read-only. |
| `ospeli_workorders_complete` | write | estates-tech | yes (agents propose) | Close a work order with its outcome: fixed, escalated or no fault found. |
| `ospeli_maps_list` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | The process maps on this device, with steps and start-to-finish time for Today and Proposed, plus the example processes a new map can start from. Read-only. |
| `ospeli_maps_get` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | One process map: its steps (Today and Proposed) and the numbers for each: start to finish, hands-on time, waiting, handoffs and the biggest wait. Use "short" for the numbers only. Read-only. |
| `ospeli_maps_summary` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | One process map in one short call: the numbers for Today and Proposed, the difference between them, the biggest wait and the guide's top suggestions with their reasons. Use this to answer "where does the time go in this process?". For every step use ospeli_maps_get. Read-only; suggests only. |
| `ospeli_maps_suggest` | read | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | no | The guide's suggestions for one version of a map: biggest waits, steps that only pass on information, handoffs, steps that could run alongside, missing times and walk questions. Each says why. Rule-based; empty when the guide is switched off. Suggests only; changes nothing. |
| `ospeli_maps_create` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Start a new process map, from one of the example processes (see ospeli_maps_list) or blank. Proposed starts as a copy of Today. |
| `ospeli_maps_step_add` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Add a step to one version of a map: what happens, who does it, minutes waiting before it and hands-on minutes. Added at the end unless a position is given. |
| `ospeli_maps_step_update` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Change a step in one version of a map: its wording, who does it, its times or its flags. Only the fields given change. |
| `ospeli_maps_step_move` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Move a step one place up or down in one version of a map. |
| `ospeli_maps_step_remove` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Remove a step from one version of a map. |
| `ospeli_maps_try_suggestion` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Apply one of the guide's suggestions (from ospeli_maps_suggest on the proposed version, where tryable is true) to the Proposed version only. Today never changes. A what-if, not a prediction. |
| `ospeli_maps_hide_suggestion` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Hide one guide suggestion on this map (not useful here). Changes no steps. |
| `ospeli_maps_reset_proposed` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | yes (agents propose) | Throw away every change in the Proposed version: it becomes a copy of Today again, and hidden suggestions come back. |
| `ospeli_maps_guide_set` | write | ward-nurse, bed-manager, estates-tech, ae-nic, ops-manager, coo | people only | Switch the process-map guide on or off on this device. With it off, maps, times and editing all still work. People only. |
