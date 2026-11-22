// Shared bits of the "finish the 20 cards in Canva" flow.
import { HttpError } from './canva.js';

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** The deck must be one this app just uploaded to its own Blob store. */
export function checkDeckUrl(raw: unknown): string {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { throw new HttpError(400, 'bad_url'); }
  if (u.protocol !== 'https:' || !/\.public\.blob\.vercel-storage\.com$/.test(u.hostname) || !/^\/canva-import\/[A-Za-z0-9-]+\.pptx$/.test(u.pathname) || u.search) {
    throw new HttpError(400, 'bad_url');
  }
  return u.toString();
}

/** Export download links come from Canva's own hosts. */
export function checkExportUrl(raw: unknown): string {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { throw new HttpError(400, 'bad_url'); }
  if (u.protocol !== 'https:' || !/(^|\.)canva\.com$|(^|\.)canva-[a-z0-9-]+\.com$|\.amazonaws\.com$|\.cloudfront\.net$/.test(u.hostname)) {
    throw new HttpError(400, 'bad_url', `unexpected host ${u.hostname}`);
  }
  return u.toString();
}
