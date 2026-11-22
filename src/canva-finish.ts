// Canva finishing: the 20 cards go to Canva as a PowerPoint deck — each slide is the card's background picture with
// the words as real text boxes, so they stay editable — and the finished pages come back as the card images.
import { upload } from '@vercel/blob/client';
import { call, canvaState, CanvaError } from './canva';
import { newId, workTitle, type Work } from './model';
import { cardHeight, ensureFonts, renderCard, W } from './render';

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PX = 96; // CSS pixels per inch: slide size in inches = pixels / 96, type size in points = pixels × 0.75

/* ---------- capturing the words the renderer draws ---------- */
export interface TextRec { text: string; x: number; y: number; size: number; family: string; weight: number; color: string; alpha: number; align: CanvasTextAlign; spacing: number }

export function parseFont(font: string): { size: number; weight: number; family: string } {
  const m = /(\d+(?:\.\d+)?)px\s*(?:\/\s*\S+\s+)?(.+)$/.exec(font) ?? [];
  const before = font.slice(0, font.indexOf(m[0] ?? font));
  const w = /\bbold\b/.test(before) ? 700 : Number(/\b([1-9]00)\b/.exec(before)?.[1] ?? 400);
  const family = (m[2] ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '') || 'Noto Serif KR';
  return { size: Number(m[1] ?? 16), weight: w, family };
}

export function colorParts(c: string): { hex: string; alpha: number } {
  const s = String(c).trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return { hex: s.slice(1).toUpperCase(), alpha: 1 };
  if (/^#[0-9a-f]{3}$/i.test(s)) return { hex: s.slice(1).split('').map((h) => h + h).join('').toUpperCase(), alpha: 1 };
  const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/i.exec(s);
  if (m) return { hex: [m[1], m[2], m[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('').toUpperCase(), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  return { hex: 'FFFFFF', alpha: 1 };
}

/** A drawing context that records fillText calls instead of drawing them; huge decorative glyphs are still drawn. */
export function captureContext(real: CanvasRenderingContext2D, recs: TextRec[]): CanvasRenderingContext2D {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'fillText') {
        return (text: string, x: number, y: number) => {
          const f = parseFont(target.font);
          if (f.size >= 150 || !String(text).trim()) { target.fillText(text, x, y); return; }
          const c = colorParts(String(target.fillStyle));
          const top = target.textBaseline === 'top';
          recs.push({
            text: String(text), x, y: top ? y + f.size * 0.86 : y, size: f.size, family: f.family, weight: f.weight,
            color: c.hex, alpha: c.alpha * target.globalAlpha, align: target.textAlign,
            spacing: parseFloat(String((target as unknown as { letterSpacing?: string }).letterSpacing ?? '0')) || 0,
          });
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) { return Reflect.set(target, prop, value, target); },
  });
}

export interface Line { y: number; runs: TextRec[] }
export interface Block { lines: Line[]; step: number }

/** Runs drawn on the same baseline make a line; lines of the same style and spacing make a block (one text box). */
export function groupBlocks(recs: TextRec[]): Block[] {
  const lines: Line[] = [];
  for (const r of recs) {
    const last = lines[lines.length - 1];
    const prev = last?.runs[last.runs.length - 1];
    // runs of one line: same baseline and size, drawn left to right (a footer's left and right parts stay apart)
    if (last && prev && Math.abs(last.y - r.y) < 0.5 && prev.size === r.size && prev.align === 'left' && r.align === 'left' && r.x >= prev.x) last.runs.push(r);
    else lines.push({ y: r.y, runs: [r] });
  }
  const sig = (l: Line) => { const r = l.runs[0]; return [r.size, r.family, r.weight, r.align, r.spacing, r.align === 'center' ? 'c' : Math.round(r.x)].join('|'); };
  const blocks: Block[] = [];
  for (const l of lines) {
    const b = blocks[blocks.length - 1];
    const prev = b?.lines[b.lines.length - 1];
    const step = prev ? l.y - prev.y : 0;
    if (b && prev && sig(prev) === sig(l) && step > 0 && step < l.runs[0].size * 2.4 && (!b.step || Math.abs(step - b.step) < 1.5)) {
      b.lines.push(l); b.step = step;
    } else {
      blocks.push({ lines: [l], step: 0 });
    }
  }
  return blocks;
}

/** One card: its picture without the words (JPEG data URL) and the words as blocks. */
export async function cardParts(w: Work, index: number): Promise<{ bg: string; blocks: Block[] }> {
  const plain: Work = { ...w, finished: undefined };
  const c = document.createElement('canvas');
  c.width = W; c.height = cardHeight(w);
  const recs: TextRec[] = [];
  await renderCard(captureContext(c.getContext('2d')!, recs), plain, index);
  return { bg: c.toDataURL('image/jpeg', 0.92), blocks: groupBlocks(recs) };
}

type Slide = { addImage(o: Record<string, unknown>): unknown; addText(t: Record<string, unknown>[], o: Record<string, unknown>): unknown };

export function addBlock(slide: Slide, b: Block, H: number): void {
  const first = b.lines[0].runs[0];
  const lh = b.step || first.size * 1.25;
  const runs: Record<string, unknown>[] = [];
  b.lines.forEach((l, li) => l.runs.forEach((r, ri) => runs.push({
    text: r.text,
    options: {
      color: r.color, ...(r.alpha < 0.99 ? { transparency: Math.round((1 - r.alpha) * 100) } : {}),
      bold: r.weight >= 600, fontFace: r.family, fontSize: +(r.size * 0.75).toFixed(1),
      ...(r.spacing ? { charSpacing: +(r.spacing * 0.75).toFixed(1) } : {}),
      ...(ri === l.runs.length - 1 && li < b.lines.length - 1 ? { breakLine: true } : {}),
    },
  })));
  const top = Math.max(0, b.lines[0].y - lh * 0.8);
  const height = Math.min(H - top, (b.lines.length - 1) * lh + lh * 1.1);
  const align = first.align === 'center' ? 'center' : first.align === 'right' || first.align === 'end' ? 'right' : 'left';
  const x = align === 'left' ? first.x : 40;
  const width = align === 'left' ? W - first.x - 30 : align === 'center' ? W - 80 : first.x - 40;
  slide.addText(runs, {
    x: x / PX, y: top / PX, w: Math.max(40, width) / PX, h: Math.max(20, height) / PX,
    margin: 0, valign: 'top', align, lineSpacing: +(lh * 0.75).toFixed(1), fit: 'none', isTextBox: true,
  });
}

/** The deck: one slide per card, the card's size, background picture plus live text. */
export async function buildDeck(w: Work, onCard: (n: number) => void): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  await ensureFonts(w);
  const H = cardHeight(w);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'CARD', width: W / PX, height: H / PX });
  pptx.layout = 'CARD';
  pptx.title = workTitle(w);
  for (let i = 0; i < w.cards.length; i++) {
    const { bg, blocks } = await cardParts(w, i);
    const slide = pptx.addSlide() as unknown as Slide;
    slide.addImage({ data: bg.replace(/^data:/, ''), x: 0, y: 0, w: W / PX, h: H / PX });
    for (const b of blocks) addBlock(slide, b, H);
    onCard(i + 1);
  }
  return (await pptx.write({ outputType: 'blob' })) as Blob;
}

export interface FinishDesign { id: string; editUrl: string; pages: number | null }

/** Builds the deck, uploads it, and has Canva make a design from it. */
export async function sendToCanva(w: Work, progress: (step: 'deck' | 'upload' | 'import', n?: number) => void): Promise<FinishDesign[]> {
  const deck = await buildDeck(w, (n) => progress('deck', n));
  progress('upload');
  let url: string;
  try {
    const r = await upload(`canva-import/${newId().toLowerCase().replace(/[^a-z0-9]/g, '')}.pptx`, deck, { access: 'public', handleUploadUrl: '/api/canva/finish-upload', contentType: PPTX_MIME });
    url = r.url;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    throw new CanvaError(/not_connected|401/.test(msg) ? 'not_connected' : /blob_not_configured/.test(msg) ? 'blob_not_configured' : 'upload_failed', msg);
  }
  progress('import');
  const res = await call('/finish-import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, title: workTitle(w).slice(0, 40) + ' 마감', state: canvaState(w.id, 'finish') }) });
  return ((await res.json()) as { designs: FinishDesign[] }).designs;
}

/** Exports the finished design and brings every page back as a 1080-wide JPEG data URL the size of the card. */
export async function fetchFinished(w: Work, designId: string, onPage: (n: number, total: number) => void): Promise<string[]> {
  const { urls } = (await (await call('/finish-export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ designId }) })).json()) as { urls: string[] };
  const H = cardHeight(w);
  const out: string[] = [];
  for (let k = 0; k < urls.length; k++) {
    const blob = await (await call(`/page?u=${encodeURIComponent(urls[k])}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const s = Math.max(W / bmp.width, H / bmp.height);
    c.getContext('2d')!.drawImage(bmp, (W - bmp.width * s) / 2, (H - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
    bmp.close();
    out.push(c.toDataURL('image/jpeg', 0.92));
    onPage(k + 1, urls.length);
  }
  return out;
}
