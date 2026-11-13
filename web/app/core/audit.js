// Audit trail as a chain of check codes (foundation section 5.12).
// Each entry stores the hash of the previous entry, so an edit without re-hashing breaks the chain.
// That catches accidental damage. There is no secret key, no signature and no copy kept anywhere
// else, so a history that was re-hashed, shortened or emptied on purpose still passes (issue #79).
// SELF_CHECK_CASES below says exactly that, and a unit test keeps it true.

export const GENESIS = '0'.repeat(64);

// Stable JSON: keys sorted at every level, so the same record always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// actorType is "human", "agent" or "system" (issue #17); agent is only on agent entries.
// via says which door the call came through on the site server: "console" (typed at the server
// itself) or "api" (over HTTP with an agent key). The browser app does not set it.
// Undefined keys are left out of the hash, so entries written before this still verify.
const body = (e) => ({ seq: e.seq, at: e.at, actorRole: e.actorRole, actorType: e.actorType, agent: e.agent, via: e.via, action: e.action, target: e.target, detail: e.detail, prev: e.prev });

export async function makeEntry(prevEntry, { at, actorRole, actorType, agent, via, action, target = null, detail = null }) {
  const entry = {
    seq: prevEntry ? prevEntry.seq + 1 : 1,
    at, actorRole, action, target, detail,
    prev: prevEntry ? prevEntry.hash : GENESIS,
  };
  if (actorType === 'agent') { entry.actorType = 'agent'; entry.agent = agent; }
  else if (actorType === 'human' || actorType === 'system') entry.actorType = actorType;
  if (via === 'console' || via === 'api') entry.via = via;
  entry.hash = await sha256(canonical(body(entry)));
  return entry;
}

// Returns { ok: true } or { ok: false, at: seq, reason }.
export async function verifyChain(entries) {
  let prev = null;
  for (const e of entries) {
    const expectSeq = prev ? prev.seq + 1 : 1;
    if (e.seq !== expectSeq) return { ok: false, at: e.seq, reason: `expected entry ${expectSeq}` };
    if (e.prev !== (prev ? prev.hash : GENESIS)) return { ok: false, at: e.seq, reason: 'previous hash does not match' };
    if (e.hash !== await sha256(canonical(body(e)))) return { ok: false, at: e.seq, reason: 'entry was changed' };
    prev = e;
  }
  return { ok: true };
}

// What the self-check does and does not catch (issue #79). The Data page and the site server's
// README show this list, and tests/unit/core.test.mjs runs every case against verifyChain.
// `apply` gets a copy of a valid trail and returns the changed trail.
const rehashFrom = async (entries, from) => {
  for (let i = from; i < entries.length; i += 1) {
    const e = entries[i];
    e.seq = i + 1;
    e.prev = i ? entries[i - 1].hash : GENESIS;
    e.hash = await sha256(canonical(body(e)));
  }
  return entries;
};
export const SELF_CHECK_CASES = [
  { id: 'edit', change: 'One entry changed, check codes left alone', caught: true,
    apply: async (t) => { t[2].detail = { changed: true }; return t; } },
  { id: 'edit-rehash', change: 'One entry changed, check codes worked out again from there on', caught: false,
    apply: async (t) => { t[2].detail = { changed: true }; return rehashFrom(t, 2); } },
  { id: 'tail', change: 'Newest entries removed', caught: false,
    apply: async (t) => t.slice(0, -2) },
  { id: 'middle', change: 'A middle entry removed, the rest renumbered and re-coded', caught: false,
    apply: async (t) => { t.splice(2, 1); return rehashFrom(t, 2); } },
  { id: 'empty', change: 'Trail emptied', caught: false,
    apply: async () => [] },
];
