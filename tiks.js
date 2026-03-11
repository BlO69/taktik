// tiks.js
// Affiche la balance TIKS et l'équivalent USDT (usdt_value) pour l'utilisateur courant.
// Utilise polling (pas de realtime) — compatible avec le plan gratuit Supabase.
// Usage: <script type="module" src="./tiks.js"></script>
//
// Attendu : supabaseClient.js exportant `supabase` (optionnel) ou window.supabase présent.
// Cherche un conteneur existant (#tiksBalance ou .tiks-balance) sinon injecte un petit widget UI.
// Poll interval par défaut : 15s (paramétrable en variable POLL_INTERVAL_MS).

const dbg = false;
function dbgLog(...args) { if (dbg) console.log('[tiks.js]', ...args); }

const POLL_INTERVAL_MS = 15_000; // 15s default
const POLL_BACKOFF_MAX_MS = 5 * 60_000; // 5 minutes on repeated errors

// ---------------------- supabase helper ----------------------
async function getSupabase() {
  try {
    const mod = await import('./supabaseClient.js');
    if (mod && mod.supabase) {
      dbgLog('getSupabase: imported module');
      return mod.supabase;
    }
  } catch (e) {
    dbgLog('getSupabase import failed', e && e.message ? e.message : e);
  }
  if (typeof window !== 'undefined' && window.supabase) {
    dbgLog('getSupabase: using window.supabase');
    return window.supabase;
  }
  throw new Error('Supabase client introuvable. Ajoute supabaseClient.js ou expose window.supabase.');
}

// ---------------------- DOM helpers ----------------------
function formatTiks(nStr) {
  // nStr may be numeric string from Postgres (e.g. "1234.000000")
  if (nStr == null) return '0';
  const v = Number(nStr);
  if (Number.isNaN(v)) return nStr;
  // show up to 6 fractional digits for tiks (table uses numeric(20,6))
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}
function formatUsdt(nStr) {
  if (nStr == null) return '0';
  const v = Number(nStr);
  if (Number.isNaN(v)) return nStr;
  // usdt_value stored as numeric(18,8) — show up to 8 decimals, but hide trailing zeros nicely
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 8 });
}

function createWidget() {
  // If page already has #tiksBalance or .tiks-balance, use that (no injection)
  let el = document.getElementById('tiksBalance') || document.querySelector('.tiks-balance');
  if (el) {
    // ensure it has the right children
    if (!el.querySelector('.tiks-value')) {
      el.innerHTML = `
        <div style="display:flex; flex-direction:row; gap:8px; align-items:center;">
          <div style="min-width:12ch;">
            <div class="tiks-value" style="font-weight:700;">-- TIKS</div>
            <div class="usdt-value" style="font-size:0.85em; opacity:0.85;">-- USDT</div>
          </div>
          <button class="tiks-refresh" style="padding:6px 8px;border-radius:8px;border:1px solid rgba(0,0,0,0.06);background:#fff;cursor:pointer;">⟳</button>
        </div>`;
    }
    return el;
  }

  // Otherwise create floating widget bottom-right
  const wrapper = document.createElement('div');
  wrapper.id = 'tiksBalance';
  wrapper.className = 'tiks-balance-widget';
  wrapper.setAttribute('aria-live', 'polite');
  wrapper.style.cssText = `
    position:fixed; right:18px; bottom:18px; z-index:99999;
    background: linear-gradient(180deg, #0f1724, #071024);
    color: #e6eef8; padding:10px 12px; border-radius:12px; box-shadow:0 8px 28px rgba(2,6,23,0.6);
    font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
    border: 1px solid rgba(255,255,255,0.04);
    min-width:160px;
  `;
  wrapper.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <div style="flex:1;">
        <div class="tiks-value" style="font-weight:700; font-size:15px;">-- TIKS</div>
        <div class="usdt-value" style="font-size:12px; opacity:0.85;">-- USDT</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
        <button class="tiks-refresh" title="Rafraîchir" style="padding:6px;border-radius:8px;border:none;background:#10b981;color:#fff;cursor:pointer;">⟳</button>
        <button class="tiks-open" title="Ouvrir portefeuille" style="padding:4px 6px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:#cfece6;cursor:pointer;font-size:12px;">Portefeuille</button>
      </div>
    </div>
    <div class="tiks-msg" style="font-size:11px; margin-top:8px; color:#99a3b3; display:block;"></div>
  `;
  document.body.appendChild(wrapper);
  return wrapper;
}

// ---------------------- Core logic ----------------------
export async function startTiksWidget(opts = {}) {
  const supabase = await getSupabase();
  const pollInterval = (opts.pollIntervalMs || POLL_INTERVAL_MS);
  let currentInterval = pollInterval;
  let pollTimer = null;
  let running = false;
  let lastProfileId = null;

  const container = createWidget();
  const valueEl = container.querySelector('.tiks-value');
  const usdtEl = container.querySelector('.usdt-value');
  const msgEl = container.querySelector('.tiks-msg');
  const refreshBtn = container.querySelector('.tiks-refresh');
  const openBtn = container.querySelector('.tiks-open');

  function setMsg(text, isError = false) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.style.color = isError ? '#ff8b8b' : '#99a3b3';
  }

  async function fetchProfileIdForAuthUser(user) {
    if (!user) return null;
    try {
      const q = supabase.from('user_profiles').select('id').eq('user_id', user.id).limit(1).maybeSingle();
      const { data, error } = await q;
      if (error) {
        dbgLog('fetchProfileId - error', error);
        return null;
      }
      if (!data) return null;
      return data.id;
    } catch (e) {
      dbgLog('fetchProfileId exception', e);
      return null;
    }
  }

  async function fetchBalanceByProfileId(profileId) {
    if (!profileId) return null;
    try {
      const { data, error } = await supabase
        .from('tiks_balances')
        .select('balance, usdt_value, updated_at')
        .eq('user_id', profileId)
        .limit(1)
        .maybeSingle();
      if (error) {
        dbgLog('fetchBalance - error', error);
        throw error;
      }
      return data || null;
    } catch (e) {
      dbgLog('fetchBalance exception', e);
      throw e;
    }
  }

  async function updateOnce() {
    try {
      setMsg('Chargement…');
      const sessionRes = await supabase.auth.getSession();
      const session = sessionRes?.data?.session ?? null;
      const user = session?.user ?? null;
      if (!user) {
        // not logged in
        valueEl.textContent = '-- TIKS';
        usdtEl.textContent = '-- USDT';
        setMsg('Connecte-toi pour voir ton solde');
        lastProfileId = null;
        return;
      }

      // get profile id (user_profiles.id) linked to auth user
      let profileId = await fetchProfileIdForAuthUser(user);
      if (!profileId) {
        // no profile yet (ensureProfile might ask pseudo) — show message
        valueEl.textContent = '0 TIKS';
        usdtEl.textContent = '0 USDT';
        setMsg('Profil manquant — complète ton pseudo');
        lastProfileId = null;
        return;
      }

      // if profile changed or first time, reset small backoff
      if (profileId !== lastProfileId) {
        currentInterval = pollInterval;
        lastProfileId = profileId;
        dbgLog('profileId changed ->', profileId);
      }

      const bal = await fetchBalanceByProfileId(profileId);
      if (!bal) {
        valueEl.textContent = '0 TIKS';
        usdtEl.textContent = '0 USDT';
        setMsg('Aucun compte TIKS — initialisation automatique possible');
        return;
      }

      const b = formatTiks(bal.balance);
      const u = formatUsdt(bal.usdt_value ?? (Number(bal.balance || 0) / 200));
      valueEl.textContent = `${b} TIKS`;
      usdtEl.textContent = `${u} USDT`;
      setMsg(`Mis à jour: ${bal.updated_at ? new Date(bal.updated_at).toLocaleString() : '—'}`, false);

      // success -> reset backoff
      currentInterval = pollInterval;
    } catch (err) {
      dbgLog('updateOnce error', err && err.message ? err.message : err);
      setMsg('Erreur récupération solde — réessaye', true);
      // exponential backoff (capped)
      currentInterval = Math.min(currentInterval * 2, POLL_BACKOFF_MAX_MS);
    } finally {
      // schedule next poll if still running
      if (running) scheduleNext();
    }
  }

  function scheduleNext() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      // only poll if page is visible
      if (document.hidden) {
        dbgLog('document hidden: skipping poll, will reschedule');
        scheduleNext();
        return;
      }
      updateOnce();
    }, currentInterval);
    dbgLog('next poll in ms', currentInterval);
  }

  function start() {
    if (running) return;
    running = true;
    currentInterval = pollInterval;
    updateOnce(); // immediate
    // resume when visible
    document.addEventListener('visibilitychange', handleVisibility);
  }

  function stop() {
    running = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    document.removeEventListener('visibilitychange', handleVisibility);
  }

  function handleVisibility() {
    if (!running) return;
    if (!document.hidden) {
      // immediate refresh on become visible
      dbgLog('visible -> refresh');
      currentInterval = pollInterval;
      updateOnce();
    }
  }

  // manual refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (!running) start();
      // immediate update
      currentInterval = pollInterval;
      updateOnce();
    });
  }

  if (openBtn) {
    openBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      // heuristic: try open /wallet or /profile path if present; fallback to '#'
      const candidates = ['/wallet', '/profile', '/account', '/balance'];
      const found = candidates.find(p => {
        try { return !!document.querySelector(`a[href="${p}"], a[href^="${p}#"]`); } catch (e) { return false; }
      });
      if (found) {
        window.location.href = found;
        return;
      }
      // fallback: focus the widget (no-op); or open auth modal if not logged
      // try to trigger global openAuthModal if available
      if (typeof window.openAuthModal === 'function') {
        window.openAuthModal();
      } else {
        // nothing known: show message
        setMsg('Ouvre ton portefeuille depuis la page Profil.', false);
      }
    });
  }

  // watch auth changes to start/stop polling accordingly
  try {
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      dbgLog('auth state changed', event);
      if (session?.user) {
        start();
      } else {
        // no user: stop and clear UI
        stop();
        valueEl.textContent = '-- TIKS';
        usdtEl.textContent = '-- USDT';
        setMsg('Connecte-toi pour voir ton solde');
      }
    });
    // start immediately if logged in
    (async () => {
      const s = await supabase.auth.getSession();
      const u = s?.data?.session?.user ?? null;
      if (u) start();
    })();

    // cleanup on unload (optional)
    window.addEventListener('beforeunload', () => {
      try { listener?.unsubscribe?.(); } catch (e) {}
      stop();
    });
  } catch (e) {
    dbgLog('auth listener setup failed', e);
    // Still start polling once (best effort)
    start();
  }

  return {
    start, stop
  };
}

// Auto-start when loaded as module in browser
if (typeof window !== 'undefined') {
  // Delay a bit for supabaseClient to be available in case of bundling order
  setTimeout(() => {
    startTiksWidget().catch(err => {
      console.error('tiks widget failed to start', err);
    });
  }, 50);
}
