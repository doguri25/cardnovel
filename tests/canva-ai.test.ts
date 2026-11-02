// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { seal } from '../api/_lib/canva';
import { callTool, imageLink, jobIdOf, jobOutcome, MAX_INLINE, readMessages, resetMcpUrl, type ToolResult } from '../api/_lib/mcp';
import { POST as aiImage } from '../api/_canva/ai-image';
import { POST as aiImageJob } from '../api/_canva/ai-image-job';

const SECRET = 'test-session-secret-0123456789abcdef';
beforeAll(() => {
  process.env.CANVA_CLIENT_ID = 'OC-test';
  process.env.CANVA_CLIENT_SECRET = 'cnvca-test';
  process.env.CANVA_REDIRECT_URI = 'https://cardnovel.vercel.app/api/canva/callback';
  process.env.SESSION_SECRET = SECRET;
});
afterEach(() => { vi.unstubAllGlobals(); resetMcpUrl(); delete process.env.CANVA_MCP_URL; });

const MCP = 'https://api.canva.com/connect/v1/mcp';
const tokenCookie = async (exp = Date.now() + 3600_000) => `cn_tok=${encodeURIComponent(await seal({ a: 'ACCESS', r: 'REFRESH', e: exp }, SECRET))}`;
const rpc = (id: number, result: unknown, sse = false, headers: Record<string, string> = {}) => sse
  ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream', ...headers } })
  : new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json', ...headers } });

interface Seen { method?: string; auth: string | null; session: string | null; params?: Record<string, unknown> }
/** A fake MCP server: initialize hands out a session, tools/call answers with `tool(name, args)`. */
function fakeMcp(tool: (name: string, args: Record<string, unknown>) => ToolResult | Response, opts: { sse?: boolean } = {}) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(MCP);
    const h = new Headers(init.headers);
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    seen.push({ method: body.method, auth: h.get('authorization'), session: h.get('mcp-session-id'), params: body.params });
    if (body.method === 'initialize') return rpc(body.id!, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'canva' } }, opts.sse, { 'mcp-session-id': 'S1' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/call') {
      const out = tool(String(body.params!.name), body.params!.arguments as Record<string, unknown>);
      return out instanceof Response ? out : rpc(body.id!, out, opts.sse);
    }
    return new Response('', { status: 400 });
  });
  vi.stubGlobal('fetch', fetch);
  return seen;
}

describe('MCP client', () => {
  it('reads JSON and event-stream answers', () => {
    expect(readMessages('{"jsonrpc":"2.0","id":1,"result":{"a":1}}', 'application/json')).toEqual([{ jsonrpc: '2.0', id: 1, result: { a: 1 } }]);
    const sse = ': ping\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    expect(readMessages(sse, 'text/event-stream; charset=utf-8').map((m) => m.id ?? null)).toEqual([null, 2]);
    expect(readMessages('', 'application/json')).toEqual([]);
  });

  it('opens a session with the user token, then calls the tool in that session', async () => {
    const seen = fakeMcp(() => ({ content: [{ type: 'text', text: '{"jobId":"JOB1"}' }] }), { sse: true });
    const r = await callTool('ACCESS', 'generate-image', { prompt: 'a bus at night' });
    expect(jobIdOf(r)).toBe('JOB1');
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(seen.every((s) => s.auth === 'Bearer ACCESS')).toBe(true);
    expect(seen[0].session).toBeNull();
    expect(seen[2].session).toBe('S1');
    expect(seen[2].params).toEqual({ name: 'generate-image', arguments: { prompt: 'a bus at night' } });
  });

  it('moves to Canva\'s other MCP address only when the first does not exist, and remembers it', async () => {
    const hits: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      hits.push(url);
      if (url === MCP) return new Response('not found', { status: 404 });
      const body = JSON.parse(String(init.body));
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return rpc(body.id, body.method === 'initialize' ? {} : { structuredContent: { jobId: 'J-public' } });
    }));
    expect(jobIdOf(await callTool('ACCESS', 'generate-image', {}))).toBe('J-public');
    expect(hits).toEqual([MCP, 'https://mcp.canva.com/mcp', 'https://mcp.canva.com/mcp', 'https://mcp.canva.com/mcp']);
    hits.length = 0;
    await callTool('ACCESS', 'generate-image', {});
    expect(hits[0]).toBe('https://mcp.canva.com/mcp');
    // a refusal (not a missing address) is final
    resetMcpUrl();
    hits.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { hits.push(url); return new Response('no', { status: 401 }); }));
    await expect(callTool('ACCESS', 'generate-image', {})).rejects.toMatchObject({ code: 'mcp_unauthorized' });
    expect(hits).toEqual([MCP]);
    // CANVA_MCP_URL wins
    process.env.CANVA_MCP_URL = 'https://example.test/mcp';
    hits.length = 0;
    await expect(callTool('ACCESS', 'generate-image', {})).rejects.toBeTruthy();
    expect(hits).toEqual(['https://example.test/mcp']);
  });

  it('turns refusals into clear codes', async () => {
    for (const [status, code] of [[401, 'mcp_unauthorized'], [403, 'mcp_forbidden'], [404, 'mcp_unavailable'], [429, 'too_many_requests'], [500, 'mcp_error']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })));
      await expect(callTool('ACCESS', 'generate-image', {})).rejects.toMatchObject({ code });
    }
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const { id } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Missing required scope' } }), { headers: { 'content-type': 'application/json' } });
    }));
    await expect(callTool('ACCESS', 'generate-image', {})).rejects.toMatchObject({ code: 'mcp_forbidden' });
  });

  it('finds the job id in structured content, JSON text or plain text', () => {
    expect(jobIdOf({ structuredContent: { job: { id: 'J-structured' } } })).toBe('J-structured');
    expect(jobIdOf({ content: [{ type: 'text', text: '{"job_id":"J_json"}' }] })).toBe('J_json');
    expect(jobIdOf({ content: [{ type: 'text', text: 'Started image generation. jobId: J_plain42' }] })).toBe('J_plain42');
    expect(jobIdOf({ content: [{ type: 'text', text: 'nothing here' }] })).toBeUndefined();
  });
});

describe('reading a finished picture', () => {
  it('pending, failure, inline picture', () => {
    expect(jobOutcome({ structuredContent: { status: 'PENDING' } })).toEqual({ status: 'pending' });
    expect(jobOutcome({ structuredContent: { status: 'FAILURE', failureType: 'POLICY', failureMessage: 'Prompt was blocked' } })).toEqual({ status: 'failure', message: 'Prompt was blocked' });
    expect(jobOutcome({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toEqual({ status: 'failure', message: 'boom' });
    expect(jobOutcome({
      structuredContent: { status: 'SUCCESS', result: { media_id: 'MAF1' } },
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'Open generated image: https://www.canva.com/u/abc' }],
    })).toEqual({ status: 'success', data: 'data:image/png;base64,AAAA', mediaId: 'MAF1' });
    expect(jobOutcome({ content: [{ type: 'resource', resource: { uri: 'canva://media/1', blob: 'BBBB', mimeType: 'image/jpeg' } }, { type: 'text', text: '{"status":"SUCCESS"}' }] }))
      .toEqual({ status: 'success', data: 'data:image/jpeg;base64,BBBB', mediaId: undefined });
  });

  it('takes the picture file, not the Canva page link', () => {
    const r: ToolResult = { content: [{ type: 'text', text: JSON.stringify({ status: 'SUCCESS', result: { media_id: 'MAF2', upload_url: 'https://www.canva.com/u/xyz', image: { url: 'https://export-download.canva.com/a/b/0001.png?sig=1' } } }) }] };
    expect(jobOutcome(r)).toEqual({ status: 'success', url: 'https://export-download.canva.com/a/b/0001.png?sig=1', mediaId: 'MAF2' });
    expect(imageLink(['https://www.canva.com/u/1', 'https://canva.com/x', 'https://media.canva.com/x/thumb', 'https://media.canva.com/x/full.jpg'])).toBe('https://media.canva.com/x/full.jpg');
    expect(imageLink(['https://www.canva.com/u/1'])).toBeUndefined();
  });

  it('waits when the job is done but the picture is not there yet, or too large to pass inline', () => {
    expect(jobOutcome({ structuredContent: { status: 'SUCCESS', media_id: 'MAF3' }, content: [{ type: 'text', text: 'The image link is not ready yet. Open generated image: https://www.canva.com/u/1' }] }))
      .toEqual({ status: 'pending', mediaId: 'MAF3' });
    expect(jobOutcome({ structuredContent: { status: 'SUCCESS' }, content: [{ type: 'image', data: 'A'.repeat(MAX_INLINE), mimeType: 'image/png' }] }).status).toBe('pending');
  });
});

describe('Canva AI endpoints', () => {
  it('ai-image starts a job with the card prompt, shape and the cover as reference', async () => {
    const seen = fakeMcp((name, args) => {
      expect(name).toBe('generate-image');
      expect(args).toMatchObject({ prompt: 'Scene: an empty bus', aspectRatio: 'LANDSCAPE_16_9', imageReferences: [{ type: 'MEDIA', id: 'MAFcover' }] });
      expect(String(args.user_intent)).toBeTruthy();
      return { structuredContent: { jobId: 'JOB9' } };
    });
    const res = await aiImage(new Request('https://x/api/canva/ai-image', {
      method: 'POST', headers: { cookie: await tokenCookie() },
      body: JSON.stringify({ prompt: 'Scene: an empty bus', aspect: 'LANDSCAPE_16_9', refs: ['MAFcover', '../bad id'] }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 'JOB9' });
    expect(seen).toHaveLength(3);
  });

  it('ai-image leaves out an unknown shape and refuses an empty prompt or a missing sign-in', async () => {
    fakeMcp((_n, args) => { expect(args.aspectRatio).toBeUndefined(); expect(args.imageReferences).toBeUndefined(); return { structuredContent: { jobId: 'JOB10' } }; });
    const ok = await aiImage(new Request('https://x/', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ prompt: 'x', aspect: '16:9' }) }));
    expect(await ok.json()).toEqual({ jobId: 'JOB10' });
    expect((await (await aiImage(new Request('https://x/', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ prompt: ' ' }) }))).json()).error).toBe('bad_prompt');
    const out = await aiImage(new Request('https://x/', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) }));
    expect(out.status).toBe(401);
    expect((await out.json()).error).toBe('not_connected');
  });

  it('ai-image reports a used-up allowance as ai_quota', async () => {
    fakeMcp(() => ({ isError: true, content: [{ type: 'text', text: 'You have reached your Magic Media usage limit for this month.' }] }));
    const res = await aiImage(new Request('https://x/', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ prompt: 'x' }) }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('ai_quota');
  });

  it('a refreshed token still reaches the browser when Canva AI then refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'A2', refresh_token: 'R2', expires_in: 14400 }), { headers: { 'content-type': 'application/json' } });
      return new Response('forbidden', { status: 403 });
    }));
    const res = await aiImage(new Request('https://x/', { method: 'POST', headers: { cookie: await tokenCookie(Date.now() + 1000) }, body: JSON.stringify({ prompt: 'x' }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mcp_forbidden');
    expect(res.headers.get('set-cookie')).toMatch(/cn_t0=[^;]+;/);
  });

  it('ai-image-job passes on the picture link only for Canva hosts, and names the failures', async () => {
    const cookie = await tokenCookie();
    const ask = async () => (await aiImageJob(new Request('https://x/', { method: 'POST', headers: { cookie }, body: JSON.stringify({ jobId: 'JOB9' }) }))).json();
    fakeMcp((name, args) => { expect(name).toBe('get-generate-image-job'); expect(args.jobId).toBe('JOB9'); return { structuredContent: { status: 'IN_PROGRESS' } }; });
    expect(await ask()).toEqual({ status: 'pending' });
    fakeMcp(() => ({ structuredContent: { status: 'SUCCESS', media_id: 'MAF9', url: 'https://export-download.canva.com/p/1.png' } }));
    expect(await ask()).toEqual({ status: 'success', url: 'https://export-download.canva.com/p/1.png', mediaId: 'MAF9' });
    fakeMcp(() => ({ structuredContent: { status: 'SUCCESS', url: 'https://evil.example.com/1.png' } }));
    expect(await ask()).toMatchObject({ status: 'failure', code: 'ai_no_image' });
    fakeMcp(() => ({ structuredContent: { status: 'FAILED', failureMessage: 'Not enough credits' } }));
    expect(await ask()).toMatchObject({ status: 'failure', code: 'ai_quota' });
    fakeMcp(() => ({ structuredContent: { status: 'FAILED', failureMessage: 'Content policy' } }));
    expect(await ask()).toMatchObject({ status: 'failure', code: 'ai_failed', message: 'Content policy' });
    expect((await (await aiImageJob(new Request('https://x/', { method: 'POST', headers: { cookie }, body: JSON.stringify({ jobId: 'a b' }) }))).json()).error).toBe('bad_job');
  });

  it('the Canva function routes both new actions', async () => {
    fakeMcp(() => ({ structuredContent: { jobId: 'JOB11' } }));
    const { POST } = await import('../api/canva');
    const res = await POST(new Request('https://cardnovel.vercel.app/api/canva?action=ai-image', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ prompt: 'x' }) }));
    expect(await res.json()).toEqual({ jobId: 'JOB11' });
    fakeMcp(() => ({ structuredContent: { status: 'PENDING' } }));
    const job = await POST(new Request('https://cardnovel.vercel.app/api/canva/ai-image-job', { method: 'POST', headers: { cookie: await tokenCookie() }, body: JSON.stringify({ jobId: 'JOB11' }) }));
    expect(await job.json()).toEqual({ status: 'pending' });
  });
});
