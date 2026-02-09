// game.js
// Initialise l'UI de la partie, gère rendu du plateau, abonnement aux events,
// et envoie de coups via RPC rpc_place_move.
//
// Usage: import initGame from './game.js'; initGame(window.supabase);
// game.html importe dynamiquement et appelle la fonction exportée.

export default async function initGame(supabaseClient) {
  const supabase = supabaseClient ?? window.supabase;
  const dbg = true;
  function dbgLog(...args) { if (dbg) console.debug('DBG game:', ...args); }
  function info(msg) { console.info('game:', msg); }
  function warn(msg) { console.warn('game:', msg); }
  function err(msg, e) { console.error('game:', msg, e); }

  if (!supabase) {
    console.warn('game.js: supabase client introuvable (window.supabase ou param).');
    return;
  }

  // Constants same as RPC side
  const ROWS = 20;
  const COLS = 20;
  const WINLEN = 5;
  const BOARD_SIZE = ROWS * COLS;

  // DOM anchors
  const boardGrid = document.getElementById('boardGrid');
  const currentTurnEl = document.getElementById('currentTurn');
  const scoreXEl = document.getElementById('scoreX');
  const scoreOEl = document.getElementById('scoreO');

  // Local state
  let gameId = null;
  let invitationId = null;
  let fromInvite = false;
  let state = {
    gameId: null,
    hostId: null,
    opponentId: null,
    board: new Array(BOARD_SIZE).fill(null),
    status: null,
    currentTurn: null,
    moveCount: 0,
    winner: null
  };
  let myUserId = null;
  let subscriptions = [];
  let placingLock = false; // prevent double submission

  // Expose getState for game.html (updatePlayerStatsOnce uses it)
  window.taktikGame = window.taktikGame || {};
  window.taktikGame.getState = () => ({ ...state, gameId });

  // Helpers --------------------------------------------------------------
  function qs(name) {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  }

  function posFromCoords(r, c) { return r * COLS + c; }

  function indexToRC(idx) {
    const r = Math.floor(idx / COLS);
    const c = idx % COLS;
    return { r, c };
  }

  function setTurn(t) {
    state.currentTurn = t;
    if (currentTurnEl) currentTurnEl.textContent = t ?? '—';
  }

  function setScores(x, o) {
    if (scoreXEl) scoreXEl.textContent = String(x ?? 0);
    if (scoreOEl) scoreOEl.textContent = String(o ?? 0);
  }

  // Board render/update -------------------------------------------------
  function ensureCells() {
    if (!boardGrid) return;
    if (boardGrid.children.length === BOARD_SIZE) return;
    boardGrid.innerHTML = '';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'board-cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.dataset.idx = posFromCoords(r, c);
        cell.style.cursor = 'pointer';
        boardGrid.appendChild(cell);
      }
    }
  }

  function renderFullBoard() {
    ensureCells();
    for (let idx = 0; idx < BOARD_SIZE; idx++) {
      const val = state.board[idx];
      const { r, c } = indexToRC(idx);
      const cell = boardGrid.querySelector(`.board-cell[data-idx="${idx}"]`);
      if (!cell) continue;
      // use global helper to set piece
      window.setPieceInCell(cell, val ?? null);
    }
  }

  function applyMoveLocally(move) {
    // move: { position, row_index, col_index, player }
    try {
      const idx = Number(move.position ?? move.position ?? posFromCoords(move.row_index, move.col_index));
      if (isNaN(idx) || idx < 0 || idx >= BOARD_SIZE) return;
      state.board[idx] = move.player;
      state.moveCount = (state.moveCount || 0) + 1;
      // render single cell
      const cell = boardGrid.querySelector(`.board-cell[data-idx="${idx}"]`);
      if (cell) window.setPieceInCell(cell, move.player);
    } catch (e) {
      dbgLog('applyMoveLocally error', e);
    }
  }

  // Resolve invitation -> game_id (similar strategy as create_game.js)
  async function fetchInvitation(invId) {
    try {
      const { data, error } = await supabase.from('game_invitations').select('*').eq('id', invId).maybeSingle();
      if (error) dbgLog('fetchInvitation error', error);
      return data ?? null;
    } catch (e) {
      dbgLog('fetchInvitation exception', e);
      return null;
    }
  }

  async function resolveGameIdFromInvitation(rec) {
    try {
      if (!rec) return null;
      if (rec.game_id) return rec.game_id;
      if (!rec.series_id) return null;

      // fetch recent parties in series
      const { data: parties, error: partiesErr } = await supabase
        .from('parties')
        .select('id')
        .eq('series_id', rec.series_id)
        .order('created_at', { ascending: false })
        .limit(10);

      if (partiesErr || !Array.isArray(parties) || parties.length === 0) return null;
      const partyIds = parties.map(p => p.id);

      const { data: games, error: gamesErr } = await supabase
        .from('games')
        .select('id,party_id,owner_id,opponent_id,created_at,status')
        .in('party_id', partyIds)
        .in('status', ['playing', 'active', 'started', 'in_progress'])
        .order('created_at', { ascending: false })
        .limit(12);

      if (gamesErr || !Array.isArray(games) || games.length === 0) return null;

      // try to pick game where current user is participant
      if (myUserId) {
        const cand = games.find(g => String(g.owner_id) === String(myUserId) || String(g.opponent_id) === String(myUserId));
        if (cand && cand.id) return cand.id;
      }

      return games[0]?.id ?? null;
    } catch (e) {
      dbgLog('resolveGameIdFromInvitation exception', e);
      return null;
    }
  }

  async function waitForGameIdFromInvite(invId, maxMs = 5000, intervalMs = 400) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const rec = await fetchInvitation(invId);
      if (rec && rec.game_id) return rec.game_id;
      // fallback: try to resolve via series/parties/games
      const maybe = await resolveGameIdFromInvitation(rec);
      if (maybe) return maybe;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  // Fetch game row ------------------------------------------------------
  async function fetchGameRow(gid) {
    try {
      const { data, error } = await supabase
        .from('games')
        .select('id,party_id,owner_id,opponent_id,board,status,current_turn,move_count,winner,updated_at')
        .eq('id', gid)
        .maybeSingle();
      if (error) {
        dbgLog('fetchGameRow error', error);
        return null;
      }
      return data ?? null;
    } catch (e) {
      dbgLog('fetchGameRow exception', e);
      return null;
    }
  }

  function normalizeBoard(boardRaw) {
    // board may be an array, object, or null. Normalize to array[BOARD_SIZE]
    const b = new Array(BOARD_SIZE).fill(null);
    try {
      if (!boardRaw) return b;
      // If array-like
      if (Array.isArray(boardRaw)) {
        for (let i = 0; i < Math.min(boardRaw.length, BOARD_SIZE); i++) {
          const v = boardRaw[i];
          b[i] = (v === null || v === undefined) ? null : String(v);
        }
        return b;
      }
      // If object mapping index -> 'X'/'O'
      if (typeof boardRaw === 'object') {
        for (const k of Object.keys(boardRaw)) {
          const idx = Number(k);
          if (Number.isInteger(idx) && idx >= 0 && idx < BOARD_SIZE) {
            const v = boardRaw[k];
            b[idx] = (v === null || v === undefined) ? null : String(v);
          }
        }
        return b;
      }
      // fallback - try parse if string
      if (typeof boardRaw === 'string') {
        try {
          const parsed = JSON.parse(boardRaw);
          return normalizeBoard(parsed);
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      dbgLog('normalizeBoard error', e);
    }
    return b;
  }

  async function loadAndRenderGame(gid, opts = {}) {
    try {
      const g = await fetchGameRow(gid);
      if (!g) {
        warn('Partie introuvable: ' + gid);
        return false;
      }

      gameId = gid;
      state.gameId = gid;
      state.hostId = g.owner_id;
      state.opponentId = g.opponent_id;
      state.board = normalizeBoard(g.board);
      state.status = g.status;
      state.currentTurn = g.current_turn;
      state.moveCount = g.move_count ?? 0;
      state.winner = g.winner ?? null;

      renderFullBoard();
      setTurn(state.currentTurn);
      // keep scores placeholders (you may compute from parties/games)
      setScores(0, 0);

      // expose for other modules
      window.taktikGame = window.taktikGame || {};
      window.taktikGame.getState = () => ({ ...state, gameId });

      // dispatch event so UI parts can react (game.html listens to this)
      try {
        window.dispatchEvent(new CustomEvent('taktik:joined', { detail: { gameId } }));
      } catch (e) { /* ignore */ }

      return true;
    } catch (e) {
      dbgLog('loadAndRenderGame error', e);
      return false;
    }
  }

  // Subscriptions -------------------------------------------------------
  function addSubscription(obj) {
    subscriptions.push(obj);
  }

  async function subscribeToGameUpdates(gid) {
    try {
      // unsubscribe previous subs
      await cleanupSubscriptions();

      // channel for games updates (status / winner / current_turn)
      const gameChan = supabase.channel(`games:game:${gid}`);
      gameChan.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gid}` }, payload => {
        dbgLog('games UPDATE', payload);
        const newRow = payload?.new;
        if (!newRow) return;
        // update state fields
        state.status = newRow.status;
        state.currentTurn = newRow.current_turn;
        state.winner = newRow.winner ?? null;
        state.moveCount = newRow.move_count ?? state.moveCount;
        setTurn(state.currentTurn);
        if (state.status === 'finished' && state.winner) {
          info('Partie terminée. Winner: ' + state.winner);
        }
      });

      // channel for game_moves inserts
      const movesChan = supabase.channel(`game_moves:game:${gid}`);
      movesChan.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_moves', filter: `game_id=eq.${gid}` }, payload => {
        dbgLog('game_moves INSERT', payload);
        const m = payload?.new;
        if (!m) return;
        // apply and render
        applyMoveLocally({
          position: m.position,
          row_index: m.row_index,
          col_index: m.col_index,
          player: m.player
        });
      });

      // subscribe both
      try {
        const res1 = await gameChan.subscribe();
        dbgLog('gameChan subscribe result', res1);
      } catch (e) {
        dbgLog('gameChan subscribe failed', e);
      }
      try {
        const res2 = await movesChan.subscribe();
        dbgLog('movesChan subscribe result', res2);
      } catch (e) {
        dbgLog('movesChan subscribe failed', e);
      }

      addSubscription(gameChan);
      addSubscription(movesChan);
    } catch (e) {
      dbgLog('subscribeToGameUpdates exception', e);
    }
  }

  async function cleanupSubscriptions() {
    try {
      for (const ch of subscriptions) {
        try {
          if (ch && typeof ch.unsubscribe === 'function') await ch.unsubscribe();
        } catch (e) { dbgLog('unsubscribe error', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(ch); } catch (e) { /* ignore */ }
      }
    } finally {
      subscriptions = [];
    }
  }

  // Place move ----------------------------------------------------------
  async function placeMoveAt(idx, r, c) {
    if (!gameId) {
      alert('Partie non initialisée.');
      return;
    }
    if (placingLock) return;
    // check turn
    if (!state.currentTurn) {
      alert('Tour inconnu.');
      return;
    }

    // if it's not the player's turn, prevent placing
    // we attempt to figure out current user id and whether they are owner/opponent.
    try {
      if (!myUserId) {
        const s = await supabase.auth.getSession();
        myUserId = s?.data?.session?.user?.id ?? null;
      }
    } catch (e) { dbgLog('getSession error', e); }

    const amOwner = myUserId && state.hostId && String(myUserId) === String(state.hostId);
    const amOpponent = myUserId && state.opponentId && String(myUserId) === String(state.opponentId);
    const expectedPlayerSymbol = amOwner ? 'X' : (amOpponent ? 'O' : null);

    // Only allow click if user's symbol matches currentTurn OR if there is no mapping (allow spectating)
    if (expectedPlayerSymbol && expectedPlayerSymbol !== state.currentTurn) {
      alert('Ce n\'est pas ton tour.');
      return;
    }

    // occupied?
    if (state.board[idx]) {
      alert('Cellule déjà occupée.');
      return;
    }

    placingLock = true;
    const spinner = showLocalSpinner('Placement du pion...');
    dbgLog('placing move', { idx, r, c, player: state.currentTurn, gameId });

    try {
      // Call RPC
      const payload = {
        p_game_id: gameId,
        p_position: idx,
        p_row: r,
        p_col: c,
        p_player: state.currentTurn
      };
      const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_place_move', payload);
      dbgLog('rpc_place_move result', { rpcData, rpcErr });

      if (rpcErr) {
        // RPC raised exception (e.g., Cellule occupée / Game terminé / Position incohérente)
        err('rpc_place_move failed', rpcErr);
        alert(rpcErr?.message || 'Erreur serveur lors du placement.');
        return;
      }

      // rpcData can be array or object
      let res = null;
      if (Array.isArray(rpcData) && rpcData.length > 0) res = rpcData[0];
      else if (rpcData && typeof rpcData === 'object') res = rpcData;
      dbgLog('rpc parsed', res);

      // optimistic update: mark board (if not already marked by realtime event)
      state.board[idx] = state.currentTurn;
      state.moveCount = (state.moveCount || 0) + 1;
      renderFullBoard();

      // handle RPC response: aligned_count, game_finished, winner
      const aligned = Number(res?.aligned_count ?? res?.alignedcount ?? res?.best_aligned ?? 0);
      const gameFinished = !!(res?.game_finished ?? res?.gamefinished ?? res?.game_finished);
      const winner = res?.winner ?? res?.winner_uuid ?? null;
      dbgLog('rpc interpreted', { aligned, gameFinished, winner });

      if (gameFinished) {
        // optionally fetch latest game row to sync
        try {
          await loadAndRenderGame(gameId);
        } catch (e) { dbgLog('refresh after finish failed', e); }
        alert('Partie terminée !' + (winner ? ` Gagnant: ${winner}` : ''));
      } else {
        // update current turn locally (RPC updates games row, we will get realtime update)
        state.currentTurn = (state.currentTurn === 'X') ? 'O' : 'X';
        setTurn(state.currentTurn);
      }
    } catch (e) {
      dbgLog('placeMoveAt exception', e);
      alert('Erreur lors du placement.');
    } finally {
      placingLock = false;
      try { spinner.close(); } catch (_) {}
    }
  }

  // UI spinner helper (small overlay)
  function createOverlayEl() {
    const overlay = document.createElement('div');
    overlay.className = 'taktik-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.35)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '99999';
    return overlay;
  }

  function showLocalSpinner(message = 'Patientez...') {
    const overlay = createOverlayEl();
    const card = document.createElement('div');
    card.style.background = '#fff';
    card.style.padding = '14px 18px';
    card.style.borderRadius = '8px';
    card.style.minWidth = '200px';
    card.style.textAlign = 'center';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.alignItems = 'center';
    const spinner = document.createElement('div');
    spinner.innerHTML = '<div style="margin:6px auto;width:36px;height:36px;border-radius:50%;border:3px solid #ccc;border-top-color:#333;animation:spin 1s linear infinite"></div>';
    const cssId = 'taktik-spinner-style-game';
    if (!document.getElementById(cssId)) {
      const css = document.createElement('style');
      css.id = cssId;
      css.textContent = `@keyframes spin{to{transform:rotate(360deg)}}`;
      document.head.appendChild(css);
    }
    const txt = document.createElement('div');
    txt.textContent = message;
    txt.style.marginTop = '8px';
    txt.style.fontSize = '14px';
    card.appendChild(spinner);
    card.appendChild(txt);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return {
      close() { try { overlay.remove(); } catch (e) { /* ignore */ } }
    };
  }

  // Attach click handlers to board (delegation)
  function attachBoardClicks() {
    ensureCells();
    boardGrid.addEventListener('click', (ev) => {
      const cell = ev.target.closest('.board-cell');
      if (!cell) return;
      const idx = Number(cell.dataset.idx);
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      if (isNaN(idx)) return;
      placeMoveAt(idx, r, c).catch(e => dbgLog('placeMoveAt outer catch', e));
    });
  }

  // Initialization sequence: determine game_id (from url or invitation) then load & subscribe
  async function initSequence() {
    try {
      ensureCells();
      attachBoardClicks();

      // try to get session user id
      try {
        const s = await supabase.auth.getSession();
        myUserId = s?.data?.session?.user?.id ?? null;
        dbgLog('session user', myUserId);
      } catch (e) { dbgLog('getSession init error', e); }

      // parse url params
      const gidParam = qs('game_id');
      const invParam = qs('invitation_id');
      const fromInvParam = qs('from_invite');

      if (gidParam) {
        dbgLog('URL contains game_id', gidParam);
        await loadAndRenderGame(gidParam);
        await subscribeToGameUpdates(gidParam);
        return;
      }

      if (invParam) {
        dbgLog('URL contains invitation_id', invParam);
        invitationId = invParam;
        fromInvite = !!fromInvParam;
        // fetch invitation row
        const rec = await fetchInvitation(invitationId);
        if (!rec) {
          warn('Invitation introuvable.');
          return;
        }

        // if invitation already accepted and has game_id, use it
        if (rec.status === 'accepted' && rec.game_id) {
          await loadAndRenderGame(rec.game_id);
          await subscribeToGameUpdates(rec.game_id);
          return;
        }

        // otherwise wait a short while for acceptance / game creation (polling fallback)
        const foundGameId = await waitForGameIdFromInvite(invitationId, 7000, 500);
        if (foundGameId) {
          dbgLog('resolved game_id from invitation', foundGameId);
          await loadAndRenderGame(foundGameId);
          await subscribeToGameUpdates(foundGameId);
          return;
        }

        // still no game_id: we can subscribe to the invitation row to watch updates (so when accepted we can resolve)
        const invChan = supabase.channel(`invite:watch:${invitationId}`);
        invChan.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'game_invitations', filter: `id=eq.${invitationId}` }, async payload => {
          dbgLog('invitation UPDATE payload', payload);
          const newRec = payload?.new;
          if (!newRec) return;
          if (newRec.status === 'accepted') {
            // try to resolve game id
            let resolved = newRec.game_id ?? null;
            if (!resolved) {
              resolved = await waitForGameIdFromInvite(invitationId, 5000, 500);
            }
            if (resolved) {
              await loadAndRenderGame(resolved);
              await subscribeToGameUpdates(resolved);
            } else {
              // final fallback: try to resolve via series
              const maybe = await resolveGameIdFromInvitation(newRec);
              if (maybe) {
                await loadAndRenderGame(maybe);
                await subscribeToGameUpdates(maybe);
              }
            }
            try { invChan.unsubscribe(); } catch (e) { /* ignore */ }
          } else if (['declined', 'expired', 'cancelled'].includes(newRec.status)) {
            info('Invitation terminée: ' + newRec.status);
            try { invChan.unsubscribe(); } catch (e) { /* ignore */ }
          }
        });

        try { await invChan.subscribe(); addSubscription(invChan); } catch (e) { dbgLog('invChan.subscribe failed', e); }
        return;
      }

      // no params: nothing to load (user can create/join from UI)
      dbgLog('Aucun game_id ni invitation_id fourni dans l\'URL — UI en attente.');
    } catch (e) {
      dbgLog('initSequence exception', e);
    }
  }

  // cleanup on unload
  async function cleanupAll() {
    try {
      await cleanupSubscriptions();
    } catch (e) { dbgLog('cleanupAll error', e); }
  }
  window.addEventListener('beforeunload', cleanupAll);
  window.addEventListener('pagehide', cleanupAll);

  // start
  await initSequence();

  // export small API
  return {
    getState: () => ({ ...state, gameId }),
    cleanup: cleanupAll,
    reloadGame: async () => {
      if (gameId) {
        await loadAndRenderGame(gameId);
      }
    }
  };
}
