// AI가 쓴 티가 나는 기계식 표현: stock phrases that make a text read as pasted from an AI — mechanical numbering,
// formula conclusions, empty evaluation, inflated words, and the "~가 아니라 ~다" contrast used again and again.
import type { Work } from './model';

export type ToneKind = 'numbering' | 'conclusion' | 'empty' | 'hype' | 'contrast';
export interface ToneHit { where: number | 'caption'; phrase: string; kind: ToneKind }

const PATTERNS: { kind: ToneKind; re: RegExp }[] = [
  { kind: 'conclusion', re: /결론적으로|요약하자면|요약하면|정리하자면|종합하자면/g },
  { kind: 'empty', re: /시사하는 (?:바|점)|시사점/g },
  { kind: 'hype', re: /단순(?:한|히) [가-힣]+(?: [가-힣]+)?(?:을|를) 넘어|새로운 패러다임|패러다임(?:의)? 전환/g },
];
const NUMBERING = /(?:^|[\s"'“(])첫째[\s,.:]/;
const SECOND = /(?:^|[\s"'“(])둘째[\s,.:]/;
const CONTRAST = /[가-힣]+(?:이|가) 아니라\s/g;
/** one "~가 아니라 ~다" is ordinary in a story; this many across the work reads as a habit */
const CONTRAST_REPEAT = 3;

/** The texts that go out with the post: every card's title and words, and the caption. */
function texts(w: Work): { where: number | 'caption'; text: string }[] {
  const out: { where: number | 'caption'; text: string }[] = w.cards.map((c, i) => ({ where: i as number | 'caption', text: [c.title, c.text].filter(Boolean).join('\n').replace(/\*/g, '') }));
  if (w.caption.trim()) out.push({ where: 'caption', text: w.caption });
  return out;
}

/** Where such phrases are, in card order, the caption last. */
export function aiToneHits(w: Work): ToneHit[] {
  const hits: ToneHit[] = [];
  const contrast: ToneHit[] = [];
  for (const { where, text } of texts(w)) {
    for (const p of PATTERNS) for (const m of text.matchAll(p.re)) hits.push({ where, phrase: m[0], kind: p.kind });
    if (NUMBERING.test(text) && SECOND.test(text)) hits.push({ where, phrase: '첫째·둘째', kind: 'numbering' });
    for (const m of text.matchAll(CONTRAST)) contrast.push({ where, phrase: m[0].trim(), kind: 'contrast' });
  }
  const all = contrast.length >= CONTRAST_REPEAT ? [...hits, ...contrast] : hits;
  const order = (h: ToneHit) => (h.where === 'caption' ? 1e6 : h.where);
  return all.map((h, k) => ({ h, k })).sort((a, b) => order(a.h) - order(b.h) || a.k - b.k).map((x) => x.h);
}
