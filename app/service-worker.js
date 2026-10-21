/* service-worker.js — офлайн кеш + лесно обновяване (network-first) */
var VERSION = 'v209';              // ← увеличавай при нова версия
var CACHE = 'walnut-' + VERSION;
var ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/data.js',
  './js/sync.js',
  './js/firebase-config.js',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/bucket_cheese.png',
  './assets/bucket_black.png',
  './assets/bucket_round.png'
];

self.addEventListener('install', function (e) {
  // cache:'reload' = заобикаля HTTP кеша на GitHub Pages (max-age=600) и тегли свежи файлове
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }));
  // новата версия поема веднага — иначе старият SW продължава да сервира стар код след рефреш
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// общ брояч за иконката (badge), споделен с приложението през IndexedDB.
// delta = с колко да вдигнем; ако absolute != null — задава точна стойност.
function badgeCount(delta, absolute) {
  return new Promise(function (resolve) {
    var open = indexedDB.open('walnut-badge', 1);
    open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
    open.onsuccess = function () {
      var db = open.result, tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv'), g = st.get('count');
      g.onsuccess = function () {
        var cur = g.result || 0;
        var next = (absolute != null) ? absolute : Math.max(0, cur + (delta || 0));
        st.put(next, 'count');
        resolve(next);
      };
      g.onerror = function () { resolve(0); };
    };
    open.onerror = function () { resolve(0); };
  });
}

// получаване на push от сървъра (Cloudflare Worker) → системно известие,
// дори когато приложението е напълно затворено
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (err) { data = { title: 'Орехова градина', body: e.data ? e.data.text() : '' }; }
  var title = data.title || 'Орехова градина';
  var opts = {
    body: data.body || '',
    icon: data.icon || 'assets/icon.svg',
    badge: 'assets/icon.svg',
    tag: data.tag,
    data: { url: data.url || './' }
  };
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, opts),
    badgeCount(1).then(function (n) {
      if (self.navigator && self.navigator.setAppBadge) { try { self.navigator.setAppBadge(n); } catch (x) {} }
    })
  ]));
});

// натискане на известие → показва (или отваря) приложението
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) return list[i].focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // проверка за връзка — само мрежа, без резервен кеш (за коректен офлайн индикатор)
  if (url.searchParams.has('ping')) { e.respondWith(fetch(req)); return; }

  // Network-first: когато има мрежа — винаги свежи файлове (така поправките стигат веднага
  // след рефреш); кешът е резерва само когато няма интернет.
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || caches.match('./index.html');
      });
    })
  );
});
