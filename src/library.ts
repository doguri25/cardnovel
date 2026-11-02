// Library: finding and ordering works, and a 30-day trash so a deleted work can come back.
import { matches } from './hangul';
import { stripMarks, workTitle, type Work } from './model';
import { kv } from './store';

export type LibSort = 'recent' | 'created' | 'title' | 'episode';
export const LIB_SORT_NAME: Record<LibSort, string> = { recent: '최근 고친 순', created: '만든 순', title: '제목 순', episode: '시리즈·회차 순' };

/** Title, series, name, hook and every card's words, for searching. */
export const searchText = (w: Work): string =>
  [w.name, workTitle(w), w.series, w.episode ? `${w.episode}화` : '', ...w.cards.map((c) => stripMarks(`${c.title} ${c.text}`))].join(' ');

export function filterWorks(all: Work[], query: string, sort: LibSort): Work[] {
  const q = query.trim();
  const found = q ? all.filter((w) => matches(searchText(w), q)) : [...all];
  const title = (w: Work) => (w.name || workTitle(w)).toLowerCase();
  const by: Record<LibSort, (a: Work, b: Work) => number> = {
    recent: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    title: (a, b) => title(a).localeCompare(title(b), 'ko'),
    episode: (a, b) => (a.series || '￿').localeCompare(b.series || '￿', 'ko') || (a.episode || 1e9) - (b.episode || 1e9) || (b.updatedAt || 0) - (a.updatedAt || 0),
  };
  return found.sort(by[sort]);
}

/* ---------- trash ---------- */
export const TRASH_DAYS = 30;
export interface TrashEntry { id: string; title: string; series: string; episode?: number; deletedAt: number; thumb?: string }

export const listTrash = (): Promise<TrashEntry[]> => kv.get<TrashEntry[]>('trash.index', []);

/** Keeps the whole work for 30 days. The caller removes it from the works store. */
export async function moveToTrash(w: Work, now = Date.now()): Promise<void> {
  await kv.set('trash.' + w.id, w);
  const list = (await listTrash()).filter((e) => e.id !== w.id);
  list.unshift({ id: w.id, title: w.name || workTitle(w), series: w.series, episode: w.episode, deletedAt: now, thumb: w.thumb });
  await kv.set('trash.index', list);
}

/** The work kept in the trash (and takes it out of the trash). */
export async function takeFromTrash(id: string): Promise<Work | null> {
  const w = await kv.get<Work | null>('trash.' + id, null);
  await dropFromTrash(id);
  return w;
}

export async function dropFromTrash(id: string): Promise<void> {
  await kv.del('trash.' + id);
  await kv.set('trash.index', (await listTrash()).filter((e) => e.id !== id));
}

/** Empties entries older than 30 days (or all with `all`); returns the ids removed, so their versions can go too. */
export async function purgeTrash(now = Date.now(), all = false): Promise<string[]> {
  const list = await listTrash();
  const old = list.filter((e) => all || now - e.deletedAt > TRASH_DAYS * 86400000);
  for (const e of old) await kv.del('trash.' + e.id);
  if (old.length) await kv.set('trash.index', list.filter((e) => !old.includes(e)));
  return old.map((e) => e.id);
}

export const daysLeft = (e: TrashEntry, now = Date.now()): number => Math.max(0, Math.ceil(TRASH_DAYS - (now - e.deletedAt) / 86400000));
