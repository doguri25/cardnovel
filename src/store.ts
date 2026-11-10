// Everything stays on this device: works and settings in IndexedDB, with localStorage as a fallback.
import type { Work } from './model';

const DB_NAME = 'cardnovel-app';
type StoreName = 'works' | 'kv';

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!dbp) {
    const p: Promise<IDBDatabase> = new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('works', { keyPath: 'id' });
          r.result.createObjectStore('kv');
        };
        r.onsuccess = () => {
          // the browser can drop the connection (Safari, after the app was in the background): open a new one next time
          r.result.onclose = () => { if (dbp === p) dbp = null; };
          res(r.result);
        };
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      } catch (e) { rej(e); }
    });
    dbp = p;
    p.catch(() => { if (dbp === p) dbp = null; });
  }
  return dbp;
}

function run<T>(db: IDBDatabase, store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => res((rq ? rq.result : undefined) as T);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
/** What a closed or lost connection answers with (Safari: "Connection to Indexed Database server lost"). */
const lostConnection = (e: unknown): boolean => { const n = (e as { name?: string } | null)?.name; return n === 'InvalidStateError' || n === 'UnknownError'; };

/** One request; on a dropped connection it is tried once more on a new one. Any other failure is passed on. */
async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const p = open();
  const db = await p;
  try {
    return await run<T>(db, store, mode, fn);
  } catch (e) {
    if (!lostConnection(e)) throw e;
    if (dbp === p) dbp = null;
    try { db.close(); } catch { /* already closed */ }
    return run<T>(await open(), store, mode, fn);
  }
}

const LS = {
  read<T>(key: string, fallback: T): T { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } },
  /** throws when it cannot write (full, or private mode), so the save is reported as failed */
  write(key: string, v: unknown) { localStorage.setItem(key, JSON.stringify(v)); },
};

/** localStorage only when IndexedDB cannot be opened at all (private mode, very old browsers). Decided once, on first use:
 *  a failed write later is reported to the caller and never moves the session to an empty localStorage. */
let useLS = false;
let decided: Promise<void> | null = null;
const idb = async (): Promise<boolean> => {
  decided ??= open().then(() => undefined, () => { useLS = true; });
  await decided;
  return !useLS;
};

export const works = {
  async put(w: Work): Promise<void> {
    if (await idb()) { await tx('works', 'readwrite', (s) => s.put(w)); return; }
    const m = LS.read<Record<string, Work>>('cardnovel.works', {}); m[w.id] = w; LS.write('cardnovel.works', m);
  },
  async get(id: string): Promise<Work | null> {
    if (await idb()) return (await tx<Work | undefined>('works', 'readonly', (s) => s.get(id))) ?? null;
    return LS.read<Record<string, Work>>('cardnovel.works', {})[id] ?? null;
  },
  async all(): Promise<Work[]> {
    if (await idb()) return (await tx<Work[]>('works', 'readonly', (s) => s.getAll())) ?? [];
    return Object.values(LS.read<Record<string, Work>>('cardnovel.works', {}));
  },
  async del(id: string): Promise<void> {
    if (await idb()) { await tx('works', 'readwrite', (s) => s.delete(id)); return; }
    const m = LS.read<Record<string, Work>>('cardnovel.works', {}); delete m[id]; LS.write('cardnovel.works', m);
  },
};

export const kv = {
  async get<T>(key: string, fallback: T): Promise<T> {
    if (await idb()) { const v = await tx<T | undefined>('kv', 'readonly', (s) => s.get(key)); return v === undefined ? fallback : v; }
    return LS.read<T>('cardnovel.kv.' + key, fallback);
  },
  async set(key: string, v: unknown): Promise<void> {
    if (await idb()) { await tx('kv', 'readwrite', (s) => s.put(v, key)); return; }
    LS.write('cardnovel.kv.' + key, v);
  },
  async del(key: string): Promise<void> {
    if (await idb()) { await tx('kv', 'readwrite', (s) => s.delete(key)); return; }
    try { localStorage.removeItem('cardnovel.kv.' + key); } catch { /* fine */ }
  },
};

export const storageKind = (): 'indexeddb' | 'localstorage' => (useLS ? 'localstorage' : 'indexeddb');
