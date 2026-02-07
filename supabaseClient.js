// supabaseClient.js

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/**
 * Debug banner + wrappers
 * - set `dbg = true` to enable the banner & message buffering (for Android without console)
 * - messages are stored on window.__lw_debug_messages so you can copy them later
 */
const dbg = false; // <-- demandé : constdbg true

// ensure a safe, no-op DOM guard (in case running in non-browser env)
const _hasDOM = typeof document !== 'undefined' && document && document.createElement;

/**
 * Internal buffer and utilities
 */
if (!window.__lw_debug_messages) window.__lw_debug_messages = [];
if (!window.__lw_debug_buffer) window.__lw_debug_buffer = '';

function _formatMsg(level, args) {
  const time = new Date().toISOString();
  const text = args.map(a => {
    try {
      if (typeof a === 'string') return a;
      return JSON.stringify(a);
    } catch (e) {
      try { return String(a); } catch (_) { return '[Unserializable]'; }
    }
  }).join(' ');
  return `${time} — [${level}] ${text}`;
}

function _appendToBuffer(text) {
  window.__lw_debug_messages.push(text);
  window.__lw_debug_buffer += text + '\n';
}

/**
 * Create (or return) the visual banner used for debug output on mobile.
 * The banner is a fixed element at top, with controls to copy/clear/hide.
 */
function _ensureDebugBanner() {
  if (!dbg || !_hasDOM) return null;
  let banner = document.getElementById('__lw_debug_console');
  if (banner) return banner;

  banner = document.createElement('div');
  banner.id = '__lw_debug_console';
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    maxHeight: '40vh',
    overflowY: 'auto',
    zIndex: 2147483647,
    background: 'rgba(0,0,0,0.85)',
    color: 'white',
    fontFamily: 'monospace',
    fontSize: '12px',
    padding: '6px',
    boxSizing: 'border-box'
  });

  // header with buttons
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.gap = '6px';
  header.style.marginBottom = '6px';
  header.style.alignItems = 'center';

  const title = document.createElement('div');
  title.textContent = 'LW Debug Console';
  title.style.fontWeight = '700';
  title.style.flex = '1';
  header.appendChild(title);

  const btnCopy = document.createElement('button');
  btnCopy.textContent = 'Copier';
  btnCopy.style.padding = '6px';
  btnCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(window.__lw_debug_buffer || '');
      btnCopy.textContent = 'Copié ✓';
      setTimeout(() => (btnCopy.textContent = 'Copier'), 1500);
    } catch (e) {
      btnCopy.textContent = 'Erreur copy';
      console.warn('[__lw_debug_console] copy failed', e);
    }
  };
  header.appendChild(btnCopy);

  const btnClear = document.createElement('button');
  btnClear.textContent = 'Effacer';
  btnClear.style.padding = '6px';
  btnClear.onclick = () => {
    const body = banner.querySelector('.__lw_debug_body');
    if (body) body.innerHTML = '';
    window.__lw_debug_messages = [];
    window.__lw_debug_buffer = '';
  };
  header.appendChild(btnClear);

  const btnHide = document.createElement('button');
  btnHide.textContent = 'Masquer';
  btnHide.style.padding = '6px';
  btnHide.onclick = () => {
    banner.style.display = 'none';
  };
  header.appendChild(btnHide);

  banner.appendChild(header);

  const body = document.createElement('div');
  body.className = '__lw_debug_body';
  body.style.whiteSpace = 'pre-wrap';
  body.style.fontSize = '12px';
  banner.appendChild(body);

  // make space at top of page content so banner doesn't cover things
  try {
    const spacerId = '__lw_debug_console_spacer';
    if (!document.getElementById(spacerId)) {
      const spacer = document.createElement('div');
      spacer.id = spacerId;
      spacer.style.height = '48px';
      document.body.insertBefore(spacer, document.body.firstChild);
    }
  } catch (e) { /* noop */ }

  document.body.appendChild(banner);
  return banner;
}

function _renderToBanner(text, level = 'INFO') {
  if (!dbg || !_hasDOM) return;
  const banner = _ensureDebugBanner();
  if (!banner) return;
  const body = banner.querySelector('.__lw_debug_body');
  if (!body) return;
  const el = document.createElement('div');
  el.textContent = text;
  el.style.padding = '4px 0';
  if (level === 'ERROR') el.style.background = 'rgba(255,0,0,0.12)';
  else if (level === 'WARN') el.style.background = 'rgba(255,165,0,0.08)';
  body.prepend(el);
  // cap the number of children to avoid huge DOM
  while (body.children.length > 200) body.removeChild(body.lastChild);
}

function dbgLog(...args) {
  const text = _formatMsg('LOG', args);
  try { console.log(...args); } catch (e) { /* ignore */ }
  _appendToBuffer(text);
  _renderToBanner(text, 'LOG');
}
function dbgInfo(...args) {
  const text = _formatMsg('INFO', args);
  try { console.info(...args); } catch (e) { /* ignore */ }
  _appendToBuffer(text);
  _renderToBanner(text, 'INFO');
}
function dbgWarn(...args) {
  const text = _formatMsg('WARN', args);
  try { console.warn(...args); } catch (e) { /* ignore */ }
  _appendToBuffer(text);
  _renderToBanner(text, 'WARN');
}
function dbgError(...args) {
  const text = _formatMsg('ERROR', args);
  try { console.error(...args); } catch (e) { /* ignore */ }
  _appendToBuffer(text);
  _renderToBanner(text, 'ERROR');
}
function dbgTable(obj) {
  // show table as JSON lines in banner
  try {
    try { console.table(obj); } catch (e) { /* ignore */ }
    const t = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    const text = _formatMsg('TABLE', [t]);
    _appendToBuffer(text);
    _renderToBanner(text, 'LOG');
  } catch (e) { dbgWarn('dbgTable failed', e); }
}

/* ---------------- safe storage wrapper to avoid localStorage throwing ---------------- */
const safeStorage = {
  _hasLocalStorage() {
    try { return typeof localStorage !== 'undefined' && localStorage !== null; }
    catch (e) { return false; }
  },

  getItem(key) {
    if (!this._hasLocalStorage()) return null;
    try { return localStorage.getItem(key); }
    catch (e) { dbgWarn('[safeStorage] getItem failed for', key, e); return null; }
  },

  setItem(key, value) {
    if (!this._hasLocalStorage()) return;
    try { localStorage.setItem(key, value); }
    catch (e) { dbgWarn('[safeStorage] setItem failed for', key, e); }
  },

  removeItem(key) {
    if (!this._hasLocalStorage()) return;
    try {
      if (typeof key !== 'string') key = String(key);
      localStorage.removeItem(key);
    } catch (e) {
      dbgWarn('[safeStorage] removeItem failed for', key, e);
    }
  },

  keys() {
    if (!this._hasLocalStorage()) return [];
    try {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        try {
          const k = localStorage.key(i);
          if (k) out.push(k);
        } catch (e) {
          // ignore single key failures
        }
      }
      return out;
    } catch (e) {
      dbgWarn('[safeStorage] keys() failed', e);
      return [];
    }
  }
};

/* ---------------- create supabase client using safeStorage ---------------- */
let supabase = null;
try {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    dbgError('[supabaseClient] Missing SUPABASE_URL or SUPABASE_ANON_KEY — check config.js exports.');
  } else {
    dbgInfo('[supabaseClient] SUPABASE_URL and ANON_KEY presence ok');
  }
  supabase = createClient(SUPABASE_URL || '', SUPABASE_ANON_KEY || '', {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: safeStorage
    }
  });
  dbgInfo('[supabaseClient] createClient OK', !!supabase);
} catch (err) {
  dbgError('[supabaseClient] createClient failed', err);
  // expose a minimal stub so imports don't completely blow up (consumers should check)
  supabase = {
    auth: {
      onAuthStateChange: () => ({ data: null, error: new Error('supabase not initialised') }),
      signInWithRefreshToken: async () => ({ error: new Error('supabase not initialised') }),
      setSession: async () => ({ error: new Error('supabase not initialised') })
    }
  };
}

/* ---------------- helpers pour inspection protégée du stockage ---------------- */
function tryParseSessionFromKey(key) {
  try {
    const raw = safeStorage.getItem(key);
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed) return null;
    if (parsed.refresh_token || parsed.access_token || parsed.user || parsed.currentSession || parsed.expires_at) {
      return parsed;
    }
    return null;
  } catch (e) {
    dbgWarn('[tryParseSessionFromKey] error for key', key, e);
    return null;
  }
}

function getSessionFromStorage() {
  try {
    const canonical = safeStorage.getItem('lw_supabase_session');
    if (canonical) {
      try {
        const p = JSON.parse(canonical);
        if (p && (p.refresh_token || p.access_token)) {
          dbgInfo('[getSessionFromStorage] found canonical lw_supabase_session');
          return p;
        }
      } catch (e) { /* ignore parse errors */ }
    }

    const keys = safeStorage.keys();
    for (const k of keys) {
      const candidate = tryParseSessionFromKey(k);
      if (candidate) {
        dbgInfo('[getSessionFromStorage] found candidate session key:', k);
        return candidate;
      }
    }
    dbgInfo('[getSessionFromStorage] no session found in storage');
    return null;
  } catch (e) {
    dbgWarn('[getSessionFromStorage] unexpected error', e);
    return null;
  }
}

/* utility: list keys & small sample values (for debug only) */
function debugListStorageKeys() {
  try {
    if (!safeStorage._hasLocalStorage()) {
      dbgWarn('[debugListStorageKeys] no localStorage available');
      return [];
    }
    const keys = safeStorage.keys();
    dbgInfo('[debugListStorageKeys] found keys count:', keys.length);
    const out = keys.map(k => {
      let v = null;
      try { v = safeStorage.getItem(k); } catch (e) { v = 'GET_FAILED'; }
      if (typeof v === 'string' && v.length > 200) v = v.slice(0, 200) + '…(truncated)';
      return { key: k, sample: v };
    });
    dbgTable(out);
    return out;
  } catch (e) {
    dbgWarn('[debugListStorageKeys] failed', e);
    return [];
  }
}

/* ---------------- onAuthStateChange centralisé (logging + hint restore) ---------------- */
if (supabase && supabase.auth && typeof supabase.auth.onAuthStateChange === 'function') {
  if (!supabase._hasOnAuthStateChangeHandler) {
    supabase._hasOnAuthStateChangeHandler = true;

    supabase.auth.onAuthStateChange((event, session) => {
      try {
        dbgInfo('[supabase:onAuthStateChange]', event,
          session ? { userId: session.user?.id, expires_at: session.expires_at } : null
        );

        try {
          const panel = document.getElementById('__lw_auth_debug_lines');
          if (panel) {
            const el = document.createElement('div');
            el.textContent = new Date().toLocaleTimeString() + ' — [onAuthStateChange] ' + event;
            panel.prepend(el);
            if (panel.children.length > 80) panel.removeChild(panel.lastChild);
          }
        } catch(e){ /* noop */ }

        if (event === 'SIGNED_OUT') {
          dbgWarn('[supabase] SIGNED_OUT detected — tentative de restore si disponible');

          if (window.__lw_restore_in_progress) {
            dbgInfo('[onAuthStateChange] restore already in progress, skipping duplicate attempt');
            return;
          }

          const storedSession = getSessionFromStorage();
          if (!storedSession) {
            dbgInfo('[onAuthStateChange] no usable session found in storage -> skip restore');
            debugListStorageKeys();
            return;
          }

          window.__lw_restore_in_progress = true;
          setTimeout(async () => {
            try {
              if (typeof tryRestoreSupabaseSession === 'function') {
                try {
                  const ok = await tryRestoreSupabaseSession();
                  dbgInfo('[onAuthStateChange] tryRestoreSupabaseSession result:', ok);
                } catch (err) {
                  dbgWarn('[onAuthStateChange] tryRestoreSupabaseSession threw', err);
                }
              } else {
                const refresh = storedSession.refresh_token || (storedSession.currentSession && storedSession.currentSession.refresh_token);
                const access = storedSession.access_token || (storedSession.currentSession && storedSession.currentSession.access_token);

                if (refresh && typeof supabase.auth.signInWithRefreshToken === 'function') {
                  try {
                    dbgInfo('[onAuthStateChange] attempting inline signInWithRefreshToken fallback');
                    await supabase.auth.signInWithRefreshToken({ refresh_token: refresh });
                    dbgInfo('[onAuthStateChange] inline restore via signInWithRefreshToken succeeded');
                  } catch (err) {
                    dbgWarn('[onAuthStateChange] inline signInWithRefreshToken failed', err);
                  }
                } else if (access && typeof supabase.auth.setSession === 'function') {
                  try {
                    dbgInfo('[onAuthStateChange] attempting inline setSession fallback (access token present)');
                    await supabase.auth.setSession({ access_token: access, refresh_token: refresh || null });
                    dbgInfo('[onAuthStateChange] inline setSession fallback succeeded');
                  } catch (err) {
                    dbgWarn('[onAuthStateChange] inline setSession fallback failed', err);
                  }
                } else {
                  dbgInfo('[onAuthStateChange] no refresh_token/access_token found for fallback restore');
                  debugListStorageKeys();
                }
              }
            } catch (err) {
              dbgWarn('[onAuthStateChange] restore attempt failed:', err);
            } finally {
              window.__lw_restore_in_progress = false;
            }
          }, 200);
        }
      } catch (err) {
        dbgWarn('onAuthStateChange handler error', err);
      }
    });
  }
} else {
  dbgWarn('[supabaseClient] supabase.auth.onAuthStateChange NOT available on this SDK instance');
}

/* ---------------- convenience: show current session on demand ---------------- */
/**
 * Call `showSupabaseSession()` from anywhere (e.g. via import) or run:
 * import('./supabaseClient.js').then(m => m.showSupabaseSession());
 */
async function showSupabaseSession() {
  try {
    if (!supabase || !supabase.auth) {
      dbgWarn('[showSupabaseSession] supabase or supabase.auth not available');
      return null;
    }
    // some SDK versions provide getSession() or getUser()
    if (typeof supabase.auth.getSession === 'function') {
      const s = await supabase.auth.getSession();
      dbgInfo('[showSupabaseSession] getSession result:', s);
      return s;
    } else if (typeof supabase.auth.session === 'function') {
      // older versions
      const s = supabase.auth.session();
      dbgInfo('[showSupabaseSession] legacy session result:', s);
      return s;
    } else {
      dbgInfo('[showSupabaseSession] no session API found on supabase.auth — dumping storage');
      debugListStorageKeys();
      return null;
    }
  } catch (e) {
    dbgWarn('[showSupabaseSession] failed', e);
    return null;
  }
}

// exports
export { supabase, safeStorage, getSessionFromStorage, debugListStorageKeys, showSupabaseSession, dbg };
export default supabase;

