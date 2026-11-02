// Phone layout: five tabs at the bottom (story, cards, look, review, export), one card at a time with a small
// preview you can swipe, and the app-bar buttons in a menu.
import type { App } from '../app';
import { $, openModal } from './dom';

export type Tab = 'story' | 'cards' | 'look' | 'review' | 'export';
const TABS: Tab[] = ['story', 'cards', 'look', 'review', 'export'];
const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;
export const isPhone = (): boolean => !!mq?.matches;

export function setTab(t: Tab): void {
  document.body.dataset.tab = t;
  document.querySelectorAll<HTMLButtonElement>('#mTabs button').forEach((b) => {
    const on = b.dataset.tab === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  try { sessionStorage.setItem('cardnovel.tab', t); } catch { /* fine */ }
  if (isPhone()) window.scrollTo({ top: 0 });
}

/** Copies the big preview into the small one above the card being edited (phone, cards tab). */
export function paintMini(): void {
  if (!isPhone()) return;
  const src = $<HTMLCanvasElement>('stage'), dst = $<HTMLCanvasElement>('mStage');
  const h = Math.round((dst.width * src.height) / src.width);
  if (dst.height !== h) dst.height = h;
  dst.getContext('2d')!.drawImage(src, 0, 0, dst.width, dst.height);
}

export function wireMobile(app: App, hasStory: () => boolean): void {
  let saved: string | null = null;
  try { saved = sessionStorage.getItem('cardnovel.tab'); } catch { /* fine */ }
  setTab(TABS.includes(saved as Tab) ? (saved as Tab) : hasStory() ? 'cards' : 'story');
  $('mTabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
    if (b) setTab(b.dataset.tab as Tab);
  });
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
    const items: [string, string][] = [['btnLibrary', '보관함'], ['btnVersions', '버전 기록'], ['btnSettings', '설정'], ['btnUsage', '사용량 · 비용'], ['btnCaption', '캡션 복사'], ['btnSaveAll', '전체 ZIP 저장']];
    openModal(`<div class="panel-head"><h2>메뉴</h2></div><div class="m-menu">${items.map(([id, label]) => `<button class="btn" type="button" data-id="${id}">${label}</button>`).join('')}</div>`, {
      wire: (box, close) => box.querySelectorAll<HTMLButtonElement>('[data-id]').forEach((b) => b.addEventListener('click', () => { close(); $(b.dataset.id!).click(); })),
    });
  });
}
