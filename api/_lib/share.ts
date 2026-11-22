// Share links: the 20 cards as public images in Vercel Blob, a small manifest, and a swipe viewer page at /s/<id>.
// Only the owner can create or delete links: requests carry SHARE_KEY (set in Vercel, typed once in the app's settings).
import { HttpError } from './canva.js';

export interface ShareManifest {
  v: 1;
  id: string;
  title: string;
  hook: string;
  caption: string;
  handle: string;
  series: string;
  /** card ratio, e.g. "4:5" */
  ratio: string;
  images: string[];
  createdAt: number;
}

export const ID_RE = /^[a-z0-9]{10,24}$/;
export const imagePath = (id: string, n: number): string => `shares/${id}/${String(n).padStart(2, '0')}.jpg`;
export const manifestPath = (id: string): string => `shares/${id}/manifest.json`;
const RATIOS: Record<string, [number, number]> = { '1:1': [1, 1], '4:5': [4, 5], '3:4': [3, 4], '9:16': [9, 16] };

export function shareKeyConfigured(): boolean {
  return !!process.env.SHARE_KEY && !!process.env.BLOB_READ_WRITE_TOKEN;
}

/** Compares the request's key with SHARE_KEY without leaking where they differ. */
export async function checkKey(req: Request): Promise<void> {
  const want = process.env.SHARE_KEY;
  if (!want || !process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, 'share_not_configured');
  const got = req.headers.get('x-share-key') || '';
  const [a, b] = await Promise.all([got, want].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0 || !got) throw new HttpError(401, 'bad_share_key');
}

export function validId(id: unknown): string {
  const s = String(id ?? '');
  if (!ID_RE.test(s)) throw new HttpError(400, 'bad_id');
  return s;
}

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v : '').slice(0, n);

/** Checks a manifest from the app: every picture must be one this link uploaded to the store. */
export function validateManifest(raw: unknown, id: string): ShareManifest {
  const m = (raw ?? {}) as Record<string, unknown>;
  const images = Array.isArray(m.images) ? m.images.map(String) : [];
  if (images.length < 1 || images.length > 20) throw new HttpError(400, 'bad_images');
  images.forEach((u, i) => {
    let url: URL;
    try { url = new URL(u); } catch { throw new HttpError(400, 'bad_images'); }
    if (url.protocol !== 'https:' || !/\.public\.blob\.vercel-storage\.com$/.test(url.hostname) || url.pathname !== '/' + imagePath(id, i + 1) || url.search) {
      throw new HttpError(400, 'bad_images');
    }
  });
  const ratio = typeof m.ratio === 'string' && RATIOS[m.ratio] ? m.ratio : '1:1';
  return {
    v: 1, id,
    title: clip(m.title, 120) || '카드소설',
    hook: clip(m.hook, 200),
    caption: clip(m.caption, 2200),
    handle: clip(m.handle, 60),
    series: clip(m.series, 80),
    ratio, images,
    createdAt: Date.now(),
  };
}

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function notFoundPage(origin: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>카드소설</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0F1015;color:#E8EAF1;font:15px/1.6 "Noto Sans KR",system-ui,sans-serif;text-align:center}a{color:#E37A8B}</style></head>
<body><div><p>이 카드소설 링크는 없거나 지워졌어요.</p><p><a href="${esc(origin)}/">카드소설 제작소</a></p></div></body></html>`;
}

/** The viewer: swipe (or arrow keys) through the cards, caption below. Open Graph tags give link previews the cover. */
export function sharePage(m: ShareManifest, origin: string, nonce: string): string {
  const [rw, rh] = RATIOS[m.ratio] ?? [1, 1];
  const url = `${origin}/s/${m.id}`;
  const desc = m.hook || m.caption.split('\n')[0] || '넘기면서 읽는 카드소설';
  const n = m.images.length;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0F1015">
<title>${esc(m.title)}${m.series ? ` · ${esc(m.series)}` : ''}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(m.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(m.images[0])}">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="${Math.round((1080 * rh) / rw)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Noto+Serif+KR:wght@700&display=swap">
<style nonce="${nonce}">
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;background:#0F1015;color:#E8EAF1;font:15px/1.65 "Noto Sans KR","Apple SD Gothic Neo",system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:20px 16px 40px}
  .wrap{width:min(100%,560px,calc((100dvh - 190px) * ${rw} / ${rh}));min-width:min(100%,280px)}
  header{display:flex;align-items:baseline;gap:10px;margin:0 2px 12px}
  header h1{margin:0;font:700 19px/1.3 "Noto Serif KR",serif;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  header span{color:#9AA1B4;font-size:13px;white-space:nowrap}
  .media{position:relative;aspect-ratio:${rw}/${rh};background:#000;border-radius:10px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,.5)}
  .track{display:flex;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;outline:none}
  .track::-webkit-scrollbar{display:none}
  .track img{flex:none;width:100%;height:100%;object-fit:cover;scroll-snap-align:start;user-select:none;-webkit-user-drag:none}
  .count{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.6);color:#fff;font-size:12px;border-radius:12px;padding:2px 9px;font-variant-numeric:tabular-nums}
  .nav{position:absolute;top:50%;width:36px;height:36px;margin-top:-18px;border-radius:50%;border:0;background:rgba(255,255,255,.88);color:#222;font-size:22px;line-height:1;cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,.35)}
  .nav.prev{left:10px}.nav.next{right:10px}.nav[hidden]{display:none}
  .dots{display:flex;justify-content:center;gap:4px;margin:12px 0 4px;flex-wrap:wrap}
  .dots i{width:6px;height:6px;border-radius:50%;background:#3A3F4E}.dots i.on{background:#E37A8B}
  .caption{white-space:pre-wrap;color:#C9CDD8;margin:14px 2px 0;font-size:14px}
  footer{margin-top:28px;font-size:12.5px;color:#7D8496}
  footer a{color:#E37A8B;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <header><h1>${esc(m.title)}</h1><span>${esc([m.series, m.handle].filter(Boolean).join(' · '))}</span></header>
  <div class="media">
    <div class="track" id="track" tabindex="0" aria-label="카드 ${n}장, 옆으로 넘겨 읽기">
      ${m.images.map((u, i) => `<img src="${esc(u)}" alt="${i + 1}번 카드" ${i > 1 ? 'loading="lazy"' : ''} draggable="false">`).join('\n      ')}
    </div>
    <span class="count" id="count">1/${n}</span>
    <button class="nav prev" id="prev" type="button" aria-label="이전 카드" hidden>‹</button>
    <button class="nav next" id="next" type="button" aria-label="다음 카드">›</button>
  </div>
  <div class="dots" id="dots">${m.images.map((_, i) => `<i${i ? '' : ' class="on"'}></i>`).join('')}</div>
  ${m.caption ? `<p class="caption">${esc(m.caption)}</p>` : ''}
  <footer>${m.handle ? `${esc(m.handle)} · ` : ''}<a href="${esc(origin)}/">카드소설 제작소</a>로 만들었어요</footer>
</div>
<script nonce="${nonce}">
(function(){
  var t=document.getElementById('track'),c=document.getElementById('count'),p=document.getElementById('prev'),x=document.getElementById('next'),d=document.getElementById('dots').children,n=${n};
  function at(){return Math.round(t.scrollLeft/Math.max(1,t.clientWidth));}
  function go(i){t.scrollTo({left:Math.max(0,Math.min(n-1,i))*t.clientWidth,behavior:'smooth'});}
  function sync(){var i=at();c.textContent=(i+1)+'/'+n;p.hidden=i<=0;x.hidden=i>=n-1;for(var k=0;k<d.length;k++)d[k].className=k===i?'on':'';}
  t.addEventListener('scroll',function(){requestAnimationFrame(sync);},{passive:true});
  p.addEventListener('click',function(){go(at()-1);});x.addEventListener('click',function(){go(at()+1);});
  document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'){go(at()+1);}else if(e.key==='ArrowLeft'){go(at()-1);}});
  sync();
})();
</script>
</body>
</html>`;
}

export const randomNonce = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
