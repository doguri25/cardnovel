import './styles.css';
import { aiMessage, AiError, listModels, onUsage, pickDefault, type ModelInfo, type ModelLists } from './ai/providers';
import { compose, drawCard, drawCharacterSheet, rewriteCard, summarize, writeOutro, dataUrlParts, shrinkImage, type CardRefs, type ImageAI, type SeriesContext, type TextAI } from './ai/compose';
import { asPrev, groupBySeries, nextEpisodeNumber, nextEpisodeWork, previousEpisodes, seriesName } from './series';
import { adoptBible, bibleText, loadBible } from './bible';
import {
  BODY_COUNT, LAYOUT_NAME, OUTRO_KINDS, TEXT_POS_NAME, TEXT_SCALES, STYLE_PRESETS, TOTAL_CARDS, countChars, newWork, normalizeWork, presetStyle, seriesLine, workTitle,
  type Card, type CardLayout, type ImageProvider, type TextPos, type InputMode, type OutroKind, type TextProvider, type Work, type WorkDefaults,
} from './model';
import { detectMode, SAMPLE_SPLIT, splitManuscript } from './parse';
import { artHeight, cardHeight, ensureFonts, layoutOf, renderCard, srcOf, W } from './render';
import { DEFAULT_SETTINGS, keyFor, loadSettings, maskKey, saveSettings, type Settings } from './settings';
import { kv, works } from './store';
import { FONT_CHOICES, THEMES, ratioOf, type RatioKey, type ThemeKey } from './themes';
import { captionText, cardFileName, download, fileBase, renderAll as renderAllFiles, renderToBlob, shareCards, zipAll, type ImgFormat } from './export';
import { $, confirmBox, esc, fmtDate, fmtTime, openModal, promptBox, setStatus, toast } from './ui/dom';
import type { App } from './app';
import { renderReview, wireReview } from './ui/review';
import { openInstaPreview } from './ui/insta';
import { openCoverCandidates } from './ui/cover';
import { openBible } from './ui/bible';
import { pullFinished, renderFinishBox, wireFinishBox, type FinishDeps } from './ui/finish';
import { brandHint, openBrandEditor, openThemeEditor, setBrandOn } from './ui/look';
import { monthTotal, onUsageEvent, openUsage, renderUsagePill } from './ui/usage';
import { money } from './usage';
import { makeShareLink, openShareList, type ShareDeps } from './ui/share';
import { shareStatus } from './share';
import { afterLocalSave, renderDriveBox, type DriveDeps } from './ui/drive';
import { CANVA_MESSAGES, CanvaError, canvaLogin, canvaLogout, canvaMessage, canvaState, canvaStatus, createDesign, exportDesign, parseCanvaState, pictureForCanva, readLanding } from './canva';

/** Google OAuth client ID baked into the build (Vercel env VITE_GOOGLE_CLIENT_ID); the settings field overrides it. */
const DEFAULT_GOOGLE_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '';

/* ================= state ================= */
let settings: Settings = DEFAULT_SETTINGS;
let work: Work;
let current = 0;
const modelLists: Partial<Record<TextProvider, ModelLists>> = {};
const artBusy = new Set<string>();
let composeCtl: AbortController | null = null;
let artCtl: AbortController | null = null;
let uploadTarget: number | null = null;

const PROVIDER_NAME: Record<TextProvider, string> = { anthropic: 'Claude', google: 'Gemini', openai: 'GPT' };
const IMG_NAME: Record<ImageProvider, string> = { gemini: 'Gemini', openai: 'GPT', claude: 'Claude SVG', canva: 'Canva', upload: '올림' };
const KIND_NAME: Record<Card['kind'], string> = { cover: '표지', body: '본문', outro: '마지막' };

const defaults = (): WorkDefaults => ({
  series: settings.series, handle: settings.handle, follow: settings.follow,
  textAI: { ...settings.textAI }, imageAI: { ...settings.imageAI },
});

/* ================= what feature modules may use ================= */
const app: App = {
  work: () => work,
  openWork: (w) => openWork(w),
  save: () => save(),
  flush: async () => { clearTimeout(persistTimer); dirty = true; await persist(true); },
  pushUndo: () => pushUndo(),
  refreshRow: (i) => refreshRow(i),
  select: (i) => select(i),
  scheduleRender: () => scheduleRender(),
  textAI: () => textAI(),
  imageAI: () => imageAI(),
  openSettings: () => openSettings(),
  online: () => online(),
  current: () => current,
  settings: () => settings,
  saveSettings: () => saveSettings(settings),
  renderLook: () => renderLook(),
};
const shareDeps: ShareDeps = { key: () => settings.shareKey };
const finishDeps: FinishDeps = { login: () => goCanvaLogin(), refreshAll: () => { buildCardList(); scheduleRender(); } };
const driveDeps: DriveDeps = { clientId: () => settings.googleClientId || DEFAULT_GOOGLE_CLIENT_ID, defaults: () => defaults(), reopenLibrary: () => void openLibrary() };
let reviewTimer = 0;
const scheduleReview = () => { clearTimeout(reviewTimer); reviewTimer = window.setTimeout(() => renderReview(app), 700); };

/* ================= undo (text and order, last 20 steps) ================= */
interface Snap { order: string[]; fields: Record<string, Pick<Card, 'label' | 'showLabel' | 'title' | 'text' | 'scene' | 'accent'>>; outroKind: OutroKind }
const undoStack: Snap[] = [];
function snapshot(): Snap {
  const fields: Snap['fields'] = {};
  work.cards.forEach((c) => { fields[c.id] = { label: c.label, showLabel: c.showLabel, title: c.title, text: c.text, scene: c.scene, accent: c.accent }; });
  return { order: work.cards.map((c) => c.id), fields, outroKind: work.outroKind };
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 20) undoStack.shift();
  $<HTMLButtonElement>('btnUndo').disabled = false;
}
let typingBurst = 0;
function pushUndoTyping() {
  // one undo step per burst of typing
  if (!typingBurst) pushUndo();
  clearTimeout(typingBurst);
  typingBurst = window.setTimeout(() => { typingBurst = 0; }, 1500);
}
function undo() {
  const s = undoStack.pop();
  $<HTMLButtonElement>('btnUndo').disabled = !undoStack.length;
  if (!s) return;
  const byId = new Map(work.cards.map((c) => [c.id, c]));
  work.cards = s.order.map((id) => byId.get(id)).filter((c): c is Card => !!c);
  work.cards.forEach((c) => Object.assign(c, s.fields[c.id]));
  work.outroKind = s.outroKind;
  save(); renderAllUI();
  toast('되돌렸어요.');
}

/* ================= saving ================= */
let persistTimer = 0, dirty = false;
function save() {
  work.updatedAt = Date.now();
  dirty = true;
  $('savedAt').textContent = '저장 중…';
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => void persist(true), 800);
}
async function persist(withThumb: boolean) {
  if (!dirty) return;
  dirty = false;
  try {
    if (withThumb) { try { work.thumb = await makeThumb(); } catch { /* keep the old one */ } }
    await works.put(work);
    await kv.set('currentId', work.id);
    $('savedAt').textContent = `자동 저장됨 · ${fmtTime(Date.now())}`;
    afterLocalSave(app);
  } catch {
    dirty = true;
    $('savedAt').textContent = '자동 저장 실패 — 보관함 「내보내기」로 백업해 두세요';
  }
}
async function makeThumb(): Promise<string> {
  const c = document.createElement('canvas');
  c.width = W; c.height = cardHeight(work);
  await renderCard(c.getContext('2d')!, work, 0);
  const t = document.createElement('canvas');
  t.width = t.height = 180;
  t.getContext('2d')!.drawImage(c, 0, 0, W, W, 0, 0, 180, 180);
  return t.toDataURL('image/jpeg', 0.72);
}
window.addEventListener('beforeunload', () => { if (dirty) { clearTimeout(persistTimer); void persist(false); } });
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) { clearTimeout(persistTimer); void persist(false); } });

/* ================= AI choices ================= */
function textAI(): TextAI | null {
  const p = work.textAI.provider;
  const key = keyFor(settings, p);
  if (!key) return null;
  return { provider: p, key, model: work.textAI.model || settings.models[p] };
}
function imageAI(): ImageAI | null {
  const p = work.imageAI.provider;
  if (p === 'canva' || p === 'upload') return null;
  const key = keyFor(settings, p);
  if (!key) return null;
  const model = work.imageAI.model || (p === 'gemini' ? settings.models.geminiImage : p === 'openai' ? settings.models.openaiImage : settings.models.anthropic);
  return { provider: p, key, model, quick: settings.claudeArtTier !== 'detailed' };
}
const online = () => navigator.onLine !== false;

async function loadModels(p: TextProvider, force = false): Promise<ModelLists | null> {
  const key = keyFor(settings, p);
  if (!key) return null;
  if (modelLists[p] && !force) return modelLists[p]!;
  const cached = await kv.get<ModelLists | null>('models.' + p, null);
  if (cached && !force) modelLists[p] = cached;
  if (online()) {
    try {
      const fresh = await listModels(p, key);
      modelLists[p] = fresh;
      await kv.set('models.' + p, fresh);
    } catch (e) {
      if (e instanceof AiError && e.code === 'invalid_key') toast(`${PROVIDER_NAME[p]} ${aiMessage(e)}`);
    }
  }
  return modelLists[p] ?? null;
}

function fillSelect(sel: HTMLSelectElement, list: ModelInfo[], value: string, empty: string) {
  sel.innerHTML = list.length
    ? list.map((m) => `<option value="${esc(m.id)}" ${m.id === value ? 'selected' : ''}>${esc(m.label)}</option>`).join('')
    : `<option value="">${esc(empty)}</option>`;
  if (value && list.length && !list.some((m) => m.id === value)) {
    sel.insertAdjacentHTML('afterbegin', `<option value="${esc(value)}" selected>${esc(value)}</option>`);
  }
}

async function renderTextAI() {
  const p = work.textAI.provider;
  $<HTMLSelectElement>('textProvider').value = p;
  const sel = $<HTMLSelectElement>('textModel');
  const key = keyFor(settings, p);
  if (!key) { fillSelect(sel, [], '', `${PROVIDER_NAME[p]} 키 필요 — 설정에서 넣기`); return; }
  const lists = await loadModels(p);
  const list = lists?.text ?? [];
  if (!work.textAI.model) work.textAI.model = settings.models[p] || pickDefault(p, list);
  fillSelect(sel, list, work.textAI.model, '모델 목록을 불러오지 못했어요');
}

async function renderImageAI() {
  const p = work.imageAI.provider;
  $<HTMLSelectElement>('imageProvider').value = p;
  const sel = $<HTMLSelectElement>('imageModel');
  sel.hidden = p === 'canva' || p === 'upload';
  $<HTMLButtonElement>('btnArtAll').disabled = p === 'canva' || p === 'upload' || !online();
  if (p === 'canva') { void renderCanvaStatus(); return; }
  if (sel.hidden) { setStatus($('artStatus'), '카드마다 「올리기」로 그림을 넣으세요.'); return; }
  const textP: TextProvider = p === 'gemini' ? 'google' : p === 'openai' ? 'openai' : 'anthropic';
  if (!keyFor(settings, textP)) { fillSelect(sel, [], '', `${PROVIDER_NAME[textP]} 키 필요`); setStatus($('artStatus'), `${IMG_NAME[p]}로 그리려면 설정에서 ${PROVIDER_NAME[textP]} 키를 넣어 주세요.`); return; }
  const lists = await loadModels(textP);
  const list = p === 'claude' ? lists?.text ?? [] : lists?.image ?? [];
  const remembered = p === 'gemini' ? settings.models.geminiImage : p === 'openai' ? settings.models.openaiImage : settings.models.anthropic;
  if (!work.imageAI.model) work.imageAI.model = remembered || pickDefault(p === 'gemini' ? 'geminiImage' : p === 'openai' ? 'openaiImage' : 'anthropic', list);
  fillSelect(sel, list, work.imageAI.model, '그림 모델이 없어요');
  setStatus($('artStatus'), p === 'claude' ? `Claude가 SVG로 그려요 (${settings.claudeArtTier === 'detailed' ? '정밀, 장당 30초 안팎' : '빠름, 장당 몇 초'}).` : '표지를 먼저 그리고, 그 그림체에 맞춰 나머지를 그려요.');
}

/* ================= story panel ================= */
function renderStoryPanel() {
  $<HTMLTextAreaElement>('story').value = work.source.text || '';
  setMode(work.source.mode || 'auto', false);
  const sel = $<HTMLSelectElement>('outroKind');
  sel.innerHTML = (Object.keys(OUTRO_KINDS) as OutroKind[]).map((k) => `<option value="${k}" ${k === work.outroKind ? 'selected' : ''}>${OUTRO_KINDS[k].name}</option>`).join('');
  $('outroFixedHint').textContent = [work.series, work.follow, work.handle].filter(Boolean).join(' · ') || '오른쪽 칸에서 넣어요';
}
function setMode(m: InputMode, persist = true) {
  work.source.mode = m;
  document.querySelectorAll<HTMLButtonElement>('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === m));
  updateModeHint();
  if (persist) save();
}
function updateModeHint() {
  const text = $<HTMLTextAreaElement>('story').value;
  const m = work.source.mode;
  const eff = m === 'auto' ? detectMode(text) : m;
  const name = { long: '긴 원고 → 18장으로 압축·각색', idea: '줄거리 → 18장으로 살 붙이기', split: '나눈 원고 → 머리글대로 앉히기' }[eff];
  const n = countChars(text);
  $('modeHint').innerHTML = text.trim() ? `${m === 'auto' ? '자동 판단: ' : ''}<b>${name}</b> · ${n.toLocaleString()}자` : '';
}

/* ================= style ================= */
function renderStyle() {
  const s = work.style;
  $('styleName').innerHTML = `그림체 · ${esc(s.name)}${s.preset === 'ai' ? '<span class="badge-ai">AI 제안</span>' : ''}`;
  $('styleDesc').textContent = s.description || '';
  const sel = $<HTMLSelectElement>('stylePreset');
  sel.innerHTML = `<option value="">그림체 바꾸기…</option>` + STYLE_PRESETS.map((p) => `<option value="${p.preset}">${esc(p.name)}</option>`).join('');
  $<HTMLTextAreaElement>('stylePrompt').value = s.prompt;
  $<HTMLTextAreaElement>('styleChars').value = s.characters;
  renderRefBox();
}

function renderRefBox() {
  const ref = work.style.refImage;
  const p = work.imageAI.provider;
  const busy = artBusy.has('ref');
  $('refPic').className = 'refpic' + (ref ? '' : ' empty') + (busy ? ' busy' : '');
  $('refPic').innerHTML = ref ? `<img alt="인물 기준 그림" src="${ref}">` : '없음';
  $<HTMLButtonElement>('btnRefAI').disabled = busy || !online();
  $<HTMLButtonElement>('btnRefAI').textContent = ref ? 'AI로 다시' : 'AI로 만들기';
  $<HTMLButtonElement>('btnRefCover').disabled = !work.cards[0].img;
  $<HTMLButtonElement>('btnRefClear').hidden = !ref;
  $('refNote').textContent = p === 'gemini' || p === 'openai'
    ? (ref ? '모든 그림에 함께 보내 얼굴·머리·옷차림을 맞춰요.' : '인물 생김새를 고정하려면 기준 그림을 넣으세요. 모든 그림 요청에 함께 보내요.')
    : `${IMG_NAME[p]}에는 기준 그림을 보내지 않아요. Gemini·GPT 이미지에서 쓰여요.`;
}

async function makeRefSheet() {
  const ai = imageAI();
  if (!ai || ai.provider === 'claude') {
    toast(ai ? '인물 기준 그림은 Gemini 이미지나 GPT 이미지로 만들어요. 그림 AI를 바꿔 주세요.' : `${IMG_NAME[work.imageAI.provider]} 키를 먼저 넣어 주세요.`);
    if (!ai && work.imageAI.provider !== 'canva' && work.imageAI.provider !== 'upload') openSettings();
    return;
  }
  if (work.style.refImage && !(await confirmBox('지금 기준 그림을 새로 바꿀까요? 이미 그린 카드는 그대로예요.', { ok: '다시 만들기' }))) return;
  artBusy.add('ref'); renderRefBox();
  setStatus($('artStatus'), '인물 기준 그림을 그리는 중…', 'busy');
  try {
    work.style.refImage = await drawCharacterSheet(work, ai);
    save();
    setStatus($('artStatus'), '인물 기준 그림을 넣었어요. 이제부터 그리는 카드는 이 생김새를 따라요.');
  } catch (e) {
    setStatus($('artStatus'), aiMessage(e), 'error');
  } finally {
    artBusy.delete('ref'); renderRefBox();
  }
}

/* ================= cards ================= */
const icons = {
  up: '<svg viewBox="0 0 24 24"><path d="M7.4 15.4 6 14l6-6 6 6-1.4 1.4L12 10.8z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M16.6 8.6 18 10l-6 6-6-6 1.4-1.4 4.6 4.6z"/></svg>',
};

function cardRowHTML(card: Card, i: number): string {
  const src = srcOf(card);
  const isBody = card.kind === 'body', isCover = card.kind === 'cover', isOutro = card.kind === 'outro';
  const p = work.imageAI.provider;
  const canAI = p !== 'upload' && p !== 'canva';
  const busy = artBusy.has(card.id);
  const pos = card.imgPos || 'center';
  const layout = layoutOf(card);
  const layouts: CardLayout[] = isBody ? ['stack', 'full', 'quote'] : isCover ? ['stack', 'full'] : [];
  return `
    <div class="num">
      ${isBody ? `<button type="button" data-act="up" aria-label="위로" ${i === 1 ? 'disabled' : ''}>${icons.up}</button>` : ''}
      <span>${String(i + 1).padStart(2, '0')}</span>
      ${isBody ? `<button type="button" data-act="down" aria-label="아래로" ${i === BODY_COUNT ? 'disabled' : ''}>${icons.down}</button>` : ''}
    </div>
    <div class="art">
      <div class="pic ${src ? '' : 'empty'} ${busy ? 'busy' : ''}">${src ? `<img alt="" src="${src}">` : isOutro ? '그림 없어도 됨' : '그림 없음'}${src && card.imgSource ? `<span class="src">${esc(IMG_NAME[card.imgSource])}</span>` : ''}</div>
      <div class="picbtns">
        ${canAI ? `<button class="btn tiny tonal" type="button" data-act="ai" ${busy || !online() ? 'disabled' : ''}>${src ? '다시' : 'AI 그림'}</button>` : ''}
        ${canAI && isCover ? `<button class="btn tiny" type="button" data-act="coverCands" ${busy || !online() ? 'disabled' : ''}>후보 3장</button>` : ''}
        ${p === 'canva' ? `<button class="btn tiny tonal" type="button" data-act="canva" ${busy || !online() ? 'disabled' : ''}>${src ? 'Canva에서 고치기' : 'Canva에서 그리기'}</button>` : ''}
        ${p === 'canva' && card.canvaDesignId ? `<button class="btn tiny" type="button" data-act="canvaImport" ${busy || !online() ? 'disabled' : ''}>Canva에서 가져오기</button>` : ''}
        <button class="btn tiny" type="button" data-act="upload">올리기</button>
        ${src ? '<button class="btn tiny" type="button" data-act="clear">지움</button>' : ''}
        ${layouts.length ? `<select class="input pos" data-f="layout" aria-label="카드 배치">${layouts.map((l) => `<option value="${l}" ${l === layout ? 'selected' : ''}>배치 · ${LAYOUT_NAME[l]}</option>`).join('')}</select>` : ''}
        <select class="input pos" data-f="textScale" aria-label="글자 크기">${TEXT_SCALES.map((t) => `<option value="${t.value}" ${t.value === (card.textScale || 1) ? 'selected' : ''}>글자 · ${t.name}</option>`).join('')}</select>
        ${!isOutro ? `<select class="input pos" data-f="textPos" aria-label="글 위치">${(Object.keys(TEXT_POS_NAME) as TextPos[]).map((k) => `<option value="${k}" ${k === (card.textPos || 'auto') ? 'selected' : ''}>글 위치 · ${TEXT_POS_NAME[k]}</option>`).join('')}</select>` : ''}
        ${src ? `<select class="input pos" data-f="imgPos" aria-label="자르기 위치"><option value="top" ${pos === 'top' ? 'selected' : ''}>자르기 · 위</option><option value="center" ${pos === 'center' ? 'selected' : ''}>자르기 · 가운데</option><option value="bottom" ${pos === 'bottom' ? 'selected' : ''}>자르기 · 아래</option></select>` : ''}
      </div>
    </div>
    <div class="body">
      <div class="top">
        ${isCover ? `<input class="input" data-f="title" placeholder="이야기 제목" value="${esc(card.title)}">` : ''}
        ${isBody ? `<input class="input" data-f="label" placeholder="머리말 (예: 전환 · 비워도 됨)" value="${esc(card.label)}">` : ''}
        ${isOutro ? `<select class="input" data-f="outroKind" aria-label="덧붙임 종류">${(Object.keys(OUTRO_KINDS) as OutroKind[]).map((k) => `<option value="${k}" ${k === work.outroKind ? 'selected' : ''}>${OUTRO_KINDS[k].name}</option>`).join('')}</select>` : ''}
        <label class="chk" title="${isBody ? '카드 위에 머리말을 보여 줍니다' : '카드 위에 시리즈 이름을 보여 줍니다'}"><input type="checkbox" data-f="showLabel" ${card.showLabel ? 'checked' : ''}> ${isBody ? '머리말' : '시리즈'}</label>
        ${isBody ? `<label class="chk" title="제목과 막대를 강조색으로"><input type="checkbox" data-f="accent" ${card.accent ? 'checked' : ''}> 강조</label>` : '<span></span>'}
        <button class="btn small" type="button" data-act="rewrite" ${!online() || (isOutro && work.outroKind === 'none') ? 'disabled' : ''}>${isCover ? '훅 다시' : '다시 쓰기'}</button>
      </div>
      ${isBody ? `<input class="input" data-f="title" placeholder="${layout === 'quote' ? '말한 사람 (선택, 예: 지수)' : '소제목 (선택)'}" value="${esc(card.title)}">` : ''}
      ${isOutro && work.outroKind === 'none' ? '' : `<textarea class="input" data-f="text" placeholder="${isCover ? '표지에 들어갈 한 줄 훅' : isOutro ? '덧붙임 한 줄' : '카드 본문 · *별표*로 감싼 말은 강조색'}">${esc(card.text)}</textarea>`}
      ${isOutro ? `<div class="fixed">고정: ${esc([work.follow, work.handle].filter(Boolean).join(' · ') || '오른쪽 칸에서 팔로우 문구와 핸들을 넣으세요')}</div>` : ''}
      <div class="meta"><span class="kind">${KIND_NAME[card.kind]}${isCover ? ' · 훅은 25자 안팎' : ''}${isOutro ? ' · 60자 이내' : ''}</span><span class="count"></span></div>
    </div>`;
}

function updateCount(row: HTMLElement, card: Card) {
  const el = row.querySelector('.count');
  if (!el) return;
  const n = countChars(card.text);
  const [lo, hi] = card.kind === 'cover' ? [0, 30] : card.kind === 'outro' ? [0, 60] : [40, 90];
  const bad = n > hi || (card.kind === 'body' && n > 0 && n < lo);
  el.textContent = `${n}자` + (n > hi ? ' · 조금 길어요' : bad ? ' · 조금 짧아요' : '');
  el.classList.toggle('over', bad);
}

const thumbCanvases: HTMLCanvasElement[] = [];

function buildCardList() {
  const list = $('cardList');
  list.innerHTML = '';
  const thumbs = $('thumbs');
  thumbs.innerHTML = '';
  thumbCanvases.length = 0;
  const H = cardHeight(work);
  work.cards.forEach((card, i) => {
    const row = document.createElement('div');
    row.className = `card-row ${card.kind}` + (i === current ? ' active' : '');
    row.dataset.i = String(i);
    row.innerHTML = cardRowHTML(card, i);
    list.appendChild(row);
    updateCount(row, card);

    const tb = document.createElement('button');
    tb.type = 'button';
    tb.setAttribute('aria-label', `${i + 1}번 카드`);
    const tc = document.createElement('canvas');
    tc.width = 112; tc.height = Math.round((112 * H) / W);
    tb.appendChild(tc);
    thumbs.appendChild(tb);
    thumbCanvases.push(tc);
    tb.addEventListener('click', () => select(i));
  });
}

function refreshRow(i: number) {
  const row = $('cardList').querySelector<HTMLElement>(`.card-row[data-i="${i}"]`);
  if (!row) return;
  row.innerHTML = cardRowHTML(work.cards[i], i);
  updateCount(row, work.cards[i]);
  if (i === 0) renderRefBox(); // 「표지 그림 쓰기」 depends on the cover picture
}

function select(i: number) {
  if (i === current) return;
  current = Math.max(0, Math.min(TOTAL_CARDS - 1, i));
  document.querySelectorAll('.card-row').forEach((r, k) => r.classList.toggle('active', k === current));
  scheduleRender();
}

function wireCardList() {
  const list = $('cardList');
  const rowOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.card-row');
  list.addEventListener('focusin', (e) => { const r = rowOf(e); if (r) select(Number(r.dataset.i)); });
  list.addEventListener('click', (e) => {
    const r = rowOf(e); if (!r) return;
    const i = Number(r.dataset.i);
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!b) { select(i); return; }
    void onCardAction(b.dataset.act!, i);
  });
  list.addEventListener('input', (e) => {
    const r = rowOf(e); if (!r) return;
    const i = Number(r.dataset.i);
    const el = e.target as HTMLInputElement;
    const f = el.dataset.f; if (!f) return;
    const card = work.cards[i];
    if (f === 'outroKind') { void changeOutroKind(el.value as OutroKind); return; }
    if (f === 'imgPos') { card.imgPos = el.value as Card['imgPos']; save(); scheduleRender(); return; }
    if (f === 'textScale') { const v = Number(el.value); if (v === 1) delete card.textScale; else card.textScale = v; save(); scheduleRender(); return; }
    if (f === 'textPos') { if (el.value === 'auto') delete card.textPos; else card.textPos = el.value as TextPos; save(); scheduleRender(); return; }
    if (f === 'layout') {
      const before = layoutOf(card);
      card.layout = el.value as CardLayout;
      save(); refreshRow(i); scheduleRender();
      // the picture area changes shape between the top band and the whole card
      if (srcOf(card) && (before === 'stack') !== (layoutOf(card) === 'stack')) toast('배치가 바뀌어 그림 비율이 달라졌어요. 「자르기」로 맞추거나 다시 그려 보세요.', 4200);
      return;
    }
    pushUndoTyping();
    if (f === 'showLabel' || f === 'accent') (card as unknown as Record<string, boolean>)[f] = el.checked;
    else (card as unknown as Record<string, string>)[f] = el.value;
    updateCount(r, card);
    save(); scheduleRender(); scheduleReview();
  });
}

async function onCardAction(act: string, i: number) {
  const card = work.cards[i];
  select(i);
  if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 1 || j > BODY_COUNT) return;
    pushUndo();
    [work.cards[i], work.cards[j]] = [work.cards[j], work.cards[i]];
    current = j;
    save(); buildCardList(); scheduleRender();
    $('cardList').querySelector<HTMLElement>(`.card-row[data-i="${j}"] button[data-act="${act}"]`)?.focus();
  } else if (act === 'clear') {
    delete card.img; delete card.svg; delete card.imgSource;
    save(); refreshRow(i); scheduleRender();
  } else if (act === 'upload') {
    uploadTarget = i;
    const fi = $<HTMLInputElement>('fileInput');
    fi.value = '';
    fi.click();
  } else if (act === 'canva') {
    await openInCanva(i);
  } else if (act === 'canvaImport') {
    if (card.canvaDesignId) await importFromCanva(i, card.canvaDesignId);
  } else if (act === 'ai') {
    await drawOne(i);
  } else if (act === 'coverCands') {
    const p = work.imageAI.provider as 'gemini' | 'openai' | 'claude';
    await openCoverCandidates(app, () => cardRefs(0), IMG_NAME[p], settings.prices[p] ?? 0, () => { refreshRow(0); });
  } else if (act === 'rewrite') {
    await rewrite(i);
  }
}

async function changeOutroKind(k: OutroKind) {
  pushUndo();
  work.outroKind = k;
  const outro = work.cards[TOTAL_CARDS - 1];
  if (k === 'none') outro.text = '';
  save(); refreshRow(TOTAL_CARDS - 1); renderStoryPanel(); scheduleRender();
  const hasStory = work.cards.slice(1, -1).some((c) => c.text.trim());
  const ai = textAI();
  if (k !== 'none' && hasStory && ai && online()) {
    setStatus($('composeStatus'), `${OUTRO_KINDS[k].name} 한 줄을 쓰는 중…`, 'busy');
    try {
      outro.text = await writeOutro(work, k, ai);
      save(); refreshRow(TOTAL_CARDS - 1); scheduleRender();
      setStatus($('composeStatus'), `마지막 장 덧붙임을 ${OUTRO_KINDS[k].name}(으)로 바꿨어요.`);
    } catch (e) { setStatus($('composeStatus'), aiMessage(e), 'error'); }
  }
}

async function rewrite(i: number) {
  const ai = textAI();
  if (!ai) { toast(`${PROVIDER_NAME[work.textAI.provider]} 키를 먼저 넣어 주세요.`); openSettings(); return; }
  const card = work.cards[i];
  if (card.kind === 'outro') {
    pushUndo();
    try { card.text = await writeOutro(work, work.outroKind, ai); } catch (e) { toast(aiMessage(e)); return; }
    save(); refreshRow(i); scheduleRender();
    return;
  }
  const ask = await promptBox(card.kind === 'cover' ? '표지 훅을 어떻게 고칠까요? (비워도 됩니다)' : `${i + 1}번 카드를 어떻게 고칠까요? (비워도 됩니다)`, { placeholder: '예: 더 짧게, 긴장감 있게, 대사로', ok: '다시 쓰기' });
  if (ask === null) return;
  const row = $('cardList').querySelector<HTMLElement>(`.card-row[data-i="${i}"]`);
  const btn = row?.querySelector<HTMLButtonElement>('button[data-act="rewrite"]');
  if (btn) { btn.disabled = true; btn.textContent = '쓰는 중…'; }
  try {
    const text = await rewriteCard(work, i, ask, ai);
    pushUndo();
    card.text = text;
    save(); scheduleRender(); renderReview(app);
  } catch (e) {
    toast(aiMessage(e));
  } finally {
    refreshRow(i);
  }
}

/* ================= pictures ================= */
/** Pictures sent along with a card's request: the character sheet first, then the cover (for the other cards). */
function cardRefs(i: number): CardRefs | null {
  const p = work.imageAI.provider;
  if (p !== 'gemini' && p !== 'openai') return null;
  const chars = work.style.refImage ? dataUrlParts(work.style.refImage) : null;
  const cover = i !== 0 && work.cards[0].img ? dataUrlParts(work.cards[0].img) : null;
  return chars || cover ? { chars, cover } : null;
}

async function drawOne(i: number, signal?: AbortSignal, quiet = false): Promise<boolean> {
  const ai = imageAI();
  const card = work.cards[i];
  if (!ai) {
    toast(`${IMG_NAME[work.imageAI.provider]} 키를 먼저 넣어 주세요.`);
    openSettings();
    return false;
  }
  if (artBusy.has(card.id)) return false;
  artBusy.add(card.id);
  refreshRow(i);
  if (!quiet) setStatus($('artStatus'), `${i + 1}번 카드 그림을 그리는 중…`, 'busy');
  try {
    const out = await drawCard(work, i, ai, cardRefs(i), signal);
    delete card.img; delete card.svg;
    if (out.img) card.img = out.img;
    if (out.svg) card.svg = out.svg;
    card.imgSource = ai.provider;
    card.imgPos = 'center';
    save();
    if (!quiet) setStatus($('artStatus'), `${i + 1}번 카드 그림을 넣었어요.`);
    return true;
  } catch (e) {
    if (!quiet) setStatus($('artStatus'), aiMessage(e), 'error');
    if (quiet) throw e;
    return false;
  } finally {
    artBusy.delete(card.id);
    refreshRow(i);
    scheduleRender();
  }
}

async function drawAll() {
  const ai = imageAI();
  if (!ai) { toast(`${IMG_NAME[work.imageAI.provider]} 키를 먼저 넣어 주세요.`); openSettings(); return; }
  let targets = work.cards.map((c, i) => ({ c, i })).filter(({ c }) => c.kind !== 'outro' && !srcOf(c)).map(({ i }) => i);
  if (!targets.length) {
    if (!(await confirmBox('모든 카드에 그림이 있어요. 표지와 본문 19장을 모두 다시 그릴까요?', { ok: '모두 다시 그리기' }))) return;
    targets = work.cards.map((_, i) => i).filter((i) => work.cards[i].kind !== 'outro');
  }
  const price = settings.prices[ai.provider] ?? 0;
  const spent = await monthTotal(app);
  const ok = await confirmBox(`그림 ${targets.length}장을 ${IMG_NAME[ai.provider]}(으)로 그립니다. 예상 비용은 약 $${(price * targets.length).toFixed(2)}예요.`, {
    ok: '그리기', detail: [
      `이번 달 지금까지 추정 ${money(spent)}${settings.monthlyBudget ? ` (예산 ${money(settings.monthlyBudget)})` : ''}.`,
      '장당 단가는 설정에서 고칠 수 있어요.',
      ai.provider === 'claude' ? 'Claude SVG는 장당 몇 초~30초 걸려요.' : '표지를 먼저 그리고, 그 그림을 참고해 나머지 그림체를 맞춰요.',
    ],
  });
  if (!ok) return;
  artCtl = new AbortController();
  const signal = artCtl.signal;
  $('btnArtStop').hidden = false;
  $<HTMLButtonElement>('btnArtAll').disabled = true;
  let done = 0, failed = 0, stop: string | null = null;
  const status = () => setStatus($('artStatus'), `그림 그리는 중… ${done + failed} / ${targets.length}`, 'busy');
  status();
  const one = async (i: number) => {
    try { await drawOne(i, signal, true); done++; } catch (e) {
      failed++;
      if (e instanceof AiError && ['rate_limited', 'invalid_key', 'no_key', 'cancelled', 'forbidden'].includes(e.code)) stop = aiMessage(e);
    }
    status();
  };
  // the cover first, so the other cards can follow its look
  if (targets[0] === 0) await one(targets.shift()!);
  const queue = [...targets];
  const worker = async () => { while (queue.length && !signal.aborted && !stop) await one(queue.shift()!); };
  await Promise.all([worker(), worker()]);
  artCtl = null;
  $('btnArtStop').hidden = true;
  $<HTMLButtonElement>('btnArtAll').disabled = false;
  if (signal.aborted) setStatus($('artStatus'), `중단했어요. ${done}장은 넣었습니다.`);
  else if (stop) setStatus($('artStatus'), `${stop} ${done}장은 넣었습니다.`, 'error');
  else setStatus($('artStatus'), failed ? `${done}장을 넣었고 ${failed}장은 실패했어요. 해당 카드의 「AI 그림」을 다시 눌러 보세요.` : `그림 ${done}장을 모두 넣었어요.`);
}

async function onUpload(file: File) {
  const i = uploadTarget;
  uploadTarget = null;
  if (i === null || !file) return;
  if (!file.type.startsWith('image/')) { toast('이미지 파일을 골라 주세요.'); return; }
  const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
  if (i === -1) {
    work.style.refImage = await shrinkImage(url, 1280);
    save(); renderRefBox();
    toast('인물 기준 그림을 넣었어요.');
    return;
  }
  const card = work.cards[i];
  delete card.svg;
  card.img = await shrinkImage(url);
  card.imgSource = work.imageAI.provider === 'canva' ? 'canva' : 'upload';
  card.imgPos = 'center';
  save(); refreshRow(i); scheduleRender();
}

/* ================= compose ================= */
async function runCompose() {
  const story = $<HTMLTextAreaElement>('story').value.trim();
  const st = $('composeStatus');
  if (!story) { setStatus(st, '이야기를 먼저 넣어 주세요.', 'error'); return; }
  const mode = work.source.mode;
  const eff = mode === 'auto' ? detectMode(story) : mode;
  const ai = textAI();
  if (!ai && eff !== 'split') { setStatus(st, `${PROVIDER_NAME[work.textAI.provider]} 키가 필요해요. 설정에서 넣어 주세요.`, 'error'); openSettings(); return; }
  if (ai && !online()) { setStatus(st, '인터넷 연결이 필요해요.', 'error'); return; }

  let split;
  if (eff === 'split') {
    split = splitManuscript(story);
    if (split.changes.length) {
      const ok = await confirmBox(`원고 ${split.originalCount}쪽을 본문 18장으로 맞춥니다.`, { ok: '이대로 맞추기', detail: split.changes });
      if (!ok) return;
    }
  }
  const hasWork = work.cards.some((c) => c.text.trim());
  if (hasWork && !(await confirmBox('지금 카드를 새 이야기로 바꿀까요? 글이 그대로인 카드의 그림만 남겨요.', { ok: '바꾸기' }))) return;

  pushUndo();
  const before = work.cards.map((c) => c.text);
  composeCtl = new AbortController();
  $('btnComposeStop').hidden = false;
  $<HTMLButtonElement>('btnCompose').disabled = true;
  setStatus(st, ai ? `${PROVIDER_NAME[ai.provider]}가 20장을 구성하는 중… (보통 20초~1분)` : '원고를 카드에 앉히는 중…', 'busy');
  try {
    const seriesCtx = ai ? await seriesContext(ai, composeCtl.signal) : undefined;
    if (seriesCtx?.previous.length) setStatus(st, `${PROVIDER_NAME[ai!.provider]}가 앞 회 ${seriesCtx.previous.length}편을 이어 ${work.episode}화 20장을 구성하는 중…`, 'busy');
    else if (seriesCtx?.bible) setStatus(st, `${PROVIDER_NAME[ai!.provider]}가 시리즈 설정집을 지키며 20장을 구성하는 중…`, 'busy');
    const draft: Work = JSON.parse(JSON.stringify(work));
    const r = await compose(draft, story, mode, $<HTMLSelectElement>('outroKind').value as OutroKind, ai, composeCtl.signal, split, seriesCtx);
    if (r.mode === 'split' || r.usedAI) {
      draft.cards.forEach((c, i) => { if (c.text !== before[i]) { delete c.img; delete c.svg; delete c.imgSource; } });
    }
    if (ai && draft.outroKind !== 'none' && !draft.cards[TOTAL_CARDS - 1].text) {
      try { draft.cards[TOTAL_CARDS - 1].text = await writeOutro(draft, draft.outroKind, ai, composeCtl.signal); } catch { /* the writer can fill it in */ }
    }
    work = draft;
    current = 0;
    save(); renderAllUI();
    const styleNote = r.usedAI && work.style.preset === 'ai' ? ` 그림체 제안: ${work.style.name}.` : '';
    setStatus(st, `20장 구성을 마쳤어요.${styleNote} 아래에서 다듬고 그림을 그려 보세요.${!ai && r.mode === 'split' ? ' (AI 키가 없어 장면 설명·그림체 제안은 비워 두었어요.)' : ''}`);
    $('cardsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    undoStack.pop();
    $<HTMLButtonElement>('btnUndo').disabled = !undoStack.length;
    setStatus(st, aiMessage(e), (e as AiError)?.code === 'cancelled' ? '' : 'error');
  } finally {
    composeCtl = null;
    $('btnComposeStop').hidden = true;
    $<HTMLButtonElement>('btnCompose').disabled = false;
  }
}

/** Episode 2 and later: the earlier episodes' summaries (written now where missing) go to the writer. */
async function seriesContext(ai: TextAI, signal: AbortSignal): Promise<SeriesContext | undefined> {
  if (!seriesName(work)) return undefined;
  const bible = bibleText(await loadBible(work.series));
  const prev = work.episode && work.episode >= 2 ? previousEpisodes(await works.all(), work) : [];
  if (!prev.length) return bible ? { previous: [], bible } : undefined;
  for (const p of prev) {
    if (p.summary?.trim() || !p.cards.some((c) => c.text.trim())) continue;
    setStatus($('composeStatus'), `${p.episode}화 줄거리를 정리하는 중…`, 'busy');
    try { p.summary = await summarize(p, ai, signal); await works.put(p); } catch (e) { if ((e as AiError)?.code === 'cancelled') throw e; }
  }
  return { previous: prev.map(asPrev), keepStyle: prev[prev.length - 1].style.prompt === work.style.prompt, bible };
}

/** Starts the next episode of `fromId`'s series with the same look, art style and character picture. */
async function startNextEpisode(fromId: string) {
  await persist(true);
  const all = await works.all();
  const from = fromId === work.id ? work : all.find((w) => w.id === fromId);
  if (!from) return;
  if (!seriesName(from)) { toast('시리즈 이름을 먼저 넣어 주세요. 같은 시리즈 이름끼리 회차가 이어져요.'); return; }
  if (!from.episode) {
    from.episode = 1;
    await works.put(from);
    const i = all.findIndex((w) => w.id === from.id); if (i >= 0) all[i] = from;
  }
  if (!from.summary && from.cards.some((c) => c.text.trim())) {
    const ai = textAI();
    if (ai && online()) {
      setStatus($('composeStatus'), `${from.episode}화 줄거리를 정리하는 중…`, 'busy');
      try { from.summary = await summarize(from, ai); await works.put(from); } catch { /* summarized again at compose time */ }
    }
  }
  work = nextEpisodeWork(from, defaults(), nextEpisodeNumber(all, from.series));
  current = 0; undoStack.length = 0; $<HTMLButtonElement>('btnUndo').disabled = true;
  save(); renderAllUI();
  setStatus($('composeStatus'), `「${seriesLine(work)}」 작업을 시작했어요. 이번 회 줄거리를 넣고 「카드로 만들기」를 누르면 앞 회와 이어지게 써요. 그림체와 인물 기준 그림도 그대로 가져왔어요.`);
  $('storyPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('story').focus();
}

/* ================= preview ================= */
let renderTimer = 0, rendering = false, renderAgain = false;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = window.setTimeout(() => void renderPreview(), 60); }
const stage = () => $<HTMLCanvasElement>('stage');

async function renderPreview() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try {
    const H = cardHeight(work);
    const sc = stage();
    if (sc.height !== H) sc.height = H;
    document.documentElement.style.setProperty('--card-ar', `1080 / ${H}`);
    await ensureFonts(work);
    await renderCard(sc.getContext('2d')!, work, current);
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d')!;
    for (let i = 0; i < work.cards.length; i++) {
      const tc = thumbCanvases[i];
      if (!tc) continue;
      const th = Math.round((112 * H) / W);
      if (tc.height !== th) tc.height = th;
      await renderCard(octx, work, i);
      const x = tc.getContext('2d')!;
      x.clearRect(0, 0, tc.width, tc.height);
      x.drawImage(off, 0, 0, W, H, 0, 0, tc.width, tc.height);
    }
    $('pagerText').textContent = `${current + 1} / ${TOTAL_CARDS}`;
    document.querySelectorAll('#thumbs button').forEach((b, i) => b.classList.toggle('active', i === current));
    document.querySelectorAll('.card-row').forEach((r, i) => r.classList.toggle('active', i === current));
  } finally {
    rendering = false;
    if (renderAgain) { renderAgain = false; scheduleRender(); }
  }
}

function renderLook() {
  const r = ratioOf(work.ratio);
  document.querySelectorAll<HTMLButtonElement>('#ratioSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === work.ratio));
  $('ratioHint').textContent = r.hint + (r.instagramApi ? '' : ' · 인스타 API 직접 게시는 1:1·4:5만 돼요(공유는 가능).');
  $('sizeTag').textContent = `카드 20장 · 1080×${r.h}`;
  const swatch = (t: { bg: [string, string]; accent: string; name: string }, attrs: string, active: boolean, mine = false) =>
    `<button type="button" class="theme ${active ? 'active' : ''} ${mine ? 'mine' : ''}" ${attrs} style="--sw-accent:${t.accent}"><span class="swatch" style="background:linear-gradient(135deg, ${t.bg[0]}, ${t.bg[1]})"></span>${esc(t.name)}</button>`;
  const customId = work.theme === 'custom' ? work.customTheme?.id : undefined;
  const saved = settings.customThemes;
  // a work may carry a custom theme that is not (or no longer) in this device's list: show it too
  const extra = work.theme === 'custom' && work.customTheme && !saved.some((t) => t.id === customId) ? [work.customTheme] : [];
  $('themes').innerHTML = (Object.keys(THEMES) as ThemeKey[]).map((k) => swatch(THEMES[k], `data-k="${k}"`, k === work.theme)).join('')
    + [...saved, ...extra].map((t) => swatch(t, `data-c="${esc(t.id)}" title="내 테마"`, t.id === customId, true)).join('');
  $('btnThemeEdit').hidden = !(customId && saved.some((t) => t.id === customId));
  $<HTMLInputElement>('brandOn').checked = !!work.brand;
  $('brandHint').textContent = brandHint(work) || '카드 구석에 로고나 핸들을 넣어요.';
  $<HTMLSelectElement>('font').innerHTML = FONT_CHOICES.map((f) => `<option value="${esc(f.value)}" ${f.value === work.font ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
  $<HTMLInputElement>('series').value = work.series;
  $<HTMLInputElement>('episode').value = work.episode ? String(work.episode) : '';
  $<HTMLInputElement>('handle').value = work.handle;
  $<HTMLInputElement>('follow').value = work.follow;
}

function renderAllUI() {
  renderStoryPanel();
  renderStyle();
  renderLook();
  buildCardList();
  renderReview(app);
  renderFinishBox(app);
  void renderTextAI();
  void renderImageAI();
  scheduleRender();
}

/* ================= settings ================= */
function openSettings() {
  const keyRow = (p: TextProvider, label: string, help: string) => `
    <div class="key-row" data-p="${p}">
      <div class="field">
        <label for="key-${p}">${label}</label>
        <input class="input" id="key-${p}" type="password" autocomplete="off" spellcheck="false" placeholder="${settings.keys[p] ? maskKey(settings.keys[p]) + ' 저장됨' : help}">
      </div>
      <button class="btn primary" type="button" data-a="save">확인·저장</button>
      <button class="btn" type="button" data-a="del" ${settings.keys[p] ? '' : 'disabled'}>지우기</button>
      <div class="state" data-state></div>
    </div>`;
  openModal(`
    <div class="panel-head"><h2>설정</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    <div class="scroll">
      <div class="warn">API 키는 이 기기의 브라우저에만 저장되고, 해당 AI 회사로만 보내요. 공용 기기에서는 쓰지 말고, 각 회사 콘솔에서 월 사용 한도를 걸어 두세요.</div>
      <div class="section-title">AI 키</div>
      <div class="stack">
        ${keyRow('anthropic', 'Anthropic (Claude 글 · Claude SVG 그림)', 'sk-ant-…')}
        ${keyRow('google', 'Google AI Studio (Gemini 글 · Gemini 이미지)', 'AIza…')}
        ${keyRow('openai', 'OpenAI (GPT 글 · GPT 이미지)', 'sk-…')}
      </div>
      <div class="section-title">새 작품 기본값</div>
      <div class="row two">
        <div class="field"><label for="setSeries">시리즈 이름</label><input class="input" id="setSeries" value="${esc(settings.series)}"></div>
        <div class="field"><label for="setHandle">작가 핸들</label><input class="input" id="setHandle" value="${esc(settings.handle)}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="setFollow">팔로우 문구 (마지막 장)</label><input class="input" id="setFollow" value="${esc(settings.follow)}"></div>
      <div class="section-title">그림</div>
      <div class="row three">
        <div class="field"><label for="priceGemini">Gemini 장당 $</label><input class="input" id="priceGemini" type="number" step="0.01" min="0" value="${settings.prices.gemini}"></div>
        <div class="field"><label for="priceOpenai">GPT 장당 $</label><input class="input" id="priceOpenai" type="number" step="0.01" min="0" value="${settings.prices.openai}"></div>
        <div class="field"><label for="priceClaude">Claude SVG 장당 $</label><input class="input" id="priceClaude" type="number" step="0.01" min="0" value="${settings.prices.claude}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="claudeTier">Claude SVG 품질</label>
        <select class="input" id="claudeTier"><option value="quick" ${settings.claudeArtTier === 'quick' ? 'selected' : ''}>빠름 (장당 몇 초)</option><option value="detailed" ${settings.claudeArtTier === 'detailed' ? 'selected' : ''}>정밀 (장당 30초 안팎)</option></select>
      </div>
      <p class="hint" style="margin-top:16px">가격은 자주 바뀌어요. 각 회사 가격표를 보고 맞춰 두면 그림 그리기 전에 예상 비용을 보여 줘요.</p>
      <div class="section-title">공유 링크</div>
      <div class="key-row" id="shareKeyRow">
        <div class="field"><label for="shareKey">공유 열쇠 (서버의 SHARE_KEY)</label><input class="input" id="shareKey" type="password" autocomplete="off" spellcheck="false" placeholder="${settings.shareKey ? maskKey(settings.shareKey) + ' 저장됨' : 'cn-…'}"></div>
        <button class="btn primary" type="button" data-a="shareSave">확인·저장</button>
        <button class="btn" type="button" data-a="shareDel" ${settings.shareKey ? '' : 'disabled'}>지우기</button>
        <div class="state" data-state></div>
      </div>
      <div class="section-title">구글 드라이브 백업</div>
      <div class="field"><label for="googleClientId">Google OAuth 클라이언트 ID</label><input class="input" id="googleClientId" spellcheck="false" autocomplete="off" placeholder="${esc(DEFAULT_GOOGLE_CLIENT_ID || '…apps.googleusercontent.com')}" value="${esc(settings.googleClientId)}"></div>
      <p class="hint" style="margin-top:6px">Google Cloud 콘솔에서 만든 ‘웹 애플리케이션’ 클라이언트 ID예요. 승인된 자바스크립트 원본에 ${esc(location.origin)} 을 넣어야 해요.</p>
    </div>
    <div class="toolbar" style="margin-top:16px"><button class="btn primary" type="button" data-a="done">저장하고 닫기</button></div>`,
  {
    size: 'mid',
    wire: (box, close) => {
      box.querySelector('[data-a="close"]')!.addEventListener('click', close);
      box.querySelectorAll<HTMLElement>('.key-row[data-p]').forEach((row) => {
        const p = row.dataset.p as TextProvider;
        const input = row.querySelector<HTMLInputElement>('input')!;
        const state = row.querySelector<HTMLElement>('[data-state]')!;
        const setState = (msg: string, cls = '') => { state.textContent = msg; state.className = 'state ' + cls; };
        row.querySelector('[data-a="save"]')!.addEventListener('click', async () => {
          const key = input.value.trim();
          if (!key) { setState('키를 붙여 넣어 주세요.', 'bad'); return; }
          setState('확인하는 중…');
          try {
            const lists = await listModels(p, key);
            settings.keys[p] = key;
            modelLists[p] = lists;
            await kv.set('models.' + p, lists);
            await saveSettings(settings);
            input.value = '';
            input.placeholder = maskKey(key) + ' 저장됨';
            row.querySelector<HTMLButtonElement>('[data-a="del"]')!.disabled = false;
            setState(`확인했어요. 글 모델 ${lists.text.length}개${lists.image.length ? ` · 그림 모델 ${lists.image.length}개` : ''}`, 'ok');
            void renderTextAI(); void renderImageAI(); buildCardList();
          } catch (e) {
            setState(e instanceof AiError && e.code === 'invalid_key' ? '잘못된 키예요.' : e instanceof AiError && e.code === 'network' ? '네트워크 오류예요. 연결을 확인해 주세요.' : aiMessage(e), 'bad');
          }
        });
        row.querySelector('[data-a="del"]')!.addEventListener('click', async () => {
          settings.keys[p] = '';
          delete modelLists[p];
          await kv.set('models.' + p, null);
          await saveSettings(settings);
          input.placeholder = '';
          row.querySelector<HTMLButtonElement>('[data-a="del"]')!.disabled = true;
          setState('지웠어요.');
          void renderTextAI(); void renderImageAI();
        });
      });
      const shareRow = box.querySelector<HTMLElement>('#shareKeyRow')!;
      const shareInput = shareRow.querySelector<HTMLInputElement>('#shareKey')!;
      const shareState = (msg: string, cls = '') => { const st = shareRow.querySelector<HTMLElement>('[data-state]')!; st.textContent = msg; st.className = 'state ' + cls; };
      shareRow.querySelector('[data-a="shareSave"]')!.addEventListener('click', async () => {
        const key = shareInput.value.trim();
        if (!key) { shareState('열쇠를 붙여 넣어 주세요.', 'bad'); return; }
        shareState('확인하는 중…');
        const st = await shareStatus(key);
        if (st && !st.keyOk) { shareState(st.enabled ? '열쇠가 맞지 않아요.' : '서버에 공유 저장소가 아직 설정되지 않았어요.', 'bad'); return; }
        settings.shareKey = key;
        await saveSettings(settings);
        shareInput.value = ''; shareInput.placeholder = maskKey(key) + ' 저장됨';
        shareRow.querySelector<HTMLButtonElement>('[data-a="shareDel"]')!.disabled = false;
        shareState(st ? '확인했어요. 이제 공유 링크를 만들 수 있어요.' : '저장했어요. (지금은 서버에 닿지 않아 확인은 못 했어요)', st ? 'ok' : '');
      });
      shareRow.querySelector('[data-a="shareDel"]')!.addEventListener('click', async () => {
        settings.shareKey = ''; await saveSettings(settings);
        shareInput.placeholder = 'cn-…'; shareRow.querySelector<HTMLButtonElement>('[data-a="shareDel"]')!.disabled = true;
        shareState('지웠어요.');
      });
      box.querySelector('[data-a="done"]')!.addEventListener('click', async () => {
        const v = (id: string) => (box.querySelector<HTMLInputElement>('#' + id)!.value);
        settings.googleClientId = v('googleClientId').trim();
        settings.series = v('setSeries').trim();
        settings.handle = v('setHandle').trim();
        settings.follow = v('setFollow').trim();
        settings.prices = { gemini: Number(v('priceGemini')) || 0, openai: Number(v('priceOpenai')) || 0, claude: Number(v('priceClaude')) || 0 };
        settings.claudeArtTier = v('claudeTier') === 'detailed' ? 'detailed' : 'quick';
        await saveSettings(settings);
        close();
        void renderImageAI();
        toast('설정을 저장했어요. 시리즈·핸들·팔로우 문구는 새 작품부터 들어가요.');
      });
    },
  });
}

/* ================= library ================= */
async function openLibrary() {
  await persist(true);
  const all = await works.all();
  const groups = groupBySeries(all);
  const item = (w: Work) => `
    <div class="work ${w.id === work.id ? 'current' : ''}" data-id="${esc(w.id)}">
      ${w.thumb ? `<img alt="" src="${w.thumb}">` : '<div class="noimg">그림 없음</div>'}
      <div><b>${w.episode ? `<span class="ep">${w.episode}화</span>` : ''}${esc(w.name || workTitle(w))}</b><span>${fmtDate(w.updatedAt)} · ${w.cards.filter((c) => c.text.trim()).length}/20장 글 · ${w.cards.filter((c) => c.img || c.svg).length}장 그림</span></div>
      <div class="acts">
        ${w.id === work.id ? '<span class="hint">지금 작업</span>' : '<button class="btn small" type="button" data-a="open">열기</button>'}
        <button class="btn small" type="button" data-a="copy">사본</button>
        <button class="btn small" type="button" data-a="export">내보내기</button>
        <button class="btn small" type="button" data-a="del" ${w.id === work.id ? 'disabled' : ''}>삭제</button>
      </div>
    </div>`;
  const group = (g: { name: string; works: Work[] }) => `
    <section class="series-group">
      <div class="series-head">
        <h3>${g.name ? esc(g.name) : '시리즈 없음'}<small>${g.works.length}편</small></h3>
        ${g.name ? `<button class="btn small tonal" type="button" data-a="next" data-id="${esc(g.works[g.works.length - 1].id)}">다음 회 만들기</button>` : ''}
      </div>
      ${g.works.map(item).join('')}
    </section>`;
  openModal(`
    <div class="panel-head"><h2>작품 보관함</h2>
      <div class="toolbar">
        <button class="btn small primary" type="button" data-a="new">새 작품</button>
        <button class="btn small" type="button" data-a="import">가져오기</button>
        <button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>
      </div>
    </div>
    <div class="drive-box" id="driveBox"></div>
    <p class="hint" style="margin:0 0 12px">작업은 바뀔 때마다 이 기기에 자동 저장돼요. 같은 시리즈 이름끼리 묶이고, 「다음 회 만들기」는 그림체·인물 기준 그림·테마를 그대로 가져가요.</p>
    <div class="lib">${all.length ? groups.map(group).join('') : '<div class="empty-note">아직 저장된 작품이 없어요.</div>'}</div>`,
  {
    size: 'wide',
    wire: (box, close) => {
      box.querySelector('[data-a="close"]')!.addEventListener('click', close);
      void renderDriveBox(box.querySelector<HTMLElement>('#driveBox')!, app, driveDeps, close);
      box.querySelector('[data-a="new"]')!.addEventListener('click', async () => {
        await persist(true);
        work = newWork(defaults());
        current = 0; undoStack.length = 0; $<HTMLButtonElement>('btnUndo').disabled = true;
        save(); renderAllUI(); close();
        toast('새 작품을 시작했어요.');
      });
      box.querySelector('[data-a="import"]')!.addEventListener('click', () => { const f = $<HTMLInputElement>('libFile'); f.value = ''; f.click(); close(); });
      box.querySelectorAll<HTMLButtonElement>('[data-a="next"]').forEach((b) => b.addEventListener('click', () => { close(); void startNextEpisode(b.dataset.id!); }));
      box.querySelectorAll<HTMLElement>('.work').forEach((el) => {
        const id = el.dataset.id!;
        el.querySelector('[data-a="open"]')?.addEventListener('click', async () => {
          await persist(true);
          const w = await works.get(id);
          if (!w) return;
          await openWork(w);
          close();
        });
        el.querySelector('[data-a="copy"]')!.addEventListener('click', async () => {
          const w = id === work.id ? work : await works.get(id);
          if (!w) return;
          const copy: Work = { ...JSON.parse(JSON.stringify(w)), id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: `${w.name || workTitle(w)} · 사본 ${fmtDate(Date.now())}`, createdAt: Date.now(), updatedAt: Date.now() };
          await works.put(copy);
          close(); void openLibrary();
        });
        el.querySelector('[data-a="export"]')!.addEventListener('click', async () => {
          const w = id === work.id ? work : await works.get(id);
          if (!w) return;
          download(new Blob([JSON.stringify({ app: 'cardnovel', version: 1, work: w })], { type: 'application/json' }), `${fileBase(w)}.cardnovel.json`);
        });
        el.querySelector('[data-a="del"]')!.addEventListener('click', async () => {
          close();
          if (!(await confirmBox('이 작품을 지울까요? 되돌릴 수 없어요.', { ok: '지우기' }))) { void openLibrary(); return; }
          await works.del(id);
          void openLibrary();
        });
      });
    },
  });
}

async function openWork(w: Work) {
  await adoptBible(w);
  work = normalizeWork(w, defaults());
  current = 0; undoStack.length = 0; $<HTMLButtonElement>('btnUndo').disabled = true;
  await kv.set('currentId', work.id);
  renderAllUI();
}

async function importFile(file: File) {
  try {
    const data = JSON.parse(await file.text());
    const w = data?.work ?? data;
    if (!w || !Array.isArray(w.cards)) throw new Error('not a work');
    await persist(true);
    work = normalizeWork({ ...w, id: w.id || undefined }, defaults());
    if (!w.id) work.id = Date.now().toString(36);
    current = 0;
    save(); renderAllUI();
    toast('작품을 가져왔어요.');
  } catch {
    toast('카드소설 제작소에서 내보낸 파일이 아니에요.');
  }
}

/* ================= export ================= */
const exportFmt = (): ImgFormat => ($<HTMLSelectElement>('exportFmt').value === 'jpg' ? 'jpg' : 'png');

async function copyCaption(silent = false) {
  try {
    await navigator.clipboard.writeText(captionText(work));
    if (!silent) toast('캡션을 복사했어요. 게시글에 붙여 넣으세요.');
    return true;
  } catch {
    if (!silent) toast('복사가 막혔어요. 표지 제목과 훅을 직접 옮겨 적어 주세요.');
    return false;
  }
}

async function saveAll() {
  const btn = $<HTMLButtonElement>('btnSaveAll');
  btn.disabled = true;
  try {
    const blob = await zipAll(work, exportFmt(), (n) => { btn.textContent = `만드는 중 ${n}/20`; });
    download(blob, `${fileBase(work)}_20장.zip`);
    toast('20장을 ZIP으로 저장했어요.');
  } catch { toast('저장하지 못했어요. 다시 시도해 주세요.'); } finally { btn.disabled = false; btn.textContent = '전체 ZIP 저장'; }
}

async function saveOne() {
  try { download(await renderToBlob(work, current, exportFmt()), cardFileName(work, current, exportFmt())); toast(`${current + 1}번 카드를 저장했어요.`); } catch { toast('저장하지 못했어요.'); }
}

async function share() {
  const btn = $<HTMLButtonElement>('btnShare');
  btn.disabled = true;
  try {
    const files = await renderAllFiles(work, 'jpg', (n) => { btn.textContent = `준비 중 ${n}/20`; });
    const copied = await copyCaption(true);
    const r = await shareCards(files, captionText(work));
    if (r === 'shared') toast(copied ? '공유했어요. 캡션은 복사돼 있으니 게시글에 붙여 넣으세요.' : '공유했어요.');
    else if (r === 'unsupported') toast('이 브라우저는 파일 공유를 지원하지 않아요. 「전체 ZIP 저장」 후 인스타 앱에서 올려 주세요.', 5000);
  } catch { toast('공유하지 못했어요.'); } finally { btn.disabled = false; btn.textContent = '인스타로 공유 (20장)'; }
}

/* ================= wiring ================= */
function wire() {
  $('btnLibrary').addEventListener('click', () => void openLibrary());
  $('btnUsage').addEventListener('click', () => void openUsage(app));
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCaption').addEventListener('click', () => void copyCaption());
  $('btnSaveAll').addEventListener('click', () => void saveAll());
  $('btnSaveOne').addEventListener('click', () => void saveOne());
  $('btnShare').addEventListener('click', () => void share());
  $('btnInsta').addEventListener('click', () => void openInstaPreview(app));
  // the video encoder is loaded only when it is used
  $('btnReels').addEventListener('click', () => void import('./ui/reels').then((m) => m.openReels(app)).catch(() => toast('영상 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')));
  $('btnShareLink').addEventListener('click', () => void makeShareLink(app, shareDeps, $<HTMLButtonElement>('btnShareLink')));
  $('btnShareList').addEventListener('click', () => void openShareList(app, shareDeps));
  $('btnUndo').addEventListener('click', undo);
  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); undo(); }
  });

  // story
  $('story').addEventListener('input', () => { work.source.text = $<HTMLTextAreaElement>('story').value; updateModeHint(); save(); });
  document.querySelectorAll<HTMLButtonElement>('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.v as InputMode)));
  $('outroKind').addEventListener('change', () => void changeOutroKind($<HTMLSelectElement>('outroKind').value as OutroKind));
  $('btnCompose').addEventListener('click', () => void runCompose());
  $('btnComposeStop').addEventListener('click', () => composeCtl?.abort());
  $('btnExample').addEventListener('click', () => {
    openModal(`<h2>나눈 원고 형식</h2><p class="hint" style="margin:8px 0 12px">머리글 한 줄로 카드를 나눕니다. 표지의 첫 줄은 제목, 둘째 줄은 훅이 돼요. 본문이 18장이 아니면 합치거나 나눌 곳을 먼저 보여 줘요.</p><pre class="format-note" style="white-space:pre-wrap;margin:0 0 16px">${esc(SAMPLE_SPLIT)}</pre><div class="toolbar"><button class="btn" type="button" data-a="close">닫기</button><button class="btn primary" type="button" data-a="use">이 형식으로 시작</button></div>`, {
      size: 'mid',
      wire: (box, close) => {
        box.querySelector('[data-a="close"]')!.addEventListener('click', close);
        box.querySelector('[data-a="use"]')!.addEventListener('click', () => {
          const ta = $<HTMLTextAreaElement>('story');
          if (!ta.value.trim()) { ta.value = SAMPLE_SPLIT; work.source.text = SAMPLE_SPLIT; setMode('split'); }
          close(); ta.focus();
        });
      },
    });
  });
  $('textProvider').addEventListener('change', () => {
    const p = $<HTMLSelectElement>('textProvider').value as TextProvider;
    work.textAI = { provider: p, model: settings.models[p] || '' };
    settings.textAI = { ...work.textAI };
    void saveSettings(settings); save(); void renderTextAI();
  });
  $('textModel').addEventListener('change', () => {
    const m = $<HTMLSelectElement>('textModel').value;
    work.textAI.model = m;
    settings.models[work.textAI.provider] = m;
    settings.textAI = { ...work.textAI };
    void saveSettings(settings); save();
  });

  // style
  $('stylePreset').addEventListener('change', () => {
    const v = $<HTMLSelectElement>('stylePreset').value;
    if (!v) return;
    const keepChars = work.style.characters, keepRef = work.style.refImage;
    work.style = presetStyle(v);
    if (keepChars && !work.style.characters) work.style.characters = keepChars;
    if (keepRef) work.style.refImage = keepRef;
    save(); renderStyle();
    toast(`그림체를 ‘${work.style.name}’(으)로 바꿨어요. 새로 그리는 그림부터 적용돼요.`);
  });
  $('stylePrompt').addEventListener('input', () => { work.style.prompt = $<HTMLTextAreaElement>('stylePrompt').value; if (work.style.preset !== 'ai') work.style.preset = 'custom'; save(); });
  $('styleChars').addEventListener('input', () => { work.style.characters = $<HTMLTextAreaElement>('styleChars').value; save(); });
  $('btnRefAI').addEventListener('click', () => void makeRefSheet());
  $('btnRefUpload').addEventListener('click', () => { uploadTarget = -1; const fi = $<HTMLInputElement>('fileInput'); fi.value = ''; fi.click(); });
  $('btnRefCover').addEventListener('click', () => { if (work.cards[0].img) { work.style.refImage = work.cards[0].img; save(); renderRefBox(); toast('표지 그림을 인물 기준 그림으로 썼어요.'); } });
  $('btnRefClear').addEventListener('click', () => { delete work.style.refImage; save(); renderRefBox(); });

  // pictures
  $('imageProvider').addEventListener('change', () => {
    const p = $<HTMLSelectElement>('imageProvider').value as ImageProvider;
    const remembered = p === 'gemini' ? settings.models.geminiImage : p === 'openai' ? settings.models.openaiImage : p === 'claude' ? settings.models.anthropic : '';
    work.imageAI = { provider: p, model: remembered };
    settings.imageAI = { ...work.imageAI };
    void saveSettings(settings); save(); void renderImageAI(); buildCardList(); renderRefBox(); scheduleRender();
  });
  $('imageModel').addEventListener('change', () => {
    const m = $<HTMLSelectElement>('imageModel').value;
    work.imageAI.model = m;
    const p = work.imageAI.provider;
    if (p === 'gemini') settings.models.geminiImage = m; else if (p === 'openai') settings.models.openaiImage = m;
    settings.imageAI = { ...work.imageAI };
    void saveSettings(settings); save();
  });
  $('btnArtAll').addEventListener('click', () => void drawAll());
  $('btnArtStop').addEventListener('click', () => artCtl?.abort());
  $('fileInput').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void onUpload(f); });
  $('libFile').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importFile(f); });
  wireCardList();
  wireReview(app);
  wireFinishBox(app, finishDeps);

  // look
  $('ratioSeg').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
    if (!b) return;
    work.ratio = b.dataset.v as RatioKey;
    save(); renderLook(); buildCardList(); scheduleRender();
  });
  $('themes').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-k], button[data-c]');
    if (!b) return;
    if (b.dataset.k) {
      work.theme = b.dataset.k as ThemeKey;
      delete work.customTheme;
    } else {
      const t = settings.customThemes.find((x) => x.id === b.dataset.c) ?? (work.customTheme?.id === b.dataset.c ? work.customTheme : undefined);
      if (!t) return;
      work.theme = 'custom';
      work.customTheme = { ...t, bg: [...t.bg] as [string, string] };
    }
    save(); renderLook(); scheduleRender();
  });
  $('btnThemeNew').addEventListener('click', () => openThemeEditor(app));
  $('btnThemeEdit').addEventListener('click', () => openThemeEditor(app, work.customTheme?.id));
  $('brandOn').addEventListener('change', () => setBrandOn(app, $<HTMLInputElement>('brandOn').checked));
  $('btnBrand').addEventListener('click', () => openBrandEditor(app));
  $('font').addEventListener('change', () => { work.font = $<HTMLSelectElement>('font').value; save(); scheduleRender(); });
  $('episode').addEventListener('input', () => {
    const n = parseInt($<HTMLInputElement>('episode').value, 10);
    if (n >= 1 && n <= 999) work.episode = n; else delete work.episode;
    save(); scheduleRender();
  });
  $('btnNextEpisode').addEventListener('click', () => void startNextEpisode(work.id));
  $('btnBible').addEventListener('click', () => void openBible(app));
  for (const f of ['series', 'handle', 'follow'] as const) {
    $(f).addEventListener('input', () => { work[f] = $<HTMLInputElement>(f).value; save(); renderStoryPanel(); refreshRow(TOTAL_CARDS - 1); scheduleRender(); });
  }

  // preview
  $('btnPrev').addEventListener('click', () => select((current + TOTAL_CARDS - 1) % TOTAL_CARDS));
  $('btnNext').addEventListener('click', () => select((current + 1) % TOTAL_CARDS));

  // online state
  const net = () => { $('offlinePill').hidden = online(); buildCardList(); renderReview(app); void renderImageAI(); scheduleRender(); };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);

  wireSplitter();
}

function wireSplitter() {
  const sp = $('splitter');
  let dragging = false;
  void kv.get<number>('rightw', 0).then((w) => { if (w >= 320 && w <= 760) document.documentElement.style.setProperty('--right-w', w + 'px'); });
  sp.addEventListener('pointerdown', (e) => { dragging = true; sp.classList.add('drag'); sp.setPointerCapture(e.pointerId); });
  sp.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(320, Math.min(760, window.innerWidth - e.clientX - 16));
    document.documentElement.style.setProperty('--right-w', w + 'px');
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove('drag');
    void kv.set('rightw', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-w'), 10) || 440);
  };
  sp.addEventListener('pointerup', end);
  sp.addEventListener('pointercancel', end);
  sp.addEventListener('dblclick', () => { document.documentElement.style.setProperty('--right-w', '440px'); void kv.set('rightw', 0); });
}

/* ================= Canva ================= */
const channel: BroadcastChannel | null = 'BroadcastChannel' in window ? new BroadcastChannel('cardnovel') : null;
interface CanvaImageMsg { type: 'canva-image'; workId: string; cardId: string; img: string }
const broadcast = (m: CanvaImageMsg) => { try { channel?.postMessage(m); } catch { /* another tab is optional */ } };

async function renderCanvaStatus() {
  const st = $('artStatus');
  setStatus(st, 'Canva 연결을 확인하는 중…', 'busy');
  const connected = await canvaStatus();
  if (work.imageAI.provider !== 'canva') return;
  st.className = 'status';
  if (connected === null) { st.textContent = CANVA_MESSAGES.unavailable; return; }
  if (connected) {
    st.innerHTML = 'Canva에 연결됐어요. 카드마다 「Canva에서 그리기」를 누르세요. <button class="btn tiny" type="button" id="btnCanvaLogout">연결 끊기</button>';
    $('btnCanvaLogout').addEventListener('click', async () => { await canvaLogout().catch(() => undefined); void renderCanvaStatus(); });
  } else {
    st.innerHTML = 'Canva로 그리려면 먼저 연결해 주세요. <button class="btn tiny primary" type="button" id="btnCanvaLogin">Canva 연결하기</button>';
    $('btnCanvaLogin').addEventListener('click', () => void goCanvaLogin());
  }
}

/** Saves first: the sign-in leaves the app page and comes back to it. */
async function goCanvaLogin() {
  clearTimeout(persistTimer);
  dirty = true;
  await persist(true);
  canvaLogin();
}

async function openInCanva(i: number) {
  const card = work.cards[i];
  // open the tab now, while the click still counts, so the browser does not block it as a pop-up
  const tab = window.open('', '_blank');
  try { tab?.document.write('<p style="font:16px sans-serif;padding:24px">Canva 디자인을 준비하는 중…</p>'); } catch { /* cosmetic */ }
  const st = $('artStatus');
  artBusy.add(card.id);
  refreshRow(i);
  setStatus(st, `${i + 1}번 카드를 Canva로 보내는 중…`, 'busy');
  try {
    const w = W;
    const h = artHeight(work, card);
    const src = srcOf(card);
    const image = src ? await pictureForCanva(src, w, h, card.imgPos) : undefined;
    const r = await createDesign({ width: w, height: h, title: `${workTitle(work)} ${String(i + 1).padStart(2, '0')}`, image, state: canvaState(work.id, card.id) });
    card.canvaDesignId = r.designId;
    save();
    if (tab && !tab.closed) tab.location.href = r.editUrl; else window.open(r.editUrl, '_blank');
    setStatus(st, `${i + 1}번 카드가 Canva 새 탭에서 열렸어요. 다 그리면 Canva 왼쪽 위의 돌아가기(Return) 버튼을 누르세요.`);
  } catch (e) {
    tab?.close();
    if (e instanceof CanvaError && e.code === 'not_connected') {
      setStatus(st, 'Canva 연결이 필요해요. 연결 화면으로 이동해요…');
      await goCanvaLogin();
      return;
    }
    setStatus(st, canvaMessage(e), 'error');
  } finally {
    artBusy.delete(card.id);
    refreshRow(i);
  }
}

async function importFromCanva(i: number, designId: string) {
  const card = work.cards[i];
  const st = $('artStatus');
  artBusy.add(card.id);
  refreshRow(i);
  setStatus(st, `${i + 1}번 카드 그림을 Canva에서 가져오는 중…`, 'busy');
  try {
    const url = await exportDesign(designId);
    delete card.svg;
    card.img = await shrinkImage(url);
    card.imgSource = 'canva';
    card.imgPos = 'center';
    card.canvaDesignId = designId;
    save();
    broadcast({ type: 'canva-image', workId: work.id, cardId: card.id, img: card.img });
    setStatus(st, `${i + 1}번 카드에 Canva 그림을 넣었어요.`);
    toast(`${i + 1}번 카드에 Canva 그림을 넣었어요.`);
  } catch (e) {
    if (e instanceof CanvaError && e.code === 'not_connected') { setStatus(st, 'Canva 연결이 필요해요. 연결 화면으로 이동해요…'); await goCanvaLogin(); return; }
    setStatus(st, canvaMessage(e), 'error');
  } finally {
    artBusy.delete(card.id);
    refreshRow(i);
    scheduleRender();
  }
}

/** Another tab (the one Canva returned to) put a picture into a card of this work. */
channel?.addEventListener('message', (e: MessageEvent<CanvaImageMsg>) => {
  const m = e.data;
  if (m?.type !== 'canva-image' || m.workId !== work.id) return;
  const i = work.cards.findIndex((c) => c.id === m.cardId);
  if (i < 0) return;
  const c = work.cards[i];
  delete c.svg;
  c.img = m.img;
  c.imgSource = 'canva';
  c.imgPos = 'center';
  save(); refreshRow(i); scheduleRender();
  toast(`${i + 1}번 카드에 Canva 그림이 들어왔어요.`);
});

/** Landing back from Canva: after sign-in (?canva=connected), or from the editor's Return button (?canva=return). */
async function handleCanvaLanding() {
  const url = new URL(location.href);
  const l = readLanding(url);
  if (!l) return;
  history.replaceState(null, '', url.pathname);
  if (l.kind === 'connected') {
    if (work.imageAI.provider !== 'canva') { work.imageAI = { provider: 'canva', model: '' }; save(); void renderImageAI(); buildCardList(); }
    toast('Canva에 연결했어요. 카드의 「Canva에서 그리기」를 눌러 주세요.', 5000);
    return;
  }
  if (l.kind === 'error') {
    toast(l.reason === 'return' ? 'Canva에서 돌아온 정보를 확인하지 못했어요. 카드의 「Canva에서 가져오기」를 눌러 주세요.' : `Canva 연결에 실패했어요 (${l.reason || '알 수 없음'}).`, 6000);
    return;
  }
  const target = parseCanvaState(l.state || '');
  if (target && target.workId !== work.id) {
    const other = await works.get(target.workId);
    if (other) { work = normalizeWork(other, defaults()); current = 0; await kv.set('currentId', work.id); renderAllUI(); }
  }
  if (target?.cardId === 'finish' && l.design) {
    $('finishBox').scrollIntoView({ block: 'center' });
    await pullFinished(app, finishDeps, l.design);
    return;
  }
  let i = target ? work.cards.findIndex((c) => c.id === target.cardId) : -1;
  if (i < 0 && l.design) i = work.cards.findIndex((c) => c.canvaDesignId === l.design);
  if (i < 0 || !l.design) { toast('Canva 그림이 어느 카드 것인지 찾지 못했어요.'); return; }
  select(i);
  $('cardList').querySelector<HTMLElement>(`.card-row[data-i="${i}"]`)?.scrollIntoView({ block: 'center' });
  await importFromCanva(i, l.design);
}

/* ================= start ================= */
async function start() {
  settings = await loadSettings();
  const id = await kv.get<string | null>('currentId', null);
  const saved = id ? await works.get(id) : null;
  work = saved ? normalizeWork(saved, defaults()) : newWork(defaults());
  if (!saved) await works.put(work);
  wire();
  onUsage((u) => void onUsageEvent(app, u));
  void renderUsagePill(app);
  $('offlinePill').hidden = online();
  renderAllUI();
  $('savedAt').textContent = saved ? `불러옴 · ${fmtDate(saved.updatedAt)}` : '';
  if (!settings.keys.anthropic && !settings.keys.google && !settings.keys.openai) {
    setStatus($('composeStatus'), '처음이라면 「설정」에서 AI 키를 하나 넣어 주세요. 나눈 원고는 키 없이도 카드로 만들 수 있어요.');
  }
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  }
  await handleCanvaLanding();
}

void start();

// exposed for automated browser checks
declare global { interface Window { __cardnovel?: { work: () => Work } } }
window.__cardnovel = { work: () => work };
