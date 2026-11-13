// Storage for the site server: one SQLite file on the site's own computer, through Node's
// built-in SQLite (no packages to install). Same small API as the browser's adapters
// (web/app/core/db.js), so the core does not know which one it runs on.
//
// One process owns the file (exclusive lock): a second server on the same file is refused,
// because the core keeps the tail of the audit chain in memory and two writers would fork it.
// Every write goes to disk first, then to an in-memory copy that reads are served from.
import { DatabaseSync } from 'node:sqlite';

const KEYS = { entities: 'id', events: 'seq', audit: 'seq', meta: 'id' };
const STORES = Object.keys(KEYS);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const constraintError = (store, key) => Object.assign(new Error(`${store}: key ${key} already exists`), { name: 'ConstraintError' });

export class StoreInUseError extends Error {}

export class SqliteAdapter {
  constructor(db, file) {
    this.kind = 'sqlite';
    this.file = file;
    this.db = db;
    this.data = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  }

  static open(file) {
    let db;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
      db.exec('BEGIN IMMEDIATE; COMMIT;'); // takes the exclusive lock now, or fails if another process has it
    } catch (err) {
      try { db?.close(); } catch { /* nothing to close */ }
      if (/locked|busy/i.test(String(err?.message))) throw new StoreInUseError(file);
      throw err;
    }
    const a = new SqliteAdapter(db, file);
    for (const s of STORES) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${s} (k ${KEYS[s] === 'seq' ? 'INTEGER' : 'TEXT'} PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
      for (const row of db.prepare(`SELECT k, v FROM ${s}`).all()) a.data[s].set(row.k, JSON.parse(row.v));
    }
    return a;
  }

  _s(store) {
    const s = this.data[store];
    if (!s) throw new Error(`unknown store ${store}`);
    return s;
  }
  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  async get(store, key) { return clone(this._s(store).get(key)); }
  async getAll(store) {
    const k = KEYS[store];
    return [...this._s(store).values()].map(clone).sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0));
  }
  async put(store, record) { return this.putMany(store, [record]); }
  async putMany(store, records) {
    const s = this._s(store); const k = KEYS[store];
    const stmt = this.db.prepare(`INSERT INTO ${store} (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
    this._tx(() => { for (const r of records) stmt.run(r[k], JSON.stringify(r)); });
    for (const r of records) s.set(r[k], clone(r));
  }
  async add(store, record) { return this.addMany(store, [record]); }
  // All or nothing; a key that already exists is refused (the logs are append-only).
  async addMany(store, records) {
    const s = this._s(store); const k = KEYS[store];
    const seen = new Set();
    for (const r of records) {
      if (s.has(r[k]) || seen.has(r[k])) throw constraintError(store, r[k]);
      seen.add(r[k]);
    }
    const stmt = this.db.prepare(`INSERT INTO ${store} (k, v) VALUES (?, ?)`);
    this._tx(() => { for (const r of records) stmt.run(r[k], JSON.stringify(r)); });
    for (const r of records) s.set(r[k], clone(r));
  }
  async last(store) {
    const k = KEYS[store]; let best;
    for (const v of this._s(store).values()) if (best === undefined || v[k] > best[k]) best = v;
    return best === undefined ? null : clone(best);
  }
  async clear(store) { this._s(store); this.db.exec(`DELETE FROM ${store}`); this.data[store].clear(); }
  async count(store) { return this._s(store).size; }
  // A complete copy of the data file, safe to take while the server runs.
  backupTo(path) { this.db.prepare('VACUUM INTO ?').run(path); }
  async close() { this.db.close(); }
}
