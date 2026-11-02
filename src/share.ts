// Share links (browser side): upload the 20 cards as JPEGs, then the manifest; the server returns https://…/s/<id>.
import { captionText, renderToBlob } from './export';
import { seriesLine, stripMarks, workTitle, type Work } from './model';
import { kv } from './store';

export interface ShareRecord { id: string; url: string; title: string; workId: string; createdAt: number; cover?: string }

export class ShareError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}
export const SHARE_MESSAGES: Record<string, string> = {
  share_not_configured: '서버에 공유 저장소가 아직 설정되지 않았어요.',
  bad_share_key: '공유 열쇠가 맞지 않아요. 설정에서 확인해 주세요.',
  no_key: '설정에서 공유 열쇠를 먼저 넣어 주세요.',
  too_large: '카드 이미지가 너무 커요.',
  network: '인터넷 연결을 확인해 주세요.',
  unavailable: '공유 링크는 배포된 앱(https://cardnovel.vercel.app)에서만 만들 수 있어요.',
};
export const shareMessage = (e: unknown): string =>
  e instanceof ShareError ? SHARE_MESSAGES[e.code] ?? `공유 링크를 만들지 못했어요 (${e.code}).` : '공유 링크를 만들지 못했어요.';

async function api<T>(path: string, key: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/share/${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'x-share-key': key } });
  } catch {
    throw new ShareError('network');
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new ShareError(res.status === 404 ? 'unavailable' : 'upstream', res.status);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ShareError(data.error || 'upstream', res.status);
  return data;
}

export async function shareStatus(key: string): Promise<{ enabled: boolean; keyOk: boolean } | null> {
  try { return await api<{ enabled: boolean; keyOk: boolean }>('status', key); } catch { return null; }
}

export const newShareId = (): string => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => a[b % a.length]).join('');
};

/** Renders and uploads the 20 cards (three at a time), then publishes the manifest. */
export async function createShare(w: Work, key: string, onProgress: (done: number) => void, signal?: AbortSignal): Promise<ShareRecord> {
  if (!key) throw new ShareError('no_key');
  const id = newShareId();
  const urls: string[] = new Array(w.cards.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < w.cards.length) {
      if (signal?.aborted) throw new ShareError('cancelled');
      const i = next++;
      const blob = await renderToBlob(w, i, 'jpg');
      const r = await api<{ url: string }>(`upload?id=${id}&n=${i + 1}`, key, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob, signal });
      urls[i] = r.url;
      onProgress(++done);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const cover = w.cards[0];
  const r = await api<{ id: string; url: string }>('create', key, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ id, title: workTitle(w), hook: stripMarks(cover.text), caption: captionText(w), handle: w.handle, series: seriesLine(w), ratio: w.ratio, images: urls }),
  });
  const rec: ShareRecord = { id: r.id, url: r.url, title: workTitle(w), workId: w.id, createdAt: Date.now(), cover: w.thumb };
  await kv.set('shares', [rec, ...(await listShares())].slice(0, 200));
  return rec;
}

export async function deleteShare(id: string, key: string): Promise<void> {
  await api('delete', key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  await forgetShare(id);
}

export const listShares = (): Promise<ShareRecord[]> => kv.get<ShareRecord[]>('shares', []);
export async function forgetShare(id: string): Promise<void> {
  await kv.set('shares', (await listShares()).filter((s) => s.id !== id));
}
