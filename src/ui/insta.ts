// Instagram preview: how the 20-card post reads in the feed (swipe, dots, caption) and how the cover sits in the profile grid.
import type { App } from '../app';
import { captionText } from '../export';
import { workTitle, type Work } from '../model';
import { cardHeight, ensureFonts, renderCard, W } from '../render';
import { works } from '../store';
import { $, esc, openModal } from './dom';

const PREVIEW_W = 540;

/** The feed shows 1:1 up to 3:4; taller cards (9:16) are cropped to 4:5 in a carousel. */
export function feedAspect(ratio: string): { w: number; h: number; cropped: boolean } {
  if (ratio === '1:1') return { w: 1, h: 1, cropped: false };
  if (ratio === '4:5') return { w: 4, h: 5, cropped: false };
  if (ratio === '3:4') return { w: 3, h: 4, cropped: false };
  return { w: 4, h: 5, cropped: true };
}

async function renderPreviews(w: Work, onProgress: (n: number) => void): Promise<string[]> {
  await ensureFonts(w);
  const H = cardHeight(w);
  const full = document.createElement('canvas'); full.width = W; full.height = H;
  const small = document.createElement('canvas'); small.width = PREVIEW_W; small.height = Math.round((PREVIEW_W * H) / W);
  const urls: string[] = [];
  for (let i = 0; i < w.cards.length; i++) {
    await renderCard(full.getContext('2d')!, w, i);
    small.getContext('2d')!.drawImage(full, 0, 0, small.width, small.height);
    const blob = await new Promise<Blob | null>((res) => small.toBlob(res, 'image/jpeg', 0.86));
    urls.push(blob ? URL.createObjectURL(blob) : small.toDataURL('image/jpeg', 0.86));
    onProgress(i + 1);
  }
  return urls;
}

const ICON = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.3 10.6 19C5.6 14.5 2.5 11.7 2.5 8.2 2.5 5.4 4.7 3.2 7.5 3.2c1.6 0 3.1.7 4.5 2 1.4-1.3 2.9-2 4.5-2 2.8 0 5 2.2 5 5 0 3.5-3.1 6.3-8.1 10.8z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M20.5 11.6a8.4 8.4 0 0 1-12.3 7.4L3.5 20.5l1.6-4.5a8.4 8.4 0 1 1 15.4-4.4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M21 3 3 10.5l7 2.6M21 3l-7.5 18-3.4-7.9M21 3 10.1 13.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M19 21 12 16.5 5 21V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><path d="M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

export async function openInstaPreview(app: App): Promise<void> {
  const w = app.work();
  const handle = (w.handle || '@my.cards').replace(/^@/, '');
  const initial = esc((handle.match(/[a-z0-9가-힣]/i)?.[0] || 'C').toUpperCase());
  const fa = feedAspect(w.ratio);
  let urls: string[] = [];
  let closed = false;

  openModal(`
    <div class="panel-head"><h2>인스타 미리보기</h2>
      <div class="toolbar">
        <div class="seg" id="igTabs" role="tablist"><button type="button" data-tab="post" class="active">게시물</button><button type="button" data-tab="grid">프로필 격자</button></div>
        <button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>
      </div>
    </div>
    <div class="ig-stage">
      <div class="phone">
        <div class="ig-post" id="igPost">
          <div class="ig-head"><span class="ig-avatar">${initial}</span><b>${esc(handle)}</b><span class="ig-icon">${ICON.more}</span></div>
          <div class="ig-media" style="aspect-ratio:${fa.w} / ${fa.h}">
            <div class="ig-track" id="igTrack"><div class="ig-loading" id="igLoading">미리보기를 만드는 중… 0/20</div></div>
            <span class="ig-count" id="igCount">1/20</span>
            <button class="ig-nav prev" type="button" data-nav="-1" aria-label="이전" hidden>‹</button>
            <button class="ig-nav next" type="button" data-nav="1" aria-label="다음">›</button>
          </div>
          <div class="ig-actions"><span class="ig-icon">${ICON.heart}</span><span class="ig-icon">${ICON.comment}</span><span class="ig-icon">${ICON.send}</span><span class="ig-dots" id="igDots">${w.cards.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</span><span class="ig-icon">${ICON.save}</span></div>
          <div class="ig-caption" id="igCaption"><b>${esc(handle)}</b> ${esc(captionText(w)).replace(/\n/g, '<br>')}</div>
          <button class="ig-more" type="button" id="igMore">더 보기</button>
          <div class="ig-time">방금 전</div>
        </div>
        <div class="ig-profile" id="igProfile" hidden>
          <div class="ig-prof-head"><span class="ig-avatar big">${initial}</span><div><b>${esc(handle)}</b><span id="igPostCount"></span></div></div>
          <div class="ig-prof-tabs"><span class="ig-icon on">${ICON.grid}</span></div>
          <div class="ig-grid" id="igGrid"></div>
        </div>
      </div>
      <div class="ig-notes">
        <p class="hint"><b>${esc(workTitle(w))}</b> · 카드 20장</p>
        ${fa.cropped ? '<p class="warn">9:16 카드는 피드 게시물에서 4:5로 위아래가 잘려 보여요. 피드용이면 4:5나 3:4를 권해요.</p>' : ''}
        <p class="hint">넘겨 보면서 글이 잘리거나 그림과 겹치는 카드가 없는지 확인하세요. 프로필 격자는 3:4로 잘려 보여요.</p>
        <p class="hint">캡션은 처음 두 줄만 보이고 「더 보기」로 펼쳐져요. 첫 줄에 제목, 둘째 줄에 훅이 오게 돼 있어요.</p>
      </div>
    </div>`,
  {
    size: 'wide',
    onClose: () => { closed = true; for (const u of urls) if (u.startsWith('blob:')) URL.revokeObjectURL(u); },
    wire: (box, closeIt) => {
      box.querySelector('[data-a="close"]')!.addEventListener('click', closeIt);
      box.querySelectorAll<HTMLButtonElement>('#igTabs button').forEach((b) => b.addEventListener('click', () => {
        box.querySelectorAll('#igTabs button').forEach((x) => x.classList.toggle('active', x === b));
        $('igPost').hidden = b.dataset.tab !== 'post';
        $('igProfile').hidden = b.dataset.tab !== 'grid';
      }));
      const cap = box.querySelector<HTMLElement>('#igCaption')!;
      box.querySelector('#igMore')!.addEventListener('click', (e) => { cap.classList.toggle('open'); (e.target as HTMLElement).textContent = cap.classList.contains('open') ? '접기' : '더 보기'; });
    },
  });

  const track = $('igTrack');
  const at = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const sync = () => {
    const i = at();
    $('igCount').textContent = `${i + 1}/${w.cards.length}`;
    $('igDots').querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === i));
    document.querySelector<HTMLElement>('.ig-nav.prev')!.hidden = i === 0;
    document.querySelector<HTMLElement>('.ig-nav.next')!.hidden = i >= w.cards.length - 1;
  };
  track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
  document.querySelectorAll<HTMLButtonElement>('.ig-nav').forEach((b) => b.addEventListener('click', () => {
    track.scrollTo({ left: (at() + Number(b.dataset.nav)) * track.clientWidth, behavior: 'smooth' });
  }));
  track.tabIndex = 0;
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); track.scrollTo({ left: (at() + (e.key === 'ArrowRight' ? 1 : -1)) * track.clientWidth, behavior: 'smooth' }); }
  });

  urls = await renderPreviews(w, (n) => { const l = document.getElementById('igLoading'); if (l) l.textContent = `미리보기를 만드는 중… ${n}/20`; });
  if (closed) { for (const u of urls) if (u.startsWith('blob:')) URL.revokeObjectURL(u); return; }
  track.innerHTML = urls.map((u, i) => `<img alt="${i + 1}번 카드" src="${u}" draggable="false">`).join('');
  sync();

  // profile grid: this work's cover first, then the other works' covers (newest first)
  const others = (await works.all()).filter((x) => x.id !== w.id && x.thumb).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 11);
  if (closed) return;
  $('igPostCount').textContent = `게시물 ${others.length + 1}`;
  $('igGrid').innerHTML = [`<img alt="이번 표지" class="new" src="${urls[0]}">`, ...others.map((x) => `<img alt="" src="${x.thumb}">`)].join('');
}
