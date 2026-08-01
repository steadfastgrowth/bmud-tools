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
    ping: function () { return request('GET', '/health', null, 8000); },
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
    musicControl: function (action, uri, deviceId) {
      var body = { action: action, uri: uri || null };
      if (deviceId) body.device_id = deviceId;
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
    }
  };
})();
