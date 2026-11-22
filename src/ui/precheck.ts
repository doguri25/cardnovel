// 「게시 전 점검」 box at the top of 내보내기: a live list of what to fix before posting, each with a way there.
import type { App } from '../app';
import { countLevel, precheck, type CheckItem } from '../precheck';
import { $, confirmBox, esc } from './dom';
import { proofSummary } from './proof';
import { setTab } from './steps';

const ICON: Record<CheckItem['level'], string> = { error: '!', warn: '!', info: 'i' };
const LEVEL_NAME: Record<CheckItem['level'], string> = { error: '꼭 확인', warn: '확인', info: '참고' };

export const checksFor = (app: App): CheckItem[] => precheck(app.work(), { proof: proofSummary(app) });

export function renderPrecheck(app: App): void {
  const box = document.getElementById('precheckBox');
  if (!box) return;
  const items = checksFor(app);
  const errors = countLevel(items, 'error'), warns = countLevel(items, 'warn'), infos = countLevel(items, 'info');
  const badge = $('exportBadge');
  badge.hidden = !(errors + warns) || items[0]?.id === 'nothing'; // nothing written yet: no alarm on the tab
  badge.textContent = String(errors + warns);
  badge.classList.toggle('bad', errors > 0);
  const open = box.querySelector('details')?.open ?? (errors + warns > 0);
  const head = errors + warns
    ? `<b>게시 전 점검</b><span>${errors ? `<em class="e">꼭 확인 ${errors}</em>` : ''}${warns ? `<em class="w">확인 ${warns}</em>` : ''}${infos ? `<em>참고 ${infos}</em>` : ''}</span>`
    : `<b>게시 전 점검</b><span class="ok">올릴 준비가 됐어요${infos ? ` · 참고 ${infos}` : ''}</span>`;
  box.className = 'precheck ' + (errors ? 'has-error' : warns ? 'has-warn' : 'ok');
  box.innerHTML = `<details ${open ? 'open' : ''}><summary>${head}</summary>
    <ul>${items.map((it, k) => `<li class="lv-${it.level}">
      <span class="ico" aria-label="${LEVEL_NAME[it.level]}">${ICON[it.level]}</span>
      <span class="txt">${esc(it.text)}${it.cards && it.cards.length > 1 ? `<span class="chips">${it.cards.slice(0, 12).map((c) => `<button type="button" data-card="${c}">${String(c + 1).padStart(2, '0')}</button>`).join('')}</span>` : ''}</span>
      ${it.go ? `<button class="btn tiny" type="button" data-go="${k}">${it.go === 'caption' ? '캡션 열기' : '보기'}</button>` : ''}
    </li>`).join('')}</ul></details>`;
  box.querySelectorAll<HTMLButtonElement>('[data-card]').forEach((b) => b.addEventListener('click', () => app.goCard(Number(b.dataset.card), true)));
  box.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => b.addEventListener('click', () => goTo(app, items[Number(b.dataset.go)])));
}

export function goTo(app: App, it: CheckItem): void {
  if (it.go === 'card') { app.goCard(it.cards?.[0] ?? 0, true); return; }
  if (it.go === 'caption') { app.openCaption(); return; }
  if (it.go === 'proof' || it.go === 'review') {
    setTab('review');
    document.getElementById(it.go === 'proof' ? 'proofPanel' : 'reviewPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  setTab(it.go === 'look' ? 'look' : 'story');
}

/** Before saving or sharing all 20: stop for the problems that would show on Instagram. */
export async function okToPost(app: App, what: string): Promise<boolean> {
  const errors = checksFor(app).filter((i) => i.level === 'error');
  if (!errors.length) return true;
  const go = !(await confirmBox(`올리기 전에 꼭 확인할 것이 ${errors.length}가지 있어요. 그래도 ${what}할까요?`, { ok: `그래도 ${what}`, cancel: '고치러 가기', detail: errors.map((e) => e.text) }));
  if (go) { setTab('export'); renderPrecheck(app); }
  return !go;
}
