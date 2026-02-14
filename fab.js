// fab.js
// Floating Action Button autonome + bouton "Diffuser" conditionnel.
// Usage: <script src="./fab.js" defer></script>
(function () {
  if (window.fab) return; // éviter doublons

  // Actions du menu (ajoute 'diffuser' aussi pour pouvoir déclencher depuis le menu)
  const ACTIONS = [
    { key: 'affichage', label: 'Affichage' },
    { key: 'emoji_gifts', label: 'Emoji / Gifts' },
    { key: 'partager', label: 'Partager' },
    { key: 'commentaires', label: 'Commentaires' },
    { key: 'animateur', label: 'Animateur' },
    { key: 'camera_micro', label: 'Caméra / Micro' },
    { key: 'diffuser', label: 'Diffuser' }, // intégré au menu également
    { key: 'sortir', label: 'Sortir' },
  ];

  // Handlers enregistrés par l'app (chaque option "attend son propre script")
  const handlers = Object.create(null);

  // Etat
  let isOpen = false;
  let container = null;
  let fabButton = null;
  let menuEl = null;

  // Diffuseur flottant
  let diffuseBtn = null;
  let diffuseVisible = false;

  // Styles injectés (scope local)
  const style = `
  /* Fab principal (menu) */
  .fab-root { position: fixed; right: 20px; bottom: 20px; z-index: 9999; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; }
  .fab-wrapper { position: relative; }
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

  /* Bouton "Diffuser" séparé (visible seulement si autorisé) */
  .fab-diffuse {
    position: fixed; right: 20px; bottom: 92px; width: 64px; height: 64px; border-radius: 999px;
    display:inline-flex; align-items:center; justify-content:center; font-weight:700; box-shadow: 0 6px 18px rgba(2,6,23,0.12);
    cursor: pointer; z-index: 9998; border: none;
    transition: transform .12s ease;
    background: linear-gradient(135deg,#06b6d4,#3b82f6); color: white;
  }
  .fab-diffuse:active { transform: scale(.98); }
  .fab-diffuse.hidden { display: none !important; }
  .fab-diffuse .label { font-size:11px; pointer-events:none; display:block; text-align:center; margin-top:2px; }
  .fab-diffuse .icon { font-size:18px; line-height:1; }
  `;

  function injectStyles() {
    if (document.getElementById('fab-styles')) return;
    const s = document.createElement('style');
    s.id = 'fab-styles';
    s.textContent = style;
    document.head.appendChild(s);
  }

  // Récupération souple de l'état "series" (plusieurs chemins possibles)
  function getSeriesState() {
    try {
      // 1) window.taktikGame.getState()?.series
      if (window.taktikGame && typeof window.taktikGame.getState === 'function') {
        const gs = window.taktikGame.getState();
        if (!gs) {} else {
          if (gs.series && typeof gs.series === 'object') return gs.series;
          if (gs.series_id || gs.seriesStatus || gs.series_status) {
            return {
              id: gs.series_id || gs.seriesId || gs.series?.id || null,
              status: gs.series_status || gs.seriesStatus || (gs.series && gs.series.status) || null
            };
          }
        }
      }

      // 2) window.seriesState or window.series
      if (window.seriesState && typeof window.seriesState === 'object') return window.seriesState;
      if (window.series && typeof window.series === 'object') return window.series;

      // 3) data attributes on body (data-series-id / data-series-status)
      const body = document.body;
      if (body) {
        const sid = body.getAttribute('data-series-id');
        const sst = body.getAttribute('data-series-status');
        if (sid || sst) return { id: sid || null, status: sst || null };
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  // Récupération souple de l'user id via supabase si présent
  async function getCurrentUserId() {
    try {
      if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
        // NOTE: supabase API peut varier, on gère plusieurs formes
        const sessRes = await window.supabase.auth.getSession();
        // sessRes may be { data: { session } } or { data: session } - tenter plusieurs chemins
        const sessionData = sessRes?.data?.session ?? sessRes?.data ?? sessRes?.session ?? null;
        const user = sessionData?.user ?? sessionData?.user ?? null;
        if (user && user.id) return user.id.toString();
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  // --- NEW: helper to ensure live.js module is loaded if not present ---  /* PATCH */
  function loadLiveScriptIfNeeded() {
    return new Promise((resolve) => {
      if (window.livekit) return resolve(true);
      // try to find existing script tag (module)
      const existing = Array.from(document.querySelectorAll('script[type="module"]')).find(s => s.src && s.src.includes('live.js'));
      if (existing) {
        // wait for it to load
        if (existing.hasAttribute('data-loaded')) return resolve(true);
        existing.addEventListener('load', () => resolve(true));
        existing.addEventListener('error', () => resolve(false));
        return;
      }
      // otherwise inject a script tag pointing to default path (assume same dir)
      const src = window.LIVEJS_PATH || './live.js';
      const s = document.createElement('script');
      s.type = 'module';
      s.src = src;
      s.async = true;
      s.addEventListener('load', () => { s.setAttribute('data-loaded', '1'); resolve(true); });
      s.addEventListener('error', (err) => { console.error('fab: failed to load live.js', err); resolve(false); });
      document.head.appendChild(s);
    });
  }

  function build() {
    injectStyles();

    // Container principal
    container = document.createElement('div');
    container.className = 'fab-root';
    container.setAttribute('aria-hidden', 'false');

    // wrapper pour controle de l'etat open
    const wrapper = document.createElement('div');
    wrapper.className = 'fab-wrapper';

    // FAB button (menu)
    fabButton = document.createElement('button');
    fabButton.className = 'fab-btn';
    fabButton.setAttribute('aria-expanded', 'false');
    fabButton.setAttribute('aria-haspopup', 'menu');
    fabButton.setAttribute('aria-label', 'Ouvrir menu');
    fabButton.title = 'Menu';
    fabButton.type = 'button';

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
    ACTIONS.forEach((act) => {
      const btn = document.createElement('button');
      btn.className = 'fab-item';
      btn.setAttribute('role', 'menuitem');
      btn.type = 'button';
      btn.dataset.action = act.key;
      btn.tabIndex = -1;

      const dot = document.createElement('div');
      dot.className = 'dot';
      dot.innerText = (act.label && act.label[0]) ? act.label[0] : (act.key[0] || '?');

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

    // bouton "Diffuser" (séparé)
    diffuseBtn = document.createElement('button');
    diffuseBtn.className = 'fab-diffuse hidden';
    diffuseBtn.type = 'button';
    diffuseBtn.title = 'Diffuser / Stop';
    diffuseBtn.setAttribute('aria-pressed', 'false');
    diffuseBtn.innerHTML = `<div style="text-align:center">
                              <div class="icon">▶</div>
                              <div class="label">Diffuser</div>
                            </div>`;
    document.body.appendChild(diffuseBtn);

    // wrapper class toggling pour animations (reflect isOpen)
    requestAnimationFrame(() => {
      container.classList.toggle('fab-open', isOpen);
    });

    // events
    fabButton.addEventListener('click', toggle);
    fabButton.addEventListener('keydown', onFabKeyDown);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeyDown);
    window.addEventListener('resize', close);

    // diffuse events
    diffuseBtn.addEventListener('click', onDiffuseClick);

    // visibility checks
    document.addEventListener('taktik:joined', updateDiffuseVisibility);
    document.addEventListener('series:updated', updateDiffuseVisibility);
    // périodique de secours au cas où l'état change sans émettre d'event
    const iv = setInterval(updateDiffuseVisibility, 3000);
    // stocker pour teardown
    diffuseBtn._fabInterval = iv;

    // initial try
    updateDiffuseVisibility();
  }

  // Gestion clavier / navigation
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
    } else if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      e.currentTarget.click();
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
      if (fabButton) fabButton.focus();
    }
  }

  function triggerAction(action, meta = {}) {
    // appel du handler enregistré si présent
    const h = handlers[action];
    const detail = { action, time: Date.now(), meta };

    // dispatch d'un CustomEvent sur document (utile pour code externe)
    try {
      const ev = new CustomEvent(`fab:${action}`, { detail });
      document.dispatchEvent(ev);
    } catch (err) {
      // CustomEvent peut échouer dans des environnements très anciens — on ignore
      console.warn('fab: dispatch error', err);
    }

    // appeler le handler enregistré (si présent)
    try {
      if (typeof h === 'function') {
        // handler async possible, ne pas attendre
        Promise.resolve().then(() => h(detail));
      }
    } catch (err) {
      console.error('fab handler error for', action, err);
    }

    // fermer le menu après sélection sauf si handler retourne explicitement { keepOpen: true }
    // (support basique : handler peut set detail.meta.keepOpen = true synchronously)
    if (!meta.keepOpen) {
      close();
    }
  }

  // API publique
  const api = {
    open() { open(); },
    close() { close(); },
    toggle() { toggle(); },
    isOpen() { return isOpen; },
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
    const first = menuEl && menuEl.querySelector('.fab-item');
    if (first) first.focus();
  }

  function open() {
    if (!container) return;
    isOpen = true;
    container.classList.add('fab-open');
    if (fabButton) fabButton.setAttribute('aria-expanded', 'true');
    if (menuEl) menuEl.setAttribute('aria-hidden', 'false');
    Array.from(menuEl.querySelectorAll('.fab-item')).forEach(btn => btn.tabIndex = 0);
    setTimeout(() => focusFirstItem(), 60);
  }

  function close() {
    if (!container) return;
    isOpen = false;
    container.classList.remove('fab-open');
    if (fabButton) fabButton.setAttribute('aria-expanded', 'false');
    if (menuEl) menuEl.setAttribute('aria-hidden', 'true');
    Array.from(menuEl.querySelectorAll('.fab-item')).forEach(btn => btn.tabIndex = -1);
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  function teardown() {
    if (!container) return;
    try {
      fabButton && fabButton.removeEventListener('click', toggle);
      fabButton && fabButton.removeEventListener('keydown', onFabKeyDown);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onDocumentKeyDown);
      window.removeEventListener('resize', close);

      // menu items
      if (menuEl) {
        Array.from(menuEl.querySelectorAll('.fab-item')).forEach(btn => {
          btn.removeEventListener('click', onMenuItemClick);
          btn.removeEventListener('keydown', onMenuItemKeyDown);
        });
      }

      // diffuse
      if (diffuseBtn) {
        diffuseBtn.removeEventListener('click', onDiffuseClick);
        if (diffuseBtn._fabInterval) clearInterval(diffuseBtn._fabInterval);
      }

      container.remove();
      diffuseBtn && diffuseBtn.remove();
    } catch (e) {
      // ignore removal errors
    } finally {
      container = null;
      fabButton = null;
      menuEl = null;
      diffuseBtn = null;
    }
  }

  // ---------- Diffuser : visibilité & comportement ----------
  // Critère de visibilité:
  // - utilisateur connecté via window.supabase.auth.getSession()
  // - user.id === owner_id || user.id === opponent_id
  // - la série correspondante (recherche flexible via getSeriesState) a status === 'ongoing' (insensible à la casse)
  async function updateDiffuseVisibility() {
    try {
      if (!diffuseBtn) return;
      const userId = await getCurrentUserId();
      if (!userId) {
        setDiffuseHidden(true);
        return;
      }

      // récupérer series
      const series = getSeriesState();
      if (!series || (!series.id && !series.status)) {
        // si aucune info série, on cache par défaut (sécurité)
        setDiffuseHidden(true);
        return;
      }

      // récupérer owner/opponent à partir du state global (si possible)
      let owner = null, opponent = null;
      try {
        if (window.taktikGame && typeof window.taktikGame.getState === 'function') {
          const gs = window.taktikGame.getState() || {};
          owner = gs.owner_id || gs.ownerId || gs.owner || null;
          opponent = gs.opponent_id || gs.opponentId || gs.opponent || null;
        }
      } catch (e) { /* ignore */ }

      // si owner/opponent manquant, tenter de lire depuis series (parfois la série inclut players)
      if (!owner && series.owner_id) owner = series.owner_id;
      if (!opponent && series.opponent_id) opponent = series.opponent_id;

      // Normaliser en chaîne pour éviter mismatch uuid/object
      const userIdStr = userId?.toString();
      const ownerStr = owner != null ? owner.toString() : null;
      const opponentStr = opponent != null ? opponent.toString() : null;

      const status = (series.status || '').toString().toLowerCase();
      const allowed = !!(userIdStr && (userIdStr === ownerStr || userIdStr === opponentStr) && status === 'ongoing');

      setDiffuseHidden(!allowed);
    } catch (e) {
      console.warn('fab: updateDiffuseVisibility error', e);
      setDiffuseHidden(true);
    }
  }

  function setDiffuseHidden(hide) {
    if (!diffuseBtn) return;
    diffuseVisible = !hide;
    if (hide) {
      diffuseBtn.classList.add('hidden');
      diffuseBtn.setAttribute('aria-hidden', 'true');
    } else {
      diffuseBtn.classList.remove('hidden');
      diffuseBtn.setAttribute('aria-hidden', 'false');
    }
  }

  // comportement par défaut du bouton diffuser :
  // - si un handler 'diffuser' est enregistré, l'app l'utilisera (registerHandler)
  // - sinon, on tente d'utiliser window.livekit.startPublish / stopPublish si présent
  async function onDiffuseClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const action = 'diffuser';
    const h = handlers[action];

    // dispatch event pour que l'app ait toujours la notification
    try {
      const ev = new CustomEvent(`fab:${action}`, { detail: { action, time: Date.now(), meta: { source: 'fab-diffuse' } } });
      document.dispatchEvent(ev);
    } catch (err) { /* ignore */ }

    if (typeof h === 'function') {
      try {
        // handler can be async
        await Promise.resolve().then(() => h({ action, time: Date.now(), meta: { source: 'fab-diffuse' } }));
      } catch (err) {
        console.error('fab diffuser handler error', err);
      }
      return;
    }

    // fallback: default livekit integration if available
    try {
      // ensure live.js loaded (if not present attempt to load it)
      const loaded = await loadLiveScriptIfNeeded(); /* PATCH */
      if (!loaded) {
        console.warn('fab: impossible de charger live.js — vérifie le chemin (LIVEJS_PATH) ou la disponibilité du fichier.');
      }

      if (window.livekit && typeof window.livekit.isPublishing === 'function') {
        const publishing = window.livekit.isPublishing();
        if (publishing) {
          if (typeof window.livekit.stopPublish === 'function') {
            try {
              await window.livekit.stopPublish();
              setDiffuseButtonState(false);
            } catch (err) {
              console.error('fab: stopPublish failed', err);
              // montrer retour utilisateur léger
              try { alert('Erreur en stoppant la diffusion : ' + (err.message || err)); } catch (_) {}
            }
          }
        } else {
          if (typeof window.livekit.startPublish === 'function') {
            try {
              await window.livekit.startPublish();
              setDiffuseButtonState(true);
            } catch (err) {
              // startPublish a échoué — afficher l'erreur clairement pour debug (ex : non connecté, gameId manquant, permission refusée...)
              console.error('fab: startPublish failed', err);
              // le message d'erreur peut être long — afficher alert pour debug, tu pourras remplacer par un toast dans ta UI
              try { alert('Impossible de démarrer la diffusion : ' + (err.message || err)); } catch (_) {}
              setDiffuseButtonState(false);
            }
          } else {
            console.info('fab: window.livekit.startPublish non disponible.');
          }
        }
        return;
      }
    } catch (e) {
      console.warn('fab default diffuser action failed', e);
    }

    // si on arrive ici, aucune action disponible => afficher un petit warning via console
    console.info('fab: aucun handler "diffuser" enregistré et window.livekit non disponible.');
    try { alert('La fonctionnalité diffusion n’est pas disponible (livekit non chargé).'); } catch (_) {}
  }

  function setDiffuseButtonState(publishing) {
    if (!diffuseBtn) return;
    if (publishing) {
      diffuseBtn.innerHTML = `<div style="text-align:center"><div class="icon">⏸</div><div class="label">Stop</div></div>`;
      diffuseBtn.setAttribute('aria-pressed', 'true');
    } else {
      diffuseBtn.innerHTML = `<div style="text-align:center"><div class="icon">▶</div><div class="label">Diffuser</div></div>`;
      diffuseBtn.setAttribute('aria-pressed', 'false');
    }
  }

  // Initialisation
  try {
    build();
    // expose l'API publique
    window.fab = api;

    // mettre à jour l'état visuel du bouton diffuser si la publication change depuis l'extérieur
    // (par ex. window.livekit peut contrôler l'état). On fait un poll léger pour rester synchrones.
    const syncIv = setInterval(() => {
      try {
        if (!diffuseBtn) { clearInterval(syncIv); return; }
        if (window.livekit && typeof window.livekit.isPublishing === 'function') {
          const p = !!window.livekit.isPublishing();
          setDiffuseButtonState(p);
        }
      } catch (e) {}
    }, 1000);
  } catch (err) {
    console.error('fab init failed', err);
  }

  // --- Exemple d'utilisation (commenté) ---
  // window.fab.registerHandler('diffuser', async (detail) => {
  //   // Exemple: appeler votre logique de permission/serveur puis window.livekit.startPublish()
  //   console.log('diffuser clicked', detail);
  // });
  //
  // document.addEventListener('fab:partager', (ev) => console.log('partager event', ev.detail));
})();
