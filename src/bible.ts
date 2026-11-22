// Series bible: characters, places, rules and open threads of one series, kept on this device (and copied into
// the works of the series, so a Drive backup or an exported file carries it).
import { kv } from './store';
import type { Work } from './model';

export interface BibleEntry { name: string; desc: string }
export interface Thread { text: string; status: 'open' | 'closed'; episode?: number }
export interface SeriesBible {
  series: string;
  characters: BibleEntry[];
  places: BibleEntry[];
  /** world rules and facts that must not change */
  rules: string;
  /** set-ups (떡밥) and whether they have been paid off */
  threads: Thread[];
  updatedAt: number;
}

export const emptyBible = (series: string): SeriesBible => ({ series, characters: [], places: [], rules: '', threads: [], updatedAt: 0 });
const key = (series: string) => 'bible:' + series.trim();

export async function loadBible(series: string): Promise<SeriesBible> {
  const b = await kv.get<SeriesBible | null>(key(series), null);
  return b ? { ...emptyBible(series), ...b } : emptyBible(series);
}
export async function saveBible(b: SeriesBible): Promise<void> {
  await kv.set(key(b.series), { ...b, updatedAt: b.updatedAt || Date.now() });
}

/** A work opened from a file or Drive may carry a newer copy of its series bible: keep the newest. */
export async function adoptBible(w: Work): Promise<void> {
  const copy = w.seriesBible;
  if (!copy || !w.series.trim() || copy.series.trim() !== w.series.trim()) return;
  const mine = await loadBible(w.series);
  if ((copy.updatedAt || 0) > (mine.updatedAt || 0)) await saveBible(copy);
}

export const isEmptyBible = (b: SeriesBible): boolean => !b.characters.length && !b.places.length && !b.rules.trim() && !b.threads.length;

/** The bible as plain text for the writer AI. */
export function bibleText(b: SeriesBible): string {
  if (isEmptyBible(b)) return '';
  const lines: string[] = [];
  if (b.characters.length) lines.push('인물:', ...b.characters.filter((c) => c.name.trim()).map((c) => `- ${c.name}: ${c.desc}`));
  if (b.places.length) lines.push('장소:', ...b.places.filter((c) => c.name.trim()).map((c) => `- ${c.name}: ${c.desc}`));
  if (b.rules.trim()) lines.push('세계관·규칙:', b.rules.trim());
  const open = b.threads.filter((t) => t.status === 'open' && t.text.trim());
  const closed = b.threads.filter((t) => t.status === 'closed' && t.text.trim());
  if (open.length) lines.push('아직 풀리지 않은 떡밥:', ...open.map((t) => `- ${t.text}${t.episode ? ` (${t.episode}화)` : ''}`));
  if (closed.length) lines.push('이미 풀린 떡밥(되풀이하지 않음):', ...closed.map((t) => `- ${t.text}`));
  return lines.join('\n');
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Adds what the AI found to what the writer already has: the writer's entries win, new ones are appended. */
export function mergeBible(mine: SeriesBible, found: Partial<SeriesBible>): SeriesBible {
  const mergeEntries = (a: BibleEntry[], b: BibleEntry[] = []) => {
    const out = a.map((x) => ({ ...x }));
    for (const e of b) {
      if (!e?.name?.trim()) continue;
      const hit = out.find((x) => norm(x.name) === norm(e.name));
      if (!hit) out.push({ name: e.name.trim(), desc: (e.desc || '').trim() });
      else if (!hit.desc.trim() && e.desc) hit.desc = e.desc.trim();
    }
    return out;
  };
  const threads = mine.threads.map((t) => ({ ...t }));
  for (const t of found.threads ?? []) {
    if (!t?.text?.trim()) continue;
    const hit = threads.find((x) => norm(x.text) === norm(t.text));
    if (!hit) threads.push({ text: t.text.trim(), status: t.status === 'closed' ? 'closed' : 'open', ...(t.episode ? { episode: t.episode } : {}) });
    else if (t.status === 'closed') hit.status = 'closed';
  }
  const rules = [mine.rules.trim(), ...(found.rules ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !mine.rules.includes(l))].filter(Boolean).join('\n');
  return { ...mine, characters: mergeEntries(mine.characters, found.characters), places: mergeEntries(mine.places, found.places), rules, threads, updatedAt: Date.now() };
}
