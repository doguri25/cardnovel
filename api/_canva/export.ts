// POST /api/canva/export — exports a design as PNG and returns the image bytes.
import { HttpError, accessToken, canva, errorResponse, pollJob } from '../_lib/canva.js';

interface ExportJob { job: { id: string; status: string; urls?: string[]; error?: { code: string; message: string } } }

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { designId?: string };
    const designId = String(body.designId || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(designId)) throw new HttpError(400, 'bad_design');
    const { token, setCookies } = await accessToken(req);
    const started = await canva<ExportJob>(token, '/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ design_id: designId, format: { type: 'png' } }),
    });
    const done = started.job.status === 'in_progress' ? await pollJob<ExportJob>(token, `/exports/${encodeURIComponent(started.job.id)}`, 50_000) : started;
    const url = done.job.urls?.[0];
    if (done.job.status !== 'success' || !url) throw new HttpError(502, 'export_failed', done.job.error?.message || 'export failed');
    const img = await fetch(url);
    if (!img.ok) throw new HttpError(502, 'download_failed', `download ${img.status}`);
    const h = new Headers({ 'content-type': img.headers.get('content-type') || 'image/png', 'cache-control': 'no-store' });
    setCookies.forEach((c) => h.append('set-cookie', c));
    return new Response(await img.arrayBuffer(), { status: 200, headers: h });
  } catch (e) {
    return errorResponse(e);
  }
}
