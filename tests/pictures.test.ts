// Better pictures: people and setting (world) in every picture prompt.
import { describe, expect, it } from 'vitest';
import { applyCompose } from '../src/ai/compose';
import { canvaPrompt, characterSheetPrompt, composePrompt, imagePrompt, svgPrompt, worldLine } from '../src/ai/prompts';
import { DEFAULT_WORLD, DEFAULTS, newWork, normalizeWork, type Work } from '../src/model';

const KOREAN = 'All people are Korean, with East Asian features; the setting is contemporary South Korea (streets, homes, objects), with no readable signage.';

const work = (): Work => {
  const w = newWork(DEFAULTS);
  w.style.characters = 'Minho: a bus driver in his 40s.';
  w.cards[3].text = '민호는 거울 속 승객을 다시 봤다.';
  w.cards[3].scene = 'Minho glances at the rear-view mirror of the night bus.';
  return w;
};

describe('people and setting', () => {
  it('a new work draws Korean people in contemporary Korea', () => {
    expect(DEFAULT_WORLD).toBe('한국인 · 현대 한국');
    expect(newWork(DEFAULTS).style.world).toBe(DEFAULT_WORLD);
    expect(worldLine(work())).toBe(KOREAN);
  });

  it('another world is passed on as written; an empty one says nothing', () => {
    const w = work();
    w.style.world = '조선 시대 한양';
    expect(worldLine(w)).toBe('People and setting: 조선 시대 한양.');
    w.style.world = '  ';
    expect(worldLine(w)).toBe('');
  });

  it('every picture AI gets it: Canva AI, Gemini/GPT, the character sheet and Claude SVG', () => {
    const w = work();
    expect(canvaPrompt(w, 3)).toContain(KOREAN);
    expect(imagePrompt(w, 3)).toContain(KOREAN);
    expect(characterSheetPrompt(w)).toContain(KOREAN);
    expect(svgPrompt(w, 3, 640, true)).toContain(KOREAN);
    w.style.world = '';
    expect(canvaPrompt(w, 3)).not.toMatch(/Korean, with East Asian|People and setting/);
  });

  it('it sits right after the people in the Canva prompt, before the framing', () => {
    const p = canvaPrompt(work(), 3);
    expect(p.indexOf(KOREAN)).toBeGreaterThan(p.indexOf('Minho: a bus driver'));
    expect(p.indexOf(KOREAN)).toBeLessThan(p.indexOf('Wide shot'));
  });

  it('a work saved before the field existed gets the default; one the writer cleared stays clear', () => {
    const old = JSON.parse(JSON.stringify(work())) as Work;
    delete (old.style as Partial<Work['style']>).world;
    expect(normalizeWork(old, DEFAULTS).style.world).toBe(DEFAULT_WORLD);
    const cleared = work();
    cleared.style.world = '';
    expect(normalizeWork(cleared, DEFAULTS).style.world).toBe('');
  });

  it('composing with an AI art style keeps the writer\'s people and setting', () => {
    const w = work();
    w.style.world = '1980년대 부산';
    applyCompose(w, { title: 't', cards: [], style: { name: 's', description: 'd', prompt: 'Moody watercolor.', characters: 'Minho: a Korean man.' } });
    expect(w.style.prompt).toBe('Moody watercolor.');
    expect(w.style.world).toBe('1980년대 부산');
  });

  it('the writing AI writes the characters for the world (Korean by default)', () => {
    const p = composePrompt({ mode: 'idea', story: '막차 이야기', outroKind: 'question' });
    expect(p).toContain('인물·배경');
    expect(p).toContain(DEFAULT_WORLD);
  });
});
