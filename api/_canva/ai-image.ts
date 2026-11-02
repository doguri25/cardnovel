// POST /api/canva/ai-image — asks Canva AI (through Canva's MCP server) to draw one picture; returns the job to poll.
import { HttpError, accessToken, errorResponse, json } from '../_lib/canva.js';
import { callTool, jobIdOf, resultJson } from '../_lib/mcp.js';

export const ASPECTS = ['SQUARE_1_1', 'LANDSCAPE_16_9', 'LANDSCAPE_4_3', 'LANDSCAPE_3_2', 'PORTRAIT_9_16', 'PORTRAIT_3_4', 'PORTRAIT_2_3', 'LANDSCAPE_5_4', 'LANDSCAPE_2_1', 'PORTRAIT_4_5', 'PORTRAIT_1_2'];
export const QUOTA = /quota|limit|credit|usage|allowance/i;

export async function POST(req: Request): Promise<Response> {
  let cookies: string[] = [];
  try {
    const body = (await req.json().catch(() => ({}))) as { prompt?: string; aspect?: string; refs?: unknown };
    const prompt = String(body.prompt || '').trim();
    if (!prompt || prompt.length > 6000) throw new HttpError(400, 'bad_prompt');
    const aspect = ASPECTS.includes(String(body.aspect)) ? String(body.aspect) : undefined;
    const refs = (Array.isArray(body.refs) ? body.refs : []).map(String).filter((id) => /^[A-Za-z0-9_-]{4,80}$/.test(id)).slice(0, 3);
    const { token, setCookies } = await accessToken(req);
    cookies = setCookies;
    const result = await callTool(token, 'generate-image', {
      prompt,
      ...(aspect ? { aspectRatio: aspect } : {}),
      ...(refs.length ? { imageReferences: refs.map((id) => ({ type: 'MEDIA', id })) } : {}),
      user_intent: 'Illustrate one card of an Instagram card novel in the series art style',
    });
    const jobId = jobIdOf(result);
    if (result.isError || !jobId) {
      const msg = String((result.content ?? []).map((c) => c.text ?? '').join(' ') || JSON.stringify(resultJson(result))).slice(0, 300);
      throw new HttpError(502, QUOTA.test(msg) ? 'ai_quota' : 'ai_failed', msg || 'no job');
    }
    return json({ jobId }, 200, cookies);
  } catch (e) {
    return errorResponse(e, cookies);
  }
}
