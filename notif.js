
// notif.js — module chargé par index.html
// usage: importé dynamiquement par index.html ; expose window.initNotifications(), window.renderNotificationsList(), window.markAllNotificationsRead()

const NOTIF_TABLE = 'notifications';
let _userId = null;
let _subscription = null;
let _authListener = null;

// util: try to find supabase client from global scope or dynamic import
async function getSupabase() {
  // 1) already available as module/global
  if (typeof supabase !== 'undefined' && supabase) return supabase;
  if (window.supabase) return window.supabase;

  // 2) try to import the local supabase client module
  try {
    const mod = await import('./supabaseClient.js');
    if (mod?.supabase) {
      // expose globally so other modules can use it
      try { window.supabase = mod.supabase; } catch (e) { /* ignore if not writable */ }
      return mod.supabase;
    }
  } catch (e) {
    // import failed — may be offline or not present
    // swallow and return null
    console.debug('getSupabase: import ./supabaseClient.js failed', e);
  }

  return null;
}

async function getCurrentUserId() {
  const sup = await getSupabase();
  if (!sup) return null;
  try {
    // supabase-js v2: auth.getSession()
    if (sup.auth && typeof sup.auth.getSession === 'function') {
      const res = await sup.auth.getSession();
      // v2 shape: { data: { session } }
      const session = res?.data?.session ?? res?.session ?? null;
      const user = session?.user ?? null;
      if (user && user.id) return user.id;
    }
    // v2: auth.getUser()
    if (sup.auth && typeof sup.auth.getUser === 'function') {
      const r = await sup.auth.getUser();
      const user = r?.data?.user ?? r?.user ?? null;
      if (user && user.id) return user.id;
    }
    // older v1: auth.session()
    if (sup.auth && typeof sup.auth.session === 'function') {
      const s = sup.auth.session();
      const user = s?.user ?? null;
      if (user && user.id) return user.id;
    }
    // fallback: maybe the client attached a user directly
    if (sup.user && sup.user.id) return sup.user.id;
  } catch (e) {
    console.warn('getCurrentUserId error', e);
  }
  return null;
}

async function fetchUnreadCount() {
  const sup = await getSupabase();
  if (!sup) return 0;
  if (!_userId) return 0;
  try {
    // request count only (use head: true to avoid fetching rows), but some clients handle differently
    // try head:true first; if server doesn't return count, fallback to selecting rows
    let resp;
    try {
      resp = await sup
        .from(NOTIF_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', _userId)
        .eq('is_read', false);
    } catch (e) {
      // fallback to non-head select if DB/client doesn't support head:true in this env
      resp = await sup
        .from(NOTIF_TABLE)
        .select('id', { count: 'exact' })
        .eq('user_id', _userId)
        .eq('is_read', false)
        .limit(1);
    }
    if (resp?.error) throw resp.error;
    const count = resp?.count ?? 0;
    return count;
  } catch (e) {
    console.warn('fetchUnreadCount error', e);
    return 0;
  }
}

function updateBadge(count) {
  const el = document.getElementById('notifBadge');
  if (!el) return;
  if (!count || count <= 0) {
    el.classList.add('hidden');
    el.textContent = '0';
  } else {
    el.classList.remove('hidden');
    el.textContent = String(count > 99 ? '99+' : count);
  }
}

// fetch and render list of notifications into placeholderPanel
window.renderNotificationsList = async function renderNotificationsList() {
  const sup = await getSupabase();
  const titleEl = document.getElementById('placeholderTitle');
  const textEl = document.getElementById('placeholderText');
  if (!titleEl || !textEl) return;
  if (!sup || !_userId) {
    textEl.textContent = 'Utilisateur non authentifié — connectez-vous.';
    return;
  }

  try {
    const res = await sup
      .from(NOTIF_TABLE)
      .select('*')
      .eq('user_id', _userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (res.error) throw res.error;
    const rows = res.data ?? [];

    if (!rows.length) {
      textEl.innerHTML = '<div class="text-slate-600">Aucune notification.</div>';
      return;
    }

    // build HTML list
    const list = document.createElement('div');
    list.className = 'space-y-2';
    rows.forEach(n => {
      const when = new Date(n.created_at).toLocaleString();
      const text = (n.payload && n.payload.text) ? n.payload.text : (n.type || 'Notification');
      const actor = (n.actor_id) ? `<span class="text-xs text-slate-400"> — par ${n.actor_id}</span>` : '';
      const unreadClass = n.is_read ? 'opacity-80' : 'font-semibold bg-white/60 border-l-4 border-sky-500 p-2 rounded-md';
      const item = document.createElement('div');
      item.className = unreadClass + ' p-2';
      item.innerHTML = `<div class="flex items-center justify-between"><div>${escapeHtml(text)}${actor}</div><div class="text-xs text-slate-400">${escapeHtml(when)}</div></div>`;
      list.appendChild(item);
    });

    // Add a "marquer tout lu" button
    const btnBar = document.createElement('div');
    btnBar.className = 'flex items-center justify-end gap-2 mt-3';
    const markBtn = document.createElement('button');
    markBtn.className = 'px-3 py-1 rounded-md bg-sky-500 text-white text-sm';
    markBtn.textContent = 'Marquer tout lu';
    markBtn.onclick = async () => {
      markBtn.disabled = true;
      await window.markAllNotificationsRead();
      await window.renderNotificationsList();
      markBtn.disabled = false;
    };
    btnBar.appendChild(markBtn);

    // render into placeholder area
    textEl.innerHTML = '';
    textEl.appendChild(list);
    textEl.appendChild(btnBar);
  } catch (e) {
    console.warn('renderNotificationsList error', e);
    document.getElementById('placeholderText').textContent = 'Erreur chargement notifications.';
  }
};

// mark all unread notifications as read for this user
window.markAllNotificationsRead = async function markAllNotificationsRead() {
  const sup = await getSupabase();
  if (!sup || !_userId) return false;
  try {
    const res = await sup
      .from(NOTIF_TABLE)
      .update({ is_read: true })
      .eq('user_id', _userId)
      .eq('is_read', false);
    if (res.error) throw res.error;
    // update UI
    updateBadge(0);
    return true;
  } catch (e) {
    console.warn('markAllNotificationsRead error', e);
    return false;
  }
};

// helper unsubscribe for various supabase realtime APIs
async function safeUnsubscribe() {
  const sup = await getSupabase();
  if (!sup) return;
  try {
    if (_subscription) {
      // v1 subscription pattern
      if (typeof _subscription.unsubscribe === 'function') {
        try { _subscription.unsubscribe(); } catch (e) { /* ignore */ }
      }
      // v2 channel: sup.removeChannel
      if (sup.removeChannel && _subscription?.channel) {
        try { sup.removeChannel(_subscription); } catch (e) { /* ignore */ }
      }
      // final cleanup
      _subscription = null;
    }
  } catch (e) {
    console.debug('safeUnsubscribe error', e);
  }
}

// set up realtime subscription to keep badge updated
async function setupRealtime() {
  const sup = await getSupabase();
  if (!sup || !_userId) return;
  try {
    // unsubscribe previous if exists
    await safeUnsubscribe();

    // old supabase realtime API (v1)
    if (sup.from && typeof sup.from === 'function') {
      _subscription = sup
        .from(`${NOTIF_TABLE}:user_id=eq.${_userId}`)
        .on('INSERT', payload => { fetchAndUpdateBadge(); })
        .on('UPDATE', payload => { fetchAndUpdateBadge(); })
        .subscribe();
      return;
    }

    // newer supabase-js v2 channel API
    if (typeof sup.channel === 'function') {
      const ch = sup.channel(`public:${NOTIF_TABLE}:user:${_userId}`);
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: NOTIF_TABLE, filter: `user_id=eq.${_userId}` }, () => fetchAndUpdateBadge());
      ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: NOTIF_TABLE, filter: `user_id=eq.${_userId}` }, () => fetchAndUpdateBadge());
      // subscribe and keep reference
      try {
        const sub = ch.subscribe(() => {});
        // store channel/subscription reference so we can remove later
        _subscription = sub || ch;
      } catch (e) {
        // some sdk versions return a different shape; still store ch
        _subscription = ch;
      }
      return;
    }
  } catch (e) {
    console.warn('setupRealtime error', e);
  }
}

async function fetchAndUpdateBadge() {
  const c = await fetchUnreadCount();
  updateBadge(c);
}

function escapeHtml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// init entrypoint — tries to detect user and set up badge + realtime
window.initNotifications = async function initNotifications() {
  const sup = await getSupabase();
  if (!sup) {
    // nothing to do — hide badge
    updateBadge(0);
    return;
  }

  // try to read current session
  _userId = await getCurrentUserId();
  if (!_userId) {
    // no user now — but listen to future auth state changes
    updateBadge(0);

    // set up auth state listener to detect login/logout events
    try {
      if (sup.auth && typeof sup.auth.onAuthStateChange === 'function') {
        // supabase-js v2 returns { data: { subscription } } or a callback unsubscribe
        const maybe = sup.auth.onAuthStateChange((event, session) => {
          const user = session?.user ?? session?.data?.user ?? null;
          if (user && user.id) {
            _userId = user.id;
            fetchAndUpdateBadge();
            setupRealtime();
          } else {
            // logged out
            _userId = null;
            updateBadge(0);
            safeUnsubscribe();
          }
        });
        _authListener = maybe;
      }
    } catch (e) {
      console.debug('initNotifications: cannot attach auth listener', e);
    }
    return;
  }

  // if we have a user now, fetch count and wire realtime + auth listener
  await fetchAndUpdateBadge();
  await setupRealtime();

  // also ensure we update when auth state changes (switch account / logout)
  try {
    if (sup.auth && typeof sup.auth.onAuthStateChange === 'function') {
      const maybe = sup.auth.onAuthStateChange((event, session) => {
        const user = session?.user ?? session?.data?.user ?? null;
        if (user && user.id) {
          if (user.id !== _userId) {
            _userId = user.id;
            fetchAndUpdateBadge();
            setupRealtime();
          }
        } else {
          _userId = null;
          updateBadge(0);
          safeUnsubscribe();
        }
      });
      _authListener = maybe;
    }
  } catch (e) {
    console.debug('initNotifications: cannot attach auth listener after login', e);
  }
};

// auto-init attempt (in case supabase session already available)
(async () => {
  try {
    await window.initNotifications();
  } catch(e) { /* ignore */ }
})();