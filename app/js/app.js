/* =========================================================================
   app.js — Логика и изгледи на приложението (offline-first, роли, soft delete)
   ========================================================================= */
(function () {
  'use strict';

  var APP_VERSION = '1.36.0';   // ← при нова версия: увеличи тук И в service-worker.js (VERSION)
  var db = DB.load();
  var route = { name: 'login', param: null };
  var harvestDraft = {};   // { treeId: {bucketId: count} } за текущата сесия събиране
  var harvestMode = 'tree';
  var harvestRowFilter = ''; // филтър по ред на картата при събиране
  var harvestBucket = '';    // избрана кофа при събиране
  var harvestFill = 100;      // колко пълни са кофите (%) — общо за събиране
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
  var statPeriod = (function () { try { return localStorage.getItem(STAT_PERIOD_KEY) === 'week' ? 'week' : 'today'; } catch (e) { return 'today'; } })();
  var harvestHL = null;     // null или { id: kg } — подчертани дървета на картата (кой колко е дал)
  var statSuppressClick = false; // пропусни клика след суайп по бройките
  var mapSuppressClick = false; // пропусни клика след задържане/влачене, за да не размаркира
  var walk = { watchId: null, orient: null, heading: null, pos: null, nearestId: null }; // режим „Разходка“
  var editMode = false;     // редактиране на схемата (само админ)
  var treeEditBefore = null; // снимка на дървото преди редактиране (за връщане при отказ/изтриване)
  var syncStatus = 'off';   // 'off' | 'connecting' | 'on' | 'error' — състояние на облачната синхронизация

  // ---- Helpers -----------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  // пази само цифри и водещия „+“ за tel: връзка
  function telHref(s) { s = String(s == null ? '' : s).replace(/[^\d+]/g, ''); return s.replace(/(?!^)\+/g, ''); }
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
  function initials(name) { return (name || '?').trim().split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase(); }

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
  function bucket(id) { return db.settings.buckets.find(function (b) { return b.id === id; }); }
  var BUCKET_IMG = { buc_cheese: 'assets/bucket_cheese.png', buc_black: 'assets/bucket_black.png', buc_small: 'assets/bucket_round.png' };
  function bucketIcon(b) {
    var src = (b && b.photo) || (b && BUCKET_IMG[b.id]);
    return src ? '<img src="' + src + '" alt="" style="width:100%;height:100%;object-fit:contain"/>' : '🪣';
  }
  function activeEvents() { return db.events.filter(function (e) { return !e.deletedAt; }); }

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
  function harvestStats(period) {
    var today = DB.todayISO();
    var cutoff = today;
    if (period === 'week') { var d = new Date(); d.setDate(d.getDate() - 6); cutoff = d.toISOString().slice(0, 10); }
    var perTree = {}, groundKg = 0, totalKg = 0;
    activeEvents().forEach(function (e) {
      if (e.type !== 'harvest_tree' && e.type !== 'harvest_ground') return;
      if (e.date < cutoff || e.date > today) return;
      var k = eventKg(e); totalKg += k;
      if (e.type === 'harvest_tree' && e.treeId) perTree[e.treeId] = (perTree[e.treeId] || 0) + k;
      else groundKg += k;
    });
    return { kg: totalKg, perTree: perTree, groundKg: groundKg };
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
    return '<svg viewBox="0 0 64 64" width="100%" height="100%">' +
      '<rect x="29" y="42" width="6" height="16" rx="2" fill="#8a5a3b"/>' +
      '<circle cx="22" cy="30" r="14" fill="' + c[2] + '"/>' +
      '<circle cx="42" cy="30" r="14" fill="' + c[1] + '"/>' +
      '<circle cx="32" cy="20" r="15" fill="' + c[0] + '"/>' +
      '<circle cx="32" cy="30" r="13" fill="' + c[1] + '"/>' +
      '</svg>';
  }
  function treeSVG(health) {
    var c = health === 'green' ? ['#4bb869', '#2f9e52', '#1f7a43']
      : health === 'yellow' ? ['#f6c65a', '#f3b53c', '#d9962a']
        : ['#ec726b', '#e4584f', '#c23e36'];
    return treeSVGColors(c);
  }

  // ---- Event logging -----------------------------------------------------
  function addEvent(ev) {
    ev.id = DB.uid('ev');
    ev.createdBy = db.currentUserId;
    ev.createdAt = Date.now();
    ev.deletedAt = null;
    ev.deletedBy = null;
    db.events.unshift(ev);
    save();
  }
  function softDelete(evId) {
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e) return;
    e.deletedAt = Date.now();
    e.deletedBy = db.currentUserId;
    if (e.type === 'tree_edit' && e.changes && e.treeId) revertTreeChanges(e, true);
    if (e.type === 'photo' && e.photoId) setPhotoDeleted(e.photoId, true, e.treeId);
    save();
  }
  function restore(evId) {
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e) return;
    e.deletedAt = null; e.deletedBy = null;
    if (e.type === 'tree_edit' && e.changes && e.treeId) revertTreeChanges(e, false);
    if (e.type === 'photo' && e.photoId) setPhotoDeleted(e.photoId, false, e.treeId);
    save();
  }
  // Окончателно маха запис от дневника (за тестови записи) — не може да се върне.
  function purgeEvent(evId) {
    var i = db.events.findIndex(function (x) { return x.id === evId; });
    if (i === -1) return;
    db.events.splice(i, 1);
    save(); render();
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
  // тегло на 1 кофа според вида: зелени / обелени с черупка / чиста ядка
  function stateKg(b, state) { return !b ? 0 : (state === 'clean' ? b.cleanKg : state === 'shelled' ? b.shelledKg : b.greenKg); }
  function stateLabel(state) { return state === 'clean' ? 'чиста ядка' : state === 'shelled' ? 'обелени (с черупка)' : 'зелени'; }
  function eventKg(ev) {
    if (!ev.buckets) return 0;
    var fill = (ev.fill != null ? ev.fill : 100) / 100; // колко пълни са били кофите
    var total = 0;
    Object.keys(ev.buckets).forEach(function (bid) {
      var b = bucket(bid); if (!b) return;
      var w = ev.state === 'clean' ? b.cleanKg : ev.state === 'shelled' ? b.shelledKg : b.greenKg;
      total += (ev.buckets[bid] || 0) * w;
    });
    return total * fill;
  }
  function eventBuckets(ev) {
    if (!ev.buckets) return 0;
    return Object.keys(ev.buckets).reduce(function (s, k) { return s + (ev.buckets[k] || 0); }, 0);
  }
  // показва килограми с до 3 десетични знака, без излишни нули (напр. 3.75, 10, 0.5)
  function fmtKg(n) {
    n = Math.round(((n || 0) + Number.EPSILON) * 1000) / 1000;
    return n.toFixed(3).replace(/\.?0+$/, '');
  }
  // еталонна кофа за броене („кофа за сирене“) — спрямо нея се смятат „кофи днес“
  function refBucket() { return bucket('buc_cheese') || (db.settings.buckets && db.settings.buckets[0]); }
  function refBucketKg() {
    var b = refBucket();
    return b && b.greenKg ? b.greenKg : 10;
  }
  // колко обелени кофи излизат от 1 зелена кофа (нагласва се в Настройки)
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
  // авто-сметката е в килограми: обелени кг = зелени кг × коефициент (shellYield).
  function shelledStats(period) {
    var today = DB.todayISO();
    var days = [];
    if (period === 'week') {
      for (var i = 6; i >= 0; i--) { var dd = new Date(); dd.setDate(dd.getDate() - i); days.push(dd.toISOString().slice(0, 10)); }
      if (days.indexOf(today) === -1) days.push(today);
    } else days = [today];
    var greenByDay = {};
    activeEvents().forEach(function (e) {
      if (e.type !== 'harvest_tree' && e.type !== 'harvest_ground') return;
      if (days.indexOf(e.date) === -1) return;
      greenByDay[e.date] = (greenByDay[e.date] || 0) + eventKg(e);
    });
    var buckets = 0, kg = 0, manual = false;
    days.forEach(function (dt) {
      var ov = shellOverrideFor(dt);
      if (ov) { buckets += (ov.buckets || 0); kg += (ov.buckets || 0) * refBucketKg(); manual = true; }
      else { var dKg = (greenByDay[dt] || 0) * shellYield(); kg += dKg; buckets += dKg / refBucketKg(); }
    });
    return { buckets: buckets, kg: kg, manual: manual };
  }
  // рандеман: каква част от обелените (с черупка) е чиста ядка — от калкулатора в Настройки
  function kernelYield() {
    var s = db.settings;
    if (s && s.yieldInputKg > 0 && s.yieldOutputKg > 0) return s.yieldOutputKg / s.yieldInputKg;
    return 0.48;
  }
  // общо обелени (с черупка) кг за целия сезон — ръчното за деня надделява над авто-сметката
  function totalShelledKg() {
    var greenByDay = {}, dates = {};
    activeEvents().forEach(function (e) {
      if (e.type === 'harvest_tree' || e.type === 'harvest_ground') { greenByDay[e.date] = (greenByDay[e.date] || 0) + eventKg(e); dates[e.date] = 1; }
      else if (e.type === 'shell') dates[e.date] = 1;
    });
    var total = 0;
    Object.keys(dates).forEach(function (dt) {
      var ov = shellOverrideFor(dt);
      if (ov) total += (ov.buckets || 0) * refBucketKg();
      else total += (greenByDay[dt] || 0) * shellYield();
    });
    return total;
  }
  // обобщава изчистената ядка: очаквано (от рандемана), въведено досега и колко остава
  function kernelStats() {
    var shelledKg = totalShelledKg();
    var expected = shelledKg * kernelYield();
    var actual = 0;
    activeEvents().forEach(function (e) { if (e.type === 'clean') actual += (e.kg || 0); });
    return { expected: expected, actual: actual, remaining: Math.max(0, expected - actual) };
  }
  // колко пълни еталонни кофи се падат за дадено тегло (2 кофи = реално напълнени, не просто въведени)
  function bucketsEq(kg) { return (kg || 0) / refBucketKg(); }

  // =======================================================================
  //  NAVIGATION
  // =======================================================================
  function go(name, param) {
    if (route.name === 'walk' && name !== 'walk') stopWalk();
    if (name !== 'home' && mapSelected.length) clearMapSelect();
    route = { name: name, param: param || null };
    // добавя запис в историята, за да работи бутонът „назад“ / суайп жестът на iPhone вътре в приложението
    try { history.pushState({ route: route }, '', '#' + name + (param ? '/' + encodeURIComponent(param) : '')); } catch (err) {}
    render(); window.scrollTo(0, 0);
  }

  // назад през историята (телефонен бутон „назад“ и iOS суайп правят същото чрез popstate)
  function goBack() {
    if (isSheetOpen()) { closeSheet(); return; }
    if (history.length > 1) history.back(); else go('home');
  }
  function isSheetOpen() { var s = el('sheet'); return !!(s && s.classList.contains('open')); }

  window.addEventListener('popstate', function (e) {
    // ако има отворен лист (sheet) — затвори него и остани на същия изглед
    if (isSheetOpen()) { closeSheet(); try { history.pushState({ route: route }, ''); } catch (err) {} return; }
    var st = e.state && e.state.route;
    if (route.name === 'walk') stopWalk();
    if (mapSelected.length) clearMapSelect();
    route = st || { name: db.currentUserId ? 'home' : 'login', param: null };
    render(); window.scrollTo(0, 0);
  });

  // =======================================================================
  //  RENDER
  // =======================================================================
  function render() {
    var app = el('app');
    if (!db.currentUserId) { app.className = 'app'; app.innerHTML = viewLogin(); bind(); return; }
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
    app.innerHTML = body + bottomNav();
    bind();
    if (route.name === 'walk') startWalk();
    if (route.name === 'home') { initMapSelect(); renderMapBar(); initStatSwipe(); }
  }

  // =======================================================================
  //  ОБЛАЧНА СИНХРОНИЗАЦИЯ
  // =======================================================================
  function setSyncStatus(s) {
    syncStatus = s;
    var box = el('syncStatus');
    if (box) box.innerHTML = syncStatusHtml();
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
  // Облакът вече има данни → приемаме тях (пазим кой е влязъл на този телефон).
  function applyCloudSnapshot(cloud) {
    var keepUser = db.currentUserId;
    ['trees', 'events', 'buyers', 'sales', 'users', 'photos'].forEach(function (c) { if (cloud[c]) db[c] = cloud[c]; });
    if (cloud.settings) db.settings = cloud.settings;
    db.currentUserId = keepUser;
    DB.migratePhotos(db);
    DB.save(db);
    render();
  }
  function startSync() {
    if (!window.Sync) return;
    window.Sync.init({
      getLocalDb: function () { return db; },
      onInitialLoad: applyCloudSnapshot,
      onRemote: function () { DB.migratePhotos(db); DB.save(db); if (!isSheetOpen()) render(); },
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
      '<div class="avatar" data-action="settings">' + initials(m.name) + '</div></div></div>';
  }

  // ---- Bottom nav --------------------------------------------------------
  function bottomNav() {
    var items = [
      { k: 'home', ic: '🗺️', t: 'Градина' },
      { k: 'harvest', ic: '🧺', t: 'Събиране' },
      { k: 'sales', ic: '💰', t: 'Клиенти' },
      { k: 'stats', ic: '📊', t: 'Статистика' },
      { k: 'log', ic: '📜', t: 'Дневник' }
    ];
    return '<div class="bottomnav">' + items.map(function (i) {
      var active = (route.name === i.k || (i.k === 'sales' && route.name === 'buyer')) ? ' active' : '';
      return '<div class="nav' + active + '" data-action="nav:' + i.k + '"><span class="ic">' + i.ic + '</span>' + i.t + '</div>';
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
          '<span><span class="avatar" style="display:inline-flex;vertical-align:middle;margin-right:10px">' + initials(u.name) + '</span>' + esc(u.name) + '</span>' +
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
  function viewHome() {
    var counts = { green: 0, yellow: 0, red: 0 };
    db.trees.filter(function (t) { return !t.deletedAt; }).forEach(function (t) { counts[t.health]++; });
    var hv = harvestStats(statPeriod);
    var perLbl = statPeriod === 'today' ? 'днес' : '7д';

    var fr = { fresh: 0, week: 0, old: 0 }, doneToday = 0;
    db.trees.filter(function (t) { return !t.deletedAt; }).forEach(function (t) {
      var f = harvestFreshness(t.id);
      if (f === 'today') fr.fresh++; else if (f === 'week') fr.week++; else fr.old++;
      if (harvestedToday(t.id)) doneToday++;
    });

    var greenBk = bucketsEq(hv.kg);
    var sh = shelledStats(statPeriod);
    var shelledBk = sh.buckets;
    var shelledKg = sh.kg;

    return topbar('Орехова градина') + '<div class="content">' +
      '<div class="stat-row" id="statSwipe">' +
      '<div class="stat green harvstat" data-action="statbreak"><b>' + fmtKg(greenBk) + '</b><small>кофи зелени ' + perLbl + '</small><small class="kg">≈ ' + fmtKg(hv.kg) + ' кг</small></div>' +
      '<div class="stat shelled harvstat" data-action="statbreak"><b>' + fmtKg(shelledBk) + '</b><small>кофи обелени ' + perLbl + (sh.manual ? ' ✏️' : '') + '</small><small class="kg">≈ ' + fmtKg(shelledKg) + ' кг</small></div>' +
      '</div>' +
      '<div class="stat-period" data-action="statperiod"><span class="ar">‹</span><span class="pl">' +
      (statPeriod === 'today' ? '📅 Днес' : '🗓️ Тази седмица (7 дни)') +
      '</span><span class="ar">›</span></div>' +
      '<div class="refbucket-note"><img src="assets/bucket_cheese.png" alt="Кофа от сирене"/><span>броят кофи е спрямо кофата от сирене (' + fmtKg(refBucketKg()) + ' кг)</span></div>' +
      (harvestHL ? '<div class="hl-banner">📍 Маркирани дърветата от „' + (statPeriod === 'today' ? 'днес' : 'тази седмица') +
        '" върху картата. <button class="btn sm ghost" data-action="statclear">✖ Махни</button></div>' : '') +

      '<div class="section-title title-row"><span class="tl">Карта на градината' +
      (isAdmin() ? ' <button class="iconbtn' + (editMode ? ' on' : '') + '" data-action="editschema" aria-label="Редактирай схемата">' + (editMode ? '✓' : '✏️') + '</button>' : '') +
      '</span>' +
      (editMode ? '' : '<button class="btn sm secondary walkbtn" data-action="nav:walk">🧭 Къде съм</button>') +
      '</div>' +
      (editMode ? '' : '<div class="seg"><button class="' + (mapMode === 'health' ? 'active' : '') + '" data-action="mapmode:health">🌳 Здраве</button>' +
        '<button class="' + (mapMode === 'harvest' ? 'active' : '') + '" data-action="mapmode:harvest">🧺 Събиране</button></div>') +
      (editMode ? '<div class="edit-bar">✏️ Режим редакция: докосни ➕ за ново дърво, дърво за да го местиш/триеш, или зона (Градина, Къща…) за да ѝ смениш мястото и размера.</div>' : '') +
      (editMode ? '<button class="btn secondary mb" data-action="addzone">➕ Добави зона</button>' : '') +
      (editMode ? '' : '<div class="map-toolbar">' +
        '<select class="input" id="fVar"><option value="">Всички сортове</option>' +
        db.settings.varieties.map(function (v) { return '<option value="' + v.id + '">' + esc(v.name) + '</option>'; }).join('') + '</select>' +
        (mapMode === 'health' ? '<select class="input" id="fHealth"><option value="">Всички състояния</option><option value="green">Здрави</option><option value="yellow">За грижа</option><option value="red">Болни</option></select>' : '') +
        '</div>') +
      (editMode ? '' : '<div class="map-tools-row"><button class="btn sm ' + (mapSelect ? '' : 'secondary') + '" data-action="mapselecttoggle">' + (mapSelect ? '✖ Изход от избор' : '☑️ Избери няколко дървета') + '</button></div>') +
      (editMode ? '' : '<div class="map-hint">💡 Натисни „Избери няколко" и докосвай дърветата, или задръж пръст върху дърво за да започнеш.</div>') +
      '<div class="mapwrap" id="mapwrap">' + orchardGrid('', '', editMode, mapMode) + '</div>' +
      (mapMode === 'harvest'
        ? '<div class="legend">' +
          '<span><i class="dotc green"></i>Брано скоро (' + fr.fresh + ')</span>' +
          '<span><i class="dotc yellow"></i>Тази седмица (' + fr.week + ')</span>' +
          '<span><i class="dotc" style="background:#aab7af"></i>Отдавна / не е брано (' + fr.old + ')</span>' +
          '<span>✅ Събрано днес (' + doneToday + ')</span></div>'
        : '<div class="legend">' +
          '<span><i class="dotc green"></i>Здраво (' + counts.green + ')</span>' +
          '<span><i class="dotc yellow"></i>За грижа (' + counts.yellow + ')</span>' +
          '<span><i class="dotc red"></i>Болно (' + counts.red + ')</span>' +
          '<span><i class="dotc" style="background:#7c5cff"></i>дребен сорт</span></div>') +

      '<div class="section-title">Бързи действия</div>' +
      '<div class="row mb">' +
      '<button class="btn secondary" data-action="nav:harvest">🧺 Събиране</button>' +
      '<button class="btn secondary" data-action="care:fertilize">🌱 Торене</button>' +
      '</div>' +
      '<div class="row">' +
      '<button class="btn secondary" data-action="care:water">💧 Поливане</button>' +
      '<button class="btn secondary" data-action="care:mow">🌾 Косене</button>' +
      '</div>' +
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
    var html = '<div class="grid" style="grid-template-columns:16px repeat(' + cols2 + ',1fr)">';
    html += '<div class="corner" style="grid-row:1;grid-column:1"></div>';
    for (var c = 1; c <= maxCol; c++) html += '<div class="colhead" style="grid-row:1;grid-column:' + (2 * c) + ' / span 2">' + c + '</div>';
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
          var small = v && v.size === 'small' ? ' small-badge' : '';
          var act = edit ? 'edittree:' + t.id : 'tree:' + t.id;
          var sel = (mapSelected.indexOf(t.id) !== -1) ? ' selected' : '';
          var hl = (harvestHL && harvestHL[t.id] != null) ? ' hl-harvest' : '';
          var hlBadge = (harvestHL && harvestHL[t.id] != null) ? '<span class="hlkg">' + fmtKg(harvestHL[t.id]) + ' кг</span>' : '';
          var svg, doneCls = '', ageHtml = '';
          if (mode === 'harvest') {
            var fresh = harvestFreshness(t.id);
            svg = treeSVGColors(FRESH_COLORS[fresh]);
            if (harvestedToday(t.id)) doneCls = ' harvested-today';
            var al = harvestAgoLabel(t.id);
            if (al) ageHtml = '<span class="age ' + fresh + '">' + al + '</span>';
          } else {
            svg = treeSVG(t.health);
          }
          html += '<div class="tree-cell' + small + sel + doneCls + hl + '" id="cell_' + t.id + '" data-tid="' + t.id + '" data-action="' + act + '" style="grid-row:' + gr + ';grid-column:' + (2 * c) + ' / span 2;' + (dim ? 'opacity:.2' : '') + '">' +
            '<div class="svgwrap">' + svg + '</div><span class="code">' + esc(t.code) + '</span>' + ageHtml + hlBadge + '</div>';
        } else if (edit && !isReserved) {
          html += '<div class="cell-empty" data-action="addtree:' + rk + ':' + c + '" style="grid-row:' + gr + ';grid-column:' + (2 * c) + ' / span 2">＋</div>';
        }
      }
    });
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
        '<div style="width:90px;height:90px">' + treeSVG(t.health) + '</div></div>') +
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
    var todayEvs = activeEvents().filter(function (e) { return (e.type === 'harvest_tree' || e.type === 'harvest_ground') && e.date === today; });
    var todayKg = todayEvs.reduce(function (s, e) { return s + eventKg(e); }, 0);

    var body = topbar('Събиране на орехи', { back: 'nav:home' }) + '<div class="content">' +
      '<div class="seg">' +
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
      fmtKg(todayKg) + ' кг · ' + fmtKg(bucketsEq(todayKg)) + ' кофи</div></div>';

    body += '<button class="btn mt" data-action="savehcurrent">💾 Запази събраното</button>';
    body += '</div>';
    return body;
  }

  function counterRow(key, title, sub, val) {
    return '<div class="counter-row">' +
      '<div class="ic">' + (key === 'ground' ? '🍂' : '🌳') + '</div>' +
      '<div class="info"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></div>' +
      '<div class="stepper">' +
      '<button data-action="hminus:' + key + '">−</button>' +
      '<span class="val" id="cnt_' + key + '">' + val + '</span>' +
      '<button data-action="hplus:' + key + '">+</button>' +
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

    var body = topbar('Грижа за градината', { back: 'nav:home' }) + '<div class="content">' +
      '<div class="seg">' +
      '<button class="' + (careTab === 'fertilize' ? 'active' : '') + '" data-action="ctab:fertilize">🌱 Торене</button>' +
      '<button class="' + (careTab === 'water' ? 'active' : '') + '" data-action="ctab:water">💧 Поливане</button>' +
      '<button class="' + (careTab === 'mow' ? 'active' : '') + '" data-action="ctab:mow">🌾 Косене</button>' +
      '</div>';

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
    body += '</div>';
    return body;
  }

  // =======================================================================
  //  LOG / CHANGE LOG
  // =======================================================================
  function logRow(e) {
    var map = {
      water: { ic: '💧', cls: 'water', t: 'Поливане' },
      fertilize: { ic: '🌱', cls: 'fert', t: 'Торене' },
      harvest_tree: { ic: '🧺', cls: 'harvest', t: 'Събиране (дърво)' },
      harvest_ground: { ic: '🍂', cls: 'harvest', t: 'Събиране (земя)' },
      shell: { ic: '🥥', cls: 'harvest', t: 'Обелени (ръчно)' },
      clean: { ic: '🌰', cls: 'harvest', t: 'Изчистена ядка' },
      mow: { ic: '🌾', cls: 'mow', t: 'Косене' },
      photo: { ic: '📷', cls: 'sys', t: 'Снимка' },
      tree_edit: { ic: '⚙️', cls: 'sys', t: 'Промяна на дърво' },
      buyer_add: { ic: '🤝', cls: 'sys', t: 'Нов купувач' },
      buyer_del: { ic: '🗑️', cls: 'sys', t: 'Изтрит купувач' },
      note: { ic: '📝', cls: 'sys', t: 'Бележка' }
    };
    var m = map[e.type] || { ic: '•', cls: 'sys', t: e.type };
    var who = db.users.find(function (u) { return u.id === e.createdBy; });
    var t = e.treeId ? tree(e.treeId) : null;
    var detail = '';
    if (e.type === 'harvest_tree' || e.type === 'harvest_ground') detail = eventBuckets(e) + ' кофи' + (e.fill != null && e.fill !== 100 ? ' (' + e.fill + '% пълни)' : '') + ' · ' + fmtKg(eventKg(e)) + ' кг' + (e.state && e.state !== 'green' ? ' · ' + stateLabel(e.state) : '');
    else if (e.type === 'shell') detail = fmtKg(e.buckets) + ' обелени кофи · ≈ ' + fmtKg((e.buckets || 0) * refBucketKg()) + ' кг';
    else if (e.type === 'clean') detail = fmtKg(e.kg) + ' кг чиста ядка';
    else if (e.type === 'fertilize') detail = esc(e.what || '') + (e.qty ? ' · ' + e.qty + ' ' + esc(e.unit || '') : '');
    else if (e.type === 'water') detail = (e.qty || 0) + ' л';
    else if (e.type === 'mow') detail = 'окосено';
    else if (e.note) detail = esc(e.note);

    var onBehalf = e.onBehalfOf ? ' (от името на ' + esc(e.onBehalfOf) + ')' : '';
    var deleted = e.deletedAt;
    var scopeLbl = t ? ' · ' + esc(t.code) : (e.rows && e.rows.length ? ' · редове ' + esc(e.rows.join(', ')) : '');
    var reacts = e.reactions || [];
    var liked = reacts.indexOf(db.currentUserId) !== -1;
    var reactBtn = '<button class="heartbtn' + (liked ? ' on' : '') + '" data-action="react:' + e.id + '" aria-label="Реагирай със сърце">' +
      (liked ? '❤️' : '🤍') + (reacts.length ? ' <span class="hc">' + reacts.length + '</span>' : '') + '</button>';
    return '<div class="list-row"' + (deleted ? ' style="opacity:.5"' : '') + '>' +
      '<div class="ic ' + m.cls + '">' + m.ic + '</div>' +
      '<div class="tx"><b>' + m.t + scopeLbl + (deleted ? ' <span class="badge orange">изтрито</span>' : '') + '</b>' +
      '<small>' + detail + ' — ' + (who ? esc(who.name) : '?') + onBehalf + '</small>' +
      '<div class="reacts">' + reactBtn + '</div></div>' +
      '<div class="meta">' + fmtDate(e.date) +
      (isAdmin() ? '<div>' + (deleted ? '<button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="restore:' + e.id + '">Върни</button>' +
        '<button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="purge:' + e.id + '">🗑️ Завинаги</button>'
        : '<button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button>') + '</div>' : '') +
      '</div></div>';
  }

  function viewLog() {
    var evs = isAdmin() ? db.events : activeEvents();
    return topbar('Дневник / Чейндж лог', { back: 'nav:home' }) + '<div class="content">' +
      '<p class="muted mb">Всичко кой какво е правил, с дати и имена. Изтритото се пази (soft delete).</p>' +
      '<div class="card">' + (evs.length ? evs.slice(0, 100).map(logRow).join('') : '<p class="muted">Още няма записи.</p>') + '</div>' +
      '</div>';
  }

  // =======================================================================
  //  STATS
  // =======================================================================
  function viewStats() {
    var year = db.settings.seasonYear;
    var harv = activeEvents().filter(function (e) { return e.type === 'harvest_tree' || e.type === 'harvest_ground'; });
    var totalKg = harv.reduce(function (s, e) { return s + eventKg(e); }, 0);
    var soldKg = db.sales.reduce(function (s, x) { return s + (x.kg || 0); }, 0);
    var revenue = db.sales.reduce(function (s, x) { return s + (x.total || 0); }, 0);

    // по месеци
    var months = new Array(12).fill(0);
    harv.forEach(function (e) { var d = new Date(e.date); if (d.getFullYear() === year) months[d.getMonth()] += eventKg(e); });
    var maxM = Math.max.apply(null, months.concat([1]));
    var mLabels = ['Я', 'Ф', 'М', 'А', 'М', 'Ю', 'Ю', 'А', 'С', 'О', 'Н', 'Д'];

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
      '<div class="stat blue"><b>' + fmtKg(soldKg) + '</b><small>продадени (кг)</small></div>' +
      '<div class="stat purple"><b>' + revenue.toFixed(0) + '</b><small>приходи (€)</small></div>' +
      '</div>' +

      '<div class="section-title">🌰 Изчистена ядка (рандеман)</div>' +
      '<div class="kernelcard" data-action="kernel">' +
      '<div class="kernelhead"><span>Изчистено / очаквано</span><b>' + fmtKg(ks.actual) + ' / ' + fmtKg(ks.expected) + ' кг</b></div>' +
      '<div class="kprog"><div class="kprog-fill" style="width:' + kpct + '%"></div></div>' +
      '<div class="kernelsub">' + (ks.expected > 0 ? 'Остават ≈ ' + fmtKg(ks.remaining) + ' кг до очакваното · рандеман ' + Math.round(kernelYield() * 100) + '% · натисни за въвеждане' : 'Събери и обели, за да се сметне очакваното') + '</div>' +
      '</div>' +

      '<div class="section-title">Добив по месеци — ' + year + ' (кг)</div>' +
      '<div class="card"><div class="bars">' +
      months.map(function (v) { return '<div class="b" style="height:' + Math.max(4, (v / maxM) * 100) + '%"></div>'; }).join('') +
      '</div><div class="barlabels">' + mLabels.map(function (l) { return '<span>' + l + '</span>'; }).join('') + '</div></div>' +

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
    return topbar('Клиенти и продажби', { back: 'nav:home' }) + '<div class="content">' +
      '<button class="btn mb" data-action="newsale">➕ Нова продажба</button>' +
      '<div class="section-title">Купувачи</div>' +
      db.buyers.map(function (b) {
        var purchases = db.sales.filter(function (s) { return s.buyerId === b.id; });
        var kg = purchases.reduce(function (s, x) { return s + (x.kg || 0); }, 0);
        return '<div class="card" data-action="buyer:' + b.id + '" style="cursor:pointer">' +
          '<div style="display:flex;align-items:center;gap:12px">' +
          '<div class="avatar">' + initials(b.name) + '</div>' +
          '<div style="flex:1"><b>' + esc(b.name) + '</b><div class="muted" style="font-size:13px">' + esc(b.phone || '') + '</div>' +
          '<div class="muted" style="font-size:12px">' + purchases.length + ' покупки · ' + fmtKg(kg) + ' кг</div></div>' +
          '<span style="font-size:22px;color:var(--muted)">›</span></div></div>';
      }).join('') +
      '<button class="btn ghost mt" data-action="newbuyer">➕ Нов купувач</button>' +
      '</div>';
  }

  function viewBuyer(id) {
    var b = db.buyers.find(function (x) { return x.id === id; });
    if (!b) return topbar('Купувач', { back: 'nav:sales' }) + '<div class="content">Няма.</div>';
    var purchases = db.sales.filter(function (s) { return s.buyerId === id; }).sort(function (a, c) { return c.date < a.date ? -1 : 1; });
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
          '<div class="meta">' + fmtDate(s.date) + '</div></div>';
      }).join('') : '<p class="muted">Още няма покупки.</p>') + '</div>' +
      '<button class="btn" data-action="newsalefor:' + b.id + '">➕ Добави продажба</button>' +
      (isAdmin() ? '<button class="btn danger mt" data-action="delbuyer:' + b.id + '">🗑️ Изтрий купувача</button>' : '') +
      '</div>';
  }

  // =======================================================================
  //  SETTINGS
  // =======================================================================
  function viewSettings() {
    var s = db.settings;
    return topbar('Настройки', { back: 'nav:home' }) + '<div class="content">' +
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
      '<p class="muted mb" style="font-size:13px">Колко кг е 1 кофа — зелени / обелени с черупка / чиста ядка. (Обелените с черупка са винаги в кофата от сирене.)</p>' +
      db.settings.buckets.map(function (b) {
        var head = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">' +
          '<div style="width:48px;height:48px;border-radius:12px;background:var(--green-soft);display:flex;align-items:center;justify-content:center;font-size:26px;overflow:hidden;padding:4px">' + bucketIcon(b) + '</div>' +
          '<div><b>' + esc(b.name) + '</b><div class="muted" style="font-size:13px">' + esc(b.capacityNote || '') + '</div></div></div>';
        if (!isAdmin()) {
          return '<div class="card">' + head +
            '<div class="kv"><span class="k">Вместимост</span><span class="v">' + (b.liters != null ? b.liters + ' л' : '—') + '</span></div>' +
            '<div class="kv"><span class="k">Зелени</span><span class="v">' + b.greenKg + ' кг</span></div>' +
            '<div class="kv"><span class="k">С черупка</span><span class="v">' + b.shelledKg + ' кг</span></div>' +
            '<div class="kv"><span class="k">Чиста ядка</span><span class="v">' + b.cleanKg + ' кг</span></div></div>';
        }
        return '<div class="card">' + head +
          '<div class="field"><label>Вместимост (литри)</label><input class="input" type="number" value="' + (b.liters != null ? b.liters : '') + '" data-bkg="liters:' + b.id + '"/></div>' +
          '<div class="row"><div class="field"><label>Зелени (кг)</label><input class="input" type="number" value="' + b.greenKg + '" data-bkg="green:' + b.id + '"/></div>' +
          '<div class="field"><label>С черупка</label><input class="input" type="number" value="' + b.shelledKg + '" data-bkg="shelled:' + b.id + '"/></div>' +
          '<div class="field"><label>Чиста ядка</label><input class="input" type="number" value="' + b.cleanKg + '" data-bkg="clean:' + b.id + '"/></div></div></div>';
      }).join('') +
      (isAdmin() ? '<button class="btn secondary mb" data-action="savebuckets">💾 Запази теглата на кофите</button>' : '') +
      '</div></details>' +

      '<details class="sect"><summary>🥥 Белене (зелени → обелени)</summary><div class="sect-body">' +
      '<p class="muted mb" style="font-size:13px">Орехите се събират зелени, после ги белите. Тук казваш колко килограма обелени (с черупка) излизат от 1 кг зелени. Бройката „обелени" горе на началния екран се смята автоматично по тегло.</p>' +
      (isAdmin()
        ? '<div class="card"><div class="field"><label>1 кг зелени → колко кг обелени</label>' +
          '<input id="shYield" class="input" type="number" step="0.05" min="0.05" value="' + shellYield() + '"/></div>' +
          '<p class="muted" style="font-size:12px">Напр. 0.5 означава: 10 кг зелени → 5 кг обелени.</p>' +
          '<button class="btn secondary" data-action="saveshellyield">💾 Запази</button></div>'
        : '<div class="card"><div class="kv"><span class="k">1 кг зелени ≈</span><span class="v">' + fmtKg(shellYield()) + ' кг обелени</span></div></div>') +
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
          '<span class="avatar" style="width:36px;height:36px;font-size:13px">' + initials(u.name) + '</span>' +
          '<div style="flex:1"><b>' + esc(u.name) + '</b>' + (owner ? ' 👑' : '') +
          '<div class="muted" style="font-size:12px">' + (u.role === 'admin' ? '🔒 Администратор' : 'Работник') + '</div></div>' +
          '<span class="badge ' + (u.role === 'admin' ? 'green' : 'orange') + '">' + (u.role === 'admin' ? 'Админ' : 'Работник') + '</span></div>' +
          (controls ? '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:10px 0 12px;border-bottom:1px solid var(--line)">' + controls + '</div>' : '');
      }).join('') + '</div>' +
      (isAdmin() ? '<button class="btn secondary mt" data-action="changemypass">🔑 Смени моята парола</button>' : '') +
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

      '<button class="btn ghost mt" data-action="logout">🚪 Смени потребител</button>' +
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
  function openSheet(html) {
    var s = el('sheet');
    s.innerHTML = '<div class="sheet"><div class="grip"></div>' + html + '</div>';
    s.classList.add('open');
  }
  function closeSheet() { el('sheet').classList.remove('open'); el('sheet').innerHTML = ''; }

  // ---- Сортове (само админ; промените се синхронизират за всички) ----
  function sheetVarietyNew() {
    if (!isAdmin()) return;
    openSheet('<h3>Нов сорт орех</h3>' +
      '<div class="field"><label>Име</label><input id="vName" class="input" placeholder="напр. Чандлър"/></div>' +
      '<div class="field"><label>Размер</label><select id="vSize" class="input"><option value="big">🌰 Едър сорт</option><option value="small">🥜 Дребен сорт</option></select></div>' +
      '<div class="field"><label>Бележка</label><input id="vNote" class="input" placeholder="напр. Големи орехи"/></div>' +
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
    if (id === 'new') {
      db.settings.varieties.push({ id: DB.uid('var'), name: name, size: size, note: note });
    } else {
      var v = variety(id); if (!v) return;
      v.name = name; v.size = size; v.note = note;
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
      '<div class="field"><label>Височина (м)</label><input id="etHeight" type="number" step="0.1" min="0" class="input" placeholder="напр. 3.5" value="' + (t.height != null && t.height !== '' ? esc(t.height) : '') + '"/></div>' +
      '<div class="field"><label>Бележка</label><textarea id="etNote" class="input">' + esc(t.note || '') + '</textarea></div>' +
      '<button class="btn" data-action="savetree:' + id + '">💾 Запази</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }

  function sheetNewSale(buyerId) {
    openSheet('<h3>Нова продажба</h3>' +
      '<div class="field"><label>Купувач</label><select id="saleBuyer" class="input">' +
      db.buyers.map(function (b) { return '<option value="' + b.id + '"' + (b.id === buyerId ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Дата</label><input id="saleDate" type="date" class="input" value="' + DB.todayISO() + '"/></div>' +
      '<div class="row"><div class="field"><label>Количество (кг)</label><input id="saleKg" type="number" class="input" placeholder="0"/></div>' +
      '<div class="field"><label>Цена (€/кг)</label><input id="salePrice" type="number" class="input" placeholder="0"/></div></div>' +
      '<div class="field"><label>Бележка</label><input id="saleNote" class="input" placeholder="по избор"/></div>' +
      '<button class="btn" data-action="savesale">💾 Запази продажба</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }

  function sheetNewBuyer() {
    openSheet('<h3>Нов купувач</h3>' +
      '<div class="field"><label>Име</label><input id="bName" class="input" placeholder="Име и фамилия"/></div>' +
      '<div class="field"><label>Телефон</label><input id="bPhone" class="input" placeholder="+359..."/></div>' +
      '<div class="field"><label>Бележка</label><textarea id="bNote" class="input" placeholder="по избор"></textarea></div>' +
      '<button class="btn" data-action="savebuyer">💾 Запази купувач</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }

  function sheetEditBuyer(id) {
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    openSheet('<h3>Редактирай купувач</h3>' +
      '<div class="field"><label>Име</label><input id="bName" class="input" value="' + esc(b.name) + '"/></div>' +
      '<div class="field"><label>Телефон</label><input id="bPhone" class="input" value="' + esc(b.phone || '') + '"/></div>' +
      '<div class="field"><label>Бележка</label><textarea id="bNote" class="input">' + esc(b.note || '') + '</textarea></div>' +
      '<button class="btn" data-action="saveeditbuyer:' + id + '">💾 Запази</button>' +
      (isAdmin() ? '<button class="btn danger mt" data-action="delbuyer:' + id + '">🗑️ Изтрий купувача</button>' : '') +
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
    var mw = el('mapwrap');
    if (mw) mw.innerHTML = orchardGrid(el('fVar') ? el('fVar').value : '', el('fHealth') ? el('fHealth').value : '', editMode);
  }

  // ---- Горни бройки: период „днес/седмица“ + разбивка по дървета ----------
  function setStatPeriod(p) {
    statPeriod = (p === 'week' ? 'week' : 'today');
    try { localStorage.setItem(STAT_PERIOD_KEY, statPeriod); } catch (e) {}
    harvestHL = null; // смяната на период маха подчертаването
    render();
  }
  function toggleStatPeriod() { setStatPeriod(statPeriod === 'today' ? 'week' : 'today'); }

  // показва от кои дървета колко е събрано за избрания период и ги маркира на картата
  function showHarvestBreakdown() {
    var hv = harvestStats(statPeriod);
    var when = statPeriod === 'today' ? 'днес' : 'тази седмица (7 дни)';
    harvestHL = hv.perTree; // маркирай дърветата на картата
    render();               // прерисувай картата с подчертаването
    var ranked = Object.keys(hv.perTree).map(function (id) { return { t: tree(id), kg: hv.perTree[id] }; })
      .filter(function (r) { return r.t; }).sort(function (a, b) { return b.kg - a.kg; });
    var list = ranked.length ? ranked.map(function (r) {
      return '<div class="list-row"><div class="ic harvest">🌳</div>' +
        '<div class="tx"><b>Дърво ' + esc(r.t.code) + '</b><small>' + fmtKg(bucketsEq(r.kg)) + ' кофи</small></div>' +
        '<div class="meta"><b>' + fmtKg(r.kg) + ' кг</b></div></div>';
    }).join('') : '<p class="muted">Няма събрано от дървета за този период.</p>';
    var ground = hv.groundKg > 0 ? '<div class="list-row"><div class="ic harvest">🍂</div>' +
      '<div class="tx"><b>От земята (зелени)</b><small>не е вързано към дърво</small></div>' +
      '<div class="meta"><b>' + fmtKg(hv.groundKg) + ' кг</b></div></div>' : '';
    var greenBk = bucketsEq(hv.kg);
    var sh = shelledStats(statPeriod);
    var shelledBk = sh.buckets;
    var shelledKg = sh.kg;
    var today = DB.todayISO();
    var todayOv = shellOverrideFor(today);
    var todayAuto = (harvestStats('today').kg * shellYield()) / refBucketKg();
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
      setStatPeriod(x < sx ? 'week' : 'today'); // наляво = седмица, надясно = днес
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
  function toggleMapTree(id) {
    var i = mapSelected.indexOf(id);
    if (i === -1) { mapSelected.push(id); markCell(id, true); }
    else { mapSelected.splice(i, 1); markCell(id, false); }
    renderMapBar();
  }
  function clearMapSelect() {
    mapSelect = false;
    mapSelected.slice().forEach(function (id) { markCell(id, false); });
    mapSelected = [];
    renderMapBar();
  }
  function renderMapBar() {
    var bar = el('mapbar'); if (!bar) return;
    if (!mapSelect && !mapSelected.length) { bar.classList.remove('open'); bar.innerHTML = ''; return; }
    var n = mapSelected.length;
    bar.innerHTML = '<div class="mapbar-info">' + (n ? '<b>' + n + '</b> избрани дървета' : 'Докосни дърветата') + '</div>' +
      '<div class="mapbar-actions">' +
      (n ? '<button class="btn sm" data-action="mapcare:fertilize">🌱 Торене</button>' +
        '<button class="btn sm" data-action="mapcare:water">💧 Поливане</button>' : '') +
      '<button class="btn sm ghost" data-action="mapclear">Готово</button>' +
      '</div>';
    bar.classList.add('open');
  }
  // закача слушатели за задържане/влачене върху картата (докосване и мишка за тест)
  function initMapSelect() {
    var mw = el('mapwrap');
    if (!mw || editMode) return;
    var pressTimer = null, startX = 0, startY = 0, dragging = false, moved = false, startId = null;
    var pinching = false;   // активен жест със зуум (два пръста) — да не маркира дърво

    function cellIdAt(x, y) {
      var node = document.elementFromPoint(x, y);
      // върви нагоре ръчно (по-надеждно от closest при SVG елементи в стари браузъри)
      while (node && node !== document.body) {
        if (node.classList && node.classList.contains('tree-cell')) return node.getAttribute('data-tid');
        node = node.parentNode;
      }
      return null;
    }
    function onDown(x, y, id) {
      startX = x; startY = y; moved = false; dragging = false; startId = id;
      if (pressTimer) clearTimeout(pressTimer);
      if (!id) return;
      pressTimer = setTimeout(function () {
        // задържане → влез в режим избор и маркирай това дърво
        pressTimer = null;
        mapSelect = true; dragging = true; mapSuppressClick = true;
        selectMapTree(id);
        if (navigator.vibrate) navigator.vibrate(20);
      }, 350);
    }
    function onMove(x, y) {
      // широк праг — пръстът леко мърда при натискане; само реално плъзгане да брои за скрол
      if (Math.abs(x - startX) > 24 || Math.abs(y - startY) > 24) moved = true;
      if (!dragging) {
        // ако се движи осезаемо преди задържането да е сработило — това е скрол, отмени
        if (moved && pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        return;
      }
      var id = cellIdAt(x, y);
      if (id) { selectMapTree(id); mapSuppressClick = true; }
    }
    function onUp() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      dragging = false;
      // ако не последва клик (напр. след влачене) — освободи флага след малко
      if (mapSuppressClick) setTimeout(function () { mapSuppressClick = false; }, 350);
    }

    mw.addEventListener('touchstart', function (e) {
      if (e.touches.length >= 2) {
        // два пръста = жест за зуум → отмени задържането и не маркирай/отваряй дърво
        pinching = true;
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        dragging = false; mapSuppressClick = true;
        return;
      }
      if (pinching) return;
      var t = e.touches[0]; onDown(t.clientX, t.clientY, cellIdAt(t.clientX, t.clientY));
    }, { passive: true });
    mw.addEventListener('touchmove', function (e) {
      if (pinching || e.touches.length >= 2) return;
      var t = e.touches[0];
      if (dragging) e.preventDefault(); // спри скрола докато влачим за избор
      onMove(t.clientX, t.clientY);
    }, { passive: false });
    mw.addEventListener('touchend', function (e) {
      if (pinching) {
        // изчакай всички пръсти да се вдигнат, после пусни жеста и потисни клика
        if (e.touches.length === 0) {
          pinching = false;
          mapSuppressClick = true;
          setTimeout(function () { mapSuppressClick = false; }, 400);
        }
        return;
      }
      onUp();
    });
    // ВАЖНО: не слушаме touchcancel — на iOS той се вдига спорадично и убиваше задържането
    // мишка (за тест на компютър)
    mw.addEventListener('mousedown', function (e) { onDown(e.clientX, e.clientY, cellIdAt(e.clientX, e.clientY)); });
    mw.addEventListener('mousemove', function (e) { if (e.buttons) onMove(e.clientX, e.clientY); });
    mw.addEventListener('mouseup', onUp);
    mw.addEventListener('mouseleave', onUp);
  }

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
      case 'mapclear': clearMapSelect(); render(); break;
      case 'mapselecttoggle':
        if (mapSelect || mapSelected.length) clearMapSelect(); else mapSelect = true;
        render(); break;
      case 'mapmode': mapMode = (parts[1] === 'harvest' ? 'harvest' : 'health'); try { localStorage.setItem(MAP_MODE_KEY, mapMode); } catch (e) {} render(); break;
      case 'statperiod': toggleStatPeriod(); break;
      case 'statbreak': showHarvestBreakdown(); break;
      case 'statclear': harvestHL = null; render(); break;
      case 'treeedit': { var te = tree(parts[1]); treeEditBefore = te ? { id: te.id, health: te.health, varietyId: te.varietyId, note: te.note, height: te.height } : null; sheetTreeEdit(parts[1]); break; }
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

      case 'editschema': if (isAdmin()) { editMode = !editMode; render(); } break;
      case 'addtree': sheetAddTree(parts[1], parseInt(parts[2], 10)); break;
      case 'savenewtree': saveNewTree(parts[1], parseInt(parts[2], 10)); break;
      case 'edittree': sheetEditTree(parts[1]); break;
      case 'movetree': moveTree(parts[1], parts[2]); break;
      case 'deltree': deleteTree(parts[1]); break;

      case 'editzone': sheetEditZone(parts[1]); break;
      case 'movezone': moveZone(parts[1], parts[2]); break;
      case 'sizezone': sizeZone(parts[1], parts[2]); break;
      case 'renamezone': renameZone(parts[1]); break;
      case 'addzone': addZone(); break;
      case 'delzone': deleteZone(parts[1]); break;

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
      case 'react': toggleReaction(parts[1]); break;

      case 'newsale': sheetNewSale(); break;
      case 'newsalefor': sheetNewSale(parts[1]); break;
      case 'savesale': saveSale(); break;
      case 'newbuyer': sheetNewBuyer(); break;
      case 'savebuyer': saveBuyer(); break;
      case 'editbuyer': sheetEditBuyer(parts[1]); break;
      case 'saveeditbuyer': saveEditBuyer(parts[1]); break;
      case 'delbuyer': deleteBuyer(parts[1]); break;
      case 'buyer': go('buyer', parts[1]); break;

      case 'savebuckets': saveBuckets(); break;
      case 'savecalc': saveCalc(); break;
      case 'saveshellyield': saveShellYield(); break;
      case 'saveshelled': saveShelledToday(); break;
      case 'clearshelled': clearShelledToday(); break;
      case 'kernel': showKernel(); break;
      case 'addclean': addCleanEntry(); break;

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
    db.currentUserId = id; save(); go('home');
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
    if (u && u.pass === DB.hashPw(pass)) { db.currentUserId = id; save(); closeSheet(); go('home'); }
    else { var er = el('admErr'); if (er) er.classList.remove('hidden'); }
  }

  function doRegister() {
    var name = (el('newName').value || '').trim();
    if (!name) { el('newName').focus(); return; }
    var u = { id: DB.uid('u'), name: name, role: 'worker' };  // нови = работници
    db.users.push(u); db.currentUserId = u.id; save(); go('home');
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
      '<div class="field"><label>Премести</label><div class="move-pad">' +
      '<span class="sp"></span><button data-action="movetree:' + id + ':up">↑</button><span class="sp"></span>' +
      '<button data-action="movetree:' + id + ':left">←</button><span class="sp"></span><button data-action="movetree:' + id + ':right">→</button>' +
      '<span class="sp"></span><button data-action="movetree:' + id + ':down">↓</button><span class="sp"></span>' +
      '</div></div>' +
      '<button class="btn" data-action="savetree:' + id + '">💾 Запази</button>' +
      '<button class="btn danger mt" data-action="deltree:' + id + '">🗑️ Изтрий дървото</button>' +
      '<button class="btn ghost mt" data-action="closesheet">Отказ</button>');
  }
  function occupied(row, col, exceptId) {
    return db.trees.some(function (t) { return !t.deletedAt && t.row === row && t.col === col && t.id !== exceptId; });
  }
  function moveTree(id, dir) {
    var t = tree(id); if (!t) return;
    var order = DB.ROW_LETTERS, ri = order.indexOf(t.row);
    var nr = t.row, nc = t.col;
    if (dir === 'left') nc = Math.max(1, t.col - 1);
    else if (dir === 'right') nc = Math.min(9, t.col + 1);
    else if (dir === 'up') nr = order[Math.max(0, ri - 1)] || t.row;
    else if (dir === 'down') nr = order[ri + 1] || t.row;
    if ((nr !== t.row || nc !== t.col) && !occupied(nr, nc, id)) { t.row = nr; t.col = nc; save(); }
    sheetEditTree(id);
    updateMap();
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
      '<button class="btn ghost mt" data-action="closesheet">Готово</button>');
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
    var before = (treeEditBefore && treeEditBefore.id === id) ? treeEditBefore : { health: t.health, varietyId: t.varietyId, note: t.note, height: t.height };
    // формата „Състояние“ (sheetTreeEdit): etVar/etNote; редакторът на схемата (sheetEditTree): etCode/etVar2/etHealth2
    var varEl = el('etVar'), noteEl = el('etNote'), codeEl = el('etCode'), var2El = el('etVar2'), health2El = el('etHealth2'), heightEl = el('etHeight');
    if (varEl) t.varietyId = varEl.value;
    if (noteEl) t.note = noteEl.value;
    if (heightEl) t.height = heightEl.value === '' ? null : parseFloat(heightEl.value);
    if (var2El) t.varietyId = var2El.value;
    if (health2El) t.health = health2El.value;
    if (codeEl) t.code = (codeEl.value || t.code).trim();
    var changes = {};
    if (before.health !== t.health) changes.health = { before: before.health, after: t.health };
    if (before.varietyId !== t.varietyId) changes.varietyId = { before: before.varietyId, after: t.varietyId };
    if ((before.note || '') !== (t.note || '')) changes.note = { before: before.note || '', after: t.note || '' };
    if ((before.height == null ? '' : before.height) !== (t.height == null ? '' : t.height)) changes.height = { before: before.height == null ? '' : before.height, after: t.height == null ? '' : t.height };
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
  function openLightbox(src) {
    var lb = document.getElementById('lightbox');
    if (!lb) { lb = document.createElement('div'); lb.id = 'lightbox'; document.body.appendChild(lb); }
    lb.innerHTML = '<button class="lb-close" aria-label="Затвори">✕</button>' +
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
    var span = el('cnt_' + key);
    if (span) span.textContent = harvestDraft[key]._count;
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
    render();
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
    document.querySelectorAll('[data-bkg]').forEach(function (inp) {
      var p = inp.getAttribute('data-bkg').split(':');
      var b = bucket(p[1]); if (!b) return;
      var val = parseFloat(inp.value) || 0;
      if (p[0] === 'green') b.greenKg = val;
      else if (p[0] === 'shelled') b.shelledKg = val;
      else if (p[0] === 'clean') b.cleanKg = val;
      else if (p[0] === 'liters') { b.liters = val; b.capacityNote = '≈ ' + val + ' л'; }
    });
    save(); alert('Запазено!');
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
      return '<div class="list-row"><div class="ic harvest">🌰</div>' +
        '<div class="tx"><b>' + fmtKg(e.kg) + ' кг</b><small>изчистена ядка' + (who ? ' · ' + esc(who.name) : '') + '</small></div>' +
        '<div class="meta">' + fmtDate(e.date) +
        (isAdmin() ? '<div><button class="btn sm ghost danger" style="margin-top:6px;height:30px;border-color:#f3c9c6;color:#b23a33" data-action="del:' + e.id + '">Изтрий</button></div>' : '') +
        '</div></div>';
    }).join('') : '<p class="muted">Още няма въведени изчистени.</p>';
    openSheet('<h3>🌰 Изчистена ядка (рандеман)</h3>' +
      '<p class="muted mb" style="font-size:13px">Очакваното се смята от събраните обелени (с черупка) × рандеман <b>' + Math.round(kernelYield() * 100) + '%</b> (от калкулатора в Настройки).</p>' +
      '<div class="card">' +
      '<div class="kv"><span class="k">Очаквано</span><span class="v"><b>' + fmtKg(ks.expected) + ' кг</b></span></div>' +
      '<div class="kv"><span class="k">Изчистено досега</span><span class="v"><b>' + fmtKg(ks.actual) + ' кг</b></span></div>' +
      '<div class="kv"><span class="k">Остават</span><span class="v"><b>' + fmtKg(ks.remaining) + ' кг</b></span></div>' +
      '<div class="kprog" style="margin-top:10px"><div class="kprog-fill" style="width:' + pct + '%"></div></div>' +
      '</div>' +
      '<div class="section-title">Добави изчистени</div>' +
      '<div class="card">' +
      '<p class="muted" style="font-size:12px;margin:0 0 8px">Като изчистиш още, въведи колко кг чиста ядка добавяш. Бройката „изчистено" расте и остатъкът намалява.</p>' +
      '<div class="field"><label>Колко кг изчистена ядка добавяш</label><input id="clKg" class="input" type="number" step="0.1" min="0" inputmode="decimal"/></div>' +
      '<button class="btn secondary" data-action="addclean">➕ Добави към изчистените</button>' +
      '</div>' +
      '<div class="section-title">Въведени досега</div>' +
      '<div class="card">' + list + '</div>' +
      '<button class="btn ghost mt" data-action="closesheet">Затвори</button>');
  }
  function addCleanEntry() {
    var v = parseFloat(el('clKg').value);
    if (!(v > 0)) { alert('Въведи кг по-голямо от 0.'); return; }
    addEvent({ type: 'clean', date: DB.todayISO(), kg: v });
    render(); showKernel();
  }

  function saveSale() {
    var kg = parseFloat(el('saleKg').value) || 0;
    var price = parseFloat(el('salePrice').value) || 0;
    var sale = { id: DB.uid('sale'), buyerId: el('saleBuyer').value, date: el('saleDate').value, kg: kg, pricePerKg: price, total: kg * price, note: el('saleNote').value, createdBy: db.currentUserId };
    db.sales.unshift(sale); save(); closeSheet(); go('sales');
  }
  function saveBuyer() {
    var name = (el('bName').value || '').trim(); if (!name) { el('bName').focus(); return; }
    db.buyers.push({ id: DB.uid('buy'), name: name, phone: fmtPhone(el('bPhone').value), note: el('bNote').value, createdAt: Date.now() });
    addEvent({ type: 'buyer_add', date: DB.todayISO(), note: name });
    closeSheet(); go('sales');
  }

  function saveEditBuyer(id) {
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    var name = (el('bName').value || '').trim(); if (!name) { el('bName').focus(); return; }
    b.name = name; b.phone = fmtPhone(el('bPhone').value); b.note = el('bNote').value;
    save(); closeSheet(); go('buyer', id);
  }

  function deleteBuyer(id) {
    if (!isAdmin()) return;
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    if (db.sales.some(function (s) { return s.buyerId === id; })) {
      alert('Този купувач има записани продажби и не може да се изтрие.');
      return;
    }
    if (!confirm('Да изтрия ли купувача „' + b.name + '"?')) return;
    db.buyers = db.buyers.filter(function (x) { return x.id !== id; });
    addEvent({ type: 'buyer_del', date: DB.todayISO(), note: b.name });
    closeSheet(); go('sales');
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
  try { history.replaceState({ route: route }, ''); } catch (err) {}
  applyZoom();
  render();
  startSync();
})();
