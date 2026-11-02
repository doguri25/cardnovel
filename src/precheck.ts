// 게시 전 점검: what is worth fixing before the 20 cards go up — empty or overlong cards, stray emphasis marks,
// missing pictures, a caption over Instagram's limits, proofreading left undone, a 9:16 feed post.
import { captionText } from './export';
import { countChars, textSig, type Work } from './model';
import { contrast, themeOfWork } from './themes';

export type CheckLevel = 'error' | 'warn' | 'info';
/** where the 「보기」 button takes the writer */
export type CheckGo = 'card' | 'caption' | 'proof' | 'review' | 'look' | 'story';
export interface CheckItem { id: string; level: CheckLevel; text: string; cards?: number[]; go?: CheckGo }
export interface CheckContext {
  /** this session's proofreading of this work: whether it ran, and fixes not applied yet */
  proof?: { ran: boolean; open: number };
}

export const CAPTION_LIMIT = 2200;
export const HASHTAG_LIMIT = 30;
const num = (i: number) => String(i + 1).padStart(2, '0');
export const cardList = (cards: number[]): string => cards.slice(0, 6).map(num).join(', ') + (cards.length > 6 ? ` 외 ${cards.length - 6}장` : '');

/** asterisks left over once the *pairs* are taken out: they would be printed as they are */
const strayStar = (s: string) => /\*/.test(String(s || '').replace(/\*([^*\n]+)\*/g, '$1'));

export function precheck(w: Work, ctx: CheckContext = {}): CheckItem[] {
  const out: CheckItem[] = [];
  const add = (i: CheckItem) => out.push(i);
  const body = w.cards.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'body');
  const cover = w.cards[0], outro = w.cards[w.cards.length - 1];
  const finished = !!w.finished?.on;

  if (!body.some((x) => x.c.text.trim())) {
    add({ id: 'nothing', level: 'error', text: '아직 카드 글이 없어요. 이야기를 넣고 「카드로 만들기」를 눌러 주세요.', go: 'story' });
    return out;
  }
  const empty = body.filter((x) => !x.c.text.trim()).map((x) => x.i);
  if (empty.length) add({ id: 'empty', level: 'error', text: `본문이 빈 카드가 ${empty.length}장 있어요 (${cardList(empty)}).`, cards: empty, go: 'card' });
  if (!cover.title.trim()) add({ id: 'title', level: 'error', text: '표지 제목이 비어 있어요.', cards: [0], go: 'card' });
  if (!cover.text.trim()) add({ id: 'hook', level: 'warn', text: '표지 훅(한 줄)이 비어 있어요. 첫 장에서 넘기게 만드는 문장이에요.', cards: [0], go: 'card' });
  if (w.outroKind !== 'none' && !outro.text.trim()) add({ id: 'outro', level: 'warn', text: '마지막 장 덧붙임이 비어 있어요.', cards: [w.cards.length - 1], go: 'card' });

  const long = w.cards.map((c, i) => ({ c, i, n: countChars(c.text) }))
    .filter((x) => x.n > (x.c.kind === 'cover' ? 30 : x.c.kind === 'outro' ? 60 : 90)).map((x) => x.i);
  if (long.length) add({ id: 'long', level: 'warn', text: `글이 길어 글씨가 작아지는 카드가 ${long.length}장 있어요 (${cardList(long)}).`, cards: long, go: 'card' });
  const short = body.filter((x) => { const n = countChars(x.c.text); return n > 0 && n < 25; }).map((x) => x.i);
  if (short.length) add({ id: 'short', level: 'info', text: `아주 짧은 카드가 ${short.length}장 있어요 (${cardList(short)}). 일부러 그런 거면 괜찮아요.`, cards: short, go: 'card' });

  const stars = w.cards.map((c, i) => ({ i, bad: strayStar(c.text) || strayStar(c.title) })).filter((x) => x.bad).map((x) => x.i);
  if (stars.length) add({ id: 'stars', level: 'warn', text: `강조 표시 별표(*)의 짝이 맞지 않아 별표가 그대로 보이는 카드가 있어요 (${cardList(stars)}).`, cards: stars, go: 'card' });

  const seen = new Map<string, number>();
  const dup: number[] = [];
  for (const x of body) {
    const k = x.c.text.replace(/\s+/g, ' ').trim();
    if (!k) continue;
    if (seen.has(k)) dup.push(x.i); else seen.set(k, x.i);
  }
  if (dup.length) add({ id: 'dup', level: 'warn', text: `앞 카드와 글이 똑같은 카드가 있어요 (${cardList(dup)}).`, cards: dup, go: 'card' });

  if (finished) {
    add({ id: 'finished', level: 'info', text: 'Canva 마감본 그림으로 내보내요. 여기서 고친 글은 마감본에 들어가지 않아요.', go: 'look' });
  } else {
    const drawn = [cover, ...body.map((x) => x.c)];
    const bare = [0, ...body.map((x) => x.i)].filter((i) => !w.cards[i].img && !w.cards[i].svg);
    if (bare.length && bare.length < drawn.length) add({ id: 'pics', level: 'warn', text: `그림 없는 카드가 ${bare.length}장 있어요 (${cardList(bare)}).`, cards: bare, go: 'card' });
    else if (bare.length === drawn.length) add({ id: 'nopics', level: 'info', text: '그림 없이 글만 있는 카드예요. 그대로 올려도 되고, 「모든 그림 그리기」로 그릴 수도 있어요.', go: 'card', cards: [0] });
    const t = themeOfWork(w);
    if (contrast(t.text, t.bg[0]) < 4.5 || contrast(t.text, t.bg[1]) < 4.5) add({ id: 'contrast', level: 'warn', text: '테마의 글자색과 배경색 대비가 낮아 폰에서 읽기 어려울 수 있어요.', go: 'look' });
  }
  if (w.ratio === '9:16') add({ id: 'ratio', level: 'warn', text: '9:16은 피드 게시물에서 위아래가 잘려 보여요. 게시물은 4:5나 1:1, 릴스는 9:16이 알맞아요.', go: 'look' });

  const cap = captionText(w);
  const tags = w.hashtags.length;
  if (!w.caption.trim()) add({ id: 'caption', level: 'warn', text: '캡션 본문이 비어 있어요. 기본 문구가 들어가요.', go: 'caption' });
  if (cap.length > CAPTION_LIMIT) add({ id: 'capLong', level: 'error', text: `캡션이 ${cap.length.toLocaleString()}자로 인스타 한도(${CAPTION_LIMIT.toLocaleString()}자)를 넘어요.`, go: 'caption' });
  if (tags > HASHTAG_LIMIT) add({ id: 'tagsMany', level: 'error', text: `해시태그가 ${tags}개예요. 인스타는 ${HASHTAG_LIMIT}개까지만 받아요.`, go: 'caption' });
  if (!tags) add({ id: 'tagsNone', level: 'info', text: '해시태그가 없어 기본 태그 4개가 들어가요.', go: 'caption' });

  if (ctx.proof?.open) add({ id: 'proofOpen', level: 'warn', text: `일괄 교정에서 아직 적용하지 않은 곳이 ${ctx.proof.open}곳 있어요.`, go: 'proof' });
  else if (ctx.proof && !ctx.proof.ran) add({ id: 'proofNone', level: 'info', text: '맞춤법·띄어쓰기를 아직 일괄 교정하지 않았어요.', go: 'proof' });
  if (!w.review) add({ id: 'review', level: 'info', text: 'AI 평가를 아직 받지 않았어요.', go: 'review' });
  else if (w.review.sig !== textSig(w)) add({ id: 'reviewOld', level: 'info', text: 'AI 평가 뒤에 글이 바뀌었어요.', go: 'review' });
  if (!w.handle.trim()) add({ id: 'handle', level: 'info', text: '작가 핸들이 비어 있어 표지와 마지막 장에 계정 이름이 나오지 않아요.', go: 'look' });

  const rank: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

export const countLevel = (items: CheckItem[], level: CheckLevel): number => items.filter((i) => i.level === level).length;
