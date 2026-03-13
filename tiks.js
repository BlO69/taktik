/**
 * tiks.js — Balance TIKS + Packs + Achat + Retrait via MonCash
 *
 * Corrections v4 :
 *  - Suppression mention "(Sandbox)" → paiement MonCash Live
 *  - Vérification rôle administrateur (user_profiles.role)
 *    → admin : bouton "Consulter les KYC" au lieu de "Remplir le KYC"
 *    → les deux redirectent vers kyc.html
 */

/* ── Config ─────────────────────────────────────────────────────────── */
const POLL_MS           = 8000;
const TIKS_PER_USDT     = 200;
const DEFAULT_HTG_RATE  = 132.0;
const SUPABASE_PROJECT  = 'mvkfawtnvahxqwcbcfkb';
const EDGE_PAYMENT_URL  = `https://${SUPABASE_PROJECT}.supabase.co/functions/v1/moncash-payment`;

/* Seuils retrait (test) */
const WITHDRAW_MIN_TIKS      = 1000;
const WITHDRAW_MIN_FOLLOWERS = 5;

/* ─────────────────────────────────────────────────────────────────────── */
(async function initTiks() {

  const supabase = window.supabase ?? null;

  /* ── DOM ── */
  const menuTiks         = document.getElementById('menuTiks');
  const homePanel        = document.getElementById('homePanel');
  const profilePanel     = document.getElementById('profilePanel');
  const placeholderPanel = document.getElementById('placeholderPanel');
  const placeholderTitle = document.getElementById('placeholderTitle');
  const placeholderText  = document.getElementById('placeholderText');
  const mainNav          = document.getElementById('mainNav');

  if (!menuTiks || !placeholderPanel) return;

  /* ── État ── */
  let _pollTimer    = null;
  let _panelActive  = false;
  let _userId       = null;
  let _sessionToken = null;
  let _htgRate      = DEFAULT_HTG_RATE;

  /* ══════════════════════════════════════════════════════════════════ */
  /*  HELPERS                                                           */
  /* ══════════════════════════════════════════════════════════════════ */

  function fmt(n, decimals = 2) {
    if (n == null || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  function fmtHTG(n) {
    if (n == null || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('fr-FR', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }) + ' HTG';
  }
  function spinner(size = 20) {
    return `<style>@keyframes tiks-spin{to{transform:rotate(360deg)}}</style>
      <span style="display:inline-block;width:${size}px;height:${size}px;
        border:2px solid #94a3b8;border-top-color:#6366f1;border-radius:50%;
        animation:tiks-spin .7s linear infinite;flex-shrink:0;"></span>`;
  }

  /* ── Session ── */
  async function getSession() {
    if (!supabase?.auth) return null;
    try {
      const { data } = await supabase.auth.getSession();
      return data?.session ?? null;
    } catch { return null; }
  }
  async function getUserId() {
    const s = await getSession();
    _sessionToken = s?.access_token ?? null;
    return s?.user?.id ?? null;
  }

  /* ── callEdge : appel robuste à l'Edge Function ── */
  async function callEdge(payload) {
    if (!_sessionToken) {
      const s = await getSession();
      _sessionToken = s?.access_token ?? null;
    }
    if (!_sessionToken) throw new Error('Non authentifié');

    /* Clé anon — cherche dans plusieurs emplacements du client Supabase JS v2 */
    const anonKey = supabase?.supabaseKey
      ?? supabase?.options?.global?.headers?.apikey
      ?? window.SUPABASE_ANON_KEY
      ?? '';

    const res = await fetch(EDGE_PAYMENT_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${_sessionToken}`,
        'apikey':        anonKey,
      },
      body: JSON.stringify(payload),
    });

    let data;
    try { data = await res.json(); }
    catch { throw new Error(`HTTP ${res.status} — réponse non-JSON`); }

    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  /* ── Fetch balance ── */
  async function fetchBalance(userId) {
    if (!supabase || !userId) return null;
    try {
      const { data, error } = await supabase
        .from('tiks_balances')
        .select('balance, usdt_value, updated_at, currency')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) { console.warn('tiks fetchBalance error', error); return null; }
      return data;
    } catch (e) { console.warn('tiks fetchBalance exception', e); return null; }
  }

  /* ── Fetch packs actifs ── */
  async function fetchPacks() {
    if (!supabase) return [];
    try {
      const { data, error } = await supabase
        .from('tiks_packs')
        .select('id, name, description, tiks_amount, price_usdt, bonus_tiks')
        .eq('active', true)
        .order('price_usdt', { ascending: true });
      if (error) { console.warn('tiks fetchPacks error', error); return []; }
      return data ?? [];
    } catch { return []; }
  }

  /* ── Fetch taux HTG ── */
  async function fetchHTGRate() {
    if (!supabase) return DEFAULT_HTG_RATE;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await supabase
        .from('exchange_rates')
        .select('rate')
        .eq('currency_from', 'USD')
        .eq('currency_to',   'GDE')
        .lte('effective_date', today)
        .order('effective_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.rate ? Number(data.rate) : DEFAULT_HTG_RATE;
    } catch { return DEFAULT_HTG_RATE; }
  }

  /* ── Fetch éligibilité retrait (balance + followers + KYC + rôle) ── */
  async function fetchWithdrawEligibility(userId) {
    const fallback = {
      eligible: false, kycVerified: false, kycExists: false,
      followerCount: 0, balance: 0, isAdmin: false,
    };
    if (!supabase || !userId) return fallback;
    try {
      const [balRes, profileRes, kycRes] = await Promise.allSettled([
        supabase.from('tiks_balances').select('balance').eq('user_id', userId).maybeSingle(),
        /* ▼ on récupère aussi le rôle ici */
        supabase.from('user_profiles').select('follower_count, role').eq('id', userId).maybeSingle(),
        supabase.from('kyc_profiles').select('is_verified').eq('user_id', userId).maybeSingle(),
      ]);

      const balance       = Number(balRes.status === 'fulfilled' ? (balRes.value?.data?.balance ?? 0) : 0);
      const profileData   = profileRes.status === 'fulfilled' ? (profileRes.value?.data ?? null) : null;
      const followerCount = Number(profileData?.follower_count ?? 0);
      const isAdmin       = profileData?.role === 'administrator';
      const kycRow        = kycRes.status === 'fulfilled' ? kycRes.value?.data : null;
      const kycExists     = !!kycRow;
      const kycVerified   = kycRow?.is_verified === true;

      const eligible = balance >= WITHDRAW_MIN_TIKS
        && followerCount >= WITHDRAW_MIN_FOLLOWERS
        && kycVerified;

      return { eligible, kycVerified, kycExists, followerCount, balance, isAdmin };
    } catch (e) {
      console.warn('tiks fetchWithdrawEligibility error', e);
      return fallback;
    }
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  RETOUR MONCASH (?tiks_return=1)                                   */
  /* ══════════════════════════════════════════════════════════════════ */

  async function checkMonCashReturn() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('tiks_return')) return;

    let pendingPurchase = null;
    try { pendingPurchase = JSON.parse(localStorage.getItem('tiks_pending_purchase') ?? 'null'); } catch {}

    const transactionId = params.get('transactionId') ?? params.get('transaction_id') ?? '';
    const orderId       = pendingPurchase?.order_id ?? params.get('orderId') ?? '';

    try { history.replaceState(null, '', window.location.pathname); } catch {}

    if (!transactionId && !orderId) return;

    showPanel(true);
    placeholderText.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:32px 0;">
        <span style="font-size:38px;">⏳</span>
        <div style="font-weight:600;font-size:16px;color:#1e293b;">Vérification du paiement…</div>
        <div style="font-size:13px;color:#64748b;">Merci de patienter, nous confirmons votre transaction MonCash.</div>
        ${spinner(24)}
      </div>`;

    try {
      if (!_userId) _userId = await getUserId();
      if (!_userId) throw new Error('Veuillez vous reconnecter.');

      const result = await callEdge({ action: 'verify', transaction_id: transactionId, order_id: orderId });
      localStorage.removeItem('tiks_pending_purchase');

      if (result?.ok && (result?.status === 'paid' || result?.already_processed)) {
        const credited = result.tiks_credited ?? 0;
        const newBal   = result.balance?.balance ?? 0;
        placeholderText.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px 0;">
            <span style="font-size:52px;">🎉</span>
            <div style="font-weight:700;font-size:20px;color:#16a34a;">Paiement confirmé !</div>
            <div style="font-size:14px;color:#475569;">
              <strong>${fmt(credited, 0)} TIKS</strong> ont été crédités sur votre compte.
            </div>
            <div style="font-size:13px;color:#94a3b8;">Nouveau solde : <strong>${fmt(newBal, 0)} TIKS</strong></div>
            <button id="tiksReturnBtn" style="margin-top:8px;padding:10px 24px;border:none;
              border-radius:8px;background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer;font-size:14px;">
              Voir mon solde
            </button>
          </div>`;
        document.getElementById('tiksReturnBtn')?.addEventListener('click', () => renderTiksPanel(false).catch(() => {}));
      } else {
        placeholderText.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px 0;">
            <span style="font-size:52px;">⚠️</span>
            <div style="font-weight:700;font-size:18px;color:#b45309;">Paiement non confirmé</div>
            <div style="font-size:13px;color:#64748b;text-align:center;">
              Statut : <strong>${result?.status ?? 'inconnu'}</strong><br>
              Si vous avez bien payé, votre solde sera mis à jour automatiquement.
            </div>
            <button id="tiksVerifyRetryBtn" style="margin-top:8px;padding:10px 24px;border:none;
              border-radius:8px;background:#f59e0b;color:#fff;font-weight:600;cursor:pointer;font-size:14px;">
              Retour au solde
            </button>
          </div>`;
        document.getElementById('tiksVerifyRetryBtn')?.addEventListener('click', () => renderTiksPanel(false).catch(() => {}));
      }
    } catch (e) {
      placeholderText.innerHTML = `
        <div style="padding:24px;text-align:center;">
          <span style="font-size:36px;">❌</span>
          <div style="font-weight:600;color:#dc2626;margin-top:8px;">Erreur de vérification</div>
          <div style="font-size:13px;color:#64748b;margin-top:6px;">${String(e?.message ?? e)}</div>
          <button id="tiksErrBackBtn" style="margin-top:12px;padding:8px 20px;border:none;
            border-radius:8px;background:#64748b;color:#fff;cursor:pointer;font-size:13px;">Retour</button>
        </div>`;
      document.getElementById('tiksErrBackBtn')?.addEventListener('click', () => renderTiksPanel(false).catch(() => {}));
    }
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  ACHAT PACK                                                        */
  /* ══════════════════════════════════════════════════════════════════ */

  async function handleBuyPack(pack) {
    if (!_userId) _userId = await getUserId();
    if (!_userId) { alert('Veuillez vous connecter pour acheter des Tiks.'); return; }

    const priceHTG = Math.round(Number(pack.price_usdt) * _htgRate * 100) / 100;
    const confirmed = window.confirm(
      `Acheter le pack « ${pack.name} » ?\n\n` +
      `  ${fmt(pack.tiks_amount, 0)} TIKS\n` +
      `  ${fmtHTG(priceHTG)} (≈ ${pack.price_usdt} USDT)\n\n` +
      `Vous serez redirigé vers MonCash pour payer.`
    );
    if (!confirmed) return;

    const btn = document.getElementById(`buyBtn_${pack.id}`);
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    try {
      const returnUrl = window.location.origin + window.location.pathname + '?tiks_return=1';
      const result = await callEdge({ action: 'create', pack_id: pack.id, return_url: returnUrl });
      if (!result?.redirect_url) throw new Error('Pas de lien de paiement reçu.');

      localStorage.setItem('tiks_pending_purchase', JSON.stringify({
        order_id: result.order_id, purchase_id: result.purchase_id,
        pack_id: pack.id, pack_name: pack.name, tiks_amount: pack.tiks_amount,
        price_usdt: pack.price_usdt, amount_gourdes: result.amount_gourdes, ts: Date.now(),
      }));

      window.location.href = result.redirect_url;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Acheter'; }
      alert(`Erreur lors de la création du paiement :\n${e?.message ?? e}`);
    }
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  RETRAIT                                                           */
  /* ══════════════════════════════════════════════════════════════════ */

  async function handleWithdraw(amountTiks, phone) {
    if (!_userId) _userId = await getUserId();
    if (!_userId) { alert('Session expirée. Veuillez vous reconnecter.'); return; }

    const amountHTG = Math.round(amountTiks / TIKS_PER_USDT * _htgRate * 100) / 100;
    const confirmed = window.confirm(
      `Confirmer le retrait ?\n\n` +
      `  ${fmt(amountTiks, 0)} TIKS\n` +
      `  ≈ ${fmtHTG(amountHTG)}\n` +
      `  Numéro MonCash : ${phone}\n\n` +
      `Cette action est irréversible.`
    );
    if (!confirmed) return;

    const submitBtn = document.getElementById('tiksWithdrawSubmit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Traitement…'; }

    try {
      const result = await callEdge({ action: 'withdraw', amount_tiks: amountTiks, phone });

      if (result?.ok) {
        const newBal = result.new_balance ?? 0;
        document.getElementById('tiksWithdrawSection').innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px 0;">
            <span style="font-size:40px;">✅</span>
            <div style="font-weight:700;font-size:16px;color:#16a34a;">Retrait initié avec succès</div>
            <div style="font-size:13px;color:#475569;text-align:center;">
              <strong>${fmt(amountTiks, 0)} TIKS</strong> débités.<br>
              Paiement MonCash en cours vers <strong>${phone}</strong>.
            </div>
            <div style="font-size:12px;color:#94a3b8;">Nouveau solde : ${fmt(newBal, 0)} TIKS</div>
          </div>`;
        /* Mettre à jour la carte solde sans re-render complet */
        try {
          const row = await fetchBalance(_userId);
          if (row) {
            const b = Number(row.balance ?? 0);
            const balEl  = document.getElementById('tiksBalance');
            const usdtEl = document.getElementById('tiksUsdt');
            if (balEl)  balEl.textContent  = fmt(b, 0);
            if (usdtEl) usdtEl.textContent = fmt(b / TIKS_PER_USDT, 4);
            const statEl = document.getElementById('statTiks');
            if (statEl) statEl.textContent = fmt(b, 0);
          }
        } catch (_) {}
      } else {
        throw new Error(result?.error ?? 'Retrait échoué');
      }
    } catch (e) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Confirmer le retrait'; }
      const msgDiv = document.getElementById('tiksWithdrawMsg');
      if (msgDiv) { msgDiv.textContent = `Erreur : ${e?.message ?? e}`; msgDiv.style.color = '#dc2626'; }
    }
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  HTML — SECTION RETRAIT                                            */
  /* ══════════════════════════════════════════════════════════════════ */

  function buildWithdrawSection(eligibility) {
    const { eligible, kycVerified, followerCount, balance, isAdmin } = eligibility;

    /* Checklist conditions */
    const condHtml = `
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;
                  padding:14px 16px;font-size:12px;color:#0369a1;line-height:1.8;">
        <div style="font-weight:700;margin-bottom:6px;font-size:13px;">📋 Conditions pour retirer des Tiks</div>
        <div style="${balance >= WITHDRAW_MIN_TIKS ? 'color:#16a34a' : 'color:#94a3b8'}">
          ${balance >= WITHDRAW_MIN_TIKS ? '✅' : '⬜'}&nbsp;
          Balance minimum <strong>${fmt(WITHDRAW_MIN_TIKS, 0)} TIKS</strong>
          ${balance < WITHDRAW_MIN_TIKS ? `&nbsp;<span style="font-size:11px;">(vous avez ${fmt(balance, 0)})</span>` : ''}
        </div>
        <div style="${followerCount >= WITHDRAW_MIN_FOLLOWERS ? 'color:#16a34a' : 'color:#94a3b8'}">
          ${followerCount >= WITHDRAW_MIN_FOLLOWERS ? '✅' : '⬜'}&nbsp;
          Au moins <strong>${WITHDRAW_MIN_FOLLOWERS} abonnés</strong>
          ${followerCount < WITHDRAW_MIN_FOLLOWERS ? `&nbsp;<span style="font-size:11px;">(vous en avez ${followerCount})</span>` : ''}
        </div>
        <div style="${kycVerified ? 'color:#16a34a' : 'color:#94a3b8'}">
          ${kycVerified ? '✅' : '⬜'}&nbsp;
          <strong>Identité vérifiée (KYC)</strong>
        </div>
      </div>`;

    const sectionHeader = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <div style="flex:1;height:1px;background:#e2e8f0;"></div>
        <div style="font-size:14px;font-weight:700;color:#475569;white-space:nowrap;">💸 Retirer des Tiks</div>
        <div style="flex:1;height:1px;background:#e2e8f0;"></div>
      </div>`;

    /* ── Cas éligible : formulaire ── */
    if (eligible) {
      return `
        <div id="tiksWithdrawSection">
          ${sectionHeader}
          ${condHtml}
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-top:14px;">
            <div style="margin-bottom:14px;">
              <label style="font-size:13px;font-weight:600;color:#475569;display:block;margin-bottom:6px;">
                Montant à retirer (TIKS)
              </label>
              <input id="tiksWithdrawAmount" type="number"
                min="${WITHDRAW_MIN_TIKS}" max="${Math.floor(balance)}" step="100"
                value="${WITHDRAW_MIN_TIKS}"
                style="width:100%;padding:10px 12px;border:1.5px solid #cbd5e1;border-radius:8px;
                       font-size:16px;font-weight:600;color:#1e293b;background:#fff;box-sizing:border-box;" />
              <div id="tiksWithdrawPreview" style="font-size:12px;color:#64748b;margin-top:5px;">
                ≈ ${fmtHTG(WITHDRAW_MIN_TIKS / TIKS_PER_USDT * _htgRate)}
              </div>
            </div>
            <div style="margin-bottom:14px;">
              <label style="font-size:13px;font-weight:600;color:#475569;display:block;margin-bottom:6px;">
                Numéro MonCash (ex : 50930000000)
              </label>
              <input id="tiksWithdrawPhone" type="tel" placeholder="50930000000"
                style="width:100%;padding:10px 12px;border:1.5px solid #cbd5e1;border-radius:8px;
                       font-size:15px;color:#1e293b;background:#fff;box-sizing:border-box;" />
            </div>
            <div id="tiksWithdrawMsg" style="font-size:12px;min-height:16px;margin-bottom:8px;color:#dc2626;"></div>
            <button id="tiksWithdrawSubmit"
              style="width:100%;padding:11px 0;border:none;border-radius:8px;
                     background:linear-gradient(135deg,#6366f1,#0ea5e9);color:#fff;
                     font-weight:700;font-size:15px;cursor:pointer;"
              onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'">
              Confirmer le retrait
            </button>
          </div>
        </div>`;
    }

    /* ── Bloc KYC : admin → consulter, utilisateur → remplir ── */
    const kycBlock = !kycVerified ? (() => {
      if (isAdmin) {
        /* L'administrateur voit un bouton "Consulter les KYC" */
        return `
          <div style="margin-top:14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;
                      padding:16px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;">
            <span style="font-size:28px;">🛡️</span>
            <div style="font-size:14px;font-weight:600;color:#1d4ed8;">Espace administrateur</div>
            <div style="font-size:12px;color:#1e40af;">
              Consultez et gérez les demandes de vérification d'identité des utilisateurs.
            </div>
            <a href="kyc.html"
               style="margin-top:4px;padding:10px 24px;border-radius:8px;background:#2563eb;
                      color:#fff;font-weight:700;font-size:14px;text-decoration:none;display:inline-block;">
              Consulter les KYC
            </a>
          </div>`;
      }
      /* Utilisateur normal → remplir son KYC */
      return `
        <div style="margin-top:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;
                    padding:16px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;">
          <span style="font-size:28px;">🪪</span>
          <div style="font-size:14px;font-weight:600;color:#92400e;">Vérification d'identité requise</div>
          <div style="font-size:12px;color:#78350f;">
            Complétez votre KYC pour pouvoir effectuer des retraits.<br>
            La vérification prend généralement moins de 24h.
          </div>
          <a href="kyc.html"
             style="margin-top:4px;padding:10px 24px;border-radius:8px;background:#f59e0b;
                    color:#fff;font-weight:700;font-size:14px;text-decoration:none;display:inline-block;">
            Remplir le KYC
          </a>
        </div>`;
    })() : '';

    return `
      <div id="tiksWithdrawSection">
        ${sectionHeader}
        ${condHtml}
        ${kycBlock}
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  CARDS PACKS                                                       */
  /* ══════════════════════════════════════════════════════════════════ */

  const PACK_ACCENTS = {
    Mini:     { bg: '#f1f5f9', border: '#cbd5e1', badge: null },
    Starter:  { bg: '#ecfdf5', border: '#6ee7b7', badge: '🟢 Démarrage' },
    Bronze:   { bg: '#fff7ed', border: '#fdba74', badge: '🥉 Bronze' },
    Silver:   { bg: '#f8fafc', border: '#94a3b8', badge: '🥈 Argent' },
    Gold:     { bg: '#fefce8', border: '#fde047', badge: '🥇 Or' },
    Platinum: { bg: '#f5f3ff', border: '#c4b5fd', badge: '💎 Platine' },
    Whale:    { bg: '#0f172a', border: '#7c3aed', badge: '🐳 Whale', dark: true },
  };

  function renderPackCard(pack, htgRate) {
    const priceHTG  = Math.round(Number(pack.price_usdt) * htgRate * 100) / 100;
    const totalTiks = Number(pack.tiks_amount) + Number(pack.bonus_tiks ?? 0);
    const accent    = PACK_ACCENTS[pack.name] ?? { bg: '#f8fafc', border: '#e2e8f0', badge: null };
    const isDark    = accent.dark ?? false;
    const textColor = isDark ? '#f1f5f9' : '#1e293b';
    const subColor  = isDark ? '#94a3b8' : '#64748b';

    return `
    <div style="background:${accent.bg};border:2px solid ${accent.border};border-radius:14px;
                padding:18px 16px;display:flex;flex-direction:column;gap:8px;position:relative;
                transition:transform .15s;"
         onmouseover="this.style.transform='translateY(-2px)'"
         onmouseout="this.style.transform='translateY(0)'">
      ${accent.badge ? `<div style="position:absolute;top:-10px;right:12px;background:${accent.border};
          color:${isDark ? '#0f172a' : '#334155'};font-size:10px;font-weight:700;
          padding:2px 8px;border-radius:20px;white-space:nowrap;">${accent.badge}</div>` : ''}
      <div style="font-size:16px;font-weight:700;color:${textColor};">${pack.name}</div>
      ${pack.description ? `<div style="font-size:12px;color:${subColor};">${pack.description}</div>` : ''}
      <div style="margin:4px 0;">
        <span style="font-size:26px;font-weight:800;color:${isDark ? '#a78bfa' : '#6366f1'};">
          ${fmt(totalTiks, 0)}
        </span>
        <span style="font-size:13px;font-weight:600;color:${subColor};margin-left:4px;">TIKS</span>
        ${Number(pack.bonus_tiks) > 0 ? `<div style="font-size:11px;color:#16a34a;margin-top:2px;">+${fmt(pack.bonus_tiks, 0)} bonus</div>` : ''}
      </div>
      <div style="background:rgba(0,0,0,0.04);border-radius:8px;padding:8px 10px;margin-top:2px;">
        <div style="font-size:18px;font-weight:700;color:${textColor};">${fmtHTG(priceHTG)}</div>
        <div style="font-size:11px;color:${subColor};margin-top:1px;">
          ≈ ${pack.price_usdt} USDT &nbsp;|&nbsp; taux : ${fmt(htgRate, 2)} HTG/USD
        </div>
      </div>
      <button id="buyBtn_${pack.id}"
        style="margin-top:4px;padding:9px 0;border:none;border-radius:8px;
               background:${isDark ? '#7c3aed' : '#0ea5e9'};color:#fff;
               font-weight:700;font-size:14px;cursor:pointer;width:100%;"
        onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'">
        Acheter via MonCash
      </button>
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  RENDU PRINCIPAL                                                   */
  /* ══════════════════════════════════════════════════════════════════ */

  async function renderTiksPanel(isRefresh = false) {
    if (!_panelActive) return;

    if (!_userId) _userId = await getUserId();
    placeholderTitle.textContent = 'Tiks';

    if (!_userId) {
      placeholderText.innerHTML =
        '<p class="text-slate-500 text-sm mt-2">Connectez-vous pour consulter votre solde Tiks.</p>';
      return;
    }

    const [row, packs, htgRate, eligibility] = await Promise.all([
      fetchBalance(_userId),
      fetchPacks(),
      fetchHTGRate(),
      fetchWithdrawEligibility(_userId),
    ]);
    _htgRate = htgRate;

    const balance   = Number(row?.balance   ?? 0);
    const usdtValue = row?.usdt_value != null ? Number(row.usdt_value) : balance / TIKS_PER_USDT;
    const currency  = row?.currency ?? 'TIKS';
    const updatedAt = row?.updated_at
      ? new Date(row.updated_at).toLocaleString('fr-FR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '—';

    const refreshBadge = isRefresh
      ? `<span title="Actualisé" style="display:inline-block;width:7px;height:7px;
           border-radius:50%;background:#22c55e;margin-left:6px;vertical-align:middle;"></span>`
      : '';

    const packsHtml = packs.length === 0
      ? `<p style="color:#94a3b8;font-size:13px;text-align:center;padding:12px 0;">Aucun pack disponible.</p>`
      : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;">
           ${packs.map(p => renderPackCard(p, htgRate)).join('')}
         </div>`;

    placeholderText.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:20px;margin-top:8px;">

      <!-- Carte solde -->
      <div style="background:linear-gradient(135deg,#0ea5e9 0%,#6366f1 100%);
                  border-radius:16px;padding:24px 28px;color:#fff;
                  box-shadow:0 8px 24px rgba(99,102,241,.18);position:relative;overflow:hidden;">
        <div style="font-size:12px;opacity:.85;letter-spacing:.06em;text-transform:uppercase;font-weight:600;">
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
                    font-size:80px;opacity:.06;pointer-events:none;user-select:none;">🪙</div>
      </div>

      <!-- Infos secondaires -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;">
          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px;">Balance TIKS</div>
          <div style="font-size:22px;font-weight:700;color:#1e293b;">${fmt(balance, 2)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">${currency}</div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;">
          <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px;">Équivalent USDT</div>
          <div style="font-size:22px;font-weight:700;color:#1e293b;">${fmt(usdtValue, 6)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">USDT</div>
        </div>
      </div>

      <!-- Section retrait -->
      ${buildWithdrawSection({ ...eligibility, balance })}

      <!-- Séparateur packs -->
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="flex:1;height:1px;background:#e2e8f0;"></div>
        <div style="font-size:14px;font-weight:700;color:#475569;white-space:nowrap;">🛒 Acheter des Tiks</div>
        <div style="flex:1;height:1px;background:#e2e8f0;"></div>
      </div>

      <div style="font-size:12px;color:#94a3b8;text-align:right;margin-top:-10px;">
        Taux du jour : <strong>1 USD = ${fmt(htgRate, 2)} HTG</strong>
        &nbsp;·&nbsp; Paiement via MonCash
      </div>

      ${packsHtml}

      <p style="font-size:12px;color:#94a3b8;text-align:right;">
        <i class="fa-solid fa-rotate" style="margin-right:4px;"></i>
        Actualisation automatique toutes les ${POLL_MS / 1000}s.
      </p>

    </div>`;

    /* ── Handlers boutons pack ── */
    packs.forEach(pack => {
      document.getElementById(`buyBtn_${pack.id}`)
        ?.addEventListener('click', () => handleBuyPack(pack));
    });

    /* ── Handlers retrait (si formulaire présent) ── */
    if (eligibility.eligible) {
      const amountInput = document.getElementById('tiksWithdrawAmount');
      const previewDiv  = document.getElementById('tiksWithdrawPreview');
      const submitBtn   = document.getElementById('tiksWithdrawSubmit');
      const msgDiv      = document.getElementById('tiksWithdrawMsg');

      amountInput?.addEventListener('input', () => {
        const v = Number(amountInput.value) || 0;
        if (previewDiv) previewDiv.textContent = `≈ ${fmtHTG(v / TIKS_PER_USDT * _htgRate)}`;
      });

      submitBtn?.addEventListener('click', () => {
        const amountTiks = Number(amountInput?.value ?? 0);
        const phone      = document.getElementById('tiksWithdrawPhone')?.value?.trim() ?? '';
        if (msgDiv) msgDiv.textContent = '';

        if (!amountTiks || amountTiks < WITHDRAW_MIN_TIKS) {
          if (msgDiv) { msgDiv.textContent = `Montant minimum : ${fmt(WITHDRAW_MIN_TIKS, 0)} TIKS`; msgDiv.style.color = '#dc2626'; }
          return;
        }
        if (amountTiks > balance) {
          if (msgDiv) { msgDiv.textContent = 'Montant supérieur à votre balance'; msgDiv.style.color = '#dc2626'; }
          return;
        }
        if (!phone || phone.length < 8) {
          if (msgDiv) { msgDiv.textContent = 'Numéro MonCash invalide'; msgDiv.style.color = '#dc2626'; }
          return;
        }
        handleWithdraw(amountTiks, phone).catch(e => {
          if (msgDiv) { msgDiv.textContent = `Erreur : ${e?.message ?? e}`; msgDiv.style.color = '#dc2626'; }
        });
      });
    }

    /* statTiks home */
    try {
      const statEl = document.getElementById('statTiks');
      if (statEl) statEl.textContent = fmt(balance, 0);
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  POLLING                                                           */
  /* ══════════════════════════════════════════════════════════════════ */

  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(async () => {
      try { await renderTiksPanel(true); } catch (e) { console.warn('tiks poll error', e); }
    }, POLL_MS);
  }
  function stopPolling() {
    if (_pollTimer != null) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  PANEL SHOW / HIDE                                                 */
  /* ══════════════════════════════════════════════════════════════════ */

  function showPanel(skipInitialFetch = false) {
    _panelActive = true;
    homePanel?.classList.add('hidden');
    profilePanel?.classList.add('hidden');
    placeholderPanel?.classList.remove('hidden');

    if (!skipInitialFetch) {
      placeholderTitle.textContent = 'Tiks';
      placeholderText.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-top:12px;color:#94a3b8;">
          ${spinner()} Chargement du solde et des packs…
        </div>`;
      renderTiksPanel(false).catch(e => console.warn('tiks renderTiksPanel error', e));
    }
    startPolling();
  }
  function hidePanel() {
    _panelActive = false;
    stopPolling();
  }

  /* ══════════════════════════════════════════════════════════════════ */
  /*  MENU HANDLER                                                      */
  /* ══════════════════════════════════════════════════════════════════ */

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

  ['menuHome','menuStats','menuGames','menuNotifications',
   'menuTx','menuMingots','menuProfile'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      if (_panelActive) hidePanel();
    });
  });

  window.addEventListener('pagehide', stopPolling);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPolling();
    else if (_panelActive) startPolling();
  });

  /* ══════════════════════════════════════════════════════════════════ */
  /*  INIT                                                              */
  /* ══════════════════════════════════════════════════════════════════ */

  (async () => {
    try {
      const uid = await getUserId();
      if (!uid) return;
      const row = await fetchBalance(uid);
      const statEl = document.getElementById('statTiks');
      if (statEl && row) statEl.textContent = fmt(Number(row.balance ?? 0), 0);
    } catch (_) {}
  })();

  if (window.location.search.includes('tiks_return')) {
    await checkMonCashReturn();
  }

  supabase?.auth?.onAuthStateChange?.((event, session) => {
    _userId       = session?.user?.id ?? null;
    _sessionToken = session?.access_token ?? null;
    if (_panelActive) renderTiksPanel(true).catch(() => {});
    if (_userId) {
      fetchBalance(_userId).then(row => {
        const statEl = document.getElementById('statTiks');
        if (statEl && row) statEl.textContent = fmt(Number(row.balance ?? 0), 0);
      }).catch(() => {});
    }
  });

})();
