// NotesGo UI: views, note cards, multi-select, editor (text + checklist), tags, colours,
// sharing, secure folder, account & sync status.

const CFG = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nowIso = () => new Date().toISOString();
const icon = (id) => `<svg><use href="#${id}"/></svg>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const COLORS = [
  ['default', 'No colour'],
  ['rose', 'Rose'],
  ['peach', 'Peach'],
  ['lemon', 'Lemon'],
  ['lime', 'Lime'],
  ['mint', 'Mint'],
  ['aqua', 'Aqua'],
  ['sky', 'Sky'],
  ['indigo', 'Indigo'],
  ['violet', 'Violet'],
  ['orchid', 'Orchid'],
  ['sand', 'Sand'],
];
const PRIVATE = ['title', 'content', 'items', 'tags']; // encrypted for secure notes
const SHARED_EDITABLE = ['kind', 'title', 'content', 'items']; // what friends with edit access may change

const S = {
  user: null,
  email: '',
  notes: [], // own notes + notes shared with me (not deleted)
  shares: [], // share rows: ones I created + ones addressed to me
  pending: 0,
  plain: new Map(), // secure note id → { title, content, items, tags } (only while unlocked)
  plainCipher: new Map(),
  vault: null,
  view: 'notes', // notes | shared | secure | archive | trash | tag
  tag: null,
  filter: 'all', // all | pinned | text | checklist
  query: '',
  layout: store.get('notesgo-layout', 'list'),
  sel: null, // Set of selected note ids while selecting
  ed: null, // open editor state
  hiddenAt: 0,
  failedUnlocks: 0,
  lockUntil: 0,
};

/* ======================================================================
   Overlays + Android/browser back button
   ====================================================================== */
const overlays = [];
const popWaiters = [];
history.replaceState({ depth: 0 }, '');

function pushOverlay(close) {
  overlays.push(close);
  history.pushState({ depth: overlays.length }, '');
}
function popOverlay() {
  return new Promise((resolve) => {
    if (!overlays.length) return resolve();
    popWaiters.push(resolve);
    history.back();
  });
}
window.addEventListener('popstate', (e) => {
  const depth = e.state?.depth || 0;
  while (overlays.length > depth) overlays.pop()();
  popWaiters.splice(0).forEach((r) => r());
});

/* ---------- Bottom sheet ---------- */
let sheet = null;
let sheetOpenedAt = 0;

function openSheet(html, onClose) {
  const host = $('sheet');
  // Fresh container each time, so listeners from an earlier sheet never fire on this one.
  const el = document.createElement('div');
  el.innerHTML = html;
  host.replaceChildren(el);
  host.scrollTop = 0;
  if (sheet) {
    const prev = sheet.onClose;
    sheet = { onClose, result: undefined };
    prev?.(undefined);
  } else {
    sheet = { onClose, result: undefined };
    sheetOpenedAt = Date.now();
    host.hidden = false;
    $('sheetScrim').hidden = false;
    pushOverlay(() => {
      host.hidden = true;
      $('sheetScrim').hidden = true;
      host.replaceChildren();
      const s = sheet;
      sheet = null;
      s?.onClose?.(s.result);
    });
  }
  const first = el.querySelector('[autofocus]');
  if (first) setTimeout(() => first.focus(), 80);
  return el;
}
function closeSheet(result) {
  if (sheet) sheet.result = result;
  return popOverlay();
}
$('sheetScrim').addEventListener('click', () => Date.now() - sheetOpenedAt > 350 && closeSheet());

const sheetHero = (ic, title, text = '', danger = false) =>
  `<div class="sheet-hero"><span class="sheet-icon ${danger ? 'danger' : ''}">${icon(ic)}</span><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}</div>`;

/** A bottom-sheet menu. items: [action, icon, label, {danger, hint}] → resolves the chosen action. */
function menuSheet(title, items) {
  return new Promise((resolve) => {
    const el = openSheet(
      `${title ? `<div class="sheet-hero"><h3>${esc(title)}</h3></div>` : ''}<div class="menu">${items
        .map(
          ([a, ic, label, o = {}]) =>
            `<button class="menu-item ${o.danger ? 'danger' : ''}" data-a="${a}"><span class="mi-icon">${icon(ic)}</span><span>${esc(label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></button>`,
        )
        .join('')}</div>`,
      (r) => resolve(r),
    );
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a) closeSheet(a);
    });
  });
}

function confirmSheet({ title, text, ok = 'OK', danger = false, ic = 'i-alert' }) {
  return new Promise((resolve) => {
    const el = openSheet(
      `${sheetHero(ic, title, text, danger)}
       <div class="sheet-actions"><button class="btn btn-ghost" data-a="no">Cancel</button>
       <button class="btn ${danger ? 'btn-danger' : 'btn-gradient'}" data-a="yes">${esc(ok)}</button></div>`,
      (r) => resolve(r === true),
    );
    el.querySelector('[data-a=no]').onclick = () => closeSheet(false);
    el.querySelector('[data-a=yes]').onclick = () => closeSheet(true);
  });
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  t.classList.toggle('top', Boolean(sheet) || !$('selBar').hidden); // stay clear of open sheets
  if (action)
    t.querySelector('button').onclick = () => {
      t.hidden = true;
      action.run();
    };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 5000 : 2600);
}

/* ======================================================================
   Data
   ====================================================================== */
const saveChains = new Map();
function queue(id, fn) {
  const p = (saveChains.get(id) || Promise.resolve()).then(fn).catch((e) => {
    console.error(e);
    toast(`Couldn't save: ${e.message || e}`);
  });
  saveChains.set(id, p);
  return p;
}
const allSaved = () => Promise.all([...saveChains.values()]);

async function reload() {
  await allSaved();
  const rows = await DB.all('notes');
  const shares = await DB.all('shares');
  S.pending = rows.filter((n) => n.synced === 0).length + shares.filter((s) => s.synced === 0).length;
  S.notes = rows.filter((n) => !n.deleted);
  S.shares = shares;
  S.vault = (await DB.get('vault', S.user.id)) || null;
  await decryptAll();
  render();
  renderSync();
}

async function decryptAll() {
  if (!Vault.unlocked) {
    S.plain.clear();
    S.plainCipher.clear();
    return;
  }
  const ids = new Set();
  for (const n of S.notes) {
    if (!n.secure || !isOwn(n)) continue;
    ids.add(n.id);
    if (S.plainCipher.get(n.id) === n.cipher) continue;
    const p = await Vault.decryptNote(n.cipher);
    if (p) S.plain.set(n.id, p);
    else S.plain.delete(n.id);
    S.plainCipher.set(n.id, n.cipher);
  }
  for (const id of [...S.plain.keys()]) if (!ids.has(id)) S.plain.delete(id);
}

const findNote = (id) => S.notes.find((n) => n.id === id);
const isOwn = (n) => n.user_id === S.user.id;
/** Title/content/items/tags of a note, or null for a secure note that can't be read right now. */
const fieldsOf = (n) => (n.secure ? S.plain.get(n.id) || null : n);
/** Active shares I created for a note. */
const sharesOf = (id) => S.shares.filter((s) => s.note_id === id && s.user_id === S.user.id && !s.deleted);
/** The share that gives me access to someone else's note. */
const myShareFor = (id) => S.shares.find((s) => s.note_id === id && s.email === S.email && s.user_id !== S.user.id && !s.deleted);
const roleOf = (n) => (isOwn(n) ? 'owner' : myShareFor(n.id)?.role || null);
const canEdit = (n) => !n.trashed && (isOwn(n) || roleOf(n) === 'edit');
const myName = () => S.user.user_metadata?.full_name || S.user.user_metadata?.name || S.user.email || '';

async function refreshPending() {
  const rows = await DB.all('notes');
  const shares = await DB.all('shares');
  S.pending = rows.filter((n) => n.synced === 0).length + shares.filter((s) => s.synced === 0).length;
  renderSync();
}

async function persist(n) {
  n.updated_at = nowIso();
  n.synced = 0;
  await DB.put('notes', n);
  await refreshPending();
  Cloud.requestSync();
}

async function persistShare(s) {
  s.updated_at = nowIso();
  s.synced = 0;
  await DB.put('shares', s);
  if (!S.shares.includes(s)) S.shares.push(s);
  await refreshPending();
  Cloud.requestSync();
}

/** Change a note. Private fields are encrypted automatically for secure notes. */
function updateNote(id, changes, { touch = true } = {}) {
  return queue(id, async () => {
    const n = findNote(id);
    if (!n) return;
    if (!isOwn(n)) {
      // Friends may only edit the text of notes shared with them.
      if (roleOf(n) !== 'edit') return;
      changes = Object.fromEntries(Object.entries(changes).filter(([k]) => SHARED_EDITABLE.includes(k)));
      if (!Object.keys(changes).length) return;
    }
    const priv = {};
    for (const k of PRIVATE) if (k in changes) priv[k] = changes[k];
    for (const [k, v] of Object.entries(changes)) if (!(k in priv)) n[k] = v;
    if (Object.keys(priv).length) {
      if (n.secure) {
        const p = { ...(S.plain.get(id) || { title: '', content: '', items: [], tags: [] }), ...priv };
        n.cipher = await Vault.encryptNote(p);
        S.plain.set(id, p);
        S.plainCipher.set(id, n.cipher);
      } else Object.assign(n, priv);
    }
    if (touch) {
      n.edited_at = nowIso();
      n.edited_by = myName();
    }
    await persist(n);
  });
}

async function createNote({ kind = 'text', title = '', content = '', items = [], tags = [], color = 'default', pinned = false, secure = false, id = newId() }) {
  const t = nowIso();
  const n = {
    id,
    user_id: S.user.id,
    kind,
    title: '',
    content: '',
    items: [],
    tags: [],
    color,
    pinned,
    archived: false,
    trashed: false,
    trashed_at: null,
    secure,
    cipher: '',
    edited_by: myName(),
    edited_at: t,
    created_at: t,
    updated_at: t,
    deleted: false,
    synced: 0,
  };
  items = items.map((i) => ({ ...i }));
  tags = [...tags];
  if (secure) {
    const p = { title, content, items, tags };
    n.cipher = await Vault.encryptNote(p);
    S.plain.set(id, p);
    S.plainCipher.set(id, n.cipher);
  } else Object.assign(n, { title, content, items, tags });
  S.notes.push(n);
  await persist(n);
  return n;
}

async function stopSharing(id) {
  for (const s of sharesOf(id)) {
    s.deleted = true;
    await persistShare(s);
  }
}

/** Delete forever: keep a blank tombstone so other devices remove it too. */
function deleteForever(id) {
  return queue(id, async () => {
    const n = findNote(id);
    if (!n || !isOwn(n)) return;
    await stopSharing(id);
    Object.assign(n, { title: '', content: '', items: [], tags: [], cipher: '', deleted: true });
    S.notes = S.notes.filter((x) => x.id !== id);
    S.plain.delete(id);
    await persist(n);
  });
}

async function purgeOldTrash() {
  const limit = Date.now() - (CFG.TRASH_DAYS || 7) * 86400000;
  const old = S.notes.filter((n) => isOwn(n) && n.trashed && n.trashed_at && new Date(n.trashed_at).getTime() < limit);
  for (const n of old) await deleteForever(n.id);
}

async function trashNotes(ids) {
  ids = ids.filter((id) => findNote(id) && isOwn(findNote(id)));
  for (const id of ids) await updateNote(id, { trashed: true, trashed_at: nowIso(), pinned: false }, { touch: false });
  render();
  if (ids.length)
    toast(`${plural(ids.length, 'note')} moved to Trash`, {
      label: 'Undo',
      run: () => restoreNotes(ids, true),
    });
}
async function restoreNotes(ids, quiet = false) {
  for (const id of ids) await updateNote(id, { trashed: false, trashed_at: null }, { touch: false });
  render();
  if (!quiet) toast(`${plural(ids.length, 'note')} restored`);
}
async function setArchived(ids, archived) {
  ids = ids.filter((id) => findNote(id) && isOwn(findNote(id)) && !findNote(id).secure);
  for (const id of ids) await updateNote(id, { archived, ...(archived ? { pinned: false } : {}) }, { touch: false });
  render();
  if (ids.length)
    toast(archived ? `${plural(ids.length, 'note')} archived` : `${plural(ids.length, 'note')} unarchived`, {
      label: 'Undo',
      run: async () => {
        for (const id of ids) await updateNote(id, { archived: !archived }, { touch: false });
        render();
      },
    });
}
async function setPinned(ids, pinned) {
  ids = ids.filter((id) => findNote(id) && isOwn(findNote(id)));
  for (const id of ids) await updateNote(id, { pinned, ...(pinned ? { archived: false } : {}) }, { touch: false });
  render();
  return ids.length;
}

async function copyNote(id) {
  const n = findNote(id);
  const f = n && fieldsOf(n);
  if (!f) return;
  await createNote({
    kind: n.kind,
    title: f.title,
    content: f.content,
    items: f.items.map((i) => ({ ...i, id: newId() })),
    tags: isOwn(n) ? [...f.tags] : [],
    color: isOwn(n) ? n.color : 'default',
    secure: n.secure,
  });
  render();
  toast('Copy made');
}

async function leaveNotes(ids) {
  if (!navigator.onLine) return toast('Go online to remove shared notes.');
  for (const id of ids) {
    try {
      await Cloud.leaveShare(id);
      const s = myShareFor(id);
      if (s) {
        s.deleted = true;
        await DB.put('shares', s);
      }
      await DB.delete('notes', id);
      S.notes = S.notes.filter((n) => n.id !== id);
    } catch (e) {
      toast(e.message || String(e));
    }
  }
  render();
}

function allTags({ includeSecure = false } = {}) {
  const set = new Set();
  for (const n of S.notes) {
    if (n.trashed || !isOwn(n)) continue;
    const f = n.secure ? (includeSecure ? S.plain.get(n.id) : null) : n;
    f?.tags.forEach((t) => set.add(t));
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/* ======================================================================
   Rendering
   ====================================================================== */
function inView(n) {
  const own = isOwn(n);
  if (!own) {
    // Someone else's note: visible while it's shared with me and not trashed by its owner.
    if (n.trashed || n.secure || !myShareFor(n.id)) return false;
    return S.view === 'notes' || S.view === 'shared';
  }
  switch (S.view) {
    case 'shared':
      return !n.trashed && !n.secure && sharesOf(n.id).length > 0;
    case 'archive':
      return n.archived && !n.trashed && !n.secure;
    case 'secure':
      return n.secure && !n.trashed;
    case 'trash':
      return n.trashed;
    case 'tag':
      return !n.trashed && !n.secure && n.tags.includes(S.tag);
    default:
      return !n.trashed && !n.secure && (S.query ? true : !n.archived); // search also finds archived notes
  }
}

function visibleNotes() {
  const q = S.query.trim().toLowerCase();
  return S.notes
    .filter(inView)
    .filter((n) => {
      if (S.filter === 'pinned' && !n.pinned) return false;
      if (S.filter === 'text' && n.kind === 'checklist') return false;
      if (S.filter === 'checklist' && n.kind !== 'checklist') return false;
      if (!q) return true;
      const f = fieldsOf(n);
      return f && `${f.title}\n${f.content}\n${f.items.map((i) => i.text).join('\n')}\n${f.tags.join(' ')}`.toLowerCase().includes(q);
    })
    .sort((a, b) => (b.edited_at > a.edited_at ? 1 : b.edited_at < a.edited_at ? -1 : 0));
}

function columnCount() {
  const w = $('main').clientWidth;
  if (S.layout === 'list') return 1;
  return w < 640 ? 2 : w < 900 ? 3 : 4;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

function cardEl(n) {
  const f = fieldsOf(n);
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = n.id;
  el.tabIndex = 0;
  const selecting = Boolean(S.sel);
  if (selecting && S.sel.has(n.id)) el.classList.add('sel');
  if (isOwn(n) && n.color && n.color !== 'default') {
    el.dataset.color = n.color;
    el.classList.add('colored');
  }
  const selBox = selecting ? `<span class="sel-box">${icon('i-check')}</span>` : '';
  if (!f) {
    el.innerHTML = `<div class="card-head">${selBox}<div class="locked">${icon('i-lock')}Secure note</div></div>`;
    return el;
  }
  let body = '';
  if (n.kind === 'checklist') {
    const open = f.items.filter((i) => !i.done);
    const done = f.items.length - open.length;
    const shown = open.slice(0, 6);
    body = `<ul class="card-items">${shown
      .map((i) => `<li data-item="${esc(i.id)}"><button class="cbox" type="button" aria-label="Tick">${icon('i-check')}</button><span>${esc(i.text) || '&nbsp;'}</span></li>`)
      .join('')}${open.length > shown.length ? `<li class="more">+ ${open.length - shown.length} more</li>` : ''}${
      done ? `<li class="more">${icon('i-check')} ${done} done</li>` : ''
    }</ul>`;
    if (!f.items.length) body = '<p class="body empty-body">Empty list</p>';
  } else {
    const text = f.content.length > 600 ? `${f.content.slice(0, 600)}…` : f.content;
    body = text ? `<p class="body">${esc(text)}</p>` : f.title ? '' : '<p class="body empty-body">Empty note</p>';
  }
  const pills = [];
  if (n.secure && S.view !== 'secure') pills.push(`<span class="pill">${icon('i-lock')}Secure</span>`);
  if (isOwn(n)) {
    const cnt = sharesOf(n.id).length;
    if (cnt) pills.push(`<span class="pill share">${icon('i-people')}Shared · ${cnt}</span>`);
  } else {
    const s = myShareFor(n.id);
    pills.push(`<span class="pill share">${icon('i-people')}${esc(s?.owner_name || s?.owner_email || 'Shared')}${s?.role === 'view' ? ' · view' : ''}</span>`);
  }
  if (n.kind === 'checklist' && f.items.length) {
    const d = f.items.filter((i) => i.done).length;
    pills.push(`<span class="pill">${icon('i-checklist')}${d}/${f.items.length}</span>`);
  }
  f.tags.forEach((t) => pills.push(`<span class="pill">${icon('i-tag')}${esc(t)}</span>`));
  el.innerHTML = `
    <div class="card-head">${selBox}${f.title ? `<h4>${esc(f.title)}</h4>` : '<span style="flex:1"></span>'}
      ${n.pinned && isOwn(n) && S.view !== 'trash' ? `<svg class="pin-mark"><use href="#i-pin-on"/></svg>` : ''}</div>
    ${body}
    <div class="card-foot">${pills.join('')}<span class="date">${esc(fmtTime(n.edited_at))}</span></div>`;
  return el;
}

function fillGrid(container, notes) {
  container.innerHTML = '';
  container.classList.toggle('grid', S.layout === 'grid');
  const cols = Array.from({ length: columnCount() }, () => {
    const c = document.createElement('div');
    c.className = 'col';
    container.appendChild(c);
    return c;
  });
  // Masonry: each card goes into the currently shortest column, keeping left-to-right order.
  for (const n of notes) {
    let target = cols[0];
    for (const c of cols) if (c.offsetHeight < target.offsetHeight) target = c;
    target.appendChild(cardEl(n));
  }
}

const VIEW_INFO = {
  notes: { title: 'My Notes', icon: 'i-note', empty: ['No notes yet', 'Tap “New” to write a note or start a checklist.'] },
  shared: { title: 'Shared', icon: 'i-people', empty: ['Nothing shared yet', 'Notes you share, and notes friends share with you, show up here.'] },
  secure: { title: 'Secure folder', icon: 'i-lock', empty: ['Secure folder is empty', 'Move notes here to encrypt them with your password.'] },
  archive: { title: 'Archive', icon: 'i-archive', empty: ['No archived notes', 'Archive notes you want to keep but not see every day.'] },
  trash: { title: 'Trash', icon: 'i-trash', empty: ['Trash is empty', 'Deleted notes stay here for a while before they go for good.'] },
  tag: { title: '', icon: 'i-tag', empty: ['No notes with this tag', 'Add tags from a note’s tag button.'] },
};

const CHIPS = [
  ['all', 'i-note', 'All'],
  ['pinned', 'i-pin-on', 'Pinned'],
  ['text', 'i-text', 'Notes'],
  ['checklist', 'i-checklist', 'Checklists'],
];

function render() {
  if (!S.user) return;
  const info = VIEW_INFO[S.view];
  $('viewTitle').textContent = S.view === 'tag' ? `# ${S.tag}` : info.title;
  $('search').placeholder = S.view === 'notes' ? 'Search notes, lists and tags' : `Search in ${S.view === 'tag' ? S.tag : info.title}`;
  $('chips').innerHTML = CHIPS.map(
    ([k, ic, label]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-filter="${k}" role="tab" aria-selected="${S.filter === k}">${icon(ic)}${label}</button>`,
  ).join('');
  $('viewBtn').innerHTML = icon(S.layout === 'grid' ? 'i-list' : 'i-grid');
  $('viewBtn').setAttribute('aria-label', S.layout === 'grid' ? 'Show as list' : 'Show as grid');
  $('selectBtn').classList.toggle('on', Boolean(S.sel));
  const locked = S.view === 'secure' && !Vault.unlocked;
  $('fab').hidden = Boolean(S.sel) || ['trash', 'archive'].includes(S.view) || locked;
  $('selectBtn').hidden = locked;
  $('chips').hidden = locked;
  $('viewBtn').hidden = locked;

  const banner = $('banner');
  banner.hidden = true;
  if (S.view === 'trash' && S.notes.some((n) => n.trashed && isOwn(n))) {
    banner.hidden = false;
    banner.innerHTML = `${icon('i-trash')}<span style="flex:1">Notes in Trash are deleted after ${CFG.TRASH_DAYS || 7} days.</span><button class="btn btn-sm btn-ghost" id="emptyTrash">Empty</button>`;
    $('emptyTrash').onclick = emptyTrash;
  } else if (S.view === 'secure' && Vault.unlocked) {
    banner.hidden = false;
    banner.innerHTML = `${icon('i-unlock')}<span style="flex:1">Unlocked. Notes here are encrypted on your device.</span><button class="btn btn-sm btn-ghost" id="lockNow">Lock</button>`;
    $('lockNow').onclick = () => lockVault();
  }

  const empty = $('empty');
  if (locked) {
    $('pinnedWrap').hidden = true;
    $('othersLabel').hidden = true;
    $('others').innerHTML = '';
    empty.hidden = false;
    const hasVault = Boolean(S.vault);
    empty.className = 'empty vault-lock';
    empty.innerHTML = `<div class="empty-icon">${icon('i-lock')}</div>
        <h3>${hasVault ? 'Secure folder is locked' : 'Set up your Secure folder'}</h3>
        <p>${hasVault ? 'Enter your password to see these notes.' : 'Notes here are encrypted on your device with a password only you know.'}</p>
        <button class="btn btn-gradient" id="vaultGo">${icon(hasVault ? 'i-unlock' : 'i-key')}${hasVault ? 'Unlock' : 'Set password'}</button>`;
    $('vaultGo').onclick = () => ensureUnlocked().then((ok) => ok && reload());
    return;
  }

  const notes = visibleNotes();
  const split = S.view !== 'trash' && S.filter !== 'pinned';
  const pinned = split ? notes.filter((n) => n.pinned && isOwn(n)) : [];
  const others = split ? notes.filter((n) => !(n.pinned && isOwn(n))) : notes;
  $('pinnedWrap').hidden = !pinned.length;
  $('othersLabel').hidden = !(pinned.length && others.length);
  fillGrid($('pinned'), pinned);
  fillGrid($('others'), others);

  empty.hidden = notes.length > 0;
  empty.className = 'empty';
  if (!notes.length) {
    const [h, p] = S.query || S.filter !== 'all' ? ['No matching notes', 'Try another search or filter.'] : info.empty;
    empty.innerHTML = `<div class="empty-icon">${icon(S.query ? 'i-search' : info.icon)}</div><h3>${esc(h)}</h3><p>${esc(p)}</p>`;
  }
  if (S.sel) renderSelBar();
}

function renderSync() {
  const st = Cloud.state;
  let ic = 'i-cloud-done';
  let text = 'Synced';
  let cls = '';
  let label = 'All changes synced';
  if (!navigator.onLine) {
    ic = 'i-cloud-off';
    text = S.pending ? `Offline · ${S.pending} pending` : 'Offline';
    label = S.pending ? `Offline · ${S.pending} change(s) will sync later` : 'Offline · saved on this device';
  } else if (st.syncing) {
    ic = 'i-sync';
    text = 'Syncing…';
    cls = 'spin';
    label = 'Syncing…';
  } else if (st.error) {
    ic = 'i-alert';
    text = 'Sync error';
    cls = 'error';
    label = `Sync problem: ${st.error}`;
  } else if (S.pending) {
    ic = 'i-cloud-up';
    text = `${S.pending} pending`;
    label = `${S.pending} change(s) waiting to sync`;
  }
  const b = $('syncStatus');
  b.className = `status ${cls}`;
  b.innerHTML = `${icon(ic)}${esc(text)}`;
  b.dataset.label = label;
  b.title = label;
  $('onlineDot').classList.toggle('is-online', navigator.onLine);
}

let lastCols = 0;
window.addEventListener('resize', () => {
  const c = columnCount();
  if (c !== lastCols) {
    lastCols = c;
    render();
  }
});
window.addEventListener('online', renderSync);
window.addEventListener('offline', renderSync);

/* ======================================================================
   Views, side menu, search, chips
   ====================================================================== */
async function setView(view, tag = null) {
  if (S.view === 'secure' && view !== 'secure' && Vault.unlocked) await lockVault({ silent: true });
  S.view = view;
  S.tag = tag;
  S.query = '';
  $('search').value = '';
  $('clearSearch').hidden = true;
  window.scrollTo(0, 0);
  render();
}

function openDrawer() {
  const tags = allTags();
  const item = (view, ic, label, extra = '', tag = '') =>
    `<button class="drawer-item ${S.view === view && (view !== 'tag' || S.tag === tag) ? 'active' : ''}" data-view="${view}" data-tag="${esc(tag)}">
       ${icon(ic)}<span>${esc(label)}</span>${extra}</button>`;
  const count = (fn) => {
    const c = S.notes.filter(fn).length;
    return c ? `<small>${c}</small>` : '';
  };
  const visible = (n) => !n.trashed && !n.secure;
  $('drawerList').innerHTML = `
    ${item('notes', 'i-note', 'My Notes', count((n) => visible(n) && (isOwn(n) ? !n.archived : Boolean(myShareFor(n.id)))))}
    ${item('shared', 'i-people', 'Shared', count((n) => visible(n) && (isOwn(n) ? sharesOf(n.id).length > 0 : Boolean(myShareFor(n.id)))))}
    ${item('secure', Vault.unlocked ? 'i-unlock' : 'i-lock', 'Secure folder')}
    ${item('archive', 'i-archive', 'Archive', count((n) => isOwn(n) && n.archived && visible(n)))}
    ${item('trash', 'i-trash', 'Trash', count((n) => isOwn(n) && n.trashed))}
    <div class="drawer-label">Tags <button id="editTags" type="button">${tags.length ? 'Edit' : ''}</button></div>
    ${tags.map((t) => item('tag', 'i-tag', t, count((n) => isOwn(n) && visible(n) && n.tags.includes(t)), t)).join('') || '<p class="drawer-hint">No tags yet. Add them from a note.</p>'}`;
  $('themeLabel').textContent = `Theme: ${{ light: 'Light', dark: 'Dark' }[store.get('notesgo-theme', '')] || 'System'}`;
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  pushOverlay(() => {
    $('drawer').hidden = true;
    $('scrim').hidden = true;
  });
}

$('menuBtn').onclick = openDrawer;
$('scrim').onclick = () => popOverlay();
$('drawerList').addEventListener('click', async (e) => {
  if (e.target.closest('#editTags')) {
    await popOverlay();
    return editTagsSheet();
  }
  const b = e.target.closest('[data-view]');
  if (!b) return;
  await popOverlay();
  setView(b.dataset.view, b.dataset.view === 'tag' ? b.dataset.tag : null);
});
$('drawerOut').onclick = async () => {
  await popOverlay();
  signOut();
};

$('chips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-filter]');
  if (!c) return;
  S.filter = c.dataset.filter;
  render();
});
$('search').addEventListener('input', (e) => {
  S.query = e.target.value;
  $('clearSearch').hidden = !S.query;
  render();
});
$('clearSearch').onclick = () => {
  S.query = '';
  $('search').value = '';
  $('clearSearch').hidden = true;
  render();
};
$('viewBtn').onclick = () => {
  S.layout = S.layout === 'grid' ? 'list' : 'grid';
  store.set('notesgo-layout', S.layout);
  render();
};

/* ---------- Theme ---------- */
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
function applyTheme(t) {
  store.set('notesgo-theme', t);
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $('themeBtn').innerHTML = icon(isDark() ? 'i-sun' : 'i-moon');
  $('themeBtn').setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  $('themeLabel').textContent = `Theme: ${{ light: 'Light', dark: 'Dark' }[t] || 'System'}`;
}
$('themeBtn').onclick = () => applyTheme(isDark() ? 'light' : 'dark');
$('drawerTheme').onclick = () => {
  const order = ['', 'light', 'dark'];
  applyTheme(order[(order.indexOf(store.get('notesgo-theme', '')) + 1) % 3]);
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('notesgo-theme', '')));

/* ---------- Install ---------- */
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('installBtn').hidden = false;
});
$('installBtn').onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('installBtn').hidden = true;
};

/* ======================================================================
   Cards: tap opens (or toggles while selecting); long-press starts selecting
   ====================================================================== */
let press = null;
let swallowClickUntil = 0;
// After a long-press, ignore the click that comes from lifting the finger.
document.addEventListener(
  'pointerup',
  () => {
    if (swallowClickUntil === Infinity) swallowClickUntil = Date.now() + 400;
  },
  true,
);
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() < swallowClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
    swallowClickUntil = 0;
  },
  true,
);

$('main').addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  press = { id: card.dataset.id, x: e.clientX, y: e.clientY, long: false };
  press.timer = setTimeout(() => {
    press.long = true;
    swallowClickUntil = Infinity;
    navigator.vibrate?.(15);
    if (S.sel) toggleSel(press.id);
    else startSelect(press.id);
  }, 480);
});
const cancelPress = (e) => {
  if (!press) return;
  if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) return;
  clearTimeout(press.timer);
  if (e.type !== 'pointerup') press = null;
};
['pointermove', 'pointercancel', 'pointerup'].forEach((t) => $('main').addEventListener(t, cancelPress));
$('main').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const wasLong = press?.long;
  press = null;
  if (wasLong) return;
  const id = card.dataset.id;
  if (S.sel) return toggleSel(id);
  // Tick a checklist item right on the card.
  const box = e.target.closest('.card-items .cbox');
  if (box) {
    const n = findNote(id);
    if (n && canEdit(n)) {
      const itemId = box.closest('[data-item]').dataset.item;
      const f = fieldsOf(n);
      const items = f.items.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i));
      updateNote(id, { items }).then(render);
      return;
    }
  }
  openEditor(id);
});
$('main').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  if (press?.long) return;
  if (S.sel) toggleSel(card.dataset.id);
  else startSelect(card.dataset.id);
});
$('main').addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    if (S.sel) toggleSel(card.dataset.id);
    else openEditor(card.dataset.id);
  }
});

/* ======================================================================
   Multi-select
   ====================================================================== */
function startSelect(id) {
  if (S.sel) return;
  S.sel = new Set(id ? [id] : []);
  $('selBar').hidden = false;
  pushOverlay(() => {
    S.sel = null;
    $('selBar').hidden = true;
    render();
  });
  render();
}
const endSelect = () => (S.sel ? popOverlay() : Promise.resolve());
function toggleSel(id) {
  if (!S.sel) return;
  if (S.sel.has(id)) S.sel.delete(id);
  else S.sel.add(id);
  render();
}
$('selectBtn').onclick = () => (S.sel ? endSelect() : startSelect());
$('selClose').onclick = () => endSelect();
$('selAll').onclick = () => {
  const ids = visibleNotes().map((n) => n.id);
  const all = ids.every((id) => S.sel.has(id));
  S.sel = new Set(all ? [] : ids);
  render();
};

function renderSelBar() {
  const ids = [...S.sel];
  const notes = ids.map(findNote).filter(Boolean);
  const own = notes.filter(isOwn);
  $('selCount').textContent = `${ids.length} selected`;
  const allIds = visibleNotes().map((n) => n.id);
  $('selAll').textContent = allIds.length && allIds.every((id) => S.sel.has(id)) ? 'Clear' : 'Select all';
  let acts;
  if (S.view === 'trash') {
    acts = [
      ['restore', 'i-restore', 'Restore'],
      ['forever', 'i-forever', 'Delete', 'danger'],
    ];
  } else if (S.view === 'secure') {
    acts = [
      ['pin', own.length && own.every((n) => n.pinned) ? 'i-pin' : 'i-pin-on', own.length && own.every((n) => n.pinned) ? 'Unpin' : 'Pin'],
      ['unsecure', 'i-unlock', 'Move out'],
      ['color', 'i-palette', 'Colour'],
      ['trash', 'i-trash', 'Delete', 'danger'],
    ];
  } else {
    const allPinned = own.length && own.every((n) => n.pinned);
    acts = [
      ['pin', allPinned ? 'i-pin' : 'i-pin-on', allPinned ? 'Unpin' : 'Pin'],
      ['secure', 'i-lock', 'Secure'],
      ['share', 'i-person-add', 'Share'],
      ['trash', 'i-trash', 'Delete', 'danger'],
      ['more', 'i-more', 'More'],
    ];
  }
  const box = $('selActions');
  box.style.gridTemplateColumns = `repeat(${acts.length}, 1fr)`;
  box.innerHTML = acts
    .map(([a, ic, label, cls]) => `<button class="sel-act ${cls || ''}" data-a="${a}" ${ids.length ? '' : 'disabled'}>${icon(ic)}${label}</button>`)
    .join('');
}

$('selActions').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (!a || !S.sel?.size) return;
  const ids = [...S.sel];
  const notes = ids.map(findNote).filter(Boolean);
  const own = notes.filter(isOwn);
  const foreign = notes.filter((n) => !isOwn(n));
  const skipped = (n, what) => n && toast(`${plural(n, 'shared note')} skipped — only the owner can ${what}.`);

  if (a === 'pin') {
    const pin = !(own.length && own.every((n) => n.pinned));
    await setPinned(own.map((n) => n.id), pin);
    skipped(foreign.length, 'pin it');
    return endSelect();
  }
  if (a === 'secure') {
    const movable = own.filter((n) => !n.secure);
    if (!movable.length) return skipped(foreign.length, 'move it');
    const ok = await moveToSecure(movable.map((n) => n.id));
    if (ok) {
      skipped(foreign.length, 'move it');
      endSelect();
    }
    return;
  }
  if (a === 'unsecure') {
    for (const n of own) await moveOutOfSecure(n.id, true);
    toast(`${plural(own.length, 'note')} moved out of Secure folder`);
    return endSelect();
  }
  if (a === 'share') {
    const shareable = own.filter((n) => !n.secure);
    if (!shareable.length) return toast('Only your own notes outside the Secure folder can be shared.');
    await endSelect();
    return shareSheet(shareable.map((n) => n.id));
  }
  if (a === 'trash') {
    const text = foreign.length
      ? `${own.length ? `${plural(own.length, 'note')} will move to Trash. ` : ''}${plural(foreign.length, 'note')} shared with you will be removed from your list.`
      : `${plural(own.length, 'note')} will move to Trash.`;
    if (!(await confirmSheet({ title: `Delete ${plural(ids.length, 'note')}?`, text, ok: 'Delete', danger: true, ic: 'i-trash' }))) return;
    await endSelect();
    await trashNotes(own.map((n) => n.id));
    if (foreign.length) await leaveNotes(foreign.map((n) => n.id));
    return;
  }
  if (a === 'restore') {
    await endSelect();
    return restoreNotes(ids);
  }
  if (a === 'forever') {
    if (!(await confirmSheet({ title: `Delete ${plural(ids.length, 'note')} forever?`, text: 'They will be deleted from all your devices.', ok: 'Delete forever', danger: true, ic: 'i-forever' }))) return;
    for (const id of ids) await deleteForever(id);
    await endSelect();
    return;
  }
  if (a === 'color') return colorSheet(own.map((n) => n.id), true);
  if (a === 'more') {
    const anyArchived = own.some((n) => n.archived);
    const choice = await menuSheet(`${ids.length} selected`, [
      ['color', 'i-palette', 'Background colour'],
      ['tag', 'i-tag', 'Add tag'],
      [anyArchived ? 'unarchive' : 'archive', anyArchived ? 'i-unarchive' : 'i-archive', anyArchived ? 'Unarchive' : 'Archive'],
      ['copy', 'i-copy', 'Make copies'],
    ]);
    if (choice === 'color') return colorSheet(own.map((n) => n.id), true);
    if (choice === 'tag') return bulkTagSheet(own.filter((n) => !n.secure).map((n) => n.id));
    if (choice === 'archive' || choice === 'unarchive') {
      await endSelect();
      return setArchived(own.map((n) => n.id), choice === 'archive');
    }
    if (choice === 'copy') {
      for (const n of notes) await copyNote(n.id);
      return endSelect();
    }
  }
});

/* ======================================================================
   Colour, tags, share sheets
   ====================================================================== */
function swatches(current) {
  current = current || 'default';
  return COLORS.map(
    ([k, label]) =>
      `<button type="button" class="swatch ${k === 'default' ? 'none' : ''} ${k === current ? 'sel' : ''}" data-color-key="${k}" ${k !== 'default' ? `data-color="${k}"` : ''} aria-label="${label}" title="${label}">${k === current && k !== 'default' ? icon('i-check') : ''}</button>`,
  ).join('');
}

function colorSheet(ids, fromSelection = false) {
  if (!ids.length) return toast('Only your own notes can be recoloured.');
  const first = findNote(ids[0]);
  const el = openSheet(`${sheetHero('i-palette', 'Background colour')}<div class="palette inline">${swatches(ids.length === 1 ? first.color : null)}</div>`);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-color-key]');
    if (!b) return;
    for (const id of ids) await updateNote(id, { color: b.dataset.colorKey }, { touch: false });
    await closeSheet();
    if (fromSelection) await endSelect();
    render();
  });
}

function bulkTagSheet(ids) {
  if (!ids.length) return toast('Only your own notes outside the Secure folder can be tagged here.');
  const tags = allTags();
  const el = openSheet(
    `${sheetHero('i-tag', `Add a tag to ${plural(ids.length, 'note')}`)}
     <form class="tag-new" id="tf"><input class="input" id="tagNew" placeholder="New tag" maxlength="40" enterkeyhint="done" /><button class="btn btn-gradient" type="submit">Add</button></form>
     <div class="menu">${tags.map((t) => `<button class="menu-item" data-tag="${esc(t)}"><span class="mi-icon">${icon('i-tag')}</span><span>${esc(t)}</span></button>`).join('')}</div>`,
  );
  const apply = async (t) => {
    for (const id of ids) {
      const n = findNote(id);
      if (n && !n.tags.includes(t)) await updateNote(id, { tags: [...n.tags, t] }, { touch: false });
    }
    await closeSheet();
    await endSelect();
    toast(`Tagged “${t}”`);
    render();
  };
  el.querySelector('#tf').onsubmit = (e) => {
    e.preventDefault();
    const v = el.querySelector('#tagNew').value.trim().replace(/\s+/g, ' ');
    if (v) apply(tags.find((t) => t.toLowerCase() === v.toLowerCase()) || v);
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (b) apply(b.dataset.tag);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function shareSheet(ids) {
  const notes = ids.map(findNote).filter((n) => n && isOwn(n) && !n.secure);
  if (!notes.length) return toast('Move the note out of the Secure folder to share it.');
  const single = notes.length === 1 ? notes[0] : null;
  const title = single ? fieldsOf(single).title || 'Share note' : `Share ${plural(notes.length, 'note')}`;
  const draw = () => {
    const members = single ? sharesOf(single.id) : [];
    return `${sheetHero('i-people', title, 'They’ll see it after signing in to NotesGo with that Google account.')}
      <form class="share-form" id="sf">
        <input class="input" id="shEmail" type="email" placeholder="friend@gmail.com" autocomplete="email" inputmode="email" autofocus />
        <select id="shRole" aria-label="Access"><option value="view">Can view</option><option value="edit">Can edit</option></select>
        <button class="btn btn-gradient" type="submit" aria-label="Add">${icon('i-plus')}</button>
      </form>
      <div class="err" id="shErr"></div>
      ${
        single
          ? `<ul class="member-list">${
              members.length
                ? members
                    .map(
                      (m) => `<li class="member" data-id="${m.id}"><span class="member-avatar">${esc(m.email[0].toUpperCase())}</span>
                  <span class="member-email">${esc(m.email)}</span>
                  <select class="member-role" aria-label="Access"><option value="view" ${m.role === 'view' ? 'selected' : ''}>View</option><option value="edit" ${m.role === 'edit' ? 'selected' : ''}>Edit</option></select>
                  <button class="icon-btn" data-remove aria-label="Stop sharing">${icon('i-close')}</button></li>`,
                    )
                    .join('')
                : '<li class="muted" style="padding:6px 4px">Not shared with anyone yet.</li>'
            }</ul>`
          : ''
      }
      <div class="sheet-note">${icon('i-lock')} Notes in the Secure folder can’t be shared.${navigator.onLine ? '' : ' You’re offline — sharing will sync when you’re back.'}</div>
      <div class="sheet-actions"><button class="btn btn-ghost" data-done type="button">Done</button></div>`;
  };
  const el = openSheet(draw());
  const wire = () => {
    el.querySelector('#sf').onsubmit = async (e) => {
      e.preventDefault();
      const email = el.querySelector('#shEmail').value.trim().toLowerCase();
      const role = el.querySelector('#shRole').value;
      const err = el.querySelector('#shErr');
      if (!EMAIL_RE.test(email)) return (err.textContent = 'Enter a valid email address.');
      if (email === S.email) return (err.textContent = 'That’s your own email.');
      for (const n of notes) await addShare(n.id, email, role);
      render();
      if (single) {
        el.innerHTML = draw();
        wire();
        toast(`Shared with ${email}`);
      } else {
        await closeSheet();
        toast(`${plural(notes.length, 'note')} shared with ${email}`);
      }
    };
  };
  wire();
  el.addEventListener('change', async (e) => {
    const li = e.target.closest('.member');
    if (!li || !e.target.matches('.member-role')) return;
    const s = S.shares.find((x) => x.id === li.dataset.id);
    s.role = e.target.value;
    await persistShare(s);
    toast(`${s.email} can now ${s.role}`);
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-done]')) return closeSheet();
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    const s = S.shares.find((x) => x.id === rm.closest('.member').dataset.id);
    s.deleted = true;
    await persistShare(s);
    el.innerHTML = draw();
    wire();
    render();
    toast(`Stopped sharing with ${s.email}`);
  });
}

async function addShare(noteId, email, role) {
  let s = S.shares.find((x) => x.note_id === noteId && x.email === email && x.user_id === S.user.id);
  if (s) Object.assign(s, { role, deleted: false });
  else {
    const t = nowIso();
    s = {
      id: newId(),
      user_id: S.user.id,
      note_id: noteId,
      email,
      role,
      owner_name: myName(),
      owner_email: S.email,
      created_at: t,
      updated_at: t,
      deleted: false,
      synced: 0,
    };
  }
  await persistShare(s);
}

/* ---------- Delete flows ---------- */
async function forever(id) {
  if (await confirmSheet({ title: 'Delete forever?', text: 'This note will be deleted from all your devices.', ok: 'Delete forever', danger: true, ic: 'i-forever' })) {
    await deleteForever(id);
    render();
  }
}

async function emptyTrash() {
  const ids = S.notes.filter((n) => n.trashed && isOwn(n)).map((n) => n.id);
  if (!(await confirmSheet({ title: 'Empty Trash?', text: `${plural(ids.length, 'note')} will be deleted forever.`, ok: 'Empty Trash', danger: true, ic: 'i-trash' }))) return;
  for (const id of ids) await deleteForever(id);
  render();
}

/* ======================================================================
   Create (bottom popup)
   ====================================================================== */
$('fab').onclick = async () => {
  const secureView = S.view === 'secure';
  const items = [
    ['text', 'i-text', secureView ? 'Secure note' : 'Note', { hint: 'Write freely' }],
    ['checklist', 'i-checklist', secureView ? 'Secure checklist' : 'Checklist', { hint: 'Tick off items as you go' }],
  ];
  if (!secureView) items.push(['secure', 'i-lock', 'Secure note', { hint: 'Encrypted with your password' }]);
  const a = await menuSheet('Create', items);
  if (!a) return;
  if (a === 'secure') {
    if (!(await ensureUnlocked())) return;
    return openEditor(null, { kind: 'text', secure: true });
  }
  openEditor(null, { kind: a });
};

/* ======================================================================
   Editor
   ====================================================================== */
const edTitle = $('edTitle');
const edContent = $('edContent');
const edItems = $('edItems');
let edTimer = null;

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

async function openEditor(id = null, opts = {}) {
  let n = id ? findNote(id) : null;
  if (id && !n) return;
  if (n?.secure && !fieldsOf(n)) {
    if (!(await ensureUnlocked())) return;
    await decryptAll();
    if (!fieldsOf(n)) return toast("This note was encrypted with a different password and can't be opened.");
  }
  const f = n
    ? fieldsOf(n)
    : { title: '', content: '', items: [], tags: S.view === 'tag' ? [S.tag] : [] };
  S.ed = {
    id: n ? n.id : newId(),
    draft: !n,
    kind: n ? n.kind : opts.kind || 'text',
    secure: n ? n.secure : Boolean(opts.secure) || S.view === 'secure',
    title: f.title,
    content: f.content,
    items: f.items.map((i) => ({ ...i })),
    tags: [...f.tags],
    readonly: n ? !canEdit(n) : false,
    color: 'default',
    pinned: false,
  };
  if (S.ed.draft && S.ed.kind === 'checklist') S.ed.items = [{ id: newId(), text: '', done: false }];
  edTitle.value = S.ed.title;
  edContent.value = S.ed.content;
  edTitle.readOnly = edContent.readOnly = S.ed.readonly;
  $('editor').hidden = false;
  $('palette').hidden = true;
  renderEditor();
  renderItems();
  autosize(edTitle);
  autosize(edContent);
  $('edBody').scrollTop = 0;
  pushOverlay(closeEditorNow);
  if (!n) setTimeout(() => (S.ed.kind === 'checklist' ? edItems.querySelector('textarea') : edContent).focus(), 80);
}

function renderEditor() {
  const ed = S.ed;
  if (!ed) return;
  const n = findNote(ed.id);
  const own = !n || isOwn(n);
  const color = own ? n?.color || ed.color : 'default';
  const box = $('editor');
  if (color && color !== 'default') box.dataset.color = color;
  else delete box.dataset.color;
  const pinned = n ? n.pinned : ed.pinned;
  const ro = ed.readonly;
  const ownerTools = own && !n?.trashed;
  $('edPin').hidden = !ownerTools;
  $('edPin').innerHTML = icon(pinned ? 'i-pin-on' : 'i-pin');
  $('edPin').classList.toggle('on', Boolean(pinned));
  $('edPin').setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
  $('edShare').hidden = !ownerTools || ed.secure;
  $('edSecure').hidden = !ownerTools;
  $('edSecure').innerHTML = icon(ed.secure ? 'i-unlock' : 'i-lock');
  $('edSecure').setAttribute('aria-label', ed.secure ? 'Move out of Secure folder' : 'Move to Secure folder');
  $('edColor').hidden = !ownerTools;
  $('edTag').hidden = !ownerTools;
  $('edKind').hidden = ro;
  $('edKind').innerHTML = icon(ed.kind === 'checklist' ? 'i-text' : 'i-checklist');
  $('edKind').setAttribute('aria-label', ed.kind === 'checklist' ? 'Switch to plain note' : 'Switch to checklist');
  edContent.hidden = ed.kind === 'checklist';
  edItems.hidden = ed.kind !== 'checklist';

  const badges = [];
  if (ed.secure) badges.push(`<span class="pill">${icon('i-lock')}Secure · encrypted</span>`);
  if (n && own) {
    const c = sharesOf(n.id).length;
    if (c) badges.push(`<button class="pill share" data-open-share>${icon('i-people')}Shared with ${plural(c, 'person', 'people')}</button>`);
  }
  if (n && !own) {
    const s = myShareFor(n.id);
    badges.push(`<span class="pill share">${icon('i-people')}From ${esc(s?.owner_name || s?.owner_email || 'a friend')} · ${s?.role === 'edit' ? 'can edit' : 'view only'}</span>`);
  }
  if (n?.trashed) badges.push(`<span class="pill">${icon('i-trash')}In Trash</span>`);
  $('edBadges').innerHTML = badges.join('');
  $('edTags').innerHTML = ed.tags.map((t) => `<button type="button" class="pill" data-tag="${esc(t)}">${icon('i-tag')}${esc(t)}</button>`).join('');
  const who = n && n.edited_by && n.edited_by !== myName() ? ` by ${n.edited_by}` : '';
  $('edTime').textContent = n ? `Edited ${fmtTime(n.edited_at)}${who}` : '';
}

/* ---------- Checklist editing ---------- */
function renderItems(focusId = null, caretEnd = true) {
  const ed = S.ed;
  if (!ed || ed.kind !== 'checklist') return;
  const row = (i) => `<div class="ci ${i.done ? 'done' : ''}" data-id="${esc(i.id)}">
      <button type="button" class="cbox ${i.done ? 'on' : ''}" aria-label="${i.done ? 'Untick' : 'Tick'}" ${ed.readonly ? 'disabled' : ''}>${icon('i-check')}</button>
      <textarea rows="1" maxlength="1000" placeholder="List item" ${ed.readonly ? 'readonly' : ''}>${esc(i.text)}</textarea>
      ${ed.readonly ? '' : `<button type="button" class="icon-btn ci-del" aria-label="Remove item">${icon('i-close')}</button>`}</div>`;
  const open = ed.items.filter((i) => !i.done);
  const done = ed.items.filter((i) => i.done);
  edItems.innerHTML = `${open.map(row).join('')}
    ${ed.readonly ? '' : `<button type="button" class="ci-add">${icon('i-plus')}List item</button>`}
    ${done.length ? `<div class="ci-done-label">${done.length} completed</div>${done.map(row).join('')}` : ''}`;
  edItems.querySelectorAll('textarea').forEach(autosize);
  if (focusId) {
    const t = edItems.querySelector(`[data-id="${CSS.escape(focusId)}"] textarea`);
    if (t) {
      t.focus();
      const pos = caretEnd ? t.value.length : 0;
      t.setSelectionRange(pos, pos);
    }
  }
}

const itemOf = (el) => S.ed.items.find((i) => i.id === el.closest('.ci')?.dataset.id);

edItems.addEventListener('input', (e) => {
  if (!e.target.matches('textarea') || !S.ed) return;
  const it = itemOf(e.target);
  if (!it) return;
  if (e.target.value.includes('\n')) {
    // Pasted several lines: one item per line.
    const lines = e.target.value.split('\n');
    it.text = lines[0];
    const at = S.ed.items.indexOf(it);
    const extra = lines.slice(1).map((text) => ({ id: newId(), text, done: false }));
    S.ed.items.splice(at + 1, 0, ...extra);
    renderItems(extra[extra.length - 1].id);
  } else {
    it.text = e.target.value;
    autosize(e.target);
  }
  scheduleSave();
});
edItems.addEventListener('keydown', (e) => {
  if (!e.target.matches('textarea') || !S.ed || S.ed.readonly) return;
  const it = itemOf(e.target);
  if (!it) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const pos = e.target.selectionStart;
    const next = { id: newId(), text: it.text.slice(pos), done: false };
    it.text = it.text.slice(0, pos);
    S.ed.items.splice(S.ed.items.indexOf(it) + 1, 0, next);
    renderItems(next.id, false);
    scheduleSave();
  } else if (e.key === 'Backspace' && e.target.selectionStart === 0 && e.target.selectionEnd === 0) {
    const list = S.ed.items.filter((i) => i.done === it.done);
    const idx = list.indexOf(it);
    if (idx <= 0) return;
    e.preventDefault();
    const prev = list[idx - 1];
    const caret = prev.text.length;
    prev.text += it.text;
    S.ed.items = S.ed.items.filter((i) => i !== it);
    renderItems(prev.id);
    const t = edItems.querySelector(`[data-id="${CSS.escape(prev.id)}"] textarea`);
    t?.setSelectionRange(caret, caret);
    scheduleSave();
  }
});
edItems.addEventListener('click', (e) => {
  if (!S.ed || S.ed.readonly) return;
  if (e.target.closest('.ci-add')) {
    const it = { id: newId(), text: '', done: false };
    const firstDone = S.ed.items.findIndex((i) => i.done);
    S.ed.items.splice(firstDone < 0 ? S.ed.items.length : firstDone, 0, it);
    renderItems(it.id);
    return;
  }
  const box = e.target.closest('.cbox');
  if (box) {
    const it = itemOf(box);
    it.done = !it.done;
    renderItems();
    scheduleSave();
    return;
  }
  const del = e.target.closest('.ci-del');
  if (del) {
    const it = itemOf(del);
    S.ed.items = S.ed.items.filter((i) => i !== it);
    renderItems();
    scheduleSave();
  }
});

$('edKind').onclick = () => {
  const ed = S.ed;
  if (!ed || ed.readonly) return;
  if (ed.kind === 'text') {
    const lines = ed.content.split('\n').map((l) => l.replace(/^\s*([-*•]|\[[ xX]?\]|☐|☑)\s*/, ''));
    ed.items = lines.filter((l) => l.trim()).map((text) => ({ id: newId(), text, done: false }));
    if (!ed.items.length) ed.items = [{ id: newId(), text: '', done: false }];
    ed.kind = 'checklist';
  } else {
    ed.content = ed.items
      .filter((i) => i.text.trim())
      .map((i) => (i.done ? `✓ ${i.text}` : i.text))
      .join('\n');
    edContent.value = ed.content;
    ed.kind = 'text';
  }
  renderEditor();
  renderItems();
  autosize(edContent);
  scheduleSave();
};

/* ---------- Saving ---------- */
const hasContent = (ed) => ed.title.trim() || (ed.kind === 'checklist' ? ed.items.some((i) => i.text.trim()) : ed.content.trim());

/** Write the editor's state to the note (creating it on first content). */
async function flushEditor() {
  clearTimeout(edTimer);
  const ed = S.ed;
  if (!ed || ed.readonly) return;
  const n = findNote(ed.id);
  const data = {
    kind: ed.kind,
    title: ed.title,
    content: ed.kind === 'text' ? ed.content : '',
    items: ed.kind === 'checklist' ? ed.items.map((i) => ({ ...i })) : [],
    tags: [...ed.tags], // copies: the editor keeps mutating its own arrays
  };
  if (ed.draft) {
    if (!hasContent(ed) && !ed.tags.length) return;
    ed.draft = false;
    await createNote({ id: ed.id, ...data, color: ed.color, pinned: ed.pinned, secure: ed.secure });
    renderEditor();
    return;
  }
  if (!n) return;
  const f = fieldsOf(n);
  if (f && n.kind === data.kind && f.title === data.title && f.content === data.content && JSON.stringify(f.items) === JSON.stringify(data.items) && f.tags.join('\n') === data.tags.join('\n')) return;
  if (!isOwn(n)) delete data.tags;
  await updateNote(ed.id, data);
  $('edTime').textContent = `Edited ${fmtTime(nowIso())}`;
}

function scheduleSave() {
  clearTimeout(edTimer);
  edTimer = setTimeout(flushEditor, 350);
}

function closeEditorNow() {
  const ed = S.ed;
  $('editor').hidden = true;
  $('palette').hidden = true;
  if (!ed) return;
  (async () => {
    await flushEditor();
    await allSaved();
    if (S.ed === ed) S.ed = null;
    const n = findNote(ed.id);
    const f = n && fieldsOf(n);
    if (n && f && isOwn(n) && !n.trashed && !f.title.trim() && !f.content.trim() && !f.items.some((i) => i.text.trim()) && !f.tags.length) {
      await deleteForever(n.id);
      toast('Empty note discarded');
    }
    // A note moved into the Secure folder from outside it locks again when you leave it.
    if (Vault.unlocked && S.view !== 'secure' && !S.ed) await lockVault({ silent: true });
    render();
  })();
}

edTitle.addEventListener('input', () => {
  if (!S.ed) return;
  S.ed.title = edTitle.value.replace(/\n/g, ' ');
  if (edTitle.value !== S.ed.title) edTitle.value = S.ed.title;
  autosize(edTitle);
  scheduleSave();
});
edTitle.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (S.ed?.kind === 'checklist') {
    const first = edItems.querySelector('textarea');
    if (first) first.focus();
    else edItems.querySelector('.ci-add')?.click();
  } else edContent.focus();
});
edContent.addEventListener('input', () => {
  if (!S.ed) return;
  S.ed.content = edContent.value;
  autosize(edContent);
  scheduleSave();
});
$('edBody').addEventListener('click', (e) => {
  if (e.target.id === 'edBody' && !S.ed?.readonly && S.ed?.kind === 'text') edContent.focus();
  if (e.target.closest('#edTags [data-tag]') && !S.ed?.readonly) tagSheet();
  if (e.target.closest('[data-open-share]')) shareSheet([S.ed.id]);
});
$('edBack').onclick = () => popOverlay();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushEditor();
});
window.addEventListener('pagehide', () => flushEditor());

$('edPin').onclick = async () => {
  const ed = S.ed;
  const n = findNote(ed.id);
  if (!n) ed.pinned = !ed.pinned;
  else await updateNote(ed.id, { pinned: !n.pinned, archived: false }, { touch: false });
  renderEditor();
};
$('edShare').onclick = async () => {
  await flushEditor();
  if (!findNote(S.ed.id)) return toast('Write something first, then share it.');
  shareSheet([S.ed.id]);
};
$('edSecure').onclick = async () => {
  await flushEditor();
  const ed = S.ed;
  if (!ed) return;
  if (ed.secure) {
    if (ed.draft) {
      ed.secure = false;
      return renderEditor();
    }
    await moveOutOfSecure(ed.id);
  } else {
    if (ed.draft) {
      if (!(await ensureUnlocked())) return;
      ed.secure = true;
      renderEditor();
      return toast('This note will be saved in the Secure folder');
    }
    await moveToSecure([ed.id]);
  }
};
$('edColor').onclick = (e) => {
  e.stopPropagation();
  const p = $('palette');
  const n = findNote(S.ed.id);
  p.innerHTML = swatches(n?.color || S.ed.color);
  p.hidden = !p.hidden;
};
$('palette').onclick = async (e) => {
  const b = e.target.closest('[data-color-key]');
  if (!b) return;
  const color = b.dataset.colorKey;
  const n = findNote(S.ed.id);
  if (n) await updateNote(n.id, { color }, { touch: false });
  else S.ed.color = color;
  $('palette').innerHTML = swatches(color);
  renderEditor();
};
$('editor').addEventListener('click', (e) => {
  if (!e.target.closest('#palette, #edColor')) $('palette').hidden = true;
});
$('edTag').onclick = () => tagSheet();
$('edMore').onclick = async () => {
  await flushEditor();
  const ed = S.ed;
  const n = findNote(ed.id);
  const own = !n || isOwn(n);
  let items;
  if (n?.trashed) {
    items = [
      ['restore', 'i-restore', 'Restore'],
      ['forever', 'i-forever', 'Delete forever', { danger: true }],
    ];
  } else if (!own) {
    items = [
      ['copy', 'i-copy', 'Make my own copy'],
      ['leave', 'i-logout', 'Remove from my notes', { danger: true, hint: 'The owner keeps their note' }],
    ];
  } else {
    items = [
      ...(n && !ed.secure ? [['share', 'i-person-add', 'Share', { hint: sharesOf(n.id).length ? `Shared with ${plural(sharesOf(n.id).length, 'person', 'people')}` : 'Give view or edit access' }]] : []),
      ...(n && !ed.secure ? [[n.archived ? 'unarchive' : 'archive', n.archived ? 'i-unarchive' : 'i-archive', n.archived ? 'Unarchive' : 'Archive']] : []),
      ...(n ? [['copy', 'i-copy', 'Make a copy']] : []),
      ['trash', 'i-trash', 'Delete', { danger: true }],
    ];
  }
  const a = await menuSheet(null, items);
  if (!a) return;
  const id = ed.id;
  if (a === 'share') return shareSheet([id]);
  if (a === 'copy') return copyNote(id);
  if (a === 'restore') {
    await restoreNotes([id]);
    ed.readonly = false;
    edTitle.readOnly = edContent.readOnly = false;
    renderEditor();
    renderItems();
    return;
  }
  await popOverlay(); // close the editor
  if (!findNote(id)) return; // never-saved draft: nothing more to do
  if (a === 'archive' || a === 'unarchive') setArchived([id], a === 'archive');
  if (a === 'trash') trashNotes([id]);
  if (a === 'forever') forever(id);
  if (a === 'leave' && (await confirmSheet({ title: 'Remove shared note?', text: 'It disappears from your notes. The owner keeps it.', ok: 'Remove', danger: true }))) leaveNotes([id]);
};

/* ---------- Tags (single note) ---------- */
function tagSheet() {
  const ed = S.ed;
  if (!ed || ed.readonly) return;
  const draw = () => {
    const tags = [...new Set([...allTags({ includeSecure: ed.secure }), ...ed.tags])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return `${sheetHero('i-tag', 'Tags')}
      <form class="tag-new" id="tagNewForm"><input class="input" id="tagNew" placeholder="New tag" maxlength="40" enterkeyhint="done" />
      <button class="btn btn-gradient" type="submit">Add</button></form>
      <div id="tagList">${tags
        .map((t) => `<div class="tag-pick"><label><input type="checkbox" value="${esc(t)}" ${ed.tags.includes(t) ? 'checked' : ''}/>${icon('i-tag')}<span>${esc(t)}</span></label></div>`)
        .join('')}</div>
      <div class="sheet-actions"><button class="btn btn-ghost" id="tagDone" type="button">Done</button></div>`;
  };
  const apply = () => {
    renderEditor();
    scheduleSave();
  };
  const el = openSheet(draw());
  const wire = () => {
    el.querySelector('#tagNewForm').onsubmit = (e) => {
      e.preventDefault();
      const v = el.querySelector('#tagNew').value.trim().replace(/\s+/g, ' ');
      if (!v) return;
      const existing = allTags({ includeSecure: ed.secure }).find((t) => t.toLowerCase() === v.toLowerCase()) || v;
      if (!ed.tags.includes(existing)) ed.tags.push(existing);
      apply();
      el.innerHTML = draw();
      wire();
    };
    el.querySelector('#tagList').onchange = (e) => {
      const t = e.target.value;
      if (e.target.checked) ed.tags.includes(t) || ed.tags.push(t);
      else ed.tags = ed.tags.filter((x) => x !== t);
      apply();
    };
    el.querySelector('#tagDone').onclick = () => closeSheet();
  };
  wire();
}

function editTagsSheet() {
  const draw = () => {
    const tags = allTags();
    return `${sheetHero('i-tag', 'Edit tags', 'Renaming or deleting a tag changes it on every note that has it.')}${
      tags.length
        ? tags
            .map(
              (t) => `<div class="tag-edit field" data-tag="${esc(t)}"><input class="input" value="${esc(t)}" maxlength="40" aria-label="Tag name" />
            <button class="icon-btn" data-del aria-label="Delete tag">${icon('i-trash')}</button></div>`,
            )
            .join('')
        : '<p class="muted">No tags yet.</p>'
    }<div class="sheet-actions"><button class="btn btn-ghost" data-done>Done</button></div>`;
  };
  const el = openSheet(draw());
  const retag = async (from, to) => {
    for (const n of S.notes) {
      if (!isOwn(n)) continue;
      const f = fieldsOf(n);
      if (!f || !f.tags.includes(from)) continue;
      let tags = f.tags.filter((t) => t !== from);
      if (to && !tags.includes(to)) tags = [...tags, to];
      await updateNote(n.id, { tags }, { touch: false });
    }
    if (S.view === 'tag' && S.tag === from) S.tag = to || null;
    if (S.view === 'tag' && !S.tag) S.view = 'notes';
    render();
  };
  el.addEventListener('change', async (e) => {
    const row = e.target.closest('.tag-edit');
    if (!row) return;
    const to = e.target.value.trim().replace(/\s+/g, ' ');
    if (!to || to === row.dataset.tag) return (e.target.value = row.dataset.tag);
    await retag(row.dataset.tag, to);
    el.innerHTML = draw();
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-done]')) return closeSheet();
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const t = del.closest('.tag-edit').dataset.tag;
    await retag(t, null);
    el.innerHTML = draw();
    toast(`Tag “${t}” deleted`);
  });
}

/* ======================================================================
   Secure folder
   ====================================================================== */
async function vaultRecord() {
  if (S.vault) return S.vault;
  if (navigator.onLine) {
    try {
      const remote = await Cloud.fetchVault();
      if (remote) {
        S.vault = { ...remote, synced: 1 };
        await DB.put('vault', S.vault);
      }
    } catch (e) {
      console.warn(e);
    }
  }
  return S.vault;
}

/** Make sure the Secure folder is unlocked; asks for (or sets up) the password. Resolves true/false. */
async function ensureUnlocked() {
  if (Vault.unlocked) return true;
  const rec = await vaultRecord();
  return rec ? unlockSheet(rec) : setupSheet();
}

const pwField = (id, label, auto = false, ac = 'current-password') =>
  `<label class="field"><span>${label}</span><input class="input" id="${id}" type="password" autocomplete="${ac}" ${auto ? 'autofocus' : ''} /></label>`;

function setupSheet() {
  return new Promise((resolve) => {
    if (!navigator.onLine) {
      toast('Connect to the internet once to set up the Secure folder.');
      return resolve(false);
    }
    let ok = false;
    let handedOff = false;
    const el = openSheet(
      `${sheetHero('i-key', 'Create Secure folder password', 'Notes in the Secure folder are encrypted on your device with this password.')}
       <div class="sheet-note warn">If you forget this password, secure notes can’t be recovered — not even by us.</div>
       <form id="vf">${pwField('p1', 'Password (at least 6 characters)', true, 'new-password')}
       ${pwField('p2', 'Confirm password', false, 'new-password')}
       <div class="err" id="verr"></div>
       <div class="sheet-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-gradient" type="submit">Create</button></div></form>`,
      () => handedOff || resolve(ok),
    );
    el.querySelector('[data-cancel]').onclick = () => closeSheet();
    el.querySelector('#vf').onsubmit = async (e) => {
      e.preventDefault();
      const p1 = el.querySelector('#p1').value;
      const p2 = el.querySelector('#p2').value;
      const err = el.querySelector('#verr');
      if (p1.length < 6) return (err.textContent = 'Use at least 6 characters.');
      if (p1 !== p2) return (err.textContent = "Passwords don't match.");
      const btn = el.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const made = await Vault.create(p1);
        const res = await Cloud.createVault(made.record);
        if (res.existing) {
          // Another device set it up first: use that password instead.
          S.vault = { ...res.existing, synced: 1 };
          await DB.put('vault', S.vault);
          toast('A Secure folder password already exists for your account. Enter it to unlock.');
          handedOff = true;
          return resolve(await unlockSheet(S.vault));
        }
        S.vault = { ...res.row, synced: 1 };
        await DB.put('vault', S.vault);
        Vault.activate(made.key, made.keyId);
        ok = true;
        toast('Secure folder ready');
        closeSheet();
      } catch (ex) {
        err.textContent = ex.message || String(ex);
        btn.disabled = false;
        btn.textContent = 'Create';
      }
    };
  });
}

function unlockSheet(rec) {
  return new Promise((resolve) => {
    let ok = false;
    const el = openSheet(
      `${sheetHero('i-lock', 'Unlock Secure folder')}
       <form id="vf">${pwField('p1', 'Password', true)}
       <div class="err" id="verr"></div>
       <div class="sheet-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button>
       <button class="btn btn-gradient" type="submit">Unlock</button></div>
       <div style="text-align:center;margin-top:10px"><button class="link-btn" type="button" data-forgot>Forgot password?</button></div></form>`,
      () => resolve(ok),
    );
    el.querySelector('[data-cancel]').onclick = () => closeSheet();
    el.querySelector('[data-forgot]').onclick = () => resetVaultSheet();
    el.querySelector('#vf').onsubmit = async (e) => {
      e.preventDefault();
      const err = el.querySelector('#verr');
      const wait = Math.ceil((S.lockUntil - Date.now()) / 1000);
      if (wait > 0) return (err.textContent = `Too many tries. Wait ${wait}s.`);
      const btn = el.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Unlocking…';
      const good = await Vault.unlock(rec, el.querySelector('#p1').value);
      btn.disabled = false;
      btn.textContent = 'Unlock';
      if (!good) {
        S.failedUnlocks += 1;
        if (S.failedUnlocks >= 5) S.lockUntil = Date.now() + 30000 * 2 ** (S.failedUnlocks - 5);
        el.querySelector('#p1').select();
        return (err.textContent = 'Wrong password.');
      }
      S.failedUnlocks = 0;
      ok = true;
      await decryptAll();
      closeSheet();
    };
  });
}

function resetVaultSheet() {
  const count = S.notes.filter((n) => n.secure && isOwn(n)).length;
  const el = openSheet(
    `${sheetHero('i-alert', 'Reset Secure folder?', '', true)}
     <div class="sheet-note warn">Without the password the notes inside can’t be decrypted. Resetting deletes all ${plural(count, 'secure note')} forever on every device. Then you can set a new password.</div>
     <label class="field"><span>Type RESET to confirm</span><input class="input" id="rc" autocomplete="off" autocapitalize="characters" /></label>
     <div class="sheet-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-danger" data-go disabled>Reset</button></div>`,
  );
  const go = el.querySelector('[data-go]');
  el.querySelector('#rc').oninput = (e) => (go.disabled = e.target.value.trim() !== 'RESET');
  el.querySelector('[data-cancel]').onclick = () => closeSheet();
  go.onclick = async () => {
    if (!navigator.onLine) return toast('You need to be online to reset the Secure folder.');
    go.disabled = true;
    try {
      await Cloud.deleteVault();
      for (const n of S.notes.filter((x) => x.secure && isOwn(x))) await deleteForever(n.id);
      await DB.delete('vault', S.user.id);
      S.vault = null;
      Vault.lock();
      await closeSheet();
      toast('Secure folder reset');
      render();
    } catch (ex) {
      toast(ex.message || String(ex));
      go.disabled = false;
    }
  };
}

function changePasswordSheet() {
  const rec = S.vault;
  if (!rec) return toast('Set up the Secure folder first.');
  if (!navigator.onLine) return toast('You need to be online to change the password.');
  const el = openSheet(
    `${sheetHero('i-key', 'Change Secure folder password')}
     <form id="vf">${pwField('p0', 'Current password', true)}
     ${pwField('p1', 'New password (at least 6 characters)', false, 'new-password')}
     ${pwField('p2', 'Confirm new password', false, 'new-password')}
     <div class="err" id="verr"></div>
     <div class="sheet-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-gradient" type="submit">Change</button></div></form>`,
  );
  el.querySelector('[data-cancel]').onclick = () => closeSheet();
  el.querySelector('#vf').onsubmit = async (e) => {
    e.preventDefault();
    const err = el.querySelector('#verr');
    const [p0, p1, p2] = ['p0', 'p1', 'p2'].map((id) => el.querySelector(`#${id}`).value);
    if (p1.length < 6) return (err.textContent = 'Use at least 6 characters.');
    if (p1 !== p2) return (err.textContent = "New passwords don't match.");
    const btn = el.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Changing…';
    try {
      if (!(await Vault.unlock(rec, p0))) throw new Error('Current password is wrong.');
      await allSaved();
      await decryptAll();
      const made = await Vault.create(p1);
      // Re-encrypt every readable secure note with the new key (in memory first).
      const updates = [];
      for (const n of S.notes.filter((x) => x.secure && isOwn(x))) {
        const p = S.plain.get(n.id);
        if (p) updates.push([n, await Vault.encryptNote(p, made.key, made.keyId)]);
      }
      const row = await Cloud.replaceVault(made.record);
      S.vault = { ...row, synced: 1 };
      await DB.put('vault', S.vault);
      Vault.activate(made.key, made.keyId);
      for (const [n, cipher] of updates) {
        n.cipher = cipher;
        S.plainCipher.set(n.id, cipher);
        await persist(n);
      }
      await closeSheet();
      toast('Password changed');
      if (S.view !== 'secure') await lockVault({ silent: true });
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      btn.disabled = false;
      btn.textContent = 'Change';
    }
  };
}

async function lockVault({ silent = false } = {}) {
  if (S.ed?.secure) {
    await flushEditor();
    await allSaved();
    if (!$('editor').hidden) await popOverlay();
  }
  await allSaved();
  Vault.lock();
  S.plain.clear();
  S.plainCipher.clear();
  if (!silent) toast('Secure folder locked');
  render();
}

/** Move notes into the Secure folder. Resolves true if it happened. */
async function moveToSecure(ids) {
  ids = ids.filter((id) => {
    const n = findNote(id);
    return n && isOwn(n) && !n.secure;
  });
  if (!ids.length) return false;
  const shared = ids.filter((id) => sharesOf(id).length);
  if (
    shared.length &&
    !(await confirmSheet({
      title: 'Stop sharing?',
      text: `${plural(shared.length, 'note is', 'notes are')} shared with other people. Secure notes are encrypted, so sharing will stop.`,
      ok: 'Move to Secure folder',
      ic: 'i-lock',
    }))
  )
    return false;
  if (!(await ensureUnlocked())) return false;
  for (const id of ids) {
    await stopSharing(id);
    await queue(id, async () => {
      const n = findNote(id);
      if (!n || n.secure) return;
      const p = { title: n.title, content: n.content, items: n.items, tags: [...n.tags] };
      n.cipher = await Vault.encryptNote(p);
      S.plain.set(id, p);
      S.plainCipher.set(id, n.cipher);
      Object.assign(n, { secure: true, title: '', content: '', items: [], tags: [], archived: false });
      await persist(n);
    });
  }
  if (S.ed && ids.includes(S.ed.id)) {
    S.ed.secure = true;
    renderEditor();
  }
  toast(ids.length === 1 ? 'Moved to Secure folder' : `${ids.length} notes moved to Secure folder`);
  if (!S.ed && S.view !== 'secure') await lockVault({ silent: true });
  render();
  return true;
}

function moveOutOfSecure(id, quiet = false) {
  return queue(id, async () => {
    const n = findNote(id);
    const p = n && S.plain.get(id);
    if (!p) return;
    Object.assign(n, { secure: false, cipher: '', title: p.title, content: p.content, items: p.items || [], tags: [...p.tags] });
    S.plain.delete(id);
    S.plainCipher.delete(id);
    await persist(n);
  }).then(() => {
    if (S.ed?.id === id) {
      S.ed.secure = false;
      renderEditor();
    }
    if (!quiet) toast('Moved out of Secure folder');
    render();
  });
}

// Lock automatically after the app has been in the background for a while.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') S.hiddenAt = Date.now();
  else if (Vault.unlocked && S.hiddenAt && Date.now() - S.hiddenAt > (CFG.AUTO_LOCK_SECONDS || 60) * 1000) lockVault();
});

async function onVaultChanged() {
  const rec = (await DB.get('vault', S.user.id)) || null;
  S.vault = rec;
  if (!Vault.unlocked) return render();
  const kid = rec ? await Vault.idFor(rec.salt) : null;
  if (kid !== Vault.keyId) {
    await lockVault({ silent: true });
    toast(rec ? 'Secure folder password changed on another device. Unlock again.' : 'Secure folder was reset on another device.');
  }
}

/* ======================================================================
   Account
   ====================================================================== */
function renderAvatar(el, u) {
  const pic = u.user_metadata?.avatar_url || u.user_metadata?.picture;
  const letter = (myName().trim()[0] || '?').toUpperCase();
  el.textContent = '';
  if (pic) {
    const img = document.createElement('img');
    img.src = pic;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      img.remove();
      el.textContent = letter;
    };
    el.appendChild(img);
  } else el.textContent = letter;
}

async function accountSheet() {
  const u = S.user;
  const st = Cloud.state;
  const el = openSheet(
    `<div class="profile"><span class="user-avatar" id="accAvatar"></span><strong>${esc(myName())}</strong><span class="muted">${esc(u.email || '')}</span></div>
     <div class="sheet-note">${esc($('syncStatus').dataset.label || '')}${st.lastSyncedAt ? ` · last synced ${esc(fmtTime(st.lastSyncedAt.toISOString()))}` : ''}</div>
     <div class="menu">
     <button class="menu-item" data-a="sync"><span class="mi-icon">${icon('i-sync')}</span>Sync now</button>
     ${Vault.unlocked ? `<button class="menu-item" data-a="lock"><span class="mi-icon">${icon('i-lock')}</span>Lock Secure folder</button>` : ''}
     ${S.vault ? `<button class="menu-item" data-a="pw"><span class="mi-icon">${icon('i-key')}</span>Change Secure folder password</button>` : ''}
     <button class="menu-item danger" data-a="out"><span class="mi-icon">${icon('i-logout')}</span>Sign out</button></div>`,
  );
  renderAvatar(el.querySelector('#accAvatar'), u);
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'pw') return changePasswordSheet();
    await closeSheet();
    if (a === 'sync') {
      if (!navigator.onLine) return toast("You're offline. Notes will sync when you're back online.");
      await Cloud.syncNow();
      toast(Cloud.state.error ? `Sync problem: ${Cloud.state.error}` : 'Synced');
    }
    if (a === 'lock') lockVault();
    if (a === 'out') signOut();
  });
}
$('avatarBtn').onclick = accountSheet;
$('syncStatus').onclick = () => {
  toast($('syncStatus').dataset.label || '');
  if (navigator.onLine) Cloud.syncNow();
};

async function signOut() {
  await allSaved();
  if (navigator.onLine) await Cloud.syncNow();
  const pending = (await DB.all('notes')).filter((r) => r.synced === 0).length + (await DB.all('shares')).filter((r) => r.synced === 0).length;
  const text = pending
    ? `${plural(pending, 'change')} haven't synced yet and will be lost. Connect to the internet first to keep them.`
    : 'Your notes stay safe in your account. They will be removed from this device.';
  if (!(await confirmSheet({ title: 'Sign out?', text, ok: 'Sign out', danger: Boolean(pending), ic: 'i-logout' }))) return;
  Vault.lock();
  await Cloud.signOut();
  await DB.clearAll();
  location.reload();
}

/* ======================================================================
   Boot
   ====================================================================== */
function showLogin(msg = '') {
  $('app').hidden = true;
  $('login').hidden = false;
  const btn = $('googleBtn');
  const m = $('loginMsg');
  m.textContent = msg;
  btn.disabled = false;
  if (!Cloud.configured) {
    btn.disabled = true;
    m.textContent = 'Supabase is not configured (config.js).';
  } else if (!Cloud.isHosted) {
    btn.disabled = true;
    m.textContent = 'Open the app over http(s): run "node server.js" and visit http://localhost:3000';
  } else if (!navigator.onLine) {
    m.textContent = "You're offline. Connect to the internet to sign in the first time.";
  }
}
$('googleBtn').onclick = async () => {
  if (!navigator.onLine) return ($('loginMsg').textContent = "You're offline. Connect to the internet to sign in.");
  $('googleBtn').disabled = true;
  $('loginMsg').textContent = 'Opening Google…';
  try {
    await Cloud.signInWithGoogle();
  } catch (e) {
    $('googleBtn').disabled = false;
    $('loginMsg').textContent = e.message || String(e);
  }
};
window.addEventListener('online', () => !$('login').hidden && showLogin());
window.addEventListener('offline', () => !$('login').hidden && showLogin());

async function startApp(user) {
  if (S.user?.id === user.id) return;
  // Another account used this device before: start clean.
  const owner = await DB.getMeta('owner');
  if (owner && owner !== user.id) await DB.clearAll();
  await DB.setMeta('owner', user.id);
  S.user = user;
  S.email = (user.email || '').toLowerCase();
  $('login').hidden = true;
  $('app').hidden = false;
  renderAvatar($('avatar'), user);
  renderAvatar($('drawerAvatar'), user);
  $('drawerName').textContent = myName();
  $('drawerEmail').textContent = user.email || '';
  lastCols = columnCount();
  await reload();
  await purgeOldTrash();
  Cloud.startRealtime();
  Cloud.syncNow();
}

let reloadTimer = null;
function onCloud(kind) {
  if (kind === 'auth') {
    if (Cloud.user) startApp(Cloud.user);
    else if (S.user) location.reload();
    else showLogin();
  } else if (kind === 'sync') {
    renderSync();
  } else if (kind === 'vault') {
    onVaultChanged();
  } else if (kind === 'data' && S.user) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      await reload();
      purgeOldTrash();
    }, 50);
  }
}

async function boot() {
  applyTheme(store.get('notesgo-theme', ''));
  if ('serviceWorker' in navigator && Cloud.isHosted) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  let user = null;
  try {
    user = await Cloud.init(onCloud);
  } catch (e) {
    console.error(e);
  }
  if (user) startApp(user);
  else showLogin();
}

boot();
