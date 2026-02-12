// online.js
// Usage: <script type="module" src="online.js"></script>
// Crée un banner qui apparaît 5s après le lancement, puis toutes les 15s,
// affichant "Environ 154 342 personnes actives" avec transitions et nombres lissés.
// Si la connexion Internet est absente, affiche un message invitant à se reconnecter.

const ONLINE_MIN = 97_785;
const ONLINE_MAX = 775_431;

// Paramètres de comportement
const FIRST_DELAY_MS = 5000;      // première apparition après X ms
const REPEAT_INTERVAL_MS = 15000; // intervalle entre affichages
const VISIBLE_MS = 4500;          // durée d'affichage à chaque fois
const ANIM_DURATION_MS = 700;     // durée de l'animation comptage

// Ping (contrôle simple de connectivité). Par défaut on ping la racine du site.
// Si ton site n'a pas de ressource racine accessible, modifie PING_URL vers une petite route existante.
const PING_URL = (typeof location !== 'undefined' && location.origin) ? `${location.origin}/` : null;
const PING_TIMEOUT_MS = 3000; // timeout du ping

// Taille maximale d'un saut entre deux valeurs (évite les gros écarts)
const RANGE = ONLINE_MAX - ONLINE_MIN;
const MAX_DELTA = Math.max(100, Math.round(RANGE * 0.01)); // ~1% du range, min 100

// ID pour éviter duplications
const BANNER_ID = 'online-sim-banner-v1';

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function fmt(n) {
  // Formatage avec séparateur de milliers en français
  try {
    return new Intl.NumberFormat('fr-FR').format(Math.round(n));
  } catch (e) {
    // fallback simple
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
}

function createStyles() {
  if (document.getElementById('online-sim-styles')) return;
  const css = `
    #${BANNER_ID} {
      position: fixed;
      left: 50%;
      bottom: 28px;
      transform: translateX(-50%) translateY(12px);
      background: linear-gradient(90deg, rgba(0,0,0,0.85), rgba(0,0,0,0.78));
      color: #fff;
      padding: 10px 16px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
      font-size: 14px;
      line-height: 1;
      z-index: 99999;
      display: inline-flex;
      align-items: center;
      gap: 12px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 240ms ease, transform 300ms cubic-bezier(.2,.9,.25,1);
      will-change: opacity, transform;
      min-width: 220px;
      justify-content: center;
      text-align: center;
    }
    #${BANNER_ID}.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
      pointer-events: auto;
    }
    #${BANNER_ID} .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.95), rgba(255,255,255,0.4));
      box-shadow: 0 0 10px rgba(0,200,150,0.25);
      flex: 0 0 auto;
    }
    #${BANNER_ID} .text {
      font-weight: 600;
      font-size: 14px;
      color: #fff;
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
    }
    #${BANNER_ID} .text .label { font-weight: 600; }
    #${BANNER_ID} .text .num { font-variant-numeric: tabular-nums; }
    #${BANNER_ID} .offline {
      display: none;
      font-weight: 600;
      font-size: 13px;
      color: #ffd8d8;
      max-width: 320px;
    }
    #${BANNER_ID}.is-offline {
      background: linear-gradient(90deg, rgba(120,10,10,0.95), rgba(90,8,8,0.95));
      box-shadow: 0 8px 30px rgba(150,30,30,0.45);
    }
    @media (max-width: 420px) {
      #${BANNER_ID} { font-size: 13px; padding: 8px 12px; bottom: 18px; min-width: 180px; }
      #${BANNER_ID} .offline { font-size: 12px; }
    }
  `;
  const style = document.createElement('style');
  style.id = 'online-sim-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function createBannerIfNeeded() {
  if (document.getElementById(BANNER_ID)) return document.getElementById(BANNER_ID);

  createStyles();

  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  el.innerHTML = `
    <span class="dot" aria-hidden="true"></span>
    <span class="text">
      <span class="label">Environ</span>
      <span class="num">—</span>
      <span class="suffix"> personnes actives</span>
    </span>
    <span class="offline" aria-hidden="true">Vous devez être connecté·e à Internet pour utiliser la plateforme</span>
  `;
  document.body.appendChild(el);
  return el;
}

function showOfflineMessage(banner) {
  if (!banner) banner = createBannerIfNeeded();
  banner.classList.add('is-offline');
  const textEl = banner.querySelector('.text');
  const offlineEl = banner.querySelector('.offline');
  if (textEl) textEl.style.display = 'none';
  if (offlineEl) offlineEl.style.display = 'inline';
  // ensure visible
  banner.classList.add('visible');
}

function showOnlineTemplate(banner) {
  if (!banner) banner = createBannerIfNeeded();
  banner.classList.remove('is-offline');
  const textEl = banner.querySelector('.text');
  const offlineEl = banner.querySelector('.offline');
  if (offlineEl) offlineEl.style.display = 'none';
  if (textEl) textEl.style.display = 'inline-flex';
  // ensure visible
  banner.classList.add('visible');
}

function hideBanner(banner) {
  if (!banner) return;
  banner.classList.remove('visible');
  // optionally remove offline class after animation
  setTimeout(() => {
    banner.classList.remove('is-offline');
  }, 400);
}

function animateNumber(elNum, from, to, duration = ANIM_DURATION_MS) {
  const start = performance.now();
  const diff = to - from;
  if (diff === 0) {
    elNum.textContent = fmt(to);
    return;
  }
  function step(ts) {
    const t = Math.min(1, (ts - start) / duration);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    const val = from + diff * eased;
    elNum.textContent = fmt(val);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// connectivity check: navigator.onLine quick check + optional fetch to confirm
async function isOnline() {
  // quick offline detection
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  // if no ping URL is set (rare), trust navigator.onLine
  if (!PING_URL) {
    return (typeof navigator === 'undefined') ? true : Boolean(navigator.onLine);
  }

  // try a small fetch to the site's origin (timeout after PING_TIMEOUT_MS)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    // We request the root with no-cache to avoid cached 200s hiding network issues.
    const res = await fetch(PING_URL, { method: 'GET', cache: 'no-store', signal: controller.signal, credentials: 'same-origin' });
    clearTimeout(timer);
    // if fetch resolves (even 404), network is up
    return true;
  } catch (err) {
    clearTimeout(timer);
    return false;
  }
}

// Stateful simulator
const Simulator = (function () {
  let current = rndInt(ONLINE_MIN, ONLINE_MAX);
  let banner = null;
  let hideTimeout = null;
  let intervalHandle = null;

  function nextValue() {
    // Parfois (5% chance) on fait un grand saut pour varier un peu,
    // sinon on bouge seulement d'au plus ±MAX_DELTA
    if (Math.random() < 0.05) {
      return rndInt(ONLINE_MIN, ONLINE_MAX);
    }
    const delta = rndInt(-MAX_DELTA, MAX_DELTA);
    const candidate = clamp(current + delta, ONLINE_MIN, ONLINE_MAX);
    // Si on se retrouve trop proche du bord, pousse légèrement vers le centre
    const margin = Math.round(RANGE * 0.02);
    if (candidate - ONLINE_MIN < margin) return clamp(candidate + margin, ONLINE_MIN, ONLINE_MAX);
    if (ONLINE_MAX - candidate < margin) return clamp(candidate - margin, ONLINE_MIN, ONLINE_MAX);
    return candidate;
  }

  async function showOnce() {
    banner = createBannerIfNeeded();
    const numEl = banner.querySelector('.num');

    const online = await isOnline();
    if (!online) {
      showOfflineMessage(banner);
      // hide after VISIBLE_MS
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      hideTimeout = setTimeout(() => { hideBanner(banner); }, VISIBLE_MS);
      return;
    }

    // online path: show number
    showOnlineTemplate(banner);

    const next = nextValue();
    // animate number from current to next
    // ensure numeric fallback if current isn't numeric
    const fromVal = Number.isFinite(current) ? current : ONLINE_MIN;
    animateNumber(numEl, fromVal, next);
    current = next;

    // clear previous hide timeout
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    hideTimeout = setTimeout(() => {
      hideBanner(banner);
    }, VISIBLE_MS);
  }

  function scheduleInitialAndRepeats() {
    // first show after FIRST_DELAY_MS
    setTimeout(() => {
      showOnce();
      // subsequent shows every REPEAT_INTERVAL_MS
      intervalHandle = setInterval(() => { showOnce(); }, REPEAT_INTERVAL_MS);
    }, FIRST_DELAY_MS);
  }

  function immediateShowIfOnline() {
    // Show immediately (useful on 'online' event)
    showOnce();
  }

  function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  }

  return {
    scheduleInitialAndRepeats,
    immediateShowIfOnline,
    stop
  };
})();

// Auto-run on DOM ready (works if script is loaded before/after DOM)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    Simulator.scheduleInitialAndRepeats();
  });
} else {
  Simulator.scheduleInitialAndRepeats();
}

// react to browser network events to be more responsive
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // when back online, show the banner with a fresh number immediately
    Simulator.immediateShowIfOnline();
  });
  window.addEventListener('offline', () => {
    // when offline, show offline message immediately
    // create banner if needed and display offline message
    const b = createBannerIfNeeded();
    showOfflineMessage(b);
    // hide after VISIBLE_MS
    setTimeout(() => { hideBanner(b); }, VISIBLE_MS);
  });
}