// History persistence. Metadata and bodies live in separate object stores so the
// sidebar can list every entry without reading multi-megabyte texts back.
const DB_NAME = 'textizer';
const DB_VERSION = 1;

const settle = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const commit = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
});

class IndexedStore {
  kind = 'indexeddb';
  constructor(db) { this.db = db; }

  list() {
    return settle(this.db.transaction('entries').objectStore('entries').getAll());
  }

  async text(id) {
    const row = await settle(this.db.transaction('bodies').objectStore('bodies').get(id));
    return row?.text ?? '';
  }

  async document(id) {
    return await settle(this.db.transaction('bodies').objectStore('bodies').get(id)) ?? { text: '' };
  }

  // Omitting text updates metadata only, e.g. a page count after layout.
  put(meta, text) {
    const tx = this.db.transaction(['entries', 'bodies'], 'readwrite');
    tx.objectStore('entries').put(meta);
    if (text !== undefined) tx.objectStore('bodies').put(typeof text === 'string' ? { id: meta.id, text } : { ...text, id: meta.id });
    return commit(tx);
  }

  remove(id) {
    const tx = this.db.transaction(['entries', 'bodies'], 'readwrite');
    tx.objectStore('entries').delete(id);
    tx.objectStore('bodies').delete(id);
    return commit(tx);
  }

  clear() {
    const tx = this.db.transaction(['entries', 'bodies'], 'readwrite');
    tx.objectStore('entries').clear();
    tx.objectStore('bodies').clear();
    return commit(tx);
  }
}

// Used when IndexedDB is unavailable (blocked storage, some private modes).
class MemoryStore {
  kind = 'memory';
  #entries = new Map();
  #bodies = new Map();
  constructor(reason) { this.reason = reason; }
  async list() { return [...this.#entries.values()].map(meta => ({ ...meta })); }
  async text(id) { const body = this.#bodies.get(id); return typeof body === 'string' ? body : body?.text ?? ''; }
  async document(id) { const body = this.#bodies.get(id); return typeof body === 'string' ? { text: body } : body ?? { text: '' }; }
  async put(meta, text) {
    this.#entries.set(meta.id, { ...meta });
    if (text !== undefined) this.#bodies.set(meta.id, text);
  }
  async remove(id) { this.#entries.delete(id); this.#bodies.delete(id); }
  async clear() { this.#entries.clear(); this.#bodies.clear(); }
}

export async function openStore() {
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries', { keyPath: 'id' });
        request.result.createObjectStore('bodies', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('database upgrade blocked by another tab'));
    });
    // Let a newer schema in another tab take over instead of blocking it.
    db.onversionchange = () => db.close();
    return new IndexedStore(db);
  } catch (error) {
    return new MemoryStore(error instanceof Error ? error.message : String(error));
  }
}
