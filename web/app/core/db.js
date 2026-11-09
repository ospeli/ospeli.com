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
    return vals.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0));
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
  constructor(db) { this.kind = 'indexeddb'; this.db = db; }
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
      r.onsuccess = () => resolve(new IDBAdapter(r.result));
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
  _tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
  async get(store, key) { return req(this._tx(store, 'readonly').get(key)); }
  async getAll(store) { return req(this._tx(store, 'readonly').getAll()); }
  async put(store, record) { await req(this._tx(store, 'readwrite').put(record)); }
  putMany(store, records) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const r of records) os.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }
  add(store, record) { return this.addMany(store, [record]); }
  addMany(store, records) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      let failed = null;
      for (const r of records) {
        // A duplicate key (ConstraintError) aborts the whole batch: nothing is written.
        os.add(r).onerror = (e) => { failed = failed || e.target.error; e.preventDefault(); e.stopPropagation(); tx.abort(); };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failed || tx.error || new Error('transaction aborted'));
    });
  }
  async last(store) {
    const r = await req(this._tx(store, 'readonly').openCursor(null, 'prev'));
    return r ? r.value : null;
  }
  async clear(store) { await req(this._tx(store, 'readwrite').clear()); }
  async count(store) { return req(this._tx(store, 'readonly').count()); }
  async close() { this.db.close(); }
}

// Open the best available adapter. Falls back to memory so the app still runs.
export async function openStorage(name = 'ospeli') {
  try {
    return await IDBAdapter.open(name);
  } catch {
    return new MemoryAdapter();
  }
}
