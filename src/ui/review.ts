// Ⅲ AI 평가: scores, cards to fix with a one-click rewrite, and title/hook ideas for the cover.
import type { App } from '../app';
import { aiMessage, AiError } from '../ai/providers';
import { reviewWork, totalScore } from '../ai/review';
import { startBusy } from '../busy';
import { REVIEW_AXES, textSig, type Review, type ReviewAxis, type ReviewNote, type Work } from '../model';
import { reviewHistory } from '../posts';
import { works } from '../store';
import { $, esc, fmtDate, setStatus } from './dom';

let ctl: AbortController | null = null;
const num = (i: number) => String(i + 1).padStart(2, '0');

/** Where the card a note is about sits now (cards can be moved after the review), or -1 when that is not known:
 *  a review saved before notes kept their card is read by position only while the cards are as reviewed. */
function noteAt(w: Work, r: Review, n: ReviewNote): number {
  if (n.cardId) return w.cards.findIndex((c) => c.id === n.cardId);
  return r.sig === textSig(w) && w.cards[n.index] ? n.index : -1;
}

export function renderReview(app: App): void {
  const w = app.work();
  const r = w.review;
  const body = $('reviewBody');
  $<HTMLButtonElement>('btnReview').textContent = r ? '다시 평가' : '평가 받기';
  $<HTMLButtonElement>('btnReview').disabled = !!ctl || !app.online();
  if (!r) {
    body.innerHTML = '<div class="empty-note">카드를 다 채운 뒤 「평가 받기」를 누르면 다섯 가지 기준으로 읽고, 고칠 카드와 제목 후보를 알려 줘요.</div>';
    return;
  }
  const stale = r.sig !== textSig(w);
  const total = totalScore(r);
  const axes = Object.keys(REVIEW_AXES) as ReviewAxis[];
  body.innerHTML = `
    <div class="eval">
      ${stale ? '<p class="warn">평가한 뒤 카드 글이 바뀌었어요. 「다시 평가」를 누르면 지금 글로 다시 읽어요.</p>' : ''}
      <div class="scorebar">
        <div class="total">${total}<small>/100</small></div>
        <div class="subs">${axes.map((a) => { const v = Number(r.scores[a]) || 0; return `<div class="sub">${REVIEW_AXES[a]}<b>${v}</b><div class="track"><i style="width:${(v / 20) * 100}%"></i></div></div>`; }).join('')}</div>
      </div>
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
      ${r.strengths.length ? `<div><h3>잘된 점</h3><ul>${r.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${r.notes.length ? `<div><h3>고칠 카드</h3><div class="stack">${r.notes.map((n, k) => {
        const at = noteAt(w, r, n);
        const i = at >= 0 ? at : Math.max(0, Math.round(Number(n.index)) || 0); // not known: where it was when reviewed
        const card = w.cards[at];
        const applied = !!card && card.text === n.suggestion;
        const cut = n.verdict === 'cut';
        return `
        <div class="issue ${i === app.current() ? 'on' : ''}" data-card="${i}" title="누르면 옆 미리보기가 이 카드로 바뀌어요">
          <div class="head"><button class="badge" type="button" data-show="${i}" title="옆 미리보기에서 이 카드 보기">${num(i)}${i === 0 ? ' 표지' : ''}</button><span class="verdict ${cut ? 'cut' : 'fix'}">${cut ? '바꾸기 권장' : '다듬기'}</span><span>${esc(n.issue)}</span></div>
          ${n.suggestion ? `<div class="fix">${esc(n.suggestion)}</div>` : ''}
          <div class="toolbar"><button class="btn small" type="button" data-go="${i}">카드에서 고치기</button>${n.suggestion ? `<button class="btn small ${applied ? '' : 'tonal'}" type="button" data-apply="${k}" ${applied || !card ? 'disabled' : ''}${card ? '' : ' title="평가한 뒤 카드 순서가 바뀌었을 수 있어요. 「다시 평가」를 눌러 주세요."'}>${applied ? '바꿨어요' : i === 0 ? '이 훅으로 바꾸기' : '이 문장으로 바꾸기'}</button>` : ''}</div>
        </div>`;
      }).join('')}</div></div>` : ''}
      ${r.titles.length ? `<div><h3>제목·훅 후보</h3><div class="stack">${r.titles.map((x, k) => {
        const on = w.cards[0].title === x.title && (!x.hook || w.cards[0].text === x.hook);
        return `
        <div class="title-row"><div><b>${esc(x.title)}</b>${x.hook ? `<span class="hook">${esc(x.hook)}</span>` : ''}${x.why ? `<span class="why">${esc(x.why)}</span>` : ''}</div>
          <button class="btn small" type="button" data-title="${k}" ${on ? 'disabled' : ''}>${on ? '표지에 있음' : '표지에 넣기'}</button></div>`;
      }).join('')}</div></div>` : ''}
      <p class="hint">${fmtDate(r.at)}에 평가했어요.${Number(r.history) > 0 ? ` 지난 ${Number(r.history)}편의 게시 반응을 참고했어요.` : ''} 점수는 참고용이에요.</p>
    </div>`;
}

/** After a suggestion is applied the review still describes this text, so it keeps matching. */
function keepFresh(app: App, wasFresh: boolean) {
  const w = app.work();
  if (wasFresh && w.review) w.review.sig = textSig(w);
}

export function wireReview(app: App): void {
  $('btnReview').addEventListener('click', () => void run(app));
  $('reviewBody').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const w = app.work();
    const r = w.review;
    if (!r) return;
    const go = el.closest<HTMLElement>('[data-go]');
    if (go) { app.goCard(Number(go.dataset.go), true); return; }
    const apply = el.closest<HTMLElement>('[data-apply]');
    if (apply) {
      const n = r.notes[Number(apply.dataset.apply)];
      const at = n ? noteAt(w, r, n) : -1;
      const card = w.cards[at];
      if (!card || !n.suggestion) return;
      const fresh = r.sig === textSig(w);
      app.pushUndo();
      card.text = n.suggestion;
      keepFresh(app, fresh);
      app.save(); app.refreshRow(at); app.showCard(at); app.scheduleRender(); renderReview(app);
      app.undoToast(`${num(at)}번 카드를 바꿨어요.`);
      return;
    }
    const title = el.closest<HTMLElement>('[data-title]');
    if (title) {
      const x = r.titles[Number(title.dataset.title)];
      if (!x) return;
      const fresh = r.sig === textSig(w);
      app.pushUndo();
      w.cards[0].title = x.title;
      if (x.hook) w.cards[0].text = x.hook;
      keepFresh(app, fresh);
      app.save(); app.refreshRow(0); app.showCard(0); app.scheduleRender(); renderReview(app);
      app.undoToast('표지 제목과 훅을 바꿨어요.');
      return;
    }
    // anywhere else on a note: the preview beside turns to that card
    const note = el.closest<HTMLElement>('[data-card]');
    if (note && !el.closest('a, textarea, input')) app.showCard(Number(note.dataset.card));
  });
}

async function run(app: App) {
  const ai = app.textAI();
  const st = $('reviewStatus');
  if (!ai) { setStatus(st, '글 AI 키가 필요해요. 설정에서 넣어 주세요.', 'error'); app.openSettings(); return; }
  const w = app.work();
  if (w.cards.filter((c) => c.kind === 'body' && c.text.trim()).length < 6) { setStatus(st, '본문을 6장 이상 채운 뒤 평가해 주세요.', 'error'); return; }
  ctl = new AbortController();
  renderReview(app);
  setStatus(st, '이야기를 읽고 평가하는 중… (보통 20초 안팎)', 'busy');
  const done = startBusy(); // a background update waits for this
  try {
    let history = '';
    try { history = reviewHistory(await works.all(), w.id); } catch { /* the review works without it */ }
    const r = await reviewWork(w, ai, ctl.signal, history);
    if (app.work().id !== w.id) return; // another work was opened meanwhile
    w.review = r;
    app.save();
    setStatus(st, r.notes.length ? `고칠 카드 ${r.notes.length}장을 찾았어요.` : '평가를 마쳤어요.');
  } catch (e) {
    setStatus(st, aiMessage(e), (e as AiError)?.code === 'cancelled' ? '' : 'error');
  } finally {
    ctl = null;
    done();
    renderReview(app);
  }
}
