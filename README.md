# NotesGo

A mobile-first notes and checklist web app in plain HTML, CSS and JavaScript. It has no build step and nothing to install. It works offline, syncs on its own through Supabase, and you sign in with Google.

It uses the **same Supabase project as myExpenses**, with its own schema (`notesgo`), so the two apps' tables never mix.

## Features

The look follows **myExpenses**: purple gradient header, glass buttons, cards, bottom sheets and a gradient selection bar, in **light and dark** mode. Tap ☀️/🌙 in the header to switch; the side menu also offers *System*.

- **Side menu** (☰ at the top left): My Notes, Shared, Secure folder, Archive, Trash, and your tags. *Edit* renames or deletes a tag everywhere. Sign out is at the bottom.
- **Create** (the **+ New** button opens a bottom sheet): Note, Checklist or Secure note.
- **Checklists**: tick items in the editor or right on the card. Enter adds the next item, Backspace on an empty item joins it with the one above, and pasted lines become separate items. Ticked items move under *Completed*. The ☑/≡ button in the editor turns a note into a checklist and back.
- **Pin**, **tags** and **background colour** (12 colours, each with a dark-mode version), from the editor.
- **Filter chips**: All · Pinned · Notes · Checklists. **Search** looks in titles, text, checklist items and tags. **List/grid** layout toggle.
- **Multi-select**: long-press a note, or tap the ☑ button, to show checkboxes. The bottom bar then offers **Pin, Secure, Share, Delete** and **More** (colour, add tag, archive, make copies). *Select all* is in the bar. In Trash the bar offers *Restore* and *Delete*; in the Secure folder, *Move out*.
- **Share with someone**: share by Google email with **Can view** or **Can edit** access, from the editor (👤+), from the ⋯ menu, or for several notes at once from the selection bar.
  - The person sees the note under *My Notes* and *Shared*, marked with the owner's name, after signing in to NotesGo with that email. With edit access they can change the title, text and checklist. Pin, colour, tags, archive and delete stay with the owner; the database enforces this too (`guard_shared_edit`).
  - You can change someone's access or remove them in the share sheet. They can also *Remove from my notes* themselves.
  - Secure notes can't be shared. Moving a shared note into the Secure folder asks first, then stops the sharing.
- **Secure folder** 🔒: the title, text, checklist and tags are **encrypted on the device** (AES-256-GCM, with the key derived from your password by PBKDF2-SHA256 at 310,000 iterations). Supabase stores only the ciphertext.
  - The folder locks when you leave it, when you tap *Lock*, and after 60 s in the background (`AUTO_LOCK_SECONDS`). After 5 wrong tries, each new attempt has to wait longer.
  - Change the password from the account sheet (tap your avatar). **Forgot it?** Nobody can decrypt those notes. *Forgot password?* → *Reset* deletes them, and then you can set a new password.
  - Setting up, changing or resetting the password needs internet. Unlocking and editing work offline.
- **Archive** and **Trash**: 7-day auto-delete (`TRASH_DAYS`), with *Undo* after delete or archive.
- The Android back button closes sheets, selection, the editor and the menu first.

## Offline + sync

Every change is written to IndexedDB first, so the app works with no connection. It syncs with Supabase:

- about 1 second after every change (several quick changes are sent together),
- when the connection comes back, when you return to the app, and every minute while it's open,
- right away when another device, or a friend you shared with, changes a note (Supabase Realtime).

The cloud icon in the top bar shows the status: synced ✓, syncing, changes waiting ↑, offline, or a problem ⚠ (sync keeps retrying with backoff). Conflicts: if a note was edited on this device and hasn't been uploaded yet, the local edit wins. Otherwise the newest server version is used. Deleting a note forever leaves a blank tombstone so that other devices delete it too.

## Setup (once)

1. **Database**: Supabase Dashboard → SQL Editor → run [`supabase/schema.sql`](supabase/schema.sql). It is safe to re-run.
2. **Expose the schema**: Project Settings → Data API → *Exposed schemas* → add `notesgo` (keep `myexpenses`).
3. **Google login** is already enabled for myExpenses. Under Authentication → URL Configuration → *Redirect URLs*, add every URL NotesGo is served from, for example:
   - `http://localhost:3000/`
   - `https://<your-github-user>.github.io/NotesGo/`
4. `config.js` already has the project URL and anon key (the same as myExpenses).

## Run it

- **Locally**: `node server.js` → http://localhost:3000. Google sign-in needs http(s); it doesn't work from `file://`.
- **Hosted**: push to GitHub and enable Pages (Settings → Pages → Deploy from branch → `main` / root). Once you've opened it, it works offline.

The first sign-in needs internet. After that, the app opens and works offline.

## Files

| File | What it does |
|---|---|
| `index.html` | Layout and icons |
| `styles.css` | Styling, note colours, light/dark |
| `config.js` | Supabase URL, anon key, schema, trash/auto-lock settings |
| `db.js` | IndexedDB storage on the device |
| `vault.js` | Secure-folder encryption (Web Crypto) |
| `sync.js` | Google login, push/pull sync (own and shared notes, share rows), Realtime |
| `app.js` | Screens, editor (text + checklist), multi-select, sharing, tags, colours, secure folder |
| `sw.js`, `manifest.json` | Offline cache and installable app (bump `CACHE` in `sw.js` when you change files) |
| `supabase/schema.sql` | Tables `notesgo.notes`, `notesgo.note_shares`, `notesgo.vaults`; Row Level Security, sharing rules, Realtime |
| `vendor/supabase.js` | Supabase library, bundled so the app works offline |
| `server.js` | Local static server |
