import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { CAPTION_SCHEMA, captionPrompt, normalizeIdeas } from '../src/ai/caption';
import { chosung, matches, score } from '../src/hangul';
import { daysLeft, dropFromTrash, filterWorks, listTrash, moveToTrash, purgeTrash, searchText, takeFromTrash, TRASH_DAYS } from '../src/library';
import { DEFAULTS, newPost, newWork, textSig, type Work } from '../src/model';
import { cardList, precheck } from '../src/precheck';
import { collectRows, normTag, tagStats } from '../src/posts';
import { rankCommands, type Command } from '../src/ui/palette';

const full = (): Work => {
  const w = newWork(DEFAULTS);
  w.cards[0].title = '막차';
  w.cards[0].text = '종점에서 내리지 않은 한 사람';
  w.cards.forEach((c, i) => { if (c.kind === 'body') c.text = `${i}번째 장면. 밤 버스는 비어 있었고 기사 민호는 거울 속 승객을 다시 봤다.`; });
  w.cards[19].text = '어디로 가고 싶었을까요?';
  w.cards.forEach((c) => { if (c.kind !== 'outro') c.img = 'data:image/png;base64,AA'; });
  w.caption = '넘기면서 끝까지 읽어 주세요.';
  w.hashtags = ['#카드소설'];
  w.review = { at: 1, sig: '', scores: { hook: 1, flow: 1, consistency: 1, turn: 1, ending: 1 }, summary: '', strengths: [], notes: [], titles: [] };
  return w;
};
const ids = (w: Work, ctx = {}) => precheck(w, ctx).map((i) => i.id);

describe('pre-publish check', () => {
  it('says only “write something first” for an empty work', () => {
    expect(ids(newWork(DEFAULTS))).toEqual(['nothing']);
  });
  it('a finished work has only notes, no errors or warnings', () => {
    const w = full();
    w.review!.sig = textSig(w);
    const items = precheck(w, { proof: { ran: true, open: 0 } });
    expect(items.filter((i) => i.level !== 'info')).toEqual([]);
  });
  it('finds empty, long, short, duplicate cards and stray emphasis marks, errors first', () => {
    const w = full();
    w.cards[3].text = '';
    w.cards[4].text = '가'.repeat(95);
    w.cards[5].text = '짧다.';
    w.cards[6].text = w.cards[7].text;
    w.cards[8].text = '그날 밤 *버스는 끝내 종점까지 오지 않았고 나는 정류장에 혼자 남았다.';
    w.cards[0].title = '';
    const items = precheck(w);
    expect(items[0].level).toBe('error');
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.empty.cards).toEqual([3]);
    expect(by.title.level).toBe('error');
    expect(by.long.cards).toEqual([4]);
    expect(by.short.cards).toEqual([5]);
    expect(by.dup.cards).toEqual([7]);
    expect(by.stars.cards).toEqual([8]);
    expect(by.empty.text).toContain('04');
  });
  it('checks pictures, ratio, caption limits and proofreading', () => {
    const w = full();
    w.cards[2].img = undefined;
    w.ratio = '9:16';
    w.hashtags = Array.from({ length: 31 }, (_, i) => `#태그${i}`);
    w.caption = '가'.repeat(2300);
    const got = ids(w, { proof: { ran: true, open: 2 } });
    expect(got).toEqual(expect.arrayContaining(['pics', 'ratio', 'tagsMany', 'capLong', 'proofOpen']));
    expect(precheck(w).find((i) => i.id === 'pics')?.cards).toEqual([2]);
    w.cards.forEach((c) => { delete c.img; });
    expect(ids(w)).toContain('nopics');
    expect(ids(w, { proof: { ran: false, open: 0 } })).toContain('proofNone');
    w.finished = { designId: 'd', images: [], at: 1, on: true };
    expect(ids(w)).toContain('finished');
    expect(ids(w)).not.toContain('nopics');
  });
  it('lists card numbers briefly', () => {
    expect(cardList([0, 4])).toBe('01, 05');
    expect(cardList([1, 2, 3, 4, 5, 6, 7, 8])).toBe('02, 03, 04, 05, 06, 07 외 2장');
  });
});

describe('Korean search', () => {
  it('finds by letters or by initial consonants', () => {
    expect(chosung('일괄 교정')).toBe('ㅇㄱ ㄱㅈ');
    expect(matches('일괄 교정하기', 'ㄱㅈ')).toBe(true);
    expect(matches('일괄 교정하기', '교 정')).toBe(true);
    expect(matches('릴스 영상', 'ㄱㅈ')).toBe(false);
    expect(matches('Reels', 'reel')).toBe(true);
    expect(matches('설정: 연결 (공유 링크)', '설정 연결')).toBe(true);
    expect(score('교정하기', '교정')).toBeGreaterThan(score('일괄 교정하기', '교정'));
    expect(score('릴스', '교정')).toBe(-1);
  });
});

describe('library', () => {
  const mk = (title: string, series: string, ep: number | undefined, updatedAt: number, createdAt: number, text = '') => {
    const w = newWork(DEFAULTS);
    w.cards[0].title = title; w.series = series; w.episode = ep; w.updatedAt = updatedAt; w.createdAt = createdAt;
    w.cards[5].text = text;
    return w;
  };
  const all = [mk('막차', '3분 미스터리', 2, 30, 10, '거울 속 승객'), mk('빈집', '3분 미스터리', 1, 10, 20), mk('편지', '', undefined, 20, 30, '보낸 사람이 없다')];
  it('finds by title, card words and initial consonants', () => {
    expect(filterWorks(all, '승객', 'recent').map((w) => w.cards[0].title)).toEqual(['막차']);
    expect(filterWorks(all, 'ㅍㅈ', 'recent').map((w) => w.cards[0].title)).toEqual(['편지']);
    expect(filterWorks(all, '2화', 'recent').map((w) => w.cards[0].title)).toEqual(['막차']);
    expect(searchText(all[0])).toContain('3분 미스터리');
  });
  it('sorts by recent, created, title and series order', () => {
    const t = (s: Parameters<typeof filterWorks>[2]) => filterWorks(all, '', s).map((w) => w.cards[0].title);
    expect(t('recent')).toEqual(['막차', '편지', '빈집']);
    expect(t('created')).toEqual(['편지', '빈집', '막차']);
    expect(t('title')).toEqual(['막차', '빈집', '편지']);
    expect(t('episode')).toEqual(['빈집', '막차', '편지']);
  });
  it('keeps deleted works for 30 days and gives them back', async () => {
    const w = all[2];
    await moveToTrash(w, 1000);
    expect((await listTrash()).map((e) => e.title)).toEqual(['편지']);
    expect(daysLeft((await listTrash())[0], 1000 + 86400000 * 3)).toBe(TRASH_DAYS - 3);
    const back = await takeFromTrash(w.id);
    expect(back?.cards[5].text).toBe('보낸 사람이 없다');
    expect(await listTrash()).toEqual([]);
    await moveToTrash(all[0], 0);
    await moveToTrash(all[1], 0);
    expect(await purgeTrash(TRASH_DAYS * 86400000 - 1)).toEqual([]);
    expect(await purgeTrash(TRASH_DAYS * 86400000 + 1)).toHaveLength(2);
    expect(await takeFromTrash(all[0].id)).toBeNull();
    await moveToTrash(all[0], 5);
    await dropFromTrash(all[0].id);
    expect(await listTrash()).toEqual([]);
  });
});

describe('quick run', () => {
  const cmd = (id: string, title: string, keywords?: string): Command => ({ id, title, group: 'g', keywords, run: () => undefined });
  const all = [cmd('proof', '일괄 교정하기', '맞춤법'), cmd('reels', '릴스 영상 만들기'), cmd('settings', '설정: AI 키'), ...Array.from({ length: 20 }, (_, i) => cmd(`card:${i}`, `${String(i + 1).padStart(2, '0')} 장면`))];
  it('ranks by letters, initial consonants and keywords; a number finds that card', () => {
    expect(rankCommands(all, 'ㄱㅈ')[0].id).toBe('proof');
    expect(rankCommands(all, '맞춤')[0].id).toBe('proof');
    expect(rankCommands(all, '릴스')[0].id).toBe('reels');
    expect(rankCommands(all, '3')[0].id).toBe('card:2');
    expect(rankCommands(all, '없는말')).toEqual([]);
  });
  it('without a query lists actions, not every card', () => {
    expect(rankCommands(all, '').map((c) => c.id)).toEqual(['proof', 'reels', 'settings']);
  });
});

describe('caption and hashtags', () => {
  it('cleans AI ideas: hashtags out of captions, tags normalized and unique', () => {
    const ideas = normalizeIdeas({
      captions: [{ text: '마지막 버스는 비어 있었다.\\n저장해 두고 다시 읽어 보세요 #카드소설', angle: '분위기' }, { text: '', angle: 'x' }],
      tagSets: [{ name: '좁게', tags: ['카드소설', '#카드소설', '# 초단편', '#'] }, { name: '빈', tags: [] }],
    });
    expect(ideas.captions).toEqual([{ text: '마지막 버스는 비어 있었다.\n저장해 두고 다시 읽어 보세요', angle: '분위기' }]);
    expect(ideas.tagSets).toEqual([{ name: '좁게', tags: ['#카드소설', '#초단편'] }]);
    expect(CAPTION_SCHEMA.required).toEqual(['captions', 'tagSets']);
  });
  it('tells the AI the story and the tags that did well', () => {
    const w = full();
    const p = captionPrompt(w, [{ tag: '#미스터리', n: 3, value: 0.1 }]);
    expect(p).toContain('제목: 막차');
    expect(p).toContain('#미스터리 (3번 사용)');
    expect(captionPrompt(w)).not.toContain('반응이 좋았던 해시태그 (평균');
  });
  it('remembers the tags on a logged post and ranks tags by how those posts did', () => {
    expect(normTag(' 카드 소설 ')).toBe('#카드소설');
    const mk = (tags: string[], reach: number, likes: number) => { const w = newWork(DEFAULTS); w.posts = [{ ...newPost(1, tags), reach, likes }]; return w; };
    const ws = [mk(['#밤', '#카드소설'], 100, 20), mk(['#카드소설'], 100, 10), mk(['#밤', '#카드소설'], 100, 30), mk(['#낮'], 100, 1)];
    expect(ws[0].posts![0].tags).toEqual(['#밤', '#카드소설']);
    const stats = tagStats(collectRows(ws));
    expect(stats.map((s) => s.tag)).toEqual(['#밤', '#카드소설']);
    expect(stats[0]).toMatchObject({ n: 2 });
    expect(stats[0].value).toBeCloseTo(0.25);
    expect(tagStats(collectRows(ws), 1).map((s) => s.tag)).toContain('#낮');
  });
});
