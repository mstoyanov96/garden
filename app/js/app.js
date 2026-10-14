/* =========================================================================
   app.js — Логика и изгледи на приложението (offline-first, роли, soft delete)
   ========================================================================= */
(function () {
  'use strict';

  var APP_VERSION = '1.10.6';   // ← при нова версия: увеличи тук И в service-worker.js (VERSION)
  var db = DB.load();
  var route = { name: 'login', param: null };
  var harvestDraft = {};   // { treeId: {bucketId: count} } за текущата сесия събиране
  var harvestMode = 'tree';
  var harvestRowFilter = ''; // филтър по ред на картата при събиране
  var harvestBucket = '';    // избрана кофа при събиране
  var harvestFill = 100;      // колко пълни са кофите (%) — общо за събиране
  var treeHarvestOpen = '';   // id на дърво с отворена вградена форма за събиране
  var treeDetailsOpen = false; // показани ли са подробните данни за дървото
  var careScope = 'all';    // 'all' | 'rows' | 'tree' — обхват на грижата
  var careRows = [];        // избрани редици (букви) когато careScope === 'rows'
  var careTreePreset = '';  // предварително избрано дърво при грижа от профила на дърво
  var walk = { watchId: null, orient: null, heading: null, pos: null, nearestId: null }; // режим „Разходка“
  var editMode = false;     // редактиране на схемата (само админ)

  // ---- Helpers -----------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function save() { DB.save(db); }
  function me() { return db.users.find(function (u) { return u.id === db.currentUserId; }) || null; }
  function isAdmin() { var m = me(); return m && m.role === 'admin'; }
  function isOwner() { var m = me(); return m && (m.isOwner || m.id === db.ownerId); }
  function initials(name) { return (name || '?').trim().split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase(); }
  function tree(id) { return db.trees.find(function (t) { return t.id === id; }); }
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
  function treeSVG(health) {
    var c = health === 'green' ? ['#4bb869', '#2f9e52', '#1f7a43']
      : health === 'yellow' ? ['#f6c65a', '#f3b53c', '#d9962a']
        : ['#ec726b', '#e4584f', '#c23e36'];
    return '<svg viewBox="0 0 64 64" width="100%" height="100%">' +
      '<rect x="29" y="42" width="6" height="16" rx="2" fill="#8a5a3b"/>' +
      '<circle cx="22" cy="30" r="14" fill="' + c[2] + '"/>' +
      '<circle cx="42" cy="30" r="14" fill="' + c[1] + '"/>' +
      '<circle cx="32" cy="20" r="15" fill="' + c[0] + '"/>' +
      '<circle cx="32" cy="30" r="13" fill="' + c[1] + '"/>' +
      '</svg>';
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
    save();
  }
  function restore(evId) {
    var e = db.events.find(function (x) { return x.id === evId; });
    if (!e) return;
    e.deletedAt = null; e.deletedBy = null; save();
  }

  // ---- Bucket math -------------------------------------------------------
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

  // =======================================================================
  //  NAVIGATION
  // =======================================================================
  function go(name, param) { if (route.name === 'walk' && name !== 'walk') stopWalk(); route = { name: name, param: param || null }; render(); window.scrollTo(0, 0); }

  // =======================================================================
  //  RENDER
  // =======================================================================
  function render() {
    var app = el('app');
    if (!db.currentUserId) { app.className = 'app'; app.innerHTML = viewLogin(); bind(); return; }
    app.className = 'app';
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
      ? '<button class="back" data-action="' + esc(opts.back) + '">‹</button>'
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
    var today = DB.todayISO();
    var todayKg = 0, todayBuckets = 0;
    activeEvents().filter(function (e) { return (e.type === 'harvest_tree' || e.type === 'harvest_ground') && e.date === today; })
      .forEach(function (e) { todayKg += eventKg(e); todayBuckets += eventBuckets(e); });

    return topbar('Орехова градина') + '<div class="content">' +
      '<div class="stat-row">' +
      '<div class="stat green"><b>' + todayBuckets + '</b><small>кофи днес</small></div>' +
      '<div class="stat blue"><b>' + Math.round(todayKg) + '</b><small>кг (зелени) днес</small></div>' +
      '<div class="stat plain"><b>' + counts.green + '</b><small>здрави дървета</small></div>' +
      '</div>' +

      '<div class="section-title title-row"><span class="tl">Карта на градината' +
      (isAdmin() ? ' <button class="iconbtn' + (editMode ? ' on' : '') + '" data-action="editschema" aria-label="Редактирай схемата">' + (editMode ? '✓' : '✏️') + '</button>' : '') +
      '</span>' +
      (editMode ? '' : '<button class="btn sm secondary walkbtn" data-action="nav:walk">🧭 Къде съм</button>') +
      '</div>' +
      (editMode ? '<div class="edit-bar">✏️ Режим редакция: докосни ➕ за ново дърво, дърво за да го местиш/триеш, или зона (Градина, Къща…) за да ѝ смениш мястото и размера.</div>' : '') +
      (editMode ? '<button class="btn secondary mb" data-action="addzone">➕ Добави зона</button>' : '') +
      (editMode ? '' : '<div class="map-toolbar">' +
        '<select class="input" id="fVar"><option value="">Всички сортове</option>' +
        db.settings.varieties.map(function (v) { return '<option value="' + v.id + '">' + esc(v.name) + '</option>'; }).join('') + '</select>' +
        '<select class="input" id="fHealth"><option value="">Всички състояния</option><option value="green">Здрави</option><option value="yellow">За грижа</option><option value="red">Болни</option></select>' +
        '</div>') +
      '<div class="mapwrap" id="mapwrap">' + orchardGrid('', '', editMode) + '</div>' +
      '<div class="legend">' +
      '<span><i class="dotc green"></i>Здраво (' + counts.green + ')</span>' +
      '<span><i class="dotc yellow"></i>За грижа (' + counts.yellow + ')</span>' +
      '<span><i class="dotc red"></i>Болно (' + counts.red + ')</span>' +
      '<span><i class="dotc" style="background:#7c5cff"></i>дребен сорт</span></div>' +

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

  function orchardGrid(fVar, fHealth, edit) {
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
          html += '<div class="tree-cell' + small + '" id="cell_' + t.id + '" data-action="' + act + '" style="grid-row:' + gr + ';grid-column:' + (2 * c) + ' / span 2;' + (dim ? 'opacity:.2' : '') + '">' +
            '<div class="svgwrap">' + treeSVG(t.health) + '</div><span class="code">' + esc(t.code) + '</span></div>';
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
    var lastPhoto = t.photos.length ? t.photos[t.photos.length - 1] : null;

    // снимки групирани по година+сезон
    var groups = {};
    t.photos.forEach(function (p) { var key = season(p.date) + ' ' + new Date(p.date).getFullYear(); (groups[key] = groups[key] || []).push(p); });

    var seasonKg = evs.filter(function (e) { return e.type === 'harvest_tree'; }).reduce(function (s, e) { return s + eventKg(e); }, 0);
    var gps = treeGPS(t);

    return topbar('Дърво ' + t.code, { back: 'nav:home' }) + '<div class="content">' +
      '<div class="card flush">' +
      (lastPhoto ? '<img class="detail-photo" src="' + lastPhoto.data + '" style="border-radius:0"/>' :
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
        '<div class="kv"><span class="k">🧺 Добив сезон</span><span class="v">' + Math.round(seasonKg) + ' кг</span></div>' +
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

      (t.photos.length ? '<div class="section-title">Снимки по сезони (' + t.photos.length + ')</div>' +
        Object.keys(groups).map(function (g) {
          return '<div class="card"><b>' + esc(g) + '</b><div style="display:flex;gap:8px;overflow:auto;margin-top:10px">' +
            groups[g].map(function (p) { return '<img src="' + p.data + '" style="width:90px;height:90px;border-radius:12px;object-fit:cover"/>'; }).join('') +
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
          '<b>' + esc(bk.name) + '</b><small>1 кофа ≈ ' + bk.greenKg + ' кг</small></button>';
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
    var todayBuckets = todayEvs.reduce(function (s, e) { return s + eventBuckets(e); }, 0);

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
          '<b>' + esc(b.name) + '</b><small>1 кофа ≈ ' + b.greenKg + ' кг</small></button>';
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
      body += '<div class="section-title">Орехи събрани от земята (зелени)</div>' +
        counterRow('ground', 'От земята', 'Зелени орехи', val);
    }

    body += '<div class="card mt" style="display:flex;justify-content:space-between;align-items:center">' +
      '<div><small class="muted">Днес събрано общо</small><div style="font-size:20px;font-weight:800">' +
      Math.round(todayKg) + ' кг · ' + todayBuckets + ' кофи</div></div>' +
      '<button class="btn sm" data-action="savehcurrent">Запази</button></div>';

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
    return '<div class="field"><label>Колко пълни бяха кофите?</label><div class="rowfilter">' +
      [100, 75, 50, 25, 10, 5].map(function (p) {
        return '<button class="' + (harvestFill === p ? 'active' : '') + '" data-action="hfill:' + p + '">' + (p === 100 ? 'Пълна' : p + '%') + '</button>';
      }).join('') + '</div>' +
      '<div class="stepper" style="margin-top:8px">' +
      '<button data-action="hfillstep:-5">−5%</button>' +
      '<span class="val" style="min-width:64px">' + harvestFill + '%</span>' +
      '<button data-action="hfillstep:5">+5%</button>' +
      '</div></div>';
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

    var body = topbar('Грижа за градината', { back: 'nav:home' }) + '<div class="content">' +
      '<div class="seg">' +
      '<button class="' + (careTab === 'fertilize' ? 'active' : '') + '" data-action="ctab:fertilize">🌱 Торене</button>' +
      '<button class="' + (careTab === 'water' ? 'active' : '') + '" data-action="ctab:water">💧 Поливане</button>' +
      '<button class="' + (careTab === 'mow' ? 'active' : '') + '" data-action="ctab:mow">🌾 Косене</button>' +
      '</div>';

    // --- избор на обхват: цялата градина / редици / едно дърво ---
    body += '<div class="field"><label>За кого е грижата?</label>' +
      '<button class="btn ' + (careScope === 'all' ? '' : 'secondary') + ' mb" data-action="cscope:all">' + (careScope === 'all' ? '✓ ' : '') + '🌳 Цялата градина</button>' +
      '<button class="btn ' + (careScope === 'rows' ? '' : 'secondary') + ' mb" data-action="cscope:rows">' + (careScope === 'rows' ? '✓ ' : '') + '🌿 Избрани редици</button>' +
      (careTab !== 'mow' ? '<button class="btn ' + (careScope === 'tree' ? '' : 'secondary') + '" data-action="cscope:tree">' + (careScope === 'tree' ? '✓ ' : '') + '🌲 Едно дърво</button>' : '') +
      '</div>';

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
      mow: { ic: '🌾', cls: 'mow', t: 'Косене' },
      photo: { ic: '📷', cls: 'sys', t: 'Снимка' },
      tree_edit: { ic: '⚙️', cls: 'sys', t: 'Промяна на дърво' },
      note: { ic: '📝', cls: 'sys', t: 'Бележка' }
    };
    var m = map[e.type] || { ic: '•', cls: 'sys', t: e.type };
    var who = db.users.find(function (u) { return u.id === e.createdBy; });
    var t = e.treeId ? tree(e.treeId) : null;
    var detail = '';
    if (e.type === 'harvest_tree' || e.type === 'harvest_ground') detail = eventBuckets(e) + ' кофи' + (e.fill != null && e.fill !== 100 ? ' (' + e.fill + '% пълни)' : '') + ' · ' + Math.round(eventKg(e)) + ' кг';
    else if (e.type === 'fertilize') detail = esc(e.what || '') + (e.qty ? ' · ' + e.qty + ' ' + esc(e.unit || '') : '');
    else if (e.type === 'water') detail = (e.qty || 0) + ' л';
    else if (e.type === 'mow') detail = 'окосено';
    else if (e.note) detail = esc(e.note);

    var onBehalf = e.onBehalfOf ? ' (от името на ' + esc(e.onBehalfOf) + ')' : '';
    var deleted = e.deletedAt;
    var scopeLbl = t ? ' · ' + esc(t.code) : (e.rows && e.rows.length ? ' · редове ' + esc(e.rows.join(', ')) : '');
    return '<div class="list-row"' + (deleted ? ' style="opacity:.5"' : '') + '>' +
      '<div class="ic ' + m.cls + '">' + m.ic + '</div>' +
      '<div class="tx"><b>' + m.t + scopeLbl + (deleted ? ' <span class="badge orange">изтрито</span>' : '') + '</b>' +
      '<small>' + detail + ' — ' + (who ? esc(who.name) : '?') + onBehalf + '</small></div>' +
      '<div class="meta">' + fmtDate(e.date) +
      (isAdmin() ? '<div>' + (deleted ? '<button class="btn sm ghost" style="margin-top:6px;height:30px" data-action="restore:' + e.id + '">Върни</button>'
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

    return topbar('Статистика', { back: 'nav:home' }) + '<div class="content">' +
      '<div class="stat-row">' +
      '<div class="stat green"><b>' + Math.round(totalKg) + '</b><small>общо събрани (кг)</small></div>' +
      '<div class="stat blue"><b>' + Math.round(soldKg) + '</b><small>продадени (кг)</small></div>' +
      '<div class="stat purple"><b>' + revenue.toFixed(0) + '</b><small>приходи (€)</small></div>' +
      '</div>' +
      '<div class="section-title">Добив по месеци — ' + year + ' (кг)</div>' +
      '<div class="card"><div class="bars">' +
      months.map(function (v) { return '<div class="b" style="height:' + Math.max(4, (v / maxM) * 100) + '%"></div>'; }).join('') +
      '</div><div class="barlabels">' + mLabels.map(function (l) { return '<span>' + l + '</span>'; }).join('') + '</div></div>' +

      '<div class="section-title">Най-доходоносни дървета</div>' +
      '<div class="card">' + (ranked.length ? ranked.map(function (r) {
        return '<div class="rank-row"><span class="nm">' + esc(r.t.code) + '</span>' +
          '<div class="track"><div class="fill" style="width:' + ((r.kg / maxR) * 100) + '%"></div></div>' +
          '<span class="kg">' + Math.round(r.kg) + ' кг</span></div>';
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
          '<div class="muted" style="font-size:12px">' + purchases.length + ' покупки · ' + Math.round(kg) + ' кг</div></div>' +
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
      (isAdmin() ? '<button class="btn sm secondary" data-action="editbuyer:' + b.id + '">✏️ Редактирай</button>' : '') + '</div>' +
      (b.note ? '<p class="mt">' + esc(b.note) + '</p>' : '') + '</div>' +
      '<div class="section-title">История на покупки</div>' +
      '<div class="card">' + (purchases.length ? purchases.map(function (s) {
        return '<div class="list-row"><div class="ic harvest">💰</div><div class="tx"><b>' + s.kg + ' кг · ' + (s.total || 0).toFixed(2) + ' €</b>' +
          '<small>' + (s.pricePerKg || 0) + ' €/кг' + (s.note ? ' · ' + esc(s.note) : '') + '</small></div>' +
          '<div class="meta">' + fmtDate(s.date) + '</div></div>';
      }).join('') : '<p class="muted">Още няма покупки.</p>') + '</div>' +
      '<button class="btn" data-action="newsalefor:' + b.id + '">➕ Добави продажба</button>' +
      '</div>';
  }

  // =======================================================================
  //  SETTINGS
  // =======================================================================
  function viewSettings() {
    var s = db.settings;
    return topbar('Настройки', { back: 'nav:home' }) + '<div class="content">' +
      '<details class="sect"><summary>🌰 Сортове орехи</summary><div class="sect-body">' +
      '<div class="card">' + s.varieties.map(function (v) {
        return '<div class="kv"><span class="k">' + (v.size === 'big' ? '🌰 Едри' : '🥜 Малки') + '</span><span class="v">' + esc(v.name) + ' — ' + esc(v.note) + '</span></div>';
      }).join('') + '</div>' +
      '</div></details>' +

      '<details class="sect"><summary>🪣 Кофи и тегло</summary><div class="sect-body">' +
      '<p class="muted mb" style="font-size:13px">Колко кг е 1 кофа — зелени / обелени с черупка / чиста ядка. (Обелените с черупка са винаги в кофата от сирене.)</p>' +
      db.settings.buckets.map(function (b) {
        return '<div class="card"><div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">' +
          '<div style="width:48px;height:48px;border-radius:12px;background:var(--green-soft);display:flex;align-items:center;justify-content:center;font-size:26px;overflow:hidden;padding:4px">' + bucketIcon(b) + '</div>' +
          '<div><b>' + esc(b.name) + '</b><div class="muted" style="font-size:13px">' + esc(b.capacityNote || '') + '</div></div></div>' +
          '<div class="field"><label>Вместимост (литри)</label><input class="input" type="number" value="' + (b.liters != null ? b.liters : '') + '" data-bkg="liters:' + b.id + '"/></div>' +
          '<div class="row"><div class="field"><label>Зелени (кг)</label><input class="input" type="number" value="' + b.greenKg + '" data-bkg="green:' + b.id + '"/></div>' +
          '<div class="field"><label>С черупка</label><input class="input" type="number" value="' + b.shelledKg + '" data-bkg="shelled:' + b.id + '"/></div>' +
          '<div class="field"><label>Чиста ядка</label><input class="input" type="number" value="' + b.cleanKg + '" data-bkg="clean:' + b.id + '"/></div></div></div>';
      }).join('') +
      '<button class="btn secondary mb" data-action="savebuckets">💾 Запази теглата на кофите</button>' +
      '</div></details>' +

      '<details class="sect"><summary>📐 Калкулатор за рандеман</summary><div class="sect-body">' +
      '<div class="card"><div class="row">' +
      '<div class="field"><label>Вход — сухи с черупка (кг)</label><input id="yin" class="input" type="number" value="' + s.yieldInputKg + '"/></div>' +
      '<div class="field"><label>Изход — чиста ядка (кг)</label><input id="yout" class="input" type="number" value="' + s.yieldOutputKg + '"/></div></div>' +
      '<div class="center" style="font-size:20px;font-weight:800;color:var(--green-dark)">Рандеман: ' +
      Math.round((s.yieldOutputKg / (s.yieldInputKg || 1)) * 100) + '%</div>' +
      '<button class="btn secondary mt" data-action="savecalc">Изчисли / Запази</button></div>' +
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

      '<div class="section-title">Версия и обновяване</div>' +
      '<div class="card">' +
      '<div class="kv"><span class="k">📱 Версия</span><span class="v">' + APP_VERSION + '</span></div>' +
      '<p class="muted" id="updState" style="font-size:13px;margin:10px 0">Натисни, за да провериш за нова версия.</p>' +
      '<button class="btn secondary" data-action="checkupdate">🔄 Провери за нова версия</button>' +
      '</div>' +

      '<button class="btn ghost mt" data-action="logout">🚪 Смени потребител</button>' +
      (isAdmin() ? '<button class="btn ghost mt" data-action="reset" style="border-color:#f3c9c6;color:#b23a33">🗑️ Нулирай всички данни</button>' : '') +
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
    // компас (посока на телефона) — със силно изглаждане срещу трептене в ръка
    walk.fx = null; walk.fy = null; walk.rot = 0; walk.shown = null;
    function onOrient(e) {
      var hd = (typeof e.webkitCompassHeading === 'number') ? e.webkitCompassHeading
        : (e.alpha != null ? (360 - e.alpha) : null);
      if (hd == null) return;
      var rad = hd * Math.PI / 180;
      if (walk.fx == null) { walk.fx = Math.cos(rad); walk.fy = Math.sin(rad); }
      else {
        // адаптивно изглаждане: при малка промяна (трептене в ръка) филтрираме силно,
        // при реално завъртане следваме бързо
        var cur = Math.atan2(walk.fy, walk.fx) * 180 / Math.PI; if (cur < 0) cur += 360;
        var diff = Math.abs(((hd - cur + 540) % 360) - 180); // 0..180
        var a = diff < 3 ? 0.03 : diff < 8 ? 0.08 : diff < 20 ? 0.2 : diff < 45 ? 0.4 : 0.6;
        walk.fx += a * (Math.cos(rad) - walk.fx);
        walk.fy += a * (Math.sin(rad) - walk.fy);
      }
      var sm = Math.atan2(walk.fy, walk.fx) * 180 / Math.PI;
      if (sm < 0) sm += 360;
      walk.heading = sm;
      // непрекъснато въртене по най-късия път (без скок при 359°→0°)
      var delta = sm - (walk.rot % 360);
      if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
      if (Math.abs(delta) < 2) return; // по-голяма мъртва зона срещу микро-трептене в ръка
      walk.rot += delta;
      var needle = el('walkNeedle'), txt = el('walkHeading');
      if (needle) needle.style.transform = 'rotate(' + walk.rot.toFixed(1) + 'deg)';
      // текстът се обновява само при осезаема промяна (>=3°), за да не мига числото
      var shownDeg = Math.round(sm);
      if (txt && (walk.shown == null || Math.abs(((shownDeg - walk.shown + 540) % 360) - 180) >= 3)) {
        walk.shown = shownDeg;
        txt.textContent = shownDeg + '° ' + compassName(sm);
      }
    }
    walk.orient = onOrient;
    function attachOrient() {
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
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
    if (walk.orient) {
      window.removeEventListener('deviceorientationabsolute', walk.orient, true);
      window.removeEventListener('deviceorientation', walk.orient, true);
    }
    walk.watchId = null; walk.orient = null; walk.nearestId = null;
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
    var mw = el('mapwrap');
    if (mw) mw.innerHTML = orchardGrid(el('fVar') ? el('fVar').value : '', el('fHealth') ? el('fHealth').value : '', editMode);
  }

  document.addEventListener('click', function (e) {
    var node = e.target.closest('[data-action]');
    if (!node) return;
    var action = node.getAttribute('data-action');
    var parts = action.split(':');
    var cmd = parts[0];

    switch (cmd) {
      case 'nav': go(parts[1]); break;
      case 'login': tryLogin(parts[1]); break;
      case 'loginadmin': doAdminLogin(parts[1]); break;
      case 'register': doRegister(); break;
      case 'logout': db.currentUserId = null; save(); render(); break;
      case 'settings': go('settings'); break;
      case 'reset': if (isAdmin() && confirm('Да нулирам ли ВСИЧКИ данни? Това не може да се върне.')) { db = DB.reset(); editMode = false; go('login'); } break;

      case 'tree': treeHarvestOpen = ''; treeDetailsOpen = false; go('tree', parts[1]); break;
      case 'treeedit': sheetTreeEdit(parts[1]); break;
      case 'treeharvest': treeHarvestOpen = (treeHarvestOpen === parts[1] ? '' : parts[1]); render(); if (treeHarvestOpen) scrollToEl('treeHarvestForm'); break;
      case 'treedetails': treeDetailsOpen = !treeDetailsOpen; render(); if (treeDetailsOpen) scrollToEl('treeDetails'); break;
      case 'treeharvestcancel': treeHarvestOpen = ''; render(); break;
      case 'savetreeharvestinline': saveTreeHarvestInline(parts[1]); break;
      case 'treecare': careTab = parts[1]; careScope = 'tree'; careTreePreset = parts[2]; go('care'); break;
      case 'savetree': saveTreeEdit(parts[1]); break;
      case 'savegps': saveGps(parts[1]); break;
      case 'sethealth': setHealth(parts[1], parts[2]); break;
      case 'addphoto': addPhoto(parts[1]); break;

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
      case 'cscope': careScope = parts[1]; render(); break;
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

      case 'del': if (isAdmin() && confirm('Да изтрия ли записа? Ще се пази в историята.')) { softDelete(parts[1]); render(); } break;
      case 'restore': if (isAdmin()) { restore(parts[1]); render(); } break;

      case 'newsale': sheetNewSale(); break;
      case 'newsalefor': sheetNewSale(parts[1]); break;
      case 'savesale': saveSale(); break;
      case 'newbuyer': sheetNewBuyer(); break;
      case 'savebuyer': saveBuyer(); break;
      case 'editbuyer': if (isAdmin()) sheetEditBuyer(parts[1]); break;
      case 'saveeditbuyer': saveEditBuyer(parts[1]); break;
      case 'delbuyer': deleteBuyer(parts[1]); break;
      case 'buyer': go('buyer', parts[1]); break;

      case 'savebuckets': saveBuckets(); break;
      case 'savecalc': saveCalc(); break;

      case 'promote': sheetPromote(parts[1]); break;
      case 'dopromote': doPromote(parts[1]); break;
      case 'demote': doDemote(parts[1]); break;
      case 'setpass': sheetSetPass(parts[1]); break;
      case 'dosetpass': doSetPass(parts[1]); break;
      case 'deluser': doDelUser(parts[1]); break;
      case 'changemypass': sheetSetPass(db.currentUserId); break;

      case 'checkupdate': checkForUpdate(); break;
      case 'applyupdate': applyUpdate(); break;

      case 'closesheet': closeSheet(); break;
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
  function saveTreeEdit(id) {
    var t = tree(id); if (!t) return;
    t.varietyId = el('etVar').value;
    t.note = el('etNote').value;
    save();
    addEvent({ type: 'tree_edit', treeId: id, date: DB.todayISO(), note: 'състояние: ' + healthLabel(t.health) });
    closeSheet(); go('tree', id);
  }

  function addPhoto(id) {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
    input.onchange = function () {
      var f = input.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var t = tree(id);
        var photo = { id: DB.uid('ph'), data: reader.result, date: DB.todayISO() };
        t.photos.push(photo);
        addEvent({ type: 'photo', treeId: id, date: photo.date, note: 'добавена снимка' });
        go('tree', id);
      };
      reader.readAsDataURL(f);
    };
    input.click();
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
        addEvent({ type: 'harvest_ground', date: date, state: 'green', buckets: buckets, fill: harvestFill });
      } else {
        addEvent({ type: 'harvest_tree', treeId: key, date: date, state: 'green', buckets: buckets, fill: harvestFill });
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
    addEvent({ type: 'harvest_tree', treeId: id, date: date, state: 'green', buckets: buckets, fill: harvestFill });
    delete harvestDraft[id];
    treeHarvestOpen = '';
    render();
  }

  function saveGps(id) {
    var t = tree(id); if (!t) return;
    if (!navigator.geolocation) { alert('Телефонът не поддържа GPS.'); return; }
    alert('Застани до дървото и натисни OK. Изчакай координатите...');
    navigator.geolocation.getCurrentPosition(function (pos) {
      t.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy || 0), ts: Date.now() };
      save();
      addEvent({ type: 'tree_edit', treeId: t.id, date: DB.todayISO(), note: 'записани GPS координати (±' + t.gps.acc + ' м)' });
      alert('Записано! Точност ±' + t.gps.acc + ' м.');
      render();
    }, function (err) {
      alert('Няма достъп до GPS: ' + (err && err.message ? err.message : 'разреши местоположение в браузъра.'));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function saveCare(type) {
    var date = el('cdate').value;
    var note = el('cnote') ? el('cnote').value : '';
    // определи обхвата: цялата градина / редици / едно дърво
    var treeId = null, rows = null;
    if (careScope === 'tree') {
      treeId = el('ctree') ? el('ctree').value : '';
      if (!treeId) { alert('Избери дърво.'); return; }
    } else if (careScope === 'rows') {
      if (!careRows.length) { alert('Избери поне една редица.'); return; }
      rows = careRows.slice();
    }
    var base = { date: date, note: note };
    if (treeId) base.treeId = treeId;
    if (rows) base.rows = rows;

    if (type === 'fertilize') {
      base.type = 'fertilize'; base.what = el('cwhat').value;
      base.qty = parseFloat(el('cqty').value) || 0; base.unit = el('cunit').value;
      addEvent(base);
    } else if (type === 'water') {
      base.type = 'water'; base.qty = parseFloat(el('cqty').value) || 0; base.unit = 'л';
      addEvent(base);
    } else {
      base.type = 'mow'; addEvent(base);
    }
    alert('Записано!'); go('home');
  }

  function saveBuckets() {
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
    db.settings.yieldInputKg = parseFloat(el('yin').value) || 0;
    db.settings.yieldOutputKg = parseFloat(el('yout').value) || 0;
    save(); render();
  }

  function saveSale() {
    var kg = parseFloat(el('saleKg').value) || 0;
    var price = parseFloat(el('salePrice').value) || 0;
    var sale = { id: DB.uid('sale'), buyerId: el('saleBuyer').value, date: el('saleDate').value, kg: kg, pricePerKg: price, total: kg * price, note: el('saleNote').value, createdBy: db.currentUserId };
    db.sales.unshift(sale); save(); closeSheet(); go('sales');
  }
  function saveBuyer() {
    var name = (el('bName').value || '').trim(); if (!name) { el('bName').focus(); return; }
    db.buyers.push({ id: DB.uid('buy'), name: name, phone: el('bPhone').value, note: el('bNote').value, createdAt: Date.now() });
    save(); closeSheet(); go('sales');
  }

  function saveEditBuyer(id) {
    if (!isAdmin()) return;
    var b = db.buyers.find(function (x) { return x.id === id; }); if (!b) return;
    var name = (el('bName').value || '').trim(); if (!name) { el('bName').focus(); return; }
    b.name = name; b.phone = el('bPhone').value; b.note = el('bNote').value;
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
    save(); closeSheet(); go('sales');
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

  render();
})();
