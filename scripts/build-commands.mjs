// Writes web/app/api/commands.json and web/app/api/README.md from the command registry
// (core/commands.js), so the machine-readable spec can never drift from the code.
// `node scripts/build-commands.mjs --check` fails if the files are out of date, or if a
// command lacks a schema or an example (run by scripts/check.py).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listCommands } from '../web/app/core/commands.js';
import { validate } from '../web/app/core/schema.js';

const dir = fileURLToPath(new URL('../web/app/api/', import.meta.url));
const commands = listCommands();
const problems = [];
for (const c of commands) {
  if (c.input?.type !== 'object') problems.push(`${c.name}: no input schema`);
  if (c.output?.type !== 'object') problems.push(`${c.name}: no output schema`);
  if (!c.example?.input) problems.push(`${c.name}: no example`);
  else for (const e of validate(c.input, c.example.input)) problems.push(`${c.name}: example ${e}`);
  if (!c.roles?.length) problems.push(`${c.name}: no roles`);
}

const spec = {
  name: 'Ospeli command layer',
  version: 1,
  description: 'Every action in the Ospeli app is one of these commands. People and agents run the same commands. Synthetic data only in this build.',
  rules: [
    'People decide, Ospeli suggests: an agent may read, and its write commands become proposals that wait for a person.',
    'Agent access is off by default, for the hospital and for each ward (ospeli_agents_set_access, people only).',
    'Only agents on the site\'s list may call (ospeli_agents_add, people only): each has one role, its wards and an end date of 90 days at most. An agent that is not listed, is past its end date or claims another role is refused. Agents are named, not verified: the browser app has no secret keys; the first version of the site server gives each agent one.',
    'Anyone on site can stop every agent at once (ospeli_agents_stop_all); only the operations manager or chief operating officer can switch agents on again.',
    'Agent reads, proposals and refusals made through window.ospeli.run are designed to be recorded in the audit trail with actor type "agent", the agent name and the role it acts for.',
    'In the browser app these rules are kept by the app\'s own code and are not a security boundary: a script running in the page can load the app\'s modules and act as a person, and the trail would then record a person. The first version of the site server (tools/ospeli-server/, run on a site\'s own computer) checks agent keys and records every call made with a key as that agent, never as a person; sign-in for people is not built yet.',
    'Nothing leaves the site: commands run on this device or the hospital\'s own server, never through a cloud relay.',
  ],
  howToCall: {
    browser: 'window.ospeli.commands(), window.ospeli.describe(name), await window.ospeli.run(name, input, { agent: "your-agent-name", role: "bed-manager" })',
    names: 'Command names are ospeli_<module>_<action>. The dotted names used before 12 Nov 2026 still work in this build; each is listed as deprecatedName. The audit trail and the proposal queue always record the new name. Use the new names.',
    lists: 'List reads take a limit and return total and truncated; most take format: "short". Start with the task-shaped reads: ospeli_beds_find_free, ospeli_workorders_list (overdue, locationId) and ospeli_maps_summary.',
    errors: 'A refused call throws an error with .code: invalid-input, unknown-command, forbidden, not-found, conflict or agents-off.',
  },
  commands,
};
const json = `${JSON.stringify(spec, null, 2)}\n`;

const row = (c) => `| \`${c.name}\` | ${c.kind} | ${c.roles.join(', ')} | ${!c.agentsMayCall ? 'people only' : c.kind === 'write' ? 'yes (agents propose)' : 'no'} | ${c.summary} |`;
const md = `# Ospeli command API

Generated from \`core/commands.js\` by \`scripts/build-commands.mjs\`. Do not edit by hand.
The full schemas and examples are in [commands.json](commands.json).

Every action in the app is a named command. The screens call these commands, and so can an agent working for a member of staff.

## Rules for agents
${spec.rules.map((r) => `- ${r}`).join('\n')}

## How to call
- In the browser: \`window.ospeli.commands()\`, \`window.ospeli.describe(name)\`, \`await window.ospeli.run(name, input, { agent, role })\`.
- ${spec.howToCall.names}
- ${spec.howToCall.lists}
- ${spec.howToCall.errors} Errors say how to fix the call: a wrong ward, place or map id comes back with the ids you may use.
- Write commands take an optional \`expectedState\`: if the bed changed since you looked, the command is refused with \`conflict\` instead of acting on stale data.
- An agent's write returns \`{ status: "proposed", proposal: { id } }\`. A person accepts or declines it on the bed board (\`ospeli_proposals_accept\`, \`ospeli_proposals_decline\`); the agent reads the outcome with \`ospeli_proposals_list\` (accepted, declined, or expired if the bed changed first).
- More for agents: [/agents.md](../../agents.md) and [/llms.txt](../../llms.txt).

## Commands (${commands.length})
| Command | Kind | Roles | Agents: needs a person | What it does |
|---|---|---|---|---|
${commands.map(row).join('\n')}
`;

const check = process.argv.includes('--check');
const stale = [['commands.json', json], ['README.md', md]].filter(([f, text]) => !existsSync(dir + f) || readFileSync(dir + f, 'utf8') !== text);
if (check) {
  for (const [f] of stale) problems.push(`web/app/api/${f} is out of date: run node scripts/build-commands.mjs`);
  for (const p of problems) console.log('FAIL', p);
  console.log(`Checked ${commands.length} commands, ${problems.length} problems`);
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) { for (const p of problems) console.log('FAIL', p); process.exit(1); }
for (const [f, text] of stale) writeFileSync(dir + f, text);
console.log(`Wrote ${stale.length} file(s); ${commands.length} commands`);
