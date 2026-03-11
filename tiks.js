/**
 * tiks.js — Affichage de la balance TIKS + équivalent USDT
 *
 * Compatible avec index.html :
 *  - Se greffe sur #menuTiks (remplace le handler placeholder)
 *  - Affiche le panel dans #placeholderPanel / #placeholderText
 *  - Polling toutes les POLL_MS ms (pas de realtime Supabase)
 *  - Lit la table public.tiks_balances (balance, usdt_value, updated_at)
 *
 * Correction : recherche d'abord user_profiles.id (profile id) lié à auth.user.id,
 * puis lecture de tiks_balances.user_id = user_profiles.id.
 */

const POLL_MS       = 8000;   // intervalle de polling en ms
const TIKS_PER_USDT = 200;    // 1 USDT = 200 TIKS (cohérent avec la colonne générée)

(async function initTiks() {
  /* 1. Récupérer le client Supabase (window.supabase, défini par supabaseClient.js) */
  const supabase = (typeof window !== 'undefined' && window.supabase) ? window.supabase : null;
  if (!supabase) {
    console.warn('tiks.js: supabase client introuvable (window.supabase manquant).');
  }

  /* 2. Éléments DOM partagés avec index.html */
  const menuTiks         = document.getElementById('menuTiks');
  const homePanel        = document.getElementById('homePanel');
  const profilePanel     = document.getElementById('profilePanel');
  const placeholderPanel = document.getElementById('placeholderPanel');
  const placeholderTitle = document.getElementById('placeholderTitle');
  const placeholderText  = document.getElementById('placeholderText');
  const mainNav          = document.getElementById('mainNav');

  if (!menuTiks || !placeholderPanel) {
    // page incompatible : rien à faire
    return;
  }

  /* ── État interne ────────────────────────────────────────────────── */
  let _pollTimer   = null;   // référence setInterval
  let _panelActive = false;  // true si le panel Tiks est visible
  let _profileId   = null;   // id (user_profiles.id) du profile courant
  let _authUid     = null;   // supabase auth user id (session.user.id)

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Helpers                                                            */
  /* ─────────────────────────────────────────────────────────────────── */

  /** Formate un nombre avec séparateur de milliers et N décimales */
  function fmt(n, decimals = 2) {
    if (n == null || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  /** Récupère l'UID auth de l'utilisateur connecté (null si déconnecté) */
  async function getAuthUid() {
    if (!supabase?.auth) return null;
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data?.session?.user?.id ?? null;
      return uid;
    } catch (e) {
      console.warn('tiks.js getAuthUid exception', e);
      return null;
    }
  }

  /** Récupère user_profiles.id (profile id) pour un auth UID donné
   *  Retourne null si pas trouvé.
   */
  async function fetchProfileIdForAuthUid(uid) {
    if (!supabase || !uid) return null;
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('user_id', uid)
        .limit(1)
        .maybeSingle();
      if (error) {
        console.warn('tiks.js fetchProfileId error', error);
        return null;
      }
      return data?.id ?? null;
    } catch (e) {
      console.warn('tiks.js fetchProfileId exception', e);
      return null;
    }
  }

  /** Récupère la ligne tiks_balances pour un profileId donné */
  async function fetchBalanceByProfileId(profileId) {
    if (!supabase || !profileId) return null;
    try {
      const { data, error } = await supabase
        .from('tiks_balances')
        .select('balance, usdt_value, updated_at, currency')
        .eq('user_id', profileId)
        .limit(1)
        .maybeSingle();
      if (error) {
        console.warn('tiks.js fetchBalance error', error);
        return null;
      }
      return data || null;
    } catch (e) {
      console.warn('tiks.js fetchBalance exception', e);
      return null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Rendu du panel                                                     */
  /* ─────────────────────────────────────────────────────────────────── */

  async function renderTiksPanel(isRefresh = false) {
    if (!_panelActive) return;

    /* 1) récupérer l'UID auth si nécessaire */
    try {
      const authUid = await getAuthUid();
      if (authUid !== _authUid) {
        // auth changed -> refresh profileId cache
        _authUid = authUid;
        _profileId = null;
      }
    } catch (e) {
      console.warn('tiks.js renderTiksPanel getAuthUid failed', e);
    }

    /* 2) si pas connecté */
    if (!_authUid) {
      placeholderTitle.textContent = 'Tiks';
      placeholderText.innerHTML =
        '<p class="text-slate-500 text-sm mt-2">Connectez-vous pour consulter votre solde Tiks.</p>';
      return;
    }

    /* 3) obtenir profileId si pas en cache */
    if (!_profileId) {
      _profileId = await fetchProfileIdForAuthUid(_authUid);
    }

    /* 4) si pas de profile (utilisateur connecté mais profil pas encore créé) */
    if (!_profileId) {
      placeholderTitle.textContent = 'Tiks';
      placeholderText.innerHTML = `
        <p class="text-slate-400 text-sm mt-2 italic">
          Profil non trouvé — complète ton pseudo pour initialiser ton portefeuille.
        </p>`;
      return;
    }

    /* 5) fetch de la balance par profileId */
    const row = await fetchBalanceByProfileId(_profileId);

    /* 6) mise à jour du titre */
    placeholderTitle.textContent = 'Tiks';

    if (!row) {
      /* Ligne inexistante — cas exceptionnel (trigger normalement créé la ligne) */
      placeholderText.innerHTML = `
        <p class="text-slate-400 text-sm mt-2 italic">
          Aucune balance trouvée. Elle sera créée automatiquement après la première connexion complète.
        </p>`;
      return;
    }

    /* ── Calculs et affichage ── */
    const balance   = Number(row.balance   ?? 0);
    const usdtValue = row.usdt_value != null
      ? Number(row.usdt_value)
      : balance / TIKS_PER_USDT;

    const currency  = row.currency ?? 'TIKS';
    const updatedAt = row.updated_at
      ? new Date(row.updated_at).toLocaleString('fr-FR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        })
      : '—';

    const refreshBadge = isRefresh
      ? `<span id="tiksRefreshDot" title="Données actualisées"
            style="display:inline-block;width:8px;height:8px;border-radius:50%;
                   background:#22c55e;margin-left:6px;vertical-align:middle;"></span>`
      : '';

    placeholderText.innerHTML = `
      <div class="space-y-4 mt-2">

        <!-- Carte principale balance -->
        <div style="
          background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%);
          border-radius: 16px;
          padding: 24px 28px;
          color: #fff;
          box-shadow: 0 8px 24px rgba(99,102,241,0.18);
          position: relative;
        ">
          <div style="font-size:13px; opacity:0.85; letter-spacing:0.06em; text-transform:uppercase; font-weight:600;">
            Solde disponible ${refreshBadge}
          </div>

          <div style="margin-top:10px; display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap;">
            <!-- TIKS -->
            <div>
              <span style="font-size:42px; font-weight:800; line-height:1;" id="tiksBalance">
                ${fmt(balance, 0)}
              </span>
              <span style="font-size:18px; font-weight:600; margin-left:6px; opacity:0.9;">${currency}</span>
            </div>

            <!-- Séparateur -->
            <div style="font-size:20px; opacity:0.55; padding-bottom:4px;">≈</div>

            <!-- USDT -->
            <div>
              <span style="font-size:24px; font-weight:700; line-height:1;" id="tiksUsdt">
                ${fmt(usdtValue, 4)}
              </span>
              <span style="font-size:14px; font-weight:600; margin-left:4px; opacity:0.85;">USDT</span>
            </div>
          </div>

          <div style="margin-top:14px; font-size:12px; opacity:0.7;">
            Taux : 1 USDT = ${TIKS_PER_USDT} TIKS &nbsp;|&nbsp; Mis à jour le ${updatedAt}
          </div>

          <div style="
            position:absolute; right:20px; top:50%; transform:translateY(-50%);
            font-size:52px; opacity:0.10; pointer-events:none; user-select:none;
          ">🪙</div>
        </div>

        <!-- Ligne d'infos secondaires -->
        <div style="
          display:grid; grid-template-columns:1fr 1fr;
          gap:12px;
        ">
          <div style="
            background:#f8fafc; border:1px solid #e2e8f0;
            border-radius:10px; padding:14px 16px;
          ">
            <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em; font-weight:600; margin-bottom:6px;">
              Balance TIKS
            </div>
            <div style="font-size:22px; font-weight:700; color:#1e293b;">${fmt(balance, 2)}</div>
            <div style="font-size:12px; color:#64748b; margin-top:2px;">${currency}</div>
          </div>

          <div style="
            background:#f8fafc; border:1px solid #e2e8f0;
            border-radius:10px; padding:14px 16px;
          ">
            <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em; font-weight:600; margin-bottom:6px;">
              Équivalent USDT
            </div>
            <div style="font-size:22px; font-weight:700; color:#1e293b;">${fmt(usdtValue, 6)}</div>
            <div style="font-size:12px; color:#64748b; margin-top:2px;">USDT</div>
          </div>
        </div>

        <p style="font-size:12px; color:#94a3b8; margin-top:4px; text-align:right;">
          <i class="fa-solid fa-rotate" style="margin-right:4px;"></i>
          Actualisation automatique toutes les ${Math.round(POLL_MS / 1000)} secondes.
        </p>

      </div>`;

    /* ── Mettre à jour aussi #statTiks dans le homePanel si présent ── */
    try {
      const statTiks = document.getElementById('statTiks');
      if (statTiks) statTiks.textContent = fmt(balance, 0);
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Polling                                                            */
  /* ─────────────────────────────────────────────────────────────────── */

  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(async () => {
      try { await renderTiksPanel(true); } catch (e) { console.warn('tiks.js poll error', e); }
    }, POLL_MS);
  }

  function stopPolling() {
    if (_pollTimer != null) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Gestion du panel (show / hide)                                     */
  /* ─────────────────────────────────────────────────────────────────── */

  function showPanel() {
    _panelActive = true;
    homePanel?.classList.add('hidden');
    profilePanel?.classList.add('hidden');
    placeholderPanel?.classList.remove('hidden');

    placeholderTitle.textContent = 'Tiks';
    placeholderText.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-top:12px;color:#94a3b8;">
        <span style="display:inline-block;width:18px;height:18px;border:2px solid #94a3b8;
                     border-top-color:#6366f1;border-radius:50%;animation:spin .7s linear infinite;"></span>
        Chargement du solde…
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;

    renderTiksPanel(false).catch(e => console.warn('tiks.js renderTiksPanel error', e));
    startPolling();
  }

  function hidePanel() {
    _panelActive = false;
    stopPolling();
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Remplacement du handler menuTiks dans index.html                   */
  /* ─────────────────────────────────────────────────────────────────── */

  const newMenuTiks = menuTiks.cloneNode(true);
  menuTiks.parentNode.replaceChild(newMenuTiks, menuTiks);

  function setActiveMenuFallback(btn) {
    const all = ['menuHome','menuStats','menuGames','menuNotifications',
                 'menuTiks','menuTx','menuMingots','menuProfile'];
    all.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('bg-sky-500','text-white','font-semibold');
    });
    btn.classList.add('bg-sky-500','text-white','font-semibold');
  }

  newMenuTiks.addEventListener('click', () => {
    if (typeof window.setActiveMenu === 'function') {
      window.setActiveMenu(newMenuTiks);
    } else {
      setActiveMenuFallback(newMenuTiks);
    }

    if (window.innerWidth < 768) mainNav?.classList.add('hidden');

    showPanel();
  });

  const otherMenuIds = ['menuHome','menuStats','menuGames',
                        'menuNotifications','menuTx','menuMingots','menuProfile'];
  otherMenuIds.forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      if (_panelActive) hidePanel();
    });
  });

  window.addEventListener('pagehide', stopPolling);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPolling();
    else if (_panelActive) startPolling();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Mise à jour silencieuse du compteur statTiks sur la home           */
  /* ─────────────────────────────────────────────────────────────────── */
  (async () => {
    try {
      const authUid = await getAuthUid();
      if (!authUid) return;
      const profId = await fetchProfileIdForAuthUid(authUid);
      if (!profId) return;
      const row = await fetchBalanceByProfileId(profId);
      if (!row) return;
      const statTiks = document.getElementById('statTiks');
      if (statTiks) statTiks.textContent = fmt(Number(row.balance ?? 0), 0);
    } catch (_) {}
  })();

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Écouter les changements d'authentification                         */
  /*  (si l'utilisateur se connecte pendant que le panel est ouvert)    */
  /* ─────────────────────────────────────────────────────────────────── */
  if (supabase?.auth?.onAuthStateChange) {
    supabase.auth.onAuthStateChange((event, session) => {
      const newUid = session?.user?.id ?? null;
      _authUid = newUid;
      // refresh profileId cache
      (async () => {
        _profileId = newUid ? await fetchProfileIdForAuthUid(newUid) : null;
        if (_panelActive) {
          renderTiksPanel(true).catch(() => {});
        }
        if (_profileId) {
          fetchBalanceByProfileId(_profileId).then(row => {
            const statTiks = document.getElementById('statTiks');
            if (statTiks && row) statTiks.textContent = fmt(Number(row.balance ?? 0), 0);
          }).catch(() => {});
        }
      })();
    });
  } else {
    // best-effort: try initial start
    (async () => {
      const u = await getAuthUid();
      _authUid = u;
      _profileId = u ? await fetchProfileIdForAuthUid(u) : null;
    })();
  }

})();
