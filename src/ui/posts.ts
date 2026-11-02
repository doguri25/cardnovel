// 「게시 기록·성과」: when and where this episode went up and how it did, and across all works which covers,
// hooks, themes, days and hours did best — with an AI reading of the patterns.
import type { App } from '../app';
import { askJSON } from '../ai/compose';
import { aiMessage } from '../ai/providers';
import { download } from '../export';
import { newPost, POST_KIND_NAME, POST_METRICS, workTitle, type PostKind, type PostMetric, type PostRecord, type Work } from '../model';
import {
  bestPerWork, collectRows, fmtMeasure, fmtNum, groupBy, hasNumbers, HOUR_BANDS, hourBand, INSIGHT_SCHEMA, insightPrompt, normalizeInsight,
  pct, postsCSV, rowOf, usesRate, WEEKDAY, type Group, type Insight, type PostRow,
} from '../posts';
import { kv, works } from '../store';
import { esc, fmtDate, openModal, pad2, setStatus, toast } from './dom';

const METRICS = Object.keys(POST_METRICS) as PostMetric[];
const toLocal = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const epName = (r: Pick<PostRow, 'title' | 'episode'>) => `${r.title}${r.episode ? ` · ${r.episode}화` : ''}`;

function recHTML(p: PostRecord): string {
  return `
  <div class="post-rec" data-id="${esc(p.id)}">
    <div class="row three">
      <div class="field"><label>올린 시각</label><input class="input" type="datetime-local" data-f="at" value="${toLocal(p.at)}"></div>
      <div class="field"><label>어디에</label><select class="input" data-f="kind">${(Object.keys(POST_KIND_NAME) as PostKind[]).map((k) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${POST_KIND_NAME[k]}</option>`).join('')}</select></div>
      <div class="field"><label>링크 (선택)</label><input class="input" type="url" data-f="url" placeholder="https://www.instagram.com/p/…" value="${esc(p.url)}"></div>
    </div>
    <div class="metrics">${METRICS.map((m) => `<div class="field"><label>${POST_METRICS[m]}</label><input class="input" type="number" min="0" step="1" inputmode="numeric" data-f="${m}" value="${p[m] ?? ''}" placeholder="–"></div>`).join('')}</div>
    <div class="post-foot">
      <input class="input" data-f="note" placeholder="메모 (예: 해시태그 바꿔 봄, 스토리에도 올림)" value="${esc(p.note)}">
      <span class="rate" data-rate></span>
      <button class="btn small" type="button" data-del>지우기</button>
    </div>
  </div>`;
}

function bars(groups: Group[], rate: boolean, unit: string): string {
  const max = Math.max(...groups.map((g) => g.value), 0) || 1;
  return `<div class="bars" role="list">${groups.map((g) => {
    const label = `${g.key} · ${unit} ${g.n}개 · 평균 ${rate ? '참여율' : '반응 점수'} ${fmtMeasure(g.value, rate)}`;
    return `<div class="bar-row" role="listitem" title="${esc(label)}" aria-label="${esc(label)}"><span class="k">${esc(g.key)}</span><span class="track"><i style="width:${Math.max(2, (g.value / max) * 100).toFixed(1)}%"></i></span><span class="val">${fmtMeasure(g.value, rate)}<small>${g.n}개</small></span></div>`;
  }).join('')}</div>`;
}

function insightHTML(ins: Insight | null): string {
  if (!ins) return '';
  return `<div class="insight">
    ${ins.patterns.length ? `<h4>보이는 패턴</h4><ul>${ins.patterns.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${ins.tips.length ? `<h4>다음 화에 해 볼 것</h4><ul>${ins.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${ins.next ? `<h4>다음 화 표지 제안</h4><p class="next">${esc(ins.next)}</p>` : ''}
    <p class="hint">${fmtDate(ins.at)} · 게시물 ${ins.posts}개를 읽었어요. 표본이 적으면 우연일 수 있어요.</p>
  </div>`;
}

function dashboardHTML(rows: PostRow[], all: Work[], ins: Insight | null): string {
  if (!rows.length) {
    return `<div class="empty-note">아직 숫자를 넣은 게시 기록이 없어요.<br>작품마다 「이 작품 기록」에 올린 날짜와 좋아요·저장 수를 넣으면 여기서 비교해 줘요.</div>`;
  }
  const rate = usesRate(rows);
  const best = bestPerWork(rows, rate);
  const avg = (f: (r: PostRow) => number, list = rows) => list.reduce((a, r) => a + f(r), 0) / Math.max(1, list.length);
  const withReach = rows.filter((r) => r.rate !== null);
  const sections: [string, Group[], string][] = [
    ['테마', groupBy(rows, (r) => r.theme, rate), '게시물'],
    ['표지 모양', groupBy(rows, (r) => r.coverLayout, rate), '게시물'],
    ['요일', groupBy(rows, (r) => WEEKDAY[r.weekday] + '요일', rate, WEEKDAY.map((d) => d + '요일')), '게시물'],
    ['시간대', groupBy(rows, (r) => hourBand(r.hour), rate, HOUR_BANDS.map((b) => b.name)), '게시물'],
    ['올린 곳', groupBy(rows, (r) => POST_KIND_NAME[r.kind], rate, Object.values(POST_KIND_NAME)), '게시물'],
  ];
  const shown = sections.filter(([, g]) => g.length >= 2);
  const byId = new Map(all.map((w) => [w.id, w]));
  return `
    <div class="kpis">
      <div class="kpi"><span>기록한 게시물</span><b>${rows.length}</b><small>작품 ${new Set(rows.map((r) => r.workId)).size}편</small></div>
      <div class="kpi"><span>${rate ? '평균 참여율' : '평균 반응 점수'}</span><b>${rate ? pct(avg((r) => r.rate ?? 0, withReach)) : Math.round(avg((r) => r.score))}</b><small>${rate ? '(좋아요+댓글+저장+공유) ÷ 도달' : '좋아요 + 댓글×2 + 저장·공유×3 + 팔로우×5'}</small></div>
      <div class="kpi"><span>평균 저장</span><b>${avg((r) => r.saves).toFixed(1)}</b><small>평균 공유 ${avg((r) => r.shares).toFixed(1)}</small></div>
      <div class="kpi"><span>가장 반응 좋은 화</span><b class="t">${esc(best[0] ? epName(best[0]) : '–')}</b><small>${best[0] ? fmtMeasure(rate ? best[0].rate ?? 0 : best[0].score, rate) : ''}</small></div>
    </div>
    ${rate ? '' : '<p class="hint">도달·조회 수를 넣은 게시물이 절반이 안 돼서, 반응 수에 무게를 둔 점수로 비교해요. 도달 수를 넣으면 참여율로 비교해요.</p>'}
    <h3>반응 좋은 순 (작품마다 가장 좋은 게시물)</h3>
    <div class="table-wrap"><table class="perf">
      <thead><tr><th>#</th><th>작품</th><th>표지 훅</th><th>올린 날</th><th class="n">도달</th><th class="n">좋아요</th><th class="n">댓글</th><th class="n">저장</th><th class="n">공유</th><th class="n">${rate ? '참여율' : '점수'}</th></tr></thead>
      <tbody>${best.slice(0, 12).map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td>${byId.has(r.workId) ? `<button class="link" type="button" data-open="${esc(r.workId)}">${esc(epName(r))}</button>` : esc(epName(r))}<small>${esc(r.theme)} · ${esc(r.coverLayout)}</small></td>
        <td class="hook">${esc(r.hook || '–')}</td>
        <td>${new Date(r.at).getMonth() + 1}/${new Date(r.at).getDate()} (${WEEKDAY[r.weekday]}) ${r.hour}시</td>
        <td class="n">${fmtNum(r.reach)}</td><td class="n">${fmtNum(r.likes)}</td><td class="n">${fmtNum(r.comments)}</td><td class="n">${fmtNum(r.saves)}</td><td class="n">${fmtNum(r.shares)}</td>
        <td class="n"><b>${rate ? pct(r.rate) : r.score}</b></td></tr>`).join('')}</tbody>
    </table></div>
    ${shown.length ? `<div class="groups">${shown.map(([name, g, unit]) => `<div class="group"><h3>${name}별 ${rate ? '평균 참여율' : '평균 반응'}</h3>${bars(g, rate, unit)}</div>`).join('')}</div>` : '<p class="hint">테마·요일·시간대가 서로 다른 게시물이 쌓이면 무엇이 잘되는지 막대로 비교해 줘요.</p>'}
    <div class="insight-box">
      <div class="toolbar"><h3 style="margin:0">AI 패턴 읽기</h3><span class="spacer"></span><button class="btn small tonal" type="button" data-a="insight" ${rows.length < 3 ? 'disabled title="게시물 3개 이상부터"' : ''}>${ins ? '다시 읽기' : '패턴 읽기'}</button></div>
      <span class="status" id="psStatus"></span>
      <div id="psInsight">${insightHTML(ins)}</div>
    </div>
    <details class="all-posts"><summary>전체 기록 ${rows.length}개</summary>
      <div class="table-wrap"><table class="perf">
        <thead><tr><th>올린 시각</th><th>작품</th><th>어디에</th>${METRICS.map((m) => `<th class="n">${POST_METRICS[m]}</th>`).join('')}<th class="n">참여율</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${fmtDate(r.at)}</td><td>${esc(epName(r))}</td><td>${POST_KIND_NAME[r.kind]}</td><td class="n">${fmtNum(r.reach)}</td><td class="n">${fmtNum(r.likes)}</td><td class="n">${fmtNum(r.comments)}</td><td class="n">${fmtNum(r.saves)}</td><td class="n">${fmtNum(r.shares)}</td><td class="n">${fmtNum(r.follows)}</td><td class="n">${pct(r.rate)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="toolbar" style="margin-top:8px"><button class="btn small" type="button" data-a="csv">CSV로 내려받기</button></div>
    </details>`;
}

export function openPosts(app: App, tab: 'mine' | 'all' = 'mine'): void {
  const w = app.work();
  if (!w.posts) w.posts = [];
  let insightCtl: AbortController | null = null;
  openModal(`
    <div class="panel-head"><h2>게시 기록 · 성과</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    <div class="seg" id="psTabs" role="tablist"><button type="button" role="tab" data-t="mine">이 작품 기록</button><button type="button" role="tab" data-t="all">성과 한눈에</button></div>
    <div id="psMine" class="posts-pane">
      <p class="hint">「${esc(workTitle(w))}」을(를) 올린 날짜와 반응을 적어 두세요. 하루·일주일 뒤 숫자로 고쳐 써도 돼요. 숫자는 인스타 앱 「인사이트」에서 볼 수 있어요.</p>
      <div class="stack" id="psList"></div>
      <div class="toolbar" style="margin-top:10px"><button class="btn tonal" type="button" data-a="add">게시 기록 추가</button></div>
    </div>
    <div id="psAll" class="posts-pane" hidden><div class="empty-note">불러오는 중…</div></div>`,
  {
    size: 'wide',
    onClose: () => { insightCtl?.abort(); app.save(); },
    wire: (box, close) => {
      const q = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
      const list = q('#psList');
      const posts = () => app.work().posts ?? [];
      const showRate = (el: HTMLElement, p: PostRecord) => {
        const r = rowOf(app.work(), p);
        el.querySelector<HTMLElement>('[data-rate]')!.textContent = hasNumbers(p) ? (r.rate !== null ? `참여율 ${pct(r.rate)}` : `반응 ${r.interactions.toLocaleString('ko-KR')}`) : '';
      };
      const paint = () => {
        const ps = [...posts()].sort((a, b) => b.at - a.at);
        list.innerHTML = ps.length ? ps.map(recHTML).join('') : '<div class="empty-note">아직 기록이 없어요. 올린 뒤 「게시 기록 추가」를 눌러 주세요.</div>';
        list.querySelectorAll<HTMLElement>('.post-rec').forEach((el) => { const p = posts().find((x) => x.id === el.dataset.id); if (p) showRate(el, p); });
      };
      const update = (el: HTMLElement, f: string, val: string) => {
        const p = posts().find((x) => x.id === el.closest<HTMLElement>('.post-rec')!.dataset.id);
        if (!p) return;
        if (f === 'at') { const t = new Date(val).getTime(); if (Number.isFinite(t)) p.at = t; }
        else if (f === 'kind') p.kind = val as PostKind;
        else if (f === 'url') p.url = val.trim();
        else if (f === 'note') p.note = val;
        else if ((METRICS as string[]).includes(f)) { const n = Math.round(Number(val)); (p as unknown as Record<string, number | null>)[f] = val.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, n); }
        p.updatedAt = Date.now();
        showRate(el.closest<HTMLElement>('.post-rec')!, p);
        app.save();
      };
      list.addEventListener('input', (e) => { const el = e.target as HTMLInputElement; if (el.dataset.f && el.dataset.f !== 'at') update(el, el.dataset.f, el.value); });
      list.addEventListener('change', (e) => { const el = e.target as HTMLInputElement; if (el.dataset.f) update(el, el.dataset.f, el.value); });
      list.addEventListener('click', (e) => {
        const del = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del]');
        if (!del) return;
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = '정말 지울까요?'; del.classList.add('danger'); setTimeout(() => { if (del.isConnected) { del.dataset.sure = ''; del.textContent = '지우기'; del.classList.remove('danger'); } }, 3000); return; }
        const id = del.closest<HTMLElement>('.post-rec')!.dataset.id;
        app.work().posts = posts().filter((p) => p.id !== id);
        app.save(); paint();
      });
      q('[data-a="add"]').addEventListener('click', () => {
        const ws = app.work();
        const last = (ws.posts ?? []).length;
        ws.posts = [...(ws.posts ?? []), newPost()];
        app.save(); paint();
        if (!last) toast('올린 시각은 지금으로 넣었어요. 다르면 고쳐 주세요.');
        list.querySelector<HTMLInputElement>('.post-rec [data-f="reach"]')?.focus();
      });

      let loaded = false;
      const loadAll = async () => {
        const pane = q('#psAll');
        await app.flush().catch(() => undefined);
        const all = await works.all();
        const rows = collectRows(all);
        const ins = await kv.get<Insight | null>('posts.insight', null);
        pane.innerHTML = dashboardHTML(rows, all, ins);
        loaded = true;
        pane.querySelector('[data-a="csv"]')?.addEventListener('click', () => download(new Blob([postsCSV(rows)], { type: 'text/csv;charset=utf-8' }), `카드소설_게시기록_${new Date().toISOString().slice(0, 10)}.csv`));
        pane.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => b.addEventListener('click', async () => {
          const target = all.find((x) => x.id === b.dataset.open);
          if (!target) return;
          close();
          if (target.id !== app.work().id) await app.openWork(target);
        }));
        pane.querySelector<HTMLButtonElement>('[data-a="insight"]')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          const st = pane.querySelector<HTMLElement>('#psStatus')!;
          const ai = app.textAI();
          if (!ai) { setStatus(st, '글 AI 키가 필요해요. 설정에서 넣어 주세요.', 'error'); return; }
          insightCtl = new AbortController();
          btn.disabled = true;
          setStatus(st, '기록을 읽는 중…', 'busy');
          try {
            const raw = await askJSON<{ patterns?: unknown; tips?: unknown; next?: unknown }>(ai, insightPrompt(rows), INSIGHT_SCHEMA, insightCtl.signal, 4000, 'insight');
            const result = normalizeInsight(raw, rows.length);
            await kv.set('posts.insight', result);
            pane.querySelector('#psInsight')!.innerHTML = insightHTML(result);
            btn.textContent = '다시 읽기';
            setStatus(st, '');
          } catch (err) {
            setStatus(st, aiMessage(err), 'error');
          } finally {
            insightCtl = null; btn.disabled = false;
          }
        });
      };
      const setTab = (t: 'mine' | 'all') => {
        box.querySelectorAll<HTMLButtonElement>('#psTabs button').forEach((b) => { const on = b.dataset.t === t; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
        q('#psMine').hidden = t !== 'mine';
        q('#psAll').hidden = t !== 'all';
        if (t === 'all' && !loaded) void loadAll().catch(() => { q('#psAll').innerHTML = '<div class="empty-note">기록을 불러오지 못했어요.</div>'; });
      };
      box.querySelectorAll<HTMLButtonElement>('#psTabs button').forEach((b) => b.addEventListener('click', () => { loaded = false; setTab(b.dataset.t as 'mine' | 'all'); }));
      q('[data-a="close"]').addEventListener('click', close);
      paint();
      setTab(tab);
    },
  });
}
