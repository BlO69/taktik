// maingame.js
// Centralise les scripts précédemment inline depuis game.html
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

// importer et initialiser game.js (comme avant)
// on laisse game.js responsable de construire la grille/board/etc.
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

//
// BACK navigation helpers (déplacé depuis inline script)
//
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

