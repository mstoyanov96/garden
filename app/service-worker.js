/* service-worker.js — офлайн кеш + лесно обновяване (network-first) */
var VERSION = 'v24';              // ← увеличавай при нова версия
var CACHE = 'walnut-' + VERSION;
var ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/data.js',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/bucket_cheese.png',
  './assets/bucket_black.png',
  './assets/bucket_round.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
  // НЕ викаме skipWaiting тук — чакаме потребителят да натисне „Обнови“.
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // проверка за връзка — само мрежа, без резервен кеш (за коректен офлайн индикатор)
  if (url.searchParams.has('ping')) { e.respondWith(fetch(req)); return; }

  // Network-first: винаги пробваме мрежата (свежа версия), при липса — от кеша.
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
