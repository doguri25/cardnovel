// POST /api/share/create — stores the manifest after the images are uploaded; returns the link.
import { put } from '@vercel/blob';
import { errorResponse, json } from '../_lib/canva.js';
import { checkKey, manifestPath, validateManifest, validId } from '../_lib/share.js';

export async function POST(req: Request): Promise<Response> {
  try {
    await checkKey(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = validId(body.id);
    const m = validateManifest(body, id);
    await put(manifestPath(id), JSON.stringify(m), {
      access: 'public', contentType: 'application/json; charset=utf-8', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60,
    });
    return json({ id, url: `${new URL(req.url).origin}/s/${id}` });
  } catch (e) {
    return errorResponse(e);
  }
}
