// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const blob = vi.hoisted(() => ({
  put: vi.fn(async (path: string) => ({ url: `https://abc123.public.blob.vercel-storage.com/${path}` })),
  head: vi.fn(async (path: string) => ({ url: `https://abc123.public.blob.vercel-storage.com/${path}` })),
  list: vi.fn(async () => ({ blobs: [{ url: 'https://abc123.public.blob.vercel-storage.com/shares/x/01.jpg' }] })),
  del: vi.fn(async () => undefined),
}));
vi.mock('@vercel/blob', () => blob);

import { sharePage, validateManifest } from '../api/_lib/share';
import { POST as upload } from '../api/_share/upload';
import { POST as create } from '../api/_share/create';
import { POST as remove } from '../api/_share/delete';
import { GET as page } from '../api/_share/page';
import { GET as status } from '../api/_share/status';

const KEY = 'cn-test-key';
const ID = 'abcdefghij0123';
const img = (n: number, id = ID) => `https://abc123.public.blob.vercel-storage.com/shares/${id}/${String(n).padStart(2, '0')}.jpg`;
beforeAll(() => { process.env.SHARE_KEY = KEY; process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test'; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const req = (path: string, init: RequestInit & { key?: string } = {}) =>
  new Request(`https://cardnovel.vercel.app${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), ...(init.key !== undefined ? { 'x-share-key': init.key } : {}) } });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('share link API', () => {
  it('reports whether the key is right', async () => {
    expect(await (await status(req('/api/share/status', { key: KEY }))).json()).toEqual({ enabled: true, keyOk: true });
    expect(await (await status(req('/api/share/status', { key: 'nope' }))).json()).toEqual({ enabled: true, keyOk: false });
  });
  it('uploads a JPEG card under the link folder, only with the key', async () => {
    const bad = await upload(req(`/api/share/upload?id=${ID}&n=1`, { method: 'POST', key: 'wrong', body: JPEG, headers: { 'content-type': 'image/jpeg' } }));
    expect(bad.status).toBe(401);
    const notJpeg = await upload(req(`/api/share/upload?id=${ID}&n=1`, { method: 'POST', key: KEY, body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/jpeg' } }));
    expect(notJpeg.status).toBe(415);
    const badN = await upload(req(`/api/share/upload?id=${ID}&n=21`, { method: 'POST', key: KEY, body: JPEG, headers: { 'content-type': 'image/jpeg' } }));
    expect(badN.status).toBe(400);
    const ok = await upload(req(`/api/share/upload?id=${ID}&n=7`, { method: 'POST', key: KEY, body: JPEG, headers: { 'content-type': 'image/jpeg' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ url: img(7) });
    expect(blob.put).toHaveBeenCalledWith(`shares/${ID}/07.jpg`, expect.anything(), expect.objectContaining({ access: 'public', addRandomSuffix: false, contentType: 'image/jpeg' }));
  });
  it('accepts only pictures uploaded for this link', () => {
    const images = Array.from({ length: 20 }, (_, i) => img(i + 1));
    expect(validateManifest({ title: '막차', images, ratio: '4:5' }, ID)).toMatchObject({ id: ID, ratio: '4:5', title: '막차' });
    expect(() => validateManifest({ images: [img(1, 'otherlink00000')] }, ID)).toThrow();
    expect(() => validateManifest({ images: ['https://evil.example.com/shares/' + ID + '/01.jpg'] }, ID)).toThrow();
    expect(() => validateManifest({ images: [img(2)] }, ID)).toThrow(); // out of order
    expect(() => validateManifest({ images: [] }, ID)).toThrow();
    expect(validateManifest({ images: [img(1)], ratio: '7:3' }, ID).ratio).toBe('1:1');
  });
  it('publishes the manifest and returns the /s/ link', async () => {
    const res = await create(req('/api/share/create', { method: 'POST', key: KEY, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ID, title: '막차', images: [img(1), img(2)] }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, url: `https://cardnovel.vercel.app/s/${ID}` });
    expect(blob.put).toHaveBeenCalledWith(`shares/${ID}/manifest.json`, expect.stringContaining('"title":"막차"'), expect.objectContaining({ access: 'public' }));
  });
  it('deletes every file of a link', async () => {
    const res = await remove(req('/api/share/delete', { method: 'POST', key: KEY, body: JSON.stringify({ id: ID }) }));
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(blob.list).toHaveBeenCalledWith({ prefix: `shares/${ID}/`, limit: 100 });
    expect(blob.del).toHaveBeenCalled();
  });
  it('serves the viewer page with the cover as the link preview', async () => {
    const manifest = validateManifest({ title: '막차', hook: '종점의 승객', handle: '@midnight.cards', series: '3분 미스터리 · 2화', ratio: '4:5', images: [img(1), img(2)] }, ID);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } })));
    const res = await page(req(`/api/share/page?id=${ID}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<meta property="og:image" content="${img(1)}">`);
    expect(html).toContain('og:image:height" content="1350"');
    expect(html).toContain('aspect-ratio:4/5');
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/);
  });
  it('says a missing link is gone', async () => {
    blob.head.mockRejectedValueOnce(new Error('BlobNotFoundError'));
    const res = await page(req(`/api/share/page?id=${ID}`));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('없거나 지워졌어요');
    expect((await page(req('/api/share/page?id=../../x'))).status).toBe(404);
  });
  it('escapes what the writer typed', () => {
    const m = validateManifest({ title: '<script>alert(1)</script>', caption: '"><img src=x onerror=alert(1)>', images: [img(1)] }, ID);
    const html = sharePage(m, 'https://cardnovel.vercel.app', 'NONCE');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('one function per endpoint group', () => {
  it('routes /api/share/<action> and /s/<id> to the right handler', async () => {
    const { GET, POST } = await import('../api/share');
    expect(await (await GET(req('/api/share?action=status', { key: KEY }))).json()).toEqual({ enabled: true, keyOk: true });
    expect(await (await GET(req('/api/share/status', { key: KEY }))).json()).toEqual({ enabled: true, keyOk: true });
    expect((await GET(req('/api/share?action=nope'))).status).toBe(404);
    expect((await GET(req('/api/share?action=upload'))).status).toBe(405);
    blob.head.mockRejectedValueOnce(new Error('missing'));
    const page = await GET(req(`/s/${ID}`));
    expect(page.status).toBe(404);
    expect(blob.head).toHaveBeenCalledWith(`shares/${ID}/manifest.json`);
    const r = await POST(req('/api/share?action=delete', { method: 'POST', key: KEY, body: JSON.stringify({ id: ID }) }));
    expect(await r.json()).toEqual({ deleted: 1 });
  });
});
