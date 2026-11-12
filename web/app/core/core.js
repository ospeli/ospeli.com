// The Ospeli core: hospital model, append-only event log, hash-chained audit log,
// JSON export and import. Modules are thin views over this object.

import { MemoryAdapter } from './db.js';
import { ENTITY_TYPES, validateEntity, validateEvent, roleById } from './model.js';
import { makeEntry, verifyChain } from './audit.js';

export const EXPORT_FORMAT = 'ospeli-export';

// Rule 1: this build holds synthetic data only. Keys that look like they carry a person's
// identity are refused on import, wherever they appear (issue #5). An entity's own `name`
// (a ward, a bed) is allowed; a person-name key such as patientName is not.
const IDENTIFIER_KEY = /(name|surname|nhs|mrn|dob|birth|address|postcode|zip|phone|mobile|email|staff|employee|ssn|passport|nationalid|insurance|medicare)/;
const ENTITY_OWN_KEYS = new Set(['id', 'type', 'name', 'parentId', 'version', 'updatedAt']);

export function findIdentifierFields(data) {
  const hits = [];
  const walk = (v, path, ownKeys = null) => {
    if (hits.length >= 10 || v == null || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      const norm = k.toLowerCase().replace(/[^a-z]/g, '');
      if (!(ownKeys && ownKeys.has(k)) && IDENTIFIER_KEY.test(norm)) hits.push(`${path}.${k}`);
      walk(val, `${path}.${k}`);
    }
  };
  (data.entities || []).forEach((e, i) => walk(e, `entities[${i}]`, ENTITY_OWN_KEYS));
  (data.events || []).forEach((e, i) => walk(e?.data, `events[${i}].data`));
  return hits;
}
export const EXPORT_VERSION = 1;

const checkActor = (actorRole) => {
  if (actorRole !== 'system' && !roleById(actorRole)) throw new Error(`unknown actor role ${actorRole}`);
};

export class Core {
  constructor(adapter, clock) {
    this.db = adapter;
    this.channel = null;
    this.clock = clock;
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.lastEvent = null;
    this.lastAudit = null;
  }

  static async open({ adapter = new MemoryAdapter(), clock = () => new Date() } = {}) {
    const core = new Core(adapter, clock);
    await core._loadTails();
    core._listenToOtherTabs();
    return core;
  }

  // Other tabs on this device share the same IndexedDB. When one writes, the others re-read
  // the log and redraw, so nobody acts on a stale board (issue #9).
  _listenToOtherTabs() {
    if (this.db.kind !== 'indexeddb' || typeof BroadcastChannel !== 'function') return;
    this.channel = new BroadcastChannel('ospeli');
    this.channel.onmessage = async () => {
      await this._serial(() => this._loadTails());
      this._emitLocal('events', { from: 'another tab' });
    };
  }

  async _loadTails() {
    this.lastEvent = await this.db.last('events');
    this.lastAudit = await this.db.last('audit');
  }

  // Append to a log without ever overwriting an entry. Another tab on the same device may
  // have written since we last looked: the storage refuses the duplicate key, we re-read
  // the tail and build the record(s) again on top of it (issue #2).
  async _appendLog(store, tailKey, build) {
    for (let attempt = 0; ; attempt++) {
      const recs = await build(this[tailKey]);
      try {
        await this.db.addMany(store, recs);
        if (recs.length) this[tailKey] = recs[recs.length - 1];
        return recs;
      } catch (err) {
        if (err?.name !== 'ConstraintError' || attempt >= 20) throw err;
        this[tailKey] = await this.db.last(store);
      }
    }
  }

  now() { return this.clock().toISOString(); }

  // Writes run one at a time so sequence numbers and the hash chain stay consistent.
  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emitLocal(kind, detail) { for (const fn of this.listeners) { try { fn({ kind, detail }); } catch { /* a view error must not break the core */ } } }
  _emit(kind, detail) {
    this._emitLocal(kind, detail);
    try { this.channel?.postMessage({ kind }); } catch { /* another tab will catch up on reload */ }
  }

  async _audit(actor, action, target, detail, at = this.now()) {
    const who = typeof actor === 'string' ? { role: actor } : { ...actor };
    if (who.type !== 'agent') who.type = who.role === 'system' ? 'system' : 'human';
    const [entry] = await this._appendLog('audit', 'lastAudit', async (tail) => [await makeEntry(tail, {
      at, actorRole: who.role, actorType: who.type, agent: who.agent, action, target, detail,
    })]);
    return entry;
  }

  // ---- hospital model ----
  async _checkParent(e, pending) {
    if (e.parentId == null) {
      if (ENTITY_TYPES[e.type].parents.length) {
        throw new Error(`${e.type} ${e.id} needs a parent (${ENTITY_TYPES[e.type].parents.join(' or ')})`);
      }
      return;
    }
    const parent = pending?.get(e.parentId) || await this.db.get('entities', e.parentId);
    if (!parent) throw new Error(`${e.id}: parent ${e.parentId} not found`);
    if (!ENTITY_TYPES[e.type].parents.includes(parent.type)) {
      throw new Error(`${e.id}: a ${e.type} cannot sit under a ${parent.type}`);
    }
  }

  putEntity(entity, actorRole) {
    return this._serial(async () => {
      checkActor(actorRole);
      const errs = validateEntity(entity);
      if (errs.length) throw new Error(`invalid entity: ${errs.join('; ')}`);
      await this._checkParent(entity);
      const old = await this.db.get('entities', entity.id);
      if (old && old.type !== entity.type) throw new Error(`${entity.id} is a ${old.type}; type cannot change`);
      const rec = { ...entity, version: old ? old.version + 1 : 1, updatedAt: this.now() };
      await this.db.put('entities', rec);
      await this._audit(actorRole, old ? 'entity.updated' : 'entity.created', rec.id, { type: rec.type, version: rec.version });
      this._emit('entity', rec);
      return rec;
    });
  }

  // Bulk load (used by the synthetic generator). One audit entry for the batch.
  putEntities(entities, actorRole, note = 'bulk load') {
    return this._serial(async () => {
      checkActor(actorRole);
      const pending = new Map(entities.map((e) => [e.id, e]));
      if (pending.size !== entities.length) throw new Error('duplicate ids in batch');
      for (const e of entities) {
        const errs = validateEntity(e);
        if (errs.length) throw new Error(`invalid entity ${e?.id}: ${errs.join('; ')}`);
        await this._checkParent(e, pending);
      }
      const at = this.now();
      const recs = [];
      for (const e of entities) {
        const old = await this.db.get('entities', e.id);
        recs.push({ ...e, version: old ? old.version + 1 : 1, updatedAt: at });
      }
      await this.db.putMany('entities', recs);
      await this._audit(actorRole, 'entities.loaded', null, { count: recs.length, note }, at);
      this._emit('entities', { count: recs.length });
      return recs.length;
    });
  }

  getEntity(id) { return this.db.get('entities', id); }
  async listEntities(type) {
    const all = await this.db.getAll('entities');
    return type ? all.filter((e) => e.type === type) : all;
  }
  async children(parentId, type) {
    return (await this.listEntities(type)).filter((e) => e.parentId === parentId);
  }

  // ---- event log (append-only: there is no update or delete) ----
  _eventRecord(ev, prevSeq) {
    const errs = validateEvent(ev);
    if (errs.length) throw new Error(`invalid event: ${errs.join('; ')}`);
    return {
      seq: prevSeq + 1,
      type: ev.type,
      subject: ev.subject,
      actorRole: ev.actorRole,
      at: ev.at ? new Date(ev.at).toISOString() : this.now(),
      recordedAt: this.now(),
      data: ev.data ?? null,
    };
  }

  appendEvent(ev) {
    return this._serial(async () => {
      const [rec] = await this._appendLog('events', 'lastEvent',
        async (tail) => [this._eventRecord(ev, tail ? tail.seq : 0)]);
      this._emit('event', rec);
      return rec;
    });
  }

  appendEvents(list, actorRole, note = 'bulk events') {
    return this._serial(async () => {
      checkActor(actorRole);
      const recs = await this._appendLog('events', 'lastEvent', async (tail) => {
        let seq = tail ? tail.seq : 0;
        return list.map((ev) => this._eventRecord(ev, seq++));
      });
      await this._audit(actorRole, 'events.loaded', null, { count: recs.length, note });
      this._emit('events', { count: recs.length });
      return recs.length;
    });
  }

  // Append events only if they still make sense against the log as it is *now* (re-read from
  // storage, so writes from another tab count). `build(events)` returns the events to append
  // or throws to refuse. If another tab writes in between, it runs again on the fresh log.
  appendChecked(build) {
    return this._serial(async () => {
      const recs = await this._appendLog('events', 'lastEvent', async (tail) => {
        const fresh = await this.db.getAll('events');
        const list = await build(fresh);
        let seq = Math.max(tail ? tail.seq : 0, fresh.length ? fresh[fresh.length - 1].seq : 0);
        return list.map((ev) => this._eventRecord(ev, seq++));
      });
      for (const rec of recs) this._emit('event', rec);
      return recs;
    });
  }

  async events({ type, subject, since, until } = {}) {
    const all = await this.db.getAll('events');
    const types = type == null ? null : new Set([].concat(type));
    return all.filter((e) => (!types || types.has(e.type))
      && (subject == null || e.subject === subject)
      && (since == null || e.at >= since)
      && (until == null || e.at < until));
  }

  eventCount() { return this.db.count('events'); }

  // ---- audit log ----
  record(actorRole, action, target = null, detail = null) {
    return this._serial(async () => {
      checkActor(actorRole);
      const entry = await this._audit(actorRole, action, target, detail);
      this._emit('audit', entry);
      return entry;
    });
  }
  // Audit an action by a human or an agent: { type: 'human'|'agent', role, agent? }.
  recordAs(actor, action, target = null, detail = null) {
    return this._serial(async () => {
      checkActor(actor.role);
      const entry = await this._audit(actor, action, target, detail);
      this._emit('audit', entry);
      return entry;
    });
  }

  // An agent's proposed change: recorded and queued for a person; nothing else changes.
  // `extra` carries what the person will need to check it later (ward, the state the agent saw).
  propose(actor, command, input, extra = {}) {
    return this._serial(async () => {
      checkActor(actor.role);
      const list = await this.getMeta('agent-proposals', []) || [];
      const proposal = {
        id: `prop-${String(list.length + 1).padStart(4, '0')}`, command, input, agent: actor.agent, role: actor.role,
        at: this.now(), status: 'pending', ...extra,
      };
      await this.setMeta('agent-proposals', [...list, proposal]);
      await this._audit(actor, 'agent.proposed', proposal.id, { command, input });
      this._emit('proposals', proposal);
      return proposal;
    });
  }
  async proposals() { return (await this.getMeta('agent-proposals', [])) || []; }

  // A person accepted, declined or found a proposal out of date (issue #17). Only a pending
  // proposal can be decided, once; the audit entry links the proposal id.
  // A proposal being accepted is first claimed ('accepting', not audited) so a second tap or tab
  // cannot run it twice; the claim then becomes 'accepted' or 'expired'.
  decideProposal(id, actor, { status, reason = null, events = [], result = null }) {
    return this._serial(async () => {
      checkActor(actor.role);
      const list = (await this.getMeta('agent-proposals', [])) || [];
      const i = list.findIndex((p) => p.id === id);
      if (i < 0) throw Object.assign(new Error(`No proposal ${id}.`), { code: 'not-found' });
      const from = list[i].status;
      if (!(from === 'pending' || (from === 'accepting' && status !== 'accepting'))) throw Object.assign(new Error(`Proposal ${id} is already ${list[i].status}.`), { code: 'conflict' });
      const decided = { ...list[i], status, decidedAt: this.now(), decidedByRole: actor.role, reason, events, result };
      const next = [...list]; next[i] = decided;
      await this.setMeta('agent-proposals', next);
      if (status !== 'accepting') await this._audit(actor, `agent.proposal-${status}`, id, { command: decided.command, agent: decided.agent, reason, events });
      this._emit('proposals', decided);
      return decided;
    });
  }

  auditLog() { return this.db.getAll('audit'); }
  async verifyAudit() { return verifyChain(await this.db.getAll('audit')); }

  // ---- settings (not audited: device preferences such as the chosen role) ----
  async getMeta(id, fallback = null) { const r = await this.db.get('meta', id); return r ? r.value : fallback; }
  async setMeta(id, value) { await this.db.put('meta', { id, value }); }
  // Read-modify-write a setting inside the write queue, so two quick writes never lose one.
  updateMeta(id, fn, fallback = null) {
    return this._serial(async () => {
      const r = await this.db.get('meta', id);
      const next = await fn(r ? r.value : fallback);
      await this.db.put('meta', { id, value: next });
      this._emit('meta', { id });
      return next;
    });
  }

  // ---- export and import ----
  async exportData() {
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: this.now(),
      synthetic: (await this.getMeta('synthetic', true)) !== false,
      entities: await this.db.getAll('entities'),
      events: await this.db.getAll('events'),
      audit: await this.db.getAll('audit'),
    };
  }

  // Checks everything before touching storage; a bad file changes nothing.
  async validateImport(data) {
    const errs = [];
    if (!data || data.format !== EXPORT_FORMAT) return ['not an Ospeli export file'];
    if (data.version !== EXPORT_VERSION) return [`unsupported export version ${data.version}`];
    if (data.synthetic !== true) return ['This build accepts synthetic data only, and this file is not marked synthetic.'];
    for (const k of ['entities', 'events', 'audit']) if (!Array.isArray(data[k])) errs.push(`${k} must be a list`);
    if (errs.length) return errs;
    const ids = findIdentifierFields(data);
    if (ids.length) return [`This file has fields that look like personal details (${ids.slice(0, 3).join(', ')}). This build accepts synthetic data only.`];
    const byId = new Map();
    for (const e of data.entities) {
      const v = validateEntity(e);
      if (v.length) { errs.push(`entity ${e?.id}: ${v.join('; ')}`); continue; }
      if (byId.has(e.id)) errs.push(`duplicate entity ${e.id}`);
      byId.set(e.id, e);
    }
    for (const e of data.entities) {
      if (e.parentId != null) {
        const p = byId.get(e.parentId);
        if (!p) errs.push(`entity ${e.id}: parent ${e.parentId} missing`);
        else if (!ENTITY_TYPES[e.type]?.parents.includes(p.type)) errs.push(`entity ${e.id}: bad parent type ${p.type}`);
      }
    }
    data.events.forEach((ev, i) => {
      const v = validateEvent(ev);
      if (v.length) errs.push(`event ${ev?.seq ?? i}: ${v.join('; ')}`);
      if (ev.seq !== i + 1) errs.push(`event ${i + 1}: sequence broken`);
    });
    const chain = await verifyChain(data.audit);
    if (!chain.ok) errs.push(`audit trail broken at entry ${chain.at}: ${chain.reason}`);
    return errs.slice(0, 20);
  }

  importData(data, actorRole) {
    return this._serial(async () => {
      checkActor(actorRole);
      const errs = await this.validateImport(data);
      if (errs.length) throw new Error(`import refused: ${errs.join('; ')}`);
      const was = await this._agentAccessInUse();
      for (const s of ['entities', 'events', 'audit']) await this.db.clear(s);
      await this.db.putMany('entities', data.entities);
      await this.db.putMany('events', data.events);
      await this.db.putMany('audit', data.audit);
      await this._loadTails();
      await this.setMeta('synthetic', true);
      await this._clearAgentAccess(actorRole, 'import', was);
      await this._audit(actorRole, 'data.imported', null, {
        entities: data.entities.length, events: data.events.length, exportedAt: data.exportedAt ?? null,
        checks: { markedSynthetic: true, identifierFields: 0 },
      });
      this._emit('reset', null);
      return { entities: data.entities.length, events: data.events.length };
    });
  }

  // Agent access never carries over to a replaced data set (issue #51): off by default means a
  // reset, a fresh copy or an import starts with the dial at Off, no ward switched on, an empty
  // agent list and no waiting proposals. If anything was on, the new trail says so in one entry.
  async _agentAccessInUse() {
    const a = await this.getMeta('agents', null);
    const wards = Object.values(a?.wards || {}).filter((v) => v === true).length;
    const agents = Array.isArray(a?.registered) ? a.registered.length : 0;
    const pendingProposals = ((await this.getMeta('agent-proposals', [])) || []).filter((p) => p.status === 'pending').length;
    if (a?.allowed !== true && !wards && !agents && !pendingProposals) return null;
    return { dial: a?.allowed === true ? 'advise' : 'off', wards, agents, pendingProposals };
  }
  agentAccessInUse() { return this._agentAccessInUse(); }
  async _clearAgentAccess(actorRole, by, was) {
    for (const id of ['agents', 'agent-refusals', 'agent-proposals']) await this.db.put('meta', { id, value: null });
    if (!was) return;
    // The notice outlives a later reset (which wipes the trail) until a person switches agents on again.
    await this.db.put('meta', { id: 'agents-cleared', value: { at: this.now(), by, byRole: actorRole } });
    await this._audit(actorRole, 'agents.access-cleared', null, { by, was });
  }

  // Wipe everything on this device (used by "Reset device data" and "Load a fresh copy").
  reset(actorRole = 'system') {
    return this._serial(async () => {
      checkActor(actorRole);
      const was = await this._agentAccessInUse();
      for (const s of ['entities', 'events', 'audit']) await this.db.clear(s);
      // Nothing is loaded now, so nothing is claimed about it (issue #5 badge, issue #7).
      for (const id of ['synthetic', 'generator', 'process-maps']) await this.db.put('meta', { id, value: null });
      this.lastEvent = null;
      this.lastAudit = null;
      await this._clearAgentAccess(actorRole, 'reset', was);
      this._emit('reset', null);
    });
  }
}
