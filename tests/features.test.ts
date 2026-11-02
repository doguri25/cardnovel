import { describe, expect, it } from 'vitest';
import { applyCompose, artAspect } from '../src/ai/compose';
import { characterSheetPrompt, composePrompt, imagePrompt, seriesBlock } from '../src/ai/prompts';
import { normalizeReview, REVIEW_SCHEMA, reviewPrompt, totalScore } from '../src/ai/review';
import { backupName, compareCopies } from '../src/drive';
import { DEFAULTS, newWork, seriesLine, textSig, type Work } from '../src/model';
import { artHeight, layoutOf } from '../src/render';
import { asPrev, fallbackSummary, groupBySeries, nextEpisodeNumber, nextEpisodeWork, previousEpisodes } from '../src/series';
import { feedAspect } from '../src/ui/insta';

const story = (title: string, series = '3분 미스터리', episode?: number, updatedAt = 1): Work => {
  const w = newWork(DEFAULTS);
  w.series = series; w.episode = episode; w.updatedAt = updatedAt;
  w.cards[0].title = title; w.cards[0].text = `${title} 훅`;
  for (let i = 1; i <= 18; i++) w.cards[i].text = `${title} 본문 ${i}`;
  return w;
};

describe('card layouts', () => {
  it('keeps the last card stacked and the cover out of the quote layout', () => {
    const w = newWork(DEFAULTS);
    w.cards[0].layout = 'quote';
    w.cards[19].layout = 'full';
    w.cards[3].layout = 'quote';
    expect(layoutOf(w.cards[0])).toBe('stack');
    expect(layoutOf(w.cards[19])).toBe('stack');
    expect(layoutOf(w.cards[3])).toBe('quote');
    expect(layoutOf(w.cards[4])).toBe('stack');
  });
  it('asks for a whole-card picture on full-bleed cards', () => {
    const w = newWork(DEFAULTS);
    w.ratio = '4:5';
    w.cards[2].layout = 'full';
    expect(artHeight(w, w.cards[1])).toBe(800);
    expect(artHeight(w, w.cards[2])).toBe(1350);
    expect(artAspect(w, 2)).toBeCloseTo(1080 / 1350);
    expect(artAspect(w, 1)).toBeCloseTo(1080 / 800);
    expect(imagePrompt(w, 2)).toMatch(/full-bleed/);
    expect(imagePrompt(w, 1)).toMatch(/text continues below/);
  });
});

describe('character reference picture', () => {
  it('tells the image model which reference is which', () => {
    const w = newWork(DEFAULTS);
    w.cards[3].text = '본문';
    expect(imagePrompt(w, 3, { chars: true, cover: true })).toMatch(/first is the character sheet.*second is the cover/);
    expect(imagePrompt(w, 3, { chars: true })).toMatch(/Reference image: the character sheet/);
    expect(imagePrompt(w, 3, { cover: true })).toMatch(/Match the art style/);
    expect(imagePrompt(w, 3)).not.toMatch(/[Rr]eference/);
  });
  it('builds a character sheet prompt from the style and characters', () => {
    const w = newWork(DEFAULTS);
    w.style.characters = 'Jiho, 20s, yellow raincoat';
    const p = characterSheetPrompt(w);
    expect(p).toContain('Jiho, 20s, yellow raincoat');
    expect(p).toMatch(/full body, front view/);
    expect(p).toMatch(/No text/);
  });
});

describe('series', () => {
  it('finds earlier episodes of the same series, oldest first', () => {
    const e1 = story('하나', '3분 미스터리', 1), e2 = story('둘', '3분 미스터리', 2), other = story('남', '다른 시리즈', 1), e3 = story('셋', '3분 미스터리', 3);
    expect(previousEpisodes([e3, other, e1, e2], e3).map((w) => w.episode)).toEqual([1, 2]);
    expect(previousEpisodes([e1, e2], e1)).toEqual([]);
    expect(nextEpisodeNumber([e1, e2, other, e3], '3분 미스터리')).toBe(4);
    expect(nextEpisodeNumber([other], '새 시리즈')).toBe(1);
  });
  it('carries the look and the art style (with the character picture) into the next episode', () => {
    const from = story('하나', '3분 미스터리', 1);
    from.theme = 'news'; from.ratio = '4:5'; from.font = 'Gowun Batang'; from.handle = '@me'; from.outroKind = 'teaser';
    from.style = { preset: 'ai', name: '수채', description: 'd', prompt: 'watercolor', characters: 'Jiho', refImage: 'data:image/webp;base64,AAAA' };
    const next = nextEpisodeWork(from, DEFAULTS, 2);
    expect(next.id).not.toBe(from.id);
    expect(next).toMatchObject({ theme: 'news', ratio: '4:5', font: 'Gowun Batang', handle: '@me', series: '3분 미스터리', episode: 2, outroKind: 'teaser' });
    expect(next.style.refImage).toBe('data:image/webp;base64,AAAA');
    expect(next.style).not.toBe(from.style);
    expect(next.cards.every((c) => !c.text)).toBe(true);
    expect(seriesLine(next)).toBe('3분 미스터리 · 2화');
  });
  it('groups the library by series and episode, one-off stories last', () => {
    const a1 = story('a1', 'A', 1, 10), a2 = story('a2', 'A', 2, 5), b = story('b', 'B', undefined, 50), loose = story('loose', '', undefined, 99);
    const g = groupBySeries([a2, loose, b, a1]);
    expect(g.map((x) => x.name)).toEqual(['B', 'A', '']);
    expect(g[1].works.map((w) => w.episode)).toEqual([1, 2]);
  });
  it('gives the writer the earlier episodes, with a stand-in summary where the AI one is missing', () => {
    const e1 = story('하나', '3분 미스터리', 1);
    expect(fallbackSummary(e1)).toContain('하나 훅');
    e1.summary = '지호가 우산을 찾았다.';
    const block = seriesBlock('3분 미스터리', 2, [asPrev(e1)]);
    expect(block).toContain('2화');
    expect(block).toContain('1화 「하나」: 지호가 우산을 찾았다.');
    const p = composePrompt({ mode: 'idea', story: '다음 이야기', outroKind: 'teaser', series: '3분 미스터리', episode: 2, previous: [asPrev(e1)] });
    expect(p).toContain('[앞 회 줄거리]');
    expect(composePrompt({ mode: 'idea', story: 'x', outroKind: 'none' })).not.toContain('[앞 회 줄거리]');
  });
  it('stores the AI summary and keeps the series art style when asked', () => {
    const w = newWork(DEFAULTS);
    w.style = { preset: 'ai', name: '시리즈 화풍', description: '', prompt: 'series style', characters: '' };
    const a = { cards: [{ text: '본문' }], summary: '요약입니다.', style: { name: '새 화풍', description: '', prompt: 'new style', characters: '' } };
    applyCompose(w, a, undefined, true);
    expect(w.summary).toBe('요약입니다.');
    expect(w.style.name).toBe('시리즈 화풍');
    applyCompose(w, a);
    expect(w.style.name).toBe('새 화풍');
  });
});

describe('AI review', () => {
  it('lists the cards with their numbers and asks for five 0–20 scores', () => {
    const w = story('막차');
    const p = reviewPrompt(w);
    expect(p).toContain('01 표지 — 제목: 막차');
    expect(p).toContain('19 막차 본문 18');
    expect((REVIEW_SCHEMA.properties.scores as { required: string[] }).required).toEqual(['hook', 'flow', 'consistency', 'turn', 'ending']);
  });
  it('clamps scores and keeps only usable notes', () => {
    const w = story('막차');
    const r = normalizeReview({
      scores: { hook: 25, flow: 14.6, consistency: -3, turn: Number.NaN as unknown as number, ending: 12 },
      summary: '좋아요', strengths: ['a', 'b', 'c', 'd'],
      notes: [
        { card: 5, verdict: 'cut', issue: '늘어짐', suggestion: '새 문장' },
        { card: 5, verdict: 'fix', issue: '중복', suggestion: '중복' },
        { card: 20, verdict: 'fix', issue: '마지막 장', suggestion: 'x' },
        { card: 0, verdict: 'fix', issue: '없는 카드', suggestion: 'x' },
        { card: 1, verdict: 'weird', issue: '훅이 약함', suggestion: '새 훅' },
      ],
      titles: [{ title: '막차', hook: '훅', why: '짧다' }, { title: '', hook: 'x', why: '' }],
    }, w, 123);
    expect(r.scores).toEqual({ hook: 20, flow: 15, consistency: 0, turn: 0, ending: 12 });
    expect(totalScore(r)).toBe(47);
    expect(r.notes.map((n) => [n.index, n.verdict])).toEqual([[0, 'fix'], [4, 'cut']]);
    expect(r.strengths).toHaveLength(3);
    expect(r.titles).toHaveLength(1);
    expect(r.sig).toBe(textSig(w));
    expect(r.at).toBe(123);
  });
  it('notices when the cards change after a review', () => {
    const w = story('막차');
    const before = textSig(w);
    w.cards[5].text += '!';
    expect(textSig(w)).not.toBe(before);
  });
});

describe('Instagram preview', () => {
  it('shows 9:16 cards as 4:5 in the feed', () => {
    expect(feedAspect('1:1')).toMatchObject({ w: 1, h: 1, cropped: false });
    expect(feedAspect('3:4')).toMatchObject({ w: 3, h: 4, cropped: false });
    expect(feedAspect('9:16')).toMatchObject({ w: 4, h: 5, cropped: true });
  });
});

describe('Drive backup', () => {
  it('compares the Drive copy with this device by the saved time', () => {
    const f = (t: number) => ({ id: 'f', name: 'n', modifiedTime: '', appProperties: { updatedAt: String(t) } });
    expect(compareCopies(f(5), undefined)).toBe('drive_only');
    expect(compareCopies(f(5), { updatedAt: 5 })).toBe('same');
    expect(compareCopies(f(9), { updatedAt: 5 })).toBe('drive_newer');
    expect(compareCopies(f(1), { updatedAt: 5 })).toBe('local_newer');
  });
  it('names files by series, episode and title without characters Drive dislikes', () => {
    const w = story('비/밤?', '3분 미스터리', 3);
    expect(backupName(w)).toBe('3분 미스터리 3화 비_밤_.cardnovel.json');
  });
});
