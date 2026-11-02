// Canvas card renderer, ported from the 카드소설 제작소 artifact.
// Picture on top, words below; without a picture the words sit in the middle.
import type { Card, Work } from './model';
import { parseMarks, seriesLine, TOTAL_CARDS, type TextPos } from './model';
import { fontForWork, ratioOf, themeOfWork, weightFor, type Theme } from './themes';

export const W = 1080;
export const PAD = 100;

export const cardHeight = (work: Pick<Work, 'ratio'>): number => ratioOf(work.ratio).h;

/** Effective layout: the cover can be full-bleed but not a quote card, the last card always stacks. */
export const layoutOf = (card: Card): NonNullable<Card['layout']> =>
  card.kind === 'outro' ? 'stack' : card.kind === 'cover' && card.layout === 'quote' ? 'stack' : card.layout || 'stack';

/** Height of a card's picture area: the whole card for full-bleed and quote cards, the top band otherwise. */
export const artHeight = (work: Pick<Work, 'ratio'>, card: Card): number => {
  if (card.kind === 'outro') return Math.round(cardHeight(work) * 0.42);
  return layoutOf(card) === 'stack' ? ratioOf(work.ratio).art : cardHeight(work);
};

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Breaks text into lines that fit maxW, preferring to break at a space near the end of the line (Korean has spaces between words). */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { lines.push(''); continue; }
    let line = '';
    let lastSpace = -1;
    for (const ch of para) {
      const test = line + ch;
      if (line.length && ctx.measureText(test).width > maxW) {
        if (lastSpace > 0 && ch !== ' ' && line.length - lastSpace < 9) {
          lines.push(line.slice(0, lastSpace));
          line = line.slice(lastSpace + 1) + ch;
        } else {
          lines.push(line);
          line = ch === ' ' ? '' : ch;
        }
        lastSpace = line.lastIndexOf(' ');
      } else {
        line = test;
        if (ch === ' ') lastSpace = line.length - 1;
      }
    }
    lines.push(line);
  }
  return lines;
}

/* ---------- emphasis: *words* in the accent colour ---------- */
export interface RichLine { text: string; marks: boolean[] }

/** wrap() for text with *emphasis* markers: the markers are removed and each line keeps a flag per character. */
export function wrapRich(ctx: CanvasRenderingContext2D, text: string, maxW: number): RichLine[] {
  const { plain, flags } = parseMarks(String(text ?? ''));
  const out: RichLine[] = [];
  let p = 0;
  for (const l of wrap(ctx, plain, maxW)) {
    if (!l) { out.push({ text: '', marks: [] }); continue; }
    // wrap() drops the newline between paragraphs and the space it breaks at; skip them
    while (p < plain.length && !plain.startsWith(l, p)) p++;
    out.push({ text: l, marks: flags.slice(p, p + l.length) });
    p += l.length;
  }
  return out;
}

/** Draws one line at x (honouring textAlign) in the current fill; marked runs in `emph`. */
export function drawRich(ctx: CanvasRenderingContext2D, rl: RichLine, x: number, y: number, emph: string): void {
  if (!rl.marks.some(Boolean)) { ctx.fillText(rl.text, x, y); return; }
  const base = ctx.fillStyle, align = ctx.textAlign;
  const total = ctx.measureText(rl.text).width;
  let cx = align === 'center' ? x - total / 2 : align === 'right' || align === 'end' ? x - total : x;
  ctx.textAlign = 'left';
  for (let i = 0; i < rl.text.length;) {
    const on = rl.marks[i];
    let j = i;
    while (j < rl.text.length && rl.marks[j] === on) j++;
    const seg = rl.text.slice(i, j);
    ctx.fillStyle = on ? emph : base;
    ctx.fillText(seg, cx, y);
    cx += ctx.measureText(seg).width;
    i = j;
  }
  ctx.fillStyle = base; ctx.textAlign = align;
}

/** The emphasis colour: the accent, or the text colour where the line itself is already in the accent. */
const emphFor = (ctx: CanvasRenderingContext2D, theme: Theme): string =>
  String(ctx.fillStyle).toLowerCase() === theme.accent.toLowerCase() ? theme.text : theme.accent;

/** 0 = top of the text zone, 1 = bottom; auto uses the layout's own default. */
const posF = (pos: TextPos | undefined, auto: number): number => (pos === 'top' ? 0 : pos === 'center' ? 0.5 : pos === 'bottom' ? 1 : auto);

let noiseTile: HTMLCanvasElement | null = null;
function makeNoise(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  const img = x.createImageData(256, 256);
  // fixed seed so the grain is the same on every render and every export
  let s = 1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (128 + (rnd() * 90 - 45)) | 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

function drawGround(ctx: CanvasRenderingContext2D, theme: Theme, H: number) {
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, theme.bg[0]);
  g.addColorStop(1, theme.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (theme.deco === 'glow') {
    const r1 = ctx.createRadialGradient(880, 140, 0, 880, 140, 620);
    r1.addColorStop(0, hexA(theme.accent, 0.22));
    r1.addColorStop(1, hexA(theme.accent, 0));
    ctx.fillStyle = r1;
    ctx.fillRect(0, 0, W, H);
    const r2 = ctx.createRadialGradient(120, H - 80, 0, 120, H - 80, 520);
    r2.addColorStop(0, 'rgba(255,255,255,0.07)');
    r2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = r2;
    ctx.fillRect(0, 0, W, H);
  }
  if (theme.deco === 'corners' && !theme.light) {
    const r = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, Math.max(W, H) * 0.83);
    r.addColorStop(0, 'rgba(255,220,160,0.06)');
    r.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawGrain(ctx: CanvasRenderingContext2D, theme: Theme, H: number) {
  if (!noiseTile) noiseTile = makeNoise();
  ctx.save();
  ctx.globalAlpha = theme.light ? 0.05 : 0.07;
  ctx.globalCompositeOperation = 'overlay';
  const pat = ctx.createPattern(noiseTile, 'repeat');
  if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
  const R = Math.max(W, H);
  const v = ctx.createRadialGradient(W / 2, H / 2, R * 0.35, W / 2, H / 2, R * 0.76);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, theme.light ? 'rgba(60,40,20,0.10)' : 'rgba(0,0,0,0.42)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function drawFrame(ctx: CanvasRenderingContext2D, theme: Theme, H: number, textTop: number) {
  const d = theme.deco;
  if (d === 'frame') {
    ctx.strokeStyle = hexA(theme.text, 0.35); ctx.lineWidth = 2; ctx.strokeRect(44, 44, W - 88, H - 88);
    ctx.strokeStyle = hexA(theme.text, 0.14); ctx.lineWidth = 1; ctx.strokeRect(56, 56, W - 112, H - 112);
  }
  if (d === 'bar') {
    ctx.save(); ctx.shadowColor = theme.accent; ctx.shadowBlur = 30; ctx.fillStyle = theme.accent;
    ctx.fillRect(PAD - 36, textTop, 6, H - 130 - textTop);
    ctx.restore();
  }
  if (d === 'corners') {
    ctx.strokeStyle = hexA(theme.accent, 0.6); ctx.lineWidth = 2;
    const L = 56, O = 60;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const cx = sx > 0 ? O : W - O, cy = sy > 0 ? O : H - O;
      ctx.beginPath(); ctx.moveTo(cx, cy + sy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * L, cy); ctx.stroke();
    }
  }
  if (d === 'panel') {
    ctx.save(); ctx.strokeStyle = theme.accent; ctx.lineWidth = 10; ctx.lineJoin = 'round';
    ctx.strokeRect(34, 34, W - 68, H - 68);
    ctx.strokeStyle = hexA(theme.bg[1], 0.9); ctx.lineWidth = 3; ctx.strokeRect(46, 46, W - 92, H - 92);
    ctx.restore();
  }
}

let offImg: HTMLCanvasElement | null = null;
function drawIllustration(ctx: CanvasRenderingContext2D, img: HTMLImageElement, imgH: number, theme: Theme, pos: Card['imgPos']) {
  if (!offImg) { offImg = document.createElement('canvas'); offImg.width = W; offImg.height = 1920; }
  const o = offImg.getContext('2d')!;
  o.globalCompositeOperation = 'source-over';
  o.clearRect(0, 0, W, offImg.height);
  const iw = img.naturalWidth || 1080, ih = img.naturalHeight || 640;
  const s = Math.max(W / iw, imgH / ih);
  const dw = iw * s, dh = ih * s;
  const dy = pos === 'top' ? 0 : pos === 'bottom' ? imgH - dh : (imgH - dh) / 2;
  o.drawImage(img, (W - dw) / 2, dy, dw, dh);
  o.save(); o.globalCompositeOperation = 'source-atop'; o.globalAlpha = theme.light ? 0.10 : 0.28; o.fillStyle = theme.bg[0]; o.fillRect(0, 0, W, imgH); o.restore();
  o.globalCompositeOperation = 'destination-out';
  const g = o.createLinearGradient(0, imgH - 190, 0, imgH);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,1)');
  o.fillStyle = g; o.fillRect(0, imgH - 190, W, 190);
  const gt = o.createLinearGradient(0, 0, 0, 90);
  gt.addColorStop(0, 'rgba(0,0,0,0.35)'); gt.addColorStop(1, 'rgba(0,0,0,0)');
  o.fillStyle = gt; o.fillRect(0, 0, W, 90);
  o.globalCompositeOperation = 'source-over';
  ctx.drawImage(offImg, 0, 0, W, imgH, 0, 0, W, imgH);
}

/** The picture over the whole card (full-bleed and quote cards), cropped to fill. */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, H: number, pos: Card['imgPos']) {
  const iw = img.naturalWidth || W, ih = img.naturalHeight || H;
  const s = Math.max(W / iw, H / ih);
  const dw = iw * s, dh = ih * s;
  const dy = pos === 'top' ? 0 : pos === 'bottom' ? H - dh : (H - dh) / 2;
  ctx.drawImage(img, (W - dw) / 2, dy, dw, dh);
}

/* ---------- pictures ---------- */
export function srcOf(card: Card): string | null {
  if (card.img) return card.img;
  if (card.svg) return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(card.svg);
  return null;
}
const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
export function loadImage(src: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  const hit = imgCache.get(src);
  if (hit) return hit;
  const p = new Promise<HTMLImageElement | null>((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
  imgCache.set(src, p);
  if (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value as string);
  return p;
}

/** Keeps only drawing elements of an AI-written SVG: no scripts, no outside links, fixed size. Ported from the artifact. */
export function sanitizeSVG(src: string): string | null {
  if (!src || src.length > 400000) return null;
  const m = String(src).match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  let doc: Document;
  try { doc = new DOMParser().parseFromString(m[0], 'image/svg+xml'); } catch { return null; }
  if (!doc || doc.getElementsByTagName('parsererror').length) return null;
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return null;
  const BAD = new Set(['script', 'foreignobject', 'image', 'a', 'iframe', 'video', 'audio', 'style', 'animate', 'animatetransform', 'animatemotion', 'set']);
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    const tag = el.nodeName.toLowerCase();
    if (BAD.has(tag)) { el.remove(); continue; }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase(), v = a.value;
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href') && !v.trim().startsWith('#')) el.removeAttribute(a.name);
      else if (/url\(\s*['"]?\s*(?!#)/i.test(v)) el.removeAttribute(a.name);
    }
  }
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  let vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(isNaN) || vb[2] <= 0 || vb[3] <= 0) { vb = [0, 0, 1080, 640]; root.setAttribute('viewBox', '0 0 1080 640'); }
  root.setAttribute('width', '1080');
  root.setAttribute('height', String(Math.round((1080 * vb[3]) / vb[2])));
  root.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  for (const a of Array.from(root.attributes)) if (a.name.toLowerCase().startsWith('on')) root.removeAttribute(a.name);
  return new XMLSerializer().serializeToString(root);
}

/* ---------- fonts ---------- */
export async function ensureFonts(work: Work): Promise<void> {
  if (!('fonts' in document)) return;
  const family = fontForWork(work);
  const text = work.cards.map((c) => c.title + c.text + c.label).join('') + work.series + work.handle + work.follow + '0123456789/?제목 없음';
  const w = weightFor(family);
  try {
    await Promise.all([
      document.fonts.load(`400 40px "${family}"`, text),
      document.fonts.load(`500 30px "${family}"`, text),
      document.fonts.load(`${w} 60px "${family}"`, text),
      document.fonts.load(`700 60px "Gowun Batang"`, '0123456789'),
    ]);
  } catch { /* render with the fallback font */ }
}

/* ---------- what a card's picture depends on (to skip redrawing unchanged thumbnails) ---------- */
const fp = (s?: string) => (s ? `${s.length}:${s.slice(-40)}` : '');
export function lookSig(w: Work): string {
  return JSON.stringify([w.theme, w.customTheme, w.font, w.ratio, w.series, w.handle, w.follow, w.episode, w.outroKind,
    w.brand ? { ...w.brand, logo: fp(w.brand.logo) } : null, !!w.finished?.on]);
}
export function cardSig(w: Work, i: number, look = lookSig(w)): string {
  const c = w.cards[i];
  if (!c) return look;
  return look + JSON.stringify([c.kind, c.label, c.showLabel, c.title, c.text, c.accent, c.layout, c.textScale, c.textPos, c.imgPos,
    fp(c.img), fp(c.svg), w.finished?.on ? fp(w.finished.images[i]) : '']);
}

/* ---------- the card ---------- */
export async function renderCard(ctx: CanvasRenderingContext2D, work: Work, index: number): Promise<void> {
  const card = work.cards[index];
  const H = cardHeight(work);
  // the version finished in Canva replaces the drawn card everywhere (preview, files, video, links)
  const fin = work.finished;
  if (fin?.on && fin.images[index]) {
    const im = await loadImage(fin.images[index]);
    if (im) { ctx.clearRect(0, 0, W, H); ctx.drawImage(im, 0, 0, W, H); return; }
  }
  const theme = themeOfWork(work);
  const family = fontForWork(work);
  const bold = weightFor(family);
  const fam = `"${family}", "Noto Serif KR", serif`;
  const img = await loadImage(srcOf(card));
  const ts = H >= 1800 ? 1.22 : H >= 1400 ? 1.08 : 1; // taller cards get larger type so the text zone does not look empty
  const sc = Math.max(0.7, Math.min(1.5, card.textScale || 1)); // the writer's size choice for this card
  const maxW = W - PAD * 2;
  const setSpacing = (px: number) => { try { (ctx as unknown as { letterSpacing: string }).letterSpacing = px + 'px'; } catch { /* older browsers */ } };

  ctx.clearRect(0, 0, W, H);
  drawGround(ctx, theme, H);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  if (card.kind === 'outro') {
    renderOutro(ctx, work, card, img, { H, theme, fam, bold, ts, maxW, setSpacing, index, sc });
  } else {
    const isCover = card.kind === 'cover';
    const eyebrow = card.showLabel ? (isCover ? seriesLine(work) : card.label || '') : '';
    const title = isCover ? card.title || '제목 없음' : (card.title || '').trim();
    const body = card.text || '';
    const strong = card.accent || isCover;
    // an accented body card without an eyebrow still gets the short accent bar above its text
    const markOnly = !eyebrow && card.accent && !isCover;
    const layout = layoutOf(card);
    const t: TextParts = { eyebrow, title, body, strong, markOnly, isCover, accent: card.accent };

    if (layout === 'full' && img) {
      renderFull(ctx, work, card, img, t, { H, theme, fam, bold, ts: ts * sc, maxW, setSpacing, index });
    } else if (layout === 'quote') {
      renderQuote(ctx, card, img, t, { H, theme, fam, bold, ts: ts * sc, maxW, setSpacing, index });
    } else if (img) {
      let tSize = Math.round((isCover ? 92 : 52) * ts * sc), bSize = Math.round((isCover ? 38 : 42) * ts * sc);
      const bLH = () => bSize * (isCover ? 1.6 : 1.68), tLH = () => tSize * 1.25;
      const measure = () => {
        ctx.font = `${bold} ${tSize}px ${fam}`; const tl = title ? wrapRich(ctx, title, maxW) : [];
        ctx.font = `400 ${bSize}px ${fam}`; const bl = body ? wrapRich(ctx, body, maxW) : [];
        const h = (eyebrow ? 64 : markOnly ? 34 : 0) + tl.length * tLH() + (tl.length && bl.length ? 22 : 0) + bl.length * bLH();
        return { tl, bl, h };
      };
      const minImg = Math.round(H * (isCover ? 0.40 : 0.37));
      const maxImg = Math.min(Math.round(H * (isCover ? 0.555 : 0.575)), Math.round(W * 0.9));
      const textBottom = H - 130, gapTop = 50;
      let r = measure();
      while (r.h > textBottom - gapTop - minImg && bSize > 28) { bSize -= 2; tSize = Math.max(isCover ? 60 : 40, tSize - 2); r = measure(); }
      const imgH = Math.max(minImg, Math.min(maxImg, textBottom - gapTop - r.h));
      drawIllustration(ctx, img, imgH, theme, card.imgPos);
      drawGrain(ctx, theme, H);
      const textTop = imgH + 40;
      let y = textTop + Math.max(0, (textBottom - textTop - r.h) * posF(card.textPos, 0.5));
      drawFrame(ctx, theme, H, textTop);
      if (eyebrow) {
        ctx.font = `500 30px ${fam}`; setSpacing(5); ctx.fillStyle = theme.accent;
        ctx.fillText(eyebrow, PAD, y + 30); setSpacing(0);
        if (strong) ctx.fillRect(PAD, y + 46, 56, 4);
        y += 64;
      } else if (markOnly) {
        ctx.fillStyle = theme.accent; ctx.fillRect(PAD, y + 4, 56, 4);
        y += 34;
      }
      if (r.tl.length) {
        ctx.fillStyle = card.accent && !isCover ? theme.accent : theme.text; ctx.font = `${bold} ${tSize}px ${fam}`;
        if (work.theme === 'neon' && isCover) { ctx.shadowColor = theme.accent; ctx.shadowBlur = 24; }
        y += tSize * 0.82;
        const em = emphFor(ctx, theme);
        for (const l of r.tl) { drawRich(ctx, l, PAD, y, em); y += tLH(); }
        ctx.shadowBlur = 0; y += (r.bl.length ? 22 : 0) - tSize * 0.82 + tLH() * 0.02;
      }
      if (r.bl.length) {
        ctx.fillStyle = isCover ? hexA(theme.text, 0.82) : theme.text; ctx.font = `400 ${bSize}px ${fam}`;
        y += bSize * 0.82;
        for (const l of r.bl) { drawRich(ctx, l, PAD, y, theme.accent); y += bLH(); }
      }
    } else {
      drawGrain(ctx, theme, H);
      drawFrame(ctx, theme, H, 200);
      if (theme.deco === 'number') {
        ctx.fillStyle = hexA(theme.accent, 0.08); ctx.font = `700 460px "Gowun Batang", serif`; ctx.textAlign = 'right';
        ctx.fillText(String(index + 1).padStart(2, '0'), W - 40, H - 30); ctx.textAlign = 'left';
      }
      if (eyebrow) {
        ctx.font = `500 30px ${fam}`; setSpacing(5); ctx.fillStyle = theme.accent; ctx.fillText(eyebrow, PAD, 150); setSpacing(0);
        if (strong) ctx.fillRect(PAD, 172, 56, 4);
      } else if (markOnly) {
        ctx.fillStyle = theme.accent; ctx.fillRect(PAD, 172, 56, 4);
      }
      let tSize = Math.round((isCover ? 108 : 56) * ts * sc), bSize = Math.round((isCover ? 40 : 46) * ts * sc);
      const fits = () => {
        ctx.font = `${bold} ${tSize}px ${fam}`; const tl = title ? wrapRich(ctx, title, maxW) : [];
        ctx.font = `400 ${bSize}px ${fam}`; const bl = body ? wrapRich(ctx, body, maxW) : [];
        return { tl, bl, h: tl.length * tSize * 1.25 + (tl.length ? 28 : 0) + bl.length * bSize * 1.7 };
      };
      const availNo = H - 380;
      let r = fits();
      while (r.h > availNo && bSize > 30) { bSize -= 2; tSize = Math.max(44, tSize - 2); r = fits(); }
      let y = 220 + (availNo - r.h) * posF(card.textPos, 0.5);
      if (r.tl.length) {
        ctx.fillStyle = card.accent && !isCover ? theme.accent : theme.text; ctx.font = `${bold} ${tSize}px ${fam}`;
        if (work.theme === 'neon' && isCover) { ctx.shadowColor = theme.accent; ctx.shadowBlur = 24; }
        y += tSize * 0.85;
        const em = emphFor(ctx, theme);
        for (const l of r.tl) { drawRich(ctx, l, PAD, y, em); y += tSize * 1.25; }
        ctx.shadowBlur = 0; y += 28 - tSize * 0.85;
      }
      ctx.fillStyle = isCover ? hexA(theme.text, 0.82) : theme.text; ctx.font = `400 ${bSize}px ${fam}`;
      y += bSize * 0.85;
      for (const l of r.bl) { drawRich(ctx, l, PAD, y, theme.accent); y += bSize * 1.7; }
    }
  }

  /* ---- footer: series (or handle on the cover) left, card number right ---- */
  ctx.font = `500 26px ${fam}`; setSpacing(2); ctx.fillStyle = hexA(theme.text, 0.55);
  ctx.textAlign = 'left';
  if (card.kind === 'cover') ctx.fillText(work.handle || '', PAD, H - 88);
  else ctx.fillText(work.series || '', PAD, H - 88);
  ctx.textAlign = 'right';
  ctx.fillText(`${String(index + 1).padStart(2, '0')} / ${String(TOTAL_CARDS).padStart(2, '0')}`, W - PAD, H - 88);
  ctx.textAlign = 'left'; setSpacing(0);

  await drawBrand(ctx, work, index, H, theme, fam);
}

/** The writer's logo (or handle) in a corner; bottom corners sit above the footer line. */
async function drawBrand(ctx: CanvasRenderingContext2D, work: Work, index: number, H: number, theme: Theme, fam: string) {
  const b = work.brand;
  if (!b) return;
  const card = work.cards[index];
  if (b.scope === 'cover' && card.kind !== 'cover') return;
  if (b.scope === 'ends' && card.kind === 'body') return;
  const m = 56;
  const top = b.pos[0] === 't', left = b.pos[1] === 'l';
  ctx.save();
  ctx.globalAlpha = Math.max(0.15, Math.min(1, b.opacity));
  if (b.kind === 'logo' && b.logo) {
    const img = await loadImage(b.logo);
    if (img) {
      const w = Math.round((W * Math.max(4, Math.min(30, b.size))) / 100);
      const h = Math.round((w * (img.naturalHeight || 1)) / (img.naturalWidth || 1));
      ctx.drawImage(img, left ? m : W - m - w, top ? m : H - 130 - h, w, h);
    }
  } else if (work.handle) {
    ctx.font = `600 ${Math.round(18 + b.size * 1.1)}px ${fam}`;
    try { (ctx as unknown as { letterSpacing: string }).letterSpacing = '1px'; } catch { /* older browsers */ }
    ctx.fillStyle = theme.text;
    if (!theme.light) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8; }
    ctx.textAlign = left ? 'left' : 'right';
    ctx.textBaseline = top ? 'top' : 'alphabetic';
    ctx.fillText(work.handle, left ? m : W - m, top ? m : H - 130);
    try { (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px'; } catch { /* older browsers */ }
  }
  ctx.restore();
}

interface Ctx {
  H: number; theme: Theme; fam: string; bold: number; ts: number; maxW: number; index: number;
  setSpacing: (px: number) => void;
  /** the writer's size choice (outro only; the other layouts get it folded into ts) */
  sc?: number;
}
interface TextParts { eyebrow: string; title: string; body: string; strong: boolean; markOnly: boolean; isCover: boolean; accent: boolean }

/** Full-bleed: the picture fills the card and the words sit over a shade at the bottom. */
function renderFull(ctx: CanvasRenderingContext2D, work: Work, card: Card, img: HTMLImageElement, t: TextParts, c: Ctx) {
  const { H, theme, fam, bold, ts, maxW, setSpacing } = c;
  drawCover(ctx, img, H, card.imgPos);
  // a light wash in the theme colour keeps pictures from different sources looking like one set
  ctx.save(); ctx.globalAlpha = theme.light ? 0.08 : 0.16; ctx.fillStyle = theme.bg[0]; ctx.fillRect(0, 0, W, H); ctx.restore();

  let tSize = Math.round((t.isCover ? 100 : 54) * ts), bSize = Math.round((t.isCover ? 40 : 44) * ts);
  const tLH = () => tSize * 1.25, bLH = () => bSize * 1.66;
  const measure = () => {
    ctx.font = `${bold} ${tSize}px ${fam}`; const tl = t.title ? wrapRich(ctx, t.title, maxW) : [];
    ctx.font = `400 ${bSize}px ${fam}`; const bl = t.body ? wrapRich(ctx, t.body, maxW) : [];
    return { tl, bl, h: (t.eyebrow ? 64 : t.markOnly ? 34 : 0) + tl.length * tLH() + (tl.length && bl.length ? 22 : 0) + bl.length * bLH() };
  };
  let r = measure();
  while (r.h > H * 0.5 && bSize > 28) { bSize -= 2; tSize = Math.max(t.isCover ? 60 : 40, tSize - 2); r = measure(); }
  const f = posF(card.textPos, 1); // the words sit at the bottom unless the writer moved them
  const textTop = 150 + (H - 300 - r.h) * f;
  const textBottom = textTop + r.h;

  // a shade under the words so they read on any picture
  const base = theme.light ? theme.bg[0] : theme.bg[1];
  const strong = theme.light ? 0.78 : 0.72;
  if (f >= 1) {
    const shadeTop = Math.max(0, textTop - Math.round(H * 0.22));
    const g = ctx.createLinearGradient(0, shadeTop, 0, H);
    g.addColorStop(0, hexA(base, 0)); g.addColorStop(0.45, hexA(base, strong)); g.addColorStop(1, hexA(base, 0.94));
    ctx.fillStyle = g; ctx.fillRect(0, shadeTop, W, H - shadeTop);
    const gt = ctx.createLinearGradient(0, 0, 0, 160);
    gt.addColorStop(0, hexA(base, 0.35)); gt.addColorStop(1, hexA(base, 0));
    ctx.fillStyle = gt; ctx.fillRect(0, 0, W, 160);
  } else if (f <= 0) {
    const shadeBottom = Math.min(H, textBottom + Math.round(H * 0.22));
    const g = ctx.createLinearGradient(0, 0, 0, shadeBottom);
    g.addColorStop(0, hexA(base, 0.94)); g.addColorStop(0.55, hexA(base, strong)); g.addColorStop(1, hexA(base, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, shadeBottom);
    const gb = ctx.createLinearGradient(0, H - 200, 0, H);
    gb.addColorStop(0, hexA(base, 0)); gb.addColorStop(1, hexA(base, 0.5));
    ctx.fillStyle = gb; ctx.fillRect(0, H - 200, W, 200);
  } else {
    const a = Math.max(0, textTop - Math.round(H * 0.18)), b = Math.min(H, textBottom + Math.round(H * 0.18));
    const g = ctx.createLinearGradient(0, a, 0, b);
    g.addColorStop(0, hexA(base, 0)); g.addColorStop((textTop - a) / (b - a), hexA(base, strong));
    g.addColorStop((textBottom - a) / (b - a), hexA(base, strong)); g.addColorStop(1, hexA(base, 0));
    ctx.fillStyle = g; ctx.fillRect(0, a, W, b - a);
    const gb = ctx.createLinearGradient(0, H - 200, 0, H);
    gb.addColorStop(0, hexA(base, 0)); gb.addColorStop(1, hexA(base, 0.5));
    ctx.fillStyle = gb; ctx.fillRect(0, H - 200, W, 200);
  }
  drawGrain(ctx, theme, H);
  drawFrame(ctx, theme, H, textTop);

  let y = textTop;
  if (!theme.light) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 14; }
  if (t.eyebrow) {
    ctx.font = `500 30px ${fam}`; setSpacing(5); ctx.fillStyle = theme.accent;
    ctx.fillText(t.eyebrow, PAD, y + 30); setSpacing(0);
    if (t.strong) ctx.fillRect(PAD, y + 46, 56, 4);
    y += 64;
  } else if (t.markOnly) {
    ctx.fillStyle = theme.accent; ctx.fillRect(PAD, y + 4, 56, 4);
    y += 34;
  }
  if (r.tl.length) {
    ctx.fillStyle = t.accent && !t.isCover ? theme.accent : theme.text; ctx.font = `${bold} ${tSize}px ${fam}`;
    if (work.theme === 'neon' && t.isCover) { ctx.shadowColor = theme.accent; ctx.shadowBlur = 24; }
    y += tSize * 0.82;
    const em = emphFor(ctx, theme);
    for (const l of r.tl) { drawRich(ctx, l, PAD, y, em); y += tLH(); }
    if (!theme.light) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 14; } else ctx.shadowBlur = 0;
    y += (r.bl.length ? 22 : 0) - tSize * 0.82 + tLH() * 0.02;
  }
  if (r.bl.length) {
    ctx.fillStyle = t.isCover ? hexA(theme.text, 0.86) : theme.text; ctx.font = `400 ${bSize}px ${fam}`;
    y += bSize * 0.82;
    for (const l of r.bl) { drawRich(ctx, l, PAD, y, theme.accent); y += bLH(); }
  }
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
}

/** Quote card: one line of dialogue set large in the middle, the picture (if any) faint behind it. */
function renderQuote(ctx: CanvasRenderingContext2D, card: Card, img: HTMLImageElement | null, t: TextParts, c: Ctx) {
  const { H, theme, fam, bold, ts, setSpacing } = c;
  if (img) {
    drawCover(ctx, img, H, card.imgPos);
    const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, hexA(theme.bg[0], theme.light ? 0.84 : 0.8)); g.addColorStop(1, hexA(theme.bg[1], theme.light ? 0.9 : 0.88));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  drawGrain(ctx, theme, H);
  drawFrame(ctx, theme, H, 200);
  if (t.eyebrow) {
    ctx.font = `500 30px ${fam}`; setSpacing(5); ctx.fillStyle = theme.accent; ctx.fillText(t.eyebrow, PAD, 150); setSpacing(0);
    if (t.strong) ctx.fillRect(PAD, 172, 56, 4);
  } else if (t.markOnly) {
    ctx.fillStyle = theme.accent; ctx.fillRect(PAD, 172, 56, 4);
  }

  // the words without the quotation marks the writer may have typed; the card draws its own
  const line = t.body.trim().replace(/^["“”'‘’「『]+|["“”'‘’」』]+$/g, '').trim();
  const speaker = t.title.trim();
  const qW = W - PAD * 2 - 40;
  let qSize = Math.round(60 * ts);
  const qLH = () => qSize * 1.55;
  ctx.textAlign = 'center';
  const measure = () => { ctx.font = `${bold} ${qSize}px ${fam}`; return line ? wrapRich(ctx, line, qW) : []; };
  let ql = measure();
  const sH = speaker ? 34 * ts * 1.6 + 30 : 0;
  const avail = H - 420;
  while (ql.length * qLH() + sH > avail && qSize > 34) { qSize -= 2; ql = measure(); }
  const blockH = ql.length * qLH() + sH;
  let y = 240 + Math.max(0, (avail - blockH) * posF(card.textPos, 0.5));

  // a large opening mark above the words
  ctx.save();
  ctx.fillStyle = hexA(theme.accent, 0.55); ctx.font = `700 ${Math.round(200 * ts)}px "Gowun Batang", "Noto Serif KR", serif`;
  ctx.fillText('“', W / 2, y + Math.round(40 * ts));
  ctx.restore();
  y += Math.round(60 * ts);

  ctx.fillStyle = t.accent ? theme.accent : theme.text; ctx.font = `${bold} ${qSize}px ${fam}`;
  y += qSize * 0.85;
  const em = emphFor(ctx, theme);
  for (const l of ql) { drawRich(ctx, l, W / 2, y, em); y += qLH(); }
  y -= qSize * 0.85;
  if (speaker) {
    ctx.fillStyle = hexA(theme.text, 0.7); ctx.font = `500 ${Math.round(34 * ts)}px ${fam}`; setSpacing(2);
    y += 30 + 34 * ts;
    ctx.fillText(`— ${speaker}`, W / 2, y); setSpacing(0);
  }
  ctx.textAlign = 'left';
}

/** The 20th card: the add-on line the writer picked (question, teaser, …) above the fixed follow line and handle. */
function renderOutro(ctx: CanvasRenderingContext2D, work: Work, card: Card, img: HTMLImageElement | null, c: Ctx) {
  const { H, theme, fam, bold, ts, maxW, setSpacing } = c;
  const addon = work.outroKind === 'none' ? '' : (card.text || '').trim();
  const eyebrow = card.showLabel ? seriesLine(work) : '';
  let top = 220;
  const bottom = H - 170;

  if (img) {
    const imgH = Math.round(H * 0.42);
    drawIllustration(ctx, img, imgH, theme, card.imgPos);
    drawGrain(ctx, theme, H);
    drawFrame(ctx, theme, H, imgH + 40);
    top = imgH + 60;
  } else {
    drawGrain(ctx, theme, H);
    drawFrame(ctx, theme, H, 200);
    if (work.outroKind === 'question') {
      ctx.save(); ctx.fillStyle = hexA(theme.accent, 0.09); ctx.font = `${bold} 620px ${fam}`; ctx.textAlign = 'right';
      ctx.fillText('?', W - 30, Math.round(H * 0.7)); ctx.restore(); ctx.textAlign = 'left';
    } else if (theme.deco === 'number') {
      ctx.fillStyle = hexA(theme.accent, 0.08); ctx.font = `700 460px "Gowun Batang", serif`; ctx.textAlign = 'right';
      ctx.fillText(String(TOTAL_CARDS), W - 40, H - 30); ctx.textAlign = 'left';
    }
  }

  if (eyebrow) {
    const ey = img ? top - 4 : 150;
    ctx.font = `500 30px ${fam}`; setSpacing(5); ctx.fillStyle = theme.accent; ctx.fillText(eyebrow, PAD, ey); setSpacing(0);
    ctx.fillRect(PAD, ey + 22, 56, 4);
    if (img) top += 64;
  }

  // fixed block: follow line + handle
  const fSize = Math.round(36 * ts), hSize = Math.round(60 * ts);
  ctx.font = `500 ${fSize}px ${fam}`;
  const fl = work.follow ? wrap(ctx, work.follow, maxW) : [];
  ctx.font = `${bold} ${hSize}px ${fam}`;
  const hl = work.handle ? wrap(ctx, work.handle, maxW) : [];
  const blockH = (fl.length ? fl.length * fSize * 1.5 : 0) + (hl.length ? hl.length * hSize * 1.25 + 12 : 0);

  // add-on line above it, shrunk until it fits
  let aSize = Math.round(46 * ts * (c.sc || 1));
  const room = () => bottom - blockH - 72 - top;
  ctx.font = `400 ${aSize}px ${fam}`;
  let al = addon ? wrapRich(ctx, addon, maxW) : [];
  while (addon && al.length * aSize * 1.7 > room() && aSize > 30) { aSize -= 2; ctx.font = `400 ${aSize}px ${fam}`; al = wrapRich(ctx, addon, maxW); }
  const aH = al.length * aSize * 1.7;

  let blockTop: number;
  if (al.length) {
    let y = top + Math.max(0, (room() - aH) / 2);
    ctx.fillStyle = theme.text; ctx.font = `400 ${aSize}px ${fam}`;
    y += aSize * 0.85;
    for (const l of al) { drawRich(ctx, l, PAD, y, theme.accent); y += aSize * 1.7; }
    blockTop = bottom - blockH;
  } else {
    blockTop = top + Math.max(0, (bottom - top - blockH) / 2);
  }

  if (fl.length || hl.length) {
    ctx.fillStyle = hexA(theme.accent, 0.8);
    ctx.fillRect(PAD, blockTop - 36, 56, 3);
  }
  let y = blockTop;
  if (fl.length) {
    ctx.fillStyle = theme.accent; ctx.font = `500 ${fSize}px ${fam}`;
    y += fSize * 0.9;
    for (const l of fl) { ctx.fillText(l, PAD, y); y += fSize * 1.5; }
    y -= fSize * 0.9;
  }
  if (hl.length) {
    ctx.fillStyle = theme.text; ctx.font = `${bold} ${hSize}px ${fam}`;
    y += 12 + hSize * 0.95;
    for (const l of hl) { ctx.fillText(l, PAD, y); y += hSize * 1.25; }
  }
}
