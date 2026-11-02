import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANVA_STOP, CanvaError, canvaAiImage, canvaAspect, canvaMessage, pictureMessage } from '../src/canva';
import { AiError } from '../src/ai/providers';

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const FAST = { first: 1, every: 1, limit: 2000 };

describe('Canva AI picture shapes', () => {
  it('picks the closest shape Canva draws', () => {
    expect(canvaAspect(1080 / 640)).toBe('LANDSCAPE_16_9');
    expect(canvaAspect(1080 / 1350)).toBe('PORTRAIT_4_5');
    expect(canvaAspect(1080 / 1920)).toBe('PORTRAIT_9_16');
    expect(canvaAspect(1)).toBe('SQUARE_1_1');
    expect(canvaAspect(1080 / 520)).toBe('LANDSCAPE_2_1');
    expect(canvaAspect(0)).toBe('SQUARE_1_1');
  });
});

describe('drawing with Canva AI', () => {
  it('starts a job, waits while it is drawing and returns the picture with its media id', async () => {
    const calls: { url: string; body?: unknown }[] = [];
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/canva/ai-image') return json({ jobId: 'J1' });
      if (url === '/api/canva/ai-image-job') return json(++polls < 3 ? { status: 'pending' } : { status: 'success', data: 'data:image/png;base64,AAAA', mediaId: 'MAF1' });
      return json({ error: 'not_found' }, 404);
    }));
    const out = await canvaAiImage({ prompt: 'Scene: a bus', aspect: 1080 / 640, refs: ['MAFcover'] }, undefined, FAST);
    expect(out).toEqual({ dataUrl: 'data:image/png;base64,AAAA', mediaId: 'MAF1' });
    expect(calls[0].body).toEqual({ prompt: 'Scene: a bus', aspect: 'LANDSCAPE_16_9', refs: ['MAFcover'] });
    expect(calls.filter((c) => c.url.endsWith('/ai-image-job'))).toHaveLength(3);
  });

  it('fetches a linked picture through the page proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/canva/ai-image') return json({ jobId: 'J2' });
      if (url === '/api/canva/ai-image-job') return json({ status: 'success', url: 'https://export-download.canva.com/p/1.png', mediaId: 'MAF2' });
      if (url === '/api/canva/page?u=' + encodeURIComponent('https://export-download.canva.com/p/1.png')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
      return json({ error: 'not_found' }, 404);
    }));
    const out = await canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST);
    expect(out.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(out.mediaId).toBe('MAF2');
  });

  it('stops on a failed job, a missing sign-in, a timeout, or the stop button', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ai-image') ? json({ jobId: 'J3' }) : json({ status: 'failure', code: 'ai_quota', message: 'limit' }))));
    await expect(canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST)).rejects.toMatchObject({ code: 'ai_quota' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not_connected' }, 401)));
    await expect(canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, FAST)).rejects.toMatchObject({ code: 'not_connected' });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ai-image') ? json({ jobId: 'J4' }) : json({ status: 'pending' }))));
    await expect(canvaAiImage({ prompt: 'x', aspect: 1 }, undefined, { first: 1, every: 5, limit: 30 })).rejects.toMatchObject({ code: 'ai_timeout' });

    const ctl = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/ai-image') ? json({ jobId: 'J5' }) : json({ status: 'pending' }))));
    const p = canvaAiImage({ prompt: 'x', aspect: 1 }, ctl.signal, { first: 1, every: 50, limit: 60000 });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('explains each failure in Korean and says when to stop drawing the rest', () => {
    expect(canvaMessage(new CanvaError('ai_quota'))).toContain('사용량');
    expect(canvaMessage(new CanvaError('mcp_forbidden'))).toContain('권한');
    expect(canvaMessage(new CanvaError('ai_failed', 'Prompt was blocked'))).toContain('(Prompt was blocked)');
    expect(pictureMessage(new AiError('no_key'))).not.toContain('Canva');
    expect(CANVA_STOP).toEqual(expect.arrayContaining(['ai_quota', 'not_connected', 'mcp_forbidden']));
    expect(CANVA_STOP).not.toContain('ai_failed');
  });
});
