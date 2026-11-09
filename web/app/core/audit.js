// Hash-chained audit trail (foundation section 5.12).
// Each entry stores the hash of the previous entry, so any edit or deletion breaks the chain.

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
// Undefined keys are left out of the hash, so entries written before this still verify.
const body = (e) => ({ seq: e.seq, at: e.at, actorRole: e.actorRole, actorType: e.actorType, agent: e.agent, action: e.action, target: e.target, detail: e.detail, prev: e.prev });

export async function makeEntry(prevEntry, { at, actorRole, actorType, agent, action, target = null, detail = null }) {
  const entry = {
    seq: prevEntry ? prevEntry.seq + 1 : 1,
    at, actorRole, action, target, detail,
    prev: prevEntry ? prevEntry.hash : GENESIS,
  };
  if (actorType === 'agent') { entry.actorType = 'agent'; entry.agent = agent; }
  else if (actorType === 'human' || actorType === 'system') entry.actorType = actorType;
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
