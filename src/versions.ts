// Version history: snapshots of a work in their own IndexedDB database. Pictures (the bulk of a work) are stored
// once by content hash and shared between versions, so keeping many versions costs little.
import { countChars, stripMarks, workTitle, type Work } from './model';

export type VersionReason = 'manual' | 'timer' | 'compose' | 'draw' | 'drive' | 'canva' | 'restore' | 'leave' | 'proof';
export const REASON_NAME: Record<VersionReason, string> = {
  manual: '직접 저장', timer: '자동 (10분마다)', compose: '카드 구성 전', draw: '그림 다시 그리기 전',
  drive: '드라이브 사본 불러오기 전', canva: 'Canva 마감본 받기 전', restore: '되돌리기 전', leave: '다른 작품으로 옮기기 전', proof: '일괄 교정 적용 전',
};

export interface VersionMeta {
  id: string;
  workId: string;
  at: number;
  reason: VersionReason;
  label?: string;
  title: string;
  thumb?: string;
  /** cards with words / with pictures, for the list */
  texts: number;
  pics: number;
  /** fingerprint of the whole work (pictures by hash): an unchanged work is not saved twice */
  sig: string;
}
interface VersionRec extends VersionMeta { work: Work; hashes: string[] }
interface BlobRec { h: string; data: string; refs: number }

const DB = 'cardnovel-versions';
const KEEP_AUTO = 30;
const REF = 'vblob:';

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => {
          const v = r.result.createObjectStore('versions', { keyPath: 'id' });
          v.createIndex('workId', 'workId');
          r.result.createObjectStore('blobs', { keyPath: 'h' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
export const versionsAvailable = (): boolean => typeof indexedDB !== 'undefined';

/** Two FNV-1a passes and the length: a cheap fingerprint for long data URLs. */
export function hashString(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${s.length.toString(36)}-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

/** Copy of the work with each large picture replaced by a reference; the pictures are returned separately. */
export function detach(w: Work): { work: Work; blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  const ref = (s: string | undefined): string | undefined => {
    if (!s || s.length < 2000) return s;
    const h = hashString(s);
    blobs.set(h, s);
    return REF + h;
  };
  const work: Work = {
    ...w,
    cards: w.cards.map((c) => ({ ...c, img: ref(c.img), svg: ref(c.svg) })),
    style: { ...w.style, refImage: ref(w.style.refImage) },
    ...(w.finished ? { finished: { ...w.finished, images: w.finished.images.map((x) => ref(x) as string) } } : {}),
    ...(w.brand ? { brand: { ...w.brand, logo: ref(w.brand.logo) } } : {}),
  };
  for (const c of work.cards) { if (c.img === undefined) delete c.img; if (c.svg === undefined) delete c.svg; }
  if (work.style.refImage === undefined) delete work.style.refImage;
  if (work.brand && work.brand.logo === undefined) delete work.brand.logo;
  return { work, blobs };
}

/** The reverse of detach(). */
export function attach(w: Work, blobs: Map<string, string>): Work {
  const val = (s: string | undefined) => (s && s.startsWith(REF) ? blobs.get(s.slice(REF.length)) : s);
  const out: Work = JSON.parse(JSON.stringify(w));
  for (const c of out.cards) { if (c.img) c.img = val(c.img); if (c.svg) c.svg = val(c.svg); }
  if (out.style.refImage) out.style.refImage = val(out.style.refImage);
  if (out.finished) out.finished.images = out.finished.images.map((x) => val(x) ?? '').filter(Boolean);
  if (out.brand?.logo) out.brand.logo = val(out.brand.logo);
  return out;
}

/** Object keys in a fixed order, so the same work always gives the same fingerprint. */
const sortedKeys = (_k: string, v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v;
/** Fingerprint of a detached work: everything the writer can change (caption, posts, style, card design too),
 *  leaving out what changes by itself (save time, library thumbnail) and the ids. */
function sigOf(detached: Work): string {
  const { id: _id, createdAt: _c, updatedAt: _u, thumb: _t, ...rest } = detached;
  return hashString(JSON.stringify({ ...rest, cards: rest.cards.map(({ id: _cid, ...c }) => c) }, sortedKeys));
}
/** Fingerprint of a whole work (pictures by hash, so this is cheap to compare). */
export const workSig = (w: Work): string => sigOf(detach(w).work);

/** How many cards differ (words or picture) between two works. */
export function changedCards(a: Work, b: Work): number {
  const key = (w: Work, i: number) => { const c = w.cards[i]; return c ? [c.title, c.text, c.img ? hashString(c.img) : '', c.svg ? hashString(c.svg) : ''].join('\u0001') : ''; };
  let n = 0;
  for (let i = 0; i < Math.max(a.cards.length, b.cards.length); i++) if (key(a, i) !== key(b, i)) n++;
  return n;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export async function listVersions(workId: string): Promise<VersionMeta[]> {
  const db = await open();
  const t = db.transaction('versions', 'readonly');
  const all = await req<VersionRec[]>(t.objectStore('versions').index('workId').getAll(workId));
  return all.map(({ work: _w, hashes: _h, ...meta }) => meta).sort((x, y) => y.at - x.at);
}

/** Saves a version unless the work is unchanged since its latest version (manual saves always count). */
export async function saveVersion(w: Work, reason: VersionReason, label?: string): Promise<VersionMeta | null> {
  const { work, blobs } = detach(w);
  const sig = sigOf(work);
  const list = await listVersions(w.id);
  if (reason !== 'manual' && list[0]?.sig === sig) return null;
  const meta: VersionMeta = {
    id: `${w.id}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    workId: w.id, at: Date.now(), reason, ...(label ? { label } : {}),
    title: workTitle(w), thumb: w.thumb,
    texts: w.cards.filter((c) => countChars(stripMarks(c.text)) > 0).length,
    pics: w.cards.filter((c) => c.img || c.svg).length,
    sig,
  };
  const db = await open();
  const t = db.transaction(['versions', 'blobs'], 'readwrite');
  const bs = t.objectStore('blobs');
  for (const [h, data] of blobs) {
    const got = await req<BlobRec | undefined>(bs.get(h));
    bs.put(got ? { ...got, refs: got.refs + 1 } : { h, data, refs: 1 });
  }
  t.objectStore('versions').put({ ...meta, work, hashes: [...blobs.keys()] } satisfies VersionRec);
  await done(t);
  if (reason !== 'manual') await prune(w.id);
  return meta;
}

async function prune(workId: string) {
  const autos = (await listVersions(workId)).filter((v) => v.reason !== 'manual');
  for (const v of autos.slice(KEEP_AUTO)) await deleteVersion(v.id);
}

export async function loadVersion(id: string): Promise<Work | null> {
  const db = await open();
  const t = db.transaction(['versions', 'blobs'], 'readonly');
  const rec = await req<VersionRec | undefined>(t.objectStore('versions').get(id));
  if (!rec) return null;
  const blobs = new Map<string, string>();
  for (const h of rec.hashes) {
    const b = await req<BlobRec | undefined>(t.objectStore('blobs').get(h));
    if (b) blobs.set(h, b.data);
  }
  return attach(rec.work, blobs);
}

export async function deleteVersion(id: string): Promise<void> {
  const db = await open();
  const t = db.transaction(['versions', 'blobs'], 'readwrite');
  const vs = t.objectStore('versions'), bs = t.objectStore('blobs');
  const rec = await req<VersionRec | undefined>(vs.get(id));
  if (rec) {
    for (const h of rec.hashes) {
      const b = await req<BlobRec | undefined>(bs.get(h));
      if (!b) continue;
      if (b.refs <= 1) bs.delete(h); else bs.put({ ...b, refs: b.refs - 1 });
    }
    vs.delete(id);
  }
  await done(t);
}

export async function renameVersion(id: string, label: string): Promise<void> {
  const db = await open();
  const t = db.transaction('versions', 'readwrite');
  const s = t.objectStore('versions');
  const rec = await req<VersionRec | undefined>(s.get(id));
  if (rec) s.put({ ...rec, label: label.trim() || undefined, reason: label.trim() ? 'manual' : rec.reason });
  await done(t);
}

export async function deleteAllVersions(workId: string): Promise<void> {
  for (const v of await listVersions(workId)) await deleteVersion(v.id);
}
