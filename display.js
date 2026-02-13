// display.js
// Panel "Affichage" — intègre fab.js et maingame.js via CustomEvents.
// Usage: <script src="./display.js" defer></script>

(function () {
  if (window.__display_panel_inited) return;
  window.__display_panel_inited = true;

  const STORAGE_KEY = 'displayPanelState';

  // default state
  const DEFAULT = {
    video1: true,
    video2: true,
    video3: true,
    mini_map: true,
    commentaires: false,
    grilleSize: 20
  };

  // Styles injectés
  const css = `
  .display-panel {
    position: fixed;
    right: 20px;
    bottom: 96px;
    width: 300px;
    max-width: calc(100% - 40px);
    background: white;
    border-radius: 12px;
    box-shadow: 0 16px 40px rgba(2,6,23,0.25);
    z-index: 10000;
    font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
    padding: 12px;
  }
  .display-panel h3 { margin:0 0 8px 0; font-size:15px; }
  .display-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 6px; border-radius:8px; }
  .display-row + .display-row { margin-top:6px; }
  .display-row .left { display:flex; align-items:center; gap:10px; }
  .display-toggle { width:42px; height:26px; border-radius:999px; background:#eee; position:relative; cursor:pointer; }
  .display-toggle .knob { position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:white; box-shadow:0 2px 6px rgba(2,6,23,0.12); transition:left .18s ease; }
  .display-toggle.on { background: linear-gradient(90deg,#06b6d4,#3b82f6); }
  .display-toggle.on .knob { left:19px; }
  .display-select { width:120px; padding:6px 8px; border-radius:8px; border:1px solid rgba(2,6,23,0.06); background:#fff; font-size:13px; }
  .display-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; }
  .display-btn { padding:8px 10px; border-radius:8px; border: none; cursor:pointer; font-weight:600; }
  .display-btn.ghost { background:#f8fafc; border:1px solid rgba(2,6,23,0.04); }
  .display-close { position:absolute; top:8px; right:8px; background:transparent; border:none; cursor:pointer; font-weight:700; font-size:14px; }
  @media (max-width:640px){ .display-panel { right:12px; left:12px; bottom:84px; width:auto; } }
  `;

  function injectStyles() {
    if (document.getElementById('display-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'display-panel-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // storage helpers
  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT };
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT, parsed);
    } catch (e) {
      return { ...DEFAULT };
    }
  }
  function writeState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore */ }
  }

  // dispatch helpers (emit events maingame.js attend)
  function dispatchVideo(name, enabled) {
    try { document.dispatchEvent(new CustomEvent(`display:${name}`, { detail: { enabled: !!enabled } })); } catch(e){}
  }
  function dispatchMiniMap(enabled) {
    try { document.dispatchEvent(new CustomEvent('display:mini_map', { detail: { enabled: !!enabled } })); } catch(e){}
  }
  function dispatchCommentaires(enabled) {
    try { document.dispatchEvent(new CustomEvent('display:commentaires', { detail: { enabled: !!enabled } })); } catch(e){}
  }
  function dispatchGrille(size) {
    try { document.dispatchEvent(new CustomEvent('display:grille', { detail: { size: Number(size) } })); } catch(e){}
  }

  // Create panel DOM
  let panelEl = null;
  function buildPanel() {
    if (panelEl) return panelEl;
    injectStyles();
    const state = readState();

    panelEl = document.createElement('div');
    panelEl.className = 'display-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Paramètres d\'affichage');

    panelEl.innerHTML = `
      <button class="display-close" aria-label="Fermer">✕</button>
      <h3>Affichage</h3>
      <div class="display-row" data-row="videos">
        <div class="left"><strong>Vidéos</strong><div style="font-size:12px;color:#64748b">Choisir les canvas visibles</div></div>
        <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
          <label style="font-size:13px;display:flex;align-items:center;gap:8px">
            <span style="min-width:64px">Joueur 1</span>
            <div data-toggle="video1" class="display-toggle"><div class="knob"></div></div>
          </label>
          <label style="font-size:13px;display:flex;align-items:center;gap:8px">
            <span style="min-width:64px">Joueur 2</span>
            <div data-toggle="video2" class="display-toggle"><div class="knob"></div></div>
          </label>
          <label style="font-size:13px;display:flex;align-items:center;gap:8px">
            <span style="min-width:64px">Animateur</span>
            <div data-toggle="video3" class="display-toggle"><div class="knob"></div></div>
          </label>
        </div>
      </div>

      <div class="display-row" data-row="grille">
        <div class="left"><strong>Grille</strong><div style="font-size:12px;color:#64748b">Taille de la grille</div></div>
        <select class="display-select" data-select="grilleSize" aria-label="Taille de la grille">
          <option value="9">9 × 9</option>
          <option value="12">12 × 12</option>
          <option value="15">15 × 15</option>
          <option value="20">20 × 20</option>
        </select>
      </div>

      <div class="display-row" data-row="minimap">
        <div class="left"><strong>Mini-map</strong><div style="font-size:12px;color:#64748b">Afficher la mini-map</div></div>
        <div data-toggle="mini_map" class="display-toggle"><div class="knob"></div></div>
      </div>

      <div class="display-row" data-row="comments">
        <div class="left"><strong>Mini-comments</strong><div style="font-size:12px;color:#64748b">Afficher mini-card commentaires</div></div>
        <div data-toggle="commentaires" class="display-toggle"><div class="knob"></div></div>
      </div>

      <div class="display-actions">
        <button class="display-btn ghost" data-action="reset">Réinitialiser</button>
        <button class="display-btn" data-action="apply">Appliquer</button>
      </div>
    `;

    // attach to body but hidden initially
    panelEl.style.display = 'none';
    document.body.appendChild(panelEl);

    // wire controls
    const toggles = panelEl.querySelectorAll('[data-toggle]');
    toggles.forEach(t => {
      const key = t.getAttribute('data-toggle');
      const on = !!state[key];
      t.classList.toggle('on', on);
      t.setAttribute('aria-pressed', String(on));
      t.addEventListener('click', () => {
        const now = !t.classList.contains('on');
        t.classList.toggle('on', now);
        t.setAttribute('aria-pressed', String(now));
      });
    });

    const sel = panelEl.querySelector('[data-select="grilleSize"]');
    if (sel) sel.value = String(state.grilleSize || DEFAULT.grilleSize);

    // actions
    panelEl.querySelector('.display-close').addEventListener('click', closePanel);
    panelEl.querySelector('[data-action="apply"]').addEventListener('click', () => {
      applyFromUI();
      closePanel();
    });
    panelEl.querySelector('[data-action="reset"]').addEventListener('click', () => {
      writeState(DEFAULT);
      applyState(DEFAULT);
      syncUIWithState(DEFAULT);
    });

    // close on outside click / Esc
    setTimeout(() => { // allow panel to be appended before watcher
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onKeyDown);
    }, 20);

    return panelEl;
  }

  function syncUIWithState(state) {
    if (!panelEl) return;
    panelEl.querySelectorAll('[data-toggle]').forEach(t => {
      const key = t.getAttribute('data-toggle');
      const on = !!state[key];
      t.classList.toggle('on', on);
      t.setAttribute('aria-pressed', String(on));
    });
    const sel = panelEl.querySelector('[data-select="grilleSize"]');
    if (sel) sel.value = String(state.grilleSize || DEFAULT.grilleSize);
  }

  function applyFromUI() {
    if (!panelEl) return;
    const next = readState();
    panelEl.querySelectorAll('[data-toggle]').forEach(t => {
      const key = t.getAttribute('data-toggle');
      next[key] = !!t.classList.contains('on');
    });
    const sel = panelEl.querySelector('[data-select="grilleSize"]');
    if (sel) next.grilleSize = Number(sel.value) || DEFAULT.grilleSize;
    writeState(next);
    applyState(next);
  }

  function applyState(state) {
    // videos
    dispatchVideo('video1', state.video1);
    dispatchVideo('video2', state.video2);
    dispatchVideo('video3', state.video3);

    // minimap & comments
    dispatchMiniMap(state.mini_map);
    dispatchCommentaires(state.commentaires);

    // grille
    dispatchGrille(state.grilleSize);
  }

  // panel open/close
  function openPanel() {
    buildPanel();
    syncUIWithState(readState());
    panelEl.style.display = '';
    // trap focus a tiny bit
    const firstButton = panelEl.querySelector('button,select');
    try { firstButton && firstButton.focus(); } catch(e){}
  }
  function closePanel() {
    if (!panelEl) return;
    panelEl.style.display = 'none';
  }

  function togglePanel() {
    buildPanel();
    if (panelEl.style.display === 'none' || getComputedStyle(panelEl).display === 'none') openPanel(); else closePanel();
  }

  function onDocClick(e) {
    if (!panelEl) return;
    if (!panelEl.contains(e.target)) {
      // allow clicks on fab to not close immediately (fab sits nearby)
      const fabRoot = document.querySelector('.fab-root');
      if (fabRoot && fabRoot.contains(e.target)) return;
      closePanel();
    }
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') closePanel();
  }

  // register to fab (best-effort). fab dispatches CustomEvent `fab:affichage` AND offers registerHandler API.
  function bindToFab() {
    // listen for custom event from fab
    document.addEventListener('fab:affichage', () => {
      togglePanel();
    });

    // prefer registerHandler if available
    if (window.fab && typeof window.fab.registerHandler === 'function') {
      try {
        window.fab.registerHandler('affichage', (detail) => {
          // the handler may be async — just toggle panel
          togglePanel();
        });
      } catch (e) { /* ignore */ }
    } else {
      // if fab isn't present yet, poll briefly to register when available
      let attempts = 0;
      const t = setInterval(() => {
        attempts++;
        if (window.fab && typeof window.fab.registerHandler === 'function') {
          try {
            window.fab.registerHandler('affichage', () => togglePanel());
          } catch (e) {}
          clearInterval(t);
        } else if (attempts > 30) {
          clearInterval(t);
        }
      }, 100);
    }
  }

  // apply initial state on load so maingame gets the values (maingame already reads localStorage but we also emit to be safe)
  function applyInitial() {
    const state = readState();
    // ensure all keys exist
    const s = Object.assign({}, DEFAULT, state);
    writeState(s);
    // emit
    setTimeout(() => applyState(s), 60);
  }

  // init
  (function init() {
    injectStyles();
    bindToFab();
    applyInitial();
  })();

})();