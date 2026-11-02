// The writer's own themes (editor with live preview) and the logo / handle watermark.
import type { App } from '../app';
import { shrinkImage } from '../ai/compose';
import { BRAND_POS_NAME, BRAND_SCOPE_NAME, DEFAULT_BRAND, newId, type Brand, type BrandPos, type Work } from '../model';
import { cardHeight, ensureFonts, renderCard, W } from '../render';
import { contrast, DECO_NAME, FONT_CHOICES, isHex, isLightBg, themeOfWork, type Deco, type SavedTheme } from '../themes';
import { confirmBox, esc, openModal, toast } from './dom';

const CLOSE = '<button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>';

/** Renders card `index` of a draft copy of the work into a small preview canvas, at most every 120 ms. */
function previewer(canvas: HTMLCanvasElement, draft: () => Work, index: () => number) {
  let timer = 0, busy = false, again = false;
  const full = document.createElement('canvas');
  const run = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const w = draft();
      const H = cardHeight(w);
      full.width = W; full.height = H;
      canvas.width = 360; canvas.height = Math.round((360 * H) / W);
      await ensureFonts(w);
      await renderCard(full.getContext('2d')!, w, index());
      canvas.getContext('2d')!.drawImage(full, 0, 0, canvas.width, canvas.height);
    } finally {
      busy = false;
      if (again) { again = false; schedule(); }
    }
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(() => void run(), 120); };
  return schedule;
}

/* ================= themes ================= */
export function openThemeEditor(app: App, editId?: string): void {
  const st = app.settings();
  const work = app.work();
  const existing = editId ? st.customThemes.find((t) => t.id === editId) : undefined;
  const base = existing ?? themeOfWork(work);
  const draft: SavedTheme = {
    id: existing?.id ?? 't' + newId(),
    name: existing ? existing.name : `내 테마 ${st.customThemes.length + 1}`,
    bg: [...base.bg] as [string, string], text: base.text, accent: base.accent, font: base.font, deco: base.deco, light: base.light,
  };
  const fonts = FONT_CHOICES.filter((f) => f.value !== 'auto');
  const color = (id: string, label: string, v: string) => `<div class="field color-field"><label for="${id}">${label}</label><div class="color-line"><input type="color" id="${id}" value="${v}"><input class="input mono" data-for="${id}" value="${v}" maxlength="7" spellcheck="false"></div></div>`;
  openModal(`
    <div class="panel-head"><h2>${existing ? '테마 고치기' : '내 테마 만들기'}</h2>${CLOSE}</div>
    <div class="theme-edit">
      <div class="preview-box"><canvas id="thPreview" aria-label="미리보기"></canvas><p class="hint">지금 고르고 있는 카드로 미리 봐요.</p></div>
      <div class="stack">
        <div class="field"><label for="thName">이름</label><input class="input" id="thName" maxlength="12" value="${esc(draft.name)}"></div>
        <div class="row two">${color('thBg0', '배경 (위)', draft.bg[0])}${color('thBg1', '배경 (아래)', draft.bg[1])}</div>
        <div class="row two">${color('thText', '글자', draft.text)}${color('thAccent', '강조색', draft.accent)}</div>
        <div class="row two">
          <div class="field"><label for="thFont">서체</label><select class="input" id="thFont">${fonts.map((f) => `<option value="${esc(f.value)}" ${f.value === draft.font ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="thDeco">장식</label><select class="input" id="thDeco">${(Object.keys(DECO_NAME) as Deco[]).map((d) => `<option value="${d}" ${d === draft.deco ? 'selected' : ''}>${DECO_NAME[d]}</option>`).join('')}</select></div>
        </div>
        <p class="hint" id="thContrast"></p>
      </div>
    </div>
    <div class="toolbar" style="margin-top:16px">
      ${existing ? '<button class="btn" type="button" data-a="del">테마 지우기</button><span class="spacer"></span>' : ''}
      <button class="btn" type="button" data-a="cancel">취소</button>
      <button class="btn primary" type="button" data-a="save">저장하고 쓰기</button>
    </div>`,
  {
    size: 'wide',
    wire: (box, close) => {
      const q = <T extends HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
      const canvas = q<HTMLCanvasElement>('#thPreview');
      const draw = previewer(canvas, () => ({ ...work, theme: 'custom', customTheme: { ...draft } }), () => app.current());
      const note = () => {
        const c = Math.min(contrast(draft.text, draft.bg[0]), contrast(draft.text, draft.bg[1]));
        const el = q<HTMLElement>('#thContrast');
        el.textContent = c < 4.5 ? `글자와 배경의 대비가 ${c.toFixed(1)}:1로 낮아요. 폰에서 읽기 어려울 수 있어요(4.5:1 이상 권장).` : `글자와 배경의 대비 ${c.toFixed(1)}:1 · 읽기 좋아요.`;
        el.classList.toggle('bad', c < 4.5);
      };
      const sync = () => {
        draft.name = q<HTMLInputElement>('#thName').value.trim() || '내 테마';
        draft.bg = [q<HTMLInputElement>('#thBg0').value, q<HTMLInputElement>('#thBg1').value];
        draft.text = q<HTMLInputElement>('#thText').value;
        draft.accent = q<HTMLInputElement>('#thAccent').value;
        draft.font = q<HTMLSelectElement>('#thFont').value;
        draft.deco = q<HTMLSelectElement>('#thDeco').value as Deco;
        draft.light = isLightBg(draft.bg);
        note(); draw();
      };
      box.querySelectorAll<HTMLInputElement>('input[type="color"]').forEach((c) => c.addEventListener('input', () => { q<HTMLInputElement>(`[data-for="${c.id}"]`).value = c.value; sync(); }));
      box.querySelectorAll<HTMLInputElement>('input[data-for]').forEach((t) => t.addEventListener('input', () => {
        const v = t.value.trim().startsWith('#') ? t.value.trim() : '#' + t.value.trim();
        if (isHex(v)) { q<HTMLInputElement>('#' + t.dataset.for).value = v.toLowerCase(); sync(); }
      }));
      q('#thName').addEventListener('input', sync);
      q('#thFont').addEventListener('change', sync);
      q('#thDeco').addEventListener('change', sync);
      q('[data-a="close"]').addEventListener('click', close);
      q('[data-a="cancel"]').addEventListener('click', close);
      box.querySelector('[data-a="del"]')?.addEventListener('click', async () => {
        close();
        if (!(await confirmBox(`「${draft.name}」 테마를 지울까요? 이미 이 테마를 쓴 작품은 그대로 보여요.`, { ok: '지우기' }))) return;
        st.customThemes = st.customThemes.filter((t) => t.id !== draft.id);
        await app.saveSettings();
        app.renderLook();
      });
      q('[data-a="save"]').addEventListener('click', async () => {
        sync();
        const saved = { ...draft, bg: [...draft.bg] as [string, string] };
        const i = st.customThemes.findIndex((t) => t.id === saved.id);
        if (i >= 0) st.customThemes[i] = saved; else st.customThemes.push(saved);
        await app.saveSettings();
        const w = app.work();
        w.theme = 'custom';
        w.customTheme = { ...saved };
        w.font = 'auto';
        app.save(); app.renderLook(); app.scheduleRender();
        close();
        toast(`「${saved.name}」 테마를 저장하고 이 작품에 썼어요.`);
      });
      sync();
    },
  });
}

/* ================= watermark ================= */
export function brandHint(w: Work): string {
  const b = w.brand;
  if (!b) return '';
  return `${b.kind === 'logo' ? '로고' : '핸들'} · ${BRAND_POS_NAME[b.pos]} · ${BRAND_SCOPE_NAME[b.scope]}`;
}

export function setBrandOn(app: App, on: boolean): void {
  const w = app.work();
  const st = app.settings();
  if (!on) { delete w.brand; app.save(); app.renderLook(); app.scheduleRender(); return; }
  if (st.brand.kind === 'logo' && !st.brand.logo) { openBrandEditor(app); return; }
  w.brand = { ...st.brand };
  app.save(); app.renderLook(); app.scheduleRender();
}

export function openBrandEditor(app: App): void {
  const st = app.settings();
  const work = app.work();
  const draft: Brand = { ...DEFAULT_BRAND, ...st.brand, ...(work.brand ?? {}) };
  openModal(`
    <div class="panel-head"><h2>로고 워터마크</h2>${CLOSE}</div>
    <div class="theme-edit">
      <div class="preview-box"><canvas id="brPreview" aria-label="미리보기"></canvas><p class="hint">퍼가기를 막고 내 계정을 알리는 작은 표시예요.</p></div>
      <div class="stack">
        <div class="field"><label>무엇을 넣을까요</label>
          <div class="seg" id="brKind"><button type="button" data-v="handle">작가 핸들 글자</button><button type="button" data-v="logo">로고 그림</button></div></div>
        <div class="logo-line" id="brLogoLine">
          <div class="logo-pic" id="brLogoPic"></div>
          <div class="toolbar"><button class="btn small" type="button" data-a="upload">로고 올리기</button><button class="btn small" type="button" data-a="clearLogo">지움</button></div>
          <p class="hint">배경이 투명한 PNG가 가장 잘 어울려요.</p>
        </div>
        <div class="row two">
          <div class="field"><label for="brPos">위치</label><select class="input" id="brPos">${(Object.keys(BRAND_POS_NAME) as BrandPos[]).map((k) => `<option value="${k}" ${k === draft.pos ? 'selected' : ''}>${BRAND_POS_NAME[k]}</option>`).join('')}</select></div>
          <div class="field"><label for="brScope">넣을 카드</label><select class="input" id="brScope">${(Object.keys(BRAND_SCOPE_NAME) as Brand['scope'][]).map((k) => `<option value="${k}" ${k === draft.scope ? 'selected' : ''}>${BRAND_SCOPE_NAME[k]}</option>`).join('')}</select></div>
        </div>
        <div class="row two">
          <div class="field"><label for="brSize">크기 <span id="brSizeV"></span></label><input type="range" id="brSize" min="6" max="24" step="1" value="${draft.size}"></div>
          <div class="field"><label for="brOpacity">진하기 <span id="brOpacityV"></span></label><input type="range" id="brOpacity" min="0.3" max="1" step="0.05" value="${draft.opacity}"></div>
        </div>
      </div>
    </div>
    <input type="file" id="brFile" accept="image/png,image/webp,image/svg+xml,image/jpeg" hidden>
    <div class="toolbar" style="margin-top:16px">
      <button class="btn" type="button" data-a="off">이 작품에서 빼기</button><span class="spacer"></span>
      <button class="btn" type="button" data-a="cancel">취소</button>
      <button class="btn primary" type="button" data-a="save">저장하고 넣기</button>
    </div>`,
  {
    size: 'wide',
    wire: (box, close) => {
      const q = <T extends HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
      const draw = previewer(q<HTMLCanvasElement>('#brPreview'), () => ({ ...work, brand: { ...draft } }), () => app.current());
      const sync = () => {
        draft.pos = q<HTMLSelectElement>('#brPos').value as BrandPos;
        draft.scope = q<HTMLSelectElement>('#brScope').value as Brand['scope'];
        draft.size = Number(q<HTMLInputElement>('#brSize').value);
        draft.opacity = Number(q<HTMLInputElement>('#brOpacity').value);
        q('#brSizeV').textContent = `${draft.size}%`;
        q('#brOpacityV').textContent = `${Math.round(draft.opacity * 100)}%`;
        box.querySelectorAll<HTMLButtonElement>('#brKind button').forEach((b) => b.classList.toggle('active', b.dataset.v === draft.kind));
        q('#brLogoLine').hidden = draft.kind !== 'logo';
        q('#brLogoPic').innerHTML = draft.logo ? `<img alt="로고" src="${draft.logo}">` : '<span>로고 없음</span>';
        draw();
      };
      box.querySelectorAll<HTMLButtonElement>('#brKind button').forEach((b) => b.addEventListener('click', () => { draft.kind = b.dataset.v as Brand['kind']; sync(); }));
      ['#brPos', '#brScope'].forEach((id) => q(id).addEventListener('change', sync));
      ['#brSize', '#brOpacity'].forEach((id) => q(id).addEventListener('input', sync));
      q('[data-a="upload"]').addEventListener('click', () => { const f = q<HTMLInputElement>('#brFile'); f.value = ''; f.click(); });
      q('#brFile').addEventListener('change', async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file || !file.type.startsWith('image/')) return;
        const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
        // keep transparency: PNG/WebP stay WebP; at most 600 px wide is plenty for a corner mark
        draft.logo = file.type === 'image/svg+xml' ? url : await shrinkImage(url, 600);
        draft.kind = 'logo';
        sync();
      });
      q('[data-a="clearLogo"]').addEventListener('click', () => { delete draft.logo; sync(); });
      q('[data-a="close"]').addEventListener('click', close);
      q('[data-a="cancel"]').addEventListener('click', close);
      q('[data-a="off"]').addEventListener('click', () => { close(); setBrandOn(app, false); });
      q('[data-a="save"]').addEventListener('click', async () => {
        if (draft.kind === 'logo' && !draft.logo) { toast('로고 그림을 올리거나 「작가 핸들 글자」를 고르세요.'); return; }
        if (draft.kind === 'handle' && !app.work().handle) { toast('작가 핸들이 비어 있어요. 오른쪽 칸에서 넣어 주세요.'); }
        st.brand = { ...draft };
        await app.saveSettings();
        app.work().brand = { ...draft };
        app.save(); app.renderLook(); app.scheduleRender();
        close();
        toast('워터마크를 넣었어요. 새 작품에도 이 설정을 쓸 수 있어요.');
      });
      sync();
    },
  });
}
