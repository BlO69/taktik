// live.js (merged patched)
// Gestion LiveKit — attache les vidéos dans les slots existants (#player1Video, #player2Video, #moderatorVideo)
// Version : merge patch (participantToSlotIdentity null fallback, getOrCreateParticipantContainer, unified handlePublication, dbg=true + alerts)
/* global window, document, console, alert */

const dbg = true; // <-- garder true pendant debug ; mettre false en prod
function dbgLog(...args) { if (!dbg) return; try { console.info('[live.js][DBG]', ...args); } catch (e) {} }
function dbgWarn(...args) { if (!dbg) return; try { console.warn('[live.js][WARN]', ...args); } catch (e) {} }
function dbgError(...args) { if (!dbg) return; try { console.error('[live.js][ERROR]', ...args); } catch (e) {} try { if (dbg) alert('[live.js] ERROR: ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (e) {} }
function dbgAlert(...args) { if (!dbg) return; try { alert('[live.js] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (e) {} }

// wait for LiveKit client object availability
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

// bookkeeping
let subscribedTracksMap = new Map();
let subscribedVideoCount = 0;

const VIDEO_SLOT_IDS = {
  owner: 'player1Video',
  opponent: 'player2Video',
  moderator: 'moderatorVideo'
};

const DEFAULT_LIVEKIT_TOKEN_ENDPOINT = 'https://mvkfawtnvahxqwcbcfkb.supabase.co/functions/v1/get_livekit_token';

function log(...args) { dbgLog(...args); }

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
function sanitizeId(s) {
  try {
    return String(s || '').replace(/[^\w\-]/g, '_').slice(0, 128);
  } catch (e) {
    return 'p_unknown';
  }
}

/** Retourne 'owner' | 'opponent' | 'moderator' | null
 *  IMPORTANT: retourne null si gameState absent pour permettre fallback per-participant.
 */
function participantToSlotIdentity(participant, gameState) {
  const ident = normalizeIdentity(participant?.identity ?? participant?.sid ?? participant?.name ?? '');
  if (dbg) dbgLog('participantToSlotIdentity:', { ident, participant });
  if (!gameState) return null; // <-- changement : retourner null quand gameState absent

  const ownerId = safeToString(gameState.owner_id ?? gameState.ownerId ?? gameState.owner ?? '');
  const opponentId = safeToString(gameState.opponent_id ?? gameState.opponentId ?? gameState.opponent ?? '');

  const normOwner = normalizeIdentity(ownerId);
  const normOpponent = normalizeIdentity(opponentId);

  if (ident && normOwner && ident === normOwner) return 'owner';
  if (ident && normOpponent && ident === normOpponent) return 'opponent';
  return 'moderator';
}

function getSlotEl(slotKey) {
  const id = VIDEO_SLOT_IDS[slotKey];
  if (!id) return null;
  return document.getElementById(id) || null;
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
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '13px';
  btn.textContent = '🔊';
  try {
    const cs = getComputedStyle(slotEl);
    if (cs && cs.position === 'static') slotEl.style.position = 'relative';
  } catch (e) {}
  slotEl.dataset.lkMuted = 'true'; // default muted to avoid autoplay issues on Android
  btn.addEventListener('click', () => {
    const isMuted = slotEl.dataset.lkMuted === 'true';
    const newMuted = !isMuted;
    const audios = Array.from(slotEl.querySelectorAll('audio[data-livekit-audio]'));
    audios.forEach(a => { try { a.muted = newMuted; } catch (e) {} });
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
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '14px';
  btn.textContent = '🔇 audio (tap to unmute)';
  btn.dataset.lkMuted = 'true';
  btn.addEventListener('click', () => {
    const isMuted = btn.dataset.lkMuted === 'true';
    const newMuted = !isMuted;
    const audios = Array.from(document.querySelectorAll('audio[data-livekit-audio]'));
    audios.forEach(a => { try { a.muted = newMuted; } catch (e) {} });
    btn.dataset.lkMuted = newMuted ? 'true' : 'false';
    btn.textContent = newMuted ? '🔇 audio' : '🔊 audio';
    document.querySelectorAll('[data-livekit-audio]').forEach(el => {
      const slot = el.closest('.participant-slot');
      if (slot) {
        const b = slot.querySelector('.lk-mute-btn');
        if (b) b.textContent = newMuted ? '🔇' : '🔊';
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
  let audio = slotEl ? slotEl.querySelector('audio[data-livekit-audio]') : null;
  if (audio) {
    audio.autoplay = true;
    audio.controls = false;
    audio.style.display = 'none';
    audio.muted = true; // default muted until user action (Android autoplay)
    return audio;
  }
  audio = document.createElement('audio');
  audio.setAttribute('data-livekit-audio', '1');
  audio.autoplay = true;
  audio.controls = false;
  audio.style.display = 'none';
  audio.muted = true;
  if (slotEl) {
    slotEl.appendChild(audio);
    ensureSlotMuteButton(slotEl);
  } else {
    document.body.appendChild(audio);
    ensureGlobalAudioController();
  }
  return audio;
}

function attachTrackToSlot(track, slotEl, { isLocalPreview = false } = {}) {
  if (!track) return;
  try {
    const kind = track.kind ?? (track.track && track.track.kind) ?? 'unknown';
    if (!slotEl) {
      dbgWarn('attachTrackToSlot called without slotEl — use getOrCreateParticipantContainer fallback');
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

/** spectator gating logic (audio always allowed; video limit client-side) */
function spectatorMaySubscribe(pub, participant) {
  const kind = getPublicationKind(pub);
  if (!['video', 'audio'].includes(kind)) return false;

  const gs = getGameState();
  try {
    let slot = null;
    try { slot = participantToSlotIdentity(participant, gs); } catch (e) {}
    if (!slot && pub) {
      const pubOwnerIdent = normalizeIdentity(pub.participantSid ?? pub.participantIdentity ?? pub.owner ?? pub.publisher ?? '');
      if (pubOwnerIdent) {
        const normOwner = normalizeIdentity(gs?.owner_id ?? gs?.ownerId ?? gs?.owner ?? '');
        const normOpponent = normalizeIdentity(gs?.opponent_id ?? gs?.opponentId ?? gs?.opponent ?? '');
        if (pubOwnerIdent === normOwner) slot = 'owner';
        else if (pubOwnerIdent === normOpponent) slot = 'opponent';
      }
    }
    if (['owner', 'opponent', 'moderator'].includes(slot)) return true;
  } catch (e) {
    dbgWarn('spectatorMaySubscribe: participantToSlotIdentity failed', e);
  }

  if (kind === 'audio') return true;
  if (subscribedVideoCount < 3) return true;
  return false;
}

async function disableSubscriptionOnPub(pub) {
  try {
    if (!pub) return;
    if (typeof pub.setSubscribed === 'function') {
      try { await pub.setSubscribed(false); dbgLog('Called pub.setSubscribed(false)'); return; } catch(e) { dbgWarn('pub.setSubscribed(false) failed', e); }
    }
    if (typeof pub.unsubscribe === 'function') {
      try { await pub.unsubscribe(); dbgLog('Called pub.unsubscribe()'); return; } catch(e) { dbgWarn('pub.unsubscribe failed', e); }
    }
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

/**
 * Unified handlePublication:
 *  - If client is spectator => apply spectatorMaySubscribe gating.
 *  - If client is NOT spectator => force subscribe attempt (setSubscribed(true)/subscribe()) when possible.
 *  - Attach track immediately when available, otherwise register for trackSubscribed and attach to correct slot.
 *  - Use getOrCreateParticipantContainer(participant) as fallback when no game slot known.
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
    const spectatorNames = ['spectator', 'spectateur', 'viewer'];
    const isLocalSpectator = spectatorNames.includes((role || '').toLowerCase?.() ?? 'spectator');

    if (isLocalSpectator) {
      if ((pub.isSubscribed ?? false)) {
        if (!spectatorMaySubscribe(pub, participant)) {
          dbgLog('Spectator: already at limit, disabling subscription for', getPublicationId(pub), 'kind=', kind);
          await disableSubscriptionOnPub(pub);
          markUnsubscribed(pub);
          return;
        }
      } else {
        if (!spectatorMaySubscribe(pub, participant)) {
          dbgLog('Spectator: skip subscribe (limit reached) for', getPublicationId(pub));
          return;
        }
        try {
          if (typeof pub.setSubscribed === 'function') {
            await pub.setSubscribed(true);
            dbgLog('Spectator: requested setSubscribed(true) for', getPublicationId(pub));
          } else if (typeof pub.subscribe === 'function') {
            await pub.subscribe();
            dbgLog('Spectator: requested subscribe() for', getPublicationId(pub));
          }
        } catch (e) {
          dbgWarn('Spectator subscribe attempt failed or not available', e);
        }
      }
    } else {
      // Non-spectator: attempt to ensure subscription
      try {
        if (!pub?.isSubscribed) {
          if (typeof pub.setSubscribed === 'function') {
            await pub.setSubscribed(true);
            dbgLog('Requested pub.setSubscribed(true) for', getPublicationId(pub));
          } else if (typeof pub.subscribe === 'function') {
            await pub.subscribe();
            dbgLog('Requested pub.subscribe() for', getPublicationId(pub));
          } else if (liveRoom && typeof liveRoom.localParticipant?.setSubscribed === 'function') {
            try { await liveRoom.localParticipant.setSubscribed(pub, true); } catch (_) {}
          } else {
            dbgLog('No subscribe API available for pub', getPublicationId(pub));
          }
        }
      } catch (e) {
        dbgWarn('subscribe attempt error for pub', getPublicationId(pub), e);
      }
    }

    // If track available now, attach immediately
    const track = pub.track ?? pub;
    const isNowSubscribed = (pub.isSubscribed ?? true);
    if (track && isNowSubscribed) {
      const gameState = getGameState();
      const slotName = participantToSlotIdentity(participant, gameState);
      let slotEl = slotName ? getSlotEl(slotName) : null;
      if (!slotEl) slotEl = getOrCreateParticipantContainer(participant);

      attachTrackToSlot(track, slotEl, { isLocalPreview: false });
      markSubscribed(pub, participant);

      // attach participant audio pubs to same slot when video arrives
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
      return;
    }

    // Otherwise wait for trackSubscribed events on participant
    try {
      if (participant && typeof participant.on === 'function') {
        const onceHandler = async (trackOrPub) => {
          try {
            const thePub = trackOrPub?.publication ? trackOrPub.publication : trackOrPub;
            const theTrack = thePub?.track ?? thePub;
            const gs = getGameState();
            const slot = participantToSlotIdentity(participant, gs);
            let slotEl = slot ? getSlotEl(slot) : null;
            if (!slotEl) slotEl = getOrCreateParticipantContainer(participant);
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
        try { participant.on('trackSubscribed', onceHandler); } catch (e) { dbgWarn('failed to register trackSubscribed one-time handler', e); }
      } else {
        dbgWarn('participant has no .on to wait for trackSubscribed; cannot attach later for', getPublicationId(pub));
      }
    } catch (e) {
      dbgWarn('Failure setting up fallback trackSubscribed handler for', getPublicationId(pub), e);
    }

  } catch (e) {
    dbgWarn('[live.js] handlePublication failed', e);
  }
}

async function handleParticipant(participant, gameState, role) {
  try {
    iterateParticipantTracks(participant, (pub) => {
      try { if (!pub) return; handlePublication(pub, participant, role); } catch (e) { dbgWarn('handleParticipant iterate error', e); }
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
  if (!gameId) { dbgError('requestLivekitTokenForGame called without gameId'); throw new Error('gameId required'); }
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
  } catch (e) { dbgWarn('[live.js] getSession failed', e); }

  const headers = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  dbgLog('Requesting LiveKit token from', url.toString());
  const resp = await fetch(url.toString(), { method: 'GET', headers, credentials: 'include' });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    dbgError(`Token request failed: ${resp.status} ${resp.statusText} ${txt}`);
    throw new Error(`Token request failed: ${resp.status} ${resp.statusText} ${txt}`);
  }
  const json = await resp.json().catch((e) => { dbgError('Failed to parse token response JSON', e); throw e; });
  dbgLog('Token response', json);
  return json;
}

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
      if (mod) { window.LivekitClient = mod; dbgLog('Dynamic import success for', url); return mod; }
    } catch (e) { dbgWarn('Dynamic import failed for', url, e); }
  }
  try {
    dbgLog('Attempting module-injection fallback to load LivekitClient');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.textContent = `import * as LK from '${candidates[0]}'; window.LivekitClient = LK;`;
      script.onload = () => { resolve(); };
      script.onerror = (e) => { reject(new Error('module-injection failed')); };
      document.head.appendChild(script);
      setTimeout(() => { if (window.LivekitClient) resolve(); else reject(new Error('module-injection timeout')); }, 3500);
    });
    if (window.LivekitClient) { dbgLog('Module-injection succeeded and LivekitClient available on window'); return window.LivekitClient; }
  } catch (e) { dbgWarn('Module-injection fallback failed', e); }
  dbgError('LivekitClient not found on window (script not loaded)');
  throw new Error('LivekitClient not loaded');
}

async function connectAndJoin(roomName, identity, gameId) {
  dbgLog('connectAndJoin', { roomName, identity, gameId });
  const LK = await dynamicImportLivekit();
  dbgLog('livekit module keys:', Object.keys(LK || {}));

  let tokenResp;
  if (gameId) {
    try { tokenResp = await requestLivekitTokenForGame(gameId); } catch (e) { dbgError('requestLivekitTokenForGame failed', e); throw e; }
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
    if (!resp.ok) { dbgError('token fetch failed (fallback):', resp.status, resp.statusText); throw new Error('token fetch failed: ' + resp.statusText); }
    tokenResp = await resp.json();
  }

  const token = tokenResp?.token || tokenResp?.accessToken || tokenResp?.access_token;
  const urlStr = tokenResp?.livekit_url || tokenResp?.url || tokenResp?.liveKitUrl;
  const role = (tokenResp?.role || tokenResp?.app?.role || 'spectateur').toLowerCase?.() ?? 'spectateur';
  window.__livekit_role = role;
  dbgLog('Resolved role from token response:', role);

  if (!token || !urlStr) { dbgError('token or livekit_url missing in token response', tokenResp); throw new Error('token or livekit_url missing in response'); }

  subscribedTracksMap.clear();
  subscribedVideoCount = 0;

  const autoSubscribe = true;

  // Try different shapes of API
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
    } catch (e) { dbgWarn('LK.connect failed, trying alternate shapes', e); }
  }

  const RoomClass = LK.Room || LK.default?.Room || LK.default;
  if (typeof RoomClass === 'function') {
    try {
      const room = new RoomClass();
      if (typeof room.connect === 'function') {
        await room.connect(urlStr, token, { autoSubscribe });
      } else if (typeof room.join === 'function') {
        await room.join(urlStr, token, { autoSubscribe });
      } else { throw new Error('Room API connect/join not found'); }
      liveRoom = room;
      dbgLog('Connected via new Room().connect (autoSubscribe=' + autoSubscribe + ')');
      dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
      await subscribeExistingParticipants(room, role);
      room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState(), role));
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot) || document.getElementById(`participant_${sanitizeId(p?.identity)}`)); });
      return room;
    } catch (e) { dbgWarn('Room.connect flow failed', e); }
  }

  if (window.LivekitClient) {
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
    } catch (e) { dbgWarn('window.LivekitClient connection attempt failed', e); }
  }

  dbgError('livekit connect not available on imported module', { keys: Object.keys(LK || {}), windowLivekit: !!window.LivekitClient });
  throw new Error('livekit connect not available on imported module');
}

async function startPublish() {
  if (currentlyPublishing) { dbgLog('Already publishing'); return true; }
  try {
    dbgLog('startPublish called');

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

    if (!userId) { dbgError('Utilisateur non connecté (startPublish)'); throw new Error('Utilisateur non connecté'); }

    const gs = getGameState();
    const gameId = gs?.id ?? gs?.gameId ?? gs?.game_id ?? null;
    if (!gameId) { dbgError('gameId introuvable (nécessaire pour token)'); throw new Error('gameId introuvable (nécessaire pour token)'); }

    const roomName = `game-${gameId}`;
    dbgLog('Will join room', roomName);

    if (!liveRoom) {
      try { await connectAndJoin(roomName, userId, gameId); } catch (e) { dbgError('connectAndJoin failed', e); throw e; }
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

    // publish using whichever API available
    if (typeof liveRoom.localParticipant.publishTrack === 'function') {
      try { if (localVideoTrack) await liveRoom.localParticipant.publishTrack(localVideoTrack); } catch (err) { dbgWarn('publishTrack video failed, trying publish fallback', err); if (typeof liveRoom.localParticipant.publish === 'function' && localVideoTrack) await liveRoom.localParticipant.publish([localVideoTrack]); }
      try { if (localAudioTrack) await liveRoom.localParticipant.publishTrack(localAudioTrack); } catch (err) { dbgWarn('publishTrack audio failed, trying publish fallback', err); if (typeof liveRoom.localParticipant.publish === 'function' && localAudioTrack) await liveRoom.localParticipant.publish([localAudioTrack]); }
    } else if (typeof liveRoom.localParticipant.publish === 'function') {
      const toPublish = [];
      if (localVideoTrack) toPublish.push(localVideoTrack);
      if (localAudioTrack) toPublish.push(localAudioTrack);
      if (toPublish.length) await liveRoom.localParticipant.publish(toPublish);
    } else {
      dbgWarn('[live.js] publish API non trouvée');
    }

    currentlyPublishing = true;

    // attach local preview into appropriate slot or fallback container
    const ownerId = gs && (gs.owner_id ?? gs.ownerId ?? gs.owner);
    const opponentId = gs && (gs.opponent_id ?? gs.opponentId ?? gs.opponent);
    const userIdStr = safeToString(userId);
    const slotKey = (gs && userIdStr === safeToString(ownerId)) ? 'owner'
                   : (gs && userIdStr === safeToString(opponentId)) ? 'opponent'
                   : 'moderator';
    let slotEl = getSlotEl(slotKey);
    if (!slotEl) slotEl = getOrCreateParticipantContainer({ identity: userIdStr });

    attachTrackToSlot(localVideoTrack, slotEl, { isLocalPreview: true });
    attachTrackToSlot(localAudioTrack, slotEl, { isLocalPreview: true });

    return true;
  } catch (e) {
    dbgError('startPublish failed', e);
    throw e;
  }
}

async function stopPublish() {
  try {
    if (!currentlyPublishing) return;
    currentlyPublishing = false;
    try {
      if (localVideoTrack && typeof localVideoTrack.stop === 'function') localVideoTrack.stop();
      if (localAudioTrack && typeof localAudioTrack.stop === 'function') localAudioTrack.stop();
    } catch (e) { dbgWarn('stopPublish: stop local tracks failed', e); }
    localVideoTrack = null;
    localAudioTrack = null;
    try {
      if (liveRoom && liveRoom.localParticipant && typeof liveRoom.localParticipant.unpublishTrack === 'function') {
        // try to unpublish known shapes
      }
    } catch (e) { dbgWarn('stopPublish: unpublish failed', e); }
  } catch (e) {
    dbgWarn('stopPublish failed', e);
  }
}

async function disconnectRoom() {
  try {
    if (!liveRoom) return;
    try {
      if (typeof liveRoom.disconnect === 'function') await liveRoom.disconnect();
      else if (typeof liveRoom.leave === 'function') await liveRoom.leave();
    } catch (e) { dbgWarn('disconnectRoom: leave/disconnect failed', e); }
    liveRoom = null;
    subscribedTracksMap.clear();
    subscribedVideoCount = 0;
  } catch (e) { dbgWarn('disconnectRoom failed', e); }
}

// Expose some helpers for debugging in console
window.livekit_debug = {
  connectAndJoin,
  startPublish,
  stopPublish,
  disconnectRoom,
  getOrCreateParticipantContainer,
  participantToSlotIdentity,
  dbg: () => dbg
};

dbgLog('live.js (merged patched) loaded');
