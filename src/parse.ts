// Manuscripts that are already split ("표지 / 1페이지 … / 마지막 페이지") become cards without AI.
// The header rules are ported from the 카드소설 제작소 artifact; fitting to 18 body cards is new.
import { BODY_COUNT, countChars, type InputMode } from './model';

export interface Block { type: 'cover' | 'last' | 'num' | 'free'; head: string; text: string }

const HEAD_COVER = /^[\[【「(]?\s*(표지|커버|cover|프롤로그)\s*[\]】」)]?\s*(?:[:：.\-–]\s*(.*))?$/i;
const HEAD_LAST = /^[\[【「(]?\s*(마지막(?:\s*(?:페이지|장|카드|장면))?|끝|엔딩|에필로그)\s*[\]】」)]?\s*(?:[:：.\-–]\s*(.*))?$/i;
const HEAD_NUM = /^[\[【「(#]?\s*(?:(?:p|page)\s*(\d{1,3})|(\d{1,3})\s*(?:페이지|장|카드|쪽|p|page))\s*[\]】」)]?\s*(?:[:：.\-–]\s*)?(.*)$/i;
const HEAD_NUM2 = /^[\[【「(#]\s*(\d{1,3})\s*[\]】」)]\s*(?:[:：.\-–]\s*)?(.*)$|^(\d{1,3})\s*[.:：)\-–]\s*(.*)$/;
const isShort = (s: string | undefined) => { const t = (s || '').trim(); return t.length <= 16 && !/[.。!?다요]$/.test(t); };

export function parseManuscript(text: string): { blocks: Block[]; hasHeads: boolean } {
  const lines = text.replace(/\r/g, '').split('\n');
  const sections: { type: Block['type']; head: string; lines: string[] }[] = [];
  let cur: (typeof sections)[number] | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(HEAD_COVER))) { cur = { type: 'cover', head: m[2] || '', lines: [] }; sections.push(cur); continue; }
    if ((m = line.match(HEAD_LAST)) && isShort(m[2])) { cur = { type: 'last', head: m[2] || '', lines: [] }; sections.push(cur); continue; }
    if ((m = line.match(HEAD_NUM)) && isShort(m[3])) { cur = { type: 'num', head: m[3] || '', lines: [] }; sections.push(cur); continue; }
    if ((m = line.match(HEAD_NUM2)) && line.length <= 20) {
      const head = (m[2] ?? m[4]) || '';
      if (isShort(head)) { cur = { type: 'num', head, lines: [] }; sections.push(cur); continue; }
    }
    if (!cur) { cur = { type: 'free', head: '', lines: [] }; sections.push(cur); }
    cur.lines.push(raw);
  }
  const hasHeads = sections.some((s) => s.type !== 'free');
  let blocks: Block[];
  if (hasHeads) {
    blocks = sections
      .filter((s) => s.type !== 'free' || s.lines.join('').trim())
      .map((s) => ({ type: s.type, head: s.head, text: s.lines.join('\n').replace(/^\n+|\n+$/g, '') }));
  } else {
    const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    blocks = paras.map((p, i) => ({ type: i === 0 ? 'cover' : i === paras.length - 1 && paras.length > 2 ? 'last' : 'num', head: '', text: p }));
  }
  return { blocks, hasHeads };
}

/** Which way to treat what was pasted: headers → split, a long text → long manuscript, a few lines → idea. */
export function detectMode(text: string): Exclude<InputMode, 'auto'> {
  const t = text.trim();
  if (!t) return 'idea';
  if (parseManuscript(t).hasHeads) return 'split';
  const lines = t.split('\n').filter((l) => l.trim()).length;
  return countChars(t) > 500 || lines > 10 ? 'long' : 'idea';
}

export interface SplitResult {
  title: string;
  hook: string;
  body: { label: string; text: string }[];
  outro: string;
  /** what fitting to 18 cards did, in words the writer can check before applying */
  changes: string[];
  originalCount: number;
}

/** Splits a text in two at the sentence boundary closest to its middle (or a comma, or a space). */
export function splitInTwo(text: string): [string, string] | null {
  const t = text.trim();
  if (countChars(t) < 16) return null;
  const mid = t.length / 2;
  const cuts: number[] = [];
  const re = /([.!?。…]|다\.|요\.)["'”’)]?\s+|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) cuts.push(m.index + m[0].length);
  if (!cuts.length) { const re2 = /[,，]\s*/g; while ((m = re2.exec(t))) cuts.push(m.index + m[0].length); }
  if (!cuts.length) { const re3 = /\s+/g; while ((m = re3.exec(t))) cuts.push(m.index + m[0].length); }
  const valid = cuts.filter((c) => c > 0 && c < t.length);
  if (!valid.length) return null;
  const at = valid.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  const a = t.slice(0, at).trim(), b = t.slice(at).trim();
  return a && b ? [a, b] : null;
}

/** Fits a split manuscript to exactly 18 body cards: merges the shortest neighbours or splits the longest cards. */
export function fitToBody(items: { label: string; text: string }[], target = BODY_COUNT): { body: { label: string; text: string }[]; changes: string[] } {
  // keep track of where every card came from, so the changes can be described with the writer's own page numbers
  let body = items.map((it, i) => ({ ...it, from: [i + 1] }));
  const changes: string[] = [];
  while (body.length > target) {
    let best = 0, bestLen = Infinity;
    for (let i = 0; i < body.length - 1; i++) {
      const len = countChars(body[i].text) + countChars(body[i + 1].text);
      if (len < bestLen) { bestLen = len; best = i; }
    }
    const a = body[best], b = body[best + 1];
    body.splice(best, 2, { label: a.label || b.label, text: `${a.text}\n${b.text}`.trim(), from: [...a.from, ...b.from] });
  }
  for (let guard = 0; body.length < target && guard < 100; guard++) {
    const order = body.map((c, i) => ({ i, len: countChars(c.text) })).sort((x, y) => y.len - x.len);
    let done = false;
    for (const { i } of order) {
      const parts = splitInTwo(body[i].text);
      if (!parts) continue;
      const c = body[i];
      body.splice(i, 1, { label: c.label, text: parts[0], from: c.from }, { label: '', text: parts[1], from: c.from });
      done = true;
      break;
    }
    if (!done) break;
  }
  while (body.length < target) body.push({ label: '', text: '', from: [] });

  // describe the result
  const merged = body.filter((c) => c.from.length > 1).map((c) => c.from.join('+'));
  const splitCount = new Map<number, number>();
  body.forEach((c) => { if (c.from.length === 1) splitCount.set(c.from[0], (splitCount.get(c.from[0]) ?? 0) + 1); });
  const split = [...splitCount.entries()].filter(([, n]) => n > 1).map(([p, n]) => `${p}(${n}장으로)`);
  const empty = body.filter((c) => c.from.length === 0).length;
  if (merged.length) changes.push(`합친 페이지: ${merged.join(', ')}`);
  if (split.length) changes.push(`나눈 페이지: ${split.join(', ')}`);
  if (empty) changes.push(`빈 카드 ${empty}장을 끝에 두었습니다. 직접 채우거나 AI로 다시 쓰세요.`);
  return { body: body.map(({ label, text }) => ({ label, text })), changes };
}

export function splitManuscript(text: string): SplitResult {
  const { blocks } = parseManuscript(text);
  let title = '', hook = '', outro = '';
  const mid: { label: string; text: string }[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'cover' && i === 0) {
      const ls = b.text.split('\n').map((s) => s.trim()).filter(Boolean);
      title = b.head.trim() || ls.shift() || '';
      hook = ls.join(' ');
    } else if (b.type === 'last') {
      outro = [b.head.trim(), b.text.trim()].filter(Boolean).join('\n');
    } else if (b.text.trim() || b.head.trim()) {
      mid.push({ label: b.head.trim(), text: b.text.trim() });
    }
  });
  const fitted = fitToBody(mid);
  return { title, hook, body: fitted.body, outro, changes: fitted.changes, originalCount: mid.length };
}

export const SAMPLE_SPLIT = `표지
젖지 않은 우산
비 오는 밤, 우산꽂이에 우산이 하나 남았다.

1페이지: 사건
화요일 밤 10시, 편의점 마감. 알바생 지호는 우산꽂이에 남은 검은 우산 하나를 발견했다.

2페이지
우산은 완전히 말라 있었다. 밖은 세 시간째 비가 내리고 있었다.

3페이지
…

마지막 페이지
그런데 민서는 왜 창고 열쇠를 숨겨야만 했을까?`;
