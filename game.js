// game.js (corrigé : nouvelle manche & nouvelle série -> tous synchronisés,
// defeat sound/modal uniquement pour le perdant, perdant rejoint la nouvelle partie automatiquement)
// Ajout : polling fallback pour détecter NEW GAME dans la même party sans realtime
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
  // Poll spécifique pour détecter rapidement la création d'une nouvelle game dans la même party
  const POLL_NEWGAME_MS = 900; // <--- intervalle ajustable pour "quasi instantané" sans realtime
  const VICTORY_SOUND = 'victory.wav';
  const DEFEAT_SOUND = 'defeat.wav';

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
    // party/series info filled by rpc_finalize_round or polling
    party_id: null,
    party_owner_wins: 0,
    party_opponent_wins: 0,
    party_winner: null,
    series_id: null,
    series_owner_wins: 0,
    series_opponent_wins: 0,
    series_winner: null,
        match_id: null,
    // keep last round winner id to determine starter for next game when new game is detected
    lastRoundWinnerId: null,
    // après lastRoundWinnerId: null,
initialSyncDone: false,
    // track that we've already shown outcome modal for this finished game to avoid replays
    outcomeShownForGameId: null,
    // track that we've shown the "new round" modal for a given new_game_id
    newRoundShownForGameId: null,
    // track that we showed the "series finished" modal for a given series id
    seriesFinishedShownForSeriesId: null,
    // track last known game id for the party to detect new games via polling fallback
    lastPartyKnownGameId: null
        // suppress modals while we do the first authoritative sync on startup
  };

  let channels = []; // active supabase channels to cleanup
  let globalGamesChannel = null;
  // channels dedicated to score subscriptions (parties/series)
  let scoreSubscriptions = { party: null, series: null };
  let pollers = { game: null, moves: null, partyGames: null };

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
// loading overlay helpers (insert après setImg)
function showLoadingOverlay() {
  try {
    if (document.getElementById('taktik-loading-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'taktik-loading-overlay';
    ov.style.position = 'fixed';
    ov.style.inset = '0';
    ov.style.display = 'flex';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';
    ov.style.background = 'rgba(255,255,255,0.9)';
    ov.style.zIndex = '99998';
    ov.innerHTML = `<div style="padding:18px;border-radius:10px;background:#fff;box-shadow:0 8px 20px rgba(0,0,0,0.12);font-weight:600">Chargement…</div>`;
    document.body.appendChild(ov);
  } catch (e) { dbgLog('showLoadingOverlay failed', e); }
}
function hideLoadingOverlay() {
  try {
    const o = document.getElementById('taktik-loading-overlay');
    if (o) o.remove();
  } catch (e) { dbgLog('hideLoadingOverlay failed', e); }
}
  // util: read URL params
  const urlp = new URLSearchParams(window.location.search);
gameId = urlp.get('game_id') || null;
invitationId = urlp.get('invitation_id') || null;
const matchId = urlp.get('match_id') || null;
if (matchId) {
  state.match_id = matchId;
}
  // --- Exposer un shim global minimal pour que les autres modules (live.js, fab.js, maingame.js) puissent lire le gameId ---
window.gameState = window.gameState || {};

// gameId (existant)
if (gameId) {
  window.gameState.id = gameId;
  window.gameState.gameId = gameId;
} else {
  window.gameState.id = window.gameState.id ?? null;
  window.gameState.gameId = window.gameState.gameId ?? null;
}

// matchId (nouveau) — défensif : vérifie que matchId est défini et non vide
if (typeof matchId !== 'undefined' && matchId) {
  window.gameState.match_id = matchId;
  window.gameState.matchId = matchId;
} else {
  // conserve la valeur existante si présente, sinon null
  window.gameState.match_id = window.gameState.match_id ?? null;
  window.gameState.matchId = window.gameState.matchId ?? window.gameState.match_id ?? null;
}

// rétro-compat : provide taktikGame.getState() si absent (fab.js / live.js s'en servent)
window.taktikGame = window.taktikGame || {};
if (typeof window.taktikGame.getState !== 'function') {
  window.taktikGame.getState = () => window.gameState;
}

// utilitaire pour synchroniser l'état game -> window.gameState
function exposeGameStateToWindow() {
  try {
    window.gameState = window.gameState || {};

    // always keep game id mirrored
    window.gameState.id = gameId ?? window.gameState.id ?? null;
    window.gameState.gameId = window.gameState.id;

    // mirror owner/opponent if known
    if (state.ownerId) {
      window.gameState.owner_id = state.ownerId;
      window.gameState.ownerId = state.ownerId;
    }
    if (state.opponentId) {
      window.gameState.opponent_id = state.opponentId;
      window.gameState.opponentId = state.opponentId;
    }

    // ✅ new: mirror match_id if present
    if (state.match_id) {
      window.gameState.match_id = state.match_id;
      window.gameState.matchId = state.match_id;
    }

    // other useful fields for consumers
    window.gameState.status = state.status ?? window.gameState.status ?? null;
    window.gameState.current_turn = state.currentTurn ?? window.gameState.current_turn ?? null;

  } catch (e) {
    dbgLog('exposeGameStateToWindow failed', e);
  }
}

// appel initial pour s'assurer qu'on a bien propagé la valeur du param
exposeGameStateToWindow();
  
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

  // --- rebuild canonical board mapping from game_moves rows ---
  async function rebuildBoardFromMoves(gId = null) {
    const gid = gId ?? gameId;
    if (!gid) return {};
    try {
      const { data: moves, error } = await supabase
        .from('game_moves')
        .select('position, row_index, col_index, player, move_index')
        .eq('game_id', gid)
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

  // Update players area (avatar / pseudo / role / elo / div / followers) AND update scores in page
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

    // Update scores on page
    // 'X' is owner, 'O' is opponent
    setText('scoreX', state.party_owner_wins ?? 0);
    setText('scoreO', state.party_opponent_wins ?? 0);
    setText('seriesX', state.series_owner_wins ?? 0);
    setText('seriesO', state.series_opponent_wins ?? 0);

    // optional backup ids for party/series counters
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
          state.lastRoundWinnerId = resp.winner;
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
        // Only show once per finished game to avoid repeated sounds/modals
        if (state.outcomeShownForGameId !== gameId) {
          showOutcomeModal({ winnerId: state.winnerId, winnerPseudo: state.winnerPseudo });
          state.outcomeShownForGameId = gameId;
        }

        // IMPORTANT: do NOT auto-call rpc_finalize_round here.
        // The winner must explicitly click "Continuer de jouer" to finalize the round.
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

  // Subscribe realtime to game_moves and games (per-game channel)
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
              state.lastRoundWinnerId = rec.winner;
            }
            // determine winner char
            let winnerChar = null;
            if (rec.winner) {
              if (String(rec.winner) === String(state.ownerId)) winnerChar = 'X';
              else if (String(rec.winner) === String(state.opponentId)) winnerChar = 'O';
            }
            // If no explicit winner uuid, try to infer by sequences
            if (!winnerChar && rec.board) {
              if (findWinningSequences(state.board, 'X').length) winnerChar = 'X';
              else if (findWinningSequences(state.board, 'O').length) winnerChar = 'O';
            }
            if (winnerChar) {
              const sequences = findWinningSequences(state.board, winnerChar);
              await animateWinningSequences(sequences, winnerChar);
            }

            // show outcome modal once
            if (state.outcomeShownForGameId !== gameId) {
              showOutcomeModal({ winnerId: state.winnerId, winnerPseudo: state.winnerPseudo });
              state.outcomeShownForGameId = gameId;
            }
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

  // Helper: when a new game row is created on server, update local party/series UI, show new-round modal and auto-join
  async function handleGlobalNewGameCreated(g) {
    try {
      if (!g || !g.id) return;
      // Avoid duplicate processing
      if (String(state.newRoundShownForGameId) === String(g.id)) {
        dbgLog('new game already processed', g.id);
        return;
      }

      // We'll attempt to refresh party + series info from DB for accurate scores
      try {
        // fetch party row (if available)
        let partyRow = null;
        if (g.party_id) {
          const { data: p, error: perr } = await supabase
            .from('parties')
            .select('id, owner_wins, opponent_wins, winner_id, series_id, target_games')
            .eq('id', g.party_id)
            .maybeSingle();
          if (!perr && p) partyRow = p;
        }

        // If party not found but g.owner/opponent match current players, try to find most recent party between players
        if (!partyRow) {
          // attempt best-effort: find a party in DB with these participants and status playing/ongoing
          const { data: approx, error: aerr } = await supabase
            .from('parties')
            .select('id, owner_wins, opponent_wins, winner_id, series_id, target_games')
            .order('created_at', { ascending: false })
            .limit(3);
          if (!aerr && Array.isArray(approx) && approx.length) partyRow = approx[0];
        }

        // fetch series row if we have series_id
        let seriesRow = null;
        if (partyRow && partyRow.series_id) {
          const { data: s, error: serr } = await supabase
            .from('series')
            .select('id, owner_wins, opponent_wins, winner_id, target_parties, owner_id, opponent_id')
            .eq('id', partyRow.series_id)
            .maybeSingle();
          if (!serr && s) seriesRow = s;
        }

        // Update local state from fetched rows (best-effort)
        if (partyRow) {
          state.party_id = partyRow.id ?? state.party_id;
          state.party_owner_wins = Number(partyRow.owner_wins ?? state.party_owner_wins ?? 0);
          state.party_opponent_wins = Number(partyRow.opponent_wins ?? state.party_opponent_wins ?? 0);
          state.party_winner = partyRow.winner_id ?? state.party_winner;
        }
        if (seriesRow) {
          state.series_id = seriesRow.id ?? state.series_id;
          state.series_owner_wins = Number(seriesRow.owner_wins ?? state.series_owner_wins ?? 0);
          state.series_opponent_wins = Number(seriesRow.opponent_wins ?? state.series_opponent_wins ?? 0);
          state.series_winner = seriesRow.winner_id ?? state.series_winner;
        }

        // update UI counters
        updatePlayerUI();
        // --- PATCH: ensure immediate score subscriptions so counters update fast for losers/spectators
try {
  // mark this game as known early to avoid concurrent poll/insert races
  if (g && g.id) state.lastPartyKnownGameId = String(g.id);

  // subscribe now to party/series so realtime updates start flowing immediately
  await setupScoreSubscriptions();
  dbgLog('early setupScoreSubscriptions after global new-game');
} catch (e) {
  dbgLog('early setupScoreSubscriptions failed', e);
}
      } catch (e) {
        dbgLog('handleGlobalNewGameCreated: fetch party/series failed', e);
      }
stopPolling();
      // === PATCH: clear blocking modals & reset client UI immediately so losers are not stuck ===
// retire overlays/modals restants (issue: perdant voit encore le modal qui bloque)
try {
  const om = document.getElementById('taktik-outcome-modal');
  if (om) om.remove();
  const nm = document.getElementById('taktik-new-round-modal');
  if (nm) nm.remove();
  const sm = document.getElementById('taktik-series-modal');
  if (sm) sm.remove();
} catch(e){ dbgLog('modal cleanup failed', e); }

// Reset local board/UI so this client (perdant/spectateur) voit la grille vide tout de suite
state.board = {};
state.moveCount = 0;
state.lastMoveIndex = 0;
state.status = 'playing';
state.winnerId = null;
state.winnerPseudo = null;
state.outcomeShownForGameId = null;
try { renderBoard(state.board); } catch(e){ dbgLog('renderBoard after global new-game reset failed', e); }
try { updateTurnUI(); } catch(e){}
try { await setupScoreSubscriptions(); } catch(e){ dbgLog('setupScoreSubscriptions after global new-game failed', e); }

// kick a quick authoritative resync to ensure we display updated scores/game row fast
try { await pollGameOnce(); } catch(e){ dbgLog('pollGameOnce after global new-game failed', e); }
      // Show the new-round modal (only once per new game)
      try {
        showNewRoundModal({
          party_id: state.party_id,
          party_owner_wins: state.party_owner_wins,
          party_opponent_wins: state.party_opponent_wins,
          party_winner: state.party_winner,
          series_id: state.series_id,
          series_owner_wins: state.series_owner_wins,
          series_opponent_wins: state.series_opponent_wins,
          series_winner: state.series_winner,
          new_game_id: g.id
        });
        state.newRoundShownForGameId = g.id;
      } catch (e) {
        dbgLog('showNewRoundModal in handleGlobalNewGameCreated failed', e);
      }

      // If the series has been closed (series_winner present) and we haven't shown series modal yet, show it.
      if (state.series_winner && String(state.seriesFinishedShownForSeriesId) !== String(state.series_id)) {
        try {
          showSeriesModal({
            series_id: state.series_id,
            series_owner_wins: state.series_owner_wins,
            series_opponent_wins: state.series_opponent_wins,
            series_winner: state.series_winner,
            series_winner_pseudo: (state.series_winner && (String(state.series_winner) === String(state.ownerId) ? state.ownerProfile?.pseudo : state.opponentProfile?.pseudo)) || null,
            party_owner_wins: state.party_owner_wins,
            party_opponent_wins: state.party_opponent_wins,
            new_game_id: g.id || null,
            last_round_winner: state.lastRoundWinnerId
          });
        } catch (e) {
          dbgLog('series modal show failed', e);
        }
      }

      // Auto-join the new game so losers & spectators get the reset board immediately
      try {
        // === CHANGEMENT ===
        // Prefer using the server-provided current_turn from the created game row 'g' when available.
        // Fallback to lastRoundWinnerId to compute starter if current_turn not set.
        let starterChar = null;
        if (g.current_turn) {
          // server explicitly set who starts next game
          if (String(g.current_turn) === 'X' || String(g.current_turn) === 'O') {
            starterChar = String(g.current_turn);
          }
        }
        if (!starterChar) {
          if (state.lastRoundWinnerId) {
            if (String(state.lastRoundWinnerId) === String(g.owner_id)) starterChar = 'X';
            else if (String(state.lastRoundWinnerId) === String(g.opponent_id)) starterChar = 'O';
          }
        }
        // final fallback: if starterChar still null, let joinNewGame rely on server's current_turn after poll
        await joinNewGame(g.id, starterChar);
        // record last known party game id to avoid reprocessing
        state.lastPartyKnownGameId = g.id;
      } catch (e) {
        dbgLog('auto joinNewGame in handleGlobalNewGameCreated failed', e);
        // even if join fails, we already showed modal and updated scores
      }
      startPolling();
    } catch (e) {
      dbgLog('handleGlobalNewGameCreated exception', e);
    }
  }

  // Setup global subscription to detect newly created games
  async function setupGlobalGamesInsertSubscription() {
  try {
    if (globalGamesChannel) return; // already created
    const gch = supabase.channel('games-global-inserts');
    globalGamesChannel = gch;
    channels.push(gch);

    gch.on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'games'
    }, payload => {
      try {
        const g = payload?.new;
        if (!g) return;
        dbgLog('GLOBAL games INSERT detected', g);

        // Prefer match-level handling if we have a match_id
        if (state.match_id && g.match_id && String(g.match_id) === String(state.match_id)) {
          if (String(g.id) === String(gameId)) {
            dbgLog('global insert: same gameId, skipping');
            return;
          }
          dbgLog('global insert: detected new game in same match -> handleGlobalNewGameCreated', g.id);
          handleGlobalNewGameCreated(g).catch(e => dbgLog('handleGlobalNewGameCreated failed', e));
          return;
        }

        // If we have a party_id and the new game belongs to it -> handle (includes losers)
        if (state.party_id && g.party_id && String(g.party_id) === String(state.party_id)) {
          // Avoid joining if this client already is in that game
          if (String(g.id) === String(gameId)) {
            dbgLog('global insert: same gameId, skipping');
            return;
          }
          dbgLog('global insert: detected new game in same party -> handleGlobalNewGameCreated', g.id);
          // mark it known immediately to avoid poll/race
state.lastPartyKnownGameId = String(g.id);
          handleGlobalNewGameCreated(g).catch(e => dbgLog('handleGlobalNewGameCreated failed', e));
          return;
        }

        // Otherwise, if the new game's players match our current pair, auto-handle as well
        const ourOwner = state.ownerId;
        const ourOpponent = state.opponentId;
        if (ourOwner && ourOpponent) {
          const samePair = (String(g.owner_id) === String(ourOwner) && String(g.opponent_id) === String(ourOpponent)) ||
                           (String(g.owner_id) === String(ourOpponent) && String(g.opponent_id) === String(ourOwner));
          if (samePair) {
            dbgLog('global insert: auto-joining new game for matching pair -> handleGlobalNewGameCreated', g.id);
            // avoid races with party pollers
            state.lastPartyKnownGameId = String(g.id);
            handleGlobalNewGameCreated(g).catch(e => dbgLog('handleGlobalNewGameCreated failed', e));
          }
        }
      } catch (e) { dbgLog('global games INSERT handler error', e); }
    });

    const res = await gch.subscribe();
    dbgLog('globalGamesChannel subscribe result', res);
  } catch (e) {
    dbgLog('setupGlobalGamesInsertSubscription failed', e);
  }
}

  async function setupMatchSubscription(matchId) {
  try {
    if (!matchId) return;
    // don't duplicate
    if (channels.some(ch => ch && ch._topic === `match:${matchId}`)) return;
    const mchan = supabase.channel(`match:${matchId}`);
    channels.push(mchan);

    // Detect any new game created for this match (all clients in the match-room should get it)
    mchan.on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'games', filter: `match_id=eq.${matchId}`
    }, payload => {
      const g = payload?.new;
      if (!g) return;
      dbgLog('MATCH-level games INSERT detected', g);
      // delegate to existing handler
      state.lastPartyKnownGameId = String(g.id);
      handleGlobalNewGameCreated(g).catch(e => dbgLog('handleGlobalNewGameCreated failed (match chan)', e));
    });

    // Also watch for updates to games in this match (useful for watchers/moderators)
    mchan.on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'games', filter: `match_id=eq.${matchId}`
    }, payload => {
      const g = payload?.new;
      if (!g) return;
      dbgLog('MATCH-level games UPDATE detected', g);
      // If it's the current game, resync the authoritative row
      if (String(g.id) === String(gameId)) {
        // quick authoritative sync
        pollGameOnce().catch(e => dbgLog('pollGameOnce after match-level update failed', e));
      } else {
        // for non-current games we still may want to update party/series UI
        // best-effort: update state.party_id/series via poll or ignore
        pollGameOnce().catch(()=>{});
      }
    });

    await mchan.subscribe();
    dbgLog('Subscribed to match channel', matchId);
  } catch (e) {
    dbgLog('setupMatchSubscription failed', e);
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
        .select('id,board,move_count,current_turn,status,owner_id,opponent_id,winner,party_id,match_id')
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
      const prevPartyId = state.party_id;
      const prevSeriesId = state.series_id;
      state.ownerId = g.owner_id ?? state.ownerId;
      state.opponentId = g.opponent_id ?? state.opponentId;
      state.party_id = g.party_id ?? state.party_id;
      state.match_id = g.match_id ?? state.match_id;
      exposeGameStateToWindow();

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
          state.lastRoundWinnerId = g.winner;
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

        // show outcome modal (winner will have to click to finalize)
        if (state.outcomeShownForGameId !== gameId) {
          showOutcomeModal({ winnerId: state.winnerId, winnerPseudo: state.winnerPseudo });
          state.outcomeShownForGameId = gameId;
          // If a series winner is present (server declared end of series), show the series modal once
          try {
            // fetch series row if we don't have it yet (best-effort)
            if (state.series_winner && String(state.seriesFinishedShownForSeriesId) !== String(state.series_id)) {
              // Attempt to fetch the most up-to-date series row to extract target/new_game info (best-effort)
              let newGameIdFromServer = null;
              try {
                if (state.series_id) {
                  const { data: srow, error: serr } = await supabase
                    .from('series')
                    .select('id, owner_wins, opponent_wins, winner_id')
                    .eq('id', state.series_id)
                    .maybeSingle();
                  if (!serr && srow) {
                    // no new_game id typically on series table, skip but keep scores
                  }
                }
                // We try to infer new_game_id from the latest party games (best-effort)
                if (state.party_id) {
                  const { data: recentGames, error: rgerr } = await supabase
                    .from('games')
                    .select('id, party_id, created_at')
                    .eq('party_id', state.party_id)
                    .order('created_at', { ascending: false })
                    .limit(1);
                  if (!rgerr && Array.isArray(recentGames) && recentGames.length) {
                    // If latest game is different from current game and belongs to a new series, offer it
                    const latest = recentGames[0];
                    if (String(latest.id) !== String(gameId)) newGameIdFromServer = latest.id;
                  }
                }
              } catch(e) { dbgLog('series modal helper fetch failed', e); }

              showSeriesModal({
                series_id: state.series_id,
                series_owner_wins: state.series_owner_wins,
                series_opponent_wins: state.series_opponent_wins,
                series_winner: state.series_winner,
                series_winner_pseudo: (state.series_winner && (String(state.series_winner) === String(state.ownerId) ? state.ownerProfile?.pseudo : state.opponentProfile?.pseudo)) || null,
                party_owner_wins: state.party_owner_wins,
                party_opponent_wins: state.party_opponent_wins,
                new_game_id: newGameIdFromServer,
                last_round_winner: state.lastRoundWinnerId
              });
            }
          } catch (e) {
            dbgLog('showSeriesModal from pollGameOnce failed', e);
          }
        }
      }

      // recompute playerChar
      if (state.userId) state.playerChar = computePlayerChar(state.userId);

      // ensure player UI reflects latest profiles
      updatePlayerUI();

      updateTurnUI();

      // If party_id or series_id changed, (re)subscribe score channels so we keep everyone's UI updated
      if (state.party_id !== prevPartyId || state.series_id !== prevSeriesId) {
        await setupScoreSubscriptions();
        // ensure party polling targets the new party_id
        startPartyPolling();
      }
    } catch (e) {
      dbgLog('pollGameOnce exception', e);
    }
  }

  // Polling to detect newly created games in the same party (fallback if realtime not available)
async function pollPartyNewGameOnce() {
  try {
    // quick exit si on ne connaît ni party ni les joueurs
    if (!state.party_id && !state.ownerId && !state.opponentId) return;

    // ---------- 1) fast path: recherche par party_id ----------
    if (state.party_id) {
      const { data: rows, error } = await supabase
        .from('games')
        .select('id, owner_id, opponent_id, party_id, created_at, match_id')
        .eq('party_id', state.party_id)
        .order('created_at', { ascending: false })
        .limit(1);

      if (!error && Array.isArray(rows) && rows.length) {
        const latest = rows[0];
        if (latest && latest.id) {
          // initialisation safe de lastPartyKnownGameId (première exécution)
          if (!state.lastPartyKnownGameId) {
            // propager match_id depuis le jeu polled (pratique si on arrive par polling)
            if (latest.match_id && !state.match_id) {
              state.match_id = String(latest.match_id);
              // exposeGameStateToWindow() existe dans ton fichier : appelle-le pour rafraîchir l'URL/état visible
              try { exposeGameStateToWindow(); } catch (e) { dbgLog('exposeGameStateToWindow failed', e); }
            }
            // IMPORTANT: initialize to the currently active gameId (URL or previously-joined).
            // Ne pas initialiser à latest.id ici sinon on raterait la détection si latest est déjà le nouveau jeu.
            state.lastPartyKnownGameId = String(gameId ?? '');
          }

          if (String(latest.id) !== String(gameId) && String(latest.id) !== String(state.lastPartyKnownGameId)) {
            dbgLog('pollPartyNewGameOnce detected new game (party)', latest.id);
            // fetch the full game row to pass to handler
            const { data: g, error: gerr } = await supabase
              .from('games')
              .select('*')
              .eq('id', latest.id)
              .maybeSingle();

            if (g && g.id) {
              // marquer connu maintenant pour éviter les races
              state.lastPartyKnownGameId = g.id;
              handleGlobalNewGameCreated(g).catch(e => dbgLog('handleGlobalNewGameCreated failed after poll detect', e));
              return;
            } else {
              dbgLog('pollPartyNewGameOnce: failed to fetch full game by party lookup', gerr);
            }
          }
        }
      } else if (error) {
        dbgLog('pollPartyNewGameOnce error on party lookup', error);
      }
    }

    // ---------- 2) fallback pair-based: recherche la dernière game entre les mêmes joueurs ----------
    // (utile quand une "nouvelle série" crée une nouvelle party_id)
    if (state.ownerId && state.opponentId) {
      const pairFilter = `or(and(owner_id.eq.${state.ownerId},opponent_id.eq.${state.opponentId}),and(owner_id.eq.${state.opponentId},opponent_id.eq.${state.ownerId}))`;
      const { data: pairRows, error: pairErr } = await supabase
        .from('games')
        .select('id, owner_id, opponent_id, party_id, created_at, match_id')
        .or(pairFilter)
        .order('created_at', { ascending: false })
        .limit(1);

      if (!pairErr && Array.isArray(pairRows) && pairRows.length) {
        const latestPair = pairRows[0];
        if (latestPair && latestPair.id &&
            String(latestPair.id) !== String(gameId) &&
            String(latestPair.id) !== String(state.lastPartyKnownGameId)) {
          dbgLog('pollPartyNewGameOnce detected new game (pair fallback)', latestPair.id);
          // fetch full row puis handle
          const { data: g2, error: g2err } = await supabase
            .from('games')
            .select('*')
            .eq('id', latestPair.id)
            .maybeSingle();

          if (g2 && g2.id) {
            state.lastPartyKnownGameId = g2.id;
            handleGlobalNewGameCreated(g2).catch(e => dbgLog('handleGlobalNewGameCreated failed after pair poll', e));
            return;
          } else {
            dbgLog('pollPartyNewGameOnce: failed to fetch full game by pair lookup', g2err);
          }
        }
      } else if (pairErr) {
        dbgLog('pollPartyNewGameOnce error on pair lookup', pairErr);
      }
    }

  } catch (e) {
    dbgLog('pollPartyNewGameOnce exception', e);
  }
}
  function startPartyPolling() {
    try {
      stopPartyPolling();
      if (!state.party_id) {
        dbgLog('startPartyPolling: no party_id, skipping');
        return;
      }
      dbgLog('startPartyPolling', state.party_id);
      pollers.partyGames = setInterval(() => pollPartyNewGameOnce().catch(e => dbgLog('pollPartyNewGameOnce error', e)), POLL_NEWGAME_MS);
      // run once immediately for faster detection
      pollPartyNewGameOnce().catch(e => dbgLog('pollPartyNewGameOnce immediate error', e));
    } catch (e) {
      dbgLog('startPartyPolling exception', e);
    }
  }
  function stopPartyPolling() {
    try {
      if (pollers.partyGames) clearInterval(pollers.partyGames);
      pollers.partyGames = null;
    } catch (e) { dbgLog('stopPartyPolling error', e); }
  }

  function startPolling() {
    stopPolling();
    dbgLog('startPolling');
    pollers.moves = setInterval(() => pollMovesOnce().catch(e => dbgLog('pollMoves error', e)), POLL_MOVES_MS);
    pollers.game = setInterval(() => pollGameOnce().catch(e => dbgLog('pollGame error', e)), POLL_GAME_MS);
    // start party polling (fallback detection of new games)
    startPartyPolling();
    pollMovesOnce().catch(()=>{});
    pollGameOnce().catch(()=>{});
  }
  function stopPolling() {
    try { if (pollers.moves) clearInterval(pollers.moves); } catch(_) {}
    try { if (pollers.game) clearInterval(pollers.game); } catch(_) {}
    pollers.moves = null; pollers.game = null;
    // stop party polling separately
    stopPartyPolling();
  }

  async function syncGameRow() {
    try {
      await pollGameOnce();
    } catch (e) { dbgLog('syncGameRow fail', e); }
  }

  // --- NEW FUNCTION: call rpc_finalize_round and handle response/UI/new game join ---
  async function callRpcFinalizeRound(p_game_id) {
    try {
      // Defensive: ensure the game row 'winner' column contains a proper UUID (owner/opponent)
      try {
        const { data: g, error: gerr } = await supabase
          .from('games')
          .select('id, winner, owner_id, opponent_id, status')
          .eq('id', p_game_id)
          .maybeSingle();
        if (g && !gerr) {
          // If winner missing or empty, attempt to infer from state or board and update row with UUID
          let winnerToSet = null;
          if (!g.winner) {
            // prefer state.winnerId if it exists and matches one of participants
            if (state.winnerId && (String(state.winnerId) === String(g.owner_id) || String(state.winnerId) === String(g.opponent_id))) {
              winnerToSet = state.winnerId;
            } else {
              // try inference from board: check if X or O has winning sequences
              let winnerChar = null;
              if (findWinningSequences(state.board, 'X').length) winnerChar = 'X';
              else if (findWinningSequences(state.board, 'O').length) winnerChar = 'O';
              if (winnerChar === 'X' && g.owner_id) winnerToSet = g.owner_id;
              if (winnerChar === 'O' && g.opponent_id) winnerToSet = g.opponent_id;
            }
            if (winnerToSet) {
              // Update games.winner with the UUID (ensures rpc_finalize_round sees a UUID)
              try {
                const { data: upd, error: uerr } = await supabase
                  .from('games')
                  .update({ winner: winnerToSet })
                  .eq('id', p_game_id);
                if (uerr) dbgLog('failed to update games.winner before finalize', uerr);
                else dbgLog('updated games.winner before finalize', winnerToSet);
              } catch (e) {
                dbgLog('update games.winner exception', e);
              }
            }
          } else {
            // winner present: nothing to do (assume DB type uuid); if it's string that equals owner/opponent, keep it.
          }
        }
      } catch (e) {
        dbgLog('pre-finalize winner normalization failed', e);
      }

      // finally call rpc_finalize_round
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

      // update state party/series from RPC return (scores updated for everyone)
      state.party_id = finalizeRow.party_id ?? state.party_id;
      state.party_owner_wins = Number(finalizeRow.party_owner_wins ?? state.party_owner_wins ?? 0);
      state.party_opponent_wins = Number(finalizeRow.party_opponent_wins ?? state.party_opponent_wins ?? 0);
      state.party_winner = finalizeRow.party_winner ?? state.party_winner;

      state.series_id = finalizeRow.series_id ?? state.series_id;
      state.series_owner_wins = Number(finalizeRow.series_owner_wins ?? state.series_owner_wins ?? 0);
      state.series_opponent_wins = Number(finalizeRow.series_opponent_wins ?? state.series_opponent_wins ?? 0);
      state.series_winner = finalizeRow.series_winner ?? state.series_winner;

      // Update UI counters immediately so everyone sees the new scores
      updatePlayerUI();

      // Ensure score subscriptions exist for new party/series
      await setupScoreSubscriptions();

      // Ensure lastRoundWinnerId is preserved for clients that may need it to compute starter
      if (!state.lastRoundWinnerId && state.winnerId) {
        state.lastRoundWinnerId = state.winnerId;
      }
     // Si le RPC renvoie un gagnant de party (fallback utile), l'utiliser pour initialiser lastRoundWinnerId
     // (Note : party_winner ≠ dernier round winner, mais cela peut servir de fallback si le client ne l'a pas)
     state.lastRoundWinnerId = finalizeRow.party_winner ?? state.lastRoundWinnerId;
      
      // --- NEW: if server created a new game, reset local board/state immediately for THIS client ---
      const newGameId = finalizeRow.new_game_id ?? null;
      if (newGameId) {
  // clear board and local counters
  state.board = {};
  state.moveCount = 0;
  state.lastMoveIndex = 0;
  state.status = 'playing';

  // clear last winner display for the old finished game so outcome modal/sounds won't replay
  // but keep lastRoundWinnerId (we use it as fallback)
  state.winnerId = null;
  state.winnerPseudo = null;
  state.outcomeShownForGameId = null;

  gameId = newGameId;
  exposeGameStateToWindow();

  // === PATCH: remove previous modals to avoid blocking other clients when finalize created a new game ===
  try {
    const om = document.getElementById('taktik-outcome-modal');
    if (om) om.remove();
    const nm = document.getElementById('taktik-new-round-modal');
    if (nm) nm.remove();
    const sm = document.getElementById('taktik-series-modal');
    if (sm) sm.remove();
  } catch(e){ dbgLog('finalize modal cleanup failed', e); }

  // re-render an empty board for this client (so loser sees cleared board immediately when they join)
  renderBoard(state.board);
  updateTurnUI();
}

      // Show modal "nouvelle manche" with info and a button to join the new game (if present).
      // Winner sees it too (but winner will immediately auto-join below)
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
      if (newGameId) state.newRoundShownForGameId = newGameId;

      // If finalizeRow signals a finished series -> show series modal once and include option to start new series
      if (finalizeRow.series_winner && String(state.seriesFinishedShownForSeriesId) !== String(state.series_id)) {
        showSeriesModal({
          series_id: state.series_id,
          series_owner_wins: state.series_owner_wins,
          series_opponent_wins: state.series_opponent_wins,
          series_winner: state.series_winner,
          series_winner_pseudo: (state.series_winner && (String(state.series_winner) === String(state.ownerId) ? state.ownerProfile?.pseudo : state.opponentProfile?.pseudo)) || null,
          party_owner_wins: state.party_owner_wins,
          party_opponent_wins: state.party_opponent_wins,
          new_game_id: finalizeRow.new_game_id ?? null,
          last_round_winner: state.lastRoundWinnerId ?? null        });
      }

      // Make sure party poller knows about the new game immediately (helps other clients detect it)
      if (state.party_id) {
        // set last known so pollers won't re-handle current game accidentally
        state.lastPartyKnownGameId = String(newGameId ?? state.lastPartyKnownGameId ?? '');
        // kick an immediate poll (others will pick up soon if they poll)
        pollPartyNewGameOnce().catch(e => dbgLog('immediate pollPartyNewGameOnce after finalize failed', e));
      }

      // If new_game_id is provided, join it automatically (this is the winner who called finalize)
      if (newGameId) {
        dbgLog('Joining newly created game returned by rpc_finalize_round', newGameId);
        // starterChar: winner should start next game (if known)
        const starterChar = options.starterChar ?? (state.lastRoundWinnerId ? (String(state.lastRoundWinnerId) === String(state.ownerId) ? 'X' : 'O') : null);
        await joinNewGame(newGameId, starterChar);
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
      if (!state.initialSyncDone) {
  dbgLog('suppress new-round modal until initial sync');
  if (info && info.new_game_id) state.newRoundShownForGameId = info.new_game_id;
  return;
}
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
        // find the joinBtn.onclick = async () => { ... } and replace body with:
joinBtn.onclick = async () => {
  overlay.remove();
  // Determine starterChar: prefer provided last_round_winner, then state.lastRoundWinnerId
  let starterChar = null;
  if (info.last_round_winner) {
    if (String(info.last_round_winner) === String(state.ownerId)) starterChar = 'X';
    else if (String(info.last_round_winner) === String(state.opponentId)) starterChar = 'O';
  } else if (state.lastRoundWinnerId) {
    if (String(state.lastRoundWinnerId) === String(state.ownerId)) starterChar = 'X';
    else if (String(state.lastRoundWinnerId) === String(state.opponentId)) starterChar = 'O';
  }

  try {
    // this will reset board locally and resync the game/party/series for this client
    await joinNewGame(info.new_game_id, starterChar);

    // after joining, ensure we have fresh subscriptions and UI counters
    try { await setupScoreSubscriptions(); } catch(e){ dbgLog('post-join setupScoreSubscriptions failed', e); }
    updatePlayerUI();
  } catch (e) {
    dbgLog('joinNewGame from series modal failed', e);
    // fallback poll to resync if joinNewGame failed
    await pollGameOnce();
  }
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

  // Show a modal when a series is finished (with optional join button for the new game)
  // --- MODIFIED: add "Nouvelle série" button (visible to series winner) that calls rpc_new_game (with parent_id)
  async function showSeriesModal(info = {}) {
    try {
      if (!state.initialSyncDone) {
  dbgLog('suppress series modal until initial sync');
  if (info && info.series_id) state.seriesFinishedShownForSeriesId = info.series_id;
  return;
}
      // prevent duplicates: info.series_id may be null but we still guard by series_id
      const prev = document.getElementById('taktik-series-modal');
      if (prev) prev.remove();

      const overlay = document.createElement('div');
      overlay.id = 'taktik-series-modal';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = 'rgba(0,0,0,0.65)';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '10001';
      overlay.style.padding = '16px';

      const box = document.createElement('div');
      box.style.width = 'min(560px, 96%)';
      box.style.maxWidth = '560px';
      box.style.background = '#fff';
      box.style.borderRadius = '12px';
      box.style.boxShadow = '0 20px 40px rgba(0,0,0,0.35)';
      box.style.padding = '20px';
      box.style.textAlign = 'center';
      overlay.appendChild(box);

      const title = document.createElement('h3');
      title.style.margin = '0 0 8px 0';
      title.style.fontSize = '20px';
      title.textContent = info.series_winner ? 'Série terminée' : 'Série — résultat';
      box.appendChild(title);

      const winnerName = (info.series_winner_pseudo || (info.series_winner ? String(info.series_winner).slice(0,8) : null));
      const winnerLine = document.createElement('div');
      winnerLine.style.margin = '6px 0 12px';
      winnerLine.style.fontSize = '15px';
      if (info.series_winner) {
        winnerLine.innerHTML = `La série est remportée par <strong>${winnerName}</strong>`;
      } else {
        winnerLine.textContent = 'La série est terminée.';
      }
      box.appendChild(winnerLine);

      const details = document.createElement('div');
      details.style.fontSize = '14px';
      details.style.color = '#333';
      details.style.marginBottom = '14px';
      details.innerHTML = `
        <div>Score de la manche (partie) — Joueur 1 : <strong>${info.party_owner_wins ?? '0'}</strong> — Joueur 2 : <strong>${info.party_opponent_wins ?? '0'}</strong></div>
        <div style="margin-top:6px">Score de la série — Joueur 1 : <strong>${info.series_owner_wins ?? '0'}</strong> — Joueur 2 : <strong>${info.series_opponent_wins ?? '0'}</strong></div>
      `;
      box.appendChild(details);

      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '10px';
      btns.style.justifyContent = 'center';
      btns.style.alignItems = 'center';

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Fermer';
      closeBtn.style.padding = '8px 12px';
      closeBtn.style.borderRadius = '6px';
      closeBtn.style.border = '1px solid #ccc';
      closeBtn.onclick = () => overlay.remove();
      btns.appendChild(closeBtn);

      // If new_game_id is given (server created new game for the new series/first manche), allow joining
      if (info.new_game_id) {
        const joinBtn = document.createElement('button');
        joinBtn.textContent = 'Rejoindre la nouvelle partie';
        joinBtn.style.padding = '8px 12px';
        joinBtn.style.borderRadius = '6px';
        joinBtn.style.border = 'none';
        joinBtn.style.background = '#0b84ff';
        joinBtn.style.color = '#fff';
        joinBtn.style.fontWeight = '600';

        // find the joinBtn.onclick = async () => { ... } and replace body with:
joinBtn.onclick = async () => {
  overlay.remove();
  // Determine starterChar: prefer provided last_round_winner, then state.lastRoundWinnerId
  let starterChar = null;
  if (info.last_round_winner) {
    if (String(info.last_round_winner) === String(state.ownerId)) starterChar = 'X';
    else if (String(info.last_round_winner) === String(state.opponentId)) starterChar = 'O';
  } else if (state.lastRoundWinnerId) {
    if (String(state.lastRoundWinnerId) === String(state.ownerId)) starterChar = 'X';
    else if (String(state.lastRoundWinnerId) === String(state.opponentId)) starterChar = 'O';
  }

  try {
    // this will reset board locally and resync the game/party/series for this client
    await joinNewGame(info.new_game_id, starterChar);

    // after joining, ensure we have fresh subscriptions and UI counters
    try { await setupScoreSubscriptions(); } catch(e){ dbgLog('post-join setupScoreSubscriptions failed', e); }
    updatePlayerUI();
  } catch (e) {
    dbgLog('joinNewGame from series modal failed', e);
    // fallback poll to resync if joinNewGame failed
    await pollGameOnce();
  }
};
        btns.appendChild(joinBtn);
      }

      // --- NEW: Allow the series winner to immediately create a new series (parent link to previous)
      // Show if the current user is the winner of the series
      try {
        const userIsSeriesWinner = state.userId && info.series_winner && (String(state.userId) === String(info.series_winner));
        if (userIsSeriesWinner && info.series_id) {
          const newSeriesBtn = document.createElement('button');
          newSeriesBtn.textContent = 'Nouvelle série';
          newSeriesBtn.style.padding = '8px 12px';
          newSeriesBtn.style.borderRadius = '6px';
          newSeriesBtn.style.border = 'none';
          newSeriesBtn.style.background = '#28a745';
          newSeriesBtn.style.color = '#fff';
          newSeriesBtn.style.fontWeight = '600';
          newSeriesBtn.onclick = async () => {
            // disable to prevent double-clicks
            newSeriesBtn.disabled = true;
            newSeriesBtn.textContent = 'Création...';
            overlay.remove();
            try {
              await createNewSeriesFromSeries(info.series_id, info.last_round_winner ?? state.lastRoundWinnerId);
            } catch (e) {
              dbgLog('createNewSeriesFromSeries failed', e);
              await pollGameOnce();
            }
          };
          btns.appendChild(newSeriesBtn);
        }
      } catch (e) {
        dbgLog('series winner button rendering failed', e);
      }

      box.appendChild(btns);
      document.body.appendChild(overlay);

      // mark as shown to prevent duplicates if series_id is provided
      if (info.series_id) {
        state.seriesFinishedShownForSeriesId = info.series_id;
      }
    } catch (e) {
      dbgLog('showSeriesModal failed', e);
    }
  }

  // Create a new series (child) using rpc_new_game and join its first game.
  // parentSeriesId: uuid of the finished series to be recorded as parent
  // lastRoundWinner: optional uuid to determine starterChar
  async function createNewSeriesFromSeries(parentSeriesId, lastRoundWinner = null) {
    try {
      if (!state.ownerId || !state.opponentId) {
        // need participants
        await pollGameOnce();
      }
      const ownerId = state.ownerId;
      const opponentId = state.opponentId;
      if (!ownerId || !opponentId) {
        throw new Error('Impossible de créer une nouvelle série: participants inconnus.');
      }

      // Determine starter char: winner of previous series starts (if known)
      let starterChar = 'X';
      if (lastRoundWinner) {
        if (String(lastRoundWinner) === String(ownerId)) starterChar = 'X';
        else if (String(lastRoundWinner) === String(opponentId)) starterChar = 'O';
      } else if (state.lastRoundWinnerId) {
        if (String(state.lastRoundWinnerId) === String(ownerId)) starterChar = 'X';
        else if (String(state.lastRoundWinnerId) === String(opponentId)) starterChar = 'O';
      }

      // Call rpc_new_game: p_parent_series_id will link child to parent
      const { data, error } = await supabase.rpc('rpc_new_game', {
        p_owner_id: ownerId,
        p_opponent_id: opponentId,
        p_target_parties: 3,
        p_target_games: 3,
        p_parent_series_id: parentSeriesId,
        p_starter_char: starterChar
      });

      if (error) {
        dbgLog('rpc_new_game error', error);
        throw error;
      }

      const resp = Array.isArray(data) ? data[0] : data;
      if (!resp || !resp.new_game_id) {
        dbgLog('rpc_new_game returned no new_game_id', resp);
        // fallback: poll latest games to find one with parent reference (best-effort)
        await pollGameOnce();
        return null;
      }

      // join the newly created game immediately
      const newGameId = resp.new_game_id;
      // update state with new series id if provided
      state.series_id = resp.new_series_id ?? state.series_id;
      state.party_id = resp.new_party_id ?? state.party_id;

      // reset local board and UI for immediate join
      await joinNewGame(newGameId, starterChar);
      return resp;
    } catch (e) {
      dbgLog('createNewSeriesFromSeries exception', e);
      throw e;
    }
  }

  // --- REPLACE existing joinNewGame ---
async function joinNewGame(newGameId, starterChar = null) {
  try {
    if (!newGameId) return;
    // avoid joining the same game twice
    if (String(newGameId) === String(gameId)) {
      dbgLog('joinNewGame: already in that game, skipping', newGameId);
      return;
    }

    // cleanup old game-specific channels (but keep globalGamesChannel)
    try {
      for (const ch of channels) {
        if (ch && ch._topic && String(ch._topic).startsWith('game:')) {
          try { await ch.unsubscribe(); } catch(e) { dbgLog('unsubscribe fail', e); }
          try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(ch); } catch(e) {}
        }
      }
    } catch (e) { dbgLog('cleanup channels on new game', e); }

    // keep only non-game channels in channels array (like globalGamesChannel)
    channels = channels.filter(ch => !(ch && ch._topic && String(ch._topic).startsWith('game:')));

    // reset local minimal state (ready to join new game)
    // reset local minimal state (ready to join new game)
state.board = {};
state.moveCount = 0;
state.lastMoveIndex = 0;
state.status = 'playing';
state.winnerPseudo = null;
state.winnerId = null;
state.outcomeShownForGameId = null;

// recompute playerChar in case user/player ids changed
state.playerChar = computePlayerChar(state.userId);


// === PATCH: remove blocking modals so loser is not stuck ===
try {
  const om = document.getElementById('taktik-outcome-modal');
  if (om) om.remove();
  const nm = document.getElementById('taktik-new-round-modal');
  if (nm) nm.remove();
  const sm = document.getElementById('taktik-series-modal');
  if (sm) sm.remove();
} catch (e) {
  dbgLog('joinNewGame modal cleanup failed', e);
}

// Immediately render empty board so UI resets instantly
try { renderBoard(state.board); } catch (e) { dbgLog('renderBoard failed', e); }
try { updateTurnUI(); } catch (e) {}
    // set new game id locally
    gameId = newGameId;
    exposeGameStateToWindow();
    // Ensure URL reflects the newly joined game so refresh lands on it.
try {
  const u = new URL(window.location.href);
  const params = u.searchParams;
  params.set('game_id', String(newGameId));
  // preserve match_id if present in state
  if (state.match_id) params.set('match_id', String(state.match_id));
  // replace state without navigation
  history.replaceState(null, '', `${u.pathname}?${params.toString()}`);
} catch (e) {
  dbgLog('update URL on joinNewGame failed', e);
}
    
    // reset outcomeShownForGameId so modal/sound can appear for the new game later
    state.outcomeShownForGameId = null;

    // set lastPartyKnownGameId so party poller doesn't re-handle this newly joined game
    if (state.party_id) state.lastPartyKnownGameId = String(newGameId);

    // refresh authoritative state from server for the new game
    await pollGameOnce();

    // --- EXTRA: ensure party/series rows & match_id are populated for this client ---
    try {
      // if pollGameOnce didn't fill party_id / series_id (edge cases), try to fetch from games row
      if (!state.party_id || !state.series_id) {
        const { data: grow, error: gerr } = await supabase
          .from('games')
          .select('party_id, owner_id, opponent_id, match_id')
          .eq('id', newGameId)
          .maybeSingle();
        if (!gerr && grow) {
          state.party_id = grow.party_id ?? state.party_id;
          // owner/opponent may be useful for computePlayerChar & starter logic
          state.ownerId = grow.owner_id ?? state.ownerId;
          state.opponentId = grow.opponent_id ?? state.opponentId;
          state.match_id = grow.match_id ?? state.match_id;
          exposeGameStateToWindow();
        }
      }

      // fetch party & series rows to populate scores (best-effort)
      if (state.party_id) {
        const { data: prow, error: perr } = await supabase
          .from('parties')
          .select('id, owner_wins, opponent_wins, winner_id, series_id, match_id')
          .eq('id', state.party_id)
          .maybeSingle();
        if (!perr && prow) {
          state.party_owner_wins = Number(prow.owner_wins ?? state.party_owner_wins ?? 0);
          state.party_opponent_wins = Number(prow.opponent_wins ?? state.party_opponent_wins ?? 0);
          state.party_winner = prow.winner_id ?? state.party_winner;
          // propagate match_id if present
          if (prow.match_id && !state.match_id) {
            state.match_id = prow.match_id;
            exposeGameStateToWindow();
          }
        }
      }
      if (state.series_id) {
        const { data: srow, error: serr } = await supabase
          .from('series')
          .select('id, owner_wins, opponent_wins, winner_id, target_parties, match_id')
          .eq('id', state.series_id)
          .maybeSingle();
         if (!serr && srow) {
          // Ne pas écraser une valeur locale déjà non-null/non-zero (ex: venant de rpc_finalize_round)
          if (!state.series_owner_wins) {
            state.series_owner_wins = Number(srow.owner_wins ?? state.series_owner_wins ?? 0);
          }
          if (!state.series_opponent_wins) {
            state.series_opponent_wins = Number(srow.opponent_wins ?? state.series_opponent_wins ?? 0);
          }
          state.series_winner = srow.winner_id ?? state.series_winner;
          if (srow.match_id && !state.match_id) {
            state.match_id = srow.match_id;
            exposeGameStateToWindow();
          }
        }
      }
    } catch(e) {
      dbgLog('joinNewGame: best-effort fetch party/series failed', e);
    }

    // If starterChar provided, set it as currentTurn (ensures winner can place first)
    if (starterChar === 'X' || starterChar === 'O') {
      state.currentTurn = starterChar;
    } else {
      // prefer server's currentTurn if any
      state.currentTurn = state.currentTurn ?? 'X';
    }

    // render the (empty or server) board
    renderBoard(state.board);

    // re-subscribe realtime for this game
    await setupRealtime();

    // ensure global games channel exists to detect other creations
    await setupGlobalGamesInsertSubscription();

    // ensure polling is active if realtime not active
    startPolling();

    // ensure score subscriptions and UI counters reflect current party/series
    try {
      await setupScoreSubscriptions();
    } catch(e) { dbgLog('setupScoreSubscriptions after join failed', e); }
    updatePlayerUI();

    // dispatch event for external listeners
    try { document.dispatchEvent(new CustomEvent('taktik:joined-new-game', { detail: { gameId } })); } catch(e) {}

    // small notification
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

  // ---- Outcome modal (winner / loser) + sounds ----
  function playSound(src) {
    try {
      if (!src) return;
      const a = new Audio(src);
      // ignore autoplay rejections, try to play
      a.play().catch(e => dbgLog('sound play failed', e));
    } catch (e) { dbgLog('playSound exception', e); }
  }

  function showOutcomeModal({ winnerId = null, winnerPseudo = null } = {}) {
    try {
      // suppress outcome modal until initial sync completed
if (!state.initialSyncDone) {
  dbgLog('suppress outcome modal until initial sync');
  // avoid duplicate later
  state.outcomeShownForGameId = gameId;
  return;
}
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
            e.style.opacity = '0';
            e.style.transform = `rotate(${Math.random()*360}deg) translateY(30px)`;
          }, 30 + Math.random()*200);
          setTimeout(()=> { try{ e.remove(); }catch(_){} }, 1800 + Math.random()*800);
        }
      }

      // detect if current user is the loser (to play defeat sound)
      const amLoser = state.userId && winnerId && (String(state.userId) !== String(winnerId)) && (String(state.userId) === String(state.ownerId) || String(state.userId) === String(state.opponentId));

      // header
      const big = document.createElement('div');
      big.style.fontSize = '34px';
      big.style.marginTop = '6px';
      big.style.marginBottom = '8px';
      big.textContent = 'Partie terminée';
      box.appendChild(big);

      const who = document.createElement('div');
      who.style.marginBottom = '12px';
      who.style.fontSize = '15px';
      if (amLoser) {
  // afficher correctement que le gagnant a battu le perdant
  if (winnerPseudo) who.textContent = `${winnerPseudo} vous a battu.`;
  else who.textContent = 'Vous avez perdu.';
} else {
        // spectator
        if (winnerPseudo) who.textContent = `${winnerPseudo} a gagné.`;
        else who.textContent = 'La partie est terminée.';
      }
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

      // play defeat sound only if user is a loser (not for spectators)
if (amLoser) playSound(DEFEAT_SOUND);

// play victory sound only for the winner (not for spectators)
if (state.userId && winnerId && String(state.userId) === String(winnerId)) {
  playSound(VICTORY_SOUND);
}
      // Winner action button: "Continuer de jouer" (calls rpc_finalize_round)
      if (state.userId && winnerId && String(state.userId) === String(winnerId)) {
        const continueBtn = document.createElement('button');
        continueBtn.textContent = 'Continuer de jouer';
        continueBtn.style.padding = '10px 14px';
        continueBtn.style.borderRadius = '8px';
        continueBtn.style.border = 'none';
        continueBtn.style.marginLeft = '8px';
        continueBtn.style.background = '#0b84ff';
        continueBtn.style.color = '#fff';
        continueBtn.onclick = async () => {
          continueBtn.disabled = true;
          try {
            // Winner clicks: finalize the round (server will create next game or next series if needed)
            const res = await handleFinalizeRoundAndFollowup(gameId, { starterChar: null });
            dbgLog('finalize result for winner', res);
          } catch (e) {
            dbgLog('winner finalize failed', e);
            await pollGameOnce();
          } finally {
            try { overlay.remove(); } catch(_) {}
          }
        };
        box.appendChild(continueBtn);

        // small confetti launch for visual effect
        launchEmojis();
      }

      document.body.appendChild(overlay);
    } catch (e) {
      dbgLog('showOutcomeModal failed', e);
    }
  }

  // --- Score subscription helpers (realtime) ---
  async function cleanupScoreSubscriptions() {
    try {
      if (scoreSubscriptions.party) {
        try { await scoreSubscriptions.party.unsubscribe(); } catch(e) { dbgLog('unsubscribe party fail', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(scoreSubscriptions.party); } catch(e) {}
        scoreSubscriptions.party = null;
      }
      if (scoreSubscriptions.series) {
        try { await scoreSubscriptions.series.unsubscribe(); } catch(e) { dbgLog('unsubscribe series fail', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(scoreSubscriptions.series); } catch(e) {}
        scoreSubscriptions.series = null;
      }
    } catch (e) {
      dbgLog('cleanupScoreSubscriptions exception', e);
    }
  }

  async function setupScoreSubscriptions() {
    try {
      // clear previous
      await cleanupScoreSubscriptions();

      // subscribe to party updates
      if (state.party_id) {
        const pchan = supabase.channel(`party:${state.party_id}`);
        scoreSubscriptions.party = pchan;
        channels.push(pchan);

        pchan.on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'parties', filter: `id=eq.${state.party_id}`
        }, payload => {
          const row = payload?.new;
          if (!row) return;
          try {
            state.party_owner_wins = Number(row.owner_wins ?? state.party_owner_wins ?? 0);
            state.party_opponent_wins = Number(row.opponent_wins ?? state.party_opponent_wins ?? 0);
            state.party_winner = row.winner_id ?? state.party_winner;
            updatePlayerUI();
            // if party finished -> maybe trigger showSeriesModal on clients that need it (but server finalize does that)
          } catch (e) { dbgLog('party subscription handler error', e); }
        });

        try { await pchan.subscribe(); } catch(e){ dbgLog('subscribe party channel failed', e); }
      }

      // subscribe to series updates
      if (state.series_id) {
        const schan = supabase.channel(`series:${state.series_id}`);
        scoreSubscriptions.series = schan;
        channels.push(schan);

        schan.on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'series', filter: `id=eq.${state.series_id}`
        }, payload => {
          const row = payload?.new;
          if (!row) return;
          try {
            state.series_owner_wins = Number(row.owner_wins ?? state.series_owner_wins ?? 0);
            state.series_opponent_wins = Number(row.opponent_wins ?? state.series_opponent_wins ?? 0);
            state.series_winner = row.winner_id ?? state.series_winner;
            updatePlayerUI();
            // show series modal if winner is decided and we haven't shown it
            if (state.series_winner && String(state.seriesFinishedShownForSeriesId) !== String(state.series_id)) {
              showSeriesModal({
                series_id: state.series_id,
                series_owner_wins: state.series_owner_wins,
                series_opponent_wins: state.series_opponent_wins,
                series_winner: state.series_winner,
                series_winner_pseudo: (state.series_winner && (String(state.series_winner) === String(state.ownerId) ? state.ownerProfile?.pseudo : state.opponentProfile?.pseudo)) || null,
                party_owner_wins: state.party_owner_wins,
                party_opponent_wins: state.party_opponent_wins,
                new_game_id: null,
                last_round_winner: state.lastRoundWinnerId
              });
            }
          } catch (e) { dbgLog('series subscription handler error', e); }
        });

        try { await schan.subscribe(); } catch(e){ dbgLog('subscribe series channel failed', e); }
      }
    } catch (e) {
      dbgLog('setupScoreSubscriptions exception', e);
    }
  }

  // startup: create grid + get user + initial poll + realtime + score subscriptions
  async function startup() {
    try {
      createGrid();
      const u = await getUser();
      if (u) {
        state.userId = u.id;
        state.playerChar = computePlayerChar(state.userId);
      }

      // If we were given an invitation id, try to resolve to game id
      if (!gameId && invitationId) {
        const gid = await waitForGameIdFromInvitation(invitationId, 8000, 400);
        if (gid) gameId = gid;
      }

      if (!gameId) {
        dbgLog('startup: no gameId provided, nothing to do yet.');
        return;
      }

      // initial sync
      // before first authoritative sync: show loading overlay
// <<< PATCH: éviter d'afficher les modales sur reload initial
if (gameId) {
  state.outcomeShownForGameId = String(gameId);
  state.newRoundShownForGameId = String(gameId);
}
// si on connaît déjà une série, marquer la modal de série comme "déjà vue"
if (state.series_id) state.seriesFinishedShownForSeriesId = String(state.series_id);
      showLoadingOverlay();
try {
  await pollGameOnce();
} finally {
  // mark initial sync done so modals can appear safely and remove overlay
  state.initialSyncDone = true;
  hideLoadingOverlay();
}
      if (state.match_id) {
  await setupMatchSubscription(state.match_id);
}
      // subscribe realtime
      await setupRealtime();
      // ensure global games insert subscription exists
      await setupGlobalGamesInsertSubscription();
      // subscribe to party/series score changes
      await setupScoreSubscriptions();

      // start polling fallback
      startPolling();
    } catch (e) {
      dbgLog('startup failed', e);
    }
  }

  // run startup
  startup().catch(e => dbgLog('startup exception', e));

  // return some helpers for tests/console
  return {
    getState: () => state,
    getGameId: () => gameId,
    joinNewGame,
    createNewSeriesFromSeries,
    finalizeRound: () => handleFinalizeRoundAndFollowup(gameId)
  };
}
