// Web app updates: every deploy ships a new service worker. When it takes over, the open page still runs the
// old code, so: show a bar to switch now, and switch by itself when the tab is in the background and idle.
import type { App } from '../app';
import { esc } from './dom';

const CHECK_EVERY = 30 * 60_000;
let ready = false;

function bar(msg: string, label: string, run: () => void) {
  const el = document.getElementById('updateBar');
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<span>${esc(msg)}</span><button class="btn small primary" type="button">${esc(label)}</button>`;
  el.querySelector('button')!.addEventListener('click', run, { once: true });
}

async function apply(app: App) {
  try { await app.flush(); } catch { /* the work was saved a moment ago anyway */ }
  location.reload();
}

/** A new version took over (or a part of the old one is gone from the server): offer to switch. */
export function newVersionReady(app: App, reason: 'deploy' | 'missing' = 'deploy'): void {
  ready = true;
  bar(reason === 'missing' ? '앱이 새 버전으로 바뀌어 이 기능을 열려면 새로고침이 필요해요. 작업은 저장돼 있어요.' : '카드소설 제작소 새 버전이 나왔어요. 작업은 저장돼 있어요.', '지금 적용', () => void apply(app));
}

export function watchForUpdates(app: App, reg: ServiceWorkerRegistration, idle: () => boolean): void {
  // a page opened for the first time has no controller yet: its first service worker is not an update
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) newVersionReady(app); });
  let last = Date.now();
  const check = () => { last = Date.now(); void reg.update().catch(() => undefined); };
  setInterval(check, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - last > 5 * 60_000) check();
    // switch quietly while the writer is elsewhere and nothing is running
    if (document.hidden && ready && idle()) void apply(app);
  });
}

/** A chunk loaded on demand (video, Canva deck) failed: usually the server has a newer version. */
export const isStaleChunkError = (e: unknown): boolean => /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch/i.test(String((e as Error)?.message || e));
