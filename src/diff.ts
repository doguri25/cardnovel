// Word-level difference between two short texts (a card's words before and after proofreading).
// Tokens are runs of non-space characters and runs of spaces, so "할수" → "할 수" shows as one replaced word.

export type DiffPart = { op: 'eq' | 'del' | 'ins'; text: string };

export const tokenize = (s: string): string[] => String(s ?? '').match(/\s+|[^\s]+/g) ?? [];

/** Longest-common-subsequence diff of the tokens; equal runs and changed runs are merged, deletions before insertions. */
export function diffWords(a: string, b: string): DiffPart[] {
  const x = tokenize(a), y = tokenize(b);
  const n = x.length, m = y.length;
  // lcs[i][j] = common length of x[i..] and y[j..]
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (op: DiffPart['op'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text; else out.push({ op, text });
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { push('eq', x[i]); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] > lcs[i + 1][j])) push('ins', y[j++]);
    else push('del', x[i++]);
  }
  // a lone space kept between two changes reads better as part of the change: "~~a b~~ c d" instead of "~~a~~ c ~~b~~ d"
  const merged: DiffPart[] = [];
  for (let k = 0; k < out.length; k++) {
    const p = out[k], prev = out[k - 1], next = out[k + 1];
    if (p.op === 'eq' && /^\s+$/.test(p.text) && prev && next && prev.op !== 'eq' && next.op !== 'eq') {
      merged.push({ op: 'del', text: p.text }, { op: 'ins', text: p.text });
    } else merged.push(p);
  }
  // put every del run before its ins run and join neighbours of the same kind
  const tidy: DiffPart[] = [];
  for (let k = 0; k < merged.length;) {
    if (merged[k].op === 'eq') { tidy.push(merged[k++]); continue; }
    let del = '', ins = '';
    while (k < merged.length && merged[k].op !== 'eq') { if (merged[k].op === 'del') del += merged[k].text; else ins += merged[k].text; k++; }
    // spaces both sides share at the ends are not part of the change
    let lead = '', tail = '';
    if (del && ins) {
      while (del && ins && /\s/.test(del[0]) && del[0] === ins[0]) { lead += del[0]; del = del.slice(1); ins = ins.slice(1); }
      while (del && ins && /\s/.test(del[del.length - 1]) && del[del.length - 1] === ins[ins.length - 1]) { tail = del[del.length - 1] + tail; del = del.slice(0, -1); ins = ins.slice(0, -1); }
    }
    if (lead) eq(tidy, lead);
    if (del) tidy.push({ op: 'del', text: del });
    if (ins) tidy.push({ op: 'ins', text: ins });
    if (tail) eq(tidy, tail);
  }
  // join equal runs that met after the spaces moved
  return tidy.reduce<DiffPart[]>((out, p) => { if (p.op === 'eq') eq(out, p.text); else out.push(p); return out; }, []);
}

function eq(list: DiffPart[], text: string) {
  const last = list[list.length - 1];
  if (last && last.op === 'eq') last.text += text; else list.push({ op: 'eq', text });
}

/** How many separate places changed. */
export const changeCount = (parts: DiffPart[]): number => parts.filter((p, k) => p.op !== 'eq' && (k === 0 || parts[k - 1].op === 'eq')).length;
