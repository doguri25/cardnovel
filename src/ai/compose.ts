// Story → 20 cards, card rewrites, outro line and pictures, on top of the provider adapter.
import { BODY_COUNT, type ArtStyle, type InputMode, type OutroKind, type Work } from '../model';
import { detectMode, splitManuscript, type SplitResult } from '../parse';
import { canvaAiImage } from '../canva';
import { artHeight, layoutOf, sanitizeSVG, W } from '../render';
import { AiError, generateImage, generateJSON, generateText, type TextRequest, type UsageTag } from './providers';
import { COMPOSE_SCHEMA, ONE_TEXT_SCHEMA, SYSTEM_WRITER, characterSheetPrompt, composePrompt, imagePrompt, outroPrompt, rewritePrompt, summaryPrompt, svgPrompt, type PrevEpisode } from './prompts';

export interface TextAI { provider: TextRequest['provider']; key: string; model: string }

interface ComposeAnswer {
  title?: string; hook?: string;
  cards?: { label?: string; title?: string; text?: string; scene?: string; accent?: boolean }[];
  outro?: string; caption?: string; hashtags?: string[];
  style?: Partial<ArtStyle>; coverScene?: string; summary?: string;
}

const s = (v: unknown) => (typeof v === 'string' ? v : '').replace(/\\n/g, '\n').trim();

/** Retries once with a smaller output budget for models that do not accept 16k output tokens. */
export async function askJSON<T>(ai: TextAI, prompt: string, schema: Record<string, unknown>, signal?: AbortSignal, maxTokens = 16000, tag: UsageTag = 'other'): Promise<T> {
  const req = { ...ai, system: SYSTEM_WRITER, prompt, schema, signal, maxTokens, tag };
  try {
    return await generateJSON<T>(req);
  } catch (e) {
    if (e instanceof AiError && e.code === 'bad_request' && /max_tokens|max_completion_tokens|maxOutputTokens|output tokens/i.test(e.message) && maxTokens > 8000) {
      return generateJSON<T>({ ...req, maxTokens: 8000 });
    }
    if (e instanceof AiError && e.code === 'invalid_json') return generateJSON<T>(req); // one more try
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
  for (let i = 0; i < BODY_COUNT; i++) {
    const c = w.cards[i + 1];
    const src = cards[i] ?? {};
    const keep = fixed?.body[i];
    c.text = keep && keep.text ? keep.text : s(src.text);
    c.label = (keep && keep.label) || s(src.label);
    c.title = s(src.title);
    c.scene = s(src.scene);
    c.accent = !!src.accent;
    c.showLabel = false;
  }
  const outro = w.cards[w.cards.length - 1];
  outro.text = w.outroKind === 'none' ? '' : s(fixed?.outro) || s(a.outro);
  w.caption = s(a.caption);
  w.summary = s(a.summary) || w.summary;
  w.hashtags = (Array.isArray(a.hashtags) ? a.hashtags : []).map((t) => s(t)).filter(Boolean).map((t) => (t.startsWith('#') ? t : '#' + t)).slice(0, 10);
  if (a.style && s(a.style.prompt) && !keepStyle) {
    w.style = { preset: 'ai', name: s(a.style.name) || 'AI 제안', description: s(a.style.description), prompt: s(a.style.prompt), characters: s(a.style.characters) };
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
    const a = await askJSON<ComposeAnswer>(ai, composePrompt({ mode: m, story, outroKind, fixed: sp, ...cont }), COMPOSE_SCHEMA, signal, 16000, 'compose');
    applyCompose(w, a, sp, keepStyle);
    return { mode: m, split: sp, usedAI: true };
  }
  if (!ai) throw new AiError('no_key');
  const a = await askJSON<ComposeAnswer>(ai, composePrompt({ mode: m, story, outroKind, ...cont }), COMPOSE_SCHEMA, signal, 16000, 'compose');
  if (!Array.isArray(a.cards) || a.cards.filter((c) => s(c?.text)).length < 3) throw new AiError('invalid_json');
  applyCompose(w, a, undefined, keepStyle);
  return { mode: m, usedAI: true };
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
/** Reference pictures for one card: the character sheet (keeps people the same) and the cover (keeps the look).
 *  Canva AI takes pictures already in Canva instead: `canvaCover` is the media id of a cover Canva AI drew. */
export interface CardRefs { chars?: ImageRef | null; cover?: ImageRef | null; canvaCover?: string }

/** Draws one card's picture. Returns a data URL (raster) or an SVG string (Claude). */
/** Composition ideas for cover candidates, so the three pictures differ. */
export const COVER_VARIANTS = [
  'Composition idea: a close-up of the story\'s key object, dramatic light, shallow depth of field.',
  'Composition idea: a wide establishing shot of the place where the story happens, a small figure for scale.',
  'Composition idea: the main character from behind or in silhouette at the moment of tension.',
];

export async function drawCard(w: Work, index: number, ai: ImageAI, refs: CardRefs | null, signal?: AbortSignal, variant?: string): Promise<{ img?: string; svg?: string; mediaId?: string }> {
  const tag = variant ? 'cover' : undefined;
  if (ai.provider === 'canvaai') {
    const cover = index !== 0 ? refs?.canvaCover : undefined;
    const out = await canvaAiImage({
      prompt: imagePrompt(w, index, { cover: !!cover }) + (variant ? `\n${variant}` : ''),
      aspect: artAspect(w, index), refs: cover ? [cover] : [],
    }, signal);
    return { img: await shrinkImage(out.dataUrl), mediaId: out.mediaId };
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
