// Browser side of the Canva connection. Tokens stay on the server (/api/canva/*); the app only asks it to
// make a design, open it in Canva, and export it back when the writer returns — or have Canva AI draw a picture.
import { aiMessage } from './ai/providers';

export class CanvaError extends Error {
  constructor(public code: string, message = code) { super(message); }
}

export const CANVA_MESSAGES: Record<string, string> = {
  not_connected: 'Canva 연결이 필요해요.',
  server_not_configured: '서버에 Canva 설정이 없어요. 배포 환경 변수를 확인해 주세요.',
  unavailable: 'Canva 연결은 배포된 앱(cardnovel.vercel.app)에서만 돼요.',
  image_too_large: '그림이 너무 커서 Canva로 보내지 못했어요.',
  upload_failed: '그림을 Canva에 올리지 못했어요.',
  export_failed: 'Canva에서 그림을 내보내지 못했어요.',
  job_timeout: 'Canva가 응답하는 데 너무 오래 걸려요. 잠시 뒤 다시 해 주세요.',
  too_many_requests: 'Canva 요청이 너무 잦아요. 잠시 뒤 다시 해 주세요.',
  network: '인터넷 연결을 확인해 주세요.',
  blob_not_configured: '서버에 파일 저장소가 설정되지 않았어요.',
  invalid_file: 'Canva가 카드 파일을 읽지 못했어요.',
  fetch_failed: 'Canva가 카드 파일을 내려받지 못했어요. 다시 해 주세요.',
  import_failed: 'Canva로 가져오지 못했어요. 다시 해 주세요.',
  design_import_throttled: 'Canva 가져오기 요청이 많아요. 잠시 뒤 다시 해 주세요.',
  design_import_already_in_progress: '이미 가져오는 중이에요. 잠시 뒤 다시 해 주세요.',
  download_failed: 'Canva에서 마감본 페이지를 받지 못했어요.',
  mcp_unauthorized: 'Canva AI가 이 연결을 받아 주지 않았어요. 「연결 끊기」 후 Canva를 다시 연결해 주세요.',
  mcp_forbidden: 'Canva AI를 쓸 권한이 없어요. Canva 앱 설정에서 AI 기능(MCP)을 허용했는지 확인해 주세요.',
  mcp_unavailable: '지금 Canva AI에 닿지 않아요. 잠시 뒤 다시 해 주세요.',
  mcp_error: 'Canva AI가 요청을 처리하지 못했어요.',
  ai_failed: 'Canva AI가 그림을 그리지 못했어요. 다시 해 보세요.',
  ai_quota: 'Canva AI 사용량을 다 썼어요. Canva 요금제의 AI 사용 한도를 확인해 주세요.',
  ai_timeout: 'Canva AI가 너무 오래 걸려요. 잠시 뒤 다시 해 주세요.',
  ai_no_image: 'Canva AI가 그림 파일을 돌려주지 않았어요. 다시 해 보세요.',
  not_an_image: 'Canva AI가 그림 파일을 돌려주지 않았어요. 다시 해 보세요.',
  cancelled: '그리기를 멈췄어요.',
};
export const canvaMessage = (e: unknown): string => {
  const code = e instanceof CanvaError ? e.code : 'network';
  const known = CANVA_MESSAGES[code];
  if (!known) return `Canva 오류: ${(e as Error)?.message || code}`;
  // Canva's own words help with a refused or failed picture (a blocked prompt, a plan limit)
  return (code === 'ai_failed' || code === 'mcp_error') && e instanceof CanvaError && e.message && e.message !== code ? `${known} (${e.message.slice(0, 140)})` : known;
};
/** The message for a failed picture, from Canva or from an AI provider. */
export const pictureMessage = (e: unknown): string => (e instanceof CanvaError ? canvaMessage(e) : aiMessage(e));
/** Errors after which drawing more pictures with Canva AI would fail the same way. */
export const CANVA_STOP = ['not_connected', 'unavailable', 'server_not_configured', 'mcp_unauthorized', 'mcp_forbidden', 'ai_quota', 'too_many_requests', 'cancelled', 'network'];

const API = '/api/canva';

export async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await fetch(API + path, { credentials: 'same-origin', ...init }); } catch { throw new CanvaError(init?.signal?.aborted ? 'cancelled' : 'network'); }
  if (res.status === 404 || (res.headers.get('content-type') || '').includes('text/html')) throw new CanvaError('unavailable');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new CanvaError(body.error || `http_${res.status}`, body.message || '');
  }
  return res;
}

/** true / false, or null when the server part is not there (local dev server, offline). */
export async function canvaStatus(): Promise<boolean | null> {
  try { return ((await (await call('/status')).json()) as { connected: boolean }).connected; } catch { return null; }
}

export const canvaLogin = (): void => { location.href = `${API}/login`; };
export async function canvaLogout(): Promise<void> { await call('/logout', { method: 'POST' }); }

export async function createDesign(opts: { width: number; height: number; title: string; image?: string; state: string }): Promise<{ designId: string; editUrl: string }> {
  const res = await call('/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) });
  return res.json();
}

/** Exports the design as PNG and returns it as a data URL. */
export async function exportDesign(designId: string): Promise<string> {
  const res = await call('/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ designId }) });
  const blob = await res.blob();
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob); });
}

/* ---------- Canva AI: pictures drawn by Canva's own image AI, on the writer's Canva account ---------- */
/** The picture shapes Canva AI draws (width / height). */
export const CANVA_ASPECTS: [string, number][] = [
  ['SQUARE_1_1', 1], ['LANDSCAPE_16_9', 16 / 9], ['LANDSCAPE_4_3', 4 / 3], ['LANDSCAPE_3_2', 3 / 2], ['LANDSCAPE_5_4', 5 / 4], ['LANDSCAPE_2_1', 2],
  ['PORTRAIT_9_16', 9 / 16], ['PORTRAIT_3_4', 3 / 4], ['PORTRAIT_2_3', 2 / 3], ['PORTRAIT_4_5', 4 / 5], ['PORTRAIT_1_2', 1 / 2],
];
/** The Canva shape closest to a picture area (compared on a log scale, so 2:1 and 1:2 are equally far from square). */
export function canvaAspect(ratio: number): string {
  const r = Math.log(ratio > 0 && Number.isFinite(ratio) ? ratio : 1);
  return CANVA_ASPECTS.reduce((best, a) => (Math.abs(Math.log(a[1]) - r) < Math.abs(Math.log(best[1]) - r) ? a : best))[0];
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new CanvaError('cancelled')); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(new CanvaError('cancelled')); };
  signal?.addEventListener('abort', stop, { once: true });
});
const post = (path: string, body: unknown, signal?: AbortSignal) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
async function responseDataUrl(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${res.headers.get('content-type') || 'image/png'};base64,${btoa(bin)}`;
}

export interface CanvaAiTiming { first: number; every: number; limit: number }
/** How long to wait for a picture: Canva AI usually takes 10–40 seconds. */
export const CANVA_AI_TIMING: CanvaAiTiming = { first: 4000, every: 3000, limit: 180000 };

/** Asks Canva AI for one picture and waits for it. `refs` are Canva media ids (an earlier Canva AI picture) to follow. */
export async function canvaAiImage(opts: { prompt: string; aspect: number; refs?: string[] }, signal?: AbortSignal, timing = CANVA_AI_TIMING): Promise<{ dataUrl: string; mediaId?: string }> {
  const body = { prompt: opts.prompt, aspect: canvaAspect(opts.aspect), refs: opts.refs ?? [] };
  let jobId = '';
  for (let attempt = 0; !jobId; attempt++) {
    try {
      jobId = ((await (await post('/ai-image', body, signal)).json()) as { jobId: string }).jobId;
    } catch (e) {
      // a short burst of requests (two cards at a time) can hit Canva's rate limit; wait it out twice
      if (e instanceof CanvaError && e.code === 'too_many_requests' && attempt < 2) { await wait(8000 * (attempt + 1), signal); continue; }
      throw e;
    }
  }
  const until = Date.now() + timing.limit;
  await wait(timing.first, signal);
  for (;;) {
    const r = (await (await post('/ai-image-job', { jobId }, signal)).json()) as { status: string; url?: string; data?: string; mediaId?: string; message?: string; code?: string };
    if (r.status === 'failure') throw new CanvaError(r.code || 'ai_failed', r.message || '');
    if (r.status === 'success' && (r.data || r.url)) {
      const dataUrl = r.data ?? (await responseDataUrl(await call(`/page?u=${encodeURIComponent(r.url!)}`, { signal })));
      return { dataUrl, mediaId: r.mediaId };
    }
    if (Date.now() > until) throw new CanvaError('ai_timeout');
    await wait(timing.every, signal);
  }
}

/** A card's current picture (raster or SVG) drawn to the picture-area size as JPEG, to place in the Canva design. */
export async function pictureForCanva(src: string, w: number, h: number, pos: 'top' | 'center' | 'bottom' = 'center'): Promise<string> {
  const im = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d')!;
  const iw = im.naturalWidth || w, ih = im.naturalHeight || h;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  const dy = pos === 'top' ? 0 : pos === 'bottom' ? h - dh : (h - dh) / 2;
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.drawImage(im, (w - dw) / 2, dy, dw, dh);
  return c.toDataURL('image/jpeg', 0.92);
}

/** State carried through Canva and back to find the card again: "<work id>~<card id>". */
export const canvaState = (workId: string, cardId: string): string => `${workId}~${cardId}`.replace(/[^A-Za-z0-9_~.-]/g, '').slice(0, 50);
export function parseCanvaState(s: string): { workId: string; cardId: string } | null {
  const i = s.indexOf('~');
  return i > 0 ? { workId: s.slice(0, i), cardId: s.slice(i + 1) } : null;
}

export interface CanvaLanding { kind: 'connected' | 'error' | 'return'; reason?: string; design?: string; state?: string }
export function readLanding(url: URL): CanvaLanding | null {
  const k = url.searchParams.get('canva');
  if (k === 'connected') return { kind: 'connected' };
  if (k === 'error') return { kind: 'error', reason: url.searchParams.get('reason') || '' };
  if (k === 'return') return { kind: 'return', design: url.searchParams.get('design') || '', state: url.searchParams.get('state') || '' };
  return null;
}
