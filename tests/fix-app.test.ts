// Races and mix-ups in the app controller: AI work that finishes after the writer moved on, undo steps, the trash.
// The app tests load the real src/main.ts on the real index.html in jsdom, with the AI calls replaced.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AiError } from '../src/ai/providers';
import { askJSON, CARD_VARIANTS, COVER_VARIANTS, refreshScenes, rewriteCard, sceneStale, summarize, writeOutro } from '../src/ai/compose';
import { DEFAULTS, newWork, type Work, textSig } from '../src/model';

const hooks = vi.hoisted(() => ({
  generateJSON: null as null | ((req: { tag?: string; maxTokens?: number; prompt: string }) => Promise<unknown>),
  drawCard: null as null | ((w: { id: string; cards: { id: string; text: string; scene: string }[] }, i: number, variant?: string) => Promise<{ img?: string; svg?: string }>),
  confirm: null as null | (() => Promise<boolean>),
}));

vi.mock('../src/ai/providers', async (orig) => {
  const m = await orig<typeof import('../src/ai/providers')>();
  return {
    ...m,
    generateJSON: (req: Parameters<typeof m.generateJSON>[0]) => (hooks.generateJSON ? hooks.generateJSON(req) : m.generateJSON(req)),
    listModels: async () => ({ text: [], image: [] }),
  };
});
vi.mock('../src/ai/compose', async (orig) => {
  const m = await orig<typeof import('../src/ai/compose')>();
  return { ...m, drawCard: (...a: Parameters<typeof m.drawCard>) => (hooks.drawCard ? hooks.drawCard(a[0], a[1], a[5]) : m.drawCard(...a)) };
});
vi.mock('../src/ui/dom', async (orig) => {
  const m = await orig<typeof import('../src/ui/dom')>();
  return { ...m, confirmBox: async () => (hooks.confirm ? hooks.confirm() : true) };
});

// longer than until()'s own limit, so a test that waits in vain ends (and puts its AI stand-ins back) before the next one starts
vi.setConfig({ testTimeout: 30000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(15); }
}
const ai = { provider: 'anthropic' as const, key: 'k', model: 'claude-test' };
/** An AI answer held back until the test lets it through. */
function gate() { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; }

/** A work with words and up-to-date scenes on every card, drawn with Claude SVG. */
function storyWork(name = '테스트'): Work {
  const w = newWork(DEFAULTS);
  w.id = name + Math.random().toString(36).slice(2, 8);
  w.textAI = { provider: 'anthropic', model: 'claude-test' };
  w.imageAI = { provider: 'claude', model: 'claude-test' };
  w.cards.forEach((c, i) => {
    if (c.kind === 'cover') c.title = `${name} 제목`;
    c.text = c.kind === 'outro' ? '다음 이야기도 기대해 주세요' : `${name} ${i + 1}번째 장면. 지수는 낡은 엘리베이터 앞에서 오래 망설였다.`;
    c.scene = `Scene ${i + 1}`;
    c.sceneFor = c.text;
  });
  w.style.directedFor = textSig(w); // and 연출 정리 already done for these words
  return w;
}

/* ================= the AI's short tasks get room to answer ================= */
describe('short AI tasks', () => {
  it('an empty answer is asked once more, with room for a model that thinks first', async () => {
    const budgets: number[] = [];
    hooks.generateJSON = async (req) => { budgets.push(req.maxTokens!); if (budgets.length === 1) throw new AiError('empty'); return { text: '그날 밤, 13층 불이 다시 켜졌다' }; };
    try {
      expect(await writeOutro(storyWork(), 'teaser', ai)).toBe('그날 밤, 13층 불이 다시 켜졌다');
      expect(budgets).toEqual([1000, 8000]);
    } finally { hooks.generateJSON = null; }
  });

  it('a cut-off answer (no JSON) is asked again with more room, not the same budget', async () => {
    const budgets: number[] = [];
    let fail = true;
    hooks.generateJSON = async (req) => { budgets.push(req.maxTokens!); if (fail) { fail = false; throw new AiError('invalid_json'); } return { text: '줄거리' }; };
    try {
      expect(await summarize(storyWork(), ai)).toBe('줄거리');
      expect(budgets).toEqual([1500, 8000]);
      budgets.length = 0; fail = true;
      expect(await rewriteCard(storyWork(), 3, '', ai)).toBe('줄거리');
      expect(budgets).toEqual([2000, 8000]);
    } finally { hooks.generateJSON = null; }
  });

  const tooBig = () => new AiError('bad_request', 'max_tokens: 16000 > 8192, which is the maximum allowed for this model');

  it('the second try stays within what the model accepts', async () => {
    // scenes (4000): cut off, then 16000 is refused, so 8000
    const budgets: number[] = [];
    hooks.generateJSON = async (req) => {
      budgets.push(req.maxTokens!);
      if (budgets.length === 1) throw new AiError('invalid_json');
      if (req.maxTokens! > 8000) throw tooBig();
      return { scenes: [] };
    };
    try {
      await refreshScenes(storyWork(), [3], ai);
      expect(budgets).toEqual([4000, 16000, 8000]);
    } finally { hooks.generateJSON = null; }
  });

  it('a model that refuses 16k is asked with 8k, and once more with 8k after a cut-off answer', async () => {
    const budgets: number[] = [];
    hooks.generateJSON = async (req) => {
      budgets.push(req.maxTokens!);
      if (req.maxTokens! > 8000) throw tooBig();
      if (budgets.length === 2) throw new AiError('invalid_json');
      return { ok: true };
    };
    try {
      expect(await askJSON(ai, 'p', {}, undefined, 16000)).toEqual({ ok: true });
      expect(budgets).toEqual([16000, 8000, 8000]);
    } finally { hooks.generateJSON = null; }
  });

  it('other failures are not asked again', async () => {
    let n = 0;
    hooks.generateJSON = async () => { n++; throw new AiError('rate_limited'); };
    try {
      await expect(writeOutro(storyWork(), 'teaser', ai)).rejects.toMatchObject({ code: 'rate_limited' });
      expect(n).toBe(1);
    } finally { hooks.generateJSON = null; }
  });
});

/* ================= scenes written while the writer keeps working ================= */
describe('refreshing scenes', () => {
  it('a new scene goes to the card it was written for, even when that card moved meanwhile', async () => {
    const w = storyWork();
    w.cards[5].scene = '';
    const five = w.cards[4], six = w.cards[5];
    hooks.generateJSON = async () => {
      // ▲ on card 6 while the AI writes
      [w.cards[4], w.cards[5]] = [w.cards[5], w.cards[4]];
      return { scenes: [{ card: 6, scene: 'Elevator doors open on a dark floor.' }] };
    };
    try {
      expect(await refreshScenes(w, [5], ai)).toBe(1);
    } finally { hooks.generateJSON = null; }
    expect(six.scene).toBe('Elevator doors open on a dark floor.');
    expect(six.sceneFor).toBe(six.text);
    expect(five.scene).toBe('Scene 5');
    expect(five.sceneFor).toBe(five.text);
  });

  it('a scene for words that were rewritten meanwhile still reads as out of date', async () => {
    const w = storyWork();
    w.cards[3].text = '처음 글: 지수가 계단을 내려간다.';
    w.cards[3].scene = '';
    const sent = w.cards[3].text;
    hooks.generateJSON = async () => {
      w.cards[3].text = '완전히 다른 새 글: 민호는 비 오는 정류장에서 버스를 기다리며 휴대폰만 들여다보았다.';
      return { scenes: [{ card: 4, scene: 'A scene for the first words' }] };
    };
    try {
      await refreshScenes(w, [3], ai);
    } finally { hooks.generateJSON = null; }
    expect(w.cards[3].scene).toBe('A scene for the first words');
    expect(w.cards[3].sceneFor).toBe(sent);
    expect(sceneStale(w.cards[3])).toBe(true);
  });
});

/* ================= the app ================= */
function installDom() {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>')).replace(/<script[^>]*><\/script>/g, '');
  const noop = () => undefined;
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop: noop });
      if (k === 'getImageData' || k === 'createImageData') return (w = 1, h = 1) => ({ width: w, height: h, data: new Uint8ClampedArray(4 * w * h) });
      if (k === 'canvas') return { width: 1080, height: 1080 };
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => ctx;
  proto.toDataURL = () => 'data:image/jpeg;base64,AAAA';
  proto.toBlob = (cb: (b: Blob) => void) => cb(new Blob(['x']));
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = noop;
  (Element.prototype as unknown as Record<string, unknown>).scrollTo = noop;
  let blobs = 0;
  (URL as unknown as Record<string, unknown>).createObjectURL = () => `blob:test/${++blobs}`;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = noop;
  const win = window as unknown as Record<string, unknown>;
  win.scrollTo = noop;
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
  win.open = () => null;
  vi.stubGlobal('fetch', async () => new Response('{"error":"offline in tests"}', { status: 500 }));
  class FakeImage {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    naturalWidth = 1080; naturalHeight = 1080; width = 1080; height = 1080; private s = '';
    set src(v: string) { this.s = v; setTimeout(() => this.onload?.(), 0); }
    get src() { return this.s; }
    decode() { return Promise.resolve(); }
    addEventListener() { /* not used */ }
  }
  vi.stubGlobal('Image', FakeImage);
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cur = (): Work => window.__cardnovel!.work();
const row = (i: number) => document.querySelector<HTMLElement>(`.card-row[data-i="${i}"]`)!;
const type = (i: number, text: string) => {
  const ta = row(i).querySelector<HTMLTextAreaElement>('textarea[data-f="text"]')!;
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
};
const ctrlZ = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
let store: typeof import('../src/store');
let library: typeof import('../src/library');
let versions: typeof import('../src/versions');

/** Opens `w` from the library, the way the writer does. `meanwhile` runs right after 「열기」 is clicked. */
async function openFromLibrary(w: Work, meanwhile?: () => void): Promise<Work> {
  await store.works.put(w);
  el('btnLibrary').click();
  const sel = `.work[data-id="${w.id}"] [data-a="open"]`;
  await until(() => !!document.querySelector(sel));
  document.querySelector<HTMLButtonElement>(sel)!.click();
  meanwhile?.();
  await until(() => cur().id === w.id && el('modal').hidden);
  return cur();
}
const drawing = () => !el('btnArtStop').hidden;

beforeAll(async () => {
  installDom();
  const { saveSettings, DEFAULT_SETTINGS } = await import('../src/settings');
  await saveSettings({
    ...DEFAULT_SETTINGS,
    keys: { ...DEFAULT_SETTINGS.keys, anthropic: 'sk-ant-test' },
    models: { ...DEFAULT_SETTINGS.models, anthropic: 'claude-test' },
    imageAI: { provider: 'claude', model: 'claude-test' },
  });
  store = await import('../src/store');
  library = await import('../src/library');
  versions = await import('../src/versions');
  await import('../src/main');
  await until(() => document.querySelectorAll('.card-row').length === 20);
}, 30000);

describe('모든 그림 그리기 while the writer opens another work', () => {
  it('stops drawing into the work opened, and keeps the pictures already being drawn in the work they were for', async () => {
    const A = await openFromLibrary(storyWork('A'));
    const calls: { work: string; card: string }[] = [];
    // the cover comes back at once; the next two while the other work is being opened; the two after that once it is open
    const opening = gate(), opened = gate();
    hooks.drawCard = async (w, i) => {
      const card = w.cards[i].id;
      calls.push({ work: w.id, card });
      const n = calls.length;
      await (n === 1 ? sleep(20) : n <= 3 ? opening.wait : opened.wait);
      return { svg: `<svg xmlns="http://www.w3.org/2000/svg" data-card="${card}"/>` };
    };
    try {
      el<HTMLButtonElement>('btnArtAll').click();
      await until(() => calls.length === 3); // the cover, then two at a time
      const B = await openFromLibrary(storyWork('B'), () => opening.open());
      expect(calls).toHaveLength(5);
      opened.open();
      await until(() => !drawing());
      expect(calls.filter((c) => c.work === B.id)).toEqual([]);
      expect(cur().id).toBe(B.id);
      expect(cur().cards.some((c) => c.svg)).toBe(false);
      // every picture asked for A is in A's stored copy, on the card it was drawn for
      const stored = (await store.works.get(A.id))!;
      for (const c of calls) expect(stored.cards.find((k) => k.id === c.card)?.svg).toContain(`data-card="${c.card}"`);
      expect(stored.cards.filter((k) => k.svg)).toHaveLength(5);
      expect(el('artStatus').textContent).toContain('작품이 바뀌어');
      // and the work opened is not overwritten by A's later autosave
      await sleep(1000);
      expect((await store.works.get(B.id))!.cards.some((c) => c.svg)).toBe(false);
      expect((await store.works.get(A.id))!.cards.filter((k) => k.svg)).toHaveLength(5);
    } finally { hooks.drawCard = null; }
  });

  it('draws each card once when a card is moved during the run', async () => {
    const w = await openFromLibrary(storyWork('M'));
    const calls: { card: string; text: string }[] = [];
    hooks.drawCard = async (wk, i) => {
      const { id, text } = wk.cards[i];
      calls.push({ card: id, text });
      await sleep(60);
      return { svg: `<svg xmlns="http://www.w3.org/2000/svg" data-card="${id}"/>` };
    };
    try {
      el<HTMLButtonElement>('btnArtAll').click();
      await until(() => calls.length >= 4);
      // drag thumbnail 18 to slot 3
      const thumbs = el('thumbs').children;
      thumbs[17].dispatchEvent(new Event('dragstart', { bubbles: true }));
      thumbs[2].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      expect(cur().cards[2].text).toContain('18번째');
      await until(() => !drawing(), 20000);
      const ids = calls.map((c) => c.card);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(19);
      // each picture is on the card whose words it was drawn from
      for (const c of calls) {
        const card = cur().cards.find((k) => k.id === c.card)!;
        expect(card.text).toBe(c.text);
        expect(card.svg).toContain(`data-card="${c.card}"`);
      }
      expect(cur().id).toBe(w.id);
    } finally { hooks.drawCard = null; }
  });

  it('cannot be started twice: not by a second click while the cost question is open, nor after settings are saved', async () => {
    await openFromLibrary(storyWork('T'));
    const calls: string[] = [];
    let inFlight = 0, inFlightWhenStopHidden = -1;
    hooks.confirm = () => sleep(40).then(() => true);
    hooks.drawCard = async (w, i) => {
      calls.push(w.cards[i].id);
      inFlight++;
      await sleep(50);
      inFlight--;
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' };
    };
    try {
      const btn = el<HTMLButtonElement>('btnArtAll');
      btn.click();
      btn.click(); // again, while the cost question is still open
      await until(() => calls.length >= 2);
      // 「저장하고 닫기」 in the settings, coming back online and saving a key all redraw the picture AI box
      window.dispatchEvent(new Event('online'));
      await sleep(30);
      expect(btn.disabled).toBe(true);
      btn.click();
      await until(() => !drawing(), 20000);
      inFlightWhenStopHidden = inFlight;
      await sleep(200);
      expect(inFlightWhenStopHidden).toBe(0);
      expect(new Set(calls).size).toBe(calls.length);
      expect(calls.length).toBe(19);
    } finally { hooks.drawCard = null; hooks.confirm = null; }
  });
});

describe('그림 후보 on any card', () => {
  const pickable = () => document.querySelectorAll('#modal [data-pick]:not([disabled])').length;
  it('a body card gets two compositions of its own scene, and the one picked goes on that card only', async () => {
    await openFromLibrary(storyWork('C'));
    const asked: { i: number; variant?: string }[] = [];
    hooks.drawCard = async (_w, i, variant) => {
      asked.push({ i, variant });
      return { svg: `<svg xmlns="http://www.w3.org/2000/svg" data-v="${CARD_VARIANTS.indexOf(variant!)}"/>` };
    };
    try {
      const btn = row(4).querySelector<HTMLButtonElement>('[data-act="cands"]')!;
      expect(btn.textContent).toBe('후보 2장');
      btn.click();
      await until(() => pickable() === 2);
      expect(CARD_VARIANTS).toHaveLength(2);
      expect(asked.map((a) => a.i)).toEqual([4, 4]);
      expect(asked.map((a) => a.variant).sort()).toEqual([...CARD_VARIANTS].sort());
      expect(el('modal').textContent).toContain('05번 카드 후보');
      document.querySelector<HTMLButtonElement>('#modal [data-pick="1"]')!.click();
      await until(() => el('modal').hidden);
      expect(cur().cards[4].svg).toContain('data-v="1"');
      expect(cur().cards[4].imgSource).toBe('claude');
      expect(cur().cards.filter((c) => c.svg)).toHaveLength(1);
    } finally { hooks.drawCard = null; }
  });

  it('the cover keeps its three compositions; the last card has no candidates', async () => {
    await openFromLibrary(storyWork('D'));
    const asked: (string | undefined)[] = [];
    hooks.drawCard = async (_w, i, variant) => { asked.push(variant); expect(i).toBe(0); return { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }; };
    try {
      expect(row(19).querySelector('[data-act="cands"]')).toBeNull();
      const btn = row(0).querySelector<HTMLButtonElement>('[data-act="cands"]')!;
      expect(btn.textContent).toBe('후보 3장');
      btn.click();
      await until(() => pickable() === 3);
      expect(asked.sort()).toEqual([...COVER_VARIANTS].sort());
      expect(el('modal').textContent).toContain('표지 후보');
      document.querySelector<HTMLButtonElement>('#modal [data-a="close"]')!.click();
      await until(() => el('modal').hidden);
      expect(cur().cards[0].svg).toBeUndefined();
    } finally { hooks.drawCard = null; }
  });
});

describe('pictures from the Gemini app', () => {
  const png = (name = 'x.png', lastModified = 1) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png', lastModified });
  const pasteImage = (target: EventTarget = document.body) => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files: [png()], items: [], types: ['Files'], getData: () => '' } });
    target.dispatchEvent(e);
    return e;
  };
  const selectCard = (i: number) => row(i).querySelector<HTMLElement>('.num span')!.click();
  const closeModal = async () => { document.querySelector<HTMLButtonElement>('#modal [data-a="close"]')?.click(); await until(() => el('modal').hidden); };

  it('a picture pasted on the cards step goes onto the selected card; a paste into a text field stays the writer\'s', async () => {
    await openFromLibrary(storyWork('P'));
    document.querySelector<HTMLButtonElement>('#stepNav [data-tab="cards"]')!.click();
    selectCard(5);
    (document.activeElement as HTMLElement | null)?.blur();
    const e = pasteImage();
    expect(e.defaultPrevented).toBe(true);
    await until(() => !!cur().cards[5].img);
    expect(cur().cards[5].imgSource).toBe('upload');
    const ta = row(6).querySelector<HTMLTextAreaElement>('textarea[data-f="text"]')!;
    ta.focus();
    expect(pasteImage(ta).defaultPrevented).toBe(false);
    await sleep(150);
    expect(cur().cards[6].img).toBeUndefined();
  });

  it('a picture pasted over another can be put back from the notice', async () => {
    const w = storyWork('Q');
    w.cards[7].svg = '<svg xmlns="http://www.w3.org/2000/svg" data-old="1"/>';
    w.cards[7].imgSource = 'claude';
    await openFromLibrary(w);
    document.querySelector<HTMLButtonElement>('#stepNav [data-tab="cards"]')!.click();
    selectCard(7);
    (document.activeElement as HTMLElement | null)?.blur();
    pasteImage();
    await until(() => !!cur().cards[7].img);
    const undoBtn = await (async () => { await until(() => !!Array.from(document.querySelectorAll('#toast button, .toast button')).find((b) => b.textContent === '되돌리기')); return Array.from(document.querySelectorAll<HTMLButtonElement>('#toast button, .toast button')).find((b) => b.textContent === '되돌리기')!; })();
    undoBtn.click();
    await until(() => !cur().cards[7].img);
    expect(cur().cards[7].svg).toContain('data-old');
    expect(cur().cards[7].imgSource).toBe('claude');
  });

  it('in the helper, a paste goes onto the ▶ card as 「Gemini 앱」, then ▶ moves on to the next card without a picture', async () => {
    const w = storyWork('G');
    w.cards[4].svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    await openFromLibrary(w);
    el('btnGeminiApp').click();
    await until(() => !el('modal').hidden && !!document.querySelector('#modal .gx-row'));
    try {
      expect(document.querySelectorAll('#modal .gx-row')).toHaveLength(19); // every card but the last
      // the first message asks Gemini for the reference picture first: the first paste goes there
      expect(document.querySelector('#modal #gxRefLine.target')).not.toBeNull();
      expect(document.querySelector('#modal .gx-row.target')).toBeNull();
      pasteImage();
      await until(() => !!cur().style.refImage);
      await until(() => document.querySelector('#modal .gx-row.target')?.getAttribute('data-i') === '0');
      expect(cur().cards[0].img).toBeUndefined();
      document.querySelector<HTMLButtonElement>('#modal [data-copy="3"]')!.click();
      await until(() => document.querySelector('#modal .gx-row.target')?.getAttribute('data-i') === '3');
      pasteImage();
      await until(() => !!cur().cards[3].img);
      expect(cur().cards[3].imgSource).toBe('gemini-app');
      // card 5 (index 4) already has a picture: skipped
      await until(() => document.querySelector('#modal .gx-row.target')?.getAttribute('data-i') === '5');
      expect(cur().cards[4].svg).toBeTruthy();
    } finally { await closeModal(); }
  });

  it('when every card has a picture, a paste waits until the writer picks a card (nothing is replaced unasked)', async () => {
    const w = storyWork('F');
    w.cards.forEach((c, i) => { c.svg = `<svg xmlns="http://www.w3.org/2000/svg" data-i="${i}"/>`; });
    await openFromLibrary(w);
    el('btnGeminiApp').click();
    await until(() => !!document.querySelector('#modal .gx-row'));
    try {
      expect(document.querySelector('#modal .gx-row.target')).toBeNull();
      expect(pasteImage().defaultPrevented).toBe(true);
      await sleep(150);
      expect(cur().cards.every((c) => !c.img)).toBe(true);
      expect(el('gxStatus').textContent).toContain('카드를 먼저 골라');
    } finally { await closeModal(); }
  });

  it('pictures uploaded together go, in the order they were made, onto the cards without one, after the order check', async () => {
    const w = storyWork('U');
    w.cards[1].svg = '<svg xmlns="http://www.w3.org/2000/svg" data-keep="1"/>';
    await openFromLibrary(w);
    el('btnGeminiApp').click();
    await until(() => !!document.querySelector('#modal #gxFiles'));
    try {
      const input = document.querySelector<HTMLInputElement>('#modal #gxFiles')!;
      Object.defineProperty(input, 'files', { value: [png('c.png', 30), png('a.png', 10), png('b.png', 20)], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => document.querySelectorAll('#modal .gx-review select').length === 3);
      // previews straight from the files: no full-size copies held while the writer checks the order
      expect(Array.from(document.querySelectorAll<HTMLImageElement>('#modal .gx-review img')).every((im) => im.getAttribute('src')!.startsWith('blob:'))).toBe(true);
      const picks = Array.from(document.querySelectorAll<HTMLSelectElement>('#modal .gx-review select')).map((s) => s.value);
      expect(picks).toEqual(['0', '2', '3']); // a, b, c onto 01, 03, 04 (02 has a picture)
      // the writer moves the last one to card 06
      const last = document.querySelectorAll<HTMLSelectElement>('#modal .gx-review select')[2];
      last.value = '5';
      last.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector<HTMLButtonElement>('#modal [data-a="apply"]')!.click();
      await until(() => !!cur().cards[5].img && !!cur().cards[2].img && !!cur().cards[0].img);
      expect(cur().cards[3].img).toBeUndefined();
      expect(cur().cards[1].svg).toContain('data-keep');
      expect(cur().cards[1].img).toBeUndefined();
      expect([0, 2, 5].map((i) => cur().cards[i].imgSource)).toEqual(['gemini-app', 'gemini-app', 'gemini-app']);
    } finally { await closeModal(); }
  });
});

describe('연출 정리 and what the writer wrote', () => {
  const directAnswer = (n = 19) => ({ characters: 'Minho: a Korean man in his 40s, navy uniform.', scenes: Array.from({ length: n }, (_, i) => ({ card: i + 1, scene: `Directed ${i + 1}` })) });

  it('a scene typed in 디자인 is marked as the writer\'s', async () => {
    await openFromLibrary(storyWork('S'));
    row(4).querySelector<HTMLButtonElement>('[data-act="design"]')!.click();
    await until(() => !!row(4).querySelector('textarea[data-f="scene"]'));
    const ta = row(4).querySelector<HTMLTextAreaElement>('textarea[data-f="scene"]')!;
    ta.value = 'Minsu holds a red umbrella at the bus stop.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cur().cards[4].scene).toBe('Minsu holds a red umbrella at the bus stop.');
    expect(cur().cards[4].sceneByWriter).toBe(true);
  });

  it('changing the art style keeps the writer\'s characters theirs, and direction done', async () => {
    await openFromLibrary(storyWork('T'));
    const chars = el<HTMLTextAreaElement>('styleChars');
    chars.value = 'Minho: 내가 정한 생김새';
    chars.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = el<HTMLSelectElement>('stylePreset');
    sel.value = Array.from(sel.options).map((o) => o.value).find((v) => v && v !== cur().style.preset)!;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(cur().style.characters).toBe('Minho: 내가 정한 생김새');
    expect(cur().style.charactersByWriter).toBe(true);
    expect(cur().style.directedFor).toBe(textSig(cur()));
  });

  it('a result that comes back after the same work was opened again goes onto the open copy, keeping what was typed meanwhile', async () => {
    const A = await openFromLibrary(storyWork('V'));
    const g = gate();
    hooks.generateJSON = async (req) => { if (req.tag !== 'direct') throw new AiError('empty'); await g.wait; return directAnswer(); };
    try {
      el<HTMLButtonElement>('btnDirect').click();
      await sleep(50);
      await openFromLibrary(storyWork('W')); // another work, then the first one again: a new copy of it
      await sleep(1200);
      await openFromLibrary((await store.works.get(A.id))!);
      type(2, '그사이에 고친 글. 지수는 결국 계단으로 내려갔다.');
      g.open();
      await until(() => cur().cards[5].scene === 'Directed 6');
      expect(cur().id).toBe(A.id);
      expect(cur().cards[2].text).toBe('그사이에 고친 글. 지수는 결국 계단으로 내려갔다.');
      expect(cur().style.characters).toContain('navy uniform');
      await sleep(1800); // the autosave
      const stored = (await store.works.get(A.id))!;
      expect(stored.cards[2].text).toBe('그사이에 고친 글. 지수는 결국 계단으로 내려갔다.');
      expect(stored.cards[5].scene).toBe('Directed 6');
    } finally { hooks.generateJSON = null; }
  });

  it('a result that comes back after another work was opened goes into the stored copy of its own work', async () => {
    const A = await openFromLibrary(storyWork('X'));
    const g = gate();
    hooks.generateJSON = async (req) => { if (req.tag !== 'direct') throw new AiError('empty'); await g.wait; return directAnswer(); };
    try {
      el<HTMLButtonElement>('btnDirect').click();
      await sleep(50);
      const B = await openFromLibrary(storyWork('Y'));
      g.open();
      const t0 = Date.now();
      let stored = (await store.works.get(A.id))!;
      while (stored.cards[5].scene !== 'Directed 6' && Date.now() - t0 < 5000) { await sleep(30); stored = (await store.works.get(A.id))!; }
      expect(stored.cards[5].scene).toBe('Directed 6');
      expect(stored.style.characters).toContain('navy uniform');
      expect(stored.style.directedFor).toBe(textSig(stored));
      expect(cur().id).toBe(B.id);
      expect(cur().cards[5].scene).toBe('Scene 6');
    } finally { hooks.generateJSON = null; }
  });

  it('모든 그림 그리기 after the words changed directs once, then draws; a failed direction still draws', async () => {
    for (const fail of [false, true]) {
      const w = storyWork(fail ? 'Z1' : 'Z0');
      delete w.style.directedFor;
      await openFromLibrary(w);
      const tags: string[] = [];
      hooks.generateJSON = async (req) => { tags.push(req.tag ?? ''); if (fail) throw new AiError('rate_limited'); return directAnswer(); };
      const drawn: string[] = [];
      hooks.drawCard = async (wk, i) => { drawn.push(wk.cards[i].scene); return { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }; };
      try {
        el<HTMLButtonElement>('btnArtAll').click();
        await until(() => drawn.length === 19 && !drawing(), 15000);
        expect(tags.filter((t) => t === 'direct')).toHaveLength(1);
        expect(drawn.every((sc) => sc.startsWith(fail ? 'Scene' : 'Directed'))).toBe(true);
      } finally { hooks.generateJSON = null; hooks.drawCard = null; }
    }
  });
});

describe('그리기 on one card while it is moved', () => {
  it('the new scene and the picture go to that card, drawn from its own words', async () => {
    const w = storyWork('S');
    w.cards[5].scene = ''; // card 6 needs a new scene before it is drawn
    await openFromLibrary(w);
    const five = cur().cards[4], six = cur().cards[5];
    const drawn: { text: string; scene: string }[] = [];
    hooks.generateJSON = async (req) => {
      if (req.tag !== 'scene') throw new AiError('upstream');
      await sleep(150);
      return { scenes: [{ card: 6, scene: 'Elevator doors open on a dark floor.' }] };
    };
    hooks.drawCard = async (wk, i) => { drawn.push({ text: wk.cards[i].text, scene: wk.cards[i].scene }); return { svg: '<svg xmlns="http://www.w3.org/2000/svg" data-six="1"/>' }; };
    try {
      row(5).querySelector<HTMLButtonElement>('button[data-act="ai"]')!.click();
      await sleep(40);
      row(5).querySelector<HTMLButtonElement>('button[data-act="up"]')!.click(); // ▲ while the scene is being written
      expect(cur().cards[4]).toBe(six);
      await until(() => drawn.length === 1 && !row(4).querySelector('.pic.busy'));
      expect(drawn[0]).toEqual({ text: six.text, scene: 'Elevator doors open on a dark floor.' });
      expect(six.scene).toBe('Elevator doors open on a dark floor.');
      expect(six.svg).toContain('data-six');
      expect(five.scene).toBe('Scene 5');
      expect(five.svg).toBeUndefined();
    } finally { hooks.generateJSON = null; hooks.drawCard = null; }
  });
});

describe('카드로 만들기 while the writer keeps working', () => {
  const answer = () => ({
    title: 'AI 제목', hook: 'AI 훅',
    cards: Array.from({ length: 18 }, (_, i) => ({ text: `AI가 쓴 본문 ${i + 1}. 지수는 엘리베이터 버튼을 다시 눌렀다.`, scene: `AI scene ${i + 1}` })),
    outro: '다음 화에서 만나요', caption: 'AI 캡션', hashtags: ['미스터리'], summary: 'AI 요약',
  });
  const startCompose = async (story: string) => {
    const ta = el<HTMLTextAreaElement>('story');
    ta.value = story;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    el<HTMLButtonElement>('btnCompose').click();
    await until(() => el<HTMLButtonElement>('btnCompose').disabled);
  };
  const composing = () => el<HTMLButtonElement>('btnCompose').disabled;

  it('keeps a theme and handle changed while the AI writes', async () => {
    await openFromLibrary(storyWork('C'));
    const g = gate();
    hooks.generateJSON = async (req) => { await g.wait; if (req.tag === 'compose') return answer(); throw new AiError('upstream'); };
    try {
      await startCompose('어느 밤, 지수는 낡은 엘리베이터에 갇혔다. 13층 버튼이 혼자 켜졌다.');
      const theme = [...document.querySelectorAll<HTMLButtonElement>('#themes button[data-k]')].find((b) => b.dataset.k !== cur().theme)!;
      theme.click();
      const handle = el<HTMLInputElement>('handle');
      handle.value = '@changed.while.waiting';
      handle.dispatchEvent(new Event('input', { bubbles: true }));
      g.open();
      await until(() => !composing());
      expect(cur().theme).toBe(theme.dataset.k);
      expect(cur().handle).toBe('@changed.while.waiting');
      expect(cur().cards[1].text).toContain('AI가 쓴 본문 1');
      expect(cur().caption).toBe('AI 캡션');
      expect(cur().hashtags).toEqual(['#미스터리']);
      expect(cur().summary).toBe('AI 요약');
    } finally { hooks.generateJSON = null; }
  });

  it('a work opened meanwhile stays open, and the cards go to the work they were made for', async () => {
    const A = await openFromLibrary(storyWork('D'));
    const g = gate();
    hooks.generateJSON = async (req) => { await g.wait; if (req.tag === 'compose') return answer(); throw new AiError('upstream'); };
    try {
      await startCompose('어느 밤, 지수는 낡은 엘리베이터에 갇혔다. 13층 버튼이 혼자 켜졌다.');
      const B = await openFromLibrary(storyWork('E'));
      const ta = el<HTMLTextAreaElement>('story');
      ta.value = '새 작품에 쓰기 시작한 줄거리';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      g.open();
      await until(() => !composing());
      expect(cur().id).toBe(B.id);
      expect(cur().source.text).toBe('새 작품에 쓰기 시작한 줄거리');
      expect(cur().cards[1].text).toContain('E 2번째');
      const a = (await store.works.get(A.id))!;
      expect(a.cards[1].text).toContain('AI가 쓴 본문 1');
      expect(a.cards[0].title).toBe('AI 제목');
      await sleep(2000); // autosave
      expect((await store.works.get(B.id))!.source.text).toBe('새 작품에 쓰기 시작한 줄거리');
    } finally { hooks.generateJSON = null; }
  });

  it('a failed run takes back only its own undo step, not one made in the work opened meanwhile', async () => {
    await openFromLibrary(storyWork('F'));
    const g = gate();
    hooks.generateJSON = async () => { await g.wait; throw new AiError('upstream'); };
    try {
      await startCompose('어느 밤, 지수는 낡은 엘리베이터에 갇혔다. 13층 버튼이 혼자 켜졌다.');
      await openFromLibrary(storyWork('G'));
      row(1).querySelector<HTMLButtonElement>('button[data-act="down"]')!.click(); // an undo step in the new work
      expect(el<HTMLButtonElement>('btnUndo').disabled).toBe(false);
      g.open();
      await until(() => !composing());
      expect(el<HTMLButtonElement>('btnUndo').disabled).toBe(false);
    } finally { hooks.generateJSON = null; }
  });
});

describe('undo', () => {
  it('a notice\'s 되돌리기 only undoes its own change, also when 20 steps are kept', async () => {
    await openFromLibrary(storyWork('U'));
    // 20 earlier steps: ▼ and ▲ on card 2
    for (let k = 0; k < 20; k++) row(k % 2 ? 2 : 1).querySelector<HTMLButtonElement>(`button[data-act="${k % 2 ? 'up' : 'down'}"]`)!.click();
    const before = cur().cards.map((c) => c.id);
    const thumbs = el('thumbs').children;
    thumbs[2].dispatchEvent(new Event('dragstart', { bubbles: true }));
    thumbs[7].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    expect(cur().cards[7].id).toBe(before[2]);
    await sleep(1600); // the earlier typing burst has ended
    type(9, '방금 쓴 문장');
    document.querySelector<HTMLButtonElement>('#toast button')!.click();
    expect(cur().cards[9].text).toBe('방금 쓴 문장');
    expect(cur().cards[7].id).toBe(before[2]);
    expect(el('toast').textContent).toContain('그 뒤에 다른 변경이 있어요');
  });

  it('after importing a file, Ctrl+Z does not apply the previous work\'s steps (which would empty it)', async () => {
    await openFromLibrary(storyWork('H'));
    await sleep(1600);
    type(3, '이전 작품에서 고친 글');
    expect(el<HTMLButtonElement>('btnUndo').disabled).toBe(false);
    const w = storyWork('I');
    w.id = 'imported1';
    // it was deleted once and is still in the trash
    await library.moveToTrash(w);
    const file = new File([JSON.stringify({ app: 'cardnovel', version: 1, work: w })], 'a.cardnovel.json', { type: 'application/json' });
    const input = el<HTMLInputElement>('libFile');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await until(() => cur().id === 'imported1');
    await until(() => el('toast').textContent!.includes('가져왔어요'));
    expect(el<HTMLButtonElement>('btnUndo').disabled).toBe(true);
    ctrlZ();
    expect(cur().cards).toHaveLength(20);
    await sleep(1200);
    expect((await store.works.get('imported1'))!.cards).toHaveLength(20);
    expect((await store.works.get('imported1'))!.cards[1].text).toContain('I 2번째');
    // live again: no longer in the trash
    expect((await library.listTrash()).some((e) => e.id === 'imported1')).toBe(false);
  });

  it('a step that does not match the open work\'s cards is dropped instead of emptying the work', async () => {
    await openFromLibrary(storyWork('J'));
    row(1).querySelector<HTMLButtonElement>('button[data-act="down"]')!.click();
    cur().cards[5].id = 'replaced-elsewhere';
    ctrlZ();
    expect(cur().cards).toHaveLength(20);
    expect(el<HTMLButtonElement>('btnUndo').disabled).toBe(true);
  });
});

describe('the trash and a work that is live again', () => {
  const openTrash = async () => {
    el('btnLibrary').click();
    await until(() => !!document.querySelector('[data-a="trash"]'));
    document.querySelector<HTMLButtonElement>('[data-a="trash"]')!.click();
    await until(() => !!document.querySelector('.trash-head'));
  };
  const closeModal = async () => { document.querySelector<HTMLButtonElement>('#modalBox [data-a="close"]')?.click(); await until(() => el('modal').hidden, 2000); };

  it('emptying the trash keeps the versions of a work with the same id that was loaded back', async () => {
    const x = storyWork('X');
    await library.moveToTrash(x);
    // loaded back from Drive (or a file) without going through the trash, and worked on
    await store.works.put(x);
    await versions.saveVersion(x, 'manual');
    expect(await versions.listVersions(x.id)).toHaveLength(1);
    await openTrash();
    try {
      document.querySelector<HTMLButtonElement>('[data-a="emptyTrash"]')!.click();
      await until(() => el('toast').textContent!.includes('휴지통을 비웠어요'));
      await sleep(100);
      expect(await versions.listVersions(x.id)).toHaveLength(1);
      expect(await store.works.get(x.id)).toBeTruthy();
    } finally { await closeModal(); }
  });

  it('되살리기 over a live copy keeps that copy in the version history', async () => {
    const y = storyWork('Y');
    y.cards[1].text = 'old';
    await library.moveToTrash(y);
    const live = JSON.parse(JSON.stringify(y)) as Work;
    live.cards[1].text = 'new';
    await store.works.put(live);
    await openTrash();
    try {
      document.querySelector<HTMLButtonElement>(`[data-tid="${y.id}"] [data-a="restore"]`)!.click();
      await until(() => el('toast').textContent!.includes('되살렸어요'));
      const kept = (await versions.listVersions(y.id)).filter((v) => v.reason === 'restore');
      expect(kept).toHaveLength(1);
      expect((await versions.loadVersion(kept[0].id))!.cards[1].text).toBe('new');
      expect((await store.works.get(y.id))!.cards[1].text).toBe('old');
    } finally { await closeModal(); }
  });

  it('opening a work drops its stale trash entry', async () => {
    const z = storyWork('Z');
    await library.moveToTrash(z);
    await openFromLibrary(z); // as a Drive restore does: put back, then opened
    await sleep(100);
    expect((await library.listTrash()).some((e) => e.id === z.id)).toBe(false);
  });
});

declare global { interface Window { __cardnovel?: { work: () => Work } } }
