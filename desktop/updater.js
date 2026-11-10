// Desktop self-update from the GitHub releases of this repository.
// The web app inside updates itself with every deploy; this updates the desktop shell around it.
// - Windows: the NSIS installer runs silently over the installed copy and starts the app again.
// - macOS: the new app is copied out of the dmg over the old one (the app has no Apple Developer ID, so the
//   system updater cannot be used); if the app runs from a place that cannot be written, the dmg is opened instead.
// - Ubuntu: an AppImage replaces itself; a .deb is installed with the system's password prompt (pkexec).
// The latest release carries latest.json (written by CI): the version, the notes and each installer's SHA-256.
// It is read from the release download address, which, unlike the GitHub API, has no per-address request limit.
// Every download is checked against that SHA-256 before anything is installed.
const { app, dialog, net, Notification, shell, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./update-core.js');

const FEED = process.env.CARDNOVEL_UPDATE_FEED || 'https://github.com/doguri25/cardnovel/releases/latest/download/latest.json';
const EVERY = 6 * 60 * 60 * 1000;

const kind = core.installKind(process.platform, process.env);
const prefsFile = () => path.join(app.getPath('userData'), 'updater.json');
const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; } };
const savePrefs = (p) => { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch { /* not important */ } };

let busy = false;
/** a downloaded, verified update to install when the app closes (automatic mode) */
let pending = null;
let installing = false;

async function latestRelease() {
  const res = await net.fetch(FEED, { headers: { 'User-Agent': 'cardnovel-desktop' }, cache: 'no-store' });
  if (res.status === 404) return null; // a release without a manifest (before 0.3.0): nothing to offer
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

/** What GitHub offers for this computer, or null. */
async function findUpdate() {
  const info = core.releaseInfo(await latestRelease(), kind, process.arch);
  return info && core.isNewer(info.version, app.getVersion()) ? info : null;
}

const mainWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getParentWindow() === null) || null;

/** The response body as chunks; stops the download when the rest is not needed (the file could not be written). */
async function* bodyChunks(body) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Downloads the installer into a new folder only this user can open, showing progress on the taskbar / Dock,
 * and checks its SHA-256. The file stays there, unchanged, until it is installed.
 */
async function download(info) {
  const file = path.join(core.makeDownloadDir(app.getPath('temp')), info.name);
  const win = mainWindow();
  try {
    const res = await net.fetch(info.url, { headers: { 'User-Agent': 'cardnovel-desktop' } });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    const total = Number(res.headers.get('content-length')) || info.size || 0;
    try {
      await core.saveChecked(bodyChunks(res.body), file, info, (got) => { if (win && total) win.setProgressBar(Math.min(1, got / total)); });
    } finally {
      if (win) win.setProgressBar(-1);
    }
    return file;
  } catch (e) {
    core.removeDownload(file);
    throw e;
  }
}

/** The .app bundle this process runs from, when it may be replaced in place. */
function replaceableMacApp() {
  const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return null;
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return bundle; } catch { return null; }
}

const MAC_SCRIPT = `#!/bin/bash
APP="$1"; DMG="$2"; PID="$3"; RELAUNCH="$4"
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
MNT=$(mktemp -d /tmp/cardnovel-update.XXXXXX)
hdiutil attach "$DMG" -nobrowse -readonly -noverify -mountpoint "$MNT" -quiet || exit 1
NEW=$(ls -d "$MNT"/*.app 2>/dev/null | head -1)
if [ -z "$NEW" ]; then hdiutil detach "$MNT" -quiet; exit 1; fi
rm -rf "$APP.old"
if ! mv "$APP" "$APP.old"; then hdiutil detach "$MNT" -quiet; exit 1; fi
if ditto "$NEW" "$APP"; then rm -rf "$APP.old"; else rm -rf "$APP"; mv "$APP.old" "$APP"; fi
hdiutil detach "$MNT" -quiet
xattr -cr "$APP" 2>/dev/null
D=$(dirname "$DMG"); case "$(basename "$D")" in cardnovel-update-*) rm -rf "$D";; *) rm -f "$DMG";; esac
if [ "$RELAUNCH" = "1" ]; then open "$APP"; fi
`;

/** Starts the installer for the downloaded file and quits; `relaunch` opens the new version afterwards. */
async function install(file, relaunch) {
  installing = true;
  if (kind === 'nsis') {
    spawn(file, ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return true;
  }
  if (kind === 'dmg') {
    const bundle = replaceableMacApp();
    if (!bundle) {
      // running from the dmg or a protected folder: let the writer drag the new app in
      await shell.openPath(file);
      installing = false;
      dialog.showMessageBox({ type: 'info', message: '새 버전의 dmg를 열었어요.', detail: 'CardNovel을 응용 프로그램 폴더로 끌어 넣어 바꿔 주세요. 앱을 응용 프로그램 폴더에서 열면 다음부터는 자동으로 바뀌어요.' });
      return false;
    }
    const script = path.join(path.dirname(file), 'install.sh');
    fs.writeFileSync(script, MAC_SCRIPT, { mode: 0o755 });
    spawn('/bin/bash', [script, bundle, file, String(process.pid), relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return true;
  }
  if (kind === 'appimage') {
    const target = process.env.APPIMAGE;
    const tmp = target + '.new';
    try {
      fs.copyFileSync(file, tmp);
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, target);
    } finally {
      core.removeDownload(file);
    }
    if (relaunch) spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return true;
  }
  if (kind === 'deb') {
    const ok = await new Promise((resolve) => {
      const p = spawn('pkexec', ['apt-get', 'install', '-y', '--allow-downgrades', file], { stdio: 'ignore' });
      p.on('error', () => resolve(null));
      p.on('exit', (code) => resolve(code === 0));
    });
    if (ok !== null) core.removeDownload(file);
    if (ok === null) { await shell.openPath(file); installing = false; return false; } // no pkexec: the system installer
    if (!ok) { installing = false; dialog.showMessageBox({ type: 'warning', message: '업데이트를 설치하지 못했어요.', detail: '나중에 다시 해 보거나, 릴리즈 페이지에서 받아 설치해 주세요.' }); return false; }
    if (relaunch) app.relaunch();
    app.exit(0);
    return true;
  }
  return false;
}

/** Checks GitHub. `manual`: the writer asked (menu), so say so when there is nothing new or something failed. */
async function check(manual = false) {
  if (busy || installing || !kind) return;
  busy = true;
  try {
    const info = await findUpdate();
    if (!info) {
      if (manual) dialog.showMessageBox({ type: 'info', message: '최신 버전이에요.', detail: `지금 쓰는 버전: ${app.getVersion()}` });
      return;
    }
    const prefs = loadPrefs();
    if (!manual && prefs.skip === info.version) return;
    if (pending && pending.version === info.version) return;

    if (prefs.auto && !manual && kind !== 'deb') {
      // automatic: fetch it now, put it in place when the app closes
      const file = await download(info);
      if (pending) core.removeDownload(pending.file); // an older version that was waiting
      pending = { version: info.version, file };
      if (Notification.isSupported()) new Notification({ title: '카드소설 제작소 업데이트', body: `${info.version} 버전을 받아 두었어요. 앱을 닫으면 바뀌어요.` }).show();
      return;
    }

    const win = mainWindow();
    const opts = {
      type: 'info',
      message: `새 버전 ${info.version}이 나왔어요.`,
      detail: `${info.notes ? info.notes + '\n\n' : ''}지금 쓰는 버전: ${app.getVersion()}. 작품과 키는 그대로 남아요.`,
      buttons: ['지금 업데이트', '나중에', '이 버전 건너뛰기'],
      defaultId: 0, cancelId: 1,
      checkboxLabel: kind === 'deb' ? undefined : '다음부터는 묻지 않고 자동으로 업데이트',
      checkboxChecked: !!prefs.auto,
    };
    const r = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    if (r.response === 2) { savePrefs({ ...prefs, skip: info.version }); return; }
    savePrefs({ ...prefs, auto: !!r.checkboxChecked, skip: undefined });
    if (r.response !== 0) return;
    const file = await download(info);
    await install(file, true);
  } catch (e) {
    if (manual) dialog.showMessageBox({ type: 'warning', message: '업데이트를 확인하지 못했어요.', detail: String((e && e.message) || e) });
  } finally {
    busy = false;
  }
}

/** Checks a little after start and every few hours; installs a downloaded update when the app quits. */
function startAutoUpdate() {
  if (!kind) return;
  setTimeout(() => void check(false), 8000);
  setInterval(() => void check(false), EVERY);
  app.on('before-quit', (e) => {
    if (!pending || installing) return;
    e.preventDefault();
    const { file } = pending;
    pending = null;
    void install(file, false).then((done) => { if (!done) app.quit(); });
  });
}

/** For CI: print what the updater would do, without downloading. */
async function dryRun() {
  const release = await latestRelease();
  const info = core.releaseInfo(release, kind, process.arch);
  return { current: app.getVersion(), kind, latest: release && release.version, file: info && info.name, sha256: !!(info && info.sha256), newer: !!(info && core.isNewer(info.version, app.getVersion())) };
}

module.exports = { check, startAutoUpdate, dryRun };
