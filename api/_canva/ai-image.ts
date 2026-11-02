// POST /api/canva/ai-image — starts a Canva AI picture with Canva's image generation API (preview), on the writer's
// own Canva account and AI allowance. Returns the job to check with /api/canva/ai-image-job.
import { HttpError, accessToken, canva, errorResponse, json } from '../_lib/canva.js';
import { checkExportUrl } from '../_lib/finish.js';

/** The shapes Canva draws: square 1:1, landscape 16:9, portrait 9:16, and 3:2, 2:3, 4:5. */
export const ASPECTS = ['square', 'landscape', 'portrait', 'landscape_3_2', 'portrait_2_3', 'portrait_4_5'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImageJob { id: string; status: 'in_progress' | 'success' | 'failed'; result?: { image?: { url?: string; width?: number; height?: number } }; error?: { code?: string; message?: string } }
export type Outcome =
  | { status: 'pending' }
  | { status: 'success'; url: string; width?: number; height?: number }
  | { status: 'failure'; code: string; message: string };

/** What a job says: still drawing, the picture's download link (Canva's own hosts only), or why it failed. */
export function outcome(job: ImageJob): Outcome {
  if (job.status === 'failed') {
    const code = job.error?.code === 'unsafe_input' ? 'ai_unsafe' : job.error?.code === 'timeout' ? 'ai_timeout' : 'ai_failed';
    return { status: 'failure', code, message: job.error?.message || job.error?.code || 'failed' };
  }
  const image = job.result?.image;
  if (job.status !== 'success' || !image?.url) return { status: 'pending' };
  try {
    return { status: 'success', url: checkExportUrl(image.url), width: image.width, height: image.height };
  } catch {
    let host = '';
    try { host = new URL(image.url).hostname; } catch { /* not a URL */ }
    return { status: 'failure', code: 'ai_no_image', message: `unexpected picture link host ${host}` };
  }
}

/** Canva's refusals, named for the app (see the Create image generation job API). */
export function aiError(e: unknown): unknown {
  if (!(e instanceof HttpError)) return e;
  const m = e.message || '';
  switch (e.code) {
    case 'not_connected': return e;
    case 'permission_denied': return new HttpError(403, /not enabled/i.test(m) ? 'ai_not_enabled' : 'ai_forbidden', m);
    case 'missing_scope': return new HttpError(403, 'ai_scope', m);
    case 'credit_quota_exceeded': return new HttpError(429, 'ai_quota', m);
    case 'credit_quota_cooldown': return new HttpError(429, 'ai_cooldown', m);
    case 'too_many_requests': return new HttpError(429, 'too_many_requests', m);
    default: return new HttpError(502, 'ai_failed', m);
  }
}

export async function POST(req: Request): Promise<Response> {
  let cookies: string[] = [];
  try {
    const body = (await req.json().catch(() => ({}))) as { prompt?: string; aspect?: string; key?: string };
    const prompt = String(body.prompt || '').trim();
    if (!prompt || prompt.length > 10000) throw new HttpError(400, 'bad_prompt');
    const aspect = ASPECTS.includes(String(body.aspect)) ? String(body.aspect) : undefined;
    // the browser's key makes a retried start return the same job instead of drawing (and charging) twice
    const key = UUID.test(String(body.key)) ? String(body.key) : crypto.randomUUID();
    const { token, setCookies } = await accessToken(req);
    cookies = setCookies;
    const r = await canva<{ job: ImageJob }>(token, '/image-generations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, ...(aspect ? { aspect_ratio: aspect } : {}), idempotency_key: key }),
    }).catch((e) => { throw aiError(e); });
    return json({ jobId: r.job.id, ...outcome(r.job) }, 200, cookies);
  } catch (e) {
    return errorResponse(e, cookies);
  }
}
