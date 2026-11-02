// 「릴스 영상」: options (time per card, transition, zoom, music), progress, preview, save and share.
import type { App } from '../app';
import { download, fileBase } from '../export';
import { cardDurations, decodeMusic, makeReel, pickFormat, ReelError, totalDuration, type ReelOptions, type Transition } from '../reels';
import { esc, openModal, toast } from './dom';

const CODEC_NAME: Record<string, string> = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', aac: 'AAC', opus: 'Opus' };
const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초` : `${Math.round(s)}초`);

export async function openReels(app: App): Promise<void> {
  const w = app.work();
  const fmt = await pickFormat();
  let music: { name: string; buffer: AudioBuffer } | null = null;
  let ctl: AbortController | null = null;
  let url = '';
  const o: ReelOptions = { seconds: 'auto', transition: 'slide', zoom: true, music: null };

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
        <div class="field"><label>배경음 (선택)</label>
          <div class="toolbar"><button class="btn small" type="button" data-a="music">음악 파일 고르기</button><span class="hint" id="rlMusic">없음</span><button class="btn small" type="button" data-a="nomusic" hidden>빼기</button></div>
          <div class="toolbar" id="rlVolRow" hidden><span class="hint">볼륨</span><input type="range" id="rlVol" min="0.1" max="1" step="0.05" value="0.7" style="max-width:200px"></div>
          <p class="hint">내가 쓸 권리가 있는 음악만 넣으세요. 음악 없이 만든 뒤 인스타 앱에서 음악을 붙여도 돼요.</p></div>
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
    onClose: () => { ctl?.abort(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); },
    wire: (box, close) => {
      const q = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
      let result: { blob: Blob; ext: string } | null = null;
      const total = () => { const d = totalDuration(cardDurations(w, o.seconds)); q('#rlTotal').textContent = `총 ${fmtSec(d)} · 카드 ${w.cards.length}장${d > 180 ? ' · 릴스는 3분까지라 장당 시간을 줄여 주세요' : ''}`; };
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
        ctl = new AbortController();
        make.disabled = true; stop.hidden = false; bar.hidden = false; q('#rlActs').hidden = true;
        st.className = 'status busy';
        const started = performance.now();
        try {
          const r = await makeReel(w, o, (phase, done, all) => {
            const p = phase === 'cards' ? (done / all) * 0.1 : 0.1 + (done / all) * 0.9;
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
          if (o.music && !r.audio) toast('이 브라우저는 소리를 넣을 수 없어 소리 없이 만들었어요.', 5000);
          else if (r.ext === 'mp4' && r.audio === 'opus') toast('소리가 Opus 형식으로 들어갔어요. 인스타에서 소리가 빠지면 맥·윈도의 Chrome이나 Safari에서 다시 만들면 AAC로 들어가요.', 7000);
        } catch (e) {
          st.className = 'status' + (e instanceof ReelError && e.code === 'cancelled' ? '' : ' error');
          st.textContent = e instanceof ReelError ? (e.code === 'cancelled' ? '중단했어요.' : e.code === 'unsupported' ? '이 브라우저는 영상 만들기를 지원하지 않아요.' : `영상을 만들지 못했어요. (${esc(e.message).slice(0, 120)})`) : '영상을 만들지 못했어요.';
        } finally {
          ctl = null; make.disabled = false; stop.hidden = true; bar.hidden = true;
        }
      });
      total();
    },
  });
}
