// Browser side of the Canva connection. Tokens stay on the server (/api/canva/*); the app only asks it to
// make a design, open it in Canva, and export it back when the writer returns.

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
};
export const canvaMessage = (e: unknown): string => {
  const code = e instanceof CanvaError ? e.code : 'network';
  return CANVA_MESSAGES[code] ?? `Canva 오류: ${(e as Error)?.message || code}`;
};

const API = '/api/canva';

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await fetch(API + path, { credentials: 'same-origin', ...init }); } catch { throw new CanvaError('network'); }
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
