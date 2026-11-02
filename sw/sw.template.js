// Offline support: the app shell, every built file and the fonts are cached; AI and other API calls always go to
// the network. vite.config.ts fills in the version (new with every build, so a deploy replaces the cache) and the
// list of built files (including the parts loaded on demand: video, Canva deck).
const VERSION = __VERSION__;
const SHELL = ['./', './index.html', './manifest.webmanifest', './fonts/maplestory-300.woff2', './fonts/maplestory-700.woff2', './icons/icon-192.png', ...__ASSETS__];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    // keep the previous version's cache too: a page still running the old code can load its own parts from it
    // until it switches (the app shows "new version" and reloads); older caches go
    caches.keys().then((keys) => {
      const others = keys.filter((k) => k !== VERSION);
      return Promise.all(others.slice(0, -1).map((k) => caches.delete(k)));
    }).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;
  // server functions (Canva, share links) and shared-story pages (/s/…) are always live and never replace the app shell
  if (sameOrigin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/'))) return;

  if (req.mode === 'navigate') {
    // pages that carry a Canva landing (?canva=…) must reach the network too; the shell is the same file
    // network first, so a new deploy shows up; the cached shell when offline
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html', { ignoreVary: true })),
    );
    return;
  }

  // assets (hashed file names) and fonts: cache first, fill the cache on first use
  e.respondWith(
    // ignoreVary: module scripts and styles are requested with CORS (an Origin header) but were cached without one
    caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
