// Series: episodes of one story world. Pure helpers, so they can be tested without the page.
import { newWork, workTitle, type Work, type WorkDefaults } from './model';
import type { PrevEpisode } from './ai/prompts';

export const seriesName = (w: Pick<Work, 'series'>): string => (w.series || '').trim();

/** Works of the same series that come before `w`, oldest first, at most `limit` (the latest ones). */
export function previousEpisodes(all: Work[], w: Work, limit = 5): Work[] {
  const name = seriesName(w);
  if (!name || !w.episode) return [];
  return all
    .filter((x) => x.id !== w.id && seriesName(x) === name && x.episode && x.episode < w.episode!)
    .sort((a, b) => a.episode! - b.episode!)
    .slice(-limit);
}

export const asPrev = (w: Work): PrevEpisode => ({
  episode: w.episode || 0,
  title: workTitle(w),
  summary: (w.summary || '').trim() || fallbackSummary(w),
});

/** Without an AI summary: the hook and the first and last body lines stand in. */
export function fallbackSummary(w: Work): string {
  const body = w.cards.filter((c) => c.kind === 'body' && c.text.trim()).map((c) => c.text.replace(/\s+/g, ' ').trim());
  return [w.cards[0]?.text, body[0], body[body.length - 1]].filter(Boolean).join(' / ').slice(0, 400);
}

export function nextEpisodeNumber(all: Work[], series: string): number {
  const name = series.trim();
  return Math.max(0, ...all.filter((w) => seriesName(w) === name).map((w) => w.episode || 0)) + 1;
}

/** A new, empty episode that carries the look of `from`: series, handle, follow line, theme (also a custom one),
 *  watermark, ratio, font, art style (including the character reference picture), the add-on kind and the AI choices. */
export function nextEpisodeWork(from: Work, d: WorkDefaults, episode: number): Work {
  const w = newWork({ ...d, theme: from.theme, customTheme: from.customTheme, ratio: from.ratio, font: from.font, textAI: { ...from.textAI }, imageAI: { ...from.imageAI } });
  if (from.brand) w.brand = { ...from.brand };
  w.series = from.series;
  w.handle = from.handle;
  w.follow = from.follow;
  w.outroKind = from.outroKind;
  w.style = JSON.parse(JSON.stringify(from.style));
  w.episode = episode;
  w.source = { mode: 'idea', text: '' };
  w.cards[0].showLabel = from.cards[0]?.showLabel ?? true;
  return w;
}

export interface SeriesGroup { name: string; works: Work[] }

/** Library order: series with the latest activity first; inside a series by episode; one-off stories last. */
export function groupBySeries(all: Work[]): SeriesGroup[] {
  const map = new Map<string, Work[]>();
  for (const w of all) {
    const k = seriesName(w);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(w);
  }
  const groups = [...map.entries()].map(([name, works]) => ({
    name,
    works: works.sort((a, b) => (a.episode || 1e9) - (b.episode || 1e9) || (b.updatedAt || 0) - (a.updatedAt || 0)),
  }));
  const latest = (g: SeriesGroup) => Math.max(...g.works.map((w) => w.updatedAt || 0));
  return groups.sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || latest(b) - latest(a));
}
