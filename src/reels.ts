// Reels video: the 20 cards as a 1080×1920 video (slide or fade between cards, slow zoom, optional music),
// encoded in the browser with WebCodecs. MP4 (H.264 / AAC) where the browser can, WebM otherwise.
import {
  AudioBufferSource, BufferTarget, CanvasSource, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec,
  Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat, type AudioCodec, type VideoCodec,
} from 'mediabunny';
import { countChars, type Work } from './model';
import { cardHeight, ensureFonts, renderCard, W } from './render';
import { themeOfWork } from './themes';

export const REEL_W = 1080;
export const REEL_H = 1920;
const TRANSITION = 0.45;

export type Transition = 'slide' | 'fade' | 'none';
export interface ReelOptions {
  /** seconds per card, or 'auto' (longer cards stay longer) */
  seconds: number | 'auto';
  transition: Transition;
  zoom: boolean;
  /** decoded music and its volume (0–1); looped and faded out at the end */
  music?: { buffer: AudioBuffer; volume: number } | null;
  fps?: number;
}
export interface ReelResult { blob: Blob; ext: 'mp4' | 'webm'; video: VideoCodec; audio: AudioCodec | null; duration: number }

export class ReelError extends Error {
  constructor(public code: 'unsupported' | 'cancelled' | 'failed', message = '') { super(message || code); }
}

/** How long each card stays on screen. 'auto': about the time it takes to read it. */
export function cardDurations(w: Work, seconds: ReelOptions['seconds']): number[] {
  return w.cards.map((c) => {
    if (seconds !== 'auto') return seconds;
    if (c.kind === 'cover') return 3;
    if (c.kind === 'outro') return 3.5;
    return Math.min(6.5, Math.max(2.5, 1.6 + countChars(c.text + c.title) * 0.05));
  });
}
export const totalDuration = (d: number[]): number => d.reduce((a, b) => a + b, 0);

/** Picks the first codec pair this browser can encode: MP4 (H.264, HEVC…) first, WebM (VP9, VP8) as the fallback. */
export async function pickFormat(): Promise<{ ext: 'mp4' | 'webm'; video: VideoCodec; make: () => Mp4OutputFormat | WebMOutputFormat } | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const size = { width: REEL_W, height: REEL_H };
  const mp4 = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], size);
  if (mp4) return { ext: 'mp4', video: mp4, make: () => new Mp4OutputFormat({ fastStart: 'in-memory' }) };
  const webm = await getFirstEncodableVideoCodec(['vp9', 'vp8', 'av1'], size);
  if (webm) return { ext: 'webm', video: webm, make: () => new WebMOutputFormat() };
  return null;
}

/** Music looped to the video's length, at the chosen volume, with a short fade in and a longer fade out. */
export async function soundtrack(music: AudioBuffer, volume: number, duration: number): Promise<AudioBuffer> {
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = music;
  src.loop = true;
  const gain = ctx.createGain();
  const v = Math.max(0, Math.min(1, volume));
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(v, Math.min(0.6, duration / 4));
  gain.gain.setValueAtTime(v, Math.max(0.6, duration - 1.8));
  gain.gain.linearRampToValueAtTime(0, duration);
  src.connect(gain).connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

export async function decodeMusic(file: Blob): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  return ctx.decodeAudioData(await file.arrayBuffer());
}

interface Frame { card: ImageBitmap | HTMLCanvasElement; bg: HTMLCanvasElement | null; h: number }

/** Each card at full size, plus (for cards shorter than 9:16) a blurred, darkened copy that fills the frame behind it. */
async function prepareFrames(w: Work, onCard: (n: number) => void): Promise<Frame[]> {
  await ensureFonts(w);
  const H = cardHeight(w);
  const tall = H >= REEL_H;
  const out: Frame[] = [];
  for (let i = 0; i < w.cards.length; i++) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    await renderCard(c.getContext('2d')!, w, i);
    let bg: HTMLCanvasElement | null = null;
    if (!tall) {
      bg = document.createElement('canvas');
      bg.width = REEL_W; bg.height = REEL_H;
      const x = bg.getContext('2d')!;
      x.fillStyle = themeOfWork(w).bg[1];
      x.fillRect(0, 0, REEL_W, REEL_H);
      // a small copy blurred while scaling up is much cheaper than blurring at full size
      const small = document.createElement('canvas');
      small.width = 108; small.height = 192;
      const s = Math.max(108 / W, 192 / H);
      small.getContext('2d')!.drawImage(c, (108 - W * s) / 2, (192 - H * s) / 2, W * s, H * s);
      x.save();
      x.filter = 'blur(6px) brightness(0.45) saturate(1.1)';
      x.drawImage(small, -60, -60, REEL_W + 120, REEL_H + 120);
      x.restore();
    }
    const card = typeof createImageBitmap === 'function' ? await createImageBitmap(c) : c;
    out.push({ card, bg, h: H });
    onCard(i + 1);
  }
  return out;
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

function drawCardFrame(ctx: CanvasRenderingContext2D, f: Frame, local: number, dur: number, zoom: boolean, dx: number, alpha: number) {
  const z = zoom ? 1 + 0.035 * Math.min(1, Math.max(0, local / dur)) : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(dx, 0);
  if (f.bg) ctx.drawImage(f.bg, 0, 0);
  const h = f.h * z, w = W * z;
  const y = f.h >= REEL_H ? (REEL_H - h) / 2 : (REEL_H - h) / 2;
  ctx.drawImage(f.card, (REEL_W - w) / 2, y, w, h);
  ctx.restore();
}

/** The picture at time t: the current card, and during the last TRANSITION seconds the next one sliding or fading in. */
export function drawAt(ctx: CanvasRenderingContext2D, frames: Frame[], starts: number[], durs: number[], t: number, o: Pick<ReelOptions, 'transition' | 'zoom'>): void {
  let i = starts.length - 1;
  while (i > 0 && starts[i] > t) i--;
  const local = t - starts[i];
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, REEL_W, REEL_H);
  const tr = o.transition === 'none' || i === frames.length - 1 ? 0 : Math.min(TRANSITION, durs[i] / 3);
  const into = durs[i] - tr;
  if (!tr || local < into) { drawCardFrame(ctx, frames[i], local, durs[i] + (i < frames.length - 1 ? TRANSITION : 0), o.zoom, 0, 1); return; }
  const p = ease((local - into) / tr);
  if (o.transition === 'slide') {
    drawCardFrame(ctx, frames[i], local, durs[i] + TRANSITION, o.zoom, -p * REEL_W, 1);
    drawCardFrame(ctx, frames[i + 1], 0, durs[i + 1], o.zoom, (1 - p) * REEL_W, 1);
  } else {
    drawCardFrame(ctx, frames[i], local, durs[i] + TRANSITION, o.zoom, 0, 1);
    drawCardFrame(ctx, frames[i + 1], 0, durs[i + 1], o.zoom, 0, p);
  }
}

export async function makeReel(w: Work, o: ReelOptions, progress: (phase: 'cards' | 'video', done: number, total: number) => void, signal?: AbortSignal): Promise<ReelResult> {
  const fmt = await pickFormat();
  if (!fmt) throw new ReelError('unsupported');
  const fps = o.fps ?? 30;
  const durs = cardDurations(w, o.seconds);
  const starts = durs.map((_, i) => durs.slice(0, i).reduce((a, b) => a + b, 0));
  const duration = totalDuration(durs);
  const frames = await prepareFrames(w, (n) => progress('cards', n, w.cards.length));
  if (signal?.aborted) throw new ReelError('cancelled');

  const canvas = document.createElement('canvas');
  canvas.width = REEL_W; canvas.height = REEL_H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const format = fmt.make();
  const output = new Output({ format, target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: fmt.video, quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: fps });

  let audioCodec: AudioCodec | null = null;
  let audio: AudioBufferSource | null = null;
  if (o.music) {
    audioCodec = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs().filter((c) => c === 'aac' || c === 'opus'), { numberOfChannels: 2, sampleRate: 48000 });
    if (audioCodec) {
      audio = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
      output.addAudioTrack(audio);
    }
  }

  await output.start();
  try {
    if (audio && o.music) await audio.add(await soundtrack(o.music.buffer, o.music.volume, duration));
    const total = Math.round(duration * fps);
    for (let f = 0; f < total; f++) {
      if (signal?.aborted) throw new ReelError('cancelled');
      const t = f / fps;
      drawAt(ctx, frames, starts, durs, t, o);
      await video.add(t, 1 / fps);
      if (f % 10 === 0) progress('video', f, total);
    }
    progress('video', total, total);
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => undefined);
    if (e instanceof ReelError) throw e;
    throw new ReelError('failed', String((e as Error)?.message || e));
  } finally {
    for (const fr of frames) if ('close' in fr.card) (fr.card as ImageBitmap).close();
  }
  const buf = (output.target as BufferTarget).buffer;
  if (!buf) throw new ReelError('failed', 'empty output');
  return { blob: new Blob([buf], { type: fmt.ext === 'mp4' ? 'video/mp4' : 'video/webm' }), ext: fmt.ext, video: fmt.video, audio: audioCodec, duration };
}
