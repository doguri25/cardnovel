import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCompose, refreshScenes, sceneStale } from '../src/ai/compose';
import { SCENES_SCHEMA, scenesPrompt } from '../src/ai/prompts';
import { DEFAULTS, newWork, type Work } from '../src/model';

afterEach(() => vi.unstubAllGlobals());

const composed = (): Work => {
  const w = newWork(DEFAULTS);
  applyCompose(w, {
    title: '막차', hook: '종점에서 내리지 않은 한 사람', coverScene: 'An empty bus at a dark terminal.',
    cards: Array.from({ length: 18 }, (_, i) => ({ text: `${i + 1}번째 장면. 밤 버스는 비어 있었고 기사 민호는 거울 속 승객을 다시 봤다.`, scene: `Scene ${i + 1}: Minho looks at the mirror.` })),
    style: { name: 's', description: '', prompt: 'Moody watercolor.', characters: 'Minho: a bus driver in his 40s.' },
  });
  return w;
};

describe('which scenes no longer match their card', () => {
  it('a composed card remembers the words its scene was written for', () => {
    const w = composed();
    expect(w.cards[3].sceneFor).toBe(w.cards[3].text);
    expect(w.cards[0].sceneFor).toBe(w.cards[0].text);
    expect(w.cards.filter((c) => sceneStale(c))).toEqual([]);
  });
  it('small fixes keep the scene; rewritten words or a missing scene need a new one', () => {
    const w = composed();
    const c = w.cards[3];
    c.text = c.text.replace('다시 봤다', '다시 보았다');
    expect(sceneStale(c)).toBe(false);
    c.text = '서연은 비 오는 창밖을 보다가 정류장에 서 있는 어린 자신을 발견했다.';
    expect(sceneStale(c)).toBe(true);
    w.cards[4].scene = '';
    expect(sceneStale(w.cards[4])).toBe(true);
    expect(sceneStale(w.cards[19])).toBe(false); // the last card has no picture to draw
  });
  it('an older work without the record only refreshes empty scenes', () => {
    const w = composed();
    delete w.cards[3].sceneFor;
    w.cards[3].text = '완전히 다른 글';
    expect(sceneStale(w.cards[3])).toBe(false);
  });
});

describe('writing the scenes again', () => {
  it('tells the AI each changed card, its neighbours, the characters and the old scene', () => {
    const w = composed();
    w.cards[3].text = '서연은 비 오는 창밖을 보다가 정류장의 어린 자신을 발견했다.';
    const p = scenesPrompt(w, [3]);
    expect(p).toContain('04번 카드: 서연은 비 오는 창밖을 보다가');
    expect(p).toContain('앞 카드: 2번째 장면');
    expect(p).toContain('예전 장면: Scene 3: Minho looks at the mirror.');
    expect(p).toContain('Minho: a bus driver in his 40s.');
    expect(SCENES_SCHEMA.required).toEqual(['scenes']);
  });

  it('puts the new scenes on the cards asked for, in one request', async () => {
    const w = composed();
    w.cards[3].text = '서연은 비 오는 창밖을 보다가 정류장의 어린 자신을 발견했다.';
    w.cards[5].scene = '';
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const answer = { scenes: [{ card: 4, scene: 'Seo-yeon looks through the rainy window at a small girl at the bus stop.' }, { card: 6, scene: 'Wide shot of the empty bus at night.' }, { card: 9, scene: 'not asked for' }] };
      return new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(answer) }] }), { headers: { 'content-type': 'application/json' } });
    }));
    const n = await refreshScenes(w, [3, 5], { provider: 'anthropic', key: 'k', model: 'claude-sonnet-5-5' });
    expect(n).toBe(2);
    expect(bodies).toHaveLength(1);
    expect(w.cards[3].scene).toBe('Seo-yeon looks through the rainy window at a small girl at the bus stop.');
    expect(w.cards[3].sceneFor).toBe(w.cards[3].text);
    expect(w.cards[5].scene).toBe('Wide shot of the empty bus at night.');
    expect(w.cards[8].scene).toBe('Scene 8: Minho looks at the mirror.');
    expect(sceneStale(w.cards[3])).toBe(false);
  });
});
