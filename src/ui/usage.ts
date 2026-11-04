// 「사용량」: this month's estimated AI spending, by job, company and work; budget warning; price table; CSV.
import type { App } from '../app';
import { download } from '../export';
import { workTitle } from '../model';
import { works } from '../store';
import { budgetAlert, clearMonth, estimateCost, money, monthKey, monthRecords, PROVIDER_NAME, recordUsage, summarize, TAG_NAME, toCSV, usageMonths, type UsageRecord } from '../usage';
import type { UsageEvent } from '../ai/providers';
import { $, confirmBox, esc, fmtTime, openModal, toast } from './dom';

/** Costs are recomputed with today's prices, so fixing a price in the table fixes the totals too. */
const priced = (app: App, list: UsageRecord[]) => list.map((r) => ({ ...r, cost: estimateCost(r, app.settings()) }));

export async function monthTotal(app: App, k = monthKey(Date.now())): Promise<number> {
  return summarize(priced(app, await monthRecords(k))).total;
}

export async function renderUsagePill(app: App): Promise<void> {
  const total = await monthTotal(app);
  const b = app.settings().monthlyBudget;
  const el = $('btnUsage');
  el.textContent = `이번 달 ${money(total)}`;
  el.classList.toggle('warn', !!b && total >= b * 0.8);
  el.title = b ? `이번 달 추정 비용 ${money(total)} / 예산 ${money(b)}` : '이번 달 AI 추정 비용';
}

/** Called for every AI call: store it, refresh the pill, warn at 80% and 100% of the budget. */
export async function onUsageEvent(app: App, u: UsageEvent): Promise<void> {
  const r: UsageRecord = { ...u, t: Date.now(), workId: app.work().id, cost: estimateCost(u, app.settings()) };
  await recordUsage(r);
  await renderUsagePill(app);
  const b = app.settings().monthlyBudget;
  if (!b) return;
  const total = await monthTotal(app);
  const level = await budgetAlert(total, b, monthKey(r.t));
  if (level) toast(level >= 100 ? `이번 달 AI 비용이 예산 ${money(b)}을 넘었어요 (추정 ${money(total)}).` : `이번 달 AI 비용이 예산의 80%를 넘었어요 (추정 ${money(total)} / ${money(b)}).`, 6000);
}

export async function openUsage(app: App, month = monthKey(Date.now())): Promise<void> {
  const st = app.settings();
  const months = await usageMonths();
  if (!months.includes(month)) months.push(month);
  months.sort().reverse();
  const list = priced(app, await monthRecords(month));
  const sum = summarize(list);
  const all = await works.all();
  const titles: Record<string, string> = Object.fromEntries(all.map((w) => [w.id, w.name || workTitle(w)]));
  const pct = st.monthlyBudget ? Math.min(100, (sum.total / st.monthlyBudget) * 100) : 0;
  const table = (rows: { key: string; cost: number; calls: number }[], name: (k: string) => string) => rows.length
    ? `<table class="usage-table"><tbody>${rows.slice(0, 10).map((r) => `<tr><td>${esc(name(r.key))}</td><td class="num">${r.calls}회</td><td class="num">${money(r.cost)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">기록이 없어요.</p>';
  const priceRow = (p: 'anthropic' | 'google' | 'openai') => `
    <tr><td>${PROVIDER_NAME[p]}</td>
      <td><input class="input num" type="number" min="0" step="0.01" data-p="${p}" data-k="in" value="${st.textPrices[p].in}"></td>
      <td><input class="input num" type="number" min="0" step="0.01" data-p="${p}" data-k="out" value="${st.textPrices[p].out}"></td></tr>`;
  openModal(`
    <div class="panel-head"><h2>사용량 · 비용</h2>
      <div class="toolbar">
        <select class="input" id="usMonth" style="width:auto">${months.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${m.replace('-', '년 ')}월</option>`).join('')}</select>
        <button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>
      </div>
    </div>
    <div class="scroll">
      <div class="usage-top">
        <div class="total">${money(sum.total)}<small> 추정</small></div>
        <div class="facts"><span>AI 호출 ${sum.calls}회</span><span>그림 ${sum.images}장</span><span>글 토큰 ${(sum.input / 1000).toFixed(1)}k 입력 · ${(sum.output / 1000).toFixed(1)}k 출력</span></div>
        ${st.monthlyBudget ? `<div class="budget-bar ${pct >= 100 ? 'over' : pct >= 80 ? 'near' : ''}"><i style="width:${pct}%"></i></div><div class="hint">예산 ${money(st.monthlyBudget)} 중 ${pct.toFixed(0)}%</div>` : ''}
      </div>
      <div class="row two usage-cols">
        <div><div class="section-title">용도별</div>${table(sum.byTag, (k) => TAG_NAME[k as keyof typeof TAG_NAME] ?? k)}</div>
        <div><div class="section-title">회사별</div>${table(sum.byProvider, (k) => PROVIDER_NAME[k as keyof typeof PROVIDER_NAME] ?? k)}</div>
      </div>
      <div class="section-title">작품별</div>${table(sum.byWork, (k) => titles[k] ?? '지운 작품')}
      <div class="section-title">최근 호출</div>
      ${list.length ? `<table class="usage-table small"><tbody>${list.slice(-12).reverse().map((r) => `<tr><td>${fmtTime(r.t)}</td><td>${esc(TAG_NAME[r.tag] ?? r.tag)}</td><td>${esc(r.model)}</td><td class="num">${r.images ? `${r.images}장` : `${r.input + r.output}토큰`}</td><td class="num">${money(r.cost)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">이 달에는 아직 AI를 쓰지 않았어요.</p>'}
      <div class="section-title">월 예산</div>
      <div class="toolbar" style="justify-content:flex-start"><input class="input num" id="usBudget" type="number" min="0" step="1" value="${st.monthlyBudget || ''}" placeholder="예: 20" style="width:120px"><span class="hint">달러. 80%와 100%에서 알려 줘요. 비우면 알림 없음.</span></div>
      <div class="section-title">글 AI 단가 (100만 토큰당 달러)</div>
      <table class="usage-table prices"><thead><tr><th></th><th>입력</th><th>출력</th></tr></thead><tbody>${priceRow('anthropic')}${priceRow('google')}${priceRow('openai')}</tbody></table>
      <p class="hint">그림 단가는 「설정 → 그림」에서 고쳐요. 가격은 모델마다 다르고 자주 바뀌어서 모든 금액은 추정치예요. 정확한 금액은 각 회사 콘솔에서 확인하세요.</p>
    </div>
    <div class="toolbar" style="margin-top:16px">
      <button class="btn" type="button" data-a="clear" ${list.length ? '' : 'disabled'}>이 달 기록 지우기</button>
      <button class="btn" type="button" data-a="csv" ${list.length ? '' : 'disabled'}>CSV로 받기</button>
      <span class="spacer"></span>
      <button class="btn primary" type="button" data-a="save">저장하고 닫기</button>
    </div>`,
  {
    size: 'wide',
    wire: (box, close) => {
      box.querySelector('[data-a="close"]')!.addEventListener('click', close);
      box.querySelector<HTMLSelectElement>('#usMonth')!.addEventListener('change', (e) => { close(); void openUsage(app, (e.target as HTMLSelectElement).value); });
      box.querySelector('[data-a="csv"]')!.addEventListener('click', () => download(new Blob([toCSV(list, titles)], { type: 'text/csv;charset=utf-8' }), `카드소설_사용량_${month}.csv`));
      box.querySelector('[data-a="clear"]')!.addEventListener('click', async () => {
        close();
        if (!(await confirmBox(`${month} 사용 기록을 지울까요? 실제 요금에는 영향이 없어요.`, { ok: '지우기' }))) { void openUsage(app, month); return; }
        await clearMonth(month);
        await renderUsagePill(app);
        void openUsage(app, month);
      });
      box.querySelector('[data-a="save"]')!.addEventListener('click', async () => {
        st.monthlyBudget = Math.max(0, Number(box.querySelector<HTMLInputElement>('#usBudget')!.value) || 0);
        box.querySelectorAll<HTMLInputElement>('input[data-p]').forEach((i) => {
          const p = i.dataset.p as 'anthropic' | 'google' | 'openai';
          const v = Number(i.value);
          if (Number.isFinite(v) && v >= 0) st.textPrices[p][i.dataset.k as 'in' | 'out'] = v;
        });
        await app.saveSettings();
        await renderUsagePill(app);
        close();
        toast('예산과 단가를 저장했어요.');
      });
    },
  });
}
