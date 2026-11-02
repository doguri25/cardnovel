// 「캡션 · 해시태그」: edit the post text and its hashtags, see how it reads before 「더 보기」, take AI ideas,
// and add the hashtags that did well on earlier posts.
import type { App } from '../app';
import { captionIdeas, type CaptionIdeas } from '../ai/caption';
import { aiMessage } from '../ai/providers';
import { captionText } from '../export';
import { CAPTION_LIMIT, HASHTAG_LIMIT } from '../precheck';
import { collectRows, fmtMeasure, normTag, tagStats, usesRate, type TagStat } from '../posts';
import { works } from '../store';
import { esc, openModal, setStatus, toast } from './dom';

/** Instagram shows about this much of a caption before 「더 보기」 */
const FOLD = 125;
let lastIdeas: { workId: string; ideas: CaptionIdeas } | null = null;

export function openCaption(app: App): void {
  const w = app.work();
  let pushed = false;
  let ctl: AbortController | null = null;
  const touch = () => { if (!pushed) { app.pushUndo(); pushed = true; } };
  openModal(`
    <div class="panel-head"><h2>캡션 · 해시태그</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    <div class="cap-grid">
      <div class="stack">
        <div class="field"><label for="capText">캡션 본문</label>
          <textarea class="input" id="capText" rows="6" placeholder="넘기면서 끝까지 읽어 주세요.">${esc(w.caption)}</textarea>
          <p class="hint">앞에 표지 제목과 훅이, 뒤에 해시태그가 붙어요.</p></div>
        <div class="field"><label for="tagInput">해시태그 <span class="hint" id="tagCount"></span></label>
          <div class="tag-box" id="tagBox"><span id="tagChips"></span><input id="tagInput" placeholder="태그 입력 후 Enter (쉼표·띄어쓰기로 여러 개)" autocomplete="off"></div></div>
        <div class="field"><label>이 계정에서 반응 좋았던 해시태그</label><div class="good-tags" id="goodTags"><span class="hint">불러오는 중…</span></div></div>
      </div>
      <div class="cap-preview">
        <div class="cap-head"><b>${esc(w.handle || '@내 계정')}</b><span class="hint" id="capCount"></span></div>
        <div class="cap-body" id="capPreview"></div>
      </div>
    </div>
    <div class="ideas-box">
      <div class="toolbar"><h3>AI 제안</h3><span class="spacer"></span><button class="btn small tonal" type="button" data-a="ideas">${lastIdeas?.workId === w.id ? '다시 제안받기' : '캡션·태그 제안받기'}</button></div>
      <span class="status" id="capStatus"></span>
      <div id="ideas"></div>
    </div>
    <div class="toolbar" style="margin-top:14px"><span class="spacer"></span><button class="btn" type="button" data-a="copy">전체 복사</button><button class="btn primary" type="button" data-a="done">닫기</button></div>`,
  {
    size: 'wide',
    onClose: () => { ctl?.abort(); },
    wire: (box, close) => {
      const q = <T extends HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
      const text = q<HTMLTextAreaElement>('#capText');
      const paint = () => {
        const full = captionText(w);
        q('#capCount').textContent = `${full.length.toLocaleString()} / ${CAPTION_LIMIT.toLocaleString()}자`;
        q('#capCount').classList.toggle('over', full.length > CAPTION_LIMIT);
        q('#capPreview').innerHTML = `<span>${esc(full.slice(0, FOLD))}</span>${full.length > FOLD ? `<span class="fold">… 더 보기</span><span class="rest">${esc(full.slice(FOLD))}</span>` : ''}`;
        q('#tagChips').innerHTML = w.hashtags.map((t, i) => `<span class="tag">${esc(t)}<button type="button" data-del="${i}" aria-label="${esc(t)} 빼기">×</button></span>`).join('');
        q('#tagCount').textContent = `${w.hashtags.length} / ${HASHTAG_LIMIT}개${w.hashtags.length ? '' : ' · 없으면 기본 태그 4개가 들어가요'}`;
        q('#tagCount').classList.toggle('over', w.hashtags.length > HASHTAG_LIMIT);
        box.querySelectorAll<HTMLButtonElement>('#goodTags [data-add]').forEach((b) => { b.disabled = w.hashtags.includes(b.dataset.add!); });
      };
      const addTags = (raw: string) => {
        const tags = raw.split(/[\s,]+/).map(normTag).filter((t) => t.length > 1);
        const fresh = tags.filter((t) => !w.hashtags.includes(t));
        if (!fresh.length) return;
        touch();
        w.hashtags = [...w.hashtags, ...fresh];
        if (w.hashtags.length > HASHTAG_LIMIT) toast(`인스타는 해시태그를 ${HASHTAG_LIMIT}개까지만 받아요.`);
        app.save(); paint();
      };
      text.addEventListener('input', () => { touch(); w.caption = text.value; app.save(); paint(); });
      const input = q<HTMLInputElement>('#tagInput');
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTags(input.value); input.value = ''; }
        else if (e.key === 'Backspace' && !input.value && w.hashtags.length) { touch(); w.hashtags = w.hashtags.slice(0, -1); app.save(); paint(); }
      });
      input.addEventListener('blur', () => { if (input.value.trim()) { addTags(input.value); input.value = ''; } });
      q('#tagBox').addEventListener('click', (e) => {
        const del = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del]');
        if (del) { touch(); w.hashtags = w.hashtags.filter((_, i) => i !== Number(del.dataset.del)); app.save(); paint(); return; }
        input.focus();
      });

      // hashtags that did well before
      let good: TagStat[] = [];
      void (async () => {
        const el = q('#goodTags');
        try {
          await app.flush().catch(() => undefined);
          const rows = collectRows(await works.all());
          let stats: TagStat[] = tagStats(rows, 2);
          if (!stats.length) stats = tagStats(rows, 1);
          const rate = usesRate(rows);
          good = stats;
          el.innerHTML = stats.length
            ? stats.slice(0, 16).map((g) => `<button class="tag-add" type="button" data-add="${esc(g.tag)}" title="${g.n}번 쓴 게시물의 평균 ${rate ? '참여율' : '반응 점수'}">+ ${esc(g.tag)}<small>${fmtMeasure(g.value, rate)}</small></button>`).join('')
            : '<span class="hint">「게시 기록 · 성과」에 올린 게시물의 숫자를 넣으면, 그때 쓴 해시태그 중 반응이 좋았던 것을 여기서 골라 넣을 수 있어요.</span>';
          el.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) => b.addEventListener('click', () => addTags(b.dataset.add!)));
          paint();
        } catch { el.innerHTML = '<span class="hint">기록을 불러오지 못했어요.</span>'; }
      })();

      const showIdeas = (ideas: CaptionIdeas) => {
        q('#ideas').innerHTML = `
          ${ideas.captions.length ? `<div class="idea-grid">${ideas.captions.map((c, i) => `<div class="idea"><span class="angle">${esc(c.angle || `후보 ${i + 1}`)}</span><p>${esc(c.text)}</p><button class="btn small" type="button" data-cap="${i}">이 캡션 쓰기</button></div>`).join('')}</div>` : ''}
          ${ideas.tagSets.map((t, i) => `<div class="tagset"><div><b>${esc(t.name)}</b> <span class="hint">${t.tags.length}개</span></div><p>${t.tags.map(esc).join(' ')}</p><div class="toolbar"><button class="btn small" type="button" data-set="${i}">이 묶음으로 바꾸기</button><button class="btn small" type="button" data-plus="${i}">지금 태그에 더하기</button></div></div>`).join('')}`;
        q('#ideas').querySelectorAll<HTMLButtonElement>('[data-cap]').forEach((b) => b.addEventListener('click', () => {
          touch(); w.caption = ideas.captions[Number(b.dataset.cap)].text; text.value = w.caption; app.save(); paint();
          toast('캡션을 바꿨어요.');
        }));
        q('#ideas').querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) => b.addEventListener('click', () => {
          touch(); w.hashtags = ideas.tagSets[Number(b.dataset.set)].tags.slice(0, HASHTAG_LIMIT); app.save(); paint();
          toast('해시태그를 바꿨어요.');
        }));
        q('#ideas').querySelectorAll<HTMLButtonElement>('[data-plus]').forEach((b) => b.addEventListener('click', () => addTags(ideas.tagSets[Number(b.dataset.plus)].tags.join(' '))));
      };
      if (lastIdeas?.workId === w.id) showIdeas(lastIdeas.ideas);
      q('[data-a="ideas"]').addEventListener('click', async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const st = q('#capStatus');
        const ai = app.textAI();
        if (!ai) { setStatus(st, '글 AI 키가 필요해요. 설정에서 넣어 주세요.', 'error'); return; }
        ctl = new AbortController();
        btn.disabled = true;
        setStatus(st, '캡션과 해시태그를 고르는 중… (10초 안팎)', 'busy');
        try {
          const ideas = await captionIdeas(w, ai, good, ctl.signal);
          lastIdeas = { workId: w.id, ideas };
          showIdeas(ideas);
          setStatus(st, '');
          btn.textContent = '다시 제안받기';
        } catch (err) {
          setStatus(st, err instanceof Error && err.message === 'empty' ? '제안을 받지 못했어요. 다시 눌러 주세요.' : aiMessage(err), 'error');
        } finally { ctl = null; btn.disabled = false; }
      });
      q('[data-a="copy"]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(captionText(w)); toast('캡션과 해시태그를 복사했어요.'); } catch { toast('복사가 막혔어요. 미리보기 글을 직접 골라 복사해 주세요.'); }
      });
      q('[data-a="close"]').addEventListener('click', close);
      q('[data-a="done"]').addEventListener('click', close);
      paint();
    },
  });
}
