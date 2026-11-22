// Phone layout: five tabs at the bottom (story, cards, look, review, export), one card at a time with a small
// preview you can swipe, and the app-bar buttons in a menu. The tabs themselves live in steps.ts.
import type { App } from '../app';
import { $, openModal } from './dom';
import { isPhone } from './steps';

export { isPhone, setTab } from './steps';

/** Copies the big preview into the small one above the card being edited (phone, cards tab). */
export function paintMini(): void {
  if (!isPhone()) return;
  const src = $<HTMLCanvasElement>('stage'), dst = $<HTMLCanvasElement>('mStage');
  const h = Math.round((dst.width * src.height) / src.width);
  if (dst.height !== h) dst.height = h;
  dst.getContext('2d')!.drawImage(src, 0, 0, dst.width, dst.height);
}

export function wireMobile(app: App): void {
  const go = (d: number) => app.select((app.current() + d + 20) % 20);
  $('mPrev').addEventListener('click', () => go(-1));
  $('mNext').addEventListener('click', () => go(1));

  // swipe the small preview to move between cards
  const mini = $('mStage');
  let x0 = 0, y0 = 0, down = false;
  mini.addEventListener('pointerdown', (e) => { down = true; x0 = e.clientX; y0 = e.clientY; });
  mini.addEventListener('pointerup', (e) => {
    if (!down) return;
    down = false;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  });
  mini.addEventListener('pointercancel', () => { down = false; });

  // the keyboard covers the bottom of the screen: hide the tab bar while typing
  document.addEventListener('focusin', (e) => { if ((e.target as HTMLElement).matches?.('input, textarea, select')) document.body.classList.add('m-typing'); });
  document.addEventListener('focusout', () => { setTimeout(() => { if (!document.activeElement?.matches('input, textarea, select')) document.body.classList.remove('m-typing'); }, 60); });

  $('btnSaveAllM').addEventListener('click', () => $('btnSaveAll').click());
  $('btnMenu').addEventListener('click', () => {
    const items: [string, string][] = [['btnNewWork', '새 작품 시작'], ['btnPalette', '빠른 실행 (찾아서 하기)'], ['btnLibrary', '보관함'], ['btnVersions', '버전 기록'], ['btnSettings', '설정'], ['btnUsage', '사용량 · 비용'], ['btnCaption', '캡션 복사'], ['btnSaveAll', '전체 ZIP 저장']];
    openModal(`<div class="panel-head"><h2>메뉴</h2></div><div class="m-menu">${items.map(([id, label]) => `<button class="btn" type="button" data-id="${id}">${label}</button>`).join('')}</div>`, {
      wire: (box, close) => box.querySelectorAll<HTMLButtonElement>('[data-id]').forEach((b) => b.addEventListener('click', () => { close(); $(b.dataset.id!).click(); })),
    });
  });
}
