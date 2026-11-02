// Drive section of the library: connect, back up this work or all works, restore from Drive, automatic backup.
import type { App } from '../app';
import { compareCopies, connect, connected, disconnect, downloadWork, driveMessage, DriveError, findBackup, FOLDER_NAME, listBackups, loadGis, uploadWork, type DriveFile, type SyncState } from '../drive';
import { normalizeWork, workTitle, type Work, type WorkDefaults } from '../model';
import { kv, works } from '../store';
import { confirmBox, esc, fmtDate, openModal, setStatus, toast } from './dom';

export interface DriveDeps { clientId(): string; defaults(): WorkDefaults; reopenLibrary(): void }

let auto = false;
void kv.get<boolean>('drive.auto', false).then((v) => { auto = v; });

/** Backs up one work; a newer copy on Drive (changed on another device) is not overwritten unless `force`. */
export async function backupOne(w: Work, force = false): Promise<'saved' | 'same' | 'conflict'> {
  const existing = await findBackup(w.id);
  const state = existing ? compareCopies(existing, w) : 'drive_only';
  if (existing && state === 'same') return 'same';
  if (existing && state === 'drive_newer' && !force) return 'conflict';
  await uploadWork(w, existing);
  await kv.set('drive.lastBackup', Date.now());
  return 'saved';
}

/* ---------- automatic backup of the open work while connected ---------- */
let autoTimer = 0;
export function afterLocalSave(app: App): void {
  if (!auto || !connected() || !app.online()) return;
  clearTimeout(autoTimer);
  autoTimer = window.setTimeout(async () => {
    try {
      const r = await backupOne(app.work());
      if (r === 'conflict') toast('드라이브에 더 최신 사본이 있어 자동 백업을 건너뛰었어요. 보관함에서 확인해 주세요.', 5000);
    } catch (e) {
      if (e instanceof DriveError && e.code === 'auth') toast('구글 드라이브 연결이 한 시간이 지나 끊겼어요. 보관함에서 다시 연결하면 자동 백업이 이어져요.', 5000);
    }
  }, 20_000);
}

export async function renderDriveBox(el: HTMLElement, app: App, deps: DriveDeps, closeLibrary: () => void): Promise<void> {
  const clientId = deps.clientId();
  el.hidden = false;
  if (!clientId) {
    el.innerHTML = `<div class="drive-line"><b>구글 드라이브 백업</b><span class="hint">설정에서 Google OAuth 클라이언트 ID를 넣으면 쓸 수 있어요.</span><button class="btn small" type="button" data-a="settings">설정 열기</button></div>`;
    el.querySelector('[data-a="settings"]')!.addEventListener('click', () => { closeLibrary(); app.openSettings(); });
    return;
  }
  void loadGis().catch(() => undefined); // ready before the click, so the pop-up is not blocked
  const last = await kv.get<number>('drive.lastBackup', 0);
  if (!connected()) {
    el.innerHTML = `<div class="drive-line"><b>구글 드라이브 백업</b><span class="hint">드라이브의 「${esc(FOLDER_NAME)}」 폴더에 작품마다 파일 하나로 저장해요. 이 앱이 만든 파일만 볼 수 있어요.</span><button class="btn small primary" type="button" data-a="connect">드라이브 연결</button></div><div class="status" data-status></div>`;
    el.querySelector('[data-a="connect"]')!.addEventListener('click', async () => {
      const st = el.querySelector<HTMLElement>('[data-status]')!;
      setStatus(st, '구글 로그인 창에서 허용을 눌러 주세요…', 'busy');
      try { await connect(clientId); void renderDriveBox(el, app, deps, closeLibrary); } catch (e) { setStatus(st, driveMessage(e), 'error'); }
    });
    return;
  }
  el.innerHTML = `
    <div class="drive-line"><b>구글 드라이브 연결됨</b><span class="hint">「${esc(FOLDER_NAME)}」 폴더${last ? ` · 마지막 백업 ${fmtDate(last)}` : ''}</span>
      <button class="btn small" type="button" data-a="off">연결 끊기</button></div>
    <div class="toolbar">
      <button class="btn small tonal" type="button" data-a="one">이 작품 백업</button>
      <button class="btn small" type="button" data-a="all">모두 백업</button>
      <button class="btn small" type="button" data-a="restore">드라이브에서 불러오기</button>
      <label class="chk"><input type="checkbox" data-a="auto" ${auto ? 'checked' : ''}> 저장할 때 자동 백업</label>
    </div>
    <div class="status" data-status></div>`;
  const st = el.querySelector<HTMLElement>('[data-status]')!;
  const fail = (e: unknown) => {
    setStatus(st, driveMessage(e), 'error');
    if (e instanceof DriveError && e.code === 'auth') void renderDriveBox(el, app, deps, closeLibrary);
  };
  el.querySelector('[data-a="off"]')!.addEventListener('click', () => { disconnect(); void renderDriveBox(el, app, deps, closeLibrary); });
  el.querySelector<HTMLInputElement>('[data-a="auto"]')!.addEventListener('change', (e) => {
    auto = (e.target as HTMLInputElement).checked;
    void kv.set('drive.auto', auto);
    toast(auto ? '연결돼 있는 동안 고칠 때마다 20초 뒤 드라이브에 백업해요.' : '자동 백업을 껐어요.');
  });
  el.querySelector('[data-a="one"]')!.addEventListener('click', async () => {
    setStatus(st, '백업하는 중…', 'busy');
    try {
      await app.flush();
      let r = await backupOne(app.work());
      if (r === 'conflict') {
        closeLibrary();
        if (!(await confirmBox('드라이브 사본이 이 기기보다 최신이에요(다른 기기에서 고친 듯해요). 이 기기 것으로 덮어쓸까요?', { ok: '덮어쓰기', detail: ['드라이브 것을 보려면 취소하고 「드라이브에서 불러오기」를 쓰세요.'] }))) { deps.reopenLibrary(); return; }
        r = await backupOne(app.work(), true);
        toast('드라이브에 백업했어요.');
        deps.reopenLibrary();
        return;
      }
      setStatus(st, r === 'same' ? '드라이브 사본이 이미 최신이에요.' : '드라이브에 백업했어요.');
    } catch (e) { fail(e); }
  });
  el.querySelector('[data-a="all"]')!.addEventListener('click', async () => {
    setStatus(st, '드라이브 목록을 읽는 중…', 'busy');
    try {
      await app.flush();
      const files = await listBackups();
      const byId = new Map(files.map((f) => [f.appProperties?.cardnovelId, f]));
      const all = await works.all();
      let saved = 0, same = 0, conflicts = 0;
      for (const [k, w] of all.entries()) {
        setStatus(st, `백업하는 중… ${k + 1}/${all.length}`, 'busy');
        const f = byId.get(w.id) ?? null;
        const state = f ? compareCopies(f, w) : 'drive_only';
        if (f && state === 'same') { same++; continue; }
        if (f && state === 'drive_newer') { conflicts++; continue; }
        await uploadWork(w, f);
        saved++;
      }
      await kv.set('drive.lastBackup', Date.now());
      setStatus(st, `${saved}편을 백업했어요.${same ? ` ${same}편은 이미 최신이에요.` : ''}${conflicts ? ` ${conflicts}편은 드라이브 쪽이 더 최신이라 건너뛰었어요(불러오기에서 확인).` : ''}`);
    } catch (e) { fail(e); }
  });
  el.querySelector('[data-a="restore"]')!.addEventListener('click', async () => {
    setStatus(st, '드라이브 목록을 읽는 중…', 'busy');
    try {
      const files = await listBackups();
      closeLibrary();
      await openRestore(app, deps, files);
    } catch (e) { fail(e); }
  });
}

const STATE_NAME: Record<SyncState, string> = { drive_only: '이 기기에 없음', same: '이 기기와 같음', drive_newer: '드라이브가 더 최신', local_newer: '이 기기가 더 최신' };

async function openRestore(app: App, deps: DriveDeps, files: DriveFile[]) {
  const local = new Map((await works.all()).map((w) => [w.id, w]));
  const row = (f: DriveFile) => {
    const st = compareCopies(f, local.get(f.appProperties?.cardnovelId || ''));
    return `
    <div class="work drive-file" data-id="${esc(f.id)}">
      <div class="noimg">${f.appProperties?.episode ? `${esc(f.appProperties.episode)}화` : 'JSON'}</div>
      <div><b>${esc(f.name.replace(/\.cardnovel\.json$/, ''))}</b><span>${fmtDate(Date.parse(f.modifiedTime))} · ${f.size ? `${Math.max(1, Math.round(Number(f.size) / 1024))}KB · ` : ''}<em class="sync ${st}">${STATE_NAME[st]}</em></span></div>
      <div class="acts"><button class="btn small ${st === 'drive_only' || st === 'drive_newer' ? 'tonal' : ''}" type="button" data-a="load" ${st === 'same' ? 'disabled' : ''}>${st === 'same' ? '같음' : '불러오기'}</button></div>
    </div>`;
  };
  openModal(`
    <div class="panel-head"><h2>드라이브에서 불러오기</h2><button class="btn small" type="button" data-a="back">보관함으로</button></div>
    <p class="hint" style="margin:0 0 12px">불러오면 이 기기의 같은 작품을 드라이브 사본으로 바꿔요. 이 기기에 없는 작품은 새로 들어와요.</p>
    <div class="lib">${files.length ? files.map(row).join('') : '<div class="empty-note">드라이브에 백업한 작품이 없어요.</div>'}</div>`,
  {
    size: 'wide',
    wire: (box, close) => {
      box.querySelector('[data-a="back"]')!.addEventListener('click', () => { close(); deps.reopenLibrary(); });
      box.querySelectorAll<HTMLElement>('.drive-file').forEach((el) => {
        const f = files.find((x) => x.id === el.dataset.id)!;
        el.querySelector('[data-a="load"]')!.addEventListener('click', async () => {
          const mine = local.get(f.appProperties?.cardnovelId || '');
          const st = compareCopies(f, mine);
          close();
          if (st === 'local_newer' && !(await confirmBox(`이 기기의 「${workTitle(mine!)}」가 드라이브보다 최신이에요. 그래도 드라이브 사본으로 바꿀까요?`, { ok: '드라이브 것으로 바꾸기' }))) {
            void openRestore(app, deps, files); return;
          }
          try {
            await app.flush();
            const w = normalizeWork(await downloadWork(f.id), deps.defaults());
            await works.put(w);
            await app.openWork(w);
            toast(`「${workTitle(w)}」를 드라이브에서 불러왔어요.`);
          } catch (e) {
            toast(driveMessage(e), 5000);
          }
        });
      });
    },
  });
}
