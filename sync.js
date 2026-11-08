// Google login + Supabase sync.
// Notes and shares are always written to IndexedDB first; this uploads pending rows and downloads
// rows changed elsewhere (your other devices, or friends editing a note you shared). A sync is requested after every change (debounced), when the connection
// comes back, when the app returns to the foreground, every minute while open, and when
// Supabase Realtime reports a change from another device.

const Cloud = (() => {
  const cfg = window.APP_CONFIG || {};
  const isHosted = location.protocol === 'http:' || location.protocol === 'https:';
  const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);

  const client = configured
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        db: { schema: cfg.SCHEMA || 'notesgo' },
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'pkce',
          // Own key, so NotesGo and myExpenses on the same github.io origin don't share/clobber sessions.
          storageKey: 'notesgo-auth',
        },
      })
    : null;

  const PAGE = 500;
  let user = null;
  let running = null;
  let again = false;
  let timer = null;
  let retryDelay = 5000;
  let channel = null;
  const state = { syncing: false, error: null, lastSyncedAt: null };
  let notify = () => {};

  async function init(onChange) {
    notify = onChange;
    if (!client) return null;
    // Reads the saved session from localStorage, so it also works offline after the first login.
    const { data } = await client.auth.getSession();
    user = data.session?.user ?? null;
    client.auth.onAuthStateChange((_event, session) => {
      const next = session?.user ?? null;
      if (next?.id === user?.id) return;
      user = next;
      notify('auth');
    });
    if (new URLSearchParams(location.search).has('code')) history.replaceState(null, '', location.pathname);

    window.addEventListener('online', () => requestSync(0));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestSync(0);
    });
    setInterval(() => document.visibilityState === 'visible' && requestSync(0), 60000);
    return user;
  }

  async function signInWithGoogle() {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  }

  async function signOut() {
    stopRealtime();
    await client.auth.signOut({ scope: 'local' });
    user = null;
  }

  function startRealtime() {
    if (!client || !user || channel) return;
    channel = client
      .channel(`notesgo-${user.id}`)
      // No filter: Row Level Security only delivers rows this user may see (own + shared with them).
      .on('postgres_changes', { event: '*', schema: cfg.SCHEMA || 'notesgo', table: 'notes' }, () => requestSync(400))
      .on('postgres_changes', { event: '*', schema: cfg.SCHEMA || 'notesgo', table: 'note_shares' }, () => requestSync(400))
      .subscribe();
  }

  function stopRealtime() {
    if (channel) client.removeChannel(channel);
    channel = null;
  }

  /** Ask for a sync in `delay` ms. Repeated calls within the delay collapse into one. */
  function requestSync(delay = 1200) {
    clearTimeout(timer);
    timer = setTimeout(syncNow, delay);
  }

  /** Upload pending rows, then download changes. Calls during a run queue exactly one more run. */
  function syncNow() {
    if (!client || !user || !navigator.onLine) {
      notify('sync');
      return Promise.resolve();
    }
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      state.syncing = true;
      notify('sync');
      try {
        const vaultChanged = await syncVault(user.id);
        let pushed = await pushNotes(user.id);
        pushed = (await pushShares(user.id)) || pushed;
        let pulled = await pullTable('notes', 'notes', noteFromServer, user.id);
        pulled = (await pullTable('shares', 'note_shares', shareFromServer, user.id)) || pulled;
        pulled = (await reconcileShared(user.id, user.email)) || pulled;
        state.error = null;
        state.lastSyncedAt = new Date();
        retryDelay = 5000;
        if (vaultChanged) notify('vault');
        if (pushed || pulled || vaultChanged) notify('data');
      } catch (e) {
        state.error = e?.message || String(e);
        requestSync(retryDelay); // keep trying with backoff (up to 2 min)
        retryDelay = Math.min(retryDelay * 2, 120000);
      } finally {
        state.syncing = false;
        running = null;
        notify('sync');
        if (again) {
          again = false;
          requestSync(0);
        }
      }
    })();
    return running;
  }

  const noteFromServer = (r) => ({
    ...r,
    kind: r.kind || 'text',
    title: r.title || '',
    content: r.content || '',
    items: Array.isArray(r.items) ? r.items : [],
    tags: r.tags || [],
    cipher: r.cipher || '',
    edited_by: r.edited_by || '',
    synced: 1,
  });
  const shareFromServer = (r) => ({ ...r, synced: 1 });
  // Fields a friend with edit access may change on a note they don't own (see guard_shared_edit).
  const SHARED_FIELDS = ['kind', 'title', 'content', 'items', 'edited_by', 'edited_at'];

  /** After the server answered an upload, store its version unless the row was edited meanwhile. */
  async function settle(store, sent, remoteRows, fromServer) {
    const sentVersion = new Map(sent.map((r) => [r.id, r.updated_at]));
    for (const remote of remoteRows || []) {
      const current = await DB.get(store, remote.id);
      if (current && current.updated_at !== sentVersion.get(remote.id)) continue; // edited meanwhile
      if (remote.deleted && store === 'notes') await DB.delete(store, remote.id); // tombstone delivered
      else await DB.put(store, fromServer(remote));
    }
  }

  async function pushNotes(userId) {
    const pending = (await DB.all('notes')).filter((r) => r.synced === 0);
    if (!pending.length) return false;
    const own = pending.filter((r) => r.user_id === userId);
    const foreign = pending.filter((r) => r.user_id !== userId);
    for (let i = 0; i < own.length; i += PAGE) {
      const batch = own.slice(i, i + PAGE);
      const payload = batch.map(({ synced, updated_at, ...row }) => row); // server sets updated_at
      const { data, error } = await client.from('notes').upsert(payload).select();
      if (error) throw error;
      await settle('notes', batch, data, noteFromServer);
    }
    // Notes shared with me: update only the text fields (upsert would need insert rights).
    for (const row of foreign) {
      const patch = Object.fromEntries(SHARED_FIELDS.map((k) => [k, row[k]]));
      const { data, error } = await client.from('notes').update(patch).eq('id', row.id).select();
      if (error) throw error;
      if (!data.length) {
        // No edit access any more: drop the local change, the next pull restores the server copy.
        await DB.delete('notes', row.id);
        await DB.setMeta(`lastPulledAt:notes:${userId}`, null);
        continue;
      }
      await settle('notes', [row], data, noteFromServer);
    }
    return true;
  }

  async function pushShares(userId) {
    const pending = (await DB.all('shares')).filter((r) => r.user_id === userId && r.synced === 0);
    if (!pending.length) return false;
    const payload = pending.map(({ synced, updated_at, ...row }) => row);
    const { data, error } = await client.from('note_shares').upsert(payload, { onConflict: 'id' }).select();
    if (error) throw error;
    await settle('shares', pending, data, shareFromServer);
    return true;
  }

  async function pullTable(store, table, fromServer, userId) {
    const cursorKey = `lastPulledAt:${table}:${userId}`;
    let cursor = (await DB.getMeta(cursorKey)) || '1970-01-01T00:00:00Z';
    let changed = false;
    for (;;) {
      // No user filter: Row Level Security returns my rows plus rows shared with me.
      const { data, error } = await client
        .from(table)
        .select('*')
        .gt('updated_at', cursor)
        .order('updated_at', { ascending: true })
        .limit(PAGE);
      if (error) throw error;
      if (!data.length) break;
      for (const remote of data) {
        const local = await DB.get(store, remote.id);
        if (local?.synced === 0) continue; // unsent local edit wins; it uploads next time
        if (local && local.updated_at === remote.updated_at) continue; // our own upload coming back
        if (remote.deleted && store === 'notes') {
          if (local) await DB.delete(store, remote.id);
        } else {
          await DB.put(store, fromServer(remote));
        }
        changed = true;
      }
      cursor = data[data.length - 1].updated_at;
      await DB.setMeta(cursorKey, cursor);
      if (data.length < PAGE) break;
    }
    await DB.setMeta(cursorKey, cursor);
    return changed;
  }

  /**
   * Sharing bookkeeping after a pull:
   *  - newly shared with me → download that note (it may be older than my sync cursor)
   *  - access removed       → drop my local copy
   */
  async function reconcileShared(userId, email) {
    if (!email) return false;
    const me = email.toLowerCase();
    const mine = (await DB.all('shares')).filter((s) => s.email === me && s.user_id !== userId);
    const active = new Set(mine.filter((s) => !s.deleted).map((s) => s.note_id));
    const notes = await DB.all('notes');
    let changed = false;
    for (const n of notes) {
      if (n.user_id !== userId && !active.has(n.id)) {
        await DB.delete('notes', n.id);
        changed = true;
      }
    }
    const have = new Set(notes.map((n) => n.id));
    const missing = [...active].filter((id) => !have.has(id));
    if (missing.length) {
      const { data, error } = await client.from('notes').select('*').in('id', missing);
      if (error) throw error;
      await DB.putMany('notes', data.filter((r) => !r.deleted).map(noteFromServer));
      changed = changed || data.length > 0;
    }
    return changed;
  }

  /** Remove a note someone shared with me from my notes (their copy stays). */
  async function leaveShare(noteId) {
    const { error } = await client.rpc('leave_share', { p_note: noteId });
    if (error) throw error;
  }

  /** Keep the local vault record equal to the server's. Returns true if it changed. */
  async function syncVault(userId) {
    const local = await DB.get('vault', userId);
    const remote = await fetchVault();
    if (!remote) {
      if (local) {
        await DB.delete('vault', userId); // secure folder was reset on another device
        return true;
      }
      return false;
    }
    if (local && local.salt === remote.salt && local.check_value === remote.check_value) return false;
    await DB.put('vault', { ...remote, synced: 1 });
    return true;
  }

  async function fetchVault() {
    const { data, error } = await client.from('vaults').select('*').maybeSingle();
    if (error) throw error;
    return data;
  }

  /** Create the vault on the server. Returns the server row; `existing` if one was already there. */
  async function createVault(record) {
    const { data, error } = await client.from('vaults').insert(record).select().single();
    if (error) {
      if (error.code === '23505') return { existing: await fetchVault() };
      throw error;
    }
    return { row: data };
  }

  async function replaceVault(record) {
    const { data, error } = await client.from('vaults').update(record).eq('user_id', user.id).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteVault() {
    const { error } = await client.from('vaults').delete().eq('user_id', user.id);
    if (error) throw error;
  }

  return {
    init,
    signInWithGoogle,
    signOut,
    syncNow,
    requestSync,
    startRealtime,
    stopRealtime,
    fetchVault,
    createVault,
    replaceVault,
    deleteVault,
    leaveShare,
    state,
    get user() {
      return user;
    },
    configured,
    isHosted,
    canSignIn: configured && isHosted,
  };
})();
