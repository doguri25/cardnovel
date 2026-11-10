import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decide, planSync, type DriveFile } from '../src/drive';
import { DEFAULTS, newWork, type Work } from '../src/model';
import { cardSig, lookSig } from '../src/render';
import { attach, changedCards, deleteAllVersions, deleteVersion, detach, hashString, listVersions, loadVersion, saveVersion, workSig } from '../src/versions';

const big = (ch: string) => 'data:image/webp;base64,' + ch.repeat(5000);
const sample = (): Work => {
  const w = newWork(DEFAULTS);
  w.cards[0].title = '막차';
  w.cards[1].text = '밤 버스는 비어 있었다.';
  w.cards[1].img = big('A');
  w.cards[2].img = big('B');
  w.cards[3].svg = '<svg/>';
  w.style.refImage = big('C');
  return w;
};

async function blobCount(): Promise<number> {
  const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('cardnovel-versions', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return new Promise((res) => { const q = db.transaction('blobs').objectStore('blobs').count(); q.onsuccess = () => res(q.result); });
}

describe('version history', () => {
  it('takes pictures out of a snapshot and puts them back', () => {
    const w = sample();
    const { work, blobs } = detach(w);
    expect(blobs.size).toBe(3);
    expect(work.cards[1].img).toMatch(/^vblob:/);
    expect(work.cards[3].svg).toBe('<svg/>'); // small: stays inline
    expect(attach(work, blobs)).toEqual(JSON.parse(JSON.stringify(w)));
    expect(w.cards[1].img).toBe(big('A')); // the original is untouched
  });
  it('fingerprints words and pictures', () => {
    const a = sample(), b = sample();
    b.id = a.id;
    expect(workSig(a)).toBe(workSig(b));
    b.cards[2].img = big('D');
    expect(workSig(a)).not.toBe(workSig(b));
    b.cards[5].text = '새 글';
    expect(changedCards(a, b)).toBe(2);
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
  it('stores shared pictures once, skips unchanged autos, and frees pictures with the last version', async () => {
    const w = sample();
    const v1 = await saveVersion(w, 'compose');
    expect(v1).not.toBeNull();
    expect(await saveVersion(w, 'timer')).toBeNull(); // nothing changed
    w.cards[1].text = '고친 글';
    const v2 = await saveVersion(w, 'timer');
    expect(v2).not.toBeNull();
    const named = await saveVersion(w, 'manual', '첫 완성본');
    expect(named?.label).toBe('첫 완성본');
    expect(await blobCount()).toBe(3); // three versions, three pictures
    const list = await listVersions(w.id);
    expect(list.map((v) => v.reason)).toEqual(['manual', 'timer', 'compose']);
    const back = await loadVersion(v1!.id);
    expect(back?.cards[1].text).toBe('밤 버스는 비어 있었다.');
    expect(back?.cards[1].img).toBe(big('A'));
    await deleteVersion(v1!.id);
    await deleteVersion(v2!.id);
    expect(await blobCount()).toBe(3); // still used by the named version
    await deleteAllVersions(w.id);
    expect(await blobCount()).toBe(0);
    expect(await listVersions(w.id)).toEqual([]);
  });
  it('keeps the latest 30 automatic versions and every named one', async () => {
    const w = sample();
    await saveVersion(w, 'manual', '남김');
    for (let i = 0; i < 33; i++) { w.cards[4].text = `글 ${i}`; await saveVersion(w, 'timer'); }
    const list = await listVersions(w.id);
    expect(list.filter((v) => v.reason === 'timer')).toHaveLength(30);
    expect(list.some((v) => v.label === '남김')).toBe(true);
    await deleteAllVersions(w.id);
  });
});

describe('continuing from Drive', () => {
  const file = (id: string, t: number): DriveFile => ({ id: 'f-' + id, name: id, modifiedTime: '', appProperties: { cardnovelId: id, updatedAt: String(t) } });
  it('loads a copy changed only elsewhere, asks when both sides changed', () => {
    expect(decide(file('a', 50), { updatedAt: 40 }, 40)).toBe('load');   // here unchanged since the last sync
    expect(decide(file('a', 50), { updatedAt: 45 }, 40)).toBe('ask');    // changed here too
    expect(decide(file('a', 50), { updatedAt: 40 }, undefined)).toBe('ask'); // never compared on this device
    expect(decide(file('a', 40), { updatedAt: 50 }, 40)).toBe('none');   // this device is newer
    expect(decide(undefined, { updatedAt: 1 }, 1)).toBe('none');
  });
  it('sorts every work into update, conflict, only-on-Drive and the open one', () => {
    const plan = planSync(
      [file('cur', 90), file('b', 70), file('c', 70), file('d', 70), file('e', 10)],
      [{ id: 'cur', updatedAt: 80 }, { id: 'b', updatedAt: 60 }, { id: 'c', updatedAt: 65 }, { id: 'e', updatedAt: 20 }],
      { cur: 80, b: 60, c: 60, e: 10 },
      'cur',
    );
    expect(plan.current).toBe('load');
    expect(plan.currentFile?.id).toBe('f-cur');
    expect(plan.update.map((f) => f.id)).toEqual(['f-b']);
    expect(plan.conflicts.map((f) => f.id)).toEqual(['f-c']);
    expect(plan.onlyOnDrive.map((f) => f.id)).toEqual(['f-d']);
  });
});

describe('thumbnail cache', () => {
  it('changes a card’s fingerprint only when something it shows changes', () => {
    const w = sample();
    const s1 = cardSig(w, 1), s2 = cardSig(w, 2);
    w.cards[1].text = '다른 글';
    expect(cardSig(w, 1)).not.toBe(s1);
    expect(cardSig(w, 2)).toBe(s2);
    w.cards[2].imgPos = 'top';
    expect(cardSig(w, 2)).not.toBe(s2);
    const look = lookSig(w);
    w.theme = 'news';
    expect(lookSig(w)).not.toBe(look); // a theme change redraws every card
  });
});

describe('service worker template', () => {
  it('has the placeholders the build fills in, once each', () => {
    const t = readFileSync('sw/sw.template.js', 'utf8');
    expect(t.match(/__VERSION__/g)).toHaveLength(1);
    expect(t.match(/__ASSETS__/g)).toHaveLength(1);
    expect(t).toContain("url.pathname.startsWith('/s/')");
    // other pages (privacy policy, terms) never become the cached app shell
    expect(t).toContain("url.pathname !== '/' && url.pathname !== '/index.html') return;");
  });
});
