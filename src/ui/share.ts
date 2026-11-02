// 「공유 링크」: make a public link to a swipe viewer of the 20 cards, list and delete earlier links.
import type { App } from '../app';
import { createShare, deleteShare, forgetShare, listShares, shareMessage, ShareError, type ShareRecord } from '../share';
import { confirmBox, esc, fmtDate, openModal, toast } from './dom';

export interface ShareDeps { key(): string }

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export async function makeShareLink(app: App, deps: ShareDeps, btn: HTMLButtonElement): Promise<void> {
  const key = deps.key();
  if (!key) { toast('설정 → 공유 링크에서 공유 열쇠를 먼저 넣어 주세요.', 4500); app.openSettings(); return; }
  if (!app.online()) { toast('인터넷 연결이 필요해요.'); return; }
  const ok = await confirmBox('카드 20장을 인터넷에 올려 링크가 있는 사람은 누구나 볼 수 있게 할까요?', {
    ok: '링크 만들기', detail: ['검색에는 나오지 않아요. 링크를 아는 사람만 볼 수 있어요.', '언제든 「공유 링크 목록」에서 지울 수 있어요.', '카드를 고친 뒤에는 링크를 새로 만들어야 바뀐 내용이 보여요.'],
  });
  if (!ok) return;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const rec = await createShare(app.work(), key, (n) => { btn.textContent = `올리는 중 ${n}/20`; });
    const copied = await copy(rec.url);
    openShareList(app, deps, rec, copied);
  } catch (e) {
    toast(shareMessage(e), 5000);
    if (e instanceof ShareError && e.code === 'bad_share_key') app.openSettings();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export async function openShareList(app: App, deps: ShareDeps, fresh?: ShareRecord, copied = false): Promise<void> {
  const all = await listShares();
  const row = (s: ShareRecord) => `
    <div class="work share-item" data-id="${esc(s.id)}">
      ${s.cover ? `<img alt="" src="${s.cover}">` : '<div class="noimg">링크</div>'}
      <div><b>${esc(s.title)}</b><span>${fmtDate(s.createdAt)} · <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace(/^https?:\/\//, ''))}</a></span></div>
      <div class="acts">
        <button class="btn small" type="button" data-a="copy">복사</button>
        <button class="btn small" type="button" data-a="del">지우기</button>
      </div>
    </div>`;
  openModal(`
    <div class="panel-head"><h2>공유 링크</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    ${fresh ? `<div class="share-new">
      <p>링크를 만들었어요.${copied ? ' 클립보드에 복사해 두었어요.' : ''}</p>
      <div class="share-link"><input class="input" readonly value="${esc(fresh.url)}" id="shareUrl"><button class="btn primary" type="button" data-a="copyNew">복사</button><a class="btn" href="${esc(fresh.url)}" target="_blank" rel="noopener">열기</a></div>
    </div>` : ''}
    <div class="section-title">만든 링크</div>
    <div class="lib">${all.length ? all.map(row).join('') : '<div class="empty-note">아직 만든 링크가 없어요. 「공유 링크 만들기」로 시작하세요.</div>'}</div>`,
  {
    size: 'mid',
    wire: (box, close) => {
      box.querySelector('[data-a="close"]')!.addEventListener('click', close);
      box.querySelector('[data-a="copyNew"]')?.addEventListener('click', async () => { toast((await copy(fresh!.url)) ? '링크를 복사했어요.' : '복사가 막혔어요. 링크를 길게 눌러 복사하세요.'); });
      box.querySelector<HTMLInputElement>('#shareUrl')?.addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
      box.querySelectorAll<HTMLElement>('.share-item').forEach((el) => {
        const rec = all.find((s) => s.id === el.dataset.id)!;
        el.querySelector('[data-a="copy"]')!.addEventListener('click', async () => { toast((await copy(rec.url)) ? '링크를 복사했어요.' : '복사가 막혔어요.'); });
        el.querySelector('[data-a="del"]')!.addEventListener('click', async () => {
          close();
          if (!(await confirmBox(`「${rec.title}」 링크를 지울까요? 이 링크로는 더 볼 수 없게 돼요.`, { ok: '지우기' }))) { void openShareList(app, deps); return; }
          try {
            await deleteShare(rec.id, deps.key());
            toast('링크를 지웠어요.');
          } catch (e) {
            if (e instanceof ShareError && e.status === 404) await forgetShare(rec.id);
            else toast(shareMessage(e), 5000);
          }
          void openShareList(app, deps);
        });
      });
    },
  });
}
