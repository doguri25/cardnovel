// 「버전 기록」: list, save, restore, open as a copy, rename and delete versions of the open work.
import type { App } from '../app';
import { workTitle, type Work } from '../model';
import { changedCards, deleteVersion, listVersions, loadVersion, REASON_NAME, renameVersion, saveVersion, type VersionMeta } from '../versions';
import { confirmBox, esc, fmtDate, openModal, promptBox, toast } from './dom';

export interface VersionDeps {
  /** puts a version's content into the open work (same id) */
  restore(w: Work): Promise<void>;
  /** opens a version as a new work */
  openCopy(w: Work): Promise<void>;
}

export async function openVersions(app: App, deps: VersionDeps): Promise<void> {
  await app.flush();
  const cur = app.work();
  const list = await listVersions(cur.id);
  const diffs = new Map<string, number>();
  const row = (v: VersionMeta) => `
    <div class="work version" data-id="${esc(v.id)}">
      ${v.thumb ? `<img alt="" src="${v.thumb}">` : '<div class="noimg">버전</div>'}
      <div><b>${esc(v.label || REASON_NAME[v.reason])}${v.label ? ` <span class="ep">이름</span>` : ''}</b>
        <span>${fmtDate(v.at)} · ${esc(v.title)} · 글 ${v.texts}장 · 그림 ${v.pics}장<em class="diff" data-diff="${esc(v.id)}"></em></span></div>
      <div class="acts">
        <button class="btn small tonal" type="button" data-a="restore">이 버전으로</button>
        <button class="btn small" type="button" data-a="copy">사본으로 열기</button>
        <button class="btn small" type="button" data-a="name">이름</button>
        <button class="btn small" type="button" data-a="del">지우기</button>
      </div>
    </div>`;
  openModal(`
    <div class="panel-head"><h2>버전 기록 · ${esc(workTitle(cur))}</h2>
      <div class="toolbar"><button class="btn small primary" type="button" data-a="save">지금 버전 저장</button>
      <button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    </div>
    <p class="hint" style="margin:0 0 12px">카드를 새로 구성하거나 그림을 다시 그리기 전, 드라이브·Canva에서 받아오기 전, 그리고 고치는 동안 10분마다 저절로 남겨요. 자동 버전은 최근 30개, 이름 붙인 버전은 지우기 전까지 남아요. 같은 그림은 한 번만 저장돼 용량을 적게 써요.</p>
    <div class="lib">${list.length ? list.map(row).join('') : '<div class="empty-note">아직 버전이 없어요. 「지금 버전 저장」으로 남겨 보세요.</div>'}</div>`,
  {
    size: 'wide',
    wire: (box, close) => {
      box.querySelector('[data-a="close"]')!.addEventListener('click', close);
      box.querySelector('[data-a="save"]')!.addEventListener('click', async () => {
        close();
        const name = await promptBox('이 버전의 이름 (비워도 돼요)', { placeholder: '예: 첫 완성본, 인스타에 올린 판' , ok: '저장' });
        if (name === null) { void openVersions(app, deps); return; }
        await saveVersion(app.work(), 'manual', name);
        toast('지금 상태를 버전으로 저장했어요.');
        void openVersions(app, deps);
      });
      // how many cards differ from now, filled in after the list shows
      void (async () => {
        for (const v of list.slice(0, 12)) {
          const w = await loadVersion(v.id).catch(() => null);
          if (!w) continue;
          const n = changedCards(w, app.work());
          diffs.set(v.id, n);
          const el = box.querySelector<HTMLElement>(`[data-diff="${CSS.escape(v.id)}"]`);
          if (el) el.textContent = n ? ` · 지금과 다른 카드 ${n}장` : ' · 지금과 같음';
        }
      })();
      box.querySelectorAll<HTMLElement>('.version').forEach((el) => {
        const v = list.find((x) => x.id === el.dataset.id)!;
        el.querySelector('[data-a="restore"]')!.addEventListener('click', async () => {
          close();
          const n = diffs.get(v.id);
          if (!(await confirmBox(`${fmtDate(v.at)} 버전으로 되돌릴까요?${n ? ` 카드 ${n}장이 바뀌어요.` : ''}`, { ok: '되돌리기', detail: ['지금 상태는 「되돌리기 전」 버전으로 먼저 남겨요.'] }))) { void openVersions(app, deps); return; }
          const w = await loadVersion(v.id);
          if (!w) { toast('이 버전을 읽지 못했어요.'); return; }
          await saveVersion(app.work(), 'restore');
          await deps.restore(w);
          toast(`${fmtDate(v.at)} 버전으로 되돌렸어요.`);
        });
        el.querySelector('[data-a="copy"]')!.addEventListener('click', async () => {
          const w = await loadVersion(v.id);
          if (!w) { toast('이 버전을 읽지 못했어요.'); return; }
          close();
          await deps.openCopy(w);
          toast('이 버전을 새 작품으로 열었어요.');
        });
        el.querySelector('[data-a="name"]')!.addEventListener('click', async () => {
          close();
          const name = await promptBox('버전 이름', { value: v.label ?? '', ok: '저장' });
          if (name !== null) await renameVersion(v.id, name);
          void openVersions(app, deps);
        });
        el.querySelector('[data-a="del"]')!.addEventListener('click', async () => {
          close();
          if (await confirmBox('이 버전을 지울까요?', { ok: '지우기' })) await deleteVersion(v.id);
          void openVersions(app, deps);
        });
      });
    },
  });
}
