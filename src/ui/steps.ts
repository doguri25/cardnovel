// The five steps of making a card novel. On a computer the writing side shows one of 이야기 · 카드 · 다듬기 and the
// preview side one of 꾸미기 · 내보내기; on a phone the bottom tabs show one of all five.
export type Tab = 'story' | 'cards' | 'review' | 'look' | 'export';
export const TABS: Tab[] = ['story', 'cards', 'review', 'look', 'export'];
export const TAB_NAME: Record<Tab, string> = { story: '이야기', cards: '카드', review: '다듬기', look: '꾸미기', export: '내보내기' };
const LEFT: Tab[] = ['story', 'cards', 'review'];
const isLeft = (t: Tab) => LEFT.includes(t);

const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;
export const isPhone = (): boolean => !!mq?.matches;

const listeners: ((t: Tab) => void)[] = [];
export const onTabChange = (fn: (t: Tab) => void): void => { listeners.push(fn); };

function mark() {
  const b = document.body.dataset;
  const set = (sel: string, active: (t: string) => boolean) => document.querySelectorAll<HTMLButtonElement>(`${sel} button[data-tab]`).forEach((btn) => {
    const on = active(btn.dataset.tab!);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-current', on ? 'page' : 'false');
  });
  set('#mTabs', (t) => t === b.tab);
  set('#stepNav', (t) => t === b.left);
  set('#sideNav', (t) => t === b.right);
}

/** Shows a step. `scroll`: bring the writing side (or the phone page) back to its top. */
export function setTab(t: Tab, scroll = true): void {
  const b = document.body.dataset;
  const leftChanged = isLeft(t) && b.left !== t;
  b.tab = t;
  if (isLeft(t)) b.left = t; else b.right = t;
  mark();
  try {
    sessionStorage.setItem('cardnovel.tab', t);
    localStorage.setItem('cardnovel.steps', JSON.stringify({ left: b.left, right: b.right }));
  } catch { /* fine */ }
  if (scroll) {
    if (isPhone()) window.scrollTo({ top: 0 });
    else if (leftChanged) document.querySelector('.work-col')?.scrollTo({ top: 0 });
  }
  for (const fn of listeners) { try { fn(t); } catch { /* a listener must not break switching */ } }
}

export const currentTab = (): Tab => (document.body.dataset.tab as Tab) || 'story';

/** The steps as they were last time (this tab on a phone, the two sides on a computer). */
export function restoreTabs(hasStory: boolean): void {
  let saved: string | null = null, sides: { left?: Tab; right?: Tab } = {};
  try { saved = sessionStorage.getItem('cardnovel.tab'); sides = JSON.parse(localStorage.getItem('cardnovel.steps') || '{}'); } catch { /* fine */ }
  const first: Tab = hasStory ? 'cards' : 'story';
  const b = document.body.dataset;
  b.left = sides.left && isLeft(sides.left) ? sides.left : first;
  b.right = sides.right && !isLeft(sides.right) ? sides.right : 'look';
  setTab(TABS.includes(saved as Tab) ? (saved as Tab) : (b.left as Tab), false);
}

export function wireSteps(): void {
  for (const id of ['mTabs', 'stepNav', 'sideNav']) {
    document.getElementById(id)?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
      if (btn) setTab(btn.dataset.tab as Tab);
    });
  }
}
