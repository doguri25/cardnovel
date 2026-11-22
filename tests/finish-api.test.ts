// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const blob = vi.hoisted(() => ({ del: vi.fn(async () => undefined) }));
vi.mock('@vercel/blob', () => blob);

import { seal } from '../api/_lib/canva';
import { checkDeckUrl, checkExportUrl } from '../api/_lib/finish';
import { POST as finishImport } from '../api/_canva/finish-import';
import { POST as finishExport } from '../api/_canva/finish-export';
import { GET as page } from '../api/_canva/page';

const SECRET = 'test-session-secret-0123456789abcdef';
beforeAll(() => {
  process.env.CANVA_CLIENT_ID = 'OC-test';
  process.env.CANVA_CLIENT_SECRET = 'cnvca-test';
  process.env.CANVA_REDIRECT_URI = 'https://cardnovel.vercel.app/api/canva/callback';
  process.env.SESSION_SECRET = SECRET;
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cookie = async () => `cn_tok=${encodeURIComponent(await seal({ a: 'ACCESS', r: 'REFRESH', e: Date.now() + 3600_000 }, SECRET))}`;
const DECK = 'https://abc123.public.blob.vercel-storage.com/canva-import/k3j2h1-Xy9.pptx';

describe('Canva finishing API', () => {
  it('accepts only decks in this app’s upload folder and Canva download links', () => {
    expect(checkDeckUrl(DECK)).toBe(DECK);
    expect(() => checkDeckUrl('https://evil.example.com/canva-import/a.pptx')).toThrow();
    expect(() => checkDeckUrl('https://abc.public.blob.vercel-storage.com/shares/a/01.jpg')).toThrow();
    expect(checkExportUrl('https://export-download.canva.com/abc/1.jpg?sig=x')).toContain('canva.com');
    expect(() => checkExportUrl('http://export-download.canva.com/1.jpg')).toThrow();
    expect(() => checkExportUrl('https://169.254.169.254/latest/meta-data')).toThrow();
  });

  it('imports the deck from its URL, adds the return state to the edit link and deletes the upload', async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: init.body as string });
      if (url.endsWith('/url-imports')) return json({ job: { id: 'J1', status: 'in_progress' } });
      if (url.endsWith('/url-imports/J1')) return json({ job: { id: 'J1', status: 'success', result: { designs: [{ id: 'D1', page_count: 20, urls: { edit_url: 'https://www.canva.com/design/D1/edit?token=t' } }] } } });
      return json({}, 404);
    }));
    const res = await finishImport(new Request('https://cardnovel.vercel.app/api/canva/finish-import', {
      method: 'POST', headers: { cookie: await cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ url: DECK, title: '막차 마감', state: 'work1~finish' }),
    }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { designs: { id: string; editUrl: string; pages: number }[] };
    expect(out.designs[0]).toMatchObject({ id: 'D1', pages: 20 });
    expect(new URL(out.designs[0].editUrl).searchParams.get('correlation_state')).toBe('work1~finish');
    const started = JSON.parse(calls[0].body!);
    expect(started).toMatchObject({ url: DECK, title: '막차 마감' });
    expect(started.mime_type).toContain('presentationml');
    expect(blob.del).toHaveBeenCalledWith(DECK);
  });

  it('deletes the upload even when Canva cannot read it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ job: { id: 'J2', status: 'failed', error: { code: 'invalid_file', message: 'bad' } } })));
    const res = await finishImport(new Request('https://cardnovel.vercel.app/api/canva/finish-import', {
      method: 'POST', headers: { cookie: await cookie() }, body: JSON.stringify({ url: DECK, state: 'w~finish' }),
    }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_file');
    expect(blob.del).toHaveBeenCalledWith(DECK);
  });

  it('exports every page as JPEG and passes pages through only for a signed-in browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/exports')) {
        expect(JSON.parse(init.body as string).format).toEqual({ type: 'jpg', quality: 92 });
        return json({ job: { id: 'E1', status: 'success', urls: ['https://export-download.canva.com/p1.jpg', 'https://export-download.canva.com/p2.jpg'] } });
      }
      if (url.startsWith('https://export-download.canva.com/')) return new Response(new Uint8Array([0xff, 0xd8, 1]), { headers: { 'content-type': 'image/jpeg' } });
      return json({}, 404);
    }));
    const ex = await finishExport(new Request('https://cardnovel.vercel.app/api/canva/finish-export', { method: 'POST', headers: { cookie: await cookie() }, body: JSON.stringify({ designId: 'D1' }) }));
    expect(((await ex.json()) as { urls: string[] }).urls).toHaveLength(2);
    const u = encodeURIComponent('https://export-download.canva.com/p1.jpg');
    expect((await page(new Request(`https://cardnovel.vercel.app/api/canva/page?u=${u}`))).status).toBe(401);
    const ok = await page(new Request(`https://cardnovel.vercel.app/api/canva/page?u=${u}`, { headers: { cookie: await cookie() } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    const bad = await page(new Request(`https://cardnovel.vercel.app/api/canva/page?u=${encodeURIComponent('https://evil.example.com/x.jpg')}`, { headers: { cookie: await cookie() } }));
    expect(bad.status).toBe(400);
  });
});
