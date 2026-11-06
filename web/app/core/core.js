// The Ospeli core: hospital model, append-only event log, hash-chained audit log,
// JSON export and import. Modules are thin views over this object.

import { MemoryAdapter } from './db.js';
import { ENTITY_TYPES, validateEntity, validateEvent, roleById } from './model.js';
import { makeEntry, verifyChain } from './audit.js';

export const EXPORT_FORMAT = 'ospeli-export';
export const EXPORT_VERSION = 1;

const checkActor = (actorRole) => {
  if (actorRole !== 'system' && !roleById(actorRole)) throw new Error(`unknown actor role ${actorRole}`);
};

export class Core {
  constructor(adapter, clock) {
    this.db = adapter;
    this.clock = clock;
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.lastEvent = null;
    this.lastAudit = null;
  }

  static async open({ adapter = new MemoryAdapter(), clock = () => new Date() } = {}) {
    const core = new Core(adapter, clock);
    await core._loadTails();
    return core;
  }

  async _loadTails() {
    const ev = await this.db.getAll('events');
    const au = await this.db.getAll('audit');
    this.lastEvent = ev.length ? ev[ev.length - 1] : null;
    this.lastAudit = au.length ? au[au.length - 1] : null;
  }

  now() { return this.clock().toISOString(); }

  // Writes run one at a time so sequence numbers and the hash chain stay consistent.
  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(kind, detail) { for (const fn of this.listeners) { try { fn({ kind, detail }); } catch { /* a view error must not break the core */ } } }

  async _audit(actorRole, action, target, detail, at = this.now()) {
    const entry = await makeEntry(this.lastAudit, { at, actorRole, action, target, detail });
    await this.db.put('audit', entry);
    this.lastAudit = entry;
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
      const rec = this._eventRecord(ev, this.lastEvent ? this.lastEvent.seq : 0);
      await this.db.put('events', rec);
      this.lastEvent = rec;
      this._emit('event', rec);
      return rec;
    });
  }

  appendEvents(list, actorRole, note = 'bulk events') {
    return this._serial(async () => {
      checkActor(actorRole);
      let seq = this.lastEvent ? this.lastEvent.seq : 0;
      const recs = list.map((ev) => this._eventRecord(ev, seq++));
      await this.db.putMany('events', recs);
      if (recs.length) this.lastEvent = recs[recs.length - 1];
      await this._audit(actorRole, 'events.loaded', null, { count: recs.length, note });
      this._emit('events', { count: recs.length });
      return recs.length;
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

  // ---- audit log ----
  record(actorRole, action, target = null, detail = null) {
    return this._serial(async () => {
      checkActor(actorRole);
      const entry = await this._audit(actorRole, action, target, detail);
      this._emit('audit', entry);
      return entry;
    });
  }
  auditLog() { return this.db.getAll('audit'); }
  async verifyAudit() { return verifyChain(await this.db.getAll('audit')); }

  // ---- settings (not audited: device preferences such as the chosen role) ----
  async getMeta(id, fallback = null) { const r = await this.db.get('meta', id); return r ? r.value : fallback; }
  async setMeta(id, value) { await this.db.put('meta', { id, value }); }

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
    for (const k of ['entities', 'events', 'audit']) if (!Array.isArray(data[k])) errs.push(`${k} must be a list`);
    if (errs.length) return errs;
    const ids = new Map();
    for (const e of data.entities) {
      const v = validateEntity(e);
      if (v.length) { errs.push(`entity ${e?.id}: ${v.join('; ')}`); continue; }
      if (ids.has(e.id)) errs.push(`duplicate entity ${e.id}`);
      ids.set(e.id, e);
    }
    for (const e of data.entities) {
      if (e.parentId != null) {
        const p = ids.get(e.parentId);
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
      for (const s of ['entities', 'events', 'audit']) await this.db.clear(s);
      await this.db.putMany('entities', data.entities);
      await this.db.putMany('events', data.events);
      await this.db.putMany('audit', data.audit);
      await this._loadTails();
      await this._audit(actorRole, 'data.imported', null, {
        entities: data.entities.length, events: data.events.length, exportedAt: data.exportedAt ?? null,
      });
      this._emit('reset', null);
      return { entities: data.entities.length, events: data.events.length };
    });
  }

  // Wipe everything on this device (used by "Reset demo data").
  reset() {
    return this._serial(async () => {
      for (const s of ['entities', 'events', 'audit']) await this.db.clear(s);
      this.lastEvent = null;
      this.lastAudit = null;
      this._emit('reset', null);
    });
  }
}
