/**
 * tournament.js — Module compétitions Taktik
 *
 * Export :
 *   default initTournament(supabase, containerEl)
 *   export async function renderHomePreview(previewEl, supabase)
 *
 * Vues gérées :
 *   1. overview   — liste des tournois disponibles
 *   2. checkin    — salle d'attente après inscription
 *   3. bracket    — bracket complet + bouton "Jouer mon match"
 *   4. launching  — création match+game + redirection game.html
 */

export default async function initTournament(supabaseClient, containerEl) {
  const supabase = supabaseClient ?? window.supabase;
  // IMPORTANT: par défaut on cible le panneau "tournamentContent" dans index.html
  const root     = containerEl ?? document.getElementById('tournamentContent') ?? document.getElementById('placeholderText');

  if (!root) { console.error('tournament.js: containerEl introuvable'); return; }

  /* ── Helpers log ── */
  const DBG = true; // met à true pour avoir des alert() verboses (utile sur Android sans terminal)
  const dbg = (...a) => {
    try { console.debug('[tournament]', ...a); } catch (_) {}
    if (DBG) {
      try {
        const msg = a.map(x => {
          if (typeof x === 'string') return x;
          try { return JSON.stringify(x, null, 2); } catch (_) { return String(x); }
        }).join(' ');
        // show verbose alert so Android users without terminal can see logs
        alert('[tournament] ' + msg);
      } catch (_) {}
    }
  };

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
      .trn-form-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
      .trn-input{padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}
      .trn-small{font-size:12px;color:#64748b}
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
  function okBox(msg) {
    return `<div style="padding:12px;background:#ecfdf5;border:1px solid #bbf7d0;border-radius:8px;
      color:#065f46;font-size:13px;">✅ ${msg}</div>`;
  }
  function fmt(n, d = 0) {
    if (n == null || isNaN(+n)) return '—';
    return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  async function getSession() {
    if (!supabase?.auth) return null;
    try { const { data } = await supabase.auth.getSession(); return data?.session ?? null; }
    catch (e) { dbg('getSession error', e); return null; }
  }

  async function getUserBalance(uid) {
    if (!uid) return 0;
    try {
      const { data, error } = await supabase.from('tiks_balances').select('balance').eq('user_id', uid).maybeSingle();
      if (error) { dbg('getUserBalance error', error); return 0; }
      return Number(data?.balance ?? 0);
    } catch (e) { dbg('getUserBalance exception', e); return 0; }
  }

  async function getProfiles(ids) {
    if (!ids?.length) return [];
    try {
      const uniq = [...new Set(ids.filter(Boolean))];
      if (!uniq.length) return [];
      const { data, error } = await supabase.from('user_profiles').select('id,pseudo,avatar_url').in('id', uniq);
      if (error) { dbg('getProfiles error', error); return []; }
      return data ?? [];
    } catch (e) { dbg('getProfiles exception', e); return []; }
  }

  // Nouveau helper pour récupérer le profil (notamment role) du user courant
  async function getMyProfile(uid) {
    if (!uid) return null;
    try {
      // on demande role + champs alternatifs au cas où la table user_profiles diffère
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id,pseudo,role,is_admin,can_create_tournament')
        .eq('id', uid)
        .maybeSingle();
      if (error) {
        dbg('getMyProfile error', error);
        return null;
      }
      return data ?? null;
    } catch (e) {
      dbg('getMyProfile exception', e);
      return null;
    }
  }

  /* Helper: calcule prizes par défaut (même logique que RPC côté serveur) */
  function estimatePrizes(max_players = 4, entry_fee = 20) {
    const poolRaw = Math.floor((max_players * entry_fee * 0.875) / 10) * 10;
    let prize_first = 0, prize_second = 0, prize_third = 0;
    if (max_players === 4) {
      prize_first = Math.floor(poolRaw * 4 / 7.0 / 10) * 10;
      prize_second = Math.floor(poolRaw * 2 / 7.0 / 10) * 10;
    } else {
      prize_first = Math.floor(poolRaw * 7 / 14.0 / 10) * 10;
      prize_second = Math.floor(poolRaw * 4 / 14.0 / 10) * 10;
    }
    prize_third = poolRaw - prize_first - prize_second;
    return { pool: poolRaw, prize_first, prize_second, prize_third };
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 1 — OVERVIEW : liste des tournois
  ══════════════════════════════════════════════════════════════════ */

  async function showOverview() {
    dbg('showOverview start');
    render(spinner('Chargement des compétitions…'));

    let session = null;
    let uid = null;
    try {
      session = await getSession();
      uid = session?.user?.id ?? null;
    } catch (e) {
      dbg('getSession error', e);
    }

    if (!supabase) {
      render(errBox('Connexion Supabase non disponible.'));
      return;
    }

    const myProfile = uid ? await getMyProfile(uid) : null;
    const isAdmin = !!(myProfile &&
      (['administrator', 'admin', 'super_admin', 'superuser'].includes((myProfile.role ?? '').toLowerCase())
        || myProfile.is_admin === true
        || myProfile.can_create_tournament === true));
    dbg('myProfile', myProfile, 'isAdmin=' + isAdmin);

    // récupérer tournois actifs (limit 10)
    let tournaments = [];
    try {
      const { data, error } = await supabase
        .from('tournaments')
        .select('id,max_players,status,entry_fee,prize_first,prize_second,prize_third,created_at,started_at')
        .in('status', ['active'])
        .order('created_at', { ascending: true })
        .limit(10);
      if (error) throw error;
      tournaments = data ?? [];
    } catch (e) {
      dbg('showOverview tournaments query error', e);
      tournaments = [];
    }

    // Si aucun tournoi, afficher message et (si admin) formulaire de création
    if (!tournaments.length) {
      let html = `<div class="trn-card" style="text-align:center;color:#94a3b8;padding:24px;">
        <div style="font-size:20px;margin-bottom:6px;">🎮 Aucune compétition pour l'instant</div>
        <div style="font-size:13px;color:#64748b;">Reviens bientôt — ou crée la première compétition.</div>
      </div>`;

      if (isAdmin) {
        // formulaire creation rapide
        const defaults = estimatePrizes(4, 20);
        html += `<div class="trn-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="font-weight:800;">Créer un tournoi</div>
            <div class="trn-small">Visible seulement par les administrateurs</div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;">
            <div class="trn-form-row">
              <label class="trn-small" style="min-width:120px;">Format</label>
              <select id="trn-form-maxplayers" class="trn-input">
                <option value="4">4 joueurs</option>
                <option value="8">8 joueurs</option>
                <option value="32">32 joueurs</option>
                <option value="64">64 joueurs</option>
              </select>
            </div>

            <div class="trn-form-row">
              <label class="trn-small" style="min-width:120px;">Frais (TIKS)</label>
              <input id="trn-form-fee" class="trn-input" type="number" min="1" step="1" value="20" />
            </div>

            <div class="trn-form-row">
              <label class="trn-small" style="min-width:120px;">Prizes estimés</label>
              <div id="trn-form-prizes" class="trn-small">1er: ${fmt(defaults.prize_first)} · 2ème: ${fmt(defaults.prize_second)} · 3ème: ${fmt(defaults.prize_third)}</div>
            </div>

            <div style="display:flex;gap:8px;margin-top:8px;">
              <button id="trn-create-submit" class="trn-btn-primary">Créer le tournoi</button>
              <button id="trn-create-calc" class="trn-btn-secondary">Mettre à jour estimation</button>
            </div>

            <div id="trn-create-msg" style="margin-top:8px;"></div>
          </div>
        </div>`;
      }

      render(html);

      // listeners formulaire admin
      if (isAdmin) {
        const maxSel = root.querySelector('#trn-form-maxplayers');
        const feeIn = root.querySelector('#trn-form-fee');
        const prizesEl = root.querySelector('#trn-form-prizes');
        const msgEl = root.querySelector('#trn-create-msg');

        function updateEst() {
          const mp = Number(maxSel.value) || 4;
          const fee = Number(feeIn.value) || 20;
          const est = estimatePrizes(mp, fee);
          prizesEl.textContent = `1er: ${fmt(est.prize_first)} · 2ème: ${fmt(est.prize_second)} · 3ème: ${fmt(est.prize_third)} (Pool ${fmt(est.pool)})`;
        }

        root.querySelector('#trn-create-calc')?.addEventListener('click', (e) => { e.preventDefault(); updateEst(); });
        root.querySelector('#trn-create-submit')?.addEventListener('click', async (e) => {
          e.preventDefault();
          msgEl.innerHTML = spinner('Création en cours…');
          const mp = Number(maxSel.value) || 4;
          const fee = Number(feeIn.value) || 20;
          const est = estimatePrizes(mp, fee);
          const payload = {
            max_players: mp,
            status: 'active',
            entry_fee: fee,
            prize_first: est.prize_first,
            prize_second: est.prize_second,
            prize_third: est.prize_third,
            started_at: new Date().toISOString()
          };
          try {
            const { data, error } = await supabase.from('tournaments').insert(payload).select('id').single();
            if (error) throw error;
            msgEl.innerHTML = okBox('Tournoi créé avec succès.');
            // re-render overview (montrer le nouveau tournoi)
            setTimeout(showOverview, 900);
          } catch (err) {
            dbg('createTournament failed', err);
            msgEl.innerHTML = errBox(err?.message ?? String(err));
          }
        });
      }

      return;
    }

    // Sinon, il y a des tournois → affichage normal
    // Compter inscriptions pour chaque tournoi (simple)
    const counts = {};
    for (const t of tournaments) {
      try {
        const { count, error } = await supabase.from('tournament_registrations')
          .select('id', { count: 'exact', head: true })
          .eq('tournament_id', t.id);
        counts[t.id] = count ?? 0;
      } catch (e) { counts[t.id] = 0; }
    }

    // solde utilisateur (pour boutons join)
    const balance = await getUserBalance(uid);

    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div><h3 style="margin:0 0 4px 0;font-size:16px;font-weight:800;">🏆 Compétitions disponibles</h3>
      <div class="trn-small">Format KO · Frais par défaut 20 TIKS</div></div>
      ${isAdmin ? `<div><button class="trn-btn-primary" id="trn-create-btn-top">➕ Créer un tournoi</button></div>` : ''}
    </div>`;

    for (const t of tournaments) {
      const n = counts[t.id] ?? 0;
      const pct = Math.round(n / (t.max_players || 4) * 100);
      html += `<div class="trn-card" data-tid="${t.id}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div>
            <div style="font-weight:800;">Tournoi · ${t.max_players} joueurs</div>
            <div class="trn-small">Démarré: ${new Date(t.started_at).toLocaleString()}</div>
          </div>
          <div style="text-align:right;">
            <div class="trn-small">Frais ${fmt(t.entry_fee)} TIKS</div>
            <div class="trn-small">🥇 ${fmt(t.prize_first)} · 🥈 ${fmt(t.prize_second)}</div>
          </div>
        </div>

        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:6px;">
            <span>${n} / ${t.max_players} joueurs</span><span>${pct}%</span>
          </div>
          <div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#0ea5e9);border-radius:4px;"></div>
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;">
          <button class="trn-btn-secondary trn-view-btn" data-tid="${t.id}">Voir bracket</button>
        </div>
      </div>`;
    }

    if (uid) {
      html += `<div style="margin-top:6px;text-align:right;" class="trn-small">Votre solde : <strong>${fmt(balance)} TIKS</strong></div>`;
    }

    render(html);

    // listeners
    root.querySelectorAll('.trn-view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tid = btn.dataset.tid;
        showBracket(tid, true);
      });
    });
    root.querySelector('#trn-create-btn-top')?.addEventListener('click', () => {
      // scroll to top and open overview creation (simple: re-run showOverview to show admin form)
      showOverview();
      // Ideally focus the form if present
      setTimeout(()=> root.querySelector('#trn-form-maxplayers')?.focus(), 300);
    });

    dbg('showOverview rendered, tournaments_count=' + tournaments.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     ACTION — REJOINDRE (ou créer+rejoindre)
     (on laisse la logique d'origine, inchangée)
  ══════════════════════════════════════════════════════════════════ */

  async function joinTournament(tid, fee) {
    dbg('joinTournament start', { tid, fee });
    render(spinner('Inscription en cours…'));
    try {
      const rpcArgs = typeof tid !== 'undefined' && tid !== null ? { p_tournament_id: tid } : {};
      dbg('calling rpc_register_tournament with', rpcArgs);
      const { data, error } = await supabase.rpc('rpc_register_tournament', rpcArgs);
      if (error) {
        dbg('rpc_register_tournament error', error);
        const msg = error.message ?? String(error);
        if (msg.toLowerCase().includes('insuffisant') || msg.toLowerCase().includes('insufficient')) {
          render(`${errBox(msg)}
            <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour</button>`);
          root.querySelector('#trn-back-btn')?.addEventListener('click', showOverview);
        } else if (msg.includes('déjà inscrit') || msg.includes('already registered')) {
          await showCheckin(tid);
        } else {
          render(`${errBox(msg)}
            <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour</button>`);
          root.querySelector('#trn-back-btn')?.addEventListener('click', showOverview);
        }
        return;
      }

      dbg('rpc_register_tournament result', data);
      const tournamentId = (data && data.tournament_id) ? data.tournament_id : tid;
      if (data?.status === 'started' || data?.status === 'active') {
        await showBracket(tournamentId, true);
      } else {
        await showCheckin(tournamentId);
      }
    } catch (e) {
      dbg('joinTournament exception', e);
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
     (copié inchangé depuis votre version)
  ══════════════════════════════════════════════════════════════════ */

  let _checkinChannel = null;
  let _checkinPoll    = null;

  function stopCheckin() {
    if (_checkinChannel) { try { _checkinChannel.unsubscribe(); } catch (_) {} _checkinChannel = null; }
    if (_checkinPoll)    { clearInterval(_checkinPoll); _checkinPoll = null; }
  }

  async function showCheckin(tid) {
    dbg('showCheckin start', tid);
    stopCheckin();
    render(spinner('Chargement de la salle d\'attente…'));

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    const { data: t } = await supabase
      .from('tournaments').select('id,status,entry_fee,prize_first,prize_second,prize_third').eq('id', tid).maybeSingle();

    if (!t) { render(errBox('Tournoi introuvable.')); dbg('showCheckin: tournoi introuvable', tid); return; }

    // Déjà actif → aller direct au bracket
    if (t.status === 'active') { await showBracket(tid, true); return; }

    await renderCheckinView(t, uid);

    /* Realtime */
    try {
      _checkinChannel = supabase.channel(`trn-checkin:${tid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_registrations', filter: `tournament_id=eq.${tid}` },
          async () => { dbg('realtime: tournament_registrations change'); await renderCheckinView(t, uid); })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${tid}` },
          async (payload) => {
            dbg('realtime: tournaments update', payload);
            if (payload?.new?.status === 'active') { stopCheckin(); await showBracket(tid, true); }
          })
        .subscribe(s => { dbg('checkin channel subscribed status', s); if (s !== 'SUBSCRIBED') startCheckinPoll(tid, uid); });
    } catch (e) {
      dbg('showCheckin: subscribe failed', e);
      startCheckinPoll(tid, uid);
    }
  }

  async function renderCheckinView(t, uid) {
    dbg('renderCheckinView', t?.id);
    const { data: regs } = await supabase
      .from('tournament_registrations').select('user_id,slot').eq('tournament_id', t.id).order('slot');
    const registrations = regs ?? [];
    const n = registrations.length;

    const profiles = await getProfiles(registrations.map(r => r.user_id));
    registrations.forEach(r => { r.pseudo = profiles.find(p => p.id === r.user_id)?.pseudo ?? null; });

    const myReg = registrations.find(r => r.user_id === uid);
    const pct   = Math.round(n / (t.max_players || 4) * 100);

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
            <span class="trn-badge" style="background:#e0f2fe;color:#0369a1;margin-left:8px;">${n}/${t.max_players}</span>
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
            <span>${n} / ${t.max_players} joueurs inscrits</span><span>${pct}%</span>
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
            Le tournoi démarrera automatiquement dès que ${t.max_players} joueurs seront prêts.
          </div>
        </div>
      </div>`;

    render(html);
    root.querySelector('#trn-back-btn')?.addEventListener('click', () => { stopCheckin(); showOverview(); });
  }

  function startCheckinPoll(tid, uid) {
    if (_checkinPoll) return;
    dbg('startCheckinPoll', tid);
    _checkinPoll = setInterval(async () => {
      try {
        const { data: t } = await supabase
          .from('tournaments').select('status').eq('id', tid).maybeSingle();
        if (t?.status === 'active')      { stopCheckin(); await showBracket(tid, true); }
        else if (t?.status === 'waiting') { const sess = await getSession(); await renderCheckinView({ id: tid, ...t }, sess?.user?.id ?? null); }
      } catch (e) { dbg('startCheckinPoll exception', e); }
    }, 3000);
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 3 — BRACKET / COMPÉTITION
     (implementation adaptée mais fidèle à l'original)
  ══════════════════════════════════════════════════════════════════ */

  let _bracketChannel = null;
  let _bracketPoll    = null;

  function stopBracket() {
    if (_bracketChannel) { try { _bracketChannel.unsubscribe(); } catch (_) {} _bracketChannel = null; }
    if (_bracketPoll)    { clearInterval(_bracketPoll); _bracketPoll = null; }
  }

  async function showBracket(tid, subscribe = false) {
    dbg('showBracket start', tid, 'subscribe=' + subscribe);
    stopBracket();
    render(spinner('Chargement du bracket…'));

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    await renderBracketView(tid, uid);

    if (subscribe) {
      try {
        _bracketChannel = supabase.channel(`trn-bracket:${tid}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_matches', filter: `tournament_id=eq.${tid}` },
            async () => { dbg('realtime: tournament_matches change'); await renderBracketView(tid, uid); })
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${tid}` },
            async () => { dbg('realtime: tournaments update while bracket subscribed'); await renderBracketView(tid, uid); })
          .subscribe(s => { dbg('bracket channel subscribe status', s); if (s !== 'SUBSCRIBED') { _bracketPoll = setInterval(() => renderBracketView(tid, uid), 5000); } });
      } catch (e) {
        dbg('showBracket subscribe failed', e);
        _bracketPoll = setInterval(() => renderBracketView(tid, uid), 5000);
      }
    }
  }

  async function renderBracketView(tid, uid) {
    dbg('renderBracketView', tid);
    const { data: t } = await supabase
      .from('tournaments').select('*').eq('id', tid).maybeSingle();
    const { data: matches } = await supabase
      .from('tournament_matches').select('*').eq('tournament_id', tid).order('round_number').order('match_index');
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
            <div style="font-size:11px;color:#94a3b8;">Tour ${m.round_number} · Match ${m.match_index}</div>
          </div>
          <div>${actionBtn}</div>
        </button>`;
    }

    const semis  = allMatches.filter(m => m.round_number === 1);
    const finale = allMatches.find(m => m.round_number === Math.max(...allMatches.map(x=>x.round_number), 1));

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
            Demi-finales / Premiers matches
          </div>
          ${semis.map(m => matchBlock(m)).join('') || '<div style="color:#94a3b8;font-size:13px;">En attente des matchs…</div>'}
        </div>

        <div class="trn-card" style="margin-top:12px;">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
            Reste du tableau
          </div>
          ${matchBlock(finale)}
        </div>

        <!-- Participants -->
        <div class="trn-card" style="margin-top:12px;">
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

    dbg('renderBracketView rendered', { tid, matches: allMatches.length, regs: allRegs.length });
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 4 — LANCEMENT : création match+game → redirect game.html
     (repris de l'original)
  ══════════════════════════════════════════════════════════════════ */

  async function launchGame(tournamentMatchId, uid, tid) {
    dbg('launchGame start', { tournamentMatchId, uid, tid });
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
          dbg('player1 creating match record');
          const { data: mRow, error: mErr } = await supabase.from('matches')
            .insert({ owner_id: tmatch.player1_id, opponent_id: tmatch.player2_id, status: 'ongoing',
                      metadata: { tournament_id: tmatch.tournament_id, tournament_match_id: tmatch.id } })
            .select('id').single();
          if (mErr || !mRow) {
            dbg('create match error', mErr);
            throw new Error('Erreur création match : ' + (mErr?.message ?? 'inconnu'));
          }
          matchId = mRow.id;

          dbg('match created', matchId);

          const { data: gRow, error: gErr } = await supabase.from('games')
            .insert({ owner_id: tmatch.player1_id, opponent_id: tmatch.player2_id,
                      status: 'playing', match_id: matchId })
            .select('id').single();
          if (gErr || !gRow) {
            dbg('create game error', gErr);
            throw new Error('Erreur création game : ' + (gErr?.message ?? 'inconnu'));
          }
          gameId = gRow.id;

          dbg('game created', gameId);

          await supabase.from('tournament_matches').update({ match_id: matchId }).eq('id', tmatch.id);
          dbg('tournament_matches updated with match_id', matchId);

        } else {
          /* Player 2 attend que player1 crée le match */
          dbg('player2 waiting for match to be created by player1');
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
          dbg('player2 found match/game', { matchId, gameId });
        }
      } else {
        const { data: g } = await supabase.from('games').select('id').eq('match_id', matchId).maybeSingle();
        gameId = g?.id ?? null;
      }

      if (!gameId) throw new Error('gameId introuvable — le match n\'a peut-être pas encore été initialisé.');

      dbg('launchGame redirecting', { gameId, matchId });
      /* Redirection — même format que create_game.js */
      window.location.href = `game.html?gameId=${gameId}&matchId=${matchId}`;

    } catch (e) {
      console.error('[tournament] launchGame error', e);
      dbg('launchGame error', e);
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
    dbg('init start');
    if (!supabase) { render(errBox('Connexion non disponible.')); return; }

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    if (uid) {
      // L'utilisateur est-il inscrit à un tournoi actif ou en attente ?
      try {
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
      } catch (e) {
        dbg('init: check myRegs failed, trying active only', e);
        try {
          const { data: myRegs2 } = await supabase
            .from('tournament_registrations')
            .select('tournament_id, tournaments!inner(status)')
            .eq('user_id', uid)
            .in('tournaments.status', ['active'])
            .limit(1)
            .maybeSingle();
          if (myRegs2) {
            const t2 = myRegs2.tournaments;
            const tid2 = myRegs2.tournament_id;
            if (t2?.status === 'active') { await showBracket(tid2, true); return; }
          }
        } catch (e2) { dbg('init fallback failed', e2); }
      }
    }

    await showOverview();
  }

  // Cleanup si on quitte la page
  window.addEventListener('pagehide', () => { stopCheckin(); stopBracket(); });

  // Exposer pour utilisation externe (ex : bouton depuis homePanel)
  // On expose une API simple avec render() pour index.html
  window.taktikTournament = window.taktikTournament || {};
  window.taktikTournament.render = async () => { await showOverview(); };
  window.taktikTournament.showOverview = showOverview;
  window.taktikTournament.showCheckin = showCheckin;
  window.taktikTournament.showBracket = showBracket;

  // Lancement initial (mais si index.html veut contrôler, il peut appeler window.taktikTournament.render())
  await init();
}

/* ─────────────────────────────────────────────────────────────────────
   Export utilitaire pour la home preview (appelé depuis index.html)
   Usage: import { renderHomePreview } from './tournament.js';
   ou await import('./tournament.js') et utiliser renderHomePreview(previewEl, supabase)
   ──────────────────────────────────────────────────────────────────── */
export async function renderHomePreview(previewEl, supabaseClient) {
  const sup = supabaseClient ?? window.supabase;
  if (!previewEl) return;
  previewEl.textContent = 'Chargement...';
  try {
    if (!sup) { previewEl.textContent = ''; return; }
    const { data } = await sup.from('tournaments').select('id,max_players,status,entry_fee,prize_first').in('status', ['active']).order('created_at', { ascending: true }).limit(3);
    const t = data ?? [];
    if (!t.length) {
      previewEl.textContent = 'Aucune compétition pour l\'instant';
      return;
    }
    previewEl.innerHTML = t.map(x => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;">
      <div style="font-weight:600;">Tournoi · ${x.max_players} joueurs</div>
      <div style="color:#64748b;">Frais ${Number(x.entry_fee).toLocaleString('fr-FR')}</div>
    </div>`).join('');
  } catch (e) {
    console.warn('renderHomePreview failed', e);
    previewEl.textContent = '';
  }
}