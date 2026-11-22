import { describe, expect, it } from 'vitest';
import { detectMode, fitToBody, parseManuscript, splitInTwo, splitManuscript } from '../src/parse';
import { BODY_COUNT } from '../src/model';

const pages = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}페이지\n${i + 1}번째 장면이다. 비가 내렸다. 지호는 우산을 들었다.`).join('\n\n');

describe('parseManuscript', () => {
  it('reads cover, numbered pages and the last page', () => {
    const { blocks, hasHeads } = parseManuscript(`표지\n젖지 않은 우산\n비 오는 밤.\n\n1페이지: 사건\n화요일 밤.\n\n마지막 페이지\n왜였을까?`);
    expect(hasHeads).toBe(true);
    expect(blocks.map((b) => b.type)).toEqual(['cover', 'num', 'last']);
    expect(blocks[1].head).toBe('사건');
  });
  it('splits on blank lines when there are no headers', () => {
    const { blocks, hasHeads } = parseManuscript('제목\n\n첫 문단.\n\n둘째 문단.\n\n끝 문단.');
    expect(hasHeads).toBe(false);
    expect(blocks.map((b) => b.type)).toEqual(['cover', 'num', 'num', 'last']);
  });
});

describe('detectMode', () => {
  it('headers mean a split manuscript', () => expect(detectMode('표지\n제목\n\n1페이지\n본문')).toBe('split'));
  it('a few lines are an idea', () => expect(detectMode('편의점에 젖지 않은 우산이 하나 남았다.')).toBe('idea'));
  it('a long text is a manuscript', () => expect(detectMode('가'.repeat(800))).toBe('long'));
});

describe('splitInTwo', () => {
  it('cuts at the sentence boundary nearest the middle', () => {
    expect(splitInTwo('비가 계속 내렸다. 지호가 문을 열었다. 우산이 하나 있었다. 아무도 오지 않았다.')).toEqual(['비가 계속 내렸다. 지호가 문을 열었다.', '우산이 하나 있었다. 아무도 오지 않았다.']);
  });
  it('refuses very short text', () => expect(splitInTwo('짧다.')).toBeNull());
});

describe('fitToBody', () => {
  it('keeps 18 as they are', () => {
    const items = Array.from({ length: 18 }, (_, i) => ({ label: '', text: `카드 ${i}. 내용이 있다.` }));
    const r = fitToBody(items);
    expect(r.body).toHaveLength(BODY_COUNT);
    expect(r.changes).toEqual([]);
  });
  it('merges the shortest neighbours when there are too many', () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ label: '', text: i === 4 || i === 5 ? '짧음.' : `카드 ${i}번의 꽤 긴 본문입니다. 두 문장이 있어요.` }));
    const r = fitToBody(items);
    expect(r.body).toHaveLength(BODY_COUNT);
    expect(r.changes[0]).toMatch(/합친 페이지: .*5\+6/);
  });
  it('splits the longest cards when there are too few', () => {
    const items = Array.from({ length: 16 }, (_, i) => ({ label: '', text: `카드 ${i}의 첫 문장이다. 그리고 두 번째 문장이 이어진다.` }));
    const r = fitToBody(items);
    expect(r.body).toHaveLength(BODY_COUNT);
    expect(r.body.every((c) => c.text.length > 0)).toBe(true);
    expect(r.changes.join(' ')).toMatch(/나눈 페이지/);
  });
  it('pads with empty cards when nothing can be split', () => {
    const r = fitToBody([{ label: '', text: '짧다.' }]);
    expect(r.body).toHaveLength(BODY_COUNT);
    expect(r.changes.join(' ')).toMatch(/빈 카드 17장/);
  });
});

describe('splitManuscript', () => {
  it('gives title, hook, 18 body cards and the outro line', () => {
    const r = splitManuscript(`표지\n젖지 않은 우산\n비 오는 밤의 우산.\n\n${pages(18)}\n\n마지막 페이지\n왜 숨겼을까?`);
    expect(r.title).toBe('젖지 않은 우산');
    expect(r.hook).toBe('비 오는 밤의 우산.');
    expect(r.body).toHaveLength(18);
    expect(r.outro).toBe('왜 숨겼을까?');
    expect(r.changes).toEqual([]);
    expect(r.originalCount).toBe(18);
  });
});
