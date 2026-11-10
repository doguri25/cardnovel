import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, connected, disconnect, downloadWork, listBackups, uploadWork } from '../src/drive';
import { DEFAULTS, newWork } from '../src/model';

const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });

function signIn() {
  (window as unknown as { google: unknown }).google = {
    accounts: { oauth2: {
      initTokenClient: (c: { callback: (r: { access_token: string; expires_in: number }) => void }) => ({ requestAccessToken: () => c.callback({ access_token: 'TOKEN', expires_in: 3600 }) }),
      revoke: vi.fn(),
    } },
  };
  return connect('client.apps.googleusercontent.com');
}
afterEach(() => { vi.unstubAllGlobals(); disconnect(); });

describe('Drive client', () => {
  it('needs a client ID', async () => {
    await expect(connect('')).rejects.toMatchObject({ code: 'no_client' });
  });
  it('signs in, finds or makes the folder, and uploads a new work with a resumable upload', async () => {
    await signIn();
    expect(connected()).toBe(true);
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes('/drive/v3/files?q=')) return json({ files: [] });
      if (url.endsWith('/drive/v3/files?fields=id')) return json({ id: 'FOLDER' });
      if (url.includes('/upload/drive/v3/files?uploadType=resumable')) return new Response(null, { status: 200, headers: { location: 'https://upload.example/session1' } });
      if (url === 'https://upload.example/session1') return json({ id: 'FILE1', name: 'x', modifiedTime: '2026-11-02T00:00:00Z' });
      return new Response('nope', { status: 500 });
    }));
    const w = newWork(DEFAULTS);
    w.cards[0].title = '막차'; w.updatedAt = 42;
    const f = await uploadWork(w, null);
    expect(f.id).toBe('FILE1');
    const start = calls.find((c) => c.url.includes('uploadType=resumable'))!;
    expect(start.init.method).toBe('POST');
    expect((start.init.headers as Record<string, string>).authorization).toBe('Bearer TOKEN');
    const meta = JSON.parse(String(start.init.body));
    expect(meta.parents).toEqual(['FOLDER']);
    expect(meta.appProperties).toMatchObject({ app: 'cardnovel', cardnovelId: w.id, updatedAt: '42' });
    const put = calls.find((c) => c.url === 'https://upload.example/session1')!;
    expect(put.init.method).toBe('PUT');
    expect(JSON.parse(String(put.init.body)).work.id).toBe(w.id);
  });
  it('updates an existing file in place and reads files back', async () => {
    await signIn();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url.includes('/upload/drive/v3/files/FILE1?uploadType=resumable')) return new Response(null, { headers: { location: 'https://upload.example/s2' } });
      if (url === 'https://upload.example/s2') return json({ id: 'FILE1' });
      if (url.includes('/files/FILE1?alt=media')) return json({ app: 'cardnovel', version: 1, work: { id: 'w1', cards: [] } });
      if (url.includes("mimeType='application/vnd.google-apps.folder'")) return json({ files: [{ id: 'FOLDER' }] });
      if (url.includes('in+parents') || url.includes('in%20parents')) return json({ files: [{ id: 'FILE1', name: 'a', modifiedTime: '' }] });
      return new Response('nope', { status: 500 });
    }));
    await uploadWork(newWork(DEFAULTS), { id: 'FILE1', name: 'a', modifiedTime: '' });
    expect(calls[0]).toMatch(/^PATCH https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/FILE1\?uploadType=resumable/);
    expect((await downloadWork('FILE1')).id).toBe('w1');
    expect(await listBackups()).toHaveLength(1);
  });
  it('drops the token when Google says it expired', async () => {
    await signIn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(listBackups()).rejects.toMatchObject({ code: 'auth' });
    expect(connected()).toBe(false);
  });
});
