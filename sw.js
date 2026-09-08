const CACHE = 'sharaga-v9';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/logo.png',
  './assets/icon.png',
  './assets/icon-192.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isAppShell(req){
  if (req.mode === 'navigate') return true;
  const u = new URL(req.url);
  return u.pathname.endsWith('/') || u.pathname.endsWith('index.html') || u.pathname.endsWith('manifest.webmanifest');
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.indexOf('/cloud/') > -1) { e.respondWith(fetch(e.request)); return; }

  // Само приложение — сначала сеть: иначе обновление доезжает только со второго
  // запуска, и «скачал новую версию» на телефоне показывает старую.
  if (isAppShell(e.request)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Картинки и прочая статика — сначала кэш (они не меняются).
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchP = fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchP;
    })
  );
});

self.addEventListener('push', e => {
  let title = '🔔 Пара скоро начнётся';
  let body = 'Открой Шарагу для деталей';
  let data = null;
  if (e.data) {
    try { const d = e.data.json(); title = d.title || title; body = d.body || body; data = d; } catch(err){ body = e.data.text(); }
  }
  e.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: 'assets/icon-192.png',
      badge: 'assets/icon-192.png',
      tag: data && data.tag ? data.tag : 'sharaga-pair',
      renotify: true,
      data: data || {}
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
