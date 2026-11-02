// 일괄 교정: spelling, spacing and punctuation across all 20 cards (and the caption) in one call,
// optionally unifying the narration's speech level. Only fixes; the story and its wording stay the writer's.
import { TOTAL_CARDS, type Work } from '../model';
import { AiError } from './providers';
import { askJSON, type TextAI } from './compose';

export type ProofTone = 'keep' | 'hada' | 'haeyo';
export const PROOF_TONE_NAME: Record<ProofTone, string> = { keep: '말투 그대로', hada: '하다체로 통일', haeyo: '해요체로 통일' };
export type ProofKind = 'spelling' | 'spacing' | 'punct' | 'tone' | 'word';
export const PROOF_KIND_NAME: Record<ProofKind, string> = { spelling: '맞춤법', spacing: '띄어쓰기', punct: '문장부호', tone: '말투', word: '표현' };
const KINDS = Object.keys(PROOF_KIND_NAME) as ProofKind[];

export type ProofField = 'title' | 'text' | 'caption';
export interface ProofSpot { key: string; index: number; field: ProofField; label: string; value: string }
export interface ProofItem {
  key: string; index: number; field: ProofField; label: string;
  /** the words as they were checked; the fix applies only while the card still says this */
  from: string;
  to: string;
  changes: { kind: ProofKind; from: string; to: string }[];
  /** the AI dropped an *emphasis* mark that could not be put back */
  lostMarks?: boolean;
}
export interface ProofResult { at: number; workId: string; tone: ProofTone; checked: number; items: ProofItem[]; summary: string }

const num = (i: number) => String(i + 1).padStart(2, '0');

/** Everything with words: cover title and hook, body sub-titles and texts, the last card's add-on line, the caption. */
export function proofSpots(w: Work): ProofSpot[] {
  const out: ProofSpot[] = [];
  w.cards.forEach((c, i) => {
    const n = num(i);
    if (c.kind === 'outro' && w.outroKind === 'none') return;
    if (c.title.trim()) out.push({ key: `${i + 1}t`, index: i, field: 'title', label: c.kind === 'cover' ? `${n} 표지 제목` : `${n} 소제목`, value: c.title });
    if (c.text.trim()) out.push({ key: `${i + 1}`, index: i, field: 'text', label: c.kind === 'cover' ? `${n} 표지 훅` : c.kind === 'outro' ? `${n} 마지막 장` : n, value: c.text });
  });
  if (w.caption.trim()) out.push({ key: 'cap', index: -1, field: 'caption', label: '캡션', value: w.caption });
  return out;
}

export const spotValue = (w: Work, s: Pick<ProofSpot, 'index' | 'field'>): string =>
  s.field === 'caption' ? w.caption : w.cards[s.index]?.[s.field] ?? '';

const str = { type: 'string' } as const;
export const PROOF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fixes', 'summary'],
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'corrected', 'changes'],
        properties: {
          id: str,
          corrected: str,
          changes: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['kind', 'from', 'to'], properties: { kind: { type: 'string', enum: KINDS }, from: str, to: str } },
          },
        },
      },
    },
    summary: str,
  },
};

const TONE_RULE: Record<ProofTone, string> = {
  keep: '- 말투(문장 끝맺음)는 바꾸지 않습니다.',
  hada: '- 따옴표 밖 서술 문장의 끝맺음을 하다체(~했다, ~이다, ~한다)로 맞춥니다. 따옴표 안 대사와 제목은 그대로 둡니다. 이렇게 바꾼 곳의 kind는 tone입니다.',
  haeyo: '- 따옴표 밖 서술 문장의 끝맺음을 해요체(~했어요, ~이에요, ~해요)로 맞춥니다. 따옴표 안 대사와 제목은 그대로 둡니다. 이렇게 바꾼 곳의 kind는 tone입니다.',
};

export function proofPrompt(spots: ProofSpot[], tone: ProofTone): string {
  const lines = spots.map((s) => `[${s.key}] (${s.label}) ${s.value.replace(/\n/g, '\\n')}`).join('\n');
  return `아래는 인스타그램 카드소설의 글입니다. 교정자로서 틀린 곳만 바로잡습니다.

규칙:
- 고칠 곳이 있는 항목만 fixes에 넣습니다. 고칠 것이 없는 항목은 넣지 않습니다.
- id는 각 줄 맨 앞 [ ] 안의 값을 그대로 씁니다.
- corrected는 고친 뒤의 그 항목 전체 글입니다. 내용·문체·길이·줄바꿈(\\n)은 그대로 두고 틀린 곳만 고칩니다. 문장을 새로 쓰거나 더 좋게 다듬지 않습니다.
- *별표*로 감싼 강조 표시는 그대로 둡니다(별표 안의 맞춤법은 고쳐도 됩니다).
- 작가가 일부러 쓴 말줄임(…), 구어체, 의성어·의태어, 사투리, 인물의 말버릇은 틀린 것으로 보지 않습니다.
- 숫자, 고유명사, 인물 이름, 해시태그는 바꾸지 않습니다.
- 표준 맞춤법과 띄어쓰기(국립국어원 기준)를 따릅니다. 애매하면 고치지 않습니다.
${TONE_RULE[tone]}
- changes: 고친 곳마다 kind(spelling 맞춤법, spacing 띄어쓰기, punct 문장부호, tone 말투, word 뜻이 틀린 낱말), from(원래 부분), to(고친 부분). 짧게.
- summary: 전체 교정 결과 한두 문장(한국어).

[글]
${lines}`;
}

const t = (v: unknown) => (typeof v === 'string' ? v.replace(/\\n/g, '\n').trim() : '');
const MARK = /\*([^*\n]+)\*/g;
const marksOf = (s: string) => [...s.matchAll(MARK)].map((m) => m[1]);

/** Puts back *emphasis* marks the AI dropped, where the marked words are still there. */
export function keepMarks(orig: string, fixed: string): { text: string; lost: boolean } {
  const want = marksOf(orig);
  if (!want.length || marksOf(fixed).length === want.length) return { text: fixed, lost: false };
  let plain = fixed.replace(MARK, '$1'), from = 0, lost = false;
  for (const w of want) {
    const at = plain.indexOf(w, from);
    if (at < 0) { lost = true; continue; }
    plain = plain.slice(0, at) + `*${w}*` + plain.slice(at + w.length);
    from = at + w.length + 2;
  }
  return { text: plain, lost };
}

interface RawProof { fixes?: { id?: string; corrected?: string; changes?: { kind?: string; from?: string; to?: string }[] }[]; summary?: string }

/** Keeps fixes for real spots that actually change something and stay about the same length (a fix, not a rewrite). */
export function normalizeProof(raw: RawProof, w: Work, spots: ProofSpot[], tone: ProofTone, at = Date.now()): ProofResult {
  const byKey = new Map(spots.map((s) => [s.key, s]));
  const items: ProofItem[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(raw.fixes) ? raw.fixes : []) {
    const key = String(f?.id ?? '').replace(/^\[|\]$/g, '').trim();
    const spot = byKey.get(key);
    if (!spot || seen.has(key)) continue;
    let to = t(f.corrected);
    if (!to || to === spot.value.trim()) continue;
    const plainA = spot.value.replace(MARK, '$1').replace(/\s/g, ''), plainB = to.replace(MARK, '$1').replace(/\s/g, '');
    if (Math.abs(plainA.length - plainB.length) > Math.max(6, plainA.length * 0.35)) continue; // a rewrite, not a fix
    const kept = keepMarks(spot.value, to);
    to = kept.text;
    if (to === spot.value) continue;
    seen.add(key);
    const changes = (Array.isArray(f.changes) ? f.changes : [])
      .map((c) => ({ kind: (KINDS.includes(c?.kind as ProofKind) ? c!.kind : 'spelling') as ProofKind, from: t(c?.from), to: t(c?.to) }))
      .filter((c) => c.from || c.to)
      .slice(0, 8);
    items.push({ key, index: spot.index, field: spot.field, label: spot.label, from: spot.value, to, changes, ...(kept.lost ? { lostMarks: true } : {}) });
  }
  const order = (i: ProofItem) => (i.index < 0 ? TOTAL_CARDS : i.index) * 2 + (i.field === 'title' ? 0 : 1);
  items.sort((a, b) => order(a) - order(b));
  return { at, workId: w.id, tone, checked: spots.length, items, summary: t(raw.summary) };
}

export async function proofWork(w: Work, ai: TextAI, tone: ProofTone, signal?: AbortSignal): Promise<ProofResult> {
  const spots = proofSpots(w);
  if (spots.filter((s) => s.field === 'text').length < 2) throw new AiError('bad_request', '교정할 글이 없어요. 카드를 먼저 채워 주세요');
  const raw = await askJSON<RawProof>(ai, proofPrompt(spots, tone), PROOF_SCHEMA, signal, 12000, 'proof');
  return normalizeProof(raw, w, spots, tone);
}

/** Puts one fix into the work if that spot still says what was checked. */
export function applyProof(w: Work, item: ProofItem): boolean {
  if (spotValue(w, item) !== item.from) return false;
  if (item.field === 'caption') w.caption = item.to; else w.cards[item.index][item.field] = item.to;
  return true;
}
