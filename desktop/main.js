// 카드소설 제작소 — desktop shell (macOS, Windows, Ubuntu).
// It shows the deployed web app, so the desktop version updates itself with the website and keeps
// Canva working (same origin, same cookies). Canva's editor and sign-in open in app windows, so
// "Return" lands back in this app's own storage, not in a separate browser.
const { app, BrowserWindow, Menu, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_URL = process.env.CARDNOVEL_URL || 'https://cardnovel.vercel.app/';
const APP_ORIGIN = new URL(APP_URL).origin;
const SMOKE = process.argv.includes('--smoke-test');

// Hosts that may open inside the app: the app itself, Canva, and the sign-in pages Canva sends people to.
const IN_APP_HOSTS = [/\.canva\.com$/, /^canva\.com$/, /^accounts\.google\.com$/, /^appleid\.apple\.com$/, /\.facebook\.com$/, /^login\.microsoftonline\.com$/];
const inApp = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:') return true;
    if (u.origin === APP_ORIGIN) return true;
    return u.protocol === 'https:' && IN_APP_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
};

// Look like regular Chrome so Canva and sign-in pages do not treat the app as an unknown browser.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|cardnovel-desktop|카드소설 제작소)\/\S+/g, '');

const gotLock = SMOKE || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/** @type {BrowserWindow | null} */
let mainWindow = null;

function guard(win) {
  // links to other sites open in the default browser; the app, Canva and sign-in stay in app windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (inApp(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 1280, height: 860, autoHideMenuBar: true, webPreferences: secureWebPreferences() },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!inApp(url)) { e.preventDefault(); shell.openExternal(url); }
  });
}
app.on('browser-window-created', (_e, win) => guard(win));

function secureWebPreferences() {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false };
}

/* ---------- the window opens where it was closed ---------- */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const b = { x: s.x, y: s.y, width: Math.max(960, s.width), height: Math.max(640, s.height) };
    // only if it is still on a connected screen
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y < area.y + area.height - 100 && b.y + b.height > area.y;
    return visible ? { ...b, maximized: !!s.maximized } : { width: b.width, height: b.height, maximized: !!s.maximized };
  } catch {
    return { width: 1440, height: 940, maximized: false };
  }
}
function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* not important */ }
}

function createWindow() {
  const st = SMOKE ? { width: 1440, height: 940, maximized: false } : loadWindowState();
  mainWindow = new BrowserWindow({
    ...('x' in st ? { x: st.x, y: st.y } : {}),
    width: st.width,
    height: st.height,
    minWidth: 960,
    minHeight: 640,
    title: '카드소설 제작소',
    backgroundColor: '#F5F6FA',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: SMOKE ? false : true,
    webPreferences: secureWebPreferences(),
  });

  // First start without internet (nothing cached yet): show a page that explains and retries.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted by a redirect */) return;
    if (SMOKE) { console.error(`smoke: load failed ${code} ${desc} ${url}`); app.exit(1); return; }
    mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { url: APP_URL } });
  });

  if (SMOKE) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const title = await mainWindow.webContents.executeJavaScript('document.title');
        const rows = await mainWindow.webContents.executeJavaScript(
          "new Promise(r => { const t = Date.now(); (function w(){ const n = document.querySelectorAll('.card-row').length; if (n || Date.now() - t > 15000) r(n); else setTimeout(w, 250); })(); })",
        );
        console.log(`smoke: title=${title} cards=${rows}`);
        app.exit(title.includes('카드소설') && rows === 20 ? 0 : 1);
      } catch (e) {
        console.error('smoke:', e);
        app.exit(1);
      }
    });
    setTimeout(() => { console.error('smoke: timed out'); app.exit(1); }, 60000);
  }

  if (st.maximized) mainWindow.maximize();
  mainWindow.on('close', () => { if (!SMOKE && mainWindow) saveWindowState(mainWindow); });
  mainWindow.loadURL(APP_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: '보기',
      submenu: [
        { label: '새로고침', accelerator: 'CmdOrCtrl+R', click: (_i, w) => w && w.webContents.reload() },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: '웹에서 열기', click: () => shell.openExternal(APP_URL) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

if (process.platform === 'win32') app.setAppUserModelId('app.vercel.cardnovel');

app.whenReady().then(() => {
  if (!gotLock) return;
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
