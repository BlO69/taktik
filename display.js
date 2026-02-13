// display.js
// Gère le panneau "Affichage" appelé depuis fab.js (via fab:affichage ou registerHandler)
// Persiste sous localStorage.displayPanelState et dispatche les CustomEvent attendus par maingame.js

(function () {
  if (window.__displayPanelLoaded) return;
  window.__displayPanelLoaded = true;

  const STORAGE_KEY = 'displayPanelState';
  const DEFAULT = {
    video1: true,
    video2: true,
    video3: false,
    mini_map: true,
    commentaires: false,
    grilleSize: 20
  };

  // --- utilitaires DOM ---
  function qs(sel, ctx = document) { return ctx.querySelector(sel); }
  function ce(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    Object.assign(el, props);
    kids.forEach(k => { if (k == null) return; if (typeof k === 'string') el.appendChild(document.createTextNode(k)); else el.appendChild(k); });
    return el;
  }

  // --- stockage ---
  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT };
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT, parsed || {});
    } catch (e) {
      console.warn('display: readState parse error', e);
      return { ...DEFAULT };
    }
  }
  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('display: saveState error', e);
    }
  }

  // --- dispatch vers maingame (noms attendus) ---
  function dispatchVideo(name, enabled) {
    try { document.dispatchEvent(new CustomEvent(`display:${name}`, { detail: { enabled: !!enabled } })); } catch(e){}
  }
  function dispatchMiniMap(enabled) {
    try { document.dispatchEvent(new CustomEvent('display:mini_map', { detail: { enabled: !!enabled } })); } catch(e){}
  }
  function dispatchComments(enabled) {
    try { document.dispatchEvent(new CustomEvent('display:commentaires', { detail: { enabled: !!enabled } })); } catch(e){}
  }
  function dispatchGrid(size) {
    try { document.dispatchEvent(new CustomEvent('display:grille', { detail: { size: Number(size) } })); } catch(e){}
  }

  function applyStateToUI(state, root) {
    if (!root) return;
    root.querySelectorAll('[data-bind]').forEach(el => {
      const key = el.dataset.bind;
      if (el.type === 'checkbox') el.checked = !!state[key];
      else if (el.tagName === 'SELECT') el.value = String(state[key]);
    });
  }

  function applyState(state) {
    // envoie les events
    dispatchVideo('video1', state.video1);
    dispatchVideo('video2', state.video2);
    dispatchVideo('video3', state.video3);
    dispatchMiniMap(state.mini_map);
    dispatchComments(state.commentaires);
    dispatchGrid(state.grilleSize);
  }

  // --- UI construction ---
  const css = `
  /* display.js panel styles */
  .display-panel-backdrop {
    position: fixed; inset: 0; background: rgba(2,6,23,0.35); z-index: 10010; display:flex; align-items:flex-end; justify-content:center;
  }
  .display-panel {
    width: 100%; max-width: 680px; border-top-left-radius:12px; border-top-right-radius:12px;
    background: white; box-shadow: 0 -10px 30px rgba(2,6,23,0.12); padding: 14px; transform-origin: bottom center;
  }
  @media(min-width:800px) {
    .display-panel-backdrop { align-items:center; }
    .display-panel { border-radius:12px; width: 92%; max-width:640px; }
  }
  .display-panel h3 { font-size:16px; margin:0 0 8px; }
  .display-row { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:10px 6px; border-radius:8px; }
  .display-row + .display-row { margin-top:6px; }
  .display-row .left { display:flex; gap:10px; align-items:center; }
  .display-row .left .label { font-weight:600; font-size:14px; }
  .display-controls { display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
  .display-btn { padding:8px 10px; border-radius:8px; border:1px solid rgba(2,6,23,0.06); background:white; cursor:pointer; }
  .display-btn.primary { background: linear-gradient(135deg,#06b6d4,#3b82f6); color:white; border:none; box-shadow:0 6px 18px rgba(15,23,42,0.12); }
  .display-small { font-size:12px; color:#64748b; }
  .display-select { padding:6px 8px; border-radius:8px; border:1px solid rgba(2,6,23,0.06); }
  `;

  function injectCss() {
    if (document.getElementById('display-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'display-panel-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  let backdrop, panelRoot;

  function buildPanel() {
    injectCss();

    backdrop = ce('div');
    backdrop.className = 'display-panel-backdrop';
    backdrop.tabIndex = -1;
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.style.display = 'none'; // initial

    panelRoot = ce('div');
    panelRoot.className = 'display-panel';
    panelRoot.innerHTML = `
      <h3>Options d'affichage</h3>
    `;

    // rows
    const rowVideo1 = ce('div', { className: 'display-row' },
      ce('div', { className: 'left' },
         ce('label', { className: 'label' }, 'Vidéo — Joueur 1')
      ),
      ce('div', {},
         ce('input', { type: 'checkbox', dataset: { bind: 'video1' } })
      )
    );

    const rowVideo2 = ce('div', { className: 'display-row' },
      ce('div', { className: 'left' }, ce('label', { className: 'label' }, 'Vidéo — Joueur 2')),
      ce('div', {}, ce('input', { type: 'checkbox', dataset: { bind: 'video2' } }))
    );

    const rowVideo3 = ce('div', { className: 'display-row' },
      ce('div', { className: 'left' }, ce('label', { className: 'label' }, 'Vidéo — Animateur')),
      ce('div', {}, ce('input', { type: 'checkbox', dataset: { bind: 'video3' } }))
    );

    const rowGrid = ce('div', { className: 'display-row' },
      ce('div', { className: 'left' }, ce('div', { className: 'label' }, 'Grille')),
      ce('div', {},
         ce('select', { className: 'display-select', dataset: { bind: 'grilleSize' } },
            ce('option', { value: '9' }, '9 × 9'),
            ce('option', { value: '12' }, '12 × 12'),
            ce('option', { value: '15' }, '15 × 15'),
            ce('option', { value: '20' }, '20 × 20')
         )
      )
    );

    const rowMiniMap = ce('div', { className: 'display-row' },
      ce('div', { className: 'left' }, ce('div', { className: 'label' }, 'Mini-map')),
      ce('div', {}, ce('input', { type: 'checkbox', dataset: { bind: 'mini_map' } }))
    );

    const rowComments = ce('div', { className: 'display-row' },
      ce('div', { className: 'left' }, ce('div', { className: 'label' }, 'Mini-card commentaires')),
      ce('div', {}, ce('input', { type: 'checkbox', dataset: { bind: 'commentaires' } }))
    );

    // controls
    const controls = ce('div', { className: 'display-controls' },
      ce('button', { className: 'display-btn', type: 'button' }, 'Réinitialiser'),
      ce('button', { className: 'display-btn', type: 'button' }, 'Annuler'),
      ce('button', { className: 'display-btn primary', type: 'button' }, 'Appliquer')
    );

    // append rows + controls
    [rowVideo1, rowVideo2, rowVideo3, rowGrid, rowMiniMap, rowComments].forEach(r => panelRoot.appendChild(r));
    panelRoot.appendChild(controls);
    backdrop.appendChild(panelRoot);
    document.body.appendChild(backdrop);

    // attach references
    const bindEls = {};
    panelRoot.querySelectorAll('[data-bind]').forEach(el => {
      const key = el.dataset.bind;
      bindEls[key] = el;
    });

    // actions
    const btnReset = controls.children[0];
    const btnCancel = controls.children[1];
    const btnApply = controls.children[2];

    function updateStateFromUI() {
      const state = readState(); // start with stored
      Object.keys(bindEls).forEach(k => {
        const el = bindEls[k];
        if (!el) return;
        if (el.type === 'checkbox') state[k] = !!el.checked;
        else if (el.tagName === 'SELECT') state[k] = el.value;
      });
      return state;
    }

    // on change immediate apply (optimistic)
    Object.values(bindEls).forEach(el => {
      el.addEventListener('change', () => {
        const newState = updateStateFromUI();
        saveState(newState);
        // apply immediate so user sees instant effect
        applyState(newState);
      });
    });

    btnReset.addEventListener('click', () => {
      const s = { ...DEFAULT };
      saveState(s);
      applyStateToUI(s, panelRoot);
      applyState(s);
    });

    btnCancel.addEventListener('click', () => {
      // restore UI to persisted state
      const s = readState();
      applyStateToUI(s, panelRoot);
      closePanel();
    });

    btnApply.addEventListener('click', () => {
      const s = updateStateFromUI();
      // ensure numeric grilleSize
      s.grilleSize = Number(s.grilleSize) || DEFAULT.grilleSize;
      saveState(s);
      applyState(s);
      closePanel();
    });

    // close on backdrop click outside panelRoot
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) {
        closePanel();
      }
    });

    // keyboard: Escape closes
    backdrop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closePanel();
    });

    // prepare for reuse
    return { root: panelRoot, bindEls, backdrop };
  }

  const built = buildPanel();

  function openPanel() {
    const state = readState();
    applyStateToUI(state, built.root);
    // place focus on first control
    built.backdrop.style.display = '';
    // small timeout to focus the first interactive element
    setTimeout(() => {
      const first = built.root.querySelector('[data-bind]');
      if (first && typeof first.focus === 'function') first.focus();
    }, 40);
    // trap focus simple: listen for focusout to wrap inside
    built.backdrop.addEventListener('focusout', onFocusOut);
  }

  function onFocusOut(e) {
    // keep focus inside modal — if focus escapes to body, re-focus panel
    setTimeout(() => {
      if (!built.backdrop.contains(document.activeElement)) {
        const first = built.root.querySelector('[data-bind]');
        if (first) first.focus();
      }
    }, 10);
  }

  function closePanel() {
    try {
      built.backdrop.style.display = 'none';
      built.backdrop.removeEventListener('focusout', onFocusOut);
    } catch (e) {}
  }

  // --- Init: apply stored state at startup once (to sync UI quickly) ---
  try {
    const initial = readState();
    // apply to page immediately so maingame picks it up if loaded later
    applyState(initial);
  } catch (e) { console.warn('display init apply error', e); }

  // --- Hook into fab.js ---
  // if fab API exists, register a handler; also listen to the CustomEvent 'fab:affichage'
  if (window.fab && typeof window.fab.registerHandler === 'function') {
    try {
      window.fab.registerHandler('affichage', () => {
        openPanel();
      });
    } catch (e) { console.warn('display: fab.registerHandler failed', e); }
  }
  document.addEventListener('fab:affichage', () => openPanel());

  // also expose a small public API
  window.displayPanel = {
    open: openPanel,
    close: closePanel,
    getState: readState,
    setState(s) { const merged = Object.assign({}, DEFAULT, s); saveState(merged); applyState(merged); }
  };

})();
