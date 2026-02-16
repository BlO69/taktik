// live.js (version corrigée)
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

// Default slot ids (modifie si tes slots ont d'autres ids)
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

/**
 * Retourne 'owner' | 'opponent' | 'moderator' | null
 * IMPORTANT: retourne null si gameState absent pour permettre le fallback per-participant
 */
function participantToSlotIdentity(participant, gameState) {
  const ident = normalizeIdentity(participant?.identity ?? participant?.sid ?? participant?.name ?? '');
  if (dbg) dbgLog('participantToSlotIdentity:', { ident, participant });

  // si on a un gameState, utiliser les owner/opponent explicitement
  if (gameState) {
    const ownerId = safeToString(gameState.owner_id ?? gameState.ownerId ?? gameState.owner ?? '');
    const opponentId = safeToString(gameState.opponent_id ?? gameState.opponentId ?? gameState.opponent ?? '');

    const normOwner = normalizeIdentity(ownerId);
    const normOpponent = normalizeIdentity(opponentId);

    if (ident && normOwner && ident === normOwner) return 'owner';
    if (ident && normOpponent && ident === normOpponent) return 'opponent';
    return 'moderator';
  }

  // si pas de gameState, essayer d'inférer via participant meta (fallback)
  // si on ne peut rien deviner renvoyer null pour que le code crée un container fallback
  return null;
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

/** sanitize an id string to valid DOM id */
function sanitizeId(s) {
  try {
    return String(s || '').replace(/[^\w\-]/g, '_').slice(0, 128);
  } catch (e) {
    return 'p_unknown';
  }
}

/** get or create a per-participant container inside #allParticipants (fallback) */
function getOrCreateParticipantContainer(participant) {
  const ident = sanitizeId(participant?.identity ?? participant?.sid ?? participant?.name ?? ('p_' + Math.random().toString(36).slice(2,8)));
  const containerId = `participant_${ident}`;
  let el = document.getElementById(containerId);
  if (el) return el;

  let parent = document.getElementById('allParticipants');
  if (!parent) {
    parent = document.createElement('div');
    parent.id = 'allParticipants';
    parent.style.display = 'flex';
    parent.style.gap = '0.5rem';
    parent.style.flexWrap = 'wrap';
    parent.style.marginTop = '0.5rem';
    try { document.body.appendChild(parent); } catch (e) { document.documentElement.appendChild(parent); }
  }

  el = document.createElement('div');
  el.id = containerId;
  el.className = 'participant-slot';
  el.style.width = '240px';
  el.style.height = '180px';
  el.style.overflow = 'hidden';
  el.style.borderRadius = '0.5rem';
  el.style.background = '#000';
  el.style.position = 'relative';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';

  const label = document.createElement('div');
  label.textContent = participant?.identity ?? participant?.sid ?? 'participant';
  label.style.position = 'absolute';
  label.style.left = '0.25rem';
  label.style.bottom = '0.25rem';
  label.style.zIndex = '10';
  label.style.color = '#fff';
  label.style.fontSize = '12px';
  label.style.background = 'rgba(0,0,0,0.35)';
  label.style.padding = '2px 6px';
  label.style.borderRadius = '4px';
  el.appendChild(label);

  parent.appendChild(el);
  return el;
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
  // initial state: muted to avoid autoplay block; user can unmute
  slotEl.dataset.lkMuted = 'true';

  btn.addEventListener('click', () => {
    const isMuted = slotEl.dataset.lkMuted === 'true';
    const newMuted = !isMuted;
    // toggle all audio elements inside slot
    const audios = Array.from(slotEl.querySelectorAll('audio[data-livekit-audio]'));
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
  btn.textContent = '🔇 audio (tap to unmute)';
  btn.dataset.lkMuted = 'true';

  btn.addEventListener('click', () => {
    const isMuted = btn.dataset.lkMuted === 'true';
    const newMuted = !isMuted;
    const audios = Array.from(document.querySelectorAll('audio[data-livekit-audio]'));
    audios.forEach(a => {
      try { a.muted = newMuted; } catch (e) {}
    });
    btn.dataset.lkMuted = newMuted ? 'true' : 'false';
    btn.textContent = newMuted ? '🔇 audio' : '🔊 audio';
    // also update per-slot buttons state for UX
    document.querySelectorAll('[data-livekit-audio]').forEach(el => {
      const slot = el.closest('.participant-slot');
      if (slot) {
        const btn = slot.querySelector('.lk-mute-btn');
        if (btn) btn.textContent = newMuted ? '🔇' : '🔊';
        slot.dataset.lkMuted = newMuted ? 'true' : 'false';
      }
    });
  });

  document.body.appendChild(btn);
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
  // audio elements are always created with data-livekit-audio attribute
  let audio = slotEl ? slotEl.querySelector('audio[data-livekit-audio]') : null;
  if (audio) {
    audio.autoplay = true;
    audio.controls = false;
    audio.style.display = 'none';
    // default muted = true to avoid autoplay policy blocks; user can unmute via controls
    audio.muted = true;
    return audio;
  }
  audio = document.createElement('audio');
  audio.setAttribute('data-livekit-audio', '1');
  audio.autoplay = true;
  audio.controls = false;
  audio.style.display = 'none';
  audio.muted = true; // initially muted until user action
  if (slotEl) {
    slotEl.appendChild(audio);
    ensureSlotMuteButton(slotEl);
  } else {
    document.body.appendChild(audio);
    ensureGlobalAudioController();
  }
  return audio;
}

/** Attach track to slot (handles audio/video tracks). If slotEl is null, the caller must pass a fallback container. */
function attachTrackToSlot(track, slotEl, { isLocalPreview = false } = {}) {
  if (!track) return;
  try {
    const kind = track.kind ?? (track.track && track.track.kind) ?? 'unknown';
    // If no slotEl provided, create fallback per-participant container if participant info is embedded
    if (!slotEl) {
      dbgWarn('attachTrackToSlot called without slotEl — caller should provide fallback container');
      return;
    }

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

/** Manage subscription bookkeeping (increment/decrement) safely */
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
 *
 * NOTE: current policy: allow everything to avoid missing streams for owner/opponent.
 */
function spectatorMaySubscribe(pub, participant) {
  const kind = getPublicationKind(pub);
  if (!['video', 'audio'].includes(kind)) return false;
  return true;
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

/** Handle single publication and attach related audio pubs to same slot when video arrives
 *  We force subscription when possible (pub.setSubscribed(true)) — this fixes owner/opponent not seeing each other.
 */
async function handlePublication(pub, participant, role) {
  try {
    if (dbg) {
      try {
        dbgLog('handlePublication invoked', {
          pubId: getPublicationId(pub),
          pubKind: getPublicationKind(pub),
          hasTrack: !!(pub && (pub.track || pub.trackSid)),
          isSubscribed: pub?.isSubscribed,
          participantIdentity: participant?.identity ?? participant?.sid
        });
      } catch (e) {}
    }

    const kind = getPublicationKind(pub);

    // Toujours tenter de s'abonner si possible (plus robuste pour owner/opponent).
    try {
      if (!pub?.isSubscribed) {
        if (typeof pub.setSubscribed === 'function') {
          await pub.setSubscribed(true);
          dbgLog('Called pub.setSubscribed(true) for', getPublicationId(pub));
        } else if (typeof pub.subscribe === 'function') {
          await pub.subscribe();
          dbgLog('Called pub.subscribe() for', getPublicationId(pub));
        } else if (liveRoom && typeof liveRoom.localParticipant?.setSubscribed === 'function') {
          try {
            await liveRoom.localParticipant.setSubscribed(pub, true);
            dbgLog('Called localParticipant.setSubscribed(pub, true) as fallback for', getPublicationId(pub));
          } catch (_) {}
        } else {
          dbgLog('No subscribe API available for pub', getPublicationId(pub));
        }
      }
    } catch (e) {
      dbgWarn('subscribe attempt error for pub', getPublicationId(pub), e);
    }

    // prepare slot (prefer owner/opponent/moderator DOM slots; fallback otherwise)
    const trackObj = pub?.track ?? pub;
    const gs = getGameState();
    const slotName = participantToSlotIdentity(participant, gs);
    let slotEl = slotName ? getSlotEl(slotName) : null;
    if (!slotEl) {
      slotEl = getOrCreateParticipantContainer(participant);
    }

    // if track already available, attach immediately
    if (trackObj && typeof trackObj.attach === 'function') {
      attachTrackToSlot(trackObj, slotEl, { isLocalPreview: false });
      markSubscribed(pub, participant);
    } else {
      // otherwise wait for 'trackSubscribed' event on participant
      try {
        if (participant && typeof participant.on === 'function') {
          const onceHandler = async (trackOrPub) => {
            try {
              const thePub = trackOrPub?.publication ? trackOrPub.publication : trackOrPub;
              const theTrack = thePub?.track ?? thePub;
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
          dbgWarn('participant has no .on to wait for trackSubscribed; cannot attach later for', getPublicationId(pub));
        }
      } catch (e) {
        dbgWarn('Failure setting up fallback trackSubscribed handler for', getPublicationId(pub), e);
      }
    }

    // if we attached a video, also try to attach any audio publication from same participant to same slot
    try {
      if (getPublicationKind(pub) === 'video' && participant) {
        const tks = participant.tracks;
        if (tks) {
          if (typeof tks.forEach === 'function') {
            tks.forEach((pubCandidate) => {
              try {
                if (getPublicationKind(pubCandidate) === 'audio') {
                  const audioTrack = pubCandidate.track ?? pubCandidate;
                  attachTrackToSlot(audioTrack, slotEl, { isLocalPreview: false });
                  markSubscribed(pubCandidate, participant);
                }
              } catch (e) {}
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
    } catch (e) { /* ignore */ }

  } catch (e) {
    dbgWarn('[live.js] handlePublication failed', e);
  }
}

async function handleParticipant(participant, gameState, role) {
  try {
    iterateParticipantTracks(participant, (pub) => {
      try {
        if (!pub) return;
        handlePublication(pub, participant, role);
      } catch (e) { dbgWarn('handleParticipant iterate error', e); }
    });

    participant?.on && participant.on('trackSubscribed', async (trackPubOrTrack) => {
      try {
        const pub = trackPubOrTrack?.publication ? trackPubOrTrack.publication : trackPubOrTrack;
        await handlePublication(pub, participant, role);
      } catch (e) { dbgWarn('trackSubscribed handler failed', e); }
    });

    participant?.on && participant.on('trackUnsubscribed', (publishedTrackOrPub) => {
      try {
        const pub = publishedTrackOrPub?.publication ? publishedTrackOrPub.publication : publishedTrackOrPub;
        markUnsubscribed(pub);
        const slotName = participantToSlotIdentity(participant, gameState);
        const slotEl = slotName ? getSlotEl(slotName) : document.getElementById(`participant_${sanitizeId(participant?.identity)}`);
        clearSlot(slotEl);
      } catch (e) { dbgWarn('trackUnsubscribed handler failed', e); }
    });

    participant?.on && participant.on('disconnected', () => {
      try {
        const slotName = participantToSlotIdentity(participant, getGameState());
        const slotEl = slotName ? getSlotEl(slotName) : document.getElementById(`participant_${sanitizeId(participant?.identity)}`);
        clearSlot(slotEl);
        // cleanup subscribedTracksMap entries for this participant
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
  // expose le rôle local pour la logique de subscription côté client
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
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot) || document.getElementById(`participant_${sanitizeId(p?.identity)}`)); });
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
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot) || document.getElementById(`participant_${sanitizeId(p?.identity)}`)); });
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
        room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot) || document.getElementById(`participant_${sanitizeId(p?.identity)}`)); });
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
        room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot) || document.getElementById(`participant_${sanitizeId(p?.identity)}`)); });
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

/* --- Publishing (startPublish / stopPublish) ---
   On laisse la logique générique : obtention du token, création tracks locaux et publish.
   Si tu veux que je fusionne ou adapte ta logique actuelle de publish (par ex. contraintes de caméra/micro),
   dis-le et je l'intègre. Ci-dessous un squelette robuste.
*/

async function startPublish(options = {}) {
  if (currentlyPublishing) {
    dbgLog('Already publishing');
    return true;
  }

  try {
    dbgLog('startPublish called');
    // Example: get local tracks and publish to liveRoom
    // (Cette partie doit s'aligner sur ta logique existante ; garde l'API générique ci-dessous.)
    const LK = await dynamicImportLivekit();
    if (!liveRoom) {
      dbgWarn('startPublish: no liveRoom yet; call connectAndJoin first');
      return false;
    }

    // try to create local tracks (camera + mic) using LiveKit helper if available
    try {
      if (LK && LK.createLocalVideoTrack && LK.createLocalAudioTrack) {
        localVideoTrack = await LK.createLocalVideoTrack();
        localAudioTrack = await LK.createLocalAudioTrack();
      } else if (liveRoom && liveRoom.localParticipant && liveRoom.localParticipant.createLocalVideoTrack) {
        localVideoTrack = await liveRoom.localParticipant.createLocalVideoTrack();
        localAudioTrack = await liveRoom.localParticipant.createLocalAudioTrack();
      } else {
        dbgWarn('No standardized createLocal*Track API found; skipping local track creation');
      }

      if (localVideoTrack && liveRoom?.localParticipant?.publishTrack) {
        await liveRoom.localParticipant.publishTrack(localVideoTrack);
      } else if (localVideoTrack && typeof liveRoom.localParticipant?.publish === 'function') {
        await liveRoom.localParticipant.publish(localVideoTrack);
      }

      if (localAudioTrack && liveRoom?.localParticipant?.publishTrack) {
        await liveRoom.localParticipant.publishTrack(localAudioTrack);
      } else if (localAudioTrack && typeof liveRoom.localParticipant?.publish === 'function') {
        await liveRoom.localParticipant.publish(localAudioTrack);
      }

      currentlyPublishing = true;
      dbgLog('Publishing started', { hasVideo: !!localVideoTrack, hasAudio: !!localAudioTrack });
      return true;
    } catch (e) {
      dbgWarn('startPublish internal error', e);
      return false;
    }

  } catch (e) {
    dbgWarn('startPublish failed', e);
    return false;
  }
}

async function stopPublish() {
  try {
    if (!currentlyPublishing) return;
    dbgLog('stopPublish called');
    if (localVideoTrack && typeof localVideoTrack.stop === 'function') {
      try { localVideoTrack.stop(); } catch (e) {}
    }
    if (localAudioTrack && typeof localAudioTrack.stop === 'function') {
      try { localAudioTrack.stop(); } catch (e) {}
    }
    // attempt to unpublish if API available
    try {
      if (liveRoom?.localParticipant?.unpublishTrack && localVideoTrack) {
        await liveRoom.localParticipant.unpublishTrack(localVideoTrack);
      }
      if (liveRoom?.localParticipant?.unpublishTrack && localAudioTrack) {
        await liveRoom.localParticipant.unpublishTrack(localAudioTrack);
      }
    } catch (e) { dbgWarn('unpublish attempt failed', e); }

    localVideoTrack = null;
    localAudioTrack = null;
    currentlyPublishing = false;
    dbgLog('Publishing stopped');
  } catch (e) {
    dbgWarn('stopPublish failed', e);
  }
}

/* --- Expose some helpers globally for integration with other scripts --- */
window.livekit = window.livekit || {};
window.livekit.connectAndJoin = connectAndJoin;
window.livekit.startPublish = startPublish;
window.livekit.stopPublish = stopPublish;
window.livekit.ensureGlobalAudioController = ensureGlobalAudioController;
window.livekit.getOrCreateParticipantContainer = getOrCreateParticipantContainer;

// Auto-init: if page provides room/identity/game info on window, try to connect automatically.
// (Si tu préfères désactiver l'auto-connect, supprime ou commente ce bloc.)
(async () => {
  try {
    // allow a short delay for other scripts to set window.currentGame, window.LIVEKIT_TOKEN_ENDPOINT, etc.
    await new Promise(r => setTimeout(r, 120));
    const gs = getGameState();
    const roomName = window.LIVEKIT_ROOM || (gs?.room || gs?.id || null);
    const identity = window.LIVEKIT_IDENTITY || (window?.supabase?.auth?.user?.id ?? null) || null;
    if (roomName && identity) {
      dbgLog('Auto-connecting to LiveKit using room/identity from page', { roomName, identity });
      try {
        await connectAndJoin(roomName, identity, gs?.id ?? gs?.gameId ?? null);
      } catch (e) {
        dbgWarn('Auto connect failed', e);
      }
    } else {
      dbgLog('Auto-connect skipped; missing roomName/identity', { roomName, identity });
    }
  } catch (e) {
    dbgWarn('live.js auto-init failed', e);
  }
})();

dbgLog('live.js loaded and ready (dbg=' + (!!dbg) + ')');
dbgAlert('live.js chargé (dbg=' + (!!dbg) + '). Si tu ne vois pas un flux, regarde les alertes pour raison.');
