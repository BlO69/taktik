// fab.js
// Floating Action Button autonome.
// Usage: <script src="./fab.js" defer></script>
(function () {
  if (window.fab) return; // éviter doublons

  const ACTIONS = [
    { key: 'affichage', label: 'Affichage' },
    { key: 'emoji_gifts', label: 'Emoji / Gifts' },
    { key: 'partager', label: 'Partager' },
    { key: 'commentaires', label: 'Commentaires' },
    { key: 'animateur', label: 'Animateur' },
    { key: 'camera_micro', label: 'Caméra / Micro' },
    { key: 'sortir', label: 'Sortir' },
  ];

  // Handlers enregistrés par l'app (chaque option "attend son propre script")
  const handlers = Object.create(null);

  // Etat
  let isOpen = false;
  let container, fabButton, menuEl;

  // Styles injectés (scope local)
  const style = `
  .fab-root { position: fixed; right: 20px; bottom: 20px; z-index: 9999; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; }
  .fab-btn {
    width: 56px; height: 56px; border-radius: 999px; display:flex; align-items:center; justify-content:center;
    background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); color: white; border: none; box-shadow: 0 6px 18px rgba(15,23,42,0.18);
    cursor: pointer; transition: transform .18s ease, box-shadow .12s ease;
  }
  .fab-btn:active { transform: scale(.98); }
  .fab-icon { font-size: 22px; line-height: 1; transform: rotate(0deg); transition: transform .18s ease; }
  .fab-open .fab-icon { transform: rotate(45deg); } /* plus -> x */

  .fab-menu {
    position: absolute; right: 0; bottom: 72px; min-width: 220px; background: white; border-radius: 12px; box-shadow: 0 10px 30px rgba(2,6,23,0.12);
    padding: 8px; display: grid; gap: 6px; transform-origin: bottom right; opacity: 0; pointer-events: none; transform: translateY(6px) scale(.98);
    transition: opacity .18s ease, transform .18s ease;
  }
  .fab-open .fab-menu { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }

  .fab-item {
    display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; cursor:pointer; text-align:left;
    font-size:13px; color: #0f172a; background: transparent; border: none;
  }
  .fab-item:focus, .fab-item:hover { background: rgba(2,6,23,0.04); outline: none; }
  .fab-item .dot { width:36px; height:36px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; background: rgba(15,23,42,0.04); font-weight:600; }
  .fab-caption { font-weight:600; }
  .fab-sub { font-size:12px; color: #64748b; margin-left:auto; }
  `;

  function injectStyles() {
    if (document.getElementById('fab-styles')) return;
    const s = document.createElement('style');
    s.id = 'fab-styles';
    s.textContent = style;
    document.head.appendChild(s);
  }

  function build() {
    injectStyles();

    container = document.createElement('div');
    container.className = 'fab-root';
    container.setAttribute('aria-hidden', 'false');

    // role wrapper so toggling "fab-open" controls animation
    const wrapper = document.createElement('div');
    wrapper.className = 'fab-wrapper';

    // FAB button
    fabButton = document.createElement('button');
    fabButton.className = 'fab-btn';
    fabButton.setAttribute('aria-expanded', 'false');
    fabButton.setAttribute('aria-haspopup', 'menu');
    fabButton.setAttribute('aria-label', 'Ouvrir menu');
    fabButton.title = 'Menu';

    const icon = document.createElement('span');
    icon.className = 'fab-icon';
    icon.innerText = '+';
    fabButton.appendChild(icon);

    // Menu
    menuEl = document.createElement('div');
    menuEl.className = 'fab-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('aria-hidden', 'true');

    // build items
    ACTIONS.forEach((act, idx) => {
      const btn = document.createElement('button');
      btn.className = 'fab-item';
      btn.setAttribute('role', 'menuitem');
      btn.type = 'button';
      btn.dataset.action = act.key;
      btn.tabIndex = -1;

      const dot = document.createElement('div');
      dot.className = 'dot';
      dot.innerText = act.label[0] || act.key[0];

      const caption = document.createElement('div');
      caption.className = 'fab-caption';
      caption.innerText = act.label;

      const sub = document.createElement('div');
      sub.className = 'fab-sub';
      sub.innerText = ''; // optionnel, laissé vide pour que le handler décide

      btn.appendChild(dot);
      btn.appendChild(caption);
      btn.appendChild(sub);

      btn.addEventListener('click', onMenuItemClick);
      btn.addEventListener('keydown', onMenuItemKeyDown);

      menuEl.appendChild(btn);
    });

    wrapper.appendChild(menuEl);
    wrapper.appendChild(fabButton);
    container.appendChild(wrapper);
    document.body.appendChild(container);

    // wrapper class toggling for animations
    requestAnimationFrame(() => {
      // add a class to container to control open state
      container.classList.toggle('fab-open', isOpen);
    });

    // events
    fabButton.addEventListener('click', toggle);
    fabButton.addEventListener('keydown', onFabKeyDown);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeyDown);
    window.addEventListener('resize', close);
  }

  function onFabKeyDown(e) {
    const key = e.key;
    if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      toggle();
      focusFirstItem();
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) open();
      focusFirstItem();
    }
  }

  function onMenuItemKeyDown(e) {
    const key = e.key;
    const items = Array.from(menuEl.querySelectorAll('.fab-item'));
    const idx = items.indexOf(e.currentTarget);
    if (key === 'ArrowDown') {
      e.preventDefault();
      const next = items[(idx + 1) % items.length];
      next.focus();
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[(idx - 1 + items.length) % items.length];
      prev.focus();
    } else if (key === 'Escape') {
      e.preventDefault();
      close();
      fabButton.focus();
    } else if (key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  }

  function onMenuItemClick(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    triggerAction(action, { sourceElement: btn });
  }

  function onDocumentClick(e) {
    if (!container) return;
    if (!isOpen) return;
    if (container.contains(e.target)) return;
    close();
  }

  function onDocumentKeyDown(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      close();
      fabButton.focus();
    }
  }

  function triggerAction(action, meta = {}) {
    // appel du handler enregistré si présent
    const h = handlers[action];
    const detail = { action, time: Date.now(), meta };

    // premièrement: dispatch d'un CustomEvent sur document
    try {
      const ev = new CustomEvent(`fab:${action}`, { detail });
      document.dispatchEvent(ev);
    } catch (err) {
      // CustomEvent peut échouer dans des environnements très anciens — on ignore
      console.warn('fab: dispatch error', err);
    }

    // secondement: appeler le handler enregistré
    try {
      if (typeof h === 'function') {
        // handler async possible
        Promise.resolve().then(() => h(detail));
      }
    } catch (err) {
      console.error('fab handler error for', action, err);
    }

    // fermer le menu après sélection sauf si handler demande explicitement de garder ouvert
    close();
  }

  // API publique
  const api = {
    open() {
      open();
    },
    close() {
      close();
    },
    toggle() {
      toggle();
    },
    isOpen() {
      return isOpen;
    },
    registerHandler(actionKey, fn) {
      if (!actionKey || typeof fn !== 'function') {
        throw new TypeError('registerHandler(actionKey, fn) — actionKey string et fn function requis');
      }
      handlers[actionKey] = fn;
    },
    unregisterHandler(actionKey) {
      delete handlers[actionKey];
    },
    destroy() {
      teardown();
      delete window.fab;
    }
  };

  function focusFirstItem() {
    const first = menuEl.querySelector('.fab-item');
    if (first) first.focus();
  }

  function open() {
    if (!container) return;
    isOpen = true;
    container.classList.add('fab-open');
    fabButton.setAttribute('aria-expanded', 'true');
    menuEl.setAttribute('aria-hidden', 'false');
    // set tabindex to allow keyboard focus
    Array.from(menuEl.querySelectorAll('.fab-item')).forEach(btn => btn.tabIndex = 0);
    // small delay to focus
    setTimeout(() => focusFirstItem(), 60);
  }

  function close() {
    if (!container) return;
    isOpen = false;
    container.classList.remove('fab-open');
    fabButton.setAttribute('aria-expanded', 'false');
    menuEl.setAttribute('aria-hidden', 'true');
    Array.from(menuEl.querySelectorAll('.fab-item')).forEach(btn => btn.tabIndex = -1);
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  function teardown() {
    if (!container) return;
    fabButton.removeEventListener('click', toggle);
    fabButton.removeEventListener('keydown', onFabKeyDown);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onDocumentKeyDown);
    window.removeEventListener('resize', close);
    container.remove();
    container = null;
    fabButton = null;
    menuEl = null;
  }

  // initialisation
  try {
    build();
    // expose l'API publique
    window.fab = api;
  } catch (err) {
    console.error('fab init failed', err);
  }

  // --- Exemple d'utilisation (commenté) ---
  // Tu peux enregistrer des handlers dans des scripts séparés comme ceci:
  //
  // window.fab.registerHandler('affichage', (detail) => {
  //   console.log('affichage clicked', detail);
  //   // lancer ton script d'affichage (ex: afficher panneaux, toggler overlay, etc.)
  // });
  //
  // Le script possède aussi un événement CustomEvent que tu peux écouter:
  // document.addEventListener('fab:partager', (ev) => {
  //   // ev.detail contient { action, time, meta }
  //   console.log('partager event', ev.detail);
  // });
  //
  // Handlers disponibles (keys): affichage, emoji_gifts, partager, commentaires, animateur, camera_micro, sortir
})();
