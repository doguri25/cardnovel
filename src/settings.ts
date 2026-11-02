import { DEFAULT_BRAND, DEFAULTS, type Brand, type ImageProvider, type TextProvider } from './model';
import type { SavedTheme } from './themes';
import { kv } from './store';

export interface Keys { anthropic: string; google: string; openai: string }

export interface Settings {
  keys: Keys;
  series: string;
  handle: string;
  follow: string;
  /** last choice, used for new works */
  textAI: { provider: TextProvider; model: string };
  imageAI: { provider: ImageProvider; model: string };
  /** remembered model per provider */
  models: { anthropic: string; google: string; openai: string; geminiImage: string; openaiImage: string };
  /** estimated price in USD per picture, editable because prices change */
  prices: { gemini: number; openai: number; claude: number };
  claudeArtTier: 'quick' | 'detailed';
  /** owner key for share links (the SHARE_KEY set on the server) */
  shareKey: string;
  /** Google OAuth client ID for Drive backup (empty: the build's default, if any) */
  googleClientId: string;
  /** the writer's own themes, offered next to the built-in ones */
  customThemes: SavedTheme[];
  /** logo / handle watermark settings, copied into a work when switched on */
  brand: Brand;
  /** estimated text prices in USD per 1M tokens (input, output), editable because they change */
  textPrices: Record<'anthropic' | 'google' | 'openai', { in: number; out: number }>;
  /** monthly spending limit in USD for warnings; 0 = none */
  monthlyBudget: number;
}

export const DEFAULT_SETTINGS: Settings = {
  keys: { anthropic: '', google: '', openai: '' },
  series: DEFAULTS.series,
  handle: DEFAULTS.handle,
  follow: DEFAULTS.follow,
  textAI: { provider: 'anthropic', model: '' },
  imageAI: { provider: 'gemini', model: '' },
  models: { anthropic: '', google: '', openai: '', geminiImage: '', openaiImage: '' },
  prices: { gemini: 0.04, openai: 0.06, claude: 0.03 },
  claudeArtTier: 'quick',
  shareKey: '',
  googleClientId: '',
  customThemes: [],
  brand: { ...DEFAULT_BRAND },
  textPrices: { anthropic: { in: 3, out: 15 }, google: { in: 0.3, out: 2.5 }, openai: { in: 1.25, out: 10 } },
  monthlyBudget: 0,
};

export async function loadSettings(): Promise<Settings> {
  const s = await kv.get<Partial<Settings>>('settings', {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    keys: { ...DEFAULT_SETTINGS.keys, ...(s.keys ?? {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(s.models ?? {}) },
    prices: { ...DEFAULT_SETTINGS.prices, ...(s.prices ?? {}) },
    textAI: { ...DEFAULT_SETTINGS.textAI, ...(s.textAI ?? {}) },
    imageAI: { ...DEFAULT_SETTINGS.imageAI, ...(s.imageAI ?? {}) },
    customThemes: Array.isArray(s.customThemes) ? s.customThemes : [],
    brand: { ...DEFAULT_BRAND, ...(s.brand ?? {}) },
    textPrices: {
      anthropic: { ...DEFAULT_SETTINGS.textPrices.anthropic, ...(s.textPrices?.anthropic ?? {}) },
      google: { ...DEFAULT_SETTINGS.textPrices.google, ...(s.textPrices?.google ?? {}) },
      openai: { ...DEFAULT_SETTINGS.textPrices.openai, ...(s.textPrices?.openai ?? {}) },
    },
    monthlyBudget: Number(s.monthlyBudget) || 0,
  };
}

export const saveSettings = (s: Settings): Promise<void> => kv.set('settings', s);

export const keyFor = (s: Settings, p: TextProvider | ImageProvider): string => {
  if (p === 'anthropic' || p === 'claude') return s.keys.anthropic;
  if (p === 'google' || p === 'gemini') return s.keys.google;
  if (p === 'openai') return s.keys.openai;
  return '';
};

export const maskKey = (k: string): string => (k ? '••••' + k.slice(-4) : '');
