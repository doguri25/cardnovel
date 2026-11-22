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

/* ---------- 연출 정리: one pass over the whole story ---------- */
import { afterEach, vi } from 'vitest';
import { directWork } from '../src/ai/compose';
import { DIRECT_SCHEMA, directPrompt } from '../src/ai/prompts';
import { textSig } from '../src/model';

afterEach(() => vi.unstubAllGlobals());
const ai = { provider: 'anthropic' as const, key: 'k', model: 'claude-sonnet-5-5' };
const answerWith = (body: unknown, bodies: Record<string, unknown>[] = []) => vi.fn(async (_u: string, init: RequestInit) => {
  bodies.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(body) }] }), { headers: { 'content-type': 'application/json' } });
});
const story = (): Work => {
  const w = work();
  w.cards[0].title = '막차';
  w.cards.forEach((c, i) => { if (c.kind === 'body') { c.text = `${i}번째 장면. 밤 버스는 비어 있었다.`; c.scene = `old scene ${i}`; } });
  return w;
};

describe('scene direction', () => {
  it('asks once with the whole story, the people, the world and the scene rule', () => {
    const p = directPrompt(story());
    expect(p).toContain('04번 카드: 3번째 장면. 밤 버스는 비어 있었다.');
    expect(p).toContain('Minho: a bus driver in his 40s.');
    expect(p).toContain(KOREAN);
    expect(p).toContain('눈에 보이는 것만');
    expect(DIRECT_SCHEMA.required).toEqual(['characters', 'scenes']);
  });

  it('puts the directed scenes and looks on the work, in one request', async () => {
    const w = story();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', answerWith({
      characters: 'Minho: a Korean man in his 40s, short black hair, navy bus driver uniform.',
      scenes: [{ card: 4, scene: 'Night bus interior, Minho in his navy uniform glances at the mirror.' }, { card: 99, scene: 'no such card' }, { card: 20, scene: 'the last card has no picture' }],
    }, bodies));
    const sig = textSig(w);
    const r = await directWork(w, ai);
    expect(bodies).toHaveLength(1);
    expect(r).toEqual({ scenes: 1, characters: true });
    expect(w.cards[3].scene).toBe('Night bus interior, Minho in his navy uniform glances at the mirror.');
    expect(w.cards[3].sceneFor).toBe(w.cards[3].text);
    expect(w.cards[4].scene).toBe('old scene 4'); // not in the answer: kept
    expect(w.style.characters).toBe('Minho: a Korean man in his 40s, short black hair, navy bus driver uniform.');
    expect(w.style.directedFor).toBe(sig);
  });

  it('keeps the characters the writer typed', async () => {
    const w = story();
    w.style.characters = 'Minho: 내가 정한 생김새';
    w.style.charactersByWriter = true;
    vi.stubGlobal('fetch', answerWith({ characters: 'Minho: AI version', scenes: [{ card: 4, scene: 'new' }] }));
    const r = await directWork(w, ai);
    expect(r.characters).toBe(false);
    expect(w.style.characters).toBe('Minho: 내가 정한 생김새');
    expect(w.cards[3].scene).toBe('new');
  });
});
