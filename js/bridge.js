/* Bridge HTTP client — friendly errors for flip UI */
var PocketBridge = (function () {
  function cfg() { return PocketStore.loadCfg(); }
  function base() { return (cfg().bridgeUrl || '').replace(/\/$/, ''); }

  function xhr() {
    try { return new XMLHttpRequest({ mozSystem: true }); }
    catch (e) { return new XMLHttpRequest(); }
  }

  function authHeaders(json) {
    var h = { Accept: 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    var t = cfg().token;
    if (t) {
      h.Authorization = 'Bearer ' + t;
      h['X-Pocket-Token'] = t;
    }
    return h;
  }

  function friendlyError(status, data, networkKind) {
    if (networkKind === 'timeout') {
      return 'Timeout — Mac asleep or bridge busy?';
    }
    if (networkKind === 'network') {
      var b = base() || '(no URL)';
      return 'Can\'t reach ' + b + ' — same Wi‑Fi? Relay running?';
    }
    if (status === 0) {
      return 'No response from bridge — check URL + Wi‑Fi';
    }
    if (status === 401) return 'Unauthorized — check token in Settings';
    if (status === 404) return 'Bridge path missing — update Mac relay?';
    if (status === 502 || status === 503) return 'Bridge upstream down (Mini?)';
    if (status === 504) return 'Upstream timeout — try again';
    var msg = (data && (data.error || data.message)) || ('HTTP ' + status);
    if (/authorization denied|Full Disk Access|chat\.db/i.test(String(msg))) {
      return 'Messages blocked — grant Full Disk Access to Terminal/imsg on Mac';
    }
    if (/No Spotify devices/i.test(String(msg))) {
      return 'No Spotify device — open Spotify on TV/Mac, or pick Devices';
    }
    return String(msg);
  }

  function request(method, path, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!base()) {
        reject(new Error('Set Bridge URL in Settings'));
        return;
      }
      var x = xhr();
      var url = base() + path;
      x.open(method, url, true);
      x.timeout = timeoutMs || 60000;
      var hs = authHeaders(!!body);
      Object.keys(hs).forEach(function (k) {
        try { x.setRequestHeader(k, hs[k]); } catch (e) {}
      });
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var text = x.responseText || '';
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
        if (x.status >= 200 && x.status < 300) resolve(data || {});
        else reject(new Error(friendlyError(x.status, data)));
      };
      x.onerror = function () { reject(new Error(friendlyError(0, null, 'network'))); };
      x.ontimeout = function () { reject(new Error(friendlyError(0, null, 'timeout'))); };
      x.send(body ? JSON.stringify(body) : null);
    });
  }

  function stt(blob, lang) {
    return new Promise(function (resolve, reject) {
      if (!base()) { reject(new Error('Set Bridge URL in Settings')); return; }
      if (!blob) { reject(new Error('No audio')); return; }
      var url = base() + '/v1/stt?language=' + encodeURIComponent(lang || 'en');
      var x = xhr();
      x.open('POST', url, true);
      x.timeout = 120000;
      var hs = authHeaders(false);
      Object.keys(hs).forEach(function (k) {
        try { x.setRequestHeader(k, hs[k]); } catch (e) {}
      });
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var text = x.responseText || '';
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
        if (x.status >= 200 && x.status < 300) resolve(data || { text: '' });
        else reject(new Error(friendlyError(x.status, data)));
      };
      x.onerror = function () { reject(new Error(friendlyError(0, null, 'network'))); };
      x.ontimeout = function () { reject(new Error(friendlyError(0, null, 'timeout'))); };
      try {
        var fd = new FormData();
        var ext = (blob.type && blob.type.indexOf('3gp') >= 0) ? '3gp' : 'webm';
        fd.append('audio', blob, 'note.' + ext);
        fd.append('file', blob, 'note.' + ext);
        x.send(fd);
      } catch (e) {
        try {
          x.setRequestHeader('Content-Type', blob.type || 'audio/webm');
          x.send(blob);
        } catch (e2) { reject(e2); }
      }
    });
  }

  return {
    base: base,
    // Fast liveness — full /health can exceed flip timeout when Mini/hermes is slow
    ping: function () { return request('GET', '/ping', null, 12000); },
    chat: function (message, notes) {
      return request('POST', '/v1/chat', { message: message, notes: notes || '', device: 'bmud' });
    },
    summarize: function (notes) {
      return request('POST', '/v1/summarize', { notes: notes || '', device: 'bmud' });
    },
    hermes: function (message, cont) {
      return request('POST', '/v1/hermes', {
        message: message || '',
        prompt: message || '',
        continue: !!cont,
        device: 'bmud'
      }, 300000);
    },
    stt: stt,
    musicSearch: function (q) { return request('POST', '/v1/music/search', { q: q }); },
    musicRecent: function (limit) {
      return request('GET', '/v1/music/recent?limit=' + encodeURIComponent(limit || 20), null, 20000);
    },
    musicLiked: function (limit) {
      return request('GET', '/v1/music/liked?limit=' + encodeURIComponent(limit || 30), null, 25000);
    },
    musicPlaylists: function (limit) {
      return request('GET', '/v1/music/playlists?limit=' + encodeURIComponent(limit || 30), null, 20000);
    },
    musicPlaylistTracks: function (id, limit) {
      return request(
        'GET',
        '/v1/music/playlist?id=' + encodeURIComponent(id || '') +
          '&limit=' + encodeURIComponent(limit || 40),
        null,
        30000
      );
    },
    musicNow: function () {
      return request('GET', '/v1/music/now', null, 12000);
    },
    musicResolve: function (track) {
      return request('POST', '/v1/music/resolve', track || {}, 60000);
    },
    musicStreamUrl: function (track, mode) {
      var b = base();
      if (!b || !track) return '';
      var t = cfg().token || '';
      var q =
        'uri=' + encodeURIComponent(track.uri || '') +
        '&name=' + encodeURIComponent(track.name || '') +
        '&artists=' + encodeURIComponent(track.artists || '') +
        '&mode=' + encodeURIComponent(mode || 'auto');
      if (t) q += '&token=' + encodeURIComponent(t);
      return b + '/v1/music/stream?' + q;
    },
    musicControl: function (action, uri, deviceId, contextUri) {
      var body = { action: action, uri: uri || null };
      if (deviceId) body.device_id = deviceId;
      if (contextUri) body.context_uri = contextUri;
      return request('POST', '/v1/music/control', body);
    },
    musicDevices: function () {
      return request('GET', '/v1/music/devices', null, 12000);
    },
    messagesChats: function (limit) {
      return request('GET', '/v1/messages/chats?limit=' + encodeURIComponent(limit || 40), null, 20000);
    },
    messagesHistory: function (chatId, limit) {
      return request('GET', '/v1/messages/history?chat_id=' + encodeURIComponent(chatId) +
        '&limit=' + encodeURIComponent(limit || 50), null, 25000);
    },
    messagesSend: function (to, text, chatId) {
      return request('POST', '/v1/messages/send', {
        to: to || null, chat_id: chatId || null, text: text, device: 'bmud'
      }, 30000);
    },
    contactsSearch: function (q, limit) {
      var path = '/v1/contacts?limit=' + encodeURIComponent(limit || 30);
      if (q) path += '&q=' + encodeURIComponent(q);
      return request('GET', path, null, 15000);
    },
    mapsSearch: function (q, limit) {
      var path = '/v1/maps/search?limit=' + encodeURIComponent(limit || 8);
      if (q) path += '&q=' + encodeURIComponent(q);
      return request('GET', path, null, 20000);
    },
    mapsDirections: function (fromObj, toObj, mode) {
      return request('POST', '/v1/maps/directions', {
        from: fromObj,
        to: toObj,
        mode: mode || 'driving'
      }, 45000);
    },
    mapsGeocode: function (q) {
      return request('GET', '/v1/maps/geocode?q=' + encodeURIComponent(q || ''), null, 20000);
    },
    termHosts: function () {
      return request('GET', '/v1/term/hosts', null, 15000);
    },
    termExec: function (host, command, user, timeout, password) {
      var body = {
        host: host || 'local',
        command: command || '',
        user: user || null
      };
      if (timeout) body.timeout = timeout;
      // Only send when set — remote hosts without keys need this (SSH_ASKPASS on Mac)
      if (password) body.password = password;
      return request('POST', '/v1/term/exec', body, Math.max(20000, ((timeout || 60) + 15) * 1000));
    },
    podcastsCatalog: function () {
      return request('GET', '/v1/podcasts/catalog', null, 15000);
    },
    podcastsFeed: function (feedUrl, limit) {
      var path = '/v1/podcasts/feed?limit=' + encodeURIComponent(limit || 20) +
        '&url=' + encodeURIComponent(feedUrl || '');
      return request('GET', path, null, 35000);
    },
    podcastsProxyUrl: function (audioUrl) {
      var b = base();
      if (!b || !audioUrl) return audioUrl || '';
      var t = (cfg().token || '');
      var path = '/v1/podcasts/proxy?url=' + encodeURIComponent(audioUrl);
      if (t) path += '&token=' + encodeURIComponent(t);
      return b + path;
    }
  };
})();
