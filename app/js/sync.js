/* =========================================================================
   sync.js — Облачна синхронизация (Firebase Firestore), offline-first.
   -------------------------------------------------------------------------
   • Обща база за всички: trees / events / buyers / sales / users + settings.
   • Всеки запис е отделен документ (по id) → добавянията от различни хора се
     сливат автоматично, без да се „бият".
   • Offline: записите се трупат локално и се качват щом има интернет
     (Firestore IndexedDB persistence).
   • Ако няма валидна конфигурация или SDK — приложението работи само локално.
   ========================================================================= */
(function (global) {
  'use strict';

  var COLLECTIONS = ['trees', 'events', 'buyers', 'sales', 'users'];
  var CHUNK = 450; // Firestore batch лимит е 500

  var S = {
    ready: false,
    fs: null,
    auth: null,
    shadow: {},            // collection -> { id -> jsonString } (последно синхронизирано)
    settingsShadow: null,
    pushTimer: null,
    getLocal: null,        // () => текущия app db обект
    onInitialLoad: null,   // (cloudData) => замести локалните данни
    onRemote: null,        // () => презапиши локално + пре-рендер
    setStatus: function () {}
  };

  function log() { try { if (global.console) console.log.apply(console, arguments); } catch (e) {} }
  function jsonOf(o) { try { return JSON.stringify(o); } catch (e) { return ''; } }

  function cfgValid(cfg) {
    return !!(cfg && cfg.apiKey && cfg.projectId &&
      cfg.apiKey.indexOf('PASTE') === -1 && cfg.projectId.indexOf('PASTE') === -1);
  }

  function col(name) { return S.fs.collection(name); }
  function docRef(name, id) { return S.fs.collection(name).doc(id); }

  // Записва масив от операции на части (заобикаля лимита от 500 за batch).
  function commitOps(ops) {
    var chunks = [];
    for (var i = 0; i < ops.length; i += CHUNK) chunks.push(ops.slice(i, i + CHUNK));
    return chunks.reduce(function (p, chunk) {
      return p.then(function () {
        var b = S.fs.batch();
        chunk.forEach(function (o) { if (o.del) b.delete(o.ref); else b.set(o.ref, o.data); });
        return b.commit();
      });
    }, Promise.resolve());
  }

  function buildShadow(db) {
    S.shadow = {};
    COLLECTIONS.forEach(function (c) {
      S.shadow[c] = {};
      (db[c] || []).forEach(function (it) { if (it && it.id) S.shadow[c][it.id] = jsonOf(it); });
    });
    S.settingsShadow = jsonOf(db.settings || {});
  }

  function uploadAll(db) {
    var ops = [];
    COLLECTIONS.forEach(function (c) {
      (db[c] || []).forEach(function (it) { if (it && it.id) ops.push({ ref: docRef(c, it.id), data: it }); });
    });
    ops.push({ ref: docRef('settings', 'main'), data: db.settings || {} });
    return commitOps(ops);
  }

  function downloadAll() {
    var out = { settings: null };
    COLLECTIONS.forEach(function (c) { out[c] = []; });
    var tasks = COLLECTIONS.map(function (c) {
      return col(c).get().then(function (qs) { qs.forEach(function (d) { out[c].push(d.data()); }); });
    });
    tasks.push(docRef('settings', 'main').get().then(function (d) { if (d.exists) out.settings = d.data(); }));
    return Promise.all(tasks).then(function () { return out; });
  }

  // --- прилагане на отдалечени промени върху живия db обект ---------------
  function applyUpsert(c, item) {
    var db = S.getLocal(); if (!db) return;
    var arr = db[c] || (db[c] = []);
    var i = arr.findIndex(function (x) { return x.id === item.id; });
    if (i === -1) arr.unshift(item); else arr[i] = item;
  }
  function applyRemove(c, id) {
    var db = S.getLocal(); if (!db || !db[c]) return;
    var i = db[c].findIndex(function (x) { return x.id === id; });
    if (i !== -1) db[c].splice(i, 1);
  }

  function attachListeners() {
    COLLECTIONS.forEach(function (c) {
      col(c).onSnapshot(function (qs) {
        var changed = false;
        qs.docChanges().forEach(function (ch) {
          var id = ch.doc.id, data = ch.doc.data(), js = jsonOf(data);
          if (!S.shadow[c]) S.shadow[c] = {};
          if (ch.type === 'removed') {
            if (S.shadow[c][id] !== undefined) { delete S.shadow[c][id]; applyRemove(c, id); changed = true; }
          } else {
            if (S.shadow[c][id] === js) return; // собствено ехо / без промяна
            S.shadow[c][id] = js; applyUpsert(c, data); changed = true;
          }
        });
        if (changed && S.onRemote) S.onRemote();
      }, function (err) { log('sync snapshot err', c, err); });
    });

    docRef('settings', 'main').onSnapshot(function (d) {
      if (!d.exists) return;
      var data = d.data(), js = jsonOf(data);
      if (S.settingsShadow === js) return;
      S.settingsShadow = js;
      var db = S.getLocal(); if (db) db.settings = data;
      if (S.onRemote) S.onRemote();
    });
  }

  function bootstrap() {
    S.setStatus('connecting');
    var meta = docRef('meta', 'main');
    meta.get().then(function (snap) {
      if (!snap.exists || !snap.data().initialized) {
        // Облакът е празен → данните на ТОЗИ телефон стават общи (качваме ги).
        return uploadAll(S.getLocal())
          .then(function () { return meta.set({ initialized: true, at: Date.now() }); })
          .then(function () { buildShadow(S.getLocal()); });
      }
      // Облакът вече има данни → приемаме тях (заместваме локалните).
      return downloadAll().then(function (cloud) {
        if (S.onInitialLoad) S.onInitialLoad(cloud);
        buildShadow(S.getLocal());
      });
    }).then(function () {
      attachListeners();
      S.ready = true;
      S.setStatus('on');
    }).catch(function (err) {
      log('sync bootstrap err', err);
      S.setStatus('error');
    });
  }

  // --- публично API -------------------------------------------------------
  function init(opts) {
    var cfg = global.FIREBASE_CONFIG;
    if (!cfgValid(cfg)) { S.setStatus = opts.setStatus || S.setStatus; S.setStatus('off'); log('Sync: няма конфигурация — локален режим.'); return false; }
    if (!global.firebase || !global.firebase.firestore) { (opts.setStatus || function () {})('off'); log('Sync: Firebase SDK липсва.'); return false; }

    S.getLocal = opts.getLocalDb;
    S.onInitialLoad = opts.onInitialLoad;
    S.onRemote = opts.onRemote;
    S.setStatus = opts.setStatus || S.setStatus;

    try { global.firebase.initializeApp(cfg); } catch (e) {}
    S.fs = global.firebase.firestore();
    try { S.fs.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (e) {}
    S.auth = global.firebase.auth();

    S.setStatus('connecting');
    S.auth.signInAnonymously().then(bootstrap).catch(function (err) {
      log('sync auth err', err); S.setStatus('error');
    });
    return true;
  }

  function push() {
    if (!S.ready || S.pushTimer) return;
    S.pushTimer = setTimeout(function () {
      S.pushTimer = null;
      var db = S.getLocal(); if (!db) return;
      var ops = [];
      COLLECTIONS.forEach(function (c) {
        var sh = S.shadow[c] || (S.shadow[c] = {}), seen = {};
        (db[c] || []).forEach(function (it) {
          if (!it || !it.id) return;
          seen[it.id] = 1;
          var js = jsonOf(it);
          if (sh[it.id] !== js) { ops.push({ ref: docRef(c, it.id), data: it }); sh[it.id] = js; }
        });
        Object.keys(sh).forEach(function (id) {
          if (!seen[id]) { ops.push({ ref: docRef(c, id), del: true }); delete sh[id]; }
        });
      });
      var sjs = jsonOf(db.settings || {});
      if (S.settingsShadow !== sjs) { ops.push({ ref: docRef('settings', 'main'), data: db.settings || {} }); S.settingsShadow = sjs; }
      if (ops.length) commitOps(ops).catch(function (e) { log('sync push err', e); });
    }, 400);
  }

  global.Sync = { init: init, push: push, isConfigured: function () { return cfgValid(global.FIREBASE_CONFIG); } };
})(window);
