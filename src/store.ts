// Everything stays on this device: works and settings in IndexedDB, with localStorage as a fallback.
import type { Work } from './model';

const DB_NAME = 'cardnovel-app';
type StoreName = 'works' | 'kv';

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('works', { keyPath: 'id' });
          r.result.createObjectStore('kv');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      } catch (e) { rej(e); }
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => res((rq ? rq.result : undefined) as T);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const LS = {
  read<T>(key: string, fallback: T): T { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } },
  write(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota or private mode */ } },
};

let useLS = false;

export const works = {
  async put(w: Work): Promise<void> {
    if (!useLS) { try { await tx('works', 'readwrite', (s) => s.put(w)); return; } catch { useLS = true; } }
    const m = LS.read<Record<string, Work>>('cardnovel.works', {}); m[w.id] = w; LS.write('cardnovel.works', m);
  },
  async get(id: string): Promise<Work | null> {
    if (!useLS) { try { return (await tx<Work | undefined>('works', 'readonly', (s) => s.get(id))) ?? null; } catch { useLS = true; } }
    return LS.read<Record<string, Work>>('cardnovel.works', {})[id] ?? null;
  },
  async all(): Promise<Work[]> {
    if (!useLS) { try { return (await tx<Work[]>('works', 'readonly', (s) => s.getAll())) ?? []; } catch { useLS = true; } }
    return Object.values(LS.read<Record<string, Work>>('cardnovel.works', {}));
  },
  async del(id: string): Promise<void> {
    if (!useLS) { try { await tx('works', 'readwrite', (s) => s.delete(id)); return; } catch { useLS = true; } }
    const m = LS.read<Record<string, Work>>('cardnovel.works', {}); delete m[id]; LS.write('cardnovel.works', m);
  },
};

export const kv = {
  async get<T>(key: string, fallback: T): Promise<T> {
    if (!useLS) {
      try { const v = await tx<T | undefined>('kv', 'readonly', (s) => s.get(key)); return v === undefined ? fallback : v; } catch { useLS = true; }
    }
    return LS.read<T>('cardnovel.kv.' + key, fallback);
  },
  async set(key: string, v: unknown): Promise<void> {
    if (!useLS) { try { await tx('kv', 'readwrite', (s) => s.put(v, key)); return; } catch { useLS = true; } }
    LS.write('cardnovel.kv.' + key, v);
  },
};

export const storageKind = (): 'indexeddb' | 'localstorage' => (useLS ? 'localstorage' : 'indexeddb');
