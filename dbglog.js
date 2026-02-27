// ===== dbglog_capture.js =====
// Coller ce bloc AVANT l'exécution de game.js pour intercepter tout dès le départ.
// Version : corrigée / plus robuste (initialisation DOM sûre, idempotence, fallbacks)
(function(){
  // Protect against double-inclusion
  if (window._dbgLoggerInitialized) return;
  window._dbgLoggerInitialized = true;

  const STORAGE_KEY = 'game_dbglogs_v1';
  const MAX_ENTRIES = 5000; // nombre maximum d'entrées gardées en localStorage
  const AUTO_OPEN_ON_ERROR = true;

  // runtime state
  let logs = [];
  try { logs = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') || []; } catch(e){ logs = []; }

  function saveStorage() {
    try {
      // keep last MAX_ENTRIES
      localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(-MAX_ENTRIES)));
    } catch (e) {
      // si storage plein ou inaccessible, garder une portion et retenter
      try {
        logs = logs.slice(-Math.floor(MAX_ENTRIES/2));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
      } catch (_) { /* fail silently */ }
    }
  }

  // helper nice format
  function formatArg(a){
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message || String(a);
      return JSON.stringify(a, null, 0);
    } catch(e){ return String(a); }
  }

  // push a log entry (keeps last MAX_ENTRIES)
  function pushLog(level, args, meta){
    const entry = {
      ts: (new Date()).toISOString(),
      level: level || 'debug',
      msg: Array.from(args || []).map(formatArg).join(' '),
      meta: meta || {}
    };
    logs.push(entry);
    if (logs.length > MAX_ENTRIES) logs = logs.slice(-MAX_ENTRIES);
    saveStorage();
    // render if UI already visible
    try { if (panelVisible) renderEntry(entry); } catch(e){}
  }

  // ----- UI STATE -----
  let panelVisible = false;
  let autoScroll = true;
  let filterText = '';
  let uiReady = false;

  // DOM refs (populated by initUI)
  let panel, bodyEl, filterEl, autoEl, toggleBtn;

  // CSS for panel
  const css = `
  #dbg-panel { position: fixed; right: 12px; bottom: 12px; width: 420px; max-height: 55vh; background: rgba(20,20,20,0.92); color: #eee;
    font-family: monospace; font-size: 12px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 999999; overflow: hidden;}
  #dbg-panel .header { display:flex; gap:8px; align-items:center; padding:8px; background: rgba(0,0,0,0.25); }
  #dbg-panel .title { font-weight:700; flex:1; }
  #dbg-panel .controls { display:flex; gap:6px; align-items:center; }
  #dbg-panel .controls button, #dbg-panel .controls input { font-size: 11px; }
  #dbg-panel .body { padding:8px; overflow:auto; max-height: calc(55vh - 96px); background: rgba(0,0,0,0.03); }
  #dbg-panel .entry { padding:4px 6px; border-bottom: 1px dashed rgba(255,255,255,0.03); white-space: pre-wrap; word-break: break-word; }
  #dbg-panel .entry.debug { color: #bcd; }
  #dbg-panel .entry.info { color: #9fd; }
  #dbg-panel .entry.warn { color: #ffd27a; }
  #dbg-panel .entry.error { color: #ff9a9a; font-weight:700; }
  #dbg-toggle { position: fixed; right: 12px; bottom: 12px; z-index: 999998; background:#2b2b2b;color:#fff;border-radius: 50px;padding:8px 12px;font-family: sans-serif; cursor:pointer; box-shadow: 0 6px 18px rgba(0,0,0,0.5); border:0; }
  #dbg-filter { width:140px; padding:4px 6px; border-radius:4px; border: none; outline: none; background: rgba(255,255,255,0.06); color:inherit; }
  #dbg-panel button { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.04); color:inherit; padding:4px 8px; border-radius:4px; cursor:pointer; }
  #dbg-panel button:active { transform: translateY(1px); }
  `;

  // create UI only when DOM ready
  function initUI() {
    if (uiReady) return;
    uiReady = true;
    try {
      // inject CSS into head (if available)
      try {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      } catch (e) { /* ignore */ }

      // create toggle button only if not present
      if (!document.getElementById('dbg-toggle')) {
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'dbg-toggle';
        toggleBtn.textContent = 'DBG';
        toggleBtn.title = 'Afficher le panneau de debug';
        toggleBtn.style.display = 'block';
        document.body.appendChild(toggleBtn);
      } else {
        toggleBtn = document.getElementById('dbg-toggle');
      }

      // create panel only if not present
      if (!document.getElementById('dbg-panel')) {
        panel = document.createElement('div');
        panel.id = 'dbg-panel';
        panel.style.display = 'none';
        panel.innerHTML = `
          <div class="header">
            <div class="title">dbg logs</div>
            <div class="controls">
              <input id="dbg-filter" placeholder="filtre (texte)" />
              <label style="font-size:11px; display:flex; align-items:center; gap:6px; margin-left:6px;">
                <input id="dbg-autoscroll" type="checkbox" checked /> auto
              </label>
              <button id="dbg-download">Télécharger</button>
              <button id="dbg-copy">Copier</button>
              <button id="dbg-clear">Effacer</button>
              <button id="dbg-close">×</button>
            </div>
          </div>
          <div class="body" id="dbg-body" role="log" aria-live="polite"></div>
        `;
        document.body.appendChild(panel);
      } else {
        panel = document.getElementById('dbg-panel');
      }

      bodyEl = panel.querySelector('#dbg-body');
      filterEl = panel.querySelector('#dbg-filter');
      autoEl = panel.querySelector('#dbg-autoscroll');

      // wire events
      toggleBtn.onclick = openPanel;
      panel.querySelector('#dbg-close').onclick = closePanel;
      panel.querySelector('#dbg-clear').onclick = clearLogs;
      panel.querySelector('#dbg-download').onclick = downloadLogs;
      panel.querySelector('#dbg-copy').onclick = copyLogs;
      if (autoEl) autoEl.onchange = (e)=> { autoScroll = !!e.target.checked; };
      if (filterEl) {
        filterEl.oninput = function(e){
          filterText = (e.target.value || '').trim().toLowerCase();
          renderAll();
        };
      }

      // render initially if panel should be open because of prior errors
      const hasErrors = logs.some(l => l.level === 'error');
      if (hasErrors && AUTO_OPEN_ON_ERROR) {
        openPanel();
      }

    } catch (e) {
      // UI failed: still keep logger functional, but no visual UI
      uiReady = false;
      try { console.warn('dbglog_capture: initUI failed', e); } catch(_) {}
    }
  }

  // open/close
  function openPanel(){
    try {
      if (!uiReady) initUI();
      if (!panel) return;
      panelVisible = true;
      panel.style.display = 'block';
      if (toggleBtn) toggleBtn.style.display = 'none';
      renderAll();
    } catch (e) { /* ignore */ }
  }
  function closePanel(){
    try {
      panelVisible = false;
      if (panel) panel.style.display = 'none';
      if (toggleBtn) toggleBtn.style.display = 'block';
    } catch (e) { /* ignore */ }
  }

  function clearLogs(){
    logs = [];
    saveStorage();
    renderAll();
  }

  function getFilteredLogs(){
    if(!filterText) return logs;
    return logs.filter(l => {
      const m = l.msg || '';
      const lv = (l.level || '').toLowerCase();
      return (m && m.toLowerCase().includes(filterText)) || lv.includes(filterText);
    });
  }

  function renderAll(){
    try {
      if (!uiReady) initUI();
      if (!bodyEl) return;
      bodyEl.innerHTML = '';
      const toShow = getFilteredLogs();
      const fragment = document.createDocumentFragment();
      for (const entry of toShow) {
        if (filterText && !(String(entry.msg || '').toLowerCase().includes(filterText) || String(entry.level || '').toLowerCase().includes(filterText))) continue;
        const div = document.createElement('div');
        div.className = 'entry ' + (entry.level||'debug');
        div.textContent = `[${entry.ts}] ${String(entry.level||'').toUpperCase()} — ${entry.msg}`;
        fragment.appendChild(div);
      }
      bodyEl.appendChild(fragment);
      if (autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
    } catch (e) { /* ignore */ }
  }

  function renderEntry(entry){
    try {
      if (!uiReady) initUI();
      if (!bodyEl) return;
      // apply filter
      if (filterText && !(String(entry.msg || '').toLowerCase().includes(filterText) || String(entry.level || '').toLowerCase().includes(filterText))) return;
      const div = document.createElement('div');
      div.className = 'entry ' + (entry.level||'debug');
      div.textContent = `[${entry.ts}] ${String(entry.level||'').toUpperCase()} — ${entry.msg}`;
      bodyEl.appendChild(div);
      if (autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
    } catch (e) { /* ignore */ }
  }

  function downloadLogs() {
    try {
      const blob = new Blob([JSON.stringify(logs, null, 2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'game_dbglogs_' + (new Date()).toISOString().replace(/[:.]/g,'-') + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      try { alert('Impossible de préparer le téléchargement des logs.'); } catch(_) {}
    }
  }

  function copyLogs(){
    const payload = JSON.stringify(getFilteredLogs(), null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload).then(()=> {
        try { alert('Logs copiés dans le presse-papiers.'); } catch(_) {}
      }).catch(() => {
        fallbackCopyPrompt(payload);
      });
      return;
    }
    fallbackCopyPrompt(payload);
  }

  function fallbackCopyPrompt(text){
    try {
      // last resort: show prompt so user can Ctrl+C
      prompt('Copier manuellement : (CTRL/CMD + C)', text);
    } catch (e) { /* ignore */ }
  }

  // ----- Intercept dbgLog & console -----
  // preserve original dbgLog if present
  const originalDbg = window.dbgLog;
  // preserve original console functions
  const originalConsole = {
    log: console.log && console.log.bind ? console.log.bind(console) : console.log,
    warn: console.warn && console.warn.bind ? console.warn.bind(console) : console.warn,
    error: console.error && console.error.bind ? console.error.bind(console) : console.error,
    info: console.info && console.info.bind ? console.info.bind(console) : console.info
  };

  // override dbgLog
  window.dbgLog = function(...args){
    try { pushLog('debug', args); } catch(e){}
    // call original if existed
    try {
      if (typeof originalDbg === 'function') originalDbg.apply(this, args);
      else if (originalConsole.log) originalConsole.log.apply(console, args);
    } catch(e){}
  };

  // wrap console methods too -- useful if game uses console directly
  try {
    console.log = function(...args){ try { pushLog('debug', args); } catch(e){}; try { originalConsole.log.apply(console, args); } catch(e){}; };
    console.info = function(...args){ try { pushLog('info', args); } catch(e){}; try { originalConsole.info.apply(console, args); } catch(e){}; };
    console.warn = function(...args){ try { pushLog('warn', args); } catch(e){}; try { originalConsole.warn.apply(console, args); } catch(e){}; };
    console.error = function(...args){ try { pushLog('error', args); } catch(e){}; try { originalConsole.error.apply(console, args); } catch(e){}; };
  } catch (e) {
    // If console is non-writable in this environment, ignore
  }

  // capture uncaught errors
  window.addEventListener('error', function(ev){
    try {
      let msg = 'UncaughtError:';
      if (ev && ev.message) msg += ' ' + ev.message;
      else if (ev && ev.error && ev.error.stack) msg += ' ' + ev.error.stack;
      else msg += ' ' + JSON.stringify(ev);
      pushLog('error', [ msg ]);
      if (AUTO_OPEN_ON_ERROR) {
        try { initUI(); openPanel(); } catch(_) {}
      }
    } catch(e){}
  });

  window.addEventListener('unhandledrejection', function(ev){
    try {
      const reason = ev && ev.reason ? ev.reason : ev;
      pushLog('error', [ 'UnhandledRejection:', reason ]);
      if (AUTO_OPEN_ON_ERROR) {
        try { initUI(); openPanel(); } catch(_) {}
      }
    } catch(e){}
  });

  // Exposed helpers (safe even if UI not yet inited)
  window._dbgLogger = {
    getLogs: () => logs.slice(),
    clear: () => { clearLogs(); },
    download: () => { try { initUI(); downloadLogs(); } catch(e){ downloadLogs(); } },
    openUI: () => { try { initUI(); openPanel(); } catch(e){} },
    closeUI: () => { try { initUI(); closePanel(); } catch(e){} },
    setAutoScroll: v => { autoScroll = !!v; if (uiReady && autoEl) autoEl.checked = !!v; },
    setFilter: t => { filterText = String(t||'').toLowerCase(); if (uiReady && filterEl) filterEl.value = t; renderAll(); },
    _rawLogsRef: () => logs // internal helper (not recommended)
  };

  // initial UI init when DOM ready (but don't require it immediately)
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUI, { once: true });
    } else {
      // DOM already ready
      initUI();
    }
  } catch (e) {
    // if anything goes wrong, still allow the logger to capture logs without UI.
  }

  // End of IIFE
})();
