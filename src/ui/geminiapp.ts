// 「Gemini 앱으로 그리기」: the writer draws every card in one Gemini app chat (their own subscription, the best model,
// the people kept the same across the chat). This window copies the prompts and takes the pictures back:
// a paste (Ctrl+V / ⌘V) goes onto the card marked ▶, or many downloaded files go on together after an order check.
import type { App } from '../app';
import { assignFiles, geminiCardPrompt, geminiFirstMessage, pasteTarget } from '../geminiapp';
import { download } from '../export';
import { srcOf } from '../render';
import { esc, openModal, setStatus, toast } from './dom';

export interface GeminiDeps {
  /** the open work's words changed since its last 연출 정리 */
  needsDirection(): boolean;
  /** runs 연출 정리 on the open work; true when it finished */
  direct(): Promise<boolean>;
  /** puts a picture on card `i` of the open work (marked as drawn in the Gemini app); false when it could not */
  setPicture(i: number, dataUrl: string): Promise<boolean>;
  /** makes a picture the work's character reference */
  setRef(dataUrl: string): Promise<void>;
}

type Target = number | 'ref';
let open = false;
/** the helper is showing (the app's own paste handling stays out of its way) */
export const geminiHelperOpen = (): boolean => open;

const num = (i: number) => String(i + 1).padStart(2, '0');
const readFile = (f: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** An image on the clipboard, read on a click (browsers ask the writer first); null when there is none or reading is not allowed. */
async function clipboardImage(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.read) return null;
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return readFile(await item.getType(type));
    }
  } catch { /* not allowed or not supported: Ctrl+V still works */ }
  return null;
}

export function openGeminiHelper(app: App, deps: GeminiDeps): void {
  const w0 = app.work();
  const picCards = () => app.work().cards.map((c, i) => ({ c, i })).filter(({ c }) => c.kind !== 'outro');
  const missing = () => picCards().filter(({ c }) => !srcOf(c)).map(({ i }) => i);
  const nextMissing = (after: number) => missing().find((i) => i > after) ?? missing()[0] ?? null;
  // nothing marked when every card has a picture: a stray paste must not replace one
  let target: Target | null = missing()[0] ?? null;
  let box: HTMLElement | null = null;
  let review: { file: File; url: string; index: number }[] | null = null;

  const status = (msg: string, kind: '' | 'busy' | 'error' = '') => { const el = box?.querySelector<HTMLElement>('#gxStatus'); if (el) setStatus(el, msg, kind); };
  const where = (t: Target | null) => (t === 'ref' ? '인물 기준 그림' : t === null ? '' : t === 0 ? '01번 카드(표지)' : `${num(t)}번 카드`);

  const rowsHTML = () => picCards().map(({ c, i }) => {
    const src = srcOf(c);
    const words = (c.kind === 'cover' ? c.text || c.title : c.text).replace(/\*/g, '').trim();
    return `<li class="gx-row ${target === i ? 'target' : ''}" data-i="${i}">
      <span class="gx-n">${target === i ? '▶ ' : ''}${num(i)}${c.kind === 'cover' ? ' 표지' : ''}</span>
      <span class="gx-t">${esc(words.slice(0, 38)) || '<em>글 없음</em>'}</span>
      <span class="gx-pic">${src ? `<img alt="" src="${src}">` : ''}</span>
      <button class="btn tiny tonal" type="button" data-copy="${i}">복사</button>
      <button class="btn tiny" type="button" data-paste="${i}">붙여넣기</button>
    </li>`;
  }).join('');

  const mainHTML = () => {
    const w = app.work();
    return `
    <div class="panel-head"><h2>Gemini 앱으로 그리기</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    <p class="hint" style="margin:0 0 10px">Gemini 앱의 새 대화 하나에서 모든 카드를 차례로 그려요. 한 대화 안에서 그리니 인물이 이어지고, 이 앱의 그림 비용은 들지 않아요.</p>
    <section class="gx-step">
      <h3>① 준비</h3>
      ${deps.needsDirection() ? '<div class="gx-line"><button class="btn tonal" type="button" data-a="direct">연출 먼저 정리하기</button><span class="hint">글 AI가 이야기 전체를 읽고 인물 생김새와 장면을 이어지게 정리해요. 지시문이 더 좋아져요.</span></div>' : ''}
      <div class="gx-line"><button class="btn primary" type="button" data-a="first">첫 메시지 복사</button><a class="btn" href="https://gemini.google.com/app" target="_blank" rel="noopener">Gemini 열기</a><span class="hint">Gemini 새 대화에 붙여넣으세요. 그림체·인물·규칙이 들어 있어요.</span></div>
      ${w.style.refImage ? '<div class="gx-line"><button class="btn" type="button" data-a="refsave">인물 기준 그림 저장</button><span class="hint">첫 메시지와 함께 Gemini에 올리면 인물이 더 잘 맞아요.</span></div>' : ''}
      <div class="gx-line ${target === 'ref' ? 'target' : ''}" id="gxRefLine"><button class="btn" type="button" data-a="refpaste">${target === 'ref' ? '▶ ' : ''}Gemini가 그린 인물 기준 그림 넣기</button><button class="btn" type="button" data-a="refupload">파일로</button><span class="hint">Gemini·GPT 이미지로 그릴 때도 이 그림을 기준으로 써요.</span></div>
    </section>
    <section class="gx-step">
      <h3>② 카드별 지시문</h3>
      <p class="hint">[복사] → Gemini에 붙여넣기 → 그림이 나오면 그림을 눌러 「이미지 복사」 → 여기서 Ctrl+V(⌘V). 그림은 ▶ 카드에 들어가고, ▶는 다음 빈 카드로 넘어가요.</p>
      <ol class="gx-list" id="gxList">${rowsHTML()}</ol>
    </section>
    <section class="gx-step">
      <h3>③ 한꺼번에 올리기</h3>
      <div class="gx-line"><button class="btn" type="button" data-a="bulk">그린 그림 한꺼번에 올리기</button><span class="hint">내려받은 그림을 여러 장 고르면 만든 순서대로 그림 없는 카드에 차례로 넣어요. 넣기 전에 확인할 수 있어요.</span></div>
      <input type="file" id="gxFiles" accept="image/*" multiple hidden>
      <input type="file" id="gxRefFile" accept="image/*" hidden>
    </section>
    <p class="status" id="gxStatus" aria-live="polite">${target !== null ? `붙여넣으면 ${where(target)}에 들어가요.` : ''}</p>`;
  };

  const reviewHTML = () => {
    const opts = picCards().map(({ c, i }) => ({ i, label: `${num(i)}번 카드${c.kind === 'cover' ? '(표지)' : ''}${srcOf(c) ? ' · 그림 있음' : ''}` }));
    return `
    <div class="panel-head"><h2>순서 확인</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    <p class="hint" style="margin:0 0 12px">그림마다 들어갈 카드를 확인하세요. 바꾸려면 카드를 고르고, 빼려면 「넣지 않음」을 고르세요. 그림이 있는 카드는 고를 때만 바뀌어요.</p>
    <div class="cand-grid gx-review">${review!.map((r, k) => `
      <figure class="cand">
        <img alt="${esc(r.file.name)}" src="${r.url}">
        <figcaption>${esc(r.file.name)}</figcaption>
        <select class="input" data-k="${k}" aria-label="${esc(r.file.name)} 넣을 카드">
          <option value="-1" ${r.index < 0 ? 'selected' : ''}>넣지 않음</option>
          ${opts.map((o) => `<option value="${o.i}" ${o.i === r.index ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </figure>`).join('')}
    </div>
    <div class="gx-line" style="margin-top:14px"><button class="btn" type="button" data-a="back">뒤로</button><button class="btn primary" type="button" data-a="apply">카드에 넣기</button></div>
    <p class="status" id="gxStatus" aria-live="polite">${review!.some((r) => r.index < 0) ? '그림 없는 카드보다 많은 그림은 「넣지 않음」으로 두었어요.' : ''}</p>`;
  };

  const paint = () => { if (box) box.innerHTML = review ? reviewHTML() : mainHTML(); };
  /** the list and the ▶ mark only, so the window keeps its scroll and status line */
  const repaintList = () => {
    if (!box || review) return;
    const list = box.querySelector('#gxList');
    if (list) list.innerHTML = rowsHTML();
    const ref = box.querySelector<HTMLElement>('#gxRefLine');
    if (ref) {
      ref.classList.toggle('target', target === 'ref');
      ref.querySelector('[data-a="refpaste"]')!.textContent = `${target === 'ref' ? '▶ ' : ''}Gemini가 그린 인물 기준 그림 넣기`;
    }
    box.querySelector('#gxList .target')?.scrollIntoView({ block: 'nearest' });
  };

  /** a picture for the marked place: the character reference, or a card (then ▶ moves to the next card without one) */
  const put = async (url: string, t: Target | null = target) => {
    if (t === null) return;
    if (app.work().id !== w0.id) { status('다른 작품이 열려 그림을 넣지 않았어요. 도우미를 다시 열어 주세요.', 'error'); return; }
    if (t === 'ref') {
      await deps.setRef(url);
      target = missing()[0] ?? null;
      repaintList();
      status('인물 기준 그림을 넣었어요.');
      return;
    }
    status(`${where(t)}에 넣는 중…`, 'busy');
    if (!(await deps.setPicture(t, url))) { status(`${where(t)}에 넣지 못했어요.`, 'error'); return; }
    target = nextMissing(t);
    repaintList();
    status(`${where(t)}에 넣었어요.${target !== null && target !== t ? ` 다음 그림은 ${where(target)}에 들어가요.` : ''}`);
  };

  const onPaste = (e: ClipboardEvent) => {
    if (review) return;
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (!file) return; // words stay words
    if (pasteTarget(document.activeElement, 0) === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (target === null) { status('넣을 카드를 먼저 골라 주세요. 카드의 [복사]나 [붙여넣기]를 누르면 그 카드에 들어가요.', 'error'); return; }
    void readFile(file).then((url) => put(url));
  };

  const openReview = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) { status('이미지 파일을 골라 주세요.', 'error'); return; }
    const { pairs, extra } = assignFiles(imgs, missing());
    const urls = await Promise.all([...pairs.map((p) => p.file), ...extra].map(readFile));
    review = [...pairs.map((p, k) => ({ file: p.file, url: urls[k], index: p.index })), ...extra.map((f, k) => ({ file: f, url: urls[pairs.length + k], index: -1 }))];
    paint();
  };

  const apply = async () => {
    if (!review) return;
    const chosen = review.filter((r) => r.index >= 0);
    const seen = new Set<number>();
    for (const r of chosen) {
      if (seen.has(r.index)) { status(`${where(r.index)}에 그림이 두 장 골라져 있어요. 하나만 남겨 주세요.`, 'error'); return; }
      seen.add(r.index);
    }
    if (app.work().id !== w0.id) { status('다른 작품이 열려 그림을 넣지 않았어요.', 'error'); return; }
    status(`${chosen.length}장을 넣는 중…`, 'busy');
    let ok = 0;
    for (const r of chosen) if (await deps.setPicture(r.index, r.url)) ok++;
    review = null;
    target = missing()[0] ?? null;
    paint();
    status(ok === chosen.length ? `그림 ${ok}장을 카드에 넣었어요.` : `그림 ${ok}장을 넣었고 ${chosen.length - ok}장은 넣지 못했어요.`, ok === chosen.length ? '' : 'error');
  };

  open = true;
  openModal('', {
    size: 'wide',
    top: true,
    onClose: () => { open = false; document.removeEventListener('paste', onPaste, true); },
    wire: (b, close) => {
      box = b;
      document.addEventListener('paste', onPaste, true);
      paint();
      b.addEventListener('change', (e) => {
        const el = e.target as HTMLElement;
        if (el instanceof HTMLInputElement && el.id === 'gxFiles') { void openReview(Array.from(el.files ?? [])); return; }
        if (el instanceof HTMLInputElement && el.id === 'gxRefFile') { const f = el.files?.[0]; if (f) void readFile(f).then((url) => put(url, 'ref')); return; }
        if (el instanceof HTMLSelectElement && el.dataset.k && review) review[Number(el.dataset.k)].index = Number(el.value);
      });
      b.addEventListener('click', async (e) => {
        const el = e.target as HTMLElement;
        const a = el.closest<HTMLElement>('[data-a]')?.dataset.a;
        const copy = el.closest<HTMLElement>('[data-copy]')?.dataset.copy;
        const paste = el.closest<HTMLElement>('[data-paste]')?.dataset.paste;
        if (a === 'close') { close(); return; }
        if (copy !== undefined) {
          const i = Number(copy);
          target = i;
          const ok = await copyText(geminiCardPrompt(app.work(), i));
          repaintList();
          status(ok ? `${where(i)} 지시문을 복사했어요. Gemini에 붙여넣고, 그림이 나오면 「이미지 복사」 후 여기서 Ctrl+V(⌘V).` : '복사가 막혔어요. 브라우저 권한을 확인해 주세요.', ok ? '' : 'error');
          return;
        }
        if (paste !== undefined || a === 'refpaste') {
          const t: Target = a === 'refpaste' ? 'ref' : Number(paste);
          target = t;
          repaintList();
          const url = await clipboardImage();
          if (url) await put(url, t);
          else status(`이제 Ctrl+V(⌘V)를 누르면 ${where(t)}에 들어가요.`);
          return;
        }
        if (a === 'first') {
          const n = missing().length || picCards().length;
          const ok = await copyText(geminiFirstMessage(app.work(), n));
          status(ok ? '첫 메시지를 복사했어요. Gemini 새 대화에 붙여넣으세요.' : '복사가 막혔어요. 브라우저 권한을 확인해 주세요.', ok ? '' : 'error');
          return;
        }
        if (a === 'direct') {
          const btn = el.closest<HTMLButtonElement>('button');
          if (btn) btn.disabled = true;
          status('연출을 정리하는 중…', 'busy');
          const ok = await deps.direct().catch(() => false);
          paint();
          status(ok ? '연출을 정리했어요. 지시문에 새 장면과 인물 생김새가 들어가요.' : '연출 정리를 하지 못했어요. 지금 장면으로 지시문을 만들어요.', ok ? '' : 'error');
          return;
        }
        if (a === 'refsave') {
          const ref = app.work().style.refImage;
          if (ref) download(await (await fetch(ref)).blob(), '인물 기준 그림.' + (/^data:image\/(\w+)/.exec(ref)?.[1] ?? 'png').replace('jpeg', 'jpg'));
          return;
        }
        if (a === 'refupload' || a === 'bulk') {
          const fi = b.querySelector<HTMLInputElement>(a === 'bulk' ? '#gxFiles' : '#gxRefFile')!;
          fi.value = '';
          fi.click();
          return;
        }
        if (a === 'back') { review = null; paint(); return; }
        if (a === 'apply') { await apply(); return; }
      });
    },
  });
  if (!w0.cards.some((c) => c.text.trim())) toast('카드 글을 먼저 채우면 지시문이 장면을 담아요.');
}
