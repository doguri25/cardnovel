// POST /api/canva/ai-image-job — checks a Canva AI picture: still drawing, the picture (inline or a link to fetch
// through /api/canva/page), or why it failed.
import { HttpError, accessToken, errorResponse, json } from '../_lib/canva.js';
import { checkExportUrl } from '../_lib/finish.js';
import { callTool, jobOutcome } from '../_lib/mcp.js';
import { QUOTA } from './ai-image.js';

export async function POST(req: Request): Promise<Response> {
  let cookies: string[] = [];
  try {
    const body = (await req.json().catch(() => ({}))) as { jobId?: string };
    const jobId = String(body.jobId || '');
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(jobId)) throw new HttpError(400, 'bad_job');
    const { token, setCookies } = await accessToken(req);
    cookies = setCookies;
    const out = jobOutcome(await callTool(token, 'get-generate-image-job', { jobId, user_intent: 'Fetch the finished card illustration' }));
    if (out.status === 'failure') return json({ ...out, code: QUOTA.test(out.message || '') ? 'ai_quota' : 'ai_failed' }, 200, cookies);
    if (out.url) {
      // only Canva's own download hosts go through the page proxy
      try { out.url = checkExportUrl(out.url); } catch { return json({ status: 'failure', code: 'ai_no_image', message: 'unexpected picture link' }, 200, cookies); }
    }
    return json(out, 200, cookies);
  } catch (e) {
    return errorResponse(e, cookies);
  }
}
