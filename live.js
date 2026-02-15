// live.js
// Gestion LiveKit — attache les vidéos dans les slots existants (#player1Video, #player2Video, #moderatorVideo)
// Usage: <script type="module" src="./live.js"></script>
/* global window, document, console, alert */

const dbg = true; // <-- mettre à false pour désactiver les alertes de debug/console
function dbgLog(...args) { if (!dbg) return; try { console.info('[live.js][DBG]', ...args); } catch (e) {} }
function dbgWarn(...args) { if (!dbg) return; try { console.warn('[live.js][WARN]', ...args); } catch (e) {} }
function dbgError(...args) { if (!dbg) return; try { console.error('[live.js][ERROR]', ...args); } catch (e) {} try { alert('[live.js] ERROR: ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (e) {} }
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

// --- patch: getSlotEl with fallback IDs ---
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
// 1) prefer window.LivekitClient if preloaded
// 2) try dynamic import from jsdelivr (ESM)
// 3) try dynamic import from unpkg
// 4) as last resort inject a small module <script> that imports and assigns window.LivekitClient
async function dynamicImportLivekit() {
  // 1) preloaded on window
  if (window.LivekitClient) {
    dbgLog('Using preloaded LivekitClient from window');
    return window.LivekitClient;
  }

  // Use a recent stable version (2.17.1) if dynamic import needed
  const candidates = [
    'https://cdn.jsdelivr.net/npm/livekit-client@2.17.1/dist/livekit-client.esm.mjs',
    'https://unpkg.com/livekit-client@2.17.1/dist/livekit-client.es.js'
  ];

  // 2) try import() candidates
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

  // 3) try injecting a small module script that performs the import and sets window.LivekitClient
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
  return video;
}

function attachTrackToSlot(track, slotEl, { isLocalPreview = false } = {}) {
  if (!slotEl || !track) return;
  try {
    const videoEl = ensureVideoElement(slotEl, { muted: !!isLocalPreview });
    if (typeof track.attach === 'function') {
      try {
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
      } catch (e) {
        try {
          const el = track.attach();
          el.autoplay = true;
          el.playsInline = true;
          if (isLocalPreview) el.muted = true;
          slotEl.innerHTML = '';
          slotEl.appendChild(el);
        } catch (ee) {
          dbgWarn('[live.js] attach fallback failed', ee);
        }
      }
    } else {
      dbgWarn('[live.js] track.attach not available on track object');
    }
  } catch (e) {
    dbgWarn('[live.js] attachTrackToSlot failed', e);
  }
}

function clearSlot(slotEl) {
  if (!slotEl) return;
  try {
    const vids = Array.from(slotEl.querySelectorAll('video,canvas'));
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

async function handleParticipant(participant, gameState) {
  try {
    iterateParticipantTracks(participant, (pub) => {
      try {
        if (!pub) return;
        const track = pub.track ?? pub;
        const isSubscribed = (pub.isSubscribed ?? true);
        if (track && isSubscribed) {
          const slot = participantToSlotIdentity(participant, gameState);
          const slotEl = getSlotEl(slot);
          attachTrackToSlot(track, slotEl, { isLocalPreview: false });
        }
      } catch (_e) {}
    });

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
        clearSlot(slotEl);
      } catch (_e) {}
    });

    participant?.on && participant.on('disconnected', () => {
      try {
        const slot = participantToSlotIdentity(participant, getGameState());
        const slotEl = getSlotEl(slot);
        clearSlot(slotEl);
      } catch (_e) {}
    });

  } catch (e) {
    dbgWarn('[live.js] handleParticipant failed', e);
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
  if (!token || !urlStr) {
    dbgError('token or livekit_url missing in token response', tokenResp);
    throw new Error('token or livekit_url missing in response');
  }

  // --- CONNECT: try several shapes of API ---
  dbgLog('Attempting to connect to LiveKit server', urlStr, 'roomName', roomName);

  // 1) If module exposes a top-level connect function (older style)
  if (typeof LK.connect === 'function') {
    try {
      const room = await LK.connect(urlStr, token, { autoSubscribe: true });
      liveRoom = room;
      dbgLog('Connected via LK.connect');
      dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
      await subscribeExistingParticipants(room);
      room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState()));
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
      return room;
    } catch (e) {
      dbgError('LK.connect failed', e);
      throw e;
    }
  }

  // 2) If module exports Room class: new Room(); await room.connect(...)
  const RoomClass = LK.Room || LK.default?.Room || LK.default;
  if (typeof RoomClass === 'function') {
    try {
      const room = new RoomClass();
      await room.connect(urlStr, token, { autoSubscribe: true });
      liveRoom = room;
      dbgLog('Connected via new Room().connect');
      dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
      await subscribeExistingParticipants(room);
      room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState()));
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
      return room;
    } catch (e) {
      dbgError('Room.connect flow failed', e);
      throw e;
    }
  }

  // 3) If UMD preloaded on window (window.LivekitClient) — try that
  if (window.LivekitClient) {
    dbgLog('Trying window.LivekitClient (UMD) for connection');
    const WK = window.LivekitClient;
    if (typeof WK.connect === 'function') {
      const room = await WK.connect(urlStr, token, { autoSubscribe: true });
      liveRoom = room;
      dbgLog('Connected via window.LivekitClient.connect');
      dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
      await subscribeExistingParticipants(room);
      room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState()));
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
      return room;
    } else if (typeof WK.Room === 'function') {
      const room = new WK.Room();
      await room.connect(urlStr, token, { autoSubscribe: true });
      liveRoom = room;
      dbgLog('Connected via new window.LivekitClient.Room().connect');
      dbgAlert('Connected to LiveKit room: ' + (tokenResp.room || roomName));
      await subscribeExistingParticipants(room);
      room?.on && room.on('participantConnected', p => handleParticipant(p, getGameState()));
      room?.on && room.on('participantDisconnected', p => { const slot = participantToSlotIdentity(p, getGameState()); clearSlot(getSlotEl(slot)); });
      return room;
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
  waitForReady: waitForLivekit
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
