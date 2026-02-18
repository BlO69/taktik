// follow.js
// Usage:
// import { attachFollowToAvatar } from './follow.js';
// attachFollowToAvatar(avatarEl, 'target-uuid', { supabase: window.supabase });

export const followCache = new Map(); // targetId -> boolean (true = already following)

/**
 * Attach a small "+" follow button to an avatar element if current session user
 * does NOT already follow targetUserId.
 *
 * avatarRef: Element (img or container)
 * targetUserId: uuid string
 * opts:
 *   - supabase: supabase client instance (default window.supabase)
 *   - size: px (default 24)
 *   - offset: { x, y } (default {x:6,y:6})
 *   - tooltip: string (default "Suivre")
 */
export async function attachFollowToAvatar(avatarRef, targetUserId, opts = {}) {
  const {
    supabase = (typeof window !== 'undefined' ? window.supabase : null),
    size = 24,
    offset = { x: 6, y: 6 },
    tooltip = 'Suivre'
  } = opts;

  if (!avatarRef || !(avatarRef instanceof Element)) return;
  if (!targetUserId) return;
  if (!supabase) {
    console.warn('follow.js: supabase client missing.');
    return;
  }

  // Get current user id (retry once if session not ready)
  async function getCurrentUserId() {
    try {
      const s = await supabase.auth.getSession();
      return s?.data?.session?.user?.id ?? null;
    } catch (e) {
      console.warn('follow.js getSession failed', e);
      return null;
    }
  }

  const currentUserId = await getCurrentUserId();
  if (!currentUserId) {
    // Not logged in — do not show follow button
    return;
  }

  // don't show for self
  if (String(currentUserId) === String(targetUserId)) return;

  // If cached and already following -> don't show
  if (followCache.has(targetUserId) && followCache.get(targetUserId) === true) return;

  // Query DB to check existing follow relationship
  let alreadyFollowing = false;
  try {
    const { data, error } = await supabase
      .from('user_follows')
      .select('id')
      .eq('follower_id', currentUserId)
      .eq('following_id', targetUserId)
      .limit(1)
      .maybeSingle();

    if (error) {
      // If RLS prohibits direct read, fallback: show + (RPC will be idempotent)
      console.warn('follow.js: check follow read error, falling back to optimistic button', error);
    } else {
      if (data && data.id) {
        alreadyFollowing = true;
      }
    }
  } catch (e) {
    console.warn('follow.js: exception checking follow', e);
  }

  // Cache result
  followCache.set(targetUserId, alreadyFollowing);

  if (alreadyFollowing) {
    // nothing to do
    return;
  }

  // Ensure avatar parent is positioned for absolute overlay
  let wrapper = avatarRef.parentElement;
  if (!wrapper || !wrapper.classList.contains('follow-overlay-wrapper')) {
    const wrap = document.createElement('span');
    wrap.className = 'follow-overlay-wrapper';
    // keep flow display similar to original element
    const computed = window.getComputedStyle(avatarRef);
    wrap.style.display = computed.display === 'block' ? 'block' : 'inline-block';
    avatarRef.parentNode.insertBefore(wrap, avatarRef);
    wrap.appendChild(avatarRef);
    wrapper = wrap;
  }

  // Inject styles once
  if (!document.getElementById('follow-js-styles')) {
    const s = document.createElement('style');
    s.id = 'follow-js-styles';
    s.textContent = `
      .follow-btn-overlay {
        position: absolute;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.9);
        background: rgba(0,0,0,0.6);
        color: white;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
        transition: transform .12s ease, opacity .12s ease;
        box-shadow: 0 2px 6px rgba(0,0,0,0.25);
        z-index: 999;
      }
      .follow-btn-overlay:hover { transform: scale(1.06); }
      .follow-btn-overlay[disabled] { opacity: .6; cursor: default; transform: none; }
      .follow-overlay-wrapper { position: relative; display: inline-block; }
    `;
    document.head.appendChild(s);
  }

  // create button
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'follow-btn-overlay';
  btn.title = tooltip;
  btn.setAttribute('aria-label', tooltip);
  btn.style.width = `${size}px`;
  btn.style.height = `${size}px`;
  btn.style.right = `${offset.x}px`;
  btn.style.top = `${offset.y}px`;
  btn.style.position = 'absolute';
  btn.style.fontSize = `${Math.max(12, Math.floor(size * 0.6))}px`;
  btn.style.lineHeight = '1';
  btn.style.padding = '0';
  btn.style.boxSizing = 'border-box';
  btn.textContent = '+';

  wrapper.appendChild(btn);

  // Click handler: call RPC
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = '…';
    try {
      const { data, error } = await supabase.rpc('rpc_follow_user', { p_following_id: targetUserId });

      if (error) {
        // show minimal feedback via title + console
        console.warn('rpc_follow_user error', error);
        btn.textContent = prev;
        btn.disabled = false;
        // optional: display toast if available
        try { if (window.toastr) window.toastr.error(error.message || 'Erreur follow'); } catch (_) {}
        return;
      }

      // RPC returns a row (or array). We consider follow successful either when created=true OR already existed.
      const row = Array.isArray(data) ? data[0] : data;
      const created = row && (row.created === true || row.created === 't' || row.created === 1);
      // UI update: show checkmark and keep button (or hide)
      btn.textContent = '✓';
      btn.title = 'Suivi';
      btn.setAttribute('aria-label', 'Suivi');
      btn.disabled = true; // keep disabled to indicate it's followed
      // update cache
      followCache.set(targetUserId, true);
    } catch (err) {
      console.error('follow.js unexpected error', err);
      btn.textContent = prev;
      btn.disabled = false;
    }
  });
}
