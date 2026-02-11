// game.js
// Init function exported by défaut.
// Usage: import('./game.js').then(m => m.default(supabase));
export default async function initGame(supabaseClient) {
  const supabase = supabaseClient ?? window.supabase;
  const dbg = false; // passe à true pour logs détaillés
  function dbgLog(...a){ if(dbg) console.debug('DBG game.js:', ...a); }
  function info(msg){ console.info('game.js:', msg); }
  function warn(msg){ console.warn('game.js:', msg); }
  function err(msg,e){ console.error('game.js:', msg, e); }

  if (!supabase) {
    throw new Error('Supabase client introuvable (window.supabase ou param).');
  }

  // CONFIG
  const ROWS = 20;
  const COLS = 20;
  const WINLEN = 5;
  const BOARD_ID = 'boardGrid';
  const POLL_GAME_MS = 2000;
  const POLL_MOVES_MS = 800;

  // STATE
  let gameId = null;
  let invitationId = null;
  let state = {
    board: {}, // { pos_str: 'X'|'O' }
    moveCount: 0,
    currentTurn: null, // 'X'|'O' or null
    status: null,
    ownerId: null,
    opponentId: null,
    lastMoveIndex: 0,
    playerChar: null, // 'X' or 'O' for current user
    userId: null
  };

  let channels = []; // active supabase channels to cleanup
  let pollers = { game: null, moves: null };

  // DOM
  const boardEl = document.getElementById(BOARD_ID);
  if (!boardEl) throw new Error(`#${BOARD_ID} introuvable dans la page.`);

  // util: read URL params
  const urlp = new URLSearchParams(window.location.search);
  gameId = urlp.get('game_id') || null;
  invitationId = urlp.get('invitation_id') || null;

  // Helper: get current user
  async function getUser() {
    try {
      const s = await supabase.auth.getSession();
      const u = s?.data?.session?.user ?? null;
      if (u) return u;
    } catch (e) { dbgLog('getUser error', e); }
    return null;
  }

  // If we have only invitation_id, wait a short time for DB to attach game_id
  async function waitForGameIdFromInvitation(invId, timeoutMs = 6000, interval = 400) {
    if (!invId) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { data, error } = await supabase
          .from('game_invitations')
          .select('game_id')
          .eq('id', invId)
          .maybeSingle();
        if (error) dbgLog('waitForGameIdFromInvitation query err', error);
        if (data && data.game_id) return data.game_id;
      } catch (e) { dbgLog('waitForGameIdFromInvitation exception', e); }
      await new Promise(r => setTimeout(r, interval));
    }
    return null;
  }

  // Basic DOM grid creation
  function createGrid() {
    boardEl.innerHTML = '';
    boardEl.style.gridTemplateColumns = `repeat(${COLS}, var(--cell-size))`;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const pos = r * COLS + c;
        const cell = document.createElement('div');
        cell.className = 'board-cell';
        cell.dataset.pos = pos;
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.setAttribute('role','button');
        cell.setAttribute('aria-label', `Cellule ${r},${c}`);
        cell.addEventListener('click', ev => handleCellClick(ev, cell));
        boardEl.appendChild(cell);
      }
    }
  }

  // Render a single cell from state.board
  function renderCell(pos, player, options={ aligned:false }) {
    const cell = boardEl.querySelector(`.board-cell[data-pos="${pos}"]`);
    if (!cell) return;
    // clear
    cell.classList.remove('piece-x','piece-o','background-img','aligned','last-move');
    const existingImg = cell.querySelector('img.piece-img');
    if (existingImg) existingImg.remove();

    if (!player) {
      // empty
      return;
    }

    if (player === 'X') {
      cell.classList.add('piece-x');
    } else if (player === 'O') {
      cell.classList.add('piece-o');
    }

    // try use window.pieceImages if available (compat with game.html)
    try {
      if (window.pieceImages && window.pieceImages[player]) {
        const img = document.createElement('img');
        img.className = 'piece-img';
        img.alt = player;
        img.src = window.pieceImages[player];
        cell.appendChild(img);
        // add background-img marker in case CSS wants to use it
        cell.classList.add('background-img');
      }
    } catch (e) { /* ignore */ }

    if (options.aligned) {
      cell.classList.add('aligned');
      setTimeout(()=>cell.classList.remove('aligned'), 1200);
    }
    if (options.last) {
      cell.classList.add('last-move');
      // keep last-move for short time then remove (visual)
      setTimeout(()=>cell.classList.remove('last-move'), 2000);
    }
  }

  // Render entire board
  function renderBoard(boardObj) {
    if (!boardObj) boardObj = {};
    // We'll render all cells to ensure authoritative state
    for (let pos=0; pos < ROWS*COLS; pos++) {
      const player = boardObj.hasOwnProperty(String(pos)) ? boardObj[String(pos)] : null;
      renderCell(pos, player);
    }
  }

  // Update small UI: turn text
  function updateTurnUI() {
    const el = document.getElementById('currentTurn');
    if (el) el.textContent = state.currentTurn ?? '—';
  }

  // Determine player's char based on game.owner/opponent
  function computePlayerChar(userId) {
    if (!userId) return null;
    if (String(userId) === String(state.ownerId)) return 'X';
    if (String(userId) === String(state.opponentId)) return 'O';
    return null;
  }

  async function handleCellClick(ev, cell) {
    try {
      if (!state.playerChar) {
        alert('Impossible de jouer: joueur non identifié pour cette partie.');
        return;
      }
      if (state.status !== 'playing') {
        alert('La partie est terminée.');
        return;
      }
      if (!state.currentTurn) {
        alert('Tour inconnu (attente)…');
        return;
      }
      if (state.currentTurn !== state.playerChar) {
        alert('Ce n\'est pas ton tour.');
        return;
      }

      const pos = Number(cell.dataset.pos);
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);

      // quick client-side occupancy check (server authoritative)
      if (state.board[String(pos)]) {
        alert('Case déjà occupée.');
        return;
      }

      // call RPC
      await placeMoveRPC(pos, row, col, state.playerChar);
    } catch (e) {
      dbgLog('handleCellClick error', e);
    }
  }

  // Helper: compute pos from row/col (server uses pos := row * cols + col)
  function posFromRowCol(r, c) {
    return (Number(r) * COLS) + Number(c);
  }

  // Helper: find single added key between two board objects
  function findAddedPosKey(oldBoard, newBoard) {
    oldBoard = oldBoard || {};
    newBoard = newBoard || {};
    // if newBoard has keys that oldBoard doesn't -> that's the added ones
    for (const k of Object.keys(newBoard)) {
      if (!Object.prototype.hasOwnProperty.call(oldBoard, k)) {
        return k; // string key representing pos
      }
    }
    // If keys same set, but value changed (rare), find changed key
    for (const k of Object.keys(newBoard)) {
      if (String(oldBoard[k]) !== String(newBoard[k])) return k;
    }
    return null;
  }

  // Call server RPC rpc_place_move
  async function placeMoveRPC(pos, row, col, playerChar) {
    if (!gameId) {
      alert('GameId manquant.');
      return;
    }
    let oldBoardSnapshot = { ...(state.board || {}) };
    try {
      // optimistic UI: show spinner
      const spinner = document.createElement('div');
      spinner.className = 'taktik-move-spinner';
      spinner.textContent = '…';
      document.body.appendChild(spinner);

      dbgLog('Calling rpc_place_move', { gameId, pos, row, col, playerChar });
      const { data, error } = await supabase.rpc('rpc_place_move', {
        p_game_id: gameId,
        p_position: pos,
        p_row: row,
        p_col: col,
        p_player: playerChar
      });

      if (error) {
        dbgLog('rpc_place_move error', error);
        alert(error.message || 'Erreur au serveur lors du placement.');
        return;
      }

      dbgLog('rpc_place_move success', data);
      const resp = Array.isArray(data) ? data[0] : data;
      if (!resp) {
        dbgLog('rpc_place_move returned empty', data);
        return;
      }

      // Server is authoritative: take board returned
      const newBoard = resp.board ?? state.board ?? {};
      // compute exact pos inserted by comparing oldBoardSnapshot -> newBoard
      const addedKey = findAddedPosKey(oldBoardSnapshot, newBoard);
      const addedPos = (addedKey !== null) ? Number(addedKey) : posFromRowCol(row, col);

      // update local state from canonical values returned
      state.board = newBoard;
      state.moveCount = resp.move_count ?? state.moveCount;
      state.currentTurn = resp.current_turn ?? state.currentTurn;
      state.status = resp.status ?? state.status;
      state.lastMoveIndex = Math.max(state.lastMoveIndex, resp.move_count ?? state.lastMoveIndex);

      // render board
      renderBoard(state.board);

      // Highlight exactly the position the server recorded
      if (!Number.isNaN(addedPos)) {
        renderCell(addedPos, state.board[String(addedPos)], { last: true });
      }

      // if aligned_count signals a win, highlight aligned & notify
      const aligned = resp.aligned_count ?? 0;
      if (aligned >= WINLEN) {
        if (!Number.isNaN(addedPos)) renderCell(addedPos, state.board[String(addedPos)], { aligned: true });
        alert('Partie terminée — victoire détectée.');
      }

      updateTurnUI();
      return resp;
    } catch (e) {
      dbgLog('placeMoveRPC exception', e);
      alert('Erreur réseau ou serveur lors du RPC.');
      throw e;
    } finally {
      try { document.querySelectorAll('.taktik-move-spinner').forEach(n=>n.remove()); } catch(_) {}
    }
  }

  // HANDLE INCOMING MOVES (from realtime or polling)
  async function handleIncomingMoveRow(row) {
    if (!row) return;
    try {
      // row may contain: position, row_index, col_index, player, move_index
      // Prefer authoritative row_index/col_index (server-side computed)
      let pos;
      if (row.hasOwnProperty('row_index') && row.hasOwnProperty('col_index') &&
          row.row_index !== null && row.col_index !== null) {
        pos = posFromRowCol(row.row_index, row.col_index);
      } else if (row.hasOwnProperty('position') && row.position !== null) {
        pos = Number(row.position);
      } else {
        dbgLog('incoming move row without coordinates', row);
        return;
      }

      const player = row.player;
      const moveIndex = Number(row.move_index ?? 0);

      // update if new
      if (moveIndex <= (state.lastMoveIndex || 0)) {
        dbgLog('ignore old move', moveIndex, state.lastMoveIndex);
        return;
      }

      // update local board with authoritative pos
      state.board[String(pos)] = player;
      state.lastMoveIndex = Math.max(state.lastMoveIndex, moveIndex);
      state.moveCount = Math.max(state.moveCount, moveIndex);

      // render single cell and mark as last move
      renderCell(pos, player, { last: true });

      // fetch authoritative game row to sync current_turn/status/board if needed
      await syncGameRow();
      updateTurnUI();
    } catch (e) {
      dbgLog('handleIncomingMoveRow exception', e);
    }
  }

  // Subscribe realtime to game_moves and games
  async function setupRealtime() {
    if (!gameId) return null;
    try {
      // create channel
      const chan = supabase.channel(`game:${gameId}`);
      channels.push(chan);

      chan.on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'game_moves', filter: `game_id=eq.${gameId}`
      }, payload => {
        dbgLog('realtime game_moves INSERT', payload);
        const rec = payload?.new;
        if (rec) handleIncomingMoveRow(rec);
      });

      // subscribe to game row updates (status,current_turn,winner,board maybe)
      chan.on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}`
      }, payload => {
        dbgLog('realtime games UPDATE', payload);
        const rec = payload?.new;
        if (!rec) return;
        // update authoritative fields
        state.currentTurn = rec.current_turn ?? state.currentTurn;
        state.status = rec.status ?? state.status;
        state.ownerId = rec.owner_id ?? state.ownerId;
        state.opponentId = rec.opponent_id ?? state.opponentId;
        if (rec.board) {
          // If board changed, render authoritative board and compute last move for highlight
          const oldBoard = { ...(state.board || {}) };
          state.board = rec.board;
          renderBoard(state.board);
          const added = findAddedPosKey(oldBoard, state.board);
          if (added !== null) {
            const pos = Number(added);
            renderCell(pos, state.board[String(pos)], { last: true });
          }
        }
        updateTurnUI();
        // recompute playerChar if needed
        if (state.userId) state.playerChar = computePlayerChar(state.userId);
      });

      const res = await chan.subscribe();
      dbgLog('subscribe result', res);
      const ok = res && (res.status === 'SUBSCRIBED' || res === 'ok' || res === 'OK' || res === 'connected');
      if (!ok) {
        dbgLog('Realtime channel not subscribed; using polling fallback.');
        // fallback: start polling
        startPolling();
      } else {
        // ensure no pollers running (realtime is primary)
        stopPolling();
      }

      return chan;
    } catch (e) {
      dbgLog('setupRealtime subscribe failed', e);
      startPolling();
      return null;
    }
  }

  // Polling: fetch new moves since lastMoveIndex
  async function pollMovesOnce() {
    if (!gameId) return;
    try {
      const last = state.lastMoveIndex ?? 0;
      const { data: rows, error } = await supabase
        .from('game_moves')
        .select('*')
        .eq('game_id', gameId)
        .gt('move_index', last)
        .order('move_index', { ascending: true })
        .limit(200);

      if (error) {
        dbgLog('pollMovesOnce error', error);
        return;
      }
      if (!rows || !rows.length) return;
      for (const r of rows) {
        await handleIncomingMoveRow(r);
      }
    } catch (e) {
      dbgLog('pollMovesOnce exception', e);
    }
  }

  // Poll full game row (authoritative current_turn/board)
  async function pollGameOnce() {
    if (!gameId) return;
    try {
      const { data: g, error } = await supabase
        .from('games')
        .select('id,board,move_count,current_turn,status,owner_id,opponent_id,winner')
        .eq('id', gameId)
        .maybeSingle();

      if (error) {
        dbgLog('pollGameOnce error', error);
        return;
      }
      if (!g) {
        dbgLog('pollGameOnce: game not found', gameId);
        return;
      }
      // merge authoritative fields
      const oldBoard = { ...(state.board || {}) };
      if (g.board) {
        state.board = g.board;
        renderBoard(state.board);
        const added = findAddedPosKey(oldBoard, state.board);
        if (added !== null) {
          const pos = Number(added);
          renderCell(pos, state.board[String(pos)], { last: true });
        }
      }
      state.moveCount = g.move_count ?? state.moveCount;
      state.lastMoveIndex = Math.max(state.lastMoveIndex || 0, state.moveCount || 0);
      state.currentTurn = g.current_turn ?? state.currentTurn;
      state.status = g.status ?? state.status;
      state.ownerId = g.owner_id ?? state.ownerId;
      state.opponentId = g.opponent_id ?? state.opponentId;
      updateTurnUI();
      // recompute playerChar
      if (state.userId) state.playerChar = computePlayerChar(state.userId);
    } catch (e) {
      dbgLog('pollGameOnce exception', e);
    }
  }

  function startPolling() {
    stopPolling();
    dbgLog('startPolling');
    pollers.moves = setInterval(() => pollMovesOnce().catch(e => dbgLog('pollMoves error', e)), POLL_MOVES_MS);
    pollers.game = setInterval(() => pollGameOnce().catch(e => dbgLog('pollGame error', e)), POLL_GAME_MS);
    // run immediately
    pollMovesOnce().catch(()=>{});
    pollGameOnce().catch(()=>{});
  }
  function stopPolling() {
    try { if (pollers.moves) clearInterval(pollers.moves); } catch(_) {}
    try { if (pollers.game) clearInterval(pollers.game); } catch(_) {}
    pollers.moves = null; pollers.game = null;
  }

  // Sync single game row (authoritative)
  async function syncGameRow() {
    try {
      await pollGameOnce();
    } catch (e) { dbgLog('syncGameRow fail', e); }
  }

  // Boot sequence: create grid, fetch user and game, sync state, subscribe
  async function boot() {
    createGrid();

    // current user
    const u = await getUser();
    state.userId = u?.id ?? null;
    dbgLog('current user', state.userId);

    // if only invitation_id provided, wait a bit for server to create the game_id
    if (!gameId && invitationId) {
      dbgLog('no gameId in URL — trying from invitationId', invitationId);
      gameId = await waitForGameIdFromInvitation(invitationId, 8000, 500);
      dbgLog('resolved gameId from invitation?', gameId);
      if (!gameId) {
        warn('Impossible de résoudre game_id depuis invitation — la page essaiera de se synchroniser plus tard.');
      }
    }

    if (!gameId) {
      dbgLog('no gameId yet, returning (will still allow sync if/when gameId assigned).');
    } else {
      await pollGameOnce(); // fill initial state
      state.playerChar = computePlayerChar(state.userId);
      dbgLog('initial state after poll', state);
      renderBoard(state.board);
      updateTurnUI();
    }

    // build window.taktikGame API used by page (updatePlayerStatsOnce relies on getState)
    window.taktikGame = window.taktikGame || {};
    window.taktikGame.getState = () => ({
      gameId,
      hostId: state.ownerId,
      opponentId: state.opponentId,
      board: state.board,
      moveCount: state.moveCount,
      currentTurn: state.currentTurn,
      status: state.status,
      playerChar: state.playerChar,
      _isReal: true
    });

    // dispatch event used by game.html to update player infos
    setTimeout(()=>document.dispatchEvent(new CustomEvent('taktik:joined')), 20);

    // setup realtime subscription & fallback polling
    await setupRealtime();
    // always keep a light poll to recover missed state on load
    startPolling();

    // also subscribe to pagehide/unload cleanup
    window.addEventListener('pagehide', cleanup);
    window.addEventListener('beforeunload', cleanup);
  }

  // Cleanup channels & pollers
  async function cleanup() {
    stopPolling();
    try {
      for (const ch of channels) {
        try { await ch.unsubscribe(); } catch (e) { dbgLog('unsubscribe fail', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(ch); } catch (e) { dbgLog('removeChannel fail', e); }
      }
      channels = [];
    } catch (e) { dbgLog('cleanup exception', e); }
  }

  // Expose some helpers to window for debug
  window.taktikGame = window.taktikGame || {};
  window.taktikGame.placeMove = async (pos) => {
    const r = Math.floor(pos / COLS);
    const c = pos % COLS;
    return placeMoveRPC(pos, r, c, state.playerChar);
  };
  window.taktikGame.getState = window.taktikGame.getState || (() => ({}));

  // start
  await boot();

  // return API
  return {
    getState: () => ({ ...state, gameId }),
    placeMove: (pos) => window.taktikGame.placeMove(pos),
    cleanup
  };
}

