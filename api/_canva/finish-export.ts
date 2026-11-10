// POST /api/canva/finish-export — exports every page of a finished design as JPEG and returns the download links
// (one per page, in page order). The browser then fetches each page through /api/canva/page.
import { HttpError, accessToken, canva, errorResponse, json, pollJob } from '../_lib/canva.js';

interface ExportJob { job: { id: string; status: string; urls?: string[]; error?: { code: string; message: string } } }

export async function POST(req: Request): Promise<Response> {
  let cookies: string[] = [];
  try {
    const body = (await req.json().catch(() => ({}))) as { designId?: string };
    const designId = String(body.designId || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(designId)) throw new HttpError(400, 'bad_design');
    const { token, setCookies } = await accessToken(req);
    cookies = setCookies;
    const started = await canva<ExportJob>(token, '/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ design_id: designId, format: { type: 'jpg', quality: 92 } }),
    });
    const done = started.job.status === 'in_progress' ? await pollJob<ExportJob>(token, `/exports/${encodeURIComponent(started.job.id)}`, 55_000) : started;
    if (done.job.status !== 'success' || !done.job.urls?.length) throw new HttpError(502, 'export_failed', done.job.error?.message || 'export failed');
    return json({ urls: done.job.urls }, 200, setCookies);
  } catch (e) {
    return errorResponse(e, cookies);
  }
}
