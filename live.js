// live.js
// Gestion LiveKit — attache les vidéos dans les slots existants (#player1Video, #player2Video, #moderatorVideo)
// Usage: <script type="module" src="./live.js"></script>
/* global window, document, console, alert */

const dbg = true; // <-- mettre à false pour désactiver les alertes de debug/console
function dbgLog(...args) { if (!dbg) return; try { console.info('[live.js][DBG]', ...args); } catch (e) {} }
function dbgWarn(...args) { if (!dbg) return; try { console.warn('[live.js][WARN]', ...args); } catch (e) {} }
function dbgError(...args) { if (!dbg) return; try { console.error('[live.js][ERROR]', ...args); } catch (e) {} try { if (dbg) alert('[live.js] ERROR: ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (e) {} }
function dbgAlert(...args) { if (!dbg) return; try { alert('[live.js] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (e) {} }

// helper: attendre que window.livekit / window.LivekitClient soit prêt (timeout en ms)
// exposé via window.livekit.waitForReady
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
// we will treat video subscriptions as the scarce resource (limit = 3).
// audio subscriptions are always allowed (so everyone can hear audio streams).
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
    return String(raw).replace(/^(user[:\-_]|u[:\-_])/i, '').trim();
  } catch (e) {
    return '';
  }
}

function participantToSlotIdentity(participant, gameState) {
  const ident = normalizeIdentity(participant?.identity ?? participant?.sid ?? participant?.name ?? '');
  if (dbg) dbgLog('participantToSlotIdentity:', { ident, participant });
  if (!gameState) return 'moderator';

  const ownerId = safeToString(gameState.owner_id ?? gameState.ownerId ?? gameState.owner ?? '');
  const opponentId = safeToString(gameState.opponent_id ?? gameState.opponentId ?? gameState.opponent ?? '');

  const normOwner = normalizeIdentity(ownerId);
  const normOpponent = normalizeIdentity(opponentId);

  if (ident && normOwner && ident === normOwner) return 'owner';
  if (ident && normOpponent && ident === normOpponent) return 'opponent';
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
    // ensure there's a mute button (so user can mute audio for this slot)
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
  // clear and append
  slotEl.innerHTML = '';
  slotEl.appendChild(video);
  ensureSlotMuteButton(slotEl);
  return video;
}

function ensureAudioElement(slotEl) {
  // for audio we may attach to the same slot (invisibly) or create an <audio> in body
  let audio = slotEl ? slotEl.querySelector('audio[data-livekit-audio]') : null;
  if (audio) {
    audio.autoplay = true;
    audio.controls = false;
    // keep visually hidden in slot (we use a custom mute button), but present in DOM for playback
    audio.style.display = 'none';
    return audio;
  }
  audio = document.createElement('audio');
  audio.setAttribute('data-livekit-audio', '1');
  audio.autoplay = true;
  audio.controls = false;
  // hidden (we control via our own button) but will still play
  audio.style.display = 'none';
  // default to unmuted so users hear streams unless they mute
  audio.muted = false;
  if (slotEl) {
    slotEl.appendChild(audio);
    // ensure mute button exists for user control
    ensureSlotMuteButton(slotEl);
  } else {
    // audio not associated with a visual slot -> attach to body but keep a global 'mute all remote audio' controller
    document.body.appendChild(audio);
    ensureGlobalAudioController();
  }
  return audio;
}

/** Create or ensure a mute button in a slot.
 *  The button toggles the muted property on audio elements inside that slot.
 *  It is a client-side mute (local playback mute) so users can mute any participant's audio locally.
 */
function ensureSlotMuteButton(slotEl) {
  if (!slotEl) return;
  // avoid creating multiple times
  if (slotEl.querySelector('.lk-mute-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lk-mute-btn';
  btn.setAttribute('aria-label', 'Couper le son du participant');
  btn.title = 'Couper / activer le son localement';
  // inline minimal style so this works without external CSS
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
  // ensure the slot is positioned to allow absolute child
  try {
    const cs = getComputedStyle(slotEl);
    if (cs && cs.position === 'static') slotEl.style.position = 'relative';
  } catch (e) {}
  // initial state: unmuted
  slotEl.dataset.lkMuted = 'false';

  btn.addEventListener('click', () => {
    const isMuted = slotEl.dataset.lkMuted === 'true';
    const newMuted = !isMuted;
    // toggle all audio elements inside slot
    const audios = Array.from(slotEl.querySelectorAll('audio'));
    audios.forEach(a => {
      try { a.muted = newMuted; } catch (e) {}
    });
    slotEl.dataset.lkMuted = newMuted ? 'true' : 'false';
    btn.textContent = newMuted ? '🔇' : '🔊';
  });

  slotEl.appendChild(btn);
}

/** Global audio controller for audio elements not associated with a visual slot.
 *  Creates a small floating 'Mute all remote audio' button.
 */
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

/** Attach track to slot (handles audio/video tracks) */
function attachTrackToSlot(track, slotEl, { isLocalPreview = false } = {}) {
  if (!track) return;
  try {
    // track.attach can accept an element param in many LiveKit versions
    // If it's a video track and slotEl available, attach to the video element
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
        // fallback: if attach not available but track has element property
        dbgWarn('[live.js] video track.attach not available; skipping attach');
      }
      // ensure there's a mute button for any incoming audio that may belong to same participant
      ensureSlotMuteButton(slotEl);
    } else if (kind === 'audio') {
      // attach to a hidden audio element under slotEl (so sound plays)
      const audioEl = ensureAudioElement(slotEl || document.body);
      if (typeof track.attach === 'function') {
        const maybeEl = track.attach(audioEl);
        // if attach returned element, replace; otherwise keep audioEl
        if (maybeEl && maybeEl !== audioEl) {
          try { audioEl.remove(); } catch(_) {}
          (slotEl || document.body).appendChild(maybeEl);
          // mark returned audio element for our controller
          try { maybeEl.setAttribute('data-livekit-audio', '1'); } catch(e) {}
        } else {
          if (!(slotEl || document.body).contains(audioEl)) {
            (slotEl || document.body).appendChild(audioEl);
          }
        }
      } else {
        dbgWarn('[live.js] audio track.attach not available; skipping attach');
      }
      // ensure slot mute button or global control exists
      if (slotEl) ensureSlotMuteButton(slotEl); else ensureGlobalAudioController();
    } else {
      // generic attach if unknown kind
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
    const vids = Array.from(slotEl.querySelectorAll('video,canvas,audio,button.lk-mute-btn'));
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

/** Manage subscription bookkeeping (increment/decrement) safely
 *  We track all pubs in subscribedTracksMap but only count video pubs for subscription limit.
 */
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

/**
 * Decide if a spectator may subscribe to a publication.
 *
 * - Audio subscriptions should be always allowed for everyone (so everyone can hear streams).
 * - Video subscriptions are limited client-side to avoid excessive streams (limit = 3).
 * - Always allow subscriptions to owner/opponent/moderator slots for video/audio.
 */
/* LIGNE 438 -> 458 : remplacement de spectatorMaySubscribe */
function spectatorMaySubscribe(pub, participant) {
  const kind = getPublicationKind(pub);
  if (!['video', 'audio'].includes(kind)) return false;

  const gs = getGameState();
  try {
    // 1) d'abord essayer avec l'objet participant fourni
    let slot = null;
    try {
      slot = participantToSlotIdentity(participant, gs);
    } catch (e) {
      // ignore
    }

    // 2) si pas de participant, essayer d'inférer à partir de la publication (participantSid / participantIdentity / owner metadata)
    if (!slot && pub) {
      const pubOwnerIdent = normalizeIdentity(pub.participantSid ?? pub.participantIdentity ?? pub.owner ?? pub.publisher ?? '');
      if (pubOwnerIdent) {
        const normOwner = normalizeIdentity(gs?.owner_id ?? gs?.ownerId ?? gs?.owner ?? '');
        const normOpponent = normalizeIdentity(gs?.opponent_id ?? gs?.opponentId ?? gs?.opponent ?? '');
        if (pubOwnerIdent === normOwner) slot = 'owner';
        else if (pubOwnerIdent === normOpponent) slot = 'opponent';
      }
    }

    // Always allow owner/opponent/moderator publications (video or audio)
    if (['owner', 'opponent', 'moderator'].includes(slot)) return true;
  } catch (e) {
    dbgWarn('spectatorMaySubscribe: participantToSlotIdentity failed', e);
  }

  // For audio: always allow (so spectators can hear everyone)
  if (kind === 'audio') return true;

  // For video: enforce the 3-video-subscription limit
  if (subscribedVideoCount < 3) return true;
  return false;
}


/** Try to disable subscription on a publication using multiple API variants */
async function disableSubscriptionOnPub(pub) {
  try {
    if (!pub) return;
    // preferred: setSubscribed(false)
    if (typeof pub.setSubscribed === 'function') {
      try { await pub.setSubscribed(false); dbgLog('Called pub.setSubscribed(false)'); return; } catch(e) { dbgWarn('pub.setSubscribed(false) failed', e); }
    }
    // older variants: unsubscribe / unsubscribeTrack
    if (typeof pub.unsubscribe === 'function') {
      try { await pub.unsubscribe(); dbgLog('Called pub.unsubscribe()'); return; } catch(e) { dbgWarn('pub.unsubscribe failed', e); }
    }
    // As fallback, detach any attached elements so user won't see stream
    try {
      const track = pub.track ?? pub;
      if (track && typeof track.detach === 'function') {
        const els = track.detach();
        if (els && typeof els.forEach === 'function') els.forEach(el => el.remove());
        else if (els && els.remove) els.remove();
        dbgLog('Detached elements for pub as fallback');
      }
    } catch (e) {
      dbgWarn('Failed to detach fallback', e);
    }
  } catch (e) {
    dbgWarn('disableSubscriptionOnPub unexpected', e);
  }
}

/** Handle a single publication according to role (spectator limit enforcement) */
async function handlePublication(pub, participant, role) {
  try {
    const isSubscribed = (pub.isSubscribed ?? true);
    const kind = getPublicationKind(pub);

    // If spectator, enforce limit but always allow owner/opponent/moderator pubs
    if (role === 'spectateur') {
      if (isSubscribed) {
        if (!spectatorMaySubscribe(pub, participant)) {
          dbgLog('Spectator: already at limit, disabling subscription for', getPublicationId(pub), 'kind=', kind);
          await disableSubscriptionOnPub(pub);
          markUnsubscribed(pub);
          return;
        }
      } else {
        // not yet subscribed — decide whether to subscribe
        if (!spectatorMaySubscribe(pub, participant)) {
          dbgLog('Spectator: skip subscribe (limit reached) for', getPublicationId(pub));
          return;
        }
        // allowed: try to subscribe
        try {
          if (typeof pub.setSubscribed === 'function') {
            await pub.setSubscribed(true);
          } else if (typeof pub.subscribe === 'function') {
            await pub.subscribe();
          } // else nothing to call, hope autoSubscribe handled it
        } catch (e) {
          dbgWarn('subscribe attempt failed or not available', e);
        }
      }
    }

    // If subscribed (or after we attempted to subscribe), attach if available
    /* LIGNE 525 -> 533 : remplacement dans handlePublication (attacher aussi l'audio du même participant) */
    const track = pub.track ?? pub;
    const isNowSubscribed = (pub.isSubscribed ?? true);
    if (track && isNowSubscribed) {
      // choose slot for attach: prefer player slots for owner/opponent, else moderator
      const gameState = getGameState();
      const slot = participantToSlotIdentity(participant, gameState);
      const slotEl = getSlotEl(slot);

      // attach the publication's track (video or audio)
      attachTrackToSlot(track, slotEl, { isLocalPreview: false });
      markSubscribed(pub, participant);

      // If this was a video publication, attempt to attach the participant's audio pubs to the same slot
      try {
        if (getPublicationKind(pub) === 'video' && participant) {
          const tks = participant.tracks;
          if (tks) {
            // iterate participant.tracks in a compatible way (Map | Array | forEach)
            if (typeof tks.forEach === 'function') {
              tks.forEach((pubCandidate) => {
                try {
                  if (getPublicationKind(pubCandidate) === 'audio') {
                    const audioTrack = pubCandidate.track ?? pubCandidate;
                    attachTrackToSlot(audioTrack, slotEl, { isLocalPreview: false });
                    markSubscribed(pubCandidate, participant);
                  }
                } catch (e) { /* ignore per-track errors */ }
              });
            } else if (Array.isArray(tks)) {
              tks.forEach((pubCandidate) => {
                try {
                  if (getPublicationKind(pubCandidate) === 'audio') {
                    const audioTrack = pubCandidate.track ?? pubCandidate;
                    attachTrackToSlot(audioTrack, slotEl, { isLocalPreview: false });
                    markSubscribed(pubCandidate, participant);
                  }
                } catch (e) {}
              });
            } else if (tks instanceof Map) {
              for (const pubCandidate of tks.values()) {
                try {
                  if (getPublicationKind(pubCandidate) === 'audio') {
                    const audioTrack = pubCandidate.track ?? pubCandidate;
                    attachTrackToSlot(audioTrack, slotEl, { isLocalPreview: false });
                    markSubscribed(pubCandidate, participant);
                  }
                } catch (e) {}
              }
            }
          }
        }
      } catch (e) { /* ignore errors */ }
    }
    }
  } catch (e) {
    dbgWarn('[live.js] handlePublication failed', e);
  }
}

async function handleParticipant(participant, gameState, role) {
  try {
    // iterate current publications
    iterateParticipantTracks(participant, (pub) => {
      try {
        if (!pub) return;
        // in some shapes pub is the track directly
        handlePublication(pub, participant, role);
      } catch (e) { dbgWarn('handleParticipant iterate error', e); }
    });

    // subscribe to dynamic events (trackSubscribed / trackUnsubscribed)
    participant?.on && participant.on('trackSubscribed', async (trackPubOrTrack) => {
      try {
        // livekit's event sometimes sends publication, sometimes track
        const pub = trackPubOrTrack?.publication ? trackPubOrTrack.publication : trackPubOrTrack;
        await handlePublication(pub, participant, role);
      } catch (e) { dbgWarn('trackSubscribed handler failed', e); }
    });

    participant?.on && participant.on('trackUnsubscribed', (publishedTrackOrPub) => {
      try {
        const pub = publishedTrackOrPub?.publication ? publishedTrackOrPub.publication : publishedTrackOrPub;
        markUnsubscribed(pub);
        const slot = participantToSlotIdentity(participant, gameState);
        const slotEl = getSlotEl(slot);
        // clear slot only if no other publications for same participant remain attached
        // simplistic: clear slot to avoid stale element (UI may handle multiple)
        clearSlot(slotEl);
      } catch (e) { dbgWarn('trackUnsubscribed handler failed', e); }
    });

    participant?.on && participant.on('disconnected', () => {
      try {
        const slot = participantToSlotIdentity(participant, getGameState());
        const slotEl = getSlotEl(slot);
        clearSlot(slotEl);
        // mark all pubs belonging to this participant as removed
        // simple sweep:
        for (const [id, meta] of Array.from(subscribedTracksMap.entries())) {
          if (meta.participantSid && participant && (participant.sid === meta.participantSid || participant.identity === meta.participantSid)) {
            if (meta.kind === 'video') subscribedVideoCount = Math.max(0, subscribedVideoCount - 1);
            subscribedTracksMap.delete(id);
          }
        }
      } catch (e) { dbgWarn('participant disconnected handler failed', e); }
    });

  } catch (e) {
    dbgWarn('[live.js] handleParticipant failed', e);
  }
}

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

  // load the livekit module (prefers window.LivekitClient if preloaded)
  const LK = await dynamicImportLivekit();
  dbgLog('livekit module keys:', Object.keys(LK || {}));

  // token retrieval (same as before)
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
  if (!token || !urlStr) {
    dbgError('token or livekit_url missing in token response', tokenResp);
    throw new Error('token or livekit_url missing in response');
  }

  dbgLog('Resolved role from token response:', role);

  // reset subscription bookkeeping on (re)connect
  subscribedTracksMap.clear();
  subscribedVideoCount = 0;

  // --- CONNECT: try several shapes of API ---
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
      room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState(), role));
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
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
      // some Room.connect accept options third param, some expect object
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
      room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState(), role));
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
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
        room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState(), role));
        room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
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
        room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState(), role));
        room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
        return room;
      }
    } catch (e) {
      dbgWarn('window.LivekitClient connection attempt failed', e);
    }
  }

  // If we reach here, none of the expected shapes existed
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

    // create local tracks (muted preview)
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
    // also attach local audio preview so user hears their mic locally if desired
    attachTrackToSlot(localAudioTrack, slotEl, { isLocalPreview: true });

    dbgLog('Publishing as', slotKey);
    dbgAlert('Diffusion démarrée en tant que ' + slotKey);
    return true;

  } catch (e) {
    dbgError('[live.js] startPublish error', e);
    // cleanup partial state
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

    // clear subscription bookkeeping
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
  // clear bookkeeping
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
  // helper to mute/unmute a slot from other scripts (logicalName = 'owner'|'opponent'|'moderator')
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

// Backwards compatibility alias (some modules expect window.liveManager)
try { window.liveManager = window.liveManager || window.livekit; } catch (e) { /* ignore */ }

// mark script as loaded
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
