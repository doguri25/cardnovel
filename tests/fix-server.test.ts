// @vitest-environment node
// Server fixes: the page proxy only passes pictures, a refreshed Canva token survives a failed call, and a dead
// refresh token asks the writer to connect again.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const blob = vi.hoisted(() => ({ del: vi.fn(async () => undefined) }));
vi.mock('@vercel/blob', () => blob);

import { seal } from '../api/_lib/canva';
import { GET as page } from '../api/_canva/page';
import { POST as design } from '../api/_canva/design';
import { POST as exportDesign } from '../api/_canva/export';
import { POST as finishExport } from '../api/_canva/finish-export';
import { POST as finishImport } from '../api/_canva/finish-import';
import { POST as aiImage } from '../api/_canva/ai-image';

const SECRET = 'test-session-secret-0123456789abcdef';
beforeAll(() => {
  process.env.CANVA_CLIENT_ID = 'OC-test';
  process.env.CANVA_CLIENT_SECRET = 'cnvca-test';
  process.env.CANVA_REDIRECT_URI = 'https://cardnovel.vercel.app/api/canva/callback';
  process.env.SESSION_SECRET = SECRET;
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokenCookie = async (exp = Date.now() + 3600_000, r = 'R1') => `cn_tok=${encodeURIComponent(await seal({ a: 'A1', r, e: exp }, SECRET))}`;
const EXPIRED = () => Date.now() - 1000;
/** the cookies a browser keeps from a response (cleared ones dropped), as a Cookie header */
const jarOf = (res: Response) => res.headers.getSetCookie().filter((c) => c.startsWith('cn_t') && !/Max-Age=0/.test(c)).map((c) => c.split(';')[0]).join('; ');

/** A fake Canva: each refresh token works once (R1 → A2/R2), and `answer` handles everything else. */
function fakeCanva(answer: (url: string, init: RequestInit) => Response | undefined) {
  const used = new Set<string>();
  const seen: { url: string; auth: string | null; redirect?: RequestRedirect }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), redirect: init.redirect });
    if (url.endsWith('/oauth/token')) {
      const r = new URLSearchParams(String(init.body)).get('refresh_token') || '';
      if (used.has(r)) return json({ error: 'invalid_grant', error_description: 'refresh token already used' }, 400);
      used.add(r);
      const n = Number(r.slice(1)) + 1;
      return json({ access_token: `A${n}`, refresh_token: `R${n}`, expires_in: 14400 });
    }
    return answer(url, init) ?? json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { seen, used };
}

describe('the page proxy passes only pictures, never a page on this app’s origin', () => {
  /** A fake download host; like the real fetch, it follows redirects unless told not to. */
  function hosts(table: Record<string, () => Response>) {
    const seen: string[] = [];
    const go = async (url: string, init: RequestInit = {}, hops = 0): Promise<Response> => {
      seen.push(url);
      const res = table[url]?.() ?? new Response('nope', { status: 404 });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc && init.redirect !== 'manual') {
        if (hops >= 20) throw new TypeError('fetch failed: redirect count exceeded');
        return go(new URL(loc, url).toString(), init, hops + 1);
      }
      return res;
    };
    vi.stubGlobal('fetch', vi.fn(go));
    return seen;
  }
  const get = async (u: string) => page(new Request(`https://cardnovel.vercel.app/api/canva/page?u=${encodeURIComponent(u)}`, { headers: { cookie: await tokenCookie() } }));
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

  it('refuses an SVG (or HTML) from an allowed host', async () => {
    for (const type of ['image/svg+xml', 'image/svg+xml; charset=utf-8', 'IMAGE/SVG+XML', 'text/html', 'application/xhtml+xml']) {
      hosts({ 'https://attacker-bucket.s3.amazonaws.com/x.svg': () => new Response(SVG, { headers: { 'content-type': type } }) });
      const res = await get('https://attacker-bucket.s3.amazonaws.com/x.svg');
      expect(res.status, type).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe('not_an_image');
    }
  });

  it('passes PNG, JPEG, WebP and GIF with headers that keep the browser from running anything in it', async () => {
    for (const [type, want] of [['image/png', 'image/png'], ['image/jpeg', 'image/jpeg'], ['image/webp', 'image/webp'], ['image/gif', 'image/gif'], ['image/jpeg; charset=binary', 'image/jpeg']]) {
      hosts({ 'https://export-download.canva.com/p1': () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': type } }) });
      const res = await get('https://export-download.canva.com/p1');
      expect(res.status, type).toBe(200);
      expect(res.headers.get('content-type')).toBe(want);
      expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
      expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-disposition')).toMatch(/^inline/);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }
  });

  it('does not follow a redirect to a host outside Canva’s', async () => {
    const seen = hosts({
      'https://export-download.canva.com/p1': () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.png' } }),
      'https://evil.example.com/x.png': () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    });
    const res = await get('https://export-download.canva.com/p1');
    expect(res.status).not.toBe(200);
    expect(seen).not.toContain('https://evil.example.com/x.png');
  });

  it('follows redirects between Canva’s hosts (absolute or relative), but not forever', async () => {
    const seen = hosts({
      'https://export-download.canva.com/p1': () => new Response(null, { status: 302, headers: { location: '/signed/p1' } }),
      'https://export-download.canva.com/signed/p1': () => new Response(null, { status: 307, headers: { location: 'https://document-export.canva.com/p1.jpg' } }),
      'https://document-export.canva.com/p1.jpg': () => new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/jpeg' } }),
    });
    const res = await get('https://export-download.canva.com/p1');
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9]));
    expect(seen).toEqual(['https://export-download.canva.com/p1', 'https://export-download.canva.com/signed/p1', 'https://document-export.canva.com/p1.jpg']);

    hosts({ 'https://export-download.canva.com/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }) });
    expect((await get('https://export-download.canva.com/loop')).status).toBe(502);
  });
});

describe('a refreshed Canva token reaches the browser even when the call after it fails', () => {
  it('design: the new cookie comes back with the error, and the next call uses it without refreshing', async () => {
    fakeCanva((url) => (url.endsWith('/designs') ? json({ code: 'internal', message: 'boom' }, 500) : undefined));
    const body = JSON.stringify({ width: 1080, height: 640, state: 'w1~c1' });
    const res = await design(new Request('https://x/api/canva/design', { method: 'POST', headers: { cookie: await tokenCookie(EXPIRED()) }, body }));
    expect(res.status).toBe(502);
    const jar = jarOf(res);
    expect(jar).toMatch(/cn_t0=/);

    const { seen } = fakeCanva((url) => (url.endsWith('/designs') ? json({ design: { id: 'D1', urls: { edit_url: 'https://www.canva.com/d/D1' } } }) : undefined));
    const next = await design(new Request('https://x/api/canva/design', { method: 'POST', headers: { cookie: jar }, body }));
    expect(next.status).toBe(200);
    expect(seen.some((s) => s.url.endsWith('/oauth/token'))).toBe(false);
    expect(seen.find((s) => s.url.endsWith('/designs'))?.auth).toBe('Bearer A2');
  });

  it('design: a bad picture is refused before the token is refreshed', async () => {
    const { seen } = fakeCanva(() => undefined);
    const res = await design(new Request('https://x/api/canva/design', {
      method: 'POST', headers: { cookie: await tokenCookie(EXPIRED()) },
      body: JSON.stringify({ width: 1080, height: 640, state: 'w1~c1', image: 'data:image/gif;base64,R0lG' }),
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('bad_image');
    expect(seen.some((s) => s.url.endsWith('/oauth/token'))).toBe(false);
  });

  it('export: a failed export job still sends the new cookie', async () => {
    fakeCanva((url) => (url.endsWith('/exports') ? json({ job: { id: 'E1', status: 'failed', error: { code: 'x', message: 'failed' } } }) : undefined));
    const res = await exportDesign(new Request('https://x/api/canva/export', { method: 'POST', headers: { cookie: await tokenCookie(EXPIRED()) }, body: JSON.stringify({ designId: 'D1' }) }));
    expect(res.status).toBe(502);
    expect(jarOf(res)).toMatch(/cn_t0=/);
  });

  it('finish-export: a failed export job still sends the new cookie', async () => {
    fakeCanva((url) => (url.endsWith('/exports') ? json({ job: { id: 'E1', status: 'failed', error: { code: 'x', message: 'failed' } } }) : undefined));
    const res = await finishExport(new Request('https://x/api/canva/finish-export', { method: 'POST', headers: { cookie: await tokenCookie(EXPIRED()) }, body: JSON.stringify({ designId: 'D1' }) }));
    expect(res.status).toBe(502);
    expect(jarOf(res)).toMatch(/cn_t0=/);
  });

  it('finish-import: a deck Canva cannot read still sends the new cookie (and the upload is deleted)', async () => {
    const DECK = 'https://abc123.public.blob.vercel-storage.com/canva-import/k3j2h1-Xy9.pptx';
    fakeCanva((url) => (url.endsWith('/url-imports') ? json({ job: { id: 'J1', status: 'failed', error: { code: 'invalid_file', message: 'bad' } } }) : undefined));
    const res = await finishImport(new Request('https://x/api/canva/finish-import', {
      method: 'POST', headers: { cookie: await tokenCookie(EXPIRED()) }, body: JSON.stringify({ url: DECK, state: 'w~finish' }),
    }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_file');
    expect(jarOf(res)).toMatch(/cn_t0=/);
    expect(blob.del).toHaveBeenCalledWith(DECK);
  });
});

describe('a refresh token Canva no longer accepts', () => {
  const designWith = async (cookie: string) => design(new Request('https://x/api/canva/design', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ width: 1080, height: 640, state: 'w1~c1' }),
  }));

  it('asks the writer to connect again (not_connected) once the access token has expired', async () => {
    const { used } = fakeCanva(() => undefined);
    used.add('R1');
    const res = await designWith(await tokenCookie(EXPIRED()));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('not_connected');

    const ai = await aiImage(new Request('https://x/api/canva/ai-image', { method: 'POST', headers: { cookie: await tokenCookie(EXPIRED()) }, body: JSON.stringify({ prompt: 'a bus' }) }));
    expect(ai.status).toBe(401);
    expect(((await ai.json()) as { error: string }).error).toBe('not_connected');
  });

  it('keeps using the access token while it still works, when another call has just used the refresh token', async () => {
    const { seen, used } = fakeCanva((url) => (url.endsWith('/designs') ? json({ design: { id: 'D1', urls: { edit_url: 'https://www.canva.com/d/D1' } } }) : undefined));
    used.add('R1'); // a sibling request refreshed first
    const res = await designWith(await tokenCookie(Date.now() + 30_000));
    expect(res.status).toBe(200);
    expect(seen.find((s) => s.url.endsWith('/designs'))?.auth).toBe('Bearer A1');
    expect(jarOf(res)).toBe(''); // the sibling's response carries the new token; this one leaves the cookie alone
  });

  it('still says token_failed when Canva’s token service itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'down' }, 503)));
    const res = await designWith(await tokenCookie(EXPIRED()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('token_failed');
  });
});
