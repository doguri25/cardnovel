// Spending record: every AI call adds one line (tokens, pictures, estimated cost), kept per month on this device.
import type { UsageEvent, UsageTag } from './ai/providers';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import { kv } from './store';

export interface UsageRecord extends UsageEvent { t: number; workId: string; cost: number }

export const TAG_NAME: Record<UsageTag, string> = {
  compose: '카드 구성', rewrite: '다시 쓰기', outro: '마지막 장 한 줄', summary: '줄거리 요약', review: 'AI 평가', proof: '일괄 교정', insight: '성과 분석', caption: '캡션·해시태그', bible: '설정집',
  svg: 'Claude SVG 그림', image: '그림', refsheet: '인물 기준 그림', cover: '표지 후보', tts: 'AI 낭독', other: '기타',
};
export const PROVIDER_NAME: Record<UsageEvent['provider'], string> = { anthropic: 'Claude', google: 'Gemini', openai: 'GPT' };

export const monthKey = (t: number): string => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

/** Estimated USD: pictures at the per-picture price, narration per 1,000 characters, everything else (including SVG drawing) by tokens. */
export function estimateCost(u: UsageEvent, s: Pick<Settings, 'prices' | 'textPrices'> & Partial<Pick<Settings, 'ttsPrices'>>): number {
  if (u.chars) { const p = s.ttsPrices ?? DEFAULT_SETTINGS.ttsPrices; return (u.chars / 1000) * (u.provider === 'openai' ? p.openai : p.google); }
  if (u.images > 0) {
    const per = u.provider === 'google' ? s.prices.gemini : u.provider === 'openai' ? s.prices.openai : s.prices.claude;
    return u.images * per;
  }
  const p = s.textPrices[u.provider];
  return (u.input * p.in + u.output * p.out) / 1_000_000;
}

// one write at a time: pictures are drawn two at a time and both finish into the same month list
let queue: Promise<unknown> = Promise.resolve();
export function recordUsage(r: UsageRecord): Promise<void> {
  const job = queue.then(async () => {
    const k = monthKey(r.t);
    const list = await kv.get<UsageRecord[]>('usage.' + k, []);
    list.push(r);
    await kv.set('usage.' + k, list.slice(-5000));
    const months = await kv.get<string[]>('usage.months', []);
    if (!months.includes(k)) await kv.set('usage.months', [...months, k].sort());
  });
  queue = job.catch(() => undefined);
  return job;
}

export const monthRecords = (k: string): Promise<UsageRecord[]> => kv.get<UsageRecord[]>('usage.' + k, []);
export const usageMonths = (): Promise<string[]> => kv.get<string[]>('usage.months', []);
export async function clearMonth(k: string): Promise<void> {
  await kv.set('usage.' + k, []);
  await kv.set('usage.months', (await usageMonths()).filter((m) => m !== k));
}

export interface UsageSummary {
  total: number; calls: number; images: number; input: number; output: number;
  byProvider: { key: string; cost: number; calls: number }[];
  byTag: { key: string; cost: number; calls: number }[];
  byWork: { key: string; cost: number; calls: number }[];
}
export function summarize(list: UsageRecord[]): UsageSummary {
  const group = (f: (r: UsageRecord) => string) => {
    const m = new Map<string, { key: string; cost: number; calls: number }>();
    for (const r of list) {
      const k = f(r);
      const g = m.get(k) ?? { key: k, cost: 0, calls: 0 };
      g.cost += r.cost; g.calls++;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  return {
    total: list.reduce((a, r) => a + r.cost, 0),
    calls: list.length,
    images: list.reduce((a, r) => a + r.images, 0),
    input: list.reduce((a, r) => a + r.input, 0),
    output: list.reduce((a, r) => a + r.output, 0),
    byProvider: group((r) => r.provider),
    byTag: group((r) => r.tag),
    byWork: group((r) => r.workId),
  };
}

export const money = (v: number): string => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);

export function toCSV(list: UsageRecord[], titles: Record<string, string>): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['시각', '작품', '회사', '모델', '용도', '입력 토큰', '출력 토큰', '그림', '추정 비용(USD)'];
  const rows = list.map((r) => [new Date(r.t).toISOString(), titles[r.workId] ?? r.workId, PROVIDER_NAME[r.provider], r.model, TAG_NAME[r.tag] ?? r.tag, r.input, r.output, r.images, r.cost.toFixed(5)]);
  return '﻿' + [head, ...rows].map((row) => row.map(q).join(',')).join('\n');
}

/** Budget thresholds crossed by this month's total, reported once each per month. */
export async function budgetAlert(total: number, budget: number, month: string): Promise<0 | 80 | 100> {
  if (!budget) return 0;
  const level = total >= budget ? 100 : total >= budget * 0.8 ? 80 : 0;
  if (!level) return 0;
  const seen = await kv.get<number>('usage.warned.' + month, 0);
  if (seen >= level) return 0;
  await kv.set('usage.warned.' + month, level);
  return level;
}
