// display.js
// Gère l'option "affichage" du FAB et applique les changements sur game.html
// Usage: <script src="./display.js" defer></script>

(function () {
  if (window.displayPanel) return;

  const DEFAULTS = {
    video1: true,
    video2: true,
    video3: true,
    mini_map: true,
    commentaires: true,
    grilleSize: 20 // 9 | 15 | 20
  };

  const OPTIONS = [
    { key: 'video1', label: 'Activer / désactiver vidéo 1' },
    { key: 'video2', label: 'Activer / désactiver vidéo 2' },
    { key: 'video3', label: 'Activer / désactiver vidéo 3' },
    { key: 'mini_map', label: 'Mini-map' },
    { key: 'commentaires', label: 'Commentaires' },
    // grille handled separately (has choices)
  ];

  let panel = null;
  let state = loadState();

  const style = `
  .display-panel {
    position: fixed;
    right: 20px;
    bottom: 90px;
    width: 280px;
    background: white;
    border-radius: 14px;
    box-shadow: 0 18px 40px rgba(0,0,0,0.18);
    padding: 10px;
    font-family: Inter, system-ui;
    z-index: 10010;
    animation: dp-fade .18s ease;
  }
  @keyframes dp-fade { from { opacity:0; transform: translateY(6px) scale(.98); } to { opacity:1; transform: translateY(0) scale(1); } }
  .display-title { font-weight:700; font-size:13px; color:#0f172a; margin-bottom:8px; }
  .display-item { display:flex; align-items:center; justify-content:space-between; padding:8px; border-radius:8px; cursor:pointer; font-size:14px; }
  .display-item:hover { background: rgba(2,6,23,0.03); }
  .display-toggle { width:42px; height:24px; border-radius:999px; background:#cbd5e1; position:relative; transition:.15s; flex-shrink:0; }
  .display-toggle::after { content:''; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:white; transition:.15s; box-shadow:0 2px 6px rgba(0,0,0,.12); }
  .display-toggle.on { background: linear-gradient(135deg,#06b6d4,#3b82f6); }
  .display-toggle.on::after { transform: translateX(18px); }
  .grille-controls { display:flex; gap:6px; padding:6px 0 0 0; }
  .grille-btn { flex:1; padding:6px 8px; border-radius:8px; background:#f1f5f9; text-align:center; font-weight:600; cursor:pointer; font-size:13px; }
  .grille-btn.active { background: linear-gradient(135deg,#06b6d4,#3b82f6); color:white; }
  .mini-comments {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 18px;
    width: min(680px, calc(100% - 40px));
    max-height: 160px;
    overflow:auto;
    background: rgba(255,255,255,0.98);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(2,6,23,0.12);
    padding: 10px;
    z-index: 10005;
    font-size: 13px;
  }
  .mini-comments .title { font-weight:700; margin-bottom:6px; }
  `;

  function injectStyles() {
    if (document.getElementById('display-styles')) return;
    const s = document.createElement('style');
    s.id = 'display-styles';
    s.textContent = style;
    document.head.appendChild(s);
  }

  function buildPanel() {
    injectStyles();
    if (panel) return;

    panel = document.createElement('div');
    panel.className = 'display-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Panneau affichage');

    const title = document.createElement('div');
    title.className = 'display-title';
    title.innerText = 'Affichage';
    panel.appendChild(title);

    // Toggle items
    OPTIONS.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'display-item';
      item.dataset.key = opt.key;

      const label = document.createElement('div');
      label.innerText = opt.label;

      const toggle = document.createElement('div');
      toggle.className = 'display-toggle';
      if (state[opt.key]) toggle.classList.add('on');

      item.appendChild(label);
      item.appendChild(toggle);
      item.addEventListener('click', () => {
        state[opt.key] = !state[opt.key];
        toggle.classList.toggle('on', state[opt.key]);
        applyToggle(opt.key, state[opt.key]);
        persistState();
        emit(opt.key, { enabled: state[opt.key] });
      });

      panel.appendChild(item);
    });

    // Grille controls (size choices)
    const grilleTitle = document.createElement('div');
    grilleTitle.className = 'display-item';
    grilleTitle.style.paddingTop = '8px';
    grilleTitle.style.borderTop = '1px solid rgba(2,6,23,0.04)';
    grilleTitle.style.marginTop = '8px';

    const gLabel = document.createElement('div');
    gLabel.innerText = 'Grille';
    const gSub = document.createElement('div');
    gSub.style.fontSize = '12px';
    gSub.style.color = '#64748b';
    gSub.innerText = `${state.grilleSize} x ${state.grilleSize}`;
    grilleTitle.appendChild(gLabel);
    grilleTitle.appendChild(gSub);
    panel.appendChild(grilleTitle);

    const grilleControls = document.createElement('div');
    grilleControls.className = 'grille-controls';
    [9, 15, 20].forEach(sz => {
      const b = document.createElement('div');
      b.className = 'grille-btn';
      b.innerText = `${sz}x${sz}`;
      b.dataset.size = String(sz);
      if (state.grilleSize === sz) b.classList.add('active');
      b.addEventListener('click', () => {
        selectGridSize(sz);
        // update label
        gSub.innerText = `${state.grilleSize} x ${state.grilleSize}`;
      });
      grilleControls.appendChild(b);
    });
    panel.appendChild(grilleControls);

    // append to body
    document.body.appendChild(panel);

    // apply initial states to page
    applyAllToDOM();

    // outside click closes panel
    setTimeout(() => document.addEventListener('click', outsideClose));
  }

  function outsideClose(e) {
    if (!panel) return;
    if (panel.contains(e.target)) return;
    // do not close when clicking the FAB (fab-root exists)
    const fabRoot = document.querySelector('.fab-root');
    if (fabRoot && fabRoot.contains(e.target)) return;
    destroy();
  }

  function destroy() {
    if (!panel) return;
    document.removeEventListener('click', outsideClose);
    panel.remove();
    panel = null;
  }

  function togglePanel() {
    if (panel) destroy(); else buildPanel();
  }

  function persistState() {
    try {
      localStorage.setItem('displayPanelState', JSON.stringify(state));
    } catch (e) { /* ignore */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem('displayPanelState');
      if (raw) {
        const parsed = JSON.parse(raw);
        return Object.assign({}, DEFAULTS, parsed);
      }
    } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULTS);
  }

  // --- Apply toggles to DOM (best-effort) ---
  function applyToggle(key, enabled) {
    try {
      if (key === 'video1') {
        toggleElemById('videoCardPlayer1', enabled);
      } else if (key === 'video2') {
        toggleElemById('videoCardPlayer2', enabled);
      } else if (key === 'video3') {
        // your markup uses videoCardMod for moderator
        toggleElemById('videoCardMod', enabled);
      } else if (key === 'mini_map') {
        toggleElemById('minimap', enabled);
      } else if (key === 'commentaires') {
        toggleMiniComments(enabled);
      }
    } catch (e) {
      console.warn('applyToggle error', key, e);
    }
  }

  function applyAllToDOM() {
    // videos & minimap & commentaires
    ['video1','video2','video3','mini_map','commentaires'].forEach(k => {
      applyToggle(k, state[k]);
      emit(k, { enabled: state[k] });
    });

    // grid
    applyGridSize(state.grilleSize);
    emit('grille', { size: state.grilleSize });
  }

  function toggleElemById(id, enabled) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = enabled ? '' : 'none';
  }

  // mini-comments DOM
  let miniCommentsEl = null;
  function toggleMiniComments(enabled) {
    // if enabling and not present, create it
    if (enabled) {
      if (!miniCommentsEl) {
        miniCommentsEl = document.createElement('div');
        miniCommentsEl.id = 'miniComments';
        miniCommentsEl.className = 'mini-comments';
        miniCommentsEl.innerHTML = `
          <div class="title">Commentaires</div>
          <div class="comments-body">
            <div style="opacity:.6;font-size:13px">Aucun commentaire pour l'instant — branche ton flux de chat pour remplir ici.</div>
          </div>
        `;
        document.body.appendChild(miniCommentsEl);
      }
      miniCommentsEl.style.display = '';
    } else {
      if (miniCommentsEl) miniCommentsEl.style.display = 'none';
      else {
        const found = document.getElementById('miniComments');
        if (found) found.style.display = 'none';
      }
    }
  }

  // grid size
  function selectGridSize(sz) {
    state.grilleSize = sz;
    // update buttons UI if panel present
    if (panel) {
      Array.from(panel.querySelectorAll('.grille-btn')).forEach(b => {
        b.classList.toggle('active', Number(b.dataset.size) === sz);
      });
    }
    applyGridSize(sz);
    persistState();
    emit('grille', { size: sz });
  }

  function applyGridSize(size) {
    // best-effort: adjust boardGrid's CSS grid-template-columns
    const boardGrid = document.getElementById('boardGrid');
    if (boardGrid) {
      boardGrid.style.gridTemplateColumns = `repeat(${size}, var(--cell-size))`;
      boardGrid.dataset.gridSize = String(size);
      // remove existing cells if game code expects to rebuild
      // we won't forcibly rebuild here (game.js should listen to display:grille)
    }
    // also set a CSS var for possible cell-size adjustments if desired
    document.documentElement.style.setProperty('--taktik-grid-size', String(size));
  }

  // emit CustomEvent helper
  function emit(key, detail) {
    try {
      const ev = new CustomEvent(`display:${key}`, { detail });
      document.dispatchEvent(ev);
    } catch (e) {
      // ignore
    }
  }

  // small helper to apply a toggle and emit
  function setAndApply(key, enabled) {
    state[key] = !!enabled;
    applyToggle(key, state[key]);
    persistState();
    emit(key, { enabled: state[key] });
  }

  // wait for fab and register handler
  function waitForFab() {
    if (!window.fab) {
      setTimeout(waitForFab, 120);
      return;
    }
    // register handler once (toggle panel on fab click)
    try {
      window.fab.registerHandler('affichage', (detail) => {
        togglePanel();
      });
    } catch (e) {
      // ignore
    }
    // apply initial state immediately
    applyAllToDOM();
  }

  waitForFab();

  // public API
  window.displayPanel = {
    open: buildPanel,
    close: destroy,
    toggle: togglePanel,
    state,
    set: setAndApply // usage: window.displayPanel.set('video1', false)
  };

})();

