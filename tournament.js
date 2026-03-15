/**
 * tournament.js — Module compétitions Taktik (version templates)
 *
 * Architecture :
 *  - Les compétitions sont définies par des TEMPLATES (tournament_templates).
 *  - L'admin crée/édite/active les templates. Il configure les 4 % de prize dont
 *    son propre % (prize_pct_admin) qui reste PRIVÉ côté user.
 *  - L'utilisateur voit les templates actifs, avec les 3 prix mis en valeur,
 *    et rejoint via rpc_register_for_tournament(p_template_id).
 *  - Quand assez de joueurs sont en file → une instance (tournaments) est créée.
 *  - Désactiver un template n'éjecte PAS les joueurs déjà en file.
 */

export default async function initTournament(supabaseClient, containerEl) {
  const supabase = supabaseClient ?? window.supabase;
  const root = containerEl ?? document.getElementById('tournamentContent') ?? document.getElementById('placeholderText');

  if (!root) { console.error('tournament.js: containerEl introuvable'); return; }

  /* ── Helpers log ── */
  const DBG = false; // passe à true pour voir des alert() verbeux sur mobile
  const dbg = (...a) => {
    try { console.debug('[tournament]', ...a); } catch (_) {}
    if (DBG) {
      try {
        const msg = a.map(x => {
          if (typeof x === 'string') return x;
          try { return JSON.stringify(x, null, 2); } catch (_) { return String(x); }
        }).join(' ');
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
      .trn-btn-danger{padding:8px 16px;border:none;border-radius:8px;
        background:#fee2e2;color:#dc2626;font-weight:700;font-size:13px;cursor:pointer;transition:opacity .15s}
      .trn-btn-danger:hover{opacity:.8}
      .trn-btn-success{padding:8px 16px;border:none;border-radius:8px;
        background:#dcfce7;color:#15803d;font-weight:700;font-size:13px;cursor:pointer;transition:opacity .15s}
      .trn-btn-success:hover{opacity:.8}
      .trn-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px 20px;margin-bottom:14px}
      .trn-card-prize{background:linear-gradient(135deg,#fefce8,#fffbeb);border:1px solid #fde68a;
        border-radius:12px;padding:16px 20px;margin-bottom:14px}
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
      .trn-badge-active{background:#dcfce7;color:#16a34a}
      .trn-badge-inactive{background:#f1f5f9;color:#94a3b8}
      .trn-form-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
      .trn-input{padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:13px}
      .trn-input:focus{outline:none;border-color:#6366f1}
      .trn-small{font-size:12px;color:#64748b}
      .trn-prize-box{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}
      .trn-prize-item{flex:1;min-width:80px;text-align:center;padding:10px 8px;
        border-radius:10px;border:1px solid #e2e8f0}
      .trn-prize-item.gold{background:linear-gradient(135deg,#fef9c3,#fef08a);border-color:#fde047}
      .trn-prize-item.silver{background:linear-gradient(135deg,#f1f5f9,#e2e8f0);border-color:#cbd5e1}
      .trn-prize-item.bronze{background:linear-gradient(135deg,#fff7ed,#fed7aa);border-color:#fdba74}
      .trn-prize-item .icon{font-size:22px;display:block;margin-bottom:3px}
      .trn-prize-item .amount{font-size:16px;font-weight:800;color:#1e293b}
      .trn-prize-item .label{font-size:11px;color:#64748b;margin-top:2px}
      .trn-pct-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
      .trn-pct-sum{font-size:13px;font-weight:700;margin-top:8px;padding:8px 12px;border-radius:8px;}
      .trn-pct-sum.ok{background:#dcfce7;color:#15803d}
      .trn-pct-sum.err{background:#fee2e2;color:#dc2626}
      .trn-divider{border:none;border-top:1px solid #f1f5f9;margin:14px 0}
      .trn-template-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
      .trn-join-area{margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
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

  async function getMyProfile(uid) {
    if (!uid) return null;
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id,pseudo,role,is_admin,can_create_tournament')
        .eq('id', uid)
        .maybeSingle();
      if (error) { dbg('getMyProfile error', error); return null; }
      return data ?? null;
    } catch (e) { dbg('getMyProfile exception', e); return null; }
  }

  function isAdminProfile(profile) {
    if (!profile) return false;
    return ['administrator', 'admin', 'super_admin', 'superuser'].includes((profile.role ?? '').toLowerCase())
      || profile.is_admin === true
      || profile.can_create_tournament === true;
  }

  /**
   * Calcule les montants de prizes depuis un template.
   * prize_pct_admin est exclu du calcul (part privée).
   * Les 3 % joueurs sont appliqués sur le pool TOTAL (ce qui reste = pool - admin_share).
   */
  function computePrizesFromTemplate(tmpl) {
  const pool = (tmpl.max_players ?? 4) * (Number(tmpl.entry_fee) || 0);
  const first      = Math.floor((pool * (Number(tmpl.prize_pct_first)  || 0) / 100) / 10) * 10;
  const second     = Math.floor((pool * (Number(tmpl.prize_pct_second) || 0) / 100) / 10) * 10;
  const third      = Math.floor((pool * (Number(tmpl.prize_pct_third)  || 0) / 100) / 10) * 10;
  const adminShare = Math.floor((pool * (Number(tmpl.prize_pct_admin)  || 0) / 100) / 10) * 10;
  return { pool, adminShare, prize_first: first, prize_second: second, prize_third: third };
}

  /** Balance côté client : total collecté - prizes distribués */
  async function getTournamentBalance(tournamentId, entry_fee = 0) {
    try {
      const { count, error: cErr } = await supabase
        .from('tournament_registrations')
        .select('id', { head: true, count: 'exact' })
        .eq('tournament_id', tournamentId);
      if (cErr) dbg('getTournamentBalance: count error', cErr);
      const regCount = count ?? 0;

      const { data: prizes, error: pErr } = await supabase
        .from('tournament_prizes')
        .select('amount')
        .eq('tournament_id', tournamentId);
      if (pErr) dbg('getTournamentBalance: prizes error', pErr);

      const totalCollected = (Number(entry_fee) || 0) * (regCount || 0);
      const totalPrizes = (prizes ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);
      return { totalCollected, totalPrizes, balance: totalCollected - totalPrizes };
    } catch (e) {
      dbg('getTournamentBalance exception', e);
      return { totalCollected: 0, totalPrizes: 0, balance: 0 };
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE OVERVIEW — ADMIN : gestion des templates
  ══════════════════════════════════════════════════════════════════ */

  async function showAdminOverview(uid) {
    dbg('showAdminOverview start');
    render(spinner('Chargement des templates…'));

    // Récupérer tous les templates (actifs et inactifs)
    let templates = [];
    try {
      const { data, error } = await supabase
        .from('tournament_templates')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      templates = data ?? [];
    } catch (e) {
      dbg('loadTemplates error', e);
      render(errBox('Erreur chargement templates : ' + (e?.message ?? String(e))));
      return;
    }

    // Compter les joueurs en file par template
    const queueCounts = {};
    for (const tmpl of templates) {
      try {
        const { count } = await supabase
          .from('tournament_queue')
          .select('id', { head: true, count: 'exact' })
          .eq('template_id', tmpl.id)
          .eq('status', 'waiting');
        queueCounts[tmpl.id] = count ?? 0;
      } catch (_) { queueCounts[tmpl.id] = 0; }
    }

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <div>
          <h3 style="margin:0 0 2px 0;font-size:16px;font-weight:800;">⚙️ Gestion des templates</h3>
          <div class="trn-small">Panel administrateur — non visible des joueurs</div>
        </div>
        <button class="trn-btn-primary" id="trn-admin-create-btn">➕ Nouveau template</button>
      </div>

      <!-- Formulaire de création (masqué par défaut) -->
      <div id="trn-create-form-wrap" style="display:none;">
        ${buildTemplateForm()}
      </div>

      <hr class="trn-divider">
    `;

    if (!templates.length) {
      html += `<div class="trn-card" style="text-align:center;color:#94a3b8;padding:24px;">
        Aucun template. Crée le premier ci-dessus.
      </div>`;
    }

    for (const tmpl of templates) {
      const prizes = computePrizesFromTemplate(tmpl);
      const qCount = queueCounts[tmpl.id] ?? 0;
      const needsPlayers = tmpl.max_players;
      const isActive = tmpl.is_active;
      const statusBadge = isActive
        ? `<span class="trn-badge trn-badge-active">✅ Actif</span>`
        : `<span class="trn-badge trn-badge-inactive">⏸ Inactif</span>`;

      html += `
        <div class="trn-card" data-tmpl-id="${tmpl.id}" style="border-left:4px solid ${isActive ? '#22c55e' : '#e2e8f0'};">
          <div class="trn-template-header">
            <div>
              <div style="font-weight:800;font-size:15px;">${escHtml(tmpl.name || 'Sans nom')} ${statusBadge}</div>
              <div class="trn-small" style="margin-top:3px;">
                ${tmpl.max_players} joueurs · Frais : <strong>${fmt(tmpl.entry_fee)} TIKS</strong>
                · Auto-restart : <strong>${tmpl.auto_restart ? 'Oui' : 'Non'}</strong>
              </div>
              <div class="trn-small" style="margin-top:2px;">
                File d'attente : <strong>${qCount} / ${needsPlayers}</strong> joueurs en attente
                ${qCount > 0 && !isActive ? ' <span style="color:#f59e0b;">(file maintenue même si inactif)</span>' : ''}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              <button class="trn-btn-secondary trn-edit-tmpl-btn" data-tmpl-id="${tmpl.id}" style="font-size:12px;padding:6px 12px;">✏️ Éditer</button>
              ${isActive
                ? `<button class="trn-btn-danger trn-toggle-tmpl-btn" data-tmpl-id="${tmpl.id}" data-active="true" style="font-size:12px;padding:6px 12px;">⏸ Désactiver</button>`
                : `<button class="trn-btn-success trn-toggle-tmpl-btn" data-tmpl-id="${tmpl.id}" data-active="false" style="font-size:12px;padding:6px 12px;">▶ Activer</button>`
              }
            </div>
          </div>

          <!-- Prizes (y compris part admin) -->
          <div style="margin-top:12px;">
            <div class="trn-small" style="margin-bottom:6px;">Distribution du pool de <strong>${fmt(prizes.pool)} TIKS</strong> :</div>
            <div class="trn-prize-box">
              <div class="trn-prize-item gold">
                <span class="icon">🥇</span>
                <div class="amount">${fmt(prizes.prize_first)}</div>
                <div class="label">${fmt(tmpl.prize_pct_first)}% · 1ère place</div>
              </div>
              <div class="trn-prize-item silver">
                <span class="icon">🥈</span>
                <div class="amount">${fmt(prizes.prize_second)}</div>
                <div class="label">${fmt(tmpl.prize_pct_second)}% · 2ème place</div>
              </div>
              <div class="trn-prize-item bronze">
                <span class="icon">🥉</span>
                <div class="amount">${fmt(prizes.prize_third)}</div>
                <div class="label">${fmt(tmpl.prize_pct_third)}% · 3ème place</div>
              </div>
              <div class="trn-prize-item" style="background:#f8f0ff;border-color:#d8b4fe;">
                <span class="icon">🏦</span>
                <div class="amount">${fmt(prizes.adminShare)}</div>
                <div class="label" style="color:#7c3aed;">${fmt(tmpl.prize_pct_admin)}% · Admin (privé)</div>
              </div>
            </div>
          </div>

          <!-- Formulaire d'édition (masqué) -->
          <div id="trn-edit-form-${tmpl.id}" style="display:none;margin-top:16px;border-top:1px solid #f1f5f9;padding-top:16px;">
            ${buildTemplateForm(tmpl)}
          </div>
          <div id="trn-edit-msg-${tmpl.id}" style="margin-top:8px;"></div>
        </div>
      `;
    }

    render(html);

    // Listener bouton "Nouveau template"
    root.querySelector('#trn-admin-create-btn')?.addEventListener('click', () => {
      const wrap = root.querySelector('#trn-create-form-wrap');
      if (!wrap) return;
      wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
      if (wrap.style.display === 'block') {
        attachTemplateFormListeners(wrap, null, uid, () => { setTimeout(showAdminOverview.bind(null, uid), 600); });
      }
    });

    // Listeners toggle actif/inactif
    root.querySelectorAll('.trn-toggle-tmpl-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tmplId   = btn.dataset.tmplId;
        const wasActive = btn.dataset.active === 'true';
        const newActive = !wasActive;
        btn.disabled = true;
        btn.textContent = 'Mise à jour…';
        try {
          const { error } = await supabase
            .from('tournament_templates')
            .update({ is_active: newActive })
            .eq('id', tmplId);
          if (error) throw error;
          await showAdminOverview(uid);
        } catch (e) {
          alert('Erreur : ' + (e?.message ?? String(e)));
          btn.disabled = false;
          btn.textContent = wasActive ? '⏸ Désactiver' : '▶ Activer';
        }
      });
    });

    // Listeners édition
    root.querySelectorAll('.trn-edit-tmpl-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tmplId = btn.dataset.tmplId;
        const formEl = root.querySelector(`#trn-edit-form-${tmplId}`);
        if (!formEl) return;
        const isHidden = formEl.style.display === 'none';
        formEl.style.display = isHidden ? 'block' : 'none';
        if (isHidden) {
          const tmpl = templates.find(t => t.id === tmplId);
          attachTemplateFormListeners(formEl, tmplId, uid, () => {
            root.querySelector(`#trn-edit-msg-${tmplId}`).innerHTML = okBox('Sauvegardé !');
            setTimeout(showAdminOverview.bind(null, uid), 800);
          });
        }
      });
    });
  }

  /** Construit le HTML du formulaire template (création ou édition) */
  function buildTemplateForm(tmpl = null) {
    const isEdit = !!tmpl;
    const v = {
      name:            tmpl?.name            ?? '',
      max_players:     tmpl?.max_players     ?? 4,
      entry_fee:       tmpl?.entry_fee       ?? 20,
      pct_first:       tmpl?.prize_pct_first  ?? 50,
      pct_second:      tmpl?.prize_pct_second ?? 30,
      pct_third:       tmpl?.prize_pct_third  ?? 10,
      pct_admin:       tmpl?.prize_pct_admin  ?? 10,
      auto_restart:    tmpl?.auto_restart     ?? false,
      is_active:       tmpl?.is_active        ?? false,
    };
    const sumOk = (Number(v.pct_first) + Number(v.pct_second) + Number(v.pct_third) + Number(v.pct_admin)) === 100;
    return `
      <div style="display:flex;flex-direction:column;gap:10px;" class="trn-tmpl-form">
        <div class="trn-form-row">
          <label class="trn-small" style="min-width:130px;">Nom de la compétition</label>
          <input class="trn-input tf-name" style="flex:1;" type="text" value="${escHtml(v.name)}" placeholder="Ex: Championnat Hebdo" />
        </div>
        <div class="trn-form-row">
          <label class="trn-small" style="min-width:130px;">Format</label>
          <select class="trn-input tf-maxplayers">
            ${[4, 8, 32, 64].map(n => `<option value="${n}" ${n === v.max_players ? 'selected' : ''}>${n} joueurs</option>`).join('')}
          </select>
        </div>
        <div class="trn-form-row">
          <label class="trn-small" style="min-width:130px;">Frais d'entrée (TIKS)</label>
          <input class="trn-input tf-fee" type="number" min="0" step="1" value="${v.entry_fee}" style="width:100px;" />
          <span class="trn-small" style="color:#0ea5e9;">0 = gratuit</span>
        </div>

        <div style="margin-top:4px;">
          <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">
            Répartition du prize pool <span class="trn-small">(la somme des 4 doit faire 100%)</span>
          </div>
          <div class="trn-pct-row">
            <div>
              <label class="trn-small">🥇 1ère place (%)</label>
              <input class="trn-input tf-pct-first" type="number" min="0" max="100" step="0.01" value="${v.pct_first}" style="width:100%;margin-top:3px;" />
            </div>
            <div>
              <label class="trn-small">🥈 2ème place (%)</label>
              <input class="trn-input tf-pct-second" type="number" min="0" max="100" step="0.01" value="${v.pct_second}" style="width:100%;margin-top:3px;" />
            </div>
            <div>
              <label class="trn-small">🥉 3ème place (%)</label>
              <input class="trn-input tf-pct-third" type="number" min="0" max="100" step="0.01" value="${v.pct_third}" style="width:100%;margin-top:3px;" />
            </div>
            <div>
              <label class="trn-small" style="color:#7c3aed;">🏦 Admin / plateforme (%) <em style="font-size:10px;">(privé)</em></label>
              <input class="trn-input tf-pct-admin" type="number" min="0" max="100" step="0.01" value="${v.pct_admin}" style="width:100%;margin-top:3px;border-color:#d8b4fe;" />
            </div>
          </div>
          <div class="trn-pct-sum tf-pct-sum ${sumOk ? 'ok' : 'err'}" style="margin-top:8px;">
            Total : <strong class="tf-pct-total">${fmt(Number(v.pct_first) + Number(v.pct_second) + Number(v.pct_third) + Number(v.pct_admin), 2)}</strong> / 100%
          </div>
          <div class="trn-small tf-preview" style="margin-top:6px;color:#0ea5e9;"></div>
        </div>

        <div class="trn-form-row">
          <label class="trn-small" style="min-width:130px;">Auto-restart</label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" class="tf-auto-restart" ${v.auto_restart ? 'checked' : ''} />
            <span class="trn-small">Relancer automatiquement dès que la file est pleine</span>
          </label>
        </div>
        <div class="trn-form-row">
          <label class="trn-small" style="min-width:130px;">Actif au départ</label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" class="tf-is-active" ${v.is_active ? 'checked' : ''} />
            <span class="trn-small">Les joueurs peuvent rejoindre la file</span>
          </label>
        </div>

        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="trn-btn-primary tf-save-btn">${isEdit ? '💾 Sauvegarder' : '✅ Créer le template'}</button>
          <button class="trn-btn-secondary tf-cancel-btn">Annuler</button>
        </div>
        <div class="tf-form-msg" style="margin-top:6px;"></div>
      </div>`;
  }

  /** Attache les listeners au formulaire template (création ou édition) */
  function attachTemplateFormListeners(formEl, tmplId, uid, onSuccess) {
    const get = cls => formEl.querySelector('.' + cls);

    function recalcSum() {
      const sum = ['tf-pct-first', 'tf-pct-second', 'tf-pct-third', 'tf-pct-admin']
        .reduce((s, c) => s + (Number(get(c)?.value) || 0), 0);
      const sumEl  = get('tf-pct-sum');
      const totEl  = get('tf-pct-total');
      const prevEl = get('tf-preview');
      if (totEl) totEl.textContent = fmt(sum, 2);
      if (sumEl) { sumEl.classList.toggle('ok', Math.abs(sum - 100) < 0.01); sumEl.classList.toggle('err', Math.abs(sum - 100) >= 0.01); }
      // Aperçu des montants
      if (prevEl) {
        const mp  = Number(get('tf-maxplayers')?.value) || 4;
        const fee = Number(get('tf-fee')?.value) || 0;
        const pool = mp * fee;
        const first  = Math.floor((pool * (Number(get('tf-pct-first')?.value) || 0) / 100) / 10) * 10;
        const second = Math.floor((pool * (Number(get('tf-pct-second')?.value) || 0) / 100) / 10) * 10;
        const third  = Math.floor((pool * (Number(get('tf-pct-third')?.value) || 0) / 100) / 10) * 10;
        prevEl.textContent = fee > 0
          ? `Aperçu (pool ${fmt(pool)} TIKS) → 🥇${fmt(first)} · 🥈${fmt(second)} · 🥉${fmt(third)}`
          : 'Frais = 0 → pas de prize pool';
      }
    }

    ['tf-pct-first', 'tf-pct-second', 'tf-pct-third', 'tf-pct-admin', 'tf-maxplayers', 'tf-fee'].forEach(cls => {
      get(cls)?.addEventListener('input', recalcSum);
    });
    recalcSum();

    get('tf-cancel-btn')?.addEventListener('click', () => { formEl.style.display = 'none'; });

    get('tf-save-btn')?.addEventListener('click', async () => {
      const msgEl = get('tf-form-msg');
      const name        = get('tf-name')?.value?.trim();
      const max_players = Number(get('tf-maxplayers')?.value) || 4;
      const entry_fee   = Number(get('tf-fee')?.value) || 0;
      const pct_first   = Number(get('tf-pct-first')?.value) || 0;
      const pct_second  = Number(get('tf-pct-second')?.value) || 0;
      const pct_third   = Number(get('tf-pct-third')?.value) || 0;
      const pct_admin   = Number(get('tf-pct-admin')?.value) || 0;
      const auto_restart = get('tf-auto-restart')?.checked ?? false;
      const is_active    = get('tf-is-active')?.checked ?? false;

      if (!name) { if (msgEl) msgEl.innerHTML = errBox('Le nom est requis.'); return; }
      const sum = pct_first + pct_second + pct_third + pct_admin;
      if (Math.abs(sum - 100) >= 0.01) {
        if (msgEl) msgEl.innerHTML = errBox(`La somme des pourcentages doit être 100% (actuellement ${fmt(sum, 2)}%).`);
        return;
      }

      if (msgEl) msgEl.innerHTML = spinner('Enregistrement…');
      const saveBtn = get('tf-save-btn');
      if (saveBtn) saveBtn.disabled = true;

      const payload = {
        name,
        max_players,
        entry_fee,
        prize_pct_first:  pct_first,
        prize_pct_second: pct_second,
        prize_pct_third:  pct_third,
        prize_pct_admin:  pct_admin,
        auto_restart,
        is_active,
      };

      try {
        if (tmplId) {
          // Mise à jour
          const { error } = await supabase.from('tournament_templates').update(payload).eq('id', tmplId);
          if (error) throw error;
        } else {
          // Création
          payload.created_by = uid;
          const { error } = await supabase.from('tournament_templates').insert(payload);
          if (error) throw error;
        }
        if (msgEl) msgEl.innerHTML = okBox(tmplId ? 'Template mis à jour !' : 'Template créé !');
        setTimeout(() => { onSuccess?.(); }, 600);
      } catch (e) {
        dbg('saveTemplate error', e);
        if (msgEl) msgEl.innerHTML = errBox(e?.message ?? String(e));
        if (saveBtn) saveBtn.disabled = false;
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE OVERVIEW — USER : liste des templates actifs
  ══════════════════════════════════════════════════════════════════ */

  async function showUserOverview(uid) {
    dbg('showUserOverview start');

    // Récupérer les templates actifs
    let templates = [];
    try {
      const { data, error } = await supabase
        .from('tournament_templates')
        .select('id,name,max_players,entry_fee,prize_pct_first,prize_pct_second,prize_pct_third,auto_restart')
        .eq('is_active', true)
        .order('created_at', { ascending: true });
      if (error) throw error;
      templates = data ?? [];
    } catch (e) {
      dbg('showUserOverview templates error', e);
      templates = [];
    }

    // Compter joueurs en file par template
    const queueCounts = {};
    for (const tmpl of templates) {
      try {
        const { count } = await supabase
          .from('tournament_queue')
          .select('id', { head: true, count: 'exact' })
          .eq('template_id', tmpl.id)
          .eq('status', 'waiting');
        queueCounts[tmpl.id] = count ?? 0;
      } catch (_) { queueCounts[tmpl.id] = 0; }
    }

    // Vérifier si l'user est déjà en file pour un template
    let myQueueEntry = null;
    if (uid) {
      try {
        const { data } = await supabase
          .from('tournament_queue')
          .select('template_id,queued_at')
          .eq('user_id', uid)
          .eq('status', 'waiting')
          .maybeSingle();
        myQueueEntry = data ?? null;
      } catch (_) {}
    }

    const balance = uid ? await getUserBalance(uid) : 0;

    if (!templates.length) {
      render(`<div class="trn-card" style="text-align:center;padding:32px;">
        <div style="font-size:28px;margin-bottom:8px;">🎮</div>
        <div style="font-size:15px;font-weight:700;color:#1e293b;margin-bottom:4px;">Aucune compétition disponible</div>
        <div class="trn-small">Reviens bientôt — les prochaines compétitions seront annoncées ici.</div>
      </div>`);
      return;
    }

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <div>
          <h3 style="margin:0 0 2px 0;font-size:16px;font-weight:800;">🏆 Compétitions disponibles</h3>
          <div class="trn-small">Rejoins la file · Le tournoi démarre automatiquement</div>
        </div>
        ${uid ? `<div class="trn-small">Solde : <strong>${fmt(balance)} TIKS</strong></div>` : ''}
      </div>
    `;

    for (const tmpl of templates) {
      const prizes   = computePrizesFromTemplate(tmpl);
      const qCount   = queueCounts[tmpl.id] ?? 0;
      const pct      = Math.min(Math.round(qCount / tmpl.max_players * 100), 100);
      const inQueue  = myQueueEntry?.template_id === tmpl.id;
      const hasEntry = Number(tmpl.entry_fee) > 0;
      const canAfford = balance >= Number(tmpl.entry_fee);

      let joinBtn = '';
      if (!uid) {
        joinBtn = `<span class="trn-small" style="color:#94a3b8;">Connecte-toi pour participer</span>`;
      } else if (inQueue) {
        joinBtn = `
          <span class="trn-badge trn-badge-active" style="padding:6px 12px;font-size:12px;">✅ Vous êtes en file</span>
          <button class="trn-btn-danger trn-leave-btn" data-tmpl-id="${tmpl.id}" style="font-size:12px;padding:6px 14px;">Quitter la file</button>`;
      } else if (myQueueEntry) {
        joinBtn = `<span class="trn-small" style="color:#f59e0b;">Vous êtes déjà en file pour une autre compétition</span>`;
      } else if (hasEntry && !canAfford) {
        joinBtn = `<span class="trn-small" style="color:#dc2626;">Solde insuffisant (requis : ${fmt(tmpl.entry_fee)} TIKS)</span>`;
      } else {
        joinBtn = `<button class="trn-btn-primary trn-join-btn" data-tmpl-id="${tmpl.id}" data-fee="${tmpl.entry_fee}">
          ${hasEntry ? `Rejoindre · ${fmt(tmpl.entry_fee)} TIKS` : 'Rejoindre (gratuit)'}
        </button>`;
      }

      html += `
        <div class="trn-card" style="border-left:4px solid #6366f1;">
          <div class="trn-template-header">
            <div>
              <div style="font-weight:800;font-size:15px;">${escHtml(tmpl.name || 'Tournoi ' + tmpl.max_players + ' joueurs')}</div>
              <div class="trn-small" style="margin-top:3px;">
                Format KO · <strong>${tmpl.max_players} joueurs</strong>
                ${hasEntry ? ` · Frais d'entrée : <strong>${fmt(tmpl.entry_fee)} TIKS</strong>` : ' · <strong style="color:#16a34a;">Gratuit</strong>'}
              </div>
            </div>
            <div style="text-align:right;">
              <div class="trn-small">File : ${qCount} / ${tmpl.max_players}</div>
            </div>
          </div>

          <!-- Prizes mis en valeur -->
          <div class="trn-prize-box" style="margin-top:12px;">
            <div class="trn-prize-item gold">
              <span class="icon">🥇</span>
              <div class="amount">${fmt(prizes.prize_first)}</div>
              <div class="label">1ère place<br><span style="opacity:.7">${fmt(tmpl.prize_pct_first)}% du pool</span></div>
            </div>
            <div class="trn-prize-item silver">
              <span class="icon">🥈</span>
              <div class="amount">${fmt(prizes.prize_second)}</div>
              <div class="label">2ème place<br><span style="opacity:.7">${fmt(tmpl.prize_pct_second)}% du pool</span></div>
            </div>
            <div class="trn-prize-item bronze">
              <span class="icon">🥉</span>
              <div class="amount">${fmt(prizes.prize_third)}</div>
              <div class="label">3ème place<br><span style="opacity:.7">${fmt(tmpl.prize_pct_third)}% du pool</span></div>
            </div>
          </div>
          ${hasEntry ? `<div class="trn-small" style="margin-top:6px;color:#64748b;">Pool total estimé : <strong>${fmt(prizes.pool)} TIKS</strong> (${tmpl.max_players} joueurs × ${fmt(tmpl.entry_fee)} TIKS)</div>` : ''}

          <!-- Barre de progression file -->
          <div style="margin-top:12px;">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:5px;">
              <span>${qCount} / ${tmpl.max_players} joueurs en file</span><span>${pct}%</span>
            </div>
            <div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#0ea5e9);border-radius:4px;transition:width .4s;"></div>
            </div>
          </div>

          <div class="trn-join-area">${joinBtn}</div>
        </div>
      `;
    }

    render(html);

    // Listeners rejoindre
    root.querySelectorAll('.trn-join-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tmplId = btn.dataset.tmplId;
        const fee    = Number(btn.dataset.fee) || 0;
        await joinTemplate(tmplId, fee);
      });
    });

    // Listeners quitter la file
    root.querySelectorAll('.trn-leave-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Sortie…';
        try {
          const { data, error } = await supabase.rpc('rpc_leave_tournament_queue');
          if (error) throw error;
          await showOverview();
        } catch (e) {
          alert('Erreur : ' + (e?.message ?? String(e)));
          btn.disabled = false;
          btn.textContent = 'Quitter la file';
        }
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     POINT D'ENTRÉE OVERVIEW : dispatch admin / user
  ══════════════════════════════════════════════════════════════════ */

  async function showOverview() {
    dbg('showOverview start');
    render(spinner('Chargement…'));

    if (!supabase) { render(errBox('Connexion Supabase non disponible.')); return; }

    const session = await getSession();
    const uid     = session?.user?.id ?? null;
    const myProfile = uid ? await getMyProfile(uid) : null;
    const admin = isAdminProfile(myProfile);

    dbg('showOverview uid=' + uid + ' isAdmin=' + admin);

    if (admin) {
      await showAdminOverview(uid);
    } else {
      await showUserOverview(uid);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     ACTION — REJOINDRE (via template)
  ══════════════════════════════════════════════════════════════════ */

  async function joinTemplate(templateId, fee) {
    dbg('joinTemplate start', { templateId, fee });
    render(spinner('Inscription en cours…'));

    try {
      const { data, error } = await supabase.rpc('rpc_register_for_tournament', {
        p_template_id: templateId
      });

      if (error) {
        dbg('rpc_register_for_tournament error', error);
        const msg = error.message ?? String(error);
        render(`${errBox(msg)}
          <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour</button>`);
        root.querySelector('#trn-back-btn')?.addEventListener('click', showOverview);
        return;
      }

      dbg('rpc_register_for_tournament result', data);

      if (data?.status === 'started') {
        // Un tournoi a démarré → aller au bracket
        await showBracket(data.tournament_id, true);
      } else {
        // En file d'attente → montrer la vue queue
        await showQueueWaiting(templateId, data?.position ?? '?');
      }
    } catch (e) {
      dbg('joinTemplate exception', e);
      render(`${errBox(e?.message ?? String(e))}
        <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour</button>`);
      root.querySelector('#trn-back-btn')?.addEventListener('click', showOverview);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE FILE D'ATTENTE (template, pas encore d'instance)
  ══════════════════════════════════════════════════════════════════ */

  let _queuePoll = null;

  function stopQueuePoll() { if (_queuePoll) { clearInterval(_queuePoll); _queuePoll = null; } }

  async function showQueueWaiting(templateId, initialPosition) {
    stopQueuePoll();
    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    await renderQueueView(templateId, uid, initialPosition);

    // Polling toutes les 4s pour vérifier si un tournoi a démarré
    _queuePoll = setInterval(async () => {
      try {
        // Vérifier si l'utilisateur a été assigné à un tournoi
        const { data: qEntry } = await supabase
          .from('tournament_queue')
          .select('status,tournament_id')
          .eq('user_id', uid)
          .eq('template_id', templateId)
          .order('queued_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (qEntry?.status === 'assigned' && qEntry?.tournament_id) {
          stopQueuePoll();
          await showBracket(qEntry.tournament_id, true);
          return;
        }

        // Mettre à jour la position
        const { count } = await supabase
          .from('tournament_queue')
          .select('id', { head: true, count: 'exact' })
          .eq('template_id', templateId)
          .eq('status', 'waiting');

        const posEl = document.getElementById('trn-queue-count');
        if (posEl) posEl.textContent = count ?? '?';
      } catch (e) { dbg('queue poll error', e); }
    }, 4000);
  }

  async function renderQueueView(templateId, uid, position) {
    let tmpl = null;
    try {
      const { data } = await supabase
        .from('tournament_templates')
        .select('name,max_players,entry_fee,prize_pct_first,prize_pct_second,prize_pct_third')
        .eq('id', templateId)
        .maybeSingle();
      tmpl = data;
    } catch (_) {}

    const prizes = tmpl ? computePrizesFromTemplate(tmpl) : null;
    const name   = tmpl?.name ?? 'Compétition';

    render(`
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
          <button class="trn-btn-secondary" id="trn-back-btn" style="padding:6px 14px;font-size:12px;">← Retour</button>
          <h3 style="font-size:16px;font-weight:800;color:#1e293b;margin:0;">⏳ File d'attente</h3>
        </div>

        <div class="trn-card">
          <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${escHtml(name)}</div>
          <div class="trn-small">Le tournoi démarrera automatiquement dès que <strong>${tmpl?.max_players ?? '?'}</strong> joueurs seront prêts.</div>
        </div>

        <!-- Prizes -->
        ${prizes ? `
        <div class="trn-card-prize">
          <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:8px;">🏆 Ce que vous pouvez gagner</div>
          <div class="trn-prize-box">
            <div class="trn-prize-item gold">
              <span class="icon">🥇</span>
              <div class="amount">${fmt(prizes.prize_first)}</div>
              <div class="label">1ère place</div>
            </div>
            <div class="trn-prize-item silver">
              <span class="icon">🥈</span>
              <div class="amount">${fmt(prizes.prize_second)}</div>
              <div class="label">2ème place</div>
            </div>
            <div class="trn-prize-item bronze">
              <span class="icon">🥉</span>
              <div class="amount">${fmt(prizes.prize_third)}</div>
              <div class="label">3ème place</div>
            </div>
          </div>
        </div>` : ''}

        <!-- Statut attente -->
        <div style="padding:20px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;text-align:center;margin-bottom:14px;">
          <div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:700;color:#1d4ed8;margin-bottom:8px;">
            <span class="trn-spin"></span>
            <span class="trn-pulse">En attente des autres joueurs…</span>
          </div>
          <div class="trn-small" style="color:#3b82f6;">
            Joueurs en file : <strong id="trn-queue-count">${position ?? '?'}</strong> / ${tmpl?.max_players ?? '?'}
          </div>
        </div>

        <!-- Bouton quitter -->
        <div style="text-align:center;">
          <button class="trn-btn-danger" id="trn-leave-queue-btn" style="font-size:13px;">
            Quitter la file ${Number(tmpl?.entry_fee) > 0 ? '(remboursement automatique)' : ''}
          </button>
        </div>
      </div>
    `);

    root.querySelector('#trn-back-btn')?.addEventListener('click', () => { stopQueuePoll(); showOverview(); });

    root.querySelector('#trn-leave-queue-btn')?.addEventListener('click', async () => {
      const btn = root.querySelector('#trn-leave-queue-btn');
      btn.disabled = true;
      btn.textContent = 'Sortie en cours…';
      try {
        const { error } = await supabase.rpc('rpc_leave_tournament_queue');
        if (error) throw error;
        stopQueuePoll();
        await showOverview();
      } catch (e) {
        alert('Erreur : ' + (e?.message ?? String(e)));
        btn.disabled = false;
        btn.textContent = 'Quitter la file';
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 2 — CHECK-IN / SALLE D'ATTENTE (instance tournament)
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
      .from('tournaments').select('id,status,entry_fee,prize_first,prize_second,prize_third,max_players').eq('id', tid).maybeSingle();

    if (!t) { render(errBox('Tournoi introuvable.')); return; }
    if (t.status === 'active') { await showBracket(tid, true); return; }

    await renderCheckinView(t, uid);

    try {
      _checkinChannel = supabase.channel(`trn-checkin:${tid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_registrations', filter: `tournament_id=eq.${tid}` },
          async () => { await renderCheckinView(t, uid); })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${tid}` },
          async (payload) => {
            if (payload?.new?.status === 'active') { stopCheckin(); await showBracket(tid, true); }
          })
        .subscribe(s => { if (s !== 'SUBSCRIBED') startCheckinPoll(tid, uid); });
    } catch (e) {
      dbg('showCheckin: subscribe failed', e);
      startCheckinPoll(tid, uid);
    }
  }

  async function renderCheckinView(t, uid) {
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
      bracketHtml += `<div class="trn-bracket-row"><span class="trn-round-lbl">${label}</span>`;
      [s1, s2].forEach((slot, i) => {
        if (i > 0) bracketHtml += `<span class="trn-slot vs">VS</span>`;
        const r = registrations.find(x => x.slot === slot);
        const cls = r ? (r.user_id === uid ? 'me' : 'filled') : 'empty';
        bracketHtml += `<span class="trn-slot ${cls}">${r ? (r.user_id === uid ? '👤' : '🎮') : '⬜'} ${r ? (r.pseudo || 'Joueur ' + slot) : 'En attente…'}</span>`;
      });
      bracketHtml += `</div>`;
    });

    render(`
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
          <button class="trn-btn-secondary" id="trn-back-btn" style="padding:6px 14px;font-size:12px;">← Retour</button>
          <h3 style="font-size:16px;font-weight:800;color:#1e293b;margin:0;">
            ⏳ Salle d'attente
            <span class="trn-badge" style="background:#e0f2fe;color:#0369a1;margin-left:8px;">${n}/${t.max_players}</span>
          </h3>
        </div>

        <!-- Prizes -->
        <div class="trn-card-prize">
          <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:8px;">🏆 À gagner</div>
          <div class="trn-prize-box">
            <div class="trn-prize-item gold"><span class="icon">🥇</span><div class="amount">${fmt(t.prize_first)}</div><div class="label">1ère place</div></div>
            <div class="trn-prize-item silver"><span class="icon">🥈</span><div class="amount">${fmt(t.prize_second)}</div><div class="label">2ème place</div></div>
            <div class="trn-prize-item bronze"><span class="icon">🥉</span><div class="amount">${fmt(t.prize_third)}</div><div class="label">3ème place</div></div>
          </div>
        </div>

        <div class="trn-card" style="margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Bracket en cours de formation</div>
          ${bracketHtml}
          <div class="trn-bracket-row" style="opacity:.45;margin-top:4px;">
            <span class="trn-round-lbl">Finale</span>
            <span class="trn-slot empty" style="font-size:12px;">Gagnant D1</span>
            <span class="trn-slot vs">VS</span>
            <span class="trn-slot empty" style="font-size:12px;">Gagnant D2</span>
          </div>
        </div>

        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:5px;">
            <span>${n} / ${t.max_players} joueurs inscrits</span><span>${pct}%</span>
          </div>
          <div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#0ea5e9);border-radius:4px;transition:width .4s;"></div>
          </div>
        </div>

        <div style="padding:14px 16px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;text-align:center;">
          <div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:700;color:#1d4ed8;">
            <span class="trn-spin"></span>
            <span class="trn-pulse">${myReg ? 'Tu es inscrit — en attente des autres joueurs…' : 'En attente…'}</span>
          </div>
          <div style="font-size:12px;color:#3b82f6;margin-top:6px;">
            Le tournoi démarrera automatiquement dès que ${t.max_players} joueurs seront prêts.
          </div>
        </div>
      </div>`);

    root.querySelector('#trn-back-btn')?.addEventListener('click', () => { stopCheckin(); showOverview(); });
  }

  function startCheckinPoll(tid, uid) {
    if (_checkinPoll) return;
    _checkinPoll = setInterval(async () => {
      try {
        const { data: t } = await supabase.from('tournaments').select('status').eq('id', tid).maybeSingle();
        if (t?.status === 'active') { stopCheckin(); await showBracket(tid, true); }
        else if (t?.status === 'waiting') { const sess = await getSession(); await renderCheckinView({ id: tid, ...t }, sess?.user?.id ?? null); }
      } catch (e) { dbg('startCheckinPoll exception', e); }
    }, 3000);
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 3 — BRACKET / COMPÉTITION (POLLING)
  ══════════════════════════════════════════════════════════════════ */

  let _bracketPoll = null;

  function stopBracket() {
    if (_bracketPoll) { clearInterval(_bracketPoll); _bracketPoll = null; }
  }

  async function showBracket(tid, subscribe = false) {
    dbg('showBracket start', tid);
    stopBracket();
    stopQueuePoll();
    render(spinner('Chargement du bracket…'));

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    await renderBracketView(tid, uid);

    if (subscribe) {
      _bracketPoll = setInterval(() => {
        try { renderBracketView(tid, uid); } catch (e) { dbg('bracket poll error', e); }
      }, 5000);
    }
  }

  async function renderBracketView(tid, uid) {
    dbg('renderBracketView', tid);

    const { data: t } = await supabase.from('tournaments').select('*').eq('id', tid).maybeSingle();
    const { data: matches } = await supabase
      .from('tournament_matches').select('*').eq('tournament_id', tid).order('round_number').order('match_index');
    const { data: regs } = await supabase
      .from('tournament_registrations').select('user_id,slot').eq('tournament_id', tid);

    const allMatches = matches ?? [];
    const allRegs    = regs ?? [];

    const allUids = [...new Set([
      ...allRegs.map(r => r.user_id),
      ...allMatches.flatMap(m => [m.player1_id, m.player2_id, m.winner_id].filter(Boolean)),
    ])];
    const profiles = await getProfiles(allUids);
    const pseudo = id => profiles.find(p => p.id === id)?.pseudo ?? (id ? id.slice(0, 8) + '…' : '?');

    const myActiveMatch = allMatches.find(m =>
      m.status === 'active' && (m.player1_id === uid || m.player2_id === uid)
    );

    const isFinished  = t?.status === 'finished';
    const statusBadge = isFinished
      ? `<span class="trn-badge" style="background:#dcfce7;color:#16a34a;">Terminé 🏁</span>`
      : `<span class="trn-badge" style="background:#fef9c3;color:#92400e;">En cours ⚔️</span>`;

    function matchBlock(m) {
      if (!m) return '<div style="color:#94a3b8;font-size:13px;">Match en attente…</div>';
      const p1   = pseudo(m.player1_id);
      const p2   = pseudo(m.player2_id);
      const isMe = m.player1_id === uid || m.player2_id === uid;
      const cls  = m.status === 'finished' ? 'pending' : (m.status === 'active' && isMe ? 'active' : m.status === 'active' ? '' : 'pending');
      const winnerLabel = m.winner_id ? `<span style="font-size:11px;color:#16a34a;font-weight:700;margin-left:6px;">🏆 ${pseudo(m.winner_id)}</span>` : '';

      let actionBtn = '';
      if (m.status === 'active' && isMe) {
        actionBtn = `<button class="trn-btn-primary trn-play-btn" data-tmid="${m.id}" style="padding:7px 18px;font-size:13px;">▶ Jouer ce match</button>`;
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
    const finale = allMatches.find(m => m.round_number === Math.max(...allMatches.map(x => x.round_number), 1) && !m.is_bronze);
    const bronze = allMatches.find(m => m.is_bronze);

    const alertHtml = myActiveMatch && !isFinished
      ? `<div style="padding:14px 16px;background:#f0fdf4;border:2px solid #22c55e;border-radius:10px;
                     display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
           <div>
             <div style="font-size:14px;font-weight:700;color:#15803d;">⚔️ Ton match t'attend !</div>
             <div style="font-size:12px;color:#16a34a;margin-top:2px;">
               Tu affrontes <strong>${pseudo(myActiveMatch.player1_id === uid ? myActiveMatch.player2_id : myActiveMatch.player1_id)}</strong>
             </div>
           </div>
           <button class="trn-btn-primary trn-play-btn" data-tmid="${myActiveMatch.id}" style="padding:10px 20px;">▶ Jouer maintenant</button>
         </div>` : '';

    const resultHtml = isFinished && t?.winner_id
      ? `<div style="padding:16px;background:#fefce8;border:1px solid #fde68a;border-radius:10px;text-align:center;margin-bottom:16px;">
           <div style="font-size:22px;margin-bottom:6px;">🎉</div>
           <div style="font-size:15px;font-weight:800;color:#713f12;">Tournoi terminé !</div>
           <div style="font-size:13px;color:#92400e;margin-top:4px;">
             🥇 <strong>${pseudo(t.winner_id)}</strong>
             ${t.runner_up_id ? ` · 🥈 <strong>${pseudo(t.runner_up_id)}</strong>` : ''}
           </div>
         </div>` : '';

    // Prizes à partir de l'instance (valeurs réelles)
    const prizeHtml = `
      <div class="trn-card-prize" style="margin-bottom:16px;">
        <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:8px;">🏆 Prize pool</div>
        <div class="trn-prize-box">
          <div class="trn-prize-item gold"><span class="icon">🥇</span><div class="amount">${fmt(t?.prize_first)}</div><div class="label">1ère place</div></div>
          <div class="trn-prize-item silver"><span class="icon">🥈</span><div class="amount">${fmt(t?.prize_second)}</div><div class="label">2ème place</div></div>
          <div class="trn-prize-item bronze"><span class="icon">🥉</span><div class="amount">${fmt(t?.prize_third)}</div><div class="label">3ème place</div></div>
        </div>
      </div>`;

    // Balance + retrait admin
    const balInfo = await getTournamentBalance(tid, t?.entry_fee);
    const myProfile = uid ? await getMyProfile(uid) : null;
    const admin = isAdminProfile(myProfile);

    const withdrawBtnHtml = admin && t?.status === 'finished' && !t?.fund_withdrawn
      ? `<button id="trn-withdraw-btn" class="trn-btn-primary" style="font-size:12px;padding:7px 16px;">Retirer (${fmt(balInfo.balance)} TIKS)</button>`
      : (t?.fund_withdrawn ? `<div style="font-size:12px;color:#64748b;margin-left:10px;">Fonds déjà retirés</div>` : '');

    render(`
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
          <button class="trn-btn-secondary" id="trn-back-btn" style="padding:6px 14px;font-size:12px;">← Retour</button>
          <h3 style="font-size:16px;font-weight:800;color:#1e293b;margin:0;">🏆 Bracket ${statusBadge}</h3>
          ${admin ? `<div style="margin-left:auto;font-size:12px;color:#64748b;">Balance: <strong>${fmt(balInfo.balance)}</strong> TIKS ${withdrawBtnHtml}</div>` : ''}
        </div>

        ${resultHtml}
        ${alertHtml}
        ${prizeHtml}

        <div class="trn-card">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
            Demi-finales / Premiers matches
          </div>
          ${semis.map(m => matchBlock(m)).join('') || '<div style="color:#94a3b8;font-size:13px;">En attente des matchs…</div>'}
        </div>

        <div class="trn-card" style="margin-top:12px;">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">Finale</div>
          ${matchBlock(finale)}
        </div>

        ${bronze ? `<div class="trn-card" style="margin-top:12px;">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">🥉 Petite finale (3ème place)</div>
          ${matchBlock(bronze)}
        </div>` : ''}

        <div class="trn-card" style="margin-top:12px;">
          <div style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Participants</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${allRegs.sort((a, b) => a.slot - b.slot).map(r => `
              <span class="trn-slot ${r.user_id === uid ? 'me' : 'filled'}">
                ${r.user_id === uid ? '👤' : '🎮'} ${pseudo(r.user_id)} <span style="opacity:.5;font-size:10px;">#${r.slot}</span>
              </span>`).join('')}
          </div>
        </div>
      </div>`);

    root.querySelector('#trn-back-btn')?.addEventListener('click', () => { stopBracket(); showOverview(); });

    root.querySelectorAll('.trn-play-btn').forEach(btn => {
      btn.addEventListener('click', () => launchGame(btn.dataset.tmid, uid, tid));
    });

    root.querySelector('#trn-withdraw-btn')?.addEventListener('click', async (e) => {
      if (!confirm('Retirer les fonds disponibles pour ce tournoi ?')) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Retrait en cours…';
      try {
        const { data, error } = await supabase.rpc('rpc_withdraw_tournament_funds', { p_tournament_id: tid });
        if (error) throw error;
        alert('Retrait effectué : ' + JSON.stringify(data));
        await renderBracketView(tid, uid);
      } catch (err) {
        dbg('withdraw error', err);
        alert('Erreur retrait : ' + (err?.message ?? String(err)));
        btn.disabled = false;
        btn.textContent = prev;
      }
    });

    dbg('renderBracketView rendered', { tid, matches: allMatches.length, regs: allRegs.length });
  }

  /* ══════════════════════════════════════════════════════════════════
     VUE 4 — LANCEMENT : création match+game → redirect game.html
  ══════════════════════════════════════════════════════════════════ */

  async function launchGame(tournamentMatchId, uid, tid) {
    dbg('launchGame start', { tournamentMatchId, uid, tid });
    render(`<div style="padding:32px;text-align:center;">
      <span class="trn-spin" style="width:28px;height:28px;border-width:3px;margin-bottom:14px;display:inline-block;"></span>
      <div style="font-size:15px;font-weight:700;color:#1e293b;margin-bottom:6px;">Préparation du match…</div>
      <div style="font-size:13px;color:#64748b;">Connexion au jeu en cours.</div>
    </div>`);

    try {
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
          const { data: mRow, error: mErr } = await supabase.from('matches')
            .insert({ owner_id: tmatch.player1_id, opponent_id: tmatch.player2_id, status: 'ongoing',
                      metadata: { tournament_id: tmatch.tournament_id, tournament_match_id: tmatch.id } })
            .select('id').single();
          if (mErr || !mRow) throw new Error('Erreur création match : ' + (mErr?.message ?? 'inconnu'));
          matchId = mRow.id;

          const { data: gRow, error: gErr } = await supabase.from('games')
            .insert({ owner_id: tmatch.player1_id, opponent_id: tmatch.player2_id, status: 'playing', match_id: matchId })
            .select('id').single();
          if (gErr || !gRow) throw new Error('Erreur création game : ' + (gErr?.message ?? 'inconnu'));
          gameId = gRow.id;

          await supabase.from('tournament_matches').update({ match_id: matchId }).eq('id', tmatch.id);
        } else {
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
      window.location.href = `game.html?gameId=${gameId}&matchId=${matchId}`;

    } catch (e) {
      console.error('[tournament] launchGame error', e);
      render(`${errBox(e?.message ?? String(e))}
        <button class="trn-btn-secondary" style="margin-top:12px;" id="trn-back-btn">← Retour au bracket</button>`);
      root.querySelector('#trn-back-btn')?.addEventListener('click', () => showBracket(tid, true));
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     UTILITAIRE : échappement HTML
  ══════════════════════════════════════════════════════════════════ */
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ══════════════════════════════════════════════════════════════════
     POINT D'ENTRÉE
  ══════════════════════════════════════════════════════════════════ */

  async function init() {
    dbg('init start');
    if (!supabase) { render(errBox('Connexion non disponible.')); return; }

    const session = await getSession();
    const uid     = session?.user?.id ?? null;

    if (uid) {
      // 1. L'utilisateur est-il dans un tournoi actif ?
      try {
        const { data: myRegs } = await supabase
          .from('tournament_registrations')
          .select('tournament_id, tournaments!inner(status)')
          .eq('user_id', uid)
          .in('tournaments.status', ['waiting', 'active'])
          .limit(1)
          .maybeSingle();

        if (myRegs) {
          const t   = myRegs.tournaments;
          const tid = myRegs.tournament_id;
          if (t?.status === 'active')  { await showBracket(tid, true); return; }
          if (t?.status === 'waiting') { await showCheckin(tid); return; }
        }
      } catch (e) { dbg('init: check myRegs failed', e); }

      // 2. Est-il en file d'attente pour un template ?
      try {
        const { data: qEntry } = await supabase
          .from('tournament_queue')
          .select('template_id,queued_at')
          .eq('user_id', uid)
          .eq('status', 'waiting')
          .maybeSingle();

        if (qEntry) {
          await showQueueWaiting(qEntry.template_id, null);
          return;
        }
      } catch (e) { dbg('init: check queue failed', e); }
    }

    await showOverview();
  }

  window.addEventListener('pagehide', () => { stopCheckin(); stopBracket(); stopQueuePoll(); });

  window.taktikTournament = window.taktikTournament || {};
  window.taktikTournament.render       = async () => { await showOverview(); };
  window.taktikTournament.showOverview = showOverview;
  window.taktikTournament.showCheckin  = showCheckin;
  window.taktikTournament.showBracket  = showBracket;

  await init();
}

/* ─────────────────────────────────────────────────────────────────────
   Export utilitaire pour la home preview (appelé depuis index.html)
   ──────────────────────────────────────────────────────────────────── */
export async function renderHomePreview(previewEl, supabaseClient) {
  const sup = supabaseClient ?? window.supabase;
  if (!previewEl) return;
  previewEl.textContent = 'Chargement...';
  try {
    if (!sup) { previewEl.textContent = ''; return; }
    // On affiche les templates actifs (pas les instances)
    const { data } = await sup
      .from('tournament_templates')
      .select('id,name,max_players,entry_fee,prize_pct_first,prize_pct_second,prize_pct_third')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(3);
    const templates = data ?? [];
    if (!templates.length) {
      previewEl.textContent = 'Aucune compétition pour l\'instant';
      return;
    }
    previewEl.innerHTML = templates.map(tmpl => {
      const pool   = (tmpl.max_players ?? 4) * (Number(tmpl.entry_fee) || 0);
      const first  = Math.floor((pool * (Number(tmpl.prize_pct_first) || 0) / 100) / 10) * 10;
      const fee    = Number(tmpl.entry_fee) || 0;
      return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;">${tmpl.name || 'Tournoi'} · ${tmpl.max_players} joueurs</div>
        <div style="color:#64748b;">🥇 ${Number(first).toLocaleString('fr-FR')} · Frais ${fee > 0 ? Number(fee).toLocaleString('fr-FR') + ' TIKS' : 'gratuit'}</div>
      </div>`;
    }).join('');
  } catch (e) {
    console.warn('renderHomePreview failed', e);
    previewEl.textContent = '';
  }
}
