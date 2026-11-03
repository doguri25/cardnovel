import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANVA_STOP, CanvaError, canvaAiImage, canvaAspect, canvaMessage, canvaUsage, pictureMessage } from '../src/canva';
import { AiError } from '../src/ai/providers';

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
const FAST = { first: 1, every: 1, limit: 2000 };
const LINK = 'https://export-download.canva.com/gen/1.png';

describe('Canva AI picture shapes', () => {
  it('picks the closest shape Canva draws', () => {
    expect(canvaAspect(1080 / 640)).toBe('landscape');
    expect(canvaAspect(1080 / 720)).toBe('landscape_3_2');
    expect(canvaAspect(1080 / 1350)).toBe('portrait_4_5');
    expect(canvaAspect(1080 / 1920)).toBe('portrait');
    expect(canvaAspect(2 / 3)).toBe('portrait_2_3');
    expect(canvaAspect(1)).toBe('square');
    expect(canvaAspect(0)).toBe('square');
  });
});

describe('drawing with Canva AI', () => {
  it('starts a job, waits while Canva draws, then takes the picture straight from Canva', async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/canva/ai-image') return json({ jobId: 'J1', status: 'pending' });
      if (url === '/api/canva/ai-image-job') return json(++polls < 3 ? { status: 'pending' } : { status: 'success', url: LINK, width: 1536, height: 864 });
      if (url === LINK) return png();
      return json({ error: 'not_found' }, 404);
    }));
    const out = await canvaAiImage({ prompt: 'Scene: a bus', aspect: 1080 / 640 }, undefined, FAST);
    expect(out.dataUrl).toBe('data:image/png;base64,iVBORw==');
    expect(calls[0].body).toMatchObject({ prompt: 'Scene: a bus', aspect: 'landscape' });
    expect(String(calls[0].body!.key)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls.filter((c) => c.url.endsWith('/ai-image-job'))).toHaveLength(3);
    expect(calls.some((c) => c.url.startsWith('/api/canva/page'))).toBe(false);
  });

  it('remembers how much of the Canva AI allowance is used', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/canva/ai-image') return json({ jobId: 'J9', status: 'pending', usage: 41.6 });
      if (url === '/api/canva/ai-image-job') return json({ status: 'success', url: LINK, width: 1, height: 1 });
      return png();
    }));
    await canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST);
    expect(canvaUsage()).toBe(42);
  });

  it('goes through the page proxy when the browser may not read Canva\'s link', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/canva/ai-image') return json({ jobId: 'J2', status: 'pending' });
      if (url === '/api/canva/ai-image-job') return json({ status: 'success', url: LINK, width: 1, height: 1 });
      if (url === LINK) throw new TypeError('Failed to fetch'); // no CORS
      if (url === '/api/canva/page?u=' + encodeURIComponent(LINK)) return png();
      return json({ error: 'not_found' }, 404);
    }));
    expect((await canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST)).dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('retries a rate-limited start with the same key, so Canva does not charge twice', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/canva/ai-image') { keys.push(JSON.parse(String(init!.body)).key); return keys.length === 1 ? json({ error: 'too_many_requests' }, 429) : json({ jobId: 'J3', status: 'pending' }); }
      if (url === '/api/canva/ai-image-job') return json({ status: 'success', url: LINK, width: 1, height: 1 });
      return png();
    }));
    await canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, { ...FAST, retry: 1 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('stops on a failed job, a missing sign-in, a timeout, or the stop button', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ai-image') ? json({ jobId: 'J4', status: 'pending' }) : json({ status: 'failure', code: 'ai_unsafe', message: 'Content safety checks rejected the prompt.' }))));
    await expect(canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST)).rejects.toMatchObject({ code: 'ai_unsafe' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'ai_quota', message: 'User has exceeded their credit quota' }, 429)));
    await expect(canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST)).rejects.toMatchObject({ code: 'ai_quota' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not_connected' }, 401)));
    await expect(canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST)).rejects.toMatchObject({ code: 'not_connected' });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ai-image') ? json({ jobId: 'J5', status: 'pending' }) : json({ status: 'pending' }))));
    await expect(canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, { first: 1, every: 5, limit: 30 })).rejects.toMatchObject({ code: 'ai_timeout' });

    const ctl = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ai-image') ? json({ jobId: 'J6', status: 'pending' }) : json({ status: 'pending' }))));
    const p = canvaAiImage({ prompt: 'x', aspect: 1 }, ctl.signal, { first: 1, every: 50, limit: 60000 });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('explains each failure in Korean and says when to stop drawing the rest', () => {
    expect(canvaMessage(new CanvaError('ai_quota'))).toContain('사용량');
    expect(canvaMessage(new CanvaError('ai_not_enabled'))).toContain('개발자 포털');
    expect(canvaMessage(new CanvaError('ai_forbidden'))).toContain('Magic Media');
    expect(canvaMessage(new CanvaError('ai_unsafe'))).toContain('안전');
    expect(canvaMessage(new CanvaError('ai_failed', 'Unknown error occurred'))).toContain('(Unknown error occurred)');
    expect(pictureMessage(new AiError('no_key'))).not.toContain('Canva');
    expect(CANVA_STOP).toEqual(expect.arrayContaining(['ai_quota', 'ai_cooldown', 'ai_not_enabled', 'ai_forbidden', 'ai_scope', 'not_connected']));
    expect(CANVA_STOP).not.toContain('ai_failed');
    expect(CANVA_STOP).not.toContain('ai_unsafe');
  });
});
