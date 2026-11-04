// Google Drive backup (browser only): Google Identity Services gives a 1-hour token for the drive.file scope,
// which reaches only the files this app made — one folder, one JSON file per work.
import type { Work } from './model';
import { kv } from './store';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_NAME = '카드소설 제작소';

export class DriveError extends Error {
  constructor(public code: 'no_client' | 'auth' | 'popup' | 'network' | 'quota' | 'not_found' | 'upstream', message = '') { super(message || code); }
}
export const DRIVE_MESSAGES: Record<DriveError['code'], string> = {
  no_client: '설정에서 Google OAuth 클라이언트 ID를 먼저 넣어 주세요.',
  auth: '구글 드라이브 연결이 끊겼어요. 다시 연결해 주세요.',
  popup: '구글 로그인 창이 닫혔거나 막혔어요. 팝업을 허용하고 다시 눌러 주세요.',
  network: '인터넷 연결을 확인해 주세요.',
  quota: '구글 드라이브 저장 공간이나 요청 한도가 찼어요.',
  not_found: '드라이브에서 파일을 찾지 못했어요.',
  upstream: '구글 드라이브가 잠시 응답하지 않아요. 다시 해 주세요.',
};
export const driveMessage = (e: unknown): string => (e instanceof DriveError ? DRIVE_MESSAGES[e.code] : DRIVE_MESSAGES.upstream);

/* ---------- sign-in (Google Identity Services token model) ---------- */
interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string }): void }
interface Gis {
  accounts: { oauth2: {
    initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient;
    revoke(token: string, done?: () => void): void;
  } };
}
declare global { interface Window { google?: Gis } }

let gisLoading: Promise<void> | null = null;
/** Loads the Google sign-in library ahead of the click, so the sign-in pop-up opens from the click itself. */
export function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise<void>((res, rej) => {
      const s = document.createElement('script');
      s.src = GIS_SRC; s.async = true;
      s.onload = () => res();
      s.onerror = () => { gisLoading = null; rej(new DriveError('network')); };
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

let token: { value: string; exp: number } | null = null;
try {
  const saved = JSON.parse(sessionStorage.getItem('cardnovel.drive') || 'null');
  if (saved && saved.exp > Date.now()) token = saved;
} catch { /* storage may be blocked */ }

export const connected = (): boolean => !!token && token.exp > Date.now() + 30_000;

/** Asks Google for a token. Call from a click: the first time it shows the consent pop-up. */
export async function connect(clientId: string): Promise<void> {
  if (!clientId) throw new DriveError('no_client');
  await loadGis();
  await new Promise<void>((res, rej) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (!r.access_token) { rej(new DriveError('auth', r.error)); return; }
        token = { value: r.access_token, exp: Date.now() + (r.expires_in ?? 3600) * 1000 };
        try { sessionStorage.setItem('cardnovel.drive', JSON.stringify(token)); } catch { /* fine */ }
        void kv.set('drive.linked', true);
        res();
      },
      error_callback: (e) => rej(new DriveError(e?.type === 'popup_failed_to_open' || e?.type === 'popup_closed' ? 'popup' : 'auth', e?.type)),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function disconnect(): void {
  const t = token?.value;
  token = null;
  try { sessionStorage.removeItem('cardnovel.drive'); } catch { /* fine */ }
  if (t) { try { window.google?.accounts.oauth2.revoke(t); } catch { /* best effort */ } }
}

/* ---------- REST ---------- */
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  if (!connected()) throw new DriveError('auth');
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token!.value}` } });
  } catch {
    throw new DriveError('network');
  }
  if (res.status === 401) { token = null; throw new DriveError('auth'); }
  if (res.status === 403 || res.status === 429) {
    const t = await res.text().catch(() => '');
    throw new DriveError(/quota|rateLimit|storage/i.test(t) || res.status === 429 ? 'quota' : 'auth', t.slice(0, 200));
  }
  if (res.status === 404) throw new DriveError('not_found');
  if (!res.ok) throw new DriveError('upstream', `${res.status}`);
  return res;
}
const getJSON = async <T>(url: string, init?: RequestInit): Promise<T> => (await call(url, init)).json() as Promise<T>;

export interface DriveFile {
  id: string; name: string; modifiedTime: string; size?: string;
  appProperties?: { cardnovelId?: string; updatedAt?: string; series?: string; episode?: string };
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

let folderId: string | null = null;
export async function ensureFolder(): Promise<string> {
  if (folderId) return folderId;
  const found = await getJSON<{ files: { id: string }[] }>(`${API}/files?` + new URLSearchParams({
    q: `mimeType='application/vnd.google-apps.folder' and name='${q(FOLDER_NAME)}' and trashed=false`, fields: 'files(id)', spaces: 'drive', pageSize: '5',
  }));
  if (found.files[0]) return (folderId = found.files[0].id);
  const made = await getJSON<{ id: string }>(`${API}/files?fields=id`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return (folderId = made.id);
}

const FIELDS = 'id,name,modifiedTime,size,appProperties';

export async function listBackups(): Promise<DriveFile[]> {
  const folder = await ensureFolder();
  const out: DriveFile[] = [];
  let pageToken = '';
  do {
    const r = await getJSON<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?` + new URLSearchParams({
      q: `'${q(folder)}' in parents and trashed=false and appProperties has { key='app' and value='cardnovel' }`,
      fields: `nextPageToken,files(${FIELDS})`, orderBy: 'modifiedTime desc', pageSize: '200', spaces: 'drive', ...(pageToken ? { pageToken } : {}),
    }));
    out.push(...r.files);
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function findBackup(workId: string): Promise<DriveFile | null> {
  const r = await getJSON<{ files: DriveFile[] }>(`${API}/files?` + new URLSearchParams({
    q: `appProperties has { key='cardnovelId' and value='${q(workId)}' } and trashed=false`, fields: `files(${FIELDS})`, spaces: 'drive', pageSize: '5',
  }));
  return r.files[0] ?? null;
}

export const backupName = (w: Work): string =>
  `${[w.series, w.episode ? `${w.episode}화` : '', (w.cards[0]?.title || '').trim() || '제목 없음'].filter(Boolean).join(' ')}.cardnovel.json`.replace(/[\\/:*?"<>|]+/g, '_');

/** Writes one work (create or update) with a resumable upload: works with pictures can be larger than 5 MB. */
export async function uploadWork(w: Work, existing: DriveFile | null): Promise<DriveFile> {
  const body = JSON.stringify({ app: 'cardnovel', version: 1, work: w });
  const meta: Record<string, unknown> = {
    name: backupName(w),
    mimeType: 'application/json',
    appProperties: { app: 'cardnovel', cardnovelId: w.id, updatedAt: String(w.updatedAt || 0), series: (w.series || '').slice(0, 60), episode: String(w.episode || '') },
  };
  if (!existing) meta.parents = [await ensureFolder()];
  const params = `uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`;
  const start = await call(existing ? `${UPLOAD}/files/${encodeURIComponent(existing.id)}?${params}` : `${UPLOAD}/files?${params}`, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/json' },
    body: JSON.stringify(meta),
  });
  const session = start.headers.get('location');
  if (!session) throw new DriveError('upstream', 'no upload session');
  let res: Response;
  try {
    res = await fetch(session, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  } catch {
    throw new DriveError('network');
  }
  if (!res.ok) throw new DriveError(res.status === 403 ? 'quota' : 'upstream', `${res.status}`);
  await markSynced(w.id, w.updatedAt || 0);
  return (await res.json()) as DriveFile;
}

export async function downloadWork(fileId: string): Promise<Work> {
  const data = await getJSON<{ work?: Work } & Partial<Work>>(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
  const w = (data.work ?? data) as Work;
  if (!w || !Array.isArray(w.cards)) throw new DriveError('not_found', 'not a cardnovel file');
  return w;
}

/** How a Drive copy compares with this device's copy of the same work. */
export type SyncState = 'drive_only' | 'same' | 'drive_newer' | 'local_newer';
export function compareCopies(file: DriveFile, local: Pick<Work, 'updatedAt'> | undefined): SyncState {
  if (!local) return 'drive_only';
  const d = Number(file.appProperties?.updatedAt || 0), l = local.updatedAt || 0;
  return d === l ? 'same' : d > l ? 'drive_newer' : 'local_newer';
}

/* ---------- continuing on another device ---------- */
/** For each work, the save time both this device and Drive last agreed on; tells "changed here" from "changed there". */
export const syncedMap = (): Promise<Record<string, number>> => kv.get<Record<string, number>>('drive.synced', {});
export async function markSynced(id: string, updatedAt: number): Promise<void> {
  const m = await syncedMap();
  m[id] = updatedAt;
  await kv.set('drive.synced', m);
}
export const driveTime = (f: DriveFile): number => Number(f.appProperties?.updatedAt || 0);

/** What to do with one work: nothing, take Drive's copy, or ask (both sides changed, or never compared before). */
export function decide(file: DriveFile | undefined, local: Pick<Work, 'updatedAt'>, syncedAt: number | undefined): 'none' | 'load' | 'ask' {
  if (!file) return 'none';
  const d = driveTime(file);
  if (d <= (local.updatedAt || 0)) return 'none';
  if (syncedAt === undefined || (local.updatedAt || 0) > syncedAt) return 'ask';
  return 'load';
}

export interface SyncPlan {
  current: 'none' | 'load' | 'ask';
  currentFile?: DriveFile;
  /** other works changed only on Drive: safe to update here */
  update: DriveFile[];
  /** other works changed on both sides: left alone, listed for the writer */
  conflicts: DriveFile[];
  /** works that are on Drive but not on this device */
  onlyOnDrive: DriveFile[];
}
export function planSync(files: DriveFile[], locals: Pick<Work, 'id' | 'updatedAt'>[], synced: Record<string, number>, currentId: string): SyncPlan {
  const byId = new Map(locals.map((w) => [w.id, w]));
  const plan: SyncPlan = { current: 'none', update: [], conflicts: [], onlyOnDrive: [] };
  for (const f of files) {
    const id = f.appProperties?.cardnovelId;
    if (!id) continue;
    const local = byId.get(id);
    if (!local) { plan.onlyOnDrive.push(f); continue; }
    const d = decide(f, local, synced[id]);
    if (id === currentId) { plan.current = d; if (d !== 'none') plan.currentFile = f; continue; }
    if (d === 'load') plan.update.push(f); else if (d === 'ask') plan.conflicts.push(f);
  }
  return plan;
}
