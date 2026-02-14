// live.js
// Gestion LiveKit — attache les vidéos dans les slots existants (#player1Video, #player2Video, #moderatorVideo)
// Usage: <script type="module" src="./live.js"></script>
/* global window, document, console */

let liveRoom = null;
let localVideoTrack = null;
let localAudioTrack = null;
let currentlyPublishing = false;

const VIDEO_SLOT_IDS = {
  owner: 'player1Video',
  opponent: 'player2Video',
  moderator: 'moderatorVideo'
};

const DEFAULT_LIVEKIT_TOKEN_ENDPOINT = 'https://mvkfawtnvahxqwcbcfkb.supabase.co/functions/v1/get_livekit_token';

function log(...args) { console.info('[live.js]', ...args); }

async function dynamicImportLivekit() {
  // Remplace par import statique si tu utilises un bundler
  return await import('https://unpkg.com/livekit-client@1.4.6/dist/livekit-client.es.js');
}

function getSlotEl(slotKey) {
  const id = VIDEO_SLOT_IDS[slotKey];
  if (!id) return null;
  return document.getElementById(id) || null;
}

// Assurer / réutiliser une balise <video> dans le slot.
// returns HTMLVideoElement or null
function ensureVideoElement(slotEl, { muted = false } = {}) {
  if (!slotEl) return null;
  // prefer existing video
  let video = slotEl.querySelector('video');
  if (video) {
    // ensure attributes
    video.autoplay = true;
    video.playsInline = true;
    video.muted = !!muted;
    video.style.width = '100%';
    video.style.height = '100%';
    video.classList?.add?.('object-cover');
    return video;
  }

  // create new <video>
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
  return video;
}

// Attach a LiveKit track to an existing slot element (reusing or creating a <video>).
function attachTrackToSlot(track, slotEl, { isLocalPreview = false } = {}) {
  if (!slotEl || !track) return;
  try {
    const videoEl = ensureVideoElement(slotEl, { muted: !!isLocalPreview });
    // try to attach into the existing video element if API supports an element argument
    if (typeof track.attach === 'function') {
      try {
        const maybeEl = track.attach(videoEl);
        if (maybeEl && maybeEl !== videoEl) {
          try { videoEl.remove(); } catch(_) {}
          slotEl.appendChild(maybeEl);
        } else {
          // attach may have used the passed element
          if (!slotEl.contains(videoEl)) {
            slotEl.innerHTML = '';
            slotEl.appendChild(videoEl);
          }
        }
      } catch (e) {
        // fallback: attach without args and append result
        try {
          const el = track.attach();
          el.autoplay = true;
          el.playsInline = true;
          if (isLocalPreview) el.muted = true;
          slotEl.innerHTML = '';
          slotEl.appendChild(el);
        } catch (ee) {
          console.warn('[live.js] attach fallback failed', ee);
        }
      }
    } else {
      console.warn('[live.js] track.attach not available on track object');
    }
  } catch (e) {
    console.warn('[live.js] attachTrackToSlot failed', e);
  }
}

function clearSlot(slotEl) {
  if (!slotEl) return;
  try {
    // detach any attached LiveKit elements if provided
    const vids = Array.from(slotEl.querySelectorAll('video,canvas'));
    vids.forEach(v => {
      try { v.remove(); } catch (e) {}
    });
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

function participantToSlotIdentity(participant, gameState) {
  const ident = (participant?.identity || '').toString();
  if (!gameState) return 'moderator';
  const ownerId = gameState.owner_id ?? gameState.ownerId ?? gameState.owner ?? null;
  const opponentId = gameState.opponent_id ?? gameState.opponentId ?? gameState.opponent ?? null;
  if (ident && ownerId && ident === ownerId.toString()) return 'owner';
  if (ident && opponentId && ident === opponentId.toString()) return 'opponent';
  return 'moderator';
}

// iterate publications safe
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
    console.warn('[live.js] iterateParticipantTracks error', e);
  }
}

async function handleParticipant(participant, gameState) {
  try {
    iterateParticipantTracks(participant, (pub) => {
      try {
        if (!pub) return;
        // publication object may be { track, isSubscribed } or a TrackPublication with .track
        const track = pub.track ?? pub;
        const isSubscribed = (pub.isSubscribed ?? true);
        if (track && isSubscribed) {
          const slot = participantToSlotIdentity(participant, gameState);
          const slotEl = getSlotEl(slot);
          attachTrackToSlot(track, slotEl, { isLocalPreview: false });
        }
      } catch (_e) {}
    });

    // subscribe to future tracks
    participant?.on && participant.on('trackSubscribed', (track) => {
      try {
        const slot = participantToSlotIdentity(participant, gameState);
        const slotEl = getSlotEl(slot);
        attachTrackToSlot(track, slotEl, { isLocalPreview: false });
      } catch (_e) {}
    });

    participant?.on && participant.on('trackUnsubscribed', (track) => {
      try {
        const slot = participantToSlotIdentity(participant, gameState);
        const slotEl = getSlotEl(slot);
        // if specific track removed, clear slot (could be improved to check remaining tracks)
        clearSlot(slotEl);
      } catch (_e) {}
    });

    participant?.on && participant.on('disconnected', () => {
      try {
        const slot = participantToSlotIdentity(participant, gameState);
        const slotEl = getSlotEl(slot);
        clearSlot(slotEl);
      } catch (_e) {}
    });

  } catch (e) {
    console.warn('[live.js] handleParticipant failed', e);
  }
}

async function subscribeExistingParticipants(room) {
  if (!room) return;
  const gs = getGameState();
  try {
    if (typeof room.participants.forEach === 'function') {
      room.participants.forEach(p => handleParticipant(p, gs));
    } else if (Array.isArray(room.participants)) {
      room.participants.forEach(p => handleParticipant(p, gs));
    } else if (room.participants instanceof Map) {
      for (const p of room.participants.values()) handleParticipant(p, gs);
    }
  } catch (e) {
    console.warn('[live.js] subscribeExistingParticipants error', e);
  }
}

// Request token from Supabase Edge Function
async function requestLivekitTokenForGame(gameId) {
  if (!gameId) throw new Error('gameId required');

  const endpoint = window.LIVEKIT_TOKEN_ENDPOINT || DEFAULT_LIVEKIT_TOKEN_ENDPOINT;
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set('game_id', gameId);

  // obtain supabase access token robustly
  let accessToken = null;
  try {
    if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
      const sess = await window.supabase.auth.getSession();
      const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
      accessToken = data?.access_token ?? data?.accessToken ?? null;
    }
  } catch (e) { console.warn('[live.js] getSession failed', e); }

  const headers = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const resp = await fetch(url.toString(), { method: 'GET', headers, credentials: 'include' });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Token request failed: ${resp.status} ${resp.statusText} ${txt}`);
  }
  return await resp.json(); // expected { token, livekit_url, room }
}

async function connectAndJoin(roomName, identity, gameId) {
  const LK = await dynamicImportLivekit();
  const connectFn = LK.connect || LK.default?.connect;
  if (typeof connectFn !== 'function') throw new Error('livekit connect not available');

  let tokenResp;
  if (gameId) {
    tokenResp = await requestLivekitTokenForGame(gameId);
  } else {
    // fallback: attempt standard endpoint with room & identity
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
    const resp = await fetch(url.toString(), { headers, credentials: 'include' });
    if (!resp.ok) throw new Error('token fetch failed: ' + resp.statusText);
    tokenResp = await resp.json();
  }

  const token = tokenResp?.token || tokenResp?.accessToken || tokenResp?.access_token;
  const urlStr = tokenResp?.livekit_url || tokenResp?.url || tokenResp?.liveKitUrl;
  if (!token || !urlStr) throw new Error('token or livekit_url missing in response');

  const room = await connectFn(urlStr, token, { autoSubscribe: true });
  liveRoom = room;

  await subscribeExistingParticipants(room);

  room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState()));
  room?.on && room.on('participantDisconnected', p => {
    const slot = participantToSlotIdentity(p, getGameState());
    const slotEl = getSlotEl(slot);
    clearSlot(slotEl);
  });

  log('Connected to LiveKit room', tokenResp.room || roomName);
  return room;
}

async function startPublish() {
  if (currentlyPublishing) {
    log('Already publishing');
    return true;
  }

  try {
    // get user id
    let userId = null;
    try {
      if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
        const sess = await window.supabase.auth.getSession();
        const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
        userId = data?.user?.id ?? data?.userId ?? data?.user_id ?? null;
      }
    } catch (e) { /* ignore */ }

    if (!userId) throw new Error('Utilisateur non connecté');

    const gs = getGameState();
    const gameId = gs?.id ?? gs?.gameId ?? gs?.game_id ?? null;
    if (!gameId) throw new Error('gameId introuvable (nécessaire pour token)');

    const roomName = `game-${gameId}`;

    if (!liveRoom) await connectAndJoin(roomName, userId, gameId);

    const LK = await dynamicImportLivekit();
    const createLocalVideoTrack = LK.createLocalVideoTrack || LK.default?.createLocalVideoTrack;
    const createLocalAudioTrack = LK.createLocalAudioTrack || LK.default?.createLocalAudioTrack;
    if (typeof createLocalVideoTrack !== 'function' || typeof createLocalAudioTrack !== 'function') {
      throw new Error('createLocalVideoTrack / createLocalAudioTrack non disponibles');
    }

    // create local tracks (muted preview)
    localVideoTrack = await createLocalVideoTrack({ resolution: 'qvga' });
    localAudioTrack = await createLocalAudioTrack();

    if (!liveRoom || !liveRoom.localParticipant) throw new Error('Non connecté à la room');

    // publish safely (API variations)
    if (typeof liveRoom.localParticipant.publishTrack === 'function') {
      // publishTrack may expect a track or a TrackPublication
      try {
        await liveRoom.localParticipant.publishTrack(localVideoTrack);
      } catch (_) {
        // fallback: try publish with array
        if (typeof liveRoom.localParticipant.publish === 'function') {
          await liveRoom.localParticipant.publish([localVideoTrack]);
        }
      }
      try {
        await liveRoom.localParticipant.publishTrack(localAudioTrack);
      } catch (_) {
        if (typeof liveRoom.localParticipant.publish === 'function') {
          await liveRoom.localParticipant.publish([localAudioTrack]);
        }
      }
    } else if (typeof liveRoom.localParticipant.publish === 'function') {
      await liveRoom.localParticipant.publish([localVideoTrack, localAudioTrack]);
    } else {
      console.warn('[live.js] publish API non trouvée');
    }

    currentlyPublishing = true;

    // preview attach into correct slot
    const ownerId = gs && (gs.owner_id ?? gs.ownerId ?? gs.owner);
    const opponentId = gs && (gs.opponent_id ?? gs.opponentId ?? gs.opponent);
    const userIdStr = userId?.toString();
    const slotKey = (gs && userIdStr === ownerId?.toString()) ? 'owner'
                   : (gs && userIdStr === opponentId?.toString()) ? 'opponent'
                   : 'moderator';
    const slotEl = getSlotEl(slotKey);
    attachTrackToSlot(localVideoTrack, slotEl, { isLocalPreview: true });

    log('Publishing as', slotKey);
    return true;

  } catch (e) {
    console.error('[live.js] startPublish error', e);
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
    log('Not publishing');
    return;
  }

  try {
    if (liveRoom && liveRoom.localParticipant) {
      // attempt to unpublish and detach
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

      // also try unpublishTrack API
      try {
        if (typeof liveRoom.localParticipant.unpublishTrack === 'function') {
          if (localVideoTrack) await liveRoom.localParticipant.unpublishTrack(localVideoTrack);
          if (localAudioTrack) await liveRoom.localParticipant.unpublishTrack(localAudioTrack);
        }
      } catch (_) {}
    }

    // stop tracks
    try { if (localVideoTrack && typeof localVideoTrack.stop === 'function') localVideoTrack.stop(); } catch(_) {}
    try { if (localAudioTrack && typeof localAudioTrack.stop === 'function') localAudioTrack.stop(); } catch(_) {}

    // detach any remaining attached elements in our preview slot
    const gs = getGameState();
    // determine slot element for current user
    let userId = null;
    try {
      if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getSession === 'function') {
        const sess = await window.supabase.auth.getSession();
        const data = sess?.data?.session ?? sess?.data ?? sess?.session ?? null;
        userId = data?.user?.id ?? null;
      }
    } catch (e) {}

    const ownerId = gs && (gs.owner_id ?? gs.ownerId ?? gs.owner);
    const opponentId = gs && (gs.opponent_id ?? gs.opponentId ?? gs.opponent);
    const userIdStr = userId?.toString();
    const slotKey = (gs && userIdStr === ownerId?.toString()) ? 'owner'
                   : (gs && userIdStr === opponentId?.toString()) ? 'opponent'
                   : 'moderator';
    const slotEl = getSlotEl(slotKey);
    clearSlot(slotEl);

    localVideoTrack = null;
    localAudioTrack = null;
    currentlyPublishing = false;

    log('Stopped publishing');

  } catch (e) {
    console.warn('[live.js] stopPublish error', e);
  }
}

async function disconnectRoom() {
  if (!liveRoom) return;
  try {
    if (typeof liveRoom.disconnect === 'function') await liveRoom.disconnect();
    else if (typeof liveRoom.close === 'function') await liveRoom.close();
  } catch (e) { console.warn('[live.js] disconnect error', e); }
  liveRoom = null;
  currentlyPublishing = false;
}

// Expose API for fab.js and debugging
window.livekit = window.livekit || {
  startPublish,
  stopPublish,
  disconnectRoom,
  isPublishing: () => !!currentlyPublishing,
  getRoom: () => liveRoom,
  connectRoom: async (roomName, identity, gameId) => connectAndJoin(roomName, identity, gameId)
};
