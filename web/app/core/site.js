// A device connected to its site's own server (tools/ospeli-server).
// The server is the only writer. This device keeps a copy of the site's data that it can read
// but not change: screens read the copy (so they still open with no connection), and every
// change is sent to the server, which checks it, records it and sends back the new state.
// A change made with no connection is refused, not kept for later (a first version).

import { CommandError, commandByName, runCommand } from './commands.js';

// The site-wide settings a connected device is sent. Never a key, a token or their hashes.
export const SITE_META = ['synthetic', 'generator', 'setup', 'agents', 'agent-proposals', 'agent-refusals', 'agents-cleared', 'history-replaced', 'process-maps'];
const SITE_STORES = ['entities', 'events', 'audit'];
const SYNC_STATE = 'site-sync';
export const READ_ONLY = 'This device shows your site\'s information. Changes are saved on the site\'s own computer.';
export const OFFLINE = 'This device is not connected. Try again when it is back on your site\'s network.';

// The copy on this device. The core reads through it; the core cannot write the site's data
// through it. Settings of this device alone (for example the ward it opens on) are kept here.
export class MirrorAdapter {
  constructor(inner) { this.inner = inner; this.kind = 'site-copy'; }
  get(store, key) { return this.inner.get(store, key); }
  getAll(store) { return this.inner.getAll(store); }
  last(store) { return this.inner.last(store); }
  count(store) { return this.inner.count(store); }
  close() { return this.inner.close(); }
  _own(store, records) {
    if (store !== 'meta' || records.some((r) => SITE_META.includes(r.id) || r.id === SYNC_STATE)) throw new Error(READ_ONLY);
  }
  async put(store, record) { this._own(store, [record]); return this.inner.put(store, record); }
  async putMany(store, records) { this._own(store, records); return this.inner.putMany(store, records); }
  async add() { throw new Error(READ_ONLY); }
  async addMany() { throw new Error(READ_ONLY); }
  async clear() { throw new Error(READ_ONLY); }

  // ---- only the sync below writes the copy ----
  async syncState() { return (await this.inner.get('meta', SYNC_STATE))?.value || null; }
  async wipe() {
    for (const s of SITE_STORES) await this.inner.clear(s);
    await this.inner.putMany('meta', [...SITE_META, SYNC_STATE].map((id) => ({ id, value: null })));
  }
  // Apply one answer from GET /api/v1/sync. Returns what changed: null, 'events' or 'reset'.
  async apply(answer, at) {
    const state = await this.syncState();
    if (answer.unchanged) return null;
    const full = answer.full || !state || state.epoch !== answer.epoch;
    if (full) {
      // A different history on the server (it restarted, or its data was replaced). An answer
      // that is not a full one cannot be put on top of the old copy: ask again from nothing.
      if (!answer.full) { await this.wipe(); return 'again'; }
      for (const s of SITE_STORES) await this.inner.clear(s);
    }
    await this.inner.putMany('entities', answer.entities);
    await this.inner.putMany('events', answer.events);
    await this.inner.putMany('audit', answer.audit);
    await this.inner.putMany('meta', SITE_META.map((id) => ({ id, value: answer.meta?.[id] ?? null })));
    const lastOf = async (s) => (await this.inner.last(s))?.seq || 0;
    await this.inner.put('meta', { id: SYNC_STATE, value: { epoch: answer.epoch, rev: answer.rev, events: await lastOf('events'), audit: await lastOf('audit'), at } });
    return full ? 'reset' : 'events';
  }
}

// The link to the server. `fetch` and `base` can be swapped in tests.
export class SiteLink {
  constructor({ mirror, base = '../api/v1', fetch = (...a) => globalThis.fetch(...a), clock = () => new Date() }) {
    Object.assign(this, { mirror, base, fetch, clock });
    this.core = null;
    this.connected = false;
    this.listeners = new Set();
    this.pulling = null;
    this.lastAt = null; // when this device last heard from the server
  }
  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _set(connected, reason = null) {
    if (this.connected === connected && !reason) return;
    this.connected = connected;
    for (const fn of this.listeners) { try { fn({ connected, reason }); } catch { /* a view error must not stop the link */ } }
  }
  // { ok, status, body }; status 0 means the server could not be reached at all.
  async _call(path, init) {
    let res;
    try { res = await this.fetch(`${this.base}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init }); } catch { return { ok: false, status: 0, body: null }; }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON: treated as a failed call */ }
    // An answer that is not this server's (a sign-in page of some Wi-Fi, a cached page) counts as no connection.
    if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') return { ok: false, status: 0, body: null };
    return { ok: res.ok && body.ok, status: res.status, body };
  }
  // Who this device is to the server: { device } , { needsCode: true } or { offline: true }.
  async session() {
    const r = await this._call('/session');
    if (r.ok) { this._set(true); return { device: r.body.device, site: r.body.site }; }
    if (r.status === 401) { this._set(false, 'needs-code'); return { needsCode: true }; }
    this._set(false);
    return { offline: true };
  }
  async connect(code) {
    const r = await this._call('/devices/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (r.ok) { this._set(true); return { device: r.body.device }; }
    if (r.status === 0) return { error: 'This device cannot reach Ospeli on your site right now. Check the Wi-Fi and try again.' };
    return { error: r.body.error?.message || 'That did not work. Try again.', code: r.body.error?.code };
  }
  // Fetch what changed and put it in the copy. One at a time; a second call waits for the first.
  pull() {
    if (!this.pulling) this.pulling = this._pull().finally(() => { this.pulling = null; });
    return this.pulling;
  }
  async _pull() {
    for (let round = 0; round < 2; round += 1) {
      const st = await this.mirror.syncState();
      const q = st ? `?epoch=${encodeURIComponent(st.epoch)}&rev=${st.rev}&events=${st.events}&audit=${st.audit}` : '';
      const r = await this._call(`/sync${q}`);
      if (r.status === 401) { await this.mirror.wipe(); this._set(false, 'needs-code'); return false; }
      if (!r.ok) { this._set(false); return false; }
      const changed = await this.mirror.apply(r.body, this.clock().toISOString());
      if (changed === 'again') continue;
      this.lastAt = this.clock().toISOString();
      this._set(true);
      if (changed && this.core) await this.core.reloaded(changed);
      return true;
    }
    return false;
  }
  // Run a command as the person using this device. A read runs on the copy. A change goes to
  // the server; with no connection it is refused and nothing is kept for later.
  async run(name, input, role) {
    const cmd = commandByName(name);
    if (cmd?.kind === 'read') return runCommand(this.core, name, input, { type: 'human', role });
    const r = await this._call(`/commands/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: input ?? {} }) });
    if (r.status === 0) { this._set(false); throw new CommandError('offline', OFFLINE); }
    if (r.status === 401) { await this.mirror.wipe(); this._set(false, 'needs-code'); throw new CommandError('forbidden', 'This device is not connected any more. Ask for a new code.'); }
    if (!r.ok) {
      await this.pull(); // the refusal may mean this device's copy was behind
      throw new CommandError(r.body.error?.code || 'error', r.body.error?.message || 'Not saved.', r.body.error?.detail ?? null);
    }
    await this.pull();
    return r.body.result;
  }
}
