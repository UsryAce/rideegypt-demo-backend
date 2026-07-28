// Rahal Go service worker — offline app shell.
// Static shell is cached on install; API calls always go network-first so
// live data (tracking, wallet) is never stale, falling back to nothing
// offline (the app surfaces fetch errors as toasts).
const CACHE = 'rahalgo-shell-v1';
const SHELL = ['/app/', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-maskable.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Never cache the API — live data only
  if (url.pathname.startsWith('/api/')) return;
  // Shell: cache-first, refresh in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request)
        .then(resp => {
          if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          return resp;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
