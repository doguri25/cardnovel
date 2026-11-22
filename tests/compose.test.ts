import { describe, expect, it } from 'vitest';
import { applyCompose } from '../src/ai/compose';
import { DEFAULTS, newWork, normalizeWork } from '../src/model';
import { splitManuscript } from '../src/parse';

const answer = () => ({
  title: '젖지 않은 우산', hook: '비 오는 밤의 우산',
  cards: Array.from({ length: 18 }, (_, i) => ({ label: `장면${i + 1}`, title: '', text: `AI 본문 ${i + 1}. 다음이 궁금하다.`, scene: `scene ${i + 1}`, accent: i === 14 })),
  outro: '당신이라면?', caption: '캡션', hashtags: ['카드소설', '#미스터리'],
  style: { name: '수채 밤', description: '수채로 그린 밤', prompt: 'watercolor night', characters: 'Jiho, 20s' },
  coverScene: 'a convenience store at night',
});

describe('applyCompose', () => {
  it('fills cover, 18 body cards, outro, caption, hashtags and the suggested art style', () => {
    const w = newWork(DEFAULTS);
    applyCompose(w, answer());
    expect(w.cards).toHaveLength(20);
    expect(w.cards[0].title).toBe('젖지 않은 우산');
    expect(w.cards[0].scene).toBe('a convenience store at night');
    expect(w.cards[1].text).toBe('AI 본문 1. 다음이 궁금하다.');
    expect(w.cards[15].accent).toBe(true);
    expect(w.cards[19].text).toBe('당신이라면?');
    expect(w.hashtags).toEqual(['#카드소설', '#미스터리']);
    expect(w.style).toMatchObject({ preset: 'ai', name: '수채 밤', characters: 'Jiho, 20s' });
  });
  it('keeps the writer’s own text for a split manuscript', () => {
    const w = newWork(DEFAULTS);
    const sp = splitManuscript(`표지\n내 제목\n내 훅\n\n${Array.from({ length: 18 }, (_, i) => `${i + 1}페이지\n작가 문장 ${i + 1}.`).join('\n\n')}`);
    applyCompose(w, answer(), sp);
    expect(w.cards[0].title).toBe('내 제목');
    expect(w.cards[3].text).toBe('작가 문장 3.');
    expect(w.cards[3].scene).toBe('scene 3');
  });
  it('leaves the outro empty when the writer picked none', () => {
    const w = newWork(DEFAULTS);
    w.outroKind = 'none';
    applyCompose(w, answer());
    expect(w.cards[19].text).toBe('');
  });
});

describe('normalizeWork', () => {
  it('always gives cover, 18 body cards and outro', () => {
    const w = normalizeWork({ cards: [{ kind: 'cover', title: 'x' }, { kind: 'body', text: 'a' }] }, DEFAULTS);
    expect(w.cards.map((c) => c.kind)).toEqual(['cover', ...Array(18).fill('body'), 'outro']);
    expect(w.cards[0].title).toBe('x');
    expect(w.cards[1].text).toBe('a');
    expect(w.series).toBe(DEFAULTS.series);
  });
});
