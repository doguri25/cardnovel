// Story → 20 cards, card rewrites, outro line and pictures, on top of the provider adapter.
import { BODY_COUNT, DEFAULT_WORLD, textSig, type ArtStyle, type InputMode, type OutroKind, type Work } from '../model';
import { detectMode, splitManuscript, type SplitResult } from '../parse';
import { canvaAiImage } from '../canva';
import { sceneStale } from '../scene';
import { artHeight, layoutOf, sanitizeSVG, W } from '../render';
import { AiError, generateImage, generateJSON, generateText, type TextRequest, type UsageTag } from './providers';
import { COMPOSE_SCHEMA, DIRECT_SCHEMA, directPrompt, parseCharacters, ONE_TEXT_SCHEMA, SCENES_SCHEMA, SYSTEM_WRITER, canvaPrompt, characterSheetPrompt, composePrompt, imagePrompt, outroPrompt, rewritePrompt, scenesPrompt, summaryPrompt, svgPrompt, type PrevEpisode } from './prompts';

export interface TextAI { provider: TextRequest['provider']; key: string; model: string }

interface ComposeAnswer {
  title?: string; hook?: string;
  cards?: { label?: string; title?: string; text?: string; scene?: string; accent?: boolean }[];
  outro?: string; caption?: string; hashtags?: string[];
  style?: Partial<ArtStyle>; coverScene?: string; summary?: string;
}

const s = (v: unknown) => (typeof v === 'string' ? v : '').replace(/\\n/g, '\n').trim();

/** Retries once with a smaller output budget for models that do not accept 16k output tokens.
 *  An empty or cut-off answer is asked once more with more room: a model that thinks before answering
 *  can spend a small budget before it writes anything. */
export async function askJSON<T>(ai: TextAI, prompt: string, schema: Record<string, unknown>, signal?: AbortSignal, maxTokens = 16000, tag: UsageTag = 'other', system = SYSTEM_WRITER): Promise<T> {
  const req = { ...ai, system, prompt, schema, signal, maxTokens, tag };
  let cap = Infinity;
  const ask = async (budget: number): Promise<T> => {
    const n = Math.min(budget, cap);
    try {
      return await generateJSON<T>({ ...req, maxTokens: n });
    } catch (e) {
      if (e instanceof AiError && e.code === 'bad_request' && /max_tokens|max_completion_tokens|maxOutputTokens|output tokens/i.test(e.message) && n > 8000) {
        cap = 8000;
        return generateJSON<T>({ ...req, maxTokens: 8000 });
      }
      throw e;
    }
  };
  try {
    return await ask(maxTokens);
  } catch (e) {
    // one more try, with more room
    if (e instanceof AiError && (e.code === 'invalid_json' || e.code === 'empty')) return ask(Math.min(16000, Math.max(maxTokens * 4, 8000)));
    throw e;
  }
}

/** Puts an AI answer into the work. Body texts come from `fixedBody` when the writer's own split is kept. */
export function applyCompose(w: Work, a: ComposeAnswer, fixed?: SplitResult, keepStyle = false): void {
  const cards = Array.isArray(a.cards) ? a.cards : [];
  const cover = w.cards[0];
  cover.title = s(fixed?.title) || s(a.title) || cover.title;
  cover.text = s(fixed?.hook) || s(a.hook) || cover.text;
  cover.scene = s(a.coverScene);
  cover.sceneFor = cover.text;
  delete cover.sceneByWriter;
  for (let i = 0; i < BODY_COUNT; i++) {
    const c = w.cards[i + 1];
    const src = cards[i] ?? {};
    const keep = fixed?.body[i];
    c.text = keep && keep.text ? keep.text : s(src.text);
    c.label = (keep && keep.label) || s(src.label);
    c.title = s(src.title);
    c.scene = s(src.scene);
    c.sceneFor = c.text;
    delete c.sceneByWriter;
    c.accent = !!src.accent;
    c.showLabel = false;
  }
  const outro = w.cards[w.cards.length - 1];
  outro.text = w.outroKind === 'none' ? '' : s(fixed?.outro) || s(a.outro);
  w.caption = s(a.caption);
  w.summary = s(a.summary) || w.summary;
  w.hashtags = (Array.isArray(a.hashtags) ? a.hashtags : []).map((t) => s(t)).filter(Boolean).map((t) => (t.startsWith('#') ? t : '#' + t)).slice(0, 10);
  if (a.style && s(a.style.prompt) && !keepStyle) {
    // the writer's people and setting stay: only the look comes from the AI
    w.style = { preset: 'ai', name: s(a.style.name) || 'AI 제안', description: s(a.style.description), prompt: s(a.style.prompt), characters: s(a.style.characters), world: w.style.world ?? DEFAULT_WORLD, charactersByWriter: false };
  }
}

export interface ComposeResult { mode: Exclude<InputMode, 'auto'>; split?: SplitResult; usedAI: boolean }

/** Fills the work's 20 cards from a story. A split manuscript is placed as written; AI then only adds the extras. */
/** keepStyle: the episode already uses the series' art style, so the writer's style suggestion is not applied */
export interface SeriesContext { previous: PrevEpisode[]; keepStyle?: boolean; /** the series bible as text */ bible?: string }

/** Fills the work's 20 cards from a story. A split manuscript is placed as written; AI then only adds the extras.
 *  In a series (episode 2 and later) the earlier episodes' summaries go along, and the series' art style is kept. */
export async function compose(w: Work, story: string, mode: InputMode, outroKind: OutroKind, ai: TextAI | null, signal?: AbortSignal, split?: SplitResult, series?: SeriesContext): Promise<ComposeResult> {
  const m = mode === 'auto' ? detectMode(story) : mode;
  const cont = series && (series.previous.length || series.bible) ? { series: w.series, episode: w.episode, previous: series.previous, bible: series.bible } : {};
  const keepStyle = !!series?.keepStyle;
  w.outroKind = outroKind;
  w.source = { mode, text: story };
  if (m === 'split') {
    const sp = split ?? splitManuscript(story);
    if (!ai) {
      applyCompose(w, {}, sp);
      return { mode: m, split: sp, usedAI: false };
    }
    const a = await askJSON<ComposeAnswer>(ai, composePrompt({ mode: m, story, outroKind, fixed: sp, world: w.style.world, ...cont }), COMPOSE_SCHEMA, signal, 16000, 'compose');
    applyCompose(w, a, sp, keepStyle);
    return { mode: m, split: sp, usedAI: true };
  }
  if (!ai) throw new AiError('no_key');
  const a = await askJSON<ComposeAnswer>(ai, composePrompt({ mode: m, story, outroKind, world: w.style.world, ...cont }), COMPOSE_SCHEMA, signal, 16000, 'compose');
  if (!Array.isArray(a.cards) || a.cards.filter((c) => s(c?.text)).length < 3) throw new AiError('invalid_json');
  applyCompose(w, a, undefined, keepStyle);
  return { mode: m, usedAI: true };
}

/* ================= scenes that follow the card's words ================= */
export { changedShare, sceneStale } from '../scene';
/** Writes the scenes of these cards again from their current words, in one request. Returns how many were updated. */
export async function refreshScenes(w: Work, indices: number[], ai: TextAI, signal?: AbortSignal): Promise<number> {
  if (!indices.length) return 0;
  // the card and the words each number was sent with: the writer may move a card or change its words while the AI writes
  const sent = new Map(indices.map((i) => [i, { id: w.cards[i].id, text: w.cards[i].text }]));
  const r = await askJSON<{ scenes?: { card?: number; scene?: string }[] }>(ai, scenesPrompt(w, indices), SCENES_SCHEMA, signal, 4000, 'scene');
  let n = 0;
  for (const x of Array.isArray(r.scenes) ? r.scenes : []) {
    const was = sent.get(Number(x?.card) - 1);
    const scene = s(x?.scene);
    const card = was && w.cards.find((c) => c.id === was.id);
    if (!was || !card || !scene) continue;
    card.scene = scene;
    // written for the words that were sent: if they changed a lot meanwhile, the card still reads as needing a new scene
    card.sceneFor = was.text;
    delete card.sceneByWriter; // only stale scenes are written again, the writer's included
    n++;
  }
  return n;
}

/** What 연출 정리 answered, mapped to card ids: the scenes with the words each was written for, and the looks. */
export interface Direction { sig: string; scenes: { id: string; scene: string; sceneFor: string }[]; characters: string }

/** 연출 정리, the request: one pass over the whole story. Nothing is changed here (see applyDirection). */
export async function askDirection(w: Work, ai: TextAI, signal?: AbortSignal): Promise<Direction> {
  const sent = w.cards.map((c, i) => ({ i, id: c.id, text: c.text, kind: c.kind })).filter((x) => x.kind !== 'outro');
  const sig = textSig(w);
  const r = await askJSON<{ characters?: string; scenes?: { card?: number; scene?: string }[] }>(ai, directPrompt(w), DIRECT_SCHEMA, signal, 8000, 'direct');
  const scenes: Direction['scenes'] = [];
  for (const x of Array.isArray(r.scenes) ? r.scenes : []) {
    const at = sent.find((p) => p.i === Number(x?.card) - 1);
    const scene = s(x?.scene);
    if (at && scene) scenes.push({ id: at.id, scene, sceneFor: at.text });
  }
  return { sig, scenes, characters: s(r.characters) };
}

/** Puts a direction on a work (the one asked, or another copy of it), finding cards by id. A scene the writer typed
 *  stays while its words still fit it. Looks: the writer's own stay; the AI's are replaced; a work saved before
 *  that was recorded keeps every look it has and only gains the people it did not have. */
export function applyDirection(w: Work, d: Direction): { scenes: number; characters: boolean } {
  let scenes = 0;
  for (const x of d.scenes) {
    const card = w.cards.find((c) => c.id === x.id);
    if (!card || card.kind === 'outro' || (card.sceneByWriter && !sceneStale(card))) continue;
    card.scene = x.scene;
    card.sceneFor = x.sceneFor;
    delete card.sceneByWriter;
    scenes++;
  }
  let characters = false;
  const by = w.style.charactersByWriter;
  if (d.characters && by === false) { w.style.characters = d.characters; characters = true; }
  else if (d.characters && by === undefined) {
    const have = new Set(parseCharacters(w.style.characters).named.map((p) => p.name.toLowerCase()));
    const added = parseCharacters(d.characters).named.filter((p) => !have.has(p.name.toLowerCase()));
    if (!w.style.characters.trim()) { w.style.characters = d.characters; characters = true; }
    else if (added.length) {
      w.style.characters = [w.style.characters.trim(), ...added.map((p) => `${p.name}: ${p.desc}.`)].join('\n');
      characters = true;
    }
  }
  w.style.directedFor = d.sig;
  return { scenes, characters };
}

/** 연출 정리 on `w`: ask, then apply to the same object. */
export async function directWork(w: Work, ai: TextAI, signal?: AbortSignal): Promise<{ scenes: number; characters: boolean }> {
  return applyDirection(w, await askDirection(w, ai, signal));
}

export async function rewriteCard(w: Work, index: number, ask: string, ai: TextAI, signal?: AbortSignal): Promise<string> {
  const r = await askJSON<{ text?: string }>(ai, rewritePrompt(w, index, ask), ONE_TEXT_SCHEMA, signal, 2000, 'rewrite');
  const t = s(r.text);
  if (!t) throw new AiError('empty');
  return t;
}

/** A 3–4 sentence summary of an episode, for the next one. */
export async function summarize(w: Work, ai: TextAI, signal?: AbortSignal): Promise<string> {
  const r = await askJSON<{ text?: string }>(ai, summaryPrompt(w), ONE_TEXT_SCHEMA, signal, 1500, 'summary');
  return s(r.text);
}

export async function writeOutro(w: Work, kind: OutroKind, ai: TextAI, signal?: AbortSignal): Promise<string> {
  if (kind === 'none') return '';
  const r = await askJSON<{ text?: string }>(ai, outroPrompt(w, kind), ONE_TEXT_SCHEMA, signal, 1000, 'outro');
  return s(r.text);
}

/* ================= pictures ================= */
export interface ImageAI { provider: 'gemini' | 'openai' | 'claude' | 'canvaai'; key: string; model: string; quick?: boolean }

/** Picture-area aspect ratio of a card (width / height): the top band, or the whole card for full-bleed and quote cards. */
export const artAspect = (w: Work, index = 1): number => W / artHeight(w, w.cards[index] ?? w.cards[1]);

export interface ImageRef { mime: string; b64: string }
/** Reference pictures for one card: the character sheet (keeps people the same) and the cover (keeps the look). */
export interface CardRefs { chars?: ImageRef | null; cover?: ImageRef | null }

/** Draws one card's picture. Returns a data URL (raster) or an SVG string (Claude). */
/** Composition ideas for cover candidates, so the three pictures differ. */
export const COVER_VARIANTS = [
  'Composition idea: a close-up of the story\'s key object, dramatic light, shallow depth of field.',
  'Composition idea: a wide establishing shot of the place where the story happens, a small figure for scale.',
  'Composition idea: the main character from behind or in silhouette at the moment of tension.',
];
/** Composition ideas for a body card's two candidates: the people up close, then the whole place. */
export const CARD_VARIANTS = [
  'Composition idea: closer in, a medium shot of the people in the scene so their faces and expressions show.',
  'Composition idea: pulled back, a wide shot of the whole place and its mood, the people small in the frame.',
];

export async function drawCard(w: Work, index: number, ai: ImageAI, refs: CardRefs | null, signal?: AbortSignal, variant?: string): Promise<{ img?: string; svg?: string }> {
  const tag = variant && index === 0 ? 'cover' : undefined; // a body card's candidates count as ordinary pictures
  if (ai.provider === 'canvaai') {
    // Canva's image API takes no reference pictures: the art style and the people's looks in every prompt keep the look
    const out = await canvaAiImage({ prompt: canvaPrompt(w, index, variant), aspect: artAspect(w, index) }, signal);
    return { img: await shrinkImage(out.dataUrl) };
  }
  if (ai.provider === 'claude') {
    const text = await generateText({
      provider: 'anthropic', key: ai.key, model: ai.model,
      system: 'You draw illustrations as a single standalone SVG document and output nothing else.',
      prompt: svgPrompt(w, index, artHeight(w, w.cards[index]), ai.quick !== false) + (variant ? `\n\n${variant}` : ''),
      maxTokens: ai.quick === false ? 16000 : 8000, signal, tag: tag ?? 'svg',
    });
    const svg = sanitizeSVG(text);
    if (!svg) throw new AiError('invalid_json', 'SVG를 읽지 못했어요');
    return { svg };
  }
  const list = [refs?.chars, refs?.cover].filter((r): r is ImageRef => !!r);
  const res = await generateImage({
    provider: ai.provider, key: ai.key, model: ai.model,
    prompt: imagePrompt(w, index, { chars: !!refs?.chars, cover: !!refs?.cover }) + (variant ? `\n${variant}` : ''), aspect: artAspect(w, index), refs: list, signal, tag,
  });
  return { img: await shrinkImage(`data:${res.mime};base64,${res.b64}`) };
}

/** A character reference sheet in the work's art style, used as the first reference for every card. */
export async function drawCharacterSheet(w: Work, ai: ImageAI, signal?: AbortSignal): Promise<string> {
  if (ai.provider === 'claude' || ai.provider === 'canvaai') throw new AiError('bad_request', '인물 기준 그림은 Gemini나 GPT 이미지로 만들어요');
  const res = await generateImage({ provider: ai.provider, key: ai.key, model: ai.model, prompt: characterSheetPrompt(w), aspect: 3 / 2, refs: [], signal, tag: 'refsheet' });
  return shrinkImage(`data:${res.mime};base64,${res.b64}`);
}

export { layoutOf };

/** Keeps stored pictures small: at most 1440 px wide, WebP (JPEG where WebP encoding is missing). */
export async function shrinkImage(dataUrl: string, maxW = 1440): Promise<string> {
  try {
    const im = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const scale = Math.min(1, maxW / (im.naturalWidth || maxW));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * scale); c.height = Math.round(im.naturalHeight * scale);
    c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
    const webp = c.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.9);
  } catch {
    return dataUrl;
  }
}

/** A data URL → the {mime, b64} pair the image APIs take as a reference picture. */
export function dataUrlParts(url: string): { mime: string; b64: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(url || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}
