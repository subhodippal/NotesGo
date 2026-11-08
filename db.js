// IndexedDB storage. Every change is saved on the device first, so the app works offline;
// sync.js uploads it to Supabase when there's a connection.
//
// Stores (rows have `synced: 0|1`; 0 = still needs uploading):
//   notes  { id, user_id (owner), kind: 'text'|'checklist', title, content, items[{id,text,done}], tags[],
//            color, pinned, archived, trashed, trashed_at, secure, cipher, edited_by, edited_at,
//            created_at, updated_at, deleted, synced }
//          Signed in, this holds your own notes plus notes other people shared with you.
//   shares { id, user_id (note owner), note_id, email, role: 'view'|'edit', owner_name, owner_email,
//            created_at, updated_at, deleted, synced }
//   vault  { user_id, salt, iterations, check_value, updated_at, synced }
//   meta   { key, value }   sync cursors etc.

const DB = (() => {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('notesgo', 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('shares')) db.createObjectStore('shares', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault', { keyPath: 'user_id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  const done = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  async function store(name, mode) {
    return (await open()).transaction(name, mode).objectStore(name);
  }

  async function putMany(name, rows) {
    if (!rows.length) return;
    const tx = (await open()).transaction(name, 'readwrite');
    rows.forEach((r) => tx.objectStore(name).put(r));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    all: async (name) => done((await store(name, 'readonly')).getAll()),
    get: async (name, id) => done((await store(name, 'readonly')).get(id)),
    put: async (name, row) => done((await store(name, 'readwrite')).put(row)),
    delete: async (name, id) => done((await store(name, 'readwrite')).delete(id)),
    putMany,
    getMeta: async (key) => (await done((await store('meta', 'readonly')).get(key)))?.value ?? null,
    setMeta: async (key, value) => done((await store('meta', 'readwrite')).put({ key, value })),
    async clearAll() {
      for (const name of ['notes', 'shares', 'vault', 'meta']) await done((await store(name, 'readwrite')).clear());
    },
  };
})();

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
