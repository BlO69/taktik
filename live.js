// live.js (version corrigée et améliorée)
// Gestion LiveKit — attache les vidéos dans les slots existants (#player1Video, #player2Video, #moderatorVideo)
// Usage: <script type="module" src="./live.js"></script>
/* global window, document, console, alert */

const dbg = true; // <-- mettre à false pour désactiver les alertes de debug/console
function dbgLog(...args) { if (!dbg) return; try { console.info('[live.js][DBG]', ...args); } catch (e) {} }
function dbgWarn(...args) { if (!dbg) return; try { console.warn('[live.js][WARN]', ...args); } catch (e) {} }
function dbgError(...args) { if (!dbg) return; try { console.error('[live.js][ERROR]', ...args); } catch (e) {} try { if (dbg) alert('[live.js] ERROR: ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (e) {} }
function dbgAlert(...args) { if (!dbg) return; try { alert('[live.js] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (e) {} }

// helper: attendre que window.livekit / window.LivekitClient soit prêt (timeout en ms)
function waitForLivekit(timeout = 2000) {
  if (window.livekit || window.LivekitClient) return Promise.resolve(window.livekit || window.LivekitClient);
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (window.livekit || window.LivekitClient) {
        clearInterval(iv);
        return resolve(window.livekit || window.LivekitClient);
      }
      if (Date.now() - start > timeout) {
        clearInterval(iv);
        return resolve(null);
      }
    }, 120);
  });
}

let liveRoom = null;
let localVideoTrack = null;
let localAudioTrack = null;
let currentlyPublishing = false;

// subscription bookkeeping (client-side)
let subscribedTracksMap = new Map(); // key -> publication id, value -> { participantSid, kind }
let subscribedVideoCount = 0; // only counts video subscriptions (enforced limit)

/** --- patch: getSlotEl with fallback IDs --- */
const VIDEO_SLOT_IDS = {
  owner: 'player1Video',
  opponent: 'player2Video',
  moderator: 'moderatorVideo'
};

const DEFAULT_LIVEKIT_TOKEN_ENDPOINT = 'https://mvkfawtnvahxqwcbcfkb.supabase.co/functions/v1/get_livekit_token';

function log(...args) { dbgLog(...args); }

/** Safe toString helper */
function safeToString(x) {
  try {
    if (x === null || x === undefined) return null;
    return x.toString();
  } catch (e) {
    return String(x);
  }
}
function normalizeIdentity(s) {
  try {
    const raw = safeToString(s) ?? '';
    // enlève préfixes usuels et espaces, lowercase pour robustesse
    return String(raw).replace(/^(user[:\-_]|u[:\-_])/i, '').replace(/^{|}$/g, '').trim().toLowerCase();
  } catch (e) {
    return '';
  }
}

// --- robust participant -> slot mapping (remplacer la fonction existante) ---
function participantToSlotIdentity(participant, gameState) {
  const identRaw = safeToString(participant?.identity ?? participant?.name ?? participant?.sid ?? '');
  const ident = normalizeIdentity(identRaw || '');
  const sid = safeToString(participant?.sid ?? '');
  if (dbg) dbgLog('participantToSlotIdentity: checking', { identRaw, ident, sid, gameState });

  if (!gameState) return 'moderator';

  const ownerId = safeToString(gameState.owner_id ?? gameState.ownerId ?? gameState.owner ?? '');
  const opponentId = safeToString(gameState.opponent_id ?? gameState.opponentId ?? gameState.opponent ?? '');
  const normOwner = normalizeIdentity(ownerId || '');
  const normOpponent = normalizeIdentity(opponentId || '');

  // direct equality or includes (fuzzy)
  if (ident && normOwner && (ident === normOwner || ident.includes(normOwner) || normOwner.includes(ident))) return 'owner';
  if (ident && normOpponent && (ident === normOpponent || ident.includes(normOpponent) || normOpponent.includes(ident))) return 'opponent';

  // try matching by raw sids if present in game state
  const ownerSid = safeToString(gameState.owner_sid ?? gameState.ownerSid ?? '');
  const opponentSid = safeToString(gameState.opponent_sid ?? gameState.opponentSid ?? '');
  if (ownerSid && sid && (sid === ownerSid || sid.includes(ownerSid) || ownerSid.includes(sid))) return 'owner';
  if (opponentSid && sid && (sid === opponentSid || sid.includes(opponentSid) || opponentSid.includes(sid))) return 'opponent';

  // fallback: if participant.name contains owner/opponent pseudo (useful if identity is email/displayname)
  const display = normalizeIdentity(participant?.name ?? participant?.identity ?? '');
  if (display && normOwner && display.includes(normOwner)) return 'owner';
  if (display && normOpponent && display.includes(normOpponent)) return 'opponent';

  // ultimate fallback: if gameState contains mapping by participant.sid (rare), try it
  try {
    if (gameState.participants_by_sid && typeof gameState.participants_by_sid === 'object') {
      if (gameState.participants_by_sid[sid] === ownerId) return 'owner';
      if (gameState.participants_by_sid[sid] === opponentId) return 'opponent';
    }
  } catch (e) {}

  return 'moderator';
}

// Robust dynamic loader for LiveKit client:
async function dynamicImportLivekit() {
  if (window.LivekitClient) {
    dbgLog('Using preloaded LivekitClient from window');
    return window.LivekitClient;
  }

  const candidates = [
    'https://cdn.jsdelivr.net/npm/livekit-client@2.17.1/dist/livekit-client.esm.mjs',
    'https://unpkg.com/livekit-client@2.17.1/dist/livekit-client.es.js'
  ];

  for (const url of candidates) {
    try {
      dbgLog('Attempting dynamic import of LiveKit client from', url);
      const mod = await import(url);
      if (mod) {
        window.LivekitClient = mod;
        dbgLog('Dynamic import success for', url);
        return mod;
      }
    } catch (e) {
      dbgWarn('Dynamic import failed for', url, e);
    }
  }

  try {
    dbgLog('Attempting module-injection fallback to load LivekitClient');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.textContent = `
        import * as LK from '${candidates[0]}';
        window.LivekitClient = LK;
      `;
      script.onload = () => { resolve(); };
      script.onerror = (e) => { reject(new Error('module-injection failed')); };
      document.head.appendChild(script);
      setTimeout(() => {
        if (window.LivekitClient) resolve();
        else reject(new Error('module-injection timeout'));
      }, 3500);
    });
    if (window.LivekitClient) {
      dbgLog('Module-injection succeeded and LivekitClient available on window');
      return window.LivekitClient;
    }
  } catch (e) {
    dbgWarn('Module-injection fallback failed', e);
  }

  dbgError('LivekitClient not found on window (script not loaded)');
  throw new Error('LivekitClient not loaded');
}

function getSlotEl(slotKey) {
  const id = VIDEO_SLOT_IDS[slotKey];
  if (!id) return null;
  return document.getElementById(id) || null;
}

function ensureVideoElement(slotEl, { muted = false } = {}) {
  if (!slotEl) return null;
  let video = slotEl.querySelector('video');
  if (video) {
    video.autoplay = true;
    video.playsInline = true;
    video.muted = !!muted;
    video.style.width = '100%';
    video.style.height = '100%';
    try { video.classList?.add?.('object-cover'); } catch(_) {}
    ensureSlotMuteButton(slotEl);
    return video;
  }
  video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = !!muted;
  video.setAttribute('aria-hidden', 'false');
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'cover';
  video.style.borderRadius = '0.5rem';
  slotEl.innerHTML = '';
  slotEl.appendChild(video);
  ensureSlotMuteButton(slotEl);
  return video;
}

function ensureAudioElement(slotEl) {
  let audio = slotEl ? slotEl.querySelector('audio[data-livekit-audio]') : null;
  if (audio) {
    audio.autoplay = true;
    audio.controls = false;
    audio.style.display = 'none';
    return audio;
  }
  audio = document.createElement('audio');
  audio.setAttribute('data-livekit-audio', '1');
  audio.autoplay = true;
  audio.controls = false;
  audio.style.display = 'none';
  audio.muted = false;
  if (slotEl) {
    slotEl.appendChild(audio);
    ensureSlotMuteButton(slotEl);
  } else {
    document.body.appendChild(audio);
    ensureGlobalAudioController();
  }
  return audio;
}

function ensureSlotMuteButton(slotEl) {
  if (!slotEl) return;
  if (slotEl.querySelector('.lk-mute-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lk-mute-btn';
  btn.setAttribute('aria-label', 'Couper le son du participant');
  btn.title = 'Couper / activer le son localement';
  btn.style.position = 'absolute';
  btn.style.right = '8px';
  btn.style.top = '8px';
  btn.style.zIndex = '999';
  btn.style.background = 'rgba(0,0,0,0.5)';
  btn.style.border = 'none';
  btn.style.color = '#fff';
  btn.style.padding = '6px';
  btn.style.borderRadius = '6px';
  btn.style.backdropFilter = 'blur(4px)';
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '13px';
  btn.textContent = '🔊';
  try {
    const cs = getComputedStyle(slotEl);
    if (cs && cs.position === 'static') slotEl.style.position = 'relative';
  } catch (e) {}
  slotEl.dataset.lkMuted = 'false';

  btn.addEventListener('click', () => {
    const isMuted = slotEl.dataset.lkMuted === 'true';
    const newMuted = !isMuted;
    const audios = Array.from(slotEl.querySelectorAll('audio'));
    audios.forEach(a => {
      try { a.muted = newMuted; } catch (e) {}
    });
    slotEl.dataset.lkMuted = newMuted ? 'true' : 'false';
    btn.textContent = newMuted ? '🔇' : '🔊';
  });

  slotEl.appendChild(btn);
}

function ensureGlobalAudioController() {
  if (document.getElementById('lk-global-audio-control')) return;
  const btn = document.createElement('button');
  btn.id = 'lk-global-audio-control';
  btn.type = 'button';
  btn.className = 'lk-global-audio';
  btn.style.position = 'fixed';
  btn.style.right = '12px';
  btn.style.bottom = '12px';
  btn.style.zIndex = '9999';
  btn.style.background = 'rgba(0,0,0,0.6)';
  btn.style.border = 'none';
  btn.style.color = '#fff';
  btn.style.padding = '8px';
  btn.style.borderRadius = '8px';
  btn.style.backdropFilter = 'blur(4px)';
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '14px';
  btn.textContent = '🔊 audio';
  btn.dataset.lkMuted = 'false';

  btn.addEventListener('click', () => {
    const isMuted = btn.dataset.lkMuted === 'true';
    const newMuted = !isMuted;
    const audios = Array.from(document.querySelectorAll('audio[data-livekit-audio]'));
    audios.forEach(a => {
      try { a.muted = newMuted; } catch (e) {}
    });
    btn.dataset.lkMuted = newMuted ? 'true' : 'false';
    btn.textContent = newMuted ? '🔇 audio' : '🔊 audio';
  });

  document.body.appendChild(btn);
}

/** UI placeholder management:
 * - when a participant publishes (video), show clickable overlay:
 *   "{{pseudo}} est en train de diffuser, cliquer pour voir"
 * - on click: attempt to subscribe/attach and remove overlay when stream attached.
 */
async function fetchPseudoForIdentity(identity) {
  // Try to resolve pseudo via Supabase user_profiles table if available.
  // identity may include prefixes; try to use raw identity first.
  try {
    if (!window.supabase || !window.supabase.from) return null;
    if (!identity) return null;
    const candidateId = safeToString(identity);
    // attempt to query by id
    try {
      const { data, error } = await window.supabase
        .from('user_profiles')
        .select('pseudo')
        .eq('id', candidateId)
        .limit(1)
        .maybeSingle();
      if (!error && data && data.pseudo) return data.pseudo;
    } catch (e) {
      dbgWarn('supabase query by id failed', e);
    }
    // fallback: try by profile_id or user_id fields (common variants)
    const keys = ['user_id', 'profile_id', 'id'];
    for (const k of keys) {
      try {
        const { data, error } = await window.supabase
          .from('user_profiles')
          .select('pseudo')
          .eq(k, candidateId)
          .limit(1)
          .maybeSingle();
        if (!error && data && data.pseudo) return data.pseudo;
      } catch (_) {}
    }
  } catch (e) {
    dbgWarn('fetchPseudoForIdentity failed', e);
  }
  // fallback: return short identity
  return String(identity).slice(0, 12);
}

function makeBroadcastPlaceholder(slotEl, pseudo, participant, publication) {
  if (!slotEl) return null;
  // remove old placeholder if exists
  const existing = slotEl.querySelector('.lk-broadcast-placeholder');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.className = 'lk-broadcast-placeholder';
  wrap.style.position = 'absolute';
  wrap.style.left = '0';
  wrap.style.top = '0';
  wrap.style.right = '0';
  wrap.style.bottom = '0';
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.justifyContent = 'center';
  wrap.style.zIndex = '998';
  wrap.style.padding = '0.5rem';
  wrap.style.textAlign = 'center';
  wrap.style.backdropFilter = 'blur(6px)';
  wrap.style.background = 'linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.25))';
  wrap.style.color = '#fff';
  wrap.style.borderRadius = '0.5rem';
  wrap.style.cursor = 'pointer';
  wrap.innerText = `${pseudo} est en train de diffuser, cliquer pour voir`;

  // store metadata
  wrap.dataset.participantSid = participant?.sid ?? '';
  wrap.dataset.pubId = getPublicationId(publication) ?? '';

  // click attempts subscription + attach
  wrap.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      dbgLog('Placeholder clicked — attempting subscribe/attach', { participant: participant?.identity, pubId: wrap.dataset.pubId });
      // Try to subscribe the publication (strong attempt)
      if (publication) {
        await trySubscribePublication(publication, participant);
      }
      // If publication.track present, attach it (handlePublication normally does it but ensure)
      const actualPub = publication?.publication ? publication.publication : publication;
      const trackObj = actualPub?.track ?? actualPub;
      if (trackObj && typeof trackObj.attach === 'function') {
        const gs = getGameState();
        const slot = participantToSlotIdentity(participant, gs);
        const sEl = getSlotEl(slot);
        attachTrackToSlot(trackObj, sEl, { isLocalPreview: false });
      } else {
        // If not yet available, ensure we register one-time listener to attach when ready
        if (publication && typeof publication.on === 'function') {
          const onSubscribed = (trackOrPub) => {
            try {
              const p = trackOrPub?.publication ? trackOrPub.publication : trackOrPub;
              const t = p?.track ?? p;
              const gs = getGameState();
              const slot = participantToSlotIdentity(participant, gs);
              const sEl = getSlotEl(slot);
              if (t && typeof t.attach === 'function') {
                attachTrackToSlot(t, sEl, { isLocalPreview: false });
              }
            } catch (e) { dbgWarn('placeholder onSubscribed handler failed', e); }
            try { if (publication.off) publication.off('subscribed', onSubscribed); } catch (_) {}
          };
          try { publication.on('subscribed', onSubscribed); } catch (e) { dbgWarn('failed to attach subscribed listener from placeholder', e); }
        }
      }
    } catch (e) {
      dbgWarn('placeholder click handler failed', e);
    }
  });

  slotEl.appendChild(wrap);
  return wrap;
}

function removeBroadcastPlaceholder(slotEl) {
  if (!slotEl) return;
  const existing = slotEl.querySelector('.lk-broadcast-placeholder');
  if (existing) existing.remove();
}

/* attach logic: when a video is attached we remove placeholder for that slot */
function attachTrackToSlot(track, slotEl, { isLocalPreview = false } = {}) {
  if (!track) return;
  try {
    const kind = track.kind ?? (track.track && track.track.kind) ?? 'unknown';
    if (kind === 'video') {
      const videoEl = ensureVideoElement(slotEl, { muted: !!isLocalPreview });
      if (typeof track.attach === 'function') {
        const maybeEl = track.attach(videoEl);
        if (maybeEl && maybeEl !== videoEl) {
          try { videoEl.remove(); } catch(_) {}
          slotEl.appendChild(maybeEl);
        } else {
          if (!slotEl.contains(videoEl)) {
            slotEl.innerHTML = '';
            slotEl.appendChild(videoEl);
          }
        }
      } else {
        dbgWarn('[live.js] video track.attach not available; skipping attach');
      }
      // remove placeholder if present
      removeBroadcastPlaceholder(slotEl);
      ensureSlotMuteButton(slotEl);
    } else if (kind === 'audio') {
      const audioEl = ensureAudioElement(slotEl || document.body);
      if (typeof track.attach === 'function') {
        const maybeEl = track.attach(audioEl);
        if (maybeEl && maybeEl !== audioEl) {
          try { audioEl.remove(); } catch(_) {}
          (slotEl || document.body).appendChild(maybeEl);
          try { maybeEl.setAttribute('data-livekit-audio', '1'); } catch(e) {}
        } else {
          if (!(slotEl || document.body).contains(audioEl)) {
            (slotEl || document.body).appendChild(audioEl);
          }
        }
      } else {
        dbgWarn('[live.js] audio track.attach not available; skipping attach');
      }
      if (slotEl) ensureSlotMuteButton(slotEl); else ensureGlobalAudioController();
    } else {
      if (typeof track.attach === 'function') {
        try {
          const el = track.attach();
          if (el) {
            (slotEl || document.body).appendChild(el);
          }
        } catch (e) {
          dbgWarn('[live.js] generic attach failed', e);
        }
      }
    }
  } catch (e) {
    dbgWarn('[live.js] attachTrackToSlot failed', e);
  }
}

function clearSlot(slotEl) {
  if (!slotEl) return;
  try {
    const vids = Array.from(slotEl.querySelectorAll('video,canvas,audio,button.lk-mute-btn,.lk-broadcast-placeholder'));
    vids.forEach(v => { try { v.remove(); } catch (e) {} });
    slotEl.innerHTML = '';
  } catch (e) {
    slotEl.innerHTML = '';
  }
}

function getGameState() {
  try {
    if (window.taktikGame && typeof window.taktikGame.getState === 'function') {
      return window.taktikGame.getState() || null;
    }
    if (window.gameState) return window.gameState;
    if (window.currentGame) return window.currentGame;
  } catch (e) { /* ignore */ }
  return null;
}

function iterateParticipantTracks(participant, cb) {
  try {
    const tracks = participant?.tracks;
    if (!tracks) return;
    if (typeof tracks.forEach === 'function') {
      tracks.forEach(pub => cb(pub));
    } else if (Array.isArray(tracks)) {
      tracks.forEach(pub => cb(pub));
    } else if (tracks instanceof Map) {
      for (const v of tracks.values()) cb(v);
    }
  } catch (e) {
    dbgWarn('[live.js] iterateParticipantTracks error', e);
  }
}

function getPublicationId(pub) {
  return pub?.track?.sid || pub?.trackSid || pub?.sid || pub?.id || pub?.track?.id || `${pub?.participantSid || ''}:${pub?.track?.kind || ''}:${pub?.name || ''}`;
}

function getPublicationKind(pub) {
  return pub?.track?.kind || pub?.kind || (pub?.track && pub.track.kind) || 'unknown';
}

/** subscription bookkeeping helpers */
function markSubscribed(pub, participant) {
  const id = getPublicationId(pub);
  if (!id) return;
  if (!subscribedTracksMap.has(id)) {
    const kind = getPublicationKind(pub);
    subscribedTracksMap.set(id, { participantSid: participant?.sid ?? participant?.identity ?? null, kind });
    if (kind === 'video') subscribedVideoCount = subscribedVideoCount + 1;
    dbgLog('Subscribed -> added', id, 'kind=', kind, 'videoCount=', subscribedVideoCount);
  }
}
function markUnsubscribed(pub) {
  const id = getPublicationId(pub);
  if (!id) return;
  if (subscribedTracksMap.has(id)) {
    const meta = subscribedTracksMap.get(id) || {};
    if (meta.kind === 'video') subscribedVideoCount = Math.max(0, subscribedVideoCount - 1);
    subscribedTracksMap.delete(id);
    dbgLog('Unsubscribed -> removed', id, 'videoCount=', subscribedVideoCount);
  }
}

// --- stronger subscription attempts (remplacer la fonction existante) ---
async function trySubscribePublication(pub, participant) {
  if (!pub) return false;
  const id = getPublicationId(pub);
  dbgLog('trySubscribePublication for', id, { pubKeys: Object.keys(pub || {}), participantId: participant?.identity, participantSid: participant?.sid });

  // 1) preferred: pub.setSubscribed(true)
  try {
    if (typeof pub.setSubscribed === 'function') {
      await pub.setSubscribed(true);
      dbgLog('pub.setSubscribed(true) OK for', id);
      return true;
    }
  } catch (e) { dbgWarn('pub.setSubscribed(true) failed for', id, e); }

  // 2) older API: pub.subscribe()
  try {
    if (typeof pub.subscribe === 'function') {
      await pub.subscribe();
      dbgLog('pub.subscribe() OK for', id);
      return true;
    }
  } catch (e) { dbgWarn('pub.subscribe() failed for', id, e); }

  // 3) localParticipant.setSubscribed(publication/trackSid, true)
  try {
    const trackSid = pub?.trackSid ?? pub?.track?.sid ?? pub?.sid ?? null;
    if (liveRoom && liveRoom.localParticipant && typeof liveRoom.localParticipant.setSubscribed === 'function') {
      // try passing the whole pub first
      try {
        await liveRoom.localParticipant.setSubscribed(pub, true);
        dbgLog('localParticipant.setSubscribed(pub,true) OK for', id);
        return true;
      } catch (e) { dbgWarn('localParticipant.setSubscribed(pub,true) threw for', id, e); }
      // try with trackSid if available
      if (trackSid) {
        try {
          await liveRoom.localParticipant.setSubscribed(trackSid, true);
          dbgLog('localParticipant.setSubscribed(trackSid,true) OK for', id, trackSid);
          return true;
        } catch (e) { dbgWarn('localParticipant.setSubscribed(trackSid,true) failed for', id, e); }
      }
    }
  } catch (e) { dbgWarn('localParticipant.setSubscribed fallback error', e); }

  // 4) room-level setSubscribed / setSubscription attempts
  try {
    const trackSid = pub?.trackSid ?? pub?.track?.sid ?? pub?.sid ?? null;
    if (liveRoom && typeof liveRoom.setSubscribed === 'function') {
      try {
        await liveRoom.setSubscribed(pub, true);
        dbgLog('liveRoom.setSubscribed(pub,true) OK for', id);
        return true;
      } catch (e) { dbgWarn('liveRoom.setSubscribed(pub,true) threw', id, e); }
      if (trackSid) {
        try {
          await liveRoom.setSubscribed(trackSid, true);
          dbgLog('liveRoom.setSubscribed(trackSid,true) OK for', id, trackSid);
          return true;
        } catch (e) { dbgWarn('liveRoom.setSubscribed(trackSid,true) threw', id, e); }
      }
    }
  } catch (e) {}

  // 5) hook 'subscribed' event if available
  try {
    if (typeof pub.on === 'function') {
      const onSubscribed = (trackOrPub) => {
        try {
          dbgLog('publication subscribed event fired for', id);
          const publication = trackOrPub?.publication ? trackOrPub.publication : trackOrPub;
          const theTrack = publication?.track ?? publication;
          const gs = getGameState();
          const slot = participantToSlotIdentity(participant, gs);
          const slotEl = getSlotEl(slot);
          if (theTrack && typeof theTrack.attach === 'function') {
            attachTrackToSlot(theTrack, slotEl, { isLocalPreview: false });
            markSubscribed(publication, participant);
          }
        } catch (e) { dbgWarn('publication subscribed handler error', e); }
        try { if (typeof pub.off === 'function') pub.off('subscribed', onSubscribed); } catch (_) {}
      };
      try { pub.on('subscribed', onSubscribed); } catch (e) { dbgWarn('failed to register pub.subscribed listener', e); }
    }
  } catch (e) { dbgWarn('subscribe fallback register error', e); }

  // 6) last resort: attach if track already present
  try {
    const trackObj = pub?.track ?? pub;
    if (trackObj && typeof trackObj.attach === 'function') {
      const gs = getGameState();
      const slot = participantToSlotIdentity(participant, gs);
      const slotEl = getSlotEl(slot);
      attachTrackToSlot(trackObj, slotEl, { isLocalPreview: false });
      markSubscribed(pub, participant);
      dbgLog('Attached existing track as last-resort for', id);
      return true;
    }
  } catch (e) { dbgWarn('last-resort attach failed', e); }

  dbgWarn('Could not subscribe to publication via known APIs for', id);
  return false;
}

/** Handle a single publication according to role (robust subscribe/attach) */
async function handlePublication(pubOrTrack, participant, role) {
  try {
    const pub = pubOrTrack?.publication ? pubOrTrack.publication : pubOrTrack;
    const pubId = getPublicationId(pub);
    const pubKind = getPublicationKind(pub);
    const hasTrack = !!(pub && (pub.track || pub.trackSid));
    dbgLog('handlePublication invoked', { pubId, pubKind, hasTrack, participantIdentity: participant?.identity ?? participant?.sid });

    // If this is a video publication, ensure placeholder is shown immediately (fetch pseudo)
    try {
      if (pubKind === 'video') {
        const gs = getGameState();
        const slot = participantToSlotIdentity(participant, gs);
        const slotEl = getSlotEl(slot);
        // fetch pseudo asynchronously and show placeholder if not already attached
        (async () => {
          try {
            // if there's already a video element attached, skip placeholder
            const hasVideoEl = slotEl && slotEl.querySelector('video');
            if (hasVideoEl) return;
            const pseudo = await fetchPseudoForIdentity(participant?.identity ?? participant?.sid ?? participant?.name) || (participant?.identity ?? 'Anonyme');
            makeBroadcastPlaceholder(slotEl, pseudo, participant, pub);
          } catch (e) { dbgWarn('failed to show placeholder', e); }
        })();
      }
    } catch (e) { dbgWarn('placeholder scheduling failed', e); }

    // Try to subscribe (multiple API shapes)
    try {
      await trySubscribePublication(pub, participant);
    } catch (e) {
      dbgWarn('subscribe attempt error for', pubId, e);
    }

    // If publication already has a track object, attach immediately
    const trackObj = pub?.track ?? (pubOrTrack && pubOrTrack.kind ? pubOrTrack : null);
    if (trackObj && typeof trackObj.attach === 'function') {
      const gs = getGameState();
      const slot = participantToSlotIdentity(participant, gs);
      const slotEl = getSlotEl(slot);
      attachTrackToSlot(trackObj, slotEl, { isLocalPreview: false });
      markSubscribed(pub, participant);
      dbgLog('Attached track immediately for', pubId);
      return;
    }

    // Listen to publication-level events (subscribed / updated) for late arrival of the actual track
    try {
      if (pub && typeof pub.on === 'function') {
        const subscriber = (trackOrPub) => {
          try {
            const publication = trackOrPub?.publication ? trackOrPub.publication : trackOrPub;
            const theTrack = publication?.track ?? publication;
            const gs = getGameState();
            const slot = participantToSlotIdentity(participant, gs);
            const slotEl = getSlotEl(slot);
            if (theTrack && typeof theTrack.attach === 'function') {
              attachTrackToSlot(theTrack, slotEl, { isLocalPreview: false });
              markSubscribed(publication, participant);
              dbgLog('publication.on subscribed/updated attached for', getPublicationId(publication));
            } else {
              dbgWarn('publication event received but track.attach missing for', getPublicationId(publication));
            }
          } catch (e) { dbgWarn('publication event handler failed', e); }
          try { if (pub.off) pub.off('subscribed', subscriber); if (pub.off) pub.off('updated', subscriber); } catch (_) {}
        };
        try { pub.on('subscribed', subscriber); } catch (e) {}
        try { pub.on('updated', subscriber); } catch (e) {}
      }
    } catch (e) {
      dbgWarn('Failure setting up publication listeners for', pubId, e);
    }

    // Fallback: wait for participant's trackSubscribed event (some versions emit track there)
    try {
      if (participant && typeof participant.on === 'function') {
        const onceHandler = async (trackOrPub) => {
          try {
            const thePub = trackOrPub?.publication ? trackOrPub.publication : trackOrPub;
            const theTrack = thePub?.track ?? thePub;
            const gs = getGameState();
            const slot = participantToSlotIdentity(participant, gs);
            const slotEl = getSlotEl(slot);
            if (theTrack && typeof theTrack.attach === 'function') {
              attachTrackToSlot(theTrack, slotEl, { isLocalPreview: false });
              markSubscribed(thePub, participant);
              dbgLog('One-time trackSubscribed attached for', getPublicationId(thePub));
            } else {
              dbgWarn('trackSubscribed event received but track.attach missing for', getPublicationId(thePub));
            }
          } catch (e) { dbgWarn('one-time trackSubscribed handler failed', e); }
          try { if (participant.off) participant.off('trackSubscribed', onceHandler); } catch (_) {}
        };
        try {
          participant.on('trackSubscribed', onceHandler);
        } catch (e) { dbgWarn('failed to register trackSubscribed one-time handler', e); }
      } else {
        dbgWarn('participant has no .on to wait for trackSubscribed; cannot attach later for', pubId);
      }
    } catch (e) {
      dbgWarn('Failure setting up fallback trackSubscribed handler for', pubId, e);
    }

  } catch (e) {
    dbgWarn('[live.js] handlePublication failed', e);
  }
}

async function handleParticipant(participant, gameState, role) {
  try {
    // iterate current publications (or track entries)
    iterateParticipantTracks(participant, (pub) => {
      try {
        if (!pub) return;
        handlePublication(pub, participant, role);
      } catch (e) { dbgWarn('handleParticipant iterate error', e); }
    });

    // support multiple event shapes: trackPublished (publication created), trackSubscribed, trackUnsubscribed
    if (participant?.on) {
      participant.on('trackPublished', (pub) => {
        try { handlePublication(pub, participant, role); } catch (e) { dbgWarn('trackPublished handler error', e); }
      });

      participant.on('trackSubscribed', async (trackOrPub) => {
        try {
          const pub = trackOrPub?.publication ? trackOrPub.publication : trackOrPub;
          await handlePublication(pub, participant, role);
        } catch (e) { dbgWarn('trackSubscribed handler failed', e); }
      });

      participant.on('trackUnsubscribed', (publishedTrackOrPub) => {
        try {
          const pub = publishedTrackOrPub?.publication ? publishedTrackOrPub.publication : publishedTrackOrPub;
          markUnsubscribed(pub);
          const slot = participantToSlotIdentity(participant, gameState);
          const slotEl = getSlotEl(slot);
          // clear slot if nothing left (simple strategy)
          clearSlot(slotEl);
        } catch (e) { dbgWarn('trackUnsubscribed handler failed', e); }
      });

      participant.on('disconnected', () => {
        try {
          const slot = participantToSlotIdentity(participant, getGameState());
          const slotEl = getSlotEl(slot);
          clearSlot(slotEl);
          for (const [id, meta] of Array.from(subscribedTracksMap.entries())) {
            if (meta.participantSid && participant && (participant.sid === meta.participantSid || participant.identity === meta.participantSid)) {
              if (meta.kind === 'video') subscribedVideoCount = Math.max(0, subscribedVideoCount - 1);
              subscribedTracksMap.delete(id);
            }
          }
        } catch (e) { dbgWarn('participant disconnected handler failed', e); }
      });
    }

  } catch (e) {
    dbgWarn('[live.js] handleParticipant failed', e);
  }
}

/** Subscribe to all existing participants (robust) */
async function subscribeExistingParticipants(room, role) {
  if (!room) return;
  const gs = getGameState();
  try {
    if (typeof room.participants.forEach === 'function') {
      room.participants.forEach(p => handleParticipant(p, gs, role));
    } else if (Array.isArray(room.participants)) {
      room.participants.forEach(p => handleParticipant(p, gs, role));
    } else if (room.participants instanceof Map) {
      for (const p of room.participants.values()) handleParticipant(p, gs, role);
    }
  } catch (e) {
    dbgWarn('[live.js] subscribeExistingParticipants error', e);
  }
}

/**
 * After connect, perform additional passes to ensure publications published before join get subscribed:
 * - retries a few times with small delays, calling trySubscribePublication on discovered publications.
 */
async function ensureAttachRetries(room, role, attempts = 3, delayMs = 700) {
  if (!room) return;
  for (let i = 0; i < attempts; i++) {
    try {
      dbgLog(`ensureAttachRetries pass ${i+1}/${attempts}`);
      if (room.participants instanceof Map) {
        for (const participant of room.participants.values()) {
          try {
            iterateParticipantTracks(participant, (pub) => {
              try {
                // strong attempt to subscribe + attach
                trySubscribePublication(pub, participant).catch(e => dbgWarn('retry subscribe failed', e));
              } catch (e) { dbgWarn('iterate pub retry failed', e); }
            });
          } catch (e) { dbgWarn('participant iterate during retry failed', e); }
        }
      } else if (Array.isArray(room.participants)) {
        for (const participant of room.participants) {
          iterateParticipantTracks(participant, (pub) => {
            trySubscribePublication(pub, participant).catch(e => dbgWarn('retry subscribe failed', e));
          });
        }
      } else if (typeof room.participants.forEach === 'function') {
        room.participants.forEach(p => {
          iterateParticipantTracks(p, (pub) => {
            trySubscribePublication(pub, p).catch(e => dbgWarn('retry subscribe failed', e));
          });
        });
      }
    } catch (e) { dbgWarn('ensureAttachRetries main loop failed', e); }
    // pause between attempts
    await new Promise(r => setTimeout(r, delayMs));
  }
}

async function requestLivekitTokenForGame(gameId) {
  if (!gameId) {
    dbgError('requestLivekitTokenForGame called without gameId');
    throw new Error('gameId required');
  }

  const endpoint = window.LIVEKIT_TOKEN_ENDPOINT || DEFAULT_LIVEKIT_TOKEN_ENDPOINT;
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set('game_id', gameId);

  let accessToken = null;
  try {
    if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
      const sess = await window.supabase.auth.getSession();
      const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
      accessToken = data?.access_token ?? data?.accessToken ?? null;
      dbgLog('Supabase access token resolved?', !!accessToken);
    }
  } catch (e) {
    dbgWarn('[live.js] getSession failed', e);
  }

  const headers = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  dbgLog('Requesting LiveKit token from', url.toString());
  const resp = await fetch(url.toString(), { method: 'GET', headers, credentials: 'include' });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    dbgError(`Token request failed: ${resp.status} ${resp.statusText} ${txt}`);
    throw new Error(`Token request failed: ${resp.status} ${resp.statusText} ${txt}`);
  }
  const json = await resp.json().catch((e) => {
    dbgError('Failed to parse token response JSON', e);
    throw e;
  });
  dbgLog('Token response', json);
  return json;
}

async function connectAndJoin(roomName, identity, gameId) {
  dbgLog('connectAndJoin', { roomName, identity, gameId });

  const LK = await dynamicImportLivekit();
  dbgLog('livekit module keys:', Object.keys(LK || {}));

  let tokenResp;
  if (gameId) {
    try {
      tokenResp = await requestLivekitTokenForGame(gameId);
    } catch (e) {
      dbgError('requestLivekitTokenForGame failed', e);
      throw e;
    }
  } else {
    const endpoint = window.LIVEKIT_TOKEN_ENDPOINT || DEFAULT_LIVEKIT_TOKEN_ENDPOINT;
    const url = new URL(endpoint, window.location.origin);
    if (roomName) url.searchParams.set('room', roomName);
    if (identity) url.searchParams.set('identity', identity);
    let accessToken = null;
    try {
      const sess = await window.supabase.auth.getSession();
      const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
      accessToken = data?.access_token ?? data?.accessToken ?? null;
    } catch (e) {}
    const headers = accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {};
    dbgLog('Fetching token (fallback) from', url.toString());
    const resp = await fetch(url.toString(), { headers, credentials: 'include' });
    if (!resp.ok) {
      dbgError('token fetch failed (fallback):', resp.status, resp.statusText);
      throw new Error('token fetch failed: ' + resp.statusText);
    }
    tokenResp = await resp.json();
  }

  const token = tokenResp?.token || tokenResp?.accessToken || tokenResp?.access_token;
  const urlStr = tokenResp?.livekit_url || tokenResp?.url || tokenResp?.liveKitUrl;
  const role = (tokenResp?.role || tokenResp?.app?.role || 'spectateur').toLowerCase?.() ?? 'spectateur';
  window.__livekit_role = role;
  dbgLog('window.__livekit_role set to', role);

  if (!token || !urlStr) {
    dbgError('token or livekit_url missing in token response', tokenResp);
    throw new Error('token or livekit_url missing in response');
  }

  dbgLog('Resolved role from token response:', role);

  // reset subscription bookkeeping on (re)connect
  subscribedTracksMap.clear();
  subscribedVideoCount = 0;

  dbgLog('Attempting to connect to LiveKit server', urlStr, 'roomName', roomName, 'role', role);

  // Force autoSubscribe true so clients will receive the owner/opponent/moderator streams
  const autoSubscribe = true;

  // 1) If module exposes a top-level connect function (older style)
  if (typeof LK.connect === 'function') {
    try {
      const room = await LK.connect(urlStr, token, { autoSubscribe });
      liveRoom = room;
      dbgLog('Connected via LK.connect (autoSubscribe=' + autoSubscribe + ')');
      dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
      await subscribeExistingParticipants(room, role);
      // on new participant, handle and attempt immediate subscribe
      room?.on && room.on('participantConnected', async (p) => {
        try { handleParticipant(p, getGameState(), role); }
        catch (e) { dbgWarn('participantConnected handler error', e); }
      });
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
      // ensure retries to pick up streams published before our join
      ensureAttachRetries(room, role, 4, 600).catch(e => dbgWarn('ensureAttachRetries failed', e));
      return room;
    } catch (e) {
      dbgWarn('LK.connect failed, trying alternate shapes', e);
    }
  }

  // 2) If module exports Room class: new Room(); await room.connect(...)
  const RoomClass = LK.Room || LK.default?.Room || LK.default;
  if (typeof RoomClass === 'function') {
    try {
      const room = new RoomClass();
      if (typeof room.connect === 'function') {
        await room.connect(urlStr, token, { autoSubscribe });
      } else if (typeof room.join === 'function') {
        await room.join(urlStr, token, { autoSubscribe });
      } else {
        throw new Error('Room API connect/join not found');
      }
      liveRoom = room;
      dbgLog('Connected via new Room().connect (autoSubscribe=' + autoSubscribe + ')');
      dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
      await subscribeExistingParticipants(room, role);
      room?.on && room.on('participantConnected', async (p) => {
        try { handleParticipant(p, getGameState(), role); }
        catch (e) { dbgWarn('participantConnected handler error', e); }
      });
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
      ensureAttachRetries(room, role, 4, 600).catch(e => dbgWarn('ensureAttachRetries failed', e));
      return room;
    } catch (e) {
      dbgWarn('Room.connect flow failed', e);
    }
  }

  // 3) If UMD preloaded on window (window.LivekitClient) — try that
  if (window.LivekitClient) {
    dbgLog('Trying window.LivekitClient (UMD) for connection');
    const WK = window.LivekitClient;
    try {
      if (typeof WK.connect === 'function') {
        const room = await WK.connect(urlStr, token, { autoSubscribe });
        liveRoom = room;
        dbgLog('Connected via window.LivekitClient.connect');
        dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
        await subscribeExistingParticipants(room, role);
        room?.on && room.on('participantConnected', async (p) => {
          try { handleParticipant(p, getGameState(), role); }
          catch (e) { dbgWarn('participantConnected handler error', e); }
        });
        room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
        ensureAttachRetries(room, role, 4, 600).catch(e => dbgWarn('ensureAttachRetries failed', e));
        return room;
      } else if (typeof WK.Room === 'function') {
        const room = new WK.Room();
        if (typeof room.connect === 'function') {
          await room.connect(urlStr, token, { autoSubscribe });
        } else if (typeof room.join === 'function') {
          await room.join(urlStr, token, { autoSubscribe });
        }
        liveRoom = room;
        dbgLog('Connected via new window.LivekitClient.Room().connect');
        dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
        await subscribeExistingParticipants(room, role);
        room?.on && room.on('participantConnected', async (p) => {
          try { handleParticipant(p, getGameState(), role); }
          catch (e) { dbgWarn('participantConnected handler error', e); }
        });
        room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
        ensureAttachRetries(room, role, 4, 600).catch(e => dbgWarn('ensureAttachRetries failed', e));
        return room;
      }
    } catch (e) {
      dbgWarn('window.LivekitClient connection attempt failed', e);
    }
  }

  dbgError('livekit connect not available on imported module', { keys: Object.keys(LK || {}), windowLivekit: !!window.LivekitClient });
  throw new Error('livekit connect not available on imported module');
}

async function startPublish() {
  if (currentlyPublishing) {
    dbgLog('Already publishing');
    return true;
  }

  try {
    dbgLog('startPublish called');

    // get user id
    let userId = null;
    try {
      if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
        const sess = await window.supabase.auth.getSession();
        const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
        userId = data?.user?.id ?? data?.userId ?? data?.user_id ?? null;
        userId = safeToString(userId);
        dbgLog('Resolved userId', userId);
      }
    } catch (e) { dbgWarn('getSession error', e); }

    if (!userId) {
      dbgError('Utilisateur non connecté (startPublish)');
      throw new Error('Utilisateur non connecté');
    }

    const gs = getGameState();
    const gameId = gs?.id ?? gs?.gameId ?? gs?.game_id ?? null;
    if (!gameId) {
      dbgError('gameId introuvable (nécessaire pour token)');
      throw new Error('gameId introuvable (nécessaire pour token)');
    }

    const roomName = `game-${gameId}`;
    dbgLog('Will join room', roomName);

    if (!liveRoom) {
      try {
        await connectAndJoin(roomName, userId, gameId);
      } catch (e) {
        dbgError('connectAndJoin failed', e);
        throw e;
      }
    }

    const LK = await dynamicImportLivekit();
    const createLocalVideoTrack = LK.createLocalVideoTrack || LK.default?.createLocalVideoTrack || LK.LocalVideoTrack?.create;
    const createLocalAudioTrack = LK.createLocalAudioTrack || LK.default?.createLocalAudioTrack || LK.LocalAudioTrack?.create;
    if (typeof createLocalVideoTrack !== 'function' || typeof createLocalAudioTrack !== 'function') {
      dbgError('createLocalVideoTrack / createLocalAudioTrack non disponibles dans le module LiveKit importé');
      throw new Error('createLocalVideoTrack / createLocalAudioTrack non disponibles');
    }

    try {
      dbgLog('Creating local video track (will request camera permission)...');
      localVideoTrack = await createLocalVideoTrack({ resolution: 'qvga' });
      dbgLog('Local video track created');
    } catch (e) {
      dbgError('Failed to create local video track (camera permission?)', e);
      throw e;
    }

    try {
      dbgLog('Creating local audio track (will request microphone permission if needed)...');
      localAudioTrack = await createLocalAudioTrack();
      dbgLog('Local audio track created');
    } catch (e) {
      dbgWarn('Failed to create local audio track (microphone permission?)', e);
      localAudioTrack = null;
    }

    if (!liveRoom || !liveRoom.localParticipant) {
      dbgError('Non connecté à la room après création des tracks');
      throw new Error('Non connecté à la room');
    }

    // publish safely (API variations)
    if (typeof liveRoom.localParticipant.publishTrack === 'function') {
      try {
        if (localVideoTrack) await liveRoom.localParticipant.publishTrack(localVideoTrack);
      } catch (err) {
        dbgWarn('publishTrack video failed, trying publish fallback', err);
        if (typeof liveRoom.localParticipant.publish === 'function' && localVideoTrack) {
          await liveRoom.localParticipant.publish([localVideoTrack]);
        }
      }
      try {
        if (localAudioTrack) await liveRoom.localParticipant.publishTrack(localAudioTrack);
      } catch (err) {
        dbgWarn('publishTrack audio failed, trying publish fallback', err);
        if (typeof liveRoom.localParticipant.publish === 'function' && localAudioTrack) {
          await liveRoom.localParticipant.publish([localAudioTrack]);
        }
      }
    } else if (typeof liveRoom.localParticipant.publish === 'function') {
      const toPublish = [];
      if (localVideoTrack) toPublish.push(localVideoTrack);
      if (localAudioTrack) toPublish.push(localAudioTrack);
      if (toPublish.length) await liveRoom.localParticipant.publish(toPublish);
    } else {
      dbgWarn('[live.js] publish API non trouvée');
    }

    currentlyPublishing = true;

    // preview attach into correct slot
    const ownerId = gs && (gs.owner_id ?? gs.ownerId ?? gs.owner);
    const opponentId = gs && (gs.opponent_id ?? gs.opponentId ?? gs.opponent);
    const userIdStr = safeToString(userId);
    const slotKey = (gs && userIdStr === safeToString(ownerId)) ? 'owner'
                   : (gs && userIdStr === safeToString(opponentId)) ? 'opponent'
                   : 'moderator';
    const slotEl = getSlotEl(slotKey);
    attachTrackToSlot(localVideoTrack, slotEl, { isLocalPreview: true });
    attachTrackToSlot(localAudioTrack, slotEl, { isLocalPreview: true });

    dbgLog('Publishing as', slotKey);
    dbgAlert('Diffusion démarrée en tant que ' + slotKey);
    return true;

  } catch (e) {
    dbgError('[live.js] startPublish error', e);
    try { if (localVideoTrack && localVideoTrack.stop) localVideoTrack.stop(); } catch(_) {}
    try { if (localAudioTrack && localAudioTrack.stop) localAudioTrack.stop(); } catch(_) {}
    localVideoTrack = null;
    localAudioTrack = null;
    currentlyPublishing = false;
    throw e;
  }
}

async function stopPublish() {
  if (!currentlyPublishing && !liveRoom) {
    dbgLog('Not publishing — nothing to stop');
    return;
  }

  try {
    dbgLog('stopPublish called');

    if (liveRoom && liveRoom.localParticipant) {
      const pubs = liveRoom.localParticipant.tracks;
      if (pubs) {
        if (typeof pubs.forEach === 'function') {
          pubs.forEach(pub => {
            try {
              if (pub.unpublish) pub.unpublish();
              const t = pub.track ?? pub;
              if (t && typeof t.detach === 'function') {
                const els = t.detach();
                if (els && typeof els.forEach === 'function') els.forEach(el => el.remove());
              }
            } catch(_) {}
          });
        } else if (Array.isArray(pubs)) {
          pubs.forEach(pub => {
            try {
              if (pub.unpublish) pub.unpublish();
              const t = pub.track ?? pub;
              if (t && typeof t.detach === 'function') {
                const els = t.detach();
                if (els && typeof els.forEach === 'function') els.forEach(el => el.remove());
              }
            } catch(_) {}
          });
        }
      }

      try {
        if (typeof liveRoom.localParticipant.unpublishTrack === 'function') {
          if (localVideoTrack) await liveRoom.localParticipant.unpublishTrack(localVideoTrack);
          if (localAudioTrack) await liveRoom.localParticipant.unpublishTrack(localAudioTrack);
        }
      } catch (_) {}
    }

    try { if (localVideoTrack && typeof localVideoTrack.stop === 'function') localVideoTrack.stop(); } catch(_) {}
    try { if (localAudioTrack && typeof localAudioTrack.stop === 'function') localAudioTrack.stop(); } catch(_) {}

    const gs = getGameState();
    let userId = null;
    try {
      if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
        const sess = await window.supabase.auth.getSession();
        const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
        userId = data?.user?.id ?? null;
        userId = safeToString(userId);
      }
    } catch (e) { dbgWarn('getSession error while stopping', e); }

    const ownerId = gs && (gs.owner_id ?? gs.ownerId ?? gs.owner);
    const opponentId = gs && (gs.opponent_id ?? gs.opponentId ?? gs.opponent);
    const userIdStr = safeToString(userId);
    const slotKey = (gs && userIdStr === safeToString(ownerId)) ? 'owner'
                   : (gs && userIdStr === safeToString(opponentId)) ? 'opponent'
                   : 'moderator';
    const slotEl = getSlotEl(slotKey);
    clearSlot(slotEl);

    localVideoTrack = null;
    localAudioTrack = null;
    currentlyPublishing = false;

    subscribedTracksMap.clear();
    subscribedVideoCount = 0;

    dbgLog('Stopped publishing');
    dbgAlert('Diffusion stoppée');
  } catch (e) {
    dbgWarn('[live.js] stopPublish error', e);
  }
}

async function disconnectRoom() {
  if (!liveRoom) return;
  try {
    if (typeof liveRoom.disconnect === 'function') await liveRoom.disconnect();
    else if (typeof liveRoom.close === 'function') await liveRoom.close();
  } catch (e) { dbgWarn('[live.js] disconnect error', e); }
  liveRoom = null;
  currentlyPublishing = false;
  subscribedTracksMap.clear();
  subscribedVideoCount = 0;
  dbgLog('Disconnected room and cleared state');
}

// Expose API for fab.js and debugging
window.livekit = window.livekit || {
  startPublish,
  stopPublish,
  disconnectRoom,
  isPublishing: () => !!currentlyPublishing,
  getRoom: () => liveRoom,
  connectRoom: async (roomName, identity, gameId) => connectAndJoin(roomName, identity, gameId),
  toggleVideo: (logicalName, enabled) => { /* no-op by default */ },
  toggleMiniMap: (enabled) => { /* no-op by default */ },
  waitForReady: waitForLivekit,
  toggleSlotMute: (logicalName) => {
    try {
      const slotEl = getSlotEl(logicalName);
      if (!slotEl) return false;
      const btn = slotEl.querySelector('.lk-mute-btn');
      if (!btn) return false;
      btn.click();
      return true;
    } catch (e) { dbgWarn('toggleSlotMute failed', e); return false; }
  }
};

try { window.liveManager = window.liveManager || window.livekit; } catch (e) { /* ignore */ }

try {
  const cs = document.currentScript;
  if (cs && cs.tagName === 'SCRIPT') {
    cs.setAttribute('data-loaded', '1');
  } else {
    const s = Array.from(document.querySelectorAll('script[type="module"]'))
      .find(sc => sc.src && sc.src.includes('live.js'));
    if (s) s.setAttribute('data-loaded', '1');
  }
} catch (e) { /* ignore */ }

dbgLog('live.js initialized (dbg=' + (dbg ? 'true' : 'false') + ')');

// --- auto-connect au chargement pour ré-attacher les flux après refresh ---
// --- autoConnectOnLoad with retries to wait for supabase session / identity ---
(async function autoConnectOnLoad(){
  try {
    if (liveRoom) return;
    await waitForLivekit(4000);

    const gs = getGameState();
    if (!gs || !gs.id) {
      if (dbg) dbgLog('autoConnectOnLoad: no gameState / id found, aborting');
      return;
    }

    // Retry logic to obtain identity (supabase session might not be ready immediately)
    let identity = null;
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
          const sess = await window.supabase.auth.getSession();
          const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
          identity = data?.user?.id ?? null;
          if (identity) { dbgLog('autoConnectOnLoad: supabase session found on attempt', attempt); break; }
        }
      } catch (e) { dbgWarn('autoConnectOnLoad: supabase getSession error', e); }

      // fallback to global vars
      identity = window.currentUserId || window.userId || identity || null;
      if (identity) { dbgLog('autoConnectOnLoad: identity resolved from window variable', identity); break; }

      // wait then retry
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 400 * attempt)); // backoff
      }
    }

    if (!identity) {
      dbgWarn('autoConnectOnLoad: identity not resolved after retries; skipping connect');
      return;
    }

    const roomName = `game-${gs.id}`;
    dbgLog('autoConnectOnLoad: attempting connect', roomName, identity, gs.id);
    try {
      await connectAndJoin(roomName, identity, gs.id);
      dbgLog('autoConnectOnLoad: connectAndJoin succeeded');
      // extra: after join, schedule extra retries to ensure late publishers are attached
      ensureAttachRetries(liveRoom, window.__livekit_role || 'spectator', 6, 900).catch(e => dbgWarn('ensureAttachRetries failed', e));
    } catch (e) {
      dbgWarn('autoConnectOnLoad: connect failed', e);
    }
  } catch (e) {
    dbgWarn('autoConnectOnLoad failed', e);
  }
})();

