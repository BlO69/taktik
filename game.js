// game.js (version RPC-only, structure: series -> parties -> games)
// Module ES pour la logique du jeu "Aligner 5" sur grille 20x20.
// Utilise RPCs : rpc_create_series_and_first_party, rpc_place_move.
// Ajouts : reconnexion automatique des subscriptions realtime + polling de secours.

const ROWS = 20, COLS = 20, WIN = 5;
const GAME_TABLE = 'games';
const MOVES_TABLE = 'game_moves';
const PARTIES_TABLE = 'parties';
const SERIES_TABLE = 'series';
const PUBLIC_REPLAY_TABLE = 'public_game_replays';
const CREATE_SERIES_RPC = 'rpc_create_series_and_first_party';
const PLACE_MOVE_RPC = 'rpc_place_move';
const ELO_RPC = 'update_elo'; // si existant côté serveur

// --- Debug flag (demandé) ---
const dbg = true;
function dbgLog(...args) { if (dbg) console.debug('DBG game.js:', ...args); }
function dbgAlert(label, payload) {
  if (!dbg) return;
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, (k, v) => {
      if (Array.isArray(v) && v.length > 50) return `[Array(${v.length}) truncated]`;
      return v;
    }, 2);
    alert(`${label}:\n${text}`);
  } catch (e) {
    try { alert(`${label}: (unable to stringify payload)`); } catch (_) {}
  }
}

// nodes (expected in index.html)
const boardGrid = document.getElementById('boardGrid');
const boardViewport = document.getElementById('boardViewport');
const currentTurnEl = document.getElementById('currentTurn');
const scoreX = document.getElementById('scoreX');
const scoreO = document.getElementById('scoreO');
const seriesX = document.getElementById('seriesX');
const seriesO = document.getElementById('seriesO');
const minimapContainer = document.getElementById('minimap');

let controlsPanel = null;

let supabase = window.supabase ?? null;
let sessionUser = null;
let localPlayerSymbol = 'X';
let hostId = null, opponentId = null, gameId = null;
// À placer en haut de game.js, avant le chargement "normal" du jeu.
async function fetchGameIdFromInvitation(invId) {
  if (!invId) return null;
  try {
    const { data, error } = await supabase
      .from('game_invitations')
      .select('game_id')
      .eq('id', invId)
      .single();
    if (error) {
      // erreur non fatale : renvoyer null
      return null;
    }
    return data?.game_id || null;
  } catch (e) {
    return null;
  }
}

async function waitForGameId(invId, attempts = 10, intervalMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    const gid = await fetchGameIdFromInvitation(invId);
    if (gid) return gid;
    // Optionnel : afficher un message d'attente à l'utilisateur
    // ex: document.getElementById('status').textContent = `En attente du joueur... (${i+1}/${attempts})`;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

(async function initFromUrl() {
  const url = new URL(location.href);
  const gameIdParam = url.searchParams.get('game_id');
  const inviteIdParam = url.searchParams.get('invitation_id');
  const fromInvite = url.searchParams.get('from_invite');

  let gameId = gameIdParam || null;

  if (!gameId && inviteIdParam) {
    try {
  const { data, error } = await supabase
    .from('game_invitations')
    .select('id, game_id, status')
    .eq('id', inviteIdParam)
    .single();

  console.warn("INVITATION DB CHECK", { data, error });
} catch (e) {
  console.warn("INVITATION DB CHECK FAILED", e);
}
    // on a une invitation -> attendre/poller pour récupérer game_id
    gameId = await waitForGameId(inviteIdParam, 12, 2000); // ~24s max
    if (!gameId) {
  const debug = {
    url: location.href,
    game_id_param: gameIdParam,
    invitation_id_param: inviteIdParam,
    from_invite: fromInvite,
    supabase_present: !!supabase,
  };

  try {
    const s = await supabase?.auth?.getSession?.();
    debug.session_user = s?.data?.session?.user?.id ?? null;
  } catch (e) {
    debug.session_error = String(e);
  }

  console.error("GAME LOAD DEBUG — gameId manquant", debug);

  showSoftError(
    "Game non chargé — voir console (GAME LOAD DEBUG). " +
    "Probablement game_id manquant ou invitation non résolue."
  );

  return;
}
  }

  if (!gameId && fromInvite) {
    // cas où create_game.js n'a pas fourni d'invitation_id ; on attend quelques secondes pour que la game soit créée côté serveur
    // tentative simple: poller quelques fois pour voir si l'utilisateur a une game récente (implémentation dépend du modèle de données)
    // Ici on prévient l'utilisateur au lieu d'afficher l'erreur.
    showSoftError("Redirection depuis une invitation : en attente de la création de la partie. Réessayez dans quelques secondes.");
    return;
  }

  if (!gameId) {
  showSoftError(
    "Connexion à la partie…\n" +
    "Si l’invitation vient d’être acceptée, merci de patienter quelques secondes."
  );
  return;
}
  
  // Si on a gameId, lancer la logique normale de chargement :
  await joinGame(gameId); // <-- nom hypothétique de votre fonction existante qui charge la partie
})();

// fonctions utilitaires (adaptez selon votre code)
function showSoftError(msg) {
  // afficher message dans UI sans bloquer ; par ex:
  const el = document.getElementById('status') || document.createElement('div');
  el.id = 'status';
  el.textContent = msg;
  document.body.prepend(el);
}
function showHardError(msg) {
  alert(msg);
}

// changed: hold an array of realtime subscriptions/objects for robust unsubscribing
let realtimeSubs = [];

let board = new Array(ROWS * COLS).fill(null);
let current = 'X';
let manches = { X: 0, O: 0 };   // games count in current party (owner_wins/opponent_wins)
let series = { X: 0, O: 0 };    // series counters (owner/opponent wins)
let moveIndex = 0;
let isHost = true;
let isRemotePlaying = false;
let pendingMove = false;

let punchlinesList = [], clicksList = [];
let selectedPunchline = null, selectedClick = null;
const audioCache = new Map();

// reconnection + polling helpers
let pollIntervalId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
let lastPollTs = 0; // timestamp of last successful poll

// UTIL
function idx(r, c) { return r * COLS + c; }
function inRange(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

// --- rendering helpers (unchanged) ---
function setCellSize() {
  if (!boardViewport || !boardGrid) return;
  let size = 48;
  const w = window.innerWidth;
  if (w < 420) size = 28;
  else if (w < 640) size = 36;
  else if (w < 1024) size = 40;
  document.documentElement.style.setProperty('--cell-size', size + 'px');
  const viewportW = size * 9 + 2;
  const viewportH = size * 8 + 2;
  boardViewport.style.width = Math.min(viewportW, Math.max(240, viewportW)) + 'px';
  boardViewport.style.height = viewportH + 'px';
  boardGrid.style.gridTemplateColumns = `repeat(${COLS}, var(--cell-size))`;
}

function svgDataURL_X() {
  const s = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 48;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}'>
        <rect width='100%' height='100%' fill='#FFD93D' rx='6' ry='6'/>
        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='${Math.floor(s*0.6)}' font-family='Arial' font-weight='700' fill='#000'>X</text>
      </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function svgDataURL_O() {
  const s = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 48;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}'>
        <rect width='100%' height='100%' fill='#FF6B6B' rx='6' ry='6'/>
        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='${Math.floor(s*0.6)}' font-family='Arial' font-weight='700' fill='#000'>O</text>
      </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function renderGrid() {
  if (!boardGrid) return;
  boardGrid.innerHTML = '';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = idx(r, c);
      const cell = document.createElement('div');
      cell.className = 'board-cell';
      cell.dataset.r = r; cell.dataset.c = c; cell.dataset.i = i;
      cell.addEventListener('click', () => onCellClick(r, c));
      const val = board[i];
      if (val) {
        const img = document.createElement('img');
        img.className = 'piece-img';
        img.src = val === 'X' ? svgDataURL_X() : svgDataURL_O();
        img.alt = val;
        cell.appendChild(img);
      }
      boardGrid.appendChild(cell);
    }
  }
}

function renderMiniMap() {
  if (!minimapContainer || !boardViewport) return;
  minimapContainer.innerHTML = '';
  const mm = minimapContainer;
  const w = mm.clientWidth || 160; const h = mm.clientHeight || 96;
  const canvas = document.createElement('canvas');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(160, Math.floor(w * ratio));
  canvas.height = Math.max(80, Math.floor(h * ratio));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  mm.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.fillStyle = '#071022'; ctx.fillRect(0, 0, w, h);
  const cellW = w / COLS, cellH = h / ROWS;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = board[idx(r, c)];
      if (!v) continue;
      ctx.fillStyle = v === 'X' ? '#FFD93D' : '#FF6B6B';
      ctx.fillRect(c * cellW, r * cellH, Math.max(1, cellW - 1), Math.max(1, cellH - 1));
    }
  }
  // viewport rect
  const vpW = boardViewport.clientWidth, vpH = boardViewport.clientHeight;
  const scrollLeft = boardViewport.scrollLeft, scrollTop = boardViewport.scrollTop;
  const cellSizePx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 48;
  const firstCol = Math.floor(scrollLeft / cellSizePx);
  const firstRow = Math.floor(scrollTop / cellSizePx);
  const visibleCols = Math.ceil(vpW / cellSizePx);
  const visibleRows = Math.ceil(vpH / cellSizePx);
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
  ctx.strokeRect(firstCol * cellW, firstRow * cellH, visibleCols * cellW, visibleRows * cellH);

  canvas.onclick = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width) / ratio;
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height) / ratio;
    const col = Math.floor(x / cellW);
    const row = Math.floor(y / cellH);
    centerViewportOn(row, col);
  };
}

function centerViewportOn(row, col) {
  if (!boardViewport) return;
  const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 48;
  const vpW = boardViewport.clientWidth, vpH = boardViewport.clientHeight;
  const targetLeft = Math.max(0, Math.round(col * cell - vpW / 2 + cell / 2));
  const targetTop = Math.max(0, Math.round(row * cell - vpH / 2 + cell / 2));
  boardViewport.scrollTo({ left: targetLeft, top: targetTop, behavior: 'smooth' });
  setTimeout(renderMiniMap, 250);
}

// --- local winner checks (keeps UI snappy but final authority is server) ---
function countDirection(r, c, dr, dc, symbol) {
  let cnt = 0; let rr = r + dr, cc = c + dc;
  while (inRange(rr, cc) && board[idx(rr, cc)] === symbol) { cnt++; rr += dr; cc += dc; }
  return cnt;
}

function checkWinnerAt(r, c) {
  const sym = board[idx(r, c)]; if (!sym) return null;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const total = 1 + countDirection(r, c, dr, dc, sym) + countDirection(r, c, -dr, -dc, sym);
    if (total >= WIN) return sym;
  }
  return null;
}

function checkAnyWinner() {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const w = checkWinnerAt(r, c); if (w) return w; }
  if (board.every(Boolean)) return 'draw';
  return null;
}

// --- audio helpers (unchanged) ---
async function resolveFileUrl(item) {
  if (!item) return null;
  const cacheKey = `${item.bucket || 'public'}/${item.path || item.name}`;
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);
  if (!supabase) {
    const fallback = `/storage/v1/object/public/${item.bucket || 'public'}/${item.path || item.name}`;
    audioCache.set(cacheKey, fallback);
    return fallback;
  }
  try {
    const { data: pubData, error: pubErr } = await supabase.storage.from(item.bucket).getPublicUrl(item.path);
    if (!pubErr && pubData?.publicUrl) { audioCache.set(cacheKey, pubData.publicUrl); return pubData.publicUrl; }
  } catch (e) {}
  try {
    const { data: signedData, error: signedErr } = await supabase.storage.from(item.bucket).createSignedUrl(item.path, 60);
    if (!signedErr && signedData?.signedUrl) { audioCache.set(cacheKey, signedData.signedUrl); return signedData.signedUrl; }
  } catch (e) {}
  const fallback = `/storage/v1/object/public/${item.bucket || 'public'}/${item.path || item.name}`;
  audioCache.set(cacheKey, fallback);
  return fallback;
}
function playAudioUrl(url) { if (!url) return null; try { const a = new Audio(url); a.play().catch(()=>{}); return a; } catch(e){return null;} }

// --- fetch sounds ---
async function fetchSoundLists() {
  if (!supabase) return;
  try {
    const { data: punches } = await supabase.from('punchlines').select('*').limit(200);
    const { data: clicks } = await supabase.from('clicks').select('*').limit(200);
    punchlinesList = punches || [];
    clicksList = clicks || [];
    populateSoundSelects();
  } catch (e) { console.warn('fetchSoundLists failed', e); }
}

function populateSoundSelects() {
  ensureControlsPanel();
  const selP = document.getElementById('selPunchline');
  const selC = document.getElementById('selClick');
  if (!selP || !selC) return;
  selP.innerHTML = `<option value="">— Aucune —</option>`;
  selC.innerHTML = `<option value="">— Aucune —</option>`;
  punchlinesList.forEach(p => { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = p.name; selP.appendChild(opt); });
  clicksList.forEach(p => { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = p.name; selC.appendChild(opt); });
}

// --- controls panel (unchanged) ---
function ensureControlsPanel() {
  if (controlsPanel) return controlsPanel;
  const rightPane = minimapContainer?.parentElement ?? document.body;
  controlsPanel = document.createElement('div');
  controlsPanel.className = 'mt-4 p-3 border rounded-md bg-white/50';
  controlsPanel.style.fontSize = '13px';
  controlsPanel.innerHTML = `
    <div class="text-sm text-slate-600">Sons (sélection à refaire à chaque pion)</div>
    <label class="block mt-2 text-xs">Punchline (joue avant le pion)</label>
    <select id="selPunchline" class="w-full mt-1 p-1 rounded border"></select>
    <div class="mt-2 flex gap-2">
      <button id="playPunchPreview" class="px-3 py-1 rounded bg-sky-100">▶ Pré-écouter</button>
      <button id="clearPunch" class="px-3 py-1 rounded bg-slate-100">Effacer</button>
    </div>

    <label class="block mt-3 text-xs">Click (coïncide avec apparition)</label>
    <select id="selClick" class="w-full mt-1 p-1 rounded border"></select>
    <div class="mt-2 flex gap-2">
      <button id="playClickPreview" class="px-3 py-1 rounded bg-sky-100">▶ Pré-écouter</button>
      <button id="clearClick" class="px-3 py-1 rounded bg-slate-100">Effacer</button>
    </div>

    <div class="mt-3 text-xs text-slate-500">Note: il faut re-sélectionner punchline / click pour chaque prochain pion.</div>
  `;
  rightPane.appendChild(controlsPanel);

  const selPunchElem = document.getElementById('selPunchline');
  const selClickElem = document.getElementById('selClick');
  if (selPunchElem) selPunchElem.addEventListener('change', (e) => { selectedPunchline = punchlinesList.find(p => p.id === e.target.value) || null; });
  if (selClickElem) selClickElem.addEventListener('change', (e) => { selectedClick = clicksList.find(c => c.id === e.target.value) || null; });

  const playPunchPreview = document.getElementById('playPunchPreview');
  if (playPunchPreview) playPunchPreview.addEventListener('click', async () => {
    if (!selectedPunchline) return alert('Choisir une punchline d\'abord.');
    const url = await resolveFileUrl(selectedPunchline); playAudioUrl(url);
  });
  const playClickPreview = document.getElementById('playClickPreview');
  if (playClickPreview) playClickPreview.addEventListener('click', async () => {
    if (!selectedClick) return alert('Choisir un click d\'abord.');
    const url = await resolveFileUrl(selectedClick); playAudioUrl(url);
  });

  const clearPunch = document.getElementById('clearPunch');
  if (clearPunch) clearPunch.addEventListener('click', () => { const sel = document.getElementById('selPunchline'); if (sel) sel.value = ''; selectedPunchline = null; });
  const clearClick = document.getElementById('clearClick');
  if (clearClick) clearClick.addEventListener('click', () => { const sel = document.getElementById('selClick'); if (sel) sel.value = ''; selectedClick = null; });

  return controlsPanel;
}

// --- refresh canonical game/party/series state from DB (reads only) ---
async function refreshGameState() {
  if (!supabase || !gameId) return;
  try {
    // fetch canonical game row
    const { data: gRow, error: gErr } = await supabase.from(GAME_TABLE)
      .select('id,party_id,owner_id,opponent_id,board,current_turn,status,winner,updated_at')
      .eq('id', gameId)
      .maybeSingle();
    dbgLog('refreshGameState: game row', { gRow, gErr });
    dbgAlert('refreshGameState: game row', { gRow, gErr });
    if (gErr) return;

    // canonical board may be stored as json or text
    if (gRow?.board) {
      if (typeof gRow.board === 'string') {
        try { board = JSON.parse(gRow.board); } catch (e) { dbgLog('board parse failed', e); }
      } else board = gRow.board;
    } else {
      // When the canonical board is not available (RLS or not stored), try to reconstruct from moves.
      dbgLog('refreshGameState: canonical board missing — attempting to reconstruct from moves');
      try {
        const { data: moves, error: movesErr } = await supabase.from(MOVES_TABLE)
          .select('position,player,move_index')
          .eq('game_id', gameId)
          .order('move_index', { ascending: true });
        if (!movesErr && Array.isArray(moves) && moves.length) {
          const newBoard = new Array(ROWS * COLS).fill(null);
          let maxIdx = moveIndex || 0;
          for (const m of moves) {
            const pos = Number(m.position);
            if (Number.isFinite(pos) && (m.player != null)) newBoard[pos] = m.player;
            const mi = Number(m.move_index ?? NaN);
            if (Number.isFinite(mi)) maxIdx = Math.max(maxIdx, mi);
          }
          board = newBoard;
          moveIndex = maxIdx;
        } else {
          dbgLog('refreshGameState: moves fetch failed or empty (maybe RLS). Keeping local board intact');
        }
      } catch (e) {
        dbgLog('refreshGameState: moves reconstruction failed', e);
      }
    }

    current = gRow?.current_turn ?? current;
    hostId = gRow?.owner_id ?? hostId;
    opponentId = gRow?.opponent_id ?? opponentId;
    if (currentTurnEl) currentTurnEl.textContent = current;

    // fetch party
    let partyRow = null;
    if (gRow?.party_id) {
      const { data: pRow, error: pErr } = await supabase.from(PARTIES_TABLE)
        .select('id,series_id,number,owner_wins,opponent_wins,target_games,winner_id')
        .eq('id', gRow.party_id)
        .maybeSingle();
      dbgLog('refreshGameState: party row', { pRow, pErr });
      partyRow = pRow;
      if (pRow) {
        manches.X = Number(pRow.owner_wins || 0);
        manches.O = Number(pRow.opponent_wins || 0);
        if (scoreX) scoreX.textContent = String(manches.X);
        if (scoreO) scoreO.textContent = String(manches.O);
      }
    }

    // fetch series if available
    if (partyRow?.series_id) {
      const { data: sRow, error: sErr } = await supabase.from(SERIES_TABLE)
        .select('id,owner_wins,opponent_wins,target_parties,winner_id')
        .eq('id', partyRow.series_id)
        .maybeSingle();
      dbgLog('refreshGameState: series row', { sRow, sErr });
      if (sRow) {
        series.X = Number(sRow.owner_wins || 0);
        series.O = Number(sRow.opponent_wins || 0);
        if (seriesX) seriesX.textContent = String(series.X);
        if (seriesO) seriesO.textContent = String(series.O);
      }
    }

    renderGrid(); renderMiniMap();
  } catch (e) {
    console.warn('refreshGameState failed', e);
  }
}

// --- main placeMove: uses rpc_place_move for server-side validation & transitions ---
async function placeMove(r, c, playerSymbol, options = {}) {
  if (pendingMove) return false;
  pendingMove = true;
  try {
    const i = idx(r, c);
    if (board[i]) return false;

    // quick local turn check
    if (isRemotePlaying && playerSymbol !== current) {
      // rely on server for final validation, but avoid spamming RPC when obviously wrong
      try { alert("Ce n'est pas votre tour (client)."); } catch (_) {}
      return false;
    }

    // play punchline first (local sound)
    if (selectedPunchline && playerSymbol === localPlayerSymbol) {
      const punchUrl = await resolveFileUrl(selectedPunchline);
      try {
        const pAudio = playAudioUrl(punchUrl);
        if (pAudio && typeof pAudio.play === 'function' && !options.skipPunch) {
          await new Promise((resolve) => { pAudio.onended = resolve; pAudio.onerror = resolve; setTimeout(resolve, 4000); });
        }
      } catch (e) { console.warn('punch play err', e); }
    }

    // optimistic UI: place piece locally for snappiness (will rollback on RPC error)
    const prevCurrent = current; // capture to restore on rollback
    board[i] = playerSymbol;
    moveIndex++;
    current = current === 'X' ? 'O' : 'X';
    if (currentTurnEl) currentTurnEl.textContent = current;
    renderGrid(); renderMiniMap();

    if (selectedClick && playerSymbol === localPlayerSymbol) {
      const clickUrl = await resolveFileUrl(selectedClick);
      try { playAudioUrl(clickUrl); } catch (e) { console.warn('click play err', e); }
    }

    // reset selections
    selectedPunchline = null; selectedClick = null;
    const selPunch = document.getElementById('selPunchline'); const selClickE = document.getElementById('selClick');
    if (selPunch) selPunch.value = ''; if (selClickE) selClickE.value = '';

    // If online, call RPC to validate & persist the move (server is authoritative)
    if (supabase && isRemotePlaying && gameId) {
      try {
        const payload = {
          p_game_id: gameId,
          p_position: Number(i),
          p_row: Number(r),
          p_col: Number(c),
          p_player: String(playerSymbol)
        };
        dbgLog('Calling PLACE_MOVE RPC', payload);
        dbgAlert('PLACE_MOVE RPC payload', payload);

        const { data: rpcData, error: rpcErr } = await supabase.rpc(PLACE_MOVE_RPC, payload);
        let rpcRow = Array.isArray(rpcData) ? rpcData[0] : rpcData;

if (rpcRow) {
  alert(
    "Alignement : " + rpcRow.aligned_count + " pion(s)"
  );

  if (rpcRow.game_finished === true) {
    alert(
      "🎉 VICTOIRE !\n" +
      "5 pions alignés\n" +
      "Winner user_id:\n" +
      rpcRow.winner
    );
  }
}
        
        dbgLog('PLACE_MOVE RPC response', { rpcData, rpcErr });
        dbgAlert('PLACE_MOVE RPC response', { rpcData, rpcErr });

        if (rpcErr) {
          // rollback optimistic UI
          board[i] = null;
          moveIndex = Math.max(0, moveIndex - 1);
          current = prevCurrent; // restore
          if (currentTurnEl) currentTurnEl.textContent = current;
          renderGrid(); renderMiniMap();
          if (playerSymbol === localPlayerSymbol) {
            try { alert("Le serveur a rejeté le coup : " + (rpcErr.message || rpcErr.toString())); } catch(_) {}
          }
          return false;
        }

        // rpcData is expected to be an array of rows (Supabase returns [ { move_id, game_finished, winner } ]) or object
        let rpcRow = null;
        if (Array.isArray(rpcData) && rpcData.length) rpcRow = rpcData[0];
        else rpcRow = rpcData;

        // If server indicates game finished or winner, refresh canonical state and call handleWin locally
        if (rpcRow && (rpcRow.game_finished === true || rpcRow.winner)) {
          // server completed round/game transitions; refresh state and then handle UI
          await refreshGameState();
          // read canonical winner from game row and handle round end
          try {
            const { data: g } = await supabase.from(GAME_TABLE).select('winner,board,current_turn,party_id,owner_id,opponent_id').eq('id', gameId).maybeSingle();
            dbgLog('after place RPC - canonical game read', g);
            if (g?.winner) await handleRoundEnd(g.winner);
          } catch (e) {
            console.warn('post-RPC canonical read failed', e);
          }
        } else {
          // If the RPC returned a canonical board in rpcRow, merge it; otherwise rely on realtime events
          if (rpcRow && rpcRow.board) {
            try {
              if (typeof rpcRow.board === 'string') board = JSON.parse(rpcRow.board);
              else board = rpcRow.board;
              renderGrid(); renderMiniMap();
            } catch (e) {
              dbgLog('failed merging board from rpcRow, relying on realtime', e);
            }
          } else {
            // don't call refreshGameState() here because it may be blocked by RLS and clear the board;
            // rely on realtime subscription to receive the inserted move and update the UI.
            dbgLog('RPC accepted move, relying on realtime to sync move (no canonical board returned).');
            // === PATCH: fallback - fetch last move directly if RPC didn't return canonical board ===
try {
  const { data: lastMove, error: lastErr } = await supabase.from(MOVES_TABLE)
    .select('position,player,move_index')
    .eq('game_id', gameId)
    .order('move_index', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastErr && lastMove) {
    dbgLog('Fallback: fetched last move after RPC', lastMove);
    applyRealtimeMove(lastMove);
  } else if (lastErr) {
    dbgLog('Fallback: error fetching last move (will rely on polling)', lastErr);
    // polling (startPolling) is already running as safety-net
  }
} catch (e) {
  dbgLog('Fallback: exception fetching last move', e);
}
          }
        }

        return true;
      } catch (e) {
        // rollback optimistic UI
        board[i] = null;
        moveIndex = Math.max(0, moveIndex - 1);
        current = prevCurrent; // restore
        if (currentTurnEl) currentTurnEl.textContent = current;
        renderGrid(); renderMiniMap();
        console.warn('PLACE_MOVE rpc exception', e);
        try { alert("Erreur serveur lors de l'envoi du coup. Voir console."); } catch (_) {}
        return false;
      }
    } else {
      // offline/local mode: keep local state only
      const w = checkWinnerAt(r, c) || checkAnyWinner();
      if (w) await handleRoundEnd(w);
      // current already flipped above in optimistic update
      return true;
    }
  } finally {
    pendingMove = false;
  }
}

// wrapper used by RPC finishes to update manches/series UI in canonical way
async function handleRoundEnd(winnerSymbol) {
  try {
    if (winnerSymbol === 'draw') {
      try { alert('Match nul.'); } catch (_) {}
    } else {
      try { alert(`Le gagnant du round est ${winnerSymbol} !`); } catch (_) {}
    }

    // Refresh canonical state to obtain party.owner_wins/opponent_wins and series counts
    await refreshGameState();

    // Optionally, if series finished and RPC update_elo exists, server may have called it already.
    // We show updated counts from DB.

  } catch (e) {
    console.warn('handleRoundEnd failed', e);
  }
}

// cell click handler
async function onCellClick(r, c) {
  if (pendingMove) return;
  if (current !== localPlayerSymbol) return;
  await placeMove(r, c, localPlayerSymbol);
}

// --- create game (host) uses RPC rpc_create_series_and_first_party ---
async function createGame(variant = 'taktik') {
  if (!supabase) {
    resetLocalGame();
    return null;
  }
  try {
    // create via RPC: returns series_id, party_id, game_id
    const { data: rpcData, error: rpcErr } = await supabase.rpc(CREATE_SERIES_RPC, {
      p_opponent_id: null, p_target_parties: 3, p_target_games: 3
    });
    dbgLog('rpc_create_series_and_first_party', { rpcData, rpcErr });
    dbgAlert('rpc_create_series_and_first_party', { rpcData, rpcErr });

    if (rpcErr) throw rpcErr;
    let row = null;
    if (Array.isArray(rpcData) && rpcData.length) row = rpcData[0]; else row = rpcData;
    if (!row || !row.game_id) throw new Error('RPC create_series did not return game_id');

    gameId = row.game_id;
    try { startPolling(); } catch (e) { dbgLog('startPolling after createGame failed', e); }
    isRemotePlaying = true;
    isHost = true;

    // subscribe & refresh canonical state
    await subscribeToGame(gameId);
    await refreshGameState();
    return gameId;
  } catch (e) {
    console.warn('createGame failed', e);
    resetLocalGame();
    return null;
  }
}

// --- join game: read-only join (we do NOT alter opponent_id here; server handles claiming via accept-invitation RPC) ---
async function joinGame(gId) {
  if (!gId) return;
  if (!supabase) {
    resetLocalGame();
    return;
  }
  try {
    // Load canonical game row and moves, but DO NOT attempt to set opponent_id via client-side UPDATE.
    const { data: gameRow, error: gameErr } = await supabase.from(GAME_TABLE)
      .select('id,owner_id,opponent_id,current_turn,board,status,party_id')
      .eq('id', gId)
      .maybeSingle();
    dbgLog('joinGame: fetched gameRow', { gId, gameRow, gameErr });
    dbgAlert('joinGame: fetched gameRow', { gId, gameRow, gameErr });
    if (gameErr) throw gameErr;
    if (!gameRow) throw new Error('Game introuvable');

    // load moves
    const { data: moves, error: movesErr } = await supabase.from(MOVES_TABLE).select('*').eq('game_id', gId).order('move_index', { ascending: true });
    // reset local and apply moves
    resetLocalGame();
    if (!movesErr && Array.isArray(moves)) {
      for (const m of moves || []) {
        const pos = Number(m.position);
        const player = m.player;
        if (!Number.isFinite(pos) || player == null) continue;
        board[pos] = player;
        moveIndex = Math.max(moveIndex, Number(m.move_index ?? moveIndex));
      }
    } else {
      dbgLog('joinGame: moves fetch failed', movesErr);
    }
    renderGrid(); renderMiniMap();

    gameId = gId;
    // ensure fallback polling runs even if realtime subscribe fails
try { startPolling(); } catch (e) { dbgLog('startPolling after joinGame failed', e); }
    isRemotePlaying = true;
    hostId = gameRow.owner_id; opponentId = gameRow.opponent_id;
    current = gameRow.current_turn || current;

    // determine local symbol (owner -> X)
    sessionUser = (await supabase.auth.getSession())?.data?.session?.user ?? sessionUser;
    if (sessionUser?.id && hostId && sessionUser.id === hostId) {
      localPlayerSymbol = 'X';
    } else if (sessionUser?.id && opponentId && sessionUser.id === opponentId) {
      localPlayerSymbol = 'O';
    } else {
      localPlayerSymbol = (sessionUser?.id && hostId && !opponentId) ? 'X' : 'O';
    }
    isHost = !!(sessionUser?.id && hostId && sessionUser.id === hostId);

    if (currentTurnEl) currentTurnEl.textContent = current;

    // subscribe to realtime events
    await subscribeToGame(gId);
    // refresh party/series counters
    await refreshGameState();

    try { window.dispatchEvent(new Event('taktik:joined')); } catch(e){}
  } catch (e) {
    console.warn('joinGame failed', e);
    resetLocalGame();
  }
}

function resetLocalGame() {
  // stop polling when leaving the game completely
  try { stopPolling(); } catch(e) { dbgLog('stopPolling failed', e); }

  board = new Array(ROWS * COLS).fill(null);
  current = 'X'; localPlayerSymbol = 'X'; manches = { X: 0, O: 0 }; series = { X: 0, O: 0 }; moveIndex = 0;
  gameId = null; isRemotePlaying = false; hostId = null; opponentId = null; isHost = false;
  renderGrid(); renderMiniMap();
  if (currentTurnEl) currentTurnEl.textContent = current;
  if (scoreX) scoreX.textContent = '0'; if (scoreO) scoreO.textContent = '0';
  if (seriesX) seriesX.textContent = '0'; if (seriesO) seriesO.textContent = '0';
}

// helper: safe unsubscribe of previous realtime subscriptions
function unsubscribeRealtime() {
  try {
    if (!realtimeSubs || !Array.isArray(realtimeSubs)) return;
    for (const s of realtimeSubs) {
      try {
        // channel object has unsubscribe(), from-sub subscription has unsubscribe()
        s?.unsubscribe && s.unsubscribe();
        // older variants might have .close or .remove; attempt defensively
        s?.close && s.close();
      } catch (e) { dbgLog('unsubscribe error', e); }
    }
  } catch (e) {
    dbgLog('unsubscribeRealtime failed', e);
  } finally {
    // keep array cleared so we don't leak handles
    realtimeSubs = [];
    // IMPORTANT: do NOT stop polling here.
    // If realtime drops, we want polling to continue as fallback until we explicitly reset the game.
    // stopPolling() is called from resetLocalGame() when the user actually leaves the game.
    reconnectAttempts = 0;
  }
}

// start/stop polling fallback — lit un petit polling léger toutes les 3s (doPoll est exécuté immédiatement aussi)
function startPolling() {
  if (!supabase || !gameId) return;
  if (pollIntervalId) return; // already polling

  // polling function (extrait pour réutilisation)
  const doPoll = async () => {
    if (!supabase || !gameId) return;
    try {
      const now = Date.now();
      // avoid overly-frequent polls if last poll was very recent
      if (now - lastPollTs < 1000) return; // laisse 1s de marge pour l'initial immediate call
      lastPollTs = now;

      const { data: moves, error } = await supabase.from(MOVES_TABLE)
        .select('position,player,move_index')
        .eq('game_id', gameId)
        .order('move_index', { ascending: true });

      if (error) { dbgLog('polling moves error', error); return; }
      if (!Array.isArray(moves)) return;

      let changed = false;
      let maxIdx = moveIndex || 0;
      for (const m of moves) {
        const pos = Number(m.position);
        const player = m.player;
        const mi = Number(m.move_index ?? NaN);
        if (!Number.isFinite(pos) || player == null) continue;
        if (!board[pos] || board[pos] !== player) {
          board[pos] = player; changed = true;
        }
        if (Number.isFinite(mi)) maxIdx = Math.max(maxIdx, mi);
      }
      if (maxIdx > moveIndex) moveIndex = maxIdx;
      if (changed) {
        renderGrid(); renderMiniMap();
        // update current based on last move
        const lastMove = moves.length ? moves[moves.length - 1] : null;
        if (lastMove && lastMove.player) current = (lastMove.player === 'X') ? 'O' : 'X';
        if (currentTurnEl) currentTurnEl.textContent = current;
      }
    } catch (e) {
      dbgLog('polling exception', e);
    }
  };

  // run an immediate poll so UI is updated right away
  doPoll().catch(e => dbgLog('initial poll failed', e));

  // then schedule periodic polling
  pollIntervalId = setInterval(doPoll, 3000);
}

function stopPolling() { if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; } }

// helper: extract record from different payload shapes
function extractRecordFromPayload(payload) {
  // channel payloads often contain .record, older .new or .payload.new; fallback to payload itself
  return payload?.record || payload?.new || (payload?.payload && (payload.payload.record || payload.payload.new)) || payload;
}

// apply a move record coming from realtime feed
function applyRealtimeMove(rec) {
  try {
    if (!rec) return;
    const pos = Number(rec.position);
    const player = rec.player;
    if (!Number.isFinite(pos)) return;
    if (player == null) {
      dbgLog('applyRealtimeMove: missing player in record', rec);
      return;
    }
// === PATCH: skip old/duplicate moves ===
const mi = Number(rec.move_index ?? NaN);
if (Number.isFinite(mi) && mi <= moveIndex) {
  dbgLog('applyRealtimeMove: skipping old/duplicate move', { rec, moveIndex });
  return;
}

    if (!Array.isArray(board)) board = new Array(ROWS * COLS).fill(null);

    // if the move slot is empty, or differs from local optimistic, set server value
    if (!board[pos] || board[pos] !== player) {
      board[pos] = player;
    }

    // update moveIndex defensively
    moveIndex = Math.max(moveIndex, Number(rec.move_index ?? moveIndex));

    renderGrid(); renderMiniMap();

    // flip current to the other player
    current = (player === 'X') ? 'O' : 'X';
    if (currentTurnEl) currentTurnEl.textContent = current;

    // if this move may have finished the game, do a best-effort refresh of canonical state
    if (rec && rec.player) {
      refreshGameState().catch(e => dbgLog('refreshGameState(from realtime) failed', e));
    }
  } catch (e) {
    dbgLog('applyRealtimeMove failed', e);
  }
}

// --- realtime subscription (keeps local UI up-to-date) ---
// improved: create both channel-based and from(...).on(...) listeners for robustness.
// stores subscription handles in realtimeSubs for later unsubscribing.
async function subscribeToGame(gId) {
  if (!supabase || !gId) return;
  try {
    // unsubscribe old ones first
    unsubscribeRealtime();

    const subs = [];

    // -------- channel API (postgres_changes) with auto-reconnect --------
    try {
      const channelName = `public:game_${gId}`;

      const makeChannel = () => {
        const ch = supabase.channel(channelName)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: MOVES_TABLE, filter: `game_id=eq.${gId}` }, payload => {
            try {
              dbgLog('channel INSERT payload', payload);
              const rec = extractRecordFromPayload(payload);
              applyRealtimeMove(rec);
            } catch (e) { dbgLog('channel INSERT handler failed', e); }
          })
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: GAME_TABLE, filter: `id=eq.${gId}` }, payload => {
            try {
              dbgLog('channel GAME UPDATE', payload);
              const rec = extractRecordFromPayload(payload);
              if (!rec) return;
              hostId = rec.owner_id ?? hostId;
              opponentId = rec.opponent_id ?? opponentId;
              current = rec.current_turn ?? current;
              if (currentTurnEl) currentTurnEl.textContent = current;
              // refresh full state if winner/status changed
              refreshGameState().catch(e => dbgLog('refreshGameState(from game update) failed', e));
            } catch (e) { dbgLog('channel GAME UPDATE handler failed', e); }
          });

        ch.subscribe((status) => {
          dbgLog('realtime channel subscribe status', status);
          // status values may vary; when channel is closed or timed out, attempt reconnect
          if (typeof status === 'string') {
            if (status.toUpperCase().includes('CLOSED') || status.toUpperCase().includes('TIMED_OUT') || status.toUpperCase().includes('ERROR')) {
              dbgLog('channel reported closed/timedout/error -> scheduling reconnect', status);
              scheduleReconnect(gId);
            } else if (status.toUpperCase().includes('SUBSCRIBED') || status.toUpperCase().includes('CONNECTED')) {
              // connected
              reconnectAttempts = 0; // reset attempts on success
              dbgLog('channel connected/subscribed');
            }
          }
        });

        return ch;
      };

      const chObj = makeChannel();
      subs.push(chObj);
    } catch (e) {
      dbgLog('channel API subscribe failed', e);
    }

    // -------- fallback: from(...).on(...) API for INSERT on moves (works reliably in many setups) --------
    try {
      const fromMovesSub = supabase.from(`${MOVES_TABLE}:game_id=eq.${gId}`).on('INSERT', payload => {
        try {
          dbgLog('from INSERT payload', payload);
          const rec = extractRecordFromPayload(payload);
          applyRealtimeMove(rec);
        } catch (e) { dbgLog('from INSERT handler failed', e); }
      })
      .subscribe((status) => {
        dbgLog('from(moves) subscribe status', status);
        // note: this subscribe callback does not always report lifecycle strings in the same way
      });
      subs.push(fromMovesSub);
    } catch (e) {
      dbgLog('from(moves) subscribe failed', e);
    }

    // -------- fallback: from(game).on(UPDATE) for game row updates --------
    try {
      const fromGameSub = supabase.from(`${GAME_TABLE}:id=eq.${gId}`).on('UPDATE', payload => {
        try {
          dbgLog('from GAME UPDATE', payload);
          const rec = extractRecordFromPayload(payload);
          if (!rec) return;
          hostId = rec.owner_id ?? hostId;
          opponentId = rec.opponent_id ?? opponentId;
          current = rec.current_turn ?? current;
          if (currentTurnEl) currentTurnEl.textContent = current;
          refreshGameState().catch(e => dbgLog('refreshGameState(from game update) failed', e));
        } catch (e) { dbgLog('from GAME UPDATE handler failed', e); }
      }).subscribe((status) => {
        dbgLog('from(game) subscribe status', status);
      });
      subs.push(fromGameSub);
    } catch (e) {
      dbgLog('from(game) subscribe failed', e);
    }

    realtimeSubs = subs;
// diagnostic: si aucune subscription “up”, log warning (helps debug missing realtime events)
setTimeout(() => {
  const active = realtimeSubs && realtimeSubs.length;
  if (!active) dbgLog('subscribeToGame: no realtime subscriptions created — will rely solely on polling.');
}, 800);
    // start polling as a safety-net (keeps things in sync even if realtime disconnects briefly)
    startPolling();

  } catch (e) {
    console.warn('subscribeToGame failed', e);
  }
}

// schedule reconnect with exponential backoff (bounded)
function scheduleReconnect(gId) {
  try {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) { dbgLog('max reconnect attempts reached'); return; }
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    dbgLog(`scheduling reconnect attempt #${reconnectAttempts} in ${delay}ms`);
    setTimeout(async () => {
      try {
        // before reconnecting, clear existing subs to avoid duplicates
        unsubscribeRealtime();
// give the runtime a brief moment to tear down sockets and avoid immediate recreate races
await new Promise(res => setTimeout(res, 250));
await subscribeToGame(gId);
      } catch (e) {
        dbgLog('reconnect attempt failed', e);
        // schedule another attempt if still under limit
        scheduleReconnect(gId);
      }
    }, delay);
  } catch (e) { dbgLog('scheduleReconnect failed', e); }
}

// --- init sequence (sets up UI & possibly auto-join) ---
async function init() {
  try {
    setCellSize();
    renderGrid(); renderMiniMap();
    ensureControlsPanel();
    fetchSoundLists().catch(()=>{});

    if (supabase) {
      try { sessionUser = (await supabase.auth.getSession())?.data?.session?.user ?? null; } catch (e) { dbgLog('getSession failed', e); }
    }

    // newGame button uses RPC create
    const newGameBtn = document.getElementById('newGameBtn');
    if (newGameBtn) newGameBtn.addEventListener('click', async () => {
      if (supabase && sessionUser) {
        const id = await createGame();
        if (id) alert('Série/partie créée en ligne — ID: ' + id);
      } else {
        resetLocalGame(); alert('Nouvelle partie (local/demo)');
      }
    });

    // menuGames to open matchmaking UI (create_game.js)
    const menuGames = document.getElementById('menuGames');
    if (menuGames) menuGames.addEventListener('click', async () => {
      if (window.taktikCreateGame && typeof window.taktikCreateGame.searchProfiles === 'function') {
        const homePanel = document.getElementById('homePanel');
        const placeholderPanel = document.getElementById('placeholderPanel');
        if (homePanel && placeholderPanel) {
          homePanel.classList.add('hidden'); placeholderPanel.classList.remove('hidden');
          const title = document.getElementById('placeholderTitle'); const text = document.getElementById('placeholderText');
          if (title) title.textContent = 'Jeux & Matchmaking';
          if (text) text.textContent = '';
        }
      } else alert('Matchmaking non disponible pour le moment.');
    });

    // wire newGame behavior already above
    setInterval(renderMiniMap, 800);
    window.addEventListener('resize', () => { setCellSize(); renderGrid(); renderMiniMap(); });
    if (boardViewport) boardViewport.addEventListener('scroll', () => { renderMiniMap(); });

    // ensure we unsubscribe on unload to avoid duplicate subscriptions on reload
    window.addEventListener('beforeunload', () => {
      try {
        unsubscribeRealtime();
      } catch(e) { dbgLog('unsub on unload failed', e); }
    });
    
    // try to auto-join latest active game for user (read-only)
    if (supabase && sessionUser) {
      try {
        const { data: active } = await supabase.from(GAME_TABLE)
          .select('id,owner_id,opponent_id,status,current_turn')
          .or(`owner_id.eq.${sessionUser.id},opponent_id.eq.${sessionUser.id}`)
          .order('created_at', { ascending: false })
          .limit(1);
        if (active && active.length) {
          const g = active[0];
          if (g.status === 'playing') await joinGame(g.id);
        }
      } catch (e) { dbgLog('auto-join failed', e); }
    }

    if (currentTurnEl) currentTurnEl.textContent = current;
    if (scoreX) scoreX.textContent = String(manches.X);
    if (scoreO) scoreO.textContent = String(manches.O);
    if (seriesX) seriesX.textContent = String(series.X);
    if (seriesO) seriesO.textContent = String(series.O);

    // import create_game module if present (matchmaking)
    try {
      const mod = await import('./create_game.js');
      if (mod && typeof mod.default === 'function') {
        try { await mod.default(supabase); } catch (e) { dbgLog('initCreateGame failed', e); }
      }
    } catch (e) { /* optional */ }

  } catch (e) {
    console.warn('init error', e);
  }
}

// expose initGame as default
export default async function initGame(supabaseClient = null) {
  try { supabase = supabaseClient ?? (window.supabase ?? supabase); } catch(e){}
  try { await init(); } catch (e) { console.warn('initGame failed', e); }
  try {
    window.taktikGame = {
      _isReal: true,
      resetLocalGame, createGame, joinGame, placeMove,
      getState: () => ({ board, current, manches, series, gameId, isRemotePlaying, hostId, opponentId, localPlayerSymbol, isHost })
    };
  } catch (e) { dbgLog('attach taktikGame failed', e); }
}

// expose fallback-less API if no existing global
if (!window.taktikGame || !window.taktikGame._isReal) {
  window.taktikGame = {
    resetLocalGame, createGame, joinGame, placeMove,
    getState: () => ({ board, current, manches, series, gameId, isRemotePlaying, hostId, opponentId, localPlayerSymbol, isHost })
  };
}
