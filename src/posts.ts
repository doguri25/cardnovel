// Posting log and performance: the numbers the writer typed in for each post, compared across works —
// which covers, hooks, themes, days and hours did well — and a short summary for the AI review.
import { LAYOUT_NAME, POST_KIND_NAME, POST_METRICS, stripMarks, workTitle, type PostMetric, type PostRecord, type Work } from './model';
import { themeOfWork } from './themes';

export interface PostRow {
  workId: string;
  postId: string;
  title: string;
  hook: string;
  series: string;
  episode?: number;
  theme: string;
  coverLayout: string;
  kind: PostRecord['kind'];
  at: number;
  weekday: number;
  hour: number;
  reach: number | null; likes: number; comments: number; saves: number; shares: number; follows: number;
  /** likes + comments + saves + shares */
  interactions: number;
  /** interactions per reach (0–1), when reach was entered */
  rate: number | null;
  /** interactions weighted toward what Instagram values most (comments, saves, shares, follows) */
  score: number;
  url: string;
}

const v = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
/** a post counts once any number is in */
export const hasNumbers = (p: PostRecord): boolean => (Object.keys(POST_METRICS) as PostMetric[]).some((k) => typeof p[k] === 'number');

export function rowOf(w: Work, p: PostRecord): PostRow {
  const d = new Date(p.at);
  const likes = v(p.likes), comments = v(p.comments), saves = v(p.saves), shares = v(p.shares), follows = v(p.follows);
  const interactions = likes + comments + saves + shares;
  const reach = typeof p.reach === 'number' && p.reach > 0 ? p.reach : null;
  return {
    workId: w.id, postId: p.id,
    title: workTitle(w), hook: stripMarks(w.cards[0]?.text || '').trim(),
    series: w.series, episode: w.episode,
    theme: themeOfWork(w).name + (w.theme === 'custom' ? ' (내 테마)' : ''),
    coverLayout: LAYOUT_NAME[w.cards[0]?.layout ?? 'stack'],
    kind: p.kind, at: p.at, weekday: d.getDay(), hour: d.getHours(),
    reach, likes, comments, saves, shares, follows, interactions,
    rate: reach ? Math.min(1, interactions / reach) : null,
    score: likes + 2 * comments + 3 * saves + 3 * shares + 5 * follows,
    url: p.url,
  };
}

/** Every post with numbers, newest first. */
export const collectRows = (all: Work[]): PostRow[] =>
  all.flatMap((w) => (w.posts ?? []).filter(hasNumbers).map((p) => rowOf(w, p))).sort((a, b) => b.at - a.at);

/** Rate where reach was entered, otherwise the weighted score: the measure everything is ranked by. */
export const usesRate = (rows: PostRow[]): boolean => rows.filter((r) => r.rate !== null).length >= Math.max(1, rows.length / 2);
export const measure = (r: PostRow, rate: boolean): number => (rate ? r.rate ?? -1 : r.score);

export const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
export const HOUR_BANDS: { name: string; from: number; to: number }[] = [
  { name: '새벽 (0–5시)', from: 0, to: 5 }, { name: '아침 (6–10시)', from: 6, to: 10 }, { name: '낮 (11–16시)', from: 11, to: 16 },
  { name: '저녁 (17–20시)', from: 17, to: 20 }, { name: '밤 (21–23시)', from: 21, to: 23 },
];
export const hourBand = (h: number): string => HOUR_BANDS.find((b) => h >= b.from && h <= b.to)?.name ?? '';

export interface Group { key: string; n: number; value: number }
/** Average of the measure per group (rate: only posts with reach), best first; ties keep the order given. */
export function groupBy(rows: PostRow[], key: (r: PostRow) => string, rate: boolean, order?: string[]): Group[] {
  const m = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    if (rate && r.rate === null) continue;
    const k = key(r);
    const g = m.get(k) ?? { n: 0, sum: 0 };
    g.n++; g.sum += measure(r, rate);
    m.set(k, g);
  }
  const out = [...m.entries()].map(([k, g]) => ({ key: k, n: g.n, value: g.sum / g.n }));
  return order ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : out.sort((a, b) => b.value - a.value);
}

/** The best post of each work, best first (one line per work, so a much-reposted episode does not fill the list). */
export function bestPerWork(rows: PostRow[], rate: boolean): PostRow[] {
  const best = new Map<string, PostRow>();
  for (const r of rows) {
    if (rate && r.rate === null) continue;
    const b = best.get(r.workId);
    if (!b || measure(r, rate) > measure(b, rate)) best.set(r.workId, r);
  }
  return [...best.values()].sort((a, b) => measure(b, rate) - measure(a, rate));
}

export const pct = (x: number | null): string => (x === null ? '–' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
export const fmtNum = (x: number | null): string => (x === null ? '–' : x.toLocaleString('ko-KR'));
export const fmtMeasure = (x: number, rate: boolean): string => (rate ? pct(x) : `${Math.round(x).toLocaleString('ko-KR')}점`);

/** What the AI review is told about past posts: the covers that did best and worst (other works only). */
export function reviewHistory(all: Work[], exceptId: string): string {
  const rows = collectRows(all.filter((w) => w.id !== exceptId));
  if (rows.length < 2) return '';
  const rate = usesRate(rows);
  const best = bestPerWork(rows, rate);
  if (best.length < 2) return '';
  const line = (r: PostRow) => `- "${r.title}"${r.hook ? ` / 훅: ${r.hook}` : ''} — ${rate ? `참여율 ${pct(r.rate)}` : `반응 점수 ${r.score}`}, 저장 ${r.saves}, 댓글 ${r.comments} (${r.theme}, 표지 ${r.coverLayout})`;
  const top = best.slice(0, 3), low = best.length >= 5 ? best.slice(-2).reverse() : [];
  return `[참고: 이 작가의 지난 게시물 반응 (${best.length}편)]
반응이 좋았던 표지:
${top.map(line).join('\n')}${low.length ? `\n반응이 약했던 표지:\n${low.map(line).join('\n')}` : ''}
이 독자들에게 통한 제목·훅의 결을 hook 점수와 titles 제안에 참고하세요. 그대로 베끼지는 마세요.`;
}

export function postsCSV(rows: PostRow[]): string {
  const q = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const head = ['게시 시각', '작품', '화', '시리즈', '종류', '테마', '표지 모양', '도달·조회', '좋아요', '댓글', '저장', '공유', '팔로우', '참여율', '반응 점수', '링크'];
  const body = rows.map((r) => [new Date(r.at).toISOString(), r.title, r.episode ?? '', r.series, POST_KIND_NAME[r.kind], r.theme, r.coverLayout, r.reach ?? '', r.likes, r.comments, r.saves, r.shares, r.follows, r.rate === null ? '' : r.rate.toFixed(4), r.score, r.url]);
  return '﻿' + [head, ...body].map((row) => row.map(q).join(',')).join('\n');
}

/* ---------- AI pattern reading ---------- */
const str = { type: 'string' } as const;
export const INSIGHT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['patterns', 'tips', 'next'],
  properties: { patterns: { type: 'array', items: str }, tips: { type: 'array', items: str }, next: str },
};
export interface Insight { at: number; posts: number; patterns: string[]; tips: string[]; next: string }

export function insightPrompt(rows: PostRow[]): string {
  const rate = usesRate(rows);
  const lines = rows.slice(0, 60).map((r) => [
    new Date(r.at).toISOString().slice(0, 10) + ` ${WEEKDAY[r.weekday]} ${r.hour}시`,
    POST_KIND_NAME[r.kind], `"${r.title}"`, r.hook ? `훅 "${r.hook}"` : '', r.episode ? `${r.episode}화` : '', r.theme, `표지 ${r.coverLayout}`,
    r.reach ? `도달 ${r.reach}` : '', `좋아요 ${r.likes}`, `댓글 ${r.comments}`, `저장 ${r.saves}`, `공유 ${r.shares}`, r.follows ? `팔로우 ${r.follows}` : '',
    r.rate !== null ? `참여율 ${pct(r.rate)}` : '',
  ].filter(Boolean).join(' | ')).join('\n');
  return `인스타그램 카드소설 계정의 게시 기록입니다(${rows.length}건, ${rate ? '참여율=(좋아요+댓글+저장+공유)/도달' : '도달 수가 없어 반응 수로 비교'}). 데이터 분석가로서 읽어 주세요.

- patterns: 데이터에서 실제로 보이는 패턴 3~5개. 각 한 문장, 근거 숫자를 함께(예: "질문형 훅 4편의 평균 참여율이 다른 훅보다 2배"). 표본이 적으면 그렇다고 말합니다.
- tips: 다음 화에 바로 써 볼 수 있는 구체적 제안 2~4개(제목·훅 문장, 게시 요일·시간, 테마·표지, 릴스 여부 등).
- next: 다음 화 표지 제목과 훅을 한 쌍 제안(형식: 제목 / 훅).
모두 한국어로, 짧게.

[기록]
${lines}`;
}

export function normalizeInsight(raw: { patterns?: unknown; tips?: unknown; next?: unknown }, posts: number, at = Date.now()): Insight {
  const list = (x: unknown) => (Array.isArray(x) ? x : []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).slice(0, 5);
  return { at, posts, patterns: list(raw.patterns), tips: list(raw.tips), next: typeof raw.next === 'string' ? raw.next.trim() : '' };
}
