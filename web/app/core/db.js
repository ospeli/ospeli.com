// Storage adapters for the Ospeli core.
// Every adapter has the same small async API over named stores of JSON records:
//   get(store, key), getAll(store), put(store, record), putMany(store, records),
//   add(store, record), addMany(store, records), last(store),
//   clear(store), count(store), close().
// add/addMany refuse a key that already exists (error name 'ConstraintError'); addMany
// is all or nothing. The logs use them so two tabs can never overwrite each other's entries.
// Records are keyed by `id` (entities) or `seq` (event and audit logs).
// IndexedDB is used in the browser; MemoryAdapter is the fallback (tests, private
// windows where IndexedDB is blocked). Modules never touch adapters directly.

export const STORES = ['entities', 'events', 'audit', 'meta'];
const KEYS = { entities: 'id', events: 'seq', audit: 'seq', meta: 'id' };

function constraintError(store, key) {
  const e = new Error(`${store}: key ${key} already exists`);
  e.name = 'ConstraintError';
  return e;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---- Whole-store reads are kept in memory (ospeli/ospeli#153) ----
// A page reads the whole event log and the whole list of places several times as it draws.
// Reading 30,000 events out of IndexedDB takes about 0.1 s on a laptop and 0.4 s on a mid-range
// phone, each time. So the browser adapter keeps the last answer for these two stores and gives
// it again while the store has not changed.
// How it knows: every write to one of these stores, from any tab, also writes a new random mark
// (`_rev:<store>` in the meta store) in the same transaction. A read first asks for the mark,
// the number of records and the last key, in one transaction; only if all three are the ones the
// kept answer was read under is the kept answer used. Otherwise the store is read again.
// The records handed out are frozen (a caller that tries to change one gets an error, in the
// browser and in the unit tests alike), so one caller can never change what the next one reads.
// Decision record: ospeli/ospeli docs/decisions/2026-11-22-keep-reads-in-memory.md.
export const KEPT_STORES = ['events', 'entities'];
const revId = (store) => `_rev:${store}`;
const newRev = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const copy = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : clone(v));
export function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}
const byKey = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
// The kept list with `records` put in (new keys added, the same key replaced), in key order.
function merged(base, records, k) {
  const ascending = records.every((r, i) => i === 0 || records[i - 1][k] < r[k]);
  if (ascending && (!base.length || !records.length || base[base.length - 1][k] < records[0][k])) return base.concat(records);
  const map = new Map(base.map((r) => [r[k], r]));
  for (const r of records) map.set(r[k], r);
  return [...map.values()].sort(byKey(k));
}
// A big batch (the first load of the example site) is frozen where it is: copying 30,000 records
// would cost as much as the read it saves. A small batch is copied first, so the caller's own
// objects stay as they were.
const BIG_BATCH = 1000;

export class MemoryAdapter {
  constructor() {
    this.kind = 'memory';
    this.data = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  }
  _s(store) {
    const s = this.data[store];
    if (!s) throw new Error(`unknown store ${store}`);
    return s;
  }
  async get(store, key) { return clone(this._s(store).get(key)); }
  async getAll(store) {
    const vals = [...this._s(store).values()].map(clone);
    const k = KEYS[store];
    // Frozen like the browser adapter's answer, so a unit test catches a caller that changes a record it read.
    if (KEPT_STORES.includes(store)) vals.forEach(deepFreeze);
    return vals.sort(byKey(k));
  }
  async put(store, record) { this._s(store).set(record[KEYS[store]], clone(record)); }
  async putMany(store, records) { for (const r of records) await this.put(store, r); }
  async add(store, record) { return this.addMany(store, [record]); }
  async addMany(store, records) {
    const s = this._s(store); const k = KEYS[store];
    const keys = new Set();
    for (const r of records) {
      if (s.has(r[k]) || keys.has(r[k])) throw constraintError(store, r[k]);
      keys.add(r[k]);
    }
    for (const r of records) s.set(r[k], clone(r));
  }
  async last(store) {
    const k = KEYS[store]; let best;
    for (const v of this._s(store).values()) if (best === undefined || v[k] > best[k]) best = v;
    return best === undefined ? null : clone(best);
  }
  async clear(store) { this._s(store).clear(); }
  async count(store) { return this._s(store).size; }
  async close() {}
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export class IDBAdapter {
  constructor(db) { this.kind = 'indexeddb'; this.db = db; this._kept = new Map(); this.reads = { kept: 0, storage: 0 }; }
  static open(name = 'ospeli', idb = globalThis.indexedDB) {
    return new Promise((resolve, reject) => {
      if (!idb) { reject(new Error('IndexedDB not available')); return; }
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEYS[s] });
        }
      };
      r.onsuccess = () => { const adapter = new IDBAdapter(r.result); adapter._ensureRevs().then(() => resolve(adapter), () => resolve(adapter)); };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
  _tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
  // A device that stored data before the marks existed gets one per kept store, once.
  _ensureRevs() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readwrite');
      const meta = tx.objectStore('meta');
      for (const s of KEPT_STORES) meta.get(revId(s)).onsuccess = (e) => { if (!e.target.result) meta.put({ id: revId(s), value: newRev() }); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }
  // Forget what is kept: the next read comes from storage. The core calls this when another tab says it wrote.
  dropKept(store) { if (store) this._kept.delete(store); else this._kept.clear(); }
  async get(store, key) { return req(this._tx(store, 'readonly').get(key)); }
  getAll(store) {
    if (!KEPT_STORES.includes(store)) return req(this._tx(store, 'readonly').getAll());
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([store, 'meta'], 'readonly');
      const os = tx.objectStore(store);
      let rev = null; let count = 0; let out = [];
      // Requests in one transaction are answered in order: the mark and the count are known when the last key arrives.
      tx.objectStore('meta').get(revId(store)).onsuccess = (e) => { rev = e.target.result?.value ?? null; };
      os.count().onsuccess = (e) => { count = e.target.result; };
      os.openKeyCursor(null, 'prev').onsuccess = (e) => {
        const lastKey = e.target.result ? e.target.result.key : null;
        const kept = this._kept.get(store);
        if (rev !== null && kept && kept.rev === rev && kept.records.length === count && kept.lastKey === lastKey) { this.reads.kept += 1; out = kept.records; return; }
        os.getAll().onsuccess = (all) => {
          out = all.target.result;
          out.forEach(deepFreeze);
          this.reads.storage += 1;
          if (rev !== null) this._kept.set(store, { rev, records: out, lastKey }); else this._kept.delete(store);
        };
      };
      // A fresh list each time (sorting or filtering it changes nothing for the next reader); the records in it are frozen.
      tx.oncomplete = () => resolve(out.slice());
      tx.onabort = () => reject(tx.error || new Error('read failed'));
    });
  }
  // One write transaction. For a kept store it also writes a new mark, and afterwards brings the kept
  // answer up to date when it was current just before this write (or the store was empty); if not,
  // the kept answer is dropped and the next read comes from storage. `update(list)` returns the new
  // list, or null to drop.
  _write(store, body, update) {
    return new Promise((resolve, reject) => {
      const keep = KEPT_STORES.includes(store);
      const tx = this.db.transaction(keep ? [store, 'meta'] : store, 'readwrite');
      const os = tx.objectStore(store);
      const rev = keep ? newRev() : null;
      let failed = null; let oldRev = null; let wasEmpty = false;
      if (keep) {
        tx.objectStore('meta').get(revId(store)).onsuccess = (e) => { oldRev = e.target.result?.value ?? null; };
        os.count().onsuccess = (e) => { wasEmpty = e.target.result === 0; };
      }
      // A record the storage refuses at once (a value it cannot copy, a bad key) stops the whole write:
      // nothing of the batch is stored, with or without a new mark.
      try {
        body(os, tx, (err) => { failed = failed || err; });
        if (keep) tx.objectStore('meta').put({ id: revId(store), value: rev });
      } catch (err) {
        failed = failed || err;
        try { tx.abort(); } catch { /* already finished */ }
      }
      tx.oncomplete = () => {
        if (keep) {
          const kept = this._kept.get(store);
          const base = kept && oldRev !== null && kept.rev === oldRev ? kept.records : wasEmpty ? [] : null;
          const next = base ? update(base) : null;
          if (next) this._kept.set(store, { rev, records: next, lastKey: next.length ? next[next.length - 1][KEYS[store]] : null });
          else this._kept.delete(store);
        }
        resolve();
      };
      tx.onabort = () => reject(failed || tx.error || new Error('transaction aborted'));
    });
  }
  // What goes into the kept answer for a small batch: copies made now, when the write is asked for,
  // so a caller that changes its own objects afterwards cannot change the kept answer.
  _copies(store, records) {
    return KEPT_STORES.includes(store) && records.length < BIG_BATCH ? records.map((r) => deepFreeze(copy(r))) : null;
  }
  // The stores that are not kept (meta, audit) are written exactly as before: a single put answers
  // when the request is accepted.
  async put(store, record) {
    if (!KEPT_STORES.includes(store)) { await req(this._tx(store, 'readwrite').put(record)); return; }
    await this.putMany(store, [record]);
  }
  putMany(store, records) {
    const mine = this._copies(store, records); // a big batch is not kept: the next read comes from storage
    return this._write(store, (os) => { for (const r of records) os.put(r); }, (base) => mine && merged(base, mine, KEYS[store]));
  }
  add(store, record) { return this.addMany(store, [record]); }
  addMany(store, records) {
    const mine = this._copies(store, records);
    return this._write(store, (os, tx, fail) => {
      for (const r of records) {
        // A duplicate key (ConstraintError) aborts the whole batch: nothing is written.
        os.add(r).onerror = (e) => { fail(e.target.error); e.preventDefault(); e.stopPropagation(); tx.abort(); };
      }
    }, (base) => merged(base, mine || records.map(deepFreeze), KEYS[store])); // a big batch is frozen where it is, once stored
  }
  async last(store) {
    const r = await req(this._tx(store, 'readonly').openCursor(null, 'prev'));
    return r ? r.value : null;
  }
  async clear(store) {
    if (!KEPT_STORES.includes(store)) { await req(this._tx(store, 'readwrite').clear()); return; }
    await this._write(store, (os) => { os.clear(); }, () => []);
  }
  async count(store) { return req(this._tx(store, 'readonly').count()); }
  async close() { this._kept.clear(); this.db.close(); }
}

// Open the best available adapter. Falls back to memory so the app still runs.
export async function openStorage(name = 'ospeli') {
  try {
    return await IDBAdapter.open(name);
  } catch {
    return new MemoryAdapter();
  }
}
