// Whether a card's picture scene still fits its words: the scene is written for the words it was asked with (sceneFor).
import { diffWords } from './diff';
import type { Card } from './model';

/** Share of the words that changed between two texts (0 = same, 1 = all different), spaces not counted. */
export function changedShare(a: string, b: string): number {
  const len = (t: string) => t.replace(/\s+/g, '').length;
  const total = len(a) + len(b);
  if (!total) return 0;
  return diffWords(a, b).filter((p) => p.op !== 'eq').reduce((n, p) => n + len(p.text), 0) / total;
}

/** A card to draw whose scene is missing, or whose words changed a lot since the scene was written. */
export function sceneStale(c: Card): boolean {
  if (c.kind === 'outro') return false;
  if (!c.scene.trim()) return true;
  return c.sceneFor !== undefined && changedShare(c.sceneFor, c.text) > 0.2;
}
