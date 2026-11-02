// Card themes, ratios and fonts: values copied from the 카드소설 제작소 artifact.

export type Deco = 'glow' | 'frame' | 'number' | 'bar' | 'corners' | 'panel';
export interface Theme {
  name: string;
  bg: [string, string];
  text: string;
  accent: string;
  font: string;
  deco: Deco;
  light?: boolean;
}

export const THEMES = {
  fog: { name: '안개', bg: ['#141C2E', '#05080F'], text: '#E6ECF5', accent: '#8FD3F4', font: 'Noto Serif KR', deco: 'glow' },
  ink: { name: '먹', bg: ['#1A1A1A', '#0A0A0A'], text: '#F3EEE3', accent: '#E3C15C', font: 'Nanum Myeongjo', deco: 'frame' },
  wine: { name: '자정', bg: ['#33101B', '#120508'], text: '#F8E9EC', accent: '#F09AA6', font: 'Gowun Batang', deco: 'number' },
  neon: { name: '네온', bg: ['#0B0B0F', '#040406'], text: '#EEEEF4', accent: '#FF4FA3', font: 'Noto Sans KR', deco: 'bar' },
  paper: { name: '헌책', bg: ['#2A1E12', '#110B06'], text: '#F1E4C8', accent: '#D9A441', font: 'Gowun Batang', deco: 'corners' },
  deep: { name: '심해', bg: ['#0B2A33', '#03141A'], text: '#E3F4F6', accent: '#4FD1C5', font: 'Noto Serif KR', deco: 'glow' },
  violet: { name: '자수정', bg: ['#261A44', '#0D0818'], text: '#EEE8FA', accent: '#C9A7FF', font: 'Gowun Batang', deco: 'glow' },
  forest: { name: '숲', bg: ['#13281C', '#05100A'], text: '#E6F0E8', accent: '#9BD47A', font: 'Gowun Batang', deco: 'corners' },
  ember: { name: '잔불', bg: ['#2E1810', '#100603'], text: '#F6E9DF', accent: '#FF8A4C', font: 'Noto Sans KR', deco: 'bar' },
  snow: { name: '설야', bg: ['#22303F', '#0B1017'], text: '#F3F6FA', accent: '#DCE6F5', font: 'Nanum Myeongjo', deco: 'frame' },
  comic: { name: '만화', bg: ['#1C2144', '#0A0C1E'], text: '#FFFFFF', accent: '#FFD24D', font: 'Maplestory OTF', deco: 'panel' },
  news: { name: '신문', bg: ['#F1EADB', '#E2D8C3'], text: '#1E1A14', accent: '#A8322E', font: 'Nanum Myeongjo', deco: 'frame', light: true },
  linen: { name: '종이', bg: ['#F4F2ED', '#E4E0D7'], text: '#23252B', accent: '#3B5BA5', font: 'Noto Serif KR', deco: 'corners', light: true },
} satisfies Record<string, Theme>;
export type ThemeKey = keyof typeof THEMES;
export const themeOf = (key: string): Theme => (THEMES as Record<string, Theme>)[key] ?? THEMES.fog;

export interface RatioInfo { name: string; h: number; art: number; hint: string; instagramApi: boolean }
export const RATIOS = {
  '1:1': { name: '정사각 1:1', h: 1080, art: 640, hint: '인스타 피드 기본 · 1080×1080', instagramApi: true },
  '4:5': { name: '세로 4:5', h: 1350, art: 800, hint: '인스타 피드 세로 · 1080×1350', instagramApi: true },
  '3:4': { name: '세로 3:4', h: 1440, art: 860, hint: '인스타 피드 새 세로 규격 · 1080×1440', instagramApi: false },
  '9:16': { name: '스토리 9:16', h: 1920, art: 1000, hint: '스토리·릴스 · 1080×1920 (위아래 여백 감안)', instagramApi: false },
} satisfies Record<string, RatioInfo>;
export type RatioKey = keyof typeof RATIOS;
export const ratioOf = (key: string): RatioInfo => (RATIOS as Record<string, RatioInfo>)[key] ?? RATIOS['1:1'];

export const FONT_CHOICES: { value: string; label: string }[] = [
  { value: 'auto', label: '테마 기본' },
  { value: 'Noto Serif KR', label: '노토 세리프' },
  { value: 'Gowun Batang', label: '고운바탕' },
  { value: 'Nanum Myeongjo', label: '나눔명조' },
  { value: 'Noto Sans KR', label: '노토 산스' },
  { value: 'Maplestory OTF', label: '메이플스토리 (넥슨)' },
];

export const fontFor = (themeKey: string, font: string): string => (font && font !== 'auto' ? font : themeOf(themeKey).font);
export const weightFor = (family: string): number => (family === 'Nanum Myeongjo' ? 800 : 700);
