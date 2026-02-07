// auth.js
// Module to handle auth modal (email/password + Google) and user_profiles pseudo flow
// Compatible with index.html (searches for #loginFooterBtn and listens for event taktik:open-auth-modal)
// Usage: <script type="module" src="./auth.js"></script>

// === DEBUG FLAG ===
const dbg = true;
function dbgAlert(label, obj) {
  if (!dbg) return;
  try {
    const safe = JSON.stringify(obj, (k, v) => {
      if (!k) return v;
      if (/access|refresh|token|secret|password|credentials|session/i.test(k)) return '[REDACTED]';
      return v;
    }, 2);
    console.info(`${label}:\n`, safe);
  } catch (e) {
    try { console.info(`${label}: ${String(obj)}`); } catch (e2) { /* ignore */ }
  }
}

const DEFAULT_REDIRECT = 'index.html';

// Prefer local supabaseClient.js export, else window.supabase if present
async function getSupabase() {
  try {
    const mod = await import('./supabaseClient.js');
    if (mod && mod.supabase) {
      dbgAlert('getSupabase - imported module', { hasSupabase: true });
      return mod.supabase;
    }
  } catch (e) {
    dbgAlert('getSupabase import failed', { error: String(e) });
  }
  if (typeof window !== 'undefined' && window.supabase) {
    dbgAlert('getSupabase - window.supabase used', { origin: window.location.origin });
    return window.supabase;
  }
  throw new Error('Supabase client introuvable. Ajoute supabaseClient.js ou expose window.supabase.');
}

function getReturnTo() {
  const url = new URL(window.location.href);
  const p = url.searchParams.get('redirectTo') || url.searchParams.get('returnTo');

  const normalizeTarget = (raw) => {
    if (!raw) return null;
    try {
      const t = new URL(raw, window.location.origin);
      const pathname = t.pathname || '';
      const lowerPath = (pathname || '').toLowerCase();
      if (lowerPath.includes('login') || lowerPath.includes('signin')) {
         return DEFAULT_REDIRECT;
      }
      if (t.origin === window.location.origin) return pathname + t.search + t.hash;
    } catch (e) {
      if (/login|signin/i.test(raw)) return DEFAULT_REDIRECT;
      return raw;
    }
    return DEFAULT_REDIRECT;
  };

  const normalizedFromQuery = normalizeTarget(p);
  if (normalizedFromQuery) return normalizedFromQuery;

  try {
    const ref = document.referrer;
    const normalizedFromRef = normalizeTarget(ref);
    if (normalizedFromRef) return normalizedFromRef;
  } catch (e) { /* ignore */ }

  return DEFAULT_REDIRECT;
}

function showMessage(el, msg, isError = false) {
  if (!el) { alert(msg); return; }
  el.textContent = msg;
  el.style.color = isError ? '#ff6666' : '';
}

/* -------------------------
   PSEUDO / PROFILE MANAGEMENT
   ------------------------- */
// Re-using/create pseudo modal used after login if user_profiles.pseudo missing.
function createPseudoModal() {
  const overlay = document.createElement('div');
  overlay.id = 'pseudoModalOverlay';
  overlay.style = `
    position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
    background:rgba(2,6,23,0.6); z-index:99999; padding:20px;
  `;

  const box = document.createElement('div');
  box.style = `
    width:100%; max-width:420px; background:linear-gradient(180deg,#0b0b0b,#101016);
    border:1px solid rgba(255,255,255,0.04); color:#eee; border-radius:12px; padding:18px;
    box-shadow:0 8px 30px rgba(2,6,23,0.6); font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;
  `;

  box.innerHTML = `
    <h3 style="margin:0 0 8px 0; font-size:18px;">Bienvenue — choisis ton pseudo</h3>
    <p style="margin:0 0 12px 0; color: #b9b9c6; font-size:13px;">Ton pseudo est unique et visible publiquement.</p>
    <label style="display:block; font-size:13px; color:#cfcfe6; margin-bottom:6px;">Pseudo</label>
    <input id="pseudoInput" type="text" maxlength="32" placeholder="ex: ton_pseudo" style="width:100%; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.06); background:#0f1116; color:#fff; box-sizing:border-box;" />
    <div id="pseudoMsg" style="height:18px; margin-top:8px; font-size:13px; color:#f0f0f0;"></div>
    <div style="display:flex; gap:8px; margin-top:14px; justify-content:flex-end;">
      <button id="pseudoCancel" style="padding:8px 12px; border-radius:8px; background:transparent; border:1px solid rgba(255,255,255,0.06); color:#ddd;">Annuler</button>
      <button id="pseudoSave" style="padding:8px 12px; border-radius:8px; background:#ff4fa3; border:none; color:#000; font-weight:600;">Sauvegarder</button>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const input = box.querySelector('#pseudoInput');
  const msg = box.querySelector('#pseudoMsg');
  const btnCancel = box.querySelector('#pseudoCancel');
  const btnSave = box.querySelector('#pseudoSave');

  return {
    overlay, input, msg, btnCancel, btnSave,
    close() { overlay.remove(); }
  };
}

function sanitizePseudo(s) {
  if (!s) return '';
  return s.trim();
}
function isPseudoValid(s) {
  if (!s) return false;
  return s.length >= 3 && s.length <= 32 && /^[\w.-]+$/.test(s);
}

async function ensureProfile(supabase, user) {
  if (!user) return;

  try {
    const { data: profile, error: selErr } = await supabase
      .from('user_profiles')
      .select('id,pseudo,user_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    dbgAlert('ensureProfile - select user_profiles', { profile, selErr });

    if (selErr) {
      console.warn('Erreur lecture user_profiles', selErr);
    } else if (profile && profile.pseudo) {
      if (!user.user_metadata?.username) {
        try { await supabase.auth.updateUser({ data: { username: profile.pseudo } }); } catch (e) { dbgAlert('ensureProfile - updateUser failed', String(e)); }
      }
      return;
    }
  } catch (e) {
    console.warn('Erreur verification profile', e);
    dbgAlert('ensureProfile - select exception', String(e));
  }

  // No pseudo -> show modal
  const modal = createPseudoModal();
  modal.input.focus();

  const stop = () => {
    try { modal.close(); } catch (e) {}
  };

  modal.btnCancel.addEventListener('click', () => {
    stop();
    const ret = getReturnTo();
    location.href = ret;
  });

  modal.btnSave.addEventListener('click', async () => {
    const raw = sanitizePseudo(modal.input.value);
    if (!isPseudoValid(raw)) {
      showMessage(modal.msg, 'Pseudo invalide — 3–32 caractères (lettres, chiffres, _ . -).', true);
      return;
    }

    modal.btnSave.disabled = true;
    const prevSaveText = modal.btnSave.textContent;
    modal.btnSave.textContent = 'Enregistrement...';
    showMessage(modal.msg, 'Vérification...', false);

    try {
      // Try upsert on user_id (atomic-ish)
      const { data: upsertData, error: upsertErr } = await supabase
        .from('user_profiles')
        .upsert({ user_id: user.id, pseudo: raw }, { onConflict: 'user_id', returning: 'minimal' });

      dbgAlert('ensureProfile - upsert profile', { upsertData, upsertErr });

      if (!upsertErr) {
        try { await supabase.auth.updateUser({ data: { username: raw } }); } catch (e) { dbgAlert('ensureProfile - updateUser after upsert error', String(e)); }
        showMessage(modal.msg, 'Pseudo enregistré — redirection...', false);
        setTimeout(() => { stop(); location.href = getReturnTo(); }, 300);
        return;
      }

      const errMsg = upsertErr?.message || '';
      const errDetails = upsertErr?.details || '';
      const isPgUnique = upsertErr?.code === '23505' || /duplicate key|unique constraint/i.test(errMsg + ' ' + errDetails) || /23505/.test(errMsg);

      if (isPgUnique && (errDetails.includes('user_profiles_pseudo_unique') || /pseudo/i.test(errMsg + errDetails))) {
        showMessage(modal.msg, 'Ce pseudo est déjà pris — choisis-en un autre.', true);
        modal.btnSave.disabled = false;
        modal.btnSave.textContent = prevSaveText;
        return;
      }

      if (isPgUnique && (errDetails.includes('user_profiles_user_id') || /user_id/i.test(errMsg + errDetails))) {
        const { data: updAfter, error: updAfterErr } = await supabase
          .from('user_profiles')
          .update({ pseudo: raw })
          .eq('user_id', user.id)
          .select('id,pseudo,user_id')
          .maybeSingle();

        dbgAlert('ensureProfile - update after upsert duplicate', { updAfter, updAfterErr });

        if (updAfter && updAfter.id) {
          try { await supabase.auth.updateUser({ data: { username: raw } }); } catch (e) { dbgAlert('ensureProfile - updateUser after retry error', String(e)); }
          showMessage(modal.msg, 'Pseudo enregistré — redirection...', false);
          setTimeout(() => { stop(); location.href = getReturnTo(); }, 300);
          return;
        }
      }

      showMessage(modal.msg, 'Échec enregistrement — réessaye.', true);
      modal.btnSave.disabled = false;
      modal.btnSave.textContent = prevSaveText;
      return;
    } catch (e) {
      console.error('Erreur during pseudo save', e);
      dbgAlert('ensureProfile - unexpected error', String(e));
      showMessage(modal.msg, 'Erreur inattendue — réessaye.', true);
      modal.btnSave.disabled = false;
      modal.btnSave.textContent = prevSaveText;
    }
  });

  modal.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') modal.btnSave.click();
  });
}

/* -------------------------
   AUTH MODAL (LOGIN / SIGNUP / GOOGLE)
   ------------------------- */
function createAuthModal() {
  // Build DOM overlay + box
  const overlay = document.createElement('div');
  overlay.id = 'authModalOverlay';
  overlay.style = `
    position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
    background:rgba(0,0,0,0.55); z-index:99998; padding:20px;
  `;

  const box = document.createElement('div');
  box.style = `
    width:100%; max-width:520px; background:#fff; color:#0b1220; border-radius:12px; padding:18px;
    box-shadow:0 10px 40px rgba(2,6,23,0.3); font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;
  `;

  box.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
      <h2 style="margin:0; font-size:18px;">Se connecter / Créer un compte</h2>
      <button id="authClose" aria-label="Fermer" style="background:transparent;border:none;font-size:18px;cursor:pointer;">✕</button>
    </div>

    <div style="margin-top:12px; display:flex; gap:8px;">
      <button id="tabLogin" style="flex:1; padding:8px; border-radius:8px; border:1px solid #e6e9ee; background:#f7f9fc; cursor:pointer;">Connexion</button>
      <button id="tabSignup" style="flex:1; padding:8px; border-radius:8px; border:1px solid #e6e9ee; background:#fff; cursor:pointer;">Inscription</button>
    </div>

    <div id="authContent" style="margin-top:14px;">
      <!-- login form -->
      <div id="loginPane">
        <label style="display:block; font-size:13px; color:#334155;">Email</label>
        <input id="loginEmail" type="email" placeholder="you@example.com" style="width:100%; padding:10px; border-radius:8px; border:1px solid #e6e9ee; margin-top:6px;" />
        <label style="display:block; font-size:13px; color:#334155; margin-top:10px;">Mot de passe</label>
        <input id="loginPass" type="password" placeholder="Mot de passe" style="width:100%; padding:10px; border-radius:8px; border:1px solid #e6e9ee; margin-top:6px;" />
        <div id="loginMsg" style="height:18px; margin-top:8px; font-size:13px; color:#ef4444;"></div>
        <div style="margin-top:12px; display:flex; gap:8px;">
          <button id="loginBtn" style="flex:1; padding:10px; border-radius:8px; background:#0ea5e9; color:#fff; border:none; font-weight:600; cursor:pointer;">Se connecter</button>
          <button id="googleLoginBtn" style="flex:0 0 48px; border-radius:8px; border:1px solid #e6e9ee; background:#fff; cursor:pointer;" title="Se connecter avec Google">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style="width:20px;height:20px;display:block;margin:auto;" />
          </button>
        </div>
      </div>

      <!-- signup form (hidden by default) -->
      <div id="signupPane" style="display:none;">
        <label style="display:block; font-size:13px; color:#334155;">Email</label>
        <input id="signupEmail" type="email" placeholder="you@example.com" style="width:100%; padding:10px; border-radius:8px; border:1px solid #e6e9ee; margin-top:6px;" />
        <label style="display:block; font-size:13px; color:#334155; margin-top:10px;">Mot de passe</label>
        <input id="signupPass" type="password" placeholder="Mot de passe (min 6)" style="width:100%; padding:10px; border-radius:8px; border:1px solid #e6e9ee; margin-top:6px;" />
        <div id="signupMsg" style="height:18px; margin-top:8px; font-size:13px; color:#ef4444;"></div>
        <div style="margin-top:12px; display:flex; gap:8px;">
          <button id="signupBtn" style="flex:1; padding:10px; border-radius:8px; background:#10b981; color:#fff; border:none; font-weight:600; cursor:pointer;">Créer un compte</button>
          <button id="googleSignupBtn" style="flex:0 0 48px; border-radius:8px; border:1px solid #e6e9ee; background:#fff; cursor:pointer;" title="S'inscrire avec Google">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style="width:20px;height:20px;display:block;margin:auto;" />
          </button>
        </div>
      </div>
    </div>

    <div style="margin-top:10px; font-size:12px; color:#64748b;">
      En utilisant Google, tu seras redirigé vers la page d'authentification. Après connexion tu reviendras ici.
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  return {
    overlay,
    box,
    // panes & controls
    tabLogin: box.querySelector('#tabLogin'),
    tabSignup: box.querySelector('#tabSignup'),
    loginPane: box.querySelector('#loginPane'),
    signupPane: box.querySelector('#signupPane'),
    loginEmail: box.querySelector('#loginEmail'),
    loginPass: box.querySelector('#loginPass'),
    loginBtn: box.querySelector('#loginBtn'),
    loginMsg: box.querySelector('#loginMsg'),
    signupEmail: box.querySelector('#signupEmail'),
    signupPass: box.querySelector('#signupPass'),
    signupBtn: box.querySelector('#signupBtn'),
    signupMsg: box.querySelector('#signupMsg'),
    googleLoginBtn: box.querySelector('#googleLoginBtn'),
    googleSignupBtn: box.querySelector('#googleSignupBtn'),
    closeBtn: box.querySelector('#authClose'),
    close() { overlay.remove(); }
  };
}

function wireAuthModal(supabase, modal) {
  // tab switches
  function showLoginTab() {
    modal.loginPane.style.display = '';
    modal.signupPane.style.display = 'none';
    modal.tabLogin.style.background = '#f7f9fc';
    modal.tabSignup.style.background = '#fff';
  }
  function showSignupTab() {
    modal.loginPane.style.display = 'none';
    modal.signupPane.style.display = '';
    modal.tabLogin.style.background = '#fff';
    modal.tabSignup.style.background = '#f7f9fc';
  }

  modal.tabLogin.addEventListener('click', showLoginTab);
  modal.tabSignup.addEventListener('click', showSignupTab);
  modal.closeBtn.addEventListener('click', () => modal.close());
  modal.overlay.addEventListener('click', (ev) => {
    if (ev.target === modal.overlay) modal.close();
  });

  // helper inline error
  function showInline(msgEl, msg, isErr = true) {
    if (!msgEl) { if (isErr) alert(msg); else console.info(msg); return; }
    msgEl.textContent = msg;
    msgEl.style.color = isErr ? '#ef4444' : '#0f766e';
  }

  // LOGIN with email/password
  modal.loginBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const email = modal.loginEmail.value?.trim();
    const password = modal.loginPass.value ?? '';
    if (!email || !password) { showInline(modal.loginMsg, 'Email et mot de passe requis.'); return; }

    modal.loginBtn.disabled = true;
    const prev = modal.loginBtn.textContent;
    modal.loginBtn.textContent = 'Connexion...';
    showInline(modal.loginMsg, '', false);

    try {
      const res = await supabase.auth.signInWithPassword({ email, password });
      dbgAlert('signInWithPassword result', res);

      if (res.error) {
        showInline(modal.loginMsg, res.error.message || 'Erreur connexion.');
        modal.loginBtn.disabled = false;
        modal.loginBtn.textContent = prev;
        return;
      }

      // success (res.data.user on v2)
      const user = res.data?.user ?? null;
      if (user) {
        // ensure profile then close modal / redirect if needed
        await ensureProfile(supabase, user);
        modal.close();
        const ret = getReturnTo();
        location.href = ret;
        return;
      } else {
        // fallback: try getUser
        const ures = await supabase.auth.getUser();
        const u = ures?.data?.user ?? null;
        if (u) { await ensureProfile(supabase, u); modal.close(); location.href = getReturnTo(); return; }
        showInline(modal.loginMsg, 'Connexion réussie (attente).');
      }
    } catch (e) {
      console.error('signIn exception', e);
      dbgAlert('signInWithPassword - exception', String(e));
      showInline(modal.loginMsg, 'Erreur réseau. Réessaye.');
    } finally {
      modal.loginBtn.disabled = false;
      modal.loginBtn.textContent = prev;
    }
  });

  // SIGNUP with email/password
  modal.signupBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const email = modal.signupEmail.value?.trim();
    const password = modal.signupPass.value ?? '';
    if (!email || !password) { showInline(modal.signupMsg, 'Email et mot de passe requis.'); return; }
    if (password.length < 6) { showInline(modal.signupMsg, 'Mot de passe trop court (min 6).'); return; }

    modal.signupBtn.disabled = true;
    const prev = modal.signupBtn.textContent;
    modal.signupBtn.textContent = 'Création...';
    showInline(modal.signupMsg, '', false);

    try {
      const res = await supabase.auth.signUp({ email, password, options: {} });
      dbgAlert('signUp result', res);

      if (res.error) {
        showInline(modal.signupMsg, res.error.message || 'Erreur création compte.');
        modal.signupBtn.disabled = false;
        modal.signupBtn.textContent = prev;
        return;
      }

      const user = res.data?.user ?? null;
      if (user) {
        // immediate user created (no email confirmation required)
        await ensureProfile(supabase, user);
        modal.close();
        location.href = getReturnTo();
        return;
      } else {
        // no immediate user -> probably email confirmation required
        showInline(modal.signupMsg, 'Inscription OK — vérifie ton email pour confirmer le compte si demandé.', false);
      }
    } catch (e) {
      console.error('signUp exception', e);
      dbgAlert('signUp - exception', String(e));
      showInline(modal.signupMsg, 'Erreur réseau. Réessaye.');
    } finally {
      modal.signupBtn.disabled = false;
      modal.signupBtn.textContent = prev;
    }
  });

  // GOOGLE (OAuth) - uses redirect back to same page
// Remplace l'implémentation actuelle dans auth.js
async function startGoogleFlow() {
  try {
    // ne pas réutiliser window.location.search (contient parfois des params d'erreur/state)
    const redirectTo = window.location.origin + window.location.pathname.replace(/\?.*$/, '');
    dbgAlert('google signInWithOAuth - redirectTo', { redirectTo });
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  } catch (e) {
    console.error('Erreur OAuth', e);
    dbgAlert('signInWithOAuth - exception', String(e));
    showInline(modal.loginMsg, 'Impossible de lancer Google Sign-in.');
  }
}
  modal.googleLoginBtn.addEventListener('click', (e) => { e.preventDefault(); startGoogleFlow(); });
  modal.googleSignupBtn.addEventListener('click', (e) => { e.preventDefault(); startGoogleFlow(); });

  // allow enter to submit forms
  [modal.loginEmail, modal.loginPass].forEach(inp => {
    inp && inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') modal.loginBtn.click(); });
  });
  [modal.signupEmail, modal.signupPass].forEach(inp => {
    inp && inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') modal.signupBtn.click(); });
  });
}

/* -------------------------
   INITIALIZATION
   ------------------------- */
async function init() {
  let supabase = null;
  try {
    supabase = await getSupabase();
  } catch (e) {
    console.warn('supabaseClient.js non trouvé — mode demo', e);
  }

  // wire footer login button and event listener:
  function bindOpeners() {
    // expose global function
    window.openAuthModal = async function openAuthModal() {
      try {
        const client = supabase ?? (typeof window !== 'undefined' && window.supabase ? window.supabase : null);
        if (!client) {
          alert('Impossible d\'initialiser l\'auth (client Supabase manquant).');
          return;
        }
        // create modal and wire
        const modal = createAuthModal();
        wireAuthModal(client, modal);
        // default to login tab
        modal.tabLogin.click();
        // focus first input
        setTimeout(() => modal.loginEmail && modal.loginEmail.focus(), 40);
      } catch (err) {
        console.error('openAuthModal error', err);
      }
    };

    // attach to #loginFooterBtn if present
    const btn = document.getElementById('loginFooterBtn');
    if (btn) {
      // ensure single listener
      btn.removeEventListener('click', window.openAuthModal);
      btn.addEventListener('click', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        window.openAuthModal();
      });
    }

    // listen for custom event
    document.removeEventListener('taktik:open-auth-modal', window.openAuthModal);
    document.addEventListener('taktik:open-auth-modal', (ev) => {
      window.openAuthModal();
    });
  }

  bindOpeners();

  // Attach support for pages that had login forms (legacy / login.html)
  try {
    if (supabase) {
      await attachLegacyHandlersIfPresent(supabase);
    }
  } catch (e) {
    console.warn('attachLegacyHandlersIfPresent failed', e);
  }

  // On any page load, check session and ensure profile existence.
  try {
    if (!supabase) return;

    const sessionRes = await supabase.auth.getSession();
    dbgAlert('init - getSession', sessionRes);
    const session = sessionRes?.data?.session ?? null;
    const user = session?.user ?? null;

    if (user) {
      // ensure user_profiles.pseudo exists (may display pseudo modal and redirect)
      await ensureProfile(supabase, user);
    } else {
      // listen for auth state change: e.g. OAuth redirect or login in another tab
      supabase.auth.onAuthStateChange((event, sess) => {
        dbgAlert('onAuthStateChange', { event, sess });
        const u = sess?.user ?? null;
        if (u) {
          // slight delay to let supabase finish redirect handling
          setTimeout(() => ensureProfile(supabase, u).catch(console.error), 200);
        }
      });
    }
  } catch (e) {
    console.warn('Erreur initialisation auth.js', e);
    dbgAlert('init - exception', String(e));
  }
}

/* -------------------------
   LEGACY: attach handlers if page includes login/signup inputs (login.html)
   This keeps backward compatibility if some pages still have inline forms.
   ------------------------- */
async function attachLegacyHandlersIfPresent(supabase) {
  // keep this minimal: if login form inputs exist, wire them (same behavior as modal)
  try {
    const loginEmail = document.getElementById('loginEmail');
    const loginPass = document.getElementById('loginPass');
    const loginBtn = document.getElementById('loginBtn');
    const signupEmail = document.getElementById('signupEmail');
    const signupPass = document.getElementById('signupPass');
    const signupBtn = document.getElementById('signupBtn');
    const googleBtn = document.getElementById('googleBtn');

    if (loginBtn && loginEmail && loginPass) {
      loginBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const email = loginEmail.value?.trim();
        const password = loginPass.value ?? '';
        if (!email || !password) { alert('Email et mot de passe requis.'); return; }
        loginBtn.disabled = true;
        const prev = loginBtn.textContent;
        loginBtn.textContent = 'Connexion...';
        try {
          const res = await supabase.auth.signInWithPassword({ email, password });
          dbgAlert('signInWithPassword result (legacy)', res);
          if (res.error) {
            alert(res.error.message || 'Erreur connexion.');
            return;
          }
          const user = res.data?.user ?? null;
          if (user) { await ensureProfile(supabase, user); location.href = getReturnTo(); }
        } catch (e) {
          console.error(e);
          alert('Erreur réseau — réessaye.');
        } finally {
          loginBtn.disabled = false;
          loginBtn.textContent = prev;
        }
      });
    }

    if (signupBtn && signupEmail && signupPass) {
      signupBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const email = signupEmail.value?.trim();
        const password = signupPass.value ?? '';
        if (!email || !password) { alert('Email et mot de passe requis.'); return; }
        signupBtn.disabled = true;
        const prev = signupBtn.textContent;
        signupBtn.textContent = 'Création...';
        try {
          const res = await supabase.auth.signUp({ email, password, options: {} });
          dbgAlert('signUp result (legacy)', res);
          if (res.error) {
            alert(res.error.message || 'Erreur création compte.');
            return;
          }
          const user = res.data?.user ?? null;
          if (user) { await ensureProfile(supabase, user); location.href = getReturnTo(); }
          else alert('Inscription OK — vérifie ton email pour confirmer le compte si requis.');
        } catch (e) {
          console.error(e);
          alert('Erreur réseau — réessaye.');
        } finally {
          signupBtn.disabled = false;
          signupBtn.textContent = prev;
        }
      });
    }

    if (googleBtn) {
      googleBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const redirectTo = window.location.origin + window.location.pathname + (window.location.search || '');
        await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
      });
    }
  } catch (e) {
    console.warn('attachLegacyHandlersIfPresent error', e);
  }
}

// Kick off
init().catch(e => {
  console.error('auth init error', e);
  dbgAlert('auth init error', String(e));
});

