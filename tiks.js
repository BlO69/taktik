/**
 * tiks.js — Balance TIKS + Packs + Achat via MonCash (sandbox)
 *
 * Compatible avec index.html :
 *  - Se greffe sur #menuTiks (remplace le handler placeholder)
 *  - Affiche le panel dans #placeholderPanel / #placeholderText
 *  - Polling toutes les POLL_MS ms (pas de realtime Supabase)
 *  - Lit public.tiks_balances (balance, usdt_value, updated_at)
 *  - Lit public.tiks_packs pour afficher les packs disponibles
 *  - Initie un paiement MonCash via l'Edge Function moncash-initiate
 */

const POLL_MS        = 8000;   // intervalle de polling en ms
const TIKS_PER_USDT  = 200;    // 1 USDT = 200 TIKS (cohérent avec la colonne générée)
const FALLBACK_RATE  = 133.0;  // HTG par USD si exchange_rates vide

/* ─────────────────────────────────────────────────────────────────────── */
/*  Init principale                                                        */
/* ─────────────────────────────────────────────────────────────────────── */
(async function initTiks() {
  /* 1. Récupérer le client Supabase (window.supabase, défini par supabaseClient.js) */
  const supabase = window.supabase ?? null;

  /* 2. Éléments DOM partagés avec index.html */
  const menuTiks         = document.getElementById('menuTiks');
  const homePanel        = document.getElementById('homePanel');
  const profilePanel     = document.getElementById('profilePanel');
  const placeholderPanel = document.getElementById('placeholderPanel');
  const placeholderTitle = document.getElementById('placeholderTitle');
  const placeholderText  = document.getElementById('placeholderText');
  const mainNav          = document.getElementById('mainNav');

  if (!menuTiks || !placeholderPanel) return; // page incompatible

  /* ── État interne ─────────────────────────────────────────────────── */
  let _pollTimer    = null;
  let _panelActive  = false;
  let _userId       = null;
  let _cachedPacks  = [];
  let _cachedRate   = FALLBACK_RATE;

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Helpers généraux                                                   */
  /* ─────────────────────────────────────────────────────────────────── */

  function fmt(n, decimals = 2) {
    if (n == null || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function getSupabaseUrl() {
    try {
      return supabase?.supabaseUrl ?? supabase?._url ?? window.SUPABASE_URL ?? null;
    } catch { return null; }
  }

  async function getUserId() {
    if (!supabase?.auth) return null;
    try {
      const { data } = await supabase.auth.getSession();
      return data?.session?.user?.id ?? null;
    } catch { return null; }
  }

  async function getAccessToken() {
    if (!supabase?.auth) return null;
    try {
      const { data } = await supabase.auth.getSession();
      return data?.session?.access_token ?? null;
    } catch { return null; }
  }

  async function fetchBalance(userId) {
    if (!supabase || !userId) return null;
    try {
      const { data, error } = await supabase
        .from('tiks_balances')
        .select('balance, usdt_value, updated_at, currency')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) { console.warn('tiks.js fetchBalance error', error); return null; }
      return data;
    } catch (e) {
      console.warn('tiks.js fetchBalance exception', e);
      return null;
    }
  }

  async function fetchPacks() {
    if (!supabase) return [];
    try {
      const { data, error } = await supabase
        .from('tiks_packs')
        .select('id, name, description, tiks_amount, price_usdt, bonus_tiks')
        .eq('active', true)
        .order('price_usdt', { ascending: true });
      if (error) { console.warn('tiks.js fetchPacks error', error); return []; }
      return data ?? [];
    } catch (e) {
      console.warn('tiks.js fetchPacks exception', e);
      return [];
    }
  }

  async function fetchCurrentRate() {
    if (!supabase) return FALLBACK_RATE;
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase
        .from('exchange_rates')
        .select('rate')
        .eq('currency_from', 'USD')
        .eq('currency_to', 'GDE')
        .lte('effective_date', today)
        .order('effective_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.rate ? Number(data.rate) : FALLBACK_RATE;
    } catch { return FALLBACK_RATE; }
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Toast notification                                                 */
  /* ─────────────────────────────────────────────────────────────────── */
  function showToast(msg, type = 'info') {
    try {
      document.getElementById('tiksToast')?.remove();
      const colors = { success: '#22c55e', error: '#ef4444', info: '#6366f1' };
      const t = document.createElement('div');
      t.id = 'tiksToast';
      t.textContent = msg;
      Object.assign(t.style, {
        position: 'fixed', bottom: '24px', left: '50%',
        transform: 'translateX(-50%)',
        background: colors[type] ?? colors.info,
        color: '#fff', padding: '10px 18px', borderRadius: '10px',
        fontSize: '14px', fontWeight: '600', zIndex: '99999',
        boxShadow: '0 4px 16px rgba(0,0,0,.18)',
        maxWidth: '90vw', textAlign: 'center',
      });
      if (!document.getElementById('tiksToastStyle')) {
        const s = document.createElement('style');
        s.id = 'tiksToastStyle';
        s.textContent = `@keyframes spin{to{transform:rotate(360deg)}}`;
        document.head.appendChild(s);
      }
      document.body.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 4500);
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Modal de confirmation d'achat                                      */
  /* ─────────────────────────────────────────────────────────────────── */
  function showConfirmModal(pack, amountGourdes, onConfirm) {
    document.getElementById('tiksConfirmModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'tiksConfirmModal';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '10002', padding: '16px',
    });
    const totalTiks = Number(pack.tiks_amount) + Number(pack.bonus_tiks ?? 0);
    const bonusHtml = Number(pack.bonus_tiks) > 0
      ? `<span style="font-size:12px;color:#22c55e;margin-left:6px;">+${fmt(pack.bonus_tiks, 0)} bonus 🎁</span>` : '';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:28px 24px;
           max-width:400px;width:100%;text-align:center;
           box-shadow:0 16px 40px rgba(0,0,0,.25);">
        <div style="font-size:36px;margin-bottom:10px;">🪙</div>
        <h3 style="font-size:18px;font-weight:800;color:#1e293b;margin:0 0 8px;">
          Acheter le pack <em>${pack.name}</em>
        </h3>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;
             padding:14px;margin:14px 0;font-size:15px;color:#334155;">
          <div style="margin-bottom:6px;">
            <strong style="font-size:20px;color:#6366f1;">${fmt(totalTiks, 0)} TIKS</strong>
            ${bonusHtml}
          </div>
          <div style="color:#64748b;font-size:13px;">≈ ${fmt(Number(pack.price_usdt), 4)} USDT</div>
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;
               font-size:18px;font-weight:700;color:#0f172a;">
            💳 ${fmt(amountGourdes, 2)} HTG (Gourdes)
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:4px;">
            via MonCash · Taux : 1 USD ≈ ${fmt(_cachedRate, 2)} HTG
          </div>
        </div>
        <p style="font-size:13px;color:#64748b;margin:0 0 18px;">
          Vous serez redirigé vers MonCash pour finaliser le paiement.
        </p>
        <div style="display:flex;gap:10px;justify-content:center;">
          <button id="tiksConfirmCancel" style="padding:10px 20px;border-radius:8px;
            border:1px solid #e2e8f0;background:#f8fafc;font-size:14px;
            font-weight:600;cursor:pointer;">Annuler</button>
          <button id="tiksConfirmOk" style="padding:10px 22px;border-radius:8px;border:none;
            background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff;
            font-size:14px;font-weight:700;cursor:pointer;">Payer avec MonCash</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#tiksConfirmCancel').onclick = () => overlay.remove();
    overlay.querySelector('#tiksConfirmOk').onclick     = () => { overlay.remove(); onConfirm(); };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Achat via MonCash                                                  */
  /* ─────────────────────────────────────────────────────────────────── */
  async function initiatePurchase(packId, packName, amountGourdes) {
    const supabaseUrl = getSupabaseUrl();
    if (!supabaseUrl) { showToast('Erreur : URL Supabase introuvable.', 'error'); return; }

    const token = await getAccessToken();
    if (!token) { showToast("Veuillez vous connecter avant d'acheter.", 'error'); return; }

    const btn = document.querySelector(`[data-pack-id="${packId}"]`);
    const origLabel = btn?.innerHTML ?? '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span style="display:inline-block;width:14px;height:14px;border:2px solid #fff;
        border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;
        vertical-align:middle;margin-right:6px;"></span>Chargement…`;
    }

    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/moncash-payment`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack_id: packId }),
      });
      const result = await res.json();
      if (!res.ok || !result.payment_url) throw new Error(result.error ?? 'Réponse inattendue');

      window.open(result.payment_url, '_blank', 'noopener,noreferrer');
      showToast(`Redirection MonCash pour ${packName} (${fmt(result.amount_gourdes, 2)} HTG)…`, 'success');
    } catch (err) {
      console.error('initiatePurchase error:', err);
      showToast('Erreur paiement : ' + (err?.message ?? err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    }
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Rendu : carte pack                                                 */
  /* ─────────────────────────────────────────────────────────────────── */
  const PACK_THEMES = {
    'Mini':     { bg: '#f1f5f9', badge: '#64748b', icon: '🪙' },
    'Starter':  { bg: '#eff6ff', badge: '#3b82f6', icon: '🚀' },
    'Bronze':   { bg: '#fef3e2', badge: '#d97706', icon: '🥉' },
    'Silver':   { bg: '#f1f5f9', badge: '#6b7280', icon: '🥈' },
    'Gold':     { bg: '#fffbeb', badge: '#f59e0b', icon: '🥇' },
    'Platinum': { bg: '#ede9fe', badge: '#7c3aed', icon: '💎' },
    'Whale':    { bg: '#fff1f2', badge: '#e11d48', icon: '🐋' },
  };

  function renderPackCard(pack, htgRate) {
    const theme     = PACK_THEMES[pack.name] ?? { bg: '#f8fafc', badge: '#64748b', icon: '🪙' };
    const totalTiks = Number(pack.tiks_amount) + Number(pack.bonus_tiks ?? 0);
    const amtHTG    = Math.round(Number(pack.price_usdt) * htgRate * 100) / 100;
    const bonusHtml = Number(pack.bonus_tiks) > 0
      ? `<div style="font-size:11px;color:#22c55e;font-weight:600;margin-top:2px;">
           +${fmt(pack.bonus_tiks, 0)} bonus 🎁</div>` : '';

    return `
      <div style="background:${theme.bg};border:1px solid #e2e8f0;border-radius:14px;
           padding:16px 14px;display:flex;flex-direction:column;gap:6px;
           position:relative;overflow:hidden;">
        <div style="display:inline-flex;align-items:center;gap:6px;
             background:${theme.badge}18;color:${theme.badge};
             font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;
             border:1px solid ${theme.badge}33;width:fit-content;">
          ${theme.icon} ${pack.name}
        </div>
        <div style="margin-top:4px;">
          <span style="font-size:26px;font-weight:800;color:#1e293b;line-height:1;">
            ${fmt(totalTiks, 0)}
          </span>
          <span style="font-size:13px;font-weight:600;color:#64748b;margin-left:4px;">TIKS</span>
          ${bonusHtml}
        </div>
        <div style="margin-top:6px;padding-top:8px;border-top:1px solid #e2e8f0;">
          <div style="font-size:18px;font-weight:800;color:#0f172a;">
            ${fmt(amtHTG, 2)} <span style="font-size:13px;font-weight:600;color:#64748b;">HTG</span>
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:1px;">≈ ${fmt(pack.price_usdt, 4)} USDT</div>
        </div>
        <button class="tiks-buy-btn"
          data-pack-id="${pack.id}"
          data-pack-name="${pack.name.replace(/"/g, '&quot;')}"
          data-pack-htg="${amtHTG}"
          style="margin-top:8px;padding:9px 0;border-radius:8px;border:none;
                 background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff;
                 font-size:13px;font-weight:700;cursor:pointer;width:100%;">
          Acheter
        </button>
        <div style="position:absolute;right:-8px;top:-8px;font-size:48px;
             opacity:.06;pointer-events:none;user-select:none;">${theme.icon}</div>
      </div>`;
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Rendu principal du panel                                           */
  /* ─────────────────────────────────────────────────────────────────── */
  async function renderTiksPanel(isRefresh = false) {
    if (!_panelActive) return;
    if (!_userId) _userId = await getUserId();

    if (!_userId) {
      placeholderTitle.textContent = 'Tiks';
      placeholderText.innerHTML =
        '<p class="text-slate-500 text-sm mt-2">Connectez-vous pour consulter votre solde Tiks.</p>';
      return;
    }

    const row = await fetchBalance(_userId);

    if (!isRefresh || _cachedPacks.length === 0) {
      const [packs, rate] = await Promise.all([fetchPacks(), fetchCurrentRate()]);
      _cachedPacks = packs;
      _cachedRate  = rate;
    }

    placeholderTitle.textContent = 'Tiks';

    if (!row) {
      placeholderText.innerHTML = `
        <p class="text-slate-400 text-sm mt-2 italic">
          Aucune balance trouvée. Elle sera créée automatiquement après la première connexion.
        </p>`;
      return;
    }

    const balance   = Number(row.balance ?? 0);
    const usdtValue = row.usdt_value != null ? Number(row.usdt_value) : balance / TIKS_PER_USDT;
    const currency  = row.currency ?? 'TIKS';
    const updatedAt = row.updated_at
      ? new Date(row.updated_at).toLocaleString('fr-FR', {
          day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      : '—';

    const refreshBadge = isRefresh
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;
              background:#22c55e;margin-left:6px;vertical-align:middle;" title="Actualisé"></span>`
      : '';

    const packsHtml = _cachedPacks.length === 0
      ? `<p style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">Aucun pack disponible.</p>`
      : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;">
           ${_cachedPacks.map(p => renderPackCard(p, _cachedRate)).join('')}
         </div>`;

    placeholderText.innerHTML = `
      <div class="space-y-5 mt-2">

        <!-- Carte principale balance -->
        <div style="background:linear-gradient(135deg,#0ea5e9 0%,#6366f1 100%);
             border-radius:16px;padding:24px 28px;color:#fff;
             box-shadow:0 8px 24px rgba(99,102,241,.18);position:relative;">
          <div style="font-size:13px;opacity:.85;letter-spacing:.06em;text-transform:uppercase;font-weight:600;">
            Solde disponible ${refreshBadge}
          </div>
          <div style="margin-top:10px;display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;">
            <div>
              <span style="font-size:42px;font-weight:800;line-height:1;" id="tiksBalance">${fmt(balance, 0)}</span>
              <span style="font-size:18px;font-weight:600;margin-left:6px;opacity:.9;">${currency}</span>
            </div>
            <div style="font-size:20px;opacity:.55;padding-bottom:4px;">≈</div>
            <div>
              <span style="font-size:24px;font-weight:700;line-height:1;" id="tiksUsdt">${fmt(usdtValue, 4)}</span>
              <span style="font-size:14px;font-weight:600;margin-left:4px;opacity:.85;">USDT</span>
            </div>
          </div>
          <div style="margin-top:14px;font-size:12px;opacity:.7;">
            Taux : 1 USDT = ${TIKS_PER_USDT} TIKS &nbsp;|&nbsp; Mis à jour le ${updatedAt}
          </div>
          <div style="position:absolute;right:20px;top:50%;transform:translateY(-50%);
               font-size:52px;opacity:.10;pointer-events:none;user-select:none;">🪙</div>
        </div>

        <!-- Tuiles secondaires -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px;">
              Balance TIKS</div>
            <div style="font-size:22px;font-weight:700;color:#1e293b;">${fmt(balance, 2)}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">${currency}</div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;">
            <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px;">
              Équivalent USDT</div>
            <div style="font-size:22px;font-weight:700;color:#1e293b;">${fmt(usdtValue, 6)}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">USDT</div>
          </div>
        </div>

        <!-- Packs -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h4 style="font-size:15px;font-weight:700;color:#1e293b;margin:0;">🛍️ Acheter des TIKS</h4>
            <span style="font-size:12px;color:#94a3b8;">1 USD ≈ ${fmt(_cachedRate, 2)} HTG</span>
          </div>
          ${packsHtml}
        </div>

        <!-- Note -->
        <p style="font-size:12px;color:#94a3b8;margin-top:4px;text-align:right;">
          <i class="fa-solid fa-rotate" style="margin-right:4px;"></i>
          Actualisation automatique toutes les ${POLL_MS / 1000} s.
        </p>
      </div>`;

    /* ── Mettre à jour #statTiks ── */
    try {
      const statTiks = document.getElementById('statTiks');
      if (statTiks) statTiks.textContent = fmt(balance, 0);
    } catch (_) {}

    /* ── Listeners sur les boutons Acheter ── */
    placeholderText.querySelectorAll('.tiks-buy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const packId   = btn.dataset.packId;
        const packName = btn.dataset.packName;
        const htg      = Number(btn.dataset.packHtg);
        const pack     = _cachedPacks.find(p => p.id === packId);
        if (!pack) return;
        showConfirmModal(pack, htg, async () => {
          await initiatePurchase(packId, packName, htg);
          setTimeout(() => renderTiksPanel(true).catch(() => {}), 3000);
        });
      });
    });
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
    if (_pollTimer != null) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Gestion du panel                                                   */
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
      </div>`;
    renderTiksPanel(false).catch(e => console.warn('tiks.js renderTiksPanel error', e));
    startPolling();
  }

  function hidePanel() { _panelActive = false; stopPolling(); }

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Remplacement du handler menuTiks                                   */
  /* ─────────────────────────────────────────────────────────────────── */
  const newMenuTiks = menuTiks.cloneNode(true);
  menuTiks.parentNode.replaceChild(newMenuTiks, menuTiks);

  function setActiveMenuFallback(btn) {
    ['menuHome','menuStats','menuGames','menuNotifications',
     'menuTiks','menuTx','menuMingots','menuProfile'].forEach(id => {
      document.getElementById(id)?.classList.remove('bg-sky-500','text-white','font-semibold');
    });
    btn.classList.add('bg-sky-500','text-white','font-semibold');
  }

  newMenuTiks.addEventListener('click', () => {
    if (typeof window.setActiveMenu === 'function') window.setActiveMenu(newMenuTiks);
    else setActiveMenuFallback(newMenuTiks);
    if (window.innerWidth < 768) mainNav?.classList.add('hidden');
    showPanel();
  });

  ['menuHome','menuStats','menuGames','menuNotifications','menuTx','menuMingots','menuProfile']
    .forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => { if (_panelActive) hidePanel(); });
    });

  window.addEventListener('pagehide', stopPolling);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPolling();
    else if (_panelActive) startPolling();
  });

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Mise à jour silencieuse de #statTiks au chargement                 */
  /* ─────────────────────────────────────────────────────────────────── */
  (async () => {
    try {
      const uid = await getUserId();
      if (!uid) return;
      const row = await fetchBalance(uid);
      if (!row) return;
      const statTiks = document.getElementById('statTiks');
      if (statTiks) statTiks.textContent = fmt(Number(row.balance ?? 0), 0);
    } catch (_) {}
  })();

  /* ─────────────────────────────────────────────────────────────────── */
  /*  Changements d'authentification                                     */
  /* ─────────────────────────────────────────────────────────────────── */
  supabase?.auth?.onAuthStateChange?.((event, session) => {
    _userId = session?.user?.id ?? null;
    if (_panelActive) renderTiksPanel(true).catch(() => {});
    if (_userId) {
      fetchBalance(_userId).then(row => {
        const statTiks = document.getElementById('statTiks');
        if (statTiks && row) statTiks.textContent = fmt(Number(row.balance ?? 0), 0);
      }).catch(() => {});
    }
  });

})();
