// GET /api/canva/page?u=<Canva export link> — passes one exported page to the browser (the links are not CORS-enabled).
// Only for a browser signed in to Canva, and only for Canva's download hosts.
import { HttpError, errorResponse, isConnected } from '../_lib/canva.js';
import { checkExportUrl } from '../_lib/finish.js';

export async function GET(req: Request): Promise<Response> {
  try {
    if (!(await isConnected(req))) throw new HttpError(401, 'not_connected');
    const target = checkExportUrl(new URL(req.url).searchParams.get('u'));
    const res = await fetch(target);
    if (!res.ok) throw new HttpError(502, 'download_failed', `download ${res.status}`);
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(type)) throw new HttpError(502, 'not_an_image');
    // passed through as it arrives: a generated picture can be larger than a function may hold and send at once
    return new Response(res.body, { status: 200, headers: { 'content-type': type, 'cache-control': 'no-store' } });
  } catch (e) {
    return errorResponse(e);
  }
}
