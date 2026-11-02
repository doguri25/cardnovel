import type { RatioKey, SavedTheme, ThemeKey } from './themes';

export const BODY_COUNT = 18;
export const TOTAL_CARDS = BODY_COUNT + 2;

export type CardKind = 'cover' | 'body' | 'outro';
export type OutroKind = 'question' | 'teaser' | 'note' | 'afterglow' | 'none';
export type ImgSource = 'gemini' | 'openai' | 'claude' | 'canva' | 'upload';
export type ImgPos = 'top' | 'center' | 'bottom';
/** stack: picture on top, words below · full: the picture fills the card, words over it · quote: one line of dialogue, large */
export type CardLayout = 'stack' | 'full' | 'quote';
/** where the words sit inside their zone; auto = the layout's own choice */
export type TextPos = 'auto' | 'top' | 'center' | 'bottom';
export type InputMode = 'auto' | 'long' | 'idea' | 'split';
export type TextProvider = 'anthropic' | 'google' | 'openai';
export type ImageProvider = 'gemini' | 'openai' | 'claude' | 'canva' | 'upload';

export interface Card {
  id: string;
  kind: CardKind;
  /** small eyebrow line above the text (series name on the cover, beat name on body cards) */
  label: string;
  showLabel: boolean;
  /** cover: the story title; body: optional sub-title */
  title: string;
  /** cover: the hook line; body: the card text; outro: the add-on line */
  text: string;
  /** what the illustration of this card shows (English, written by the text AI) */
  scene: string;
  /** turning point or emotional peak: the title and bar use the theme's accent colour */
  accent: boolean;
  svg?: string;
  img?: string;
  imgSource?: ImgSource;
  imgPos?: ImgPos;
  /** the Canva design this card's picture was made in, to export it again */
  canvaDesignId?: string;
  layout?: CardLayout;
  /** type size multiplier for this card (0.85 – 1.3); the renderer still shrinks text that does not fit */
  textScale?: number;
  textPos?: TextPos;
}

export const TEXT_SCALES: { value: number; name: string }[] = [
  { value: 0.85, name: '작게' }, { value: 1, name: '보통' }, { value: 1.15, name: '크게' }, { value: 1.3, name: '아주 크게' },
];
export const TEXT_POS_NAME: Record<TextPos, string> = { auto: '자동', top: '위', center: '가운데', bottom: '아래' };

/** Words between asterisks (*like this*) are drawn in the theme's accent colour. */
export const stripMarks = (s: string): string => String(s ?? '').replace(/\*([^*\n]+)\*/g, '$1');
export function parseMarks(s: string): { plain: string; flags: boolean[] } {
  let plain = '';
  const flags: boolean[] = [];
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const before = s.slice(last, m.index);
    plain += before + m[1];
    for (let k = 0; k < before.length; k++) flags.push(false); // one flag per UTF-16 unit, like string indices
    for (let k = 0; k < m[1].length; k++) flags.push(true);
    last = m.index + m[0].length;
  }
  const rest = s.slice(last);
  plain += rest;
  for (let k = 0; k < rest.length; k++) flags.push(false);
  return { plain, flags };
}

export type BrandPos = 'tl' | 'tr' | 'bl' | 'br';
export interface Brand {
  kind: 'logo' | 'handle';
  /** data URL of the logo (PNG with transparency works best) */
  logo?: string;
  pos: BrandPos;
  /** width of the logo as a share of the card width, in % (handle text scales with it) */
  size: number;
  opacity: number;
  /** which cards carry it */
  scope: 'all' | 'cover' | 'ends';
}
export const DEFAULT_BRAND: Brand = { kind: 'handle', pos: 'tr', size: 14, opacity: 0.75, scope: 'all' };
export const BRAND_POS_NAME: Record<BrandPos, string> = { tl: '위 왼쪽', tr: '위 오른쪽', bl: '아래 왼쪽', br: '아래 오른쪽' };
export const BRAND_SCOPE_NAME: Record<Brand['scope'], string> = { all: '모든 카드', cover: '표지만', ends: '표지와 마지막 장' };

export const LAYOUT_NAME: Record<CardLayout, string> = { stack: '기본', full: '전면 그림', quote: '대사' };

export interface ArtStyle {
  preset: string;
  name: string;
  description: string;
  /** English art direction sent to the image model */
  prompt: string;
  /** English one-liners describing the main characters, so they look the same on every card */
  characters: string;
  /** character reference picture (data URL) sent with every picture request, so faces and clothes stay the same */
  refImage?: string;
}

export type ReviewAxis = 'hook' | 'flow' | 'consistency' | 'turn' | 'ending';
export const REVIEW_AXES: Record<ReviewAxis, string> = { hook: '첫 장 흡입력', flow: '몰입·리듬', consistency: '개연성', turn: '반전·전환', ending: '결말 여운' };
export interface ReviewNote { index: number; verdict: 'good' | 'fix' | 'cut'; issue: string; suggestion: string }
export interface Review {
  at: number;
  /** card texts the review was written for, to tell when it no longer matches */
  sig: string;
  scores: Record<ReviewAxis, number>;
  summary: string;
  strengths: string[];
  notes: ReviewNote[];
  titles: { title: string; hook: string; why: string }[];
}

export interface Work {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  ratio: RatioKey;
  /** a built-in theme, or 'custom' for the writer's own theme kept in customTheme */
  theme: ThemeKey | 'custom';
  customTheme?: SavedTheme;
  /** logo or handle watermark (a copy of the brand settings, so the work renders the same anywhere) */
  brand?: Brand;
  font: string;
  series: string;
  handle: string;
  follow: string;
  outroKind: OutroKind;
  cards: Card[];
  caption: string;
  hashtags: string[];
  style: ArtStyle;
  source: { mode: InputMode; text: string };
  textAI: { provider: TextProvider; model: string };
  imageAI: { provider: ImageProvider; model: string };
  thumb?: string;
  /** episode number inside the series (1, 2, …); empty for a one-off story */
  episode?: number;
  /** a few sentences on what happens, written by the text AI, given to the next episode */
  summary?: string;
  review?: Review;
  /** the 20 cards as finished in Canva; when `on`, every output uses these pictures instead of drawing the cards */
  finished?: { designId: string; editUrl?: string; images: string[]; at: number; on: boolean };
  /** a copy of the series bible, so backups and exported files carry it */
  seriesBible?: import('./bible').SeriesBible;
}

export const OUTRO_KINDS: Record<OutroKind, { name: string; ask: string }> = {
  question: { name: '독자 질문', ask: '독자에게 던지는 질문 한 줄. 댓글로 생각을 남기고 싶어지게. 결말을 밝히지 않음' },
  teaser: { name: '다음 화 예고', ask: '다음 이야기를 궁금하게 만드는 예고 한 줄' },
  note: { name: '작가 한마디', ask: '작가가 독자에게 건네는 짧고 담백한 한마디' },
  afterglow: { name: '여운 한 줄', ask: '이야기의 여운을 남기는 문장 한 줄' },
  none: { name: '없음', ask: '' },
};

export const STYLE_PRESETS: ArtStyle[] = [
  {
    preset: 'night', name: '어두운 밤 미스터리', description: '남색·먹색 밤, 창문 불빛 한두 곳, 실루엣과 안개',
    prompt: 'Moody night-time mystery illustration. Deep navy and ink-black palette, warm light only from one or two windows or lamps, cool blue highlights, silhouettes and backlight, soft fog, rain streaks and wet reflections, dark vignette.',
    characters: 'People appear only as silhouettes or from behind, no detailed faces.',
  },
  {
    preset: 'watercolor', name: '수채 동화', description: '부드러운 수채 번짐과 따뜻한 빛의 그림책',
    prompt: 'Soft watercolor storybook illustration with visible paper texture, gentle pastel washes, loose ink outlines and warm, cozy light.',
    characters: '',
  },
  {
    preset: 'webtoon', name: '웹툰', description: '선명한 선과 셀 채색의 한국 웹툰 화풍',
    prompt: 'Clean Korean webtoon-style digital illustration, crisp line art, cel shading, expressive characters, vivid but balanced colors.',
    characters: '',
  },
  {
    preset: 'photo', name: '사진풍', description: '영화 스틸 같은 실사 느낌',
    prompt: 'Cinematic photorealistic still, 35mm film look, natural light, shallow depth of field, muted color grade.',
    characters: '',
  },
  {
    preset: 'pencil', name: '연필 스케치', description: '흑연 스케치에 색 하나만 얹은 그림',
    prompt: 'Graphite pencil sketch with light cross-hatching and a single muted accent color, sketchbook paper texture.',
    characters: '',
  },
  {
    preset: 'flat', name: '평면 일러스트', description: '단순한 도형과 적은 색의 잡지 삽화',
    prompt: 'Flat editorial illustration with simple shapes, a limited palette of four or five colors and subtle grain.',
    characters: '',
  },
];
export const presetStyle = (key: string): ArtStyle => ({ ...(STYLE_PRESETS.find((s) => s.preset === key) ?? STYLE_PRESETS[0]) });

export const DEFAULTS = {
  series: '3분 미스터리',
  handle: '@midnight.cards',
  follow: '팔로우하고 다음 이야기도 만나 보세요',
};

export const newId = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function blankCard(kind: CardKind, i = 0): Card {
  return {
    id: newId() + i,
    kind,
    label: '',
    showLabel: kind !== 'body',
    title: '',
    text: '',
    scene: '',
    accent: false,
  };
}

export interface WorkDefaults {
  series: string;
  handle: string;
  follow: string;
  theme?: ThemeKey | 'custom';
  customTheme?: SavedTheme;
  ratio?: RatioKey;
  font?: string;
  textAI?: Work['textAI'];
  imageAI?: Work['imageAI'];
}

export function newWork(d: WorkDefaults): Work {
  const cards: Card[] = [blankCard('cover')];
  for (let i = 0; i < BODY_COUNT; i++) cards.push(blankCard('body', i + 1));
  cards.push(blankCard('outro', TOTAL_CARDS));
  const now = Date.now();
  return {
    id: newId(),
    name: '',
    createdAt: now,
    updatedAt: now,
    ratio: d.ratio ?? '1:1',
    theme: d.theme === 'custom' && !d.customTheme ? 'fog' : d.theme ?? 'fog',
    ...(d.theme === 'custom' && d.customTheme ? { customTheme: { ...d.customTheme } } : {}),
    font: d.font ?? 'auto',
    series: d.series,
    handle: d.handle,
    follow: d.follow,
    outroKind: 'question',
    cards,
    caption: '',
    hashtags: [],
    style: presetStyle('night'),
    source: { mode: 'auto', text: '' },
    textAI: d.textAI ?? { provider: 'anthropic', model: '' },
    imageAI: d.imageAI ?? { provider: 'gemini', model: '' },
  };
}

/** Keeps a work loaded from storage or a file in the shape the app expects (20 cards: cover, 18 body, outro). */
export function normalizeWork(w: Omit<Partial<Work>, 'cards'> & { cards?: Partial<Card>[] }, d: WorkDefaults): Work {
  const base = newWork(d);
  const out: Work = { ...base, ...w, cards: base.cards } as Work;
  const src = Array.isArray(w.cards) ? w.cards : [];
  const cover = src.find((c) => c.kind === 'cover');
  const outro = src.find((c) => c.kind === 'outro');
  const body = src.filter((c) => c.kind === 'body');
  const fill = (c: Partial<Card> | undefined, kind: CardKind, i: number): Card => ({ ...blankCard(kind, i), ...(c ?? {}), kind });
  out.cards = [fill(cover, 'cover', 0)];
  for (let i = 0; i < BODY_COUNT; i++) out.cards.push(fill(body[i], 'body', i + 1));
  out.cards.push(fill(outro, 'outro', TOTAL_CARDS));
  if (!out.style || typeof out.style !== 'object') out.style = presetStyle('night');
  if (!Array.isArray(out.hashtags)) out.hashtags = [];
  if (!out.source) out.source = { mode: 'auto', text: '' };
  return out;
}

export const workTitle = (w: Work): string => stripMarks(w.cards[0]?.title || '').trim() || '제목 없음';
/** "3분 미스터리 · 2화" — the series line on the cover and the last card */
export const seriesLine = (w: Pick<Work, 'series' | 'episode'>): string => [w.series, w.episode ? `${w.episode}화` : ''].filter(Boolean).join(' · ');
/** a short fingerprint of the cards' words, to see whether a review still matches them */
export const textSig = (w: Work): string => {
  let h = 2166136261;
  for (const ch of w.cards.map((c) => `${c.title}|${c.text}`).join('\n')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
};
export const countChars = (s: string): number => stripMarks(s || '').replace(/\s/g, '').length;
