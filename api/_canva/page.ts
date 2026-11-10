// GET /api/canva/page?u=<Canva export link> — passes one exported page to the browser (the links are not CORS-enabled).
// Only for a browser signed in to Canva, and only for Canva's download hosts.
import { HttpError, errorResponse, isConnected } from '../_lib/canva.js';
import { checkExportUrl } from '../_lib/finish.js';

/** Pictures a browser only ever shows as pictures. An SVG (or anything else) could open as a page on this app's origin. */
const RASTER = /^image\/(png|jpe?g|webp|gif)$/;
const MAX_REDIRECTS = 5;

export async function GET(req: Request): Promise<Response> {
  try {
    if (!(await isConnected(req))) throw new HttpError(401, 'not_connected');
    let target = checkExportUrl(new URL(req.url).searchParams.get('u'));
    // redirects are followed here, so every link on the way is checked against Canva's hosts too
    let res: Response;
    for (let hops = 0; ; hops++) {
      res = await fetch(target, { redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = res.headers.get('location');
      await res.body?.cancel();
      if (!next || hops >= MAX_REDIRECTS) throw new HttpError(502, 'download_failed', next ? 'too many redirects' : 'redirect without a location');
      try { target = checkExportUrl(new URL(next, target).toString()); } catch { throw new HttpError(502, 'download_failed', 'redirect to an unexpected host'); }
    }
    if (!res.ok) throw new HttpError(502, 'download_failed', `download ${res.status}`);
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!RASTER.test(type)) { await res.body?.cancel(); throw new HttpError(502, 'not_an_image'); }
    // passed through as it arrives: a generated picture can be larger than a function may hold and send at once
    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': type, 'cache-control': 'no-store',
        // even if a link ever gets past the checks above, nothing in the answer may run on this origin
        'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="page"',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
