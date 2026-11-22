// AI가 쓴 티가 나는 기계식 표현: the writing AI is told to avoid them, and 게시 전 점검 points them out.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiToneHits } from '../src/aitone';
import { rewriteCard } from '../src/ai/compose';
import { proofWork } from '../src/ai/proof';
import { HUMAN_STYLE, SYSTEM_WRITER } from '../src/ai/prompts';
import { reviewPrompt } from '../src/ai/review';
import { DEFAULTS, newWork, type Work } from '../src/model';
import { precheck } from '../src/precheck';

afterEach(() => vi.unstubAllGlobals());

const work = (): Work => {
  const w = newWork(DEFAULTS);
  w.cards[0].title = '막차';
  w.cards[0].text = '종점에서 내리지 않은 한 사람';
  w.cards.forEach((c, i) => { if (c.kind === 'body') c.text = `${i}번째 장면. 밤 버스는 비어 있었고 기사 민호는 거울 속 승객을 다시 봤다.`; });
  w.caption = '넘기면서 끝까지 읽어 주세요.';
  return w;
};

describe('the writing AI is told to write like a person', () => {
  it('every writing request carries the five rules', () => {
    for (const k of ['첫째·둘째·셋째', '결론적으로·요약하자면', '시사하는 바가 크다', '새로운 패러다임', '~가 아니라 ~다']) expect(HUMAN_STYLE).toContain(k);
    expect(SYSTEM_WRITER).toContain(HUMAN_STYLE);
  });

  const answer = (body: unknown) => new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(body) }] }), { headers: { 'content-type': 'application/json' } });
  const ai = { provider: 'anthropic' as const, key: 'k', model: 'claude-sonnet-5-5' };

  it('a card rewrite is sent with them; proofreading is not, so it only fixes spelling', async () => {
    const systems: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      systems.push(typeof b.system === 'string' ? b.system : JSON.stringify(b.system));
      return answer(b.output_config?.format?.schema?.properties?.fixes ? { fixes: [], summary: '' } : { text: '버스는 오지 않았다.' });
    }));
    await rewriteCard(work(), 3, '', ai);
    await proofWork(work(), ai, 'keep');
    expect(systems[0]).toContain('새로운 패러다임');
    expect(systems[1]).not.toContain('새로운 패러다임');
  });

  it('the AI review points out such expressions and suggests plain sentences', () => {
    expect(reviewPrompt(work())).toContain('기계식 표현');
  });
});

describe('finding them in what is written', () => {
  it('finds each kind, in cards and the caption', () => {
    const w = work();
    w.cards[3].text = '결론적으로 그날 밤 버스는 오지 않았다.';
    w.cards[5].text = '그 침묵이 시사하는 바가 컸다.';
    w.cards[7].text = '단순한 사랑을 넘어 새로운 패러다임이었다.';
    w.cards[9].text = '첫째, 문이 잠겨 있었다. 둘째, 불이 꺼져 있었다.';
    w.caption = '요약하자면 막차 이야기예요.';
    const hits = aiToneHits(w);
    expect(hits.map((h) => `${h.where}:${h.phrase}`)).toEqual(['3:결론적으로', '5:시사하는 바', '7:단순한 사랑을 넘어', '7:새로운 패러다임', '9:첫째·둘째', 'caption:요약하자면']);
  });

  it('one "~가 아니라 ~다" is fine in a story; the same pattern again and again is not', () => {
    const w = work();
    w.cards[4].text = '그건 꿈이 아니라 현실이었다.';
    expect(aiToneHits(w)).toEqual([]);
    w.cards[8].text = '그는 손님이 아니라 기사였다.';
    w.cards[12].text = '끝이 아니라 시작이었다.';
    expect(aiToneHits(w).map((h) => h.where)).toEqual([4, 8, 12]);
  });

  it('"첫째" alone (the eldest) is not numbering', () => {
    const w = work();
    w.cards[2].text = '첫째 딸은 늘 막차를 탔다.';
    expect(aiToneHits(w)).toEqual([]);
  });

  it('게시 전 점검 lists them with the card numbers and leads to the first card', () => {
    const w = work();
    expect(precheck(w).find((i) => i.id === 'aiTone')).toBeUndefined();
    w.cards[3].text = '결론적으로 그날 밤 버스는 오지 않았다.';
    w.caption = '단순한 괴담을 넘어선 이야기.';
    const item = precheck(w).find((i) => i.id === 'aiTone')!;
    expect(item).toMatchObject({ level: 'warn', cards: [3], go: 'card' });
    expect(item.text).toContain('04 「결론적으로」');
    expect(item.text).toContain('캡션 「단순한 괴담을 넘어」');
    w.cards[3].text = '그날 밤 버스는 오지 않았다.';
    expect(precheck(w).find((i) => i.id === 'aiTone')).toMatchObject({ go: 'caption' });
  });
});
