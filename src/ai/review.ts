// AI review: five genre-neutral scores, cards to fix with a ready rewrite, and title/hook ideas.
import { BODY_COUNT, REVIEW_AXES, TOTAL_CARDS, textSig, type Review, type ReviewAxis, type ReviewNote, type Work } from '../model';
import { AiError, generateJSON } from './providers';
import { SYSTEM_WRITER } from './prompts';
import type { TextAI } from './compose';

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const AXES = Object.keys(REVIEW_AXES) as ReviewAxis[];

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'summary', 'strengths', 'notes', 'titles'],
  properties: {
    scores: { type: 'object', additionalProperties: false, required: AXES, properties: Object.fromEntries(AXES.map((a) => [a, int])) },
    summary: str,
    strengths: { type: 'array', items: str },
    notes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['card', 'verdict', 'issue', 'suggestion'],
        properties: { card: int, verdict: str, issue: str, suggestion: str },
      },
    },
    titles: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['title', 'hook', 'why'], properties: { title: str, hook: str, why: str } },
    },
  },
};

const num = (i: number) => String(i + 1).padStart(2, '0');

/** `history`: what past posts did (see reviewHistory in posts.ts), so title and hook advice fits this writer's readers */
export function reviewPrompt(w: Work, history = ''): string {
  const lines = w.cards.map((c, i) => {
    if (c.kind === 'cover') return `${num(i)} 표지 — 제목: ${c.title || '(없음)'} / 훅: ${c.text || '(없음)'}`;
    if (c.kind === 'outro') return w.outroKind === 'none' || !c.text.trim() ? null : `${num(i)} 마지막 장 덧붙임: ${c.text}`;
    return `${num(i)}${c.title ? ` [${c.title}]` : ''} ${c.text || '(비어 있음)'}`;
  }).filter(Boolean).join('\n');
  return `아래 인스타그램 카드소설(표지 1 · 본문 ${BODY_COUNT} · 마지막 1, 카드 한 장씩 넘겨 읽음)을 편집자로서 평가합니다. 장르는 따지지 않습니다.

점수(각 0~20 정수, 냉정하게; 보통 수준이면 12 안팎):
- hook(첫 장 흡입력): 표지 제목·훅과 첫 2장이 넘기고 싶게 만드는가.
- flow(몰입·리듬): 카드마다 새 정보가 하나씩 있고, 넘길 때마다 다음이 궁금한가. 늘어지는 곳이 없는가.
- consistency(개연성): 인물의 행동·설정·시간 순서가 맞는가.
- turn(반전·전환): 이야기를 뒤집거나 깊게 만드는 순간이 제자리에 있는가.
- ending(결말 여운): 결말이 앞의 실마리를 거두고 여운을 남기는가.

나머지:
- summary: 총평 2~3문장(한국어).
- strengths: 잘된 점 2~3개(각 한 문장).
- notes: 고치면 가장 좋아질 카드 최대 6개(본문 02~${num(TOTAL_CARDS - 2)}, 표지 01 포함 가능). card는 카드 번호(정수), verdict는 "fix"(문장을 다듬으면 됨) 또는 "cut"(군더더기라 다른 내용으로 바꾸는 게 나음), issue는 무엇이 문제인지 한 문장, suggestion은 그 카드에 그대로 넣을 새 문장(본문은 공백 빼고 40~90자, 표지는 훅 25자 이내; 앞뒤 카드와 이어지게).
  AI가 쓴 티가 나는 기계식 표현(기계식 번호, "결론적으로" 같은 끝맺음 공식, "시사하는 바가 크다" 같은 빈 평가, "새로운 패러다임" 같은 과장, 되풀이되는 "~가 아니라 ~다")이 있는 카드는 꼭 짚고, 담백한 문장으로 바꿔 제안합니다.
- titles: 제목과 훅 후보 3쌍. title 2~14자, hook 25자 이내, why는 그 후보가 좋은 이유 한 줄.

[카드]
${lines}${history ? `

${history}` : ''}`;
}

interface RawReview {
  scores?: Partial<Record<ReviewAxis, number>>;
  summary?: string; strengths?: string[];
  notes?: { card?: number; verdict?: string; issue?: string; suggestion?: string }[];
  titles?: { title?: string; hook?: string; why?: string }[];
}

const t = (v: unknown) => (typeof v === 'string' ? v.replace(/\\n/g, '\n').trim() : '');

/** Cleans an AI answer: scores clamped to 0–20, notes only for real cards, at most 6 notes and 3 titles. */
export function normalizeReview(raw: RawReview, w: Work, at = Date.now()): Review {
  const scores = Object.fromEntries(AXES.map((a) => {
    const v = Math.round(Number(raw.scores?.[a]));
    return [a, Number.isFinite(v) ? Math.max(0, Math.min(20, v)) : 0];
  })) as Record<ReviewAxis, number>;
  const seen = new Set<number>();
  const notes: ReviewNote[] = [];
  for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
    const index = Math.round(Number(n?.card)) - 1;
    if (!(index >= 0 && index < TOTAL_CARDS - 1) || seen.has(index)) continue; // the last card is fixed words plus one add-on line
    const issue = t(n.issue), suggestion = t(n.suggestion);
    if (!issue && !suggestion) continue;
    seen.add(index);
    notes.push({ index, verdict: n.verdict === 'cut' ? 'cut' : 'fix', issue, suggestion });
    if (notes.length >= 6) break;
  }
  notes.sort((a, b) => a.index - b.index);
  return {
    at,
    sig: textSig(w),
    scores,
    summary: t(raw.summary),
    strengths: (Array.isArray(raw.strengths) ? raw.strengths : []).map(t).filter(Boolean).slice(0, 3),
    notes,
    titles: (Array.isArray(raw.titles) ? raw.titles : []).map((x) => ({ title: t(x?.title), hook: t(x?.hook), why: t(x?.why) })).filter((x) => x.title).slice(0, 3),
  };
}

export const totalScore = (r: Review): number => AXES.reduce((n, a) => n + (r.scores[a] || 0), 0);

export async function reviewWork(w: Work, ai: TextAI, signal?: AbortSignal, history = ''): Promise<Review> {
  const body = w.cards.filter((c) => c.kind === 'body' && c.text.trim()).length;
  if (body < 6) throw new AiError('bad_request', '본문을 6장 이상 채운 뒤 평가해 주세요');
  const req = { ...ai, system: SYSTEM_WRITER, prompt: reviewPrompt(w, history), schema: REVIEW_SCHEMA, signal, maxTokens: 6000, tag: 'review' as const };
  let raw: RawReview;
  try { raw = await generateJSON<RawReview>(req); } catch (e) {
    if (e instanceof AiError && e.code === 'invalid_json') raw = await generateJSON<RawReview>(req); else throw e;
  }
  const r = normalizeReview(raw, w);
  if (!r.summary && !r.notes.length && !totalScore(r)) throw new AiError('invalid_json');
  const past = history.match(/\((\d+)편\)/);
  if (past) r.history = Number(past[1]);
  return r;
}
