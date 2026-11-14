# Ospeli site server (first version)

Runs the Ospeli core on your site's own computer, with an HTTP API. Your scripts and bots can read and propose; every change waits until a person accepts it, at the server window or on a phone or laptop connected to it.
Agent access is Off until a person switches it on. Synthetic data only: do not load real records.
Not built yet: named sign-in for people, changes made on a device with no connection, the AI assistant connector, the event feed. The code is public to read; an open-source licence is planned for March 2027.

## Start
You need Node.js 22.13 or newer (nodejs.org, the "LTS" version). Nothing else to install.

    node tools/ospeli-server/server.mjs

The window then tells you what to type. You do not need the rest of this page to begin.

## Let one bot in
In the server window type `setup agent` and answer four questions (its name, the role it works for, the units it may see, for how many days). Ospeli shows the bot's key once, and a line you can paste to try it.

## See what bots suggest
Type `proposals`. Nothing changes until you type `accept 1` or `decline 1`.

## Use it from a phone or laptop
In the server window type `add device`. Say where the device is (for example: front desk tablet) and which role will use it. Ospeli shows a one-time code and the address to open.
On the phone or laptop, open that address in a browser and type the code. You do this once per device.
That device now shows your site's information, opens on its role's own screen, and can say yes or no to what a bot suggests.
With no connection it shows the last information it had, says so, and refuses changes. They are not kept for later yet.
`devices` lists the connected devices; `remove device 1` disconnects one. A device not used for 30 days asks for a new code.
Phones and other computers can reach Ospeli only if you start it like this:

    node tools/ospeli-server/server.mjs --host 0.0.0.0

That link is not encrypted: synthetic data, on a network you trust.

If your IT person has a certificate and its key for this computer (two PEM files), Ospeli can answer over https instead:

    node tools/ospeli-server/server.mjs --host 0.0.0.0 --tls-cert FILE --tls-key FILE

It then answers over https only (TLS 1.2 or newer) and a device's cookie is sent only over https. Ospeli does not make a certificate for you, and each phone or computer must already trust the one you give; an easy way to set that up is not built yet. Over plain http on a network address a phone's browser also switches off some features: the app does not open without a connection there, and the audit self-check does not run on the phone.

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
- Who is calling comes from the agent key or the device's cookie and nothing else. A call made with a key is recorded as that agent (`via: api`) and can never be recorded as a person; a call with no valid key is refused and counted as "unlisted". A call that carries both a key and a device cookie is refused.
- A device added with `add device` acts as a person in the role chosen for it, marked `via: app` with the device's label. This is not a named sign-in: anyone holding that device can act in that role, so give devices to places, not to the public, and remove one that is lost. The code works once, for 30 minutes, and is cancelled after five wrong tries. The device keeps a random token in a cookie that page scripts cannot read; the server keeps only its hash. A request that changes anything must come from a page this server served.
- People also act in the server window. Those entries are recorded as a person in a role, marked `via: console`. This is not a named sign-in: anyone who can use the server's window can act there, so keep that computer's login to the people who should.
- It listens on this computer only. `--host 0.0.0.0` lets other computers on your network reach it; keys then travel unencrypted, so use it only on a network you trust.
- The data file, and every copy `backup` saves, can be read only by the computer account that runs Ospeli (on Windows, by whoever that folder already allows). The file itself is not encrypted: anyone who can sign in as that account, or who takes the disk, can read it.
- One server per data file. Other options: `--port 8787`, `--data FILE`, `--tls-cert FILE --tls-key FILE`.

### What the audit self-check proves
The `audit` word at the console runs a self-check on the audit trail. Each entry carries a check code worked out from the entry before it. There is no secret key, no signature and no copy kept off this computer yet, so the check catches accidental damage and nothing more. It does not cover the event log. It runs when someone types `audit`, not at start-up.

| Change to the trail | Self-check |
|---|---|
| One entry changed, check codes left alone | Caught |
| One entry changed, check codes worked out again from there on | Not caught |
| Newest entries removed | Not caught |
| A middle entry removed, the rest renumbered and re-coded | Not caught |
| Trail emptied | Not caught |

A checkpoint kept off the computer, so that a rewritten or shortened history shows up, is in development. A test runs these five cases on every build.
