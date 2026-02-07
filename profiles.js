// profiles.js
// Module ES à importer depuis index.html
// Fonctionnalités: charger profil, changer avatar (upload → bucket "avatars"), supprimer avatar, changer pseudo.
// Place ce fichier à la racine (à côté de index.html) et importe ./supabaseClient.js qui doit exporter `supabase`.

let supabase = null;
try {
  const mod = await import('./supabaseClient.js');
  supabase = mod.supabase;
} catch (e) {
  console.warn('supabaseClient.js non trouvé — profiles.js fonctionnera en mode demo.', e);
}

/* DOM refs (présents dans index.html) */
const avatarFile = document.getElementById('avatarFile');
const avatarPreview = document.getElementById('avatarPreview');
const usernameInput = document.getElementById('usernameInput'); // champ "Pseudo" dans index.html
const saveBtn = document.getElementById('saveProfile');
const cancelBtn = document.getElementById('cancelProfile');
const profileMsg = document.getElementById('profileMsg');

let currentUser = null;
let currentProfile = null; // row from user_profiles
let pendingFile = null;
let deleteBtn = null;
let followCountsEl = null;

// helpers UI
function showMsg(text, isError = false) {
  if (!profileMsg) return;
  profileMsg.textContent = text;
  profileMsg.style.color = isError ? '#b91c1c' : '#0f172a';
}

// safe timestamp
function nowISO() { return new Date().toISOString(); }

// extract storage path from public url when possible.
// Example Supabase public url: https://xyz.supabase.co/storage/v1/object/public/avatars/path/to/file.jpg
function getStoragePathFromUrl(url) {
  if (!url) return null;
  try {
    const idx = url.indexOf('/avatars/');
    if (idx === -1) return null;
    return url.slice(idx + '/avatars/'.length); // path after "avatars/"
  } catch (e) { return null; }
}

// preview chosen file
avatarFile?.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  pendingFile = f;
  avatarPreview.src = URL.createObjectURL(f);
  showMsg('Image prête à être uploadée (cliquer sur Enregistrer).');
});

// create delete button dynamically (next to avatar input) if not present
function ensureDeleteButton() {
  if (deleteBtn) return deleteBtn;
  deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'px-3 py-1 rounded-md bg-red-50 hover:bg-red-100 text-sm text-red-700';
  deleteBtn.textContent = 'Supprimer l’avatar';
  deleteBtn.style.marginLeft = '8px';
  // insert after avatarFile if exists
  if (avatarFile && avatarFile.parentNode) avatarFile.parentNode.appendChild(deleteBtn);
  deleteBtn.addEventListener('click', handleDeleteAvatar);
  return deleteBtn;
}

/* Create / ensure follow counts element next to the pseudo input */
function ensureFollowCountsElement() {
  if (followCountsEl) return followCountsEl;
  // try to find the container where usernameInput lives
  const wrapper = usernameInput?.closest('.col-span-2') ?? usernameInput?.parentNode;
  if (!wrapper) return null;
  followCountsEl = document.createElement('div');
  followCountsEl.id = 'followCounts';
  followCountsEl.className = 'text-xs text-slate-500 mt-2 flex gap-4';
  followCountsEl.innerHTML = `<div>Abonnés: <strong id="followersCount">—</strong></div>
                              <div>Suit: <strong id="followingCount">—</strong></div>`;
  wrapper.appendChild(followCountsEl);
  return followCountsEl;
}

/* Try to detect follow table and column names and return counts.
   It tries a list of candidate table / column name pairs and returns the first successful result.
   Returns { followers: number|null, following: number|null } */
async function fetchFollowCounts() {
  if (!supabase || !currentUser) return { followers: null, following: null };

  const candidateTables = ['user_follows', 'follows', 'user_followers', 'followers', 'user_follow', 'follow_relations'];
  const candidateColPairs = [
    ['follower_id', 'following_id'],
    ['follower', 'following'],
    ['user_id', 'target_id'],
    ['user_id', 'following_id'],
    ['follower_id', 'user_id'],
  ];

  for (const table of candidateTables) {
    for (const [followerCol, followingCol] of candidateColPairs) {
      try {
        // following: rows where followerCol == currentUser.id (people current user follows)
        const followingRes = await supabase
          .from(table)
          .select('id', { count: 'exact', head: true })
          .eq(followerCol, currentUser.id);

        // followers: rows where followingCol == currentUser.id (people who follow current user)
        const followersRes = await supabase
          .from(table)
          .select('id', { count: 'exact', head: true })
          .eq(followingCol, currentUser.id);

        // If both queries ran without an error object (even if count is 0), we accept this table.
        if (!followingRes.error && !followersRes.error && (typeof followingRes.count === 'number' || typeof followersRes.count === 'number')) {
          return { followers: followersRes.count ?? 0, following: followingRes.count ?? 0 };
        }
      } catch (e) {
        // ignore and try next candidate
      }
    }
  }
  // couldn't find table/columns: return nulls so UI can display "—"
  return { followers: null, following: null };
}

// update follow counts DOM
async function updateFollowCountsUI() {
  const el = ensureFollowCountsElement();
  if (!el) return;
  try {
    const { followers, following } = await fetchFollowCounts();
    const followersSpan = document.getElementById('followersCount');
    const followingSpan = document.getElementById('followingCount');
    followersSpan && (followersSpan.textContent = (followers === null ? '—' : String(followers)));
    followingSpan && (followingSpan.textContent = (following === null ? '—' : String(following)));
  } catch (e) {
    console.warn('Erreur fetch follow counts', e);
    const followersSpan = document.getElementById('followersCount');
    const followingSpan = document.getElementById('followingCount');
    followersSpan && (followersSpan.textContent = '—');
    followingSpan && (followingSpan.textContent = '—');
  }
}

// load session and profile
async function loadProfile() {
  if (!supabase) {
    showMsg('(Demo) Chargement local — connecté en mode démo.');
    return;
  }

  try {
    const res = await supabase.auth.getSession();
    const session = res?.data?.session ?? null;
    if (!session || !session.user) {
      showMsg('Non connecté — connecte-toi pour modifier ton profil.', true);
      saveBtn?.setAttribute('disabled', 'true');
      return;
    }
    currentUser = session.user;

    // prime la nav / preview si metadata contient avatar/pseudo (index.html fait aussi ça)
    if (currentUser.user_metadata?.avatar_url) {
      avatarPreview.src = currentUser.user_metadata.avatar_url;
    }
    if (currentUser.user_metadata?.pseudo) {
      usernameInput.value = currentUser.user_metadata.pseudo;
    }

    // try to fetch user_profiles row
    const { data: profileData, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', currentUser.id)
      .limit(1)
      .single();

    // ignore "no rows found" style errors
    if (error && error.code && !/No rows found|PGRST116/i.test(error.message || '')) {
      console.warn('Erreur lecture user_profiles', error);
    }

    if (profileData) {
      currentProfile = profileData;
      // prefer `pseudo` column if present
      const pseudo = profileData.pseudo ?? null;
      if (profileData.avatar_url) avatarPreview.src = profileData.avatar_url;
      if (pseudo) usernameInput.value = pseudo;
      ensureDeleteButton();
    }

    // ensure follow counts element exists and populate
    ensureFollowCountsElement();
    await updateFollowCountsUI();

    showMsg('Profil chargé.');
    saveBtn?.removeAttribute('disabled');
  } catch (err) {
    console.error('Erreur loadProfile', err);
    showMsg('Erreur lors du chargement du profil.', true);
  }
}

// upload file to bucket avatars
async function uploadAvatar(file) {
  if (!supabase || !file || !currentUser) throw new Error('Missing supabase/session/file');
  // normalized path: <user_id>/<timestamp>_<filename>
  const cleanName = file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const path = `${currentUser.id}/${Date.now()}_${cleanName}`;

  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, file, { upsert: false, cacheControl: '3600' });

  if (uploadError) {
    // if file exists and upsert false, try with different name and upsert
    if (uploadError?.status === 409) {
      const path2 = `${currentUser.id}/${Date.now()}_${Math.random().toString(36).slice(2,8)}_${cleanName}`;
      const { error: uploadError2 } = await supabase.storage.from('avatars').upload(path2, file, { upsert: true });
      if (uploadError2) throw uploadError2;
      const { data: publicData2 } = await supabase.storage.from('avatars').getPublicUrl(path2);
      const publicUrl2 = publicData2?.publicUrl ?? publicData2?.publicURL ?? null;
      if (!publicUrl2) throw new Error('Impossible de récupérer l’URL publique de l’avatar (après retry).');
      return { path: path2, publicUrl: publicUrl2 };
    }
    throw uploadError;
  }

  // get public URL
  const { data: publicData } = await supabase.storage.from('avatars').getPublicUrl(path);
  const publicUrl = publicData?.publicUrl ?? publicData?.publicURL ?? null;
  if (!publicUrl) {
    throw new Error('Impossible de récupérer l’URL publique de l’avatar.');
  }
  return { path, publicUrl };
}

// delete avatar object (if we can find storage path)
async function deleteAvatarObject(avatarUrl) {
  if (!supabase || !avatarUrl) return { removed: false };
  const storagePath = getStoragePathFromUrl(avatarUrl);
  if (!storagePath) return { removed: false, reason: 'path_not_found' };
  const { error } = await supabase.storage.from('avatars').remove([storagePath]);
  if (error) return { removed: false, error };
  return { removed: true };
}

// save profile action
async function handleSaveProfile() {
  if (!supabase) {
    showMsg('(Demo) Profil enregistré localement (aucun upload).');
    // local demo: just update preview
    if (pendingFile) avatarPreview.src = URL.createObjectURL(pendingFile);
    pendingFile = null;
    setTimeout(()=>showMsg(''), 2500);
    return;
  }
  if (!currentUser) {
    showMsg('Tu dois être connecté pour modifier ton profil.', true);
    return;
  }

  saveBtn.setAttribute('disabled', 'true');
  showMsg('Enregistrement en cours...');

  try {
    let avatar_url = currentProfile?.avatar_url ?? currentUser.user_metadata?.avatar_url ?? null;

    // if new file chosen -> upload to bucket and set avatar_url to publicUrl
    if (pendingFile) {
      // if there was an existing avatar, attempt to delete previous object to avoid orphans (best-effort)
      if (avatar_url) {
        try {
          const prevPath = getStoragePathFromUrl(avatar_url);
          if (prevPath) await supabase.storage.from('avatars').remove([prevPath]);
        } catch (e) { console.warn('Erreur suppression précédente (non bloquant)', e); }
      }

      const uploadResult = await uploadAvatar(pendingFile);
      avatar_url = uploadResult.publicUrl;
      pendingFile = null;
    }

    const inputPseudo = usernameInput?.value?.trim() ?? null;

    // Prepare payloads (we'll update/insert pseudo & avatar_url)
    const updatePayload = {
      pseudo: inputPseudo,
      avatar_url: avatar_url,
      updated_at: nowISO()
    };
    const insertPayload = {
      user_id: currentUser.id,
      pseudo: inputPseudo,
      avatar_url: avatar_url,
      created_at: nowISO(),
      updated_at: nowISO()
    };

    // If profile exists -> update, else insert
    if (currentProfile && currentProfile.id) {
      // update by id (safer)
      const { error: updateError, data: updatedRows } = await supabase
        .from('user_profiles')
        .update(updatePayload)
        .eq('id', currentProfile.id)
        .select()
        .maybeSingle();

      if (updateError) {
        // If update fails because pseudo column doesn't exist, try update without pseudo
        if (/column .*pseudo.*does not exist/i.test(updateError.message || '')) {
          const { error: updateError2 } = await supabase
            .from('user_profiles')
            .update({ avatar_url: avatar_url, updated_at: nowISO() })
            .eq('id', currentProfile.id);

          if (updateError2) throw updateError2;
        } else {
          throw updateError;
        }
      } else {
        // refresh currentProfile if returned
        if (updatedRows) currentProfile = updatedRows;
      }
    } else {
      // insert: try with pseudo
      const { error: insertError, data: inserted } = await supabase
        .from('user_profiles')
        .insert(insertPayload)
        .select()
        .maybeSingle();

      if (insertError) {
        // if pseudo column doesn't exist, try without pseudo
        if (/column .*pseudo.*does not exist/i.test(insertError.message || '')) {
          const { error: insertError2, data: inserted2 } = await supabase
            .from('user_profiles')
            .insert({
              user_id: currentUser.id,
              avatar_url: avatar_url,
              created_at: nowISO(),
              updated_at: nowISO()
            })
            .select()
            .maybeSingle();

          if (insertError2) throw insertError2;
          currentProfile = inserted2 ?? currentProfile;
        } else {
          throw insertError;
        }
      } else {
        currentProfile = inserted ?? currentProfile;
      }
    }

    // update auth user metadata so that session reflects avatar/pseudo (useful for index.html UI)
    try {
      // update arbitrary user_metadata key "pseudo" (you said you don't have username column)
      await supabase.auth.updateUser({ data: { avatar_url: avatar_url ?? null, pseudo: inputPseudo ?? null } });
    } catch (e) {
      console.warn('Impossible de mettre à jour user metadata (non bloquant)', e);
    }

    // refresh local preview + ensure delete button visible
    if (avatar_url) {
      avatarPreview.src = avatar_url;
      ensureDeleteButton();
    }

    // refresh follow counts UI (might be unchanged but safe)
    await updateFollowCountsUI();

    showMsg('Profil mis à jour avec succès.');
  } catch (err) {
    console.error('Erreur saveProfile', err);
    showMsg('Erreur lors de la sauvegarde du profil.', true);
  } finally {
    saveBtn.removeAttribute('disabled');
    setTimeout(()=>showMsg(''), 3000);
  }
}

// delete avatar handler (UI button)
async function handleDeleteAvatar() {
  if (!supabase) {
    avatarPreview.src = 'logo.png';
    showMsg('(Demo) Avatar supprimé localement.');
    return;
  }
  if (!currentUser) { showMsg('Non connecté.', true); return; }

  if (!currentProfile?.avatar_url && !currentUser.user_metadata?.avatar_url) {
    showMsg('Aucun avatar à supprimer.', true);
    return;
  }

  const avatarUrl = currentProfile?.avatar_url ?? currentUser.user_metadata?.avatar_url;

  // confirm (simple)
  if (!confirm('Supprimer définitivement l’avatar ?')) return;

  showMsg('Suppression en cours...');
  deleteBtn?.setAttribute('disabled', 'true');

  try {
    // delete object (best-effort)
    const del = await deleteAvatarObject(avatarUrl);
    if (!del.removed && del.reason !== 'path_not_found') {
      console.warn('Suppression objet avatar résultat:', del);
    }

    // update user_profiles row
    if (currentProfile && currentProfile.id) {
      const { error } = await supabase.from('user_profiles').update({ avatar_url: null, updated_at: nowISO() }).eq('id', currentProfile.id);
      if (error) throw error;
      currentProfile.avatar_url = null;
    } else {
      // try update by user_id as fallback
      const { error } = await supabase.from('user_profiles').update({ avatar_url: null, updated_at: nowISO() }).eq('user_id', currentUser.id);
      if (error) console.warn('update by user_id failed (non-blocking)', error);
    }

    // update auth metadata
    try {
      await supabase.auth.updateUser({ data: { avatar_url: null } });
    } catch (e) { console.warn('updateUser metadata failed (non blocking)', e); }

    avatarPreview.src = 'logo.png';
    showMsg('Avatar supprimé.');
    // remove delete button
    if (deleteBtn && deleteBtn.parentNode) deleteBtn.parentNode.removeChild(deleteBtn);
    deleteBtn = null;
  } catch (err) {
    console.error('Erreur suppression avatar', err);
    showMsg('Erreur lors de la suppression de l’avatar.', true);
    deleteBtn?.removeAttribute('disabled');
  } finally {
    setTimeout(()=>showMsg(''), 2500);
  }
}

// attach listeners
saveBtn?.addEventListener('click', handleSaveProfile);
cancelBtn?.addEventListener('click', (e) => {
  // same behavior as in index.html: close profile panel
  const profilePanel = document.getElementById('profilePanel');
  const homePanel = document.getElementById('homePanel');
  const menuHome = document.getElementById('menuHome');
  if (profilePanel) profilePanel.classList.add('hidden');
  if (homePanel) homePanel.classList.remove('hidden');
  if (menuHome) {
    // set active styling (same as index.html helper)
    [
      document.getElementById('menuHome'),
      document.getElementById('menuStats'),
      document.getElementById('menuGames'),
      document.getElementById('menuTiks'),
      document.getElementById('menuTx'),
      document.getElementById('menuMingots'),
      document.getElementById('menuProfile')
    ].forEach(el => { if (el) el.classList.remove('bg-sky-500','text-white','font-semibold'); });
    menuHome.classList.add('bg-sky-500','text-white','font-semibold');
  }
});

// init
await loadProfile();
