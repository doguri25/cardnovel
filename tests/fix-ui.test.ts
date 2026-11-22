import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// share links render each card to a JPEG; in jsdom there is no canvas, so a stand-in blob is used
vi.mock('../src/export', async (orig) => ({
  ...(await orig<typeof import('../src/export')>()),
  renderToBlob: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })),
}));

import type { App } from '../src/app';
import { keepMarks } from '../src/ai/proof';
import { generateSpeech, generateText } from '../src/ai/providers';
import { normalizeReview } from '../src/ai/review';
import { busy, isBusy } from '../src/busy';
import { shareCards, zipAll } from '../src/export';
import { DEFAULTS, newWork, normalizeWork, textSig, type Review, type Work } from '../src/model';
import { createShare } from '../src/share';
import { $, openModal } from '../src/ui/dom';
import { wireProof } from '../src/ui/proof';
import { renderReview, wireReview } from '../src/ui/review';
import { newVersionReady, watchForUpdates } from '../src/ui/update';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const sample = (): Work => {
  const w = newWork(DEFAULTS);
  w.cards[0].title = '막차';
  w.cards[0].text = '아무도 내리지 않았다';
  w.cards.forEach((c, i) => { if (c.kind === 'body') c.text = `${String(i + 1).padStart(2, '0')}번 카드의 원래 문장이다.`; });
  return w;
};

function fakeApp(w: Work, more: Partial<App> = {}): App {
  return {
    work: () => w, current: () => 0, online: () => true, textAI: () => null,
    save: vi.fn(), flush: vi.fn(async () => undefined), pushUndo: vi.fn(), refreshRow: vi.fn(), showCard: vi.fn(), scheduleRender: vi.fn(),
    undoToast: vi.fn(), goCard: vi.fn(), openSettings: vi.fn(), keepVersion: vi.fn(async () => undefined),
    ...more,
  } as unknown as App;
}

const reviewDom = () => { document.body.innerHTML = '<button id="btnReview"></button><div id="reviewStatus"></div><div id="reviewBody"></div>'; };
const scores = { hook: 12, flow: 13, consistency: 14, turn: 11, ending: 10 };

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('#4 a review suggestion follows its card when cards are moved', () => {
  it('keeps the card id with each note', () => {
    const w = sample();
    const r = normalizeReview({ scores, notes: [{ card: 7, verdict: 'fix', issue: '늘어져요', suggestion: '새 문장이에요.' }] }, w);
    expect(r.notes[0]).toMatchObject({ index: 6, cardId: w.cards[6].id });
  });

  it('after moving card 07 to slot 03, the suggestion goes to that card, not to whatever sits in slot 07 now', () => {
    const w = sample();
    w.review = normalizeReview({ scores, notes: [{ card: 7, verdict: 'fix', issue: '늘어져요', suggestion: '새 문장이에요.' }] }, w);
    const reviewed = w.cards[6], other = w.cards[5];
    const otherText = other.text;
    // what moveCard does
    const [c] = w.cards.splice(6, 1);
    w.cards.splice(2, 0, c);
    reviewDom();
    const app = fakeApp(w);
    wireReview(app);
    renderReview(app);
    const body = $('reviewBody');
    expect(body.querySelector('.badge')!.textContent).toContain('03');
    expect(body.querySelector<HTMLElement>('[data-go]')!.dataset.go).toBe('2');
    body.querySelector<HTMLButtonElement>('[data-apply="0"]')!.click();
    expect(reviewed.text).toBe('새 문장이에요.');
    expect(w.cards[2]).toBe(reviewed);
    expect(other.text).toBe(otherText);
    expect(app.refreshRow).toHaveBeenCalledWith(2);
  });

  it('a review saved without card ids is applied by position only while the cards are as reviewed', () => {
    const w = sample();
    const r = normalizeReview({ scores, notes: [{ card: 7, verdict: 'fix', issue: '늘어져요', suggestion: '새 문장이에요.' }] }, w);
    const old: Review = { ...r, notes: r.notes.map(({ cardId: _drop, ...n }) => n) };
    // unchanged order: normalizeWork can tell which card each note is about
    const loaded = normalizeWork({ ...w, review: old }, DEFAULTS);
    expect(loaded.review!.notes[0].cardId).toBe(loaded.cards[6].id);
    // moved after the review: no way to know, so the one-click rewrite is off
    const moved = sample();
    moved.review = old;
    const [c] = moved.cards.splice(6, 1);
    moved.cards.splice(2, 0, c);
    expect(textSig(moved)).not.toBe(old.sig);
    const before = moved.cards.map((x) => x.text);
    reviewDom();
    const app = fakeApp(moved);
    wireReview(app);
    renderReview(app);
    const btn = $('reviewBody').querySelector<HTMLButtonElement>('[data-apply="0"]')!;
    expect(btn.disabled).toBe(true);
    btn.disabled = false;
    btn.click();
    expect(moved.cards.map((x) => x.text)).toEqual(before);
  });
});

describe('#20 a review from an imported file cannot carry markup', () => {
  const bad = '<img src=x onerror="window.__pwned=1">';
  const file = () => ({
    ...sample(),
    review: {
      at: 1, sig: 'x',
      scores: { hook: bad, flow: '15', consistency: 99, turn: -3, ending: null },
      summary: '총평', strengths: 'not a list',
      notes: [
        { index: `0" onclick="alert(1)`, verdict: 'fix', issue: '가', suggestion: '나' },
        { index: 3, verdict: `fix"><img src=x onerror=alert(1)>`, issue: '다', suggestion: '라' },
        { index: 19, verdict: 'cut', issue: '마지막 장', suggestion: '' },
        'junk',
      ],
      titles: [{ title: '제목', hook: 5, why: null }, { title: 7 }],
      history: bad,
    },
  });

  it('normalizeWork keeps only numbers, known words and strings', () => {
    const w = normalizeWork(file() as never, DEFAULTS);
    const r = w.review!;
    expect(r.scores).toEqual({ hook: 0, flow: 15, consistency: 20, turn: 0, ending: 0 });
    expect(r.strengths).toEqual([]);
    expect(r.notes).toEqual([{ index: 3, verdict: 'fix', issue: '다', suggestion: '라' }]);
    expect(r.titles).toEqual([{ title: '제목', hook: '', why: '' }]);
    expect(r.history).toBeUndefined();
    expect(r.at).toBe(1);
    expect(r.sig).toBe('x');
    expect(normalizeWork({ ...sample(), review: 'junk' } as never, DEFAULTS).review).toBeUndefined();
    expect(normalizeWork({ ...sample(), review: [1, 2] } as never, DEFAULTS).review).toBeUndefined();
  });

  it('the cleaned review renders as text', () => {
    const w = normalizeWork(file() as never, DEFAULTS);
    reviewDom();
    renderReview(fakeApp(w));
    const body = $('reviewBody');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('[onclick], [onerror]')).toBeNull();
    expect(body.querySelector('.total')!.textContent).toBe('35/100');
  });

  it('renderReview does not trust the stored values either', () => {
    const w = sample();
    w.review = file().review as unknown as Review;
    w.review.strengths = [];
    w.review.titles = [];
    reviewDom();
    renderReview(fakeApp(w));
    const body = $('reviewBody');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('[onclick], [onerror]')).toBeNull();
    expect(body.querySelector('.hint')!.textContent).not.toContain('onerror');
  });
});

describe('#6 a dropped *emphasis* mark goes back on the word the writer marked', () => {
  it('uses the marked place, not an earlier copy of the same word', () => {
    expect(keepMarks('문을 열자 또 *문*이 있었다', '문을 열자 또 문이 있었다.')).toEqual({ text: '문을 열자 또 *문*이 있었다.', lost: false });
    expect(keepMarks('*문*을 열자 또 문이 있었다', '문을 열자 또 문이 있었다.')).toEqual({ text: '*문*을 열자 또 문이 있었다.', lost: false });
    expect(keepMarks('눈을 감았다. *눈*이 내렸다. *눈*물이 났다', '눈을 감았다. 눈이 내렸다. 눈물이 났다.')).toEqual({ text: '눈을 감았다. *눈*이 내렸다. *눈*물이 났다.', lost: false });
  });
  it('still follows the words when spacing around them changed', () => {
    expect(keepMarks('그는 문앞에서 *문*을 두드렸다', '그는 문 앞에서 문을 두드렸다.')).toEqual({ text: '그는 문 앞에서 *문*을 두드렸다.', lost: false });
  });
  it('says so when it cannot tell which copy was meant', () => {
    expect(keepMarks('문 Q*문*', '문 RR문').lost).toBe(true);
  });
  it('keeps the earlier behaviour', () => {
    expect(keepMarks('마지막 *버스* 안', '마지막 버스 안에')).toEqual({ text: '마지막 *버스* 안에', lost: false });
    expect(keepMarks('*할수* 없다', '할 수 없다')).toEqual({ text: '할 수 없다', lost: true });
    expect(keepMarks('표시 없음', '표시없음')).toEqual({ text: '표시없음', lost: false });
    expect(keepMarks('*가* 나 *다*', '*가* 나 다.')).toEqual({ text: '*가* 나 *다*.', lost: false });
  });
});

describe('#8 an OpenAI key without credit is not retried', () => {
  const quota = () => reply({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }, 429);
  it('text: one request, rate_limited', async () => {
    const fetchMock = vi.fn(async () => quota());
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateText({ provider: 'openai', key: 'k', model: 'gpt-x', system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('speech: one request, rate_limited', async () => {
    const fetchMock = vi.fn(async () => quota());
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateSpeech({ provider: 'openai', key: 'k', model: 'gpt-4o-mini-tts', voice: 'alloy', text: '안녕' })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('a plain rate limit is still retried', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => (++n === 1
      ? new Response(JSON.stringify({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': '0.01' } })
      : reply({ choices: [{ message: { content: '좋아요' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      const p = generateText({ provider: 'openai', key: 'k', model: 'gpt-x', system: 's', prompt: 'p' });
      await vi.runAllTimersAsync();
      expect(await p).toBe('좋아요');
    } finally { vi.useRealTimers(); }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('#23 a dialog closes only when the press started on the backdrop', () => {
  beforeEach(() => { document.body.innerHTML = '<div class="modal" id="modal" hidden><div class="box" id="modalBox"></div></div>'; });
  const press = (down: Element, up: Element) => {
    down.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    down.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    up.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // the browser sends the click to the nearest element holding both ends
    const common = down === up || down.contains(up) ? down : up.contains(down) ? up : $('modal');
    common.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  it('selecting text in an input and letting go over the backdrop keeps it open', () => {
    const onClose = vi.fn();
    openModal('<input id="t" value="이름">', { onClose });
    press($('t'), $('modal'));
    expect($('modal').hidden).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
  it('a click on the backdrop still closes it', () => {
    const onClose = vi.fn();
    openModal('<input id="t" value="이름">', { onClose });
    press($('modal'), $('modal'));
    expect($('modal').hidden).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('a press on the backdrop for an earlier dialog does not count for the next one', () => {
    openModal('<p>하나</p>');
    $('modal').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    const onClose = vi.fn();
    openModal('<input id="t">', { onClose });
    $('modal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('#24 the background update waits for long jobs', () => {
  let hidden = false;
  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: Object.assign(new EventTarget(), { controller: {} }) });
  });
  afterEach(() => {
    delete (document as { hidden?: boolean }).hidden;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
  const hide = () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); };
  const show = () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); };

  it('does not switch while something is busy, and switches at the next chance once it is done', async () => {
    // flush is the first step of switching; it never settles here, so jsdom is not asked to reload
    const app = fakeApp(sample(), { flush: vi.fn(() => new Promise<void>(() => undefined)) });
    watchForUpdates(app, { update: async () => undefined } as unknown as ServiceWorkerRegistration, () => true);
    newVersionReady(app);
    let finish!: () => void;
    const job = busy(() => new Promise<void>((r) => { finish = r; }));
    expect(isBusy()).toBe(true);
    hide();
    expect(app.flush).not.toHaveBeenCalled();
    finish();
    await job;
    expect(isBusy()).toBe(false);
    show();
    hide();
    expect(app.flush).toHaveBeenCalled();
  });

  it('an AI review counts as busy while it runs', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    const w = sample();
    reviewDom();
    const app = fakeApp(w, { textAI: () => ({ provider: 'openai', key: 'k', model: 'gpt-x' }) });
    wireReview(app);
    $('btnReview').click();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(isBusy()).toBe(true);
    answer(reply({ error: { message: 'bad' } }, 400));
    await vi.waitFor(() => expect(isBusy()).toBe(false));
  });

  it('proofreading counts as busy while it runs', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    const w = sample();
    document.body.innerHTML = '<button id="btnProof"></button><select id="proofTone"><option value="keep" selected>keep</option></select><div id="proofStatus"></div><div id="proofBody"></div>';
    const app = fakeApp(w, { textAI: () => ({ provider: 'openai', key: 'k', model: 'gpt-x' }) });
    wireProof(app);
    $('btnProof').click();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(isBusy()).toBe(true);
    answer(reply({ error: { message: 'bad' } }, 400));
    await vi.waitFor(() => expect(isBusy()).toBe(false));
  });

  it('a share link upload, a ZIP and the share sheet count as busy', async () => {
    const pending: ((r: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
      pending.push(res);
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    const share = createShare(sample(), 'key', () => undefined);
    expect(isBusy()).toBe(true);
    await vi.waitFor(() => expect(pending.length).toBe(3));
    pending[0](reply({ error: 'upstream' }, 500));
    await share.catch(() => undefined);
    expect(isBusy()).toBe(false);

    const zip = zipAll(sample(), 'jpg');
    expect(isBusy()).toBe(true);
    await zip.catch(() => undefined); // no canvas in jsdom
    expect(isBusy()).toBe(false);

    let shared!: () => void;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: () => new Promise<void>((r) => { shared = r; }) });
    try {
      const sheet = shareCards([new File(['x'], 'a.jpg')], '캡션');
      expect(isBusy()).toBe(true);
      shared();
      expect(await sheet).toBe('shared');
      expect(isBusy()).toBe(false);
    } finally {
      delete (navigator as { canShare?: unknown }).canShare;
      delete (navigator as { share?: unknown }).share;
    }
  });
});

describe('#25 a failed share upload stops the other uploads', () => {
  const url = (u: unknown) => String(u);
  it('stops at the first failure, reports it, and removes what was uploaded', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string, init: RequestInit) => {
      calls.push(url(u));
      if (u.includes('delete')) return Promise.resolve(reply({ deleted: 1 }));
      if (u.includes('n=2&') || u.endsWith('n=2')) return Promise.resolve(reply({ error: 'too_large' }, 413));
      return new Promise<Response>((res, rej) => {
        const t = setTimeout(() => res(reply({ url: `https://blob.example/${calls.length}.jpg` })), 5);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); });
      });
    }));
    const progress: number[] = [];
    await expect(createShare(sample(), 'key', (n) => progress.push(n))).rejects.toMatchObject({ code: 'too_large' });
    const after = progress.length;
    await tick(60);
    const uploads = calls.filter((c) => c.includes('upload'));
    expect(uploads.length).toBeLessThanOrEqual(3);
    expect(progress.length).toBe(after);
    const del = calls.filter((c) => c.includes('delete'));
    expect(del).toHaveLength(1);
  });

  it('removes the uploaded pictures when publishing the link fails', async () => {
    const calls: { u: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
      calls.push({ u, body: typeof init.body === 'string' ? init.body : undefined });
      if (u.includes('upload')) return reply({ url: 'https://blob.example/x.jpg' });
      if (u.includes('create')) return reply({ error: 'upstream' }, 500);
      return reply({ deleted: 20 });
    }));
    await expect(createShare(sample(), 'key', () => undefined)).rejects.toMatchObject({ code: 'upstream' });
    await tick();
    const uploadId = new URL(calls.find((c) => c.u.includes('upload'))!.u, 'https://x').searchParams.get('id');
    const del = calls.filter((c) => c.u.includes('delete'));
    expect(del).toHaveLength(1);
    expect(JSON.parse(del[0].body!)).toEqual({ id: uploadId });
  });
});
