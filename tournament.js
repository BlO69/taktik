/**
 * tournament.js — Module compétitions Taktik
 *
 * Export default: initTournament(supabase)
 * Utilise le polling (pas de realtime) pour la cohérence avec la logique des matchs.
 *
 * Gère :
 *  - Affichage des tournois actifs (overview)
 *  - Rejoindre la file d'attente (rpc_register_tournament)
 *  - Quitter la file (rpc_leave_tournament_queue)
 *  - Bracket avec pseudos (user_profiles.pseudo)
 *  - Lancement d'une fixture : décompte 45s → Accepter / Forfait
 *  - Redirection vers game.html (même pattern que create_game.js)
 *  - Compteur 600s transmis en paramètre URL pour game.js
 *  - Admin : créer un tournoi
 *  - Résultat final et distribution des prix
 */

export default async function initTournament(supabaseClient) {
  const supabase = supabaseClient ?? window.supabase;
  if (!supabase) {
    document.getElementById('tournamentRoot').innerHTML =
      '<p class="text-red-500">Client Supabase introuvable.</p>';
    return;
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  let userId     = null;
  let isAdmin    = false;
  let pollTimer  = null;
  let pollFast   = false;   // true when in active match (2s), else 5s
  let challengeOverlay = null; // overlay instance for 45s countdown

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const root = () => document.getElementById('tournamentRoot');

  function el(tag, cls = '', inner = '') {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (inner) e.innerHTML = inner;
    return e;
  }

  function formatPrize(v) {
    return Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' TIKS';
  }

  function totalRounds(maxPlayers) {
    return { 4: 2, 8: 3, 32: 5, 64: 6 }[maxPlayers] ?? 2;
  }

  // ─── Init session ──────────────────────────────────────────────────────────
  try {
    const { data: { session } } = await supabase.auth.getSession();
    userId = session?.user?.id ?? null;
  } catch (_) { }

  if (userId) {
    try {
      const { data } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', userId)
        .single();
      isAdmin = data?.role === 'administrator';
    } catch (_) { }
  }

  // Auth state changes (login / logout during session)
  try {
    supabase.auth.onAuthStateChange(async (event, session) => {
      userId = session?.user?.id ?? null;
      isAdmin = false;
      if (userId) {
        try {
          const { data } = await supabase.from('user_profiles').select('role').eq('id', userId).single();
          isAdmin = data?.role === 'administrator';
        } catch (_) { }
      }
      await refresh();
    });
  } catch (_) { }

  // ─── Data fetching ─────────────────────────────────────────────────────────

  async function fetchActiveTournaments() {
    const { data } = await supabase
      .from('tournaments')
      .select('id,max_players,status,entry_fee,prize_first,prize_second,prize_third,started_at,winner_id,runner_up_id,third_place_id')
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(20);
    return data ?? [];
  }

  async function fetchMyQueueEntry() {
    if (!userId) return null;
    const { data } = await supabase
      .from('tournament_queue')
      .select('id,max_players,queued_at,status,tournament_id')
      .eq('user_id', userId)
      .eq('status', 'waiting')
      .maybeSingle();
    return data;
  }

  async function fetchMyActiveTournamentReg() {
    if (!userId) return null;
    const { data } = await supabase
      .from('tournament_registrations')
      .select('tournament_id,slot')
      .eq('user_id', userId)
      .limit(5);
    if (!data?.length) return null;
    const tids = data.map(r => r.tournament_id);
    const { data: tours } = await supabase
      .from('tournaments')
      .select('id,max_players,status,prize_first,prize_second,prize_third,entry_fee')
      .in('id', tids)
      .eq('status', 'active')
      .limit(1);
    if (!tours?.length) return null;
    return { tournament: tours[0], slot: data.find(r => r.tournament_id === tours[0].id)?.slot };
  }

  async function fetchTournamentMatches(tournamentId) {
    const { data } = await supabase
      .from('tournament_matches')
      .select('id,round_number,match_index,is_bronze,player1_id,player2_id,winner_id,status,match_id,created_at,finished_at')
      .eq('tournament_id', tournamentId)
      .order('round_number', { ascending: true })
      .order('match_index', { ascending: true });
    return data ?? [];
  }

  async function fetchRegistrations(tournamentId) {
    const { data } = await supabase
      .from('tournament_registrations')
      .select('user_id,slot')
      .eq('tournament_id', tournamentId)
      .order('slot', { ascending: true });
    return data ?? [];
  }

  async function fetchPseudos(userIds) {
    if (!userIds?.length) return {};
    const { data } = await supabase
      .from('user_profiles')
      .select('id,pseudo,avatar_url')
      .in('id', userIds);
    const map = {};
    (data ?? []).forEach(p => { map[p.id] = p; });
    return map;
  }

  async function fetchQueueCount(maxPlayers) {
    const { count } = await supabase
      .from('tournament_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'waiting')
      .eq('max_players', maxPlayers);
    return count ?? 0;
  }

  async function fetchFinishedTournaments() {
    const { data } = await supabase
      .from('tournaments')
      .select('id,max_players,prize_first,finished_at,winner_id')
      .eq('status', 'finished')
      .order('finished_at', { ascending: false })
      .limit(5);
    return data ?? [];
  }

  // ─── Game creation (same pattern as create_game.js) ────────────────────────

  async function createTournamentGame(tournamentMatchId, opponentId) {
    try {
      const { data: rpcRaw, error: rpcErr } = await supabase.rpc('rpc_create_series_and_first_party', {
        p_opponent_id: opponentId,
        p_target_parties: 3,
        p_target_games: 3
      });
      if (rpcErr) throw new Error('RPC erreur: ' + rpcErr.message);

      let gameId = null, matchId = null, seriesId = null;
      if (Array.isArray(rpcRaw) && rpcRaw.length > 0) {
        const r = rpcRaw[0];
        gameId = r.game_id ?? r.g_id ?? null;
        matchId = r.match_id ?? r.m_id ?? null;
        seriesId = r.series_id ?? r.s_id ?? null;
      } else if (rpcRaw && typeof rpcRaw === 'object') {
        gameId = rpcRaw.game_id ?? rpcRaw.g_id ?? null;
        matchId = rpcRaw.match_id ?? rpcRaw.m_id ?? null;
        seriesId = rpcRaw.series_id ?? rpcRaw.s_id ?? null;
      }

      if (!gameId && !matchId) throw new Error('Aucun game_id retourné par le serveur');

      // Link the match (matches table row) to tournament_match
      if (matchId) {
        await supabase
          .from('tournament_matches')
          .update({ match_id: matchId })
          .eq('id', tournamentMatchId);
      }

      return { gameId, matchId, seriesId };
    } catch (e) {
      console.error('createTournamentGame error', e);
      throw e;
    }
  }

  // ─── Redirect to game.html ─────────────────────────────────────────────────

  function redirectToGame(gameId, matchId, tournamentMatchId) {
    let url = gameId
      ? `game.html?game_id=${encodeURIComponent(gameId)}`
      : 'game.html';
    if (matchId) url += `&match_id=${encodeURIComponent(matchId)}`;
    if (tournamentMatchId) url += `&tournament_match_id=${encodeURIComponent(tournamentMatchId)}&tournament_timer=600`;
    url += `&from_tournament=1&return_to=index.html?tab=tournament`;
    window.location.href = url;
  }

  // ─── Overlay helpers ───────────────────────────────────────────────────────

  function createOverlay() {
    const o = el('div');
    Object.assign(o.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '99999'
    });
    return o;
  }

  function removeOverlay(overlay) {
    try { if (overlay && overlay.parentNode) overlay.remove(); } catch (_) { }
  }

  // Spinner overlay
  function showSpinner(msg = 'Chargement…') {
    const overlay = createOverlay();
    const card = el('div', '', `
      <div style="text-align:center;background:#fff;border-radius:10px;padding:24px 32px;min-width:240px">
        <div style="margin:0 auto 12px;width:40px;height:40px;border-radius:50%;border:4px solid #e2e8f0;border-top-color:#0ea5e9;animation:tspin 0.8s linear infinite"></div>
        <div style="color:#475569;font-size:14px">${msg}</div>
      </div>`);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    if (!document.getElementById('tspin-style')) {
      const s = document.createElement('style');
      s.id = 'tspin-style';
      s.textContent = '@keyframes tspin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }
    return { close: () => removeOverlay(overlay) };
  }

  // ─── 45s challenge overlay ─────────────────────────────────────────────────

  /**
   * Shows the challenge overlay for both players.
   * isHost = true  → the one who launched (player1): shows waiting for opponent
   * isHost = false → the invitee (player2): shows Accept / Forfeit
   *
   * For the launcher, we don't show accept/forfeit since they initiated.
   * Instead they wait and can cancel (= forfeit).
   */
  function showChallengeOverlay({ opponentPseudo, isLauncher, tournamentMatchId, gameId, matchId, onAccept, onForfeit }) {
    if (challengeOverlay) removeOverlay(challengeOverlay);
    const overlay = createOverlay();
    challengeOverlay = overlay;

    const card = el('div', '', '');
    Object.assign(card.style, {
      background: '#fff', borderRadius: '12px', padding: '28px 32px',
      minWidth: '340px', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)'
    });

    const title = el('div', '', isLauncher
      ? `<strong style="font-size:18px">Défi envoyé à ${opponentPseudo}</strong>`
      : `<strong style="font-size:18px">${opponentPseudo} vous défie !</strong>`);
    title.style.marginBottom = '8px';

    const sub = el('div', '', isLauncher
      ? '<span style="color:#64748b;font-size:14px">En attente de confirmation…</span>'
      : '<span style="color:#64748b;font-size:14px">Acceptez ou forfait dans</span>');
    sub.style.marginBottom = '16px';

    const cdEl = el('div', '', '45');
    Object.assign(cdEl.style, {
      fontSize: '48px', fontWeight: '800', color: '#0ea5e9',
      lineHeight: '1', marginBottom: '20px'
    });

    const actions = el('div', '');
    actions.style.display = 'flex';
    actions.style.gap = '12px';
    actions.style.justifyContent = 'center';

    if (isLauncher) {
      const cancelBtn = el('button', '', 'Annuler (forfait)');
      Object.assign(cancelBtn.style, {
        padding: '10px 24px', borderRadius: '8px', background: '#fee2e2',
        color: '#b91c1c', fontWeight: '600', cursor: 'pointer', border: 'none', fontSize: '14px'
      });
      cancelBtn.addEventListener('click', () => {
        clearInterval(interval);
        removeOverlay(overlay);
        challengeOverlay = null;
        onForfeit && onForfeit();
      });
      actions.appendChild(cancelBtn);
    } else {
      const acceptBtn = el('button', '', '✔ Accepter');
      Object.assign(acceptBtn.style, {
        padding: '10px 24px', borderRadius: '8px', background: '#dcfce7',
        color: '#15803d', fontWeight: '600', cursor: 'pointer', border: 'none', fontSize: '14px'
      });
      const forfeitBtn = el('button', '', '✘ Forfait');
      Object.assign(forfeitBtn.style, {
        padding: '10px 24px', borderRadius: '8px', background: '#fee2e2',
        color: '#b91c1c', fontWeight: '600', cursor: 'pointer', border: 'none', fontSize: '14px'
      });

      acceptBtn.addEventListener('click', () => {
        clearInterval(interval);
        removeOverlay(overlay);
        challengeOverlay = null;
        onAccept && onAccept();
      });
      forfeitBtn.addEventListener('click', () => {
        clearInterval(interval);
        removeOverlay(overlay);
        challengeOverlay = null;
        onForfeit && onForfeit();
      });
      actions.appendChild(acceptBtn);
      actions.appendChild(forfeitBtn);
    }

    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(cdEl);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let seconds = 45;
    const interval = setInterval(() => {
      seconds--;
      cdEl.textContent = seconds;
      if (seconds <= 5) cdEl.style.color = '#ef4444';
      if (seconds <= 0) {
        clearInterval(interval);
        removeOverlay(overlay);
        challengeOverlay = null;
        onForfeit && onForfeit('expired');
      }
    }, 1000);

    return {
      close: () => {
        clearInterval(interval);
        removeOverlay(overlay);
        challengeOverlay = null;
      },
      syncSeconds: (s) => {
        seconds = Math.max(0, Math.floor(s));
        cdEl.textContent = seconds;
      }
    };
  }

  // ─── Forfeit handler ───────────────────────────────────────────────────────

  async function handleForfeit(tournamentMatchId, opponentId) {
    const spinner = showSpinner('Forfait enregistré…');
    try {
      const { data, error } = await supabase.rpc('rpc_report_tournament_winner', {
        p_tournament_match_id: tournamentMatchId,
        p_winner_id: opponentId
      });
      if (error) throw new Error(error.message);
    } catch (e) {
      console.error('handleForfeit error', e);
    } finally {
      spinner.close();
    }
    await refresh();
  }

  // ─── Launch match (player1 = owner) ───────────────────────────────────────

  async function launchMatch(tournamentMatch, pseudoMap) {
    if (!tournamentMatch || !userId) return;

    const opponentId = tournamentMatch.player1_id === userId
      ? tournamentMatch.player2_id
      : tournamentMatch.player1_id;

    if (!opponentId) { alert('Adversaire non trouvé.'); return; }

    const opponentPseudo = pseudoMap[opponentId]?.pseudo || 'Adversaire';

    stopPolling();

    let launchResult = null;
    const spinner = showSpinner('Création de la partie…');
    try {
      launchResult = await createTournamentGame(tournamentMatch.id, opponentId);
    } catch (e) {
      spinner.close();
      alert('Erreur lors de la création de la partie : ' + e.message);
      startPolling();
      return;
    }
    spinner.close();

    const { gameId, matchId } = launchResult;

    // Show launcher overlay (waiting for opponent to confirm)
    const overlayInst = showChallengeOverlay({
      opponentPseudo,
      isLauncher: true,
      tournamentMatchId: tournamentMatch.id,
      gameId, matchId,
      onForfeit: async () => {
        await handleForfeit(tournamentMatch.id, opponentId);
      }
    });

    // Poll to see if opponent accepted (they redirect themselves via their overlay)
    // We (launcher) go directly since WE created the game
    // After 2s give opponent time to see the challenge, then redirect
    setTimeout(() => {
      overlayInst.close();
      redirectToGame(gameId, matchId, tournamentMatch.id);
    }, 2500);
  }

  // ─── Check if I need to show challenge (player2 polling) ──────────────────

  async function checkMyActiveChallengeForMatch(tournamentMatch, pseudoMap) {
    // If match has match_id (game created), I'm player2 and haven't accepted yet
    if (!tournamentMatch.match_id) return false;
    if (tournamentMatch.status === 'finished') return false;

    const isPlayer2 = tournamentMatch.player2_id === userId;
    if (!isPlayer2) return false;

    // Check if overlay already showing
    if (challengeOverlay) return true;

    const player1Pseudo = pseudoMap[tournamentMatch.player1_id]?.pseudo || 'Adversaire';

    // Calculate remaining seconds from match creation
    const createdAt = new Date(tournamentMatch.created_at || Date.now()).getTime();
    // match_id was set after created_at — we use now minus createdAt as elapsed
    // In practice we don't have launched_at, so 45s from when match_id appears
    // We poll every 5s, so worst case 5s delay — use 45s as full countdown
    const remainingSeconds = 45; // fresh challenge (polling will close it if expired)

    showChallengeOverlay({
      opponentPseudo: player1Pseudo,
      isLauncher: false,
      tournamentMatchId: tournamentMatch.id,
      onAccept: async () => {
        redirectToGame(tournamentMatch.game_id_parsed, tournamentMatch.match_id_parsed, tournamentMatch.id);
      },
      onForfeit: async (reason) => {
        const opponentId = tournamentMatch.player1_id;
        await handleForfeit(tournamentMatch.id, opponentId);
      }
    });

    return true;
  }

  // ─── Bracket rendering ────────────────────────────────────────────────────

  function renderBracket(tournament, matches, pseudoMap) {
    const totalR = totalRounds(tournament.max_players);
    const container = el('div', '');
    container.style.overflowX = 'auto';

    const bracketEl = el('div', '');
    bracketEl.style.display = 'flex';
    bracketEl.style.gap = '24px';
    bracketEl.style.alignItems = 'flex-start';
    bracketEl.style.minWidth = 'max-content';
    bracketEl.style.padding = '8px 4px 16px';

    // Group matches by round
    const rounds = {};
    for (const m of matches) {
      if (!rounds[m.round_number]) rounds[m.round_number] = [];
      rounds[m.round_number].push(m);
    }

    function playerLabel(id) {
      if (!id) return '<span style="color:#94a3b8;font-style:italic">TBD</span>';
      const p = pseudoMap[id];
      const name = p?.pseudo || id.slice(0, 8) + '…';
      const isMe = id === userId;
      return `<span style="font-weight:${isMe ? '700' : '400'};color:${isMe ? '#0ea5e9' : '#334155'}">${name}${isMe ? ' ★' : ''}</span>`;
    }

    for (let r = 1; r <= totalR; r++) {
      const col = el('div', '');
      col.style.display = 'flex';
      col.style.flexDirection = 'column';
      col.style.gap = '12px';
      col.style.minWidth = '180px';

      const heading = el('div', '',
        r === totalR ? '🏆 Finale' : (r === totalR - 1 ? '🥊 Demi-finales' : `Tour ${r}`));
      heading.style.cssText = 'font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;';
      col.appendChild(heading);

      const rMatches = (rounds[r] || []).filter(m => !m.is_bronze);
      const bronze   = (rounds[r] || []).filter(m => m.is_bronze);

      for (const m of rMatches) {
        col.appendChild(renderMatchCard(m, pseudoMap, playerLabel));
      }

      if (r === totalR && bronze.length > 0) {
        const bronzeHead = el('div', '', '🥉 3ème place');
        bronzeHead.style.cssText = 'font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;margin-top:8px;margin-bottom:4px;';
        col.appendChild(bronzeHead);
        for (const m of bronze) {
          col.appendChild(renderMatchCard(m, pseudoMap, playerLabel));
        }
      }

      bracketEl.appendChild(col);
    }

    container.appendChild(bracketEl);
    return container;
  }

  function renderMatchCard(m, pseudoMap, playerLabel) {
    const card = el('div', '');
    const statusColor = {
      pending: '#e2e8f0', active: '#bfdbfe', finished: '#dcfce7'
    }[m.status] || '#f1f5f9';
    const statusText = {
      pending: 'En attente', active: '⚡ En cours', finished: '✔ Terminé'
    }[m.status] || m.status;

    card.style.cssText = `background:${statusColor};border-radius:10px;padding:10px 12px;font-size:13px;border:1px solid rgba(0,0,0,0.07);`;

    const p1Row = el('div', '');
    p1Row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:3px 0;';
    p1Row.innerHTML = playerLabel(m.player1_id);
    if (m.winner_id === m.player1_id) p1Row.innerHTML += ' <span style="color:#15803d;font-size:11px">Winner</span>';

    const divider = el('div', '');
    divider.style.cssText = 'height:1px;background:rgba(0,0,0,0.1);margin:4px 0;';

    const p2Row = el('div', '');
    p2Row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:3px 0;';
    p2Row.innerHTML = playerLabel(m.player2_id);
    if (m.winner_id === m.player2_id) p2Row.innerHTML += ' <span style="color:#15803d;font-size:11px">Winner</span>';

    const statusBadge = el('div', '', statusText);
    statusBadge.style.cssText = 'font-size:10px;color:#475569;margin-top:6px;text-align:right;';

    card.appendChild(p1Row);
    card.appendChild(divider);
    card.appendChild(p2Row);
    card.appendChild(statusBadge);

    return card;
  }

  // ─── Admin section ────────────────────────────────────────────────────────

  function renderAdminSection(container) {
    const section = el('div', '');
    section.style.cssText = 'background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:20px;';

    const title = el('div', '', '🔧 Administration — Créer un tournoi');
    title.style.cssText = 'font-weight:700;color:#92400e;margin-bottom:12px;';

    const form = el('div', '');
    form.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;';

    const formatLabel = el('label', '');
    formatLabel.innerHTML = '<span style="font-size:12px;color:#78350f;display:block;margin-bottom:4px">Format</span>';
    const formatSelect = el('select', '');
    formatSelect.style.cssText = 'padding:8px 12px;border-radius:6px;border:1px solid #fcd34d;background:#fffbeb;';
    [4, 8, 32, 64].forEach(n => {
      const o = el('option', '', n + ' joueurs');
      o.value = n;
      formatSelect.appendChild(o);
    });
    formatLabel.appendChild(formatSelect);

    const prizeInfo = el('div', '');
    prizeInfo.style.cssText = 'font-size:12px;color:#78350f;padding:8px 12px;background:#fffde7;border-radius:6px;';
    function updatePrizeInfo() {
      const n = parseInt(formatSelect.value);
      const pool = Math.floor(n * 20 * 0.875 / 10) * 10;
      const is4 = n === 4;
      const first  = Math.floor(pool * (is4 ? 4 : 7) / (is4 ? 7 : 14) / 10) * 10;
      const second = Math.floor(pool * (is4 ? 2 : 4) / (is4 ? 7 : 14) / 10) * 10;
      const third  = pool - first - second;
      prizeInfo.innerHTML = `Pool: <strong>${pool}</strong> TIKS &nbsp;|&nbsp; 🥇 ${first} &nbsp; 🥈 ${second} &nbsp; 🥉 ${third}`;
    }
    formatSelect.addEventListener('change', updatePrizeInfo);
    updatePrizeInfo();

    const createBtn = el('button', '', 'Créer le tournoi');
    createBtn.style.cssText = 'padding:8px 20px;border-radius:6px;background:#d97706;color:#fff;font-weight:600;cursor:pointer;border:none;';
    const msg = el('div', '');
    msg.style.cssText = 'font-size:13px;color:#92400e;margin-top:8px;';

    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      msg.textContent = 'Création en cours…';
      const n = parseInt(formatSelect.value);
      // To create a tournament we call rpc_try_create_tournament_from_queue.
      // But that needs enough players in queue. As admin we can insert n fake entries.
      // Better: insert a dummy registration via admin-level approach.
      // Since RLS only allows admins to insert into tournaments, we INSERT directly.
      const pool = Math.floor(n * 20 * 0.875 / 10) * 10;
      const is4 = n === 4;
      const first  = Math.floor(pool * (is4 ? 4 : 7) / (is4 ? 7 : 14) / 10) * 10;
      const second = Math.floor(pool * (is4 ? 2 : 4) / (is4 ? 7 : 14) / 10) * 10;
      const third  = pool - first - second;
      try {
        const { data, error } = await supabase
          .from('tournaments')
          .insert({
            max_players: n,
            status: 'active',
            entry_fee: 20,
            prize_first: first,
            prize_second: second,
            prize_third: third,
          })
          .select()
          .single();
        if (error) throw new Error(error.message);
        msg.innerHTML = `<span style="color:#15803d">✔ Tournoi créé ! ID: ${data.id.slice(0,8)}…</span>`;
        await refresh();
      } catch (e) {
        msg.innerHTML = `<span style="color:#b91c1c">Erreur : ${e.message}</span>`;
      }
      createBtn.disabled = false;
    });

    form.appendChild(formatLabel);
    form.appendChild(prizeInfo);
    section.appendChild(title);
    section.appendChild(form);
    form.appendChild(createBtn);
    section.appendChild(msg);
    container.appendChild(section);
  }

  // ─── Main render ──────────────────────────────────────────────────────────

  async function render() {
    const container = root();
    if (!container) return;
    container.innerHTML = '';

    // ── Admin panel ──────────────────────────────────────────────────────────
    if (isAdmin) renderAdminSection(container);

    // ── Fetch state ──────────────────────────────────────────────────────────
    let [activeTournaments, myQueue, myTourReg, finishedTournaments] = await Promise.all([
      fetchActiveTournaments(),
      fetchMyQueueEntry(),
      fetchMyActiveTournamentReg(),
      fetchFinishedTournaments()
    ]);

    // ── User status banner ───────────────────────────────────────────────────
    if (!userId) {
      const banner = el('div', '', '🔒 Connectez-vous pour participer aux tournois.');
      banner.style.cssText = 'background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px 16px;color:#0369a1;margin-bottom:16px;font-size:14px;';
      container.appendChild(banner);
    }

    // ── Queue status ─────────────────────────────────────────────────────────
    if (myQueue) {
      const qBanner = el('div', '');
      qBanner.style.cssText = 'background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px 18px;margin-bottom:16px;';
      qBanner.innerHTML = `
        <div style="font-weight:700;color:#15803d;margin-bottom:6px">⏳ En attente dans la file…</div>
        <div style="font-size:13px;color:#166534">Format : <strong>${myQueue.max_players} joueurs</strong> &nbsp;|&nbsp; Dans la file depuis ${new Date(myQueue.queued_at).toLocaleTimeString('fr-FR')}</div>`;
      const leaveBtn = el('button', '', 'Quitter la file (remboursement 20 TIKS)');
      leaveBtn.style.cssText = 'margin-top:10px;padding:7px 16px;border-radius:6px;background:#fee2e2;color:#b91c1c;font-weight:600;cursor:pointer;border:none;font-size:13px;';
      leaveBtn.addEventListener('click', async () => {
        leaveBtn.disabled = true;
        leaveBtn.textContent = 'Traitement…';
        const { data, error } = await supabase.rpc('rpc_leave_tournament_queue');
        if (error) {
          alert('Erreur : ' + error.message);
          leaveBtn.disabled = false;
          leaveBtn.textContent = 'Quitter la file';
          return;
        }
        await refresh();
      });
      qBanner.appendChild(leaveBtn);
      container.appendChild(qBanner);
    }

    // ── My active tournament ─────────────────────────────────────────────────
    if (myTourReg) {
      const { tournament } = myTourReg;
      const section = el('div', '');
      section.style.cssText = 'background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:18px 20px;margin-bottom:20px;';

      const head = el('div', '');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;';
      head.innerHTML = `
        <div>
          <span style="font-weight:700;font-size:16px;color:#1e40af">🏆 Ton tournoi en cours</span>
          <span style="margin-left:10px;font-size:12px;color:#64748b">${tournament.max_players} joueurs</span>
        </div>
        <div style="font-size:13px;color:#1d4ed8">
          🥇 ${formatPrize(tournament.prize_first)} &nbsp;
          🥈 ${formatPrize(tournament.prize_second)} &nbsp;
          🥉 ${formatPrize(tournament.prize_third)}
        </div>`;
      section.appendChild(head);

      const matches  = await fetchTournamentMatches(tournament.id);
      const regs     = await fetchRegistrations(tournament.id);
      const allIds   = [...new Set([...regs.map(r => r.user_id), ...matches.flatMap(m => [m.player1_id, m.player2_id, m.winner_id]).filter(Boolean)])];
      const pseudoMap = await fetchPseudos(allIds);

      // Find my current active match
      const myActiveMatch = matches.find(m =>
        m.status === 'active' &&
        (m.player1_id === userId || m.player2_id === userId)
      );

      // ── Active match actions ─────────────────────────────────────────────
      if (myActiveMatch) {
        const matchBanner = el('div', '');
        matchBanner.style.cssText = 'background:#dbeafe;border-radius:8px;padding:12px 16px;margin-bottom:14px;';

        const isPlayer1 = myActiveMatch.player1_id === userId;
        const opponentId = isPlayer1 ? myActiveMatch.player2_id : myActiveMatch.player1_id;
        const opponentPseudo = pseudoMap[opponentId]?.pseudo || 'Adversaire';

        if (!myActiveMatch.match_id) {
          // Game not yet created
          if (isPlayer1) {
            // Player1 = owner = can launch
            matchBanner.innerHTML = `
              <div style="font-weight:600;color:#1e40af;margin-bottom:8px">⚔️ C'est ton tour ! Lance le match contre <strong>${opponentPseudo}</strong></div>
              <div style="font-size:12px;color:#3b82f6;margin-bottom:10px">Une fois lancé, votre adversaire aura 45 secondes pour accepter.</div>`;
            const launchBtn = el('button', '', '🚀 Lancer le match');
            launchBtn.style.cssText = 'padding:10px 24px;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;border:none;font-size:14px;';
            launchBtn.addEventListener('click', async () => {
              launchBtn.disabled = true;
              await launchMatch(myActiveMatch, pseudoMap);
              launchBtn.disabled = false;
            });
            matchBanner.appendChild(launchBtn);
          } else {
            // Player2 = waiting for player1 to launch
            matchBanner.innerHTML = `
              <div style="font-weight:600;color:#1e40af;margin-bottom:4px">⏳ En attente que <strong>${opponentPseudo}</strong> lance le match…</div>
              <div style="font-size:12px;color:#3b82f6">Vous recevrez une invitation dans quelques instants.</div>`;
          }
        } else {
          // match_id is set → game has been created
          if (isPlayer1) {
            // Player1 already redirected after creating game
            matchBanner.innerHTML = `<div style="font-weight:600;color:#15803d">✅ Partie en cours… Rejoindre si vous avez été déconnecté.</div>`;
            // Fetch game_id from matches table
            try {
              const { data: matchRow } = await supabase
                .from('matches')
                .select('id, game_id')
                .eq('id', myActiveMatch.match_id)
                .maybeSingle();
              if (matchRow) {
                const rejoinBtn = el('button', '', '↩ Rejoindre la partie');
                rejoinBtn.style.cssText = 'margin-top:8px;padding:8px 18px;border-radius:6px;background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer;border:none;';
                rejoinBtn.addEventListener('click', () => {
                  redirectToGame(matchRow.game_id, matchRow.id, myActiveMatch.id);
                });
                matchBanner.appendChild(rejoinBtn);
              }
            } catch (_) {}
          } else {
            // Player2: show accept/forfeit if overlay not already visible
            if (!challengeOverlay) {
              // Fetch game_id
              let resolvedGameId = null;
              try {
                const { data: matchRow } = await supabase
                  .from('matches')
                  .select('id, game_id')
                  .eq('id', myActiveMatch.match_id)
                  .maybeSingle();
                resolvedGameId = matchRow?.game_id ?? null;
                const resolvedMatchId = matchRow?.id ?? myActiveMatch.match_id;

                showChallengeOverlay({
                  opponentPseudo,
                  isLauncher: false,
                  tournamentMatchId: myActiveMatch.id,
                  gameId: resolvedGameId,
                  matchId: resolvedMatchId,
                  onAccept: () => {
                    redirectToGame(resolvedGameId, resolvedMatchId, myActiveMatch.id);
                  },
                  onForfeit: async () => {
                    await handleForfeit(myActiveMatch.id, opponentId);
                  }
                });
              } catch (_) {}
            }
            matchBanner.innerHTML = `<div style="font-weight:600;color:#1e40af">⚠️ Répondez au défi de <strong>${opponentPseudo}</strong> !</div>`;
          }
        }
        section.appendChild(matchBanner);
      } else {
        // No active match — check if all my matches are finished
        const myMatches = matches.filter(m =>
          m.player1_id === userId || m.player2_id === userId
        );
        const lastDone = myMatches.filter(m => m.status === 'finished').sort((a, b) => b.round_number - a.round_number)[0];
        if (lastDone) {
          const won = lastDone.winner_id === userId;
          const info = el('div', '');
          info.style.cssText = `background:${won ? '#dcfce7' : '#fee2e2'};border-radius:8px;padding:12px 16px;margin-bottom:14px;`;
          info.innerHTML = won
            ? '<strong style="color:#15803d">✅ Tu as remporté ton match ! Attends ton prochain adversaire…</strong>'
            : '<strong style="color:#b91c1c">❌ Tu as perdu. Bonne chance la prochaine fois.</strong>';
          section.appendChild(info);
        }
      }

      // ── Bracket ──────────────────────────────────────────────────────────
      const bracketTitle = el('div', '', 'Tableau du tournoi');
      bracketTitle.style.cssText = 'font-weight:700;color:#1e40af;margin-bottom:10px;font-size:14px;';
      section.appendChild(bracketTitle);
      section.appendChild(renderBracket(tournament, matches, pseudoMap));
      container.appendChild(section);
    }

    // ── Available tournaments list ────────────────────────────────────────────
    const joinSection = el('div', '');
    const joinTitle = el('div', '', '🎮 Tournois disponibles');
    joinTitle.style.cssText = 'font-weight:700;font-size:15px;color:#0f172a;margin-bottom:12px;';
    joinSection.appendChild(joinTitle);

    if (!activeTournaments.length) {
      const empty = el('div', '', 'Aucun tournoi actif pour le moment.');
      empty.style.cssText = 'color:#94a3b8;font-style:italic;font-size:14px;';
      joinSection.appendChild(empty);
    } else {
      const grid = el('div', '');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;';

      for (const t of activeTournaments) {
        const card = el('div', '');
        card.style.cssText = 'background:#fff;border-radius:12px;padding:16px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,0.04);';

        const qCount = await fetchQueueCount(t.max_players);

        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-weight:700;font-size:15px;color:#0f172a">${t.max_players} joueurs</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:#f0f9ff;color:#0369a1;font-weight:600">${qCount}/${t.max_players} en attente</span>
          </div>
          <div style="font-size:12px;color:#64748b;margin-bottom:10px">
            Entrée : <strong>20 TIKS</strong><br>
            🥇 ${formatPrize(t.prize_first)} &nbsp; 🥈 ${formatPrize(t.prize_second)} &nbsp; 🥉 ${formatPrize(t.prize_third)}
          </div>`;

        if (userId && !myQueue && !myTourReg) {
          const joinBtn = el('button', '', 'Rejoindre la file');
          joinBtn.style.cssText = 'width:100%;padding:8px 0;border-radius:8px;background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer;border:none;font-size:13px;';
          joinBtn.addEventListener('click', async () => {
            joinBtn.disabled = true;
            joinBtn.textContent = 'Inscription…';
            const { data, error } = await supabase.rpc('rpc_register_tournament', {
              p_max_players: t.max_players
            });
            if (error) {
              alert('Erreur : ' + error.message);
              joinBtn.disabled = false;
              joinBtn.textContent = 'Rejoindre la file';
              return;
            }
            if (data?.status === 'started') {
              alert('🎉 Tournoi lancé immédiatement !');
            }
            await refresh();
          });
          card.appendChild(joinBtn);
        } else if (!userId) {
          const lockEl = el('div', '', '🔒 Connexion requise');
          lockEl.style.cssText = 'font-size:12px;color:#94a3b8;text-align:center;padding:6px 0;';
          card.appendChild(lockEl);
        }

        grid.appendChild(card);
      }
      joinSection.appendChild(grid);
    }
    container.appendChild(joinSection);

    // ── Quick join buttons (formats not in active list) ───────────────────────
    if (userId && !myQueue && !myTourReg) {
      const quickSection = el('div', '');
      quickSection.style.cssText = 'margin-top:20px;';
      const quickTitle = el('div', '', '⚡ Rejoindre une file directement');
      quickTitle.style.cssText = 'font-weight:600;font-size:13px;color:#475569;margin-bottom:8px;';
      quickSection.appendChild(quickTitle);
      const btnRow = el('div', '');
      btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
      [4, 8, 32, 64].forEach(n => {
        const alreadyListed = activeTournaments.some(t => t.max_players === n);
        if (alreadyListed) return;
        const qBtn = el('button', '', `${n} joueurs`);
        qBtn.style.cssText = 'padding:7px 16px;border-radius:8px;background:#f1f5f9;color:#334155;font-weight:600;cursor:pointer;border:1px solid #e2e8f0;font-size:13px;';
        qBtn.addEventListener('click', async () => {
          qBtn.disabled = true;
          qBtn.textContent = '…';
          const { data, error } = await supabase.rpc('rpc_register_tournament', { p_max_players: n });
          if (error) { alert('Erreur : ' + error.message); qBtn.disabled = false; qBtn.textContent = n + ' joueurs'; return; }
          if (data?.status === 'started') alert('🎉 Tournoi lancé immédiatement !');
          await refresh();
        });
        btnRow.appendChild(qBtn);
      });
      quickSection.appendChild(btnRow);
      container.appendChild(quickSection);
    }

    // ── Recent finished tournaments ───────────────────────────────────────────
    if (finishedTournaments.length) {
      const finSection = el('div', '');
      finSection.style.cssText = 'margin-top:24px;';
      const finTitle = el('div', '', '📜 Tournois récents terminés');
      finTitle.style.cssText = 'font-weight:600;font-size:13px;color:#475569;margin-bottom:8px;';
      finSection.appendChild(finTitle);

      const allWinnerIds = finishedTournaments.map(t => t.winner_id).filter(Boolean);
      const finPseudos = await fetchPseudos(allWinnerIds);

      finishedTournaments.forEach(t => {
        const row = el('div', '');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;';
        const winnerName = t.winner_id ? (finPseudos[t.winner_id]?.pseudo || t.winner_id.slice(0,8) + '…') : '—';
        row.innerHTML = `
          <span><strong>${t.max_players} joueurs</strong> — 🥇 ${finPseudos[t.winner_id] ? finPseudos[t.winner_id].pseudo : '—'}</span>
          <span style="color:#94a3b8">${new Date(t.finished_at).toLocaleDateString('fr-FR')}</span>`;
        finSection.appendChild(row);
      });

      container.appendChild(finSection);
    }

    // ── Refresh button ────────────────────────────────────────────────────────
    const refreshRow = el('div', '');
    refreshRow.style.cssText = 'text-align:right;margin-top:16px;';
    const refreshBtn = el('button', '', '🔄 Actualiser');
    refreshBtn.style.cssText = 'font-size:12px;color:#94a3b8;background:none;border:none;cursor:pointer;padding:4px 8px;';
    refreshBtn.addEventListener('click', () => refresh());
    refreshRow.appendChild(refreshBtn);
    container.appendChild(refreshRow);
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  async function refresh() {
    try { await render(); } catch (e) { console.error('tournament refresh error', e); }
  }

  function startPolling(fast = false) {
    stopPolling();
    pollFast = fast;
    const interval = fast ? 2000 : 5000;
    pollTimer = setInterval(() => {
      refresh().catch(() => {});
    }, interval);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ─── Check if we returned from a game ────────────────────────────────────

  async function checkReturnFromGame() {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('from_tournament')) return;

    const tmId = params.get('tournament_match_id');
    const winnerId = params.get('winner_id'); // game.js should pass this

    if (tmId && winnerId) {
      const spinner = showSpinner('Enregistrement du résultat…');
      try {
        await supabase.rpc('rpc_report_tournament_winner', {
          p_tournament_match_id: tmId,
          p_winner_id: winnerId
        });
      } catch (e) {
        console.error('rpc_report_tournament_winner error', e);
      } finally {
        spinner.close();
      }
      // Clean URL
      const url = new URL(window.location.href);
      ['from_tournament','tournament_match_id','winner_id','tournament_timer','game_id','match_id','return_to'].forEach(k => url.searchParams.delete(k));
      window.history.replaceState({}, '', url.toString());
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  await checkReturnFromGame();
  await render();
  startPolling(false);

  // Switch to fast polling if user is in an active match
  // Re-evaluated each render cycle below
  supabase.auth.onAuthStateChange(() => {
    stopPolling();
    startPolling(false);
  });

  // Cleanup on navigation
  window.addEventListener('pagehide', stopPolling);
  window.addEventListener('beforeunload', stopPolling);

  // Public API
  window.taktikTournament = {
    refresh,
    startPolling,
    stopPolling,
    _isLoaded: true
  };

  console.info('[tournament.js] Initialized', new Date().toISOString());
}
