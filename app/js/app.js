/* =========================================================================
   app.js — Логика и изгледи на приложението (offline-first, роли, soft delete)
   ========================================================================= */
(function () {
  'use strict';

  var APP_VERSION = '2.4.5';   // ← при нова версия: увеличи тук И в service-worker.js (VERSION)
  var db = DB.load();
  var route = { name: 'login', param: null };
  var harvestDraft = {};   // { treeId: {bucketId: count} } за текущата сесия събиране
  var harvestMode = 'tree';
  var harvestScreen = 'none'; // кой таб на екрана Действия: 'none' | 'collect' | 'clean' | 'sort'
  var harvestRowFilter = ''; // филтър по ред на картата при събиране
  var harvestBucket = '';    // избрана кофа при събиране
  var harvestFill = 100;      // колко пълни са кофите (%) — общо за събиране
  var groundBucket = '';     // избрана кофа при бързо събиране от земята
  var groundFill = 100;       // колко пълни са кофите (%) при събиране от земята
  var sortWhiteBucket = '';  // '' = без кофа; иначе id на кофа, с която са теглени белите при сортиране
  var sortBlackBucket = '';  // '' = без кофа; иначе id на кофа, с която са теглени черните при сортиране
  var sortDraft = {};        // временно въведените стойности при сортиране (да не се губят при избор на кофа)
  var harvestState = 'green'; // в какъв вид са кофите: 'green' зелени | 'shelled' обелени с черупка | 'clean' чиста ядка
  var treeHarvestOpen = '';   // id на дърво с отворена вградена форма за събиране
  var treeDetailsOpen = false; // показани ли са подробните данни за дървото
  var careScope = 'all';    // 'all' | 'rows' | 'tree' | 'trees' — обхват на грижата
  var careRows = [];        // избрани редици (букви) когато careScope === 'rows'
  var careTreePreset = '';  // предварително избрано дърво при грижа от профила на дърво
  var careTrees = [];       // избрани дървета (id) когато careScope === 'trees' (от картата)
  var mapSelect = false;    // режим на избор на няколко дървета върху картата
  var mapSelected = [];     // id на избраните дървета върху картата
  var MAP_MODE_KEY = 'walnut_mapmode'; // пази се на устройството (не се синхронизира)
  var mapMode = (function () { try { return localStorage.getItem(MAP_MODE_KEY) === 'harvest' ? 'harvest' : 'health'; } catch (e) { return 'health'; } })();   // 'health' | 'harvest' — по какво се оцветяват дърветата на картата
  var STAT_PERIOD_KEY = 'walnut_statperiod'; // „днес“ или „седмица“ за горните бройки (пази се на устройството)
  var STAT_PERIODS = ['today', 'week', 'month', 'prevmonth', 'year']; // ред за дропдауна и ‹ › / суайп
  var statPeriod = (function () { try { var v = localStorage.getItem(STAT_PERIOD_KEY); return STAT_PERIODS.indexOf(v) !== -1 ? v : 'today'; } catch (e) { return 'today'; } })();
  var statsMode = 'season'; // изглед на Статистика: 'season' | 'month' | 'weeks'
  var statsRef = null;      // Date-курсор за месец/седмици (кой месец / коя група седмици)
  var logFilterTypes = []; // филтър на дневника по вид действие (празно = всички; иначе списък типове)
  var logFilterUsers = []; // филтър на дневника по човек (празно = всички; иначе списък id-та)
  var harvestHL = null;     // null или { id: kg } — подчертани дървета на картата (кой колко е дал)
  var statSuppressClick = false; // пропусни клика след суайп по бройките
  var mapSuppressClick = false; // пропусни клика след задържане/влачене, за да не размаркира
  var pendingBucketVals = null; // временно новите тегла на кофите, докато админът избере дали да преизчисли старите записи
  var walk = { watchId: null, orient: null, heading: null, pos: null, nearestId: null }; // режим „Разходка“
  var editMode = false;     // редактиране на схемата (само админ)
  var editingLmId = null;   // id на ориентира, който в момента се наглася (за подсветка)
  var editingLmKind = null; // вид на наглася ориентир (за смяна на цвят)
  var editingTreeId = null; // id на дървото, което в момента се мести (за подсветка)
  var lmStep = 'coarse';    // стъпка при местене на ориентир: 'coarse' (едро) или 'fine' (дребно)
  var floatPanelPos = null; // запомнена позиция на плаващия панел, след като го преместиш
  var pendingPhotoSrc = null; // избраната профилна снимка, докато се наглася вертикално
  var ppImgW = 0, ppImgH = 0; // размери на избраната снимка (за наместване: зуум + местене)
  var treeEditBefore = null; // снимка на дървото преди редактиране (за връщане при отказ/изтриване)
  var syncStatus = 'off';   // 'off' | 'connecting' | 'on' | 'error' — състояние на облачната синхронизация

  // ---- Helpers -----------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  // пази само цифри и водещия „+“ за tel: връзка
  function telHref(s) { s = String(s == null ? '' : s).replace(/[^\d+]/g, ''); return s.replace(/(?!^)\+/g, ''); }
  // „#rrggbb“ + прозрачност (0–1) → „rgba(r,g,b,a)“ за полупрозрачните площи
  function hexToRgba(hex, alpha) {
    var h = String(hex || '#8a5a2b').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substring(0, 2), 16) || 0;
    var g = parseInt(h.substring(2, 4), 16) || 0;
    var b = parseInt(h.substring(4, 6), 16) || 0;
    var a = Math.max(0, Math.min(1, alpha == null ? 1 : alpha));
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  // форматира телефон с разстояния за четливост (набирането минава през telHref)
  function fmtPhone(s) {
    if (s == null) return '';
    var raw = String(s).trim();
    var plus = raw.charAt(0) === '+';
    var d = raw.replace(/\D/g, '');
    if (plus && d.slice(0, 3) === '359' && d.length === 12) return '+359 ' + d.slice(3).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
    if (!plus && d.charAt(0) === '0' && d.length === 10) return d.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3');
    return raw; // непознат формат — не пипай
  }
  function save() { DB.save(db); if (window.Sync) window.Sync.push(); }
  function me() { return db.users.find(function (u) { return u.id === db.currentUserId; }) || null; }
  function isAdmin() { var m = me(); return m && m.role === 'admin'; }
  function isOwner() { var m = me(); return m && (m.isOwner || m.id === db.ownerId); }

  // ---- Активност на потребителите (последно онлайн + брой отваряния) ------
  // Пази се върху самия потребител (в users), затова се синхронизира за всички
  // и админите могат да го виждат в „Потребители и роли".
  function recordOpen() {
    var u = me(); if (!u) return;
    var now = Date.now();
    u.lastOnline = now;
    if (!Array.isArray(u.opens)) u.opens = [];
    var last = u.opens.length ? u.opens[u.opens.length - 1] : 0;
    if (now - last > 30 * 60 * 1000) u.opens.push(now); // ново отваряне (поне 30 мин пауза)
    var cut = now - 120 * 86400000;                     // пази историята до ~4 месеца
    u.opens = u.opens.filter(function (t) { return t >= cut; });
    save();
  }
  function startOfTodayMs() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function countOpens(u, sinceMs) {
    if (!u || !Array.isArray(u.opens)) return 0;
    return u.opens.filter(function (t) { return t >= sinceMs; }).length;
  }
  function fmtLastOnline(ts) {
    if (!ts) return 'никога';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'току-що';
    if (diff < 3600000) return 'преди ' + Math.floor(diff / 60000) + ' мин.';
    if (diff < 86400000) return 'преди ' + Math.floor(diff / 3600000) + ' ч.';
    var d = new Date(ts);
    var mo = ['ян', 'фев', 'март', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
    var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
    return d.getDate() + ' ' + mo[d.getMonth()] + ' ' + d.getFullYear() + ', ' + hh + ':' + mm;
  }

  // ---- Известия / непрочетени записи в дневника --------------------------
  // „Последно видяно" се пази локално на устройството, отделно за всеки потребител.
  var logViewSeen = 0;          // стойност за подчертаване на непрочетените при отваряне на дневника
  var _seenEventIds = null;     // кои event id-та вече сме виждали (за да известяваме само за новите)
  function logSeenKey() { return 'walnut_logseen_' + (db.currentUserId || ''); }
  function getLogSeen() { try { return parseInt(localStorage.getItem(logSeenKey()) || '0', 10) || 0; } catch (e) { return 0; } }
  function setLogSeen(ts) { try { localStorage.setItem(logSeenKey(), String(ts)); } catch (e) {} }
  // при първо влизане на даден потребител — приеми историята за „видяна", за да не свети цялата
  function initLogSeen() { try { if (localStorage.getItem(logSeenKey()) === null) setLogSeen(Date.now()); } catch (e) {} }
  function unreadLogCount() {
    var seen = getLogSeen(), n = 0;
    activeEvents().forEach(function (e) { if ((e.createdAt || 0) > seen && e.createdBy !== db.currentUserId) n++; });
    return n;
  }
  function markLogOpened() { logViewSeen = getLogSeen(); setLogSeen(Date.now()); updateAppBadge(); }
  // записва точната стойност в общия брояч (same-origin IndexedDB), за да е в синхрон
  // с брояча, който service worker-ът вдига при push със затворено приложение
  function writeBadgeCount(n) {
    try {
      var open = indexedDB.open('walnut-badge', 1);
      open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
      open.onsuccess = function () {
        try {
          var db = open.result, tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(n, 'count');
        } catch (e) {}
      };
    } catch (e) {}
  }
  // иконата на инсталираното приложение (ако средата поддържа Badging API) показва брой непрочетени
  function updateAppBadge() {
    var n = unreadLogCount();
    try {
      if (navigator.setAppBadge) { if (n > 0) navigator.setAppBadge(n); else if (navigator.clearAppBadge) navigator.clearAppBadge(); }
    } catch (e) {}
    writeBadgeCount(n);
  }
  function notifSupported() { return typeof window !== 'undefined' && 'Notification' in window; }
  // Показва системно известие през service worker-а (единственият начин, който работи на
  // iPhone/Android, когато приложението е добавено на екрана и/или е на заден план).
  // Връща се към new Notification() само ако SW не е наличен (стари десктоп браузъри).
  function showSysNotif(title, opts) {
    opts = opts || {};
    if (!opts.icon) opts.icon = 'assets/icon.svg';
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          try { reg.showNotification(title, opts); }
          catch (e) { try { new Notification(title, opts); } catch (e2) {} }
        }).catch(function () { try { new Notification(title, opts); } catch (e) {} });
        return;
      }
    } catch (e) {}
    try { new Notification(title, opts); } catch (e) {}
  }
  // Включени ли са известията — пази се локално на устройството (по дефолт ИЗКЛЮЧЕНИ),
  // отделно за всеки потребител. Не се синхронизира, за да не се включват сами на други телефони.
  function notifPrefKey() { return 'walnut_notif_' + (db.currentUserId || ''); }
  function getNotifPref() { try { return localStorage.getItem(notifPrefKey()) === '1'; } catch (e) { return false; } }
  function setNotifPref(on) { try { localStorage.setItem(notifPrefKey(), on ? '1' : '0'); } catch (e) {} }
  // засича нови (непознати) записи от ДРУГИ хора след синхронизация
  function primeSeenEvents() { _seenEventIds = {}; (db.events || []).forEach(function (e) { if (e && e.id) _seenEventIds[e.id] = 1; }); }
  function detectNewEvents() {
    if (!_seenEventIds) { primeSeenEvents(); return []; }
    var fresh = [];
    (db.events || []).forEach(function (e) {
      if (!e || !e.id || _seenEventIds[e.id]) return;
      _seenEventIds[e.id] = 1;
      if (!e.deletedAt && e.createdBy !== db.currentUserId) fresh.push(e);
    });
    return fresh;
  }
  function notifyNewEvents(list) {
    if (!me() || !getNotifPref()) return;
    if (!notifSupported() || Notification.permission !== 'granted') return;
    list.slice(0, 5).forEach(function (e) {
      var m = LOG_TYPES[e.type] || { ic: '📜', t: e.type };
      var who = db.users.find(function (x) { return x.id === e.createdBy; });
      var t = e.treeId ? tree(e.treeId) : null;
      var title = (m.ic || '📜') + ' ' + m.t + (t ? ' · ' + t.code : '');
      var body = (who ? who.name : '') + (e.note ? ' — ' + e.note : '');
      showSysNotif(title, { body: body, tag: e.id });
    });
  }
  // извиква се при пристигане на отдалечени промени — известява + обновява бройките
  function onRemoteEvents() {
    var fresh = detectNewEvents();
    if (fresh.length) notifyNewEvents(fresh);
    if (route.name === 'log') setLogSeen(Date.now()); // ако сме в дневника — не трупай непрочетени
    updateAppBadge();
  }
  // извиква се щом знаем кой е влезлият потребител (вход/регистрация/зареждане)
  function onUserReady() {
    initLogSeen(); primeSeenEvents(); updateAppBadge();
    recordOpen();
    // ако известията вече са включени — подновяваме push абонамента (нов токен/ново устройство)
    if (getNotifPref() && notifSupported() && Notification.permission === 'granted') subscribePush();
  }
  // UI за секцията „Известия" в Настройки
  function notifSettingsHtml() {
    var u = me();
    if (!notifSupported()) {
      return '<div class="chip orange">Този телефон/браузър не поддържа известия.</div>';
    }
    var perm = Notification.permission;
    var on = getNotifPref() && perm === 'granted';
    if (perm === 'denied') {
      return '<div class="chip red">Известията са блокирани от настройките на телефона/браузъра. Разреши ги за тази страница, за да ги включиш.</div>';
    }
    return '<div class="kv"><span class="k">Известия на този телефон</span><span class="v">' +
      '<button class="btn sm ' + (on ? '' : 'secondary') + '" data-action="toggnotif">' + (on ? '🔔 Включени' : '🔕 Изключени') + '</button>' +
      '</span></div>';
  }
  function toggleNotif() {
    var u = me();
    if (!u || !notifSupported()) return;
    var on = getNotifPref() && Notification.permission === 'granted';
    if (on) { setNotifPref(false); unsubscribePush(); render(); return; }
    // включване → искаме разрешение от системата (ако това устройство още няма)
    var apply = function (perm) {
      if (perm === 'granted') { setNotifPref(true); subscribePush(); showSysNotif('🔔 Известията са включени', { body: 'Ще те известяваме при нови записи в дневника.' }); }
      render();
    };
    if (Notification.permission === 'granted') { apply('granted'); return; }
    try {
      var r = Notification.requestPermission(apply);
      if (r && typeof r.then === 'function') r.then(apply);
    } catch (e) { render(); }
  }

  // ---- Истински push (при затворено приложение) през Cloudflare Worker ----
  function urlB64ToUint8Array(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  // постоянен идентификатор на устройството (ключ за документа в pushSubs)
  function pushDeviceId() {
    var k = 'walnut_push_dev';
    try {
      var v = localStorage.getItem(k);
      if (!v) { v = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return 'dev_tmp'; }
  }
  function pushConfigured() {
    var c = window.PUSH_CONFIG;
    return !!(c && c.publicKey && c.sendUrl && window.Sync && Sync.savePushSub);
  }
  // Абонира това устройство за push и записва абонамента във Firestore.
  function subscribePush() {
    if (!pushConfigured()) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(window.PUSH_CONFIG.publicKey)
        });
      });
    }).then(function (sub) {
      if (!sub) return;
      Sync.savePushSub(pushDeviceId(), {
        id: pushDeviceId(),
        userId: db.currentUserId || null,
        sub: JSON.parse(JSON.stringify(sub)),
        updatedAt: Date.now()
      });
    }).catch(function (e) { try { console.log('push subscribe err', e); } catch (x) {} });
  }
  // Маха абонамента на това устройство (при изключване на известията).
  function unsubscribePush() {
    if (!('serviceWorker' in navigator)) return;
    try { if (window.Sync && Sync.deletePushSub) Sync.deletePushSub(pushDeviceId()); } catch (e) {}
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) { if (sub) sub.unsubscribe(); }).catch(function () {});
  }
  // Праща push към всички ДРУГИ устройства при нов запис в дневника.
  function sendPushForEvent(ev) {
    if (!pushConfigured() || !ev || ev.deletedAt) return;
    var m = LOG_TYPES[ev.type] || { ic: '📜', t: ev.type };
    var t = ev.treeId ? tree(ev.treeId) : null;
    var who = me();
    var title = (m.ic || '📜') + ' ' + m.t + (t ? ' · ' + t.code : '');
    var body = (who ? who.name : '') + (ev.note ? ' — ' + ev.note : '');
    Sync.getPushSubs().then(function (list) {
      var subs = (list || []).filter(function (s) {
        return s && s.sub && s.userId !== db.currentUserId;
      }).map(function (s) { return s.sub; });
      if (!subs.length) return;
      return fetch(window.PUSH_CONFIG.sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptions: subs, title: title, body: body, tag: ev.id, url: './' })
      });
    }).catch(function (e) { try { console.log('push send err', e); } catch (x) {} });
  }

  function initials(name) { return (name || '?').trim().split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase(); }
  // аватар: профилна снимка ако има, иначе инициали
  function avatarHtml(u, extraClass, attr) {
    var cls = 'avatar' + (extraClass ? ' ' + extraClass : '');
    if (u && u.photo) return '<span class="' + cls + ' hasphoto"' + (attr || '') + ' title="' + esc(u.name || '') + '"><img src="' + u.photo + '" alt=""/></span>';
    return '<span class="' + cls + '"' + (attr || '') + ' title="' + esc(u ? (u.name || '') : '') + '">' + initials(u ? u.name : '?') + '</span>';
  }

  // ---- Мащаб на целия интерфейс (запазва се на устройството, не се синхронизира) ----
  var UI_ZOOM_KEY = 'walnut_zoom';
  function getZoom() { var z = parseFloat(localStorage.getItem(UI_ZOOM_KEY)); return (z >= 0.7 && z <= 1.6) ? z : 1; }
  function applyZoom() { try { document.documentElement.style.zoom = getZoom(); } catch (e) {} }
  function setZoom(z) {
    z = Math.round(z * 20) / 20; // стъпка 0.05
    if (z < 0.7) z = 0.7; else if (z > 1.6) z = 1.6;
    try { localStorage.setItem(UI_ZOOM_KEY, String(z)); } catch (e) {}
    applyZoom(); render();
  }
  function tree(id) { return db.trees.find(function (t) { return t.id === id; }); }
  function treePhotos(id) {
    var out = (db.photos || []).filter(function (p) { return p.treeId === id && !p.deletedAt; });
    var t = tree(id);
    if (t && t.photos && t.photos.length) out = out.concat(t.photos); // съвместимост със стар формат
    return out.slice().sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
  }
  // Основна (корична) снимка на дървото — избрана ръчно, иначе най-новата.
  function coverPhoto(id) {
    var photos = treePhotos(id);
    if (!photos.length) return null;
    var t = tree(id);
    if (t && t.coverPhotoId) {
      var chosen = photos.filter(function (p) { return p.id === t.coverPhotoId; })[0];
      if (chosen) return chosen;
    }
    return photos[photos.length - 1];
  }
  function setCover(treeId, photoId) {
    var t = tree(treeId); if (!t) return;
    t.coverPhotoId = photoId;
    save(); render();
  }
  // Изтрива снимка направо от дървото — работи и за старите (вградени) снимки.
  function removePhoto(treeId, photoId) {
    if (!confirm('Да изтрия ли тази снимка?')) return;
    if (db.photos) db.photos = db.photos.filter(function (p) { return p.id !== photoId; });
    var t = tree(treeId);
    if (t) {
      if (t.photos) t.photos = t.photos.filter(function (p) { return p.id !== photoId; }); // стар формат
      if (t.coverPhotoId === photoId) t.coverPhotoId = null;
    }
    var ev = db.events.filter(function (e) { return e.type === 'photo' && e.photoId === photoId && !e.deletedAt; })[0];
    if (ev) { ev.deletedAt = Date.now(); ev.deletedBy = db.currentUserId; }
    save(); render();
  }
  function variety(id) { return db.settings.varieties.find(function (v) { return v.id === id; }); }
  // визуален стил на сорта на картата: клас за цветен пръстен (ring_*) + флагче за легендата
  function varDecor(v) {
    if (!v) return { cls: '', flag: '' };
    var m = varMark(v);
    var cls = markRingCls(m) + labelClsFor(varLabel(v), m);
    var flag = (m === 'ring_bg' || m === 'flag_bg') ? '🇧🇬'
      : (m === 'ring_fr' || m === 'flag_fr') ? '🇫🇷'
        : (m === 'ring_linda' || m === 'flower' || m === 'letter') ? '🌸' : '';
    return { cls: cls, flag: flag };
  }
  // легенда с флагчетата само за наличните специални сортове
  function varietyLegend() {
    return (db.settings.varieties || []).filter(function (v) { return varDecor(v).flag; })
      .map(function (v) { return '<span>' + varDecor(v).flag + ' ' + esc(v.name) + '</span>'; }).join('');
  }
  function bucket(id) { return db.settings.buckets.find(function (b) { return b.id === id; }); }
  var BUCKET_IMG = { buc_cheese: 'assets/bucket_cheese.png', buc_black: 'assets/bucket_black.png', buc_small: 'assets/bucket_round.png' };
  function bucketIcon(b) {
    var src = (b && b.photo) || (b && BUCKET_IMG[b.id]);
    return src ? '<img src="' + src + '" alt="" style="width:100%;height:100%;object-fit:contain"/>' : '🪣';
  }
  function activeEvents() { return db.events.filter(function (e) { return !e.deletedAt; }); }
  function activeSales() { return (db.sales || []).filter(function (s) { return !s.deletedAt; }); }

  function fmtDate(iso) {
    if (!iso) return '';
    var m = ['ян', 'фев', 'март', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
  }
  function season(iso) {
    var mo = new Date(iso).getMonth() + 1;
    if (mo >= 3 && mo <= 5) return 'Пролет';
    if (mo >= 6 && mo <= 8) return 'Лято';
    if (mo >= 9 && mo <= 11) return 'Есен';
    return 'Зима';
  }

  function healthLabel(h) { return h === 'green' ? 'Здраво' : h === 'yellow' ? 'Нужда от грижа' : 'Болно / изсъхнало'; }

  // ---- Свежест на брането (кога дървото е брано за орехи) ----------------
  function lastHarvestISO(treeId) {
    var last = null;
    db.events.forEach(function (e) {
      if (e.deletedAt || e.type !== 'harvest_tree' || e.treeId !== treeId || !e.date) return;
      if (!last || e.date > last) last = e.date;
    });
    return last;
  }
  function harvestedToday(treeId) { return lastHarvestISO(treeId) === DB.todayISO(); }
  function harvestFreshness(treeId) {
    var iso = lastHarvestISO(treeId);
    if (!iso) return 'never';
    var days = Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000);
    if (days <= 1) return 'today';   // днес или вчера
    if (days <= 7) return 'week';    // тази седмица
    return 'old';                    // отдавна
  }
  // кратък надпис преди колко е брано: „днес“, „7д“, „3м“ (месеци след 30 дни)
  function harvestAgoLabel(treeId) {
    var iso = lastHarvestISO(treeId);
    if (!iso) return '';
    var days = Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000);
    if (days <= 0) return 'днес';
    if (days < 30) return days + 'д';
    return Math.round(days / 30) + 'м';
  }

  // сумира събраното за период: 'today' = днес, 'week' = последните 7 дни.
  // връща { kg: общо зелени, perTree: {id:kg}, groundKg: от земята }
  function isoDate(d) { var m = d.getMonth() + 1, day = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day; }
  // начална/крайна дата (вкл.) за период; 'prevmonth' = целият предходен календарен месец
  function periodRange(period) {
    var today = DB.todayISO();
    if (period === 'week') { var d = new Date(); d.setDate(d.getDate() - 6); return { start: isoDate(d), end: today }; }
    if (period === 'month') { var dm = new Date(); dm.setDate(dm.getDate() - 29); return { start: isoDate(dm), end: today }; }
    if (period === 'year') { var dy = new Date(); dy.setDate(dy.getDate() - 364); return { start: isoDate(dy), end: today }; }
    if (period === 'prevmonth') { var n = new Date(); return { start: isoDate(new Date(n.getFullYear(), n.getMonth() - 1, 1)), end: isoDate(new Date(n.getFullYear(), n.getMonth(), 0)) }; }
    return { start: today, end: today };
  }
  function harvestStats(period) {
    var r = periodRange(period);
    var perTree = {}, perTreeBk = {}, groundKg = 0, groundBk = 0, totalKg = 0, totalBk = 0;
    activeEvents().forEach(function (e) {
      if (e.type !== 'harvest_tree' && e.type !== 'harvest_ground') return;
      if (e.date < r.start || e.date > r.end) return;
      var k = eventKg(e); totalKg += k;
      var bk = greenCheeseBuckets(e); totalBk += bk;
      if (e.type === 'harvest_tree' && e.treeId) { perTree[e.treeId] = (perTree[e.treeId] || 0) + k; perTreeBk[e.treeId] = (perTreeBk[e.treeId] || 0) + bk; }
      else { groundKg += k; groundBk += bk; }
    });
    return { kg: totalKg, buckets: totalBk, perTree: perTree, perTreeBk: perTreeBk, groundKg: groundKg, groundBk: groundBk };
  }

  // ---- GPS helpers -------------------------------------------------------
  function treeGPS(t) {
    // връща {lat, lng} или null (съвместимо със стария текстов формат)
    if (!t || !t.gps) return null;
    if (typeof t.gps === 'object' && t.gps.lat != null) return { lat: +t.gps.lat, lng: +t.gps.lng };
    var m = String(t.gps).match(/(-?\d+\.?\d*)\s*[,; ]\s*(-?\d+\.?\d*)/);
    return m ? { lat: +m[1], lng: +m[2] } : null;
  }
  function distM(a, b) {
    // Хаверсин — разстояние в метри между две GPS точки
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var la1 = a.lat * toR, la2 = b.lat * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---- Tree SVG ----------------------------------------------------------
  var FRESH_COLORS = {
    today: ['#4bb869', '#2f9e52', '#1f7a43'],
    week: ['#f6c65a', '#f3b53c', '#d9962a'],
    old: ['#c3ccc6', '#aab7af', '#8b9a90'],
    never: ['#d9ded9', '#c3ccc6', '#a2b0a6']
  };
  function treeSVGColors(c) {
    return '<svg viewBox="0 0 64 64" width="100%" height="100%">' + shapeRound(c) + '</svg>';
  }
  function healthColors(health) {
    return health === 'green' ? ['#4bb869', '#2f9e52', '#1f7a43']
      : health === 'yellow' ? ['#f6c65a', '#f3b53c', '#d9962a']
        : ['#ec726b', '#e4584f', '#c23e36'];
  }
  function treeSVG(health) {
    return treeSVGColors(healthColors(health));
  }

  // ===== Форми на короната (избираеми по сорт) =====
  var TREE_SHAPES = [
    { id: 'round', name: 'Кръгла' },
    { id: 'bushy', name: 'Храстовидна' },
    { id: 'oval', name: 'Овална (тясна)' },
    { id: 'nuts', name: 'С орехчета' },
    { id: 'cone', name: 'Конусовидна' }
  ];
  function shapeRound(c) {
    return '<rect x="29" y="42" width="6" height="16" rx="2" fill="#8a5a3b"/>' +
      '<circle cx="22" cy="30" r="14" fill="' + c[2] + '"/>' +
      '<circle cx="42" cy="30" r="14" fill="' + c[1] + '"/>' +
      '<circle cx="32" cy="20" r="15" fill="' + c[0] + '"/>' +
      '<circle cx="32" cy="30" r="13" fill="' + c[1] + '"/>';
  }
  function shapeBushy(c) {
    return '<rect x="29" y="44" width="6" height="15" rx="2" fill="#8a5a3b"/>' +
      '<circle cx="20" cy="34" r="12" fill="' + c[2] + '"/>' +
      '<circle cx="44" cy="34" r="12" fill="' + c[2] + '"/>' +
      '<circle cx="26" cy="24" r="12" fill="' + c[1] + '"/>' +
      '<circle cx="40" cy="24" r="12" fill="' + c[1] + '"/>' +
      '<circle cx="32" cy="30" r="14" fill="' + c[0] + '"/>' +
      '<circle cx="32" cy="22" r="9" fill="' + c[1] + '"/>';
  }
  function shapeOval(c) {
    return '<rect x="30" y="42" width="5" height="17" rx="2" fill="#8a5a3b"/>' +
      '<ellipse cx="32" cy="28" rx="11" ry="20" fill="' + c[1] + '"/>' +
      '<ellipse cx="32" cy="24" rx="8.5" ry="15" fill="' + c[0] + '"/>' +
      '<ellipse cx="32" cy="34" rx="9" ry="12" fill="' + c[2] + '"/>';
  }
  function shapeNuts(c) {
    return shapeRound(c) +
      '<g><circle cx="24" cy="26" r="3.1" fill="#b07a44"/><path d="M24 23v6" stroke="#8a5a2f" stroke-width="1"/>' +
      '<circle cx="39" cy="24" r="3.1" fill="#b07a44"/><path d="M39 21v6" stroke="#8a5a2f" stroke-width="1"/>' +
      '<circle cx="33" cy="33" r="3.1" fill="#b07a44"/><path d="M33 30v6" stroke="#8a5a2f" stroke-width="1"/></g>';
  }
  function shapeCone(c) {
    return '<rect x="30" y="46" width="5" height="13" rx="2" fill="#8a5a3b"/>' +
      '<path d="M32 4 L46 46 L18 46 Z" fill="' + c[1] + '"/>' +
      '<path d="M32 10 L42 42 L22 42 Z" fill="' + c[0] + '"/>' +
      '<path d="M32 30 L44 46 L20 46 Z" fill="' + c[2] + '"/>';
  }
  function shapeInner(shape, c) {
    return shape === 'bushy' ? shapeBushy(c)
      : shape === 'oval' ? shapeOval(c)
        : shape === 'nuts' ? shapeNuts(c)
          : shape === 'cone' ? shapeCone(c)
            : shapeRound(c);
  }
  // контур (halo) около короната в цвят на бордъра — уголемена силуетна форма зад короната
  function shapeHalo(shape, color) {
    var f = ' fill="' + color + '"';
    if (shape === 'oval') return '<ellipse cx="32" cy="28" rx="13.5" ry="22.5"' + f + '/>';
    if (shape === 'cone') return '<path d="M32 1 L49.5 48 L14.5 48 Z"' + f + '/>';
    if (shape === 'bushy') return '<circle cx="20" cy="34" r="14.6"' + f + '/><circle cx="44" cy="34" r="14.6"' + f + '/><circle cx="26" cy="24" r="14.6"' + f + '/><circle cx="40" cy="24" r="14.6"' + f + '/><circle cx="32" cy="30" r="16.6"' + f + '/>';
    return '<circle cx="22" cy="30" r="16.4"' + f + '/><circle cx="42" cy="30" r="16.4"' + f + '/><circle cx="32" cy="20" r="17.4"' + f + '/>';
  }

  // ===== Знаци по сорт (знаменце/цветче/кръгче — рисуват се върху короната) =====
  // забележка: „пръстените" (ring_*) са през CSS клас, не през SVG.
  var TREE_MARKS = [
    { id: 'none', name: 'Без знак' },
    { id: 'flag_bg', name: '🇧🇬 Българско знаменце' },
    { id: 'flag_fr', name: '🇫🇷 Френско знаменце' },
    { id: 'ring_bg', name: 'Пръстен БГ (трикольор)' },
    { id: 'ring_fr', name: 'Пръстен ФР (трикольор)' },
    { id: 'ring_linda', name: 'Пръстен Линда (розов)' },
    { id: 'flower', name: '🌸 Цветче' },
    { id: 'bee', name: '🐝 Пчеличка' },
    { id: 'letter', name: 'Кръгче с буква' }
  ];
  // ===== Бордър около короната (по избор на админ) =====
  var TREE_BORDERS = [
    { id: 'none', name: 'Без бордър', color: '' },
    { id: 'orange', name: '🟠 Оранжев', color: '#f08a24' },
    { id: 'gold', name: '🟡 Златист', color: '#e3b23c' },
    { id: 'green', name: '🟢 Зелен', color: '#2f9e52' },
    { id: 'red', name: '🔴 Червен', color: '#d64545' },
    { id: 'brown', name: '🟤 Кафяв', color: '#8a5a3b' }
  ];
  function borderColor(id) { var b = TREE_BORDERS.find(function (x) { return x.id === id; }); return b ? b.color : ''; }
  function emblemBG() {
    return '<g><rect x="40.5" y="2" width="2.2" height="25" rx="0.9" fill="#6b5330"/>' +
      '<g stroke="#fff" stroke-width="0.5">' +
      '<rect x="42.6" y="2.4" width="19.5" height="5.3" fill="#fff"/>' +
      '<rect x="42.6" y="7.7" width="19.5" height="5.3" fill="#2f9e52"/>' +
      '<rect x="42.6" y="13" width="19.5" height="5.3" fill="#d32f2f"/></g>' +
      '<rect x="42.6" y="2.4" width="19.5" height="15.9" fill="none" stroke="#111" stroke-width="0.8"/></g>';
  }
  function emblemFR() {
    return '<g><rect x="40.5" y="2" width="2.2" height="25" rx="0.9" fill="#6b5330"/>' +
      '<g stroke="#fff" stroke-width="0.5">' +
      '<rect x="42.6" y="2.4" width="6.5" height="15" fill="#2b4b9b"/>' +
      '<rect x="49.1" y="2.4" width="6.5" height="15" fill="#fff"/>' +
      '<rect x="55.6" y="2.4" width="6.5" height="15" fill="#d32f2f"/></g>' +
      '<rect x="42.6" y="2.4" width="19.5" height="15" fill="none" stroke="#111" stroke-width="0.8"/></g>';
  }
  function emblemFlower() {
    return '<g transform="translate(45,12)"><g fill="#ef73b0" stroke="#fff" stroke-width="0.7">' +
      '<circle cx="0" cy="-6.6" r="4.2"/><circle cx="6.3" cy="-2" r="4.2"/><circle cx="3.9" cy="5.4" r="4.2"/>' +
      '<circle cx="-3.9" cy="5.4" r="4.2"/><circle cx="-6.3" cy="-2" r="4.2"/></g>' +
      '<circle cx="0" cy="0" r="3.4" fill="#ffd34d" stroke="#fff" stroke-width="0.7"/></g>';
  }
  function emblemLetter(letter) {
    return '<g transform="translate(47,9)"><circle r="7.5" fill="#d6559b" stroke="#fff" stroke-width="1.4"/>' +
      '<text x="0" y="3.4" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="sans-serif">' + esc(letter || '') + '</text></g>';
  }
  // пчеличка, гледаща нагоре (глава горе) — центрирана около (0,0)
  function emblemBee() {
    return '<g>' +
      '<path d="M-1.3 -8.4 q-1.4 -2.4 -3 -2.9" fill="none" stroke="#241b0e" stroke-width="0.7"/>' +
      '<path d="M1.3 -8.4 q1.4 -2.4 3 -2.9" fill="none" stroke="#241b0e" stroke-width="0.7"/>' +
      '<circle cx="-4.3" cy="-11.5" r="0.9" fill="#241b0e"/>' +
      '<circle cx="4.3" cy="-11.5" r="0.9" fill="#241b0e"/>' +
      '<ellipse cx="-5.2" cy="-1.4" rx="3.4" ry="4.9" fill="#e9f4fc" stroke="#a9cbe4" stroke-width="0.6" transform="rotate(-22 -5.2 -1.4)"/>' +
      '<ellipse cx="5.2" cy="-1.4" rx="3.4" ry="4.9" fill="#e9f4fc" stroke="#a9cbe4" stroke-width="0.6" transform="rotate(22 5.2 -1.4)"/>' +
      '<circle cx="0" cy="-6.4" r="2.9" fill="#241b0e"/>' +
      '<circle cx="-1" cy="-7" r="0.6" fill="#fff"/>' +
      '<ellipse cx="0" cy="1.8" rx="5" ry="6.6" fill="#f4c23a" stroke="#2b2111" stroke-width="0.9"/>' +
      '<path d="M-4.4 -1.2 H4.4" stroke="#2b2111" stroke-width="1.7"/>' +
      '<path d="M-4.4 4.6 H4.4" stroke="#2b2111" stroke-width="1.7"/>' +
      '<path d="M0 8.6 l-1.3 2.8 2.6 0 z" fill="#2b2111"/>' +
      '</g>';
  }
  function emblemInner(mark, letter) {
    if (mark === 'bee') return '<g transform="translate(47,13) scale(1.28)">' + emblemBee() + '</g>';
    var inner = mark === 'flag_bg' ? emblemBG()
      : mark === 'flag_fr' ? emblemFR()
        : mark === 'flower' ? emblemFlower()
          : mark === 'letter' ? emblemLetter(letter)
            : '';
    if (!inner) return '';
    // всички знаци една идея по-големи; център на скалиране по-наляво (56),
    // за да не се отрязва десният черен бордър на знамената от ръба на viewBox
    return '<g transform="translate(56,10) scale(1.18) translate(-56,-10)">' + inner + '</g>';
  }
  // CSS клас за цветния пръстен (ring_*), ако е избран
  function markRingCls(mark) {
    return mark === 'ring_bg' ? ' var-bg' : mark === 'ring_fr' ? ' var-fr' : mark === 'ring_linda' ? ' var-linda' : '';
  }
  // автоматичен цвят на етикета според знака
  function markCodeColor(mark) {
    return (mark === 'ring_bg' || mark === 'flag_bg') ? ' code-bg'
      : (mark === 'ring_fr' || mark === 'flag_fr') ? ' code-fr'
        : (mark === 'ring_linda' || mark === 'flower') ? ' code-linda'
          : mark === 'bee' ? ' code-bee' : '';
  }
  // CSS клас за оцветяване на етикета (по избор на админ: авто/без/конкретен цвят)
  function labelClsFor(label, mark) {
    if (label === 'none') return '';
    if (label === 'green') return ' code-bg';
    if (label === 'blue') return ' code-fr';
    if (label === 'pink') return ' code-linda';
    if (label === 'orange') return ' code-bee';
    return markCodeColor(mark); // auto
  }
  // пълно SVG дърво: (бордър) + форма + цвят (здраве/свежест) + знак
  function treeSVGFull(shape, c, mark, letter, border) {
    return '<svg viewBox="0 0 64 64" width="100%" height="100%">' +
      (border ? shapeHalo(shape, border) : '') + shapeInner(shape, c) + emblemInner(mark, letter) + '</svg>';
  }
  // форма и знак за даден сорт (с обратна съвместимост по име/размер)
  function varMark(v) {
    if (!v) return 'none';
    if (v.mark) return v.mark;
    var n = (v.name || '').toLowerCase();
    if (n.indexOf('българ') !== -1 || n.indexOf('bulgar') !== -1) return 'ring_bg';
    if (n.indexOf('френск') !== -1 || n.indexOf('french') !== -1 || n.indexOf('franc') !== -1) return 'ring_fr';
    if (n.indexOf('линда') !== -1 || n.indexOf('linda') !== -1) return 'ring_linda';
    if (n.indexOf('педро') !== -1 || n.indexOf('pedro') !== -1) return 'bee';
    return 'none';
  }
  function varShape(v) {
    if (!v) return 'round';
    if (v.shape) return v.shape;
    return (v.size === 'small' && varMark(v) === 'none') ? 'oval' : 'round';
  }
  function varLetter(v) { return v && v.name ? v.name.trim().charAt(0) : ''; }
  function varBorder(v) { return v && v.border ? v.border : 'none'; }
  function varLabel(v) { return v && v.label ? v.label : 'auto'; }

  // ---- Ориентири на картата (порти, цистерна, спирка, гнездо) ------------
  var LM_ICONS = {
    gate: '<svg viewBox="0 0 24 24"><g fill="#1f7a43"><rect x="5" y="4.4" width="14" height="2.2" rx="1"/><rect x="5" y="17.4" width="14" height="2.2" rx="1"/></g><g fill="none" stroke="#1f7a43" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 12 H15"/><path d="M12.3 9.3 L15.2 12 L12.3 14.7"/></g></svg>',
    gateUp: '<svg viewBox="0 0 24 24"><g fill="#1f7a43"><rect x="4.4" y="5" width="2.2" height="14" rx="1"/><rect x="17.4" y="5" width="2.2" height="14" rx="1"/></g><g fill="none" stroke="#1f7a43" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.2 V8.7"/><path d="M9.3 11.6 L12 8.7 L14.7 11.6"/></g></svg>',
    cistern: '<svg viewBox="0 0 24 24"><path d="M12 3C12 3 5 11 5 15a7 7 0 0 0 14 0C19 11 12 3 12 3Z" fill="#fff"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="3" y="6.5" width="18" height="9" rx="2.2" fill="#fff"/><g fill="#f3b53c"><rect x="5" y="8.3" width="3" height="3" rx="0.6"/><rect x="9" y="8.3" width="3" height="3" rx="0.6"/><rect x="13" y="8.3" width="3" height="3" rx="0.6"/><rect x="17" y="8.3" width="2" height="3" rx="0.6"/></g><circle cx="7.5" cy="16.3" r="1.9" fill="#fff"/><circle cx="7.5" cy="16.3" r="0.8" fill="#f3b53c"/><circle cx="16.5" cy="16.3" r="1.9" fill="#fff"/><circle cx="16.5" cy="16.3" r="0.8" fill="#f3b53c"/></svg>',
    nest: '<svg viewBox="0 0 24 24"><path d="M3 11c0 4 4 7 9 7s9-3 9-7Z" fill="#7a4a2f"/><ellipse cx="9.3" cy="10.6" rx="2.3" ry="1.9" fill="#fff"/><ellipse cx="14.7" cy="10.6" rx="2.3" ry="1.9" fill="#fff"/></svg>'
  };
  var LM_LABELS = { gate: 'Порта', cistern: 'Цистерна', stop: 'Спирка', nest: 'Гнездо' };
  // стандартни цветове на значките (ползват се и за бутона „върни цвета")
  var LM_DEFAULT_COLORS = { gate: '#cfe8d6', cistern: '#2e86de', stop: '#8ecbf2', nest: '#e4d2b2' };
  function lmColor(kind) {
    var c = db.settings && db.settings.landmarkColors && db.settings.landmarkColors[kind];
    return c || LM_DEFAULT_COLORS[kind] || '#cfe8d6';
  }
  function setLandmarkColor(kind, color) {
    if (!isAdmin() || !kind) return;
    if (!db.settings.landmarkColors) db.settings.landmarkColors = {};
    db.settings.landmarkColors[kind] = color;
    save(); updateMap();
  }
  // мащаб на иконките на ориентирите (админ-настройка, синхронизира се за всички)
  function lmScale() { var s = db.settings && db.settings.landmarkScale; return (typeof s === 'number' && s > 0) ? s : 1; }
  function setLmScale(val) {
    if (!isAdmin()) return;
    var v = Math.max(0.5, Math.min(2, Math.round(val * 10) / 10));
    db.settings.landmarkScale = v;
    save(); render();
  }

  function landmarkPrefKey() { return 'walnut_landmarks_' + (db.currentUserId || ''); }
  // по подразбиране ориентирите се виждат (освен ако потребителят ги е изключил)
  function landmarksVisible() { try { return localStorage.getItem(landmarkPrefKey()) !== '0'; } catch (e) { return true; } }
  function setLandmarksVisible(on) { try { localStorage.setItem(landmarkPrefKey(), on ? '1' : '0'); } catch (e) {} }
  function lmById(id) { return (db.settings.landmarks || []).find(function (m) { return m.id === id; }); }

  function landmarksHTML(edit) {
    var list = db.settings.landmarks || [];
    if (!list.length) return '';
    return list.map(function (m) {
      var act = edit ? ' data-action="editlm:' + m.id + '"' : '';
      var ed = edit ? ' editable' : '';
      var hledit = (m.id === editingLmId) ? ' lm-editing' : '';
      var dx = m.dx || 0, dy = m.dy || 0;
      var col = (db.settings.landmarkColors && db.settings.landmarkColors[m.kind]) ? ';background:' + db.settings.landmarkColors[m.kind] : '';
      var icon = (m.kind === 'gate' && m.dir === 'up') ? LM_ICONS.gateUp : (LM_ICONS[m.kind] || '');
      return '<div class="lm badge ' + m.kind + ' lm-' + (m.anchor || 'c') + ed + hledit + '"' + act +
        ' style="grid-row:' + m.gr + ';grid-column:' + m.gc + ' / span 2;--dx:' + dx + ';--dy:' + dy + col + '">' +
        icon + '</div>';
    }).join('');
  }

  // ---- Event logging -----------------------------------------------------
  function addEvent(ev) {
    ev.id = DB.uid('ev');
    ev.createdBy = db.currentUserId;
    ev.createdAt = Date.now();
    ev.deletedAt = null;
    ev.deletedBy = null;
    db.events.unshift(ev);
    if (_seenEventIds) _seenEventIds[ev.id] = 1; // собствените записи не са „нови известия"
    recordOpen(); // всяко действие значи, че човекът е бил онлайн (вкл. save+push)
    save();
    sendPushForEvent(ev); // push към останалите, дори при тяхно затворено приложение
  }
  function softDelete(evId) {
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e) return;
    e.deletedAt = Date.now();
    e.deletedBy = db.currentUserId;
    if (e.type === 'tree_edit' && e.changes && e.treeId) revertTreeChanges(e, true);
    if (e.type === 'photo' && e.photoId) setPhotoDeleted(e.photoId, true, e.treeId);
    if (e.type === 'sale_add' && e.saleId) setSaleDeleted(e.saleId, true);
    save();
  }
  function restore(evId) {
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e) return;
    e.deletedAt = null; e.deletedBy = null;
    if (e.type === 'tree_edit' && e.changes && e.treeId) revertTreeChanges(e, false);
    if (e.type === 'photo' && e.photoId) setPhotoDeleted(e.photoId, false, e.treeId);
    if (e.type === 'sale_add' && e.saleId) setSaleDeleted(e.saleId, false);
    save();
  }
  // Окончателно маха запис от дневника (за тестови записи) — не може да се върне.
  function purgeEvent(evId) {
    var i = db.events.findIndex(function (x) { return x.id === evId; });
    if (i === -1) return;
    var e = db.events[i];
    if (e && e.type === 'sale_add' && e.saleId && db.sales) {
      db.sales = db.sales.filter(function (s) { return s.id !== e.saleId; }); // махни и самата продажба
    }
    db.events.splice(i, 1);
    save(); render();
  }
  // Маркира/връща продажбата като изтрита (върви заедно със записа ѝ в дневника).
  function setSaleDeleted(saleId, deleted) {
    var s = (db.sales || []).find(function (x) { return x.id === saleId; });
    if (s) { s.deletedAt = deleted ? Date.now() : null; s.deletedBy = deleted ? db.currentUserId : null; }
  }
  // Изтриване/връщане на снимка заедно със записа ѝ в дневника.
  function setPhotoDeleted(photoId, deleted, treeId) {
    var p = (db.photos || []).filter(function (x) { return x.id === photoId; })[0];
    if (p) p.deletedAt = deleted ? Date.now() : null;
    if (deleted) {
      var t = tree(treeId);
      if (t && t.coverPhotoId === photoId) t.coverPhotoId = null; // падни на най-новата
    }
  }
  // Сърце-реакция — всеки (работник и админ) може да хареса/отхаресва запис.
  function toggleReaction(evId) {
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e || !db.currentUserId) return;
    if (!e.reactions) e.reactions = [];
    var i = e.reactions.indexOf(db.currentUserId);
    if (i === -1) e.reactions.push(db.currentUserId); else e.reactions.splice(i, 1);
    save(); render();
  }
  // Връща променените полета на дървото. toBefore=true → връща както е било;
  // false → прилага отново (при възстановяване). Променя само акото няма по-нова промяна отгоре.
  function revertTreeChanges(e, toBefore) {
    var t = tree(e.treeId); if (!t) return;
    Object.keys(e.changes).forEach(function (f) {
      var ch = e.changes[f];
      var expect = toBefore ? ch.after : ch.before;
      var next = toBefore ? ch.before : ch.after;
      if (JSON.stringify(t[f] == null ? null : t[f]) === JSON.stringify(expect == null ? null : expect)) t[f] = next;
    });
  }

  // ---- Bucket math -------------------------------------------------------
  // нето тегло на 1 кофа: въведеното (с кофата) минус теглото на самата кофа (tareKg)
  function bucketNetKg(b, field) {
    if (!b) return 0;
    var raw = field === 'clean' ? b.cleanKg : field === 'shelled' ? b.shelledKg : b.greenKg;
    if (!(raw > 0)) return 0;
    var net = raw - (b.tareKg || 0);
    return net > 0 ? net : 0;
  }
  // тегло на 1 кофа според вида: зелени / обелени с черупка / чиста ядка (вече без кофата)
  function stateKg(b, state) { return !b ? 0 : bucketNetKg(b, state); }
  function stateLabel(state) { return state === 'clean' ? 'чиста ядка' : state === 'shelled' ? 'обелени (с черупка)' : 'зелени'; }
  function eventKg(ev) {
    if (ev.lockKg != null) return ev.lockKg; // замразено тегло — не се преизчислява при промяна на кофите
    if (!ev.buckets) return 0;
    var fill = (ev.fill != null ? ev.fill : 100) / 100; // колко пълни са били кофите
    var total = 0;
    Object.keys(ev.buckets).forEach(function (bid) {
      var b = bucket(bid); if (!b) return;
      var w = stateKg(b, ev.state);
      total += (ev.buckets[bid] || 0) * w;
    });
    return total * fill;
  }
  function eventBuckets(ev) {
    if (!ev.buckets) return 0;
    return Object.keys(ev.buckets).reduce(function (s, k) { return s + (ev.buckets[k] || 0); }, 0);
  }
  // колко „кофи за сирене" зелено съдържа едно събиране — по ОБЕМ (литри) на всяка кофа поотделно,
  // за да сметнем обелените (които винаги се мерят в кофи за сирене), независимо в каква кофа е събрано зеленото
  function greenCheeseBuckets(ev) {
    if (!ev.buckets) return 0;
    var ref = refBucket();
    var cheeseL = (ref && ref.liters > 0) ? ref.liters : 10;
    var fill = (ev.fill != null ? ev.fill : 100) / 100;
    var sum = 0;
    Object.keys(ev.buckets).forEach(function (bid) {
      var b = bucket(bid); if (!b) return;
      var L = (b.liters > 0) ? b.liters : cheeseL;
      sum += (ev.buckets[bid] || 0) * (L / cheeseL);
    });
    return sum * fill;
  }
  // обелени кг от едно събиране: зелени кофи за сирене × коефициент × „С черупка" на кофата за сирене
  function eventShelledKg(ev) {
    return greenCheeseBuckets(ev) * shellYield() * refBucketShelledKg();
  }
  // „2 × Черна кофа“ (или няколко вида, събрани с +) за показване в дневника
  function eventBucketNames(ev) {
    if (!ev.buckets) return '';
    return Object.keys(ev.buckets).filter(function (bid) { return ev.buckets[bid]; }).map(function (bid) {
      var b = bucket(bid);
      return fmtKg(ev.buckets[bid]) + ' × ' + (b ? b.name : 'кофа');
    }).join(' + ');
  }
  // малка картинка/емотиконка на кофа за вграждане в текст (дневник)
  function bucketThumb(b) {
    var src = (b && b.photo) || (b && BUCKET_IMG[b.id]);
    return src ? '<img class="bkthumb" src="' + src + '" alt=""/>' : '🪣';
  }
  // същото като eventBucketNames, но с картинки на кофите — за дневника
  function eventBucketNamesHtml(ev) {
    if (!ev.buckets) return '';
    return Object.keys(ev.buckets).filter(function (bid) { return ev.buckets[bid]; }).map(function (bid) {
      var b = bucket(bid);
      return '<span class="bkchip">' + bucketThumb(b) + fmtKg(ev.buckets[bid]) + ' × ' + (b ? esc(b.name) : 'кофа') + '</span>';
    }).join(' + ');
  }
  // показва килограми с до 3 десетични знака, без излишни нули (напр. 3.75, 10, 0.5)
  function fmtKg(n) {
    n = Math.round(((n || 0) + Number.EPSILON) * 1000) / 1000;
    return n.toFixed(3).replace(/\.?0+$/, '');
  }
  // като fmtKg, но закръгля до 2 знака след десетичната запетая
  function fmtKg2(n) {
    n = Math.round(((n || 0) + Number.EPSILON) * 100) / 100;
    return n.toFixed(2).replace(/\.?0+$/, '');
  }
  // еталонна кофа за броене („кофа за сирене“) — спрямо нея се смятат „кофи днес“
  function refBucket() { return bucket('buc_cheese') || (db.settings.buckets && db.settings.buckets[0]); }
  function refBucketKg() {
    var net = bucketNetKg(refBucket(), 'green');
    return net > 0 ? net : 10;
  }
  // тегло на 1 обелена (с черупка) еталонна кофа — за него се ползва „С черупка" на кофата за сирене (нето, без кофата)
  function refBucketShelledKg() {
    var net = bucketNetKg(refBucket(), 'shelled');
    return net > 0 ? net : refBucketKg();
  }
  // колко обелени кофи излизат от 1 зелена кофа по обем (нагласва се в Настройки)
  function shellYield() { var y = db.settings ? db.settings.shellYield : null; return (y != null && y > 0) ? y : 0.5; }
  // ръчно въведените обелени кофи за даден ден (най-новият активен запис), или null
  function shellOverrideFor(dateISO) {
    var found = null;
    activeEvents().forEach(function (e) {
      if (e.type === 'shell' && e.date === dateISO && (!found || e.createdAt > found.createdAt)) found = e;
    });
    return found;
  }
  // обобщава обелените кофи за период: ръчно въведеното за деня надделява над авто-сметката.
  // авто-сметката: за всяка събрана кофа зелено смятаме колко кофи за сирене е по обем (greenCheeseBuckets),
  // после × коефициент (shellYield) = обелени кофи за сирене; теглото е „С черупка" на кофата за сирене.
  function shelledStats(period) {
    var r = periodRange(period);
    var days = [];
    var cur = new Date(r.start + 'T00:00:00'), end = new Date(r.end + 'T00:00:00');
    while (cur <= end) { days.push(isoDate(cur)); cur.setDate(cur.getDate() + 1); }
    var greenBkByDay = {};
    activeEvents().forEach(function (e) {
      if (e.type !== 'harvest_tree' && e.type !== 'harvest_ground') return;
      if (days.indexOf(e.date) === -1) return;
      greenBkByDay[e.date] = (greenBkByDay[e.date] || 0) + greenCheeseBuckets(e);
    });
    var buckets = 0, kg = 0, manual = false;
    days.forEach(function (dt) {
      var ov = shellOverrideFor(dt);
      if (ov) { buckets += (ov.buckets || 0); kg += (ov.buckets || 0) * refBucketShelledKg(); manual = true; }
      else { var shBk = (greenBkByDay[dt] || 0) * shellYield(); buckets += shBk; kg += shBk * refBucketShelledKg(); }
    });
    return { buckets: buckets, kg: kg, manual: manual };
  }
  // рандеман: каква част от обелените (с черупка) е чиста ядка — от калкулатора в Настройки
  function kernelYield() {
    var s = db.settings;
    if (s && s.yieldInputKg > 0 && s.yieldOutputKg > 0) return s.yieldOutputKg / s.yieldInputKg;
    return 0.48;
  }
  // сортиране (4-ти процес): сумира реално сортираните бели и черни ядки за сезона
  function sortStats() {
    var white = 0, black = 0;
    activeEvents().forEach(function (e) { if (e.type === 'sort') { white += (e.whiteKg || 0); black += (e.blackKg || 0); } });
    return { white: white, black: black, total: white + black };
  }
  // само сортиранията, отбелязани да се броят за средния дял бели (excludeAvg !== true)
  function sortAvgStats() {
    var white = 0, black = 0, count = 0;
    activeEvents().forEach(function (e) { if (e.type === 'sort' && !e.excludeAvg) { white += (e.whiteKg || 0); black += (e.blackKg || 0); count++; } });
    return { white: white, black: black, total: white + black, count: count };
  }
  // какъв дял от изчистената ядка е бяла. Приоритет: избраните сортирания за средното; иначе калибровката „средно от 1 кофа".
  // връща null, ако още нищо не е въведено.
  function whitePct() {
    var ss = sortAvgStats();
    if (ss.total > 0) return ss.white / ss.total;
    var s = db.settings;
    if (!s) return null;
    var w = s.whiteKg, k = s.blackKg;
    if ((w > 0 || k > 0)) { var tot = (w || 0) + (k || 0); return tot > 0 ? (w || 0) / tot : null; }
    return null;
  }
  // общо обелени (с черупка) кг за целия сезон — ръчното за деня надделява над авто-сметката
  function totalShelledKg() {
    var greenBkByDay = {}, dates = {};
    activeEvents().forEach(function (e) {
      if (e.type === 'harvest_tree' || e.type === 'harvest_ground') { greenBkByDay[e.date] = (greenBkByDay[e.date] || 0) + greenCheeseBuckets(e); dates[e.date] = 1; }
      else if (e.type === 'shell') dates[e.date] = 1;
    });
    var total = 0;
    Object.keys(dates).forEach(function (dt) {
      var ov = shellOverrideFor(dt);
      if (ov) total += (ov.buckets || 0) * refBucketShelledKg();
      else total += (greenBkByDay[dt] || 0) * shellYield() * refBucketShelledKg();
    });
    return total;
  }
  // обобщава изчистената ядка: очаквано (от рандемана), въведено досега и колко остава
  function kernelStats() {
    var shelledKg = totalShelledKg();
    var expected = shelledKg * kernelYield();
    var actual = 0;
    activeEvents().forEach(function (e) { if (e.type === 'clean') actual += (e.kg || 0); });
    var remaining = Math.max(0, expected - actual);
    var wp = whitePct();
    var ss = sortStats();
    // оставащите бели = дялът бели × оставащото изчистено; очакваното бяло = вече сортирано + това
    var remainingWhite = wp != null ? wp * remaining : null;
    var expectedWhite = wp != null ? ss.white + remainingWhite : null;
    return {
      expected: expected, actual: actual, remaining: remaining,
      whitePct: wp,
      expectedWhite: expectedWhite, remainingWhite: remainingWhite,
      sortedWhite: ss.white, sortedBlack: ss.black, sortedTotal: ss.total
    };
  }
  // колко пълни еталонни кофи се падат за дадено тегло (2 кофи = реално напълнени, не просто въведени)
  function bucketsEq(kg) { return (kg || 0) / refBucketKg(); }

  // =======================================================================
  //  NAVIGATION
  // =======================================================================
  function go(name, param) {
    if (route.name === 'walk' && name !== 'walk') stopWalk();
    if (editingLmId || editingTreeId) closeLmEditor();
    if (name !== 'home' && mapSelected.length) clearMapSelect();
    if (name === 'harvest') harvestScreen = 'none'; // екран „Действия“ се отваря без избран таб
    if (name === 'log') markLogOpened(); // влизане в дневника → маркирай като видяно и махни бройката
    route = { name: name, param: param || null };
    // добавя запис в историята, за да работи бутонът „назад“ / суайп жестът на iPhone вътре в приложението
    try { history.pushState({ route: route }, '', '#' + name + (param ? '/' + encodeURIComponent(param) : '')); } catch (err) {}
    if (name === 'tree') resetViewportZoom(); // при отваряне на орех — върни картата от увеличението
    render(); scrollTop0();
  }

  // надеждно връщане в началото на страницата след смяна на изглед; синхронното
  // scrollTo понякога се пренебрегва заради scroll-anchoring на браузъра (когато идваме
  // от скролната карта), затова го повтаряме и на следващия кадър
  function scrollTop0() {
    window.scrollTo(0, 0);
    try { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) {}
    requestAnimationFrame(function () { window.scrollTo(0, 0); });
  }

  // връща страницата от pinch-увеличението (когато работникът е зуумнал по картата, за да намери орех)
  function resetViewportZoom() {
    try {
      var vp = document.querySelector('meta[name=viewport]');
      if (!vp) return;
      var orig = vp.getAttribute('content');
      vp.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1');
      setTimeout(function () { vp.setAttribute('content', orig); }, 350);
    } catch (e) {}
  }

  // назад през историята (телефонен бутон „назад“ и iOS суайп правят същото чрез popstate)
  function goBack() {
    if (isLightboxOpen()) { closeLightbox(); return; }
    if (editingLmId || editingTreeId) { closeLmEditor(); return; }
    if (isSheetOpen()) { closeSheet(); return; }
    if (history.length > 1) history.back(); else go('home');
  }
  function isSheetOpen() { var s = el('sheet'); return !!(s && s.classList.contains('open')); }

  window.addEventListener('popstate', function (e) {
    // ако е отворена уголемена снимка (lightbox) — затвори нея и остани на същия изглед
    if (isLightboxOpen()) { closeLightbox(); try { history.pushState({ route: route }, ''); } catch (err) {} return; }
    // ако има отворен лист (sheet) — затвори него и остани на същия изглед
    if (isSheetOpen()) { closeSheet(); try { history.pushState({ route: route }, ''); } catch (err) {} return; }
    // ако се наглася ориентир или се мести дърво — затвори панела и остани на картата
    if (editingLmId || editingTreeId) { closeLmEditor(); try { history.pushState({ route: route }, ''); } catch (err) {} return; }
    var st = e.state && e.state.route;
    if (route.name === 'walk') stopWalk();
    if (mapSelected.length) clearMapSelect();
    route = st || { name: db.currentUserId ? 'home' : 'login', param: null };
    render(); scrollTop0();
  });

  // =======================================================================
  //  RENDER
  // =======================================================================
  function render() {
    var app = el('app');
    if (!db.currentUserId) { app.className = 'app'; app.innerHTML = viewLogin(); _lastHTML = ''; bind(); return; }
    app.className = 'app';
    // нормализирай непознат/начален маршрут към „home“, за да работят коректно картата и бутоните
    var known = ['home', 'tree', 'harvest', 'care', 'log', 'stats', 'sales', 'buyer', 'settings', 'walk'];
    if (known.indexOf(route.name) === -1) route.name = 'home';
    var body = '';
    switch (route.name) {
      case 'home': body = viewHome(); break;
      case 'tree': body = viewTree(route.param); break;
      case 'harvest': body = viewHarvest(); break;
      case 'care': body = viewCare(); break;
      case 'log': body = viewLog(); break;
      case 'stats': body = viewStats(); break;
      case 'sales': body = viewSales(); break;
      case 'buyer': body = viewBuyer(route.param); break;
      case 'settings': body = viewSettings(); break;
      case 'walk': body = viewWalk(); break;
      default: body = viewHome();
    }
    var html = body + bottomNav();
    // ако резултатът е същият (напр. облачна синхронизация без реална промяна),
    // не пипаме DOM — иначе числата „премигват" без причина при зареждане
    if (html === _lastHTML && app.childNodes.length) return;
    _lastHTML = html;
    app.innerHTML = html;
    bind();
    if (route.name === 'walk') startWalk();
    if (route.name === 'home') { initMapSelect(); renderMapBar(); initStatSwipe(); }
  }
  var _lastHTML = '';

  // =======================================================================
  //  ОБЛАЧНА СИНХРОНИЗАЦИЯ
  // =======================================================================
  function setSyncStatus(s) {
    var was = syncStatus;
    syncStatus = s;
    var box = el('syncStatus');
    if (box) box.innerHTML = syncStatusHtml();
    // Щом връзката се включи (shadow-ът вече е изграден), отбелязваме „онлайн" така,
    // че да се качи в облака — иначе първоначалният snapshot презаписва lastOnline.
    if (s === 'on' && was !== 'on' && db.currentUserId) recordOpen();
  }
  function syncStatusText() {
    return syncStatus === 'on' ? 'включена'
      : syncStatus === 'connecting' ? 'свързване…'
        : syncStatus === 'error' ? 'грешка във връзката'
          : 'изключена (не е настроена)';
  }
  function syncStatusHtml() {
    var dot = syncStatus === 'on' ? '🟢' : syncStatus === 'connecting' ? '🟡' : syncStatus === 'error' ? '🔴' : '⚪';
    return dot + ' Облачна синхронизация: <b>' + syncStatusText() + '</b>';
  }
  // Облакът може да пази старото име на кокошарника → нормализираме към новото.
  function normalizeZones() {
    if (!db.settings || !db.settings.zones) return false;
    var changed = false;
    db.settings.zones.forEach(function (z) {
      if (z.kind === 'coop' && z.label === 'Кокошки') { z.label = 'Кошита'; changed = true; }
    });
    return changed;
  }
  // Облакът може да е без ориентири (стара структура) → добавяме стандартните.
  function ensureLandmarks() {
    if (!db.settings) return false;
    if (!db.settings.landmarks || !db.settings.landmarks.length) {
      db.settings.landmarks = DB.defaultLandmarks();
      return true;
    }
    return false;
  }
  // Стара структура от облака може да е без площи → гарантираме масива, за да не гръмне кодът.
  function ensureAreas() {
    if (!db.settings) return false;
    if (!db.settings.areas) { db.settings.areas = []; return true; }
    return false;
  }
  // Облакът вече има данни → приемаме тях (пазим кой е влязъл на този телефон).
  function applyCloudSnapshot(cloud) {
    var keepUser = db.currentUserId;
    var cols = ['trees', 'events', 'buyers', 'sales', 'users', 'photos'];
    // сравняваме без значение на реда — Firestore връща документите разбъркани,
    // за да не прерисуваме (и да „премигват" числата), ако всъщност нищо не се е сменило
    var changed = false;
    cols.forEach(function (c) { if (cloud[c] && colSig(cloud[c]) !== colSig(db[c])) changed = true; });
    if (cloud.settings && jsonSig(cloud.settings) !== jsonSig(db.settings)) changed = true;
    cols.forEach(function (c) { if (cloud[c]) db[c] = cloud[c]; });
    if (cloud.settings) db.settings = cloud.settings;
    db.currentUserId = keepUser;
    var addedSales = backfillSaleEvents();
    if (addedSales) { changed = true; if (window.Sync) window.Sync.push(); }
    var fixed = normalizeZones();
    var fixedLm = ensureLandmarks();
    var fixedAr = ensureAreas();
    var fixedGate = DB.fixGateArrow(db);
    DB.migratePhotos(db);
    DB.save(db);
    if ((fixed || fixedLm || fixedAr || fixedGate) && window.Sync) window.Sync.push();
    if (changed || fixed || fixedLm || fixedAr || fixedGate) render();
    primeSeenEvents();   // след първоначалното зареждане приемаме всичко за видяно
    updateAppBadge();
  }
  // подпис на колекция, нечувствителен към реда на записите
  function colSig(arr) {
    return (arr || []).map(function (it) { return (it && it.id ? it.id + ':' : '') + jsonSig(it); }).sort().join('|');
  }
  function jsonSig(o) { try { return JSON.stringify(o); } catch (e) { return ''; } }
  function startSync() {
    if (!window.Sync) return;
    window.Sync.init({
      getLocalDb: function () { return db; },
      onInitialLoad: applyCloudSnapshot,
      onRemote: function () { var fixed = normalizeZones(); var fixedLm = ensureLandmarks(); var fixedAr = ensureAreas(); var fixedGate = DB.fixGateArrow(db); var addedSales = backfillSaleEvents(); DB.migratePhotos(db); DB.save(db); if ((fixed || fixedLm || fixedAr || fixedGate || addedSales) && window.Sync) window.Sync.push(); onRemoteEvents(); if (!isSheetOpen()) render(); },
      setStatus: setSyncStatus
    });
  }

  // ---- Topbar ------------------------------------------------------------
  function logoSVG() {
    return '<svg class="logo" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#e7f4ec"/>' +
      '<path d="M24 12c-6 4-9 9-9 15 0 5 4 9 9 9s9-4 9-9c0-6-3-11-9-15z" fill="#2f9e52"/>' +
      '<path d="M24 16v22M24 24c-3-1-5-3-6-6M24 28c3-1 5-3 6-6" stroke="#1f7a43" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  }
  function topbar(title, opts) {
    opts = opts || {};
    var m = me();
    var left = opts.back
      ? '<button class="back" data-action="back">‹</button>'
      : '<span class="brand">' + logoSVG() + '</span>';
    return '<div class="topbar">' + left +
      (opts.back ? '<b style="font-size:19px">' + esc(title) + '</b>' : '<b style="font-size:19px">' + esc(title) + '</b>') +
      '<span class="spacer"></span>' +
      '<div class="user"><div class="nm"><b>' + esc(m.name) + '</b><small>' + (m.role === 'admin' ? 'Администратор' : 'Работник') + '</small></div>' +
      avatarHtml(m, '', ' data-action="settings"') + '</div></div>';
  }

  // ---- Bottom nav --------------------------------------------------------
  function bottomNav() {
    var items = [
      { k: 'home', ic: '🗺️', t: 'Градина' },
      { k: 'harvest', ic: '🧺', t: 'Действия' },
      { k: 'sales', ic: '💰', t: 'Клиенти' },
      { k: 'stats', ic: '📊', t: 'Статистика' },
      { k: 'log', ic: '📜', t: 'Дневник' }
    ];
    return '<div class="bottomnav">' + items.map(function (i) {
      var active = (route.name === i.k || (i.k === 'sales' && route.name === 'buyer')) ? ' active' : '';
      var badge = '';
      if (i.k === 'log') { var n = unreadLogCount(); if (n > 0) badge = '<span class="navbadge">' + (n > 99 ? '99+' : n) + '</span>'; }
      return '<div class="nav' + active + '" data-action="nav:' + i.k + '"><span class="ic">' + i.ic + badge + '</span>' + i.t + '</div>';
    }).join('') + '</div>';
  }

  // =======================================================================
  //  LOGIN
  // =======================================================================
  function viewLogin() {
    return '<div class="login">' +
      '<div class="hero"><div class="brand">' + logoSVG() +
      '<div><b>Орехова градина</b><small>Проследявай · Грижи се · Събирай</small></div></div></div>' +
      '<div class="panel">' +
      '<h1>Добре дошли!</h1><p class="sub">Избери кой си или напиши името си, за да започнеш.</p>' +
      '<div class="field"><label>Избери потребител</label><div id="userList">' +
      db.users.filter(function (u) { return !u.deletedAt; }).map(function (u) {
        var isAdm = u.role === 'admin';
        return '<button class="btn secondary mb" data-action="login:' + u.id + '" style="justify-content:space-between">' +
          '<span>' + avatarHtml(u, 'loginav') + esc(u.name) + '</span>' +
          '<span class="badge ' + (isAdm ? 'green' : 'orange') + '">' + (isAdm ? '🔒 Админ' : 'Работник') + '</span></button>';
      }).join('') + '</div>' +
      '<div class="section-title">Нов помагач</div>' +
      '<p class="muted mb" style="font-size:13px">Нов потребител влиза като <b>работник</b> (без парола). Администратор се прави само от главния стопанин.</p>' +
      '<div class="field"><div class="input-icon"><span class="ic">👤</span>' +
      '<input id="newName" class="input" placeholder="Вашето име" /></div></div>' +
      '<button class="btn" data-action="register">Влез в приложението</button>' +
      '</div></div>';
  }

  // =======================================================================
  //  HOME / MAP
  // =======================================================================
  // малка пчеличка-иконка за легендата (идентификатор на Педро)
  function beeIconSVG() {
    return '<svg class="bee-ico" viewBox="-9.2 -14 18.4 28" width="11" height="17">' + emblemBee() + '</svg>';
  }
  // Легендата под картата — броячите се филтрират по избрания сорт (fVar)
  function mapLegend(fVar, mode) {
    var trees = db.trees.filter(function (t) { return !t.deletedAt && (!fVar || t.varietyId === fVar); });
    if (mode === 'harvest') {
      var fr = { fresh: 0, week: 0, old: 0 }, doneToday = 0;
      trees.forEach(function (t) {
        var f = harvestFreshness(t.id);
        if (f === 'today') fr.fresh++; else if (f === 'week') fr.week++; else fr.old++;
        if (harvestedToday(t.id)) doneToday++;
      });
      return '<span><i class="dotc green"></i>Брано скоро (' + fr.fresh + ')</span>' +
        '<span><i class="dotc yellow"></i>Тази седмица (' + fr.week + ')</span>' +
        '<span><i class="dotc" style="background:#aab7af"></i>Отдавна / не е брано (' + fr.old + ')</span>' +
        '<span>✅ Събрано днес (' + doneToday + ')</span>' + varietyLegend();
    }
    var counts = { green: 0, yellow: 0, red: 0 };
    trees.forEach(function (t) { counts[t.health]++; });
    return '<span><i class="dotc green"></i>Здраво (' + counts.green + ')</span>' +
      '<span><i class="dotc yellow"></i>За грижа (' + counts.yellow + ')</span>' +
      '<span><i class="dotc red"></i>Болно (' + counts.red + ')</span>' +
      '<span class="legend-br"></span>' +
      '<span class="ped">' + beeIconSVG() + 'Педро</span>' +
      varietyLegend();
  }

  // Опциите на филтъра по сорт — с брой дървета, динамично спрямо фитъра по здраве
  function varietyOptions(fVar, fHealth) {
    var trees = db.trees.filter(function (t) { return !t.deletedAt && (!fHealth || t.health === fHealth); });
    return '<option value=""' + (fVar ? '' : ' selected') + '>Всички сортове (' + trees.length + ')</option>' +
      (db.settings.varieties || []).map(function (v) {
        var n = trees.filter(function (t) { return t.varietyId === v.id; }).length;
        return '<option value="' + v.id + '"' + (fVar === v.id ? ' selected' : '') + '>' + esc(v.name) + ' (' + n + ')</option>';
      }).join('');
  }

  function viewHome() {
    var hv = harvestStats(statPeriod);
    var perLbl = periodShort(statPeriod);

    var greenBk = hv.buckets;
    var sh = shelledStats(statPeriod);
    var shelledBk = sh.buckets;
    var shelledKg = sh.kg;

    return topbar('Орехова градина') + '<div class="content">' +
      '<div id="statSwipe">' +
      '<div class="stat-row">' +
      '<div class="stat green harvstat" data-action="statbreak"><div class="statnum"><img class="bkimg" src="assets/bucket_cheese.png" alt=""/><b>' + fmtKg(greenBk) + '</b></div><small>кофи зелени ' + perLbl + '</small><small class="kg">≈ ' + fmtKg(hv.kg) + ' кг (без кофите)</small></div>' +
      '<div class="stat shelled harvstat" data-action="statbreak"><div class="statnum"><img class="bkimg" src="assets/bucket_cheese.png" alt=""/><b>' + fmtKg2(shelledBk) + '</b></div><small>кофи обелени ' + perLbl + (sh.manual ? ' ✏️' : '') + '</small><small class="kg">≈ ' + fmtKg(shelledKg) + ' кг (без кофите)</small></div>' +
      '</div>' +
      '<div class="stat-period-wrap">' +
      '<select id="homePeriod" class="stat-period-sel">' +
      STAT_PERIODS.map(function (p) {
        return '<option value="' + p + '"' + (statPeriod === p ? ' selected' : '') + '>' + periodPill(p) + '</option>';
      }).join('') +
      '</select></div>' +
      '</div>' +
      (harvestHL ? '<div class="hl-banner">📍 Маркирани дърветата от „' + periodLong(statPeriod) +
        '" върху картата. <button class="btn sm ghost" data-action="statclear">✖ Махни</button></div>' : '') +

      '<div class="section-title title-row"><span class="tl">Карта на градината' +
      (isAdmin() ? ' <button class="iconbtn' + (editMode ? ' on' : '') + '" data-action="editschema" aria-label="Редактирай схемата">' + (editMode ? '✓' : '✏️') + '</button>' : '') +
      '</span>' +
      (editMode ? '' : '<button class="btn sm secondary walkbtn" data-action="nav:walk">🧭 Къде съм</button>') +
      '</div>' +
      (editMode ? '' : '<div class="seg"><button class="' + (mapMode === 'health' ? 'active' : '') + '" data-action="mapmode:health">🌳 Здраве</button>' +
        '<button class="' + (mapMode === 'harvest' ? 'active' : '') + '" data-action="mapmode:harvest">🧺 Събиране</button></div>') +
      (editMode ? '<div class="edit-bar">✏️ Режим редакция: докосни ➕ за ново дърво, дърво за да го местиш/триеш, зона (Градина, Къща…) за да ѝ смениш мястото, площ (цветно поле) за да я наместиш, или ориентир (порта, цистерна, спирка, гнездо) за да го наместиш много фино.</div>' : '') +
      (editMode ? '<div class="row mb"><button class="btn secondary" data-action="addzone">➕ Добави зона</button><button class="btn secondary" data-action="addarea">🟫 Добави площ</button></div>' : '') +
      (editMode ? '' : '<div class="map-toolbar">' +
        '<select class="input" id="fVar">' + varietyOptions('', '') + '</select>' +
        (mapMode === 'health' ? '<select class="input" id="fHealth"><option value="">Всички състояния</option><option value="green">Здрави</option><option value="yellow">За грижа</option><option value="red">Болни</option></select>' : '') +
        '</div>') +
      (editMode ? '' : '<div class="map-tools-row"><button class="btn sm ' + (mapSelect ? '' : 'secondary') + '" data-action="mapselecttoggle">' + (mapSelect ? '✖ Изход от избор' : '☑️ Избери няколко дървета') + '</button>' +
        '<button class="btn sm secondary" data-action="groundquick">🍂 Събери от земята</button></div>') +
      '<div class="mapwrap" id="mapwrap">' + orchardGrid('', '', editMode, mapMode) + '</div>' +
      (editMode ? '' : '<div class="legend" id="mapLegend">' + mapLegend('', mapMode) + '</div>') +


      '</div>';
  }

  function orchardGrid(fVar, fHealth, edit, mode) {
    var order = DB.ROW_LETTERS;
    var trees = db.trees.filter(function (t) { return !t.deletedAt; });
    var rows = {};
    trees.forEach(function (t) { (rows[t.row] = rows[t.row] || []).push(t); });
    var rowKeys = Object.keys(rows).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    var maxCol = 0;
    trees.forEach(function (t) { if (t.col > maxCol) maxCol = t.col; });
    if (maxCol < 9) maxCol = 9;
    // разшири колоните, ако зона стърчи надясно
    (db.settings.zones || []).forEach(function (z) {
      var need = Math.ceil((z.c + z.cs - 2) / 2);
      if (need > maxCol) maxCol = need;
    });
    // разшири колоните, ако площ стърчи надясно
    (db.settings.areas || []).forEach(function (a) {
      var need = Math.ceil((a.c + a.cs - 2) / 2);
      if (need > maxCol) maxCol = need;
    });

    // в режим редакция добавяме един празен ред отдолу за нови дървета
    if (edit) {
      var lastIdx = rowKeys.length ? order.indexOf(rowKeys[rowKeys.length - 1]) : -1;
      var next = order[lastIdx + 1];
      if (next && rowKeys.indexOf(next) === -1) rowKeys.push(next);
    }

    // резервирани декоративни зони горе вдясно — изчисляват се от зоните
    var zones = db.settings.zones || [];
    function cellCovered(gr, cc) {
      for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        if (z.r <= gr && gr < z.r + z.rs && z.c <= 2 * cc && (z.c + z.cs) >= 2 * cc + 2) return true;
      }
      return false;
    }
    function reserved(rk, c) {
      var gr = rowKeys.indexOf(rk) + 2;
      return cellCovered(gr, c) ? 'zone' : null;
    }

    // всяка колона е разделена на 2 полу-коли, за да може границата да мине през средата на колона 6
    var cols2 = maxCol * 2;
    var html = '<div class="grid" style="grid-template-columns:16px repeat(' + cols2 + ',1fr);--lm-scale:' + lmScale() + '">';
    html += '<div class="corner" style="grid-row:1;grid-column:1"></div>';
    for (var c = 1; c <= maxCol; c++) html += '<div class="colhead" style="grid-row:1;grid-column:' + (2 * c) + ' / span 2">' + (c - 1) + '</div>';
    // прозрачни цветни площи (под дърветата) — админът ги чертае/оразмерява в режим редакция
    (db.settings.areas || []).forEach(function (a) {
      var act = edit ? ' data-action="editarea:' + a.id + '"' : '';
      var cls = 'area' + (edit ? ' area-edit' : '');
      var col = a.color || '#8a5a2b';
      var op = (a.opacity == null ? 15 : a.opacity) / 100;
      html += '<div class="' + cls + '"' + act +
        ' style="grid-row:' + a.r + ' / span ' + a.rs + ';grid-column:' + a.c + ' / span ' + a.cs +
        ';background:' + hexToRgba(col, op) + ';border-color:' + hexToRgba(col, Math.min(1, op + 0.25)) + '">' +
        (a.label ? '<span style="color:' + col + '">' + esc(a.label) + '</span>' : '') + '</div>';
    });
    // декоративни зони (Градина, Къща, Кокошки, Джаро) — местят се/оразмеряват в режим редакция
    zones.forEach(function (z) {
      var act = edit ? ' data-action="editzone:' + z.id + '"' : '';
      var cls = z.kind + (edit ? ' zone-edit' : '');
      html += '<div class="' + cls + '"' + act + ' style="grid-row:' + z.r + ' / span ' + z.rs + ';grid-column:' + z.c + ' / span ' + z.cs + '">' +
        (z.emoji || '') + '<span>' + esc(z.label) + '</span></div>';
    });

    rowKeys.forEach(function (rk, ri) {
      var gr = ri + 2;
      html += '<div class="rowhead" style="grid-row:' + gr + ';grid-column:1">' + rk + '</div>';
      var byCol = {};
      (rows[rk] || []).forEach(function (t) { byCol[t.col] = t; });
      for (var c = 1; c <= maxCol; c++) {
        var isReserved = reserved(rk, c);
        var t = byCol[c];
        if (t) {
          var dim = (fVar && t.varietyId !== fVar) || (fHealth && t.health !== fHealth);
          var v = variety(t.varietyId);
          var dec = varDecor(v);
          var vShape = varShape(v), vMark = varMark(v), vLetter = varLetter(v);
          var vBorder = borderColor(varBorder(v));
          var small = (!dec.cls && v && v.size === 'small' && vMark === 'none') ? ' small-badge' : '';
          var act = edit ? 'edittree:' + t.id : 'tree:' + t.id;
          var sel = (mapSelected.indexOf(t.id) !== -1) ? ' selected' : '';
          var hl = (harvestHL && harvestHL[t.id] != null) ? ' hl-harvest' : '';
          var ted = (t.id === editingTreeId) ? ' tree-editing' : '';
          var hlBadge = (harvestHL && harvestHL[t.id] != null) ? '<span class="hlkg">' + fmtKg(harvestHL[t.id]) + ' кг</span>' : '';
          var svg, doneCls = '', ageHtml = '';
          if (mode === 'harvest') {
            var fresh = harvestFreshness(t.id);
            svg = treeSVGFull(vShape, FRESH_COLORS[fresh], vMark, vLetter, vBorder);
            if (harvestedToday(t.id)) doneCls = ' harvested-today';
            var al = harvestAgoLabel(t.id);
            if (al) ageHtml = '<span class="age ' + fresh + '">' + al + '</span>';
          } else {
            svg = treeSVGFull(vShape, healthColors(t.health), vMark, vLetter, vBorder);
          }
          html += '<div class="tree-cell' + small + dec.cls + sel + doneCls + hl + ted + '" id="cell_' + t.id + '" data-tid="' + t.id + '" data-action="' + act + '" style="grid-row:' + gr + ';grid-column:' + (2 * c) + ' / span 2;' + (dim ? 'opacity:.2' : '') + '">' +
            '<div class="svgwrap">' + svg + '</div><span class="code">' + esc(t.code) + '</span>' + ageHtml + hlBadge + '</div>';

        } else if (edit && !isReserved) {
          html += '<div class="cell-empty" data-action="addtree:' + rk + ':' + c + '" style="grid-row:' + gr + ';grid-column:' + (2 * c) + ' / span 2">＋</div>';
        }
      }
    });
    if (landmarksVisible() || edit) html += landmarksHTML(edit);
    html += '</div>';
    return html;
  }

  // =======================================================================
  //  TREE DETAIL
  // =======================================================================
  function viewTree(id) {
    var t = tree(id);
    if (!t) return topbar('Дърво', { back: 'nav:home' }) + '<div class="content"><p>Няма такова дърво.</p></div>';
    var v = variety(t.varietyId);
    var evs = activeEvents().filter(function (e) { return e.treeId === id; });
    var photos = treePhotos(id);
    var lastPhoto = coverPhoto(id);

    // снимки групирани по година+сезон
    var groups = {};
    photos.forEach(function (p) { var key = season(p.date) + ' ' + new Date(p.date).getFullYear(); (groups[key] = groups[key] || []).push(p); });

    var seasonKg = evs.filter(function (e) { return e.type === 'harvest_tree'; }).reduce(function (s, e) { return s + eventKg(e); }, 0);
    var gps = treeGPS(t);

    return topbar('Дърво ' + t.code, { back: 'nav:home' }) + '<div class="content">' +
      '<div class="card flush">' +
      (lastPhoto ? '<img class="detail-photo" src="' + lastPhoto.data + '" style="border-radius:0;cursor:pointer"' + (lastPhoto.id ? ' data-action="zoomphoto:' + t.id + ':' + lastPhoto.id + '"' : '') + '/>' :
        '<div class="detail-photo" style="display:flex;align-items:center;justify-content:center">' +
        '<div style="width:90px;height:90px">' + treeSVGFull(varShape(v), healthColors(t.health), varMark(v), varLetter(v), borderColor(varBorder(v))) + '</div></div>') +
      '<div style="padding:16px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<h2 style="font-size:22px">Дърво ' + esc(t.code) + '</h2>' +
      '<span class="chip ' + t.health + '"><i class="dotc ' + t.health + '"></i>' + healthLabel(t.health) + '</span></div>' +
      '<div class="kv"><span class="k">🌰 Сорт</span><span class="v">' + (v ? esc(v.name) + ' (' + esc(v.note) + ')' : '—') + '</span></div>' +
      '<button class="btn ghost sm" data-action="treedetails" style="margin-top:4px">' + (treeDetailsOpen ? '▴ Скрий данните' : '▾ Още данни') + '</button>' +
      (treeDetailsOpen ? '<div id="treeDetails" style="margin-top:6px">' +
        '<div class="kv"><span class="k">📍 Ред / Колона</span><span class="v">' + esc(t.row) + ' / ' + t.col + '</span></div>' +
        '<div class="kv"><span class="k">🗓️ Посадено</span><span class="v">' + fmtDate(t.plantedAt) + '</span></div>' +
        '<div class="kv"><span class="k">🧺 Добив сезон</span><span class="v">' + fmtKg(seasonKg) + ' кг</span></div>' +
        '<div class="kv"><span class="k">📏 Височина</span><span class="v">' + (t.height != null && t.height !== '' ? esc(t.height) + ' м' : '—') + '</span></div>' +
        '<div class="kv"><span class="k">🛰️ GPS</span><span class="v">' + (gps ? gps.lat.toFixed(5) + ', ' + gps.lng.toFixed(5) : '—') + '</span></div>' +
        (t.note ? '<div class="kv"><span class="k">📝 Бележка</span><span class="v">' + esc(t.note) + '</span></div>' : '') +
        '</div>' : '') +
      '</div></div>' +

      '<div class="section-title">Добави дейност</div>' +
      '<div class="row mb">' +
      '<button class="btn" data-action="treeharvest:' + t.id + '">🧺 Събиране</button>' +
      '<button class="btn secondary" data-action="treecare:fertilize:' + t.id + '">🌱 Торене</button>' +
      '</div>' +
      '<button class="btn secondary mb" data-action="treecare:water:' + t.id + '">💧 Поливане</button>' +

      (treeHarvestOpen === id ? treeHarvestForm(id) : '') +

      '<div class="row mb">' +
      '<button class="btn" data-action="addphoto:' + t.id + '">📷 Добави снимка</button>' +
      '<button class="btn secondary" data-action="treeedit:' + t.id + '">⚙️ Състояние</button>' +
      '</div>' +
      (isAdmin() ? '<button class="btn secondary mb" data-action="savegps:' + t.id + '">🛰️ ' + (gps ? 'Обнови GPS тук' : 'Запиши GPS координатите тук') + '</button>' : '') +

      (photos.length ? '<div class="section-title">Снимки по сезони (' + photos.length + ')</div>' +
        Object.keys(groups).map(function (g) {
          return '<div class="card"><b>' + esc(g) + '</b><div style="display:flex;gap:8px;overflow:auto;margin-top:10px">' +
            groups[g].map(function (p) {
              var isCover = lastPhoto && p.id && lastPhoto.id === p.id;
              return '<div style="flex:0 0 auto;text-align:center">' +
                '<img ' + (p.id ? 'data-action="zoomphoto:' + t.id + ':' + p.id + '" ' : '') + 'src="' + p.data + '" style="width:90px;height:90px;border-radius:12px;object-fit:cover;cursor:pointer' + (isCover ? ';outline:3px solid var(--green);outline-offset:-3px' : '') + '"/>' +
                '<div class="muted" style="font-size:11px;margin-top:4px">' + fmtDate(p.date) + '</div>' +
                (p.id ? '<div style="margin-top:2px;display:flex;flex-direction:column;gap:3px;align-items:center">' +
                  (isCover
                    ? '<div style="font-size:11px;color:var(--green);font-weight:700">⭐ Основна</div>'
                    : '<button class="btn ghost sm" data-action="setcover:' + t.id + ':' + p.id + '" style="font-size:11px;padding:2px 8px">Направи основна</button>') +
                  '<button class="btn ghost sm" data-action="delphoto:' + t.id + ':' + p.id + '" style="font-size:11px;padding:2px 8px;color:var(--red)">🗑️ Изтрий</button>' +
                  '</div>' : '') +
                '</div>';
            }).join('') +
            '</div></div>';
        }).join('') : '') +

      '<div class="section-title">Последни дейности</div>' +
      '<div class="card">' + (evs.length ? evs.slice(0, 12).map(logRow).join('') : '<p class="muted">Още няма дейности.</p>') + '</div>' +
      '</div>';
  }

  // вградена форма за събиране от конкретно дърво (без изскачащ прозорец)
  function treeHarvestForm(id) {
    var today = DB.todayISO();
    if (!harvestBucket || !bucket(harvestBucket)) harvestBucket = db.settings.buckets[0].id;
    var val = (harvestDraft[id] && harvestDraft[id]._count) || 0;
    var b = bucket(harvestBucket);
    return '<div class="card mb" id="treeHarvestForm" style="border:2px solid var(--green)">' +
      '<div class="section-title" style="margin-top:0">🧺 Събиране от това дърво</div>' +
      '<div class="field"><label>Коя кофа?</label><div class="bucketpick">' +
      db.settings.buckets.map(function (bk) {
        return '<button class="bpick' + (bk.id === harvestBucket ? ' active' : '') + '" data-action="hbuck:' + bk.id + '">' +
          '<span class="bpic">' + bucketIcon(bk) + '</span>' +
          '<b>' + esc(bk.name) + '</b><small>1 кофа ≈ ' + fmtKg(stateKg(bk, harvestState)) + ' кг</small></button>';
      }).join('') + '</div></div>' +
      counterRow(id, 'Колко кофи', b ? b.name : '', val) +
      fillChips() +
      '<div class="field"><label>Дата</label><input id="thdate" type="date" class="input" value="' + today + '"/></div>' +
      '<button class="btn" data-action="savetreeharvestinline:' + id + '">💾 Запази</button>' +
      '<button class="btn ghost mt" data-action="treeharvestcancel">Отказ</button>' +
      '</div>';
  }

  // =======================================================================
  //  HARVEST
  // =======================================================================
  function viewHarvest() {
    var today = DB.todayISO();

    var body = topbar('Действия', { back: 'nav:home' }) + '<div class="content">' +
      '<div class="seg seg4" style="margin-bottom:8px">' +
      '<button class="' + (harvestScreen === 'collect' ? 'active' : '') + '" data-action="hscreen:collect">🧺 Събиране</button>' +
      '<button class="' + (harvestScreen === 'shell' ? 'active' : '') + '" data-action="hscreen:shell">🥥 Белене</button>' +
      '<button class="' + (harvestScreen === 'clean' ? 'active' : '') + '" data-action="hscreen:clean">🌰 Чистене</button>' +
      '<button class="' + (harvestScreen === 'sort' ? 'active' : '') + '" data-action="hscreen:sort">⚪ Сортиране</button>' +
      '</div>' +
      '<div class="seg seg3">' +
      '<button class="' + (harvestScreen === 'fertilize' ? 'active' : '') + '" data-action="hscreen:fertilize">🌱 Торене</button>' +
      '<button class="' + (harvestScreen === 'water' ? 'active' : '') + '" data-action="hscreen:water">💧 Поливане</button>' +
      '<button class="' + (harvestScreen === 'mow' ? 'active' : '') + '" data-action="hscreen:mow">🌾 Косене</button>' +
      '</div>';

    if (harvestScreen === 'shell') { return body + harvestShellForm() + '</div>'; }
    if (harvestScreen === 'clean') { return body + harvestCleanForm() + '</div>'; }
    if (harvestScreen === 'sort') { return body + harvestSortForm() + '</div>'; }
    if (harvestScreen === 'fertilize' || harvestScreen === 'water' || harvestScreen === 'mow') {
      return body + careBody(today) + '</div>';
    }
    if (harvestScreen !== 'collect') { return body + '<p class="muted center" style="padding:24px 8px">Избери действие отгоре.</p>' + '</div>'; }

    var todayEvs = activeEvents().filter(function (e) { return (e.type === 'harvest_tree' || e.type === 'harvest_ground') && e.date === today; });
    var todayKg = todayEvs.reduce(function (s, e) { return s + eventKg(e); }, 0);
    var todayBk = todayEvs.reduce(function (s, e) { return s + greenCheeseBuckets(e); }, 0);

    body += '<div class="seg">' +
      '<button class="' + (harvestMode === 'tree' ? 'active' : '') + '" data-action="hmode:tree">🌳 От дърветата</button>' +
      '<button class="' + (harvestMode === 'ground' ? 'active' : '') + '" data-action="hmode:ground">🍂 От земята</button>' +
      '</div>';

    // избор на кофа — картинки с имена
    if (!harvestBucket || !bucket(harvestBucket)) harvestBucket = db.settings.buckets[0].id;
    body += '<div class="field"><label>Коя кофа броим?</label><div class="bucketpick">' +
      db.settings.buckets.map(function (b) {
        return '<button class="bpick' + (b.id === harvestBucket ? ' active' : '') + '" data-action="hbuck:' + b.id + '">' +
          '<span class="bpic">' + bucketIcon(b) + '</span>' +
          '<b>' + esc(b.name) + '</b><small>1 кофа ≈ ' + fmtKg(stateKg(b, harvestState)) + ' кг</small></button>';
      }).join('') + '</div></div>';
    body += '<div class="field"><label>Дата</label><input id="hdate" type="date" class="input" value="' + today + '"/></div>';
    body += fillChips();

    if (harvestMode === 'tree') {
      body += '<div class="section-title">Колко кофи от всяко дърво?</div>';
      var activeTrees = db.trees.filter(function (t) { return !t.deletedAt; });
      var rowsWith = [];
      activeTrees.forEach(function (t) { if (rowsWith.indexOf(t.row) === -1) rowsWith.push(t.row); });
      rowsWith.sort(function (a, b) { return DB.ROW_LETTERS.indexOf(a) - DB.ROW_LETTERS.indexOf(b); });
      body += '<div class="rowfilter"><button class="' + (harvestRowFilter === '' ? 'active' : '') + '" data-action="hrow:">Всички</button>' +
        rowsWith.map(function (rk) {
          return '<button class="' + (harvestRowFilter === rk ? 'active' : '') + '" data-action="hrow:' + rk + '">' + rk + '</button>';
        }).join('') + '</div>';
      activeTrees.filter(function (t) { return !harvestRowFilter || t.row === harvestRowFilter; }).forEach(function (t) {
        var v = variety(t.varietyId);
        var val = (harvestDraft[t.id] && harvestDraft[t.id]._count) || 0;
        body += counterRow(t.id, 'Дърво ' + t.code, v ? v.name : '', val);
      });
    } else {
      var val = (harvestDraft['ground'] && harvestDraft['ground']._count) || 0;
      body += '<div class="section-title">Орехи събрани от земята (' + stateLabel(harvestState) + ')</div>' +
        counterRow('ground', 'От земята', stateLabel(harvestState).charAt(0).toUpperCase() + stateLabel(harvestState).slice(1) + ' орехи', val);
    }

    body += '<div class="card mt">' +
      '<small class="muted">Днес събрано общо</small><div style="font-size:20px;font-weight:800">' +
      fmtKg(todayKg) + ' кг · ' + fmtKg(todayBk) + ' кофи</div></div>';

    body += '<button class="btn mt" data-action="savehcurrent">💾 Запази събраното</button>';
    body += '</div>';
    return body;
  }

  // таб „Чистене" на екрана Събиране: само попълване на изчистена ядка (без рандеман)
  function harvestCleanForm() {
    var entries = activeEvents().filter(function (e) { return e.type === 'clean'; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 30);
    var list = entries.length ? entries.map(function (e) {
      var who = db.users.find(function (u) { return u.id === e.createdBy; });
      return '<div class="list-row">' + avatarHtml(who, 'lg') +
        '<div class="tx"><b>' + fmtKg(e.kg) + ' кг</b><small>изчистена ядка</small></div>' +
        '<div class="meta"><span class="dt">' + fmtDate(e.date) + '</span>' +
        (isAdmin() ? '<div><button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="edit:' + e.id + '">✏️</button><button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button></div>' : '') +
        '</div></div>';
    }).join('') : '<p class="muted">Още няма въведени изчистени.</p>';
    var bucketOpts = '<option value="">— без кофа (само ядка) —</option>' +
      db.settings.buckets.map(function (b) {
        return '<option value="' + b.id + '">' + esc(b.name) + ' (кофа ' + (b.tareKg != null ? fmtKg(b.tareKg) + ' кг' : 'тара 0') + ')</option>';
      }).join('');
    return '<div class="card" style="margin-top:4px">' +
      '<p class="muted" style="font-size:12px;margin:0 0 8px"><b>Изчистена</b> = ядката без черупката (след като се счупи обеленият орех с черупка). Въведи колко кг чиста ядка изчисти за деня.</p>' +
      '<div class="field"><label>Дата</label><input id="clDate" class="input" type="date" value="' + DB.todayISO() + '"/></div>' +
      '<div class="field"><label>Измерено тегло (кг)</label><input id="clKg" class="input" type="number" step="0.1" min="0" inputmode="decimal"/></div>' +
      '<div class="field"><label>Теглил си с кофа? (ще се извади теглото ѝ)</label><select id="clBucket" class="input">' + bucketOpts + '</select></div>' +
      '<div class="field"><label>Колко такива кофи</label><input id="clCount" class="input" type="number" step="1" min="1" value="1" inputmode="numeric"/></div>' +
      '<p class="muted" id="clNet" style="font-size:13px;margin:0 0 8px"></p>' +
      '<button class="btn" data-action="addclean">➕ Запази изчистеното</button>' +
      '</div>' +
      '<div class="section-title">Записи</div>' +
      '<div class="card">' + list + '</div>';
  }

  // таб „Сортиране" на екрана Събиране: попълване на бели/черни ядки за дата (без рандеман).
  // Белите и черните може да се теглят с различна кофа (или без кофа) — тарата се вади отделно.
  function harvestSortForm() {
    var sortEntries = activeEvents().filter(function (e) { return e.type === 'sort'; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 30);
    var sortList = sortEntries.length ? sortEntries.map(function (e) {
      var who = db.users.find(function (u) { return u.id === e.createdBy; });
      var tot = (e.whiteKg || 0) + (e.blackKg || 0);
      var wp = tot > 0 ? Math.round((e.whiteKg || 0) / tot * 100) : 0;
      var inAvg = !e.excludeAvg;
      return '<div class="list-row"' + (inAvg ? '' : ' style="opacity:.55"') + '>' + avatarHtml(who, 'lg') +
        '<div class="tx"><b class="sortkv">⚪ ' + fmtKg(e.whiteKg || 0) + ' кг<br>⚫ ' + fmtKg(e.blackKg || 0) + ' кг</b><small>' + wp + '% бели' + (inAvg ? '' : ' · извън средното') + '</small></div>' +
        '<div class="meta"><span class="dt">' + fmtDate(e.date) + '</span>' +
        (isAdmin() ? '<button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="sortavg:' + e.id + '">' + (inAvg ? '✅ в средното' : '➕ в средното') + '</button>' : '') +
        (isAdmin() ? '<div><button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="edit:' + e.id + '">✏️</button><button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button></div>' : '') +
        '</div></div>';
    }).join('') : '<p class="muted">Още няма сортирани.</p>';
    var sd = sortDraft || {};
    var wKg = sd.whiteKg != null ? sd.whiteKg : '';
    var kKg = sd.blackKg != null ? sd.blackKg : '';
    var wCnt = sd.whiteCount != null ? sd.whiteCount : '1';
    var kCnt = sd.blackCount != null ? sd.blackCount : '1';
    var sDate = sd.date || DB.todayISO();
    return '<div class="card" style="margin-top:4px">' +
      '<p class="muted" style="font-size:12px;margin:0 0 8px"><b>Сортирана</b> = изчистената ядка (без черупка), разделена на <b>бяла</b> и <b>черна</b>. Можеш да теглиш с кофа (тежестта ѝ се вади) или без кофа — поотделно за белите и за черните.</p>' +
      '<div class="field"><label>Дата</label><input id="sortDate" class="input" type="date" value="' + sDate + '"/></div>' +
      '<div class="section-title" style="margin-top:2px">⚪ Бели ядки</div>' +
      '<div class="field"><label>Измерено тегло (кг)</label><input id="sortWhite" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + wKg + '"/></div>' +
      '<div class="field"><label>Теглил си с кофа?</label>' + sortBucketPicker('white') + '</div>' +
      (sortWhiteBucket ? '<div class="field"><label>Колко такива кофи</label><input id="sortWhiteCount" class="input" type="number" step="1" min="1" value="' + wCnt + '" inputmode="numeric"/></div>' : '') +
      '<p class="muted" id="swNet" style="font-size:13px;margin:0 0 8px"></p>' +
      '<div class="section-title" style="margin-top:2px">⚫ Черни ядки</div>' +
      '<div class="field"><label>Измерено тегло (кг)</label><input id="sortBlack" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + kKg + '"/></div>' +
      '<div class="field"><label>Теглил си с кофа?</label>' + sortBucketPicker('black') + '</div>' +
      (sortBlackBucket ? '<div class="field"><label>Колко такива кофи</label><input id="sortBlackCount" class="input" type="number" step="1" min="1" value="' + kCnt + '" inputmode="numeric"/></div>' : '') +
      '<p class="muted" id="sbNet" style="font-size:13px;margin:0 0 8px"></p>' +
      '<button class="btn" data-action="addsort">➕ Запази сортираното</button>' +
      '</div>' +
      (function () {
        var avg = whitePct(); var ai = sortAvgStats();
        return '<div class="card" style="margin-top:8px"><div class="kv"><span class="k">⚪ Среден дял бели (ползва се за „очаквано")</span><span class="v"><b>' + (avg != null ? Math.round(avg * 100) + '%' : '—') + '</b></span></div>' +
          '<p class="muted" style="font-size:12px;margin:6px 0 0">' +
          (ai.count > 0
            ? 'Изчислен от ' + ai.count + ' сортиране' + (ai.count === 1 ? '' : 'ия') + ' (⚪ ' + fmtKg(ai.white) + ' · ⚫ ' + fmtKg(ai.black) + ' кг).' + (isAdmin() ? ' За всяко долу избери дали влиза в средното.' : '')
            : 'Няма избрани сортирания — ползва се калибровката „среден дял бели" от Настройки.') +
          '</p>' +
          '<p class="muted" style="font-size:12px;margin:6px 0 0">Изтегленото е след приспадане на теглото на кофата, ако е имало такава.</p></div>';
      })() +
      '<div class="section-title">Записи</div>' +
      '<div class="card">' + sortList + '</div>';
  }

  // избор на кофа по картинки за сортиране (с опция „Без кофа") — отделно за бели/черни
  function sortBucketPicker(color) {
    var isW = color === 'white';
    var sel = isW ? sortWhiteBucket : sortBlackBucket;
    var act = isW ? 'swbuck' : 'sbbuck';
    var none = '<button class="bpick' + (sel === '' ? ' active' : '') + '" data-action="' + act + ':none">' +
      '<span class="bpic">🚫</span><b>Без кофа</b><small>само ядка</small></button>';
    var tiles = db.settings.buckets.map(function (b) {
      return '<button class="bpick' + (sel === b.id ? ' active' : '') + '" data-action="' + act + ':' + b.id + '">' +
        '<span class="bpic">' + bucketIcon(b) + '</span>' +
        '<b>' + esc(b.name) + '</b><small>празна ' + (b.tareKg != null ? fmtKg(b.tareKg) + ' кг' : '0') + '</small></button>';
    }).join('');
    return '<div class="bucketpick" style="flex-wrap:wrap">' + none + tiles + '</div>';
  }

  // таб „Обелени" на екрана Действия: въвеждане на обелени кофи (с черупка) за дата.
  // Показва ориентировъчна сметка от зеленото × коефициента, но потребителят въвежда накрая.
  function harvestShellForm() {
    var today = DB.todayISO();
    var greenBkToday = activeEvents().filter(function (e) {
      return (e.type === 'harvest_tree' || e.type === 'harvest_ground') && e.date === today;
    }).reduce(function (s, e) { return s + greenCheeseBuckets(e); }, 0);
    var estBuckets = greenBkToday * shellYield();
    var ov = shellOverrideFor(today);
    var prefill = ov ? ov.buckets : (estBuckets > 0 ? fmtKg(estBuckets) : '');
    var entries = activeEvents().filter(function (e) { return e.type === 'shell'; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 30);
    var list = entries.length ? entries.map(function (e) {
      var who = db.users.find(function (u) { return u.id === e.createdBy; });
      return '<div class="list-row">' + avatarHtml(who, 'lg') +
        '<div class="tx"><b>' + fmtKg(e.buckets) + ' кофи</b><small>≈ ' + fmtKg((e.buckets || 0) * refBucketShelledKg()) + ' кг обелени</small></div>' +
        '<div class="meta"><span class="dt">' + fmtDate(e.date) + '</span>' +
        (isAdmin() ? '<div><button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="edit:' + e.id + '">✏️</button><button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button></div>' : '') +
        '</div></div>';
    }).join('') : '<p class="muted">Още няма въведени обелени.</p>';
    return '<div class="card" style="margin-top:4px">' +
      '<p class="muted" style="font-size:12px;margin:0 0 8px"><b>Обелена</b> = орех с черупка (след махане на зелената кора). Обелените винаги се мерят в <b>кофи за сирене</b> — независимо в каква кофа е събрано зеленото. Накрая, като обелиш, въведи колко кофи за сирене обелени излязоха.</p>' +
      (estBuckets > 0
        ? '<p class="muted" style="font-size:12px;margin:0 0 8px">Приложението вече автоматично пресметна обелените за днес и ги попълни в полето отдолу: от <b>' + fmtKg(greenBkToday) + ' кофи зелено</b> × коефициента <b>' + fmtKg(shellYield()) + '</b> (толкова кофи обелени излизат от 1 кофа зелени) ≈ <b>' + fmtKg(estBuckets) + ' кофи за сирене</b>. Това е само ориентир — ако в този ден реално излезе друго число, просто смени стойността в полето отдолу.</p>'
        : '<p class="muted" style="font-size:12px;margin:0 0 8px">Когато събереш зелено за даден ден, приложението само пресмята колко кофи обелени се очакват (зелените × коефициента <b>' + fmtKg(shellYield()) + '</b> — толкова кофи обелени излизат от 1 кофа зелени) и ги попълва автоматично в полето отдолу за същата дата. Днес още няма събрано зелено, затова полето е празно — избери дата и въведи колко кофи за сирене реално обели.</p>') +
      '<div class="field"><label>Дата</label><input id="shDate" class="input" type="date" value="' + today + '"/></div>' +
      '<div class="field"><label>Обелени кофи за сирене (с черупка)</label><input id="shBuckets" class="input" type="number" step="0.25" min="0" inputmode="decimal" value="' + prefill + '"/></div>' +
      '<p class="muted" style="font-size:12px;margin:0 0 8px">👉 Попълни стойността на обелените само ако е различна от автоматично изчислената.</p>' +
      '<button class="btn" data-action="addshell">➕ Запази обелените</button>' +
      '</div>' +
      '<div class="section-title">Записи</div>' +
      '<div class="card">' + list + '</div>';
  }

  function counterRow(key, title, sub, val) {
    return '<div class="counter-row">' +
      '<div class="ic">' + (key === 'ground' ? '🍂' : '🌳') + '</div>' +
      '<div class="info"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></div>' +
      '<div class="stepper">' +
      '<button type="button" data-action="hminus:' + key + '">−</button>' +
      '<input class="val" id="cnt_' + key + '" type="text" inputmode="decimal" data-count="' + key + '" value="' + val + '"/>' +
      '<button type="button" data-action="hplus:' + key + '">+</button>' +
      '</div></div>';
  }

  // чипове за запълване на кофата (%) — общо за събиране/бърз режим
  function fillChips() {
    var fb = bucket(harvestBucket);
    var oneKg = fb ? stateKg(fb, harvestState) * harvestFill / 100 : 0;
    var lcName = fb ? fb.name.charAt(0).toLowerCase() + fb.name.slice(1) : '';
    var hint = fb ? ('1 ' + esc(lcName) + (harvestFill !== 100 ? ' на ' + harvestFill + '%' : '') + ' ≈ <b>' + fmtKg(oneKg) + ' кг</b>') : '';
    return '<div class="field"><label>Колко пълни бяха кофите?</label><div class="rowfilter">' +
      [100, 75, 50, 25, 10, 5].map(function (p) {
        return '<button class="' + (harvestFill === p ? 'active' : '') + '" data-action="hfill:' + p + '">' + (p === 100 ? 'Пълна' : p + '%') + '</button>';
      }).join('') + '</div>' +
      '<div class="fillstep">' +
      '<button class="fillstep-btn" data-action="hfillstep:-5"><span>−</span><small>5%</small></button>' +
      '<span class="fillstep-val">' + harvestFill + '%</span>' +
      '<button class="fillstep-btn" data-action="hfillstep:5"><span>+</span><small>5%</small></button>' +
      '</div>' +
      (hint ? '<small class="muted fillhint">' + hint + '</small>' : '') +
      '</div>';
  }

  // =======================================================================
  //  CARE (torene / polivane / kosene)
  // =======================================================================
  var careTab = 'fertilize';
  function viewCare() {
    var today = DB.todayISO();
    var body = topbar('Грижа за градината', { back: 'nav:home' }) + '<div class="content">' +
      '<div class="seg">' +
      '<button class="' + (careTab === 'fertilize' ? 'active' : '') + '" data-action="ctab:fertilize">🌱 Торене</button>' +
      '<button class="' + (careTab === 'water' ? 'active' : '') + '" data-action="ctab:water">💧 Поливане</button>' +
      '<button class="' + (careTab === 'mow' ? 'active' : '') + '" data-action="ctab:mow">🌾 Косене</button>' +
      '</div>';
    body += careBody(today);
    body += '</div>';
    return body;
  }

  // тялото на грижата (обхват + форма) — ползва се и в „Грижа“, и в таб „Действия“
  function careBody(today) {
    var activeTrees = db.trees.filter(function (t) { return !t.deletedAt; });
    var treeOpts = activeTrees
      .map(function (t) { return '<option value="' + t.id + '"' + (t.id === careTreePreset ? ' selected' : '') + '>Дърво ' + esc(t.code) + '</option>'; }).join('');

    // налични редици (букви) по реда на картата
    var rowKeys = [];
    activeTrees.forEach(function (t) { if (rowKeys.indexOf(t.row) === -1) rowKeys.push(t.row); });
    rowKeys.sort(function (a, b) { return DB.ROW_LETTERS.indexOf(a) - DB.ROW_LETTERS.indexOf(b); });

    // косенето няма „едно дърво“ — коригирай обхвата
    if (careTab === 'mow' && careScope === 'tree') careScope = 'all';
    if (careScope === 'trees' && !careTrees.length) careScope = 'all';

    var body = '';
    // --- избор на обхват: цялата градина / редици / едно дърво / избрани от картата ---
    if (careScope === 'trees') {
      var selNames = careTrees.map(function (id) { var t = tree(id); return t ? t.code : null; }).filter(Boolean);
      body += '<div class="field"><div class="pickbanner">🌲 <b>' + selNames.length + ' избрани дървета</b> от картата' +
        '<div class="pickchips">' + selNames.map(function (n) { return '<span class="chip green">' + esc(n) + '</span>'; }).join('') + '</div>' +
        '<button class="btn sm ghost mt" data-action="cscope:all">Избери друг обхват</button></div></div>';
    } else {
      body += '<div class="field"><label>За кого е грижата?</label>' +
        '<button class="btn ' + (careScope === 'all' ? '' : 'secondary') + ' mb" data-action="cscope:all">' + (careScope === 'all' ? '✓ ' : '') + '🌳 Цялата градина</button>' +
        '<button class="btn ' + (careScope === 'rows' ? '' : 'secondary') + ' mb" data-action="cscope:rows">' + (careScope === 'rows' ? '✓ ' : '') + '🌿 Избрани редици</button>' +
        (careTab !== 'mow' ? '<button class="btn ' + (careScope === 'tree' ? '' : 'secondary') + '" data-action="cscope:tree">' + (careScope === 'tree' ? '✓ ' : '') + '🌲 Едно дърво</button>' : '') +
        '</div>';
    }

    var scopeControl = '';
    if (careScope === 'rows') {
      scopeControl = '<div class="field"><label>Кои редици? (докосни за да избереш)</label><div class="rowfilter">' +
        rowKeys.map(function (rk) {
          return '<button class="' + (careRows.indexOf(rk) !== -1 ? 'active' : '') + '" data-action="crow:' + rk + '">' + rk + '</button>';
        }).join('') + '</div>' +
        '<small class="muted">Избрани: ' + (careRows.length ? esc(careRows.join(', ')) : 'няма') + '</small></div>';
    } else if (careScope === 'tree') {
      scopeControl = '<div class="field"><label>Дърво</label><select id="ctree" class="input">' + treeOpts + '</select></div>';
    }

    if (careTab === 'fertilize') {
      body += '<div class="card">' +
        '<div class="field"><label>Дата</label><input id="cdate" type="date" class="input" value="' + today + '"/></div>' +
        scopeControl +
        '<div class="field"><label>С какво торим</label><input id="cwhat" class="input" placeholder="напр. Кравешки тор, Нитрофоска"/></div>' +
        '<div class="row"><div class="field"><label>Колко</label><input id="cqty" type="number" class="input" placeholder="0"/></div>' +
        '<div class="field"><label>Мярка</label><select id="cunit" class="input"><option>кг</option><option>л</option><option>торби</option></select></div></div>' +
        '<div class="field"><label>Бележка</label><textarea id="cnote" class="input" placeholder="по избор"></textarea></div>' +
        '<button class="btn" data-action="savecare:fertilize">💾 Запази торене</button></div>';
    } else if (careTab === 'water') {
      body += '<div class="card">' +
        '<div class="field"><label>Дата</label><input id="cdate" type="date" class="input" value="' + today + '"/></div>' +
        scopeControl +
        '<div class="field"><label>Колко вода (литри)</label><input id="cqty" type="number" class="input" placeholder="0"/></div>' +
        '<div class="field"><label>Бележка</label><textarea id="cnote" class="input" placeholder="по избор"></textarea></div>' +
        '<button class="btn" data-action="savecare:water">💾 Запази поливане</button></div>';
    } else {
      body += '<div class="card">' +
        '<div class="field"><label>Дата на косене</label><input id="cdate" type="date" class="input" value="' + today + '"/></div>' +
        scopeControl +
        '<div class="field"><label>Бележка</label><textarea id="cnote" class="input" placeholder="напр. окосена цялата градина"></textarea></div>' +
        '<button class="btn" data-action="savecare:mow">💾 Запази косене</button></div>';
    }
    return body;
  }

  // =======================================================================
  //  LOG / CHANGE LOG
  // =======================================================================
  // Видове записи в дневника (икона, цвят, етикет) — ползва се от logRow и филтрите
  var LOG_TYPES = {
    water: { ic: '💧', cls: 'water', t: 'Поливане' },
    fertilize: { ic: '🌱', cls: 'fert', t: 'Торене' },
    harvest_tree: { ic: '🧺', cls: 'harvest', t: 'Събиране (дърво)' },
    harvest_ground: { ic: '🍂', cls: 'harvest', t: 'Събиране (земя)' },
    shell: { ic: '🥥', cls: 'harvest', t: 'Обелени (ръчно)' },
    clean: { ic: '🌰', cls: 'harvest', t: 'Изчистена ядка' },
    sort: { ic: '⚪', cls: 'harvest', t: 'Сортиране (бели/черни)' },
    mow: { ic: '🌾', cls: 'mow', t: 'Косене' },
    photo: { ic: '📷', cls: 'sys', t: 'Снимка' },
    tree_edit: { ic: '⚙️', cls: 'sys', t: 'Промяна на дърво' },
    buyer_add: { ic: '🤝', cls: 'sys', t: 'Нов купувач' },
    buyer_del: { ic: '🗑️', cls: 'sys', t: 'Изтрит купувач' },
    sale_add: { ic: '💰', cls: 'harvest', t: 'Продажба' },
    note: { ic: '📝', cls: 'sys', t: 'Бележка' }
  };
  // кои видове записи може да се редактират (дата + стойности)
  var EDITABLE_TYPES = { harvest_tree: 1, harvest_ground: 1, shell: 1, clean: 1, sort: 1, fertilize: 1, water: 1, mow: 1, note: 1 };

  function logRow(e) {
    var m = LOG_TYPES[e.type] || { ic: '•', cls: 'sys', t: e.type };
    var who = db.users.find(function (u) { return u.id === e.createdBy; });
    var t = e.treeId ? tree(e.treeId) : null;
    var detail = '';
    if (e.type === 'harvest_tree' || e.type === 'harvest_ground') detail = eventBucketNamesHtml(e) + ' · ' + (e.fill != null ? e.fill : 100) + '% пълни · ' + fmtKg(eventKg(e)) + ' кг' + (e.state && e.state !== 'green' ? ' · ' + stateLabel(e.state) : '');
    else if (e.type === 'shell') detail = fmtKg(e.buckets) + ' обелени кофи · ≈ ' + fmtKg((e.buckets || 0) * refBucketShelledKg()) + ' кг';
    else if (e.type === 'clean') detail = fmtKg(e.kg) + ' кг чиста ядка';
    else if (e.type === 'sort') { var st = (e.whiteKg || 0) + (e.blackKg || 0); detail = '⚪ ' + fmtKg(e.whiteKg || 0) + ' · ⚫ ' + fmtKg(e.blackKg || 0) + ' кг' + (st > 0 ? ' · ' + Math.round((e.whiteKg || 0) / st * 100) + '% бели' : ''); }
    else if (e.type === 'fertilize') detail = esc(e.what || '') + (e.qty ? ' · ' + e.qty + ' ' + esc(e.unit || '') : '');
    else if (e.type === 'water') detail = (e.qty || 0) + ' л';
    else if (e.type === 'mow') detail = 'окосено';
    else if (e.type === 'sale_add') detail = esc(e.note || 'Купувач') + ' · ' + fmtKg(e.kg) + ' кг' + (e.pricePerKg ? ' · ' + e.pricePerKg + ' €/кг' : '') + ' · ' + Math.round(e.total || 0) + ' €';
    else if (e.note) detail = esc(e.note);

    var onBehalf = e.onBehalfOf ? ' (от името на ' + esc(e.onBehalfOf) + ')' : '';
    var deleted = e.deletedAt;
    var scopeLbl = t ? ' · ' + esc(t.code) : (e.rows && e.rows.length ? ' · редове ' + esc(e.rows.join(', ')) : '');
    var reacts = e.reactions || [];
    var liked = reacts.indexOf(db.currentUserId) !== -1;
    var reactBtn = '<button class="heartbtn' + (liked ? ' on' : '') + '" data-action="react:' + e.id + '" aria-label="Реагирай със сърце">' +
      (liked ? '❤️' : '🤍') + (reacts.length ? ' <span class="hc">' + reacts.length + '</span>' : '') + '</button>';
    var fresh = !deleted && (e.createdAt || 0) > logViewSeen && e.createdBy !== db.currentUserId;
    var buyerRestorable = e.type === 'buyer_del' && e.buyerId && (db.buyers.find(function (x) { return x.id === e.buyerId; }) || {}).deletedAt;
    var adminBtns = '';
    if (isAdmin()) {
      if (deleted) {
        adminBtns = '<button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="restore:' + e.id + '">Върни</button>' +
          '<button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="purge:' + e.id + '">🗑️ Завинаги</button>';
      } else if (buyerRestorable) {
        adminBtns = '<button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="restorebuyer:' + e.buyerId + '">↩️ Върни купувача</button>';
      } else {
        adminBtns = (EDITABLE_TYPES[e.type] ? '<button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="edit:' + e.id + '">✏️</button>' : '') +
          '<button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button>';
      }
      adminBtns = '<div>' + adminBtns + '</div>';
    }
    return '<div class="list-row' + (fresh ? ' unread' : '') + '"' + (deleted ? ' style="opacity:.5"' : '') + '>' +
      avatarHtml(who, 'lg') +
      '<div class="tx"><b>' + m.ic + ' ' + m.t + scopeLbl + (deleted ? ' <span class="badge orange">изтрито</span>' : '') + '</b>' +
      '<small>' + detail + onBehalf + '</small>' +
      '<div class="reacts">' + reactBtn + '</div></div>' +
      '<div class="meta">' + fmtDate(e.date) + adminBtns +
      '</div></div>';
  }

  function viewLog() {
    var all = (isAdmin() ? db.events : activeEvents()).slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;      // по-новата дата отгоре
      return (b.createdAt || 0) - (a.createdAt || 0);               // при същата дата — последно добавеното отгоре
    });
    // кои видове и кои хора изобщо присъстват в записите (за да не показваме празни филтри)
    var typesPresent = {}, usersPresent = {};
    all.forEach(function (e) { typesPresent[e.type] = 1; if (e.createdBy) usersPresent[e.createdBy] = 1; });
    var evs = all.filter(function (e) {
      if (logFilterTypes.length && logFilterTypes.indexOf(e.type) === -1) return false;
      if (logFilterUsers.length && logFilterUsers.indexOf(e.createdBy) === -1) return false;
      return true;
    });
    // филтър по вид действие
    var typeBtns = '<button class="' + (logFilterTypes.length === 0 ? 'active' : '') + '" data-action="logtype:all">Всички</button>' +
      Object.keys(LOG_TYPES).filter(function (k) { return typesPresent[k]; }).map(function (k) {
        return '<button class="' + (logFilterTypes.indexOf(k) !== -1 ? 'active' : '') + '" data-action="logtype:' + k + '">' + LOG_TYPES[k].ic + ' ' + esc(LOG_TYPES[k].t) + '</button>';
      }).join('');
    // филтър по човек
    var userBtns = '<button class="' + (logFilterUsers.length === 0 ? 'active' : '') + '" data-action="loguser:all">Всички</button>' +
      db.users.filter(function (u) { return usersPresent[u.id]; }).map(function (u) {
        return '<button class="' + (logFilterUsers.indexOf(u.id) !== -1 ? 'active' : '') + '" data-action="loguser:' + u.id + '">' + esc(u.name) + '</button>';
      }).join('');
    var shown = Math.min(evs.length, 200);
    var countNote = evs.length > shown
      ? '<p class="muted mb" style="font-size:12px">Показани са последните ' + shown + ' от ' + evs.length + '. Стесни търсенето с филтрите, за да видиш по-стари записи.</p>'
      : '<p class="muted mb" style="font-size:12px">Намерени записи: ' + evs.length + '.</p>';
    // кратко обобщение на активните филтри за заглавката на свитата секция
    var activeType = logFilterTypes.map(function (k) { return LOG_TYPES[k] ? LOG_TYPES[k].t : k; }).join(', ');
    var activeUser = logFilterUsers.map(function (id) { return (db.users.filter(function (u) { return u.id === id; })[0] || {}).name || ''; }).filter(Boolean).join(', ');
    var activeBits = [activeType, activeUser].filter(Boolean);
    var filterSummary = activeBits.length ? activeBits.join(' · ') : 'всички';
    var filtersOpen = activeBits.length > 0; // ако има активен филтър — отвори, иначе свито
    return topbar('Дневник / Чейндж лог', { back: 'nav:home' }) + '<div class="content">' +
      '<p class="muted mb">Всичко кой какво е правил, с дати и имена. Изтритото се пази (soft delete).</p>' +
      '<details class="sect"' + (filtersOpen ? ' open' : '') + '><summary>🔎 Филтри: <b>' + esc(filterSummary) + '</b></summary><div class="sect-body">' +
      '<div class="section-title">🔎 Вид действие</div>' +
      '<div class="rowfilter logfilter">' + typeBtns + '</div>' +
      '<div class="section-title">👤 Човек</div>' +
      '<div class="rowfilter logfilter">' + userBtns + '</div>' +
      '</div></details>' +
      countNote +
      '<div class="card">' + (evs.length ? evs.slice(0, shown).map(logRow).join('') : '<p class="muted">Няма записи за този филтър.</p>') + '</div>' +
      '</div>';
  }

  // =======================================================================
  //  STATS
  // =======================================================================
  function viewStats() {
    // в статистиката закръгляме до 2 знака след запетаята
    function fmtKg(n) {
      n = Math.round(((n || 0) + Number.EPSILON) * 100) / 100;
      return n.toFixed(2).replace(/\.?0+$/, '');
    }
    var year = db.settings.seasonYear;
    var harv = activeEvents().filter(function (e) { return e.type === 'harvest_tree' || e.type === 'harvest_ground'; });
    var totalKg = harv.reduce(function (s, e) { return s + eventKg(e); }, 0);
    var soldKg = activeSales().reduce(function (s, x) { return s + (x.kg || 0); }, 0);
    var revenue = activeSales().reduce(function (s, x) { return s + (x.total || 0); }, 0);

    // добив по етапи за избрания изглед (сезон / месец / седмици)
    var MONTHS_BG = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];
    function weekStart(d) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
    function isoLocal(d) { var m = d.getMonth() + 1, day = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day; }
    var greenVals = [], shelledVals = [], cleanVals = [], whiteVals = [], blackVals = [], labels = [], periodTitle = '', barActions = null;
    if (statsMode === 'month' || statsMode === 'prevmonth') {
      var ref = statsMode === 'prevmonth'
        ? new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
        : (statsRef || new Date());
      var my = ref.getFullYear(), mm = ref.getMonth();
      var dim = new Date(my, mm + 1, 0).getDate();
      greenVals = new Array(dim).fill(0); shelledVals = new Array(dim).fill(0); cleanVals = new Array(dim).fill(0); whiteVals = new Array(dim).fill(0); blackVals = new Array(dim).fill(0);
      activeEvents().forEach(function (e) {
        var d = new Date(e.date); if (d.getFullYear() !== my || d.getMonth() !== mm) return;
        var i = d.getDate() - 1;
        if (e.type === 'harvest_tree' || e.type === 'harvest_ground') { greenVals[i] += eventKg(e); shelledVals[i] += eventShelledKg(e); }
        else if (e.type === 'clean') cleanVals[i] += (e.kg || 0);
        else if (e.type === 'sort') { whiteVals[i] += (e.whiteKg || 0); blackVals[i] += (e.blackKg || 0); }
      });
      labels = greenVals.map(function (_, i) { var dn = i + 1; return (dn === 1 || dn % 5 === 0) ? String(dn) : ''; });
      periodTitle = MONTHS_BG[mm] + ' ' + my;
    } else if (statsMode === 'weeks') {
      var end = statsRef || new Date();
      var weeks = [], ws = weekStart(end);
      for (var i = 7; i >= 0; i--) { var s = new Date(ws); s.setDate(s.getDate() - i * 7); weeks.push(s); }
      greenVals = new Array(8).fill(0); shelledVals = new Array(8).fill(0); cleanVals = new Array(8).fill(0); whiteVals = new Array(8).fill(0); blackVals = new Array(8).fill(0);
      activeEvents().forEach(function (e) {
        var d = new Date(e.date + 'T00:00:00');
        for (var j = 0; j < 8; j++) { var a = weeks[j], b = new Date(weeks[j]); b.setDate(b.getDate() + 7); if (d >= a && d < b) { if (e.type === 'harvest_tree' || e.type === 'harvest_ground') { greenVals[j] += eventKg(e); shelledVals[j] += eventShelledKg(e); } else if (e.type === 'clean') cleanVals[j] += (e.kg || 0); else if (e.type === 'sort') { whiteVals[j] += (e.whiteKg || 0); blackVals[j] += (e.blackKg || 0); } break; } }
      });
      labels = weeks.map(function (s) { return s.getDate() + '.' + (s.getMonth() + 1); });
      barActions = weeks.map(function (s) { return 'statsweek:' + isoLocal(s); }); // натисни седмица → нейните дни
      periodTitle = labels[0] + ' – ' + weeks[7].getDate() + '.' + (weeks[7].getMonth() + 1);
    } else if (statsMode === 'oneweek') {
      var wkRef = statsRef || new Date();
      var mon = weekStart(wkRef);
      var dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
      var days7 = [];
      for (var i = 0; i < 7; i++) { var dd = new Date(mon); dd.setDate(dd.getDate() + i); days7.push(dd); }
      greenVals = new Array(7).fill(0); shelledVals = new Array(7).fill(0); cleanVals = new Array(7).fill(0); whiteVals = new Array(7).fill(0); blackVals = new Array(7).fill(0);
      activeEvents().forEach(function (e) {
        var d = new Date(e.date + 'T00:00:00');
        for (var j = 0; j < 7; j++) { if (d.getFullYear() === days7[j].getFullYear() && d.getMonth() === days7[j].getMonth() && d.getDate() === days7[j].getDate()) { if (e.type === 'harvest_tree' || e.type === 'harvest_ground') { greenVals[j] += eventKg(e); shelledVals[j] += eventShelledKg(e); } else if (e.type === 'clean') cleanVals[j] += (e.kg || 0); else if (e.type === 'sort') { whiteVals[j] += (e.whiteKg || 0); blackVals[j] += (e.blackKg || 0); } break; } }
      });
      labels = days7.map(function (d, i) { return dayNames[i] + ' ' + d.getDate(); });
      periodTitle = 'Седмица ' + days7[0].getDate() + '.' + (days7[0].getMonth() + 1) + ' – ' + days7[6].getDate() + '.' + (days7[6].getMonth() + 1);
    } else {
      var seasonMonths = [7, 8, 9, 10, 11];
      labels = ['Авг', 'Сеп', 'Окт', 'Ное', 'Дек'];
      var gM = new Array(12).fill(0), shM = new Array(12).fill(0), cM = new Array(12).fill(0), wM = new Array(12).fill(0), bM = new Array(12).fill(0);
      activeEvents().forEach(function (e) {
        var d = new Date(e.date); if (d.getFullYear() !== year) return;
        if (e.type === 'harvest_tree' || e.type === 'harvest_ground') { gM[d.getMonth()] += eventKg(e); shM[d.getMonth()] += eventShelledKg(e); }
        else if (e.type === 'clean') cM[d.getMonth()] += (e.kg || 0);
        else if (e.type === 'sort') { wM[d.getMonth()] += (e.whiteKg || 0); bM[d.getMonth()] += (e.blackKg || 0); }
      });
      whiteVals = seasonMonths.map(function (m) { return wM[m]; });
      blackVals = seasonMonths.map(function (m) { return bM[m]; });
      greenVals = seasonMonths.map(function (m) { return gM[m]; });
      shelledVals = seasonMonths.map(function (m) { return shM[m]; });
      cleanVals = seasonMonths.map(function (m) { return cM[m]; });
      periodTitle = 'Сезон ' + year;
    }
    var shelledTot = shelledVals.reduce(function (a, b) { return a + b; }, 0);
    var greenTot = greenVals.reduce(function (a, b) { return a + b; }, 0);
    var cleanTot = cleanVals.reduce(function (a, b) { return a + b; }, 0);
    var whiteTot = whiteVals.reduce(function (a, b) { return a + b; }, 0);
    var blackTot = blackVals.reduce(function (a, b) { return a + b; }, 0);
    var sortedTot = whiteTot + blackTot;
    var pctShelled = greenTot > 0 ? Math.round(shelledTot / greenTot * 100) : 0;
    var pctClean = shelledTot > 0 ? Math.round(cleanTot / shelledTot * 100) : 0;
    var pctWhite = sortedTot > 0 ? Math.round(whiteTot / sortedTot * 100) : 0;
    var showBarVals = true;
    var manyBars = labels.length > 9; // при месец (28–31 стълба) въртим числата вертикално да се берат
    // една стъпаловидна диаграма за даден етап
    function stageChart(emoji, title, cls, vals, total, pct, pctWord) {
      var mx = Math.max.apply(null, vals.concat([1]));
      return '<div class="section-title">' + emoji + ' ' + title + '</div>' +
        '<div class="card">' +
        '<div class="stagehead"><b>' + fmtKg(total) + ' кг</b>' + (pct !== null ? '<span class="stagepct">' + pct + '% от ' + pctWord + '</span>' : '') + '</div>' +
        '<div class="bars ' + cls + (showBarVals ? ' withval' : '') + (manyBars ? ' manyvals' : '') + '">' +
        vals.map(function (v, i) {
          var act = (barActions && barActions[i]) ? ' data-action="' + barActions[i] + '" role="button"' : '';
          var bval = (showBarVals && v > 0) ? '<span class="bval">' + fmtKg(v) + '</span>' : '';
          return '<div class="b"' + act + ' style="height:' + Math.max(4, (v / mx) * 100) + '%">' + bval + '</div>';
        }).join('') +
        '</div><div class="barlabels">' + labels.map(function (l) { return '<span>' + l + '</span>'; }).join('') + '</div>' +
        '</div>';
    }

    // топ дървета
    var perTree = {};
    harv.filter(function (e) { return e.type === 'harvest_tree'; }).forEach(function (e) { perTree[e.treeId] = (perTree[e.treeId] || 0) + eventKg(e); });
    var ranked = Object.keys(perTree).map(function (id) { return { t: tree(id), kg: perTree[id] }; })
      .filter(function (r) { return r.t; }).sort(function (a, b) { return b.kg - a.kg; }).slice(0, 6);
    var maxR = ranked.length ? ranked[0].kg : 1;

    var ks = kernelStats();
    var kpct = ks.expected > 0 ? Math.min(100, Math.round(ks.actual / ks.expected * 100)) : 0;

    return topbar('Статистика', { back: 'nav:home' }) + '<div class="content">' +
      '<div class="stat-row">' +
      '<div class="stat green"><b>' + fmtKg(totalKg) + '</b><small>общо събрани (кг)</small></div>' +
      '<div class="stat blue" data-action="salesbreak" style="cursor:pointer"><b>' + fmtKg(soldKg) + '</b><small>продадени (кг)</small></div>' +
      '<div class="stat purple" data-action="salesbreak" style="cursor:pointer"><b>' + revenue.toFixed(0) + '</b><small>приходи (€)</small></div>' +
      '</div>' +

      '<div class="section-title">🌰 Изчистена ядка (рандеман)</div>' +
      '<div class="kernelcard" data-action="kernel">' +
      '<div class="kernelhead"><span>Изчистено / очаквано</span><b>' + fmtKg(ks.actual) + ' / ' + fmtKg(ks.expected) + ' кг</b></div>' +
      '<div class="kprog"><div class="kprog-fill" style="width:' + kpct + '%"></div></div>' +
      (ks.whitePct != null
        ? '<div class="kernelwhite">⚪ Бели ядки <span>' + Math.round(ks.whitePct * 100) + '% бели</span><b>' + fmtKg(ks.sortedWhite) + ' / ' + fmtKg(ks.expectedWhite) + ' кг</b></div>'
        : '') +
      '<div class="kernelsub">' + (ks.expected > 0 ? '<div class="ks-rem">Остават <b>' + fmtKg(ks.remaining) + ' кг</b> изчистено' + (ks.remainingWhite != null ? ' · <b>' + fmtKg(ks.remainingWhite) + ' кг</b> бели' : '') + '</div><div class="ks-hint">рандеман ' + Math.round(kernelYield() * 100) + '% · натисни за въвеждане</div>' : 'Събери и обели, за да се сметне очакваното') + '</div>' +
      '</div>' +

      '<p class="muted mb" style="font-size:13px;margin-top:16px">Добив по етапи. Всеки етап показва общото и колко процент е от предишния.</p>' +
      '<div class="seg seg4"><button class="' + (statsMode === 'season' ? 'active' : '') + '" data-action="statsmode:season">📆 Сезон</button>' +
      '<button class="' + (statsMode === 'month' ? 'active' : '') + '" data-action="statsmode:month">📅 Месец</button>' +
      '<button class="' + (statsMode === 'prevmonth' ? 'active' : '') + '" data-action="statsmode:prevmonth">⬅️ Предх. месец</button>' +
      '<button class="' + (statsMode === 'weeks' || statsMode === 'oneweek' ? 'active' : '') + '" data-action="statsmode:weeks">🗓️ Седмици</button></div>' +
      (statsMode !== 'season' && statsMode !== 'prevmonth'
        ? '<div class="stat-period"><span class="ar" data-action="statsprev">‹</span><span class="pl">' + periodTitle + '</span><span class="ar" data-action="statsnext">›</span></div>'
        : '<div class="stat-period" style="cursor:default"><span class="pl">' + periodTitle + '</span></div>') +
      (statsMode === 'weeks' ? '<p class="muted center" style="font-size:12px;margin:-4px 0 12px">👆 Натисни дадена седмица, за да видиш дните ѝ.</p>' : '') +
      (statsMode === 'oneweek' ? '<div class="center" style="margin:-4px 0 12px"><button class="btn sm ghost" data-action="statsmode:weeks">‹ Всички седмици</button></div>' : '') +
      stageChart('🟢', 'Зелени (кг)', 'greenbars', greenVals, greenTot, null, '') +
      stageChart('🥥', 'Обелени (кг)', 'shelledbars', shelledVals, shelledTot, pctShelled, 'зелените') +
      stageChart('🌰', 'Изчистени (кг)', 'cleanbars', cleanVals, cleanTot, pctClean, 'обелените') +
      stageChart('⚪', 'Сортиране — бели (кг)', 'whitebars', whiteVals, whiteTot, (sortedTot > 0 ? pctWhite : null), 'сортираните') +
      (sortedTot > 0 ? '<div class="card" style="margin-top:-6px"><div class="kv"><span class="k">⚪ Бели</span><span class="v"><b>' + fmtKg(whiteTot) + ' кг</b></span></div><div class="kv"><span class="k">⚫ Черни</span><span class="v"><b>' + fmtKg(blackTot) + ' кг</b></span></div></div>' : '') +

      '<div class="section-title">Най-доходоносни дървета</div>' +
      '<div class="card">' + (ranked.length ? ranked.map(function (r) {
        return '<div class="rank-row"><span class="nm">' + esc(r.t.code) + '</span>' +
          '<div class="track"><div class="fill" style="width:' + ((r.kg / maxR) * 100) + '%"></div></div>' +
          '<span class="kg">' + fmtKg(r.kg) + ' кг</span></div>';
      }).join('') : '<p class="muted">Още няма данни за добив по дървета.</p>') + '</div>' +
      '</div>';
  }

  // =======================================================================
  //  SALES + BUYERS
  // =======================================================================
  function viewSales() {
    var buyers = db.buyers.filter(function (b) { return !b.deletedAt; }).map(function (b) {
      var purchases = activeSales().filter(function (s) { return s.buyerId === b.id; });
      var kg = purchases.reduce(function (s, x) { return s + (x.kg || 0); }, 0);
      var spent = purchases.reduce(function (s, x) { return s + (x.total || 0); }, 0);
      return { b: b, count: purchases.length, kg: kg, spent: spent };
    }).sort(function (a, c) { return c.spent - a.spent; });
    return topbar('Клиенти и продажби', { back: 'nav:home' }) + '<div class="content">' +
      '<button class="btn mb" data-action="newsale">➕ Нова продажба</button>' +
      '<div class="section-title">Купувачи</div>' +
      buyers.map(function (r) {
        var b = r.b;
        return '<div class="card" data-action="buyer:' + b.id + '" style="cursor:pointer">' +
          '<div style="display:flex;align-items:center;gap:12px">' +
          '<div class="avatar">' + initials(b.name) + '</div>' +
          '<div style="flex:1"><b>' + esc(b.name) + '</b><div class="muted" style="font-size:13px">' + esc(b.phone || '') + '</div>' +
          '<div class="muted" style="font-size:12px">' + r.count + ' покупки · ' + fmtKg(r.kg) + ' кг · ' + (r.spent || 0).toFixed(2) + ' €</div></div>' +
          '<span style="font-size:22px;color:var(--muted)">›</span></div></div>';
      }).join('') +
      '</div>';
  }

  function viewBuyer(id) {
    var b = db.buyers.find(function (x) { return x.id === id; });
    if (!b) return topbar('Купувач', { back: 'nav:sales' }) + '<div class="content">Няма.</div>';
    var purchases = activeSales().filter(function (s) { return s.buyerId === id; }).sort(function (a, c) { return c.date < a.date ? -1 : 1; });
    return topbar(b.name, { back: 'nav:sales' }) + '<div class="content">' +
      '<div class="card"><div style="display:flex;gap:12px;align-items:center">' +
      '<div class="avatar" style="width:52px;height:52px;font-size:19px">' + initials(b.name) + '</div>' +
      '<div style="flex:1"><b style="font-size:19px">' + esc(b.name) + '</b><div class="muted">' + esc(b.phone || '') + '</div></div>' +
      '<button class="btn sm secondary" data-action="editbuyer:' + b.id + '">✏️ Редактирай</button></div>' +
      (b.phone ? '<a class="btn mt" href="tel:' + esc(telHref(b.phone)) + '" style="text-decoration:none">📞 Обади се на ' + esc(b.phone) + '</a>' : '') +
      (b.note ? '<p class="mt">' + esc(b.note) + '</p>' : '') + '</div>' +
      '<div class="section-title">История на покупки</div>' +
      '<div class="card">' + (purchases.length ? purchases.map(function (s) {
        return '<div class="list-row"><div class="ic harvest">💰</div><div class="tx"><b>' + s.kg + ' кг · ' + (s.total || 0).toFixed(2) + ' €</b>' +
          '<small>' + (s.pricePerKg || 0) + ' €/кг' + (s.note ? ' · ' + esc(s.note) : '') + '</small></div>' +
          '<div class="meta">' + fmtDate(s.date) +
          '<div><button class="btn sm ghost" style="margin-top:6px;height:30px;background:#fdeceb;border-color:#e8a7a1;color:#b23a33" data-action="delsale:' + s.id + '">🗑️ Изтрий</button></div>' +
          '</div></div>';
      }).join('') : '<p class="muted">Още няма покупки.</p>') + '</div>' +
      '<button class="btn" data-action="newsalefor:' + b.id + '">➕ Добави продажба</button>' +
      '<button class="btn danger mt" data-action="delbuyer:' + b.id + '">🗑️ Изтрий купувача</button>' +
      '</div>';
  }

  // =======================================================================
  //  SETTINGS
  // =======================================================================
  function viewSettings() {
    var s = db.settings;
    var meU = me();
    return topbar('Настройки', { back: 'nav:home' }) + '<div class="content">' +
      '<details class="sect"><summary>👤 Моят профил</summary><div class="sect-body">' +
      '<div class="card"><div style="display:flex;align-items:center;gap:14px">' +
      avatarHtml(meU, 'xl') +
      '<div style="flex:1"><b style="font-size:17px">' + esc(meU ? meU.name : '') + '</b>' +
      '<div class="muted" style="font-size:13px">' + (meU && meU.role === 'admin' ? '🔒 Администратор' : 'Работник') + '</div></div></div>' +
      '<div class="row mt"><button class="btn secondary" data-action="setphoto">📷 ' + (meU && meU.photo ? 'Смени снимката' : 'Добави снимка') + '</button>' +
      (meU && meU.photo ? '<button class="btn ghost" data-action="delprofilephoto">🗑️ Махни</button>' : '') + '</div>' +
      '<p class="muted" style="font-size:12px;margin:8px 0 0">Снимката се показва в дневника до всеки твой запис.</p>' +
      '</div></div></details>' +

      '<details class="sect"><summary>☁️ Синхронизация</summary><div class="sect-body">' +
      '<div class="card"><div id="syncStatus">' + syncStatusHtml() + '</div>' +
      '<p class="muted" style="font-size:13px;margin-top:8px">Когато е включена, всички телефони виждат едни и същи дървета и събирания. Промените се сливат автоматично, дори да си бил офлайн.</p>' +
      '</div></div></details>' +

      '<details class="sect"><summary>🌰 Сортове орехи</summary><div class="sect-body">' +
      '<div class="card">' + s.varieties.map(function (v) {
        if (!isAdmin()) {
          return '<div class="kv"><span class="k">' + (v.size === 'big' ? '🌰 Едри' : '🥜 Малки') + '</span><span class="v">' + esc(v.name) + ' — ' + esc(v.note) + '</span></div>';
        }
        return '<div class="list-row"><div class="ic harvest">' + (v.size === 'big' ? '🌰' : '🥜') + '</div>' +
          '<div class="tx"><b>' + esc(v.name) + '</b><small>' + (v.size === 'big' ? 'Едър сорт' : 'Дребен сорт') + (v.note ? ' · ' + esc(v.note) : '') + '</small></div>' +
          '<button class="btn sm ghost" data-action="varedit:' + v.id + '">✏️</button></div>';
      }).join('') + '</div>' +
      (isAdmin() ? '<button class="btn secondary mt" data-action="varnew">➕ Нов сорт</button>' : '') +
      '</div></details>' +

      '<details class="sect"><summary>🪣 Кофи и тегло</summary><div class="sect-body">' +
      '<p class="muted mb" style="font-size:13px">Колко кг е 1 кофа — зелени / обелени с черупка / чиста ядка. Пиши теглото както си го измерил (със самата кофа) — приложението само вади теглото на празната кофа. (Обелените с черупка са винаги в кофата от сирене.)' +
      (isAdmin() ? '<br>При промяна на теглото ще те питам дали да преизчисля и старите записи, или да важи само от определена дата.' : '') + '</p>' +
      db.settings.buckets.map(function (b) {
        var head = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">' +
          '<div style="width:48px;height:48px;border-radius:12px;background:var(--green-soft);display:flex;align-items:center;justify-content:center;font-size:26px;overflow:hidden;padding:4px">' + bucketIcon(b) + '</div>' +
          '<div><b>' + esc(b.name) + '</b><div class="muted" style="font-size:13px">' + esc(b.capacityNote || '') + '</div></div></div>';
        if (!isAdmin()) {
          return '<div class="card">' + head +
            '<div class="kv"><span class="k">Вместимост</span><span class="v">' + (b.liters != null ? b.liters + ' л' : '—') + '</span></div>' +
            '<div class="kv"><span class="k">Празна кофа</span><span class="v">' + (b.tareKg != null ? b.tareKg + ' кг' : '—') + '</span></div>' +
            '<div class="kv"><span class="k">Зелени (с кофата)</span><span class="v">' + b.greenKg + ' кг</span></div>' +
            '<div class="kv"><span class="k">С черупка (с кофата)</span><span class="v">' + b.shelledKg + ' кг</span></div>' +
            '<div class="kv"><span class="k">Чиста ядка (с кофата)</span><span class="v">' + b.cleanKg + ' кг</span></div>' +
            '<p class="muted" style="font-size:12px;margin:8px 0 0">Нето (без кофата): зелени <b>' + fmtKg(bucketNetKg(b, 'green')) + '</b> · с черупка <b>' + fmtKg(bucketNetKg(b, 'shelled')) + '</b> · чиста <b>' + fmtKg(bucketNetKg(b, 'clean')) + '</b> кг</p></div>';
        }
        return '<div class="card">' + head +
          '<div class="row"><div class="field"><label>Вместимост (литри)</label><input class="input" type="number" value="' + (b.liters != null ? b.liters : '') + '" data-bkg="liters:' + b.id + '"/></div>' +
          '<div class="field"><label>Тегло на празната кофа (кг)</label><input class="input" type="number" step="0.01" min="0" value="' + (b.tareKg != null ? b.tareKg : '') + '" data-bkg="tare:' + b.id + '"/></div></div>' +
          '<div class="row"><div class="field"><label>Зелени (с кофата)</label><input class="input" type="number" value="' + b.greenKg + '" data-bkg="green:' + b.id + '"/></div>' +
          '<div class="field"><label>С черупка (с кофата)</label><input class="input" type="number" value="' + b.shelledKg + '" data-bkg="shelled:' + b.id + '"/></div>' +
          '<div class="field"><label>Чиста ядка (с кофата)</label><input class="input" type="number" value="' + b.cleanKg + '" data-bkg="clean:' + b.id + '"/></div></div>' +
          '<p class="muted" style="font-size:12px;margin:2px 0 0">Нето (след вадене на кофата): зелени <b>' + fmtKg(bucketNetKg(b, 'green')) + '</b> · с черупка <b>' + fmtKg(bucketNetKg(b, 'shelled')) + '</b> · чиста <b>' + fmtKg(bucketNetKg(b, 'clean')) + '</b> кг</p></div>';
      }).join('') +
      (isAdmin() ? '<button class="btn secondary mb" data-action="savebuckets">💾 Запази теглата на кофите</button>' : '') +
      '</div></details>' +

      '<details class="sect"><summary>🥥 Белене (зелени → обелени)</summary><div class="sect-body">' +
      '<p class="muted mb" style="font-size:13px">Орехите се събират зелени, после ги белите. Тук казваш колко кофи обелени излизат от 1 кофа зелени — тоест колко място заемат след беленето. Теглото на обелените се взема от „С черупка" на кофата за сирене, а не от зеленото.</p>' +
      (isAdmin()
        ? '<div class="card"><div class="field"><label>1 кофа зелени → колко кофи обелени</label>' +
          '<input id="shYield" class="input" type="number" step="0.05" min="0.05" value="' + shellYield() + '"/></div>' +
          '<p class="muted" style="font-size:12px">Напр. 0.5 означава: 1 кофа зелени → 0.5 кофа обелени (теглото ѝ е „С черупка" на кофата за сирене).</p>' +
          '<button class="btn secondary" data-action="saveshellyield">💾 Запази</button></div>'
        : '<div class="card"><div class="kv"><span class="k">1 кофа зелени ≈</span><span class="v">' + fmtKg(shellYield()) + ' кофа обелени</span></div></div>') +
      '</div></details>' +

      '<details class="sect"><summary>📐 Калкулатор за рандеман</summary><div class="sect-body">' +
      '<p class="muted mb" style="font-size:13px">Този процент се ползва и за „🌰 Изчистена ядка" на началния екран — очакваната чиста ядка = събрани обелени × рандеман.</p>' +
      (isAdmin()
        ? '<div class="card"><div class="row">' +
          '<div class="field"><label>Вход — сухи с черупка (кг)</label><input id="yin" class="input" type="number" value="' + s.yieldInputKg + '"/></div>' +
          '<div class="field"><label>Изход — чиста ядка (кг)</label><input id="yout" class="input" type="number" value="' + s.yieldOutputKg + '"/></div></div>' +
          '<div class="center" style="font-size:20px;font-weight:800;color:var(--green-dark)">Рандеман: ' +
          Math.round((s.yieldOutputKg / (s.yieldInputKg || 1)) * 100) + '%</div>' +
          '<button class="btn secondary mt" data-action="savecalc">Изчисли / Запази</button></div>'
        : '<div class="card">' +
          '<div class="kv"><span class="k">Вход — сухи с черупка</span><span class="v">' + s.yieldInputKg + ' кг</span></div>' +
          '<div class="kv"><span class="k">Изход — чиста ядка</span><span class="v">' + s.yieldOutputKg + ' кг</span></div>' +
          '<div class="center" style="font-size:20px;font-weight:800;color:var(--green-dark);margin-top:8px">Рандеман: ' +
          Math.round((s.yieldOutputKg / (s.yieldInputKg || 1)) * 100) + '%</div></div>') +
      '</div></details>' +

      '<details class="sect"><summary>⚪ Среден дял бели (калибровка)</summary><div class="sect-body">' +
      '<p class="muted mb" style="font-size:13px">Ако още няма сортиране, тук задаваш очаквания дял: от 1 кофа начупени — колко излизат бели и колко черни. Служи само за „очаквано бели" (презаписва се от реалното сортиране).</p>' +
      (isAdmin()
        ? '<div class="card"><div class="row">' +
          '<div class="field"><label>⚪ Бели ядки</label><input id="whiteKg" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + (db.settings.whiteKg != null ? db.settings.whiteKg : '') + '"/></div>' +
          '<div class="field"><label>⚫ Черни ядки</label><input id="blackKg" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + (db.settings.blackKg != null ? db.settings.blackKg : '') + '"/></div></div>' +
          '<div class="kv"><span class="k">Дял бели</span><span class="v"><b>' + ((db.settings.whiteKg > 0 || db.settings.blackKg > 0) ? Math.round((db.settings.whiteKg || 0) / ((db.settings.whiteKg || 0) + (db.settings.blackKg || 0)) * 100) + '%' : '—') + '</b></span></div>' +
          '<button class="btn secondary" data-action="savewhiteblack">💾 Запази дела</button></div>'
        : '<div class="card"><div class="kv"><span class="k">Дял бели</span><span class="v"><b>' + ((db.settings.whiteKg > 0 || db.settings.blackKg > 0) ? Math.round((db.settings.whiteKg || 0) / ((db.settings.whiteKg || 0) + (db.settings.blackKg || 0)) * 100) + '%' : '—') + '</b></span></div></div>') +
      '</div></details>' +

      '<details class="sect"><summary>👥 Потребители и роли</summary><div class="sect-body">' +
      (isOwner() ? '<p class="muted mb" style="font-size:13px">Ти си главният стопанин. Само ти можеш да правиш други хора администратори.</p>' : '') +
      '<div class="card">' + db.users.filter(function (u) { return !u.deletedAt; }).map(function (u) {
        var owner = u.isOwner || u.id === db.ownerId;
        var controls = '';
        if (isOwner() && !owner) {
          controls = u.role === 'admin'
            ? '<button class="btn sm ghost" data-action="demote:' + u.id + '">Свали</button> <button class="btn sm ghost" data-action="setpass:' + u.id + '">Парола</button> <button class="btn sm ghost" style="border-color:#f3c9c6;color:#b23a33" data-action="deluser:' + u.id + '">Премахни</button>'
            : '<button class="btn sm" data-action="promote:' + u.id + '">Направи админ</button> <button class="btn sm ghost" style="border-color:#f3c9c6;color:#b23a33" data-action="deluser:' + u.id + '">Премахни</button>';
        }
        return '<div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)">' +
          avatarHtml(u, 'sm') +
          '<div style="flex:1"><b>' + esc(u.name) + '</b>' + (owner ? ' 👑' : '') +
          '<div class="muted" style="font-size:12px">' + (u.role === 'admin' ? '🔒 Администратор' : 'Работник') + '</div>' +
          (isAdmin() ? '<div class="muted" style="font-size:11px;margin-top:3px;line-height:1.6">' +
            '🕒 Последно онлайн: <b>' + fmtLastOnline(u.lastOnline) + '</b><br>' +
            '📱 Отваряния: днес <b>' + countOpens(u, startOfTodayMs()) + '</b>' +
            ' · седмица <b>' + countOpens(u, Date.now() - 7 * 86400000) + '</b>' +
            ' · месец <b>' + countOpens(u, Date.now() - 30 * 86400000) + '</b></div>' : '') +
          '</div>' +
          '<span class="badge ' + (u.role === 'admin' ? 'green' : 'orange') + '">' + (u.role === 'admin' ? 'Админ' : 'Работник') + '</span></div>' +
          (controls ? '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:10px 0 12px;border-bottom:1px solid var(--line)">' + controls + '</div>' : '');
      }).join('') + '</div>' +
      (isAdmin() ? '<button class="btn secondary mt" data-action="changemypass">🔑 Смени моята парола</button>' : '') +
      '</div></details>' +

      '<details class="sect"><summary>🔔 Известия</summary><div class="sect-body">' +
      '<div class="card"><p class="muted mb" style="font-size:13px">Получавай известие на този телефон, когато друг запише нещо в дневника (събиране, грижа, продажба и др.). Непрочетените се броят с червено балонче върху „📜 Дневник".</p>' +
      notifSettingsHtml() +
      '</div></div></details>' +

      '<details class="sect"><summary>📍 Ориентири на картата</summary><div class="sect-body">' +
      '<div class="card"><p class="muted mb" style="font-size:13px">Показвай ли ориентирите на картата — порти, цистерна 💧, спирка 🚌 и гнездо 🪹. Тази настройка е само за теб, на този телефон.</p>' +
      '<div class="row" style="align-items:center;justify-content:space-between">' +
      '<b style="font-size:15px">Показвай ориентирите</b>' +
      '<button class="btn sm ' + (landmarksVisible() ? '' : 'secondary') + '" data-action="togglelandmarks">' + (landmarksVisible() ? '✅ Включено' : 'Изключено') + '</button></div>' +
      (isAdmin() ? '<hr style="border:none;border-top:1px solid #e4e9e4;margin:12px 0"/>' +
        '<p class="muted mb" style="font-size:13px">Размер на значките (за всички потребители).</p>' +
        '<div class="row" style="align-items:center">' +
        '<button class="btn secondary" data-action="lmscaledown">➖ По-малки</button>' +
        '<div class="center" style="font-size:20px;font-weight:800;color:var(--green-dark);min-width:72px">' + Math.round(lmScale() * 100) + '%</div>' +
        '<button class="btn secondary" data-action="lmscaleup">➕ По-големи</button>' +
        '</div>' +
        '<button class="btn ghost mt" data-action="lmscalereset">↺ Нормален размер (100%)</button>' : '') +
      (isAdmin() ? '<p class="muted" style="font-size:12px;margin:10px 0 0">Съвет: като админ влез в „✏️ Редактирай схемата" на картата и докосни ориентир, за да го наместиш много фино.</p>' : '') +
      '</div>' +
      '</div></details>' +

      '<details class="sect"><summary>🔍 Размер на изгледа</summary><div class="sect-body">' +
      '<div class="card"><p class="muted mb" style="font-size:13px">Уголеми или смали всичко в приложението, за да се чете по-лесно.</p>' +
      '<div class="row" style="align-items:center">' +
      '<button class="btn secondary" data-action="zoomout">➖ По-малко</button>' +
      '<div class="center" style="font-size:22px;font-weight:800;color:var(--green-dark);min-width:72px">' + Math.round(getZoom() * 100) + '%</div>' +
      '<button class="btn secondary" data-action="zoomin">➕ По-голямо</button>' +
      '</div>' +
      '<button class="btn ghost mt" data-action="zoomreset">↺ Нормален размер (100%)</button>' +
      '</div>' +
      '</div></details>' +

      '<details class="sect"><summary>📱 Версия и обновяване</summary><div class="sect-body">' +
      '<div class="card">' +
      '<div class="kv"><span class="k">📱 Версия</span><span class="v">' + APP_VERSION + '</span></div>' +
      '<p class="muted" id="updState" style="font-size:13px;margin:10px 0">Натисни, за да провериш за нова версия.</p>' +
      '<button class="btn secondary" data-action="checkupdate">🔄 Провери за нова версия</button>' +
      '</div>' +
      '</div></details>' +

      '<button class="btn secondary mt" data-action="logout">🚪 Смени потребител</button>' +
      '<p class="center muted mt">По-добра грижа = по-голям добив 🌰</p>' +
      '</div>';
  }

  // =======================================================================
  //  WALK MODE (разходка — компас + „къде съм“ на картата)
  // =======================================================================
  function viewWalk() {
    var withGps = db.trees.filter(function (t) { return !t.deletedAt && treeGPS(t); });
    var body = topbar('Разходка', { back: 'nav:home' }) + '<div class="content">';
    if (!withGps.length) {
      body += '<div class="card"><p>🛰️ Още няма дървета с GPS.</p>' +
        '<p class="muted">Админът трябва първо да отиде до всяко дърво, да го отвори и да натисне „Запиши GPS координатите тук“. После тук ще се вижда къде си.</p></div></div>';
      return body;
    }
    body += '<div class="compass-card">' +
      '<div class="compass"><div class="rose"><span class="n">С</span><span class="e">И</span><span class="s">Ю</span><span class="w">З</span></div>' +
      '<div class="needle" id="walkNeedle"></div></div>' +
      '<div class="compass-info"><div id="walkHeading" class="big">—</div>' +
      '<small class="muted">накъде гледа телефонът</small></div></div>';
    body += '<div class="card" id="walkStatus"><p class="muted">📡 Търся местоположение… разреши GPS и излез навън.</p></div>';
    body += '<div class="section-title">Къде съм на картата</div>';
    body += '<div class="mapwrap" id="mapwrap">' + orchardGrid('', '', false) + '</div>';
    body += '<p class="muted center mt" style="font-size:13px">📍 = ти си тук (най-близкото дърво)</p>';
    body += '</div>';
    return body;
  }

  function startWalk() {
    stopWalk(); // избегни дублирани слушатели при пре-рендиране
    // компас (посока на телефона) — изгладена стрелка, независима от шума на сензора
    walk.fx = null; walk.fy = null; walk.rot = 0; walk.shown = null;
    walk.targetDeg = null; walk.absok = false;

    // прилага ново измерване през кръгов нискочестотен филтър (без скок при 359°→0°)
    function applyHeading(hd) {
      var rad = hd * Math.PI / 180;
      var cx = Math.cos(rad), cy = Math.sin(rad);
      var a = 0.12; // по-силно изглаждане = по-спокойна стрелка
      if (walk.fx == null) { walk.fx = cx; walk.fy = cy; }
      else { walk.fx += a * (cx - walk.fx); walk.fy += a * (cy - walk.fy); }
      var sm = Math.atan2(walk.fy, walk.fx) * 180 / Math.PI;
      if (sm < 0) sm += 360;
      walk.targetDeg = sm;
      walk.heading = sm;
    }
    // абсолютен източник (Android): има истинска посока към север
    function onOrientAbs(e) {
      var hd = (typeof e.webkitCompassHeading === 'number') ? e.webkitCompassHeading
        : (e.alpha != null ? (360 - e.alpha) : null);
      if (hd == null) return;
      walk.absok = true;
      applyHeading(hd);
    }
    // относителен източник (iOS дава webkitCompassHeading тук) — ползва се само ако няма абсолютен
    function onOrientRel(e) {
      if (walk.absok) return; // не смесвай двата източника — това причиняваше „откачането“
      var hd = (typeof e.webkitCompassHeading === 'number') ? e.webkitCompassHeading
        : (e.alpha != null ? (360 - e.alpha) : null);
      if (hd == null) return;
      applyHeading(hd);
    }
    walk.orientAbs = onOrientAbs;
    walk.orientRel = onOrientRel;

    // непрекъсната плавна анимация — стрелката бавно се насочва към целта на всеки кадър
    function tick() {
      walk.raf = requestAnimationFrame(tick);
      if (walk.targetDeg == null) return;
      var delta = walk.targetDeg - (walk.rot % 360);
      if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
      walk.rot += delta * 0.15; // плавно насочване, а не рязък скок
      var needle = el('walkNeedle');
      if (needle) needle.style.transform = 'rotate(' + walk.rot.toFixed(1) + 'deg)';
      var shownDeg = Math.round(((walk.rot % 360) + 360) % 360);
      var txt = el('walkHeading');
      if (txt && (walk.shown == null || Math.abs(((shownDeg - walk.shown + 540) % 360) - 180) >= 2)) {
        walk.shown = shownDeg;
        txt.textContent = shownDeg + '° ' + compassName(shownDeg);
      }
    }
    walk.raf = requestAnimationFrame(tick);

    function attachOrient() {
      window.addEventListener('deviceorientationabsolute', onOrientAbs, true);
      window.addEventListener('deviceorientation', onOrientRel, true);
    }
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(function (r) { if (r === 'granted') attachOrient(); }).catch(function () {});
    } else { attachOrient(); }

    // местоположение (къде съм на картата)
    if (navigator.geolocation) {
      walk.watchId = navigator.geolocation.watchPosition(function (pos) {
        walk.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        updateWalkPosition();
      }, function (err) {
        var st = el('walkStatus');
        if (st) st.innerHTML = '<p class="muted">⚠️ Няма достъп до GPS: ' + esc(err && err.message ? err.message : 'разреши местоположение.') + '</p>';
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 });
    }
  }

  function stopWalk() {
    if (walk.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(walk.watchId);
    if (walk.raf) { cancelAnimationFrame(walk.raf); walk.raf = null; }
    if (walk.orientAbs) window.removeEventListener('deviceorientationabsolute', walk.orientAbs, true);
    if (walk.orientRel) window.removeEventListener('deviceorientation', walk.orientRel, true);
    walk.orientAbs = null; walk.orientRel = null;
    walk.watchId = null; walk.nearestId = null;
  }

  function compassName(d) {
    var dirs = ['С', 'СИ', 'И', 'ЮИ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
    return dirs[Math.round(d / 45) % 8];
  }

  function updateWalkPosition() {
    if (!walk.pos) return;
    var nearest = null, best = Infinity;
    db.trees.forEach(function (t) {
      if (t.deletedAt) return;
      var g = treeGPS(t); if (!g) return;
      var d = distM(walk.pos, g);
      if (d < best) { best = d; nearest = t; }
    });
    var st = el('walkStatus');
    if (nearest) {
      if (st) st.innerHTML = '<div style="display:flex;align-items:center;gap:12px">' +
        '<div class="ic harvest" style="width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--green-soft);font-size:22px">📍</div>' +
        '<div><b style="font-size:18px">Най-близо: Дърво ' + esc(nearest.code) + '</b>' +
        '<div class="muted">на ' + Math.round(best) + ' м · точност ±' + Math.round(walk.pos.acc) + ' м</div></div></div>';
      if (walk.nearestId !== nearest.id) {
        var prev = walk.nearestId ? el('cell_' + walk.nearestId) : null;
        if (prev) prev.classList.remove('me-here');
        walk.nearestId = nearest.id;
      }
      // гарантирай маркера върху текущото най-близко дърво
      document.querySelectorAll('.tree-cell.me-here').forEach(function (c) { c.classList.remove('me-here'); });
      var cell = el('cell_' + nearest.id);
      if (cell) cell.classList.add('me-here');
    } else if (st) {
      st.innerHTML = '<p class="muted">📡 Имам местоположение, но няма дърво с GPS наблизо.</p>';
    }
  }

  // =======================================================================
  //  SHEETS (modals)
  // =======================================================================
  function openSheet(html, peek) {
    var s = el('sheet');
    var wasPeek = s.classList.contains('open') && s.classList.contains('peek');
    s.innerHTML = '<div class="sheet"><div class="grip"></div>' + html + '</div>';
    s.classList.toggle('peek', !!peek); // при редакция — прозрачен фон, за да се вижда картата отзад
    s.classList.add('open');
    if (peek && !wasPeek) { try { var mw = el('mapwrap'); if (mw) mw.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {} }
  }
  function closeSheet() {
    var s = el('sheet'); s.classList.remove('open'); s.classList.remove('peek'); s.innerHTML = '';
    if (editingLmId) { editingLmId = null; editingLmKind = null; updateMap(); }
  }

  // ---- Сортове (само админ; промените се синхронизират за всички) ----
  var TREE_LABELS = [
    { id: 'auto', name: 'Автоматично (по знака)' },
    { id: 'none', name: 'Без оцветяване' },
    { id: 'green', name: '🟢 Зелен' },
    { id: 'blue', name: '🔵 Син' },
    { id: 'pink', name: '🩷 Розов' },
    { id: 'orange', name: '🟠 Оранжев/кафяв' }
  ];
  function varietyPreviewInner(shape, mark, letter, border, label) {
    return '<div class="tree-cell' + markRingCls(mark) + labelClsFor(label, mark) + '" style="width:64px;margin:0 auto">' +
      '<div class="svgwrap">' + treeSVGFull(shape, healthColors('green'), mark, letter, borderColor(border)) + '</div>' +
      '<span class="code">' + esc((el('vName') ? el('vName').value : '').trim() || 'А') + '</span></div>';
  }
  function varietyStyleFields(shape, mark, letter, border, label) {
    return '<div class="field"><label>🌳 Форма на дървото</label><select id="vShape" class="input">' +
      TREE_SHAPES.map(function (s) { return '<option value="' + s.id + '"' + (s.id === shape ? ' selected' : '') + '>' + s.name + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>🚩 Знак на сорта</label><select id="vMark" class="input">' +
      TREE_MARKS.map(function (m) { return '<option value="' + m.id + '"' + (m.id === mark ? ' selected' : '') + '>' + m.name + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>⭕ Бордър около короната</label><select id="vBorder" class="input">' +
      TREE_BORDERS.map(function (b) { return '<option value="' + b.id + '"' + (b.id === border ? ' selected' : '') + '>' + b.name + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>🔤 Оцветяване на етикета</label><select id="vLabel" class="input">' +
      TREE_LABELS.map(function (l) { return '<option value="' + l.id + '"' + (l.id === label ? ' selected' : '') + '>' + l.name + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>Преглед</label><div id="vPreview" style="padding:12px;background:#f5f8f5;border-radius:12px">' +
      varietyPreviewInner(shape, mark, letter, border, label) + '</div></div>';
  }
  function updateVarietyPreview() {
    var sh = el('vShape'), mk = el('vMark'), pv = el('vPreview'); if (!sh || !mk || !pv) return;
    var bd = el('vBorder') ? el('vBorder').value : 'none';
    var lb = el('vLabel') ? el('vLabel').value : 'auto';
    var nm = el('vName') ? el('vName').value : '';
    pv.innerHTML = varietyPreviewInner(sh.value, mk.value, (nm || '').trim().charAt(0), bd, lb);
  }
  function sheetVarietyNew() {
    if (!isAdmin()) return;
    openSheet('<h3>Нов сорт орех</h3>' +
      '<div class="field"><label>Име</label><input id="vName" class="input" placeholder="напр. Чандлър"/></div>' +
      '<div class="field"><label>Размер</label><select id="vSize" class="input"><option value="big">🌰 Едър сорт</option><option value="small">🥜 Дребен сорт</option></select></div>' +
      '<div class="field"><label>Бележка</label><input id="vNote" class="input" placeholder="напр. Големи орехи"/></div>' +
      varietyStyleFields('round', 'none', '', 'none', 'auto') +
      '<button class="btn" data-action="savevariety:new">💾 Добави сорт</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  function sheetVarietyEdit(id) {
    if (!isAdmin()) return;
    var v = variety(id); if (!v) return;
    openSheet('<h3>Сорт: ' + esc(v.name) + '</h3>' +
      '<div class="field"><label>Име</label><input id="vName" class="input" value="' + esc(v.name) + '"/></div>' +
      '<div class="field"><label>Размер</label><select id="vSize" class="input">' +
      '<option value="big"' + (v.size === 'big' ? ' selected' : '') + '>🌰 Едър сорт</option>' +
      '<option value="small"' + (v.size === 'small' ? ' selected' : '') + '>🥜 Дребен сорт</option></select></div>' +
      '<div class="field"><label>Бележка</label><input id="vNote" class="input" value="' + esc(v.note || '') + '"/></div>' +
      varietyStyleFields(varShape(v), varMark(v), varLetter(v), varBorder(v), varLabel(v)) +
      '<button class="btn" data-action="savevariety:' + v.id + '">💾 Запази</button>' +
      '<button class="btn danger mt" data-action="delvariety:' + v.id + '">🗑️ Изтрий сорта</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  function saveVariety(id) {
    if (!isAdmin()) return;
    var name = (el('vName').value || '').trim();
    if (!name) { alert('Въведи име на сорта.'); return; }
    var size = el('vSize').value === 'small' ? 'small' : 'big';
    var note = (el('vNote').value || '').trim();
    var shape = el('vShape') ? el('vShape').value : 'round';
    var mark = el('vMark') ? el('vMark').value : 'none';
    var border = el('vBorder') ? el('vBorder').value : 'none';
    var label = el('vLabel') ? el('vLabel').value : 'auto';
    if (id === 'new') {
      db.settings.varieties.push({ id: DB.uid('var'), name: name, size: size, note: note, shape: shape, mark: mark, border: border, label: label });
    } else {
      var v = variety(id); if (!v) return;
      v.name = name; v.size = size; v.note = note; v.shape = shape; v.mark = mark; v.border = border; v.label = label;
    }
    save(); closeSheet(); render();
  }
  function deleteVariety(id) {
    if (!isAdmin()) return;
    var v = variety(id); if (!v) return;
    var used = db.trees.filter(function (t) { return !t.deletedAt && t.varietyId === id; }).length;
    if (used) { alert('Този сорт се ползва от ' + used + ' дърво(а). Първо смени сорта им, после го изтрий.'); return; }
    if (db.settings.varieties.length <= 1) { alert('Трябва да има поне един сорт.'); return; }
    if (!confirm('Да изтрия ли сорт „' + v.name + '“?')) return;
    db.settings.varieties = db.settings.varieties.filter(function (x) { return x.id !== id; });
    save(); closeSheet(); render();
  }

  function sheetTreeEdit(id) {
    var t = tree(id);
    openSheet('<h3>Състояние на дърво ' + esc(t.code) + '</h3>' +
      '<div class="field"><label>Здраве</label>' +
      '<div class="row">' +
      ['green', 'yellow', 'red'].map(function (h) {
        return '<button class="btn ' + (t.health === h ? '' : 'secondary') + '" data-action="sethealth:' + id + ':' + h + '" style="' +
          (t.health === h ? 'background:var(--' + (h === 'green' ? 'green' : h === 'yellow' ? 'yellow' : 'red') + ')' : '') + '">' +
          (h === 'green' ? 'Здраво' : h === 'yellow' ? 'Грижа' : 'Болно') + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>Сорт</label><select id="etVar" class="input">' +
      db.settings.varieties.map(function (v) { return '<option value="' + v.id + '"' + (v.id === t.varietyId ? ' selected' : '') + '>' + esc(v.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>🗓️ Посадено</label><input id="etDate" type="date" class="input" value="' + esc(t.plantedAt || '') + '"/></div>' +
      '<div class="field"><label>Височина (м)</label><input id="etHeight" type="number" step="0.1" min="0" class="input" placeholder="напр. 3.5" value="' + (t.height != null && t.height !== '' ? esc(t.height) : '') + '"/></div>' +
      '<div class="field"><label>Бележка</label><textarea id="etNote" class="input">' + esc(t.note || '') + '</textarea></div>' +
      '<button class="btn" data-action="savetree:' + id + '">💾 Запази</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }

  // Групова редакция на няколко избрани дървета (само за админ). Празно поле = не променяй.
  function sheetBulkEdit() {
    var ids = mapSelected.slice();
    if (!ids.length) return;
    openSheet('<h3>Групова редакция на ' + ids.length + ' дървета</h3>' +
      '<p class="muted mb" style="font-size:13px">Попълни само полетата, които искаш да смениш за всички избрани. Празно поле = не се променя.</p>' +
      '<div class="field"><label>🗓️ Посадено</label><input id="beDate" type="date" class="input"/></div>' +
      '<div class="field"><label>Сорт</label><select id="beVar" class="input"><option value="">— не променяй —</option>' +
      db.settings.varieties.map(function (v) { return '<option value="' + v.id + '">' + esc(v.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Височина (м)</label><input id="beHeight" type="number" step="0.1" min="0" class="input" placeholder="не променяй"/></div>' +
      '<div class="field"><label>Здраве</label><select id="beHealth" class="input"><option value="">— не променяй —</option>' +
      '<option value="green">Здраво</option><option value="yellow">Нужда от грижа</option><option value="red">Болно / изсъхнало</option></select></div>' +
      '<button class="btn" data-action="savebulkedit">💾 Приложи за всички</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }

  function saveBulkEdit() {
    var ids = mapSelected.slice();
    if (!ids.length) { closeSheet(); return; }
    var dateEl = el('beDate'), varEl = el('beVar'), heightEl = el('beHeight'), healthEl = el('beHealth');
    var newDate = dateEl && dateEl.value ? dateEl.value : null;
    var newVar = varEl && varEl.value ? varEl.value : null;
    var newHeight = heightEl && heightEl.value !== '' ? parseFloat(heightEl.value) : null;
    var newHealth = healthEl && healthEl.value ? healthEl.value : null;
    if (newDate == null && newVar == null && newHeight == null && newHealth == null) { closeSheet(); return; }
    var count = 0;
    ids.forEach(function (id) {
      var t = tree(id); if (!t) return;
      var changes = {};
      if (newDate != null && (t.plantedAt || '') !== newDate) { changes.plantedAt = { before: t.plantedAt || '', after: newDate }; t.plantedAt = newDate; }
      if (newVar != null && t.varietyId !== newVar) { changes.varietyId = { before: t.varietyId, after: newVar }; t.varietyId = newVar; }
      if (newHeight != null && (t.height == null ? '' : t.height) !== newHeight) { changes.height = { before: t.height == null ? '' : t.height, after: newHeight }; t.height = newHeight; }
      if (newHealth != null && t.health !== newHealth) { changes.health = { before: t.health, after: newHealth }; t.health = newHealth; }
      if (Object.keys(changes).length) {
        addEvent({ type: 'tree_edit', treeId: id, date: DB.todayISO(), note: 'групова редакция', changes: changes });
        count++;
      }
    });
    clearMapSelect();
    closeSheet();
    go('home');
  }

  var _saleDraft = null; // пази попълнената продажба, докато се създава нов купувач
  function sheetNewSale(buyerId, draft) {
    draft = draft || {};
    var liveBuyers = db.buyers.filter(function (b) { return !b.deletedAt; });
    var noBuyers = liveBuyers.length === 0;
    openSheet('<h3>Нова продажба</h3>' +
      '<div class="field"><label>Купувач</label>' +
      (noBuyers
        ? '<p class="muted" style="font-size:13px;margin:0 0 8px">Още няма купувачи. Натисни бутона долу, за да създадеш нов.</p>'
        : '<select id="saleBuyer" class="input">' +
          liveBuyers.map(function (b) { return '<option value="' + b.id + '"' + (b.id === buyerId ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select>') +
      '</div>' +
      '<button class="btn ghost" style="margin:-4px 0 12px" data-action="newbuyerinsale">➕ Нов купувач</button>' +
      '<div class="field"><label>Дата</label><input id="saleDate" type="date" class="input" value="' + (draft.date || DB.todayISO()) + '"/></div>' +
      '<div class="row"><div class="field"><label>Количество (кг)</label><input id="saleKg" type="number" class="input" placeholder="0" value="' + (draft.kg != null ? draft.kg : '') + '"/></div>' +
      '<div class="field"><label>Цена (€/кг)</label><input id="salePrice" type="number" class="input" placeholder="0" value="' + (draft.price != null ? draft.price : '') + '"/></div></div>' +
      '<div class="field"><label>Бележка</label><input id="saleNote" class="input" placeholder="по избор" value="' + esc(draft.note || '') + '"/></div>' +
      (noBuyers ? '' : '<button class="btn" data-action="savesale">💾 Запази продажба</button>') +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  // капва попълненото в продажбата, за да не се губи при създаване на нов купувач
  function captureSaleDraft() {
    _saleDraft = {
      date: el('saleDate') ? el('saleDate').value : DB.todayISO(),
      kg: el('saleKg') ? el('saleKg').value : '',
      price: el('salePrice') ? el('salePrice').value : '',
      note: el('saleNote') ? el('saleNote').value : ''
    };
  }

  function sheetNewBuyer(fromSale) {
    openSheet('<h3>Нов купувач</h3>' +
      '<div class="field"><label>Име</label><input id="bName" class="input" placeholder="Име и фамилия"/></div>' +
      '<div class="field"><label>Телефон</label><input id="bPhone" class="input" placeholder="+359..."/></div>' +
      '<div class="field"><label>Бележка</label><textarea id="bNote" class="input" placeholder="по избор"></textarea></div>' +
      '<button class="btn" data-action="savebuyer' + (fromSale ? ':sale' : '') + '">💾 Запази купувач</button>' +
      '<button class="btn ghost mt" data-action="' + (fromSale ? 'backtosale' : 'closesheet') + '">Отказ</button>');
  }

  function sheetEditBuyer(id) {
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    openSheet('<h3>Редактирай купувач</h3>' +
      '<div class="field"><label>Име</label><input id="bName" class="input" value="' + esc(b.name) + '"/></div>' +
      '<div class="field"><label>Телефон</label><input id="bPhone" class="input" value="' + esc(b.phone || '') + '"/></div>' +
      '<div class="field"><label>Бележка</label><textarea id="bNote" class="input">' + esc(b.note || '') + '</textarea></div>' +
      '<button class="btn" data-action="saveeditbuyer:' + id + '">💾 Запази</button>' +
      '<button class="btn danger mt" data-action="delbuyer:' + id + '">🗑️ Изтрий купувача</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }

  // =======================================================================
  //  EVENT BINDING (delegation)
  // =======================================================================
  function bind() {
    // map filters
    var fVar = el('fVar'), fHealth = el('fHealth');
    if (fVar) fVar.onchange = updateMap;
    if (fHealth) fHealth.onchange = updateMap;
  }
  function updateMap() {
    var fVar = el('fVar') ? el('fVar').value : '';
    var fHealth = el('fHealth') ? el('fHealth').value : '';
    var mw = el('mapwrap');
    if (mw) mw.innerHTML = orchardGrid(fVar, fHealth, editMode);
    var lg = el('mapLegend');
    if (lg) lg.innerHTML = mapLegend(fVar, mapMode);
    var fv = el('fVar');
    if (fv) fv.innerHTML = varietyOptions(fVar, fHealth);
  }

  // разбивка на продажбите (транзакции) — отваря се от плочките „продадени" и „приходи" в Статистика
  function showSalesBreakdown() {
    var sales = activeSales().slice().sort(function (a, b) { return b.date < a.date ? -1 : (b.date > a.date ? 1 : (b.createdAt || 0) - (a.createdAt || 0)); });
    var totalKg = sales.reduce(function (s, x) { return s + (x.kg || 0); }, 0);
    var totalRev = sales.reduce(function (s, x) { return s + (x.total || 0); }, 0);
    var rows = sales.length ? sales.map(function (s) {
      var b = db.buyers.find(function (x) { return x.id === s.buyerId; });
      return '<div class="list-row"><div class="ic harvest">💰</div>' +
        '<div class="tx"><b>' + (b ? esc(b.name) : 'Купувач') + '</b>' +
        '<small>' + fmtKg(s.kg || 0) + ' кг · ' + (s.pricePerKg || 0) + ' €/кг' + (s.note ? ' · ' + esc(s.note) : '') + '</small></div>' +
        '<div class="meta"><b>' + (s.total || 0).toFixed(2) + ' €</b><div style="font-size:12px">' + fmtDate(s.date) + '</div></div></div>';
    }).join('') : '<p class="muted">Още няма продажби.</p>';
    openSheet('<h3>💰 Продажби (транзакции)</h3>' +
      '<div class="card"><div class="kv"><span class="k">Общо продадени</span><span class="v"><b>' + fmtKg(totalKg) + ' кг</b></span></div>' +
      '<div class="kv"><span class="k">Общо приходи</span><span class="v"><b>' + totalRev.toFixed(2) + ' €</b></span></div></div>' +
      '<div class="section-title">Всички транзакции (' + sales.length + ')</div>' +
      '<div class="card">' + rows + '</div>' +
      '<button class="btn ghost mt" data-action="closesheet">Затвори</button>');
  }

  // ---- Горни бройки: период „днес/седмица“ + разбивка по дървета ----------
  // текстови етикети за избрания период (днес / седмица / месец)
  function periodShort(p) { return p === 'week' ? '7д' : p === 'month' ? '30д' : p === 'prevmonth' ? 'мин. мес.' : p === 'year' ? '1г' : 'днес'; }
  function periodLong(p) { return p === 'week' ? 'тази седмица (7 дни)' : p === 'month' ? 'този месец (30 дни)' : p === 'prevmonth' ? 'предходния месец' : p === 'year' ? 'тази година (365 дни)' : 'днес'; }
  function periodPill(p) { return p === 'week' ? '🗓️ Тази седмица (7 дни)' : p === 'month' ? '📆 Този месец (30 дни)' : p === 'prevmonth' ? '📆 Предходен месец' : p === 'year' ? '🗓️ Тази година (365 дни)' : '📅 Днес'; }

  function setStatPeriod(p) {
    statPeriod = STAT_PERIODS.indexOf(p) !== -1 ? p : 'today';
    try { localStorage.setItem(STAT_PERIOD_KEY, statPeriod); } catch (e) {}
    harvestHL = null; // смяната на период маха подчертаването
    render();
  }
  function toggleStatPeriod() { stepStatPeriod(1); }
  // стъпка наляво/надясно по периодите, циклично (−1 = назад, +1 = напред)
  function stepStatPeriod(dir) {
    var n = STAT_PERIODS.length;
    var idx = STAT_PERIODS.indexOf(statPeriod); if (idx < 0) idx = 0;
    var ni = ((idx + dir) % n + n) % n;
    setStatPeriod(STAT_PERIODS[ni]);
  }

  // показва от кои дървета колко е събрано за избрания период и ги маркира на картата
  function showHarvestBreakdown() {
    var hv = harvestStats(statPeriod);
    var when = periodLong(statPeriod);
    harvestHL = hv.perTree; // маркирай дърветата на картата
    render();               // прерисувай картата с подчертаването
    var ranked = Object.keys(hv.perTree).map(function (id) { return { t: tree(id), kg: hv.perTree[id], bk: hv.perTreeBk[id] || 0 }; })
      .filter(function (r) { return r.t; }).sort(function (a, b) { return b.kg - a.kg; });
    var list = ranked.length ? ranked.map(function (r) {
      return '<div class="list-row"><div class="ic harvest">🌳</div>' +
        '<div class="tx"><b>Дърво ' + esc(r.t.code) + '</b><small>' + fmtKg(r.bk) + ' кофи</small></div>' +
        '<div class="meta"><b>' + fmtKg(r.kg) + ' кг</b></div></div>';
    }).join('') : '<p class="muted">Няма събрано от дървета за този период.</p>';
    var ground = hv.groundKg > 0 ? '<div class="list-row"><div class="ic harvest">🍂</div>' +
      '<div class="tx"><b>От земята (зелени)</b><small>' + fmtKg(hv.groundBk) + ' кофи</small></div>' +
      '<div class="meta"><b>' + fmtKg(hv.groundKg) + ' кг</b></div></div>' : '';
    var greenBk = hv.buckets;
    var sh = shelledStats(statPeriod);
    var shelledBk = sh.buckets;
    var shelledKg = sh.kg;
    var today = DB.todayISO();
    var todayOv = shellOverrideFor(today);
    var todayAuto = activeEvents().filter(function (e) {
      return (e.type === 'harvest_tree' || e.type === 'harvest_ground') && e.date === today;
    }).reduce(function (s, e) { return s + greenCheeseBuckets(e); }, 0) * shellYield();
    var prefill = todayOv ? todayOv.buckets : fmtKg(todayAuto);
    openSheet('<h3>Събрано ' + when + '</h3>' +
      '<p class="muted mb" style="font-size:13px">🟢 Зелени: <b>' + fmtKg(greenBk) + ' кофи</b> (≈ ' + fmtKg(hv.kg) + ' кг)<br>' +
      '🥥 Обелени: <b>' + fmtKg(shelledBk) + ' кофи</b> (≈ ' + fmtKg(shelledKg) + ' кг) — ' + (sh.manual ? 'включва ръчно въведени.' : 'автоматично от зеленото.') + '<br>Маркирах дърветата на картата.</p>' +
      '<div class="section-title" style="margin-top:0">Зелени кофи по дърво</div>' +
      '<div class="card">' + list + ground + '</div>' +
      '<div class="section-title">✏️ Обелени кофи за днес (ръчно)</div>' +
      '<div class="card">' +
      '<p class="muted" style="font-size:12px;margin:0 0 8px">Накрая, като обелите, въведи колко кофи обелени излязоха днес. Записаното надделява над авто-сметката.' +
      (todayOv ? '' : ' Сега сметнато: <b>' + fmtKg(todayAuto) + '</b> кофи.') + '</p>' +
      '<div class="field"><label>Обелени кофи (днес)</label><input id="shToday" class="input" type="number" step="0.25" min="0" value="' + prefill + '"/></div>' +
      '<button class="btn secondary" data-action="saveshelled">💾 Запиши обелените за днес</button>' +
      (todayOv ? '<button class="btn sm ghost mt" data-action="clearshelled">↩️ Върни към авто-сметка</button>' : '') +
      '</div>' +
      '<button class="btn ghost mt" data-action="closesheet">Затвори</button>');
  }

  // суайп наляво/надясно върху горните бройки → сменя период (днес ↔ седмица)
  function initStatSwipe() {
    var row = el('statSwipe'); if (!row) return;
    var sx = 0, sy = 0, swiping = false;
    function down(x, y) { sx = x; sy = y; swiping = false; }
    function move(x, y) { if (Math.abs(x - sx) > 40 && Math.abs(x - sx) > Math.abs(y - sy)) swiping = true; }
    function up(x) {
      if (!swiping) return;
      statSuppressClick = true; // да не отвори разбивка от същото докосване
      stepStatPeriod(x < sx ? 1 : -1); // наляво = напред, надясно = назад
    }
    row.addEventListener('touchstart', function (e) { var t = e.touches[0]; down(t.clientX, t.clientY); }, { passive: true });
    row.addEventListener('touchmove', function (e) { var t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
    row.addEventListener('touchend', function (e) { var t = e.changedTouches[0]; up(t.clientX); });
    row.addEventListener('mousedown', function (e) { down(e.clientX, e.clientY); });
    row.addEventListener('mousemove', function (e) { if (e.buttons) move(e.clientX, e.clientY); });
    row.addEventListener('mouseup', function (e) { up(e.clientX); });
  }

  // ---- Избор на няколко дървета върху картата (задържане + влачене) ------
  function markCell(id, on) {
    var c = el('cell_' + id);
    if (c) c.classList.toggle('selected', on);
  }
  function selectMapTree(id) {
    if (mapSelected.indexOf(id) === -1) { mapSelected.push(id); markCell(id, true); renderMapBar(); }
  }
  // задава точно състояние (вкл./изкл.) — за „рисуване" по дърветата
  function setMapTree(id, on) {
    var i = mapSelected.indexOf(id);
    if (on && i === -1) { mapSelected.push(id); markCell(id, true); renderMapBar(); }
    else if (!on && i !== -1) { mapSelected.splice(i, 1); markCell(id, false); renderMapBar(); }
  }
  function toggleMapTree(id) {
    var i = mapSelected.indexOf(id);
    if (i === -1) { mapSelected.push(id); markCell(id, true); }
    else { mapSelected.splice(i, 1); markCell(id, false); }
    renderMapBar();
  }
  // слага/маха клас на картата, за да спре скрола, докато „рисуваме" (след задържане)
  function paintClass(on) {
    var mw = el('mapwrap'); if (mw) mw.classList.toggle('painting', on);
  }
  function clearMapSelect() {
    mapSelect = false;
    mapSelected.slice().forEach(function (id) { markCell(id, false); });
    mapSelected = [];
    paintClass(false);
    renderMapBar();
  }
  function renderMapBar() {
    var bar = el('mapbar'); if (!bar) return;
    if (!mapSelect && !mapSelected.length) { bar.classList.remove('open'); bar.innerHTML = ''; return; }
    var n = mapSelected.length;
    var info = n ? '<b>' + n + '</b> избрани дървета' : 'Задръж върху дърво и плъзни · скролни за надолу';
    bar.innerHTML = '<div class="mapbar-info">' + info + '</div>' +
      '<div class="mapbar-actions">' +
      (n ? '<button class="btn sm" data-action="mapcare:fertilize">🌱 Торене</button>' +
        '<button class="btn sm" data-action="mapcare:water">💧 Поливане</button>' +
        (isAdmin() ? '<button class="btn sm secondary" data-action="mapbulkedit" aria-label="Редактирай">✏️</button>' : '') : '') +
      '<button class="btn sm ghost" data-action="mapclear" aria-label="Готово">✓</button>' +
      '</div>';
    bar.classList.add('open');
  }
  // закача слушатели за задържане + влачене върху картата (задържи за да рисуваш; инак скрол)
  function initMapSelect() {
    if (initMapSelect._done) return;
    initMapSelect._done = true;
    var drag = null;               // { startId, sx, sy, painting, on, last, lp }
    var usingTouch = false;        // на тъч устройства пренебрегваме емулираните мишка-събития
    var HOLD_MS = 280;             // задържане, преди да тръгне рисуването
    var MOVE_TOL = 10;             // px толеранс: движение преди задържане = скрол
    function treeIdAt(x, y) {
      var elp = document.elementFromPoint(x, y);
      var cell = elp && elp.closest ? elp.closest('.tree-cell') : null;
      return cell ? cell.getAttribute('data-tid') : null;
    }
    function start(x, y) {
      if (!mapSelect) return;
      var id = treeIdAt(x, y); if (!id) return;
      drag = { startId: id, sx: x, sy: y, painting: false, on: true, last: null, lp: null };
      drag.lp = setTimeout(function () {
        if (!drag) return;
        drag.painting = true;
        drag.on = mapSelected.indexOf(drag.startId) === -1; // не е избрано → рисуваме; инак триене
        drag.last = drag.startId;
        paintClass(true);           // спира скрола, докато рисуваме
        setMapTree(drag.startId, drag.on);
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (er) {} }
      }, HOLD_MS);
    }
    // връща true, ако рисуваме (викащият трябва да спре скрола)
    function move(x, y) {
      if (!drag) return false;
      if (!drag.painting) {
        if (Math.abs(x - drag.sx) > MOVE_TOL || Math.abs(y - drag.sy) > MOVE_TOL) {
          clearTimeout(drag.lp); drag = null; // движение преди задържане → това е скрол
        }
        return false;
      }
      var id = treeIdAt(x, y);
      if (id && id !== drag.last) { drag.last = id; setMapTree(id, drag.on); }
      return true;
    }
    function end() {
      if (!drag) return;
      clearTimeout(drag.lp);
      if (drag.painting) mapSuppressClick = true; // да не toggle-не клика след рисуване
      paintClass(false);
      drag = null;
    }
    // тъч (телефон) — touchstart е passive, за да не пречи на скрола
    document.addEventListener('touchstart', function (e) {
      usingTouch = true;
      if (e.touches.length !== 1) { if (drag) clearTimeout(drag.lp); drag = null; return; }
      var t = e.touches[0]; start(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      var t = e.touches[0]; if (!t) return;
      if (move(t.clientX, t.clientY)) e.preventDefault(); // спира скрола само докато рисуваме
    }, { passive: false });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
    // мишка (десктоп, за тест)
    document.addEventListener('mousedown', function (e) { if (usingTouch) return; start(e.clientX, e.clientY); });
    document.addEventListener('mousemove', function (e) { if (usingTouch) return; if (move(e.clientX, e.clientY)) e.preventDefault(); });
    document.addEventListener('mouseup', function () { if (usingTouch) return; end(); });
  }

  // ръчно въведени стойности в броячите за кофи → пазим ги директно в harvestDraft
  document.addEventListener('input', function (e) {
    var inp = e.target;
    if (!inp || !inp.getAttribute) return;
    if (inp.id === 'clKg' || inp.id === 'clCount') { updateCleanNet(); return; }
    if (inp.id === 'sortWhite' || inp.id === 'sortBlack' || inp.id === 'sortWhiteCount' || inp.id === 'sortBlackCount') { updateSortNet(); return; }
    var key = inp.getAttribute('data-count');
    if (key == null) return;
    var v = parseFloat(String(inp.value).replace(',', '.'));
    if (!isFinite(v) || v < 0) v = 0;
    harvestDraft[key] = harvestDraft[key] || { _count: 0 };
    harvestDraft[key]._count = v;
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'clBucket') updateCleanNet();
    if (e.target && e.target.id === 'homePeriod') setStatPeriod(e.target.value);
    if (e.target && (e.target.id === 'vShape' || e.target.id === 'vMark' || e.target.id === 'vBorder' || e.target.id === 'vLabel')) updateVarietyPreview();
    if (e.target && e.target.id === 'lmColor' && editingLmKind) setLandmarkColor(editingLmKind, e.target.value);
    if (e.target && e.target.id === 'arColor') setAreaColor(e.target.getAttribute('data-area'), e.target.value);
  });
  // жив преглед на знака при писане на име (за „кръгче с буква")
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'vName' && el('vMark') && el('vMark').value === 'letter') updateVarietyPreview();
    if (e.target && e.target.id === 'arColor') setAreaColor(e.target.getAttribute('data-area'), e.target.value);
    if (e.target && e.target.id === 'arOpacity') setAreaOpacity(e.target.getAttribute('data-area'), e.target.value);
  });

  // жив преглед при наместване на профилната снимка (зуум + местене наляво/надясно/горе/долу)
  document.addEventListener('input', function (e) {
    if (e.target && (e.target.id === 'ppZoom' || e.target.id === 'ppX' || e.target.id === 'ppY')) {
      updatePhotoPreview();
    }
  });

  // Enter в поле (вкл. телефонната клавиатура): отиди на следващото поле или скрий клавиатурата
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    var t = e.target;
    if (!t || t.tagName !== 'INPUT') return;
    var type = (t.getAttribute('type') || 'text').toLowerCase();
    if (type === 'date' || type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') return;
    e.preventDefault();
    var box = t.closest('.sheet, .content') || document.body;
    var fields = [].slice.call(box.querySelectorAll('input, select, textarea')).filter(function (el) {
      var ty = (el.getAttribute('type') || '').toLowerCase();
      return !el.disabled && el.offsetParent !== null && ty !== 'hidden' && ty !== 'button' && ty !== 'submit';
    });
    var idx = fields.indexOf(t);
    var next = idx > -1 ? fields[idx + 1] : null;
    if (next && (next.getAttribute('type') || '').toLowerCase() !== 'date') { next.focus(); }
    else { t.blur(); }
  });

  document.addEventListener('click', function (e) {
    var node = e.target.closest('[data-action]');
    if (!node) return;
    // след задържане/влачене за избор — пропусни този клик (иначе ще размаркира дървото)
    if (mapSuppressClick) { mapSuppressClick = false; e.preventDefault(); return; }
    // след суайп по горните бройки — пропусни клика (иначе ще отвори разбивка)
    if (statSuppressClick) { statSuppressClick = false; e.preventDefault(); return; }
    var action = node.getAttribute('data-action');
    var parts = action.split(':');
    var cmd = parts[0];

    switch (cmd) {
      case 'nav': go(parts[1]); break;
      case 'back': goBack(); break;
      case 'login': tryLogin(parts[1]); break;
      case 'loginadmin': doAdminLogin(parts[1]); break;
      case 'register': doRegister(); break;
      case 'logout': db.currentUserId = null; save(); render(); break;
      case 'settings': go('settings'); break;

      case 'tree':
        if (mapSelect) { toggleMapTree(parts[1]); break; } // в режим избор докосването маркира/размаркирва
        treeHarvestOpen = ''; treeDetailsOpen = false; go('tree', parts[1]); break;
      case 'mapcare':
        careTab = parts[1]; careScope = 'trees'; careTrees = mapSelected.slice(); careTreePreset = '';
        clearMapSelect(); go('care'); break;
      case 'mapbulkedit': if (isAdmin()) sheetBulkEdit(); break;
      case 'savebulkedit': if (isAdmin()) saveBulkEdit(); break;
      case 'mapclear': clearMapSelect(); render(); break;
      case 'mapselecttoggle':
        if (mapSelect || mapSelected.length) clearMapSelect(); else mapSelect = true;
        render(); break;
      case 'mapmode': mapMode = (parts[1] === 'harvest' ? 'harvest' : 'health'); try { localStorage.setItem(MAP_MODE_KEY, mapMode); } catch (e) {} render(); break;
      case 'statperiod': toggleStatPeriod(); break;
      case 'statstep': stepStatPeriod(parseInt(parts[1], 10) || 0); break;
      case 'statbreak': showHarvestBreakdown(); break;
      case 'salesbreak': showSalesBreakdown(); break;
      case 'statclear': harvestHL = null; render(); break;
      case 'statsmode':
        statsMode = (parts[1] === 'month' || parts[1] === 'prevmonth' || parts[1] === 'weeks') ? parts[1] : 'season';
        if (statsMode === 'month') statsRef = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        else if (statsMode === 'weeks') statsRef = new Date();
        else statsRef = null;
        render(); break;
      case 'statsweek': {
        var ws = new Date(parts.slice(1).join(':') + 'T00:00:00'); // parts[1] е ISO дата (yyyy-mm-dd)
        if (!isNaN(ws)) { statsRef = ws; statsMode = 'oneweek'; }
        render(); break;
      }
      case 'statsprev': case 'statsnext': {
        var dir = parts[0] === 'statsnext' ? 1 : -1;
        if (statsMode === 'month') { var r = statsRef || new Date(); statsRef = new Date(r.getFullYear(), r.getMonth() + dir, 1); }
        else if (statsMode === 'weeks') { var w = statsRef || new Date(); var n = new Date(w); n.setDate(n.getDate() + dir * 7 * 8); statsRef = n; }
        else if (statsMode === 'oneweek') { var w1 = statsRef || new Date(); var n1 = new Date(w1); n1.setDate(n1.getDate() + dir * 7); statsRef = n1; }
        render(); break;
      }
      case 'treeedit': { var te = tree(parts[1]); treeEditBefore = te ? { id: te.id, health: te.health, varietyId: te.varietyId, note: te.note, height: te.height, plantedAt: te.plantedAt } : null; sheetTreeEdit(parts[1]); break; }
      case 'treeharvest':
        treeHarvestOpen = (treeHarvestOpen === parts[1] ? '' : parts[1]);
        if (treeHarvestOpen) { if (!harvestDraft[treeHarvestOpen]) harvestDraft[treeHarvestOpen] = {}; if (harvestDraft[treeHarvestOpen]._count == null) harvestDraft[treeHarvestOpen]._count = 1; }
        render(); if (treeHarvestOpen) scrollToEl('treeHarvestForm'); break;
      case 'treedetails': treeDetailsOpen = !treeDetailsOpen; render(); if (treeDetailsOpen) scrollToEl('treeDetails'); break;
      case 'treeharvestcancel': treeHarvestOpen = ''; render(); break;
      case 'savetreeharvestinline': saveTreeHarvestInline(parts[1]); break;
      case 'treecare': careTab = parts[1]; careScope = 'tree'; careTreePreset = parts[2]; go('care'); break;
      case 'savetree': saveTreeEdit(parts[1]); break;
      case 'savegps': saveGps(parts[1]); break;
      case 'sethealth': setHealth(parts[1], parts[2]); break;
      case 'addphoto': addPhoto(parts[1]); break;
      case 'setcover': setCover(parts[1], parts[2]); break;
      case 'delphoto': removePhoto(parts[1], parts[2]); break;

      case 'editschema': if (isAdmin()) { editMode = !editMode; closeLmEditor(); render(); } break;
      case 'addtree': sheetAddTree(parts[1], parseInt(parts[2], 10)); break;
      case 'savenewtree': saveNewTree(parts[1], parseInt(parts[2], 10)); break;
      case 'edittree': floatEditTree(parts[1]); break;
      case 'treemove': nudgeTree(parts[1], parts[2]); break;
      case 'edittreefull': closeLmEditor(); sheetEditTree(parts[1]); break;
      case 'deltree': deleteTree(parts[1]); break;

      case 'editzone': sheetEditZone(parts[1]); break;
      case 'movezone': moveZone(parts[1], parts[2]); break;
      case 'sizezone': sizeZone(parts[1], parts[2]); break;
      case 'renamezone': renameZone(parts[1]); break;
      case 'addzone': addZone(); break;
      case 'delzone': deleteZone(parts[1]); break;

      case 'editarea': sheetEditArea(parts[1]); break;
      case 'movearea': moveArea(parts[1], parts[2]); break;
      case 'sizearea': sizeArea(parts[1], parts[2]); break;
      case 'renamearea': renameArea(parts[1]); break;
      case 'addarea': addArea(); break;
      case 'delarea': deleteArea(parts[1]); break;

      case 'editlm': sheetEditLandmark(parts[1]); break;
      case 'lmnudge': nudgeLandmark(parts[1], parts[2]); break;
      case 'lmstep': toggleLmStep(); break;
      case 'lmreset': resetLandmark(parts[1]); break;
      case 'lmcolorreset': resetLandmarkColor(parts[1]); break;
      case 'closelmeditor': closeLmEditor(); break;
      case 'togglelandmarks': setLandmarksVisible(!landmarksVisible()); render(); break;
      case 'lmscaleup': setLmScale(lmScale() + 0.1); break;
      case 'lmscaledown': setLmScale(lmScale() - 0.1); break;
      case 'lmscalereset': setLmScale(1); break;

      case 'care': careTab = parts[1]; careScope = 'all'; careTreePreset = ''; go('care'); break;
      case 'ctab': careTab = parts[1]; render(); break;
      case 'cscope': careScope = parts[1]; if (parts[1] !== 'trees') careTrees = []; render(); break;
      case 'crow': {
        var rk = parts[1];
        var ix = careRows.indexOf(rk);
        if (ix === -1) careRows.push(rk); else careRows.splice(ix, 1);
        render(); break;
      }
      case 'savecare': saveCare(parts[1]); break;

      case 'hmode': harvestMode = parts[1]; render(); break;
      case 'hscreen': {
        harvestScreen = parts[1];
        if (parts[1] === 'fertilize' || parts[1] === 'water' || parts[1] === 'mow') { careTab = parts[1]; careScope = 'all'; careTreePreset = ''; }
        render(); break;
      }
      case 'groundquick': showGroundHarvest(); break;
      case 'savegroundquick': saveGroundQuick(); break;
      case 'gbuck': groundBucket = parts[1]; showGroundHarvest(); break;
      case 'gfill': groundFill = parseInt(parts[1], 10) || 100; showGroundHarvest(); break;
      case 'gfillstep': groundFill = Math.max(5, Math.min(100, groundFill + (parseInt(parts[1], 10) || 0))); showGroundHarvest(); break;
      case 'hrow': harvestRowFilter = parts[1] || ''; render(); break;
      case 'hbuck': harvestBucket = parts[1]; render(); break;
      case 'hfill': harvestFill = parseInt(parts[1], 10) || 100; render(); break;
      case 'hfillstep': harvestFill = Math.max(5, Math.min(100, harvestFill + (parseInt(parts[1], 10) || 0))); render(); break;
      case 'hplus': stepHarvest(parts[1], 1); break;
      case 'hminus': stepHarvest(parts[1], -1); break;
      case 'savehcurrent': saveHarvest(); break;

      case 'del': {
        if (!isAdmin()) break;
        var dev = db.events.find(function (x) { return x.id === parts[1]; });
        var dmsg = (dev && dev.type === 'tree_edit' && dev.changes)
          ? 'Да изтрия ли записа и да върна дървото както беше преди тази промяна?'
          : 'Да изтрия ли записа? Ще се пази в историята.';
        if (confirm(dmsg)) { softDelete(parts[1]); render(); }
        break;
      }
      case 'restore': if (isAdmin()) { restore(parts[1]); render(); } break;
      case 'purge': if (isAdmin() && confirm('Да изтрия ли записа ЗАВИНАГИ? Не може да се върне.')) { purgeEvent(parts[1]); } break;
      case 'edit': editEvent(parts[1]); break;
      case 'saveedit': saveEditEvent(parts[1]); break;
      case 'logtype': { var tp = parts[1] || 'all'; if (tp === 'all') logFilterTypes = []; else { var ti = logFilterTypes.indexOf(tp); if (ti === -1) logFilterTypes.push(tp); else logFilterTypes.splice(ti, 1); } render(); break; }
      case 'loguser': { var up = parts.slice(1).join(':') || 'all'; if (up === 'all') logFilterUsers = []; else { var ui = logFilterUsers.indexOf(up); if (ui === -1) logFilterUsers.push(up); else logFilterUsers.splice(ui, 1); } render(); break; }
      case 'react': toggleReaction(parts[1]); break;

      case 'newsale': sheetNewSale(); break;
      case 'newsalefor': sheetNewSale(parts[1]); break;
      case 'savesale': saveSale(); break;
      case 'newbuyer': sheetNewBuyer(); break;
      case 'newbuyerinsale': captureSaleDraft(); sheetNewBuyer(true); break;
      case 'backtosale': sheetNewSale(null, _saleDraft); _saleDraft = null; break;
      case 'savebuyer': saveBuyer(parts[1] === 'sale'); break;
      case 'editbuyer': sheetEditBuyer(parts[1]); break;
      case 'saveeditbuyer': saveEditBuyer(parts[1]); break;
      case 'delbuyer': deleteBuyer(parts[1]); break;
      case 'restorebuyer': restoreBuyer(parts[1]); break;
      case 'delsale': deleteSale(parts[1]); break;
      case 'buyer': go('buyer', parts[1]); break;

      case 'savebuckets': saveBuckets(); break;
      case 'bucketsapply': applyBuckets(parts[1], parts[1] === 'from' ? (el('bkFromDate') && el('bkFromDate').value) : null); break;
      case 'bucketscancel': pendingBucketVals = null; closeSheet(); break;
      case 'savecalc': saveCalc(); break;
      case 'saveshellyield': saveShellYield(); break;
      case 'saveshelled': saveShelledToday(); break;
      case 'clearshelled': clearShelledToday(); break;
      case 'kernel': showKernel(); break;
      case 'addclean': addCleanEntry(); break;
      case 'addshell': addShellEntry(); break;
      case 'addsort': addSortEntry(); break;
      case 'sortavg': { if (!isAdmin()) break; var se = db.events.find(function (x) { return x.id === parts[1]; }); if (se) { se.excludeAvg = !se.excludeAvg; save(); render(); } break; }
      case 'swbuck': captureSortInputs(); sortWhiteBucket = parts[1] === 'none' ? '' : parts[1]; render(); break;
      case 'sbbuck': captureSortInputs(); sortBlackBucket = parts[1] === 'none' ? '' : parts[1]; render(); break;
      case 'savewhiteblack': saveWhiteBlack(); break;

      case 'varnew': sheetVarietyNew(); break;
      case 'varedit': sheetVarietyEdit(parts[1]); break;
      case 'savevariety': saveVariety(parts[1]); break;
      case 'delvariety': deleteVariety(parts[1]); break;

      case 'promote': sheetPromote(parts[1]); break;
      case 'dopromote': doPromote(parts[1]); break;
      case 'demote': doDemote(parts[1]); break;
      case 'setpass': sheetSetPass(parts[1]); break;
      case 'dosetpass': doSetPass(parts[1]); break;
      case 'deluser': doDelUser(parts[1]); break;
      case 'changemypass': sheetSetPass(db.currentUserId); break;

      case 'zoomin': setZoom(getZoom() + 0.1); break;
      case 'zoomout': setZoom(getZoom() - 0.1); break;
      case 'zoomreset': setZoom(1); break;
      case 'zoomphoto': { var zp = treePhotos(parts[1]).filter(function (p) { return p.id === parts[2]; })[0]; if (zp) openLightbox(zp.data); break; }

      case 'checkupdate': checkForUpdate(); break;
      case 'applyupdate': applyUpdate(); break;
      case 'toggnotif': toggleNotif(); break;
      case 'setphoto': setProfilePhoto(); break;
      case 'delprofilephoto': delProfilePhoto(); break;
      case 'savephotoadj': saveProfilePhotoAdjust(); break;

      case 'closesheet': cancelTreeEdit(); closeSheet(); break;
    }
  });

  // backdrop click closes sheet
  el('sheet').addEventListener('click', function (e) { if (e.target.id === 'sheet') closeSheet(); });

  // ---- Auth --------------------------------------------------------------
  function tryLogin(id) {
    var u = db.users.find(function (x) { return x.id === id; });
    if (!u) return;
    if (u.role === 'admin') { sheetAdminPassword(id); return; }
    db.currentUserId = id; save(); onUserReady(); go('home');
  }
  function sheetAdminPassword(id) {
    var u = db.users.find(function (x) { return x.id === id; });
    openSheet('<h3>🔒 ' + esc(u.name) + '</h3>' +
      '<p class="muted mb">Въведи паролата за администратор.</p>' +
      '<div class="field"><input id="admPass" class="input" type="password" inputmode="numeric" placeholder="Парола" autofocus/></div>' +
      '<div id="admErr" class="chip red hidden" style="margin-bottom:12px">Грешна парола</div>' +
      '<button class="btn" data-action="loginadmin:' + id + '">Влез</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
    setTimeout(function () { var p = el('admPass'); if (p) p.focus(); }, 60);
  }
  function doAdminLogin(id) {
    var u = db.users.find(function (x) { return x.id === id; });
    var pass = el('admPass') ? el('admPass').value : '';
    if (u && u.pass === DB.hashPw(pass)) { db.currentUserId = id; save(); onUserReady(); closeSheet(); go('home'); }
    else { var er = el('admErr'); if (er) er.classList.remove('hidden'); }
  }

  function doRegister() {
    var name = (el('newName').value || '').trim();
    if (!name) { el('newName').focus(); return; }
    var u = { id: DB.uid('u'), name: name, role: 'worker' };  // нови = работници
    db.users.push(u); db.currentUserId = u.id; save(); onUserReady(); go('home');
  }

  // ---- Schema editor (admin) --------------------------------------------
  function nextCode(rk) {
    var n = db.trees.filter(function (t) { return !t.deletedAt && t.row === rk; }).length + 1;
    return rk + n;
  }
  function sheetAddTree(rk, col) {
    if (!isAdmin()) return;
    openSheet('<h3>Ново дърво · ред ' + esc(rk) + ', колона ' + col + '</h3>' +
      '<div class="field"><label>Име/код</label><input id="ntCode" class="input" value="' + esc(nextCode(rk)) + '"/></div>' +
      '<div class="field"><label>Сорт</label><select id="ntVar" class="input">' +
      db.settings.varieties.map(function (v) { return '<option value="' + v.id + '">' + esc(v.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Състояние</label><select id="ntHealth" class="input"><option value="green">Здраво</option><option value="yellow">За грижа</option><option value="red">Болно</option></select></div>' +
      '<button class="btn" data-action="savenewtree:' + rk + ':' + col + '">💾 Добави дърво</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  function saveNewTree(rk, col) {
    var t = {
      id: DB.uid('tree'), code: (el('ntCode').value || nextCode(rk)).trim(),
      row: rk, col: col, varietyId: el('ntVar').value, health: el('ntHealth').value,
      plantedAt: DB.todayISO(), gps: '', note: '', photos: [], deletedAt: null, deletedBy: null
    };
    db.trees.push(t); save();
    addEvent({ type: 'tree_edit', treeId: t.id, date: DB.todayISO(), note: 'добавено дърво ' + t.code });
    closeSheet(); render();
  }
  function sheetEditTree(id) {
    var t = tree(id); if (!t) return;
    openSheet('<h3>Дърво ' + esc(t.code) + '</h3>' +
      '<div class="field"><label>Име/код</label><input id="etCode" class="input" value="' + esc(t.code) + '"/></div>' +
      '<div class="field"><label>Сорт</label><select id="etVar2" class="input">' +
      db.settings.varieties.map(function (v) { return '<option value="' + v.id + '"' + (v.id === t.varietyId ? ' selected' : '') + '>' + esc(v.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Състояние</label><select id="etHealth2" class="input">' +
      ['green', 'yellow', 'red'].map(function (h) { return '<option value="' + h + '"' + (t.health === h ? ' selected' : '') + '>' + healthLabel(h) + '</option>'; }).join('') + '</select></div>' +
      '<button class="btn" data-action="savetree:' + id + '">💾 Запази</button>' +
      '<button class="btn danger mt" data-action="deltree:' + id + '">🗑️ Изтрий дървото</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>', true);
  }
  function occupied(row, col, exceptId) {
    return db.trees.some(function (t) { return !t.deletedAt && t.row === row && t.col === col && t.id !== exceptId; });
  }
  function deleteTree(id) {
    if (!isAdmin()) return;
    var t = tree(id); if (!t) return;
    if (!confirm('Да изтрия ли дърво ' + t.code + '? Пази се в историята.')) return;
    t.deletedAt = Date.now(); t.deletedBy = db.currentUserId; save();
    addEvent({ type: 'tree_edit', treeId: id, date: DB.todayISO(), note: 'изтрито дърво ' + t.code });
    closeSheet(); render();
  }

  // ---- Decorative zones (admin) -----------------------------------------
  function zoneById(id) { return (db.settings.zones || []).find(function (z) { return z.id === id; }); }
  function orchardRowCount() { var s = {}; db.trees.forEach(function (t) { if (!t.deletedAt) s[t.row] = 1; }); return Object.keys(s).length || 1; }

  function sheetEditZone(id) {
    if (!isAdmin()) return;
    var z = zoneById(id); if (!z) return;
    openSheet('<h3>' + (z.emoji || '') + ' ' + esc(z.label) + '</h3>' +
      '<div class="field"><label>Име</label><div class="row"><input id="znName" class="input" value="' + esc(z.label) + '" />' +
      '<button class="btn sm" data-action="renamezone:' + id + '">Запази</button></div></div>' +
      '<div class="field"><label>Премести</label><div class="move-pad">' +
      '<span class="sp"></span><button data-action="movezone:' + id + ':up">↑</button><span class="sp"></span>' +
      '<button data-action="movezone:' + id + ':left">←</button><span class="sp"></span><button data-action="movezone:' + id + ':right">→</button>' +
      '<span class="sp"></span><button data-action="movezone:' + id + ':down">↓</button><span class="sp"></span>' +
      '</div></div>' +
      '<div class="field"><label>Ширина</label><div class="row">' +
      '<button class="btn secondary" data-action="sizezone:' + id + ':wminus">− по-тясно</button>' +
      '<button class="btn secondary" data-action="sizezone:' + id + ':wplus">по-широко +</button></div></div>' +
      '<div class="field"><label>Височина</label><div class="row">' +
      '<button class="btn secondary" data-action="sizezone:' + id + ':hminus">− по-ниско</button>' +
      '<button class="btn secondary" data-action="sizezone:' + id + ':hplus">по-високо +</button></div></div>' +
      '<button class="btn danger mt" data-action="delzone:' + id + '">🗑️ Изтрий зоната</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Готово</button>', true);
  }

  function moveZone(id, dir) {
    var z = zoneById(id); if (!z) return;
    var maxR = 1 + orchardRowCount(); // последна линия с редове
    if (dir === 'up') z.r = Math.max(2, z.r - 1);
    else if (dir === 'down') z.r = Math.min(maxR, z.r + 1);
    else if (dir === 'left') z.c = Math.max(2, z.c - 1);
    else if (dir === 'right') z.c = Math.min(24, z.c + 1);
    save(); updateMap(); sheetEditZone(id);
  }

  function sizeZone(id, how) {
    var z = zoneById(id); if (!z) return;
    if (how === 'wplus') z.cs = Math.min(22, z.cs + 1);
    else if (how === 'wminus') z.cs = Math.max(1, z.cs - 1);
    else if (how === 'hplus') z.rs = Math.min(orchardRowCount(), z.rs + 1);
    else if (how === 'hminus') z.rs = Math.max(1, z.rs - 1);
    save(); updateMap(); sheetEditZone(id);
  }

  function renameZone(id) {
    var z = zoneById(id); if (!z) return;
    var v = el('znName') ? el('znName').value.trim() : '';
    if (v) { z.label = v; save(); updateMap(); }
    sheetEditZone(id);
  }

  function addZone() {
    if (!isAdmin()) return;
    db.settings.zones = db.settings.zones || [];
    db.settings.zones.push({ id: DB.uid('z'), kind: 'garden', emoji: '📍', label: 'Нова зона', r: 2, rs: 2, c: 8, cs: 4 });
    save(); render();
  }

  function deleteZone(id) {
    if (!isAdmin()) return;
    var z = zoneById(id); if (!z) return;
    if (!confirm('Да изтрия ли зоната „' + z.label + '“?')) return;
    db.settings.zones = db.settings.zones.filter(function (x) { return x.id !== id; });
    save(); closeSheet(); render();
  }

  // ---- Прозрачни площи (admin) ------------------------------------------
  function areaById(id) { return (db.settings.areas || []).find(function (a) { return a.id === id; }); }

  function sheetEditArea(id) {
    if (!isAdmin()) return;
    var a = areaById(id); if (!a) return;
    var op = (a.opacity == null ? 15 : a.opacity);
    openSheet('<h3>🟫 ' + esc(a.label || 'Площ') + '</h3>' +
      '<div class="field"><label>Име (по желание)</label><div class="row"><input id="arName" class="input" value="' + esc(a.label || '') + '" placeholder="напр. Педрота" />' +
      '<button class="btn sm" data-action="renamearea:' + id + '">Запази</button></div></div>' +
      '<div class="field"><label>Цвят</label><div class="row">' +
      '<input id="arColor" type="color" value="' + esc(a.color || '#8a5a2b') + '" data-area="' + id + '" style="width:54px;height:40px;padding:2px;border-radius:8px" />' +
      '<span class="muted" style="font-size:13px">Избери какъвто цвят искаш</span></div></div>' +
      '<div class="field"><label>Прозрачност: <b id="arOpVal">' + op + '%</b></label>' +
      '<input id="arOpacity" type="range" min="4" max="60" step="1" value="' + op + '" data-area="' + id + '" style="width:100%" />' +
      '<p class="muted" style="font-size:12px;margin:4px 0 0">По-ниско = по-прозрачно (едва се вижда), по-високо = по-наситено.</p></div>' +
      '<div class="field"><label>Премести</label><div class="move-pad">' +
      '<span class="sp"></span><button data-action="movearea:' + id + ':up">↑</button><span class="sp"></span>' +
      '<button data-action="movearea:' + id + ':left">←</button><span class="sp"></span><button data-action="movearea:' + id + ':right">→</button>' +
      '<span class="sp"></span><button data-action="movearea:' + id + ':down">↓</button><span class="sp"></span>' +
      '</div></div>' +
      '<div class="field"><label>Ширина</label><div class="row">' +
      '<button class="btn secondary" data-action="sizearea:' + id + ':wminus">− по-тясно</button>' +
      '<button class="btn secondary" data-action="sizearea:' + id + ':wplus">по-широко +</button></div></div>' +
      '<div class="field"><label>Височина</label><div class="row">' +
      '<button class="btn secondary" data-action="sizearea:' + id + ':hminus">− по-ниско</button>' +
      '<button class="btn secondary" data-action="sizearea:' + id + ':hplus">по-високо +</button></div></div>' +
      '<button class="btn danger mt" data-action="delarea:' + id + '">🗑️ Изтрий площта</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Готово</button>', true);
  }

  function moveArea(id, dir) {
    var a = areaById(id); if (!a) return;
    var maxR = 1 + orchardRowCount();
    if (dir === 'up') a.r = Math.max(2, a.r - 1);
    else if (dir === 'down') a.r = Math.min(maxR, a.r + 1);
    else if (dir === 'left') a.c = Math.max(2, a.c - 1);
    else if (dir === 'right') a.c = Math.min(40, a.c + 1);
    save(); updateMap(); sheetEditArea(id);
  }

  function sizeArea(id, how) {
    var a = areaById(id); if (!a) return;
    if (how === 'wplus') a.cs = Math.min(40, a.cs + 1);
    else if (how === 'wminus') a.cs = Math.max(1, a.cs - 1);
    else if (how === 'hplus') a.rs = Math.min(orchardRowCount(), a.rs + 1);
    else if (how === 'hminus') a.rs = Math.max(1, a.rs - 1);
    save(); updateMap(); sheetEditArea(id);
  }

  function renameArea(id) {
    var a = areaById(id); if (!a) return;
    a.label = el('arName') ? el('arName').value.trim() : '';
    save(); updateMap(); sheetEditArea(id);
  }

  function setAreaColor(id, color) {
    var a = areaById(id); if (!a || !color) return;
    a.color = color;
    save(); updateMap();
  }

  function setAreaOpacity(id, val) {
    var a = areaById(id); if (!a) return;
    var v = parseInt(val, 10); if (!isFinite(v)) return;
    a.opacity = Math.max(4, Math.min(60, v));
    if (el('arOpVal')) el('arOpVal').textContent = a.opacity + '%';
    save(); updateMap();
  }

  function addArea() {
    if (!isAdmin()) return;
    db.settings.areas = db.settings.areas || [];
    var na = { id: DB.uid('area'), label: '', color: '#8a5a2b', opacity: 15, r: 2, rs: 2, c: 8, cs: 4 };
    db.settings.areas.push(na);
    save(); render(); sheetEditArea(na.id);
  }

  function deleteArea(id) {
    if (!isAdmin()) return;
    var a = areaById(id); if (!a) return;
    if (!confirm('Да изтрия ли тази площ' + (a.label ? ' „' + a.label + '“' : '') + '?')) return;
    db.settings.areas = db.settings.areas.filter(function (x) { return x.id !== id; });
    save(); closeSheet(); render();
  }

  // ---- Плаващ панел (ориентири и дървета) — може да се мести, лесно се затваря ----
  // монтира/обновява плаващия панел; позицията се пази извън innerHTML, за да не трепка при обновяване
  function mountFloatPanel(innerHTML) {
    var ed = el('lmEditor');
    if (!ed) {
      ed = document.createElement('div');
      ed.id = 'lmEditor';
      ed.className = 'lm-editor';
      document.body.appendChild(ed);
      enableFloatDrag(ed);
    }
    ed.innerHTML = innerHTML;
    if (floatPanelPos) { ed.style.left = floatPanelPos.left + 'px'; ed.style.top = floatPanelPos.top + 'px'; ed.style.bottom = 'auto'; ed.style.transform = 'none'; }
    return ed;
  }

  // влачене на панела за дръжката в заглавието (но не върху бутони/полета)
  function enableFloatDrag(ed) {
    var dragging = false, sx = 0, sy = 0, startLeft = 0, startTop = 0;
    ed.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('.lm-ed-head')) return;
      if (e.target.closest('button, input, label, select')) return;
      var r = ed.getBoundingClientRect();
      startLeft = r.left; startTop = r.top;
      ed.style.left = startLeft + 'px'; ed.style.top = startTop + 'px'; ed.style.bottom = 'auto'; ed.style.transform = 'none';
      sx = e.clientX; sy = e.clientY; dragging = true;
      ed.classList.add('dragging');
      try { ed.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    ed.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var w = ed.offsetWidth, h = ed.offsetHeight;
      var nl = Math.min(Math.max(4, startLeft + (e.clientX - sx)), window.innerWidth - w - 4);
      var nt = Math.min(Math.max(4, startTop + (e.clientY - sy)), window.innerHeight - h - 4);
      ed.style.left = nl + 'px'; ed.style.top = nt + 'px';
      floatPanelPos = { left: nl, top: nt };
    });
    function end(e) { if (dragging) { dragging = false; ed.classList.remove('dragging'); try { ed.releasePointerCapture(e.pointerId); } catch (_) {} } }
    ed.addEventListener('pointerup', end);
    ed.addEventListener('pointercancel', end);
  }

  function closeLmEditor() {
    var ed = el('lmEditor');
    if (ed) ed.remove();
    if (editingLmId || editingTreeId) { editingLmId = null; editingLmKind = null; editingTreeId = null; updateMap(); }
  }

  // ---- Landmarks (ориентири) — наместване през плаващия панел -------------
  function sheetEditLandmark(id) {
    if (!isAdmin()) return;
    var m = lmById(id); if (!m) return;
    editingLmId = id; editingLmKind = m.kind; editingTreeId = null;
    var name = LM_LABELS[m.kind] || 'Ориентир';
    var fine = lmStep === 'fine';
    mountFloatPanel(
      '<div class="lm-ed-head">' +
      '<span class="lm-grip">⠿</span>' +
      '<span class="lm-ed-title">' + (LM_ICONS[m.kind] ? '<span class="lm-ico">' + LM_ICONS[m.kind] + '</span>' : '') + esc(name) + '</span>' +
      '<label class="lm-ed-color"><input id="lmColor" type="color" value="' + lmColor(m.kind) + '"/></label>' +
      '<button class="lm-ed-btn" data-action="lmcolorreset:' + id + '" title="Стандартен цвят">🎨↺</button>' +
      '<button class="lm-ed-close" data-action="closelmeditor" aria-label="Затвори">✕</button>' +
      '</div>' +
      '<div class="lm-pad">' +
      '<span></span><button data-action="lmnudge:' + id + ':up">↑</button><span></span>' +
      '<button data-action="lmnudge:' + id + ':left">←</button>' +
      '<button class="lm-step" data-action="lmstep">' + (fine ? '••<br><small>дребно</small>' : '•<br><small>едро</small>') + '</button>' +
      '<button data-action="lmnudge:' + id + ':right">→</button>' +
      '<span></span><button data-action="lmnudge:' + id + ':down">↓</button><span></span>' +
      '</div>' +
      '<button class="lm-ed-reset" data-action="lmreset:' + id + '">↺ Върни стандартното място</button>');
    updateMap();
    scrollEditingEl('.lm.lm-editing');
  }

  // скролва нагласяния елемент в горната видима част, за да не го крие панелът
  function scrollEditingEl(sel) {
    try {
      requestAnimationFrame(function () {
        var elx = document.querySelector(sel);
        if (!elx) return;
        var r = elx.getBoundingClientRect();
        var target = window.innerHeight * 0.28;
        var dy = r.top - target;
        if (Math.abs(dy) > 12) window.scrollBy({ top: dy, left: 0, behavior: 'smooth' });
      });
    } catch (e) {}
  }

  function nudgeLandmark(id, dir) {
    var m = lmById(id); if (!m) return;
    var step = lmStep === 'fine' ? 2 : 12;
    if (dir === 'up') m.dy = (m.dy || 0) - step;
    else if (dir === 'down') m.dy = (m.dy || 0) + step;
    else if (dir === 'left') m.dx = (m.dx || 0) - step;
    else if (dir === 'right') m.dx = (m.dx || 0) + step;
    save(); updateMap(); scrollEditingEl('.lm.lm-editing');
  }

  function toggleLmStep() {
    lmStep = lmStep === 'fine' ? 'coarse' : 'fine';
    if (editingLmId) sheetEditLandmark(editingLmId);
  }

  function resetLandmark(id) {
    var m = lmById(id); if (!m) return;
    var def = (DB.defaultLandmarks() || []).find(function (d) { return d.id === id; });
    if (def) { m.gr = def.gr; m.gc = def.gc; m.dx = def.dx; m.dy = def.dy; m.anchor = def.anchor; save(); updateMap(); scrollEditingEl('.lm.lm-editing'); }
  }
  function resetLandmarkColor(id) {
    var m = lmById(id); if (!m || !isAdmin()) return;
    if (db.settings.landmarkColors) { delete db.settings.landmarkColors[m.kind]; save(); updateMap(); }
    var inp = el('lmColor'); if (inp) inp.value = LM_DEFAULT_COLORS[m.kind] || '#cfe8d6';
  }

  // ---- Дървета — местене през същия плаващ панел -------------------------
  function floatEditTree(id) {
    if (!isAdmin()) return;
    var t = tree(id); if (!t) return;
    editingTreeId = id; editingLmId = null; editingLmKind = null;
    mountFloatPanel(
      '<div class="lm-ed-head">' +
      '<span class="lm-grip">⠿</span>' +
      '<span class="lm-ed-title">🌳 ' + esc(t.code) + '</span>' +
      '<button class="lm-ed-close" data-action="closelmeditor" aria-label="Затвори">✕</button>' +
      '</div>' +
      '<div class="lm-pad">' +
      '<span></span><button data-action="treemove:' + id + ':up">↑</button><span></span>' +
      '<button data-action="treemove:' + id + ':left">←</button>' +
      '<button class="lm-step" data-action="edittreefull:' + id + '">✏️<br><small>детайли</small></button>' +
      '<button data-action="treemove:' + id + ':right">→</button>' +
      '<span></span><button data-action="treemove:' + id + ':down">↓</button><span></span>' +
      '</div>');
    updateMap();
    scrollEditingEl('.tree-cell.tree-editing');
  }

  function nudgeTree(id, dir) {
    var t = tree(id); if (!t) return;
    var order = DB.ROW_LETTERS, ri = order.indexOf(t.row);
    var nr = t.row, nc = t.col;
    if (dir === 'left') nc = Math.max(1, t.col - 1);
    else if (dir === 'right') nc = Math.min(9, t.col + 1);
    else if (dir === 'up') nr = order[Math.max(0, ri - 1)] || t.row;
    else if (dir === 'down') nr = order[ri + 1] || t.row;
    if ((nr !== t.row || nc !== t.col) && !occupied(nr, nc, id)) { t.row = nr; t.col = nc; save(); }
    updateMap(); scrollEditingEl('.tree-cell.tree-editing');
  }

  // ---- User management (owner) ------------------------------------------
  function sheetPromote(userId) {
    if (!isOwner()) return;
    var u = db.users.find(function (x) { return x.id === userId; });
    openSheet('<h3>Направи „' + esc(u.name) + '“ администратор</h3>' +
      '<p class="muted mb">Задай парола за този администратор (запомни я и му я кажи).</p>' +
      '<div class="field"><label>Нова парола</label><input id="pmPass" class="input" type="text" placeholder="напр. 4 цифри"/></div>' +
      '<button class="btn" data-action="dopromote:' + userId + '">✅ Направи админ</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  function doPromote(userId) {
    if (!isOwner()) return;
    var u = db.users.find(function (x) { return x.id === userId; });
    var pass = (el('pmPass').value || '').trim();
    if (!pass) { el('pmPass').focus(); return; }
    u.role = 'admin'; u.pass = DB.hashPw(pass); save(); closeSheet(); render();
  }
  function doDemote(userId) {
    if (!isOwner()) return;
    var u = db.users.find(function (x) { return x.id === userId; });
    if (u.isOwner || u.id === db.ownerId) { alert('Главният стопанин не може да се сваля.'); return; }
    if (!confirm('Свали „' + u.name + '“ до работник?')) return;
    u.role = 'worker'; delete u.pass; save(); render();
  }
  function sheetSetPass(userId) {
    var u = db.users.find(function (x) { return x.id === userId; });
    openSheet('<h3>Парола · ' + esc(u.name) + '</h3>' +
      '<div class="field"><label>Нова парола</label><input id="spPass" class="input" type="text" placeholder="нова парола"/></div>' +
      '<button class="btn" data-action="dosetpass:' + userId + '">💾 Запази паролата</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  function doSetPass(userId) {
    var u = db.users.find(function (x) { return x.id === userId; });
    if (!(isOwner() || userId === db.currentUserId)) return;
    var pass = (el('spPass').value || '').trim();
    if (!pass) { el('spPass').focus(); return; }
    u.pass = DB.hashPw(pass); save(); closeSheet(); alert('Паролата е запазена.');
  }
  function doDelUser(userId) {
    if (!isOwner()) return;
    var u = db.users.find(function (x) { return x.id === userId; });
    if (u.isOwner || u.id === db.ownerId) { alert('Главният стопанин не може да се трие.'); return; }
    if (!confirm('Премахни „' + u.name + '“?')) return;
    u.deletedAt = Date.now(); save(); render();
  }

  function setHealth(id, h) { var t = tree(id); if (t) { t.health = h; } sheetTreeEdit(id); }
  // Отказ от редакцията — връща здравето/сорта/бележката както бяха (setHealth ги променя на живо).
  function cancelTreeEdit() {
    if (!treeEditBefore) return;
    var t = tree(treeEditBefore.id);
    if (t) { t.health = treeEditBefore.health; t.varietyId = treeEditBefore.varietyId; t.note = treeEditBefore.note; save(); }
    treeEditBefore = null;
  }
  function saveTreeEdit(id) {
    var t = tree(id); if (!t) return;
    var before = (treeEditBefore && treeEditBefore.id === id) ? treeEditBefore : { health: t.health, varietyId: t.varietyId, note: t.note, height: t.height, plantedAt: t.plantedAt };
    // формата „Състояние“ (sheetTreeEdit): etVar/etNote; редакторът на схемата (sheetEditTree): etCode/etVar2/etHealth2
    var varEl = el('etVar'), noteEl = el('etNote'), codeEl = el('etCode'), var2El = el('etVar2'), health2El = el('etHealth2'), heightEl = el('etHeight'), dateEl = el('etDate');
    if (varEl) t.varietyId = varEl.value;
    if (noteEl) t.note = noteEl.value;
    if (heightEl) t.height = heightEl.value === '' ? null : parseFloat(heightEl.value);
    if (dateEl) t.plantedAt = dateEl.value || null;
    if (var2El) t.varietyId = var2El.value;
    if (health2El) t.health = health2El.value;
    if (codeEl) t.code = (codeEl.value || t.code).trim();
    var changes = {};
    if (before.health !== t.health) changes.health = { before: before.health, after: t.health };
    if (before.varietyId !== t.varietyId) changes.varietyId = { before: before.varietyId, after: t.varietyId };
    if ((before.note || '') !== (t.note || '')) changes.note = { before: before.note || '', after: t.note || '' };
    if ((before.height == null ? '' : before.height) !== (t.height == null ? '' : t.height)) changes.height = { before: before.height == null ? '' : before.height, after: t.height == null ? '' : t.height };
    if ((before.plantedAt || '') !== (t.plantedAt || '')) changes.plantedAt = { before: before.plantedAt || '', after: t.plantedAt || '' };
    save();
    var ev = { type: 'tree_edit', treeId: id, date: DB.todayISO(), note: 'състояние: ' + healthLabel(t.health) };
    if (Object.keys(changes).length) ev.changes = changes;
    addEvent(ev);
    treeEditBefore = null;
    closeSheet(); go('tree', id);
  }

  function addPhoto(id) {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
    input.onchange = function () {
      var f = input.files[0]; if (!f) return;
      resizeImage(f, 1280, 0.72, function (dataUrl) {
        var date = DB.todayISO();
        if (!db.photos) db.photos = [];
        var pid = DB.uid('ph');
        db.photos.push({ id: pid, treeId: id, data: dataUrl, date: date, createdBy: db.currentUserId });
        addEvent({ type: 'photo', treeId: id, photoId: pid, date: date, note: 'добавена снимка' });
        go('tree', id);
      });
    };
    input.click();
  }

  // Профилна снимка на текущия потребител (малка, показва се в дневника)
  function setProfilePhoto() {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = function () {
      var f = input.files[0]; if (!f) return;
      resizeImage(f, 640, 0.85, function (dataUrl) {
        pendingPhotoSrc = dataUrl;
        openPhotoAdjust();
      });
    };
    input.click();
  }
  // екран за наместване на снимката (зуум + местене наляво/надясно/горе/долу)
  function openPhotoAdjust() {
    if (!pendingPhotoSrc) return;
    ppImgW = 0; ppImgH = 0;
    openSheet('<h3>📷 Нагласи снимката</h3>' +
      '<p class="muted mb" style="font-size:13px">Нагласи с плъзгачите, за да центрираш лицето в кръга.</p>' +
      '<div id="ppPrev" class="pp-prev"><img id="ppImg" src="' + pendingPhotoSrc + '" alt=""/></div>' +
      '<div class="field"><label>🔍 Увеличение</label><input id="ppZoom" class="input" type="range" min="100" max="300" value="100"/></div>' +
      '<div class="field"><label>↔️ Наляво / надясно</label><input id="ppX" class="input" type="range" min="0" max="100" value="50"/></div>' +
      '<div class="field"><label>↕️ Нагоре / надолу</label><input id="ppY" class="input" type="range" min="0" max="100" value="50"/></div>' +
      '<button class="btn" data-action="savephotoadj">💾 Запази</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
    var probe = new Image();
    probe.onload = function () { ppImgW = probe.width; ppImgH = probe.height; updatePhotoPreview(); };
    probe.src = pendingPhotoSrc;
  }
  // жив преглед: позиционира снимката според плъзгачите (моделът е същият като в cropSquare)
  function updatePhotoPreview() {
    var im = el('ppImg'); if (!im || !ppImgW || !ppImgH) return;
    var zEl = el('ppZoom'), xEl = el('ppX'), yEl = el('ppY');
    var z = zEl ? (parseInt(zEl.value, 10) || 100) / 100 : 1; if (z < 1) z = 1;
    var ox = xEl ? (parseInt(xEl.value, 10) || 0) / 100 : 0.5;
    var oy = yEl ? (parseInt(yEl.value, 10) || 0) / 100 : 0.5;
    var base = Math.min(ppImgW, ppImgH);
    var crop = base / z; // колко изходни пиксела се виждат = 100% от кръга
    im.style.width = (ppImgW / crop * 100) + '%';
    im.style.height = (ppImgH / crop * 100) + '%';
    im.style.left = (-(ppImgW / crop - 1) * ox * 100) + '%';
    im.style.top = (-(ppImgH / crop - 1) * oy * 100) + '%';
  }
  function saveProfilePhotoAdjust() {
    if (!pendingPhotoSrc) { closeSheet(); return; }
    var zEl = el('ppZoom'), xEl = el('ppX'), yEl = el('ppY');
    var zoom = zEl ? (parseInt(zEl.value, 10) || 100) / 100 : 1; if (zoom < 1) zoom = 1;
    var offsetX = xEl ? (parseInt(xEl.value, 10) || 0) / 100 : 0.5;
    var offsetY = yEl ? (parseInt(yEl.value, 10) || 0) / 100 : 0.5;
    cropSquare(pendingPhotoSrc, zoom, offsetX, offsetY, 256, 0.82, function (dataUrl) {
      var u = me(); if (!u) { closeSheet(); return; }
      u.photo = dataUrl; pendingPhotoSrc = null; save(); closeSheet(); render();
    });
  }
  function delProfilePhoto() {
    var u = me(); if (!u) return;
    u.photo = null; save(); render();
  }

  // изрязва квадрат от снимката: zoom (>=1), offsetX/offsetY 0..1 → квадратна снимка
  function cropSquare(src, zoom, offsetX, offsetY, out, q, cb) {
    var img = new Image();
    img.onload = function () {
      var w = img.width, h = img.height;
      var base = Math.min(w, h);
      var crop = base / (zoom > 1 ? zoom : 1);
      var sx = (w - crop) * offsetX;
      var sy = (h - crop) * offsetY;
      try {
        var c = document.createElement('canvas'); c.width = out; c.height = out;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#e9eee9'; ctx.fillRect(0, 0, out, out);
        ctx.drawImage(img, sx, sy, crop, crop, 0, 0, out, out);
        cb(c.toDataURL('image/jpeg', q));
      } catch (e) { cb(src); }
    };
    img.onerror = function () { cb(src); };
    img.src = src;
  }

  // Смалява снимката (макс. страна maxPx, JPEG качество q) → по-малък файл,
  // за да стои всяка снимка под лимита за облачен документ.
  function resizeImage(file, maxPx, q, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        var scale = Math.min(1, maxPx / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        try {
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
          cb(canvas.toDataURL('image/jpeg', q));
        } catch (e) {
          cb(reader.result); // при грешка — оригинала
        }
      };
      img.onerror = function () { cb(reader.result); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // Отваря снимка на цял екран със зуум с два пръста (жест), двойно докосване и влачене.
  function isLightboxOpen() { var lb = document.getElementById('lightbox'); return !!(lb && lb.classList.contains('open')); }
  function closeLightbox() { var lb = document.getElementById('lightbox'); if (lb) { lb.classList.remove('open'); lb.innerHTML = ''; } }
  function openLightbox(src) {
    var lb = document.getElementById('lightbox');
    if (!lb) { lb = document.createElement('div'); lb.id = 'lightbox'; document.body.appendChild(lb); }    lb.innerHTML = '<button class="lb-close" aria-label="Затвори">✕</button>' +
      '<div class="lb-hint">Разпери два пръста, за да уголемиш · двойно докосване · ✕ за затваряне</div>' +
      '<img class="lb-img" src="' + src + '" alt=""/>';
    lb.classList.add('open');
    var img = lb.querySelector('.lb-img');
    var scale = 1, tx = 0, ty = 0, startDist = 0, startScale = 1;
    var panning = false, lastX = 0, lastY = 0, startTx = 0, startTy = 0, lastTap = 0;
    function apply() { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }
    function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
    function close() { lb.classList.remove('open'); lb.innerHTML = ''; }
    lb.querySelector('.lb-close').addEventListener('click', close);
    lb.addEventListener('click', function (e) { if (e.target === lb && scale <= 1.02) close(); });
    img.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) { startDist = dist(e.touches); startScale = scale; e.preventDefault(); }
      else if (e.touches.length === 1) {
        var now = Date.now();
        if (now - lastTap < 300) { scale = scale > 1 ? 1 : 2.5; tx = 0; ty = 0; apply(); e.preventDefault(); }
        lastTap = now;
        if (scale > 1) { panning = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; startTx = tx; startTy = ty; }
      }
    }, { passive: false });
    img.addEventListener('touchmove', function (e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        var d = dist(e.touches);
        scale = Math.min(5, Math.max(1, startScale * d / (startDist || 1)));
        if (scale <= 1) { tx = 0; ty = 0; }
        apply();
      } else if (panning && e.touches.length === 1) {
        e.preventDefault();
        tx = startTx + (e.touches[0].clientX - lastX);
        ty = startTy + (e.touches[0].clientY - lastY);
        apply();
      }
    }, { passive: false });
    img.addEventListener('touchend', function (e) { if (e.touches.length === 0) { panning = false; if (scale < 1.05) { scale = 1; tx = 0; ty = 0; apply(); } } });
    // десктоп: двоен клик и колелце за тест
    img.addEventListener('dblclick', function () { scale = scale > 1 ? 1 : 2.5; tx = 0; ty = 0; apply(); });
    img.addEventListener('wheel', function (e) { e.preventDefault(); scale = Math.min(5, Math.max(1, scale - e.deltaY * 0.002)); if (scale <= 1) { tx = 0; ty = 0; } apply(); }, { passive: false });
  }

  function stepHarvest(key, delta) {
    harvestDraft[key] = harvestDraft[key] || { _count: 0 };
    harvestDraft[key]._count = Math.max(0, (harvestDraft[key]._count || 0) + delta);
    var inp = el('cnt_' + key);
    if (inp) { if ('value' in inp) inp.value = harvestDraft[key]._count; else inp.textContent = harvestDraft[key]._count; }
  }

  // плавно скролиране до елемент след пре-рендиране
  function scrollToEl(id) {
    requestAnimationFrame(function () {
      var e = el(id);
      if (e && e.scrollIntoView) e.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function saveHarvest() {
    var bucketId = (harvestBucket && bucket(harvestBucket)) ? harvestBucket : db.settings.buckets[0].id;
    var date = el('hdate') ? el('hdate').value : DB.todayISO();
    var saved = 0;
    Object.keys(harvestDraft).forEach(function (key) {
      var cnt = harvestDraft[key]._count || 0;
      if (cnt <= 0) return;
      var buckets = {}; buckets[bucketId] = cnt;
      if (key === 'ground') {
        addEvent({ type: 'harvest_ground', date: date, state: harvestState, buckets: buckets, fill: harvestFill });
      } else {
        addEvent({ type: 'harvest_tree', treeId: key, date: date, state: harvestState, buckets: buckets, fill: harvestFill });
      }
      saved++;
    });
    harvestDraft = {};
    if (saved) { alert('Записано! ' + saved + ' вписвания.'); go('home'); }
    else alert('Добави поне 1 кофа.');
  }

  // компактен лист за бързо събиране от земята (от екрана Градина)
  function showGroundHarvest() {
    if (!groundBucket || !bucket(groundBucket)) groundBucket = db.settings.buckets[0].id;
    var curCount = (el('gCount') && el('gCount').value) || '1';
    var curDate = (el('gDate') && el('gDate').value) || DB.todayISO();
    var pics = db.settings.buckets.map(function (b) {
      return '<button class="bpick' + (b.id === groundBucket ? ' active' : '') + '" data-action="gbuck:' + b.id + '">' +
        '<span class="bpic">' + bucketIcon(b) + '</span>' +
        '<b>' + esc(b.name) + '</b><small>1 кофа ≈ ' + fmtKg(stateKg(b, 'green')) + ' кг</small></button>';
    }).join('');
    var fb = bucket(groundBucket);
    var oneKg = fb ? stateKg(fb, 'green') * groundFill / 100 : 0;
    openSheet('<h3>🍂 Събиране от земята</h3>' +
      '<p class="muted mb" style="font-size:13px">Бързо впиши колко кофи зелени орехи събра от земята.</p>' +
      '<div class="field"><label>Коя кофа?</label><div class="bucketpick">' + pics + '</div></div>' +
      '<div class="field"><label>Дата</label><input id="gDate" class="input" type="date" value="' + curDate + '"/></div>' +
      '<div class="field"><label>Колко кофи?</label><input id="gCount" class="input" type="number" step="0.25" min="0" inputmode="decimal" value="' + curCount + '"/></div>' +
      '<div class="field"><label>Колко пълни бяха кофите?</label>' +
      '<div class="rowfilter">' +
      [100, 75, 50, 25, 10, 5].map(function (p) {
        return '<button class="' + (groundFill === p ? 'active' : '') + '" data-action="gfill:' + p + '">' + (p === 100 ? 'Пълна' : p + '%') + '</button>';
      }).join('') + '</div>' +
      '<div class="fillstep">' +
      '<button class="fillstep-btn" data-action="gfillstep:-5"><span>−</span><small>5%</small></button>' +
      '<span class="fillstep-val">' + groundFill + '%</span>' +
      '<button class="fillstep-btn" data-action="gfillstep:5"><span>+</span><small>5%</small></button>' +
      '</div>' +
      (fb ? '<small class="muted fillhint">1 ' + esc(fb.name) + (groundFill !== 100 ? ' на ' + groundFill + '%' : '') + ' ≈ <b>' + fmtKg(oneKg) + ' кг</b></small>' : '') +
      '</div>' +
      '<button class="btn mt" data-action="savegroundquick">💾 Запази</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  function saveGroundQuick() {
    var bid = (groundBucket && bucket(groundBucket)) ? groundBucket : db.settings.buckets[0].id;
    var cnt = parseFloat(el('gCount').value);
    var fill = groundFill;
    var date = (el('gDate') && el('gDate').value) || DB.todayISO();
    if (!(cnt > 0)) { alert('Въведи поне 1 кофа.'); return; }
    var buckets = {}; buckets[bid] = cnt;
    addEvent({ type: 'harvest_ground', date: date, state: 'green', buckets: buckets, fill: fill });
    closeSheet(); render();
  }

  // ---- Редакция на съществуващ запис (само админ): смяна на дата и стойности ----
  function editEvent(evId) {
    if (!isAdmin()) return;
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e || e.deletedAt || !EDITABLE_TYPES[e.type]) return;
    function num(n) { return (n == null || n === '') ? '' : fmtKg(n); }
    var m = LOG_TYPES[e.type] || { ic: '•', t: e.type };
    var tt = e.treeId ? tree(e.treeId) : null;
    var body = '<h3>✏️ Редакция · ' + m.ic + ' ' + esc(m.t) + (tt ? ' · ' + esc(tt.code) : '') + '</h3>' +
      '<div class="field"><label>Дата</label><input id="edDate" class="input" type="date" value="' + (e.date || DB.todayISO()) + '"/></div>';

    if (e.type === 'harvest_tree' || e.type === 'harvest_ground') {
      var bk = e.buckets || {};
      var keys = Object.keys(bk);
      if (keys.length <= 1) {
        var curBid = keys[0] || db.settings.buckets[0].id;
        var curCnt = keys[0] != null ? bk[keys[0]] : 1;
        var opts = db.settings.buckets.map(function (b) {
          return '<option value="' + b.id + '"' + (b.id === curBid ? ' selected' : '') + '>' + esc(b.name) + '</option>';
        }).join('');
        body += '<div class="field"><label>Кофа</label><select id="edBucket" class="input">' + opts + '</select></div>' +
          '<div class="field"><label>Колко кофи</label><input id="edCount" class="input" type="number" step="0.25" min="0" inputmode="decimal" value="' + num(curCnt) + '"/></div>';
      } else {
        body += '<div class="field"><label>Кофи</label>' + keys.map(function (bid) {
          var b = bucket(bid);
          return '<div class="row" style="align-items:center;gap:8px;margin-bottom:6px"><span style="min-width:90px">' + esc(b ? b.name : bid) + '</span>' +
            '<input id="edc_' + bid + '" class="input" type="number" step="0.25" min="0" inputmode="decimal" value="' + num(bk[bid]) + '"/></div>';
        }).join('') + '</div>';
      }
      body += '<div class="field"><label>Колко пълни (%)</label><input id="edFill" class="input" type="number" step="5" min="0" max="100" inputmode="numeric" value="' + (e.fill != null ? e.fill : 100) + '"/></div>';
      var stOpts = ['green', 'shelled', 'clean'].map(function (s) {
        return '<option value="' + s + '"' + ((e.state || 'green') === s ? ' selected' : '') + '>' + stateLabel(s) + '</option>';
      }).join('');
      body += '<div class="field"><label>Вид</label><select id="edState" class="input">' + stOpts + '</select></div>';
    } else if (e.type === 'clean') {
      body += '<div class="field"><label>Чиста ядка (кг)</label><input id="edKg" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + num(e.kg) + '"/></div>';
    } else if (e.type === 'shell') {
      body += '<div class="field"><label>Обелени кофи (за сирене)</label><input id="edBuckets" class="input" type="number" step="0.25" min="0" inputmode="decimal" value="' + num(e.buckets) + '"/></div>';
    } else if (e.type === 'sort') {
      body += '<div class="row">' +
        '<div class="field"><label>⚪ Бели (кг)</label><input id="edWhite" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + num(e.whiteKg) + '"/></div>' +
        '<div class="field"><label>⚫ Черни (кг)</label><input id="edBlack" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + num(e.blackKg) + '"/></div></div>';
    } else if (e.type === 'fertilize') {
      body += '<div class="field"><label>С какво</label><input id="edWhat" class="input" type="text" value="' + esc(e.what || '') + '"/></div>' +
        '<div class="row"><div class="field"><label>Количество</label><input id="edQty" class="input" type="number" step="0.1" min="0" inputmode="decimal" value="' + num(e.qty) + '"/></div>' +
        '<div class="field"><label>Мярка</label><input id="edUnit" class="input" type="text" value="' + esc(e.unit || '') + '"/></div></div>';
    } else if (e.type === 'water') {
      body += '<div class="field"><label>Литри</label><input id="edQty" class="input" type="number" step="1" min="0" inputmode="decimal" value="' + num(e.qty) + '"/></div>';
    } else if (e.type === 'note') {
      body += '<div class="field"><label>Бележка</label><input id="edNote" class="input" type="text" value="' + esc(e.note || '') + '"/></div>';
    }
    body += '<button class="btn mt" data-action="saveedit:' + e.id + '">💾 Запази промените</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>';
    openSheet(body);
  }

  function saveEditEvent(evId) {
    if (!isAdmin()) return;
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e || e.deletedAt || !EDITABLE_TYPES[e.type]) return;
    var date = (el('edDate') && el('edDate').value) || e.date;

    if (e.type === 'harvest_tree' || e.type === 'harvest_ground') {
      var keys = Object.keys(e.buckets || {});
      var buckets = {};
      if (keys.length <= 1) {
        var bidEl = el('edBucket');
        var bid = (bidEl && bidEl.value) || keys[0] || db.settings.buckets[0].id;
        var cnt = parseFloat(el('edCount').value);
        if (!(cnt > 0)) { alert('Въведи поне 0.25 кофа.'); return; }
        buckets[bid] = cnt;
      } else {
        var any = false;
        keys.forEach(function (bid) {
          var inp = el('edc_' + bid);
          var v = inp ? parseFloat(inp.value) : 0;
          if (v > 0) { buckets[bid] = v; any = true; }
        });
        if (!any) { alert('Въведи поне една кофа.'); return; }
      }
      var fill = parseInt(el('edFill').value, 10);
      if (!(fill >= 0)) fill = 100; if (fill > 100) fill = 100;
      var stEl = el('edState');
      e.buckets = buckets;
      e.fill = fill;
      if (stEl) e.state = stEl.value;
    } else if (e.type === 'clean') {
      var kg = parseFloat(el('edKg').value);
      if (!(kg > 0)) { alert('Въведи тегло по-голямо от 0.'); return; }
      e.kg = kg;
    } else if (e.type === 'shell') {
      var bkv = parseFloat(el('edBuckets').value);
      if (!(bkv > 0)) { alert('Въведи кофи по-голямо от 0.'); return; }
      e.buckets = bkv;
    } else if (e.type === 'sort') {
      var w = parseFloat(el('edWhite').value); if (!(w >= 0)) w = 0;
      var k = parseFloat(el('edBlack').value); if (!(k >= 0)) k = 0;
      if (w + k <= 0) { alert('Въведи поне едно число по-голямо от 0.'); return; }
      e.whiteKg = w; e.blackKg = k;
    } else if (e.type === 'fertilize') {
      e.what = (el('edWhat') && el('edWhat').value || '').trim();
      var fq = parseFloat(el('edQty').value); e.qty = (fq >= 0) ? fq : null;
      e.unit = (el('edUnit') && el('edUnit').value || '').trim();
    } else if (e.type === 'water') {
      var wq = parseFloat(el('edQty').value); e.qty = (wq >= 0) ? wq : 0;
    } else if (e.type === 'note') {
      e.note = (el('edNote') && el('edNote').value || '').trim();
    }

    e.date = date;
    e.editedAt = Date.now();
    e.editedBy = db.currentUserId;
    save();
    closeSheet(); render();
  }

  function saveTreeHarvestInline(id) {
    var t = tree(id); if (!t) return;
    var bid = (harvestBucket && bucket(harvestBucket)) ? harvestBucket : db.settings.buckets[0].id;
    var cnt = (harvestDraft[id] && harvestDraft[id]._count) || 0;
    var date = (el('thdate') && el('thdate').value) ? el('thdate').value : DB.todayISO();
    if (cnt <= 0) { alert('Добави поне 1 кофа.'); return; }
    var buckets = {}; buckets[bid] = cnt;
    addEvent({ type: 'harvest_tree', treeId: id, date: date, state: harvestState, buckets: buckets, fill: harvestFill });
    delete harvestDraft[id];
    treeHarvestOpen = '';
    go('home');
  }

  function saveGps(id) {
    var t = tree(id); if (!t) return;
    if (!navigator.geolocation) { alert('Телефонът не поддържа GPS.'); return; }
    alert('Застани до дървото и натисни OK. Изчакай координатите...');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var beforeGps = t.gps || null;
      t.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy || 0), ts: Date.now() };
      save();
      addEvent({ type: 'tree_edit', treeId: t.id, date: DB.todayISO(), note: 'записани GPS координати (±' + t.gps.acc + ' м)', changes: { gps: { before: beforeGps, after: t.gps } } });
      alert('Записано! Точност ±' + t.gps.acc + ' м.');
      render();
    }, function (err) {
      alert('Няма достъп до GPS: ' + (err && err.message ? err.message : 'разреши местоположение в браузъра.'));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function saveCare(type) {
    var date = el('cdate').value;
    var note = el('cnote') ? el('cnote').value : '';
    // определи обхвата: цялата градина / редици / едно дърво / избрани от картата
    var treeId = null, rows = null, trees = null;
    if (careScope === 'trees') {
      trees = careTrees.slice();
      if (!trees.length) { alert('Няма избрани дървета.'); return; }
    } else if (careScope === 'tree') {
      treeId = el('ctree') ? el('ctree').value : '';
      if (!treeId) { alert('Избери дърво.'); return; }
    } else if (careScope === 'rows') {
      if (!careRows.length) { alert('Избери поне една редица.'); return; }
      rows = careRows.slice();
    }

    // сглоби полетата според типа грижа
    function fill(base) {
      if (type === 'fertilize') {
        base.type = 'fertilize'; base.what = el('cwhat').value;
        base.qty = parseFloat(el('cqty').value) || 0; base.unit = el('cunit').value;
      } else if (type === 'water') {
        base.type = 'water'; base.qty = parseFloat(el('cqty').value) || 0; base.unit = 'л';
      } else { base.type = 'mow'; }
      return base;
    }

    if (trees) {
      // едно вписване за всяко избрано дърво, за да се води в неговата история
      trees.forEach(function (id) { addEvent(fill({ date: date, note: note, treeId: id })); });
      careTrees = [];
      alert('Записано за ' + trees.length + ' дървета!'); go('home'); return;
    }

    var base = { date: date, note: note };
    if (treeId) base.treeId = treeId;
    if (rows) base.rows = rows;
    addEvent(fill(base));
    alert('Записано!'); go('home');
  }

  function saveBuckets() {
    if (!isAdmin()) return;
    var vals = {}; // bid -> { green, shelled, clean, liters }
    var weightChanged = false;
    document.querySelectorAll('[data-bkg]').forEach(function (inp) {
      var p = inp.getAttribute('data-bkg').split(':');
      var field = p[0], bid = p[1];
      var b = bucket(bid); if (!b) return;
      var val = parseFloat(inp.value) || 0;
      vals[bid] = vals[bid] || {};
      vals[bid][field] = val;
      var cur = field === 'green' ? b.greenKg : field === 'shelled' ? b.shelledKg : field === 'clean' ? b.cleanKg : b.liters;
      // само теглата на съдържанието (зелени/с черупка/чиста ядка) засягат кг на записите
      if ((field === 'green' || field === 'shelled' || field === 'clean') && val !== (cur || 0)) weightChanged = true;
    });
    if (!weightChanged) { applyBucketVals(vals); save(); alert('Запазено!'); return; }
    // теглото се е сменило → питаме какво да правим със старите записи (кг се смятат по тегло на кофата)
    pendingBucketVals = vals;
    var n = db.events.filter(function (e) { return !e.deletedAt && (e.type === 'harvest_tree' || e.type === 'harvest_ground') && e.lockKg == null; }).length;
    openSheet('<h3>Ново тегло на кофите</h3>' +
      '<p class="muted" style="font-size:14px">Килограмите на записите се смятат по теглото на кофата. Какво да стане със старите записи (' + n + ')?</p>' +
      '<button class="btn" data-action="bucketsapply:all">🔄 Обнови всички записи с новото тегло</button>' +
      '<div class="muted center" style="margin:14px 0 6px;font-size:13px">— или —</div>' +
      '<div class="field"><label>Новото тегло да важи само от дата:</label><input id="bkFromDate" class="input" type="date" value="' + DB.todayISO() + '"/></div>' +
      '<button class="btn secondary" data-action="bucketsapply:from">📅 Запази старите, важи от датата</button>' +
      '<button class="btn ghost mt" data-action="bucketscancel">Отказ</button>');
  }
  function applyBucketVals(vals) {
    Object.keys(vals).forEach(function (bid) {
      var b = bucket(bid); if (!b) return;
      var v = vals[bid];
      if (v.green != null) b.greenKg = v.green;
      if (v.shelled != null) b.shelledKg = v.shelled;
      if (v.clean != null) b.cleanKg = v.clean;
      if (v.tare != null) b.tareKg = v.tare;
      if (v.liters != null) { b.liters = v.liters; b.capacityNote = '≈ ' + v.liters + ' л'; }
    });
  }
  // прилага новите тегла: mode 'all' = и за старите; dateFrom = замрази записите преди датата със старото тегло
  function applyBuckets(mode, dateFrom) {
    if (!pendingBucketVals) { closeSheet(); return; }
    if (mode === 'from' && dateFrom) {
      db.events.forEach(function (e) {
        if (e.deletedAt) return;
        if ((e.type === 'harvest_tree' || e.type === 'harvest_ground') && e.lockKg == null && e.date < dateFrom) {
          e.lockKg = eventKg(e); // замразяваме при текущите (старите) тегла
        }
      });
    }
    applyBucketVals(pendingBucketVals);
    pendingBucketVals = null;
    save(); closeSheet(); render(); alert('Запазено!');
  }
  function saveCalc() {
    if (!isAdmin()) return;
    db.settings.yieldInputKg = parseFloat(el('yin').value) || 0;
    db.settings.yieldOutputKg = parseFloat(el('yout').value) || 0;
    save(); render();
  }
  function saveShellYield() {
    if (!isAdmin()) return;
    var v = parseFloat(el('shYield').value);
    if (!(v > 0)) { alert('Въведи число по-голямо от 0.'); return; }
    if (v !== shellYield() && !confirm('Новият процент важи за всички изчисления, включително старите дни. Да запазя ли?')) return;
    db.settings.shellYield = v; save(); alert('Запазено!'); render();
  }
  // ръчно въвеждане на реално обелените кофи за днес (надделява над авто-сметката)
  function saveShelledToday() {
    var v = parseFloat(el('shToday').value);
    if (!(v >= 0)) { alert('Въведи брой кофи (0 или повече).'); return; }
    var today = DB.todayISO();
    var ex = null;
    db.events.forEach(function (e) { if (!e.deletedAt && e.type === 'shell' && e.date === today) ex = e; });
    if (ex) { ex.buckets = v; ex.createdAt = Date.now(); ex.createdBy = db.currentUserId; save(); }
    else addEvent({ type: 'shell', date: today, buckets: v });
    closeSheet(); render(); alert('Записано: ' + fmtKg(v) + ' обелени кофи за днес.');
  }
  // връща днешните обелени кофи към авто-сметката (маха ръчния запис)
  function clearShelledToday() {
    var today = DB.todayISO();
    db.events.forEach(function (e) { if (!e.deletedAt && e.type === 'shell' && e.date === today) softDelete(e.id); });
    closeSheet(); render();
  }
  // екран за изчистената ядка: очаквано (рандеман), въведено досега, остатък + добавяне
  function showKernel() {
    var ks = kernelStats();
    var pct = ks.expected > 0 ? Math.min(100, Math.round(ks.actual / ks.expected * 100)) : 0;
    var entries = activeEvents().filter(function (e) { return e.type === 'clean'; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 30);
    var list = entries.length ? entries.map(function (e) {
      var who = db.users.find(function (u) { return u.id === e.createdBy; });
      return '<div class="list-row">' + avatarHtml(who, 'lg') +
        '<div class="tx"><b>' + fmtKg(e.kg) + ' кг</b><small>изчистена ядка</small></div>' +
        '<div class="meta"><span class="dt">' + fmtDate(e.date) + '</span>' +
        (isAdmin() ? '<div><button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="edit:' + e.id + '">✏️</button><button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button></div>' : '') +
        '</div></div>';
    }).join('') : '<p class="muted">Още няма въведени изчистени.</p>';
    var sortEntries = activeEvents().filter(function (e) { return e.type === 'sort'; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 30);
    var sortList = sortEntries.length ? sortEntries.map(function (e) {
      var who = db.users.find(function (u) { return u.id === e.createdBy; });
      var tot = (e.whiteKg || 0) + (e.blackKg || 0);
      var wp = tot > 0 ? Math.round((e.whiteKg || 0) / tot * 100) : 0;
      return '<div class="list-row">' + avatarHtml(who, 'lg') +
        '<div class="tx"><b class="sortkv">⚪ ' + fmtKg(e.whiteKg || 0) + ' кг<br>⚫ ' + fmtKg(e.blackKg || 0) + ' кг</b><small>' + wp + '% бели</small></div>' +
        '<div class="meta"><span class="dt">' + fmtDate(e.date) + '</span>' +
        (isAdmin() ? '<div><button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="edit:' + e.id + '">✏️</button><button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button></div>' : '') +
        '</div></div>';
    }).join('') : '<p class="muted">Още няма сортирани.</p>';
    openSheet('<h3>🌰 Изчистена ядка (рандеман)</h3>' +
      '<p class="muted mb" style="font-size:13px">Очакваното се смята от събраните обелени (с черупка) × рандеман <b>' + Math.round(kernelYield() * 100) + '%</b> (от калкулатора в Настройки).</p>' +
      '<div class="card">' +
      '<div class="kv"><span class="k">Очаквано</span><span class="v"><b>' + fmtKg(ks.expected) + ' кг</b></span></div>' +
      '<div class="kv"><span class="k">Изчистено досега</span><span class="v"><b>' + fmtKg(ks.actual) + ' кг</b></span></div>' +
      '<div class="kv"><span class="k">Остават</span><span class="v"><b>' + fmtKg(ks.remaining) + ' кг</b></span></div>' +
      (ks.whitePct != null
        ? '<div class="kv"><span class="k">⚪ Бели ядки (' + Math.round(ks.whitePct * 100) + '%)</span><span class="v"><b>' + fmtKg(ks.sortedWhite) + ' / ' + fmtKg(ks.expectedWhite) + ' кг</b></span></div>' +
          '<div class="kv"><span class="k">⚪ Остават бели</span><span class="v"><b>' + fmtKg(ks.remainingWhite) + ' кг</b></span></div>'
        : '') +
      '<div class="kprog" style="margin-top:10px"><div class="kprog-fill" style="width:' + pct + '%"></div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:12px;margin:4px 2px 0">За въвеждане на изчистени и сортирани иди на „🧺 Събиране".</p>' +
      '<div class="section-title">🌰 Изчистени записи</div>' +
      '<div class="card">' + list + '</div>' +
      '<div class="section-title">⚪ Сортирани записи</div>' +
      '<div class="card">' + sortList + '</div>' +
      '<p class="muted" style="font-size:12px;margin:6px 2px 0">Изтегленото е след приспадане на теглото на кофата, ако е имало такава.</p>' +
      '<button class="btn ghost mt" data-action="closesheet">Затвори</button>');
  }
  function addCleanEntry() {
    var gross = parseFloat(el('clKg').value);
    if (!(gross > 0)) { alert('Въведи тегло по-голямо от 0.'); return; }
    var net = cleanNetKg();
    if (!(net > 0)) { alert('След вадене на кофите остава 0 кг. Провери теглото и броя кофи.'); return; }
    var date = (el('clDate') && el('clDate').value) || DB.todayISO();
    addEvent({ type: 'clean', date: date, kg: net });
    render();
  }
  // пресмята нетна чиста ядка: измерено тегло − (тара на избраната кофа × брой кофи)
  function cleanNetKg() {
    var gross = parseFloat((el('clKg') || {}).value) || 0;
    var sel = el('clBucket');
    var bid = sel ? sel.value : '';
    var cnt = parseFloat((el('clCount') || {}).value) || 1;
    var b = bid ? bucket(bid) : null;
    var tare = b ? (b.tareKg || 0) * cnt : 0;
    var net = gross - tare;
    return net > 0 ? net : 0;
  }
  function updateCleanNet() {
    var out = el('clNet'); if (!out) return;
    var sel = el('clBucket');
    var bid = sel ? sel.value : '';
    if (!bid) { out.innerHTML = ''; return; }
    out.innerHTML = 'Чиста ядка (без кофата): <b>' + fmtKg(cleanNetKg()) + ' кг</b>';
  }
  // нетна сортирана ядка (бели/черни): измерено тегло − (тара на избраната кофа × брой кофи)
  function sortNetKg(color) {
    var isW = color === 'white';
    var gross = parseFloat((el(isW ? 'sortWhite' : 'sortBlack') || {}).value) || 0;
    var bid = isW ? sortWhiteBucket : sortBlackBucket;
    var cnt = parseFloat((el(isW ? 'sortWhiteCount' : 'sortBlackCount') || {}).value) || 1;
    var b = bid ? bucket(bid) : null;
    var tare = b ? (b.tareKg || 0) * cnt : 0;
    var net = gross - tare;
    return net > 0 ? net : 0;
  }
  // запазва текущо въведеното при сортиране, за да не се губи при избор на кофа (re-render)
  function captureSortInputs() {
    sortDraft = {
      date: (el('sortDate') && el('sortDate').value) || '',
      whiteKg: (el('sortWhite') && el('sortWhite').value) || '',
      blackKg: (el('sortBlack') && el('sortBlack').value) || '',
      whiteCount: (el('sortWhiteCount') && el('sortWhiteCount').value) || '1',
      blackCount: (el('sortBlackCount') && el('sortBlackCount').value) || '1'
    };
  }
  function updateSortNet() {
    ['white', 'black'].forEach(function (c) {
      var isW = c === 'white';
      var out = el(isW ? 'swNet' : 'sbNet'); if (!out) return;
      var bid = isW ? sortWhiteBucket : sortBlackBucket;
      var gross = parseFloat((el(isW ? 'sortWhite' : 'sortBlack') || {}).value) || 0;
      if (!bid || !(gross > 0)) { out.innerHTML = ''; return; }
      out.innerHTML = (isW ? '⚪ Бели' : '⚫ Черни') + ' без кофата: <b>' + fmtKg(sortNetKg(c)) + ' кг</b>';
    });
  }
  // обелени (с черупка): записва реално обелените кофи за дата (надделява над авто-сметката)
  function addShellEntry() {
    var v = parseFloat(el('shBuckets').value);
    if (!(v > 0)) { alert('Въведи кофи по-голямо от 0.'); return; }
    var date = (el('shDate') && el('shDate').value) || DB.todayISO();
    var ex = null;
    db.events.forEach(function (e) { if (!e.deletedAt && e.type === 'shell' && e.date === date) ex = e; });
    if (ex) { ex.buckets = v; ex.createdAt = Date.now(); ex.createdBy = db.currentUserId; save(); }
    else addEvent({ type: 'shell', date: date, buckets: v });
    render();
  }
  // сортиране (4-ти процес): записва реално бели и черни ядки за дадена дата
  function addSortEntry() {
    var wg = parseFloat((el('sortWhite') || {}).value) || 0;
    var kg = parseFloat((el('sortBlack') || {}).value) || 0;
    if (wg <= 0 && kg <= 0) { alert('Въведи поне едно число по-голямо от 0.'); return; }
    var w = sortNetKg('white');
    var k = sortNetKg('black');
    if (wg > 0 && !(w > 0)) { alert('При белите, след вадене на кофата остава 0 кг. Провери теглото и броя кофи.'); return; }
    if (kg > 0 && !(k > 0)) { alert('При черните, след вадене на кофата остава 0 кг. Провери теглото и броя кофи.'); return; }
    var date = (el('sortDate') && el('sortDate').value) || DB.todayISO();
    addEvent({ type: 'sort', date: date, whiteKg: w, blackKg: k });
    sortDraft = {}; sortWhiteBucket = ''; sortBlackBucket = '';
    render();
  }
  // запазва колко бели и колко черни ядки излизат от 1 кофа начупени (презаписва се)
  function saveWhiteBlack() {
    if (!isAdmin()) return;
    var w = parseFloat(el('whiteKg').value);
    var k = parseFloat(el('blackKg').value);
    if (!(w >= 0)) w = 0;
    if (!(k >= 0)) k = 0;
    if (w + k <= 0) { alert('Въведи поне едно число по-голямо от 0.'); return; }
    db.settings.whiteKg = w;
    db.settings.blackKg = k;
    save(); render();
  }

  function saveSale() {
    var kg = parseFloat(el('saleKg').value) || 0;
    var price = parseFloat(el('salePrice').value) || 0;
    var sale = { id: DB.uid('sale'), buyerId: el('saleBuyer').value, date: el('saleDate').value, kg: kg, pricePerKg: price, total: kg * price, note: el('saleNote').value, createdBy: db.currentUserId, createdAt: Date.now(), deletedAt: null, deletedBy: null };
    db.sales.unshift(sale);
    var bname = (db.buyers.find(function (x) { return x.id === sale.buyerId; }) || {}).name || 'Купувач';
    addEvent({ type: 'sale_add', date: sale.date, note: bname, kg: kg, pricePerKg: price, total: sale.total, saleId: sale.id });
    closeSheet(); go('sales');
  }
  // еднократно попълване: стари продажби (отпреди логването) да получат запис в дневника.
  // id е детерминистично (ev_sale_<id>), за да не се дублира при синхронизация между устройства.
  function saleEventTs(s) {
    if (s.createdAt) return s.createdAt;
    // ако купувачът е добавен същия ден — продажбата е малко след него (за да е над „Нов купувач" в дневника)
    var b = db.buyers.find(function (x) { return x.id === s.buyerId; });
    if (b && b.createdAt && s.date) {
      var d = new Date(b.createdAt);
      var day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (day === s.date) return b.createdAt + 60000;
    }
    return s.date ? new Date(s.date + 'T12:00:00').getTime() : Date.now();
  }
  function backfillSaleEvents() {
    if (!db.sales || !db.events) return false;
    var byId = {};
    db.events.forEach(function (e) { if (e.type === 'sale_add' && e.saleId) byId[e.saleId] = e; });
    var changed = false;
    db.sales.forEach(function (s) {
      if (!s || !s.id) return;
      if (s.deletedAt) return; // изтритите продажби не връщаме в дневника
      var ts = saleEventTs(s);
      var ex = byId[s.id];
      if (ex) {
        // коригирай реда само за авто-генерираните записи (не пипай ръчно създадените)
        if (ex.id && ex.id.indexOf('ev_sale_') === 0 && ex.createdAt !== ts) { ex.createdAt = ts; changed = true; }
        return;
      }
      var bname = (db.buyers.find(function (x) { return x.id === s.buyerId; }) || {}).name || 'Купувач';
      db.events.unshift({
        id: 'ev_sale_' + s.id, type: 'sale_add', date: s.date, note: bname,
        kg: s.kg || 0, pricePerKg: s.pricePerKg || 0, total: s.total || 0, saleId: s.id,
        createdBy: s.createdBy || null, createdAt: ts, deletedAt: null, deletedBy: null
      });
      changed = true;
    });
    if (changed) DB.save(db);
    return changed;
  }
  function saveBuyer(fromSale) {
    var name = (el('bName').value || '').trim(); if (!name) { el('bName').focus(); return; }
    var id = DB.uid('buy');
    db.buyers.push({ id: id, name: name, phone: fmtPhone(el('bPhone').value), note: el('bNote').value, createdAt: Date.now() });
    addEvent({ type: 'buyer_add', date: DB.todayISO(), note: name });
    if (fromSale) { sheetNewSale(id, _saleDraft); _saleDraft = null; return; }
    closeSheet(); go('sales');
  }

  function saveEditBuyer(id) {
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    var name = (el('bName').value || '').trim(); if (!name) { el('bName').focus(); return; }
    b.name = name; b.phone = fmtPhone(el('bPhone').value); b.note = el('bNote').value;
    save(); closeSheet(); go('buyer', id);
  }

  function deleteBuyer(id) {
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    if (b.deletedAt) return;
    if (!confirm('Да изтрия ли купувача „' + b.name + '"? Админ може да го върне от дневника.')) return;
    b.deletedAt = Date.now();
    b.deletedBy = db.currentUserId;
    addEvent({ type: 'buyer_del', date: DB.todayISO(), note: b.name, buyerId: id });
    closeSheet(); go('sales');
  }
  // връщане на изтрит купувач (само админ, от дневника)
  function restoreBuyer(id) {
    if (!isAdmin()) return;
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    b.deletedAt = null; b.deletedBy = null;
    db.events.forEach(function (e) {
      if (e.type === 'buyer_del' && e.buyerId === id && !e.deletedAt) { e.deletedAt = Date.now(); e.deletedBy = db.currentUserId; }
    });
    save(); render();
  }
  // изтриване на продажба (работник или админ) — soft, админ може да я върне от дневника
  function deleteSale(saleId) {
    var s = (db.sales || []).find(function (x) { return x.id === saleId; });
    if (!s || s.deletedAt) return;
    if (!confirm('Да изтрия ли тази продажба? Админ може да я върне от дневника.')) return;
    var ev = db.events.find(function (e) { return e.type === 'sale_add' && e.saleId === saleId && !e.deletedAt; });
    if (ev) softDelete(ev.id);               // маркира записа в дневника и продажбата като изтрити
    else { setSaleDeleted(saleId, true); save(); }
    render();
  }

  // ---- Offline indicator -------------------------------------------------
  var offlineTimer = null;
  function setOffline(off) {
    document.body.classList.toggle('offline', !!off);
    if (off && !offlineTimer) offlineTimer = setInterval(refreshOnline, 10000); // повтаряй докато се върне мрежата
    if (!off && offlineTimer) { clearInterval(offlineTimer); offlineTimer = null; }
  }
  function refreshOnline() {
    // Ако браузърът казва, че има мрежа (надеждно на Android) — скрий банера веднага.
    if (navigator.onLine) { setOffline(false); return; }
    // Браузърът твърди, че няма мрежа — потвърди с реална заявка, преди да покажем банера.
    fetch('manifest.webmanifest?ping=' + Date.now())
      .then(function (r) { setOffline(!(r && r.ok)); })
      .catch(function () { setOffline(true); });
  }
  ['online', 'offline', 'pageshow', 'focus'].forEach(function (ev) { window.addEventListener(ev, refreshOnline); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshOnline(); });
  refreshOnline();

  // ---- Service worker + обновяване --------------------------------------
  var swReg = null;
  var reloading = false;

  function showUpdateBanner() {
    if (el('updateBar')) return;
    var bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.className = 'update-bar';
    bar.innerHTML = '🎉 Има нова версия на приложението!' +
      '<button data-action="applyupdate">Обнови сега</button>';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function applyUpdate() {
    if (swReg && swReg.waiting) { swReg.waiting.postMessage({ type: 'SKIP_WAITING' }); }
    else hardReload();
  }

  function hardReload() {
    if ('caches' in window) {
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).then(function () { location.reload(); });
    } else { location.reload(); }
  }

  function checkForUpdate() {
    var btnMsg = function (m) { var b = el('updState'); if (b) b.textContent = m; };
    btnMsg('Проверявам…');
    if (!('serviceWorker' in navigator) || !swReg) { hardReload(); return; }
    swReg.update().then(function () {
      setTimeout(function () {
        if (swReg.waiting || swReg.installing) { btnMsg('Намерена нова версия — обновявам…'); showUpdateBanner(); applyUpdate(); }
        else { btnMsg('✓ Имате най-новата версия (' + APP_VERSION + ')'); }
      }, 900);
    }).catch(function () { hardReload(); });
  }

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    // updateViaCache:'none' = и самият service-worker.js се тегли без HTTP кеш (за да се вижда новата версия)
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then(function (reg) {
      swReg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
    }).catch(function () {});

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return; reloading = true; location.reload();
    });

    // автоматична проверка при отваряне и при връщане към приложението
    window.addEventListener('focus', function () { if (swReg) swReg.update().catch(function () {}); });
  }

  if (db.currentUserId && route.name === 'login') route = { name: 'home', param: null };
  // при презареждане — възстанови последния таб от адреса (#таб/параметър)
  if (db.currentUserId) {
    try {
      var h = (location.hash || '').replace(/^#/, '');
      if (h) {
        var hp = h.split('/');
        var hname = hp[0];
        var hparam = hp[1] ? decodeURIComponent(hp[1]) : null;
        var restorable = ['home', 'tree', 'harvest', 'care', 'log', 'stats', 'sales', 'buyer', 'settings'];
        if (restorable.indexOf(hname) !== -1) route = { name: hname, param: hparam };
      }
    } catch (err) {}
  }
  if (db.currentUserId) onUserReady();
  // при връщане към приложението отбелязваме ново „отваряне" (за статистиката на админа)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') recordOpen();
  });
  try { history.replaceState({ route: route }, ''); } catch (err) {}
  applyZoom();
  backfillSaleEvents();
  render();
  startSync();
})();
