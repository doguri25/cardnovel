// Korean search helpers: "ㄱㅈ" finds "교정"; spaces, punctuation and case do not matter.
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

/** The initial consonant of every Hangul syllable; other characters stay as they are. */
export function chosung(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return out;
}

/** lower case, letters and digits only: spaces and marks like ‘:’ or ‘·’ do not get in the way */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const onlyCho = (s: string) => /^[ㄱ-ㅎ]+$/.test(s);

/** Whether `query` appears in `text`, by letters or (for a query of bare consonants) by initial consonants. */
export function matches(text: string, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  const t = norm(text);
  if (t.includes(q)) return true;
  return onlyCho(q) && chosung(t).includes(q);
}

/** A rough score for ordering results: earlier and whole-word hits first; -1 when it does not match. */
export function score(text: string, query: string): number {
  const q = norm(query);
  if (!q) return 0;
  const t = norm(text);
  const at = t.indexOf(q);
  if (at >= 0) return 100 - Math.min(at, 50) + (at === 0 ? 50 : 0);
  if (onlyCho(q)) { const c = chosung(t).indexOf(q); if (c >= 0) return 40 - Math.min(c, 30); }
  return -1;
}
