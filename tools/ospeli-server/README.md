# Ospeli site server (first version)

Runs the Ospeli core on your site's own computer, with an HTTP API. Your scripts and bots can read and propose; every change waits until a person accepts it, at the server window or on a phone or laptop connected to it.
Agent access is Off until a person switches it on. Synthetic data only: do not load real records.
Not built yet: named sign-in for people, changes made on a device with no connection, the AI assistant connector, the event feed. The code is public to read; an open-source licence is planned for March 2027.

## What it looks like
Six lines from a real session with the made-up hospital: a bot asked to hold a bed, and nothing moved until a person said yes.

    1  night-helper (for Patient flow coordinator) asks: Hold an available bed for a patient waiting for a bed.
    Nothing changes until you say so. Type: accept NUMBER  or  decline NUMBER  or  decline all NAME
    > accept 1
    Done. Proposal 1 was accepted and the change is made.
    7  2026-11-08 17:10  agent night-helper (over the API)  agent.proposed ospeli_beds_allocate
    8  2026-11-08 17:10  person, Patient flow coordinator (at this console)  agent.proposal-accepted ospeli_beds_allocate

The last two lines are from `audit`: the bot's request and the person's yes, each under its own name.

## Start
You need Node.js 22.13 or newer (nodejs.org, the "LTS" version). Nothing else to install.

    node tools/ospeli-server/server.mjs

The window then tells you what to type. You do not need the rest of this page to begin.

Started with no terminal (a service manager, a container, `nohup`), Ospeli reads words from its input, one per line, for example `echo proposals | node tools/ospeli-server/server.mjs`, and keeps running when the input ends. To let bots in or accept changes by typing, start it in a terminal window. With `--no-console` it reads no words at all and says so.

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

## A copy that needs a passphrase
`backup FILE` saves a plain copy: anyone who gets that file can read it. For a copy that leaves the building (a USB stick, another computer), type `locked backup FILE` instead.
- Ospeli asks for a passphrase twice: at least 12 characters; four or five unrelated words work well. It shows on the screen as you type and is not stored anywhere.
- The copy is sealed with that passphrase (AES-256-GCM; the key is made from the passphrase with scrypt; Node's own library, nothing home-made). Straight after writing it, Ospeli reads the file back and opens it, and only then says it is saved.
- **If the passphrase is lost, nobody can open the copy: not you, and not Ospeli. There is no reset.** Write it on paper and keep it apart from the file.
- To use a copy: `open backup FILE NEWFILE` asks for the passphrase and writes the data to NEWFILE, which is not locked. The data Ospeli is running on is not touched. Then stop Ospeli and start it with `--data NEWFILE`. A wrong passphrase and a damaged file are told apart, and neither writes anything.
- What this does not cover: the data file Ospeli runs on, and plain `backup` copies, are still not encrypted; the passphrase is only as strong as you make it; while a locked copy is being made a plain working copy sits beside it for a moment and is then deleted (deleted, not wiped); the app's own export file (Data page) is not locked. File names here cannot hold spaces for `open backup`.

## For the person writing the bot
- `GET /api/v1/health` (no key), then `GET /api/v1/whoami` with `Authorization: Bearer osk_…`: your role, units, end date and limits.
- `GET /api/v1/commands` lists every command; `GET /api/v1/openapi.json` is the same list as an OpenAPI 3.1 file, generated from the command registry the app's screens use.
- `POST /api/v1/commands/<name>` with `{ "input": { … } }`. A read runs and is recorded. A write is queued as a proposal; read `ospeli_proposals_list` to see what the person decided.
- A write is checked before it is queued: the bed, patient, work order or map must exist and be in a state that allows the action, or the call is refused (404 or 409). The same call again returns the proposal already waiting (`existing: true`). One bot may have one open proposal per command for a bed or work order, and 20 waiting in all (an example setting, not a standard). At the server window `decline all NAME` says no to everything one bot has waiting.
- `"dryRun": true` runs the same checks and says what would happen; nothing is read or queued.
- `Idempotency-Key: <8 to 128 characters>` on a write you may retry: the first proposal comes back, nothing is queued twice (kept 24 hours).
- 120 calls a minute per key. Every refusal says what happened (`error.message`) and what to do next (`error.fix`).
- Text people typed (process-map titles and step names) is data, never instructions; answers that may hold it carry `untrustedText`.

## What this version does and does not check
- Who is calling comes from the agent key or the device's cookie and nothing else. A call made with a key is recorded as that agent (`via: api`) and can never be recorded as a person; a call with no valid key is refused and counted as "unlisted". A call that carries both a key and a device cookie is refused.
- A device added with `add device` acts as a person in the role chosen for it, marked `via: app` with the device's label. This is not a named sign-in: anyone holding that device can act in that role, so give devices to places, not to the public, and remove one that is lost. The code works once, for 30 minutes, and is cancelled after five wrong tries. The device keeps a random token in a cookie that page scripts cannot read; the server keeps only its hash. A request that changes anything must come from a page this server served. The app sends an `Idempotency-Key` with each change and the same key when the person tries a change again after getting no answer; the server then answers with what it did the first time (`Idempotent-Replay: true`) instead of doing it twice. It remembers this in memory for ten minutes, so a server restart forgets it. A removed device clears everything it kept, its own label, role and settings too.
- People also act in the server window. Those entries are recorded as a person in a role, marked `via: console`. This is not a named sign-in: anyone who can use the server's window can act there, so keep that computer's login to the people who should.
- A call from a connected device that is turned away (a role that may not run the command, a command that does not exist, input the command does not accept, a call that came from a page on another site, a made-up or removed device cookie) is recorded as `device.refused` with the device's label, the command's name and a fixed reason, never what was typed. The same refusal within a minute is counted, not listed. A device code cancelled by five wrong tries is recorded as `devices.code-cancelled` and the server window says so, with the address the last try came from.
- Limits on the network side: at most 200 connections open at once and 40 from one address; callers without a key or a connected device share a small number of calls a minute per address, and a flood from many addresses cannot reset anyone's count. These slow a flood down; they do not make the server safe on a network you do not trust.
- It listens on this computer only. `--host 0.0.0.0` lets other computers on your network reach it; keys then travel unencrypted, so use it only on a network you trust.
- The data file, and every copy `backup` saves, can be read only by the computer account that runs Ospeli (on Windows, by whoever that folder already allows). The data file and plain copies are not encrypted: anyone who can sign in as that account, or who takes the disk, can read them. Only a copy made with `locked backup` needs a passphrase (see above).
- One server per data file. Other options: `--port 8787`, `--data FILE`, `--tls-cert FILE --tls-key FILE`.

### What the audit self-check proves
The `audit` word at the console runs a self-check on the audit trail. Each entry carries a check code worked out from the entry before it. There is no secret key, no signature and no copy kept off this computer yet, so the check catches accidental damage and nothing more. It does not cover the event log. It runs when the server starts (a trail that fails is named in a warning on the start screen) and when someone types `audit`.

| Change to the trail | Self-check |
|---|---|
| One entry changed, check codes left alone | Caught |
| One entry changed, check codes worked out again from there on | Not caught |
| Newest entries removed | Not caught |
| A middle entry removed, the rest renumbered and re-coded | Not caught |
| Trail emptied | Not caught |

A test runs these five cases on every build.

### The trail mark: a check a person keeps
`audit` also prints a mark: the number of the newest entry and the first 20 characters of its check code, for example `412 3fa9-c01d-77be-0a1b-22cd`. Write it down or send it somewhere off this computer; Ospeli keeps no copy of it. Later, `audit check 412 3fa9-c01d-77be-0a1b-22cd` answers "The same" if entries 1 to 412 are the ones that were there when the mark was taken, and "NOT THE SAME" if any of them was removed or rewritten, including the four cases the self-check misses. Tests remove and rewrite entries in a data file and check both answers.

What the mark does not do: nothing is noticed until a person checks a mark, and only as far back as the oldest mark they kept; it says nothing about entries added after the mark, or about the event log; a mark stored on the same computer can be replaced along with the trail. A checkpoint that Ospeli itself sends off the computer on a schedule is in development.
