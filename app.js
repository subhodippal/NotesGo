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
  ['gray', 'Gray'],
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
  const limit = Date.now() - (CFG.TRASH_DAYS || 30) * 86400000;
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
    items: deepCopy(f.items).map((i) => ({ ...i, id: newId() })),
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

function cardTable(t) {
  const rows = t.rows.filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return '';
  // Leave out columns that are empty everywhere.
  const cols = [...Array(Math.max(...rows.map((r) => r.length))).keys()].filter((c) => rows.some((r) => (r[c] || '').trim())).slice(0, 4);
  const shown = rows.slice(0, 5).map((r) => cols.map((c) => r[c] || ''));
  const cell = (c, tag) => `<${tag}>${esc(c.length > 40 ? `${c.slice(0, 40)}…` : c)}</${tag}>`;
  const color = t.color && t.color !== 'default' ? ` data-color="${esc(t.color)}"` : '';
  return `<li class="tbl-li"><div class="card-table"${color}><table>${shown
    .map((r, ri) => `<tr>${r.map((c) => cell(c, ri === 0 && rows[0] === t.rows[0] ? 'th' : 'td')).join('')}</tr>`)
    .join('')}</table></div>${rows.length > shown.length ? `<span class="more-rows">+ ${rows.length - shown.length} more rows</span>` : ''}</li>`;
}

function visibleNotes() {
  const q = S.query.trim().toLowerCase();
  return S.notes
    .filter(inView)
    .filter((n) => {
      if (S.filter === 'pinned' && !n.pinned) return false;
      if (S.filter === 'text' || S.filter === 'checklist') {
        const fx = fieldsOf(n);
        const checks = fx ? fx.items.some(isCheck) : n.kind === 'checklist';
        if (checks !== (S.filter === 'checklist')) return false;
      }
      if (!q) return true;
      const f = fieldsOf(n);
      return f && `${f.title}\n${f.content}\n${f.items.map(blockText).join('\n')}\n${f.tags.join(' ')}`.toLowerCase().includes(q);
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
    // Text and unticked checkboxes in order; ticked ones are summed up at the end.
    const folded = hiddenIds(f.items);
    const visible = f.items.filter((i) => !folded.has(i.id) && (!isCheck(i) || !i.done));
    const done = f.items.filter((i) => isCheck(i) && i.done).length;
    const shown = visible.slice(0, 7);
    body = `<ul class="card-items">${shown
      .map((i) =>
        isTable(i)
          ? cardTable(i)
          : isDivider(i)
          ? '<li class="hr-li"><hr /></li>'
          : isSection(i)
          ? `<li class="sec-li ${i.collapsed ? 'collapsed' : ''}">${icon('i-chevron')}<span>${esc(i.title) || 'Section'}</span></li>`
          : isTextBlock(i)
          ? `<li class="txt"><div class="rich">${blockHtml(i, 'card')}</div></li>`
          : `<li data-item="${esc(i.id)}"><button class="cbox" type="button" aria-label="Tick">${icon('i-check')}</button><span>${esc(i.text) || '&nbsp;'}</span></li>`,
      )
      .join('')}${visible.length > shown.length ? `<li class="more">+ ${visible.length - shown.length} more</li>` : ''}${
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
  const checks = n.kind === 'checklist' ? f.items.filter(isCheck) : [];
  if (checks.length) pills.push(`<span class="pill">${icon('i-checklist')}${checks.filter((i) => i.done).length}/${checks.length}</span>`);
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

/** "1 month" for 30 days, otherwise "N days". */
const trashPeriod = () => ((CFG.TRASH_DAYS || 30) === 30 ? '1 month' : plural(CFG.TRASH_DAYS || 30, 'day'));

const VIEW_INFO = {
  notes: { title: 'My Notes', icon: 'i-note', empty: ['No notes yet', 'Tap “New” to write a note or start a checklist.'] },
  shared: { title: 'Shared', icon: 'i-people', empty: ['Nothing shared yet', 'Notes you share, and notes friends share with you, show up here.'] },
  secure: { title: 'Secure folder', icon: 'i-lock', empty: ['Secure folder is empty', 'Move notes here to encrypt them with your password.'] },
  archive: { title: 'Archive', icon: 'i-archive', empty: ['No archived notes', 'Archive old notes you want to keep aside.'] },
  trash: { title: 'Trash', icon: 'i-trash', empty: ['Trash is empty', 'Deleted notes stay here for 1 month.'] },
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
    banner.innerHTML = `${icon('i-trash')}<span style="flex:1">Deleted notes stay here for ${trashPeriod()}, then they’re gone for good.</span><button class="btn btn-sm btn-ghost" id="emptyTrash">Empty</button>`;
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
    ['text', 'i-text', secureView ? 'Secure note' : 'Note', { hint: 'Text, with checkboxes anywhere you like' }],
    ['checklist', 'i-checklist', secureView ? 'Secure checklist' : 'Checklist', { hint: 'Tick off items as you go' }],
    ['table', 'i-table', secureView ? 'Secure table' : 'Table', { hint: 'Rows and columns, like a spreadsheet' }],
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
const edItems = $('edItems');
let edTimer = null;
let edCaret = null; // last place the cursor was in the body: { id, pos }

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
    secure: n ? n.secure : Boolean(opts.secure) || S.view === 'secure',
    title: f.title,
    blocks: n ? blocksOf(n.kind, f.content, f.items) : opts.kind === 'checklist' ? [checkItem()] : opts.kind === 'table' ? [tableBlock(), textBlock()] : [textBlock()],
    tags: [...f.tags],
    readonly: n ? !canEdit(n) : false,
    color: 'default',
    pinned: false,
  };
  edCaret = null;
  edTitle.value = S.ed.title;
  edTitle.readOnly = S.ed.readonly;
  $('editor').hidden = false;
  $('palette').hidden = true;
  renderEditor();
  renderItems();
  autosize(edTitle);
  $('edBody').scrollTop = 0;
  pushOverlay(closeEditorNow);
  if (!n) setTimeout(() => renderItems(S.ed?.blocks[0]?.id, isTable(S.ed.blocks[0]) ? { r: 0, c: 0 } : true), 80);
  savedRange = null;
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
  updateKindBtn();

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

/* ---------- Note body: text, checkboxes, tables and sections, in any order ----------
   Blocks:
     text     { id, type: 'text', text, html? }   html = formatted version (bold, italic, size, colour)
     checkbox { id, text, done }
     table    { id, type: 'table', rows: [[cell]], color? }
     section  { id, type: 'section', title, collapsed }   everything below it, up to the next
                                                          section, belongs to it and folds away
   Stored as kind 'text' (plain content) when the note is plain text only, otherwise
   kind 'checklist' with the blocks in `items`. */
const isTextBlock = (b) => b.type === 'text';
const isTable = (b) => b.type === 'table';
const isSection = (b) => b.type === 'section';
const isCheck = (b) => !b.type;
const textBlock = (text = '') => ({ id: newId(), type: 'text', text });
const checkItem = (text = '', done = false) => ({ id: newId(), text, done });
const tableBlock = (rows = 3, cols = 3) => ({ id: newId(), type: 'table', rows: Array.from({ length: rows }, () => Array(cols).fill('')) });
const sectionBlock = (title = '') => ({ id: newId(), type: 'section', title, collapsed: false });
const isDivider = (b) => b.type === 'divider';
const dividerBlock = () => ({ id: newId(), type: 'divider' });
/** All the words in a block (for search and "is this note empty?"). */
const blockText = (b) => (isTable(b) ? b.rows.map((r) => r.join(' ')).join('\n') : isSection(b) ? b.title || '' : b.text || '');
const deepCopy = (v) => JSON.parse(JSON.stringify(v));

/* ---------- Rich text ----------
   Formatted text is kept as "lines" of "runs": [[{ t: 'text', b, i, u, s, size: 'l'|'xl', color }]].
   It's saved as a small, fixed HTML subset that is always rebuilt from scratch (never trusted as-is),
   so a note from a friend or the server can only ever contain these tags. */
const TEXT_COLORS = { red: '#dc2626', orange: '#ea580c', green: '#16a34a', blue: '#2563eb', purple: '#7c3aed', pink: '#db2777' };
const COLOR_BY_HEX = Object.fromEntries(Object.entries(TEXT_COLORS).map(([k, v]) => [v, k]));
const DEFAULT_COLOR_HEX = '#000001'; // "no colour" marker used while applying, removed when saved
const SIZE_BY_FONT = { 5: 'l', 6: 'xl' };
const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE']);

function rgbToHex(c) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
  return m ? `#${[m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('')}` : (c || '').toLowerCase();
}

/** The formatting an element sets on its text (the nearest element wins). */
function fmtOf(el, f) {
  const n = { ...f };
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') n.b = true;
  if (tag === 'I' || tag === 'EM') n.i = true;
  if (tag === 'U') n.u = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') n.s = true;
  if (tag === 'FONT') {
    const sz = el.getAttribute('size');
    if (sz) n.size = SIZE_BY_FONT[sz] || null;
    const col = el.getAttribute('color');
    if (col) n.color = COLOR_BY_HEX[rgbToHex(col)] || null;
  }
  for (const cls of el.classList || []) {
    if (cls === 'secret') n.h = true;
    if (cls === 'fs-l' || cls === 'fs-xl') n.size = cls.slice(3);
    if (cls.startsWith('tc-') && TEXT_COLORS[cls.slice(3)]) n.color = cls.slice(3);
  }
  const st = el.style;
  if (st) {
    if (st.fontWeight) n.b = st.fontWeight === 'bold' || +st.fontWeight >= 600;
    if (st.fontStyle) n.i = st.fontStyle === 'italic';
    const deco = st.textDecorationLine || st.textDecoration || '';
    if (deco) {
      n.u = deco.includes('underline');
      n.s = deco.includes('line-through');
    }
    if (st.color) n.color = COLOR_BY_HEX[rgbToHex(st.color)] || null;
  }
  return n;
}

/** Read formatted lines out of a DOM node (the editor, or parsed saved HTML). */
function domToLines(root) {
  const lines = [];
  let cur = [];
  let dirty = false;
  const push = () => {
    lines.push(cur);
    cur = [];
    dirty = false;
  };
  const walk = (node, f) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        const t = ch.nodeValue.replace(/​/g, '');
        if (t) cur.push({ t, ...f });
        dirty = true;
      } else if (ch.nodeType === 1) {
        if (ch.tagName === 'BR') push();
        else if (ch.tagName === 'SCRIPT' || ch.tagName === 'STYLE') continue;
        else if (ch.classList.contains('secret') && ch.hasAttribute('data-v')) {
          // Hidden-text chip in the editor: its real text is in data-v (the dots/buttons aren't content).
          const t = ch.getAttribute('data-v');
          if (t) cur.push({ t, ...fmtOf(ch, f), h: true });
          dirty = true;
        }
        else if (BLOCK_TAGS.has(ch.tagName)) {
          if (dirty) push();
          const before = lines.length;
          walk(ch, fmtOf(ch, f));
          if (dirty || lines.length === before) push();
        } else walk(ch, fmtOf(ch, f));
      }
    }
  };
  walk(root, {});
  if (dirty) push();
  return lines.length ? lines : [[]];
}

const htmlToLines = (html) => domToLines(new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html').body);
const plainToLines = (text) => (text || '').split('\n').map((t) => (t ? [{ t }] : []));
const linesText = (lines) => lines.map((l) => l.map((r) => r.t).join('')).join('\n');
const sameFmt = (a, b) => a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.size === b.size && a.color === b.color && Boolean(a.h) === Boolean(b.h);
const hasFormatting = (lines) => lines.some((l) => l.some((r) => r.b || r.i || r.u || r.s || r.size || r.color || r.h));
const DOTS = '••••••';

/** mode: 'save' (stored HTML), 'editor' (hidden text as a chip with an eye), 'card' (hidden text as dots). */
function runHtml(r, mode = 'save') {
  let h = esc(r.t);
  if (r.h) {
    if (mode === 'card') h = `<span class="secret-dots">${DOTS}</span>`;
    else if (mode === 'editor')
      h = `<span class="secret" contenteditable="false" data-v="${esc(r.t)}"><span class="sv">${DOTS}</span><button type="button" class="sec-copy" aria-label="Copy" tabindex="-1">${icon('i-copy')}</button><button type="button" class="sec-eye" aria-label="Show hidden text" tabindex="-1">${icon('i-eye')}</button></span>`;
    else h = `<span class="secret">${h}</span>`;
  }
  if (r.s) h = `<s>${h}</s>`;
  if (r.u) h = `<u>${h}</u>`;
  if (r.i) h = `<i>${h}</i>`;
  if (r.b) h = `<b>${h}</b>`;
  const cls = [r.size && `fs-${r.size}`, r.color && TEXT_COLORS[r.color] && `tc-${r.color}`].filter(Boolean);
  return cls.length ? `<span class="${cls.join(' ')}">${h}</span>` : h;
}
function linesToHtml(lines, mode = 'save') {
  return lines
    .map((l) => {
      const runs = [];
      for (const r of l) {
        const last = runs[runs.length - 1];
        if (last && sameFmt(last, r)) last.t += r.t;
        else runs.push({ ...r });
      }
      return `<div>${runs.map((r) => runHtml(r, mode)).join('') || '<br>'}</div>`;
    })
    .join('');
}
const linesOf = (b) => (b.html ? htmlToLines(b.html) : plainToLines(b.text));
/** Set a text block's content from lines (keeps html only when there is formatting). */
function setLines(b, lines) {
  b.text = linesText(lines);
  if (hasFormatting(lines)) b.html = linesToHtml(lines);
  else delete b.html;
  return b;
}
const textBlockFrom = (lines) => setLines({ id: newId(), type: 'text', text: '' }, lines);
/** Safe HTML for showing a text block (rebuilt from the parsed lines). */
const blockHtml = (b, mode = 'save') => linesToHtml(linesOf(b), mode);

/** The cursor's position in a contenteditable as an offset into its plain text. */
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return 0;
  const pre = document.createRange();
  pre.setStart(el, 0);
  pre.setEnd(r.startContainer, r.startOffset);
  const box = document.createElement('div');
  box.append(pre.cloneContents());
  return linesText(domToLines(box)).length;
}
/** Put the cursor at a plain-text offset (the editor's own markup is one <div> per line;
    a hidden-text chip counts as its real text and the cursor never goes inside it). */
function setCaret(el, pos) {
  const sel = getSelection();
  const range = document.createRange();
  const lines = [...el.children];
  let left = pos === true ? Infinity : pos;
  let placed = false;
  const chipLen = (n) => (n.getAttribute('data-v') || '').length;
  const lineLen = (div) => linesText(domToLines(div)).length;
  const place = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        if (left <= ch.nodeValue.length) {
          range.setStart(ch, left);
          return true;
        }
        left -= ch.nodeValue.length;
      } else if (ch.nodeType === 1 && ch.classList.contains('secret') && ch.hasAttribute('data-v')) {
        const len = chipLen(ch);
        if (left <= len) {
          if (left === 0) range.setStartBefore(ch);
          else range.setStartAfter(ch);
          return true;
        }
        left -= len;
      } else if (ch.nodeType === 1 && place(ch)) return true;
    }
    return false;
  };
  for (const [k, div] of lines.entries()) {
    const len = lineLen(div);
    if (left <= len || k === lines.length - 1) {
      left = Math.min(left, len);
      if (!place(div)) range.setStart(div, div.childNodes.length && div.lastChild.nodeName === 'BR' ? 0 : div.childNodes.length);
      placed = true;
      break;
    }
    left -= len + 1;
  }
  if (!placed) range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
/** Split lines at a plain-text line number. */
function lineAt(lines, pos) {
  let k = 0;
  let left = pos;
  while (k < lines.length - 1 && left > linesText([lines[k]]).length) {
    left -= linesText([lines[k]]).length + 1;
    k++;
  }
  return k;
}

function blocksOf(kind, content, items) {
  if (kind === 'checklist') return items.length ? deepCopy(items) : [checkItem()];
  return [textBlock(content)];
}

/** The editor's blocks in the form they're saved. */
function bodyOf(ed) {
  const bl = ed.blocks;
  if (bl.every((b) => isTextBlock(b) && !b.html)) return { kind: 'text', content: bl.map((b) => b.text).join('\n'), items: [] };
  return {
    kind: 'checklist', // = "has blocks" (checkboxes, tables, sections or formatting)
    content: '',
    items: bl
      .filter((b) => !isTextBlock(b) || b.text.trim())
      .map((b) => {
        if (isTextBlock(b)) return b.html ? { id: b.id, type: 'text', text: b.text, html: b.html } : { id: b.id, type: 'text', text: b.text };
        if (isTable(b)) return { id: b.id, type: 'table', rows: deepCopy(b.rows), ...(b.color && b.color !== 'default' ? { color: b.color } : {}) };
        if (isSection(b)) return { id: b.id, type: 'section', title: b.title, collapsed: Boolean(b.collapsed) };
        if (isDivider(b)) return { id: b.id, type: 'divider' };
        return { id: b.id, text: b.text, done: Boolean(b.done) };
      }),
  };
}

/** Join neighbouring text blocks (after a block between them was removed). */
function joinTextBlocks() {
  const out = [];
  for (const b of S.ed.blocks) {
    const prev = out[out.length - 1];
    if (prev && isTextBlock(prev) && isTextBlock(b)) setLines(prev, [...linesOf(prev), ...linesOf(b)]);
    else out.push(b);
  }
  S.ed.blocks = out.length ? out : [textBlock()];
}

/** Which blocks are folded away inside a collapsed section. */
function hiddenIds(blocks) {
  const hide = new Set();
  let folded = false;
  for (const b of blocks) {
    if (isSection(b)) folded = b.collapsed;
    else if (folded) hide.add(b.id);
  }
  return hide;
}

/** caret: true = end, false = start, a position, or { r, c } for a table cell. */
function renderItems(focusId = null, caret = true) {
  const ed = S.ed;
  if (!ed) return;
  const ro = ed.readonly;
  const solo = ed.blocks.length === 1 && isTextBlock(ed.blocks[0]);
  const hide = hiddenIds(ed.blocks);
  const row = (b) => {
    const h = hide.has(b.id) ? ' hidden' : '';
    if (isTable(b)) return tableHtml(b, ro, h);
    if (isDivider(b))
      return `<div class="divider" data-id="${esc(b.id)}"${h}><hr />${ro ? '' : `<button type="button" class="icon-btn div-del" aria-label="Remove line">${icon('i-close')}</button>`}</div>`;
    if (isSection(b))
      return `<div class="sec ${b.collapsed ? 'collapsed' : ''}" data-id="${esc(b.id)}">
        <button type="button" class="icon-btn sec-tog" aria-label="${b.collapsed ? 'Expand section' : 'Collapse section'}" aria-expanded="${!b.collapsed}">${icon('i-chevron')}</button>
        <input class="sec-title" maxlength="200" placeholder="Section title" value="${esc(b.title)}" ${ro ? 'readonly' : ''} />
        ${ro ? '' : `<button type="button" class="icon-btn sec-del" aria-label="Remove section">${icon('i-close')}</button>`}</div>`;
    if (isTextBlock(b))
      return `<div class="tb ${solo ? 'solo' : ''} ${b.text ? '' : 'is-empty'}" data-id="${esc(b.id)}" data-ph="${solo ? 'Start writing…' : ''}" contenteditable="${ro ? 'false' : 'true'}" spellcheck="true"${h}>${blockHtml(b, 'editor')}</div>`;
    return `<div class="ci ${b.done ? 'done' : ''}" data-id="${esc(b.id)}"${h}>
      <button type="button" class="cbox ${b.done ? 'on' : ''}" aria-label="${b.done ? 'Untick' : 'Tick'}" ${ro ? 'disabled' : ''}>${icon('i-check')}</button>
      <textarea rows="1" maxlength="1000" placeholder="List item" ${ro ? 'readonly' : ''}>${esc(b.text)}</textarea>
      ${ro ? '' : `<button type="button" class="icon-btn ci-del" aria-label="Remove item">${icon('i-close')}</button>`}</div>`;
  };
  const last = ed.blocks[ed.blocks.length - 1];
  edItems.innerHTML = `${ed.blocks.map(row).join('')}${!ro && isCheck(last) && !hide.has(last.id) ? `<button type="button" class="ci-add">${icon('i-plus')}List item</button>` : ''}`;
  edItems.querySelectorAll('textarea').forEach(autosize);
  if (focusId) {
    const el = edItems.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
    const cell = typeof caret === 'object' && caret ? caret : null;
    if (el?.classList.contains('tb')) {
      el.focus();
      setCaret(el, caret === true ? true : caret === false ? 0 : caret);
      edCaret = { id: focusId, pos: caretOffset(el) };
    } else {
      const t = cell ? el?.querySelector(`[data-r="${cell.r}"][data-c="${cell.c}"]`) : el?.querySelector('textarea, input');
      if (t) {
        t.focus();
        const pos = caret === true || cell ? t.value.length : caret === false ? 0 : Math.min(caret, t.value.length);
        t.setSelectionRange(pos, pos);
        edCaret = { id: focusId, pos, ...(cell || {}) };
      }
    }
  }
  updateKindBtn();
}

const blockOf = (el) => S.ed.blocks.find((b) => b.id === el.closest('[data-id]')?.dataset.id);
const blockIndex = (b) => S.ed.blocks.indexOf(b);

/** Turn the line the cursor is on (in a text block) into a checkbox. */
function lineToCheck(i, caret) {
  const b = S.ed.blocks[i];
  const lines = linesOf(b);
  const k = lineAt(lines, caret);
  const start = linesText(lines.slice(0, k)).length + (k ? 1 : 0);
  const line = linesText([lines[k]]);
  const clean = line.replace(/^\s*([-*•]|\[[ xX]?\]|☐|☑)\s*/, '');
  const it = checkItem(clean);
  const parts = [];
  if (k > 0) parts.push(textBlockFrom(lines.slice(0, k)));
  parts.push(it);
  if (k < lines.length - 1) parts.push(textBlockFrom(lines.slice(k + 1)));
  S.ed.blocks.splice(i, 1, ...parts);
  renderItems(it.id, Math.max(0, caret - start - (line.length - clean.length)));
}

/** Turn checkbox i back into a line of text, joining the text around it. */
function checkToText(i, caret) {
  const bl = S.ed.blocks;
  const it = bl[i];
  let lines = plainToLines(it.text);
  let pos = caret;
  let from = i;
  let to = i;
  if (bl[i - 1] && isTextBlock(bl[i - 1])) {
    pos += bl[i - 1].text.length + 1;
    lines = [...linesOf(bl[i - 1]), ...lines];
    from = i - 1;
  }
  if (bl[i + 1] && isTextBlock(bl[i + 1])) {
    lines = [...lines, ...linesOf(bl[i + 1])];
    to = i + 1;
  }
  const tb = setLines({ id: it.id, type: 'text', text: '' }, lines);
  bl.splice(from, to - from + 1, tb);
  renderItems(tb.id, pos);
}

function tableHtml(b, ro, hiddenAttr = '') {
  const cols = Math.max(...b.rows.map((r) => r.length));
  const rows = b.rows
    .map(
      (r, ri) =>
        `<tr>${Array.from({ length: cols }, (_, ci) => `<td><textarea class="cell" rows="1" data-r="${ri}" data-c="${ci}" ${ro ? 'readonly' : ''} placeholder="${ri === 0 ? `Column ${ci + 1}` : ''}">${esc(r[ci] ?? '')}</textarea></td>`).join('')}</tr>`,
    )
    .join('');
  const color = b.color && b.color !== 'default' ? ` data-color="${esc(b.color)}"` : '';
  return `<div class="tbl"${color} data-id="${esc(b.id)}"${hiddenAttr}><div class="tbl-scroll"><table>${rows}</table></div>${
    ro
      ? ''
      : `<div class="tbl-bar"><button type="button" data-tbl="row">${icon('i-plus')}Row</button><button type="button" data-tbl="col">${icon('i-plus')}Column</button><span class="spacer"></span><button type="button" class="icon-btn" data-tbl="color" aria-label="Table colour">${icon('i-palette')}</button><button type="button" class="icon-btn" data-tbl="menu" aria-label="Table options">${icon('i-more')}</button></div>`
  }</div>`;
}

/** Insert blocks after the cursor's line/block (or at the end). */
function insertBlockAtCaret(...blocks) {
  const bl = S.ed.blocks;
  const i = edCaret ? bl.findIndex((b) => b.id === edCaret.id) : -1;
  if (i < 0) {
    const last = bl[bl.length - 1];
    if (isTextBlock(last) && !last.text.trim()) bl.splice(bl.length - 1, 0, ...blocks);
    else bl.push(...blocks, textBlock());
    return;
  }
  const cur = bl[i];
  if (isTextBlock(cur) && cur.text) {
    // Split the text after the line the cursor is on.
    const lines = linesOf(cur);
    const k = lineAt(lines, edCaret.pos ?? cur.text.length);
    const tail = k < lines.length - 1 ? [textBlockFrom(lines.slice(k + 1))] : [];
    setLines(cur, lines.slice(0, k + 1));
    bl.splice(i + 1, 0, ...blocks, ...tail);
  } else if (isTextBlock(cur)) {
    bl.splice(i, 0, ...blocks); // empty line: the new block takes its place, the line stays below
  } else bl.splice(i + 1, 0, ...blocks);
  if (bl[bl.length - 1] === blocks[blocks.length - 1] && !isTextBlock(blocks[blocks.length - 1])) bl.push(textBlock());
}

function updateKindBtn() {
  const b = S.ed && edCaret && S.ed.blocks.find((x) => x.id === edCaret.id);
  const inCheck = b && isCheck(b);
  $('edKind').innerHTML = icon(inCheck ? 'i-text' : 'i-checklist');
  $('edKind').setAttribute('aria-label', inCheck ? 'Turn into text' : 'Add checkbox');
}

// Remember where the cursor is, so the toolbar buttons know which line/selection to change.
let savedRange = null;
document.addEventListener('selectionchange', () => {
  const t = document.activeElement;
  if (!S.ed || !t || !edItems.contains(t)) {
    if (calcHintData && t !== calcHintData.el) hideCalcHint();
    return;
  }
  const b = blockOf(t);
  if (!b) return;
  const wasCheck = edCaret && S.ed.blocks.find((x) => x.id === edCaret.id);
  if (t.classList.contains('tb')) {
    edCaret = { id: b.id, pos: caretOffset(t) };
    const sel = getSelection();
    if (sel.rangeCount) savedRange = { el: t, range: sel.getRangeAt(0).cloneRange() };
    updateFormatState();
    updateCalcHint(t);
  } else {
    hideCalcHint();
    edCaret = { id: b.id, pos: t.selectionStart ?? 0, ...(t.classList.contains('cell') ? { r: +t.dataset.r, c: +t.dataset.c } : {}) };
  }
  if (wasCheck !== b) updateKindBtn();
});

function readTextBlock(el) {
  const b = blockOf(el);
  if (!b) return null;
  setLines(b, domToLines(el));
  el.classList.toggle('is-empty', !b.text);
  return b;
}

edItems.addEventListener('input', (e) => {
  if (!S.ed) return;
  const t = e.target;
  if (t.classList?.contains('tb')) {
    const b = readTextBlock(t);
    if (b) edCaret = { id: b.id, pos: caretOffset(t) };
    scheduleSave();
    return;
  }
  if (t.classList?.contains('sec-title')) {
    blockOf(t).title = t.value;
    scheduleSave();
    return;
  }
  if (!t.matches('textarea')) return;
  const b = blockOf(t);
  if (!b) return;
  if (isTable(b)) {
    const { r, c } = t.dataset;
    while (b.rows[r].length <= c) b.rows[r].push('');
    b.rows[r][c] = t.value;
    autosize(t);
    edCaret = { id: b.id, pos: t.selectionStart, r: +r, c: +c };
    scheduleSave();
    return;
  }
  if (t.value.includes('\n')) {
    // Pasted several lines into a checkbox: one checkbox per line.
    const lines = t.value.split('\n');
    b.text = lines[0];
    const extra = lines.slice(1).map((text) => checkItem(text));
    S.ed.blocks.splice(blockIndex(b) + 1, 0, ...extra);
    renderItems(extra[extra.length - 1].id);
  } else {
    b.text = t.value;
    autosize(t);
  }
  edCaret = { id: b.id, pos: t.selectionStart };
  scheduleSave();
});
// Paste into formatted text as plain text (keeps notes clean and safe).
edItems.addEventListener('paste', (e) => {
  if (!e.target.closest?.('.tb')) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
edItems.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!S.ed || S.ed.readonly || e.isComposing) return;
  const b = blockOf(t);
  if (!b) return;
  const i = blockIndex(b);
  if (isSection(b)) {
    if (e.key === 'Enter') {
      // Enter in a section title: go to its first line (making one if needed).
      e.preventDefault();
      if (b.collapsed) b.collapsed = false;
      let next = S.ed.blocks[i + 1];
      if (!next || isSection(next)) {
        next = textBlock();
        S.ed.blocks.splice(i + 1, 0, next);
      }
      renderItems(next.id, false);
      scheduleSave();
    } else if (e.key === 'Backspace' && !t.value) {
      e.preventDefault();
      S.ed.blocks.splice(i, 1);
      joinTextBlocks();
      edCaret = null;
      renderItems();
      scheduleSave();
    }
    return;
  }
  if (isTable(b)) {
    // Enter = next row, same column (adds a row at the bottom), like a spreadsheet. Shift+Enter = new line in the cell.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const r = +t.dataset.r + 1;
      const c = +t.dataset.c;
      if (r >= b.rows.length) b.rows.push(Array(b.rows[0].length).fill(''));
      renderItems(b.id, { r, c });
      scheduleSave();
    }
    return;
  }
  if (isTextBlock(b)) {
    // Backspace at the start of text right after a checkbox: join its first line onto that checkbox.
    const prev = S.ed.blocks[i - 1];
    const sel = getSelection();
    if (e.key === 'Backspace' && prev && isDivider(prev) && sel.isCollapsed && caretOffset(t) === 0) {
      // Backspace right below a line removes the line.
      e.preventDefault();
      readTextBlock(t);
      S.ed.blocks.splice(i - 1, 1);
      joinTextBlocks();
      const joined = S.ed.blocks.find((x) => x.id === b.id) || S.ed.blocks[Math.max(0, i - 2)];
      const before = joined && joined !== b && isTextBlock(joined) ? joined.text.length - b.text.length : 0;
      renderItems(joined?.id, before);
      scheduleSave();
      return;
    }
    if (e.key === 'Backspace' && prev && isCheck(prev) && sel.isCollapsed && caretOffset(t) === 0) {
      e.preventDefault();
      readTextBlock(t);
      const lines = linesOf(b);
      const caret = prev.text.length;
      prev.text += linesText([lines[0]]);
      if (lines.length === 1) S.ed.blocks.splice(i, 1);
      else setLines(b, lines.slice(1));
      renderItems(prev.id, caret);
      scheduleSave();
    }
    return;
  }
  const atStart = t.selectionStart === 0 && t.selectionEnd === 0;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!b.text) {
      checkToText(i, 0); // Enter on an empty checkbox ends the list
    } else {
      const pos = t.selectionStart;
      const next = checkItem(b.text.slice(pos));
      b.text = b.text.slice(0, pos);
      S.ed.blocks.splice(i + 1, 0, next);
      renderItems(next.id, false);
    }
    scheduleSave();
  } else if (e.key === 'Backspace' && atStart) {
    e.preventDefault();
    checkToText(i, 0); // Backspace at the start removes the checkbox, keeps the text
    scheduleSave();
  }
});
edItems.addEventListener('click', (e) => {
  if (!S.ed) return;
  const chip = e.target.closest('.secret[data-v]');
  if (chip) {
    // Hidden text: the eye shows/hides it, the copy button copies it (works on view-only notes too).
    e.preventDefault();
    if (e.target.closest('.sec-copy')) {
      navigator.clipboard?.writeText(chip.getAttribute('data-v')).then(
        () => toast('Copied'),
        () => toast("Couldn't copy"),
      );
      return;
    }
    const shown = chip.classList.toggle('shown');
    chip.querySelector('.sv').textContent = shown ? chip.getAttribute('data-v') : DOTS;
    chip.querySelector('.sec-eye').innerHTML = icon(shown ? 'i-eye-off' : 'i-eye');
    chip.querySelector('.sec-eye').setAttribute('aria-label', shown ? 'Hide' : 'Show hidden text');
    return;
  }
  const tog = e.target.closest('.sec-tog');
  if (tog) {
    // Folding works for everyone (also view-only); it's saved for the owner/editors.
    const s = blockOf(tog);
    s.collapsed = !s.collapsed;
    renderItems();
    if (!S.ed.readonly) scheduleSave();
    return;
  }
  if (S.ed.readonly) return;
  if (e.target.closest('.ci-add')) {
    const it = checkItem();
    S.ed.blocks.push(it);
    renderItems(it.id);
    return;
  }
  const tb = e.target.closest('[data-tbl]');
  if (tb) {
    tableAction(blockOf(tb), tb.dataset.tbl);
    return;
  }
  const box = e.target.closest('.cbox');
  if (box) {
    const it = blockOf(box);
    it.done = !it.done;
    renderItems();
    scheduleSave();
    return;
  }
  const del = e.target.closest('.ci-del, .sec-del, .div-del');
  if (del) {
    const it = blockOf(del);
    S.ed.blocks = S.ed.blocks.filter((x) => x !== it);
    joinTextBlocks();
    if (edCaret?.id === it.id) edCaret = null;
    renderItems();
    scheduleSave();
  }
});

// Checkbox button: on a text line → make it a checkbox; on a checkbox → back to text.
$('edKind').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard open
$('edKind').onclick = () => {
  const ed = S.ed;
  if (!ed || ed.readonly) return;
  const i = edCaret ? ed.blocks.findIndex((b) => b.id === edCaret.id) : -1;
  if (i >= 0 && (isTable(ed.blocks[i]) || isSection(ed.blocks[i]))) {
    const it = checkItem();
    ed.blocks.splice(i + 1, 0, it);
    renderItems(it.id);
  } else if (i >= 0) {
    if (isTextBlock(ed.blocks[i])) lineToCheck(i, edCaret.pos);
    else checkToText(i, edCaret.pos);
  } else {
    const last = ed.blocks[ed.blocks.length - 1];
    if (isTextBlock(last) && !last.text.trim()) lineToCheck(ed.blocks.length - 1, 0);
    else {
      const it = checkItem();
      ed.blocks.push(it);
      renderItems(it.id);
    }
  }
  scheduleSave();
};

// + Insert: table or section.
$('edInsert').onclick = async () => {
  const ed = S.ed;
  if (!ed || ed.readonly) return;
  const a = await menuSheet('Insert', [
    ['table', 'i-table', 'Table', { hint: 'Rows and columns, like a spreadsheet' }],
    ['section', 'i-section', 'Section', { hint: 'A heading you can fold away (collapse / expand)' }],
    ['divider', 'i-divider', 'Divider line', { hint: 'A horizontal line to separate parts' }],
    ['check', 'i-checklist', 'Checkbox list'],
  ]);
  if (!a || S.ed !== ed) return;
  if (a === 'check') return $('edKind').click();
  if (a === 'table') {
    const t = tableBlock();
    insertBlockAtCaret(t);
    renderItems(t.id, { r: 0, c: 0 });
  } else if (a === 'divider') {
    const d = dividerBlock();
    insertBlockAtCaret(d);
    const after = S.ed.blocks[S.ed.blocks.indexOf(d) + 1];
    renderItems(after?.id, false);
  } else {
    const s = sectionBlock();
    insertBlockAtCaret(s, textBlock());
    renderItems(s.id);
  }
  scheduleSave();
};

/* ---------- Hidden text (passwords): select → eye button → shows as •••••• ---------- */
$('edHide').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
$('edHide').onclick = () => {
  if (!S.ed || S.ed.readonly) return;
  if (!restoreSelection()) return toast('Select the text you want to hide first.');
  const el = savedRange.el;
  const b = blockOf(el);
  const r = getSelection().getRangeAt(0);
  const A = '\uE000';
  const B = '\uE001';
  const collapsed = r.collapsed;
  const end = r.cloneRange();
  end.collapse(false);
  end.insertNode(document.createTextNode(B));
  if (!collapsed) {
    const st = r.cloneRange();
    st.collapse(true);
    st.insertNode(document.createTextNode(A));
  }
  // One entry per character (with its formatting); '\n' entries split lines.
  const chars = [];
  domToLines(el).forEach((l, k) => {
    if (k) chars.push({ nl: true });
    for (const run of l) for (const ch of run.t) chars.push({ ...run, t: ch });
  });
  const ib = chars.findIndex((c) => c.t === B);
  let ia = collapsed ? ib : chars.findIndex((c) => c.t === A);
  if (ib < 0 || ia < 0) {
    renderItems(b.id, edCaret?.pos ?? true);
    return toast('Select the text you want to hide.');
  }
  let msg;
  if (collapsed) {
    // Cursor right next to hidden text: show it as normal text again.
    let from = -1;
    if (chars[ib - 1]?.h) from = ib - 1;
    else if (chars[ib + 1]?.h) from = ib + 1;
    if (from < 0) {
      chars.splice(ib, 1);
      setLines(b, charsToLines(chars));
      renderItems(b.id, edCaret?.pos ?? true);
      return toast('Select the text you want to hide (like a password), then tap the eye.');
    }
    for (let k = from; k >= 0 && chars[k].h && !chars[k].nl; k--) chars[k].h = false;
    for (let k = from + 1; k < chars.length && chars[k].h && !chars[k].nl; k++) chars[k].h = false;
    msg = 'Text is visible again';
  } else {
    if (ia > ib) [ia, ib] = [ib, ia];
    const inside = chars.slice(ia + 1, ib).filter((c) => !c.nl && c.t.trim());
    if (!inside.length) {
      chars.splice(ib, 1);
      chars.splice(ia, 1);
      setLines(b, charsToLines(chars));
      renderItems(b.id, edCaret?.pos ?? true);
      return toast('Select the text you want to hide.');
    }
    const hide = !inside.every((c) => c.h);
    for (let k = ia + 1; k < ib; k++) if (!chars[k].nl) chars[k].h = hide;
    msg = hide ? 'Hidden — tap the eye on it to see it' : 'Text is visible again';
  }
  // Caret goes where the end marker was.
  const caret = chars.slice(0, chars.findIndex((c) => c.t === B)).filter((c) => c.t !== A).length;
  setLines(b, charsToLines(chars.filter((c) => c.t !== A && c.t !== B)));
  renderItems(b.id, caret);
  scheduleSave();
  toast(msg);
};
function charsToLines(chars) {
  const lines = [[]];
  for (const c of chars) {
    if (c.nl) lines.push([]);
    else lines[lines.length - 1].push(c);
  }
  return lines;
}

/* ---------- Formatting bar (bold, italic, size, colour) ---------- */
const fmtBar = $('fmtBar');
$('edFormat').onclick = () => {
  fmtBar.hidden = !fmtBar.hidden;
  $('edFormat').classList.toggle('on', !fmtBar.hidden);
  if (!fmtBar.hidden) {
    renderFmtColors();
    updateFormatState();
  }
};
fmtBar.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
function renderFmtColors() {
  $('fmtColors').innerHTML = [['default', ''], ...Object.entries(TEXT_COLORS)]
    .map(([k]) => `<button type="button" class="fmt-color tc-dot-${k}" data-tc="${k}" aria-label="${k === 'default' ? 'Default colour' : `${k} text`}"></button>`)
    .join('');
}
/** Restore the last selection in a text block, so a toolbar tap applies to it. */
function restoreSelection() {
  if (!savedRange || !savedRange.el.isConnected) return false;
  if (document.activeElement !== savedRange.el) savedRange.el.focus({ preventScroll: true });
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange.range);
  return true;
}
fmtBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !S.ed || S.ed.readonly) return;
  if (!restoreSelection()) return toast('Tap in the text first, then select the words to format.');
  document.execCommand('styleWithCSS', false, false);
  if (btn.dataset.cmd) document.execCommand(btn.dataset.cmd);
  if (btn.dataset.size) document.execCommand('fontSize', false, { m: '3', l: '5', xl: '6' }[btn.dataset.size]);
  if (btn.dataset.tc) document.execCommand('foreColor', false, TEXT_COLORS[btn.dataset.tc] || DEFAULT_COLOR_HEX);
  const el = savedRange.el;
  readTextBlock(el);
  const sel = getSelection();
  if (sel.rangeCount) savedRange = { el, range: sel.getRangeAt(0).cloneRange() };
  updateFormatState();
  scheduleSave();
});
/** The formatting at the cursor (or the start of the selection) in a text block. */
function formatAtCaret() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  const host = node.nodeType === 1 ? node.closest('.tb') : node.parentElement?.closest('.tb');
  if (!host) return null;
  // Cursor between elements: look at the text just before it.
  if (node.nodeType === 1 && sel.getRangeAt(0).startOffset > 0) {
    let prev = node.childNodes[sel.getRangeAt(0).startOffset - 1];
    while (prev && prev.nodeType === 1 && prev.lastChild && !prev.matches('.secret')) prev = prev.lastChild;
    if (prev) node = prev;
  }
  const chain = [];
  for (let el = node.nodeType === 1 ? node : node.parentElement; el && el !== host; el = el.parentElement) chain.unshift(el);
  return chain.reduce((f, el) => fmtOf(el, f), {});
}
function updateFormatState() {
  if (fmtBar.hidden) return;
  const f = formatAtCaret() || {};
  const map = { bold: f.b, italic: f.i, underline: f.u, strikeThrough: f.s };
  for (const b of fmtBar.querySelectorAll('[data-cmd]')) b.classList.toggle('on', Boolean(map[b.dataset.cmd]));
  for (const b of fmtBar.querySelectorAll('[data-size]')) b.classList.toggle('on', b.dataset.size === (f.size || 'm'));
  for (const b of fmtBar.querySelectorAll('[data-tc]')) {
    const on = b.dataset.tc === (f.color || 'default');
    b.classList.toggle('sel', on);
    b.innerHTML = on ? icon('i-check') : '';
    b.setAttribute('aria-pressed', String(on));
  }
}


/* ---------- Auto-calculate suggestions ----------
   In text: "45 + 30 + 10 =" suggests 85, and a run of lines starting with +/− amounts
   ("+500 received", "-200 train ticket") suggests a total line on the empty line below.
   The calculator button in the editor turns this on/off (remembered on this device). */
const CALC_KEY = 'notesgo.calc';
let calcOn = (() => {
  try {
    return localStorage.getItem(CALC_KEY) !== '0';
  } catch {
    return true;
  }
})();
let calcHintData = null;
const calcHint = $('calcHint');

/** Evaluate + − × ÷ % and brackets without eval(). Returns a number or null. */
function evalExpr(src) {
  const s = src.replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
  const toks = s.match(/\d*\.?\d+|[-+*/%()]|\S/g);
  if (!toks) return null;
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = factor();
      if (op === '/' && r === 0) throw new Error('div0');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function factor() {
    if (peek() === '-') return next(), -factor();
    if (peek() === '+') return next(), factor();
    let v;
    if (peek() === '(') {
      next();
      v = expr();
      if (next() !== ')') throw new Error('paren');
    } else {
      const t = next();
      if (!/^\d*\.?\d+$/.test(t || '')) throw new Error('num');
      v = parseFloat(t);
    }
    while (peek() === '%') next(), (v /= 100);
    return v;
  }
  try {
    const v = expr();
    return i === toks.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
const fmtNum = (v) => {
  const r = Math.round(v * 1e8) / 1e8;
  return Object.is(r, -0) ? '0' : String(r);
};

/** What to suggest at the cursor in a text block, or null. */
function calcSuggestion(el) {
  const text = linesText(domToLines(el));
  const pos = caretOffset(el);
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  let end = text.indexOf('\n', pos);
  if (end < 0) end = text.length;
  const before = text.slice(start, pos);
  const after = text.slice(pos, end);
  if (after.trim()) return null;

  // 1) "45 + 30 + 10 =" → 85
  const m = /([-+(]?\s*[\d(][\d\s.,+\-−–*/×xX÷%()]*?)\s*=\s*$/.exec(before);
  if (m) {
    const exprSrc = m[1].replace(/^[^\d(+\-]+/, '');
    if (/\d\s*[-+*/×xX÷−–%]\s*[\d(]|\)\s*[-+*/×xX÷]/.test(exprSrc) || /\d%/.test(exprSrc)) {
      const v = evalExpr(exprSrc);
      if (v != null) return { label: fmtNum(v), parts: [(/[=]\s$/.test(before) ? '' : ' ') + fmtNum(v)] };
    }
  }

  // 2) running total under "+500 received / -200 train ticket / …"
  if (!before.trim()) {
    const lines = text.slice(0, start).split('\n');
    lines.pop(); // the part after the last newline is the current (empty) line
    const re = /^\s*([+\-−])\s*([₹$€£¥]?)\s*(\d[\d,]*(?:\.\d+)?)/;
    let total = 0;
    let count = 0;
    let cur = '';
    for (let k = lines.length - 1; k >= 0; k--) {
      const mm = re.exec(lines[k]);
      if (!mm) break;
      const n = parseFloat(mm[3].replace(/,/g, ''));
      total += mm[1] === '+' ? n : -n;
      cur = cur || mm[2];
      count++;
    }
    if (count >= 2) {
      const sign = total < 0 ? '-' : '+';
      const line = `${sign}${cur}${fmtNum(Math.abs(total))} in total`;
      return { label: line, parts: ['--------------', line] };
    }
  }
  return null;
}

function hideCalcHint() {
  calcHintData = null;
  calcHint.hidden = true;
}
function updateCalcHint(el) {
  if (!calcOn || !S.ed || S.ed.readonly || !el?.classList.contains('tb') || !getSelection().isCollapsed) return hideCalcHint();
  const sug = calcSuggestion(el);
  if (!sug) return hideCalcHint();
  calcHintData = { el, ...sug };
  calcHint.innerHTML = `${icon('i-calc')}<span class="ch-val">${esc(sug.parts.length > 1 ? sug.label : `= ${sug.label}`)}</span><small>Tap to add</small>`;
  calcHint.hidden = false;
}
function acceptCalcHint() {
  const d = calcHintData;
  if (!d || !d.el.isConnected) return hideCalcHint();
  if (document.activeElement !== d.el) restoreSelection();
  d.parts.forEach((t, k) => {
    if (k) document.execCommand('insertParagraph');
    document.execCommand('insertText', false, t);
  });
  readTextBlock(d.el);
  scheduleSave();
  hideCalcHint();
}
calcHint.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard open
calcHint.onclick = acceptCalcHint;
edItems.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && calcHintData && !calcHint.hidden && e.target.classList?.contains('tb')) {
    e.preventDefault();
    acceptCalcHint();
  }
});
function renderCalcBtn() {
  $('edCalc').classList.toggle('on', calcOn);
  $('edCalc').setAttribute('aria-pressed', String(calcOn));
  $('edCalc').setAttribute('aria-label', calcOn ? 'Auto-calculate is on' : 'Auto-calculate is off');
}
$('edCalc').addEventListener('pointerdown', (e) => e.preventDefault());
$('edCalc').onclick = () => {
  calcOn = !calcOn;
  try {
    localStorage.setItem(CALC_KEY, calcOn ? '1' : '0');
  } catch {}
  renderCalcBtn();
  toast(calcOn ? 'Auto-calculate on: end a sum with “=”, or list +/− amounts' : 'Auto-calculate off');
  const t = document.activeElement;
  if (calcOn && t?.classList.contains('tb')) updateCalcHint(t);
  else hideCalcHint();
};
renderCalcBtn();

async function tableAction(t, action) {
  if (!t || !S.ed) return;
  const cols = t.rows[0].length;
  const at = edCaret?.id === t.id && edCaret.r != null ? { r: edCaret.r, c: edCaret.c } : null;
  if (action === 'row') {
    t.rows.push(Array(cols).fill(''));
    renderItems(t.id, { r: t.rows.length - 1, c: at?.c ?? 0 });
  } else if (action === 'col') {
    t.rows.forEach((r) => r.push(''));
    renderItems(t.id, { r: 0, c: cols }); // start by naming the new column
  } else if (action === 'color') {
    const key = await pickColor('Table colour', t.color || 'default');
    if (!key || !S.ed) return;
    t.color = key;
    renderItems();
  } else if (action === 'menu') {
    const items = [];
    if (at) {
      items.push(['rowAbove', 'i-plus', 'Insert row above'], ['colLeft', 'i-plus', 'Insert column to the left']);
      if (t.rows.length > 1) items.push(['delRow', 'i-close', `Delete row ${at.r + 1}`]);
      if (cols > 1) items.push(['delCol', 'i-close', `Delete column ${at.c + 1}`]);
    }
    items.push(['color', 'i-palette', 'Table colour']);
    items.push(['sortAsc', 'i-sort', at ? `Sort by column ${at.c + 1} (A→Z)` : 'Sort by column 1 (A→Z)'], ['sortDesc', 'i-sort', at ? `Sort by column ${at.c + 1} (Z→A)` : 'Sort by column 1 (Z→A)']);
    items.push(['delTable', 'i-trash', 'Delete table', { danger: true }]);
    const a = await menuSheet('Table', items);
    if (!a || !S.ed) return;
    if (a === 'color') return tableAction(t, 'color');
    const c = at?.c ?? 0;
    if (a === 'rowAbove') t.rows.splice(at.r, 0, Array(cols).fill(''));
    if (a === 'colLeft') t.rows.forEach((r) => r.splice(at.c, 0, ''));
    if (a === 'delRow') t.rows.splice(at.r, 1);
    if (a === 'delCol') t.rows.forEach((r) => r.splice(at.c, 1));
    if (a === 'sortAsc' || a === 'sortDesc') {
      // The first row is the header and stays on top. Numbers sort as numbers.
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      const body = t.rows.slice(1).sort((x, y) => coll.compare(x[c] ?? '', y[c] ?? ''));
      if (a === 'sortDesc') body.reverse();
      t.rows = [t.rows[0], ...body];
    }
    if (a === 'delTable') {
      S.ed.blocks = S.ed.blocks.filter((x) => x !== t);
      joinTextBlocks();
      edCaret = null;
    }
    renderItems();
  }
  scheduleSave();
}

/** A colour picker sheet → resolves the chosen colour key (or null). */
function pickColor(title, current) {
  return new Promise((resolve) => {
    const el = openSheet(`${sheetHero('i-palette', title)}<div class="palette inline">${swatches(current)}</div>`, (r) => resolve(r || null));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-color-key]');
      if (b) closeSheet(b.dataset.colorKey);
    });
  });
}

/* ---------- Saving ---------- */
const hasContent = (ed) => ed.title.trim() || ed.blocks.some((b) => blockText(b).trim());

/** Write the editor's state to the note (creating it on first content). */
async function flushEditor() {
  clearTimeout(edTimer);
  const ed = S.ed;
  if (!ed || ed.readonly) return;
  const n = findNote(ed.id);
  const data = {
    title: ed.title,
    ...bodyOf(ed),
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
  hideCalcHint();
  $('editor').hidden = true;
  $('palette').hidden = true;
  if (!ed) return;
  (async () => {
    await flushEditor();
    await allSaved();
    if (S.ed === ed) S.ed = null;
    const n = findNote(ed.id);
    const f = n && fieldsOf(n);
    if (n && f && isOwn(n) && !n.trashed && !f.title.trim() && !f.content.trim() && !f.items.some((i) => blockText(i).trim()) && !f.tags.length) {
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
  if (S.ed?.blocks[0]) renderItems(S.ed.blocks[0].id, isTable(S.ed.blocks[0]) ? { r: 0, c: 0 } : false);
});
$('edBody').addEventListener('click', (e) => {
  // Tap below the note: continue writing at the end (new text line after a list).
  if ((e.target.id === 'edBody' || e.target === edItems) && S.ed && !S.ed.readonly) {
    const last = S.ed.blocks[S.ed.blocks.length - 1];
    if (isTextBlock(last)) renderItems(last.id);
    else {
      const tb = textBlock();
      S.ed.blocks.push(tb);
      renderItems(tb.id);
    }
  }
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
    edTitle.readOnly = false;
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
        ensureRecovery();
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
    el.querySelector('[data-forgot]').onclick = () => forgotPasswordSheet();
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
      ensureRecovery();
      closeSheet();
    };
  });
}

/** Re-encrypt every secure note with a key from a new password (the vault must be unlocked). */
async function rekeyVault(newPassword) {
  await allSaved();
  await decryptAll();
  const made = await Vault.create(newPassword);
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
  await ensureRecovery();
}

/** Keep the email-recovery copy of the vault key up to date (needs the vault unlocked + online). */
async function ensureRecovery() {
  if (!S.vault || !Vault.unlocked || !navigator.onLine) return;
  if (Vault.recoveryKid(S.vault.recovery_wrap) === Vault.keyId) return;
  try {
    const { rkey, wrap } = await Vault.makeRecovery();
    await Cloud.saveVaultRecovery(rkey, wrap);
    S.vault = { ...S.vault, recovery_wrap: wrap };
    await DB.put('vault', S.vault);
  } catch (e) {
    console.warn('Secure folder recovery setup failed; will retry on next unlock', e);
  }
}

/* ---------- Forgot password ----------
   Forgot password? → "Request password reset" → email with a code and a link →
   either one opens "Set new password".
   - Folders with an email-recovery copy: notes are kept and re-encrypted.
   - Older folders without one: the old notes can't be decrypted by anyone, so (after a clear
     warning) they're deleted and the folder starts fresh with the new password. */
const RECOVERY_PENDING = 'notesgo.vaultRecovery';
const pendingReset = {
  get() {
    try {
      const p = JSON.parse(localStorage.getItem(RECOVERY_PENDING) || 'null');
      return p && Date.now() - p.at < 15 * 60 * 1000 ? p : null;
    } catch {
      return null;
    }
  },
  set() {
    try {
      localStorage.setItem(RECOVERY_PENDING, JSON.stringify({ at: Date.now() }));
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(RECOVERY_PENDING);
    } catch {}
  },
};

function forgotPasswordSheet() {
  const email = S.user?.email || '';
  if (!email) return toast('Sign in again to reset the password.');
  const el = openSheet(
    `${sheetHero('i-mail', 'Forgot Secure folder password?', `We’ll send a reset link to ${email}.`)}
     <div id="fs1">
       <div class="err" id="ferr1"></div>
       <div class="sheet-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-gradient" type="button" data-send>Request password reset</button></div>
     </div>
     <form id="fs2" hidden>
       <div class="sheet-note">Email sent. <b>Tap the link in the email</b> (open it in this browser) — NotesGo opens with “Set new password”. If the email shows a code instead, enter it here.</div>
       <label class="field"><span>Code (if the email has one)</span><input class="input otp-input" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" /></label>
       <div class="err" id="ferr"></div>
       <div class="sheet-actions"><button class="btn btn-ghost" type="button" data-send>Resend</button><button class="btn btn-gradient" type="submit">Continue</button></div>
     </form>`,
  );
  el.querySelector('[data-cancel]').onclick = () => closeSheet();
  for (const b of el.querySelectorAll('[data-send]'))
    b.onclick = async () => {
      if (!navigator.onLine) return toast('You need to be online to reset the password.');
      b.disabled = true;
      const was = b.textContent;
      b.textContent = 'Sending…';
      try {
        await Cloud.sendEmailCode(email);
        pendingReset.set();
        el.querySelector('#fs1').hidden = true;
        el.querySelector('#fs2').hidden = false;
        el.querySelector('#otp').focus();
        toast(`Reset email sent to ${email}`);
      } catch (ex) {
        const m = ex.message || String(ex);
        const msg = /rate|seconds|security purposes/i.test(m)
          ? 'Too many emails — wait a minute and try again.'
          : /email logins are disabled|email.*provider.*disabled|signups not allowed for otp/i.test(m)
          ? 'Email reset is turned off in Supabase. Turn on Authentication → Sign In / Providers → Email, then try again.'
          : /smtp|sending.*email|error sending/i.test(m)
          ? 'Supabase couldn’t send the email (mail settings). Check Authentication → Emails, then try again.'
          : m;
        (el.querySelector('#fs2').hidden ? el.querySelector('#ferr1') : el.querySelector('#ferr')).textContent = msg;
      }
      b.disabled = false;
      b.textContent = was;
    };
  el.querySelector('#fs2').onsubmit = async (e) => {
    e.preventDefault();
    const code = el.querySelector('#otp').value.replace(/\s/g, '');
    const err = el.querySelector('#ferr');
    if (!/^\d{6,10}$/.test(code)) return (err.textContent = 'Enter the code from the email.');
    const btn = el.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await Cloud.verifyEmailCode(email, code);
      const rkey = await Cloud.getVaultRecovery();
      await closeSheet();
      setNewPasswordSheet(rkey);
    } catch (ex) {
      err.textContent = /expired|invalid/i.test(ex.message || '') ? 'That code is wrong or expired.' : ex.message || String(ex);
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  };
}

/** Email verified: choose a new password. rkey = recovery key from the server (null for older folders). */
async function setNewPasswordSheet(rkey) {
  // Use the server's current vault row (the recovery copy may be newer than this device's).
  try {
    const remote = await Cloud.fetchVault();
    if (remote) S.vault = { ...remote, synced: 1 };
  } catch {}
  const rec = S.vault;
  const kept = Boolean(rec && rkey && rec.recovery_wrap && (await Vault.unlockWithRecovery(rec, rkey)));
  if (kept) await decryptAll();
  const lost = S.notes.filter((n) => n.secure && isOwn(n) && !n.deleted && (!kept || !S.plain.has(n.id)));
  const el = openSheet(
    `${sheetHero('i-key', 'Set new password', 'Email verified.')}
     ${
       lost.length
         ? `<div class="sheet-note warn">${plural(lost.length, 'secure note')} ${lost.length === 1 ? 'was' : 'were'} locked with your old password before email reset was available, so ${lost.length === 1 ? 'it' : 'they'} can’t be opened by anyone. Setting a new password deletes ${lost.length === 1 ? 'it' : 'them'}.</div>
            <label class="check-row"><input type="checkbox" id="lostOk" /> <span>I understand</span></label>`
         : kept
         ? '<div class="sheet-note">Your secure notes are kept and will use the new password.</div>'
         : ''
     }
     <form id="vf">${pwField('p1', 'New password (at least 6 characters)', true, 'new-password')}
     ${pwField('p2', 'Confirm new password', false, 'new-password')}
     <div class="err" id="verr"></div>
     <div class="sheet-actions"><button class="btn btn-ghost" type="button" data-cancel>Cancel</button><button class="btn btn-gradient" type="submit">Save new password</button></div></form>`,
  );
  el.querySelector('[data-cancel]').onclick = () => closeSheet();
  el.querySelector('#vf').onsubmit = async (e) => {
    e.preventDefault();
    const err = el.querySelector('#verr');
    const p1 = el.querySelector('#p1').value;
    if (p1.length < 6) return (err.textContent = 'Use at least 6 characters.');
    if (p1 !== el.querySelector('#p2').value) return (err.textContent = "Passwords don't match.");
    if (lost.length && !el.querySelector('#lostOk').checked) return (err.textContent = 'Tick “I understand” to continue.');
    if (!navigator.onLine) return (err.textContent = 'You need to be online.');
    const btn = el.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      for (const n of lost) await deleteForever(n.id);
      if (kept) {
        await rekeyVault(p1);
      } else {
        // Start the folder fresh with the new password (+ email recovery from now on).
        if (S.vault) await Cloud.deleteVault();
        const made = await Vault.create(p1);
        const res = await Cloud.createVault(made.record);
        S.vault = { ...(res.row || res.existing), synced: 1 };
        await DB.put('vault', S.vault);
        Vault.activate(made.key, made.keyId);
        await ensureRecovery();
      }
      pendingReset.clear();
      S.failedUnlocks = 0;
      S.lockUntil = 0;
      await closeSheet();
      toast('New password saved');
      render();
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      btn.disabled = false;
      btn.textContent = 'Save new password';
    }
  };
}

/** Opened the reset link from the email: go straight to "Set new password". */
async function resumeRecovery() {
  if (!pendingReset.get() || !navigator.onLine || !S.vault) return;
  let rkey;
  try {
    rkey = await Cloud.getVaultRecovery(); // only works right after verifying by email (link or code)
  } catch {
    return;
  }
  setNewPasswordSheet(rkey);
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
      await rekeyVault(p1);
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
  resumeRecovery();
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
