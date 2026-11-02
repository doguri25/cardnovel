// 「표지 후보」: three cover pictures with different compositions, shown as finished covers; the writer picks one.
import type { App } from '../app';
import { COVER_VARIANTS, drawCard, type CardRefs } from '../ai/compose';
import { pictureMessage } from '../canva';
import type { Work } from '../model';
import { cardHeight, ensureFonts, renderCard, srcOf, W } from '../render';
import { confirmBox, esc, openModal, toast } from './dom';

interface Slot { img?: string; svg?: string; error?: string; busy: boolean }

async function coverPreview(w: Work, pic: { img?: string; svg?: string }): Promise<string> {
  const draft: Work = { ...w, cards: w.cards.map((c, i) => (i === 0 ? { ...c, img: pic.img, svg: pic.svg } : c)) };
  if (!pic.img) delete draft.cards[0].img;
  if (!pic.svg) delete draft.cards[0].svg;
  const c = document.createElement('canvas');
  c.width = W; c.height = cardHeight(w);
  await ensureFonts(draft);
  await renderCard(c.getContext('2d')!, draft, 0);
  const s = document.createElement('canvas');
  s.width = 400; s.height = Math.round((400 * c.height) / W);
  s.getContext('2d')!.drawImage(c, 0, 0, s.width, s.height);
  return s.toDataURL('image/jpeg', 0.86);
}

/** `price`: estimated dollars per picture, or null for Canva AI (it uses the writer's Canva AI allowance instead). */
export async function openCoverCandidates(app: App, refs: () => CardRefs | null, label: string, price: number | null, onPicked: () => void): Promise<void> {
  const ai = app.imageAI();
  if (!ai) { toast(`${label} 키를 먼저 넣어 주세요.`); app.openSettings(); return; }
  const w = app.work();
  const n = COVER_VARIANTS.length;
  const cost = price === null ? 'Canva AI 사용량이 차감돼요.' : `예상 비용은 약 $${(price * n).toFixed(2)}예요.`;
  if (!(await confirmBox(`표지 그림 후보 ${n}장을 ${label}(으)로 그립니다. ${cost}`, { ok: '후보 그리기', detail: ['가까이 본 핵심 사물 · 무대 전경 · 인물 뒷모습, 세 가지 구도로 그려요.', '마음에 드는 하나를 고르면 표지에 들어가고, 나머지는 버려요.'] }))) return;

  const slots: Slot[] = COVER_VARIANTS.map(() => ({ busy: true }));
  const previews: (string | null)[] = COVER_VARIANTS.map(() => null);
  const ctl = new AbortController();
  const current = srcOf(w.cards[0]) ? await coverPreview(w, { img: w.cards[0].img, svg: w.cards[0].svg }) : null;
  let box: HTMLElement | null = null;

  const paint = () => {
    if (!box) return;
    box.querySelector('#coverSlots')!.innerHTML = slots.map((s, i) => `
      <figure class="cand ${s.busy ? 'busy' : ''}">
        ${previews[i] ? `<img alt="후보 ${i + 1}" src="${previews[i]}">` : `<div class="ph">${s.error ? esc(s.error) : '그리는 중…'}</div>`}
        <figcaption>${['핵심 사물', '무대 전경', '인물 뒷모습'][i] ?? `후보 ${i + 1}`}</figcaption>
        <button class="btn small ${previews[i] ? 'primary' : ''}" type="button" data-pick="${i}" ${previews[i] ? '' : 'disabled'}>이걸로</button>
      </figure>`).join('') + (current ? `<figure class="cand now"><img alt="지금 표지" src="${current}"><figcaption>지금 표지</figcaption><button class="btn small" type="button" data-a="keep">그대로 두기</button></figure>` : '');
  };

  openModal(`
    <div class="panel-head"><h2>표지 후보</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    <p class="hint" style="margin:0 0 12px">첫 장이 게시물의 얼굴이에요. 제목·훅과 함께 보이는 모습으로 비교해 고르세요.</p>
    <div class="cand-grid" id="coverSlots"></div>`,
  {
    size: 'wide',
    onClose: () => ctl.abort(),
    wire: (b, close) => {
      box = b;
      b.querySelector('[data-a="close"]')!.addEventListener('click', close);
      b.addEventListener('click', (e) => {
        const el = e.target as HTMLElement;
        if (el.closest('[data-a="keep"]')) { close(); return; }
        const pick = el.closest<HTMLElement>('[data-pick]');
        if (!pick) return;
        const s = slots[Number(pick.dataset.pick)];
        if (!s || (!s.img && !s.svg)) return;
        const c = app.work().cards[0];
        delete c.img; delete c.svg;
        if (s.img) c.img = s.img;
        if (s.svg) c.svg = s.svg;
        c.imgSource = ai.provider;
        c.imgPos = 'center';
        app.save(); onPicked(); app.scheduleRender();
        close();
        toast('고른 그림을 표지에 넣었어요.');
      });
      paint();
    },
  });

  // two at a time, like 「모든 그림 그리기」
  let next = 0;
  const worker = async () => {
    while (next < n && !ctl.signal.aborted) {
      const i = next++;
      try {
        const out = await drawCard(w, 0, ai, refs(), ctl.signal, COVER_VARIANTS[i]);
        slots[i] = { ...out, busy: false };
        previews[i] = await coverPreview(w, out);
      } catch (e) {
        slots[i] = { busy: false, error: pictureMessage(e) };
      }
      paint();
    }
  };
  await Promise.all([worker(), worker()]);
}
