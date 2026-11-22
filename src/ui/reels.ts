// 「릴스 영상」: options (time per card, transition, zoom, AI narration, music), progress, preview, save and share.
import type { App } from '../app';
import { aiMessage, AiError, listModels, type ModelInfo } from '../ai/providers';
import { download, fileBase } from '../export';
import { DEFAULT_TTS_MODEL, estimateSeconds, isCached, narrate, narrationScript, speak, STYLE_NAME, VOICE_NOTE, voicesFor, type Voice } from '../narration';
import { cardDurations, decodeMusic, makeReel, pickFormat, ReelError, totalDuration, type ReelOptions, type Transition } from '../reels';
import type { Narration, NarrationStyle } from '../settings';
import { money } from '../usage';
import { esc, openModal, toast } from './dom';

/** speech models per provider, fetched once per session */
const ttsModels: Partial<Record<Narration['provider'], ModelInfo[]>> = {};
const PROVIDER_LABEL: Record<Narration['provider'], string> = { openai: 'GPT', google: 'Gemini' };

const CODEC_NAME: Record<string, string> = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', aac: 'AAC', opus: 'Opus' };
const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초` : `${Math.round(s)}초`);

export async function openReels(app: App): Promise<void> {
  const w = app.work();
  const fmt = await pickFormat();
  let music: { name: string; buffer: AudioBuffer } | null = null;
  let ctl: AbortController | null = null;
  let url = '';
  const o: ReelOptions = { seconds: 'auto', transition: 'slide', zoom: true, music: null };
  const settings = app.settings();
  const keys = settings.keys;
  const hasKey = (p: Narration['provider']) => !!(p === 'openai' ? keys.openai : keys.google);
  const n: Narration = { ...settings.narration, model: { ...settings.narration.model }, voice: { ...settings.narration.voice } };
  if (!hasKey(n.provider) && hasKey(n.provider === 'openai' ? 'google' : 'openai')) n.provider = n.provider === 'openai' ? 'google' : 'openai';
  const canNarrate = hasKey('openai') || hasKey('google');
  if (!canNarrate) n.on = false;
  let player: { ctx: AudioContext; src: AudioBufferSourceNode } | null = null;
  const stopPlayer = () => { try { player?.src.stop(); void player?.ctx.close(); } catch { /* already stopped */ } player = null; };

  openModal(`
    <div class="panel-head"><h2>릴스 영상 만들기</h2><button class="btn icon" type="button" data-a="close" aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button></div>
    <div class="reel-grid">
      <div class="stack">
        ${fmt ? (fmt.ext === 'mp4' ? `<p class="hint">20장을 9:16 세로 영상(MP4 · ${CODEC_NAME[fmt.video] ?? fmt.video})으로 만들어요. 이 기기 안에서 만들어서 비용이 들지 않아요.</p>`
          : `<p class="warn">이 브라우저는 MP4를 만들 수 없어 WebM(${CODEC_NAME[fmt.video] ?? fmt.video})으로 만들어요. 인스타그램에는 MP4가 필요하니 Chrome·Edge·Safari 최신판에서 만들어 주세요.</p>`)
          : '<p class="warn">이 브라우저는 영상 만들기(WebCodecs)를 지원하지 않아요. Chrome·Edge·Safari 최신판에서 열어 주세요.</p>'}
        <div class="field"><label>장당 시간</label>
          <div class="seg" id="rlSec"><button type="button" data-v="auto" class="active">자동</button><button type="button" data-v="2.5">2.5초</button><button type="button" data-v="3.5">3.5초</button><button type="button" data-v="5">5초</button></div>
          <p class="hint" id="rlTotal"></p></div>
        <div class="field"><label>넘김 효과</label>
          <div class="seg" id="rlTr"><button type="button" data-v="slide" class="active">밀기</button><button type="button" data-v="fade">서서히</button><button type="button" data-v="none">없음</button></div></div>
        <label class="chk"><input type="checkbox" id="rlZoom" checked> 카드마다 천천히 확대</label>
        <div class="field narr">
          <label class="chk big"><input type="checkbox" id="rlNarr" ${n.on ? 'checked' : ''} ${canNarrate ? '' : 'disabled'}> AI 낭독 넣기</label>
          <p class="hint">${canNarrate ? '카드 글을 AI 목소리로 읽어 줘요. 카드마다 다 읽을 때까지 머물러요.' : '설정에 GPT나 Gemini 키를 넣으면 카드 글을 AI 목소리로 읽어 줄 수 있어요.'}</p>
          <div class="narr-box stack" id="rlNarrBox" ${n.on ? '' : 'hidden'}>
            <div class="seg" id="rlNP">${(['openai', 'google'] as const).map((p) => `<button type="button" data-v="${p}" class="${n.provider === p ? 'active' : ''}" ${hasKey(p) ? '' : 'disabled title="설정에서 키를 넣어 주세요"'}>${PROVIDER_LABEL[p]}</button>`).join('')}</div>
            <div class="row two">
              <div class="field"><label for="rlNModel">모델</label><select class="input" id="rlNModel"></select></div>
              <div class="field"><label for="rlNVoice">목소리</label><select class="input" id="rlNVoice"></select></div>
            </div>
            <div class="row two style-speed">
              <div class="field"><label for="rlNStyle">읽는 느낌</label><select class="input" id="rlNStyle">${(Object.keys(STYLE_NAME) as NarrationStyle[]).map((k) => `<option value="${k}" ${n.style === k ? 'selected' : ''}>${STYLE_NAME[k]}</option>`).join('')}</select></div>
              <div class="field"><label>빠르기</label><div class="seg" id="rlNSpeed">${[[1, '보통'], [1.15, '조금 빠르게'], [1.3, '빠르게']].map(([v, l]) => `<button type="button" data-v="${v}" class="${n.speed === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>
            </div>
            <label class="chk"><input type="checkbox" id="rlNOutro" ${n.readOutro ? 'checked' : ''}> 마지막 장의 팔로우 문구도 읽기</label>
            <div class="toolbar"><button class="btn small" type="button" data-a="hear">지금 카드 미리 듣기</button><button class="btn small" type="button" data-a="hush" hidden>멈추기</button></div>
            <p class="hint" id="rlNEst"></p>
          </div>
        </div>
        <div class="field"><label>배경음 (선택)</label>
          <div class="toolbar"><button class="btn small" type="button" data-a="music">음악 파일 고르기</button><span class="hint" id="rlMusic">없음</span><button class="btn small" type="button" data-a="nomusic" hidden>빼기</button></div>
          <div class="toolbar" id="rlVolRow" hidden><span class="hint">볼륨</span><input type="range" id="rlVol" min="0.1" max="1" step="0.05" value="0.7" style="max-width:200px"></div>
          <p class="hint">내가 쓸 권리가 있는 음악만 넣으세요. 낭독과 함께 넣으면 읽는 동안 음악이 작아져요.</p></div>
        <input type="file" id="rlFile" accept="audio/*" hidden>
      </div>
      <div class="reel-out">
        <div class="reel-video" id="rlOut"><span>여기에 영상이 나와요</span></div>
        <div class="progress" id="rlProg" hidden><i></i></div>
        <p class="status" id="rlStatus"></p>
        <div class="toolbar" id="rlActs" hidden><button class="btn primary" type="button" data-a="save">영상 저장</button><button class="btn" type="button" data-a="share">공유</button></div>
      </div>
    </div>
    <div class="toolbar" style="margin-top:14px"><span class="spacer"></span><button class="btn" type="button" data-a="stop" hidden>중단</button><button class="btn primary" type="button" data-a="make" ${fmt ? '' : 'disabled'}>영상 만들기</button></div>`,
  {
    size: 'wide',
    onClose: () => { ctl?.abort(); stopPlayer(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); },
    wire: (box, close) => {
      const q = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
      let result: { blob: Blob; ext: string } | null = null;
      const voice = (): Voice => ({ provider: n.provider, key: n.provider === 'openai' ? keys.openai : keys.google, model: n.model[n.provider] || DEFAULT_TTS_MODEL[n.provider], voice: n.voice[n.provider], style: n.style, speed: n.speed });
      const script = () => narrationScript(w, n.readOutro);
      const remember = () => { settings.narration = { ...n, model: { ...n.model }, voice: { ...n.voice } }; void app.saveSettings(); };
      const total = () => {
        const sc = n.on ? script() : null;
        const d = totalDuration(cardDurations(w, o.seconds, sc ? sc.map((t) => (t ? estimateSeconds(t, n.speed) : null)) : null));
        q('#rlTotal').textContent = `${n.on ? '약 ' : '총 '}${fmtSec(d)} · 카드 ${w.cards.length}장${d > 180 ? (n.on ? ' · 릴스는 3분까지예요. 빠르기를 올리거나 글을 줄여 주세요' : ' · 릴스는 3분까지라 장당 시간을 줄여 주세요') : ''}`;
        if (sc) {
          const v = voice();
          const all = sc.filter(Boolean), fresh = all.filter((t) => !isCached(v, t));
          const chars = fresh.reduce((a, t) => a + t.length, 0);
          const price = n.provider === 'openai' ? settings.ttsPrices.openai : settings.ttsPrices.google;
          q('#rlNEst').textContent = `${all.length}장 · ${all.reduce((a, t) => a + t.length, 0).toLocaleString()}자 읽음 · 예상 ${money((chars / 1000) * price)}${fresh.length < all.length ? ` (이미 만든 ${all.length - fresh.length}장은 다시 만들지 않아요)` : ''}`;
        }
      };
      const fillVoices = () => {
        const sel = q<HTMLSelectElement>('#rlNVoice');
        const list = voicesFor(n.provider, n.model[n.provider] || DEFAULT_TTS_MODEL[n.provider]);
        if (!list.includes(n.voice[n.provider])) n.voice[n.provider] = list[0];
        sel.innerHTML = list.map((v) => `<option value="${v}" ${v === n.voice[n.provider] ? 'selected' : ''}>${v}${VOICE_NOTE[v] ? ` · ${VOICE_NOTE[v]}` : ''}</option>`).join('');
      };
      const fillModels = (list: ModelInfo[]) => {
        const sel = q<HTMLSelectElement>('#rlNModel');
        const p = n.provider;
        const ids = list.length ? list : [{ id: DEFAULT_TTS_MODEL[p], label: DEFAULT_TTS_MODEL[p] }];
        if (!n.model[p] || !ids.some((m) => m.id === n.model[p])) n.model[p] = ids[0].id;
        sel.innerHTML = ids.map((m) => `<option value="${esc(m.id)}" ${m.id === n.model[p] ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
        fillVoices();
      };
      const loadModels = async () => {
        const p = n.provider;
        fillModels(ttsModels[p] ?? (n.model[p] ? [{ id: n.model[p], label: n.model[p] }] : []));
        if (ttsModels[p] || !hasKey(p) || !app.online()) return;
        try {
          const lists = await listModels(p, p === 'openai' ? keys.openai : keys.google);
          ttsModels[p] = lists.tts;
          if (n.provider === p && lists.tts.length) { fillModels(lists.tts); total(); }
        } catch { /* keep the default model */ }
      };
      q<HTMLInputElement>('#rlNarr').addEventListener('change', (e) => {
        n.on = (e.target as HTMLInputElement).checked;
        q('#rlNarrBox').hidden = !n.on;
        if (n.on) void loadModels();
        remember(); total();
      });
      box.querySelectorAll<HTMLButtonElement>('#rlNP button').forEach((b) => b.addEventListener('click', () => {
        if (b.disabled) return;
        box.querySelectorAll('#rlNP button').forEach((x) => x.classList.toggle('active', x === b));
        n.provider = b.dataset.v as Narration['provider'];
        void loadModels(); remember(); total();
      }));
      q<HTMLSelectElement>('#rlNModel').addEventListener('change', (e) => { n.model[n.provider] = (e.target as HTMLSelectElement).value; fillVoices(); remember(); total(); });
      q<HTMLSelectElement>('#rlNVoice').addEventListener('change', (e) => { n.voice[n.provider] = (e.target as HTMLSelectElement).value; remember(); total(); });
      q<HTMLSelectElement>('#rlNStyle').addEventListener('change', (e) => { n.style = (e.target as HTMLSelectElement).value as NarrationStyle; remember(); total(); });
      box.querySelectorAll<HTMLButtonElement>('#rlNSpeed button').forEach((b) => b.addEventListener('click', () => {
        box.querySelectorAll('#rlNSpeed button').forEach((x) => x.classList.toggle('active', x === b));
        n.speed = Number(b.dataset.v); remember(); total();
      }));
      q<HTMLInputElement>('#rlNOutro').addEventListener('change', (e) => { n.readOutro = (e.target as HTMLInputElement).checked; remember(); total(); });
      q('[data-a="hush"]').addEventListener('click', () => { stopPlayer(); q('[data-a="hush"]').hidden = true; });
      q('[data-a="hear"]').addEventListener('click', async () => {
        const sc = script();
        const i = sc[app.current()] ? app.current() : sc.findIndex(Boolean);
        const hear = q<HTMLButtonElement>('[data-a="hear"]');
        if (i < 0) { toast('읽을 글이 없어요.'); return; }
        stopPlayer();
        hear.disabled = true; hear.textContent = '만드는 중…';
        try {
          const buf = await speak(voice(), sc[i]);
          const ctx = new AudioContext();
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.onended = () => { if (player?.src === src) { stopPlayer(); q('[data-a="hush"]').hidden = true; } };
          src.start();
          player = { ctx, src };
          q('[data-a="hush"]').hidden = false;
          total();
        } catch (e) {
          toast(aiMessage(e), 5000);
        } finally {
          hear.disabled = false; hear.textContent = '지금 카드 미리 듣기';
        }
      });
      if (n.on) void loadModels();
      const seg = (id: string, set: (v: string) => void) => box.querySelectorAll<HTMLButtonElement>(`${id} button`).forEach((b) => b.addEventListener('click', () => {
        box.querySelectorAll(`${id} button`).forEach((x) => x.classList.toggle('active', x === b));
        set(b.dataset.v!); total();
      }));
      seg('#rlSec', (v) => { o.seconds = v === 'auto' ? 'auto' : Number(v); });
      seg('#rlTr', (v) => { o.transition = v as Transition; });
      q<HTMLInputElement>('#rlZoom').addEventListener('change', (e) => { o.zoom = (e.target as HTMLInputElement).checked; });
      q('[data-a="close"]').addEventListener('click', close);
      q('[data-a="music"]').addEventListener('click', () => { const f = q<HTMLInputElement>('#rlFile'); f.value = ''; f.click(); });
      q('#rlFile').addEventListener('change', async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        q('#rlMusic').textContent = '읽는 중…';
        try {
          music = { name: file.name, buffer: await decodeMusic(file) };
          q('#rlMusic').textContent = `${file.name} · ${fmtSec(music.buffer.duration)}${music.buffer.duration < totalDuration(cardDurations(w, o.seconds)) ? ' (짧으면 반복해요)' : ''}`;
          q('[data-a="nomusic"]').hidden = false; q('#rlVolRow').hidden = false;
        } catch {
          music = null; q('#rlMusic').textContent = '이 파일은 읽을 수 없어요. MP3·M4A·WAV를 써 보세요.';
        }
      });
      q('[data-a="nomusic"]').addEventListener('click', () => { music = null; q('#rlMusic').textContent = '없음'; q('[data-a="nomusic"]').hidden = true; q('#rlVolRow').hidden = true; });
      q('[data-a="stop"]').addEventListener('click', () => ctl?.abort());
      q('[data-a="save"]').addEventListener('click', () => { if (result) download(result.blob, `${fileBase(w)}_릴스.${result.ext}`); });
      q('[data-a="share"]').addEventListener('click', async () => {
        if (!result) return;
        const file = new File([result.blob], `${fileBase(w)}_릴스.${result.ext}`, { type: result.blob.type });
        try {
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
          else toast('이 브라우저는 영상 공유를 지원하지 않아요. 「영상 저장」 후 인스타 앱에서 올려 주세요.', 5000);
        } catch { /* cancelled */ }
      });
      q('[data-a="make"]').addEventListener('click', async () => {
        const make = q<HTMLButtonElement>('[data-a="make"]'), stop = q('[data-a="stop"]');
        const bar = q('#rlProg'), fill = bar.querySelector('i')!, st = q('#rlStatus');
        o.music = music ? { buffer: music.buffer, volume: Number(q<HTMLInputElement>('#rlVol').value) } : null;
        o.voice = null;
        ctl = new AbortController();
        make.disabled = true; stop.hidden = false; bar.hidden = false; q('#rlActs').hidden = true;
        st.className = 'status busy';
        const started = performance.now();
        const head = n.on ? 0.3 : 0; // share of the bar for the narration
        try {
          if (n.on) {
            stopPlayer();
            const clips = await narrate(w, voice(), n.readOutro, (done, all) => {
              fill.style.width = `${((all ? done / all : 1) * head * 100).toFixed(1)}%`;
              st.textContent = `낭독 만드는 중 ${done}/${all}`;
            }, ctl.signal);
            o.voice = { clips };
            total();
          }
          const r = await makeReel(w, o, (phase, done, all) => {
            const p = head + (1 - head) * (phase === 'cards' ? (done / all) * 0.1 : 0.1 + (done / all) * 0.9);
            fill.style.width = `${(p * 100).toFixed(1)}%`;
            st.textContent = phase === 'cards' ? `카드 그리는 중 ${done}/${all}` : `영상 만드는 중 ${Math.round((done / all) * 100)}%`;
          }, ctl.signal);
          result = { blob: r.blob, ext: r.ext };
          if (url) URL.revokeObjectURL(url);
          url = URL.createObjectURL(r.blob);
          q('#rlOut').innerHTML = `<video src="${url}" controls playsinline loop></video>`;
          st.className = 'status';
          st.textContent = `${fmtSec(r.duration)} · ${r.ext.toUpperCase()} (${CODEC_NAME[r.video] ?? r.video}${r.audio ? ` + ${CODEC_NAME[r.audio] ?? r.audio}` : ', 소리 없음'}) · ${(r.blob.size / 1048576).toFixed(1)}MB · ${Math.round((performance.now() - started) / 1000)}초 걸림`;
          q('#rlActs').hidden = false;
          if ((o.music || o.voice) && !r.audio) toast('이 브라우저는 소리를 넣을 수 없어 소리 없이 만들었어요.', 5000);
          else if (r.duration > 180) toast('영상이 3분을 넘어요. 릴스로 올리려면 빠르기를 올리거나 장당 시간을 줄여 다시 만들어 주세요.', 7000);
          else if (r.ext === 'mp4' && r.audio === 'opus') toast('소리가 Opus 형식으로 들어갔어요. 인스타에서 소리가 빠지면 맥·윈도의 Chrome이나 Safari에서 다시 만들면 AAC로 들어가요.', 7000);
        } catch (e) {
          const cancelled = (e instanceof ReelError || e instanceof AiError) && e.code === 'cancelled';
          st.className = 'status' + (cancelled ? '' : ' error');
          st.textContent = e instanceof AiError ? `낭독을 만들지 못했어요. ${aiMessage(e)}`
            : e instanceof ReelError ? (e.code === 'cancelled' ? '중단했어요.' : e.code === 'unsupported' ? '이 브라우저는 영상 만들기를 지원하지 않아요.' : `영상을 만들지 못했어요. (${e.message.slice(0, 120)})`) : '영상을 만들지 못했어요.';
        } finally {
          ctl = null; make.disabled = false; stop.hidden = true; bar.hidden = true;
        }
      });
      total();
    },
  });
}
