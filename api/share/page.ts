// GET /s/<id> (rewritten to /api/share/page?id=<id>) — the public viewer page for one share link.
import { head } from '@vercel/blob';
import { ID_RE, manifestPath, notFoundPage, randomNonce, sharePage, type ShareManifest } from '../_lib/share.js';

const html = (body: string, status: number, nonce = '', cache = 'no-store'): Response => new Response(body, {
  status,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': cache,
    'content-security-policy': `default-src 'none'; img-src https://*.public.blob.vercel-storage.com; style-src ${nonce ? `'nonce-${nonce}'` : "'unsafe-inline'"} https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  },
});

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const id = url.searchParams.get('id') || '';
  if (!ID_RE.test(id) || !process.env.BLOB_READ_WRITE_TOKEN) return html(notFoundPage(origin), 404);
  try {
    const meta = await head(manifestPath(id));
    const res = await fetch(meta.url, { cache: 'no-store' });
    if (!res.ok) return html(notFoundPage(origin), 404);
    const m = (await res.json()) as ShareManifest;
    if (m?.id !== id || !Array.isArray(m.images) || !m.images.length) return html(notFoundPage(origin), 404);
    const nonce = randomNonce();
    return html(sharePage(m, origin, nonce), 200, nonce, 'public, max-age=0, s-maxage=60');
  } catch {
    return html(notFoundPage(origin), 404);
  }
}
