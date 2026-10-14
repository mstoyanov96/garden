/* =========================================================================
   data.js — Локално хранилище (offline-first) + seed данни
   Всичко се пази в localStorage под един ключ. По-късно се добавя облачна
   синхронизация, като се пази същата структура.
   ========================================================================= */
(function (global) {
  'use strict';

  var DB_KEY = 'walnut_db_v4';

  var ROW_LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К', 'Л', 'М', 'Н', 'О', 'П', 'Р', 'С', 'Т'];
  var COLS = 9;

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  // Прост hash за пароли (не е силна криптография — локално приложение).
  function hashPw(s) {
    var h = 5381;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h = h & 0xffffffff; }
    return (h >>> 0).toString(36);
  }

  function todayISO() {
    var d = new Date();
    return d.toISOString().slice(0, 10);
  }

  // Декоративни зони на картата (координати в grid-линии: r=ред, c=полу-колона).
  function defaultZones() {
    return [
      { id: 'z_g1', kind: 'garden', emoji: '🥬', label: 'Градина', r: 2, rs: 3, c: 8, cs: 6 },
      { id: 'z_house', kind: 'house', emoji: '🏠', label: 'Къща', r: 2, rs: 2, c: 14, cs: 6 },
      { id: 'z_g2', kind: 'garden', emoji: '🥬', label: 'Градина', r: 4, rs: 2, c: 14, cs: 6 },
      { id: 'z_coop', kind: 'coop', emoji: '🐔', label: 'Кокошки', r: 6, rs: 1, c: 14, cs: 3 },
      { id: 'z_dog', kind: 'dog', emoji: '🐕', label: 'Джари', r: 6, rs: 1, c: 17, cs: 3 }
    ];
  }

  // ---- Seed ---------------------------------------------------------------
  function seed() {
    var varieties = [
      { id: 'var_chandler', name: 'Чандлър', size: 'big', note: 'Големи орехи' },
      { id: 'var_opr', name: 'Опрашител', size: 'small', note: 'Малки орехи' }
    ];

    var buckets = [
      { id: 'buc_cheese', name: 'Кофа от сирене', capacityNote: '≈ 10 л', liters: 10, photo: 'assets/bucket_cheese.png', greenKg: 10, shelledKg: 8, cleanKg: 6 },
      { id: 'buc_black', name: 'Черна кофа', capacityNote: '≈ 8 л', liters: 8, photo: 'assets/bucket_black.png', greenKg: 8, shelledKg: 6, cleanKg: 4 },
      { id: 'buc_small', name: 'Малка кофа', capacityNote: '≈ 4 л', liters: 4, photo: 'assets/bucket_round.png', greenKg: 4, shelledKg: 3, cleanKg: 2 }
    ];

    // Първият администратор (стопанин). Само той прави други админи.
    var users = [
      { id: 'u_admin', name: 'Martin', role: 'admin', isOwner: true, pass: hashPw('870065') },
      { id: 'u_tarkan', name: 'Таркан', role: 'worker' },
      { id: 'u_darin', name: 'Дарин', role: 'worker' }
    ];

    // Реална схема: 75 ореха. Брой по редове и колони за подреждане
    // (къща/градина горе дясно; долу се стеснява заради агловия път).
    var layout = [
      { letter: 'А', cols: [1, 2, 3] },
      { letter: 'Б', cols: [1, 2, 3] },
      { letter: 'В', cols: [1, 2, 3] },
      { letter: 'Г', cols: [1, 2, 3, 4, 5, 6] },
      { letter: 'Д', cols: [1, 2, 3, 4, 5, 6] },
      { letter: 'Е', cols: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { letter: 'Ж', cols: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { letter: 'З', cols: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { letter: 'И', cols: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { letter: 'К', cols: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { letter: 'Л', cols: [3, 4, 5, 6, 7, 8, 9] },
      { letter: 'М', cols: [8, 9] }
    ];
    var trees = [];
    layout.forEach(function (rowDef) {
      rowDef.cols.forEach(function (c, idx) {
        trees.push({
          id: uid('tree'),
          code: rowDef.letter + (idx + 1),
          row: rowDef.letter,
          col: c,
          varietyId: 'var_chandler',
          health: 'green',
          plantedAt: '2020-03-15',
          gps: '',
          note: '',
          photos: [],
          deletedAt: null,
          deletedBy: null
        });
      });
    });

    var buyers = [
      { id: 'buy_1', name: 'Петър Димитров', phone: '+359 888 123 456', note: 'Редовен клиент, взима на едро.', createdAt: Date.now() },
      { id: 'buy_2', name: 'Мария Иванова', phone: '+359 899 987 654', note: '', createdAt: Date.now() }
    ];

    return {
      version: 2,
      createdAt: Date.now(),
      currentUserId: null,
      ownerId: 'u_admin',
      settings: {
        orchardName: 'Орехова градина',
        seasonYear: new Date().getFullYear(),
        varieties: varieties,
        buckets: buckets,
        yieldInputKg: 10,     // вход за рандеман (сухи с черупка)
        yieldOutputKg: 4.8,   // изход (чиста ядка)
        zones: defaultZones()
      },
      users: users,
      trees: trees,
      events: [],             // уеднаквен дневник: water/fertilize/harvest_tree/harvest_ground/mow/photo/note/tree_edit
      photos: [],             // снимките са отделни записи (всяка → собствен документ в облака, за да не се превишава лимитът)
      buyers: buyers,
      sales: []
    };
  }

  // ---- Load / Save --------------------------------------------------------
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(DB_KEY); } catch (e) {}
    if (!raw) {
      var fresh = seed();
      save(fresh);
      return fresh;
    }
    var db;
    try { db = JSON.parse(raw); } catch (e) { var f = seed(); save(f); return f; }
    // миграции за стари инсталации (пазим съществуващите данни)
    if (db.settings && !db.settings.zones) { db.settings.zones = defaultZones(); save(db); }
    if (!db.photos) { db.photos = []; save(db); }
    return db;
  }

  // Гарантира, че db.photos съществува. НЕ мести/трие стари снимки от tree.photos —
  // те се четат заедно с новите, за да не се губят при синхронизация.
  function migratePhotos(db) {
    if (!db.photos) { db.photos = []; return true; }
    return false;
  }

  function save(db) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {}
  }

  function reset() {
    try { localStorage.removeItem(DB_KEY); } catch (e) {}
    return load();
  }

  global.DB = {
    KEY: DB_KEY,
    ROW_LETTERS: ROW_LETTERS,
    COLS: COLS,
    uid: uid,
    hashPw: hashPw,
    todayISO: todayISO,
    load: load,
    save: save,
    reset: reset,
    seed: seed,
    defaultZones: defaultZones,
    migratePhotos: migratePhotos
  };
})(window);
