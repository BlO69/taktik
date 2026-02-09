// create_game.js — basé sur l'original create_event.js (patché, hardené et avec fallback polling)
// Usage: import initCreateGame from './create_game.js'; initCreateGame(window.supabase);
// or <script type="module" src="./create_game.js"></script> then initCreateGame(supabaseClient);

export default async function initCreateGame(supabaseClient) {
  const supabase = supabaseClient ?? window.supabase;
  const dbg = true; // true = logs (dev). Set to false in production.

  function dbgLog(...args) { if (dbg) console.debug('DBG create_game:', ...args); }
  function info(msg) { if (!dbg) { try { if (window.toastr) window.toastr.info(msg); else console.info(msg); } catch { console.info(msg); } } else { console.info(msg); } }
  function warn(msg) { console.warn('WARN create_game:', msg); }
  function err(msg, e) { console.error('ERR create_game:', msg, e); }

  if (!supabase) {
    console.warn('create_game: supabase client introuvable (window.supabase ou param).');
    return;
  }

  // UI anchors
  const placeholderPanel = document.getElementById('placeholderPanel') || document.body;
  const placeholderText = document.getElementById('placeholderText');

  // small util
  function debounce(fn, wait = 300) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // ----------------------------
  // Simple search UI (création si manquante)
  // ----------------------------
  function ensureSearchUI() {
    if (document.getElementById('taktik-matchmaking')) return document.getElementById('taktik-matchmaking');

    const box = document.createElement('div');
    box.id = 'taktik-matchmaking';
    box.className = 'p-4 rounded-md border';
    box.style.maxWidth = '720px';

    const input = document.createElement('input');
    input.id = 'taktik-search-input';
    input.placeholder = "Chercher un joueur par pseudo...";
    input.className = 'w-full p-2 rounded';
    input.style.boxSizing = 'border-box';

    const results = document.createElement('div');
    results.id = 'taktik-search-results';
    results.className = 'mt-3 space-y-2';

    box.appendChild(input);
    box.appendChild(results);
    if (placeholderText) placeholderText.replaceWith(box);
    else placeholderPanel.appendChild(box);

    return box;
  }

  const uiBox = ensureSearchUI();
  const inputEl = document.getElementById('taktik-search-input');
  const resultsEl = document.getElementById('taktik-search-results');

  let selectedProfile = null;

  function renderProfiles(list = []) {
    resultsEl.innerHTML = '';
    if (!list.length) {
      resultsEl.textContent = 'Aucun résultat';
      return;
    }
    list.forEach(p => {
      const el = document.createElement('div');
      el.className = 'flex items-center justify-between p-2 border rounded';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'space-between';

      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      const avatar = document.createElement('img');
      avatar.src = p.avatar_url || '';
      avatar.alt = p.pseudo || 'avatar';
      avatar.style.width = '40px';
      avatar.style.height = '40px';
      avatar.style.objectFit = 'cover';
      avatar.style.borderRadius = '50%';
      avatar.style.marginRight = '8px';
      left.appendChild(avatar);

      const info = document.createElement('div');
      const pseudo = document.createElement('div');
      pseudo.textContent = p.pseudo || '(no pseudo)';
      pseudo.style.fontWeight = '600';
      info.appendChild(pseudo);
      left.appendChild(info);

      const right = document.createElement('div');
      const btn = document.createElement('button');
      btn.className = 'px-3 py-1 rounded';
      btn.textContent = 'Inviter';
      btn.addEventListener('click', () => {
        selectedProfile = p;
        renderSelected();
      });
      right.appendChild(btn);

      el.appendChild(left);
      el.appendChild(right);
      resultsEl.appendChild(el);
    });
  }

  function renderSelected() {
    const selWrapId = 'taktik-selected-wrap';
    let wrap = document.getElementById(selWrapId);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = selWrapId;
      wrap.className = 'mt-4 p-3 border rounded';
      uiBox.appendChild(wrap);
    }
    wrap.innerHTML = '';
    if (!selectedProfile) return;

    const title = document.createElement('div');
    title.textContent = `Inviter ${selectedProfile.pseudo || selectedProfile.id}`;
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';

    const msgInput = document.createElement('textarea');
    msgInput.placeholder = 'Message (optionnel)';
    msgInput.rows = 3;
    msgInput.className = 'w-full p-2 border rounded';
    msgInput.style.resize = 'vertical';

    const actions = document.createElement('div');
    actions.style.marginTop = '8px';
    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Envoyer invitation';
    sendBtn.className = 'px-3 py-1 rounded';
    sendBtn.addEventListener('click', () => {
      sendInvitation(selectedProfile.id, msgInput.value);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Annuler';
    cancelBtn.style.marginLeft = '8px';
    cancelBtn.className = 'px-2 py-1 rounded';
    cancelBtn.addEventListener('click', () => {
      selectedProfile = null;
      wrap.remove();
    });

    actions.appendChild(sendBtn);
    actions.appendChild(cancelBtn);

    wrap.appendChild(title);
    wrap.appendChild(msgInput);
    wrap.appendChild(actions);
  }

  async function searchProfiles(q) {
    try {
      if (!q || q.trim().length < 1) {
        renderProfiles([]);
        return;
      }
      const qv = q.trim();
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id,pseudo,avatar_url')
        .ilike('pseudo', `%${qv}%`)
        .limit(12);

      dbgLog('searchProfiles result', { qv, data, error });
      if (error) {
        console.error('searchProfiles error', error);
        renderProfiles([]);
        return;
      }
      renderProfiles(data || []);
    } catch (e) {
      console.error('searchProfiles exception', e);
      renderProfiles([]);
    }
  }

  const debouncedSearch = debounce((e) => searchProfiles(e.target.value), 250);
  inputEl.addEventListener('input', debouncedSearch);

  // ---------------------------
  // Overlays & helpers UI
  // ---------------------------
  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'taktik-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.55)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '99999';
    return overlay;
  }

  function showWaitingOverlay(invitationRecord, onCancelCallback) {
    const overlay = createOverlay();
    const card = document.createElement('div');
    card.style.background = '#fff';
    card.style.padding = '20px';
    card.style.borderRadius = '8px';
    card.style.minWidth = '320px';
    card.style.textAlign = 'center';

    const title = document.createElement('div');
    title.textContent = `Invitation envoyée à ${invitationRecord.invitee_pseudo || invitationRecord.invitee_id}`;
    title.style.fontWeight = '700';
    title.style.marginBottom = '8px';

    const spinner = document.createElement('div');
    spinner.innerHTML = '<div style="margin:12px auto 8px;width:48px;height:48px;border-radius:50%;border:4px solid #ccc;border-top-color:#333;animation:spin 1s linear infinite"></div>';
    const cssId = 'taktik-spinner-style';
    if (!document.getElementById(cssId)) {
      const css = document.createElement('style');
      css.id = cssId;
      css.textContent = `@keyframes spin{to{transform:rotate(360deg)}}`;
      document.head.appendChild(css);
    }

    const countdown = document.createElement('div');
    countdown.textContent = '45';
    countdown.style.fontSize = '20px';
    countdown.style.marginBottom = '12px';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Annuler invitation';
    cancelBtn.className = 'px-3 py-1 rounded';

    card.appendChild(title);
    card.appendChild(spinner);
    card.appendChild(countdown);
    card.appendChild(cancelBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let seconds = 45;
    countdown.textContent = `${seconds}s`;

    const interval = setInterval(() => {
      seconds -= 1;
      countdown.textContent = `${seconds}s`;
      if (seconds <= 0) {
        clearInterval(interval);
        try { overlay.remove(); } catch (_) {}
        if (onCancelCallback) onCancelCallback('expired');
      }
    }, 1000);

    cancelBtn.addEventListener('click', async () => {
      clearInterval(interval);
      try { overlay.remove(); } catch (_) {}
      if (onCancelCallback) onCancelCallback('cancelled');
    });

    return {
      close: () => {
        clearInterval(interval);
        try { overlay.remove(); } catch (_) {}
      },
      updateRemaining: (sec) => {
        seconds = Math.max(0, Math.floor(sec));
        countdown.textContent = `${seconds}s`;
      }
    };
  }

  function showIncomingOverlay(invitationRecord, onDecision, initialSeconds = 45) {
    const overlay = createOverlay();
    const card = document.createElement('div');
    card.style.background = '#fff';
    card.style.padding = '18px';
    card.style.borderRadius = '8px';
    card.style.minWidth = '340px';
    card.style.textAlign = 'center';

    const title = document.createElement('div');
    title.textContent = `${invitationRecord.inviter_pseudo || invitationRecord.inviter_id} t'invite à jouer`;
    title.style.fontWeight = '700';
    title.style.marginBottom = '8px';

    const msg = document.createElement('div');
    msg.textContent = invitationRecord.message || '';
    msg.style.marginBottom = '12px';
    msg.style.whiteSpace = 'pre-wrap';

    const countdown = document.createElement('div');
    countdown.style.fontSize = '20px';
    countdown.style.marginBottom = '12px';
    countdown.textContent = `${initialSeconds}s`;

    const actions = document.createElement('div');
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accepter';
    acceptBtn.className = 'px-3 py-1 rounded';
    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Refuser';
    declineBtn.className = 'px-3 py-1 rounded';
    declineBtn.style.marginLeft = '8px';
    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);

    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(countdown);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let seconds = Math.max(0, Math.floor(initialSeconds));

    if (seconds <= 0) {
      try { overlay.remove(); } catch (_) {}
      if (onDecision) setTimeout(() => onDecision('expired'), 0);
      return { close: () => {} };
    }

    const interval = setInterval(() => {
      seconds -= 1;
      countdown.textContent = `${seconds}s`;
      if (seconds <= 0) {
        clearInterval(interval);
        try { overlay.remove(); } catch (_) {}
        if (onDecision) onDecision('expired');
      }
    }, 1000);

    acceptBtn.addEventListener('click', () => {
      clearInterval(interval);
      try { overlay.remove(); } catch (_) {}
      if (onDecision) onDecision('accepted');
    });

    declineBtn.addEventListener('click', () => {
      clearInterval(interval);
      try { overlay.remove(); } catch (_) {}
      if (onDecision) onDecision('declined');
    });

    return {
      close: () => {
        clearInterval(interval);
        try { overlay.remove(); } catch (_) {}
      },
      updateRemaining: (sec) => {
        seconds = Math.max(0, Math.floor(sec));
        countdown.textContent = `${seconds}s`;
      }
    };
  }

  function computeRemainingSeconds(expiresAtIso) {
    if (!expiresAtIso) return 45;
    const expiresTs = new Date(expiresAtIso).getTime();
    return Math.max(0, Math.ceil((expiresTs - Date.now()) / 1000));
  }

  // ---------------------------
  // Helpers: fetch invitation with retries
  // ---------------------------
  async function fetchInvitationById(invId, retries = 6, delayMs = 200) {
    for (let i = 0; i < retries; i++) {
      try {
        const { data, error } = await supabase.from('game_invitations').select('*').eq('id', invId).maybeSingle();
        if (error) dbgLog('fetchInvitationById error', error);
        if (data) return data;
      } catch (e) {
        dbgLog('fetchInvitationById exception', e);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
  }

  // Helper: wait a short time for DB to populate game_id (retry loop)
  async function waitForGameId(invitationId, maxMs = 5000, intervalMs = 500) {
    const deadline = Date.now() + (maxMs || 5000);
    while (Date.now() < deadline) {
      try {
        const latest = await fetchInvitationById(invitationId, 1, 0);
        if (latest && latest.game_id) return latest.game_id;
        // try resolving from related data as fallback
        const sess = await supabase.auth.getSession();
        const currentUserId = sess?.data?.session?.user?.id;
        const maybe = await resolveGameIdFromInvitation(latest, currentUserId);
        if (maybe) return maybe;
      } catch (e) {
        dbgLog('waitForGameId loop error', e);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  // Resolve game_id from series -> parties -> games if invitation row doesn't have it
  async function resolveGameIdFromInvitation(rec, currentUserId) {
    try {
      if (!rec) return null;
      if (rec.game_id) return rec.game_id;
      if (!rec.series_id) return null;

      dbgLog('resolveGameIdFromInvitation: looking up parties for series', rec.series_id);

      const { data: parties, error: partiesErr } = await supabase
        .from('parties')
        .select('id')
        .eq('series_id', rec.series_id)
        .order('created_at', { ascending: false })
        .limit(10);

      dbgLog('resolveGameIdFromInvitation parties result', { parties, partiesErr });
      if (partiesErr || !Array.isArray(parties) || parties.length === 0) return null;

      const partyIds = parties.map(p => p.id);

      const { data: games, error: gamesErr } = await supabase
        .from('games')
        .select('id,party_id,owner_id,opponent_id,created_at')
        .in('party_id', partyIds)
        // accept multiple possible statuses (plus robuste)
        .in('status', ['playing', 'active', 'started', 'in_progress'])
        .order('created_at', { ascending: false })
        .limit(10);
      dbgLog('resolveGameIdFromInvitation games result', { games, gamesErr });
      if (gamesErr || !Array.isArray(games) || games.length === 0) return null;

      if (currentUserId) {
        const candidate = games.find(g => String(g.owner_id) === String(currentUserId) || String(g.opponent_id) === String(currentUserId));
        if (candidate && candidate.id) return candidate.id;
      }

      return games[0]?.id ?? null;
    } catch (e) {
      dbgLog('resolveGameIdFromInvitation exception', e);
      return null;
    }
  }

  // ---------------------------
  // Polling fallback utilities
  // ---------------------------
  function pollInvitationUntilFinal(invId, onFinal, intervalMs = 1500, timeoutMs = 60_000) {
    let stopped = false;
    let elapsed = 0;
    let timer = null;

    async function tick() {
      if (stopped) return;
      try {
        const { data } = await supabase.from('game_invitations').select('*').eq('id', invId).maybeSingle();
        if (data && data.status && data.status !== 'pending') {
          onFinal(data);
          stop();
          return;
        }
      } catch (e) {
        dbgLog('pollInvitationUntilFinal fetch error', e);
      }
      elapsed += intervalMs;
      if (elapsed >= timeoutMs) {
        stop();
        return;
      }
      timer = setTimeout(tick, intervalMs);
    }

    timer = setTimeout(tick, intervalMs);

    function stop() {
      stopped = true;
      try { if (timer) clearTimeout(timer); } catch (_) {}
    }

    return { stop };
  }

  function startPollingPendingInvitationsForUser(userId, onNewCallback, intervalMs = 2000) {
    let stopped = false;
    let timer = null;
    const seen = new Set();

    async function poll() {
      if (stopped) return;
      try {
        const { data: pending } = await supabase
          .from('game_invitations')
          .select('*')
          .eq('invitee_id', userId)
          .eq('status', 'pending');
        if (Array.isArray(pending)) {
          for (const rec of pending) {
            if (!seen.has(rec.id)) {
              seen.add(rec.id);
              onNewCallback(rec);
            }
          }
        }
      } catch (e) {
        dbgLog('startPollingPendingInvitationsForUser error', e);
      }
      timer = setTimeout(poll, intervalMs);
    }

    timer = setTimeout(poll, 50);
    return {
      stop: () => {
        stopped = true;
        try { if (timer) clearTimeout(timer); } catch (_) {}
      }
    };
  }

  // ---------------------------
  // NEW: spinner + ensureAcceptedAndRedirect
  // ---------------------------
  function showSimpleSpinner(message = 'Patientez...') {
    const overlay = createOverlay();
    const card = document.createElement('div');
    card.style.background = '#fff';
    card.style.padding = '12px 18px';
    card.style.borderRadius = '8px';
    card.style.minWidth = '220px';
    card.style.textAlign = 'center';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.alignItems = 'center';

    const spinner = document.createElement('div');
    spinner.innerHTML = '<div style="margin:8px auto 6px;width:36px;height:36px;border-radius:50%;border:3px solid #ccc;border-top-color:#333;animation:spin 1s linear infinite"></div>';
    const cssId = 'taktik-spinner-style';
    if (!document.getElementById(cssId)) {
      const css = document.createElement('style');
      css.id = cssId;
      css.textContent = `@keyframes spin{to{transform:rotate(360deg)}}`;
      document.head.appendChild(css);
    }

    const txt = document.createElement('div');
    txt.textContent = message;
    txt.style.marginTop = '6px';
    txt.style.fontSize = '14px';

    card.appendChild(spinner);
    card.appendChild(txt);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    return {
      close: () => {
        try { overlay.remove(); } catch (_) {}
      }
    };
  }

  // dbgAlert: show visible alert when dbg true, else log
  function dbgAlert(msg) {
    if (dbg) {
      try { alert('DBG: ' + msg); } catch (e) { dbgLog('cannot show alert', e); }
    } else {
      dbgLog(msg);
    }
  }

  // Ensure invitation is accepted before redirecting. Shows spinner while waiting.
  async function ensureAcceptedAndRedirect(invitationId, initialGameId = null) {
    const spinner = showSimpleSpinner('Attente confirmation de la partie...');
    try {
      const timeoutMs = 65_000;
      const intervalMs = 800;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const rec = await fetchInvitationById(invitationId, 1, 0);
        if (!rec) {
          dbgLog('ensureAcceptedAndRedirect: invitation non trouvée, ré-essai');
          await new Promise(r => setTimeout(r, intervalMs));
          continue;
        }

        dbgLog('ensureAcceptedAndRedirect: invitation row', rec);

        if (rec.status === 'accepted') {
          // obtain game_id if any (try rec, then initial, then wait/resolution)
          let finalGameId = rec.game_id ?? initialGameId ?? null;

          if (!finalGameId) {
            dbgLog('accepted mais pas de game_id — attente courte pour DB update / fallback resolve');
            finalGameId = await waitForGameId(invitationId, 5000, 500);
          }

          if (!finalGameId) {
            try {
              const sess = await supabase.auth.getSession();
              const currentUserId = sess?.data?.session?.user?.id;
              finalGameId = await resolveGameIdFromInvitation(rec, currentUserId);
            } catch (e) {
              dbgLog('resolveGameIdFromInvitation erreur', e);
            }
          }

          dbgAlert(finalGameId ? `Invitation acceptée — game_id reçu: ${finalGameId}` : 'Invitation acceptée — aucun game_id reçu');

          // ---------- PATCH A (create_game.js) ----------
if (finalGameId) {
  // redirection directe si on a l'id de la partie
  window.location.href = `game.html?game_id=${encodeURIComponent(finalGameId)}`;
} else {
  // IMPORTANT: si on n'a pas de game_id, passer l'invitation_id pour que game.js
  // puisse la résoudre / poller et trouver la partie dès qu'elle est créée.
  // on ajoute aussi from_invite=1 pour rendre explicite le cas "arrivé depuis invitation".
  window.location.href = `game.html?invitation_id=${encodeURIComponent(invitationId)}&from_invite=1`;
}
          return;
        } else if (['declined', 'cancelled', 'expired'].includes(rec.status)) {
          dbgAlert(`Invitation terminée avec status "${rec.status}" — aucune redirection.`);
          return;
        } else {
          // still pending: wait and loop
          await new Promise(r => setTimeout(r, intervalMs));
        }
      }

      // timeout
      dbgAlert('Temps d\'attente pour acceptation expiré (timeout). Aucune redirection effectuée.');
      return;
    } catch (e) {
      dbgLog('ensureAcceptedAndRedirect erreur', e);
    } finally {
      try { spinner.close(); } catch (_) {}
    }
  }

  // ---------------------------
  // join/redirect helper (kept minimal for direct redirect usage if ever needed)
  // ---------------------------
  function redirectToGameId(gameId) {
    if (gameId) {
      window.location.href = `game.html?game_id=${encodeURIComponent(gameId)}`;
    } else {
      window.location.href = 'game.html';
    }
  }

  // centralized cleanup for outgoing object (improved robustness)
  async function cleanupOutgoingObject(obj) {
    try {
      if (!obj) return;
      try { if (obj.waiter) obj.waiter.close(); } catch (_) {}
      try { if (obj.expiryTimer) clearTimeout(obj.expiryTimer); } catch (_) {}
      try { if (obj.poller && typeof obj.poller.stop === 'function') obj.poller.stop(); } catch (e) { dbgLog('cleanupOutgoingObject poller stop error', e); }

      if (obj.chan) {
        try {
          if (typeof supabase.removeChannel === 'function') {
            dbgLog('cleanupOutgoingObject: removeChannel attempt');
            try { supabase.removeChannel(obj.chan); } catch (e) { dbgLog('removeChannel inner error', e); }
          }
        } catch (e) {
          dbgLog('cleanupOutgoingObject removeChannel check failed', e);
        }

        try {
          if (typeof obj.chan.unsubscribe === 'function') {
            dbgLog('cleanupOutgoingObject: chan.unsubscribe attempt');
            await obj.chan.unsubscribe();
          }
        } catch (e) {
          dbgLog('cleanupOutgoingObject chan.unsubscribe failed', e);
        }
      }
    } catch (e) {
      dbgLog('cleanupOutgoingObject exception', e);
    }
  }

  const incomingOverlays = new Map(); // id -> overlay instance
  const outgoingWaiters = new Map(); // id -> { waiter, expiryTimer, chan, poller }
  const activeChannels = new Set(); // channels for cleanup

  let incomingPoller = null; // fallback poller for incoming subscriptions

  // Robust get user with retry (fixes race where auth session not ready)
  async function getCurrentUserWithRetry(maxAttempts = 8, delayMs = 250) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const s = await supabase.auth.getSession();
        const user = s?.data?.session?.user;
        if (user) return user;
      } catch (e) {
        dbgLog('getSession try failed', e);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
  }

  // ---------------------------
  // sendInvitation (inviter)
  // ---------------------------
  async function sendInvitation(inviteeId, message = '') {
    try {
      const sess = await supabase.auth.getSession();
      const user = sess?.data?.session?.user;
      dbgLog('sendInvitation session user', user?.id);

      if (!user) {
        alert('Tu dois être connecté pour inviter.');
        return;
      }

      // 1) create series/party/game via RPC
      const { data: rpcRaw, error: rpcErr } = await supabase.rpc('rpc_create_series_and_first_party', {
        p_opponent_id: inviteeId,
        p_target_parties: 3,
        p_target_games: 3
      });

      dbgLog('rpc_create_series_and_first_party response', { rpcRaw, rpcErr });
      if (rpcErr) {
        err('create series/party/game RPC failed', rpcErr);
        alert('Impossible de créer la série / partie (serveur).');
        return;
      }

      // extract IDs defensively
      let seriesId = null;
      let gameId = null;
      try {
        if (Array.isArray(rpcRaw) && rpcRaw.length > 0) {
          seriesId = rpcRaw[0].series_id ?? rpcRaw[0].s_id ?? null;
          gameId = rpcRaw[0].game_id ?? rpcRaw[0].g_id ?? null;
        } else if (rpcRaw && typeof rpcRaw === 'object') {
          seriesId = rpcRaw.series_id ?? rpcRaw.s_id ?? null;
          gameId = rpcRaw.game_id ?? rpcRaw.g_id ?? null;
        }
      } catch (e) {
        dbgLog('extract rpc result error', e);
      }

      if (!seriesId) {
        err('RPC did not return series_id (unexpected).', null);
        alert('Erreur serveur : impossible d\'obtenir series_id.');
        return;
      }

      // 2) insert invitation row
      const expiresAt = new Date(Date.now() + 45 * 1000).toISOString();
      const { data: inv, error: invErr } = await supabase.from('game_invitations').insert({
        series_id: seriesId,
        game_id: gameId,
        inviter_id: user.id,
        invitee_id: inviteeId,
        message,
        status: 'pending',
        expires_at: expiresAt
      }).select().single();

      dbgLog('create invitation response', { inv, invErr });
      if (invErr || !inv) {
        err('create invitation error', invErr);
        alert('Impossible d\'envoyer l\'invitation.');
        return;
      }

      // small friendly name lookup
      let inviteePseudo = null;
      try {
        const { data: profile } = await supabase.from('user_profiles').select('pseudo').eq('id', inviteeId).maybeSingle();
        inviteePseudo = profile?.pseudo || null;
      } catch (_) { /* ignore */ }

      // show waiting overlay + manage lifecycle
      const waiter = showWaitingOverlay({ invitee_id: inviteeId, invitee_pseudo: inviteePseudo }, async (reason) => {
        try {
          if (reason === 'cancelled' || reason === 'expired') {
            const newStatus = reason === 'expired' ? 'expired' : 'cancelled';
            try {
              const { data: u, error: ue } = await supabase.from('game_invitations').update({ status: newStatus }).eq('id', inv.id).select().single();
              dbgLog('inv update after cancel/expire', { u, ue });
            } catch (e) {
              dbgLog('inv update after cancel/expire failed', e);
            }
          }
        } catch (e) {
          console.error('waiter onCancelCallback error', e);
        }
      });

      const waiterObj = { waiter, expiryTimer: null, chan: null, poller: null };
      outgoingWaiters.set(inv.id, waiterObj);

      // immediate fresh check (catch very-fast responses)
      try {
        const { data: fresh, error: freshErr } = await supabase.from('game_invitations').select('*').eq('id', inv.id).maybeSingle();
        dbgLog('immediate invitation fresh check', { fresh, freshErr });

        if (fresh && fresh.status && fresh.status !== 'pending') {
          // cleanup local waiter
          const stored = outgoingWaiters.get(fresh.id);
          if (stored) {
            await cleanupOutgoingObject(stored);
          }
          outgoingWaiters.delete(fresh.id);

          if (fresh.status === 'accepted') {
            const latest = await fetchInvitationById(fresh.id, 6, 200) || fresh;
            let targetGameId = latest.game_id;
            if (!targetGameId) {
              targetGameId = await resolveGameIdFromInvitation(latest, user.id);
            }

            // NEW: ensure we only redirect after status accepted (even if brief wait)
            await ensureAcceptedAndRedirect(fresh.id, targetGameId);
          } else {
            info('Invitation terminée : ' + fresh.status);
          }
          return;
        }
      } catch (e) {
        dbgLog('immediate fresh check exception', e);
      }

      // SUBSCRIBE to updates for this invitation (outgoing)
      const chan = supabase.channel(`invitations:out:${inv.id}`);

      async function handleOutgoingAccepted(rec) {
        try {
          const latest = await fetchInvitationById(rec.id, 6, 250);
          const finalRec = latest || rec;

          // cleanup waiter and channel
          const stored = outgoingWaiters.get(rec.id);
          if (stored) {
            await cleanupOutgoingObject(stored);
          }
          outgoingWaiters.delete(rec.id);

          let finalGameId = finalRec.game_id ?? null;
          if (!finalGameId) {
            const sess2 = await supabase.auth.getSession();
            const currentUser = sess2?.data?.session?.user;
            finalGameId = await resolveGameIdFromInvitation(finalRec, currentUser?.id);
          }

          if (!finalGameId) {
            dbgLog('handleOutgoingAccepted: game_id manquant, attente courte pour DB update');
            finalGameId = await waitForGameId(finalRec.id, 5000, 500);
          }

          // NEW: always ensure status accepted before redirect
          await ensureAcceptedAndRedirect(finalRec.id, finalGameId);
        } catch (e) {
          console.error('handleOutgoingAccepted error', e);
        }
      }

      // defensive logging in handlers
      chan.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'game_invitations', filter: `id=eq.${inv.id}` }, async payload => {
        dbgLog('outgoing invitation UPDATE payload', payload);
        const rec = payload?.new;
        if (!rec) return;

        if (rec.status === 'accepted') {
          await handleOutgoingAccepted(rec);
        } else if (['declined', 'cancelled', 'expired'].includes(rec.status)) {
          const w = outgoingWaiters.get(rec.id);
          if (w) {
            try { await cleanupOutgoingObject(w); } catch(_) {}
          }
          outgoingWaiters.delete(rec.id);
          info('Invitation terminée : ' + rec.status);
        }
      });

      chan.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_invitations', filter: `id=eq.${inv.id}` }, async payload => {
        dbgLog('outgoing invitation INSERT payload', payload);
        const rec = payload?.new;
        if (!rec) return;
        if (rec.status === 'accepted') {
          await handleOutgoingAccepted(rec);
        } else if (['declined', 'cancelled', 'expired'].includes(rec.status)) {
          const w = outgoingWaiters.get(rec.id);
          if (w) {
            try { await cleanupOutgoingObject(w); } catch(_) {}
          }
          outgoingWaiters.delete(rec.id);
          info('Invitation terminée : ' + rec.status);
        }
      });

      activeChannels.add(chan);
      waiterObj.chan = chan;

      // try/catch subscribe and log result (mobile webviews sometimes block WS)
      try {
        const subRes = await chan.subscribe();
        dbgLog('outgoing channel subscribe result', subRes);
        const subscribed = (subRes && (subRes.status === 'SUBSCRIBED' || subRes === 'ok' || subRes === 'OK'));
        if (!subscribed) {
          dbgLog('outgoing subscription not subscribed — using polling fallback for', inv.id);
          const poller = pollInvitationUntilFinal(inv.id, async (finalRec) => {
            try {
              const stored = outgoingWaiters.get(finalRec.id);
              if (stored) {
                await cleanupOutgoingObject(stored);
              }
              outgoingWaiters.delete(finalRec.id);

              let finalGameId = finalRec.game_id;
              if (!finalGameId) {
                const sess2 = await supabase.auth.getSession();
                const currentUser = sess2?.data?.session?.user;
                finalGameId = await resolveGameIdFromInvitation(finalRec, currentUser?.id);
              }

              // NEW: ensure accepted before redirect
              await ensureAcceptedAndRedirect(finalRec.id, finalGameId);
            } catch (e) {
              console.error('poller finalRec handler error', e);
            }
          }, 1200, 65_000);
          waiterObj.poller = poller;
        }
      } catch (e) {
        dbgLog('outgoing channel subscribe failed', e);
        // subscribe failed — fallback to polling
        const poller = pollInvitationUntilFinal(inv.id, async (finalRec) => {
          try {
            const stored = outgoingWaiters.get(finalRec.id);
            if (stored) {
              await cleanupOutgoingObject(stored);
            }
            outgoingWaiters.delete(finalRec.id);

            let finalGameId = finalRec.game_id;
            if (!finalGameId) {
              const sess2 = await supabase.auth.getSession();
              const currentUser = sess2?.data?.session?.user;
              finalGameId = await resolveGameIdFromInvitation(finalRec, currentUser?.id);
            }

            // NEW: ensure accepted before redirect
            await ensureAcceptedAndRedirect(finalRec.id, finalGameId);
          } catch (e) {
            console.error('poller finalRec handler error (catch)', e);
          }
        }, 1200, 65_000);
        waiterObj.poller = poller;
      }

      // safety client-side timeout: expire locally and mark server-side expired
      const expiryTimer = setTimeout(async () => {
        try {
          const { data: fresh, error: freshErr } = await supabase.from('game_invitations').select('*').eq('id', inv.id).maybeSingle();
          dbgLog('invitation refresh', { fresh, freshErr });

          if (fresh && fresh.status === 'pending') {
            const { data: up, error: upErr } = await supabase.from('game_invitations').update({ status: 'expired' }).eq('id', inv.id).select().single();
            dbgLog('inv auto-expire result', { up, upErr });

            const stored = outgoingWaiters.get(inv.id);
            if (stored) {
              await cleanupOutgoingObject(stored);
            }
            outgoingWaiters.delete(inv.id);
          }
        } catch (e) {
          console.error('sendInvitation timeout refresh exception', e);
        }
      }, 45 * 1000);
      waiterObj.expiryTimer = expiryTimer;

    } catch (e) {
      console.error('sendInvitation outer exception', e);
      alert('Erreur lors de l\'envoi de l\'invitation.');
    }
  }

  // ---------------------------
  // showIncoming (invitee side)
  // ---------------------------
  async function showIncoming(record) {
    try {
      if (!record || !record.id) return;
      if (incomingOverlays.has(record.id)) return;

      // Ensure inviter pseudo
      let inviter_pseudo = record.inviter_pseudo;
      if (!inviter_pseudo && record.inviter_id) {
        try {
          const { data } = await supabase.from('user_profiles').select('pseudo').eq('id', record.inviter_id).maybeSingle();
          inviter_pseudo = data?.pseudo || null;
        } catch (e) {
          dbgLog('failed fetching inviter pseudo', e);
        }
      }

      const rec = { ...record, inviter_pseudo };
      const remainingSeconds = computeRemainingSeconds(rec.expires_at);

      const overlayInst = showIncomingOverlay(rec, async (decision) => {
        try {
          if (decision === 'accepted') {
            const { data: acceptData, error: acceptErr } = await supabase.rpc('rpc_accept_invitation', { p_invitation_id: rec.id });
            dbgLog('rpc_accept_invitation result', { acceptData, acceptErr });

            if (acceptErr) {
              console.error('Failed to accept invitation via RPC', acceptErr);
              alert('Impossible d\'accepter l\'invitation (serveur).');
            } else {
              // Try to get latest invitation row (RPC may return game_id but ensure DB row updated)
              const latest = await fetchInvitationById(rec.id, 6, 200);
              let targetGameId = latest?.game_id ?? null;

              // extraction défensive depuis RPC / DB
              if (!targetGameId) {
                try {
                  if (Array.isArray(acceptData) && acceptData.length > 0) {
                    targetGameId = acceptData[0]?.game_id ?? acceptData[0]?.gameid ?? acceptData[0]?.g_id ?? null;
                  } else if (acceptData && typeof acceptData === 'object') {
                    targetGameId = acceptData?.game_id ?? acceptData?.gameid ?? acceptData?.g_id ?? null;
                  }
                } catch (e) { dbgLog('extract acceptData error', e); }
              }

              // si toujours pas, attendre un court moment pour que la DB soit mise à jour
              if (!targetGameId) {
                dbgLog('Pas encore de game_id après accept — attente courte pour DB update');
                targetGameId = await waitForGameId(rec.id, 5000, 500);
              }

              // fallback final: essayer de résoudre via parties/series si on a une ligne latest
              if (!targetGameId && latest) {
                try {
                  targetGameId = await resolveGameIdFromInvitation(latest, (await supabase.auth.getSession()).data?.session?.user?.id);
                } catch (e) {
                  dbgLog('resolveGameIdFromInvitation (fallback) error', e);
                }
              }

              // NEW: ensure status accepted before redirect (and show spinner + dbg alert about game_id)
              await ensureAcceptedAndRedirect(rec.id, targetGameId);
            }
          } else if (decision === 'declined') {
            const { data: d, error: derr } = await supabase.from('game_invitations').update({ status: 'declined' }).eq('id', rec.id).select().single();
            dbgLog('decline invitation update', { d, derr });
          } else if (decision === 'expired') {
            const { data: eD, error: eErr } = await supabase.from('game_invitations').update({ status: 'expired' }).eq('id', rec.id).select().single();
            dbgLog('expire invitation update', { eD, eErr });
          }
        } catch (e) {
          console.error('showIncoming decision error', e);
        } finally {
          try { incomingOverlays.delete(rec.id); } catch (e) { /* ignore */ }
        }
      }, remainingSeconds);

      if (overlayInst && remainingSeconds > 0) {
        incomingOverlays.set(rec.id, overlayInst);
      } else if (remainingSeconds <= 0) {
        // ensure server marks expired
        try {
          await supabase.from('game_invitations').update({ status: 'expired' }).eq('id', rec.id).select().single();
        } catch (e) { dbgLog('auto-expire write error', e); }
      }
    } catch (e) {
      console.error('showIncoming exception', e);
    }
  }

  // ---------------------------
  // subscribeIncomingInvitations
  // ---------------------------
  let incomingChannel = null;
  let currentSubscribeUserId = null;
  async function subscribeIncomingInvitations() {
    try {
      // use retry to get current user reliably
      const user = await getCurrentUserWithRetry();
      dbgLog('subscribeIncomingInvitations session', user?.id);
      if (!user) {
        dbgLog('subscribeIncomingInvitations: no user available, will not subscribe now.');
        return;
      }

      // if already subscribed for this user, skip
      if (incomingChannel && currentSubscribeUserId === user.id) {
        dbgLog('already subscribed to incoming for', user.id);
        return;
      }

      // cleanup previous channel if different
      if (incomingChannel) {
        try { 
          dbgLog('unsubscribe prev incomingChannel');
          await incomingChannel.unsubscribe(); 
        } catch (e) { dbgLog('unsubscribe prev incomingChannel', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(incomingChannel); } catch(e){ dbgLog('removeChannel prev incomingChannel', e); }
        activeChannels.delete(incomingChannel);
        incomingChannel = null;
        currentSubscribeUserId = null;
      }

      // initial fetch of pending invitations
      try {
        const { data: pending, error: pendingErr } = await supabase
          .from('game_invitations')
          .select('*')
          .eq('invitee_id', user.id)
          .eq('status', 'pending');
        dbgLog('initial pending invitations', pending, pendingErr);
        if (!pendingErr && Array.isArray(pending)) {
          for (const rec of pending) {
            await showIncoming(rec);
          }
        }
      } catch (e) {
        console.error('failed initial fetch pending invitations', e);
      }

      // subscribe to INSERT and UPDATE for this user
      incomingChannel = supabase.channel(`invitations:incoming:${user.id}`);

      incomingChannel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_invitations', filter: `invitee_id=eq.${user.id}` }, payload => {
        dbgLog('incoming invitation INSERT payload', payload);
        const rec = payload?.new;
        if (rec && rec.status === 'pending') {
          if (!incomingOverlays.has(rec.id)) {
            showIncoming(rec);
          }
        }
      });

      incomingChannel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'game_invitations', filter: `invitee_id=eq.${user.id}` }, payload => {
        dbgLog('incoming invitation UPDATE payload', payload);
        const rec = payload?.new;
        if (!rec) return;
        const inst = incomingOverlays.get(rec.id);
        if (inst) {
          if (rec.expires_at && typeof inst.updateRemaining === 'function') {
            const remaining = computeRemainingSeconds(rec.expires_at);
            inst.updateRemaining(remaining);
          }
          if (rec.status && rec.status !== 'pending') {
            try { inst.close(); } catch (e) { /* ignore */ }
            incomingOverlays.delete(rec.id);
            if (rec.status === 'accepted') {
              info('Invitation acceptée');
            } else if (['declined', 'cancelled', 'expired'].includes(rec.status)) {
              info('Invitation terminée : ' + rec.status);
            }
          }
        } else {
          // no overlay open - nothing to do
        }
      });

      activeChannels.add(incomingChannel);
      currentSubscribeUserId = user.id;

      try {
        const subRes = await incomingChannel.subscribe();
        dbgLog('incomingChannel subscribe result', subRes);
        const subscribed = (subRes && (subRes.status === 'SUBSCRIBED' || subRes === 'ok' || subRes === 'OK'));
        if (!subscribed) {
          dbgLog('incomingChannel not subscribed — enabling polling fallback');
          // start polling fallback
          if (incomingPoller && typeof incomingPoller.stop === 'function') {
            try { incomingPoller.stop(); } catch (_) {}
            incomingPoller = null;
          }
          incomingPoller = startPollingPendingInvitationsForUser(user.id, rec => {
            if (!incomingOverlays.has(rec.id)) showIncoming(rec);
          }, 2000);
        } else {
          // stop any previous incoming poller
          try { if (incomingPoller && typeof incomingPoller.stop === 'function') { incomingPoller.stop(); incomingPoller = null; } } catch (_) {}
        }
      } catch (e) {
        dbgLog('incomingChannel.subscribe failed', e);
        // start polling fallback
        if (incomingPoller && typeof incomingPoller.stop === 'function') {
          try { incomingPoller.stop(); } catch (_) {}
          incomingPoller = null;
        }
        incomingPoller = startPollingPendingInvitationsForUser(user.id, rec => {
          if (!incomingOverlays.has(rec.id)) showIncoming(rec);
        }, 2000);
      }

      dbgLog('subscribeIncomingInvitations subscribed');
    } catch (e) {
      console.error('subscribeIncomingInvitations', e);
    }
  }

  // ---------------------------
  // NEW: handle auth state + visibility to ensure invitee receives invitations
  // ---------------------------
  function ensureVisibilityAndAuthHandlers() {
    // safety: only define once
    if (window.__taktik_visibility_auth_handlers_installed) return;
    window.__taktik_visibility_auth_handlers_installed = true;

    // When auth state changes, resubscribe if logged in, or cleanup if logged out
    try {
      if (typeof supabase.auth.onAuthStateChange === 'function') {
        supabase.auth.onAuthStateChange(async (event, session) => {
          dbgLog('auth state changed', event);
          try {
            if (session && session.user) {
              // small delay to ensure session propagation
              setTimeout(() => {
                subscribeIncomingInvitations().catch(e => dbgLog('subscribe after auth change failed', e));
              }, 120);
            } else {
              // logged out: cleanup channels & overlays
              try {
                if (incomingChannel) {
                  try { incomingChannel.unsubscribe(); } catch (e) { dbgLog('incomingChannel.unsubscribe on signout', e); }
                  try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(incomingChannel); } catch(e){ dbgLog('removeChannel incomingChannel on signout', e); }
                }
                incomingChannel = null;
                currentSubscribeUserId = null;
              } catch (e) { dbgLog('cleanup on signout error', e); }
            }
          } catch (e) {
            dbgLog('onAuthStateChange handler error', e);
          }
        });
      }
    } catch (e) {
      dbgLog('ensureVisibilityAndAuthHandlers auth.onAuthStateChange check failed', e);
    }

    // On visibility change, if tab becomes visible, attempt to resubscribe to incoming invitations
    try {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          dbgLog('document visible -> try resubscribe incoming invitations');
          subscribeIncomingInvitations().catch(e => dbgLog('subscribe on visibilitychange failed', e));
        }
      });
    } catch (e) {
      dbgLog('visibilitychange handler install failed', e);
    }

    // also try to re-subscribe once when the script loads (safe no-op if already subscribed)
    setTimeout(() => {
      subscribeIncomingInvitations().catch(e => dbgLog('initial subscribeIncomingInvitations failed (from ensureVisibilityAndAuthHandlers)', e));
    }, 200);
  }

  // cleanup on unload
  async function cleanupAll() {
    try {
      if (incomingChannel) {
        try { await incomingChannel.unsubscribe(); } catch (e) { dbgLog('incomingChannel unsubscribe on cleanup', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(incomingChannel); } catch(e){ dbgLog('incomingChannel removeChannel on cleanup', e); }
        activeChannels.delete(incomingChannel);
        incomingChannel = null;
      }
    } catch (e) { /* ignore */ }

    try {
      for (const ch of Array.from(activeChannels)) {
        try {
          if (ch && typeof ch.unsubscribe === 'function') await ch.unsubscribe();
        } catch (e) { dbgLog('activeChannels unsubscribe error', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(ch); } catch(e) { dbgLog('activeChannels removeChannel error', e); }
        activeChannels.delete(ch);
      }
    } catch (e) { /* ignore */ }

    try {
      for (const inst of incomingOverlays.values()) {
        try { inst.close(); } catch (_) {}
      }
      incomingOverlays.clear();
    } catch (e) { /* ignore */ }

    try {
      for (const [id, inst] of outgoingWaiters.entries()) {
        try { await cleanupOutgoingObject(inst); } catch (_) {}
      }
      outgoingWaiters.clear();
    } catch (e) { /* ignore */ }

    try {
      if (incomingPoller && typeof incomingPoller.stop === 'function') {
        incomingPoller.stop();
        incomingPoller = null;
      }
    } catch (e) { dbgLog('incomingPoller stop error', e); }
  }

  window.addEventListener('beforeunload', cleanupAll);
  window.addEventListener('pagehide', cleanupAll);

  // Start subscription
  subscribeIncomingInvitations().catch(e => {
    console.error('subscribeIncomingInvitations top-level catch', e);
  });

  // ensure auth+visibility handlers installed (this was missing and caused the init to crash)
  try { ensureVisibilityAndAuthHandlers(); } catch (e) { dbgLog('ensureVisibilityAndAuthHandlers call failed', e); }

  // Expose for debugging / programmatic use
  window.taktikCreateGame = {
    sendInvitation,
    searchProfiles,
    _incomingOverlays: incomingOverlays,
    _outgoingWaiters: outgoingWaiters,
    _activeChannels: activeChannels,
    _forceResubscribe: subscribeIncomingInvitations
  };

  dbgLog('create_game initialized', new Date().toISOString());
}
