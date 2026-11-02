import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCheck, bibleFillPrompt, checkPrompt } from '../src/ai/bible';
import { composePrompt, imagePrompt, seriesBlock } from '../src/ai/prompts';
import { generateJSON, generateText, onUsage, type UsageEvent } from '../src/ai/providers';
import { bibleText, emptyBible, mergeBible } from '../src/bible';
import { captureContext, colorParts, groupBlocks, parseFont, type TextRec } from '../src/canva-finish';
import { countChars, DEFAULTS, newWork, parseMarks, stripMarks } from '../src/model';
import { cardDurations, totalDuration } from '../src/reels';
import { wrapRich } from '../src/render';
import { nextEpisodeWork } from '../src/series';
import { contrast, fontForWork, isLightBg, themeOfWork, type SavedTheme } from '../src/themes';
import { budgetAlert, estimateCost, monthKey, summarize, toCSV, type UsageRecord } from '../src/usage';

const fakeCtx = () => ({ measureText: (s: string) => ({ width: [...s].length * 10 }) }) as unknown as CanvasRenderingContext2D;
afterEach(() => { vi.unstubAllGlobals(); onUsage(null); });

describe('emphasis markers', () => {
  it('strips *markers* and flags the marked characters', () => {
    expect(stripMarks('밤 *버스*는 *비어* 있었다')).toBe('밤 버스는 비어 있었다');
    const { plain, flags } = parseMarks('a *bc* d');
    expect(plain).toBe('a bc d');
    expect(flags).toEqual([false, false, true, true, false, false]);
    expect(countChars('*강조* 말')).toBe(3);
    expect(stripMarks('별 * 하나는 그대로')).toBe('별 * 하나는 그대로');
  });
  it('keeps the flags on the right characters after wrapping', () => {
    const lines = wrapRich(fakeCtx(), '하나 둘 *셋 넷* 다섯\n여섯 *일곱*', 60);
    const marked = lines.flatMap((l) => [...l.text].filter((_, i) => l.marks[i]));
    expect(marked.join('')).toBe('셋넷일곱');
    expect(lines.map((l) => l.text).join('|')).not.toContain('*');
    lines.forEach((l) => expect(l.marks).toHaveLength(l.text.length));
  });
});

describe('own themes', () => {
  const t: SavedTheme = { id: 't1', name: '내 테마', bg: ['#ffffff', '#eeeeee'], text: '#111111', accent: '#c00000', font: 'Gowun Batang', deco: 'frame', light: true };
  it('draws a work with its own theme copy and that theme’s font', () => {
    const w = newWork(DEFAULTS);
    w.theme = 'custom'; w.customTheme = t;
    expect(themeOfWork(w).accent).toBe('#c00000');
    expect(fontForWork(w)).toBe('Gowun Batang');
    w.font = 'Noto Sans KR';
    expect(fontForWork(w)).toBe('Noto Sans KR');
    expect(themeOfWork({ theme: 'custom' }).name).toBe('안개'); // no copy: the default theme
  });
  it('measures contrast and lightness', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#888888')).toBeLessThan(1.5);
    expect(isLightBg(['#ffffff', '#f0f0f0'])).toBe(true);
    expect(isLightBg(['#101010', '#000000'])).toBe(false);
  });
  it('carries the theme and watermark into the next episode', () => {
    const w = newWork(DEFAULTS);
    w.theme = 'custom'; w.customTheme = t; w.episode = 1; w.series = 'S';
    w.brand = { kind: 'handle', pos: 'tr', size: 14, opacity: 0.7, scope: 'all' };
    const next = nextEpisodeWork(w, DEFAULTS, 2);
    expect(next.theme).toBe('custom');
    expect(next.customTheme?.accent).toBe('#c00000');
    expect(next.brand).toEqual(w.brand);
    expect(next.brand).not.toBe(w.brand);
  });
});

describe('usage', () => {
  const prices = { prices: { gemini: 0.04, openai: 0.06, claude: 0.03 }, textPrices: { anthropic: { in: 3, out: 15 }, google: { in: 0.3, out: 2.5 }, openai: { in: 1.25, out: 10 } } };
  const ev = (o: Partial<UsageEvent>): UsageEvent => ({ provider: 'anthropic', model: 'm', tag: 'compose', input: 0, output: 0, images: 0, ...o });
  it('prices tokens and pictures', () => {
    expect(estimateCost(ev({ input: 1_000_000, output: 100_000 }), prices)).toBeCloseTo(4.5);
    expect(estimateCost(ev({ provider: 'google', images: 3, tag: 'image' }), prices)).toBeCloseTo(0.12);
  });
  it('sums by job, company and work, and writes CSV', () => {
    const r = (o: Partial<UsageRecord>): UsageRecord => ({ ...ev({}), t: 1, workId: 'w1', cost: 1, ...o });
    const s = summarize([r({ cost: 2 }), r({ tag: 'image', provider: 'google', cost: 0.5, images: 1 }), r({ workId: 'w2', cost: 1 })]);
    expect(s.total).toBeCloseTo(3.5);
    expect(s.images).toBe(1);
    expect(s.byTag[0]).toMatchObject({ key: 'compose', calls: 2 });
    expect(s.byWork.map((x) => x.key)).toEqual(['w1', 'w2']);
    const csv = toCSV([r({ cost: 0.1234 })], { w1: '막차' });
    expect(csv.split('\n')[1]).toContain('"막차"');
    expect(monthKey(Date.UTC(2026, 10, 2, 12))).toBe('2026-11');
  });
  it('warns once at 80% and once at 100% of the budget', async () => {
    expect(await budgetAlert(5, 0, '2099-01')).toBe(0);
    expect(await budgetAlert(5, 10, '2099-01')).toBe(0);
    expect(await budgetAlert(8.5, 10, '2099-01')).toBe(80);
    expect(await budgetAlert(9, 10, '2099-01')).toBe(0);
    expect(await budgetAlert(10.2, 10, '2099-01')).toBe(100);
    expect(await budgetAlert(12, 10, '2099-01')).toBe(0);
  });
  it('reports tokens from every provider response', async () => {
    const seen: UsageEvent[] = [];
    onUsage((u) => seen.push(u));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.includes('anthropic')
        ? { content: [{ type: 'tool_use', input: { ok: 1 } }], usage: { input_tokens: 120, output_tokens: 30 } }
        : url.includes('openai')
          ? { choices: [{ message: { content: '안녕' } }], usage: { prompt_tokens: 50, completion_tokens: 7 } }
          : { candidates: [{ content: { parts: [{ text: '안녕' }] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5, thoughtsTokenCount: 10 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await generateJSON({ provider: 'anthropic', key: 'k', model: 'claude', system: 's', prompt: 'p', schema: {}, tag: 'review' });
    await generateText({ provider: 'openai', key: 'k', model: 'gpt', system: 's', prompt: 'p' });
    await generateText({ provider: 'google', key: 'k', model: 'gemini', system: 's', prompt: 'p', tag: 'rewrite' });
    expect(seen).toEqual([
      { provider: 'anthropic', model: 'claude', tag: 'review', images: 0, input: 120, output: 30 },
      { provider: 'openai', model: 'gpt', tag: 'other', images: 0, input: 50, output: 7 },
      { provider: 'google', model: 'gemini', tag: 'rewrite', images: 0, input: 40, output: 15 },
    ]);
  });
});

describe('cover candidates', () => {
  it('adds the composition idea to the picture request', () => {
    const w = newWork(DEFAULTS);
    w.cards[0].title = '막차';
    expect(imagePrompt(w, 0)).toContain('Cover illustration for the story "막차"');
  });
});

describe('series bible', () => {
  it('merges what the AI found without overwriting the writer', () => {
    const mine = { ...emptyBible('S'), characters: [{ name: '민호', desc: '버스 기사' }], threads: [{ text: '빨간 우산', status: 'open' as const }] };
    const merged = mergeBible(mine, {
      characters: [{ name: '민 호', desc: '다른 설명' }, { name: '지수', desc: '승객' }],
      threads: [{ text: '빨간 우산', status: 'closed' }, { text: '종점 시계', status: 'open', episode: 2 }],
      rules: '막차는 11시 40분\n민호는 20년 차',
    });
    expect(merged.characters).toEqual([{ name: '민호', desc: '버스 기사' }, { name: '지수', desc: '승객' }]);
    expect(merged.threads).toEqual([{ text: '빨간 우산', status: 'closed' }, { text: '종점 시계', status: 'open', episode: 2 }]);
    expect(merged.rules).toBe('막차는 11시 40분\n민호는 20년 차');
    const text = bibleText(merged);
    expect(text).toContain('- 민호: 버스 기사');
    expect(text).toContain('아직 풀리지 않은 떡밥:\n- 종점 시계 (2화)');
    expect(text).toContain('이미 풀린 떡밥(되풀이하지 않음):\n- 빨간 우산');
  });
  it('goes into the compose prompt even for a first episode', () => {
    expect(seriesBlock('S', undefined, [], '인물:\n- 민호: 기사')).toContain('[시리즈 설정집');
    expect(composePrompt({ mode: 'idea', story: 'x', outroKind: 'none', series: 'S', bible: '인물:\n- 민호: 기사' })).toContain('- 민호: 기사');
    expect(seriesBlock('S', 2, [], '')).toBe('');
  });
  it('builds fill and check prompts and cleans the check answer', () => {
    const w = newWork(DEFAULTS);
    w.episode = 3; w.cards[2].text = '민호는 *서른* 살이었다.';
    const b = { ...emptyBible('S'), characters: [{ name: '민호', desc: '쉰 살 기사' }] };
    expect(bibleFillPrompt('S', [{ episode: 1, title: '막차', summary: '요약' }], w, b)).toContain('1화 「막차」: 요약');
    const cp = checkPrompt(w, b, []);
    expect(cp).toContain('03 민호는 서른 살이었다.');
    expect(cp).toContain('- 민호: 쉰 살 기사');
    const r = normalizeCheck({ summary: '한 곳', issues: [{ card: 3, kind: '인물', issue: '나이가 다름', suggestion: '민호는 쉰 살이었다.' }, { card: 20, kind: '설정', issue: 'x', suggestion: '' }, { card: 0, issue: 'x' }] });
    expect(r.issues).toEqual([{ index: 2, kind: '인물', issue: '나이가 다름', suggestion: '민호는 쉰 살이었다.' }]);
  });
});

describe('reels', () => {
  it('gives longer cards more time in auto mode', () => {
    const w = newWork(DEFAULTS);
    w.cards[1].text = '짧다.';
    w.cards[2].text = '가'.repeat(90);
    const d = cardDurations(w, 'auto');
    expect(d[0]).toBe(3);
    expect(d[19]).toBe(3.5);
    expect(d[1]).toBe(2.5);
    expect(d[2]).toBeGreaterThan(5);
    expect(totalDuration(cardDurations(w, 3))).toBe(60);
  });
});

describe('Canva finishing deck', () => {
  it('reads the canvas font and colour strings', () => {
    expect(parseFont('bold 92px "Noto Serif KR", "Noto Serif KR", serif')).toEqual({ size: 92, weight: 700, family: 'Noto Serif KR' });
    expect(parseFont('500 30px "Gowun Batang", serif')).toEqual({ size: 30, weight: 500, family: 'Gowun Batang' });
    expect(parseFont('46px "Nanum Myeongjo"')).toEqual({ size: 46, weight: 400, family: 'Nanum Myeongjo' });
    expect(colorParts('#e6ecf5')).toEqual({ hex: 'E6ECF5', alpha: 1 });
    expect(colorParts('rgba(230, 236, 245, 0.55)')).toEqual({ hex: 'E6ECF5', alpha: 0.55 });
  });
  it('records words instead of drawing them, but still draws huge decorations', () => {
    const drawn: string[] = [];
    const real = { font: '400 46px "Noto Serif KR"', fillStyle: '#ffffff', globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic', letterSpacing: '0px', fillText: (t: string) => drawn.push(t) } as unknown as CanvasRenderingContext2D;
    const recs: TextRec[] = [];
    const ctx = captureContext(real, recs);
    ctx.fillText('본문', 100, 500);
    ctx.font = '700 460px "Gowun Batang"';
    ctx.fillText('07', 1040, 1050);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ text: '본문', size: 46, color: 'FFFFFF', align: 'left' });
    expect(drawn).toEqual(['07']);
  });
  it('joins runs into lines and lines into blocks', () => {
    const r = (text: string, x: number, y: number, o: Partial<TextRec> = {}): TextRec => ({ text, x, y, size: 46, family: 'F', weight: 400, color: 'FFFFFF', alpha: 1, align: 'left', spacing: 0, ...o });
    const blocks = groupBlocks([
      r('밤 버스는 ', 100, 500), r('비어', 300, 500, { color: '8FD3F4' }), r(' 있었다', 380, 500),
      r('둘째 줄', 100, 578), r('셋째 줄', 100, 656),
      r('3분 미스터리', 100, 992, { size: 26 }), r('02 / 20', 980, 992, { size: 26, align: 'right' }),
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].lines.map((l) => l.runs.length)).toEqual([3, 1, 1]);
    expect(blocks[0].step).toBe(78);
    expect(blocks[1].lines[0].runs[0].text).toBe('3분 미스터리');
    expect(blocks[2].lines[0].runs[0].align).toBe('right');
  });
});
