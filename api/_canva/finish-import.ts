// POST /api/canva/finish-import — makes a Canva design from the uploaded deck (URL import), waits for it, deletes the
// uploaded file, and returns the design(s) with the edit link carrying the return state.
import { del } from '@vercel/blob';
import { HttpError, accessToken, canva, errorResponse, isValidState, json, pollJob } from '../_lib/canva.js';
import { PPTX_MIME, checkDeckUrl } from '../_lib/finish.js';

interface ImportJob {
  job: {
    id: string; status: string;
    result?: { designs: { id: string; title?: string; page_count?: number; urls: { edit_url: string } }[] };
    error?: { code: string; message: string };
  };
}

export async function POST(req: Request): Promise<Response> {
  let url = '';
  let cookies: string[] = [];
  try {
    const body = (await req.json().catch(() => ({}))) as { url?: string; title?: string; state?: string };
    url = checkDeckUrl(body.url);
    const state = String(body.state || '');
    if (!isValidState(state)) throw new HttpError(400, 'bad_state');
    const title = String(body.title || '카드소설').slice(0, 50);
    const { token, setCookies } = await accessToken(req);
    cookies = setCookies;
    const started = await canva<ImportJob>(token, '/url-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, url, mime_type: PPTX_MIME }),
    });
    const done = started.job.status === 'in_progress' ? await pollJob<ImportJob>(token, `/url-imports/${encodeURIComponent(started.job.id)}`, 52_000) : started;
    if (done.job.status !== 'success' || !done.job.result?.designs?.length) throw new HttpError(502, done.job.error?.code || 'import_failed', done.job.error?.message || 'import failed');
    const designs = done.job.result.designs.map((d) => {
      const edit = new URL(d.urls.edit_url);
      edit.searchParams.set('correlation_state', state);
      return { id: d.id, editUrl: edit.toString(), pages: d.page_count ?? null };
    });
    return json({ designs }, 200, setCookies);
  } catch (e) {
    return errorResponse(e, cookies);
  } finally {
    if (url) await del(url).catch(() => undefined);
  }
}
