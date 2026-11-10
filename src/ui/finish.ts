// 「Canva에서 마감」: send the 20 cards to Canva as one editable design, then bring the finished pages back.
import type { App } from '../app';
import { canvaMessage, canvaStatus, CanvaError } from '../canva';
import { saveVersion } from '../versions';
import { isStaleChunkError, newVersionReady } from './update';
import { $, confirmBox, fmtDate, setStatus, toast } from './dom';

export interface FinishDeps { login(): Promise<void>; refreshAll(): void }

/** The design's edit address when it is a Canva page (https on canva.com); anything else from a work file is not linked. */
function canvaEditLink(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'https:' && (u.hostname === 'canva.com' || u.hostname.endsWith('.canva.com')) ? u.href : null;
  } catch {
    return null;
  }
}

export function renderFinishBox(app: App): void {
  const w = app.work();
  const f = w.finished;
  const box = $('finishBox');
  if (!f) {
    box.innerHTML = `<button class="btn" type="button" data-fa="send">Canva에서 마감하기</button>
      <p class="note">글자가 살아 있는 20쪽을 Canva로 보내 글꼴·위치·스티커를 손본 뒤, 돌아가기(Return)를 누르면 마감본이 그대로 들어와요.</p>
      <span class="status" id="finishStatus"></span>`;
    return;
  }
  const has = f.images.length > 0;
  const editUrl = canvaEditLink(f.editUrl);
  box.innerHTML = `
    <div class="finish-line"><b>Canva 마감본</b><span class="hint">${has ? `${f.images.length}장 · ${fmtDate(f.at)}` : 'Canva에서 편집 중 · 다 고치면 돌아가기(Return)를 누르세요'}</span></div>
    ${has ? `<label class="chk"><input type="checkbox" data-fa="toggle" ${f.on ? 'checked' : ''}> 저장·공유·영상에 마감본 쓰기</label>` : ''}
    <div class="toolbar">
      ${editUrl ? '<a class="btn small" data-fa="open" target="_blank" rel="noopener" href="' + editUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">Canva에서 열기</a>' : ''}
      <button class="btn small ${has ? '' : 'tonal'}" type="button" data-fa="pull">${has ? '다시 가져오기' : '마감본 가져오기'}</button>
      <button class="btn small" type="button" data-fa="send">새로 보내기</button>
      <button class="btn small" type="button" data-fa="drop">지우기</button>
    </div>
    ${has && f.on ? '<p class="note">마감본을 쓰는 동안 카드 글을 고쳐도 미리보기와 파일은 마감본 그대로예요. 고친 내용을 반영하려면 「새로 보내기」로 다시 마감하세요.</p>' : ''}
    <span class="status" id="finishStatus"></span>`;
}

export function wireFinishBox(app: App, deps: FinishDeps): void {
  $('finishBox').addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-fa]');
    if (!el || el.dataset.fa === 'open' || el.dataset.fa === 'toggle') return;
    const st = () => $('finishStatus');
    const w = app.work();
    const act = el.dataset.fa;
    if (act === 'drop') {
      if (!(await confirmBox('Canva 마감본을 이 작품에서 지울까요? Canva에 있는 디자인은 그대로 남아요.', { ok: '지우기' }))) return;
      delete w.finished;
      app.save(); renderFinishBox(app); deps.refreshAll();
      return;
    }
    if (!app.online()) { toast('인터넷 연결이 필요해요.'); return; }
    if (act === 'send') {
      if (w.finished?.images.length && !(await confirmBox('지금 카드로 Canva 디자인을 새로 만들까요? 가져온 마감본은 새 마감본을 가져올 때 바뀌어요.', { ok: '새로 보내기' }))) return;
      // open the tab now, while the click still counts, so it is not blocked as a pop-up
      const tab = window.open('', '_blank');
      try { tab?.document.write('<p style="font:16px sans-serif;padding:24px">Canva로 20장을 보내는 중… (1분 안팎)</p>'); } catch { /* cosmetic */ }
      const connected = await canvaStatus();
      if (connected === null) { tab?.close(); toast('Canva 연결은 배포된 앱(cardnovel.vercel.app)에서만 돼요.'); return; }
      if (!connected) { tab?.close(); toast('Canva 연결 화면으로 이동해요…'); await deps.login(); return; }
      try {
        const { sendToCanva } = await import('../canva-finish').catch((e) => { if (isStaleChunkError(e)) newVersionReady(app, 'missing'); throw e; });
        const designs = await sendToCanva(w, (step, n) => setStatus(st(), step === 'deck' ? `카드 파일 만드는 중 ${n}/20` : step === 'upload' ? '카드 파일 올리는 중…' : 'Canva가 디자인으로 바꾸는 중…', 'busy'));
        const d = designs[0];
        w.finished = { designId: d.id, editUrl: d.editUrl, images: w.finished?.images ?? [], at: w.finished?.at ?? Date.now(), on: w.finished?.on ?? false };
        app.save(); renderFinishBox(app);
        if (tab && !tab.closed) tab.location.href = d.editUrl; else window.open(d.editUrl, '_blank');
        setStatus(st(), designs.length > 1 ? `Canva가 디자인 ${designs.length}개로 나눴어요. 첫 디자인이 열렸어요.` : 'Canva 새 탭에서 열렸어요. 다 고치면 왼쪽 위 돌아가기(Return)를 누르세요.');
      } catch (err) {
        tab?.close();
        if (err instanceof CanvaError && err.code === 'not_connected') { toast('Canva 연결 화면으로 이동해요…'); await deps.login(); return; }
        setStatus(st(), canvaMessage(err), 'error');
      }
      return;
    }
    if (act === 'pull' && w.finished) await pullFinished(app, deps, w.finished.designId);
  });
  $('finishBox').addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    const f = app.work().finished;
    if (el.dataset.fa !== 'toggle' || !f) return;
    f.on = el.checked;
    app.save(); renderFinishBox(app); deps.refreshAll();
  });
}

/** Exports the finished design and keeps its pages as the card images (also called after Canva's Return). */
export async function pullFinished(app: App, deps: FinishDeps, designId: string): Promise<void> {
  const w = app.work();
  const st = () => document.getElementById('finishStatus') ?? $('artStatus');
  setStatus(st(), 'Canva에서 마감본을 내보내는 중…', 'busy');
  try {
    const { fetchFinished } = await import('../canva-finish').catch((e) => { if (isStaleChunkError(e)) newVersionReady(app, 'missing'); throw e; });
    const images = await fetchFinished(w, designId, (n, all) => setStatus(st(), `마감본 받는 중 ${n}/${all}`, 'busy'));
    if (!images.length) throw new CanvaError('export_failed');
    await saveVersion(w, 'canva').catch(() => undefined);
    w.finished = { designId, editUrl: w.finished?.editUrl, images: images.slice(0, w.cards.length), at: Date.now(), on: true };
    app.save(); renderFinishBox(app); deps.refreshAll();
    setStatus(st(), images.length === w.cards.length ? `마감본 ${images.length}장을 넣었어요.` : `마감본 ${images.length}장을 넣었어요. 카드는 ${w.cards.length}장이라 ${images.length < w.cards.length ? '모자란 카드는 원래 카드로' : '남는 쪽은 빼고'} 써요.`);
    toast('Canva 마감본을 넣었어요. 저장·공유·영상에 마감본이 쓰여요.');
  } catch (err) {
    if (err instanceof CanvaError && err.code === 'not_connected') { toast('Canva 연결 화면으로 이동해요…'); await deps.login(); return; }
    setStatus(st(), canvaMessage(err), 'error');
  }
}
