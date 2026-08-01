/* Local storage — notes, cfg, session, recents, event log */
var PocketStore = (function () {
  var KEY = 'pocket.notes.v1';
  var CFG = 'pocket.cfg.v1';
  var SESS = 'pocket.session.v1';
  var RECENTS = 'pocket.recents.v1';
  var LOG = 'pocket.log.v1';
  var PLACES = 'pocket.places.v1';
  var APP_VERSION = '0.9.0';

  function loadNotes() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function saveNotes(list) {
    localStorage.setItem(KEY, JSON.stringify(list || []));
  }
  function addNote(text) {
    var t = (text || '').replace(/^\s+|\s+$/g, '');
    if (!t) return null;
    var list = loadNotes();
    var note = { id: String(Date.now()), text: t, createdAt: new Date().toISOString() };
    list.unshift(note);
    if (list.length > 200) list = list.slice(0, 200);
    saveNotes(list);
    return note;
  }
  function removeNote(id) {
    saveNotes(loadNotes().filter(function (n) { return n.id !== id; }));
  }

  function loadCfg() {
    // Defaults are empty for public builds — set Bridge URL + token in Settings.
    // Optional: create js/config.local.js (gitignored) to seed device defaults.
    var def = {
      bridgeUrl: '',
      token: '',
      aiMode: 'notes', // notes | hermes
      musicDeviceId: null,
      musicDeviceName: null
    };
    try {
      if (typeof PocketLocalConfig === 'object' && PocketLocalConfig) {
        if (PocketLocalConfig.bridgeUrl) def.bridgeUrl = PocketLocalConfig.bridgeUrl;
        if (PocketLocalConfig.token) def.token = PocketLocalConfig.token;
        if (PocketLocalConfig.aiMode) def.aiMode = PocketLocalConfig.aiMode;
      }
    } catch (eLoc) {}
    try {
      var raw = localStorage.getItem(CFG);
      if (!raw) {
        if (def.bridgeUrl || def.token) {
          try { localStorage.setItem(CFG, JSON.stringify(def)); } catch (e0) {}
        }
        return def;
      }
      var cfg = JSON.parse(raw);
      var changed = false;
      if (!cfg.bridgeUrl && def.bridgeUrl) { cfg.bridgeUrl = def.bridgeUrl; changed = true; }
      if (!cfg.token && def.token) { cfg.token = def.token; changed = true; }
      if (!cfg.aiMode) { cfg.aiMode = def.aiMode; changed = true; }
      if (changed) {
        try { localStorage.setItem(CFG, JSON.stringify(cfg)); } catch (e1) {}
      }
      return cfg;
    } catch (e) { return def; }
  }
  function saveCfg(cfg) {
    var cur = loadCfg();
    var next = cfg || {};
    // merge so partial saves keep aiMode / device
    if (next.bridgeUrl === undefined) next.bridgeUrl = cur.bridgeUrl;
    if (next.token === undefined) next.token = cur.token;
    if (next.aiMode === undefined) next.aiMode = cur.aiMode;
    if (next.musicDeviceId === undefined) next.musicDeviceId = cur.musicDeviceId;
    if (next.musicDeviceName === undefined) next.musicDeviceName = cur.musicDeviceName;
    localStorage.setItem(CFG, JSON.stringify(next));
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESS) || '{}'); } catch (e) { return {}; }
  }
  function saveSession(s) {
    try { localStorage.setItem(SESS, JSON.stringify(s || {})); } catch (e) {}
  }

  function loadRecents() {
    try { return JSON.parse(localStorage.getItem(RECENTS) || '[]'); } catch (e) { return []; }
  }
  function pushRecent(contact) {
    if (!contact || !contact.to) return;
    var list = loadRecents().filter(function (c) {
      return c.to !== contact.to;
    });
    list.unshift({
      name: contact.name || contact.to,
      to: contact.to,
      at: new Date().toISOString()
    });
    if (list.length > 12) list = list.slice(0, 12);
    try { localStorage.setItem(RECENTS, JSON.stringify(list)); } catch (e) {}
  }

  function loadLog() {
    try { return JSON.parse(localStorage.getItem(LOG) || '[]'); } catch (e) { return []; }
  }
  function log(msg, level) {
    var list = loadLog();
    list.unshift({
      t: new Date().toISOString(),
      m: String(msg || '').slice(0, 200),
      l: level || 'info'
    });
    if (list.length > 30) list = list.slice(0, 30);
    try { localStorage.setItem(LOG, JSON.stringify(list)); } catch (e) {}
  }

  function allText(limit) {
    return loadNotes().slice(0, limit || 40).map(function (n) { return '- ' + n.text; }).join('\n');
  }

  function loadPlaces() {
    try { return JSON.parse(localStorage.getItem(PLACES) || '{}'); } catch (e) { return {}; }
  }
  function savePlaces(p) {
    try { localStorage.setItem(PLACES, JSON.stringify(p || {})); } catch (e) {}
  }
  /** slots: home, work, plus favorites[] */
  function getPlace(slot) {
    var p = loadPlaces();
    return p[slot] || null;
  }
  function setPlace(slot, place) {
    var p = loadPlaces();
    if (!place) delete p[slot];
    else {
      p[slot] = {
        name: place.name || slot,
        address: place.address || '',
        lat: place.lat,
        lon: place.lon
      };
    }
    // also keep recent destinations
    if (place && place.lat != null) {
      var fav = p.favorites || [];
      fav = fav.filter(function (f) {
        return !(f.lat === place.lat && f.lon === place.lon);
      });
      fav.unshift({
        name: place.name || 'Place',
        address: place.address || '',
        lat: place.lat,
        lon: place.lon
      });
      if (fav.length > 12) fav = fav.slice(0, 12);
      p.favorites = fav;
    }
    savePlaces(p);
  }
  function loadFavorites() {
    return loadPlaces().favorites || [];
  }

  return {
    APP_VERSION: APP_VERSION,
    loadNotes: loadNotes,
    addNote: addNote,
    removeNote: removeNote,
    loadCfg: loadCfg,
    saveCfg: saveCfg,
    allText: allText,
    loadSession: loadSession,
    saveSession: saveSession,
    loadRecents: loadRecents,
    pushRecent: pushRecent,
    loadLog: loadLog,
    log: log,
    loadPlaces: loadPlaces,
    savePlaces: savePlaces,
    getPlace: getPlace,
    setPlace: setPlace,
    loadFavorites: loadFavorites
  };
})();
