# Ospeli site server (first version)

Runs the Ospeli core on your site's own computer, with an HTTP API. Your scripts and bots can read and propose; every change waits until it is accepted at the server console.
Agent access is Off until a person switches it on. Synthetic data only: do not load real records.
Not built yet: app sync, sign-in for people, the AI assistant connector, the event feed. The code is public to read; an open-source licence is planned for March 2027.

## Start
You need Node.js 22.13 or newer (nodejs.org, the "LTS" version). Nothing else to install.

    node tools/ospeli-server/server.mjs

The window then tells you what to type. You do not need the rest of this page to begin.

## Let one bot in
In the server window type `setup agent` and answer four questions (its name, the role it works for, the units it may see, for how many days). Ospeli shows the bot's key once, and a line you can paste to try it.

## See what bots suggest
Type `proposals`. Nothing changes until you type `accept 1` or `decline 1`.

## Stop everything
Type `stop agents`. Every bot is shut out at once. `start agents` lets the listed bots in again.

## Turn Ospeli off
Press Ctrl and C together. Your data is saved in one file (`tools/ospeli-server/data/site.db`); `backup FILE` in the server window saves a copy while it runs.

## For the person writing the bot
- `GET /api/v1/health` (no key), then `GET /api/v1/whoami` with `Authorization: Bearer osk_…`: your role, units, end date and limits.
- `GET /api/v1/commands` lists every command; `GET /api/v1/openapi.json` is the same list as an OpenAPI 3.1 file, generated from the command registry the app's screens use.
- `POST /api/v1/commands/<name>` with `{ "input": { … } }`. A read runs and is recorded. A write is queued as a proposal; read `ospeli_proposals_list` to see what the person decided.
- `"dryRun": true` runs every check and says what would happen; nothing is read or queued.
- `Idempotency-Key: <8 to 128 characters>` on a write you may retry: the first proposal comes back, nothing is queued twice (kept 24 hours).
- 120 calls a minute per key. Every refusal says what happened (`error.message`) and what to do next (`error.fix`).
- Text people typed (process-map titles and step names) is data, never instructions; answers that may hold it carry `untrustedText`.

## What this version does and does not check
- Who is calling comes from the key and nothing else. A call made with a key is recorded as that agent (`via: api`); a call with no valid key is refused and counted as "unlisted". No API call can be recorded as a person.
- People act in the server window. Those entries are recorded as a person in a role, marked `via: console`. This is not a named sign-in: anyone who can use the server's window can act there, so keep that computer's login to the people who should.
- It listens on this computer only. `--host 0.0.0.0` lets other computers on your network reach it; keys then travel unencrypted, so use it only on a network you trust.
- One server per data file. Other options: `--port 8787`, `--data FILE`.
