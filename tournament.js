/**
 * tournament.js — Module compétitions Taktik
 *
 * Export : initTournament(supabase, containerEl)
 *
 * Vues gérées :
 *   1. overview   — liste des tournois disponibles
 *   2. checkin    — salle d'attente après inscription
 *   3. bracket    — bracket complet + bouton "Jouer mon match"
 *   4. launching  — création match+game + redirection game.html
 */

export default async function initTournament(supabaseClient, containerEl) {
  const supabase = supabaseClient ?? window.supabase;
  const root     = containerEl ?? document.getElementById('placeholderText');

  if (!root) { console.error('tournament.js: containerEl introuvable'); return; }

  /* ── Helpers log ── */
  const dbg = (...a) => console.debug('[tournament]', ...a);

  /* ── CSS inline partagé ── */
  if (!document.getElementById('trn-styles')) {
    const s = document.createElement('style');
    s.id = 'trn-styles';
    s.textContent = `
      @keyframes trn-spin{to{transform:rotate(360deg)}}
      .trn-spin{display:inline-block;width:18px;height:18px;border:2px solid #cbd5e1;
        border-top-color:#6366f1;border-radius:50%;animation:trn-spin .7s linear infinite;flex-shrink:0}
      @keyframes trn-pulse{0%,100%{opacity:1}50%{opacity:.4}}
      .trn-pulse{animation:trn-pulse 1.8s ease-in-out infinite}
      .trn-btn-primary{padding:10px 22px;border:none;border-radius:8px;
        background:linear-gradient(135deg,#6366f1,#0ea5e9);color:#fff;
        font-weight:700;font-size:14px;cursor:pointer;transition:opacity .15s}
      .trn-btn-primary:hover{opacity:.88}
      .trn-btn-primary:disabled{opacity:.45;cursor:default}
      .trn-btn-secondary{padding:8px 18px;border:1px solid #e2e8f0;border-radius:8px;
        background:#fff;color:#475569;font-weight:600;font-size:13px;cursor:pointer;transition:background .15s}
      .trn-btn-secondary:hover{background:#f8fafc}
      .trn-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px 20px;margin-bottom:14px}
      .trn-slot{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:8px;
        background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#64748b;min-width:0}
      .trn-slot.filled{background:#ecfdf5;border-color:#6ee7b7;color:#065f46}
      .trn-slot.me{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}
      .trn-slot.empty{opacity:.5}
      .trn-slot.vs{background:#fefce8;border-color:#fde047;color:#92400e;
        font-size:11px;font-weight:800;text-transform:uppercase;justify-content:center;
        min-width:30px;padding:6px 7px}
      .trn-bracket-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:8px}
      .trn-round-lbl{font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;
        letter-spacing:.05em;min-width:48px;flex-shrink:0}
      .trn-match-btn{display:flex;align-items:center;justify-content:space-between;
        padding:14px 16px;border:2px solid #e2e8f0;border-radius:10px;background:#fff;
        cursor:pointer;transition:border-color .15s,background .15s;width:100%;text-align:left;margin-bottom:8px}
      .trn-match-btn:hover{border-color:#6366f1;background:#f5f3ff}
      .trn-match-btn.active{border-color:#22c55e;background:#f0fdf4}
      .trn-match-btn.pending{opacity:.55;cursor:default}
      .trn-badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700}
    `;
    document.head.appendChild(s);
  }

  /* ══════════════════════════════════════════════════════════════════
     UTILITAIRES
  ══════════════════════════════════════════════════════════════════ */

  function render(html) { root.innerHTML = html; }
  function spinner(msg = 'Chargement…') {
    return `<div style="display:flex;align-items:center;gap:10px;padding:24px 0;color:#94a3b8;">
      <span class="trn-spin"></span><span>${msg}</span></div>`;
  }
  function errBox(msg) {
    return `<div style="padding:16px;background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;
      color:#dc2626;font-size:13px;">❌ ${msg}</div>`;
  }
  function fmt(n, d = 0) {
    if (n == null || isNaN(+n)) return '—';
    return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  async function getSession() {
    if (!supabase?.auth) return null;
    try { const { data } = await supabase.auth.getSession(); return data?.session ?? null; }
    catch { return null; }
  }

  async function getUserBalance(uid) {
    if (!uid) return 0;
    const { data } = await supabase.from('tiks_balances').select('balance').eq('user_id', uid).maybeSingle();
    return Number(data?.balance ?? 0);
  }

  async function getProfiles(ids) {
    if (!ids?.length) return [];
    const { data } = await supabase.from('user_profiles').select('id,pseudo,avatar_url').in('id', ids);
    return data ?? [];
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 1 — OVERVIEW : liste des tournois
  ══════════════════════════════════════════════════════════════════ */

  async function showOverview() {
    render(spinner('Chargement des compétitions…'));

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    if (!supabase) { render(errBox('Connexion Supabase non disponible.')); return; }

    /* Tournois en attente ou actifs */
    const { data: tournaments, error } = await supabase
      .from('tournaments')
      .select('id,status,entry_fee,prize_first,prize_second,created_at,started_at')
      .in('status', ['waiting', 'active'])
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) { render(errBox('Erreur chargement : ' + error.message)); return; }

    /* Inscriptions de l'utilisateur */
    let myTids = new Set();
    if (uid && tournaments?.length) {
      const { data: myRegs } = await supabase
        .from('tournament_registrations')
        .select('tournament_id')
        .eq('user_id', uid)
        .in('tournament_id', tournaments.map(t => t.id));
      (myRegs ?? []).forEach(r => myTids.add(r.tournament_id));
    }

    /* Nombre de joueurs par tournoi */
    const counts = {};
    if (tournaments?.length) {
      for (const t of tournaments) {
        const { count } = await supabase
          .from('tournament_registrations')
          .select('id', { count: 'exact', head: true })
          .eq('tournament_id', t.id);
        counts[t.id] = count ?? 0;
      }
    }

    /* Solde */
    const balance = await getUserBalance(uid);

    /* Rendu */
    let html = `
      <div style="margin-bottom:18px;">
        <h3 style="font-size:17px;font-weight:800;color:#1e293b;margin-bottom:4px;">🏆 Compétitions disponibles</h3>
        <p style="font-size:13px;color:#64748b;">Format KO 4 joueurs · Frais 20 TIKS · Prizes 40 / 20 TIKS</p>
      </div>`;

    if (!tournaments?.length) {
      html += `<div class="trn-card" style="text-align:center;color:#94a3b8;padding:32px;">
        <div style="font-size:32px;margin-bottom:8px;">🎮</div>
        <div style="font-weight:600;margin-bottom:6px;">Aucune compétition en cours</div>
        <div style="font-size:12px;">Reviens bientôt ou sois le premier à lancer un tournoi !</div>
        ${uid ? `<button class="trn-btn-primary" style="margin-top:14px;" id="trn-create-btn">Créer un tournoi</button>` : ''}
      </div>`;
    } else {
      for (const t of tournaments) {
        const n       = counts[t.id] ?? 0;
        const isIn    = myTids.has(t.id);
        const pct     = Math.round(n / 4 * 100);
        const statusLabel = t.status === 'active'
          ? `<span class="trn-badge" style="background:#dcfce7;color:#16a34a;">En cours</span>`
          : `<span class="trn-badge" style="background:#e0f2fe;color:#0369a1;">${n}/4 joueurs</span>`;
        const isInBadge = isIn
          ? `<span class="trn-badge" style="background:#eff6ff;color:#1d4ed8;margin-left:6px;">Inscrit ✓</span>` : '';

        html += `
          <div class="trn-card" data-tid="${t.id}">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
              <div>
                <span style="font-size:15px;font-weight:700;color:#1e293b;">Tournoi KO</span>
                ${statusLabel}${isInBadge}
              </div>
              <div style="display:flex;gap:8px;font-size:12px;color:#64748b;">
                <span>💰 Frais : <strong>${fmt(t.entry_fee)} TIKS</strong></span>
                <span>🥇 <strong>${fmt(t.prize_first)}</strong> · 🥈 <strong>${fmt(t.prize_second)}</strong></span>
              </div>
            </div>

            <!-- Progression -->
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:4px;">
                <span>${n} / 4 joueurs</span><span>${pct}%</span>
              </div>
              <div style="height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#0ea5e9);border-radius:3px;"></div>
              </div>
            </div>

            <!-- Actions -->
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              ${!uid
                ? `<span style="font-size:13px;color:#94a3b8;">Connecte-toi pour participer</span>`
                : isIn
                  ? `<button class="trn-btn-primary trn-checkin-btn" data-tid="${t.id}">
                       ${t.status === 'active' ? '🎮 Voir mon bracket' : '⏳ Salle d\'attente'}
                     </button>`
                  : t.status === 'waiting'
                    ? balance >= 20
                      ? `<button class="trn-btn-primary trn-join-btn" data-tid="${t.id}" data-fee="${t.entry_fee}">
                           Rejoindre — ${fmt(t.entry_fee)} TIKS
                         </button>`
                      : `<span style="font-size:13px;color:#dc2626;font-weight:600;">
                           Solde insuffisant (${fmt(balance)} TIKS)
                           <a href="#" class="trn-buy-link" style="color:#6366f1;margin-left:6px;text-decoration:underline;">Acheter →</a>
                         </span>`
                    : `<span style="font-size:13px;color:#94a3b8;">Tournoi déjà démarré</span>`
              }
            </div>
          </div>`;
      }
    }

    /* Solde affiché en bas */
    if (uid) {
      html += `<div style="margin-top:8px;font-size:12px;color:#94a3b8;text-align:right;">
        Votre solde : <strong style="color:#6366f1;">${fmt(balance)} TIKS</strong></div>`;
    }

    render(html);

    /* ── Listeners ── */
    root.querySelectorAll('.trn-join-btn').forEach(btn => {
      btn.addEventListener('click', () => joinTournament(btn.dataset.tid, Number(btn.dataset.fee)));
    });
    root.querySelectorAll('.trn-checkin-btn').forEach(btn => {
      btn.addEventListener('click', () => showCheckin(btn.dataset.tid));
    });
    root.querySelectorAll('.trn-buy-link').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); document.getElementById('menuTiks')?.click(); });
    });
    root.querySelector('#trn-create-btn')?.addEventListener('click', createAndJoin);
  }

  /* ══════════════════════════════════════════════════════════════════
     ACTION — REJOINDRE (ou créer+rejoindre)
  ══════════════════════════════════════════════════════════════════ */

  async function joinTournament(tid, fee) {
    render(spinner('Inscription en cours…'));
    try {
      const { data, error } = await supabase.rpc('rpc_register_tournament');
      if (error) {
        const msg = error.message ?? String(error);
        if (msg.toLowerCase().includes('insuffisant')) {
          render(`${errBox(msg)}
            <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour</button>`);
          root.querySelector('#trn-back-btn')?.addEventListener('click', showOverview);
        } else if (msg.includes('déjà inscrit')) {
          await showCheckin(tid);
        } else {
          render(`${errBox(msg)}
            <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour</button>`);
          root.querySelector('#trn-back-btn')?.addEventListener('click', showOverview);
        }
        return;
      }

      const tournamentId = data?.tournament_id ?? tid;
      if (data?.status === 'started') {
        await showBracket(tournamentId, true);
      } else {
        await showCheckin(tournamentId);
      }
    } catch (e) {
      render(`${errBox(e?.message ?? String(e))}
        <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour</button>`);
      root.querySelector('#trn-back-btn')?.addEventListener('click', showOverview);
    }
  }

  async function createAndJoin() {
    await joinTournament(null, 20);
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 2 — CHECK-IN / SALLE D'ATTENTE
  ══════════════════════════════════════════════════════════════════ */

  let _checkinChannel = null;
  let _checkinPoll    = null;

  function stopCheckin() {
    if (_checkinChannel) { try { _checkinChannel.unsubscribe(); } catch (_) {} _checkinChannel = null; }
    if (_checkinPoll)    { clearInterval(_checkinPoll); _checkinPoll = null; }
  }

  async function showCheckin(tid) {
    stopCheckin();
    render(spinner('Chargement de la salle d\'attente…'));

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    const { data: t } = await supabase
      .from('tournaments').select('id,status,entry_fee,prize_first,prize_second').eq('id', tid).maybeSingle();

    if (!t) { render(errBox('Tournoi introuvable.')); return; }

    // Déjà actif → aller direct au bracket
    if (t.status === 'active') { await showBracket(tid, true); return; }

    await renderCheckinView(t, uid);

    /* Realtime */
    _checkinChannel = supabase.channel(`trn-checkin:${tid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_registrations', filter: `tournament_id=eq.${tid}` },
        async () => { await renderCheckinView(t, uid); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${tid}` },
        async (payload) => {
          if (payload?.new?.status === 'active') { stopCheckin(); await showBracket(tid, true); }
        })
      .subscribe(s => { if (s !== 'SUBSCRIBED') startCheckinPoll(tid, uid); });
  }

  async function renderCheckinView(t, uid) {
    const { data: regs } = await supabase
      .from('tournament_registrations').select('user_id,slot').eq('tournament_id', t.id).order('slot');
    const registrations = regs ?? [];
    const n = registrations.length;

    const profiles = await getProfiles(registrations.map(r => r.user_id));
    registrations.forEach(r => { r.pseudo = profiles.find(p => p.id === r.user_id)?.pseudo ?? null; });

    const myReg = registrations.find(r => r.user_id === uid);
    const pct   = Math.round(n / 4 * 100);

    let bracketHtml = '';
    [[1, 2, 'Demi 1'], [3, 4, 'Demi 2']].forEach(([s1, s2, label]) => {
      bracketHtml += `<div class="trn-bracket-row">
        <span class="trn-round-lbl">${label}</span>`;
      [s1, s2].forEach((slot, i) => {
        if (i > 0) bracketHtml += `<span class="trn-slot vs">VS</span>`;
        const r = registrations.find(x => x.slot === slot);
        const cls = r ? (r.user_id === uid ? 'me' : 'filled') : 'empty';
        bracketHtml += `<span class="trn-slot ${cls}">
          ${r ? (r.user_id === uid ? '👤' : '🎮') : '⬜'} ${r ? (r.pseudo || 'Joueur ' + slot) : 'En attente…'}
        </span>`;
      });
      bracketHtml += `</div>`;
    });

    const html = `
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
          <button class="trn-btn-secondary" id="trn-back-btn" style="padding:6px 14px;font-size:12px;">← Retour</button>
          <h3 style="font-size:16px;font-weight:800;color:#1e293b;margin:0;">
            ⏳ Salle d'attente
            <span class="trn-badge" style="background:#e0f2fe;color:#0369a1;margin-left:8px;">${n}/4</span>
          </h3>
        </div>

        <!-- Bracket -->
        <div class="trn-card" style="margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">
            Bracket en cours de formation
          </div>
          ${bracketHtml}
          <div class="trn-bracket-row" style="opacity:.45;margin-top:4px;">
            <span class="trn-round-lbl">Finale</span>
            <span class="trn-slot empty" style="font-size:12px;">Gagnant D1</span>
            <span class="trn-slot vs">VS</span>
            <span class="trn-slot empty" style="font-size:12px;">Gagnant D2</span>
          </div>
        </div>

        <!-- Progression -->
        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:5px;">
            <span>${n} / 4 joueurs inscrits</span><span>${pct}%</span>
          </div>
          <div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#0ea5e9);border-radius:4px;transition:width .4s;"></div>
          </div>
        </div>

        <!-- Statut -->
        <div style="padding:14px 16px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;text-align:center;">
          <div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:700;color:#1d4ed8;">
            <span class="trn-spin"></span>
            <span class="trn-pulse">
              ${myReg ? 'Tu es inscrit — en attente des autres joueurs…' : 'En attente…'}
            </span>
          </div>
          <div style="font-size:12px;color:#3b82f6;margin-top:6px;">
            Le tournoi démarrera automatiquement dès que 4 joueurs seront prêts.
          </div>
        </div>

        <!-- Prix -->
        <div style="display:flex;gap:8px;margin-top:14px;">
          <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;">Frais</div>
            <div style="font-size:20px;font-weight:800;color:#6366f1;">${fmt(t.entry_fee)}</div>
            <div style="font-size:11px;color:#64748b;">TIKS</div>
          </div>
          <div style="flex:1;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;">1er 🥇</div>
            <div style="font-size:20px;font-weight:800;color:#16a34a;">${fmt(t.prize_first)}</div>
            <div style="font-size:11px;color:#64748b;">TIKS</div>
          </div>
          <div style="flex:1;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;">2ème 🥈</div>
            <div style="font-size:20px;font-weight:800;color:#b45309;">${fmt(t.prize_second)}</div>
            <div style="font-size:11px;color:#64748b;">TIKS</div>
          </div>
        </div>
      </div>`;

    render(html);
    root.querySelector('#trn-back-btn')?.addEventListener('click', () => { stopCheckin(); showOverview(); });
  }

  function startCheckinPoll(tid, uid) {
    if (_checkinPoll) return;
    _checkinPoll = setInterval(async () => {
      const { data: t } = await supabase
        .from('tournaments').select('status').eq('id', tid).maybeSingle();
      if (t?.status === 'active')      { stopCheckin(); await showBracket(tid, true); }
      else if (t?.status === 'waiting') { const sess = await getSession(); await renderCheckinView({ id: tid, ...t }, sess?.user?.id ?? null); }
    }, 3000);
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 3 — BRACKET / COMPÉTITION
  ══════════════════════════════════════════════════════════════════ */

  let _bracketChannel = null;
  let _bracketPoll    = null;

  function stopBracket() {
    if (_bracketChannel) { try { _bracketChannel.unsubscribe(); } catch (_) {} _bracketChannel = null; }
    if (_bracketPoll)    { clearInterval(_bracketPoll); _bracketPoll = null; }
  }

  async function showBracket(tid, subscribe = false) {
    stopBracket();
    render(spinner('Chargement du bracket…'));

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    await renderBracketView(tid, uid);

    if (subscribe) {
      _bracketChannel = supabase.channel(`trn-bracket:${tid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_matches', filter: `tournament_id=eq.${tid}` },
          async () => renderBracketView(tid, uid))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${tid}` },
          async () => renderBracketView(tid, uid))
        .subscribe(s => { if (s !== 'SUBSCRIBED') { _bracketPoll = setInterval(() => renderBracketView(tid, uid), 5000); } });
    }
  }

  async function renderBracketView(tid, uid) {
    const { data: t } = await supabase
      .from('tournaments').select('*').eq('id', tid).maybeSingle();
    const { data: matches } = await supabase
      .from('tournament_matches').select('*').eq('tournament_id', tid).order('round').order('semi_index');
    const { data: regs } = await supabase
      .from('tournament_registrations').select('user_id,slot').eq('tournament_id', tid);

    const allMatches = matches ?? [];
    const allRegs    = regs ?? [];

    // Rassemble tous les user_ids pour les profils
    const allUids = [...new Set([
      ...allRegs.map(r => r.user_id),
      ...allMatches.flatMap(m => [m.player1_id, m.player2_id, m.winner_id].filter(Boolean)),
    ])];
    const profiles = await getProfiles(allUids);
    const pseudo = id => profiles.find(p => p.id === id)?.pseudo ?? (id ? id.slice(0, 8) + '…' : '?');

    // Mon match actif (semi ou finale)
    const myActiveMatch = allMatches.find(m =>
      m.status === 'active' && (m.player1_id === uid || m.player2_id === uid)
    );

    // Statut tournoi
    const isFinished = t?.status === 'finished';
    const statusBadge = isFinished
      ? `<span class="trn-badge" style="background:#dcfce7;color:#16a34a;">Terminé 🏁</span>`
      : `<span class="trn-badge" style="background:#dcfce7;color:#16a34a;">En cours ⚔️</span>`;

    /* ── Rendu des matchs ── */
    function matchBlock(m) {
      if (!m) return '<div style="color:#94a3b8;font-size:13px;">Match en attente…</div>';
      const p1   = pseudo(m.player1_id);
      const p2   = pseudo(m.player2_id);
      const isMe = m.player1_id === uid || m.player2_id === uid;
      const cls  = m.status === 'finished' ? 'pending' : (m.status === 'active' && isMe ? 'active' : m.status === 'active' ? '' : 'pending');
      const winnerLabel = m.winner_id ? `<span style="font-size:11px;color:#16a34a;font-weight:700;margin-left:6px;">🏆 ${pseudo(m.winner_id)}</span>` : '';

      let actionBtn = '';
      if (m.status === 'active' && isMe) {
        actionBtn = `<button class="trn-btn-primary trn-play-btn" data-tmid="${m.id}" style="padding:7px 18px;font-size:13px;">
          ▶ Jouer ce match
        </button>`;
      } else if (m.status === 'active') {
        actionBtn = `<span style="font-size:12px;color:#64748b;">Match en cours…</span>`;
      } else if (m.status === 'finished') {
        actionBtn = `<span style="font-size:12px;color:#16a34a;font-weight:600;">✓ Terminé</span>`;
      } else {
        actionBtn = `<span style="font-size:12px;color:#94a3b8;">En attente</span>`;
      }

      return `
        <button class="trn-match-btn ${cls}" ${m.status !== 'active' || !isMe ? 'disabled style="cursor:default"' : ''} data-tmid="${m.id}">
          <div>
            <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:3px;">
              ${p1 ?? '?'} <span style="color:#94a3b8;font-weight:400;">vs</span> ${p2 ?? '?'}
              ${winnerLabel}
            </div>
            <div style="font-size:11px;color:#94a3b8;">${m.round === 'semi' ? 'Demi-finale ' + (m.semi_index ?? '') : 'Finale 🏆'}</div>
          </div>
          <div>${actionBtn}</div>
        </button>`;
    }

    const semis  = allMatches.filter(m => m.round === 'semi');
    const finale = allMatches.find(m => m.round === 'final');

    /* ── Alerte "ton match t'attend" ── */
    const alertHtml = myActiveMatch && !isFinished
      ? `<div style="padding:14px 16px;background:#f0fdf4;border:2px solid #22c55e;border-radius:10px;
                     display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
           <div>
             <div style="font-size:14px;font-weight:700;color:#15803d;">⚔️ Ton match t'attend !</div>
             <div style="font-size:12px;color:#16a34a;margin-top:2px;">
               Tu affrontes <strong>${pseudo(myActiveMatch.player1_id === uid ? myActiveMatch.player2_id : myActiveMatch.player1_id)}</strong>
             </div>
           </div>
           <button class="trn-btn-primary trn-play-btn" data-tmid="${myActiveMatch.id}" style="padding:10px 20px;">
             ▶ Jouer maintenant
           </button>
         </div>`
      : '';

    /* ── Résultat final ── */
    const resultHtml = isFinished && t?.winner_id
      ? `<div style="padding:16px;background:#fefce8;border:1px solid #fde68a;border-radius:10px;
                     text-align:center;margin-bottom:16px;">
           <div style="font-size:22px;margin-bottom:6px;">🎉</div>
           <div style="font-size:15px;font-weight:800;color:#713f12;">Tournoi terminé !</div>
           <div style="font-size:13px;color:#92400e;margin-top:4px;">
             🥇 <strong>${pseudo(t.winner_id)}</strong>
             ${t.runner_up_id ? ` · 🥈 <strong>${pseudo(t.runner_up_id)}</strong>` : ''}
           </div>
         </div>`
      : '';

    const html = `
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
          <button class="trn-btn-secondary" id="trn-back-btn" style="padding:6px 14px;font-size:12px;">← Retour</button>
          <h3 style="font-size:16px;font-weight:800;color:#1e293b;margin:0;">
            🏆 Bracket ${statusBadge}
          </h3>
        </div>

        ${resultHtml}
        ${alertHtml}

        <!-- Matchs -->
        <div class="trn-card">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
            Demi-finales
          </div>
          ${semis.map(m => matchBlock(m)).join('') || '<div style="color:#94a3b8;font-size:13px;">En attente des matchs…</div>'}
        </div>

        <div class="trn-card">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
            Finale 🏆
          </div>
          ${matchBlock(finale)}
        </div>

        <!-- Participants -->
        <div class="trn-card">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">
            Participants
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${allRegs.sort((a,b)=>a.slot-b.slot).map(r => `
              <span class="trn-slot ${r.user_id===uid?'me':'filled'}">
                ${r.user_id===uid?'👤':'🎮'} ${pseudo(r.user_id)} <span style="opacity:.5;font-size:10px;">#${r.slot}</span>
              </span>`).join('')}
          </div>
        </div>
      </div>`;

    render(html);

    root.querySelector('#trn-back-btn')?.addEventListener('click', () => { stopBracket(); showOverview(); });

    /* Boutons "Jouer ce match" */
    root.querySelectorAll('.trn-play-btn').forEach(btn => {
      btn.addEventListener('click', () => launchGame(btn.dataset.tmid, uid, tid));
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 4 — LANCEMENT : création match+game → redirect game.html
  ══════════════════════════════════════════════════════════════════ */

  async function launchGame(tournamentMatchId, uid, tid) {
    render(`<div style="padding:32px;text-align:center;">
      <span class="trn-spin" style="width:28px;height:28px;border-width:3px;margin-bottom:14px;display:inline-block;"></span>
      <div style="font-size:15px;font-weight:700;color:#1e293b;margin-bottom:6px;">Préparation du match…</div>
      <div style="font-size:13px;color:#64748b;">Connexion au jeu en cours.</div>
    </div>`);

    try {
      // Récupère le tournament_match
      const { data: tmatch } = await supabase
        .from('tournament_matches').select('*').eq('id', tournamentMatchId).maybeSingle();

      if (!tmatch) throw new Error('Match introuvable.');
      if (tmatch.status === 'finished') {
        render(`${errBox('Ce match est déjà terminé.')}
          <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour au bracket</button>`);
        root.querySelector('#trn-back-btn')?.addEventListener('click', () => showBracket(tid, true));
        return;
      }

      let matchId = tmatch.match_id;
      let gameId  = null;

      if (!matchId) {
        if (tmatch.player1_id === uid) {
          /* Player 1 crée les records */
          const { data: mRow, error: mErr } = await supabase.from('matches')
            .insert({ owner_id: tmatch.player1_id, opponent_id: tmatch.player2_id, status: 'ongoing',
                      metadata: { tournament_id: tmatch.tournament_id, tournament_match_id: tmatch.id } })
            .select('id').single();
          if (mErr || !mRow) throw new Error('Erreur création match : ' + (mErr?.message ?? 'inconnu'));
          matchId = mRow.id;

          const { data: gRow, error: gErr } = await supabase.from('games')
            .insert({ owner_id: tmatch.player1_id, opponent_id: tmatch.player2_id,
                      status: 'playing', match_id: matchId })
            .select('id').single();
          if (gErr || !gRow) throw new Error('Erreur création game : ' + (gErr?.message ?? 'inconnu'));
          gameId = gRow.id;

          await supabase.from('tournament_matches').update({ match_id: matchId }).eq('id', tmatch.id);

        } else {
          /* Player 2 attend que player1 crée le match */
          const deadline = Date.now() + 20_000;
          while (!matchId && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 800));
            const { data: latest } = await supabase
              .from('tournament_matches').select('match_id').eq('id', tmatch.id).maybeSingle();
            matchId = latest?.match_id ?? null;
          }
          if (!matchId) throw new Error('Timeout : match non créé par le joueur 1. Réessaie dans quelques secondes.');
          const { data: g } = await supabase.from('games').select('id').eq('match_id', matchId).maybeSingle();
          gameId = g?.id ?? null;
        }
      } else {
        const { data: g } = await supabase.from('games').select('id').eq('match_id', matchId).maybeSingle();
        gameId = g?.id ?? null;
      }

      if (!gameId) throw new Error('gameId introuvable — le match n\'a peut-être pas encore été initialisé.');

      /* Redirection — même format que create_game.js */
      window.location.href = `game.html?gameId=${gameId}&matchId=${matchId}`;

    } catch (e) {
      console.error('[tournament] launchGame error', e);
      render(`${errBox(e?.message ?? String(e))}
        <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour au bracket</button>`);
      root.querySelector('#trn-back-btn')?.addEventListener('click', () => showBracket(tid, true));
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     POINT D'ENTRÉE
  ══════════════════════════════════════════════════════════════════ */

  // Vérifie si l'user est déjà inscrit à un tournoi en cours → ouvre directement la bonne vue
  async function init() {
    if (!supabase) { render(errBox('Connexion non disponible.')); return; }

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    if (uid) {
      // L'utilisateur est-il inscrit à un tournoi actif ou en attente ?
      const { data: myRegs } = await supabase
        .from('tournament_registrations')
        .select('tournament_id, tournaments!inner(status)')
        .eq('user_id', uid)
        .in('tournaments.status', ['waiting', 'active'])
        .limit(1)
        .maybeSingle();

      if (myRegs) {
        const t = myRegs.tournaments;
        const tid = myRegs.tournament_id;
        if (t?.status === 'active') { await showBracket(tid, true); return; }
        if (t?.status === 'waiting') { await showCheckin(tid); return; }
      }
    }

    await showOverview();
  }

  // Cleanup si on quitte la page
  window.addEventListener('pagehide', () => { stopCheckin(); stopBracket(); });

  // Exposer pour utilisation externe (ex : bouton depuis homePanel)
  window.taktikTournament = { showOverview, showCheckin, showBracket };

  await init();
}
