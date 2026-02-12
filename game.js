// game.js (corrigé + affichage avatars/pseudos + RPC fallback + finalize round handling + modales victoire/défaite)
// Usage: import('./game.js').then(m => m.default(supabase));
export default async function initGame(supabaseClient) {
  const supabase = supabaseClient ?? window.supabase;
  const dbg = true;
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
    board: {}, // pos -> 'X'|'O' (canonical mapping)
    moveCount: 0,
    currentTurn: null, // 'X'|'O' or null
    status: null,
    ownerId: null,
    opponentId: null,
    ownerPseudo: null,
    opponentPseudo: null,
    ownerProfile: null,
    opponentProfile: null,
    lastMoveIndex: 0,
    playerChar: null, // 'X' or 'O' for current user
    userId: null,
    winnerPseudo: null,
    winnerId: null,
    // party/series info filled by rpc_finalize_round
    party_id: null,
    party_owner_wins: 0,
    party_opponent_wins: 0,
    party_winner: null,
    series_id: null,
    series_owner_wins: 0,
    series_opponent_wins: 0,
    series_winner: null
  };

  let channels = []; // active supabase channels to cleanup
  let pollers = { game: null, moves: null };

  // DOM
  const boardEl = document.getElementById(BOARD_ID);
  if (!boardEl) throw new Error(`#${BOARD_ID} introuvable dans la page.`);

  // UI mapping (ids from game.html)
  const uiMap = {
    player1: { pseudo: 'player1_pseudo', elo: 'player1_elo', div: 'player1_div', followers: 'player1_followers', avatar: 'player1_avatar', role: 'player1_role' },
    player2: { pseudo: 'player2_pseudo', elo: 'player2_elo', div: 'player2_div', followers: 'player2_followers', avatar: 'player2_avatar', role: 'player2_role' },
    mod:     { pseudo: 'mod_pseudo', elo: 'mod_elo', div: 'mod_div', followers: 'mod_followers', avatar: 'mod_avatar' }
  };

  // small DOM helpers
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (text === null || text === undefined || text === '') ? '—' : String(text);
  };
  const setImg = (id, src) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!src) {
      el.src = '';
      el.style.visibility = 'hidden';
      return;
    }
    el.src = src;
    el.style.visibility = 'visible';
  };

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
    cell.classList.remove('piece-x','piece-o','background-img','aligned','winning');
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
        cell.classList.add('background-img');
      }
    } catch (e) { /* ignore */ }

    if (options.aligned) {
      cell.classList.add('aligned','winning');
      // keep winning highlight for a while
      setTimeout(()=>cell.classList.remove('aligned'), 2500);
    }
  }

  // Render entire board (reads canonical mapping state.board)
  function renderBoard(boardMap) {
    if (!boardMap) boardMap = {};
    // render all cells (safe)
    for (let pos=0; pos < ROWS*COLS; pos++) {
      const player = boardMap.hasOwnProperty(String(pos)) ? boardMap[String(pos)] : null;
      renderCell(pos, player);
    }
  }

  function updateTurnUI() {
    const el = document.getElementById('currentTurn');
    if (!el) return;
    if (state.status === 'finished') {
      // Show winner pseudo if available
      if (state.winnerPseudo) {
        el.textContent = `Victoire — ${state.winnerPseudo}`;
        return;
      }
      el.textContent = 'Terminé';
      return;
    }
    if (!state.currentTurn) {
      el.textContent = '—';
      return;
    }
    if (state.currentTurn === 'X') {
      el.textContent = state.ownerPseudo ?? ('Joueur X');
      return;
    }
    if (state.currentTurn === 'O') {
      el.textContent = state.opponentPseudo ?? ('Joueur O');
      return;
    }
    el.textContent = '—';
  }

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

      // call RPC (we send row/col to RPC and omit p_position to avoid server-side inconsistency checks)
      await placeMoveRPC(pos, row, col, state.playerChar);
    } catch (e) {
      dbgLog('handleCellClick error', e);
    }
  }

  // --- NEW: rebuild canonical board mapping from game_moves rows ---
  async function rebuildBoardFromMoves() {
    if (!gameId) return {};
    try {
      const { data: moves, error } = await supabase
        .from('game_moves')
        .select('position, row_index, col_index, player, move_index')
        .eq('game_id', gameId)
        .order('move_index', { ascending: true });
      if (error) {
        dbgLog('rebuildBoardFromMoves error', error);
        return state.board || {};
      }
      const map = {};
      if (moves && moves.length) {
        for (const m of moves) {
          const pos = (m.position !== undefined && m.position !== null)
            ? Number(m.position)
            : ( (m.row_index != null && m.col_index != null) ? Number(m.row_index)*COLS + Number(m.col_index) : null );
          if (pos === null || isNaN(pos)) continue;
          map[String(pos)] = m.player;
        }
      }
      return map;
    } catch (e) {
      dbgLog('rebuildBoardFromMoves exception', e);
      return state.board || {};
    }
  }

  // Normalize server board into canonical mapping:
  async function normalizeBoard(serverBoard) {
    if (!serverBoard) return {};
    // plain object (not array) -> likely mapping pos->player
    if (!Array.isArray(serverBoard) && typeof serverBoard === 'object') {
      // Convert keys to strings of integers to ensure canonical mapping
      try {
        const map = {};
        for (const k of Object.keys(serverBoard)) {
          map[String(k)] = serverBoard[k];
        }
        return map;
      } catch (e) {
        dbgLog('normalizeBoard object branch failed, rebuilding from moves', e);
        const rebuilt = await rebuildBoardFromMoves();
        return rebuilt;
      }
    }

    // If array:
    if (Array.isArray(serverBoard)) {
      // check if array elements are objects with position/row_index/col_index/player
      const firstObj = serverBoard.find(x => x != null && typeof x === 'object');
      if (firstObj && (('position' in firstObj) || ('row_index' in firstObj) || ('col_index' in firstObj))) {
        // convert to map
        const map = {};
        for (const it of serverBoard) {
          if (!it) continue;
          if ('position' in it && it.position != null) {
            map[String(it.position)] = it.player;
            continue;
          }
          if (it.row_index != null && it.col_index != null) {
            const pos = Number(it.row_index) * COLS + Number(it.col_index);
            map[String(pos)] = it.player;
            continue;
          }
        }
        return map;
      }

      // If array elements are primitives (strings like 'X'/'O' or null), this is ambiguous:
      // DON'T interpret index as pos (that causes the 0..399 ordering bug).
      // Instead rebuild from game_moves to avoid wrong index mapping
      dbgLog('Board is primitive array -> rebuilding from game_moves to avoid index-as-pos bug');
      const rebuilt = await rebuildBoardFromMoves();
      return rebuilt;
    }

    // fallback
    return {};
  }

  // Find winning sequences (arrays of positions) for given playerChar in boardMap
  function findWinningSequences(boardMap, playerChar) {
    const rows = ROWS, cols = COLS, winlen = WINLEN;
    const positions = Object.keys(boardMap).filter(k => boardMap[k] === playerChar).map(k => Number(k));
    const posSet = new Set(positions);
    const sequences = [];
    const usedSeqSignature = new Set();

    // directions: (dr,dc)
    const dirs = [
      [1,0],
      [0,1],
      [1,1],
      [1,-1]
    ];

    function posToRC(p) {
      return [Math.floor(p / cols), p % cols];
    }
    function rcToPos(r,c) { return r*cols + c; }

    for (const p of positions) {
      const [r,c] = posToRC(p);
      for (const [dr,dc] of dirs) {
        // build backward + forward to get total sequence
        let seq = [p];
        // forward
        for (let i=1;i<winlen;i++){
          const rr = r + dr*i, cc = c + dc*i;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) break;
          const pp = rcToPos(rr,cc);
          if (!posSet.has(pp)) break;
          seq.push(pp);
        }
        // backward
        for (let i=1;i<winlen;i++){
          const rr = r - dr*i, cc = c - dc*i;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) break;
          const pp = rcToPos(rr,cc);
          if (!posSet.has(pp)) break;
          seq.unshift(pp);
        }
        if (seq.length >= winlen) {
          // normalize signature to avoid duplicates (sorted positions string)
          const sig = seq.join(',');
          if (!usedSeqSignature.has(sig)) {
            usedSeqSignature.add(sig);
            sequences.push(seq.slice());
          }
        }
      }
    }
    return sequences;
  }

  // Animate a list of position arrays (each array is a sequence)
  async function animateWinningSequences(sequences, playerChar) {
    if (!sequences || !sequences.length) return;
    for (const seq of sequences) {
      for (const pos of seq) {
        renderCell(pos, playerChar, { aligned: true });
      }
      // small pause between sequences for nicer effect
      await new Promise(r => setTimeout(r, 350));
    }
  }

  // Update players area (avatar / pseudo / role / elo / div / followers)
  function updatePlayerUI() {
    // Owner -> player1
    if (state.ownerProfile) {
      setText(uiMap.player1.pseudo, state.ownerProfile.pseudo || 'Invité');
      setImg(uiMap.player1.avatar, state.ownerProfile.avatar_url || '');
      setText(uiMap.player1.elo, state.ownerProfile.elo ?? '—');
      setText(uiMap.player1.div, state.ownerProfile.division ?? '—');
      setText(uiMap.player1.followers, state.ownerProfile.follower_count ?? '—');
      setText(uiMap.player1.role, 'Joueur 1');
    } else if (state.ownerId) {
      setText(uiMap.player1.pseudo, String(state.ownerId).slice(0,8));
      setImg(uiMap.player1.avatar, '');
      setText(uiMap.player1.role, 'Joueur 1');
    } else {
      setText(uiMap.player1.pseudo, 'Invite');
      setImg(uiMap.player1.avatar, '');
      setText(uiMap.player1.elo, '—');
      setText(uiMap.player1.div, '—');
      setText(uiMap.player1.followers, '—');
      setText(uiMap.player1.role, 'Joueur 1');
    }

    // Opponent -> player2
    if (state.opponentProfile) {
      setText(uiMap.player2.pseudo, state.opponentProfile.pseudo || 'Invité');
      setImg(uiMap.player2.avatar, state.opponentProfile.avatar_url || '');
      setText(uiMap.player2.elo, state.opponentProfile.elo ?? '—');
      setText(uiMap.player2.div, state.opponentProfile.division ?? '—');
      setText(uiMap.player2.followers, state.opponentProfile.follower_count ?? '—');
      setText(uiMap.player2.role, 'Joueur 2');
    } else if (state.opponentId) {
      setText(uiMap.player2.pseudo, String(state.opponentId).slice(0,8));
      setImg(uiMap.player2.avatar, '');
      setText(uiMap.player2.role, 'Joueur 2');
    } else {
      setText(uiMap.player2.pseudo, 'Invite');
      setImg(uiMap.player2.avatar, '');
      setText(uiMap.player2.elo, '—');
      setText(uiMap.player2.div, '—');
      setText(uiMap.player2.followers, '—');
      setText(uiMap.player2.role, 'Joueur 2');
    }

    // if winnerPseudo set, reflect it in turn UI
    updateTurnUI();

    // party/series UI (optional DOM ids):
    // partyOwnerWins, partyOpponentWins, seriesOwnerWins, seriesOpponentWins
    setText('partyOwnerWins', state.party_owner_wins ?? '');
    setText('partyOpponentWins', state.party_opponent_wins ?? '');
    setText('seriesOwnerWins', state.series_owner_wins ?? '');
    setText('seriesOpponentWins', state.series_opponent_wins ?? '');
  }

  // Fetch profiles for owner/opponent (id -> profile)
  async function fetchPseudosIfNeeded(ownerId, opponentId) {
    try {
      if (!ownerId && !opponentId) return;
      const ids = [];
      if (ownerId) ids.push(ownerId);
      if (opponentId && String(opponentId) !== String(ownerId)) ids.push(opponentId);
      if (!ids.length) return;
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id,pseudo,avatar_url,elo,division,follower_count')
        .in('id', ids);
      if (error) {
        dbgLog('fetchPseudosIfNeeded error', error);
        return;
      }
      if (Array.isArray(data)) {
        for (const row of data) {
          if (!row) continue;
          if (String(row.id) === String(ownerId)) {
            state.ownerPseudo = row.pseudo;
            state.ownerProfile = row;
          }
          if (String(row.id) === String(opponentId)) {
            state.opponentPseudo = row.pseudo;
            state.opponentProfile = row;
          }
        }
      }
      // update UI after profile fetch
      updatePlayerUI();
    } catch (e) {
      dbgLog('fetchPseudosIfNeeded exception', e);
    }
  }

  // Call server RPC rpc_place_move with fallback(s) if RPC name isn't found
  async function placeMoveRPC(pos, row, col, playerChar) {
    if (!gameId) {
      alert('GameId manquant.');
      return;
    }
    try {
      const spinner = document.createElement('div');
      spinner.className = 'taktik-move-spinner';
      spinner.textContent = '…';
      document.body.appendChild(spinner);

      dbgLog('Calling rpc_place_move', { gameId, row, col, playerChar });

      const rpcCandidates = ['rpc_place_move', 'place_move'];

      let finalResp = null;
      let lastErr = null;

      for (const rpcName of rpcCandidates) {
        try {
           const { data, error } = await supabase.rpc(rpcName, {
            p_game_id: gameId,
             p_position: pos,
            p_row: row,
            p_col: col,
            p_player: playerChar
          });

          if (error) {
            // detect "could not find function" style message and try next candidate
            const m = String(error.message || error.details || '').toLowerCase();
            if (/could not find function/i.test(error.message || '') ||
                /could not find function/i.test(error.details || '') ||
                /function .* does not exist/i.test(m) ||
                /rpc .* doesn't exist/i.test(m) ) {
              dbgLog('RPC name not found on server, trying next candidate', rpcName, { error });
              lastErr = error;
              continue; // try next rpc candidate
            }
            // Otherwise treat as final error
            dbgLog('rpc returned error', rpcName, error);
            lastErr = error;
            break;
          }

          // success
          finalResp = data;
          lastErr = null;
          break;
        } catch (e) {
          dbgLog('supabase.rpc threw exception for', rpcName, e);
          lastErr = e;
          // try next candidate
        }
      }

      if (lastErr && !finalResp) {
        // If lastErr signals missing RPC specifically, notify user about deploying the SQL function.
        const msg = (lastErr && (lastErr.message || lastErr.details || '')).toString();
        if (/could not find function/i.test(msg) || /does not exist/i.test(msg) || /function .* does not exist/i.test(msg)) {
          // Try to resync state and inform the user
          await pollGameOnce();
          alert('Fonction RPC `rpc_place_move` introuvable sur le serveur. Veuillez déployer la fonction SQL `rpc_place_move`. La page a été resynchronisée.');
          return null;
        }
        // Other errors: show message & resync
        dbgLog('placeMoveRPC final error', lastErr);
        await pollGameOnce();
        alert((lastErr && lastErr.message) ? lastErr.message : 'Erreur lors du placage de la pièce.');
        return null;
      }

      const data = finalResp;
      dbgLog('rpc_place_move success', data);
      const resp = Array.isArray(data) ? data[0] : data;
      if (!resp) {
        dbgLog('rpc_place_move returned empty', data);
        return null;
      }

      // Normalize resp.board to canonical mapping
      if (resp.board) {
        const normalized = await normalizeBoard(resp.board);
        state.board = normalized;
      }

      state.moveCount = resp.move_count ?? state.moveCount;
      state.currentTurn = resp.current_turn ?? state.currentTurn;
      state.status = resp.status ?? state.status;
      state.lastMoveIndex = Math.max(state.lastMoveIndex, resp.move_count ?? state.lastMoveIndex);

      // If server signals game_finished (or status finished), animate and block further moves
      const gameFinished = resp.game_finished === true || (resp.status && resp.status === 'finished');

      if (gameFinished) {
        // ensure pseudos loaded
        await fetchPseudosIfNeeded(state.ownerId, state.opponentId);
        // set winner id/pseudo if provided
        if (resp.winner) {
          state.winnerId = resp.winner;
          state.winnerPseudo = (String(resp.winner) === String(state.ownerId)) ? state.ownerProfile?.pseudo : state.opponentProfile?.pseudo;
        }
        // compute winning sequences for the winner char if possible
        let winnerChar = null;
        if (resp.winner) {
          if (String(resp.winner) === String(state.ownerId)) winnerChar = 'X';
          else if (String(resp.winner) === String(state.opponentId)) winnerChar = 'O';
        } else if (resp.aligned_count && resp.aligned_count >= WINLEN) {
          // fallback: highlight last placed char (playerChar)
          winnerChar = playerChar;
        }
        if (winnerChar) {
          const sequences = findWinningSequences(state.board, winnerChar);
          await animateWinningSequences(sequences, winnerChar);
        }

        // Show outcome modal (winner sees celebration + "Continuer de jouer", loser sees defeat message)
        showOutcomeModal({ winnerId: state.winnerId, winnerPseudo: state.winnerPseudo });

        // --- NEW: call rpc_finalize_round if server indicated finished AND server returned winner OR move_id ---
        // Condition per spec: Si game_finished = true et winner (ou move_id renvoyé) : appeler rpc_finalize_round(game_id).
        try {
          const hasWinnerOrMoveId = Boolean(resp.winner) || Boolean(resp.move_id);
          if (hasWinnerOrMoveId) {
            dbgLog('Calling rpc_finalize_round immediately because game finished + (winner|move_id)', { gameId, resp });
            // call finalize but do not auto-join; the modal's "Continuer de jouer" will also call finalize when clicked by winner.
            // We call finalize here to ensure server-side bookkeeping (it's safe; handleFinalizeRoundAndFollowup will show new-round modal then).
            await handleFinalizeRoundAndFollowup(gameId);
          } else {
            dbgLog('Game finished but no winner/move_id in rpc_place_move response — skipping immediate finalize.');
          }
        } catch (finalErr) {
          dbgLog('rpc_finalize_round call failed', finalErr);
          // Even if finalize fails, we keep the UI consistent and let polling/realtime eventually sync.
          await pollGameOnce();
        }

      } else {
        // not finished: normal update
        renderBoard(state.board);
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
      // row has position, row_index, col_index, player, move_index
      const pos = (row.position !== undefined && row.position !== null)
        ? Number(row.position)
        : ( (row.row_index != null && row.col_index != null) ? Number(row.row_index)*COLS + Number(row.col_index) : null );
      if (pos === null || isNaN(pos)) {
        dbgLog('incoming move has no pos, ignoring', row);
        return;
      }
      const player = row.player;
      const moveIndex = Number(row.move_index ?? 0);

      // update if new
      if (moveIndex <= (state.lastMoveIndex || 0)) {
        dbgLog('ignore old move', moveIndex, state.lastMoveIndex);
        return;
      }

      // update local board
      state.board[String(pos)] = player;
      state.lastMoveIndex = Math.max(state.lastMoveIndex, moveIndex);
      state.moveCount = Math.max(state.moveCount, moveIndex);

      // render single cell
      renderCell(pos, player);

      // fetch authoritative game row for turn/status if needed
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
      const chan = supabase.channel(`game:${gameId}`);
      channels.push(chan);

      chan.on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'game_moves', filter: `game_id=eq.${gameId}`
      }, payload => {
        dbgLog('realtime game_moves INSERT', payload);
        const rec = payload?.new;
        if (rec) handleIncomingMoveRow(rec);
      });

      chan.on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}`
      }, payload => {
        dbgLog('realtime games UPDATE', payload);
        const rec = payload?.new;
        if (!rec) return;

        state.currentTurn = rec.current_turn ?? state.currentTurn;
        state.status = rec.status ?? state.status;
        state.ownerId = rec.owner_id ?? state.ownerId;
        state.opponentId = rec.opponent_id ?? state.opponentId;

        // fetch pseudos when owner/opponent ids change or missing
        (async () => {
          await fetchPseudosIfNeeded(state.ownerId, state.opponentId);

          // if board arrives and is ambiguous, normalize
          if (rec.board) {
            const normalized = await normalizeBoard(rec.board);
            state.board = normalized;
            renderBoard(state.board);
          }

          // If finished: animate winning sequences and declare winner (use modal instead of alert)
          if (rec.status === 'finished') {
            // set winner id/pseudo
            if (rec.winner) {
              state.winnerId = rec.winner;
              state.winnerPseudo = (String(rec.winner) === String(state.ownerId)) ? state.ownerProfile?.pseudo : state.opponentProfile?.pseudo;
            }
            // determine winner char
            let winnerChar = null;
            if (rec.winner) {
              if (String(rec.winner) === String(state.ownerId)) winnerChar = 'X';
              else if (String(rec.winner) === String(state.opponentId)) winnerChar = 'O';
            }
            // If no explicit winner uuid, try to infer by sequences
            if (!winnerChar && rec.board) {
              // check both players
              if (findWinningSequences(state.board, 'X').length) winnerChar = 'X';
              else if (findWinningSequences(state.board, 'O').length) winnerChar = 'O';
            }
            if (winnerChar) {
              const sequences = findWinningSequences(state.board, winnerChar);
              await animateWinningSequences(sequences, winnerChar);
            }

            // show outcome modal
            showOutcomeModal({ winnerId: state.winnerId, winnerPseudo: state.winnerPseudo });
          } else {
            updateTurnUI();
          }

          // recompute playerChar if needed
          if (state.userId) state.playerChar = computePlayerChar(state.userId);

          // update players UI (in case id -> profile changed)
          updatePlayerUI();
        })();
      });

      const res = await chan.subscribe();
      dbgLog('subscribe result', res);
      const ok = res && (res.status === 'SUBSCRIBED' || res === 'ok' || res === 'OK');
      if (!ok) {
        dbgLog('Realtime channel not subscribed; using polling fallback.');
        startPolling();
      } else {
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

      // update ids first
      const prevOwner = state.ownerId;
      const prevOpponent = state.opponentId;
      state.ownerId = g.owner_id ?? state.ownerId;
      state.opponentId = g.opponent_id ?? state.opponentId;

      // fetch pseudos if needed (only if changed or missing)
      if (state.ownerId !== prevOwner || state.opponentId !== prevOpponent || !state.ownerProfile || !state.opponentProfile) {
        await fetchPseudosIfNeeded(state.ownerId, state.opponentId);
      }

      // handle board with normalization to avoid 0..399 bug
      if (g.board) {
        const normalized = await normalizeBoard(g.board);
        state.board = normalized;
        renderBoard(state.board);
      } else {
        // if no board provided by server, ensure we still render local
        renderBoard(state.board);
      }
      state.moveCount = g.move_count ?? state.moveCount;
      state.lastMoveIndex = Math.max(state.lastMoveIndex || 0, state.moveCount || 0);
      state.currentTurn = g.current_turn ?? state.currentTurn;
      state.status = g.status ?? state.status;

      // if finished, animate + set winner pseudo
      if (g.status === 'finished') {
        if (g.winner) {
          state.winnerId = g.winner;
          state.winnerPseudo = (String(g.winner) === String(state.ownerId)) ? state.ownerProfile?.pseudo : state.opponentProfile?.pseudo;
        }
        // find winning sequences based on winner char (if available)
        let winnerChar = null;
        if (g.winner) {
          winnerChar = (String(g.winner) === String(state.ownerId)) ? 'X' : 'O';
        } else {
          // try both
          if (findWinningSequences(state.board, 'X').length) winnerChar = 'X';
          else if (findWinningSequences(state.board, 'O').length) winnerChar = 'O';
        }
        if (winnerChar) {
          const sequences = findWinningSequences(state.board, winnerChar);
          await animateWinningSequences(sequences, winnerChar);
        }

        // show outcome modal
        showOutcomeModal({ winnerId: state.winnerId, winnerPseudo: state.winnerPseudo });
      }

      // recompute playerChar
      if (state.userId) state.playerChar = computePlayerChar(state.userId);

      // ensure player UI reflects latest profiles
      updatePlayerUI();

      updateTurnUI();
    } catch (e) {
      dbgLog('pollGameOnce exception', e);
    }
  }

  function startPolling() {
    stopPolling();
    dbgLog('startPolling');
    pollers.moves = setInterval(() => pollMovesOnce().catch(e => dbgLog('pollMoves error', e)), POLL_MOVES_MS);
    pollers.game = setInterval(() => pollGameOnce().catch(e => dbgLog('pollGame error', e)), POLL_GAME_MS);
    pollMovesOnce().catch(()=>{});
    pollGameOnce().catch(()=>{});
  }
  function stopPolling() {
    try { if (pollers.moves) clearInterval(pollers.moves); } catch(_) {}
    try { if (pollers.game) clearInterval(pollers.game); } catch(_) {}
    pollers.moves = null; pollers.game = null;
  }

  async function syncGameRow() {
    try {
      await pollGameOnce();
    } catch (e) { dbgLog('syncGameRow fail', e); }
  }

  // --- NEW FUNCTION: call rpc_finalize_round and handle response/UI/new game join ---
  async function callRpcFinalizeRound(p_game_id) {
    try {
      const { data, error } = await supabase.rpc('rpc_finalize_round', { p_game_id });
      if (error) {
        dbgLog('rpc_finalize_round error', error);
        throw error;
      }
      const row = Array.isArray(data) ? data[0] : data;
      return row || null;
    } catch (e) {
      dbgLog('callRpcFinalizeRound exception', e);
      throw e;
    }
  }

  // orchestrator that calls finalize, updates UI, shows modal and optionally joins new game
  // accepts an optional options object: { starterChar: 'X'|'O' } to indicate who should start the next game
  async function handleFinalizeRoundAndFollowup(p_game_id, options = {}) {
    try {
      const finalizeRow = await callRpcFinalizeRound(p_game_id);
      if (!finalizeRow) {
        dbgLog('rpc_finalize_round returned no row');
        await pollGameOnce();
        return null;
      }

      // update state party/series from RPC return
      state.party_id = finalizeRow.party_id ?? state.party_id;
      state.party_owner_wins = Number(finalizeRow.party_owner_wins ?? state.party_owner_wins ?? 0);
      state.party_opponent_wins = Number(finalizeRow.party_opponent_wins ?? state.party_opponent_wins ?? 0);
      state.party_winner = finalizeRow.party_winner ?? state.party_winner;

      state.series_id = finalizeRow.series_id ?? state.series_id;
      state.series_owner_wins = Number(finalizeRow.series_owner_wins ?? state.series_owner_wins ?? 0);
      state.series_opponent_wins = Number(finalizeRow.series_opponent_wins ?? state.series_opponent_wins ?? 0);
      state.series_winner = finalizeRow.series_winner ?? state.series_winner;

      // Update UI counters if present
      updatePlayerUI();

      // Show modal "nouvelle manche" with info and a button to join the new game (if present).
      const newGameId = finalizeRow.new_game_id ?? null;
      showNewRoundModal({
        party_id: state.party_id,
        party_owner_wins: state.party_owner_wins,
        party_opponent_wins: state.party_opponent_wins,
        party_winner: state.party_winner,
        series_id: state.series_id,
        series_owner_wins: state.series_owner_wins,
        series_opponent_wins: state.series_opponent_wins,
        series_winner: state.series_winner,
        new_game_id: newGameId
      });

      // If new_game_id is provided, join it automatically (per spec)
      if (newGameId) {
        dbgLog('Joining newly created game returned by rpc_finalize_round', newGameId);
        await joinNewGame(newGameId, options.starterChar ?? null);
      } else {
        // Otherwise, resync canonical game row (party maybe updated)
        await pollGameOnce();

        // If server didn't create a new game but the caller requested a starterChar, ensure local state reflects that:
        if (options.starterChar) {
          state.currentTurn = options.starterChar;
          state.status = 'playing';
          renderBoard(state.board);
          updateTurnUI();
        }
      }

      return finalizeRow;
    } catch (e) {
      dbgLog('handleFinalizeRoundAndFollowup failed', e);
      // fallback: resync state
      await pollGameOnce();
      return null;
    }
  }

  // make a simple modal to show "nouvelle manche" info
  function showNewRoundModal(info) {
    try {
      // remove existing modal
      const prev = document.getElementById('taktik-new-round-modal');
      if (prev) prev.remove();

      const overlay = document.createElement('div');
      overlay.id = 'taktik-new-round-modal';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = 'rgba(0,0,0,0.5)';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '9999';

      const box = document.createElement('div');
      box.style.background = '#fff';
      box.style.padding = '18px';
      box.style.borderRadius = '8px';
      box.style.maxWidth = '420px';
      box.style.width = '90%';
      box.style.boxShadow = '0 12px 30px rgba(0,0,0,0.25)';
      box.style.textAlign = 'center';

      const title = document.createElement('h3');
      title.textContent = 'Nouvelle manche';
      title.style.margin = '0 0 8px 0';
      box.appendChild(title);

      const details = document.createElement('div');
      details.style.margin = '8px 0 12px 0';
      details.style.fontSize = '14px';
      details.innerHTML = `
        <div>Score manche — Joueur 1 : <strong>${info.party_owner_wins ?? '0'}</strong> — Joueur 2 : <strong>${info.party_opponent_wins ?? '0'}</strong></div>
        <div style="margin-top:6px">Score série — Joueur 1 : <strong>${info.series_owner_wins ?? '0'}</strong> — Joueur 2 : <strong>${info.series_opponent_wins ?? '0'}</strong></div>
      `;
      box.appendChild(details);

      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '8px';
      btns.style.justifyContent = 'center';

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Fermer';
      closeBtn.style.padding = '8px 12px';
      closeBtn.style.borderRadius = '6px';
      closeBtn.style.border = '1px solid #ccc';
      closeBtn.onclick = () => overlay.remove();
      btns.appendChild(closeBtn);

      if (info.new_game_id) {
        const joinBtn = document.createElement('button');
        joinBtn.textContent = 'Rejoindre la nouvelle partie';
        joinBtn.style.padding = '8px 12px';
        joinBtn.style.background = '#0b84ff';
        joinBtn.style.color = '#fff';
        joinBtn.style.border = 'none';
        joinBtn.style.borderRadius = '6px';
        joinBtn.onclick = async () => {
          overlay.remove();
          await joinNewGame(info.new_game_id);
        };
        btns.appendChild(joinBtn);
      }

      box.appendChild(btns);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    } catch (e) {
      dbgLog('showNewRoundModal failed', e);
    }
  }

  // Join a newly created game: set gameId, reset local board, re-subscribe, poll initial state
  // new optional param starterChar ('X' or 'O') to set who starts next game (winner should start)
  async function joinNewGame(newGameId, starterChar = null) {
    try {
      if (!newGameId) return;
      // cleanup old channels
      try {
        for (const ch of channels) {
          try { await ch.unsubscribe(); } catch(e) { dbgLog('unsubscribe fail', e); }
          try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(ch); } catch(e) {}
        }
      } catch (e) { dbgLog('cleanup channels on new game', e); }
      channels = [];

      // reset local minimal state
      state.board = {};
      state.moveCount = 0;
      state.lastMoveIndex = 0;
      // set to playing; currentTurn will be updated after poll or by starterChar
      state.status = 'playing';
      state.winnerPseudo = null;
      state.winnerId = null;
      state.playerChar = computePlayerChar(state.userId);

      // set new game id
      gameId = newGameId;

      // refresh authoritative state
      await pollGameOnce();

      // If starterChar provided, set it as currentTurn (ensures winner can place first)
      if (starterChar === 'X' || starterChar === 'O') {
        state.currentTurn = starterChar;
      } else {
        // keep the server's currentTurn if any
        state.currentTurn = state.currentTurn ?? 'X';
      }

      // render the (empty or server) board
      renderBoard(state.board);

      // re-subscribe realtime
      await setupRealtime();

      // ensure polling is active if realtime not active
      startPolling();

      // dispatch event for external listeners
      try { document.dispatchEvent(new CustomEvent('taktik:joined-new-game', { detail: { gameId } })); } catch(e) {}

      // small notification (replace alert by a short ephemeral non-blocking message)
      try {
        const toast = document.createElement('div');
        toast.textContent = 'Nouvelle manche démarrée.';
        toast.style.position = 'fixed';
        toast.style.bottom = '18px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.background = 'rgba(0,0,0,0.8)';
        toast.style.color = '#fff';
        toast.style.padding = '8px 12px';
        toast.style.borderRadius = '8px';
        toast.style.zIndex = '9999';
        document.body.appendChild(toast);
        setTimeout(()=>{ toast.remove(); }, 2200);
      } catch(e){}

    } catch (e) {
      dbgLog('joinNewGame failed', e);
      await pollGameOnce();
    }
  }

  // Call rpc_finalize_round with safe fallback (exposed for debugging)
  window.taktikGame = window.taktikGame || {};
  window.taktikGame.finalizeRound = async (gId, options = {}) => {
    return handleFinalizeRoundAndFollowup(gId || gameId, options);
  };

  // ---- NEW: Outcome modal (winner / loser) ----
  function showOutcomeModal({ winnerId = null, winnerPseudo = null } = {}) {
    try {
      // remove existing
      const prev = document.getElementById('taktik-outcome-modal');
      if (prev) prev.remove();

      const overlay = document.createElement('div');
      overlay.id = 'taktik-outcome-modal';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = 'rgba(0,0,0,0.65)';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '10000';
      overlay.style.padding = '16px';

      // modal box
      const box = document.createElement('div');
      box.style.width = 'min(520px, 96%)';
      box.style.maxWidth = '520px';
      box.style.background = '#fff';
      box.style.borderRadius = '12px';
      box.style.boxShadow = '0 20px 40px rgba(0,0,0,0.35)';
      box.style.padding = '20px';
      box.style.textAlign = 'center';
      box.style.position = 'relative';
      box.style.overflow = 'hidden';
      overlay.appendChild(box);

      // simple confetti emojis animation container
      const emojiContainer = document.createElement('div');
      emojiContainer.style.position = 'absolute';
      emojiContainer.style.top = '0';
      emojiContainer.style.left = '0';
      emojiContainer.style.right = '0';
      emojiContainer.style.height = '100%';
      emojiContainer.style.pointerEvents = 'none';
      box.appendChild(emojiContainer);

      // small helper to generate falling emojis (non-blocking)
      function launchEmojis(list = ['🎉','✨','🎊']) {
        for (let i=0;i<9;i++){
          const e = document.createElement('div');
          e.textContent = list[Math.floor(Math.random()*list.length)];
          e.style.position = 'absolute';
          e.style.left = `${Math.random()*100}%`;
          e.style.top = `-10%`;
          e.style.fontSize = `${16 + Math.random()*36}px`;
          e.style.opacity = `${0.8 - Math.random()*0.5}`;
          e.style.transform = `rotate(${Math.random()*360}deg)`;
          e.style.transition = `transform 1s linear, top 1.3s linear, opacity 1.3s linear`;
          emojiContainer.appendChild(e);
          // animate
          setTimeout(()=> {
            e.style.top = `${80 + Math.random()*20}%`;
            e.style.transform = `translateY(0) rotate(${Math.random()*360}deg)`;
            e.style.opacity = '0';
          }, 50 + Math.random()*300);
          setTimeout(()=> e.remove(), 1600 + Math.random()*600);
        }
      }

      const isWinner = (state.userId && winnerId && String(state.userId) === String(winnerId));
      if (isWinner) {
        // Winner view
        const big = document.createElement('div');
        big.style.fontSize = '42px';
        big.style.marginTop = '6px';
        big.style.marginBottom = '8px';
        big.textContent = '🎉 Vous avez gagné ! 🎉';
        box.appendChild(big);

        const who = document.createElement('div');
        who.style.marginBottom = '12px';
        who.style.fontSize = '15px';
        who.textContent = winnerPseudo ? `Bravo ${winnerPseudo} !` : 'Bravo !';
        box.appendChild(who);

        const info = document.createElement('div');
        info.style.fontSize = '13px';
        info.style.color = '#444';
        info.style.marginBottom = '14px';
        info.textContent = 'Cliquez sur "Continuer de jouer" pour lancer la manche suivante.';
        box.appendChild(info);

        const btns = document.createElement('div');
        btns.style.display = 'flex';
        btns.style.gap = '10px';
        btns.style.justifyContent = 'center';
        btns.style.marginTop = '8px';

        const continueBtn = document.createElement('button');
        continueBtn.textContent = 'Continuer de jouer';
        continueBtn.style.padding = '10px 14px';
        continueBtn.style.borderRadius = '8px';
        continueBtn.style.border = 'none';
        continueBtn.style.background = '#0b84ff';
        continueBtn.style.color = '#fff';
        continueBtn.style.fontWeight = '600';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Fermer';
        closeBtn.style.padding = '10px 14px';
        closeBtn.style.borderRadius = '8px';
        closeBtn.style.border = '1px solid #ccc';
        closeBtn.style.background = '#fff';

        btns.appendChild(continueBtn);
        btns.appendChild(closeBtn);
        box.appendChild(btns);

        // small spinner helper
        const smallSpinner = document.createElement('span');
        smallSpinner.style.marginLeft = '8px';
        smallSpinner.style.display = 'inline-block';

        continueBtn.onclick = async () => {
          try {
            continueBtn.disabled = true;
            continueBtn.textContent = 'Préparation…';
            launchEmojis(['🎉','🎊','✨']);
            // Determine starterChar: winner should start next game
            // If we have winnerId matching ownerId/opponentId, we decide 'X' or 'O'
            let starterChar = null;
            if (String(winnerId) === String(state.ownerId)) starterChar = 'X';
            else if (String(winnerId) === String(state.opponentId)) starterChar = 'O';
            // call finalize and join new game with starterChar
            await handleFinalizeRoundAndFollowup(gameId, { starterChar });
            // after finalize/join, remove modal (joinNewGame already resets board)
            overlay.remove();
          } catch (e) {
            dbgLog('continue finalize failed', e);
            continueBtn.disabled = false;
            continueBtn.textContent = 'Continuer de jouer';
            alert('Impossible de lancer la nouvelle manche (erreur serveur). Réessayez.');
          }
        };

        closeBtn.onclick = () => overlay.remove();

        // launch a few emojis on open
        launchEmojis();
      } else {
        // Loser or spectator view
        const big = document.createElement('div');
        big.style.fontSize = '34px';
        big.style.marginTop = '6px';
        big.style.marginBottom = '8px';
        big.textContent = 'Partie terminée';
        box.appendChild(big);

        const who = document.createElement('div');
        who.style.marginBottom = '12px';
        who.style.fontSize = '15px';
        if (winnerPseudo) who.textContent = `Vous avez perdu, ${winnerPseudo}.`;
        else who.textContent = 'Vous avez perdu.';
        box.appendChild(who);

        const info = document.createElement('div');
        info.style.fontSize = '13px';
        info.style.color = '#444';
        info.style.marginBottom = '14px';
        info.textContent = 'Le vainqueur peut lancer la manche suivante.';
        box.appendChild(info);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Fermer';
        closeBtn.style.padding = '10px 14px';
        closeBtn.style.borderRadius = '8px';
        closeBtn.style.border = '1px solid #ccc';
        closeBtn.style.background = '#fff';
        closeBtn.onclick = () => overlay.remove();
        box.appendChild(closeBtn);
      }

      document.body.appendChild(overlay);
    } catch (e) {
      dbgLog('showOutcomeModal failed', e);
    }
  }

  // make a simple modal to show "nouvelle manche" info
  // (kept from previous code; separate from outcome modal)
  // function showNewRoundModal defined above

  // Polling & realtime boot sequence and rest of flow
  // Boot sequence
  async function boot() {
    createGrid();

    const u = await getUser();
    state.userId = u?.id ?? null;
    dbgLog('current user', state.userId);

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

    // window API & event
    window.taktikGame = window.taktikGame || {};
    window.taktikGame.getState = () => ({
      gameId,
      hostId: state.ownerId,
      ownerPseudo: state.ownerPseudo,
      opponentId: state.opponentId,
      opponentPseudo: state.opponentPseudo,
      board: state.board,
      moveCount: state.moveCount,
      currentTurn: state.currentTurn,
      currentTurnPseudo: (state.currentTurn === 'X' ? state.ownerPseudo : state.currentTurn === 'O' ? state.opponentPseudo : null),
      status: state.status,
      playerChar: state.playerChar,
      _isReal: true
    });

    setTimeout(()=>document.dispatchEvent(new CustomEvent('taktik:joined')), 20);

    await setupRealtime();
    startPolling();

    window.addEventListener('pagehide', cleanup);
    window.addEventListener('beforeunload', cleanup);
  }

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

  // Expose debug helpers
  window.taktikGame = window.taktikGame || {};
  window.taktikGame.placeMove = async (pos) => {
    const r = Math.floor(pos / COLS);
    const c = pos % COLS;
    return placeMoveRPC(pos, r, c, state.playerChar);
  };
  window.taktikGame.getState = window.taktikGame.getState || (() => ({}));

  await boot();

  return {
    getState: () => ({ ...state, gameId }),
    placeMove: (pos) => window.taktikGame.placeMove(pos),
    cleanup
  };
}
