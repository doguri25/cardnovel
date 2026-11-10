import { describe, expect, it } from 'vitest';
import { canvaPrompt, parseCharacters } from '../src/ai/prompts';
import { DEFAULTS, newWork, type Work } from '../src/model';

const work = (): Work => {
  const w = newWork(DEFAULTS);
  w.style = {
    preset: 'ai', name: '밤 수채화', description: '',
    prompt: 'Moody watercolor illustration, muted blue-grey palette, soft sodium street light, visible paper texture.',
    characters: 'Minho: a bus driver in his 40s, short black hair, navy uniform and grey cap. Seo-yeon: a woman in her 20s with long straight hair and a beige trench coat.',
  };
  w.cards[0].title = '막차';
  w.cards[0].text = '종점에서 내리지 않은 한 사람';
  w.cards[0].scene = 'An empty city bus parked at a dark terminal at night, one window still lit.';
  w.cards[3].text = '민호는 거울 속 승객을 다시 봤다.';
  w.cards[3].scene = 'Inside the night bus, Minho glances at the rear-view mirror; a lone passenger sits in the last row.';
  w.cards[4].text = '서연은 창밖만 보고 있었다.';
  w.cards[4].scene = 'Seo-yeon sits by the rain-streaked window of the bus, staring out at the passing lights.';
  w.cards[5].text = '아무도 내리지 않았다.';
  w.cards[5].scene = '';
  return w;
};

describe('character notes', () => {
  it('splits named characters from notes that name no one', () => {
    expect(parseCharacters(work().style.characters).named).toEqual([
      { name: 'Minho', desc: 'a bus driver in his 40s, short black hair, navy uniform and grey cap' },
      { name: 'Seo-yeon', desc: 'a woman in her 20s with long straight hair and a beige trench coat' },
    ]);
    expect(parseCharacters('People appear only as silhouettes or from behind, no detailed faces.')).toEqual({ named: [], general: 'People appear only as silhouettes or from behind, no detailed faces.' });
    expect(parseCharacters('Kim Minho, a bus driver in his 40s.\nJiwoo — a girl of ten in a yellow raincoat.').named.map((c) => c.name)).toEqual(['Kim Minho', 'Jiwoo']);
    expect(parseCharacters('')).toEqual({ named: [], general: '' });
  });
});

describe('the Canva AI prompt', () => {
  it('leads with the scene, then only the people in it, then the framing and the style', () => {
    const p = canvaPrompt(work(), 3);
    const lines = p.split('\n');
    expect(lines[0]).toBe('Inside the night bus, Minho glances at the rear-view mirror; a lone passenger sits in the last row.');
    expect(lines[1]).toBe('Minho: a bus driver in his 40s, short black hair, navy uniform and grey cap.');
    expect(p).not.toContain('Seo-yeon');
    expect(p.indexOf('Wide shot')).toBeGreaterThan(p.indexOf('Minho:'));
    expect(p.indexOf('Style: Moody watercolor')).toBeGreaterThan(p.indexOf('Wide shot'));
    expect(canvaPrompt(work(), 4)).toContain('Seo-yeon: a woman in her 20s');
    expect(canvaPrompt(work(), 4)).not.toContain('Minho');
  });

  it('keeps it short and does not invite lettering', () => {
    const p = canvaPrompt(work(), 3);
    expect(p).not.toMatch(/speech bubble|caption|logo|watermark|numbers/i);
    expect(p).toMatch(/no lettering/i);
    expect(p.length).toBeLessThan(700);
  });

  it('the cover shows its scene without the quoted title', () => {
    const p = canvaPrompt(work(), 0);
    expect(p.split('\n')[0]).toBe('An empty city bus parked at a dark terminal at night, one window still lit.');
    expect(p).not.toContain('막차');
    expect(canvaPrompt(work(), 0, 'Composition idea: a close-up of the key object.')).toContain('Composition idea: a close-up of the key object.');
  });

  it('a card without a scene uses its own words; a lone character goes along even when not named', () => {
    const w = work();
    expect(canvaPrompt(w, 5).split('\n')[0]).toBe('A moment from a Korean short story: 아무도 내리지 않았다.');
    w.style.characters = 'Minho: a bus driver in his 40s, short black hair.';
    w.cards[6].scene = 'The driver stops the bus at the last stop, hands on the wheel.';
    expect(canvaPrompt(w, 6)).toContain('Minho: a bus driver in his 40s');
  });

  it('notes that name no one always go along, and quote cards stay a quiet backdrop', () => {
    const w = work();
    w.style.characters = 'People appear only as silhouettes or from behind, no detailed faces.';
    expect(canvaPrompt(w, 3)).toContain('People appear only as silhouettes');
    w.cards[3].layout = 'quote';
    expect(canvaPrompt(w, 3)).toMatch(/soft-focus atmospheric backdrop/i);
    w.cards[3].layout = 'full';
    expect(canvaPrompt(w, 3)).toMatch(/tall full-frame/i);
  });
});
