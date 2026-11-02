// POST /api/share/delete — removes a link's images and manifest; the page then says it is gone.
import { del, list } from '@vercel/blob';
import { errorResponse, json } from '../_lib/canva.js';
import { checkKey, validId } from '../_lib/share.js';

export async function POST(req: Request): Promise<Response> {
  try {
    await checkKey(req);
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const id = validId(body.id);
    const { blobs } = await list({ prefix: `shares/${id}/`, limit: 100 });
    if (blobs.length) await del(blobs.map((b) => b.url));
    return json({ deleted: blobs.length });
  } catch (e) {
    return errorResponse(e);
  }
}
