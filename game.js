// game.js
// Usage: import('./game.js').then(m => m.default(supabase));
// Builds 20x20 board, places moves via RPC `rpc_place_move` and uses realtime + polling fallback.
//
// Assumptions:
// - page has #boardGrid (20x20 grid CSS in game.html).
// - game_id passed in query (or invitation_id which we try to resolve).
// - rpc_place_move(p_game_id, p_position, p_row, p_col, p_player) exists server-side.

export default async function initGame(supabaseClient) {
  const supabase = supabaseClient ?? window.supabase;
  const DBG = true;

  function dbg(...args){ if(DBG) console.debug('[game.js]', ...args); }
  function qId(id){ return document.getElementById(id); }

  if (!supabase) {
    console.error('Supabase client missing (window.supabase or param).');
    return;
  }

  // ----- helpers -----
  function params() {
    const u = new URL(window.location.href);
    return {
      game_id: u.searchParams.get('game_id'),
      invitation_id: u.searchParams.get('invitation_id'),
      from_invite: u.searchParams.get('from_invite')
    };
  }

  function toPos(r, c){ return r * 20 + c; }
  function fromPos(pos){ return { r: Math.floor(pos / 20), c: pos % 20 }; }

  async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  async function getSessionUser() {
    try {
      const s = await supabase.auth.getSession();
      return s?.data?.session?.user ?? null;
    } catch (e) {
      dbg('getSessionUser err', e);
      return null;
    }
  }

  // Try to resolve a game_id from invitation (used when create_game redirected with invitation_id only)
  async function resolveGameIdFromInvitation(invId, attempts = 8, delay = 500) {
    if (!invId) return null;
    for (let i = 0; i < attempts; i++) {
      try {
        const { data: inv } = await supabase.from('game_invitations').select('game_id,status,series_id').eq('id', invId).maybeSingle();
        if (inv?.game_id) return inv.game_id;
        if (inv?.status === 'accepted' && !inv.game_id) {
          // fallback: try to find recent game for series
          if (inv.series_id) {
            const { data: parties } = await supabase.from('parties').select('id').eq('series_id', inv.series_id).order('created_at', {ascending:false}).limit(8);
            if (Array.isArray(parties) && parties.length) {
              const pids = parties.map(p => p.id);
              const { data: games } = await supabase.from('games').select('id,owner_id,opponent_id').in('party_id', pids).order('created_at',{ascending:false}).limit(12);
              if (Array.isArray(games) && games.length) return games[0].id;
            }
          }
        }
      } catch (e) { dbg('resolveGameIdFromInvitation err', e); }
      await sleep(delay);
    }
    return null;
  }

  // Fetch canonical game row
  async function fetchGame(gameId) {
    if (!gameId) return null;
    try {
      const { data, error } = await supabase
        .from('games')
        .select('id,owner_id,opponent_id,board,move_count,current_turn,status,winner')
        .eq('id', gameId)
        .maybeSingle();
      if (error) {
        dbg('fetchGame err', error);
        return null;
      }
      return data ?? null;
    } catch (e) {
      dbg('fetchGame exception', e);
      return null;
    }
  }

  // ----- UI build -----
  const boardGrid = qId('boardGrid');
  if (!boardGrid) {
    console.error('game.js: #boardGrid missing in DOM (expected in game.html).');
    return;
  }

  // build skeleton 20x20 (only once)
  function buildBoardSkeleton() {
    boardGrid.innerHTML = '';
    boardGrid.style.gridTemplateColumns = 'repeat(20, var(--cell-size))';
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        const pos = toPos(r,c);
        const cell = document.createElement('div');
        cell.className = 'board-cell';
        cell.dataset.pos = String(pos);
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label', `Cell ${r},${c}`);
        // inner content placeholder
        cell.innerHTML = '<span class="cell-mark" aria-hidden="true"></span>';
        boardGrid.appendChild(cell);
      }
    }
  }

  function renderBoardFromJson(boardObj) {
    // boardObj: { "0":"X", "1":"O", ... } or null
    // clear all first
    const cells = boardGrid.querySelectorAll('.board-cell');
    cells.forEach(cell => {
      cell.classList.remove('piece-x','piece-o','aligned','background-img');
      const span = cell.querySelector('.cell-mark');
      if (span) span.textContent = '';
      cell.dataset.occupied = 'false';
    });
    if (!boardObj) return;
    for (const key of Object.keys(boardObj)) {
      const val = boardObj[key];
      const pos = Number(key);
      if (Number.isNaN(pos)) continue;
      const cell = boardGrid.querySelector(`.board-cell[data-pos="${pos}"]`);
      if (!cell) continue;
      const span = cell.querySelector('.cell-mark');
      if (val === 'X') {
        cell.classList.add('piece-x');
        if (span) span.textContent = 'X';
      } else if (val === 'O') {
        cell.classList.add('piece-o');
        if (span) span.textContent = 'O';
      } else {
        if (span) span.textContent = val ?? '';
      }
      cell.dataset.occupied = 'true';
    }
  }

  function setAlignedPositions(alignedPositions = []) {
    // alignedPositions: list of pos ints (optional). We'll simply add .aligned class to them.
    // (rpc_place_move returns aligned_count but not exact positions; this is optional)
    // Clear previous
    boardGrid.querySelectorAll('.board-cell.aligned').forEach(el => el.classList.remove('aligned'));
    if (!Array.isArray(alignedPositions)) return;
    for (const p of alignedPositions) {
      const cell = boardGrid.querySelector(`.board-cell[data-pos="${p}"]`);
      if (cell) cell.classList.add('aligned');
    }
  }

  // update current-turn UI
  function updateTurnDisplay(symbolOrText) {
    const el = qId('currentTurn');
    if (el) el.textContent = symbolOrText ?? '—';
  }

  // ----- game loop state -----
  let GAME_ID = null;
  let localGame = null; // latest canonical row
  let me = null;
  let mySymbol = null; // 'X' or 'O' or null if spectator
  let chan = null;
  let pollingTimer = null;
  let pollIntervalMs = 800;
  let subscribed = false;
  let clickEnabled = true;

  // Fetch session & game + determine symbol
  async function bootstrap() {
    // resolve params
    const p = params();
    dbg('params', p);

    // if invitation_id provided but no game_id: try resolve
    let gid = p.game_id;
    if (!gid && p.invitation_id) {
      dbg('bootstrap: resolving invitation -> game_id', p.invitation_id);
      gid = await resolveGameIdFromInvitation(p.invitation_id, 10, 500);
      if (!gid) {
        dbg('bootstrap: could not resolve game_id from invitation - will still open page and poll for game creation.');
        // we'll keep invitation_id in mind and poll for game creation below
      }
    }

    GAME_ID = gid;
    dbg('bootstrap: initial GAME_ID', GAME_ID);

    me = await getSessionUser();
    dbg('bootstrap: session user', me?.id);

    buildBoardSkeleton();

    if (GAME_ID) {
      await loadAndRender(GAME_ID);
      trySubscribe(GAME_ID);
    } else {
      // no game id yet: start polling invitation row every 1s to find game_id
      startInvitationResolverPolling(p.invitation_id);
    }

    // wire clicks
    attachClickHandlers();
    window.dispatchEvent(new Event('taktik:joined'));
  }

  async function startInvitationResolverPolling(invId) {
    if (!invId) return;
    let attempts = 0;
    const maxAttempts = 120; // ~2 minutes
    const intMs = 1000;
    const t = setInterval(async () => {
      attempts++;
      if (GAME_ID) { clearInterval(t); return; }
      try {
        const { data: inv } = await supabase.from('game_invitations').select('game_id,status').eq('id', invId).maybeSingle();
        if (inv?.game_id) {
          GAME_ID = inv.game_id;
          dbg('invitationResolver found game_id', GAME_ID);
          await loadAndRender(GAME_ID);
          trySubscribe(GAME_ID);
          clearInterval(t);
        } else if (inv?.status && inv.status !== 'pending') {
          dbg('invitationResolver: invitation ended with status', inv.status);
          clearInterval(t);
        }
      } catch (e) {
        dbg('invitationResolver poll err', e);
      }
      if (attempts >= maxAttempts) clearInterval(t);
    }, intMs);
  }

  // Load canonical game and render
  async function loadAndRender(gameId) {
    const g = await fetchGame(gameId);
    if (!g) {
      dbg('loadAndRender: no game row found for', gameId);
      return;
    }
    localGame = g;
    // determine mySymbol
    if (me && (String(me.id) === String(g.owner_id))) mySymbol = 'X';
    else if (me && (String(me.id) === String(g.opponent_id))) mySymbol = 'O';
    else mySymbol = null; // spectator

    dbg('loadAndRender: mySymbol', mySymbol, 'game.current_turn', g.current_turn);
    renderBoardFromJson(g.board);
    updateTurnDisplay(g.current_turn ?? (g.status === 'finished' ? '—' : '—'));
    // update other UI like scores if present (left minimal)
    // enable/disable clicking depending on spectator/turn
    updateClickability();
  }

  function updateClickability() {
    clickEnabled = true;
    if (!localGame) clickEnabled = false;
    if (!mySymbol) clickEnabled = false;
    if (localGame && localGame.status !== 'playing') clickEnabled = false;
    if (localGame && localGame.current_turn && mySymbol && localGame.current_turn !== mySymbol) clickEnabled = false;
    // add aria-disabled to cells visually
    boardGrid.querySelectorAll('.board-cell').forEach(cell => {
      if (clickEnabled && cell.dataset.occupied !== 'true') {
        cell.style.cursor = 'pointer';
      } else {
        cell.style.cursor = 'default';
      }
    });
  }

  // handle click to place move
  function attachClickHandlers() {
    boardGrid.addEventListener('click', async (ev) => {
      const cell = ev.target.closest('.board-cell');
      if (!cell) return;
      const pos = Number(cell.dataset.pos);
      const r = Number(cell.dataset.row);
      const c = Number(cell.dataset.col);
      if (Number.isNaN(pos)) return;

      if (!clickEnabled) {
        dbg('click ignored: not allowed now');
        return;
      }
      if (cell.dataset.occupied === 'true') {
        dbg('click ignored: occupied');
        return;
      }
      if (!GAME_ID) {
        dbg('click ignored: no GAME_ID yet');
        return;
      }
      if (!mySymbol) {
        alert('Tu es en spectateur, tu ne peux pas jouer.');
        return;
      }

      // place move via RPC
      try {
        // show small local optimistic state
        cell.classList.add(mySymbol === 'X' ? 'piece-x' : 'piece-o');
        cell.querySelector('.cell-mark').textContent = mySymbol;
        cell.dataset.occupied = 'true';
        updateClickability();

        dbg('rpc_place_move call', { GAME_ID, pos, r, c, mySymbol });

        const { data: rpcRes, error: rpcErr } = await supabase.rpc('rpc_place_move', {
          p_game_id: GAME_ID,
          p_position: pos,
          p_row: r,
          p_col: c,
          p_player: mySymbol
        });

        if (rpcErr) {
          // revert optimistic UI
          dbg('rpc_place_move error', rpcErr);
          // try to interpret common errors
          if (String(rpcErr.message || '').toLowerCase().includes('cellule occupée')) {
            alert('Case déjà occupée (conflit).');
          } else if (String(rpcErr.message || '').toLowerCase().includes('non autorisé')) {
            alert('Non autorisé à jouer sur cette partie.');
          } else {
            alert('Erreur serveur: ' + (rpcErr.message || 'Erreur lors du placement'));
          }
          // re-fetch canonical state to be safe
          await sleep(200);
          const latest = await fetchGame(GAME_ID);
          if (latest) {
            localGame = latest;
            renderBoardFromJson(localGame.board);
            updateTurnDisplay(localGame.current_turn);
          }
          return;
        }

        // rpcRes expected to contain move_id, aligned_count, board, current_turn, status etc.
        dbg('rpc_place_move result', rpcRes);
        // some RPC wrappers return array; handle defensively
        let resultObj = null;
        if (Array.isArray(rpcRes) && rpcRes.length > 0) resultObj = rpcRes[0];
        else if (rpcRes && typeof rpcRes === 'object') resultObj = rpcRes;
        else resultObj = null;

        // if returned board present, render from it
        const newBoard = resultObj?.board ?? resultObj?.board_json ?? null;
        if (newBoard) {
          renderBoardFromJson(newBoard);
        } else {
          // fallback: fetch latest game row
          const latest = await fetchGame(GAME_ID);
          if (latest) {
            localGame = latest;
            renderBoardFromJson(localGame.board);
          }
        }

        // update turn display and clickability
        const newTurn = resultObj?.current_turn ?? resultObj?.currentturn ?? null;
        updateTurnDisplay(newTurn ?? (localGame ? localGame.current_turn : '—'));

        // if game finished message
        const finished = resultObj?.game_finished ?? (localGame && localGame.status === 'finished');
        if (finished) {
          const winner = resultObj?.winner ?? (localGame ? localGame.winner : null);
          if (winner) {
            alert('Partie terminée. Vainqueur: ' + winner);
          } else {
            alert('Partie terminée.');
          }
        }

        // ensure canonical state updated
        await sleep(80);
        const latest2 = await fetchGame(GAME_ID);
        if (latest2) {
          localGame = latest2;
          renderBoardFromJson(localGame.board);
          updateTurnDisplay(localGame.current_turn);
        }

      } catch (e) {
        dbg('place move exception', e);
        alert('Erreur lors du placement: ' + (e.message || e));
        // re-fetch canonical
        const latest3 = await fetchGame(GAME_ID);
        if (latest3) {
          localGame = latest3;
          renderBoardFromJson(localGame.board);
          updateTurnDisplay(localGame.current_turn);
        }
      } finally {
        updateClickability();
      }
    }, { passive: true });
  }

  // ----- realtime subscription with polling fallback -----
  function trySubscribe(gameId) {
    if (!gameId) return;
    // cleanup previous
    if (chan) {
      try { chan.unsubscribe(); } catch (e) { dbg('chan unsubscribe error', e); }
      try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(chan); } catch(e){ dbg('removeChannel err', e); }
      chan = null;
    }

    // subscribe to games table updates for this id AND to game_moves inserts (if needed)
    chan = supabase.channel(`game:${gameId}`);

    chan.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, payload => {
      dbg('realtime: games UPDATE payload', payload);
      const updated = payload?.new;
      if (updated) {
        localGame = updated;
        renderBoardFromJson(localGame.board);
        updateTurnDisplay(localGame.current_turn);
        updateClickability();
      }
    });

    chan.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_moves', filter: `game_id=eq.${gameId}` }, payload => {
      dbg('realtime: game_moves INSERT payload', payload);
      // payload.new contains move: we can update single cell if present, else fetch game
      const m = payload?.new;
      if (m && m.position != null && m.player) {
        const pos = Number(m.position);
        const cell = boardGrid.querySelector(`.board-cell[data-pos="${pos}"]`);
        if (cell) {
          cell.classList.add(m.player === 'X' ? 'piece-x' : 'piece-o');
          cell.querySelector('.cell-mark').textContent = m.player;
          cell.dataset.occupied = 'true';
        } else {
          // fallback to fetch entire game
          fetchGame(gameId).then(g => { if (g) { localGame = g; renderBoardFromJson(g.board); updateTurnDisplay(g.current_turn); updateClickability(); } });
        }
      } else {
        fetchGame(gameId).then(g => { if (g) { localGame = g; renderBoardFromJson(g.board); updateTurnDisplay(g.current_turn); updateClickability(); } });
      }
    });

    // try subscribe
    chan.subscribe().then(res => {
      dbg('channel subscribe result', res);
      const ok = res && (res.status === 'SUBSCRIBED' || res === 'ok' || res === 'OK');
      if (ok) {
        subscribed = true;
        if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
      } else {
        dbg('channel not subscribed -> start polling fallback');
        subscribed = false;
        startPolling(gameId);
      }
    }).catch(err => {
      dbg('channel.subscribe fail -> polling fallback', err);
      subscribed = false;
      startPolling(gameId);
    });

    // safety: if websocket disconnects, fallback to polling
    try {
      window.addEventListener('offline', () => { dbg('offline -> start polling fallback'); startPolling(gameId); });
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          // try to resubscribe if not subscribed
          if (!subscribed) {
            dbg('visibility visible -> try resubscribe');
            trySubscribe(gameId);
          }
        }
      });
    } catch (e) { dbg('addEventListener fail', e); }
  }

  function startPolling(gameId) {
    if (!gameId) return;
    if (pollingTimer) return;
    dbg('startPolling', gameId);
    pollingTimer = setInterval(async () => {
      try {
        const latest = await fetchGame(gameId);
        if (latest) {
          // shallow compare move_count to reduce re-renders
          if (!localGame || String(latest.move_count) !== String(localGame.move_count) || JSON.stringify(latest.board) !== JSON.stringify(localGame.board)) {
            localGame = latest;
            renderBoardFromJson(localGame.board);
            updateTurnDisplay(localGame.current_turn);
            updateClickability();
          }
        }
      } catch (e) {
        dbg('polling fetchGame error', e);
      }
    }, pollIntervalMs);
  }

  // cleanup resources on unload
  async function cleanup() {
    dbg('cleanup called');
    try {
      if (chan) {
        try { await chan.unsubscribe(); } catch (e) { dbg('chan.unsubscribe err', e); }
        try { if (typeof supabase.removeChannel === 'function') supabase.removeChannel(chan); } catch (e) { dbg('removeChannel err', e); }
        chan = null;
      }
    } catch (e) { dbg('cleanup chan err', e); }
    try { if (pollingTimer) clearInterval(pollingTimer); pollingTimer = null; } catch(e){}
  }

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  // run bootstrap
  await bootstrap();

  // expose minimal API for other scripts (like updatePlayerStatsOnce)
  window.taktikGame = window.taktikGame || {};
  window.taktikGame.getState = () => ({
    gameId: GAME_ID,
    hostId: localGame?.owner_id,
    opponentId: localGame?.opponent_id,
    current_turn: localGame?.current_turn,
    status: localGame?.status
  });

  // return an API
  return {
    getState: window.taktikGame.getState,
    cleanup
  };
}
