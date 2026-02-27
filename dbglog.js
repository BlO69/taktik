// ===== dbglog-capture.js =====
// Coller ce bloc AVANT l'exécution de game.js pour intercepter tout dès le départ.
(function(){
  const STORAGE_KEY = 'game_dbglogs_v1';
  const MAX_ENTRIES = 5000; // mémoire max
  const AUTO_OPEN_ON_ERROR = true;

  // restore previous logs
  let logs = [];
  try { logs = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') || []; } catch(e){ logs = []; }

  function saveStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(-MAX_ENTRIES)));
    } catch(e) {
      // si storage plein, supprimer les anciens
      logs = logs.slice(-Math.floor(MAX_ENTRIES/2));
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(logs)); } catch(_) {}
    }
  }

  // helper nice format
  function formatArg(a){
    try {
      if (typeof a === 'string') return a;
      return JSON.stringify(a, null, 0);
    } catch(e){ return String(a); }
  }

  // push a log entry (keeps last MAX_ENTRIES)
  function pushLog(level, args, meta){
    const entry = {
      ts: (new Date()).toISOString(),
      level: level,
      msg: args.map(formatArg).join(' '),
      meta: meta || {}
    };
    logs.push(entry);
    if (logs.length > MAX_ENTRIES) logs = logs.slice(-MAX_ENTRIES);
    saveStorage();
    if (panelVisible) renderEntry(entry);
  }

  // ----- UI PANEL -----
  let panelVisible = false;
  let autoScroll = true;
  let filterText = '';

  const css = `
  #dbg-panel { position: fixed; right: 12px; bottom: 12px; width: 420px; max-height: 55vh; background: rgba(20,20,20,0.92); color: #eee;
    font-family: monospace; font-size: 12px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 999999; overflow: hidden;}
  #dbg-panel .header { display:flex; gap:8px; align-items:center; padding:8px; background: rgba(0,0,0,0.25); }
  #dbg-panel .title { font-weight:700; flex:1; }
  #dbg-panel .controls button { margin-left:6px; }
  #dbg-panel .body { padding:8px; overflow:auto; max-height: calc(55vh - 96px); background: rgba(0,0,0,0.05); }
  #dbg-panel .entry { padding:4px 6px; border-bottom: 1px dashed rgba(255,255,255,0.03); white-space: pre-wrap; word-break: break-word; }
  #dbg-panel .entry.debug { color: #bcd; }
  #dbg-panel .entry.warn { color: #ffd27a; }
  #dbg-panel .entry.error { color: #ff9a9a; font-weight:700; }
  #dbg-toggle { position: fixed; right: 12px; bottom: 12px; z-index: 999998; background:#2b2b2b;color:#fff;border-radius: 50px;padding:8px 12px;font-family: sans-serif; cursor:pointer; box-shadow: 0 6px 18px rgba(0,0,0,0.5); }
  #dbg-filter { width:140px; }
  `;

  // inject CSS
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // create toggle button (shown when panel hidden)
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'dbg-toggle';
  toggleBtn.textContent = 'DBG';
  toggleBtn.title = 'Afficher le panneau de debug';
  toggleBtn.onclick = openPanel;
  document.body.appendChild(toggleBtn);

  // panel DOM
  const panel = document.createElement('div');
  panel.id = 'dbg-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="header">
      <div class="title">dbg logs</div>
      <div class="controls">
        <input id="dbg-filter" placeholder="filtre (texte)" />
        <label style="font-size:11px; margin-left:6px;">
          <input id="dbg-autoscroll" type="checkbox" checked /> auto
        </label>
        <button id="dbg-download">Télécharger</button>
        <button id="dbg-copy">Copier</button>
        <button id="dbg-clear">Effacer</button>
        <button id="dbg-close">×</button>
      </div>
    </div>
    <div class="body" id="dbg-body"></div>
  `;
  document.body.appendChild(panel);

  const bodyEl = panel.querySelector('#dbg-body');
  const filterEl = panel.querySelector('#dbg-filter');
  const autoEl = panel.querySelector('#dbg-autoscroll');
  panel.querySelector('#dbg-close').onclick = closePanel;
  panel.querySelector('#dbg-clear').onclick = clearLogs;
  panel.querySelector('#dbg-download').onclick = downloadLogs;
  panel.querySelector('#dbg-copy').onclick = copyLogs;
  autoEl.onchange = (e)=> { autoScroll = e.target.checked; };

  filterEl.oninput = function(e){
    filterText = e.target.value.trim().toLowerCase();
    renderAll();
  };

  function openPanel(){ panelVisible = true; panel.style.display='block'; toggleBtn.style.display='none'; renderAll(); }
  function closePanel(){ panelVisible = false; panel.style.display='none'; toggleBtn.style.display='block'; }

  function clearLogs(){
    logs = [];
    saveStorage();
    renderAll();
  }

  function getFilteredLogs(){
    if(!filterText) return logs;
    return logs.filter(l => (l.msg && l.msg.toLowerCase().includes(filterText)) || (l.level && l.level.includes(filterText)));
  }

  function renderAll(){
    bodyEl.innerHTML = '';
    const toShow = getFilteredLogs();
    const fragment = document.createDocumentFragment();
    toShow.forEach(renderEntryToFrag(fragment));
    bodyEl.appendChild(fragment);
    if(autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function renderEntry(entry){
    // apply filter
    if(filterText && !(entry.msg && entry.msg.toLowerCase().includes(filterText))) return;
    const div = document.createElement('div');
    div.className = 'entry ' + (entry.level||'debug');
    div.textContent = `[${entry.ts}] ${entry.level.toUpperCase()} — ${entry.msg}`;
    bodyEl.appendChild(div);
    if(autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function renderEntryToFrag(fragment){
    return function(entry){
      if(filterText && !(entry.msg && entry.msg.toLowerCase().includes(filterText))) return;
      const div = document.createElement('div');
      div.className = 'entry ' + (entry.level||'debug');
      div.textContent = `[${entry.ts}] ${entry.level.toUpperCase()} — ${entry.msg}`;
      fragment.appendChild(div);
    };
  }

  function downloadLogs() {
    const blob = new Blob([JSON.stringify(logs, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'game_dbglogs_' + (new Date()).toISOString().replace(/[:.]/g,'-') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function copyLogs(){
    try {
      navigator.clipboard.writeText(JSON.stringify(getFilteredLogs(), null, 2)).then(()=> {
        alert('Logs copiés dans le presse-papiers.');
      }, ()=> {
        prompt('Copier manuellement : ', JSON.stringify(getFilteredLogs(), null, 2));
      });
    } catch(e){
      prompt('Copier :', JSON.stringify(getFilteredLogs(), null, 2));
    }
  }

  // ----- Intercept dbgLog & console -----
  // preserve original
  const originalDbg = window.dbgLog;
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
  };

  // override dbgLog
  window.dbgLog = function(...args){
    try { pushLog('debug', args); } catch(e){}
    // call original if existed
    try {
      if (typeof originalDbg === 'function') originalDbg.apply(this, args);
      else originalConsole.log.apply(console, args);
    } catch(e){}
  };

  // wrap console methods too -- useful if game uses console directly
  console.log = function(...args){ try { pushLog('debug', args); } catch(e){}; originalConsole.log.apply(console, args); };
  console.info = function(...args){ try { pushLog('info', args); } catch(e){}; originalConsole.info.apply(console, args); };
  console.warn = function(...args){ try { pushLog('warn', args); } catch(e){}; originalConsole.warn.apply(console, args); };
  console.error = function(...args){ try { pushLog('error', args); } catch(e){}; originalConsole.error.apply(console, args); };

  // capture uncaught errors
  window.addEventListener('error', function(ev){
    try {
      const msg = ev && ev.message ? ev.message : (ev && ev.error && ev.error.stack) || JSON.stringify(ev);
      pushLog('error', [ 'UncaughtError:', msg ]);
      if (AUTO_OPEN_ON_ERROR) openPanel();
    } catch(e){}
  });

  window.addEventListener('unhandledrejection', function(ev){
    try {
      const reason = ev && ev.reason ? ev.reason : ev;
      pushLog('error', [ 'UnhandledRejection:', reason ]);
      if (AUTO_OPEN_ON_ERROR) openPanel();
    } catch(e){}
  });

  // expose helpers
  window._dbgLogger = {
    getLogs: () => logs.slice(),
    clear: clearLogs,
    download: downloadLogs,
    openUI: openPanel,
    closeUI: closePanel,
    setAutoScroll: v => { autoScroll = !!v; autoEl.checked = !!v; },
    setFilter: t => { filterText = String(t||'').toLowerCase(); filterEl.value = t; renderAll(); }
  };

  // initial render only when user opens panel (or if logs contain errors, open automatically)
  const hasErrors = logs.some(l => l.level === 'error');
  if (hasErrors && AUTO_OPEN_ON_ERROR) openPanel();

  // small safety: if DOM not ready, wait
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ()=> {
      // re-attach toggles if toggle was added earlier to body not present
      // (we already appended at script run time, should be OK)
    });
  }
})();