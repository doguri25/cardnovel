// Saving cards: one image, all 20 in a ZIP, or handed to another app (Instagram) through the share sheet.
import { busy } from './busy';
import { stripMarks, type Work } from './model';
import { cardHeight, ensureFonts, renderCard, W } from './render';

export type ImgFormat = 'png' | 'jpg';

export async function renderToBlob(w: Work, i: number, fmt: ImgFormat): Promise<Blob> {
  await ensureFonts(w);
  const c = document.createElement('canvas');
  c.width = W; c.height = cardHeight(w);
  await renderCard(c.getContext('2d')!, w, i);
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92));
}

export const fileBase = (w: Work): string => ((w.cards[0]?.title || '카드소설').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '카드소설');
export const cardFileName = (w: Work, i: number, fmt: ImgFormat): string => `${fileBase(w)}_${String(i + 1).padStart(2, '0')}.${fmt}`;

/* ---- ZIP writer (store only: the images are already compressed). Ported from the artifact. ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
export function crc32(u8: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files: { name: string; data: Uint8Array }[], now = new Date()): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' });
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// these run for a while: a background update waits for them (see busy.ts)
export function renderAll(w: Work, fmt: ImgFormat, onProgress?: (n: number) => void): Promise<File[]> {
  return busy(async () => {
    const out: File[] = [];
    for (let i = 0; i < w.cards.length; i++) {
      const b = await renderToBlob(w, i, fmt);
      out.push(new File([b], cardFileName(w, i, fmt), { type: b.type }));
      onProgress?.(i + 1);
    }
    return out;
  });
}

export function zipAll(w: Work, fmt: ImgFormat, onProgress?: (n: number) => void): Promise<Blob> {
  return busy(async () => {
    const files = await renderAll(w, fmt, onProgress);
    const data = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    return makeZip(data);
  });
}

export function captionText(w: Work): string {
  const cover = w.cards[0];
  const tags = w.hashtags.length ? w.hashtags : ['#카드소설', '#초단편', '#짧은소설', '#' + (w.series || '').replace(/\s+/g, '')];
  return [stripMarks(cover.title), stripMarks(cover.text), '', w.caption || '넘기면서 끝까지 읽어 주세요.', '', tags.filter((t) => t.length > 1).join(' ')].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const canShareFiles = (files: File[]): boolean => {
  try { return !!navigator.canShare && navigator.canShare({ files }); } catch { return false; }
};

/** Hands the 20 JPEG cards to the phone's share sheet (pick Instagram there). */
export async function shareCards(files: File[], text: string): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (!canShareFiles(files)) return 'unsupported';
  try { await busy(() => navigator.share({ files, text })); return 'shared'; } catch (e) {
    return (e as DOMException)?.name === 'AbortError' ? 'cancelled' : 'unsupported';
  }
}
