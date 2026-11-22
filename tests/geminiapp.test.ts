// Gemini 앱 도우미: the texts the writer copies into the Gemini app, and where pictures coming back go.
import { describe, expect, it } from 'vitest';
import { worldLine } from '../src/ai/prompts';
import { assignFiles, geminiCardPrompt, geminiFirstMessage, pastedImage, pasteTarget } from '../src/geminiapp';
import { DEFAULTS, newWork, type Work } from '../src/model';

const work = (): Work => {
  const w = newWork(DEFAULTS); // 1:1
  w.style.prompt = 'Moody watercolor illustration, muted blue-grey palette.';
  w.style.characters = 'Minho: a Korean bus driver in his 40s, short black hair, navy uniform. Seo-yeon: a Korean woman in her 20s, long straight hair, beige trench coat.';
  w.cards[0].title = '막차의 승객';
  w.cards[0].text = '종점에서 내리지 않은 한 사람';
  w.cards[0].scene = 'An empty city bus parked at a dark terminal at night, one window still lit.';
  w.cards[3].text = '민호는 거울 속 승객을 다시 봤다.';
  w.cards[3].scene = 'Inside the night bus, Minho glances at the rear-view mirror.';
  w.cards[4].text = '서연은 창밖만 보고 있었다.';
  w.cards[4].scene = 'Seo-yeon sits by the rain-streaked window, staring out.';
  return w;
};

describe('the first message for a new Gemini chat', () => {
  it('sets up the whole run: how many pictures, the art style, people and setting, the looks, the rules, the reference picture first', () => {
    const w = work();
    const m = geminiFirstMessage(w, 19);
    expect(m).toContain('19장');
    expect(m).toContain('Moody watercolor illustration, muted blue-grey palette.');
    expect(m).toContain(worldLine(w));
    expect(m).toContain('Minho: a Korean bus driver in his 40s');
    expect(m).toContain('Seo-yeon: a Korean woman in her 20s');
    expect(m).toMatch(/글자.*말풍선/);
    expect(m).toContain('인물 기준 그림을 먼저');
  });

  it('with a reference picture already made, asks Gemini to follow the one attached instead', () => {
    const w = work();
    w.style.refImage = 'data:image/png;base64,AAAA';
    const m = geminiFirstMessage(w, 5);
    expect(m).toContain('함께 올린 인물 기준 그림');
    expect(m).not.toContain('인물 기준 그림을 먼저');
  });
});

describe('a card\'s prompt', () => {
  it('names the card, gives its scene and only the people in it, and the shape of its picture area', () => {
    const p = geminiCardPrompt(work(), 3);
    expect(p.startsWith('04번 카드')).toBe(true);
    expect(p).toContain('Inside the night bus, Minho glances at the rear-view mirror.');
    expect(p).toContain('Minho: a Korean bus driver in his 40s');
    expect(p).not.toContain('Seo-yeon');
    expect(p).toContain('가로 16:9'); // a stack card in a 1:1 work: a wide picture above the words
    const q = geminiCardPrompt(work(), 4);
    expect(q).toContain('Seo-yeon: a Korean woman');
    expect(q).not.toContain('Minho');
  });

  it('a full-picture card asks for its tall shape and room for the words', () => {
    const w = work();
    w.cards[3].layout = 'full';
    const p = geminiCardPrompt(w, 3);
    expect(p).toContain('정사각형 1:1');
    expect(p).toMatch(/아래.*비워/);
  });

  it('the cover shows its scene, never the title as text', () => {
    const p = geminiCardPrompt(work(), 0);
    expect(p.startsWith('01번 카드(표지)')).toBe(true);
    expect(p).toContain('An empty city bus parked at a dark terminal');
    expect(p).not.toContain('막차의 승객');
    expect(p).toMatch(/글자 없이/);
  });

  it('a card with no scene yet goes by its words; a story with one person keeps them along', () => {
    const w = work();
    w.style.characters = 'Minho: a Korean bus driver in his 40s.';
    w.cards[6].text = '버스는 종점에 멈췄다.';
    w.cards[6].scene = '';
    const p = geminiCardPrompt(w, 6);
    expect(p).toContain('버스는 종점에 멈췄다.');
    expect(p).toContain('Minho: a Korean bus driver in his 40s');
  });
});

describe('a card whose words changed after its scene was written', () => {
  it('goes by its words, not the old scene', () => {
    const w = work();
    w.cards[3].sceneFor = '완전히 다른 예전 글이었다. 그때는 바다가 배경이었고 아무도 없었다.';
    const p = geminiCardPrompt(w, 3);
    expect(p).not.toContain('rear-view mirror');
    expect(p).toContain('민호는 거울 속 승객을 다시 봤다.');
    expect(p).toContain('Minho: a Korean bus driver'); // still the people it names
  });
});

describe('the picture in a paste', () => {
  const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
  it('is found in files, or in items where a browser fills only those', () => {
    expect(pastedImage({ files: [file], items: [] } as unknown as DataTransfer)).toBe(file);
    expect(pastedImage({ files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }, { kind: 'file', type: 'image/png', getAsFile: () => file }] } as unknown as DataTransfer)).toBe(file);
    expect(pastedImage({ files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } as unknown as DataTransfer)).toBeNull();
    expect(pastedImage(null)).toBeNull();
  });
});

describe('pictures uploaded together', () => {
  const f = (name: string, lastModified: number) => ({ name, lastModified });
  it('go in the order they were made (then by name) onto the cards still without a picture', () => {
    const files = [f('c.png', 300), f('b (10).png', 200), f('b (2).png', 200), f('a.png', 100)];
    const { pairs, extra } = assignFiles(files, [1, 2, 5, 7]);
    expect(pairs.map((p) => [p.file.name, p.index])).toEqual([['a.png', 1], ['b (2).png', 2], ['b (10).png', 5], ['c.png', 7]]);
    expect(extra).toEqual([]);
  });

  it('more files than empty cards: the rest are left out, never put over a picture', () => {
    const { pairs, extra } = assignFiles([f('1.png', 1), f('2.png', 2), f('3.png', 3)], [4]);
    expect(pairs).toEqual([{ file: f('1.png', 1), index: 4 }]);
    expect(extra.map((x) => x.name)).toEqual(['2.png', '3.png']);
    expect(assignFiles([], [1, 2])).toEqual({ pairs: [], extra: [] });
  });
});

describe('where a pasted picture goes', () => {
  it('onto the selected card, unless the writer is typing in a text field (then the paste is theirs)', () => {
    document.body.innerHTML = '<textarea id="t"></textarea><input id="i"><div id="e" contenteditable="true"></div><button id="b">x</button><select id="s"></select>';
    const $ = (id: string) => document.getElementById(id);
    expect(pasteTarget($('t'), 3)).toBeNull();
    expect(pasteTarget($('i'), 3)).toBeNull();
    expect(pasteTarget($('e'), 3)).toBeNull();
    expect(pasteTarget($('b'), 3)).toBe(3);
    expect(pasteTarget(document.body, 0)).toBe(0);
    expect(pasteTarget(null, 7)).toBe(7);
  });
});
