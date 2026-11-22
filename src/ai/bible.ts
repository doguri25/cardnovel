// Series bible with AI: pull characters / places / rules / threads out of the episodes, and check a work against it.
import type { SeriesBible } from '../bible';
import { bibleText } from '../bible';
import { stripMarks, TOTAL_CARDS, type Work } from '../model';
import type { PrevEpisode } from './prompts';
import { SYSTEM_WRITER } from './prompts';
import { AiError, generateJSON } from './providers';
import type { TextAI } from './compose';

const str = { type: 'string' } as const;
const entry = { type: 'object', additionalProperties: false, required: ['name', 'desc'], properties: { name: str, desc: str } };

export const BIBLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['characters', 'places', 'rules', 'threads'],
  properties: {
    characters: { type: 'array', items: entry },
    places: { type: 'array', items: entry },
    rules: str,
    threads: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'status', 'episode'], properties: { text: str, status: str, episode: { type: 'integer' } } } },
  },
};

export const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'issues'],
  properties: {
    summary: str,
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['card', 'kind', 'issue', 'suggestion'], properties: { card: { type: 'integer' }, kind: str, issue: str, suggestion: str } } },
  },
};

const cards = (w: Work) => w.cards
  .map((c, i) => (c.kind === 'cover' ? `01 표지 — 제목: ${stripMarks(c.title)} / 훅: ${stripMarks(c.text)}` : c.kind === 'outro' ? null : c.text.trim() ? `${String(i + 1).padStart(2, '0')} ${stripMarks(c.text)}` : null))
  .filter(Boolean).join('\n');

export function bibleFillPrompt(series: string, episodes: PrevEpisode[], current: Work | null, mine: SeriesBible): string {
  return `연재 카드소설 「${series}」의 설정집을 정리합니다. 아래 회차들에서 확인되는 사실만 뽑습니다(추측해서 지어내지 않음).

- characters: 주요 인물. name은 작품 속 이름, desc는 나이·외모·성격·관계·지금까지 한 일을 한두 문장.
- places: 반복해서 나오거나 중요한 장소. desc는 특징 한 문장.
- rules: 세계관·설정 중 앞으로도 바뀌면 안 되는 사실을 줄마다 하나씩(예: "민호는 버스 기사 20년 차", "막차는 밤 11시 40분").
- threads: 떡밥(복선·풀리지 않은 의문). text는 한 문장, status는 아직 안 풀렸으면 "open", 풀렸으면 "closed", episode는 처음 나온 회차(모르면 0).
${mine && bibleText(mine) ? `\n[지금 설정집 — 이미 있는 항목은 다시 쓰지 말고, 새로 확인된 것과 상태가 바뀐 떡밥만]\n${bibleText(mine)}\n` : ''}
[회차]
${episodes.map((e) => `${e.episode}화 「${e.title}」: ${e.summary}`).join('\n') || '(앞 회 없음)'}
${current ? `\n[지금 쓰는 ${current.episode ? `${current.episode}화` : '회차'} 카드]\n${cards(current)}` : ''}`;
}

export function checkPrompt(w: Work, bible: SeriesBible, episodes: PrevEpisode[]): string {
  return `연재 카드소설의 ${w.episode ? `${w.episode}화` : '이번 회'}가 시리즈 설정과 어긋나는 곳을 찾습니다. 문장 다듬기나 취향 문제는 빼고, 사실이 어긋나는 것만 찾습니다.

kind는 "인물"(이름·나이·외모·성격·관계가 다름), "설정"(세계관·규칙·장소와 다름), "시간"(앞 회나 이번 회 안의 시간 순서가 맞지 않음), "떡밥"(이미 풀린 떡밥을 또 풀거나, 열린 떡밥과 모순) 중 하나.
card는 카드 번호(01~${String(TOTAL_CARDS - 1).padStart(2, '0')}), issue는 무엇이 어긋나는지 한 문장, suggestion은 그 카드에 그대로 넣을 고친 문장(본문은 공백 빼고 40~90자, 표지는 훅).
어긋나는 곳이 없으면 issues는 빈 배열, summary에 그렇게 적습니다. summary는 한두 문장.

[시리즈 설정집]
${bibleText(bible) || '(비어 있음)'}

[앞 회 줄거리]
${episodes.map((e) => `${e.episode}화 「${e.title}」: ${e.summary}`).join('\n') || '(없음)'}

[이번 회 카드]
${cards(w)}`;
}

interface RawCheck { summary?: string; issues?: { card?: number; kind?: string; issue?: string; suggestion?: string }[] }
export interface CheckIssue { index: number; kind: string; issue: string; suggestion: string }
export interface CheckResult { summary: string; issues: CheckIssue[] }

export function normalizeCheck(raw: RawCheck): CheckResult {
  const t = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const issues: CheckIssue[] = [];
  for (const x of Array.isArray(raw.issues) ? raw.issues : []) {
    const index = Math.round(Number(x?.card)) - 1;
    if (!(index >= 0 && index < TOTAL_CARDS - 1) || !t(x.issue)) continue;
    issues.push({ index, kind: t(x.kind) || '설정', issue: t(x.issue), suggestion: t(x.suggestion) });
  }
  return { summary: t(raw.summary), issues: issues.slice(0, 10).sort((a, b) => a.index - b.index) };
}

async function ask<T>(ai: TextAI, prompt: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const req = { ...ai, system: SYSTEM_WRITER, prompt, schema, signal, maxTokens: 6000, tag: 'bible' as const };
  try { return await generateJSON<T>(req); } catch (e) {
    if (e instanceof AiError && e.code === 'invalid_json') return generateJSON<T>(req);
    throw e;
  }
}

export const fillBible = (ai: TextAI, series: string, episodes: PrevEpisode[], current: Work | null, mine: SeriesBible, signal?: AbortSignal) =>
  ask<Partial<SeriesBible>>(ai, bibleFillPrompt(series, episodes, current, mine), BIBLE_SCHEMA, signal);

export const checkAgainstBible = async (ai: TextAI, w: Work, bible: SeriesBible, episodes: PrevEpisode[], signal?: AbortSignal) =>
  normalizeCheck(await ask<RawCheck>(ai, checkPrompt(w, bible, episodes), CHECK_SCHEMA, signal));
