// POST /api/share/upload?id=<id>&n=<1..20> — one card image (JPEG, under 4 MB) into the public store.
import { put } from '@vercel/blob';
import { HttpError, errorResponse, json } from '../_lib/canva.js';
import { checkKey, imagePath, validId } from '../_lib/share.js';

export async function POST(req: Request): Promise<Response> {
  try {
    await checkKey(req);
    const url = new URL(req.url);
    const id = validId(url.searchParams.get('id'));
    const n = Number(url.searchParams.get('n'));
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new HttpError(400, 'bad_index');
    if (!/^image\/jpeg\b/.test(req.headers.get('content-type') || '')) throw new HttpError(415, 'jpeg_only');
    const body = await req.arrayBuffer();
    if (!body.byteLength || body.byteLength > 4_000_000) throw new HttpError(413, 'too_large');
    const b = new Uint8Array(body);
    if (b[0] !== 0xff || b[1] !== 0xd8) throw new HttpError(415, 'jpeg_only');
    const r = await put(imagePath(id, n), body, {
      access: 'public', contentType: 'image/jpeg', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
    return json({ url: r.url });
  } catch (e) {
    return errorResponse(e);
  }
}
