// online.js
// Usage: <script type="module" src="online.js"></script>
// (ou) import './online.js' dans votre bundle.
// Crée un banner qui apparaît 5s après le lancement, puis toutes les 15s,
// affichant "Environ 154342 personnes actifs" avec transitions et nombres lissés.

const ONLINE_MIN = 97_785;
const ONLINE_MAX = 775_431;

// Paramètres de comportement
const FIRST_DELAY_MS = 5000;      // première apparition après X ms
const REPEAT_INTERVAL_MS = 15000; // intervalle entre affichages
const VISIBLE_MS = 4500;          // durée d'affichage à chaque fois
const ANIM_DURATION_MS = 700;     // durée de l'animation comptage

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
      gap: 10px;
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
    }
    @media (max-width: 420px) {
      #${BANNER_ID} { font-size: 13px; padding: 8px 12px; bottom: 18px; min-width: 180px; }
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
    <span class="text">Environ <span class="num">—</span> personnes actifs</span>
  `;
  document.body.appendChild(el);
  return el;
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

// Stateful simulator
const Simulator = (function () {
  let current = rndInt(ONLINE_MIN, ONLINE_MAX);
  let banner = null;
  let hideTimeout = null;

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
    if (candidate - ONLINE_MIN < margin) return candidate + margin;
    if (ONLINE_MAX - candidate < margin) return candidate - margin;
    return candidate;
  }

  function showOnce() {
    banner = createBannerIfNeeded();
    const numEl = banner.querySelector('.num');
    const next = nextValue();
    // animate number
    animateNumber(numEl, current, next);
    current = next;

    // ensure visible class
    banner.classList.add('visible');

    // clear previous hide timeout
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    hideTimeout = setTimeout(() => {
      banner.classList.remove('visible');
    }, VISIBLE_MS);
  }

  return {
    initialShow() {
      // create banner but keep it hidden until first show
      createBannerIfNeeded();
    },
    scheduleInitialAndRepeats() {
      // first show after FIRST_DELAY_MS
      setTimeout(() => {
        showOnce();
        // subsequent shows every REPEAT_INTERVAL_MS
        setInterval(showOnce, REPEAT_INTERVAL_MS);
      }, FIRST_DELAY_MS);
    }
  };
})();

// Auto-run on DOM ready (works if script is loaded before/after DOM)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    Simulator.initialShow();
    Simulator.scheduleInitialAndRepeats();
  });
} else {
  Simulator.initialShow();
  Simulator.scheduleInitialAndRepeats();
}