// Drive section of the library: connect, back up this work or all works, restore from Drive, automatic backup.
import type { App } from '../app';
import { compareCopies, connect, connected, disconnect, downloadWork, driveMessage, DriveError, driveTime, findBackup, FOLDER_NAME, listBackups, loadGis, markSynced, planSync, syncedMap, uploadWork, type DriveFile, type SyncState } from '../drive';
import { normalizeWork, workTitle, type Work, type WorkDefaults } from '../model';
import { kv, works } from '../store';
import { saveVersion } from '../versions';
import { confirmBox, esc, fmtDate, openModal, setStatus, toast } from './dom';

export interface DriveDeps { clientId(): string; defaults(): WorkDefaults; reopenLibrary(): void }

let auto = false;
void kv.get<boolean>('drive.auto', false).then((v) => { auto = v; });
/** open the newer Drive copy of the open work by itself (when it changed only on the other device) */
let continueAuto = true;
void kv.get<boolean>('drive.continue', true).then((v) => { continueAuto = v; });

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
      <label class="chk"><input type="checkbox" data-a="continue" ${continueAuto ? 'checked' : ''}> 열 때 최신본으로 이어서</label>
    </div>
    <div class="status" data-status></div>`;
  const st = el.querySelector<HTMLElement>('[data-status]')!;
  const fail = (e: unknown) => {
    setStatus(st, driveMessage(e), 'error');
    if (e instanceof DriveError && e.code === 'auth') void renderDriveBox(el, app, deps, closeLibrary);
  };
  el.querySelector('[data-a="off"]')!.addEventListener('click', () => { disconnect(); void kv.set('drive.linked', false); void renderDriveBox(el, app, deps, closeLibrary); });
  el.querySelector<HTMLInputElement>('[data-a="continue"]')!.addEventListener('change', (e) => {
    continueAuto = (e.target as HTMLInputElement).checked;
    void kv.set('drive.continue', continueAuto);
    toast(continueAuto ? '앱을 열 때 다른 기기에서 고친 최신본이 있으면 이어서 열어요.' : '최신본이 있으면 열기 전에 물어볼게요.');
  });
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

export async function openRestore(app: App, deps: DriveDeps, files: DriveFile[]) {
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
            const before = await works.get(w.id);
            if (before) await saveVersion(before, 'drive').catch(() => undefined);
            await works.put(w);
            await markSynced(w.id, w.updatedAt || driveTime(f));
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

/* ---------- continue where you left off: compare with Drive when the app opens or comes back ---------- */
interface BarAction { label: string; primary?: boolean; run: () => void | Promise<void> }
function showBar(msg: string, actions: BarAction[]) {
  const bar = document.getElementById('syncBar');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<span>${esc(msg)}</span>${actions.map((a, i) => `<button class="btn small ${a.primary ? 'primary' : ''}" type="button" data-i="${i}">${esc(a.label)}</button>`).join('')}<button class="btn icon" type="button" data-close aria-label="닫기"><svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4l-6.3 6.3-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg></button>`;
  bar.onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.hasAttribute('data-close')) { hideBar(); return; }
    const a = actions[Number(b.dataset.i)];
    if (a) { hideBar(); await a.run(); }
  };
}
export function hideBar(): void { const bar = document.getElementById('syncBar'); if (bar) { bar.hidden = true; bar.innerHTML = ''; } }

const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : fmtDate(t); };

async function takeDriveCopy(app: App, deps: DriveDeps, f: DriveFile, open: boolean): Promise<Work> {
  const w = normalizeWork(await downloadWork(f.id), deps.defaults());
  const before = await works.get(w.id);
  if (before) await saveVersion(before, 'drive').catch(() => undefined);
  await works.put(w);
  await markSynced(w.id, w.updatedAt || driveTime(f));
  if (open) await app.openWork(w);
  return w;
}

let checking = false, lastCheck = 0;
export async function syncCheck(app: App, deps: DriveDeps, quiet = false): Promise<void> {
  if (checking || !connected() || !app.online()) return;
  checking = true;
  lastCheck = Date.now();
  try {
    await app.flush();
    const [files, locals, synced] = await Promise.all([listBackups(), works.all(), syncedMap()]);
    const cur = app.work();
    const plan = planSync(files, locals, synced, cur.id);
    for (const f of plan.update) await takeDriveCopy(app, deps, f, false);
    if (plan.update.length) toast(`다른 기기에서 고친 작품 ${plan.update.length}편을 이 기기에 맞췄어요.`, 4500);
    const f = plan.currentFile;
    if (f && plan.current === 'load' && continueAuto) {
      await takeDriveCopy(app, deps, f, true);
      toast(`다른 기기에서 ${ago(driveTime(f))} 고친 최신본으로 이어서 열었어요. 이전 상태는 버전 기록에 있어요.`, 6000);
    } else if (f && plan.current !== 'none') {
      const both = plan.current === 'ask';
      showBar(both ? `이 작품을 이 기기와 다른 기기에서 모두 고쳤어요. 드라이브 쪽은 ${ago(driveTime(f))} 저장.` : `드라이브에 이 작품의 더 최신본이 있어요 (${ago(driveTime(f))} 저장).`, [
        { label: '드라이브 것 열기', primary: true, run: async () => { try { await takeDriveCopy(app, deps, f, true); toast('드라이브의 최신본을 열었어요. 이전 상태는 버전 기록에 있어요.'); } catch (e) { toast(driveMessage(e)); } } },
        { label: '이 기기 것 유지', run: async () => {
          // this device's copy becomes the newest: save it now and put it on Drive
          try { app.save(); await app.flush(); await uploadWork(app.work(), f); toast('이 기기 것을 드라이브에 올려 맞췄어요.'); } catch (e) { toast(driveMessage(e)); }
        } },
      ]);
    } else if (plan.onlyOnDrive.length || plan.conflicts.length) {
      const n = plan.onlyOnDrive.length, c = plan.conflicts.length;
      if (!quiet || n) {
        showBar([n ? `드라이브에만 있는 작품 ${n}편` : '', c ? `양쪽에서 고친 작품 ${c}편` : ''].filter(Boolean).join(', ') + '이 있어요.', [
          { label: '드라이브 목록 보기', primary: true, run: () => openRestore(app, deps, files) },
        ]);
      }
    }
  } catch (e) {
    if (!quiet) toast(driveMessage(e));
  } finally {
    checking = false;
  }
}

/** On open: compare right away when the Drive sign-in from this session is still valid, otherwise offer a one-click check. */
export async function startDriveSync(app: App, deps: DriveDeps): Promise<void> {
  const clientId = deps.clientId();
  if (!clientId || !(await kv.get<boolean>('drive.linked', false))) return;
  if (connected()) await syncCheck(app, deps, true);
  else {
    void loadGis().catch(() => undefined);
    showBar('다른 기기에서 고친 작업이 있는지 구글 드라이브와 맞춰 볼까요?', [
      { label: '드라이브 확인', primary: true, run: async () => { try { await connect(clientId); await syncCheck(app, deps); } catch (e) { toast(driveMessage(e)); } } },
    ]);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && connected() && Date.now() - lastCheck > 60_000) void syncCheck(app, deps, true);
  });
}
