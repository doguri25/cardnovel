// @vitest-environment node
// Canva AI pictures through Canva's Connect image generation API (POST/GET /rest/v1/image-generations).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { seal } from '../api/_lib/canva';
import { POST as aiImage } from '../api/_canva/ai-image';
import { POST as aiImageJob } from '../api/_canva/ai-image-job';
import { GET as page } from '../api/_canva/page';

const SECRET = 'test-session-secret-0123456789abcdef';
beforeAll(() => {
  process.env.CANVA_CLIENT_ID = 'OC-test';
  process.env.CANVA_CLIENT_SECRET = 'cnvca-test';
  process.env.CANVA_REDIRECT_URI = 'https://cardnovel.vercel.app/api/canva/callback';
  process.env.SESSION_SECRET = SECRET;
});
afterEach(() => vi.unstubAllGlobals());

const GEN = 'https://api.canva.com/rest/v1/image-generations';
const KEY = '550e8400-e29b-41d4-a716-446655440000';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokenCookie = async (exp = Date.now() + 3600_000) => `cn_tok=${encodeURIComponent(await seal({ a: 'ACCESS', r: 'REFRESH', e: exp }, SECRET))}`;
const start = async (body: unknown, cookie?: string) => aiImage(new Request('https://x/api/canva/ai-image', { method: 'POST', headers: cookie === undefined ? { cookie: await tokenCookie() } : cookie ? { cookie } : {}, body: JSON.stringify(body) }));
const check = async (jobId: string) => aiImageJob(new Request('https://x/api/canva/ai-image-job', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ jobId }) }));
/** Canva answering one request; records what was sent. */
function canvaAnswers(answer: (url: string, init: RequestInit) => Response) {
  const seen: { url: string; method: string; auth: string | null; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    let body: Record<string, unknown> | null = null;
    try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { /* the token request is a form */ }
    seen.push({ url, method: init.method || 'GET', auth: new Headers(init.headers).get('authorization'), body });
    return answer(url, init);
  }));
  return seen;
}

describe('starting a Canva AI picture', () => {
  it('asks Canva\'s image generation API with the prompt, the card shape and the idempotency key', async () => {
    const seen = canvaAnswers(() => json({ job: { id: 'JOB1', status: 'in_progress' }, quota_usage: { used_percentage: 12 } }));
    const res = await start({ prompt: 'Scene: an empty bus', aspect: 'landscape', key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 'JOB1', status: 'pending', usage: 12 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: GEN, method: 'POST', auth: 'Bearer ACCESS' });
    expect(seen[0].body).toEqual({ prompt: 'Scene: an empty bus', aspect_ratio: 'landscape', idempotency_key: KEY });
  });

  it('passes on the allowance Canva reports (also as text), when it resets and Canva\'s own usage page; says when Canva sent none', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    canvaAnswers(() => json({ job: { id: 'JOB3', status: 'in_progress' }, quota_usage: { used_percentage: '41', resets_at: 1767225600, usage_review_link: 'https://www.canva.com/settings/ai-usage' } }));
    expect(await (await start({ prompt: 'x' })).json()).toEqual({ jobId: 'JOB3', status: 'pending', usage: 41, usageResets: 1767225600, usageLink: 'https://www.canva.com/settings/ai-usage' });
    canvaAnswers(() => json({ job: { id: 'JOB4', status: 'in_progress' }, quota_usage: { used_percentage: 7, usage_review_link: 'javascript:alert(1)' } }));
    expect(await (await start({ prompt: 'x' })).json()).toEqual({ jobId: 'JOB4', status: 'pending', usage: 7 });
    canvaAnswers(() => json({ job: { id: 'JOB5', status: 'in_progress' } }));
    expect(await (await start({ prompt: 'x' })).json()).toEqual({ jobId: 'JOB5', status: 'pending' });
    // one log line per picture: whether Canva sent usage data, never tokens or links
    expect(info.mock.calls.map((c) => String(c.join(' ')))).toEqual([
      expect.stringContaining('quota_usage: used_percentage=41 resets_at=1767225600 usage_review_link=yes'),
      expect.stringContaining('quota_usage: used_percentage=7 usage_review_link=yes'),
      expect.stringContaining('quota_usage: none'),
    ]);
    expect(info.mock.calls.join(' ')).not.toContain('ACCESS');
    info.mockRestore();
  });

  it('makes its own key and leaves out a shape Canva does not draw; refuses an empty prompt or no sign-in', async () => {
    const seen = canvaAnswers(() => json({ job: { id: 'JOB2', status: 'in_progress' } }));
    await start({ prompt: 'x', aspect: '16:9', key: 'not-a-uuid' });
    expect(seen[0].body!.aspect_ratio).toBeUndefined();
    expect(String(seen[0].body!.idempotency_key)).toMatch(/^[0-9a-f-]{36}$/);
    expect((await (await start({ prompt: '  ' })).json()).error).toBe('bad_prompt');
    const out = await start({ prompt: 'x' }, '');
    expect(out.status).toBe(401);
    expect((await out.json()).error).toBe('not_connected');
  });

  it('names each refusal Canva documents', async () => {
    const cases: [Response, string][] = [
      [json({ code: 'permission_denied', message: 'Image generation is not enabled' }, 403), 'ai_not_enabled'],
      [json({ code: 'permission_denied', message: 'User does not have the required capability' }, 403), 'ai_forbidden'],
      [json({ code: 'missing_scope', message: 'Missing scope asset:write' }, 403), 'ai_scope'],
      [json({ code: 'credit_quota_exceeded', message: 'User has exceeded their credit quota', quota_usage: { used_percentage: 100 } }, 429), 'ai_quota'],
      [json({ code: 'credit_quota_cooldown', message: 'Credit quota cooldown is active' }, 429), 'ai_cooldown'],
      [json({ code: 'too_many_requests', message: 'slow down' }, 429), 'too_many_requests'],
      [json({ code: 'invalid_access_token', message: 'bad token' }, 401), 'not_connected'],
      [json({ code: 'internal_error', message: 'Unknown error occurred' }, 500), 'ai_failed'],
    ];
    for (const [answer, code] of cases) {
      canvaAnswers(() => answer.clone());
      const body = await (await start({ prompt: 'x' })).json();
      expect(body.error, code).toBe(code);
    }
  });

  it('a refreshed token still reaches the browser when Canva then refuses', async () => {
    canvaAnswers((url) => (url.endsWith('/oauth/token') ? json({ access_token: 'A2', refresh_token: 'R2', expires_in: 14400 }) : json({ code: 'permission_denied', message: 'Image generation is not enabled' }, 403)));
    const res = await start({ prompt: 'x' }, await tokenCookie(Date.now() + 1000));
    expect((await res.json()).error).toBe('ai_not_enabled');
    expect(res.headers.get('set-cookie')).toMatch(/cn_t0=[^;]+;/);
  });
});

describe('checking a Canva AI picture', () => {
  it('in progress, finished with a download link, or failed with Canva\'s reason', async () => {
    const seen = canvaAnswers(() => json({ job: { id: 'JOB1', status: 'in_progress' } }));
    expect(await (await check('JOB1')).json()).toEqual({ status: 'pending' });
    expect(seen[0]).toMatchObject({ url: `${GEN}/JOB1`, method: 'GET', auth: 'Bearer ACCESS' });

    canvaAnswers(() => json({ job: { id: 'JOB1', status: 'success', result: { image: { url: 'https://export-download.canva.com/gen/1.png?sig=1', width: 1536, height: 864 } } } }));
    expect(await (await check('JOB1')).json()).toEqual({ status: 'success', url: 'https://export-download.canva.com/gen/1.png?sig=1', width: 1536, height: 864 });

    canvaAnswers(() => json({ job: { id: 'JOB1', status: 'failed', error: { code: 'unsafe_input', message: 'Content safety checks rejected the prompt.' } } }));
    expect(await (await check('JOB1')).json()).toEqual({ status: 'failure', code: 'ai_unsafe', message: 'Content safety checks rejected the prompt.' });

    canvaAnswers(() => json({ job: { id: 'JOB1', status: 'failed', error: { code: 'internal_error', message: 'An unexpected error occurred' } } }));
    expect(await (await check('JOB1')).json()).toMatchObject({ status: 'failure', code: 'ai_failed' });
  });

  it('passes on only Canva\'s own download hosts, and refuses a bad job id', async () => {
    canvaAnswers(() => json({ job: { id: 'JOB1', status: 'success', result: { image: { url: 'https://evil.example.com/1.png', width: 1, height: 1 } } } }));
    expect(await (await check('JOB1')).json()).toMatchObject({ status: 'failure', code: 'ai_no_image', message: expect.stringContaining('evil.example.com') });
    expect((await (await check('a b')).json()).error).toBe('bad_job');
  });
});

describe('the page proxy', () => {
  it('streams the picture through instead of holding it in memory', async () => {
    const big = new Uint8Array(6_000_000);
    canvaAnswers(() => new Response(new Blob([big]).stream(), { headers: { 'content-type': 'image/png', 'content-length': String(big.length) } }));
    const res = await page(new Request(`https://x/api/canva/page?u=${encodeURIComponent('https://export-download.canva.com/gen/1.png')}`, { headers: { cookie: await tokenCookie() } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect((await res.arrayBuffer()).byteLength).toBe(6_000_000);
  });
});

describe('one function for all Canva endpoints', () => {
  it('routes both picture actions', async () => {
    canvaAnswers((url) => json(url.endsWith('/image-generations') ? { job: { id: 'JOB11', status: 'in_progress' } } : { job: { id: 'JOB11', status: 'in_progress' } }));
    const { POST } = await import('../api/canva');
    const res = await POST(new Request('https://cardnovel.vercel.app/api/canva?action=ai-image', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ prompt: 'x' }) }));
    expect(await res.json()).toEqual({ jobId: 'JOB11', status: 'pending' });
    const job = await POST(new Request('https://cardnovel.vercel.app/api/canva/ai-image-job', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ jobId: 'JOB11' }) }));
    expect(await job.json()).toEqual({ status: 'pending' });
  });
});
