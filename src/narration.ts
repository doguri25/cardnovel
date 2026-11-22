// AI narration for the reels video: each card's words read aloud by an OpenAI or Gemini voice, one clip per card,
// so every card stays on screen as long as its reading takes. Clips are kept for this session, so making the
// video again with another transition or music costs nothing.
import { AiError, generateSpeech, GEMINI_VOICES, OPENAI_TTS1_VOICES, OPENAI_VOICES, type SpeechAudio } from './ai/providers';
import { stripMarks, type Work } from './model';
import type { Narration, NarrationStyle } from './settings';

export const STYLE_NAME: Record<NarrationStyle, string> = {
  calm: '차분한 낭독', tense: '긴장감 있게', warm: '따뜻하게', plain: '담담하게', acted: '대사는 연기하듯',
};
/** English works best as an instruction for both providers; the text itself stays Korean. */
export const STYLE_PROMPT: Record<NarrationStyle, string> = {
  calm: 'Read this Korean story text aloud as a calm, clear audiobook narrator, unhurried, with natural pauses at commas and full stops.',
  tense: 'Read this Korean story text aloud as a suspenseful mystery narrator: low, hushed and tense, with short dramatic pauses.',
  warm: 'Read this Korean story text aloud warmly and gently, like telling a story to a close friend.',
  plain: 'Read this Korean text aloud in a plain, even, matter-of-fact voice without dramatization.',
  acted: 'Read this Korean story text aloud expressively: act out the lines inside quotation marks with the character\'s emotion, and narrate the rest naturally.',
};

export const VOICE_NOTE: Record<string, string> = {
  alloy: '중성적', ash: '또렷함', ballad: '부드러움', coral: '따뜻함', echo: '차분함', fable: '이야기꾼', nova: '밝음', onyx: '낮고 깊음',
  sage: '침착함', shimmer: '맑음', verse: '표현력', marin: '자연스러움', cedar: '자연스러움',
  Kore: '단단함', Aoede: '산뜻함', Leda: '젊음', Sulafat: '따뜻함', Achernar: '부드러움', Vindemiatrix: '온화함', Despina: '매끄러움',
  Zephyr: '밝음', Charon: '전달력', Puck: '경쾌함', Orus: '단단함', Fenrir: '들뜸', Algenib: '거침', Gacrux: '원숙함', Enceladus: '숨결',
  Iapetus: '또렷함', Schedar: '고름', Achird: '친근함',
};

export const voicesFor = (provider: Narration['provider'], model: string): string[] =>
  provider === 'google' ? GEMINI_VOICES : /^tts-1/.test(model) ? OPENAI_TTS1_VOICES : OPENAI_VOICES;
export const DEFAULT_TTS_MODEL: Record<Narration['provider'], string> = { openai: 'gpt-4o-mini-tts', google: 'gemini-2.5-flash-preview-tts' };

const clean = (s: string) => stripMarks(s || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
const stop = (s: string) => (/[.!?…。」』"'”’)~]$/.test(s) ? s : s + '.');

/** What is read on each card ('' = that card stays silent). */
export function narrationScript(w: Work, readOutro = false): string[] {
  return w.cards.map((c) => {
    if (c.kind === 'outro') {
      const parts = [w.outroKind === 'none' ? '' : clean(c.text), readOutro ? clean(w.follow) : ''];
      return parts.filter(Boolean).map(stop).join(' ');
    }
    return [clean(c.title), clean(c.text)].filter(Boolean).map(stop).join(' ');
  });
}

/** Characters billed (spaces included, as the providers count them). */
export const scriptChars = (script: string[]): number => script.reduce((n, s) => n + s.length, 0);
/** About how long Korean narration takes: some 6 syllables a second at normal speed. */
export const estimateSeconds = (text: string, speed = 1): number => (text ? 0.3 + text.replace(/\s/g, '').length / (6 * speed) : 0);

export interface Voice { provider: Narration['provider']; key: string; model: string; voice: string; style: NarrationStyle; speed: number }

/** Speech answer → audio buffer, with the silence at both ends trimmed so cards change on time. */
export async function toAudioBuffer(a: SpeechAudio): Promise<AudioBuffer> {
  let buf: AudioBuffer;
  if (a.kind === 'pcm') {
    const n = Math.floor(a.data.byteLength / 2);
    const dv = new DataView(a.data);
    buf = new AudioBuffer({ length: Math.max(1, n), numberOfChannels: 1, sampleRate: a.rate });
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  } else {
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    buf = await ctx.decodeAudioData(a.data.slice(0));
  }
  return trimSilence(buf);
}

export function trimSilence(buf: AudioBuffer, threshold = 0.012, keep = 0.06): AudioBuffer {
  const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const loud = (i: number) => chs.some((ch) => Math.abs(ch[i]) > threshold);
  let a = 0, b = buf.length - 1;
  while (a < b && !loud(a)) a++;
  while (b > a && !loud(b)) b--;
  const pad = Math.round(keep * buf.sampleRate);
  a = Math.max(0, a - pad); b = Math.min(buf.length - 1, b + pad);
  if (a === 0 && b === buf.length - 1) return buf;
  const out = new AudioBuffer({ length: Math.max(1, b - a + 1), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  chs.forEach((ch, c) => out.copyToChannel(ch.subarray(a, b + 1), c));
  return out;
}

const cache = new Map<string, Promise<AudioBuffer>>();
const cacheKey = (v: Voice, text: string) => [v.provider, v.model, v.voice, v.style, v.speed, text].join('|');
export const isCached = (v: Voice, text: string): boolean => cache.has(cacheKey(v, text));

/** One line read aloud (cached for this session; a failed attempt is forgotten so it can be tried again). */
export function speak(v: Voice, text: string, signal?: AbortSignal): Promise<AudioBuffer> {
  const k = cacheKey(v, text);
  let p = cache.get(k);
  if (!p) {
    p = generateSpeech({ provider: v.provider, key: v.key, model: v.model, voice: v.voice, text, style: STYLE_PROMPT[v.style], speed: v.speed, signal }).then(toAudioBuffer);
    cache.set(k, p);
    p.catch(() => cache.delete(k));
  }
  return p;
}

/** Every card's clip (null for silent cards), three requests at a time. */
export async function narrate(w: Work, v: Voice, readOutro: boolean, progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<(AudioBuffer | null)[]> {
  const script = narrationScript(w, readOutro);
  const out: (AudioBuffer | null)[] = script.map(() => null);
  const todo = script.map((t, i) => ({ t, i })).filter((x) => x.t);
  let done = 0, next = 0;
  progress(0, todo.length);
  const worker = async () => {
    while (next < todo.length) {
      const { t, i } = todo[next++];
      if (signal?.aborted) throw new AiError('cancelled');
      out[i] = await speak(v, t, signal);
      progress(++done, todo.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}
