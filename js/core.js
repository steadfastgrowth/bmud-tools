/* B-Mud core — SIMPLE nav + side-button STT toggle
 *
 * D-pad Up/Down = move highlight
 * Select / Enter = open / press control
 * SoftLeft = Home, SoftRight = Back
 * SIDE button (PROG1→Call) = STT toggle into focused text box
 */
(function () {
  var view = 'hub';
  var stack = [];
  var items = [];
  var idx = 0;
  var chat = null;
  var lastUri = null;
  var lastTrack = null; // { uri, name, artists, preview_url }
  var tracks = [];
  var lastField = null;
  var listening = false;
  var stream = null;
  var recorder = null;
  var chunks = [];
  var mime = '';
  var phonePlaying = false;
  var musicDevices = [];
  var lastCaps = null;

  function $(id) { return document.getElementById(id); }

  function toast(m) {
    var t = $('toast');
    if (!t) return;
    t.textContent = m || '';
    t.className = 'show';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ''; }, 1600);
  }

  function log(msg, level) {
    try { if (window.PocketStore && PocketStore.log) PocketStore.log(msg, level); } catch (e) {}
  }

  function setStatus(txt, on) {
    var s = $('status');
    if (!s) return;
    s.textContent = txt || '';
    s.className = on === true ? 'on' : (on === false ? 'off' : '');
  }

  function setCaps(txt, cls) {
    var c = $('caps');
    if (!c) return;
    c.textContent = txt || '—';
    c.className = 'caps' + (cls ? ' ' + cls : '');
  }

  function persistSession() {
    try {
      PocketStore.saveSession({ view: view, stack: stack.slice(-6), at: Date.now() });
    } catch (e) {}
  }

  function syncAiModeUi() {
    var mode = (PocketStore.loadCfg().aiMode || 'notes');
    var label = mode === 'hermes' ? 'Mode: Hermes (Mac agent)' : 'Mode: Notes AI';
    if ($('btnAiMode')) $('btnAiMode').textContent = label;
    if ($('aiModeHint')) {
      $('aiModeHint').textContent = mode === 'hermes'
        ? 'Hermes · answers via your Mac agent · ↓ reads answer'
        : 'Notes AI · uses local notes · Select = Ask · ↓ reads answer';
    }
    if ($('btnSum')) $('btnSum').style.display = mode === 'hermes' ? 'none' : '';
  }

  function toggleAiMode() {
    var c = PocketStore.loadCfg();
    c.aiMode = (c.aiMode === 'hermes') ? 'notes' : 'hermes';
    PocketStore.saveCfg(c);
    syncAiModeUi();
    toast(c.aiMode === 'hermes' ? 'Hermes mode' : 'Notes AI mode');
    log('aiMode=' + c.aiMode);
    collect();
  }

  function banner(txt) {
    var b = $('banner');
    var app = $('app');
    if (!b) return;
    if (!txt) {
      b.className = '';
      b.textContent = '';
      if (app) app.className = String(app.className || '').replace(/\bbanner-on\b/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      return;
    }
    b.textContent = txt;
    b.className = 'show';
    if (app && !/\bbanner-on\b/.test(app.className || '')) {
      app.className = ((app.className || '') + ' banner-on').replace(/^\s+/, '');
    }
  }

  function activeViewEl() {
    return $(map[view]) || document.querySelector('.view.on');
  }

  /** Scroll the active .view so el is fully visible (not window — KaiOS needs this). */
  function ensureVisible(el) {
    if (!el) return;
    var scroller = activeViewEl();
    if (!scroller) return;

    try {
      var er = el.getBoundingClientRect();
      var sr = scroller.getBoundingClientRect();
      var padTop = 6;
      var padBot = 10;
      var delta = 0;

      if (er.top < sr.top + padTop) {
        delta = er.top - sr.top - padTop;
      } else if (er.bottom > sr.bottom - padBot) {
        delta = er.bottom - (sr.bottom - padBot);
      }

      if (delta !== 0) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop + Math.floor(delta));
      }
    } catch (e) {
      try {
        if (el.scrollIntoView) el.scrollIntoView(false);
      } catch (e2) {}
    }
  }

  function isField(el) {
    if (!el || el.disabled) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var ty = (el.type || 'text').toLowerCase();
    return ty !== 'button' && ty !== 'submit' && ty !== 'checkbox' && ty !== 'radio' && ty !== 'hidden';
  }

  function remember(el) {
    if (isField(el)) lastField = el;
  }

  function targetField() {
    var a = document.activeElement;
    if (isField(a)) return a;
    if (lastField && isField(lastField)) return lastField;
    return $('note');
  }

  var map = {
    hub: 'v-hub',
    notes: 'v-notes',
    ai: 'v-ai',
    messages: 'v-messages',
    thread: 'v-thread',
    compose: 'v-compose',
    maps: 'v-maps',
    term: 'v-term',
    music: 'v-music',
    settings: 'v-settings'
  };

  var titles = {
    hub: 'B-Mud Tools',
    notes: 'Notes',
    ai: 'AI',
    messages: 'Messages',
    thread: 'Chat',
    compose: 'New msg',
    maps: 'Maps',
    term: 'Terminal',
    music: 'Music',
    settings: 'Settings'
  };

  var termHostsList = [];
  var termHost = 'local';
  var termDefaultUser = '';

  var mapPlaces = [];
  var mapSelected = null; // last focused/selected place
  var mapSteps = [];

  function show(name, push) {
    if (push && view && view !== name && view !== 'hub') stack.push(view);
    if (name === 'hub') stack = [];
    view = name;

    var id;
    for (id in map) {
      var el = $(map[id]);
      if (!el) continue;
      el.className = (id === name) ? 'view on' : 'view';
      // Reset scroll when switching pages so new view starts at top
      if (id === name) {
        try { el.scrollTop = 0; } catch (e) {}
      }
    }

    if ($('title')) $('title').textContent = titles[name] || 'B-Mud';
    setSoft();
    persistSession();

    if (name === 'notes') renderNotes();
    if (name === 'messages') {
      loadChats();
      renderRecents();
    }
    if (name === 'ai') syncAiModeUi();
    if (name === 'maps') {
      renderMapsSaved();
      refreshMapsNow();
    }
    if (name === 'term') {
      if ($('termHost') && !$('termHost').value) $('termHost').value = termHost || 'local';
      if ($('termUser') && !$('termUser').value && termDefaultUser) $('termUser').value = termDefaultUser;
      refreshTermHostNow();
      if (!termHostsList.length) loadTermHosts();
      else renderTermHosts(termHostsList);
    }
    if (name === 'music') refreshMusicDeviceHint();
    if (name === 'settings') {
      fillCfg();
      renderLog();
    }

    // rebuild focus list after paint
    setTimeout(function () {
      collect();
      focusAt(0);
    }, 30);
  }

  function back() {
    if (stack.length) {
      show(stack.pop(), false);
      return;
    }
    if (view !== 'hub') show('hub', false);
  }

  /** Pin #skC to true horizontal center of the softkey bar (KaiOS CSS is flaky). */
  function layoutSoftCenter() {
    var bar = $('softBar') || document.querySelector('.soft');
    var c = $('skC');
    if (!bar || !c) return;
    var w = bar.clientWidth || bar.offsetWidth || window.innerWidth || 240;
    if (w < 80) w = window.innerWidth || 240;
    c.style.position = 'absolute';
    c.style.left = '0px';
    c.style.right = 'auto';
    c.style.width = w + 'px';
    c.style.textAlign = 'center';
    c.style.padding = '0';
    c.style.margin = '0';
    c.style.zIndex = '1';
  }

  function setSoft() {
    if ($('skL')) $('skL').textContent = 'Home';
    if ($('skR')) $('skR').textContent = (view === 'hub' ? '' : 'Back');

    // Soft Center = primary action for the focused control / screen
    var c = 'Select';
    var el = (items[idx] && items[idx]) || document.activeElement;
    var id = el && el.id;

    if (view === 'thread') {
      c = (id === 'btnReplyMic') ? 'Talk' : 'Send';
    } else if (view === 'ai') {
      if (el && el.className && String(el.className).indexOf('ai-chunk') >= 0) c = 'Read';
      else if (id === 'btnAiMode') c = 'Toggle';
      else if (id === 'btnSum') c = 'Sum';
      else c = 'Ask';
    } else if (view === 'maps') {
      if (el && el.getAttribute && el.getAttribute('data-place-i') != null) c = 'Go';
      else if (el && el.getAttribute && el.getAttribute('data-saved') != null) c = 'Go';
      else if (el && el.getAttribute && el.getAttribute('data-step-i') != null) c = 'Read';
      else if (id === 'btnNavHome' || id === 'btnNavWork') c = 'Go';
      else if (id === 'btnSetHome' || id === 'btnSetWork') c = 'Save';
      else c = 'Search';
    } else if (view === 'term') {
      if (el && el.getAttribute && el.getAttribute('data-host-i') != null) c = 'Pick';
      else if (el && el.getAttribute && el.getAttribute('data-term-line') != null) c = 'Read';
      else if (id === 'btnTermHosts') c = 'Hosts';
      else c = 'Run';
    } else if (view === 'music') {
      if (el && el.getAttribute && el.getAttribute('data-track-i') != null) c = 'Play';
      else if (el && el.getAttribute && el.getAttribute('data-device-i') != null) c = 'Pick';
      else if (id === 'btnStop') c = 'Stop';
      else if (id === 'btnDevices') c = 'Devices';
      else if (id === 'btnRemote' || id === 'btnPlay') c = 'Remote';
      else if (id === 'btnRemotePause' || id === 'btnPause') c = 'Pause';
      else c = 'Search';
    } else if (view === 'notes') {
      if (id === 'btnTalk') c = 'Talk';
      else if (id === 'btnSave' || id === 'note') c = 'Save';
      else c = 'Select';
    } else if (view === 'settings') {
      if (id === 'btnPing') c = 'Ping';
      else if (id === 'btnSaveCfg' || id === 'url' || id === 'token') c = 'Save';
      else c = 'Select';
    } else if (view === 'messages') {
      if (id === 'btnMsgRefresh') c = 'Refresh';
      else if (id === 'btnMsgCompose') c = 'New';
      else if (id === 'btnContactSearch' || id === 'contactQ') c = 'Find';
      else if (el && el.getAttribute && (el.getAttribute('data-contact-i') != null || el.getAttribute('data-recent-i') != null)) c = 'Message';
      else c = 'Open';
    } else if (view === 'compose') {
      if (id === 'btnCompMic') c = 'Talk';
      else c = 'Send';
    }

    if ($('skC')) $('skC').textContent = c;
    layoutSoftCenter();
  }

  /* ===== MENU / D-PAD ===== */
  function clearFocusClass() {
    var i;
    for (i = 0; i < items.length; i++) {
      try {
        items[i].className = String(items[i].className || '').replace(/\bfocused\b/g, '').replace(/\s+/g, ' ');
      } catch (e) {}
    }
  }

  function collect() {
    var root = $(map[view]) || document.body;
    items = [];
    if (!root) return;

    // Prefer explicit tabindex controls in the active view (includes track rows)
    var nodes = root.querySelectorAll('li[tabindex], button, textarea, input, .msg[tabindex], #settingsEnd');
    var i, el, tag;
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (el.disabled) continue;
      // skip explicitly hidden controls (legacy music buttons)
      if (el.style && el.style.display === 'none') continue;
      try {
        if (window.getComputedStyle && window.getComputedStyle(el).display === 'none') continue;
      } catch (eHide) {}
      tag = (el.tagName || '').toLowerCase();
      if (tag === 'input') {
        var ty = (el.type || '').toLowerCase();
        if (ty === 'hidden') continue;
      }
      items.push(el);
    }
    if (idx >= items.length) idx = Math.max(0, items.length - 1);
  }

  function focusAt(i) {
    if (!items.length) {
      collect();
      if (!items.length) return;
    }
    idx = i;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;

    clearFocusClass();
    var el = items[idx];
    try {
      el.className = (String(el.className || '').replace(/\bfocused\b/g, '') + ' focused').replace(/^\s+/, '');
      el.focus();
    } catch (e) {}

    // Scroll the active .view container (not window) so focused item is visible
    ensureVisible(el);

    remember(el);
    setSoft();
  }

  function move(delta) {
    collect();
    if (!items.length) return;
    focusAt(idx + delta);
  }

  function runAction(name) {
    switch (name) {
      case 'ask': ask('chat'); return true;
      case 'sum': ask('sum'); return true;
      case 'ai-mode': toggleAiMode(); return true;
      case 'maps-search': mapsSearch(); return true;
      case 'nav-home': navigateToSaved('home'); return true;
      case 'nav-work': navigateToSaved('work'); return true;
      case 'maps-set-home': mapsSaveSelected('home'); return true;
      case 'maps-set-work': mapsSaveSelected('work'); return true;
      case 'term-hosts': loadTermHosts(); return true;
      case 'term-run': termRun(); return true;
      case 'music-search': musicSearch(); return true;
      case 'music-play': playPhoneTrack(lastTrack); return true;
      case 'music-stop': stopPhoneAudio(); return true;
      case 'music-remote': musicCtrl('play'); return true;
      case 'music-pause': musicCtrl('pause'); return true;
      case 'music-devices': loadMusicDevices(); return true;
      case 'save-note':
        if ($('btnSave')) { try { $('btnSave').click(); } catch (e) {} }
        return true;
      case 'talk': sttToggle(); return true;
      case 'save-cfg': saveCfg(); return true;
      case 'ping': ping(); return true;
      case 'msg-refresh': loadChats(); return true;
      case 'msg-compose': show('compose', true); return true;
      case 'contact-search': searchContacts(); return true;
      case 'send-reply': sendReply(); return true;
      case 'send-compose':
        if ($('btnCompSend')) { try { $('btnCompSend').click(); } catch (e2) {} }
        return true;
      default: return false;
    }
  }

  function activate() {
    collect();
    var el = items[idx] || document.activeElement;
    if (!el) return;

    // Hub / list rows with data-go (walk up in case focus is nested)
    var node = el;
    while (node && node !== document.body) {
      var go = node.getAttribute && node.getAttribute('data-go');
      if (go) {
        show(go, true);
        return;
      }
      node = node.parentNode;
    }

    // Explicit data-action (more reliable than button.click on KaiOS)
    var action = el.getAttribute && el.getAttribute('data-action');
    if (action && runAction(action)) return;

    // Field-aware primary actions (Select while still in the text box)
    var id = el.id || '';
    if (view === 'ai') {
      // Reading answer chunks: Select just keeps place (already visible)
      if (el.className && String(el.className).indexOf('ai-chunk') >= 0) {
        ensureVisible(el);
        return;
      }
      if (id === 'btnAiMode') { toggleAiMode(); return; }
      if (id === 'btnSum') { ask('sum'); return; }
      ask('chat');
      return;
    }
    if (view === 'maps') {
      var pi = el.getAttribute && el.getAttribute('data-place-i');
      if (pi != null && pi !== '') {
        startDirectionsTo(mapPlaces[parseInt(pi, 10)]);
        return;
      }
      var sav = el.getAttribute && el.getAttribute('data-saved');
      if (sav) {
        navigateToSaved(sav);
        return;
      }
      var pf = el.getAttribute && el.getAttribute('data-place-fav');
      if (pf != null && pf !== '') {
        var favs = PocketStore.loadFavorites();
        startDirectionsTo(favs[parseInt(pf, 10)]);
        return;
      }
      if (el.getAttribute && el.getAttribute('data-step-i') != null) {
        ensureVisible(el);
        return;
      }
      if (id === 'btnNavHome') { navigateToSaved('home'); return; }
      if (id === 'btnNavWork') { navigateToSaved('work'); return; }
      if (id === 'btnSetHome') { mapsSaveSelected('home'); return; }
      if (id === 'btnSetWork') { mapsSaveSelected('work'); return; }
      if (id === 'btnMapsSearch' || id === 'mapsQ') { mapsSearch(); return; }
      mapsSearch();
      return;
    }
    if (view === 'term') {
      var hi = el.getAttribute && el.getAttribute('data-host-i');
      if (hi != null && hi !== '') {
        pickTermHost(termHostsList[parseInt(hi, 10)]);
        return;
      }
      if (el.getAttribute && el.getAttribute('data-term-line') != null) {
        ensureVisible(el);
        return;
      }
      if (id === 'btnTermHosts') { loadTermHosts(); return; }
      if (id === 'btnTermRun' || id === 'termCmd') { termRun(); return; }
      termRun();
      return;
    }
    if (view === 'music') {
      var ti = el.getAttribute && el.getAttribute('data-track-i');
      if (ti != null && ti !== '') {
        playPhoneTrack(tracks[parseInt(ti, 10)]);
        return;
      }
      var di = el.getAttribute && el.getAttribute('data-device-i');
      if (di != null && di !== '') {
        pickMusicDevice(musicDevices[parseInt(di, 10)]);
        return;
      }
      if (id === 'btnStop') { stopPhoneAudio(); return; }
      if (id === 'btnDevices') { loadMusicDevices(); return; }
      if (id === 'btnRemote' || id === 'btnPlay') { musicCtrl('play'); return; }
      if (id === 'btnRemotePause' || id === 'btnPause') { musicCtrl('pause'); return; }
      if (id === 'btnSearch' || id === 'musicQ') { musicSearch(); return; }
      musicSearch();
      return;
    }
    if (view === 'thread') {
      if (id === 'btnReplyMic') { remember($('reply')); sttToggle(); return; }
      sendReply();
      return;
    }
    if (view === 'notes' && (id === 'note' || id === 'btnSave')) {
      if ($('btnSave')) { try { $('btnSave').click(); } catch (e0) {} }
      return;
    }
    if (view === 'settings' && (id === 'url' || id === 'token' || id === 'btnSaveCfg')) {
      saveCfg();
      return;
    }
    if (view === 'messages') {
      var ci = el.getAttribute && el.getAttribute('data-contact-i');
      if (ci != null && ci !== '') {
        pickContact(contactResults[parseInt(ci, 10)]);
        return;
      }
      var ri = el.getAttribute && el.getAttribute('data-recent-i');
      if (ri != null && ri !== '') {
        pickContact(PocketStore.loadRecents()[parseInt(ri, 10)]);
        return;
      }
      if (id === 'btnContactSearch' || id === 'contactQ') {
        searchContacts();
        return;
      }
      if (id === 'btnMsgCompose') {
        show('compose', true);
        return;
      }
      if (id === 'btnMsgRefresh') {
        loadChats();
        return;
      }
    }
    if (view === 'compose' && (id === 'msgBody' || id === 'msgTo' || id === 'btnCompSend')) {
      if ($('btnCompSend')) { try { $('btnCompSend').click(); } catch (e1) {} }
      return;
    }

    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'button') {
      // Prefer data-action; fall back to click + direct id map
      if (id === 'btnAsk') { ask('chat'); return; }
      if (id === 'btnSum') { ask('sum'); return; }
      if (id === 'btnSearch') { musicSearch(); return; }
      if (id === 'btnStop') { stopPhoneAudio(); return; }
      if (id === 'btnRemote' || id === 'btnPlay') { musicCtrl('play'); return; }
      if (id === 'btnPause') { musicCtrl('pause'); return; }
      if (id === 'btnPing') { ping(); return; }
      if (id === 'btnSaveCfg') { saveCfg(); return; }
      if (id === 'btnMsgRefresh') { loadChats(); return; }
      if (id === 'btnSend') { sendReply(); return; }
      try { el.click(); } catch (e) {}
      return;
    }
    if (tag === 'li') {
      try { el.click(); } catch (e2) {}
      return;
    }
    // inputs / spacers: keep focus
    try { el.focus(); } catch (e3) {}
  }

  /* ===== SIDE-BUTTON STT (toggle) ===== */
  function isSideSttKey(e) {
    var k = e.key || '';
    var c = e.code || '';
    var kc = e.keyCode || e.which || 0;
    // NEVER select/enter/ok
    if (k === 'Enter' || k === 'Accept' || kc === 13 || kc === 352) return false;
    if (k === 'SoftLeft' || k === 'SoftRight' || k === 'F1' || k === 'F2') return false;
    // Side PROG1 and Call (daemon maps side → Call)
    if (k === 'Call' || k === 'Phone' || c === 'Call' || kc === 231) return true;
    if (k === 'Prog1' || c === 'Prog1' || kc === 148) return true;
    return false;
  }

  function pickMime() {
    if (!window.MediaRecorder) return '';
    var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/3gpp', 'audio/mp4', 'audio/ogg'];
    var i;
    for (i = 0; i < c.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) return c[i];
      } catch (e) {}
    }
    return '';
  }

  function cleanupRec() {
    try {
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
      }
    } catch (e) {}
    recorder = null;
    chunks = [];
    if (stream) {
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) {}
      stream = null;
    }
  }

  function insert(el, text) {
    if (!el || !text) return;
    try { el.focus(); } catch (e) {}
    var v = el.value || '';
    var s = el.selectionStart;
    var epos = el.selectionEnd;
    if (typeof s === 'number' && typeof epos === 'number') {
      var sp = (s > 0 && v.charAt(s - 1) !== ' ' && v.charAt(s - 1) !== '\n') ? ' ' : '';
      el.value = v.slice(0, s) + sp + text + v.slice(epos);
      var p = s + sp.length + text.length;
      try { el.setSelectionRange(p, p); } catch (e2) {}
    } else {
      el.value = (v && !/\s$/.test(v) ? v + ' ' : v) + text;
    }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e3) {}
  }

  function sttStart() {
    if (listening) return;
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      show('settings', true);
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast('No mic');
      return;
    }
    remember(targetField());
    listening = true;
    chunks = [];
    mime = pickMime();
    banner('Listening… SIDE button again = stop');
    if ($('btnTalk')) {
      $('btnTalk').className = 'btn talk hot';
      $('btnTalk').textContent = 'Stop (or SIDE button)';
    }
    toast('Listening');

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      if (!listening) {
        s.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      stream = s;
      try {
        recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      } catch (e) {
        recorder = new MediaRecorder(s);
      }
      mime = recorder.mimeType || mime || 'audio/webm';
      recorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };
      try {
        recorder.start(250);
      } catch (e2) {
        cleanupRec();
        listening = false;
        banner('');
        toast(String(e2.message || e2));
      }
    }).catch(function (err) {
      listening = false;
      banner('');
      if ($('btnTalk')) {
        $('btnTalk').className = 'btn talk';
        $('btnTalk').textContent = 'Talk (or use SIDE button)';
      }
      toast('Mic: ' + (err && err.message ? err.message : 'denied'));
    });
  }

  function sttStop() {
    if (!recorder) {
      cleanupRec();
      listening = false;
      banner('');
      if ($('btnTalk')) {
        $('btnTalk').className = 'btn talk';
        $('btnTalk').textContent = 'Talk (or use SIDE button)';
      }
      return;
    }
    banner('Transcribing…');
    toast('Transcribing');
    recorder.onstop = function () {
      var blob = new Blob(chunks, { type: mime || 'audio/webm' });
      cleanupRec();
      listening = false;
      if ($('btnTalk')) {
        $('btnTalk').className = 'btn talk';
        $('btnTalk').textContent = 'Talk (or use SIDE button)';
      }
      if (!blob.size) {
        banner('');
        toast('No audio');
        return;
      }
      PocketBridge.stt(blob, 'en').then(function (r) {
        banner('');
        var text = ((r && (r.text || r.transcript)) || '').replace(/^\s+|\s+$/g, '');
        if (!text) {
          toast('No speech');
          return;
        }
        insert(targetField(), text);
        toast('Inserted');
        setStatus('online', true);
      }).catch(function (e) {
        banner('');
        toast('STT: ' + (e.message || e));
        setStatus('offline', false);
      });
    };
    try {
      if (recorder.state === 'recording') recorder.stop();
      else {
        cleanupRec();
        listening = false;
        banner('');
      }
    } catch (e) {
      cleanupRec();
      listening = false;
      banner('');
      toast(String(e.message || e));
    }
  }

  function sttToggle() {
    // brief feedback so side-key presses are obvious
    if (listening) sttStop();
    else sttStart();
  }

  /* ===== screens ===== */
  function renderNotes() {
    var list = PocketStore.loadNotes();
    var ul = $('noteList');
    var empty = $('noteEmpty');
    if (!ul) return;
    ul.innerHTML = '';
    if (!list.length) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    var i;
    for (i = 0; i < list.length && i < 40; i++) {
      (function (n) {
        var li = document.createElement('li');
        li.tabIndex = 0;
        li.textContent = n.text;
        li.onclick = function () {
          if (confirm('Delete note?')) {
            PocketStore.removeNote(n.id);
            renderNotes();
            collect();
            focusAt(0);
          }
        };
        ul.appendChild(li);
      })(list[i]);
    }
  }

  function fillCfg() {
    var c = PocketStore.loadCfg();
    if ($('url')) $('url').value = c.bridgeUrl || '';
    if ($('token')) $('token').value = c.token || '';
    if ($('verLine')) $('verLine').textContent = 'B-Mud v' + (PocketStore.APP_VERSION || '0.7.0');
    if (lastCaps && $('capsDetail')) $('capsDetail').textContent = lastCaps;
  }

  function saveCfg() {
    PocketStore.saveCfg({
      bridgeUrl: ($('url').value || '').replace(/\s/g, ''),
      token: ($('token').value || '').replace(/^\s+|\s+$/g, '')
    });
    toast('Saved');
    log('cfg saved');
    ping();
  }

  function renderLog() {
    var ul = $('logList');
    if (!ul) return;
    ul.innerHTML = '';
    var list = PocketStore.loadLog();
    var i, row, li;
    for (i = 0; i < list.length && i < 12; i++) {
      row = list[i];
      li = document.createElement('li');
      li.tabIndex = 0;
      li.className = 'ai-chunk';
      li.innerHTML = '<span class="part"></span><div class="body"></div>';
      li.querySelector('.part').textContent = (row.l || 'info');
      li.querySelector('.body').textContent = (row.t || '').slice(11, 19) + ' ' + (row.m || '');
      ul.appendChild(li);
    }
    if (!list.length) {
      li = document.createElement('li');
      li.className = 'ai-chunk';
      li.tabIndex = 0;
      li.textContent = 'No events yet';
      ul.appendChild(li);
    }
  }

  function ping() {
    setStatus('…');
    setCaps('ping…');
    if (!PocketBridge.base()) {
      setStatus('no url', false);
      setCaps('no bridge URL', 'err');
      if ($('cfgOut')) $('cfgOut').textContent = 'Set Bridge URL';
      return;
    }
    PocketBridge.ping().then(function (r) {
      setStatus('online', true);
      var bits = [];
      if (r.messages_ready) bits.push('imsg');
      else bits.push('imsg×');
      if (r.stt_ready || r.stt_configured) bits.push('stt');
      if (r.spotify_ready || r.spotify_configured) bits.push('spotify');
      if (r.hermes_ready || r.hermes_configured) bits.push('hermes');
      if (r.maps_ready || r.maps_provider) bits.push('maps');
      if (r.term_ready || r.term_provider) bits.push('term');
      if (r.contacts_loaded) bits.push(r.contacts_loaded + ' contacts');
      if (r.relay) bits.push(r.relay);
      var line = bits.join(' · ') || 'ok';
      lastCaps = line;
      setCaps(line, r.messages_ready === false ? 'err' : 'ok');
      if ($('cfgOut')) $('cfgOut').textContent = line;
      if ($('capsDetail')) $('capsDetail').textContent = line +
        (r.messages_error ? (' | ' + String(r.messages_error).slice(0, 80)) : '');
      log('ping ok ' + line);
    }).catch(function (e) {
      setStatus('offline', false);
      var err = String(e.message || e);
      setCaps(err.slice(0, 60), 'err');
      lastCaps = err;
      if ($('cfgOut')) $('cfgOut').textContent = err;
      if ($('capsDetail')) $('capsDetail').textContent = err;
      log('ping fail: ' + err, 'err');
    });
  }

  var contactResults = [];

  function openComposeTo(to, name) {
    show('compose', true);
    if ($('msgTo')) $('msgTo').value = to || '';
    if ($('composeHint')) {
      $('composeHint').textContent = name ? ('To: ' + name) : 'Type a number or paste a contact';
    }
    setTimeout(function () {
      collect();
      // focus body if To filled, else To
      var prefer = (to && $('msgBody')) ? 'msgBody' : 'msgTo';
      var i;
      for (i = 0; i < items.length; i++) {
        if (items[i].id === prefer) {
          focusAt(i);
          return;
        }
      }
      focusAt(0);
    }, 40);
  }

  function pickContact(c) {
    if (!c) return;
    var to = c.to || (c.phones && c.phones[0]) || (c.emails && c.emails[0]) || '';
    if (!to) {
      toast('No number');
      return;
    }
    PocketStore.pushRecent({ name: c.name || to, to: to });
    toast(c.name || to);
    openComposeTo(to, c.name || '');
  }

  function renderRecents() {
    var ul = $('recentList');
    var empty = $('recentEmpty');
    if (!ul) return;
    ul.innerHTML = '';
    var list = PocketStore.loadRecents();
    if (!list.length) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    var i, c, li;
    for (i = 0; i < list.length && i < 8; i++) {
      c = list[i];
      li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('data-recent-i', String(i));
      li.innerHTML = '<div class="name"></div><span class="sub"></span>';
      li.querySelector('.name').textContent = c.name || c.to;
      li.querySelector('.sub').textContent = c.to || '';
      (function (contact) {
        li.onclick = function () { pickContact(contact); };
      })(c);
      ul.appendChild(li);
    }
  }

  function renderContacts(list) {
    contactResults = list || [];
    var ul = $('contactList');
    if (!ul) return;
    ul.innerHTML = '';
    var i, c, li, sub;
    for (i = 0; i < contactResults.length && i < 40; i++) {
      c = contactResults[i];
      li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('data-contact-i', String(i));
      li.innerHTML = '<div class="name"></div><span class="sub"></span>';
      li.querySelector('.name').textContent = c.name || c.to || 'Contact';
      sub = c.to || '';
      if (c.phones && c.phones.length > 1) sub += ' · +' + (c.phones.length - 1) + ' more';
      li.querySelector('.sub').textContent = sub;
      (function (contact) {
        li.onclick = function () { pickContact(contact); };
      })(c);
      ul.appendChild(li);
    }
  }

  function searchContacts() {
    var q = ($('contactQ') && $('contactQ').value || '').replace(/^\s+|\s+$/g, '');
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      return;
    }
    if ($('contactHint')) $('contactHint').textContent = 'Searching…';
    toast('Finding…');
    PocketBridge.contactsSearch(q, 30).then(function (r) {
      var list = (r && r.contacts) || [];
      renderContacts(list);
      var total = (r && r.total_loaded) || list.length;
      if ($('contactHint')) {
        $('contactHint').textContent = list.length
          ? (list.length + ' matches · ' + total + ' on Mac')
          : ('No matches · ' + total + ' contacts on Mac');
      }
      toast(list.length ? (list.length + ' contacts') : 'No matches');
      setTimeout(function () {
        collect();
        var i;
        for (i = 0; i < items.length; i++) {
          if (items[i].getAttribute && items[i].getAttribute('data-contact-i') === '0') {
            focusAt(i);
            return;
          }
        }
      }, 40);
    }).catch(function (e) {
      if ($('contactHint')) $('contactHint').textContent = String(e.message || e);
      toast('Contacts: ' + (e.message || e));
    });
  }

  function loadChats() {
    if ($('msgHint')) $('msgHint').textContent = 'Loading…';
    PocketBridge.messagesChats(40).then(function (r) {
      var chats = (r && r.chats) || [];
      var ul = $('chatList');
      if (!ul) return;
      ul.innerHTML = '';
      var i;
      for (i = 0; i < chats.length; i++) {
        (function (c) {
          var li = document.createElement('li');
          li.tabIndex = 0;
          var title = c.title || c.to || ('Chat ' + c.id);
          var unread = c.unread_count || 0;
          li.innerHTML = '<div class="name"></div><span class="sub"></span>';
          li.querySelector('.name').textContent = title + (unread ? ' · ' + unread : '');
          li.querySelector('.sub').textContent = c.preview || c.to || '';
          li.onclick = function () {
            chat = { id: c.id, title: title, to: c.to || null };
            openThread();
          };
          ul.appendChild(li);
        })(chats[i]);
      }
      if ($('msgHint')) $('msgHint').textContent = chats.length + ' chats';
      collect();
      focusAt(0);
    }).catch(function (e) {
      if ($('msgHint')) $('msgHint').textContent = String(e.message || e);
    });
  }

  function openThread() {
    show('thread', true);
    if ($('threadTitle')) $('threadTitle').textContent = (chat && chat.title) || 'Chat';
    if ($('threadBody')) $('threadBody').innerHTML = '<div class="hint">Loading…</div>';
    PocketBridge.messagesHistory(chat.id, 60).then(function (r) {
      var msgs = (r && r.messages) || [];
      msgs.sort(function (a, b) {
        return String(a.date || '').localeCompare(String(b.date || ''));
      });
      var body = $('threadBody');
      if (!body) return;
      body.innerHTML = '';
      if (!msgs.length) {
        body.innerHTML = '<div class="hint">No messages</div>';
        collect();
        focusAt(0);
        return;
      }
      // show last ~25 so flip isn't endless; each msg focusable for scroll
      var start = Math.max(0, msgs.length - 25);
      var i, m, div, who, text;
      for (i = start; i < msgs.length; i++) {
        m = msgs[i];
        div = document.createElement('div');
        div.className = 'msg' + (m.is_from_me ? ' me' : '');
        div.tabIndex = 0;
        who = document.createElement('b');
        who.textContent = m.is_from_me ? 'You' : (m.sender || '');
        text = document.createElement('div');
        text.textContent = m.text || '';
        div.appendChild(who);
        div.appendChild(text);
        body.appendChild(div);
      }
      collect();
      // focus last message / reply field preference: last msg
      focusAt(Math.max(0, items.length - 3));
    }).catch(function (e) {
      if ($('threadBody')) $('threadBody').innerHTML = '<div class="hint">' + String(e.message || e) + '</div>';
      log('thread: ' + (e.message || e), 'err');
    });
  }

  function sendReply() {
    var text = ($('reply') && $('reply').value || '').replace(/^\s+|\s+$/g, '');
    if (!text) {
      toast('Type or SIDE-button speak first');
      return;
    }
    PocketBridge.messagesSend(chat && chat.to, text, chat && chat.id).then(function () {
      if ($('reply')) $('reply').value = '';
      if (chat && chat.to) PocketStore.pushRecent({ name: chat.title || chat.to, to: chat.to });
      toast('Sent');
      log('sent reply');
      openThread();
    }).catch(function (e) {
      toast(String(e.message || e));
      log('send fail: ' + (e.message || e), 'err');
    });
  }

  function setAiStatus(txt) {
    if ($('aiStatus')) $('aiStatus').textContent = txt || '—';
  }

  /** Split long AI replies into focusable chunks so D-pad can scroll/read them. */
  function chunkText(text, maxLen) {
    maxLen = maxLen || 140;
    text = String(text || '').replace(/\r\n/g, '\n').replace(/^\s+|\s+$/g, '');
    if (!text) return [];
    var parts = [];
    // Prefer paragraph breaks, then sentences, then hard wrap
    var paras = text.split(/\n{2,}/);
    var i, p, sentences, s, buf, words, w;
    for (i = 0; i < paras.length; i++) {
      p = paras[i].replace(/^\s+|\s+$/g, '');
      if (!p) continue;
      if (p.length <= maxLen) {
        parts.push(p);
        continue;
      }
      // No lookbehind (KaiOS JS) — split on punctuation + space
      sentences = p.replace(/([.!?])\s+/g, '$1\n').split('\n');
      buf = '';
      for (s = 0; s < sentences.length; s++) {
        if ((buf + ' ' + sentences[s]).replace(/^\s+/, '').length <= maxLen) {
          buf = (buf ? buf + ' ' : '') + sentences[s];
        } else {
          if (buf) parts.push(buf);
          if (sentences[s].length <= maxLen) {
            buf = sentences[s];
          } else {
            words = sentences[s].split(/\s+/);
            buf = '';
            for (w = 0; w < words.length; w++) {
              if ((buf + ' ' + words[w]).replace(/^\s+/, '').length <= maxLen) {
                buf = (buf ? buf + ' ' : '') + words[w];
              } else {
                if (buf) parts.push(buf);
                buf = words[w];
              }
            }
          }
        }
      }
      if (buf) parts.push(buf);
    }
    return parts.length ? parts : [text];
  }

  function renderAiAnswer(text) {
    var ul = $('aiChunks');
    if (!ul) {
      if ($('aiOut')) {
        $('aiOut').style.display = 'block';
        $('aiOut').textContent = text;
      }
      return 0;
    }
    ul.innerHTML = '';
    if ($('aiOut')) {
      $('aiOut').style.display = 'none';
      $('aiOut').textContent = text || '';
    }
    var chunks = chunkText(text, 130);
    var i, li;
    for (i = 0; i < chunks.length; i++) {
      li = document.createElement('li');
      li.className = 'ai-chunk';
      li.tabIndex = 0;
      li.setAttribute('data-ai-chunk', String(i));
      li.innerHTML = '<span class="part"></span><div class="body"></div>';
      li.querySelector('.part').textContent = (i + 1) + '/' + chunks.length;
      li.querySelector('.body').textContent = chunks[i];
      ul.appendChild(li);
    }
    return chunks.length;
  }

  function focusFirstAiChunk() {
    collect();
    var i;
    for (i = 0; i < items.length; i++) {
      if (items[i].getAttribute && items[i].getAttribute('data-ai-chunk') === '0') {
        focusAt(i);
        return;
      }
    }
    // fallback: scroll answer card into view
    if ($('aiAnswerCard')) ensureVisible($('aiAnswerCard'));
  }

  function ask(mode) {
    var msg = ($('aiIn') && $('aiIn').value || '').replace(/^\s+|\s+$/g, '');
    var notes = PocketStore.allText(40);
    var aiMode = (PocketStore.loadCfg().aiMode || 'notes');
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      setAiStatus('Set Bridge URL in Settings, then Ping.');
      renderAiAnswer('Set Bridge URL in Settings, then Ping.');
      return;
    }

    // Summarize always uses notes path
    var useHermes = (mode !== 'sum' && aiMode === 'hermes');
    var waiting = useHermes ? 'Hermes thinking…' : (mode === 'sum' ? 'Summarizing…' : 'Asking…');
    toast(waiting);
    setAiStatus(waiting);
    renderAiAnswer(waiting);
    try { ensureVisible($('aiAnswerCard') || $('btnAsk')); } catch (e0) {}
    log(useHermes ? 'hermes ask' : (mode === 'sum' ? 'summarize' : 'notes ask'));

    var p;
    if (useHermes) {
      p = PocketBridge.hermes(msg || 'Brief status of what you can help with on my Mac.');
    } else if (mode === 'sum') {
      p = PocketBridge.summarize(notes);
    } else {
      p = PocketBridge.chat(msg || 'Status of my notes?', notes);
    }

    p.then(function (r) {
      var text = (r && (r.reply || r.text || r.message || r.summary)) || JSON.stringify(r);
      var n = renderAiAnswer(text);
      var src = useHermes ? 'Hermes' : 'Notes AI';
      setAiStatus(src + (n > 1 ? (' · ' + n + ' parts · ↓ to read') : ' · done'));
      toast(n > 1 ? ('Done · ' + n + ' parts') : 'Done');
      setStatus('online', true);
      setTimeout(focusFirstAiChunk, 40);
    }).catch(function (e) {
      var err = String(e.message || e);
      renderAiAnswer('Error: ' + err);
      setAiStatus('Error');
      toast('AI: ' + err);
      log('ai fail: ' + err, 'err');
      setStatus('offline', false);
      setTimeout(focusFirstAiChunk, 40);
    });
  }

  function setMapsNow(txt) {
    if ($('mapsNow')) $('mapsNow').textContent = txt || '—';
  }

  function refreshMapsNow() {
    var home = PocketStore.getPlace('home');
    var work = PocketStore.getPlace('work');
    var bits = [];
    bits.push(home ? ('Home: ' + (home.name || 'set')) : 'Home: not set');
    bits.push(work ? ('Work: ' + (work.name || 'set')) : 'Work: not set');
    setMapsNow(bits.join(' · '));
    if ($('mapsHint')) $('mapsHint').textContent = 'OpenStreetMap · private · text steps';
  }

  function renderMapsSaved() {
    var ul = $('mapsSaved');
    if (!ul) return;
    ul.innerHTML = '';
    var slots = [
      { key: 'home', label: 'Home' },
      { key: 'work', label: 'Work' }
    ];
    var i, s, place, li;
    for (i = 0; i < slots.length; i++) {
      s = slots[i];
      place = PocketStore.getPlace(s.key);
      li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('data-saved', s.key);
      li.innerHTML = '<div class="name"></div><span class="sub"></span>';
      li.querySelector('.name').textContent = s.label + (place ? '' : ' (empty)');
      li.querySelector('.sub').textContent = place
        ? ((place.address || place.name || '').slice(0, 80))
        : 'Search a place, then Save as ' + s.label;
      (function (slot) {
        li.onclick = function () { navigateToSaved(slot); };
      })(s.key);
      ul.appendChild(li);
    }
    var fav = PocketStore.loadFavorites();
    for (i = 0; i < fav.length && i < 6; i++) {
      place = fav[i];
      li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('data-place-fav', String(i));
      li.innerHTML = '<div class="name"></div><span class="sub"></span>';
      li.querySelector('.name').textContent = place.name || 'Place';
      li.querySelector('.sub').textContent = (place.address || '').slice(0, 80);
      (function (p) {
        li.onclick = function () { startDirectionsTo(p); };
      })(place);
      ul.appendChild(li);
    }
    if ($('mapsSavedHint')) {
      $('mapsSavedHint').textContent = (homeWorkSet() ? 'Select a saved place to go' : 'Search → Select place → Save Home/Work');
    }
  }

  function homeWorkSet() {
    return !!(PocketStore.getPlace('home') || PocketStore.getPlace('work'));
  }

  function renderMapPlaces(list) {
    mapPlaces = list || [];
    var ul = $('mapsPlaces');
    if (!ul) return;
    ul.innerHTML = '';
    var i, p, li;
    for (i = 0; i < mapPlaces.length && i < 10; i++) {
      p = mapPlaces[i];
      li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('data-place-i', String(i));
      li.innerHTML = '<div class="name"></div><span class="sub"></span>';
      li.querySelector('.name').textContent = (i + 1) + '. ' + (p.name || 'Place');
      li.querySelector('.sub').textContent = (p.address || p.type || '').slice(0, 90);
      (function (place) {
        li.onclick = function () {
          mapSelected = place;
          startDirectionsTo(place);
        };
      })(p);
      ul.appendChild(li);
    }
  }

  function renderMapSteps(route) {
    mapSteps = (route && route.steps) || [];
    var ul = $('mapsSteps');
    if (!ul) return;
    ul.innerHTML = '';
    if ($('mapsRouteMeta')) {
      if (!route) {
        $('mapsRouteMeta').textContent = '—';
      } else {
        $('mapsRouteMeta').textContent =
          (route.distance || '') + ' · ' + (route.duration || '') + ' · ' +
          (route.mode || 'driving') + ' · ' + (route.step_count || mapSteps.length) + ' steps';
      }
    }
    var i, s, li;
    for (i = 0; i < mapSteps.length; i++) {
      s = mapSteps[i];
      li = document.createElement('li');
      li.className = 'ai-chunk';
      li.tabIndex = 0;
      li.setAttribute('data-step-i', String(i));
      li.innerHTML = '<span class="part"></span><div class="body"></div>';
      li.querySelector('.part').textContent = String(s.i || (i + 1));
      li.querySelector('.body').textContent =
        (s.text || '') + (s.distance ? (' · ' + s.distance) : '');
      ul.appendChild(li);
    }
  }

  function mapsSearch() {
    var q = ($('mapsQ') && $('mapsQ').value || '').replace(/^\s+|\s+$/g, '');
    if (!q) {
      toast('Type a place');
      setMapsNow('Type an address or place name');
      return;
    }
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      return;
    }
    toast('Searching…');
    setMapsNow('Searching OSM…');
    PocketBridge.mapsSearch(q, 8).then(function (r) {
      var list = (r && r.places) || [];
      renderMapPlaces(list);
      if (!list.length) {
        setMapsNow('No places found');
        toast('No places');
        return;
      }
      mapSelected = list[0];
      setMapsNow(list.length + ' places · Select to go');
      toast(list.length + ' places');
      log('maps search ' + q);
      setTimeout(function () {
        collect();
        var i;
        for (i = 0; i < items.length; i++) {
          if (items[i].getAttribute && items[i].getAttribute('data-place-i') === '0') {
            focusAt(i);
            return;
          }
        }
      }, 40);
    }).catch(function (e) {
      setMapsNow(String(e.message || e));
      toast('Maps: ' + (e.message || e));
      log('maps search fail: ' + (e.message || e), 'err');
    });
  }

  function mapsSaveSelected(slot) {
    var place = mapSelected;
    if (!place && items[idx] && items[idx].getAttribute) {
      var pi = items[idx].getAttribute('data-place-i');
      if (pi != null) place = mapPlaces[parseInt(pi, 10)];
    }
    if (!place || place.lat == null) {
      toast('Pick a search result first');
      return;
    }
    PocketStore.setPlace(slot, place);
    mapSelected = place;
    renderMapsSaved();
    refreshMapsNow();
    toast('Saved ' + slot + ': ' + (place.name || ''));
    log('maps save ' + slot);
  }

  function navigateToSaved(slot) {
    var place = PocketStore.getPlace(slot);
    if (!place || place.lat == null) {
      toast('Set ' + slot + ' first');
      setMapsNow('Search a place, then Save as ' + slot);
      return;
    }
    startDirectionsTo(place);
  }

  function startDirectionsTo(dest) {
    if (!dest || dest.lat == null || dest.lon == null) {
      toast('No destination');
      return;
    }
    mapSelected = dest;
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      return;
    }
    // Origin: Home if set, else geocode a default from saved home, else ask user
    var origin = PocketStore.getPlace('home');
    // If navigating TO home, use work as origin if available
    var destIsHome = false;
    var home = PocketStore.getPlace('home');
    if (home && home.lat === dest.lat && home.lon === dest.lon) destIsHome = true;
    if (destIsHome) {
      origin = PocketStore.getPlace('work') || origin;
    }
    if (!origin || origin.lat == null) {
      origin = PocketStore.getPlace('work');
    }
    if (!origin || origin.lat == null) {
      toast('Set Home first (origin)');
      setMapsNow('Save Home as your starting point, then navigate');
      return;
    }
    if (origin.lat === dest.lat && origin.lon === dest.lon) {
      toast('Already there');
      return;
    }

    toast('Routing…');
    setMapsNow('Routing via OSM…');
    if ($('mapsRouteMeta')) $('mapsRouteMeta').textContent = 'Routing…';
    renderMapSteps(null);

    PocketBridge.mapsDirections(
      { lat: origin.lat, lon: origin.lon, name: origin.name || 'Start' },
      { lat: dest.lat, lon: dest.lon, name: dest.name || 'Destination', address: dest.address || '' },
      'driving'
    ).then(function (route) {
      // favorites only (don't invent a _last slot as home)
      try {
        var pl = PocketStore.loadPlaces();
        var fav = pl.favorites || [];
        fav = fav.filter(function (f) {
          return !(f.lat === dest.lat && f.lon === dest.lon);
        });
        fav.unshift({
          name: dest.name || 'Place',
          address: dest.address || '',
          lat: dest.lat,
          lon: dest.lon
        });
        if (fav.length > 12) fav = fav.slice(0, 12);
        pl.favorites = fav;
        PocketStore.savePlaces(pl);
      } catch (eFav) {}
      renderMapsSaved();
      renderMapSteps(route);
      setMapsNow((route.distance || '') + ' · ' + (route.duration || '') + ' → ' + (dest.name || ''));
      toast((route.duration || 'OK') + ' · ' + (route.step_count || 0) + ' steps');
      log('maps route ' + (dest.name || ''));
      setTimeout(function () {
        collect();
        var i;
        for (i = 0; i < items.length; i++) {
          if (items[i].getAttribute && items[i].getAttribute('data-step-i') === '0') {
            focusAt(i);
            return;
          }
        }
      }, 40);
    }).catch(function (e) {
      setMapsNow(String(e.message || e));
      if ($('mapsRouteMeta')) $('mapsRouteMeta').textContent = String(e.message || e);
      toast('Route: ' + (e.message || e));
      log('maps route fail: ' + (e.message || e), 'err');
    });
  }

  function refreshTermHostNow() {
    var h = ($('termHost') && $('termHost').value) || termHost || 'local';
    var u = ($('termUser') && $('termUser').value) || termDefaultUser || '';
    if ($('termHostNow')) {
      $('termHostNow').textContent = 'Host: ' + h + (u ? (' · user ' + u) : '');
    }
  }

  function pickTermHost(h) {
    if (!h) return;
    termHost = h.target || h.ip || h.dns || h.name || 'local';
    if (h.self) termHost = 'local';
    if ($('termHost')) $('termHost').value = termHost;
    if (h.self && $('termUser') && !$('termUser').value && termDefaultUser) {
      $('termUser').value = termDefaultUser;
    }
    refreshTermHostNow();
    toast((h.online || h.self ? '' : 'offline · ') + termHost);
    log('term host ' + termHost);
  }

  function renderTermHosts(list) {
    termHostsList = list || [];
    var ul = $('termHosts');
    if (!ul) return;
    ul.innerHTML = '';
    var i, h, li, sub;
    for (i = 0; i < termHostsList.length && i < 20; i++) {
      h = termHostsList[i];
      li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('data-host-i', String(i));
      li.innerHTML = '<div class="name"></div><span class="sub"></span>';
      li.querySelector('.name').textContent =
        (h.self ? '★ ' : '') + (h.name || h.dns || h.ip || 'host') +
        (h.online || h.self ? '' : ' · off');
      sub = (h.ip || '') + (h.dns ? (' · ' + h.dns) : '') + (h.os ? (' · ' + h.os) : '');
      if (h.self) sub = 'this Mac (local shell, no sshd needed)';
      li.querySelector('.sub').textContent = sub;
      (function (host) {
        li.onclick = function () { pickTermHost(host); };
      })(h);
      ul.appendChild(li);
    }
  }

  function loadTermHosts() {
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      return;
    }
    toast('Hosts…');
    if ($('termHint')) $('termHint').textContent = 'Loading Tailscale hosts…';
    PocketBridge.termHosts().then(function (r) {
      termDefaultUser = (r && r.default_user) || termDefaultUser;
      if ($('termUser') && !$('termUser').value && termDefaultUser) {
        $('termUser').value = termDefaultUser;
      }
      var list = (r && r.hosts) || [];
      renderTermHosts(list);
      if ($('termHint')) {
        $('termHint').textContent =
          list.length + ' hosts · Select host · Run cmd (SSH keys on Mac)';
      }
      toast(list.length + ' hosts');
      log('term hosts ' + list.length);
      setTimeout(function () {
        collect();
        var i;
        for (i = 0; i < items.length; i++) {
          if (items[i].getAttribute && items[i].getAttribute('data-host-i') === '0') {
            focusAt(i);
            return;
          }
        }
      }, 40);
    }).catch(function (e) {
      if ($('termHint')) $('termHint').textContent = String(e.message || e);
      toast('Term: ' + (e.message || e));
      log('term hosts fail: ' + (e.message || e), 'err');
    });
  }

  function renderTermOutput(text, meta) {
    if ($('termMeta')) $('termMeta').textContent = meta || '—';
    var ul = $('termOut');
    if (!ul) return;
    ul.innerHTML = '';
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    if (!lines.length || (lines.length === 1 && !lines[0])) {
      lines = ['(no output)'];
    }
    // chunk long lines / cap total focusable rows
    var chunks = [];
    var i, line, part;
    for (i = 0; i < lines.length && chunks.length < 80; i++) {
      line = lines[i];
      if (line.length <= 120) {
        chunks.push(line);
      } else {
        while (line.length > 120 && chunks.length < 80) {
          chunks.push(line.slice(0, 120));
          line = line.slice(120);
        }
        if (line && chunks.length < 80) chunks.push(line);
      }
    }
    if (lines.length > 80) chunks.push('… truncated …');
    for (i = 0; i < chunks.length; i++) {
      var li = document.createElement('li');
      li.className = 'ai-chunk';
      li.tabIndex = 0;
      li.setAttribute('data-term-line', String(i));
      li.innerHTML = '<span class="part"></span><div class="body"></div>';
      li.querySelector('.part').textContent = String(i + 1);
      li.querySelector('.body').textContent = chunks[i] || ' ';
      ul.appendChild(li);
    }
  }

  function termRun() {
    var host = ($('termHost') && $('termHost').value || termHost || 'local').replace(/^\s+|\s+$/g, '');
    var user = ($('termUser') && $('termUser').value || '').replace(/^\s+|\s+$/g, '');
    var cmd = ($('termCmd') && $('termCmd').value || '').replace(/^\s+|\s+$/g, '');
    if (!host) host = 'local';
    if (!cmd) {
      toast('Type a command');
      return;
    }
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      return;
    }
    termHost = host;
    refreshTermHostNow();
    toast('Running…');
    if ($('termMeta')) $('termMeta').textContent = 'Running on ' + host + '…';
    renderTermOutput('…', 'Running…');
    PocketBridge.termExec(host, cmd, user || null, 90).then(function (r) {
      var out = '';
      if (r.stdout) out += r.stdout;
      if (r.stderr) out += (out ? '\n' : '') + r.stderr;
      if (r.error) out += (out ? '\n' : '') + r.error;
      var meta =
        (r.ok ? 'ok' : 'fail') +
        ' · exit ' + (r.exit_code != null ? r.exit_code : '?') +
        ' · ' + (r.mode || 'ssh') +
        ' · ' + (r.elapsed_s != null ? r.elapsed_s + 's' : '') +
        (r.truncated ? ' · truncated' : '');
      renderTermOutput(out || '(empty)', meta);
      toast(r.ok ? 'Done' : ('Exit ' + r.exit_code));
      log('term ' + host + ' ' + (r.ok ? 'ok' : 'fail'));
      setTimeout(function () {
        collect();
        var i;
        for (i = 0; i < items.length; i++) {
          if (items[i].getAttribute && items[i].getAttribute('data-term-line') === '0') {
            focusAt(i);
            return;
          }
        }
      }, 40);
    }).catch(function (e) {
      renderTermOutput(String(e.message || e), 'error');
      toast('Term: ' + (e.message || e));
      log('term fail: ' + (e.message || e), 'err');
    });
  }

  function setMusicNow(txt) {
    if ($('musicNow')) $('musicNow').textContent = txt || '—';
  }

  function stopPhoneAudio() {
    var a = $('musicPlayer');
    if (a) {
      try { a.pause(); } catch (e) {}
      try { a.removeAttribute('src'); a.load(); } catch (e2) {}
    }
    phonePlaying = false;
    setMusicNow('Stopped');
    toast('Stopped');
  }

  function playPhoneTrack(t) {
    if (!t) {
      toast('Search + pick a track');
      return;
    }
    lastTrack = t;
    lastUri = t.uri || lastUri;
    var url = t.preview_url || t.previewUrl || '';
    if (!url) {
      setMusicNow('No phone preview · use Remote for full track');
      toast('No phone audio — try Remote');
      return;
    }
    var a = $('musicPlayer');
    if (!a) {
      toast('No audio element');
      return;
    }
    setMusicNow('Phone · ' + (t.name || 'track'));
    toast('Playing on phone…');
    try {
      a.pause();
      a.src = url;
      a.load();
      var p = a.play();
      phonePlaying = true;
      if (p && p.then) {
        p.then(function () {
          phonePlaying = true;
          setMusicNow('▶ ' + (t.name || 'track'));
        }).catch(function (err) {
          phonePlaying = false;
          setMusicNow('Play failed');
          toast(String(err && err.message ? err.message : err));
        });
      }
    } catch (e) {
      phonePlaying = false;
      toast(String(e.message || e));
    }
  }

  function renderTracks(list) {
    tracks = list || [];
    var ul = $('musicList');
    if (!ul) return;
    ul.innerHTML = '';
    var i, t, li, can;
    for (i = 0; i < tracks.length && i < 8; i++) {
      t = tracks[i];
      can = !!(t.preview_url || t.previewUrl || t.can_play_on_phone);
      li = document.createElement('li');
      li.className = 'track' + (can ? '' : ' noprev');
      li.tabIndex = 0;
      li.setAttribute('data-track-i', String(i));
      li.innerHTML = '<span class="badge">' + (can ? 'PHONE' : 'REMOTE') + '</span>' +
        '<div class="name"></div><span class="sub"></span>';
      li.querySelector('.name').textContent = (i + 1) + '. ' + (t.name || 'Track');
      li.querySelector('.sub').textContent = (t.artists || '') + (t.album ? ' · ' + t.album : '');
      (function (track) {
        li.onclick = function () { playPhoneTrack(track); };
      })(t);
      ul.appendChild(li);
    }
  }

  function musicSearch() {
    var q = ($('musicQ') && $('musicQ').value || '').replace(/^\s+|\s+$/g, '');
    if (!q) {
      toast('Type a search first');
      setMusicNow('Type a song/artist, then Search.');
      return;
    }
    if (!PocketBridge.base()) {
      toast('Set bridge in Settings');
      setMusicNow('Set Bridge URL in Settings, then Ping.');
      return;
    }
    toast('Searching…');
    setMusicNow('Searching…');
    if ($('musicList')) $('musicList').innerHTML = '';
    PocketBridge.musicSearch(q).then(function (r) {
      if (r && r.ok === false) {
        setMusicNow(r.message || 'fail');
        toast(r.message || 'Search failed');
        return;
      }
      var list = (r && r.tracks) || [];
      if (!list.length) {
        setMusicNow('No tracks');
        toast('No tracks');
        return;
      }
      lastUri = list[0].uri;
      lastTrack = list[0];
      renderTracks(list);
      toast(list.length + ' tracks · Select to play');
      setMusicNow(list.length + ' results · ↓ then Select = play on phone');
      // focus first track so user can scroll results immediately
      setTimeout(function () {
        collect();
        var i;
        for (i = 0; i < items.length; i++) {
          if (items[i].getAttribute && items[i].getAttribute('data-track-i') === '0') {
            focusAt(i);
            return;
          }
        }
      }, 40);
    }).catch(function (e) {
      var err = String(e.message || e);
      setMusicNow(err);
      toast('Music: ' + err);
    });
  }

  function refreshMusicDeviceHint() {
    var c = PocketStore.loadCfg();
    if ($('musicDeviceHint')) {
      $('musicDeviceHint').textContent = c.musicDeviceName
        ? ('Remote device: ' + c.musicDeviceName)
        : 'Remote device: auto (first available)';
    }
  }

  function pickMusicDevice(d) {
    if (!d) return;
    var c = PocketStore.loadCfg();
    c.musicDeviceId = d.id || null;
    c.musicDeviceName = d.name || d.id || 'device';
    PocketStore.saveCfg(c);
    refreshMusicDeviceHint();
    toast('Device: ' + c.musicDeviceName);
    log('music device ' + c.musicDeviceName);
  }

  function loadMusicDevices() {
    toast('Devices…');
    PocketBridge.musicDevices().then(function (r) {
      musicDevices = (r && r.devices) || [];
      var ul = $('deviceList');
      if (!ul) return;
      ul.innerHTML = '';
      if (!musicDevices.length) {
        setMusicNow('No Spotify devices — open Spotify on TV/Mac');
        toast('No devices');
        return;
      }
      var i, d, li;
      for (i = 0; i < musicDevices.length; i++) {
        d = musicDevices[i];
        li = document.createElement('li');
        li.tabIndex = 0;
        li.setAttribute('data-device-i', String(i));
        li.innerHTML = '<div class="name"></div><span class="sub"></span>';
        li.querySelector('.name').textContent = (d.name || 'Device') + (d.is_active ? ' · active' : '');
        li.querySelector('.sub').textContent = (d.type || '') + (d.volume_percent != null ? ' · vol ' + d.volume_percent : '');
        (function (dev) {
          li.onclick = function () { pickMusicDevice(dev); };
        })(d);
        ul.appendChild(li);
      }
      toast(musicDevices.length + ' devices');
      setTimeout(function () {
        collect();
        var j;
        for (j = 0; j < items.length; j++) {
          if (items[j].getAttribute && items[j].getAttribute('data-device-i') === '0') {
            focusAt(j);
            return;
          }
        }
      }, 40);
    }).catch(function (e) {
      toast(String(e.message || e));
      log('devices: ' + (e.message || e), 'err');
    });
  }

  function musicCtrl(a) {
    if (a === 'play' && !lastUri && !(lastTrack && lastTrack.uri)) {
      toast('Pick a track first');
      return;
    }
    var uri = lastUri || (lastTrack && lastTrack.uri) || null;
    // If a track row is focused, prefer that
    var el = items[idx] || document.activeElement;
    if (el && el.getAttribute) {
      var ti = el.getAttribute('data-track-i');
      if (ti != null && tracks[parseInt(ti, 10)]) {
        lastTrack = tracks[parseInt(ti, 10)];
        uri = lastTrack.uri || uri;
        lastUri = uri;
      }
    }
    var devId = PocketStore.loadCfg().musicDeviceId || null;
    toast(a === 'play' ? 'Remote play…' : a + '…');
    setMusicNow((a === 'play' ? 'Remote… ' : a + '… ') + (lastTrack && lastTrack.name ? lastTrack.name : ''));
    PocketBridge.musicControl(a, uri, devId).then(function (r) {
      var dev = r.device || PocketStore.loadCfg().musicDeviceName || (r.ok ? 'ok' : JSON.stringify(r).slice(0, 80));
      setMusicNow((a === 'play' ? 'Remote ▶ ' : a + ' · ') + dev +
        (lastTrack && lastTrack.name ? ' · ' + lastTrack.name : ''));
      toast(a === 'play' ? ('Remote: ' + dev) : a);
      log('music ' + a + ' ' + dev);
    }).catch(function (e) {
      var err = String(e.message || e);
      setMusicNow(err);
      toast('Remote: ' + err);
      log('music fail: ' + err, 'err');
    });
  }

  /* ===== keys ===== */
  function onKeyDown(e) {
    var k = e.key || '';
    var kc = e.keyCode || e.which || 0;

    // 1) SIDE BUTTON STT only
    if (isSideSttKey(e)) {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      sttToggle();
      return;
    }

    // 2) Navigation keys
    // SoftLeft
    if (k === 'SoftLeft' || k === 'F1' || kc === 109 || kc === 112) {
      e.preventDefault();
      show('hub', false);
      return;
    }
    // SoftRight
    if (k === 'SoftRight' || k === 'F2' || kc === 113) {
      e.preventDefault();
      back();
      return;
    }
    // Select / OK / Enter — primary action (Ask / Search / Send / open)
    // On AI/Music we intentionally treat Select as submit even from text fields.
    // Notes textarea still allows newline unless focused on a button.
    if (k === 'Enter' || k === 'Accept' || k === 'OK' || kc === 13 || kc === 352) {
      var ae = document.activeElement;
      var tag = (ae && ae.tagName || '').toLowerCase();
      // Only keep raw newline in Notes textarea (not AI)
      if (tag === 'textarea' && view === 'notes' && ae && ae.id === 'note') {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      activate();
      return;
    }
    // Arrows
    if (k === 'ArrowDown' || kc === 40) {
      e.preventDefault();
      move(1);
      return;
    }
    if (k === 'ArrowUp' || kc === 38) {
      e.preventDefault();
      move(-1);
      return;
    }
    if (k === 'ArrowRight' || kc === 39) {
      // in text fields move caret
      var a = document.activeElement;
      if (isField(a)) return;
      e.preventDefault();
      move(1);
      return;
    }
    if (k === 'ArrowLeft' || kc === 37) {
      var a2 = document.activeElement;
      if (isField(a2)) {
        try {
          if (a2.selectionStart > 0) return;
        } catch (err) {}
      }
      e.preventDefault();
      move(-1);
      return;
    }
    if (k === 'Backspace' || k === 'BrowserBack' || kc === 8 || kc === 27) {
      var a3 = document.activeElement;
      if (isField(a3) && a3.value) return;
      e.preventDefault();
      back();
    }
  }

  function wireClicks() {
    // hub items also clickable
    var hub = $('hub');
    if (hub) {
      hub.onclick = function (e) {
        var t = e.target;
        while (t && t !== hub) {
          if (t.getAttribute && t.getAttribute('data-go')) {
            show(t.getAttribute('data-go'), true);
            return;
          }
          t = t.parentNode;
        }
      };
    }

    if ($('btnTalk')) {
      $('btnTalk').onclick = function () {
        remember($('note'));
        sttToggle();
      };
    }
    if ($('btnSave')) {
      $('btnSave').onclick = function () {
        var n = PocketStore.addNote($('note').value);
        if (!n) {
          toast('Empty');
          return;
        }
        $('note').value = '';
        renderNotes();
        toast('Saved');
        collect();
        focusAt(0);
      };
    }
    if ($('btnAsk')) $('btnAsk').onclick = function () { ask('chat'); };
    if ($('btnSum')) $('btnSum').onclick = function () { ask('sum'); };
    if ($('btnAiMode')) $('btnAiMode').onclick = toggleAiMode;
    if ($('btnMsgRefresh')) $('btnMsgRefresh').onclick = loadChats;
    if ($('btnMsgCompose')) {
      $('btnMsgCompose').onclick = function () { show('compose', true); };
    }
    if ($('btnContactSearch')) $('btnContactSearch').onclick = searchContacts;
    if ($('btnLogRefresh')) $('btnLogRefresh').onclick = function () { renderLog(); collect(); };
    if ($('btnSend')) $('btnSend').onclick = sendReply;
    if ($('btnReplyMic')) {
      $('btnReplyMic').onclick = function () {
        remember($('reply'));
        sttToggle();
      };
    }
    if ($('btnCompMic')) {
      $('btnCompMic').onclick = function () {
        remember($('msgBody'));
        sttToggle();
      };
    }
    if ($('btnCompSend')) {
      $('btnCompSend').onclick = function () {
        var to = ($('msgTo').value || '').replace(/^\s+|\s+$/g, '');
        var text = ($('msgBody').value || '').replace(/^\s+|\s+$/g, '');
        if (!text) {
          toast('Empty');
          return;
        }
        PocketBridge.messagesSend(to || null, text, null).then(function () {
          toast('Sent');
          if (to) PocketStore.pushRecent({ name: to, to: to });
          log('compose sent');
          $('msgBody').value = '';
          back();
        }).catch(function (e) {
          toast(String(e.message || e));
          log('compose fail: ' + (e.message || e), 'err');
        });
      };
    }
    if ($('btnMapsSearch')) $('btnMapsSearch').onclick = mapsSearch;
    if ($('btnNavHome')) $('btnNavHome').onclick = function () { navigateToSaved('home'); };
    if ($('btnNavWork')) $('btnNavWork').onclick = function () { navigateToSaved('work'); };
    if ($('btnSetHome')) $('btnSetHome').onclick = function () { mapsSaveSelected('home'); };
    if ($('btnSetWork')) $('btnSetWork').onclick = function () { mapsSaveSelected('work'); };
    if ($('btnTermHosts')) $('btnTermHosts').onclick = loadTermHosts;
    if ($('btnTermRun')) $('btnTermRun').onclick = termRun;
    if ($('btnSearch')) $('btnSearch').onclick = musicSearch;
    if ($('btnStop')) $('btnStop').onclick = stopPhoneAudio;
    if ($('btnRemote')) $('btnRemote').onclick = function () { musicCtrl('play'); };
    if ($('btnDevices')) $('btnDevices').onclick = loadMusicDevices;
    if ($('btnRemotePause')) $('btnRemotePause').onclick = function () { musicCtrl('pause'); };
    if ($('btnPlay')) $('btnPlay').onclick = function () { playPhoneTrack(lastTrack); };
    if ($('btnPause')) $('btnPause').onclick = function () { musicCtrl('pause'); };
    if ($('btnSaveCfg')) $('btnSaveCfg').onclick = saveCfg;
    if ($('btnPing')) $('btnPing').onclick = ping;

    var player = $('musicPlayer');
    if (player) {
      player.addEventListener('ended', function () {
        phonePlaying = false;
        setMusicNow('Preview ended');
      });
      player.addEventListener('error', function () {
        phonePlaying = false;
        setMusicNow('Audio error');
        toast('Audio error');
      });
    }

    document.addEventListener('focusin', function (e) {
      remember(e.target);
    }, true);
  }

  function boot() {
    // loadCfg() seeds from optional PocketLocalConfig / localStorage
    document.addEventListener('keydown', onKeyDown, true);
    // ignore keyup for STT (toggle on down only)
    document.addEventListener('keyup', function (e) {
      if (isSideSttKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    wireClicks();
    syncAiModeUi();
    refreshMusicDeviceHint();
    if ($('verLine')) $('verLine').textContent = 'B-Mud v' + (PocketStore.APP_VERSION || '0.7.0');
    layoutSoftCenter();
    setTimeout(layoutSoftCenter, 50);
    setTimeout(layoutSoftCenter, 300);
    window.addEventListener('resize', layoutSoftCenter, false);

    // Restore last screen if recent (< 24h) and not hub-only stack mess
    var sess = PocketStore.loadSession();
    var start = 'hub';
    if (sess && sess.view && sess.view !== 'hub' && map[sess.view] && sess.at && (Date.now() - sess.at) < 86400000) {
      // Don't restore thread without chat context
      if (sess.view !== 'thread' && sess.view !== 'compose') start = sess.view;
    }
    show(start, false);
    ping();
    log('boot v' + (PocketStore.APP_VERSION || '0.7.0') + ' → ' + start);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
