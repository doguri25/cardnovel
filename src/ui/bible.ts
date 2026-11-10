// 「설정집」: the series' characters, places, rules and threads; AI fill-in and a consistency check of this episode.
import type { App } from '../app';
import { checkAgainstBible, fillBible, type CheckResult } from '../ai/bible';
import { aiMessage } from '../ai/providers';
import { isEmptyBible, loadBible, mergeBible, saveBible, type SeriesBible } from '../bible';
import { asPrev, previousEpisodes, seriesName } from '../series';
import { works } from '../store';
import { confirmBox, esc, openModal, setStatus, toast } from './dom';

const X = '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>';
const num = (i: number) => String(i + 1).padStart(2, '0');

export async function openBible(app: App): Promise<void> {
  const w = app.work();
  const series = seriesName(w);
  if (!series) { toast('시리즈 이름을 먼저 넣어 주세요. 설정집은 시리즈마다 하나예요.'); return; }
  const b: SeriesBible = JSON.parse(JSON.stringify(await loadBible(series)));
  let dirty = false;
  let check: CheckResult | null = null;
  let ctl: AbortController | null = null;

  const entries = (kind: 'characters' | 'places', ph: [string, string]) => b[kind].map((e, i) => `
    <div class="bible-row" data-kind="${kind}" data-i="${i}">
      <input class="input" data-f="name" placeholder="${ph[0]}" value="${esc(e.name)}">
      <input class="input" data-f="desc" placeholder="${ph[1]}" value="${esc(e.desc)}">
      <button class="btn icon" type="button" data-del aria-label="지우기">${X}</button>
    </div>`).join('');
  const threads = () => b.threads.map((t, i) => `
    <div class="bible-row thread" data-kind="threads" data-i="${i}">
      <input class="input" data-f="text" placeholder="예: 막차 승객이 들고 있던 빨간 우산" value="${esc(t.text)}">
      <select class="input" data-f="status"><option value="open" ${t.status === 'open' ? 'selected' : ''}>아직 안 풂</option><option value="closed" ${t.status === 'closed' ? 'selected' : ''}>풀었음</option></select>
      <input class="input num" data-f="episode" type="number" min="0" placeholder="화" value="${t.episode || ''}">
      <button class="btn icon" type="button" data-del aria-label="지우기">${X}</button>
    </div>`).join('');
  const checkHTML = () => !check ? '' : `
    <div class="section-title">설정 충돌 검사 결과</div>
    <p>${esc(check.summary || (check.issues.length ? '' : '설정과 어긋나는 곳을 찾지 못했어요.'))}</p>
    ${check.issues.map((x, k) => {
      const done = app.work().cards[x.index]?.text === x.suggestion;
      return `<div class="issue-box"><div class="head"><button class="badge" type="button" data-go="${x.index}">${num(x.index)}</button><span class="kind-tag">${esc(x.kind)}</span><span>${esc(x.issue)}</span></div>
      ${x.suggestion ? `<div class="fix">${esc(x.suggestion)}</div><div class="toolbar"><button class="btn small ${done ? '' : 'tonal'}" type="button" data-apply="${k}" ${done ? 'disabled' : ''}>${done ? '바꿨어요' : '이 문장으로 바꾸기'}</button></div>` : ''}</div>`;
    }).join('')}`;

  const body = () => `
    <div class="panel-head"><h2>「${esc(series)}」 설정집</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기">${X}</button></div>
    <div class="scroll bible">
      <p class="hint" style="margin:0">여기 적은 인물·설정은 카드를 구성할 때 AI에 함께 보내요. 다음 회를 써도 이름과 설정이 바뀌지 않게 해요.</p>
      <div class="section-title">인물</div>${entries('characters', ['이름', '나이·외모·성격·관계'])}<button class="btn small" type="button" data-add="characters">+ 인물</button>
      <div class="section-title">장소</div>${entries('places', ['장소', '특징'])}<button class="btn small" type="button" data-add="places">+ 장소</button>
      <div class="section-title">세계관 · 바뀌면 안 되는 사실</div><textarea class="input" id="bibleRules" rows="4" placeholder="줄마다 하나씩. 예: 막차는 밤 11시 40분에 종점에 닿는다">${esc(b.rules)}</textarea>
      <div class="section-title">떡밥</div>${threads()}<button class="btn small" type="button" data-add="threads">+ 떡밥</button>
      <div id="bibleCheck">${checkHTML()}</div>
    </div>
    <div class="toolbar" style="margin-top:14px">
      <button class="btn tonal" type="button" data-a="fill">AI로 채우기</button>
      <button class="btn" type="button" data-a="check">이번 회 설정 충돌 검사</button>
      <span class="status" id="bibleStatus"></span>
      <span class="spacer"></span>
      <button class="btn primary" type="button" data-a="save">저장</button>
    </div>`;

  let box: HTMLElement;
  const rerender = () => {
    const scroll = box.querySelector('.scroll')?.scrollTop ?? 0;
    box.innerHTML = body();
    box.querySelector('.scroll')!.scrollTop = scroll;
    bind();
  };
  const status = (m: string, k: '' | 'busy' | 'error' = '') => setStatus(box.querySelector<HTMLElement>('#bibleStatus')!, m, k);
  const persist = async () => {
    b.updatedAt = Date.now();
    await saveBible(b);
    const cur = app.work();
    if (seriesName(cur) === series) { cur.seriesBible = JSON.parse(JSON.stringify(b)); app.save(); }
    dirty = false;
  };
  const episodes = async (onlyBefore: boolean) => {
    const all = await works.all();
    const cur = app.work();
    const list = onlyBefore && cur.episode ? previousEpisodes(all, cur, 8) : all.filter((x) => x.id !== cur.id && seriesName(x) === series).sort((a, c) => (a.episode || 0) - (c.episode || 0)).slice(-8);
    return list.map(asPrev);
  };

  let close: () => void = () => undefined;
  const bind = () => {
    box.querySelector('[data-a="close"]')!.addEventListener('click', () => void tryClose());
  };
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'bibleRules') { b.rules = el.value; dirty = true; return; }
    const row = el.closest<HTMLElement>('.bible-row');
    if (!row || !el.dataset.f) return;
    const list = b[row.dataset.kind as 'characters' | 'places' | 'threads'] as unknown as Record<string, unknown>[];
    const item = list[Number(row.dataset.i)];
    if (!item) return;
    item[el.dataset.f] = el.dataset.f === 'episode' ? Number(el.value) || undefined : el.value;
    dirty = true;
  };
  const tryClose = async () => {
    ctl?.abort();
    if (dirty) {
      close();
      if (await confirmBox('설정집에 저장하지 않은 내용이 있어요. 저장할까요?', { ok: '저장', cancel: '버리기' })) { await persist(); toast('설정집을 저장했어요.'); }
      return;
    }
    close();
  };

  close = openModal('', {
    size: 'wide',
    wire: (bx, c) => {
      box = bx;
      close = c;
      box.innerHTML = body();
      bind();
      box.addEventListener('input', onInput);
      box.addEventListener('change', onInput);
      box.addEventListener('click', async (e) => {
        const el = e.target as HTMLElement;
        const add = el.closest<HTMLElement>('[data-add]');
        if (add) {
          const k = add.dataset.add as 'characters' | 'places' | 'threads';
          if (k === 'threads') b.threads.push({ text: '', status: 'open', ...(app.work().episode ? { episode: app.work().episode } : {}) });
          else b[k].push({ name: '', desc: '' });
          dirty = true; rerender();
          return;
        }
        const del = el.closest<HTMLElement>('[data-del]');
        if (del) {
          const row = del.closest<HTMLElement>('.bible-row')!;
          (b[row.dataset.kind as 'characters' | 'places' | 'threads'] as unknown[]).splice(Number(row.dataset.i), 1);
          dirty = true; rerender();
          return;
        }
        const go = el.closest<HTMLElement>('[data-go]');
        if (go) { app.select(Number(go.dataset.go)); return; }
        const apply = el.closest<HTMLElement>('[data-apply]');
        if (apply && check) {
          const x = check.issues[Number(apply.dataset.apply)];
          const card = app.work().cards[x.index];
          if (!card || !x.suggestion) return;
          app.pushUndo();
          card.text = x.suggestion;
          app.save(); app.refreshRow(x.index); app.scheduleRender();
          box.querySelector('#bibleCheck')!.innerHTML = checkHTML();
          toast(`${num(x.index)}번 카드를 바꿨어요. 「되돌리기」로 돌아갈 수 있어요.`);
          return;
        }
        const a = el.closest<HTMLElement>('[data-a]')?.dataset.a;
        if (a === 'save') { await persist(); close(); toast('설정집을 저장했어요. 다음에 카드를 구성할 때부터 반영돼요.'); return; }
        if (a === 'fill' || a === 'check') {
          const ai = app.textAI();
          if (!ai) { status('글 AI 키가 필요해요. 설정에서 넣어 주세요.', 'error'); return; }
          if (!app.online()) { status('인터넷 연결이 필요해요.', 'error'); return; }
          ctl?.abort();
          ctl = new AbortController();
          const cur = app.work();
          const hasText = cur.cards.some((c) => c.kind === 'body' && c.text.trim());
          try {
            if (a === 'fill') {
              const eps = await episodes(false);
              if (!eps.length && !hasText) { status('이 시리즈에 쓴 회차가 아직 없어요.', 'error'); return; }
              status('회차들을 읽고 설정을 정리하는 중…', 'busy');
              const found = await fillBible(ai, series, eps, hasText ? cur : null, b, ctl.signal);
              const before = JSON.stringify([b.characters, b.places, b.rules, b.threads]);
              Object.assign(b, mergeBible(b, found));
              dirty = true;
              rerender();
              status(JSON.stringify([b.characters, b.places, b.rules, b.threads]) === before ? '새로 더할 설정을 찾지 못했어요.' : 'AI가 찾은 설정을 더했어요. 확인하고 「저장」을 누르세요.');
            } else {
              if (!hasText) { status('이번 회 카드를 먼저 채워 주세요.', 'error'); return; }
              if (isEmptyBible(b)) { status('설정집이 비어 있어요. 「AI로 채우기」나 직접 적은 뒤 검사하세요.', 'error'); return; }
              status('이번 회를 설정과 맞춰 보는 중…', 'busy');
              check = await checkAgainstBible(ai, cur, b, await episodes(true), ctl.signal);
              box.querySelector('#bibleCheck')!.innerHTML = checkHTML();
              box.querySelector('#bibleCheck')!.scrollIntoView({ behavior: 'smooth', block: 'start' });
              status(check.issues.length ? `어긋나는 곳 ${check.issues.length}군데를 찾았어요.` : '설정과 어긋나는 곳이 없어요.');
            }
          } catch (err) {
            status(aiMessage(err), 'error');
          } finally {
            ctl = null;
          }
        }
      });
    },
    onClose: () => ctl?.abort(),
  });
}
