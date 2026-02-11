// game.js
// initGame(supabase) — gère l'UI du board, realtime + polling fallback, et appelle rpc_place_move
export default async function initGame(supabaseClient) {
  const supabase = supabaseClient ?? window.supabase;
  // DEBUG MODE: true = alerts + extra verbosity (utile sur Android sans console)
  const dbg = true;

  // global dbgAlert (utilisé aussi par game.html). Si dbg=false, on logge silencieusement.
  window.dbgAlert = function dbgAlert(msg) {
    try {
      if (dbg) {
        // show visible alert with stringified object if needed
        const s = (typeof msg === 'string') ? msg : JSON.stringify(msg);
        alert('DBG: ' + s);
      } else {
        // fallback to console
        console.debug('DBG:', msg);
      }
    } catch (e) {
      try { console.debug('DBG (fallback):', msg, e); } catch(_) {}
    }
  };

  function dbgLog(...args) { if (dbg) try { console.debug('game.js DBG:', ...args); } catch(e){} }

  if (!supabase) {
    dbgAlert('Supabase client introuvable (window.supabase ou param).');
    return;
  }

  // Constants
  const ROWS = 20;
  const COLS = 20;
  const WINLEN = 5;
  const POLL_INTERVAL_MS = 900;

  // state
  let state = {
    gameId: null,
    hostId: null,
    opponentId: null,
    board: {},        // position index -> 'X'|'O'
    moveCount: 0,
    currentTurn: null, // 'X' or 'O'
    status: null,
    winner: null
  };

  // channels / pollers
  let movesChannel = null;
  let gamesChannel = null;
  let subscribed = false;
  let poller = null;
  let lastSeenMoveIndex = 0;

  // DOM anchors
  const boardGrid = document.getElementById('boardGrid');
  if (!boardGrid) {
    dbgAlert('boardGrid non trouvé dans DOM');
    return;
  }

  // create grid DOM (20x20) — game.html expects game.js to build grid
  function buildBoardGrid() {
    boardGrid.innerHTML = '';
    boardGrid.style.gridTemplateColumns = `repeat(${COLS}, var(--cell-size))`;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const pos = r * COLS + c;
        const cell = document.createElement('div');
        cell.className = 'board-cell';
        cell.dataset.pos = String(pos);
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.id = `cell-${pos}`;

        // click handler: attempt to place a move
        cell.addEventListener('click', (ev) => {
          ev.preventDefault();
          try {
            placeMoveFromUser(r, c);
          } catch (e) {
            dbgLog('cell click handler error', e);
          }
        });

        boardGrid.appendChild(cell);
      }
    }
  }

  // render a single cell
  function renderCellAt(pos, player, aligned=false) {
    const cell = document.getElementById(`cell-${pos}`);
    if (!cell) return;
    // clear
    cell.classList.remove('piece-x', 'piece-o', 'aligned', 'background-img');
    cell.innerHTML = '';

    if (player === 'X' || player === 'O') {
      cell.classList.add(player === 'X' ? 'piece-x' : 'piece-o');
      if (aligned) cell.classList.add('aligned');

      // try using pieceImages if available else text
      const imgPath = (window.pieceImages && window.pieceImages[player]) ? window.pieceImages[player] : null;
      if (imgPath) {
        const img = document.createElement('img');
        img.className = 'piece-img';
        img.src = imgPath;
        img.alt = player;
        cell.appendChild(img);
      } else {
        cell.textContent = player;
      }
    } else {
      // empty cell
      cell.textContent = '';
    }
  }

  // full board render
  function renderBoard(boardObj = {}) {
    // boardObj: { "0": "X", "1": "O", ... } or Map-like
    state.board = boardObj || {};
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const pos = r * COLS + c;
        const p = state.board?.[String(pos)] ?? null;
        renderCellAt(pos, p, false);
      }
    }
  }

  // helper: get current user id (with retry)
  async function getCurrentUserId() {
    try {
      const s = await supabase.auth.getSession();
      const user = s?.data?.session?.user;
      return user?.id ?? null;
    } catch (e) {
      dbgLog('getCurrentUserId error', e);
      return null;
    }
  }

  // determine my symbol (X or O) or null if observer
  async function mySymbol() {
    try {
      const uid = await getCurrentUserId();
      if (!uid) return null;
      if (String(uid) === String(state.hostId)) return 'X';
      if (String(uid) === String(state.opponentId)) return 'O';
      return null;
    } catch (e) { return null; }
  }

  // ========================
  // URL params resolver
  // ========================
  function getQueryParams() {
    try {
      const params = {};
      const search = window.location.search || '';
      new URLSearchParams(search).forEach((v,k) => params[k] = v);
      return params;
    } catch (e) {
      return {};
    }
  }

  // If we have invitation_id (from create_game.js redirect), try to resolve game_id
  async function resolveGameIdFromInvitation(invitationId, maxMs = 8000, intervalMs = 500) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        const { data, error } = await supabase.from('game_invitations').select('game_id,status,series_id').eq('id', invitationId).maybeSingle();
        if (error) dbgLog('resolveGameIdFromInvitation fetch error', error);
        if (data) {
          if (data.game_id) return data.game_id;
          if (data.status === 'accepted' && data.game_id) return data.game_id;
          // else, try to find latest game connected to series (fallback)
          if (data.series_id) {
            const { data: parties } = await supabase.from('parties').select('id').eq('series_id', data.series_id).order('created_at', { ascending: false }).limit(10);
            if (parties && parties.length) {
              const pids = parties.map(p=>p.id);
              const { data: games } = await supabase.from('games').select('id,owner_id,opponent_id,status').in('party_id', pids).in('status', ['playing','active','started','in_progress']).order('created_at', { ascending:false }).limit(10);
              if (games && games.length) {
                return games[0].id;
              }
            }
          }
        }
      } catch (e) {
        dbgLog('resolveGameIdFromInvitation exception', e);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  // ========================
  // initialize state from DB
  // ========================
  async function loadGameFromDb(gameId) {
    try {
      const { data: g, error } = await supabase.from('games').select('id,owner_id,opponent_id,board,move_count,current_turn,status,winner').eq('id', gameId).maybeSingle();
      if (error) {
        dbgAlert('Erreur fetching game: ' + (error.message || JSON.stringify(error)));
        dbgLog('loadGameFromDb error', error);
        return false;
      }
      if (!g) {
        dbgAlert('Partie introuvable: ' + gameId);
        return false;
      }
      state.gameId = g.id;
      state.hostId = g.owner_id;
      state.opponentId = g.opponent_id;
      state.board = g.board ?? {};
      state.moveCount = g.move_count ?? 0;
      state.currentTurn = g.current_turn ?? null;
      state.status = g.status ?? null;
      state.winner = g.winner ?? null;
      lastSeenMoveIndex = state.moveCount || 0;
      dbgLog('loadGameFromDb -> state', state);
      return true;
    } catch (e) {
      dbgLog('loadGameFromDb exception', e);
      return false;
    }
  }

  // ========================
  // RPC: place move
  // ========================
  async function rpcPlaceMove(gameId, row, col, playerSymbol) {
    try {
      const pos = row * COLS + col;
      dbgLog('rpcPlaceMove', { gameId, pos, row, col, playerSymbol });
      const params = {
        p_game_id: gameId,
        p_position: pos,
        p_row: row,
        p_col: col,
        p_player: playerSymbol
      };
      const { data, error } = await supabase.rpc('rpc_place_move', params);
      if (error) {
        dbgLog('rpc_place_move error', error);
        throw error;
      }
      // RPC returns table with canonical values (see function). Could be array or single row.
      let res = null;
      if (Array.isArray(data) && data.length) res = data[0];
      else if (data && typeof data === 'object') res = data;
      dbgLog('rpc_place_move result', res);

      return res;
    } catch (e) {
      dbgLog('rpcPlaceMove exception', e);
      throw e;
    }
  }

  // wrapper when user clicks to place (performs checks)
  async function placeMoveFromUser(row, col) {
    try {
      if (!state.gameId) {
        dbgAlert('Aucune partie chargée (game_id manquant).');
        return;
      }

      // only allow if game status playing
      if (state.status !== 'playing' && state.status !== 'active' && state.status !== null) {
        dbgAlert('La partie n\'est pas en cours (status=' + state.status + ').');
        return;
      }

      const symbol = await mySymbol();
      if (!symbol) {
        dbgAlert('Tu n\'es pas un participant de cette partie (mode observateur).');
        return;
      }

      if (state.currentTurn && state.currentTurn !== symbol) {
        dbgAlert('Ce n\'est pas ton tour (attendu: ' + state.currentTurn + ').');
        return;
      }

      const pos = row * COLS + col;
      if (state.board?.[String(pos)]) {
        dbgAlert('Case occupée');
        return;
      }

      // optimistic UI: show spinner, then call RPC
      dbgAlert(`Placement tentative: ${symbol} en (${row},${col})`);
      try {
        const res = await rpcPlaceMove(state.gameId, row, col, symbol);
        dbgLog('placeMoveFromUser rpc result', res);
        // if RPC returns board we update state
        if (res && (res.board || res.move_count !== undefined)) {
          state.board = res.board ?? state.board;
          state.moveCount = res.move_count ?? state.moveCount + 1;
          state.currentTurn = res.current_turn ?? (symbol === 'X' ? 'O' : 'X');
          state.status = res.status ?? state.status;
          state.winner = res.winner ?? state.winner;
          // render the board from returned board if available
          if (res.board) {
            renderBoard(res.board);
          } else {
            // fallback: render single placed piece
            const posIdx = row * COLS + col;
            renderCellAt(posIdx, symbol, false);
            state.board[String(posIdx)] = symbol;
          }
          dbgAlert('Coup placé.');
        } else {
          dbgAlert('Coup placé (aucune mise à jour renvoyée).');
        }
      } catch (e) {
        dbgAlert('Échec RPC: ' + (e?.message || JSON.stringify(e)));
      }
    } catch (e) {
      dbgLog('placeMoveFromUser outer error', e);
      dbgAlert('Erreur interne lors du placement.');
    }
  }

  // ==============
  // Realtime handling
  // ==============
  function applyMoveFromPayload(payload) {
    try {
      if (!payload) return;
      const newRow = payload.row_index ?? payload.row ?? null;
      const newCol = payload.col_index ?? payload.col ?? null;
      const player = payload.player;
      const moveIndex = payload.move_index ?? payload.move_index;
      if (newRow === null || newCol === null || !player) return;
      const pos = newRow * COLS + newCol;
      // don't override if already known - but always render to keep in sync
      state.board[String(pos)] = player;
      renderCellAt(pos, player, false);
      if (moveIndex && moveIndex > lastSeenMoveIndex) lastSeenMoveIndex = moveIndex;
    } catch (e) {
      dbgLog('applyMoveFromPayload error', e);
    }
  }

  // games table update handler (update currentTurn/status/winner/board)
  function handleGameRowUpdate(newRow) {
    try {
      if (!newRow) return;
      if (newRow.board) {
        state.board = newRow.board;
        renderBoard(state.board);
      }
      state.currentTurn = newRow.current_turn ?? state.currentTurn;
      state.status = newRow.status ?? state.status;
      state.winner = newRow.winner ?? state.winner;
      state.moveCount = newRow.move_count ?? state.moveCount;
      if (state.moveCount > lastSeenMoveIndex) lastSeenMoveIndex = state.moveCount;
      dbgLog('handleGameRowUpdate -> state', state);
      // expose event for other UI
      dispatchEvent(new CustomEvent('taktik:game_update', { detail: { state } }));
    } catch (e) { dbgLog('handleGameRowUpdate error', e); }
  }

  // subscribe to moves + games updates
  async function subscribeRealtime(gameId) {
    try {
      // cleanup previous
      try {
        if (movesChannel) {
          await movesChannel.unsubscribe();
          if (typeof supabase.removeChannel === 'function') supabase.removeChannel(movesChannel);
          movesChannel = null;
        }
        if (gamesChannel) {
          await gamesChannel.unsubscribe();
          if (typeof supabase.removeChannel === 'function') supabase.removeChannel(gamesChannel);
          gamesChannel = null;
        }
      } catch (e) { dbgLog('cleanup channels error', e); }

      // moves channel
      movesChannel = supabase.channel(`realtime:game_moves:${gameId}`);
      movesChannel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_moves', filter: `game_id=eq.${gameId}` }, payload => {
        dbgLog('realtime move payload', payload);
        const newRow = payload?.new;
        applyMoveFromPayload(newRow);
      });

      // games channel updates (for board/current_turn/winner)
      gamesChannel = supabase.channel(`realtime:games:${gameId}`);
      gamesChannel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, payload => {
        dbgLog('realtime games UPDATE payload', payload);
        const newRow = payload?.new;
        handleGameRowUpdate(newRow);
      });

      // attempt to subscribe
      const resMoves = await movesChannel.subscribe();
      const resGames = await gamesChannel.subscribe();
      dbgLog('subscribeRealtime results', { resMoves, resGames });

      const okMoves = resMoves && (resMoves.status === 'SUBSCRIBED' || resMoves === 'ok' || resMoves === 'OK');
      const okGames = resGames && (resGames.status === 'SUBSCRIBED' || resGames === 'ok' || resGames === 'OK');

      if (okMoves && okGames) {
        subscribed = true;
        dbgAlert('Realtime connecté (updates en direct).');
        // stop any poller
        if (poller) {
          clearInterval(poller);
          poller = null;
        }
        return;
      } else {
        dbgAlert('Realtime non connecté, activation du polling fallback.');
        subscribed = false;
        startPollingMoves(gameId);
      }
    } catch (e) {
      dbgLog('subscribeRealtime exception', e);
      dbgAlert('Erreur subscription realtime, fallback polling.');
      subscribed = false;
      startPollingMoves(gameId);
    }
  }

  // Polling fallback: fetch new moves (since lastSeenMoveIndex)
  function startPollingMoves(gameId) {
    if (poller) return;
    dbgLog('startPollingMoves', { gameId, lastSeenMoveIndex });
    poller = setInterval(async () => {
      try {
        // fetch moves with move_index > lastSeenMoveIndex
        const { data: moves, error } = await supabase
          .from('game_moves')
          .select('id,game_id,position,row_index,col_index,player,move_index,created_at')
          .eq('game_id', gameId)
          .gt('move_index', lastSeenMoveIndex)
          .order('move_index', { ascending: true })
          .limit(50);

        if (error) {
          dbgLog('polling moves fetch error', error);
          return;
        }
        if (Array.isArray(moves) && moves.length) {
          for (const m of moves) {
            applyMoveFromPayload(m);
          }
          lastSeenMoveIndex = Math.max(lastSeenMoveIndex, ...moves.map(m => m.move_index || 0));
        }

        // also fetch games row to keep current_turn/status in sync occasionally
        const { data: g, error: gErr } = await supabase.from('games').select('id,current_turn,status,winner,board,move_count').eq('id', gameId).maybeSingle();
        if (!gErr && g) handleGameRowUpdate(g);
      } catch (e) {
        dbgLog('poller exception', e);
      }
    }, POLL_INTERVAL_MS);
  }

  // simple event dispatch util
  function dispatchEvent(ev) {
    try {
      document.dispatchEvent(ev);
    } catch (e) { dbgLog('dispatchEvent error', e); }
  }

  // expose global API used by other scripts (game.html)
  window.taktikGame = {
    _isReal: true,
    getState: () => ({ ...state }),
    placeMove: async (row, col) => {
      return await placeMoveFromUser(row, col);
    }
  };

  // Build UI now
  buildBoardGrid();

  // Resolve game id from URL and load initial state
  async function boot() {
    try {
      const params = getQueryParams();
      dbgLog('boot params', params);

      let gid = params.game_id ?? params.gameId ?? null;
      if (!gid && params.invitation_id) {
        dbgAlert('Arrivé depuis invitation — résolution du game_id...');
        gid = await resolveGameIdFromInvitation(params.invitation_id, 8000, 600);
        if (!gid) {
          dbgAlert('Impossible de résoudre game_id depuis invitation. Tu peux réessayer plus tard.');
          // leave page as viewer for now
        } else {
          dbgAlert('game_id résolu: ' + gid);
        }
      }

      if (!gid) {
        dbgAlert('Aucun game_id en paramètre — mode spectateur / attente.');
        return;
      }

      // load DB
      const ok = await loadGameFromDb(gid);
      if (!ok) {
        dbgAlert('Impossible de charger la partie depuis la base.');
        return;
      }

      // initial render
      renderBoard(state.board || {});
      // expose IDs so game.html can read them (updatePlayerStatsOnce)
      window.taktikGame.hostId = state.hostId;
      window.taktikGame.opponentId = state.opponentId;
      window.taktikGame.gameId = state.gameId;

      // notify that we've joined/loaded
      dispatchEvent(new CustomEvent('taktik:joined', { detail: { state } }));

      // subscribe to realtime (with polling fallback)
      await subscribeRealtime(state.gameId);

      // final: start light periodic state refresh for eventual drift
      setInterval(async () => {
        try {
          // update small metadata every 3s without heavy payload
          const { data: g, error: gErr } = await supabase.from('games').select('current_turn,status,winner,move_count').eq('id', state.gameId).maybeSingle();
          if (!gErr && g) {
            state.currentTurn = g.current_turn ?? state.currentTurn;
            state.status = g.status ?? state.status;
            state.winner = g.winner ?? state.winner;
            state.moveCount = g.move_count ?? state.moveCount;
            // notify UI
            dispatchEvent(new CustomEvent('taktik:meta_update', { detail: { state } }));
          }
        } catch (e) { dbgLog('periodic meta refresh err', e); }
      }, 3000);

      dbgAlert('Partie chargée: ' + state.gameId);
    } catch (e) {
      dbgLog('boot error', e);
      dbgAlert('Erreur initialisation partie: ' + (e?.message || JSON.stringify(e)));
    }
  }

  // start
  boot().catch(e => {
    dbgLog('boot catch', e);
  });

  // ensure we cleanup on pagehide/unload
  async function cleanup() {
    try {
      if (poller) { clearInterval(poller); poller = null; }
      if (movesChannel) {
        try { await movesChannel.unsubscribe(); } catch (e) { dbgLog('movesChannel unsubscribe err', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(movesChannel); } catch(e) {}
        movesChannel = null;
      }
      if (gamesChannel) {
        try { await gamesChannel.unsubscribe(); } catch (e) { dbgLog('gamesChannel unsubscribe err', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(gamesChannel); } catch(e) {}
        gamesChannel = null;
      }
    } catch (e) {
      dbgLog('cleanup error', e);
    }
  }

  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
}

