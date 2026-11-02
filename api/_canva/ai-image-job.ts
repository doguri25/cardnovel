// POST /api/canva/ai-image-job — checks a Canva AI picture: still drawing, its download link, or why it failed.
import { HttpError, accessToken, canva, errorResponse, json } from '../_lib/canva.js';
import { aiError, outcome, type ImageJob } from './ai-image.js';

export async function POST(req: Request): Promise<Response> {
  let cookies: string[] = [];
  try {
    const body = (await req.json().catch(() => ({}))) as { jobId?: string };
    const jobId = String(body.jobId || '');
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(jobId)) throw new HttpError(400, 'bad_job');
    const { token, setCookies } = await accessToken(req);
    cookies = setCookies;
    const r = await canva<{ job: ImageJob }>(token, `/image-generations/${jobId}`).catch((e) => { throw aiError(e); });
    return json(outcome(r.job), 200, cookies);
  } catch (e) {
    return errorResponse(e, cookies);
  }
}
