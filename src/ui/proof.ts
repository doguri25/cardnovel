// 일괄 교정 panel: one AI pass over every card's words, shown as before/after differences per card,
// applied one by one or all at once (one undo step, and a version kept before).
import type { App } from '../app';
import { aiMessage, type AiError } from '../ai/providers';
import { applyProof, PROOF_KIND_NAME, proofWork, spotValue, type ProofItem, type ProofResult, type ProofTone } from '../ai/proof';
import { diffWords, changeCount } from '../diff';
import { textSig } from '../model';
import { $, esc, fmtDate, setStatus, toast } from './dom';
import { renderReview } from './review';

let ctl: AbortController | null = null;
/** the last result per work, for this session (a proofreading pass is quick to run again) */
const results = new Map<string, ProofResult>();

type State = 'open' | 'done' | 'stale';
const stateOf = (app: App, it: ProofItem): State => {
  const now = spotValue(app.work(), it);
  return now === it.to ? 'done' : now === it.from ? 'open' : 'stale';
};

const showSpace = (s: string) => esc(s).replace(/ /g, '<span class="sp"> </span>').replace(/\n/g, '<span class="nl">↵</span>');
function diffHTML(a: string, b: string): string {
  return diffWords(a, b).map((p) => (p.op === 'eq' ? esc(p.text).replace(/\n/g, '<br>') : p.op === 'del' ? `<del>${showSpace(p.text)}</del>` : `<ins>${showSpace(p.text)}</ins>`)).join('');
}

export function renderProof(app: App): void {
  const w = app.work();
  const r = results.get(w.id);
  const btn = $<HTMLButtonElement>('btnProof');
  btn.textContent = ctl ? '교정 중…' : r ? '다시 교정' : '교정하기';
  btn.disabled = !!ctl || !app.online();
  const body = $('proofBody');
  if (!r) {
    body.innerHTML = '<div class="empty-note">맞춤법·띄어쓰기·문장부호를 20장 전체와 캡션에서 한 번에 찾아요. 고친 곳은 카드마다 비교해 보고 골라서 적용해요.</div>';
    return;
  }
  const states = r.items.map((it) => stateOf(app, it));
  const open = states.filter((s) => s === 'open').length;
  const total = r.items.reduce((n, it) => n + changeCount(diffWords(it.from, it.to)), 0);
  if (!r.items.length) {
    body.innerHTML = `<div class="proof"><p class="ok-note">고칠 곳을 찾지 못했어요. ${r.checked}곳을 살펴봤어요.</p>${r.summary ? `<p class="hint">${esc(r.summary)}</p>` : ''}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="proof">
      <div class="proof-top">
        <span><b>${r.items.length}</b>곳 · 고친 부분 <b>${total}</b>개${open < r.items.length ? ` · 남은 것 <b>${open}</b>곳` : ''}</span>
        <button class="btn small primary" type="button" data-all ${open ? '' : 'disabled'}>${open ? `남은 ${open}곳 모두 적용` : '모두 적용했어요'}</button>
      </div>
      ${r.summary ? `<p class="hint">${esc(r.summary)}</p>` : ''}
      <div class="stack">${r.items.map((it, k) => {
        const st = states[k];
        const kinds = [...new Set(it.changes.map((c) => c.kind))].map((c) => `<span class="kind">${PROOF_KIND_NAME[c]}</span>`).join('');
        return `
        <div class="proof-item ${st}">
          <div class="head">${it.index >= 0 ? `<button class="badge" type="button" data-go="${it.index}" title="이 카드로 가기">${esc(it.label)}</button>` : `<span class="badge">${esc(it.label)}</span>`}${kinds}</div>
          <div class="diff">${diffHTML(it.from, it.to)}</div>
          ${it.changes.length ? `<ul class="why">${it.changes.slice(0, 4).map((c) => `<li><span>${PROOF_KIND_NAME[c.kind]}</span> ${esc(c.from)} → ${esc(c.to)}</li>`).join('')}</ul>` : ''}
          ${it.lostMarks ? '<p class="warn">강조 표시(*별표*) 일부가 빠진 채로 왔어요. 적용한 뒤 확인해 주세요.</p>' : ''}
          <div class="toolbar">${st === 'open'
            ? `<button class="btn small tonal" type="button" data-apply="${k}">적용</button>`
            : st === 'done'
              ? `<span class="done">적용했어요</span><button class="btn small" type="button" data-revert="${k}">원래대로</button>`
              : '<span class="hint">교정한 뒤 글이 바뀌어서 적용할 수 없어요.</span>'}</div>
        </div>`;
      }).join('')}</div>
      <p class="hint">${fmtDate(r.at)}에 교정했어요 · ${r.tone === 'keep' ? '말투 그대로' : r.tone === 'hada' ? '하다체로 통일' : '해요체로 통일'}</p>
    </div>`;
}

/** Applying fixes leaves the AI review as fresh as it was: the story did not change. */
function afterChange(app: App, wasFresh: boolean, indices: number[]) {
  const w = app.work();
  if (wasFresh && w.review) w.review.sig = textSig(w);
  app.save();
  for (const i of new Set(indices)) if (i >= 0) app.refreshRow(i);
  app.scheduleRender();
  renderReview(app);
  renderProof(app);
}

export function wireProof(app: App): void {
  $('btnProof').addEventListener('click', () => void run(app));
  $('proofBody').addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const w = app.work();
    const r = results.get(w.id);
    if (!r) return;
    const go = el.closest<HTMLElement>('[data-go]');
    if (go) {
      const i = Number(go.dataset.go);
      app.select(i);
      document.querySelector<HTMLElement>(`.card-row[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const fresh = !!w.review && w.review.sig === textSig(w);
    const one = el.closest<HTMLElement>('[data-apply]');
    if (one) {
      const it = r.items[Number(one.dataset.apply)];
      if (!it) return;
      app.pushUndo();
      if (!applyProof(w, it)) { toast('글이 바뀌어서 적용하지 못했어요.'); renderProof(app); return; }
      afterChange(app, fresh, [it.index]);
      return;
    }
    const back = el.closest<HTMLElement>('[data-revert]');
    if (back) {
      const it = r.items[Number(back.dataset.revert)];
      if (!it || spotValue(w, it) !== it.to) return;
      app.pushUndo();
      applyProof(w, { ...it, from: it.to, to: it.from });
      afterChange(app, fresh, [it.index]);
      return;
    }
    if (el.closest('[data-all]')) {
      const todo = r.items.filter((it) => stateOf(app, it) === 'open');
      if (!todo.length) return;
      await app.keepVersion('proof');
      if (app.work() !== w) return;
      app.pushUndo();
      const done = todo.filter((it) => applyProof(w, it));
      afterChange(app, fresh, done.map((it) => it.index));
      toast(`${done.length}곳을 고쳤어요. 「되돌리기」나 버전 기록으로 돌아갈 수 있어요.`);
    }
  });
}

async function run(app: App) {
  const ai = app.textAI();
  const st = $('proofStatus');
  if (!ai) { setStatus(st, '글 AI 키가 필요해요. 설정에서 넣어 주세요.', 'error'); app.openSettings(); return; }
  const w = app.work();
  const tone = $<HTMLSelectElement>('proofTone').value as ProofTone;
  ctl = new AbortController();
  renderProof(app);
  setStatus(st, '20장을 읽으며 고칠 곳을 찾는 중… (보통 20~40초)', 'busy');
  try {
    const r = await proofWork(w, ai, tone, ctl.signal);
    results.set(w.id, r);
    if (app.work().id !== w.id) return;
    setStatus(st, r.items.length ? `${r.items.length}곳에서 고칠 곳을 찾았어요.` : '고칠 곳이 없어요.');
  } catch (e) {
    setStatus(st, aiMessage(e), (e as AiError)?.code === 'cancelled' ? '' : 'error');
  } finally {
    ctl = null;
    renderProof(app);
  }
}
