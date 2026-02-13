// maingame.js
// Centralise les scripts précédemment inline depuis game.html
// -> Compatible avec display.js (écoute display:* et applique les changements)
// --> N'importera pas et ne touchera pas aux responsabilités de live.js ni fab.js

import { supabase } from './supabaseClient.js';

// expose supabase globalement comme avant (game.js et autres s'attendent à window.supabase)
window.supabase = supabase;

// mappings UI
const uiMap = {
  player1: { pseudo: 'player1_pseudo', elo: 'player1_elo', div: 'player1_div', followers: 'player1_followers', avatar: 'player1_avatar' },
  player2: { pseudo: 'player2_pseudo', elo: 'player2_elo', div: 'player2_div', followers: 'player2_followers', avatar: 'player2_avatar' },
  mod:     { pseudo: 'mod_pseudo', elo: 'mod_elo', div: 'mod_div', followers: 'mod_followers', avatar: 'mod_avatar' }
};

const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = (text === null || text === undefined) ? '—' : text; };
const setImg = (id, src) => { const el = document.getElementById(id); if (el && src) el.src = src; };

// -----------------------------
// Player stats update (inchangé, juste remis)
// -----------------------------
async function updatePlayerStatsOnce() {
  try {
    if (!window.taktikGame) return;
    if (typeof window.taktikGame.getState !== 'function') return;

    const state = window.taktikGame.getState();
    const gid = state?.gameId;
    if (!gid) return;

    let ownerId = state?.hostId ?? null;
    let opponentId = state?.opponentId ?? null;

    // fallback to games table if we don't have ids
    if (!ownerId && !opponentId) {
      const { data: gameRow, error: gameErr } = await supabase
        .from('games')
        .select('id,owner_id,opponent_id,status')
        .eq('id', gid)
        .maybeSingle();

      if (gameErr || !gameRow) {
        return;
      }

      ownerId = gameRow.owner_id;
      opponentId = gameRow.opponent_id;
    }

    // try invitations for opponent if still missing
    if (!opponentId) {
      try {
        const { data: invs, error: invErr } = await supabase
          .from('game_invitations')
          .select('invitee_id,status')
          .eq('game_id', gid)
          .eq('status', 'pending')
          .limit(1);

        if (!invErr && invs && invs.length) {
          opponentId = invs[0].invitee_id;
        }
      } catch (e) {
        // ignore invitation fetch error
      }
    }

    const ids = [];
    if (ownerId) ids.push(ownerId);
    if (opponentId && !ids.includes(opponentId)) ids.push(opponentId);
    if (!ids.length) return;

    const { data: profiles, error: profileErr } = await supabase
      .from('user_profiles')
      .select('id,pseudo,elo,division,follower_count,avatar_url')
      .in('id', ids);

    if (profileErr || !profiles || !profiles.length) return;

    const byId = {};
    profiles.forEach(p => byId[p.id] = p);

    if (ownerId && byId[ownerId]) {
      const p = byId[ownerId];
      setText(uiMap.player1.pseudo, p.pseudo || 'Invité');
      setText(uiMap.player1.elo, p.elo ?? '—');
      setText(uiMap.player1.div, p.division ?? '—');
      setText(uiMap.player1.followers, p.follower_count ?? '—');
      if (p.avatar_url) setImg(uiMap.player1.avatar, p.avatar_url);
    } else if (ownerId) {
      setText(uiMap.player1.pseudo, ownerId);
    }

    if (opponentId && byId[opponentId]) {
      const p2 = byId[opponentId];
      setText(uiMap.player2.pseudo, p2.pseudo || 'Invité');
      setText(uiMap.player2.elo, p2.elo ?? '—');
      setText(uiMap.player2.div, p2.division ?? '—');
      setText(uiMap.player2.followers, p2.follower_count ?? '—');
      if (p2.avatar_url) setImg(uiMap.player2.avatar, p2.avatar_url);
    } else if (opponentId) {
      setText(uiMap.player2.pseudo, opponentId);
    }

  } catch (e) {
    console.warn('updatePlayerStatsOnce error', e);
  }
}

// exposer la fonction comme avant
window.updatePlayerStatsOnce = updatePlayerStatsOnce;

// essayer au join / si jeu déjà réel
document.addEventListener('taktik:joined', () => {
  try { updatePlayerStatsOnce(); } catch (e) { console.warn('updatePlayerStatsOnce failed after join', e); }
});
if (window.taktikGame && window.taktikGame._isReal) {
  try { updatePlayerStatsOnce(); } catch(e) { console.warn('updatePlayerStatsOnce immediate failed', e); }
}

// polling léger identique à avant
(function startPolling() {
  updatePlayerStatsOnce().catch(()=>{});
  setInterval(() => updatePlayerStatsOnce().catch(()=>{}), 3000);
})();

// expose des images par défaut (compatibilité)
window.pieceImages = {
  X: 'pion_x.svg',
  O: 'pion_o.svg'
};

// -----------------------------
// Helpers & display integration (nouveau)
// -----------------------------

/**
 * Pause any <video> elements inside a container (best-effort).
 * We avoid stopping tracks (leaving that to live.js) — we only pause UI video elements.
 */
function pauseVideosIn(containerEl) {
  if (!containerEl) return;
  const vids = containerEl.querySelectorAll && containerEl.querySelectorAll('video');
  if (!vids || !vids.length) return;
  vids.forEach(v => {
    try {
      v.pause();
      // mute to avoid audio while hidden
      v.muted = true;
      // don't stop tracks here — live.js or the src owner should manage tracks
    } catch (e) { /* ignore */ }
  });
}

function playVideosIn(containerEl) {
  if (!containerEl) return;
  const vids = containerEl.querySelectorAll && containerEl.querySelectorAll('video');
  if (!vids || !vids.length) return;
  vids.forEach(v => {
    try {
      v.muted = false;
      // don't call play() forcibly (may require user gesture), but attempt
      v.play && v.play().catch(()=>{});
    } catch (e) { /* ignore */ }
  });
}

/**
 * Toggle element by id and optionally inform live manager if present.
 */
function applyVideoToggle(id, enabled, logicalName) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = enabled ? '' : 'none';
    if (!enabled) pauseVideosIn(el);
    else playVideosIn(el);
  }

  // if there is a live manager that can actually enable/disable streams, call it
  try {
    if (window.liveManager && typeof window.liveManager.toggleVideo === 'function') {
      window.liveManager.toggleVideo(logicalName, !!enabled);
    }
  } catch (e) {
    // ignore
  }

  // emit a follow-up event for other modules
  try {
    document.dispatchEvent(new CustomEvent(`maingame:display:video:${logicalName}`, { detail: { enabled: !!enabled } }));
  } catch (e) {}
}

/**
 * Toggle minimap visibility and notify liveManager if present.
 */
function applyMiniMapToggle(enabled) {
  const el = document.getElementById('minimap');
  if (el) el.style.display = enabled ? '' : 'none';

  try {
    if (window.liveManager && typeof window.liveManager.toggleMiniMap === 'function') {
      window.liveManager.toggleMiniMap(!!enabled);
    }
  } catch (e) {}
  try { document.dispatchEvent(new CustomEvent('maingame:display:minimap', { detail: { enabled: !!enabled } })); } catch(e){}
}

/**
 * Create / hide the mini comments area (if display.js created it that's fine).
 * Here we attempt to attach basic behavior (placeholder) and notify chat manager if present.
 */
function applyCommentsToggle(enabled) {
  let el = document.getElementById('miniComments');
  if (!enabled) {
    if (el) el.style.display = 'none';
    try { document.dispatchEvent(new CustomEvent('maingame:display:commentaires', { detail: { enabled:false } })); } catch(e){}
    return;
  }

  if (!el) {
    // display.js may create it — try to find or create a minimal one
    el = document.getElementById('miniComments');
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'miniComments';
    el.className = 'mini-comments';
    el.innerHTML = `<div class="title">Commentaires</div><div class="comments-body"><div style="opacity:.6;font-size:13px">Aucun commentaire — connecte le flux de chat.</div></div>`;
    document.body.appendChild(el);
  }
  el.style.display = '';
  try { document.dispatchEvent(new CustomEvent('maingame:display:commentaires', { detail: { enabled:true } })); } catch(e){}
}

/**
 * Apply grid size change:
 * - Prefer calling window.taktikGame.setGridSize(size) if present (game-level logic).
 * - Otherwise adjust boardGrid CSS and (best-effort) rebuild placeholder cells if counts mismatch.
 */
function applyGridSize(size) {
  // prefer to delegate to game engine if it exposes an API
  try {
    if (window.taktikGame && typeof window.taktikGame.setGridSize === 'function') {
      window.taktikGame.setGridSize(Number(size));
      return;
    }
  } catch (e) {
    // ignore and fallback
  }

  const boardGrid = document.getElementById('boardGrid');
  if (!boardGrid) return;

  // adjust CSS columns
  boardGrid.style.gridTemplateColumns = `repeat(${size}, var(--cell-size))`;
  boardGrid.dataset.gridSize = String(size);

  // if number of children doesn't match desired, rebuild minimal placeholders
  const desired = size * size;
  const current = boardGrid.children.length;
  if (current !== desired) {
    // preserve existing nodes if many — but safest is to clear and create placeholders
    boardGrid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const cell = document.createElement('div');
        cell.className = 'board-cell';
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        // placeholder content; game.js should populate actual pieces / listeners
        frag.appendChild(cell);
      }
    }
    boardGrid.appendChild(frag);
  }

  // notify game code (in case it wants to rebuild internal state)
  try { document.dispatchEvent(new CustomEvent('maingame:display:grille', { detail: { size: Number(size) } })); } catch(e){}
}

// Expose a small shim API so game.js or other modules can call to trigger same behavior:
if (!window.taktikGame) window.taktikGame = window.taktikGame || {};
if (typeof window.taktikGame.setGridSize !== 'function') {
  window.taktikGame.setGridSize = function(size) {
    try { applyGridSize(Number(size)); } catch(e){ console.warn('taktikGame.setGridSize fallback error', e); }
  };
}

// -----------------------------
// Listeners for display.js events (core integration)
// -----------------------------
document.addEventListener('display:video1', (e) => {
  const enabled = !!(e && e.detail && e.detail.enabled);
  applyVideoToggle('videoCardPlayer1', enabled, 'video1');
});

document.addEventListener('display:video2', (e) => {
  const enabled = !!(e && e.detail && e.detail.enabled);
  applyVideoToggle('videoCardPlayer2', enabled, 'video2');
});

document.addEventListener('display:video3', (e) => {
  const enabled = !!(e && e.detail && e.detail.enabled);
  applyVideoToggle('videoCardMod', enabled, 'video3');
});

document.addEventListener('display:mini_map', (e) => {
  const enabled = !!(e && e.detail && e.detail.enabled);
  applyMiniMapToggle(enabled);
});

document.addEventListener('display:commentaires', (e) => {
  const enabled = !!(e && e.detail && e.detail.enabled);
  applyCommentsToggle(enabled);
});

document.addEventListener('display:grille', (e) => {
  const size = Number(e && e.detail && e.detail.size) || 20;
  applyGridSize(size);
});

// Also apply initial persisted state at startup (best-effort)
// display.js persists under 'displayPanelState' — read that to sync initial UI
(function applyInitialDisplayStateFromStorage() {
  try {
    const raw = localStorage.getItem('displayPanelState');
    if (!raw) return;
    const state = JSON.parse(raw);
    // Apply known keys
    if (typeof state.video1 === 'boolean') applyVideoToggle('videoCardPlayer1', state.video1, 'video1');
    if (typeof state.video2 === 'boolean') applyVideoToggle('videoCardPlayer2', state.video2, 'video2');
    if (typeof state.video3 === 'boolean') applyVideoToggle('videoCardMod', state.video3, 'video3');
    if (typeof state.mini_map === 'boolean') applyMiniMapToggle(state.mini_map);
    if (typeof state.commentaires === 'boolean') applyCommentsToggle(state.commentaires);
    if (state.grilleSize) applyGridSize(Number(state.grilleSize));
  } catch (e) {
    // ignore parse errors
  }
})();

// -----------------------------
// importer et initialiser game.js (comme avant)
// on laisse game.js responsable de construire la grille/board/etc.
// -----------------------------
(async () => {
  try {
    const mod = await import('./game.js');
    const initGame = mod.default || mod.initGame || mod.init;
    if (typeof initGame === 'function') {
      await initGame(supabase);
    } else if (typeof mod.default === 'function') {
      await mod.default(supabase);
    } else {
      console.warn('game.js did not export a callable default/init function', mod);
    }

    // garder référence globale pour debug
    window.taktikSupabase = supabase;

    // importer create_game APRÈS initGame (comme tu fais déjà)
    import('./create_game.js').catch(err => console.warn('create_game.js import failed', err));
  } catch (e) {
    console.warn('initGame error', e);
  }
})();

// -----------------------------
// BACK navigation helpers (déplacé depuis inline script)
// -----------------------------
(function setupBackNavigation() {
  const backBtn = document.getElementById('backBtn');

  function goBack() {
    try {
      if (history.length > 1) { history.back(); return; }
      if (document.referrer && document.referrer !== window.location.href) { window.location.href = document.referrer; return; }
      if (window.android && typeof window.android.goBack === 'function') { try { window.android.goBack(); return; } catch(e){} }
      if (window.Android && typeof window.Android.goBack === 'function') { try { window.Android.goBack(); return; } catch(e){} }
      if (navigator.app && typeof navigator.app.backHistory === 'function') { navigator.app.backHistory(); return; }
      window.close();
    } catch (e) {
      console.warn('goBack fallback error', e);
      try { history.back(); } catch (_) {}
    }
  }

  if (backBtn) {
    backBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      goBack();
    });
  }

  document.addEventListener('backbutton', function(e) {
    try { e.preventDefault(); } catch(e){}
    goBack();
  }, false);

  window.addEventListener('keydown', function(e) {
    const active = document.activeElement;
    const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (isTyping) return;
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault && e.preventDefault();
      goBack();
    }
  }, false);
})();

