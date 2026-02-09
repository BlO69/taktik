// game.js (fusion des deux versions fournies)
// Sources originales : game - Copie.js & game.js (fichiers fournis).
/* eslint-disable no-console */
const ROWS = 20, COLS = 20, WIN = 5;
const GAME_TABLE = 'games';
const MOVES_TABLE = 'game_moves';
const PARTIES_TABLE = 'parties';
const SERIES_TABLE = 'series';
const PUBLIC_REPLAY_TABLE = 'public_game_replays';
const CREATE_SERIES_RPC = 'rpc_create_series_and_first_party';
const PLACE_MOVE_RPC = 'rpc_place_move';
const ELO_RPC = 'update_elo'; // optional server-side RPC

// Debug flag
let dbg = true;
function dbgLog(...args) { if (dbg) console.debug('DBG game.js:', ...args); }
function dbgAlert(label, payload) {
  if (!dbg) return;
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, (k, v) => {
      if (Array.isArray(v) && v.length > 50) return `[Array(${v.length}) truncated]`;
      return v;
    }, 2);
    console.info(`[DBG ALERT] ${label}:\n`, text);
  } catch (e) {
    try { console.info(`[DBG ALERT] ${label}: (unable to stringify payload)`); } catch (_) {}
  }
}
try { window.dbgAlert = dbgAlert; } catch(e) { dbgLog('expose dbgAlert failed', e); }

// DOM nodes (expected to exist in game.html)
const boardGrid = document.getElementById('boardGrid');
const boardViewport = document.getElementById('boardViewport');
const currentTurnEl = document.getElementById('currentTurn');
const scoreX = document.getElementById('scoreX');
const scoreO = document.getElementById('scoreO');
const seriesX = document.getElementById('seriesX');
const seriesO = document.getElementById('seriesO');
const minimapContainer = document.getElementById('minimap');
const newGameBtn = document.getElementById('newGameBtn');
const menuGames = document.getElementById('menuGames');

let controlsPanel = null;

let supabase = null;
let sessionUser = null;
let localPlayerSymbol = 'X';
let hostId = null, opponentId = null, gameId = null;
let board = new Array(ROWS * COLS).fill(null);
let current = 'X';
let manches = { X: 0, O: 0 };   // party scores
let series = { X: 0, O: 0 };    // series scores
let moveIndex = 0;
let isHost = true;
let isRemotePlaying = false;
let pendingMove = false;

let punchlinesList = [], clicksList = [];
let selectedPunchline = null, selectedClick = null;
const audioCache = new Map();

// Realtime / polling state
let realtimeSubs = [];
let pollIntervalId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
let lastPollTs = 0;

// Utility
function idx(r, c) { return r * COLS + c; }
function inRange(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

// --- Normalisation board serveur -> array JS (length = ROWS*COLS)
function normalizeServerBoard(srvBoard) {
  if (!srvBoard) return new Array(ROWS * COLS).fill(null);

  // si c'est une string JSON
  if (typeof srvBoard === 'string') {
    try { srvBoard = JSON.parse(srvBoard); } catch (e) { dbgLog('normalizeServerBoard parse failed', e); return new Array(ROWS * COLS).fill(null); }
  }

  // si déjà un array (ex: jsonb '[]' style)
  if (Array.isArray(srvBoard)) {
    const arr = new Array(ROWS * COLS).fill(null);
    for (let i = 0; i < Math.min(arr.length, srvBoard.length); i++) {
      arr[i] = srvBoard[i] == null ? null : String(srvBoard[i]);
    }
    return arr;
  }

  // si c'est un object de paires "index": "X"/"O"
  if (typeof srvBoard === 'object') {
    const arr = new Array(ROWS * COLS).fill(null);
    for (const k of Object.keys(srvBoard)) {
      const idx = Number(k);
      if (Number.isFinite(idx) && idx >= 0 && idx < arr.length) {
        arr[idx] = srvBoard[k] == null ? null : String(srvBoard[k]);
      }
    }
    return arr;
  }

  return new Array(ROWS * COLS).fill(null);
}

// --- Rendering Helpers ---
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
  if (boardGrid) boardGrid.style.gridTemplateColumns = `repeat(${COLS}, var(--cell-size))`;
}

function svgDataURL_X() {
  const s = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 48;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}'>
        <rect width='100%' height='100%' fill='#FF6B6B' rx='6' ry='6'/>
        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='${Math.floor(s*0.6)}' font-family='Arial' font-weight='700' fill='#FFFFFF'>X</text>
      </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function svgDataURL_O() {
  const s = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 48;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}'>
        <rect width='100%' height='100%' fill='#FFD93D' rx='6' ry='6'/>
        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='${Math.floor(s*0.6)}' font-family='Arial' font-weight='700' fill='#000000'>O</text>
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
        cell.classList.add(`piece-${String(val).toLowerCase()}`);

        const img = document.createElement('img');
        img.className = 'piece-img';
        img.src = (val === 'X') ? svgDataURL_X() : svgDataURL_O();
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

// --- Local winner checks (client-side quick detection) ---
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

// --- Audio helpers ---
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

// --- Sounds list fetch & controls panel ---
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

// --- Polling fallback (keeps UI synced) ---
function startPolling() {
  if (!supabase || !gameId) return;
  if (pollIntervalId) return; // already polling

  const doPoll = async () => {
    if (!supabase || !gameId) return;
    try {
      const now = Date.now();
      if (now - lastPollTs < 1000) return;
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
        const lastMove = moves.length ? moves[moves.length - 1] : null;
        if (lastMove && lastMove.player) current = (lastMove.player === 'X') ? 'O' : 'X';
        if (currentTurnEl) currentTurnEl.textContent = current;
      }
    } catch (e) {
      dbgLog('polling exception', e);
    }
  };

  doPoll().catch(e => dbgLog('initial poll failed', e));
  pollIntervalId = setInterval(doPoll, 3000);
}
function stopPolling() { if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; } }

// --- Realtime subscription & reconnect ---
function unsubscribeRealtime() {
  try {
    if (!realtimeSubs || !Array.isArray(realtimeSubs)) return;
    for (const s of realtimeSubs) {
      try {
        s?.unsubscribe && s.unsubscribe();
        s?.close && s.close();
      } catch (e) { dbgLog('unsubscribe error', e); }
    }
  } catch (e) {
    dbgLog('unsubscribeRealtime failed', e);
  } finally {
    realtimeSubs = [];
    reconnectAttempts = 0;
  }
}

function scheduleReconnect(gId) {
  try {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) { dbgLog('max reconnect attempts reached'); return; }
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    dbgLog(`scheduling reconnect attempt #${reconnectAttempts} in ${delay}ms`);
    setTimeout(async () => {
      try {
        unsubscribeRealtime();
        await new Promise(res => setTimeout(res, 250));
        await subscribeToGame(gId);
      } catch (e) {
        dbgLog('reconnect attempt failed', e);
        scheduleReconnect(gId);
      }
    }, delay);
  } catch (e) { dbgLog('scheduleReconnect failed', e); }
}

// helper to normalize payload into record
function extractRecordFromPayload(payload) {
  return payload?.record || payload?.new || (payload?.payload && (payload.payload.record || payload.payload.new)) || payload;
}

// --- apply realtime move (now async so we can refresh canonical state when needed) ---
async function applyRealtimeMove(rec) {
  try {
    if (!rec) return;
    const pos = Number(rec.position);
    const player = rec.player;
    if (!Number.isFinite(pos)) return;
    if (player == null) { dbgLog('applyRealtimeMove: missing player', rec); return; }
    const mi = Number(rec.move_index ?? NaN);
    if (Number.isFinite(mi) && mi <= moveIndex) {
      dbgLog('applyRealtimeMove: skipping old/duplicate move', { rec, moveIndex });
      return;
    }
    if (!Array.isArray(board)) board = new Array(ROWS * COLS).fill(null);
    if (!board[pos] || board[pos] !== player) board[pos] = player;
    moveIndex = Math.max(moveIndex, Number(rec.move_index ?? moveIndex));
    renderGrid(); renderMiniMap();
    current = (player === 'X') ? 'O' : 'X';
    if (currentTurnEl) currentTurnEl.textContent = current;

    // if the realtime payload indicates the game finished, refresh canonical state and end round
    if (rec.status === 'finished' || rec.game_finished === true) {
      try {
        await refreshGameState();
      } catch (e) { dbgLog('refreshGameState(from realtime) failed', e); }

      // determine winner symbol from rec.winner (uuid) if available
      let winnerSymbol = null;
      if (rec.winner) {
        if (rec.winner === hostId) winnerSymbol = 'X';
        else if (rec.winner === opponentId) winnerSymbol = 'O';
        else winnerSymbol = null;
      } else {
        winnerSymbol = 'draw';
      }

      try {
        await handleRoundEnd(winnerSymbol);
      } catch (e) { dbgLog('handleRoundEnd(from realtime) failed', e); }
    } else {
      // otherwise try to ensure canonical state eventually
      if (rec && rec.player) refreshGameState().catch(e => dbgLog('refreshGameState(from realtime) failed', e));
    }
  } catch (e) {
    dbgLog('applyRealtimeMove failed', e);
  }
}

async function subscribeToGame(gId) {
  if (!supabase || !gId) return;
  try {
    unsubscribeRealtime();
    const subs = [];

    try {
      const channelName = `public:game_${gId}`;
      const ch = supabase.channel(channelName)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: MOVES_TABLE, filter: `game_id=eq.${gId}` }, payload => {
          try { const rec = extractRecordFromPayload(payload); applyRealtimeMove(rec); } catch (e) { dbgLog('channel INSERT handler failed', e); }
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: GAME_TABLE, filter: `id=eq.${gId}` }, payload => {
          try {
            const rec = extractRecordFromPayload(payload);
            if (!rec) return;
            hostId = rec.owner_id ?? hostId;
            opponentId = rec.opponent_id ?? opponentId;
            current = rec.current_turn ?? current;
            if (currentTurnEl) currentTurnEl.textContent = current;
            refreshGameState().catch(e => dbgLog('refreshGameState(from game update) failed', e));
          } catch (e) { dbgLog('channel GAME UPDATE handler failed', e); }
        });

      ch.subscribe((status) => {
        dbgLog('realtime channel subscribe status', status);
        if (typeof status === 'string') {
          const s = status.toUpperCase();
          if (s.includes('CLOSED') || s.includes('TIMED_OUT') || s.includes('ERROR')) scheduleReconnect(gId);
          else if (s.includes('SUBSCRIBED') || s.includes('CONNECTED')) reconnectAttempts = 0;
        }
      });

      subs.push(ch);
    } catch (e) {
      dbgLog('channel API subscribe failed', e);
    }

    try {
      const fromMovesSub = supabase.from(`${MOVES_TABLE}:game_id=eq.${gId}`).on('INSERT', payload => {
        try { const rec = extractRecordFromPayload(payload); applyRealtimeMove(rec); } catch (e) { dbgLog('from INSERT handler failed', e); }
      }).subscribe((status) => { dbgLog('from(moves) subscribe status', status); });
      subs.push(fromMovesSub);
    } catch (e) { dbgLog('from(moves) subscribe failed', e); }

    try {
      const fromGameSub = supabase.from(`${GAME_TABLE}:id=eq.${gId}`).on('UPDATE', payload => {
        try {
          const rec = extractRecordFromPayload(payload);
          if (!rec) return;
          hostId = rec.owner_id ?? hostId;
          opponentId = rec.opponent_id ?? opponentId;
          current = rec.current_turn ?? current;
          if (currentTurnEl) currentTurnEl.textContent = current;
          refreshGameState().catch(e => dbgLog('refreshGameState(from game update) failed', e));
        } catch (e) { dbgLog('from GAME UPDATE handler failed', e); }
      }).subscribe((status) => { dbgLog('from(game) subscribe status', status); });
      subs.push(fromGameSub);
    } catch (e) { dbgLog('from(game) subscribe failed', e); }

    realtimeSubs = subs;
    setTimeout(() => {
      const active = realtimeSubs && realtimeSubs.length;
      if (!active) dbgLog('subscribeToGame: no realtime subscriptions created — will rely solely on polling.');
    }, 800);

    // safety-net: start polling
    startPolling();
  } catch (e) {
    console.warn('subscribeToGame failed', e);
  }
}

// --- DB reads / refresh canonical state ---
async function refreshGameState() {
  if (!supabase || !gameId) return;
  try {
    const { data: gRow, error: gErr } = await supabase.from(GAME_TABLE)
      .select('id,party_id,owner_id,opponent_id,board,current_turn,status,winner,move_count,updated_at')
      .eq('id', gameId)
      .maybeSingle();
    dbgLog('refreshGameState: game row', { gRow, gErr });
    if (gErr) return;

    // board may be stored as array or object or absent -> normalize to array
    if (gRow?.board) {
      try {
        board = normalizeServerBoard(gRow.board);
      } catch (e) {
        dbgLog('board normalization failed', e);
        board = new Array(ROWS * COLS).fill(null);
      }
    } else {
      // reconstruct from moves if necessary
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
          dbgLog('refreshGameState: moves fetch failed or empty');
        }
      } catch (e) {
        dbgLog('refreshGameState: moves reconstruction failed', e);
      }
    }

    // appliquer move_count fourni par le server si présent (canonique)
    if (gRow?.move_count !== undefined && gRow?.move_count !== null) {
      moveIndex = Number(gRow.move_count) || moveIndex;
    }

    current = gRow?.current_turn ?? current;
    hostId = gRow?.owner_id ?? hostId;
    opponentId = gRow?.opponent_id ?? opponentId;
    if (currentTurnEl) currentTurnEl.textContent = current;

    // party
    let partyRow = null;
    if (gRow?.party_id) {
      const { data: pRow } = await supabase.from(PARTIES_TABLE)
        .select('id,series_id,number,owner_wins,opponent_wins,target_games,winner_id')
        .eq('id', gRow.party_id)
        .maybeSingle();
      partyRow = pRow;
      if (pRow) {
        manches.X = Number(pRow.owner_wins || 0);
        manches.O = Number(pRow.opponent_wins || 0);
        if (scoreX) scoreX.textContent = String(manches.X);
        if (scoreO) scoreO.textContent = String(manches.O);
      }
    }

    // series
    if (partyRow?.series_id) {
      const { data: sRow } = await supabase.from(SERIES_TABLE)
        .select('id,owner_wins,opponent_wins,target_parties,winner_id')
        .eq('id', partyRow.series_id)
        .maybeSingle();
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

// --- RPC: create series + first party + first game (host) ---
async function createGame(variant = 'taktik') {
  if (!supabase) {
    resetLocalGame();
    return null;
  }
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc(CREATE_SERIES_RPC, {
      p_opponent_id: null, p_target_parties: 3, p_target_games: 3
    });
    dbgLog('rpc_create_series_and_first_party', { rpcData, rpcErr });
    if (rpcErr) throw rpcErr;
    let row = null;
    if (Array.isArray(rpcData) && rpcData.length) row = rpcData[0]; else row = rpcData;
    if (!row || !row.game_id) throw new Error('RPC create_series did not return game_id');

    gameId = row.game_id;
    startPolling();
    isRemotePlaying = true;
    isHost = true;

    await subscribeToGame(gameId);
    await refreshGameState();
    return gameId;
  } catch (e) {
    console.warn('createGame failed', e);
    resetLocalGame();
    return null;
  }
}

// --- PLACE MOVE (client wrapper around RPC with optimistic update & rollback) ---
async function placeMove(r, c, playerSymbol, options = {}) {
  if (pendingMove) return false;
  pendingMove = true;
  try {
    const i = idx(r, c);
    if (board[i]) return false;

    // quick local turn check
    if (isRemotePlaying && playerSymbol !== current) {
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

    // optimistic UI
    const prevCurrent = current;
    board[i] = playerSymbol;
    moveIndex++;
    current = current === 'X' ? 'O' : 'X';
    if (currentTurnEl) currentTurnEl.textContent = current;
    renderGrid(); renderMiniMap();

    if (selectedClick && playerSymbol === localPlayerSymbol) {
      const clickUrl = await resolveFileUrl(selectedClick);
      try { playAudioUrl(clickUrl); } catch (e) { console.warn('click play err', e); }
    }

    selectedPunchline = null; selectedClick = null;
    const selPunch = document.getElementById('selPunchline'); const selClickE = document.getElementById('selClick');
    if (selPunch) selPunch.value = ''; if (selClickE) selClickE.value = '';

    // If online, call RPC to validate & persist (server authoritative)
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

        const { data: rpcData, error: rpcErr } = await supabase.rpc(PLACE_MOVE_RPC, payload);
        dbgLog('PLACE_MOVE RPC response', { rpcData, rpcErr });

        if (rpcErr) {
          // rollback optimistic UI
          board[i] = null;
          moveIndex = Math.max(0, moveIndex - 1);
          current = prevCurrent;
          if (currentTurnEl) currentTurnEl.textContent = current;
          renderGrid(); renderMiniMap();
          const srvMsg = rpcErr?.message || rpcErr?.hint || (rpcErr?.details ? `${rpcErr.details}` : null);
          if (playerSymbol === localPlayerSymbol) {
            try { alert("Le serveur a rejeté le coup : " + (srvMsg || rpcErr.toString())); } catch(_) {}
          }
          return false;
        }

        // rpcData normalization (RPC peut renvoyer array ou object)
        let rpcRow = null;
        if (Array.isArray(rpcData) && rpcData.length) rpcRow = rpcData[0];
        else rpcRow = rpcData;

        // If server returned canonical board/move_count/current_turn/status -> apply them
        if (rpcRow) {
          // apply server board if present
          if (rpcRow.board !== undefined && rpcRow.board !== null) {
            try {
              board = normalizeServerBoard(rpcRow.board);
            } catch (e) {
              dbgLog('normalizeServerBoard failed', e);
            }
          }

          // authoritative move_count
          if (rpcRow.move_count !== undefined && rpcRow.move_count !== null) {
            moveIndex = Number(rpcRow.move_count) || moveIndex;
          }

          // authoritative current_turn
          if (rpcRow.current_turn !== undefined) {
            current = rpcRow.current_turn || current;
            if (currentTurnEl) currentTurnEl.textContent = current;
          }

          // authoritative status
          const srvStatus = rpcRow.status || null;

          // handle finish: winner can be uuid or null (draw)
          if (srvStatus === 'finished' || rpcRow.game_finished === true) {
            // rpcRow.winner is uuid of winner or null for draw
            let winnerUuid = rpcRow.winner || null;

            // map uuid -> symbol (X or O) based on owner/opponent
            let winnerSymbol = null;
            if (winnerUuid) {
              if (winnerUuid === hostId) winnerSymbol = 'X';
              else if (winnerUuid === opponentId) winnerSymbol = 'O';
              else {
                dbgLog('winnerUuid not matching host/opponent', { winnerUuid, hostId, opponentId });
              }
            } else {
              winnerSymbol = 'draw';
            }

            // refresh canonical state from server (best-effort)
            try { await refreshGameState(); } catch (e) { dbgLog('post-RPC refreshGameState failed', e); }

            // call handleRoundEnd with symbol or 'draw'
            try {
              await handleRoundEnd(winnerSymbol);
            } catch (e) { dbgLog('handleRoundEnd after RPC failed', e); }
          } else {
            // not finished: render canonical board/state
            renderGrid(); renderMiniMap();
          }
        } else {
          // No rpcRow: fallbacks (existing logic)
          if (rpcRow && rpcRow.board) {
            try {
              if (typeof rpcRow.board === 'string') board = JSON.parse(rpcRow.board);
              else board = rpcRow.board;
              renderGrid(); renderMiniMap();
            } catch (e) {
              dbgLog('failed merging board from rpcRow, relying on realtime', e);
            }
          } else {
            // fallback: fetch last move and apply
            try {
              const { data: lastMove, error: lastErr } = await supabase.from(MOVES_TABLE)
                .select('position,player,move_index')
                .eq('game_id', gameId)
                .order('move_index', { ascending: false })
                .limit(1)
                .maybeSingle();
              if (!lastErr && lastMove) { applyRealtimeMove(lastMove); }
            } catch (e) { dbgLog('Fallback: exception fetching last move', e); }
          }
        }

      } catch (e) {
        // rollback optimistic UI
        board[i] = null;
        moveIndex = Math.max(0, moveIndex - 1);
        current = prevCurrent;
        if (currentTurnEl) currentTurnEl.textContent = current;
        renderGrid(); renderMiniMap();
        console.warn('PLACE_MOVE rpc exception', e);
        try { alert("Erreur serveur lors de l'envoi du coup. Voir console."); } catch (_) {}
        return false;
      }
    } else {
      // offline/local mode
      const w = checkWinnerAt(r, c) || checkAnyWinner();
      if (w) await handleRoundEnd(w);
      return true;
    }
  } finally {
    pendingMove = false;
  }
}

// wrapper for RPC finishes to update manches/series UI
async function handleRoundEnd(winnerSymbol) {
  try {
    if (winnerSymbol === 'draw') {
      try { alert('Match nul.'); } catch (_) {}
    } else if (winnerSymbol) {
      try { alert(`Le gagnant du round est ${winnerSymbol} !`); } catch (_) {}
    } else {
      try { alert('Partie terminée.'); } catch (_) {}
    }

    await refreshGameState();
  } catch (e) {
    console.warn('handleRoundEnd failed', e);
  }
}

// cell click handler used by rendering
async function onCellClick(r, c) {
  if (pendingMove) return;
  if (current !== localPlayerSymbol) return;
  await placeMove(r, c, localPlayerSymbol);
}

// --- Join game (load canonical game & moves) ---
async function joinGame(gId) {
  if (!gId || !supabase) {
    dbgLog('joinGame: missing parameters');
    resetLocalGame();
    return;
  }
  try {
    const { data: gameRow, error: gameErr } = await supabase.from(GAME_TABLE)
      .select('id,owner_id,opponent_id,current_turn,board,status,party_id')
      .eq('id', gId)
      .maybeSingle();

    if (gameErr || !gameRow) throw gameErr || new Error('Game introuvable');

    // load moves
    let moves = null;
    try {
      const res = await supabase.from(MOVES_TABLE)
        .select('*')
        .eq('game_id', gId)
        .order('move_index', { ascending: true });
      moves = res.data;
    } catch (ex) { dbgLog('moves fetch error', ex); }

    // reset local state and apply moves
    resetLocalGame(false); // don't stop polling wholly
    if (Array.isArray(moves)) {
      for (const m of moves) {
        try {
          const pos = Number(m.position);
          const player = m.player;
          if (!Number.isFinite(pos) || player == null) continue;
          board[pos] = player;
          moveIndex = Math.max(moveIndex, Number(m.move_index ?? moveIndex));
        } catch (mvErr) { dbgLog('joinGame: exception applying move', mvErr, m); }
      }
    }

    renderGrid(); renderMiniMap();

    gameId = gId;
    startPolling();

    isRemotePlaying = true;
    hostId = gameRow.owner_id;
    opponentId = gameRow.opponent_id;
    current = gameRow.current_turn || current;

    // determine local symbol
    try { sessionUser = (await supabase.auth.getSession())?.data?.session?.user ?? sessionUser; } catch (e) { dbgLog('getSession failed', e); }
    if (sessionUser?.id && hostId && sessionUser.id === hostId) localPlayerSymbol = 'X';
    else if (sessionUser?.id && opponentId && sessionUser.id === opponentId) localPlayerSymbol = 'O';
    else localPlayerSymbol = (sessionUser?.id && hostId && !opponentId) ? 'X' : 'O';
    isHost = !!(sessionUser?.id && hostId && sessionUser.id === hostId);

    if (currentTurnEl) currentTurnEl.textContent = current;

    await subscribeToGame(gId);
    await refreshGameState();

    try { window.dispatchEvent(new Event('taktik:joined')); } catch (e) { dbgLog('dispatch taktik:joined failed', e); }
  } catch (e) {
    console.warn('joinGame failed', e);
    try { alert('Impossible de charger le jeu complet. Veuillez réessayer.'); } catch (_) {}
    resetLocalGame();
  }
}

// --- reset local game (optionally keep polling) ---
function resetLocalGame(stopAll = true) {
  try { if (stopAll) stopPolling(); } catch(e) { dbgLog('stopPolling failed', e); }
  board = new Array(ROWS * COLS).fill(null);
  current = 'X'; localPlayerSymbol = 'X'; manches = { X: 0, O: 0 }; series = { X: 0, O: 0 }; moveIndex = 0;
  gameId = null; isRemotePlaying = false; hostId = null; opponentId = null; isHost = false;
  renderGrid(); renderMiniMap();
  if (currentTurnEl) currentTurnEl.textContent = current;
  if (scoreX) scoreX.textContent = '0'; if (scoreO) scoreO.textContent = '0';
  if (seriesX) seriesX.textContent = '0'; if (seriesO) seriesO.textContent = '0';
}

// --- Invitation helpers (resolve game_id from invitation) ---
// NOTE: now only returns game_id when invitation.status === 'accepted'
async function fetchGameIdFromInvitation(invId) {
  if (!invId || !supabase) return null;
  try {
    const { data, error } = await supabase.from('game_invitations')
      .select('game_id,status')
      .eq('id', invId)
      .maybeSingle();
    if (error || !data) return null;
    const status = (String(data.status || '').toLowerCase());
    if (status === 'accepted') return data.game_id || null;
    return null;
  } catch (e) { dbgLog('fetchGameIdFromInvitation failed', e); return null; }
}
async function waitForGameId(invId, attempts = 12, intervalMs = 2000) {
  const dbg = (typeof dbgAlert === 'function')
    ? (...args) => { try { dbgAlert(...args); } catch(e) { console.log('[dbgAlert fallback]', ...args, e); } }
    : (...args) => console.log('[dbgAlert fallback]', ...args);

  dbg(`waitForGameId: start — invitation=${invId}, attempts=${attempts}, intervalMs=${intervalMs}`);

  for (let i = 0; i < attempts; i++) {
    try {
      dbg(`waitForGameId: attempt ${i + 1} / ${attempts} — fetching game_id...`);
      const gid = await fetchGameIdFromInvitation(invId);

      if (gid) {
        dbg(`waitForGameId: ✅ received game_id="${gid}" on attempt ${i + 1}`);
        return gid;
      } else {
        dbg(`waitForGameId: (attempt ${i + 1}) no game_id yet or invitation not accepted`);
      }
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      dbg(`waitForGameId: ⚠️ error on attempt ${i + 1}: ${errMsg}`);
    }

    if (i < attempts - 1) {
      dbg(`waitForGameId: sleeping ${intervalMs} ms before next attempt`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  dbg(`waitForGameId: ❌ exhausted ${attempts} attempts — returning null`);
  return null;
}

// --- Init sequence (reads URL params, optionally resolves invitation) ---
async function initFromUrlAndMaybeJoin() {
  const url = new URL(location.href);
  const gameIdParam = url.searchParams.get('game_id');
  const inviteIdParam = url.searchParams.get('invitation_id');
  const fromInvite = url.searchParams.get('from_invite');

  let gid = gameIdParam || null;
  if (!gid && inviteIdParam) {
    try {
      const { data, error } = await supabase.from('game_invitations').select('id, game_id, status').eq('id', inviteIdParam).single();
      dbgLog("INVITATION DB CHECK", { data, error });
    } catch (e) { dbgLog("INVITATION DB CHECK FAILED", e); }
    gid = await waitForGameId(inviteIdParam, 12, 2000);
    if (!gid) {
      dbgLog('GAME LOAD DEBUG — gameId missing after polling for invitation.', { url: location.href, gameIdParam, inviteIdParam, fromInvite, supabasePresent: !!supabase });
      showSoftError("Game non chargé — probablement invitation non résolue. Réessaye dans quelques secondes.");
      return;
    }
  }

  if (!gid && fromInvite) {
    showSoftError("Redirection depuis une invitation : en attente de la création de la partie. Réessayez dans quelques secondes.");
    return;
  }

  if (!gid) {
    showSoftError("Connexion à la partie… Si l’invitation vient d’être acceptée, merci de patienter quelques secondes.");
    return;
  }

  await joinGame(gid);
}

// --- UI helpers for soft/hard errors ---
function showSoftError(msg) {
  const el = document.getElementById('status') || document.createElement('div');
  el.id = 'status';
  el.textContent = msg;
  document.body.prepend(el);
}
function showHardError(msg) { alert(msg); }

// --- Initialization of module (setup UI, events, import create_game if present) ---
async function init() {
  try {
    setCellSize();
    renderGrid(); renderMiniMap();
    ensureControlsPanel();
    fetchSoundLists().catch(()=>{});

    if (supabase) {
      try { sessionUser = (await supabase.auth.getSession())?.data?.session?.user ?? null; } catch (e) { dbgLog('getSession failed', e); }
    }

    if (newGameBtn) newGameBtn.addEventListener('click', async () => {
      if (supabase && sessionUser) {
        const id = await createGame();
        if (id) alert('Série/partie créée en ligne — ID: ' + id);
      } else {
        resetLocalGame(); alert('Nouvelle partie (local/demo)');
      }
    });

    if (menuGames) menuGames.addEventListener('click', async () => {
      if (window.taktikCreateGame && typeof window.taktikCreateGame.searchProfiles === 'function') {
        // user provided create_game UI will handle it
      } else {
        try {
          const mod = await import('./create_game.js');
          if (mod && typeof mod.default === 'function') {
            try { await mod.default(supabase); } catch (e) { dbgLog('initCreateGame failed', e); }
          }
        } catch (e) { /* optional */ }
      }
    });

    // Auto-join flow from URL (game_id or invitation)
    await initFromUrlAndMaybeJoin();
  } catch (e) {
    console.warn('init error', e);
  }
}

// --- Public API export / attach to window ---
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

// Attach fallback API if none exist
if (!window.taktikGame || !window.taktikGame._isReal) {
  window.taktikGame = {
    resetLocalGame, createGame, joinGame, placeMove,
    getState: () => ({ board, current, manches, series, gameId, isRemotePlaying, hostId, opponentId, localPlayerSymbol, isHost })
  };
}
