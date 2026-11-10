import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, decide, disconnect, planSync, syncedMap, type DriveFile } from '../src/drive';
import { DEFAULTS, newPost, newWork, type Work } from '../src/model';
import { kv, works } from '../src/store';
import { backupOne, renderDriveBox } from '../src/ui/drive';
import type { App } from '../src/app';
import { deleteAllVersions, listVersions, saveVersion } from '../src/versions';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect(); });

/* ---------- #15: a work changed on both devices is a conflict even when this device saved last ---------- */
describe('Drive conflicts', () => {
  const file = (id: string, t: number): DriveFile => ({ id: 'f-' + id, name: id, modifiedTime: '', appProperties: { cardnovelId: id, updatedAt: String(t) } });

  it('asks when both sides changed since the last sync, whichever saved later', () => {
    // last agreed at 100; the phone backed up at 200; this laptop edited at 250 without backing up
    expect(decide(file('a', 200), { updatedAt: 250 }, 100)).toBe('ask');
    expect(decide(file('a', 200), { updatedAt: 250 }, 200)).toBe('none'); // Drive unchanged since the last sync
    expect(decide(file('a', 100), { updatedAt: 100 }, 50)).toBe('none');  // the same copy on both sides
    expect(decide(file('a', 100), { updatedAt: 100 }, undefined)).toBe('none');
    expect(decide(file('a', 40), { updatedAt: 50 }, undefined)).toBe('none'); // never compared, this device later
    const plan = planSync([file('a', 200), file('cur', 200)], [{ id: 'a', updatedAt: 250 }, { id: 'cur', updatedAt: 250 }], { a: 100, cur: 100 }, 'cur');
    expect(plan.current).toBe('ask');
    expect(plan.conflicts.map((f) => f.id)).toEqual(['f-a']);
  });

  it('lists copies that are already the same so the device can record them as agreed', () => {
    const plan = planSync([file('a', 100), file('b', 70)], [{ id: 'a', updatedAt: 100 }, { id: 'b', updatedAt: 70 }], { b: 70 }, 'x');
    expect(plan.agreed).toEqual({ a: 100 });
  });

  const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { ...init, headers: { 'content-type': 'application/json' } });
  function signIn() {
    (window as unknown as { google: unknown }).google = {
      accounts: { oauth2: {
        initTokenClient: (c: { callback: (r: { access_token: string; expires_in: number }) => void }) => ({ requestAccessToken: () => c.callback({ access_token: 'TOKEN', expires_in: 3600 }) }),
        revoke: vi.fn(),
      } },
    };
    return connect('client.apps.googleusercontent.com');
  }
  /** Drive holding one file per given work id (at the given save time); records uploads */
  function fakeDrive(files: DriveFile[]) {
    const uploads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("mimeType='application/vnd.google-apps.folder'") || url.includes('mimeType%3D%27application')) return json({ files: [{ id: 'FOLDER' }] });
      if (url.includes('/drive/v3/files?') && (url.includes('in+parents') || url.includes('in%20parents'))) return json({ files });
      if (url.includes('/drive/v3/files?') && url.includes('cardnovelId')) {
        const q = decodeURIComponent(url.replace(/\+/g, ' '));
        return json({ files: files.filter((f) => q.includes(`value='${f.appProperties!.cardnovelId}'`)) });
      }
      if (url.includes('/upload/drive/v3/files')) {
        uploads.push(JSON.parse(String(init.body)).appProperties.cardnovelId);
        return new Response(null, { headers: { location: 'https://upload.example/s' } });
      }
      if (url === 'https://upload.example/s') return json({ id: 'F' });
      return new Response('nope', { status: 500 });
    }));
    return uploads;
  }
  const work = (id: string, t: number): Work => ({ ...newWork(DEFAULTS), id, updatedAt: t });

  it('backing up does not replace a Drive copy another device changed, even when this device saved later', async () => {
    await signIn();
    await kv.set('drive.synced', { w1: 100 });
    const uploads = fakeDrive([file('w1', 200)]);
    expect(await backupOne(work('w1', 250))).toBe('conflict');
    expect(uploads).toEqual([]);
    expect(await backupOne(work('w1', 250), true)).toBe('saved'); // the writer chose to overwrite
    expect(uploads).toEqual(['w1']);
  });

  it('backs up when only this device changed, and records an identical copy as agreed', async () => {
    await signIn();
    await kv.set('drive.synced', { w2: 100 });
    const uploads = fakeDrive([file('w2', 100), file('w3', 300)]);
    expect(await backupOne(work('w2', 250))).toBe('saved');
    expect(uploads).toEqual(['w2']);
    // the same copy on both sides (imported from a file, say): agreed from now on, so the next edit backs up
    expect(await backupOne(work('w3', 300))).toBe('same');
    expect((await syncedMap()).w3).toBe(300);
  });

  it('「모두 백업」 skips works another device changed', async () => {
    await signIn();
    for (const w of await works.all()) await works.del(w.id);
    await works.put(work('a1', 250)); // changed on both sides
    await works.put(work('a2', 250)); // changed only here
    await kv.set('drive.synced', { a1: 100, a2: 100 });
    const uploads = fakeDrive([file('a1', 200), file('a2', 100)]);
    const el = document.createElement('div');
    const app = { flush: async () => undefined, work: () => work('a2', 250), online: () => true } as unknown as App;
    await renderDriveBox(el, app, { clientId: () => 'client', defaults: () => DEFAULTS, reopenLibrary: () => undefined }, () => undefined);
    el.querySelector<HTMLButtonElement>('[data-a="all"]')!.click();
    const st = el.querySelector<HTMLElement>('[data-status]')!;
    await vi.waitFor(() => expect(st.textContent).toContain('1편을 백업했어요'));
    expect(st.textContent).toContain('1편은');
    expect(uploads).toEqual(['a2']);
  });
});

/* ---------- #16: safety versions keep edits outside the words and pictures ---------- */
describe('safety versions', () => {
  it('are kept when only the caption, posts, style or card design changed', async () => {
    const w = newWork(DEFAULTS);
    w.cards[1].text = '밤 버스는 비어 있었다.';
    expect(await saveVersion(w, 'timer')).not.toBeNull();
    expect(await saveVersion({ ...w, updatedAt: w.updatedAt + 5, thumb: 'data:image/jpeg;base64,xx' }, 'timer')).toBeNull(); // nothing the writer changed
    const edits: ((x: Work) => void)[] = [
      (x) => { x.caption = '새 캡션'; },
      (x) => { x.hashtags = ['#카드소설']; },
      (x) => { x.posts = [newPost(1)]; },
      (x) => { x.name = '막차 1화'; },
      (x) => { x.style = { ...x.style, prompt: 'watercolor' }; },
      (x) => { x.cards[2] = { ...x.cards[2], accent: true }; },
      (x) => { x.cards[2] = { ...x.cards[2], textScale: 1.3 }; },
    ];
    for (const edit of edits) {
      edit(w);
      expect(await saveVersion(w, 'restore')).not.toBeNull();
    }
    expect(await listVersions(w.id)).toHaveLength(edits.length + 1);
    await deleteAllVersions(w.id);
  });
  it('are kept when Canva sends different finished pictures of the same count', async () => {
    const pic = (ch: string) => 'data:image/png;base64,' + ch.repeat(3000);
    const w: Work = { ...newWork(DEFAULTS), finished: { designId: 'D', images: [pic('A'), pic('B')], at: 1, on: true } };
    expect(await saveVersion(w, 'timer')).not.toBeNull();
    w.finished = { ...w.finished!, images: [pic('C'), pic('D')] };
    expect(await saveVersion(w, 'canva')).not.toBeNull();
    await deleteAllVersions(w.id);
  });
});
