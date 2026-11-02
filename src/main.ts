import './styles.css';
import { aiMessage, AiError, listModels, onUsage, pickDefault, type ModelInfo, type ModelLists } from './ai/providers';
import { compose, drawCard, drawCharacterSheet, rewriteCard, summarize, writeOutro, dataUrlParts, shrinkImage, type CardRefs, type ImageAI, type SeriesContext, type TextAI } from './ai/compose';
import { asPrev, groupBySeries, nextEpisodeNumber, nextEpisodeWork, previousEpisodes, seriesName } from './series';
import { adoptBible, bibleText, loadBible } from './bible';
import {
  BODY_COUNT, LAYOUT_NAME, OUTRO_KINDS, TEXT_POS_NAME, TEXT_SCALES, STYLE_PRESETS, TOTAL_CARDS, countChars, newWork, normalizeWork, presetStyle, seriesLine, stripMarks, textSig, workTitle,
  type Card, type CardLayout, type ImageProvider, type TextPos, type InputMode, type OutroKind, type TextProvider, type Work, type WorkDefaults,
} from './model';
import { detectMode, SAMPLE_SPLIT, splitManuscript } from './parse';
import { artHeight, cardHeight, cardSig, ensureFonts, layoutOf, lookSig, renderCard, srcOf, W } from './render';
import { DEFAULT_SETTINGS, keyFor, loadSettings, maskKey, saveSettings, type Settings } from './settings';
import { kv, works } from './store';
import { FOLDER_NAME } from './drive';
import { daysLeft, dropFromTrash, filterWorks, LIB_SORT_NAME, listTrash, moveToTrash, purgeTrash, takeFromTrash, TRASH_DAYS, type LibSort } from './library';
import { FONT_CHOICES, THEMES, ratioOf, type RatioKey, type ThemeKey } from './themes';
import { captionText, cardFileName, download, fileBase, renderAll as renderAllFiles, renderToBlob, shareCards, zipAll, type ImgFormat } from './export';
import { $, confirmBox, esc, fmtDate, fmtTime, openModal, promptBox, setStatus, toast } from './ui/dom';
import type { App } from './app';
import { renderReview, wireReview } from './ui/review';
import { renderProof, wireProof } from './ui/proof';
import { openInstaPreview } from './ui/insta';
import { openCoverCandidates } from './ui/cover';
import { openBible } from './ui/bible';
import { pullFinished, renderFinishBox, wireFinishBox, type FinishDeps } from './ui/finish';
import { openVersions, type VersionDeps } from './ui/versions';
import { paintMini, wireMobile } from './ui/mobile';
import { onTabChange, restoreTabs, setTab, wireSteps, type Tab } from './ui/steps';
import { openPalette, type Command } from './ui/palette';
import { okToPost, renderPrecheck } from './ui/precheck';
import { openCaption } from './ui/caption';
import { isStaleChunkError, newVersionReady, watchForUpdates } from './ui/update';
import { deleteAllVersions, saveVersion, versionsAvailable, type VersionReason } from './versions';
import { brandHint, openBrandEditor, openThemeEditor, setBrandOn } from './ui/look';
import { monthTotal, onUsageEvent, openUsage, renderUsagePill } from './ui/usage';
import { money } from './usage';
import { makeShareLink, openShareList, type ShareDeps } from './ui/share';
import { shareStatus } from './share';
import { afterLocalSave, renderDriveBox, startDriveSync, type DriveDeps } from './ui/drive';
import { CANVA_MESSAGES, CanvaError, canvaLogin, canvaLogout, canvaMessage, canvaState, canvaStatus, createDesign, exportDesign, parseCanvaState, pictureForCanva, readLanding } from './canva';

declare const __BUILD__: string;
const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

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
  openSettings: (pane) => openSettings(pane),
  online: () => online(),
  current: () => current,
  settings: () => settings,
  saveSettings: () => saveSettings(settings),
  renderLook: () => renderLook(),
  keepVersion: (reason) => keepVersion(reason),
  goCard: (i, focus) => goCard(i, focus),
  undo: () => undo(),
  undoToast: (msg) => undoToast(msg),
  openCaption: () => openCaptionHelper(),
};
const shareDeps: ShareDeps = { key: () => settings.shareKey };
const finishDeps: FinishDeps = { login: () => goCanvaLogin(), refreshAll: () => { buildCardList(); scheduleRender(); } };
const driveDeps: DriveDeps = { clientId: () => settings.googleClientId || DEFAULT_GOOGLE_CLIENT_ID, defaults: () => defaults(), reopenLibrary: () => void openLibrary() };
let reviewTimer = 0;
const scheduleReview = () => { clearTimeout(reviewTimer); reviewTimer = window.setTimeout(() => { renderReview(app); renderProof(app); }, 700); };
/** the step tabs' little status lines and the pre-publish check follow every change, a moment later */
let checksTimer = 0;
const scheduleChecks = () => { clearTimeout(checksTimer); checksTimer = window.setTimeout(() => { renderStepStatus(); renderPrecheck(app); }, 500); };
function renderStepStatus() {
  const body = work.cards.filter((c) => c.kind === 'body');
  const filled = body.filter((c) => c.text.trim()).length;
  const pics = work.cards.filter((c) => c.kind !== 'outro' && (c.img || c.svg)).length;
  $('stStory').textContent = filled ? '구성함' : work.source.text.trim() ? '입력함' : '';
  $('stCards').textContent = filled ? `글 ${filled}/${BODY_COUNT} · 그림 ${pics}/${BODY_COUNT + 1}` : '';
  const r = work.review;
  $('stReview').textContent = r ? `${Object.values(r.scores).reduce((a, b) => a + b, 0)}점${r.sig !== textSig(work) ? ' (이전 글)' : ''}` : filled ? '평가 전' : '';
}

/* ================= undo (text and order, last 20 steps) ================= */
interface Snap { order: string[]; fields: Record<string, Pick<Card, 'label' | 'showLabel' | 'title' | 'text' | 'scene' | 'accent'>>; outroKind: OutroKind; caption: string; hashtags: string[] }
const undoStack: Snap[] = [];
function snapshot(): Snap {
  const fields: Snap['fields'] = {};
  work.cards.forEach((c) => { fields[c.id] = { label: c.label, showLabel: c.showLabel, title: c.title, text: c.text, scene: c.scene, accent: c.accent }; });
  return { order: work.cards.map((c) => c.id), fields, outroKind: work.outroKind, caption: work.caption, hashtags: [...work.hashtags] };
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
  work.caption = s.caption;
  work.hashtags = [...s.hashtags];
  save(); renderAllUI();
  toast('되돌렸어요.');
}

/** A notice with 「되돌리기」 for the change just made; it only undoes that change, not a later one. */
function undoToast(msg: string) {
  const depth = undoStack.length;
  toast(msg, 6500, { label: '되돌리기', run: () => {
    if (undoStack.length === depth) undo();
    else toast('그 뒤에 다른 변경이 있어요. 카드 편집의 「되돌리기」를 써 주세요.');
  } });
}

/* ================= versions ================= */
const TIMED_VERSION_MS = 10 * 60_000;
let lastTimedVersion = Date.now();
/** Keeps a version of the open work (never blocks or fails the action that asked for it). */
async function keepVersion(reason: VersionReason, w: Work = work): Promise<void> {
  if (!versionsAvailable()) return;
  try { await saveVersion(w, reason); } catch { /* history is a convenience */ }
}
const versionDeps: VersionDeps = {
  restore: async (v) => {
    const keep = { id: work.id, createdAt: work.createdAt };
    work = normalizeWork({ ...v, ...keep, updatedAt: Date.now() }, defaults());
    undoStack.length = 0; $<HTMLButtonElement>('btnUndo').disabled = true;
    save(); renderAllUI();
  },
  openCopy: async (v) => {
    await keepVersion('leave');
    const copy = normalizeWork({ ...v, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: `${workTitle(v)} · ${fmtDate(Date.now())} 버전 사본`, createdAt: Date.now(), updatedAt: Date.now() }, defaults());
    await works.put(copy);
    await openWork(copy, false);
  },
};

/* ================= saving ================= */
let persistTimer = 0, dirty = false, thumbSig = '';
/** Rough size of the pictures kept in the work: a big work is written less often while typing. */
const pictureBytes = (w: Work): number => w.cards.reduce((n, c) => n + (c.img?.length ?? 0) + (c.svg?.length ?? 0), 0)
  + (w.finished?.images.reduce((n, x) => n + x.length, 0) ?? 0) + (w.style.refImage?.length ?? 0);
function save() {
  scheduleChecks();
  // always forward, even when the copy came from a device whose clock runs ahead: an edit here must read as newer
  work.updatedAt = Math.max(Date.now(), (work.updatedAt || 0) + 1);
  dirty = true;
  $('savedAt').textContent = '저장 중…';
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => void persist(true), pictureBytes(work) > 3_000_000 ? 1800 : 800);
}
async function persist(withThumb: boolean) {
  if (!dirty) return;
  dirty = false;
  try {
    // the library thumbnail is the cover: redraw it only when the cover changed
    const sig = cardSig(work, 0);
    if (withThumb && (sig !== thumbSig || !work.thumb)) { try { work.thumb = await makeThumb(); thumbSig = sig; } catch { /* keep the old one */ } }
    await works.put(work);
    await kv.set('currentId', work.id);
    $('savedAt').textContent = `자동 저장됨 · ${fmtTime(Date.now())}`;
    afterLocalSave(app);
    if (Date.now() - lastTimedVersion > TIMED_VERSION_MS) { lastTimedVersion = Date.now(); void keepVersion('timer'); }
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

/** cards whose design fields are open (by card id), and whether they are open on every card */
const designOpen = new Set<string>();
let designAll = (() => { try { return localStorage.getItem('cardnovel.designAll') === '1'; } catch { return false; } })();

/** The design choices that differ from the defaults, so a closed card still shows them. */
function designSummary(card: Card): string[] {
  const out: string[] = [];
  const isBody = card.kind === 'body';
  const layout = layoutOf(card);
  if (layout !== 'stack') out.push(LAYOUT_NAME[layout]);
  if (card.textScale && card.textScale !== 1) out.push('글자 ' + (TEXT_SCALES.find((t) => t.value === card.textScale)?.name ?? card.textScale));
  if (card.textPos && card.textPos !== 'auto') out.push('글 ' + TEXT_POS_NAME[card.textPos]);
  if (srcOf(card) && card.imgPos && card.imgPos !== 'center') out.push('자르기 ' + (card.imgPos === 'top' ? '위' : '아래'));
  if (isBody && card.showLabel && card.label.trim()) out.push(`머리말 ‘${card.label.trim()}’`);
  if (isBody && card.accent) out.push('강조');
  if (isBody && card.title.trim()) out.push(layout === 'quote' ? `말한 사람 ‘${card.title.trim()}’` : '소제목');
  if (!isBody && !card.showLabel) out.push('시리즈 줄 숨김');
  return out;
}

function cardRowHTML(card: Card, i: number): string {
  const src = srcOf(card);
  const isBody = card.kind === 'body', isCover = card.kind === 'cover', isOutro = card.kind === 'outro';
  const p = work.imageAI.provider;
  const canAI = p !== 'upload' && p !== 'canva';
  const busy = artBusy.has(card.id);
  const pos = card.imgPos || 'center';
  const layout = layoutOf(card);
  const layouts: CardLayout[] = isBody ? ['stack', 'full', 'quote'] : isCover ? ['stack', 'full'] : [];
  const open = designAll || designOpen.has(card.id);
  const summary = designSummary(card);
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
      </div>
    </div>
    <div class="body">
      ${isCover ? `<input class="input" data-f="title" placeholder="이야기 제목" aria-label="이야기 제목" value="${esc(card.title)}">` : ''}
      ${isOutro ? `<select class="input" data-f="outroKind" aria-label="덧붙임 종류">${(Object.keys(OUTRO_KINDS) as OutroKind[]).map((k) => `<option value="${k}" ${k === work.outroKind ? 'selected' : ''}>${OUTRO_KINDS[k].name}</option>`).join('')}</select>` : ''}
      ${isOutro && work.outroKind === 'none' ? '' : `<textarea class="input" data-f="text" aria-label="${i + 1}번 카드 글" placeholder="${isCover ? '표지에 들어갈 한 줄 훅' : isOutro ? '덧붙임 한 줄' : '카드 본문 · *별표*로 감싼 말은 강조색'}">${esc(card.text)}</textarea>`}
      ${isOutro ? `<div class="fixed">고정: ${esc([work.follow, work.handle].filter(Boolean).join(' · ') || '꾸미기에서 팔로우 문구와 핸들을 넣으세요')}</div>` : ''}
      <div class="design-box" ${open ? '' : 'hidden'}>
        <div class="design-grid">
          ${layouts.length ? `<label><span>배치</span><select class="input pos" data-f="layout">${layouts.map((l) => `<option value="${l}" ${l === layout ? 'selected' : ''}>${LAYOUT_NAME[l]}</option>`).join('')}</select></label>` : ''}
          <label><span>글자 크기</span><select class="input pos" data-f="textScale">${TEXT_SCALES.map((t) => `<option value="${t.value}" ${t.value === (card.textScale || 1) ? 'selected' : ''}>${t.name}</option>`).join('')}</select></label>
          ${!isOutro ? `<label><span>글 위치</span><select class="input pos" data-f="textPos">${(Object.keys(TEXT_POS_NAME) as TextPos[]).map((k) => `<option value="${k}" ${k === (card.textPos || 'auto') ? 'selected' : ''}>${TEXT_POS_NAME[k]}</option>`).join('')}</select></label>` : ''}
          ${src ? `<label><span>그림 자르기</span><select class="input pos" data-f="imgPos"><option value="top" ${pos === 'top' ? 'selected' : ''}>위</option><option value="center" ${pos === 'center' ? 'selected' : ''}>가운데</option><option value="bottom" ${pos === 'bottom' ? 'selected' : ''}>아래</option></select></label>` : ''}
        </div>
        <div class="design-line">
          ${isBody ? `<input class="input" data-f="label" placeholder="머리말 (예: 전환 · 비워도 됨)" aria-label="머리말" value="${esc(card.label)}">` : ''}
          <label class="chk" title="${isBody ? '카드 위에 머리말을 보여 줍니다' : '카드 위에 시리즈 이름을 보여 줍니다'}"><input type="checkbox" data-f="showLabel" ${card.showLabel ? 'checked' : ''}> ${isBody ? '머리말 보이기' : '시리즈 줄 보이기'}</label>
          ${isBody ? `<label class="chk" title="제목과 막대를 강조색으로"><input type="checkbox" data-f="accent" ${card.accent ? 'checked' : ''}> 강조 카드</label>` : ''}
        </div>
        ${isBody ? `<input class="input" data-f="title" placeholder="${layout === 'quote' ? '말한 사람 (선택, 예: 지수)' : '소제목 (선택)'}" aria-label="${layout === 'quote' ? '말한 사람' : '소제목'}" value="${esc(card.title)}">` : ''}
      </div>
      <div class="meta">
        <span class="kind">${KIND_NAME[card.kind]}${isCover ? ' · 훅은 25자 안팎' : ''}${isOutro ? ' · 60자 이내' : ''}</span>
        <button class="design-toggle" type="button" data-act="design" aria-expanded="${open}">${open ? '디자인 접기' : '디자인'}${!open && summary.length ? `<span class="sum">${esc(summary.join(' · '))}</span>` : ''}</button>
        <span class="count"></span>
        <button class="btn tiny" type="button" data-act="rewrite" ${!online() || (isOutro && work.outroKind === 'none') ? 'disabled' : ''}>${isCover ? '훅 다시' : '다시 쓰기'}</button>
      </div>
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
  thumbSigs.length = 0;
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
    if (card.kind === 'body') { tb.draggable = true; tb.title = `${i + 1}번 · 끌어서 순서 바꾸기`; }
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

/** Shows card i for editing: the 카드 step, the card selected and scrolled to, and with `focus` its words ready to type. */
function goCard(i: number, focus = false) {
  setTab('cards', false);
  select(i);
  const row = $('cardList').querySelector<HTMLElement>(`.card-row[data-i="${i}"]`);
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (focus) row?.querySelector<HTMLElement>('textarea[data-f="text"], input[data-f="title"]')?.focus({ preventScroll: true });
}

/** Moves a body card to another body position (dragging thumbnails). */
function moveCard(from: number, to: number) {
  if (from === to || from < 1 || to < 1 || from > BODY_COUNT || to > BODY_COUNT) return;
  pushUndo();
  const [c] = work.cards.splice(from, 1);
  work.cards.splice(to, 0, c);
  current = to;
  save(); buildCardList(); scheduleRender(); scheduleReview();
  undoToast(`${from + 1}번 카드를 ${to + 1}번 자리로 옮겼어요.`);
}

function wireThumbDrag() {
  const thumbs = $('thumbs');
  let from = -1;
  const indexOf = (e: Event) => { const b = (e.target as HTMLElement).closest('button'); return b ? [...thumbs.children].indexOf(b) : -1; };
  const clear = () => thumbs.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((b) => b.classList.remove('drop-before', 'drop-after', 'dragging'));
  thumbs.addEventListener('dragstart', (e) => {
    const i = indexOf(e);
    if (i < 1 || i > BODY_COUNT) { e.preventDefault(); return; }
    from = i;
    e.dataTransfer?.setData('text/plain', String(i));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    thumbs.children[i].classList.add('dragging');
  });
  thumbs.addEventListener('dragover', (e) => {
    const i = indexOf(e);
    if (from < 0 || i < 1 || i > BODY_COUNT) return;
    e.preventDefault();
    clear();
    thumbs.children[from].classList.add('dragging');
    if (i !== from) thumbs.children[i].classList.add(i < from ? 'drop-before' : 'drop-after');
  });
  thumbs.addEventListener('drop', (e) => {
    e.preventDefault();
    const i = indexOf(e);
    const f = from;
    from = -1; clear();
    if (f > 0 && i > 0) moveCard(f, i);
  });
  thumbs.addEventListener('dragend', () => { from = -1; clear(); });
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
  if (act === 'design') {
    if (designAll) { designAll = false; $<HTMLInputElement>('designAll').checked = false; try { localStorage.setItem('cardnovel.designAll', '0'); } catch { /* fine */ } work.cards.forEach((c) => designOpen.add(c.id)); }
    if (designOpen.has(card.id)) designOpen.delete(card.id); else designOpen.add(card.id);
    refreshRow(i);
    $('cardList').querySelector<HTMLElement>(`.card-row[data-i="${i}"] [data-act="design"]`)?.focus();
    return;
  }
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
    await keepVersion('draw');
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

  if (hasWork) await keepVersion('compose');
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
    void keepStorage();
    const styleNote = r.usedAI && work.style.preset === 'ai' ? ` 그림체 제안: ${work.style.name}.` : '';
    setStatus(st, `20장 구성을 마쳤어요.${styleNote} 아래에서 다듬고 그림을 그려 보세요.${!ai && r.mode === 'split' ? ' (AI 키가 없어 장면 설명·그림체 제안은 비워 두었어요.)' : ''}`);
    setTab('cards');
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
  await keepVersion('leave');
  work = nextEpisodeWork(from, defaults(), nextEpisodeNumber(all, from.series));
  lastTimedVersion = Date.now();
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

/** What each thumbnail was last drawn from; unchanged cards are not redrawn. */
const thumbSigs: string[] = [];
const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));
let offCanvas: HTMLCanvasElement | null = null;

async function renderPreview() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try {
    // the card being edited first, so typing shows at once
    const H = cardHeight(work);
    const sc = stage();
    if (sc.height !== H) sc.height = H;
    document.documentElement.style.setProperty('--card-ar', `1080 / ${H}`);
    await ensureFonts(work);
    await renderCard(sc.getContext('2d')!, work, current);
    $('pagerText').textContent = `${current + 1} / ${TOTAL_CARDS}`;
    $('mPagerText').textContent = `${current + 1} / ${TOTAL_CARDS}`;
    paintMini();
    document.querySelectorAll('#thumbs button').forEach((b, i) => b.classList.toggle('active', i === current));
    document.querySelectorAll('.card-row').forEach((r, i) => r.classList.toggle('active', i === current));

    // then the thumbnails that changed, one at a time, giving way to the next keystroke
    if (!offCanvas) offCanvas = document.createElement('canvas');
    const off = offCanvas;
    if (off.width !== W) off.width = W;
    if (off.height !== H) off.height = H;
    const octx = off.getContext('2d')!;
    const look = lookSig(work);
    const th = Math.round((112 * H) / W);
    for (let i = 0; i < work.cards.length; i++) {
      if (renderAgain) break;
      const tc = thumbCanvases[i];
      if (!tc) continue;
      const sig = cardSig(work, i, look);
      if (thumbSigs[i] === sig && tc.height === th) continue;
      if (tc.height !== th) tc.height = th;
      if (i === current) octx.drawImage(sc, 0, 0); else await renderCard(octx, work, i);
      const x = tc.getContext('2d')!;
      x.clearRect(0, 0, tc.width, tc.height);
      x.drawImage(off, 0, 0, W, H, 0, 0, tc.width, tc.height);
      thumbSigs[i] = sig;
      await yieldToBrowser();
    }
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
  renderProof(app);
  renderFinishBox(app);
  renderStepStatus();
  renderPrecheck(app);
  void renderTextAI();
  void renderImageAI();
  scheduleRender();
}

/* ================= settings ================= */
type SettingsPane = 'keys' | 'defaults' | 'prices' | 'connect';
const PANE_NAME: Record<SettingsPane, string> = { keys: 'AI 키', defaults: '새 작품 기본값', prices: '가격 · 품질', connect: '연결' };
/** A Google OAuth web client ID looks like 1234567890-abc123.apps.googleusercontent.com */
const isGoogleClientId = (s: string): boolean => /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(s);

function openSettings(pane: SettingsPane = 'keys') {
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
    <div class="seg set-tabs" id="setTabs" role="tablist">${(Object.keys(PANE_NAME) as SettingsPane[]).map((k) => `<button type="button" role="tab" data-pane="${k}">${PANE_NAME[k]}${k === 'keys' ? `<small>${(['anthropic', 'google', 'openai'] as const).filter((p) => settings.keys[p]).length}/3</small>` : ''}</button>`).join('')}</div>
    <div class="scroll">
      <div class="set-pane" data-pane="keys">
      <div class="warn">API 키는 이 기기의 브라우저에만 저장되고, 해당 AI 회사로만 보내요. 공용 기기에서는 쓰지 말고, 각 회사 콘솔에서 월 사용 한도를 걸어 두세요.</div>
      <div class="stack" style="margin-top:14px">
        ${keyRow('anthropic', 'Anthropic (Claude 글 · Claude SVG 그림)', 'sk-ant-…')}
        ${keyRow('google', 'Google AI Studio (Gemini 글 · Gemini 이미지)', 'AIza…')}
        ${keyRow('openai', 'OpenAI (GPT 글 · GPT 이미지 · GPT 낭독)', 'sk-…')}
      </div>
      </div>
      <div class="set-pane" data-pane="defaults">
      <p class="hint" style="margin-bottom:12px">새로 만드는 작품에 처음부터 들어가는 값이에요. 지금 작품은 「꾸미기」에서 바꿔요.</p>
      <div class="row two">
        <div class="field"><label for="setSeries">시리즈 이름</label><input class="input" id="setSeries" value="${esc(settings.series)}"></div>
        <div class="field"><label for="setHandle">작가 핸들</label><input class="input" id="setHandle" value="${esc(settings.handle)}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="setFollow">팔로우 문구 (마지막 장)</label><input class="input" id="setFollow" value="${esc(settings.follow)}"></div>
      </div>
      <div class="set-pane" data-pane="prices">
      <div class="section-title" style="margin-top:0">그림 가격</div>
      <div class="row three">
        <div class="field"><label for="priceGemini">Gemini 장당 $</label><input class="input" id="priceGemini" type="number" step="0.01" min="0" value="${settings.prices.gemini}"></div>
        <div class="field"><label for="priceOpenai">GPT 장당 $</label><input class="input" id="priceOpenai" type="number" step="0.01" min="0" value="${settings.prices.openai}"></div>
        <div class="field"><label for="priceClaude">Claude SVG 장당 $</label><input class="input" id="priceClaude" type="number" step="0.01" min="0" value="${settings.prices.claude}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="claudeTier">Claude SVG 품질</label>
        <select class="input" id="claudeTier"><option value="quick" ${settings.claudeArtTier === 'quick' ? 'selected' : ''}>빠름 (장당 몇 초)</option><option value="detailed" ${settings.claudeArtTier === 'detailed' ? 'selected' : ''}>정밀 (장당 30초 안팎)</option></select>
      </div>
      <div class="section-title">낭독 가격</div>
      <div class="row two">
        <div class="field"><label for="ttsOpenai">GPT 낭독 1,000자당 $</label><input class="input" id="ttsOpenai" type="number" step="0.005" min="0" value="${settings.ttsPrices.openai}"></div>
        <div class="field"><label for="ttsGoogle">Gemini 낭독 1,000자당 $</label><input class="input" id="ttsGoogle" type="number" step="0.005" min="0" value="${settings.ttsPrices.google}"></div>
      </div>
      <p class="hint" style="margin-top:16px">가격은 자주 바뀌어요. 각 회사 가격표를 보고 맞춰 두면 그림 그리기·낭독 전에 예상 비용을 보여 주고, 사용량에도 이 값으로 계산해요.</p>
      </div>
      <div class="set-pane" data-pane="connect">
      <div class="section-title" style="margin-top:0">공유 링크</div>
      <div class="key-row" id="shareKeyRow">
        <div class="field"><label for="shareKey">공유 열쇠 (서버의 SHARE_KEY)</label><input class="input" id="shareKey" type="password" autocomplete="off" spellcheck="false" placeholder="${settings.shareKey ? maskKey(settings.shareKey) + ' 저장됨' : 'cn-…'}"></div>
        <button class="btn primary" type="button" data-a="shareSave">확인·저장</button>
        <button class="btn" type="button" data-a="shareDel" ${settings.shareKey ? '' : 'disabled'}>지우기</button>
        <div class="state" data-state></div>
      </div>
      <div class="section-title">구글 드라이브 백업</div>
      <p class="hint" style="margin-bottom:10px">작품을 내 구글 드라이브의 「${esc(FOLDER_NAME)}」 폴더에 작품마다 파일 하나로 백업하고, 다른 기기에서 이어서 열 수 있어요. 처음 한 번, 내 구글 계정으로 <b>OAuth 클라이언트 ID</b>를 만들어 아래 칸에 넣으면 돼요(10분쯤, 무료).${DEFAULT_GOOGLE_CLIENT_ID ? ' 이 앱에는 기본 ID가 들어 있어 비워 둬도 돼요.' : ''}</p>
      <div class="field"><label for="googleClientId">Google OAuth 클라이언트 ID</label><input class="input" id="googleClientId" spellcheck="false" autocomplete="off" placeholder="${esc(DEFAULT_GOOGLE_CLIENT_ID || '1234567890-abc….apps.googleusercontent.com')}" value="${esc(settings.googleClientId)}"><span class="state" id="gcidState"></span></div>
      <details class="guide" id="driveGuide" ${settings.googleClientId || DEFAULT_GOOGLE_CLIENT_ID ? '' : 'open'}>
        <summary>클라이언트 ID 만드는 법 (처음 한 번)</summary>
        <ol>
          <li><b>Google Cloud 콘솔 열기</b><span><a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a>에 드라이브를 쓸 구글 계정으로 로그인해요. 처음이면 국가를 고르고 약관에 동의해요.</span></li>
          <li><b>프로젝트 만들기</b><span>맨 위 프로젝트 선택 상자 → 「새 프로젝트」 → 이름 <code>cardnovel</code> → 「만들기」. 다 만들어지면 위 상자에서 그 프로젝트가 선택돼 있는지 확인해요.</span></li>
          <li><b>Google Drive API 켜기</b><span>맨 위 검색창에 <code>Google Drive API</code>를 쳐서 결과를 누르고 「사용」을 눌러요. (<a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">바로 가기</a>)</span></li>
          <li><b>동의 화면 만들기</b><span>왼쪽 메뉴 「API 및 서비스 → OAuth 동의 화면」(화면에 따라 「Google 인증 플랫폼」) → 「시작하기」. 앱 이름 <code>카드소설 제작소</code>, 사용자 지원 이메일은 내 이메일 → 대상은 <b>외부</b> → 연락처 이메일 → 동의 → 「만들기」.</span></li>
          <li><b>나를 테스트 사용자로 넣기</b><span>「대상」 → 「테스트 사용자」의 「+ Add users」 → 드라이브를 쓸 구글 계정 주소 → 「저장」. 게시 상태는 「테스트」 그대로 두면 돼요. 그러면 나와 넣은 사람만 쓸 수 있어요.</span></li>
          <li><b>권한 범위 넣기</b><span>「데이터 액세스」 → 「범위 추가 또는 삭제」 → 목록에서 <code>.../auth/drive.file</code>을 체크(안 보이면 아래 칸에 붙여 넣고 「테이블에 추가」) → 「업데이트」 → 「저장」. 이 앱은 자기가 만든 파일만 볼 수 있어요.</span></li>
          <li><b>클라이언트 ID 만들기</b><span>「클라이언트」 → 「+ 클라이언트 만들기」(예전 화면: 「사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID」). 애플리케이션 유형 <b>웹 애플리케이션</b>, 이름은 아무거나. 「승인된 자바스크립트 원본」 → 「+ URI 추가」에 이 주소를 그대로 넣어요:
            <span class="copy-line"><code id="originText">${esc(location.origin)}</code><button class="btn tiny" type="button" data-a="copyOrigin">복사</button></span>
            다른 주소(예: https://3m-novel.vercel.app)로도 쓰면 그 주소도 하나 더 넣어요. 「승인된 리디렉션 URI」는 비워 두고 「만들기」.</span></li>
          <li><b>ID 붙여 넣기</b><span>나온 창의 「클라이언트 ID」(<code>….apps.googleusercontent.com</code>으로 끝나요)를 복사해 위 칸에 붙여 넣고 「저장하고 닫기」. 「클라이언트 보안 비밀번호」는 필요 없어요. 클라이언트 ID는 비밀번호가 아니라 남에게 보여도 괜찮아요.</span></li>
          <li><b>연결하기</b><span>「보관함 → 구글 드라이브 백업 → 드라이브 연결」 → 구글 계정을 고르고 허용해요. 「Google에서 확인하지 않은 앱」 창이 뜨면 내가 만든 앱이라 괜찮아요: 「고급」 → 「카드소설 제작소(으)로 이동」 → 「계속」.</span></li>
        </ol>
        <div class="guide-help"><b>잘 안 될 때</b>
          <ul>
            <li><code>origin_mismatch</code> · <code>redirect_uri_mismatch</code> 오류: 7번의 자바스크립트 원본이 지금 주소(<code>${esc(location.origin)}</code>)와 똑같은지 확인해요. 끝에 <code>/</code>를 붙이지 않아요. 고친 뒤 반영까지 5분쯤 걸릴 수 있어요.</li>
            <li><code>access_denied</code>(403) 오류: 5번 테스트 사용자에 지금 로그인한 계정을 넣었는지 확인해요.</li>
            <li>「Google Drive API has not been used…」: 3번을 같은 프로젝트에서 했는지 확인해요.</li>
            <li>로그인 창이 안 열려요: 브라우저의 팝업 차단을 이 사이트만 풀어 주세요.</li>
            <li>연결은 한 시간쯤 이어져요. 그 뒤에는 보관함에서 「드라이브 연결」을 한 번 더 누르면 돼요.</li>
            <li>데스크톱 앱은 저장 공간이 따로라 그 앱의 설정에도 같은 ID를 넣어요. 데스크톱 앱에서 구글 로그인 창이 막히면 웹(${esc(location.origin)})에서 백업해요.</li>
          </ul>
        </div>
      </details>
      </div>
    </div>
    <div class="toolbar" style="margin-top:16px"><span class="hint" style="margin-right:auto">앱 빌드 ${esc(BUILD)}</span><button class="btn primary" type="button" data-a="done">저장하고 닫기</button></div>`,
  {
    size: 'mid',
    wire: (box, close) => {
      box.querySelector('[data-a="close"]')!.addEventListener('click', close);
      const show = (p: SettingsPane) => {
        box.querySelectorAll<HTMLButtonElement>('#setTabs button').forEach((b) => { const on = b.dataset.pane === p; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
        box.querySelectorAll<HTMLElement>('.set-pane').forEach((el) => { el.hidden = el.dataset.pane !== p; });
      };
      box.querySelectorAll<HTMLButtonElement>('#setTabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.pane as SettingsPane)));
      show(pane);
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
      box.querySelector('[data-a="copyOrigin"]')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(location.origin); toast('주소를 복사했어요.'); } catch { toast('복사가 막혔어요. 주소를 직접 골라 복사해 주세요.'); }
      });
      box.querySelector('[data-a="done"]')!.addEventListener('click', async () => {
        const v = (id: string) => (box.querySelector<HTMLInputElement>('#' + id)!.value);
        const gcid = v('googleClientId').trim();
        if (gcid && !isGoogleClientId(gcid)) {
          show('connect');
          const st = box.querySelector<HTMLElement>('#gcidState')!;
          st.textContent = /GOCSPX|secret/i.test(gcid) ? '이건 「클라이언트 보안 비밀번호」 같아요. 「클라이언트 ID」(….apps.googleusercontent.com)를 넣어 주세요.' : '클라이언트 ID는 ….apps.googleusercontent.com 으로 끝나요. 다시 복사해 주세요.';
          st.className = 'state bad';
          box.querySelector<HTMLInputElement>('#googleClientId')!.focus();
          return;
        }
        settings.googleClientId = gcid;
        settings.series = v('setSeries').trim();
        settings.handle = v('setHandle').trim();
        settings.follow = v('setFollow').trim();
        settings.prices = { gemini: Number(v('priceGemini')) || 0, openai: Number(v('priceOpenai')) || 0, claude: Number(v('priceClaude')) || 0 };
        settings.claudeArtTier = v('claudeTier') === 'detailed' ? 'detailed' : 'quick';
        settings.ttsPrices = { openai: Math.max(0, Number(v('ttsOpenai')) || 0), google: Math.max(0, Number(v('ttsGoogle')) || 0) };
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
  let all = await works.all();
  for (const id of await purgeTrash().catch(() => [] as string[])) void deleteAllVersions(id).catch(() => undefined);
  const pref = (() => { try { return JSON.parse(localStorage.getItem('cardnovel.lib') || '{}') as { sort?: LibSort; group?: boolean }; } catch { return {}; } })();
  let query = '', sort: LibSort = pref.sort && pref.sort in LIB_SORT_NAME ? pref.sort : 'recent', grouped = pref.group !== false, showTrash = false;
  const remember = () => { try { localStorage.setItem('cardnovel.lib', JSON.stringify({ sort, group: grouped })); } catch { /* fine */ } };
  const item = (w: Work) => `
    <div class="work ${w.id === work.id ? 'current' : ''}" data-id="${esc(w.id)}">
      ${w.thumb ? `<img alt="" src="${w.thumb}">` : '<div class="noimg">그림 없음</div>'}
      <div><b>${w.episode ? `<span class="ep">${w.episode}화</span>` : ''}${esc(w.name || workTitle(w))}</b><span>${fmtDate(w.updatedAt)} · ${w.cards.filter((c) => c.text.trim()).length}/20장 글 · ${w.cards.filter((c) => c.img || c.svg).length}장 그림${w.posts?.length ? ` · 게시 ${w.posts.length}번` : ''}</span></div>
      <div class="acts">
        ${w.id === work.id ? '<span class="hint">지금 작업</span>' : '<button class="btn small" type="button" data-a="open">열기</button>'}
        <button class="btn small" type="button" data-a="copy">사본</button>
        <button class="btn small" type="button" data-a="export">내보내기</button>
        <button class="btn small" type="button" data-a="del" ${w.id === work.id ? 'disabled title="지금 작업 중인 작품은 다른 작품을 연 뒤 지울 수 있어요"' : ''}>삭제</button>
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
  const listHTML = (): string => {
    if (!all.length) return '<div class="empty-note">아직 저장된 작품이 없어요.</div>';
    const found = filterWorks(all, query, sort);
    if (!found.length) return `<div class="empty-note">‘${esc(query)}’에 맞는 작품이 없어요.</div>`;
    if (query.trim() || !grouped) return `${query.trim() ? `<p class="hint lib-count">${found.length}편 찾았어요</p>` : ''}${found.map(item).join('')}`;
    const groups = groupBySeries(found);
    const key = (g: { name: string; works: Work[] }) => sort === 'created' ? -Math.max(...g.works.map((w) => w.createdAt || 0)) : sort === 'recent' ? -Math.max(...g.works.map((w) => w.updatedAt || 0)) : 0;
    if (sort === 'title' || sort === 'episode') groups.sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name, 'ko'));
    else groups.sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || key(a) - key(b));
    return groups.map(group).join('');
  };
  const trashHTML = async (): Promise<string> => {
    const list = await listTrash();
    return `<div class="trash-head"><button class="btn small" type="button" data-a="back">← 보관함으로</button><span class="hint">지운 작품은 ${TRASH_DAYS}일 동안 여기 있어요.</span>${list.length ? '<button class="btn small" type="button" data-a="emptyTrash">휴지통 비우기</button>' : ''}</div>
      ${list.length ? list.map((e) => `<div class="work trashed" data-tid="${esc(e.id)}">
        ${e.thumb ? `<img alt="" src="${e.thumb}">` : '<div class="noimg">그림 없음</div>'}
        <div><b>${e.episode ? `<span class="ep">${e.episode}화</span>` : ''}${esc(e.title)}</b><span>${fmtDate(e.deletedAt)}에 지움 · ${daysLeft(e)}일 뒤 완전히 지워져요</span></div>
        <div class="acts"><button class="btn small tonal" type="button" data-a="restore">되살리기</button><button class="btn small" type="button" data-a="purge">영구 삭제</button></div>
      </div>`).join('') : '<div class="empty-note">휴지통이 비어 있어요.</div>'}`;
  };
  openModal(`
    <div class="panel-head"><h2>작품 보관함</h2>
      <div class="toolbar">
        <button class="btn small primary" type="button" data-a="new">새 작품</button>
        <button class="btn small" type="button" data-a="import">가져오기</button>
        <button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>
      </div>
    </div>
    <div class="drive-box" id="driveBox"></div>
    <p class="hint" style="margin:0 0 12px">작업은 바뀔 때마다 이 기기에 자동 저장돼요. 같은 시리즈 이름끼리 묶이고, 「다음 회 만들기」는 그림체·인물 기준 그림·테마를 그대로 가져가요. <span id="storageNote"></span></p>
    <div class="lib-tools">
      <input class="input" id="libSearch" type="search" placeholder="제목·시리즈·카드 글로 찾기 (ㅁㅊ처럼 초성도 돼요)" aria-label="작품 찾기" autocomplete="off">
      <select class="input" id="libSort" aria-label="정렬">${(Object.keys(LIB_SORT_NAME) as LibSort[]).map((k) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${LIB_SORT_NAME[k]}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="libGroup" ${grouped ? 'checked' : ''}> 시리즈로 묶기</label>
      <button class="btn small" type="button" data-a="trash">휴지통<span id="trashCount"></span></button>
    </div>
    <div class="lib" id="libList">${listHTML()}</div>`,
  {
    size: 'wide',
    wire: (box, close) => {
      const list = box.querySelector<HTMLElement>('#libList')!;
      const tools = box.querySelector<HTMLElement>('.lib-tools')!;
      const paint = async () => {
        tools.classList.toggle('dim', showTrash);
        list.innerHTML = showTrash ? await trashHTML() : listHTML();
        const n = (await listTrash()).length;
        box.querySelector('#trashCount')!.textContent = n ? ` ${n}` : '';
      };
      void paint();
      box.querySelector('[data-a="close"]')!.addEventListener('click', close);
      void renderDriveBox(box.querySelector<HTMLElement>('#driveBox')!, app, driveDeps, close);
      void (async () => {
        try {
          const est = await navigator.storage?.estimate?.();
          const kept = await navigator.storage?.persisted?.();
          const el = box.querySelector('#storageNote');
          if (el && est?.usage !== undefined) el.textContent = `이 기기에 ${(est.usage / 1048576).toFixed(0)}MB 사용 중${kept ? ' · 브라우저가 지우지 않게 보관 중' : ' · 저장 공간이 모자라면 브라우저가 지울 수 있으니 드라이브 백업이나 내보내기를 해 두세요'}.`;
        } catch { /* not supported */ }
      })();
      const search = box.querySelector<HTMLInputElement>('#libSearch')!;
      search.addEventListener('input', () => { query = search.value; showTrash = false; void paint(); });
      box.querySelector<HTMLSelectElement>('#libSort')!.addEventListener('change', (e) => { sort = (e.target as HTMLSelectElement).value as LibSort; remember(); void paint(); });
      box.querySelector<HTMLInputElement>('#libGroup')!.addEventListener('change', (e) => { grouped = (e.target as HTMLInputElement).checked; remember(); void paint(); });
      box.querySelector('[data-a="trash"]')!.addEventListener('click', () => { showTrash = !showTrash; void paint(); });
      box.querySelector('[data-a="new"]')!.addEventListener('click', async () => { close(); await startNewWork(); });
      box.querySelector('[data-a="import"]')!.addEventListener('click', () => { const f = $<HTMLInputElement>('libFile'); f.value = ''; f.click(); close(); });
      list.addEventListener('click', async (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
        if (!b) return;
        const a = b.dataset.a!;
        if (a === 'back') { showTrash = false; void paint(); return; }
        if (a === 'emptyTrash') {
          for (const id of await purgeTrash(Date.now(), true)) void deleteAllVersions(id).catch(() => undefined);
          void paint(); toast('휴지통을 비웠어요.'); return;
        }
        if (a === 'next') { close(); void startNextEpisode(b.dataset.id!); return; }
        const tid = b.closest<HTMLElement>('[data-tid]')?.dataset.tid;
        if (tid) {
          if (a === 'restore') {
            const w = await takeFromTrash(tid);
            if (w) { await works.put(w); all = await works.all(); toast(`「${w.name || workTitle(w)}」을(를) 되살렸어요.`); }
          } else if (a === 'purge') {
            if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '정말 지울까요?'; b.classList.add('danger'); return; }
            await dropFromTrash(tid);
            void deleteAllVersions(tid).catch(() => undefined);
          }
          void paint(); return;
        }
        const id = b.closest<HTMLElement>('.work')?.dataset.id;
        if (!id) return;
        if (a === 'open') {
          await persist(true);
          const w = await works.get(id);
          if (!w) return;
          await openWork(w);
          close();
        } else if (a === 'copy') {
          const w = id === work.id ? work : await works.get(id);
          if (!w) return;
          const copy: Work = { ...JSON.parse(JSON.stringify(w)), id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: `${w.name || workTitle(w)} · 사본 ${fmtDate(Date.now())}`, createdAt: Date.now(), updatedAt: Date.now() };
          await works.put(copy);
          all = await works.all(); void paint();
          toast('사본을 만들었어요.');
        } else if (a === 'export') {
          const w = id === work.id ? work : await works.get(id);
          if (!w) return;
          download(new Blob([JSON.stringify({ app: 'cardnovel', version: 1, work: w })], { type: 'application/json' }), `${fileBase(w)}.cardnovel.json`);
        } else if (a === 'del') {
          if (id === work.id) return;
          const w = await works.get(id);
          if (!w) return;
          await moveToTrash(w);
          await works.del(id);
          all = all.filter((x) => x.id !== id);
          void paint();
          toast(`「${w.name || workTitle(w)}」을(를) 휴지통으로 옮겼어요.`, 6500, { label: '되살리기', run: async () => {
            const back = await takeFromTrash(id);
            if (!back) return;
            await works.put(back);
            all = await works.all();
            if (box.isConnected) void paint();
            toast('되살렸어요.');
          } });
        }
      });
    },
  });
}

async function startNewWork() {
  await persist(true);
  await keepVersion('leave');
  work = newWork(defaults());
  lastTimedVersion = Date.now();
  current = 0; undoStack.length = 0; $<HTMLButtonElement>('btnUndo').disabled = true;
  save(); renderAllUI(); setTab('story');
  toast('새 작품을 시작했어요.');
}

/* ================= quick run (Ctrl/⌘+K) ================= */
function paletteCommands(): Command[] {
  const click = (id: string, tab?: Tab) => () => { if (tab) setTab(tab); document.getElementById(id)?.click(); };
  const cmds: Command[] = [
    { id: 'step:story', group: '단계', title: '이야기로 가기', keywords: '원고 줄거리 입력 1', run: () => setTab('story') },
    { id: 'step:cards', group: '단계', title: '카드 편집으로 가기', keywords: '카드 2', run: () => setTab('cards') },
    { id: 'step:review', group: '단계', title: '다듬기로 가기 (평가 · 교정)', keywords: '다듬기 평가 교정 3', run: () => setTab('review') },
    { id: 'step:look', group: '단계', title: '꾸미기로 가기', keywords: '테마 비율 서체 워터마크', run: () => setTab('look') },
    { id: 'step:export', group: '단계', title: '내보내기로 가기', keywords: '저장 공유 올리기', run: () => setTab('export') },
    { id: 'compose', group: '만들기', title: '카드로 만들기', keywords: '구성 생성', run: click('btnCompose', 'story') },
    { id: 'artAll', group: '만들기', title: '모든 그림 그리기', keywords: '그림 이미지', run: click('btnArtAll', 'cards') },
    { id: 'review', group: '다듬기', title: 'AI 평가 받기', keywords: '점수 리뷰', run: click('btnReview', 'review') },
    { id: 'proof', group: '다듬기', title: '일괄 교정하기', keywords: '맞춤법 띄어쓰기 문장부호 교정', run: click('btnProof', 'review') },
    { id: 'undo', group: '다듬기', title: '되돌리기', hint: 'Ctrl+Z', run: () => undo() },
    { id: 'versions', group: '다듬기', title: '버전 기록', keywords: '히스토리 복원', run: click('btnVersions') },
    { id: 'designAll', group: '다듬기', title: designAll ? '디자인 칸 모두 접기' : '디자인 칸 모두 펼치기', keywords: '배치 글자 크기 위치', run: () => { setTab('cards'); click('designAll')(); } },
    { id: 'check', group: '올리기', title: '게시 전 점검', keywords: '확인 체크', run: () => { setTab('export'); const d = document.querySelector<HTMLDetailsElement>('#precheckBox details'); if (d) d.open = true; } },
    { id: 'caption', group: '올리기', title: '캡션 · 해시태그', keywords: '게시글 태그', run: () => openCaptionHelper() },
    { id: 'copyCaption', group: '올리기', title: '캡션 복사', run: () => void copyCaption() },
    { id: 'zip', group: '올리기', title: '전체 ZIP 저장', keywords: '다운로드 20장', run: () => void saveAll() },
    { id: 'saveOne', group: '올리기', title: '이 카드만 저장', run: () => void saveOne() },
    { id: 'share', group: '올리기', title: '인스타로 공유 (20장)', run: () => void share() },
    { id: 'insta', group: '올리기', title: '인스타 미리보기', run: click('btnInsta') },
    { id: 'reels', group: '올리기', title: '릴스 영상 만들기', keywords: '영상 동영상 낭독', run: click('btnReels') },
    { id: 'shareLink', group: '올리기', title: '공유 링크 만들기', run: click('btnShareLink') },
    { id: 'posts', group: '올리기', title: '게시 기록 · 성과', keywords: '좋아요 저장 참여율 통계', run: click('btnPosts') },
    { id: 'library', group: '작품', title: '보관함 열기', keywords: '작품 목록 휴지통', run: () => void openLibrary() },
    { id: 'new', group: '작품', title: '새 작품 시작', run: () => void startNewWork() },
    { id: 'next', group: '작품', title: '이 시리즈 다음 회 만들기', run: click('btnNextEpisode') },
    { id: 'bible', group: '작품', title: '설정집', keywords: '인물 장소 시리즈', run: click('btnBible') },
    { id: 'settings', group: '설정', title: '설정: AI 키', keywords: 'api key', run: () => openSettings('keys') },
    { id: 'settings:defaults', group: '설정', title: '설정: 새 작품 기본값', keywords: '핸들 팔로우', run: () => openSettings('defaults') },
    { id: 'settings:prices', group: '설정', title: '설정: 가격 · 품질', run: () => openSettings('prices') },
    { id: 'settings:connect', group: '설정', title: '설정: 연결 (공유 링크 · 드라이브)', keywords: '구글 드라이브', run: () => openSettings('connect') },
    { id: 'usage', group: '설정', title: '사용량 · 비용', keywords: '돈 요금', run: click('btnUsage') },
  ];
  for (const k of Object.keys(THEMES) as ThemeKey[]) cmds.push({ id: 'theme:' + k, group: '꾸미기', title: `테마: ${THEMES[k].name}`, run: () => { setTab('look'); document.querySelector<HTMLElement>(`#themes [data-k="${k}"]`)?.click(); } });
  for (const r of ['1:1', '4:5', '3:4', '9:16']) cmds.push({ id: 'ratio:' + r, group: '꾸미기', title: `비율: ${r}`, run: () => { setTab('look'); document.querySelector<HTMLElement>(`#ratioSeg [data-v="${r}"]`)?.click(); } });
  work.cards.forEach((c, i) => {
    const words = stripMarks(c.kind === 'cover' ? `${c.title} — ${c.text}` : c.text).replace(/\s+/g, ' ').trim();
    cmds.push({ id: `card:${i}`, group: '카드', title: `${String(i + 1).padStart(2, '0')}${c.kind === 'cover' ? ' 표지' : c.kind === 'outro' ? ' 마지막 장' : ''} ${words.slice(0, 40) || '(비어 있음)'}`, keywords: `${i + 1}번 카드`, run: () => goCard(i, true) });
  });
  return cmds;
}

async function openWork(w: Work, leaveVersion = true) {
  if (leaveVersion && work && w.id !== work.id) await keepVersion('leave');
  lastTimedVersion = Date.now();
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
    await keepVersion('leave');
    const existing = w.id ? await works.get(w.id) : null;
    if (existing) await keepVersion('drive', existing);
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

function openCaptionHelper() { openCaption(app); }

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
  if (!(await okToPost(app, '저장'))) return;
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
  if (!(await okToPost(app, '공유'))) return;
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
  $('btnSettings').addEventListener('click', () => openSettings());
  $('btnCaption').addEventListener('click', () => void copyCaption());
  $('btnSaveAll').addEventListener('click', () => void saveAll());
  $('btnSaveOne').addEventListener('click', () => void saveOne());
  $('btnShare').addEventListener('click', () => void share());
  $('btnInsta').addEventListener('click', () => void openInstaPreview(app));
  // the video encoder is loaded only when it is used
  $('btnReels').addEventListener('click', () => void import('./ui/reels').then((m) => m.openReels(app)).catch((e) => {
    if (isStaleChunkError(e) && online()) newVersionReady(app, 'missing');
    else toast('영상 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
  }));
  $('btnPosts').addEventListener('click', () => void import('./ui/posts').then((m) => m.openPosts(app)).catch((e) => {
    if (isStaleChunkError(e) && online()) newVersionReady(app, 'missing');
    else toast('게시 기록을 불러오지 못했어요.');
  }));
  $('btnShareLink').addEventListener('click', () => void makeShareLink(app, shareDeps, $<HTMLButtonElement>('btnShareLink')));
  $('btnShareList').addEventListener('click', () => void openShareList(app, shareDeps));
  $('btnUndo').addEventListener('click', undo);
  $('btnVersions').addEventListener('click', () => void openVersions(app, versionDeps));
  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const dialog = !$('modal').hidden;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      // the browser's "save page" would save the app itself: save the work instead
      e.preventDefault();
      void app.flush().then(() => toast('저장했어요.'));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!document.getElementById('palInput')) openPalette(paletteCommands);
      return;
    }
    if (dialog) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing) { e.preventDefault(); undo(); }
    if (!typing && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      select((current + (e.key === 'ArrowRight' ? 1 : TOTAL_CARDS - 1)) % TOTAL_CARDS);
    }
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
  wireProof(app);
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
  const net = () => { $('offlinePill').hidden = online(); buildCardList(); renderReview(app); renderProof(app); void renderImageAI(); scheduleRender(); };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);

  wireSplitter();
  wireMobile(app);
  wireSteps();
  restoreTabs(work.cards.some((c) => c.kind === 'body' && c.text.trim()));
  onTabChange((t) => { if (t === 'export') renderPrecheck(app); if (t === 'cards') paintMini(); });
  wireThumbDrag();
  stage().addEventListener('click', () => goCard(current, true));
  const da = $<HTMLInputElement>('designAll');
  da.checked = designAll;
  da.addEventListener('change', () => {
    designAll = da.checked; designOpen.clear();
    try { localStorage.setItem('cardnovel.designAll', designAll ? '1' : '0'); } catch { /* fine */ }
    work.cards.forEach((_, i) => refreshRow(i));
  });
  $('btnCaptionHelp').addEventListener('click', () => openCaptionHelper());
  $('btnPalette').addEventListener('click', () => openPalette(paletteCommands));
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
    // make sure the browser really kept the sign-in before saying so
    if ((await canvaStatus()) === false) {
      toast('Canva 로그인은 됐는데 이 브라우저에 연결 정보가 저장되지 않았어요. 이 사이트의 쿠키 차단을 풀고 「Canva 연결하기」를 다시 눌러 주세요.', 9000);
      return;
    }
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

/* ================= safety nets ================= */
function wireSafety() {
  // an unexpected error should not look like lost work
  let last = 0;
  const report = (msg: string) => {
    if (/ResizeObserver|AbortError|cancelled|Script error/i.test(msg)) return;
    console.error(msg);
    if (Date.now() - last < 10_000) return;
    last = Date.now();
    toast('잠깐 문제가 생겼어요. 작업은 저장돼 있어요. 계속되면 새로고침해 주세요.', 5000);
  };
  window.addEventListener('error', (e) => report(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => report(String((e.reason as Error)?.message || e.reason)));
  // web fonts arriving after the first drawing: draw the thumbnails again with them
  document.fonts?.addEventListener?.('loadingdone', () => { thumbSigs.length = 0; scheduleRender(); });
}

/** Asks the browser to keep this site's data (works live only here until backed up); once, after real work exists. */
async function keepStorage() {
  try {
    if (!navigator.storage?.persist || (await navigator.storage.persisted())) return;
    if (await kv.get<boolean>('storage.asked', false)) return;
    await kv.set('storage.asked', true);
    await navigator.storage.persist();
  } catch { /* not supported */ }
}

/* ================= start ================= */
async function start() {
  settings = await loadSettings();
  const id = await kv.get<string | null>('currentId', null);
  const saved = id ? await works.get(id) : null;
  work = saved ? normalizeWork(saved, defaults()) : newWork(defaults());
  if (!saved) await works.put(work);
  wire();
  wireSafety();
  onUsage((u) => void onUsageEvent(app, u));
  void renderUsagePill(app);
  $('offlinePill').hidden = online();
  renderAllUI();
  $('savedAt').textContent = saved ? `불러옴 · ${fmtDate(saved.updatedAt)}` : '';
  if (!settings.keys.anthropic && !settings.keys.google && !settings.keys.openai) {
    setStatus($('composeStatus'), '처음이라면 「설정」에서 AI 키를 하나 넣어 주세요. 나눈 원고는 키 없이도 카드로 만들 수 있어요.');
  }
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => watchForUpdates(app, reg, () => !composeCtl && !artCtl && !artBusy.size && $('modal').hidden))
      .catch(() => { /* offline support is optional */ });
  }
  await handleCanvaLanding();
  void startDriveSync(app, driveDeps);
}

void start();

// exposed for automated browser checks
declare global { interface Window { __cardnovel?: { work: () => Work } } }
window.__cardnovel = { work: () => work };
