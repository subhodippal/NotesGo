# NotesGo

A mobile-first notes and checklist web app in plain HTML, CSS and JavaScript. It has no build step and nothing to install. It works offline, syncs on its own through Supabase, and you sign in with Google.

It uses the **same Supabase project as myExpenses**, with its own schema (`notesgo`), so the two apps' tables never mix.

## Features

The look follows **myExpenses**: purple gradient header, glass buttons, cards, bottom sheets and a gradient selection bar, in **light and dark** mode. Tap ☀️/🌙 in the header to switch; the side menu also offers *System*.

- **Side menu** (☰ at the top left): My Notes, Shared, Secure folder, Archive, Trash, and your tags. *Edit* renames or deletes a tag everywhere. Sign out is at the bottom.
- **Create** (the **+ New** button opens a bottom sheet): Note, Checklist or Secure note.
- **Text and checkboxes in one note**: tap the ☑ button in the editor's bottom bar to turn the line you're on into a checkbox, or a checkbox back into text. You can mix them in any order, for example text, then a list, then more text. In a list, Enter adds the next checkbox; Enter on an empty checkbox, or Backspace at the start of one, goes back to plain text. Pasted lines become separate checkboxes. Tick items in the editor or right on the card. *Checklist* in the + New sheet starts a note with a checkbox ready.
- **Tables** (spreadsheet-style): *Table* in the + New sheet, or **⊞ Insert → Table** in the editor's bottom bar to put a table after the line you're on. The first row is the header. Type in the cells; **Enter** moves down a row (and adds one at the bottom), Shift+Enter starts a new line in a cell. **+ Row** and **+ Column** sit under the table, and **⋯** inserts a row above or a column to the left, deletes a row or column, sorts by the column you're in (A→Z or Z→A, numbers in number order, header stays on top), or deletes the table. Cards show a preview; search finds words inside cells.
- **Text style** (the **Tт** button in the editor's bottom bar shows the formatting bar): select words, then tap **B** bold, *I* italic, U underline, S strikethrough, size **M** (normal) / **L** / **XL**, or a text colour (red, orange, green, blue, purple, pink, or back to default). Handy for headings: XL + bold + a colour. Colours adjust for dark mode. Pasted text comes in plain.
- **Sections** (**⊞ Insert → Section**): a heading that folds away everything below it, up to the next section. Tap the ⌄ arrow to collapse or expand it; the state is saved, and cards show collapsed sections folded too. Backspace in an empty section title or ✕ removes the section (its content stays).
- **Table colour**: the 🎨 button under a table (or ⋯ → *Table colour*) picks one of the 12 note colours for that table; the header row gets a slightly darker shade.
- **Auto-calculate** (calculator button in the editor's bottom bar, on by default; tap to turn off/on, remembered on this device):
  - End a sum with `=` and the answer is suggested: `45 + 30 + 10 =` → **85**. Works with + − × (or `*`, `x`) ÷ (or `/`), brackets and `%` (`200 * 10%` → 20).
  - Write amounts on lines that start with `+` or `-` (`+500 received`, `-200 train ticket`, `-100 food`). On the empty line below, a total is suggested: a `--------------` line and `+200 in total`. A currency sign after the +/− (₹ $ € £ ¥) is kept.
  - Tap the suggestion chip (or press Tab on a keyboard) to add it. Ignore it and it goes away as you keep typing.
- **Hidden text** (passwords, PINs): select the words, then tap the 👁 (eye-off) button in the editor's bottom bar. They show as `••••••` with an eye to reveal them; when shown, a copy button copies them. To show them as normal text again, select them (or put the cursor right next to them) and tap the bottom eye button again. Cards always show dots. *This only hides the text on screen — for real secrets, put the note in the Secure folder, which encrypts it.*
- **Divider line**: **⊞ Insert → Divider line** adds a horizontal line. ✕ next to it, or Backspace at the start of the line below, removes it.
- **Pin**, **tags** and **background colour** (12 colours, each with a dark-mode version), from the editor.
- **Filter chips**: All · Pinned · Notes · Checklists. **Search** looks in titles, text, checklist items and tags. **List/grid** layout toggle.
- **Multi-select**: long-press a note, or tap the ☑ button, to show checkboxes. The bottom bar then offers **Pin, Secure, Share, Delete** and **More** (colour, add tag, archive, make copies). *Select all* is in the bar. In Trash the bar offers *Restore* and *Delete*; in the Secure folder, *Move out*.
- **Share with someone**: share by Google email with **Can view** or **Can edit** access, from the editor (👤+), from the ⋯ menu, or for several notes at once from the selection bar.
  - The person sees the note under *My Notes* and *Shared*, marked with the owner's name, after signing in to NotesGo with that email. With edit access they can change the title, text and checklist. Pin, colour, tags, archive and delete stay with the owner; the database enforces this too (`guard_shared_edit`).
  - You can change someone's access or remove them in the share sheet. They can also *Remove from my notes* themselves.
  - Secure notes can't be shared. Moving a shared note into the Secure folder asks first, then stops the sharing.
- **Secure folder** 🔒: the title, text, checklist and tags are **encrypted on the device** (AES-256-GCM, with the key derived from your password by PBKDF2-SHA256 at 310,000 iterations). Supabase stores only the ciphertext.
  - The folder locks when you leave it, when you tap *Lock*, and after 60 s in the background (`AUTO_LOCK_SECONDS`). After 5 wrong tries, each new attempt has to wait longer.
  - Change the password from the account sheet (tap your avatar).
  - **Forgot it?** Tap *Forgot password?* on the unlock sheet → **Request password reset**. You get an email with a reset code and a reset link. Enter the code, or tap the link (open it in the same browser), and *Set new password* opens. Choose a new password.
    - Folders set up (or unlocked once) since email reset was added keep their notes; they're re-encrypted with the new password.
    - Older folders have no recovery copy, so their notes can't be decrypted by anyone. The reset warns you, asks you to tick *I understand*, deletes those notes and starts the folder fresh. Email reset then works for the new folder.
    - How: the folder key is also stored wrapped with a random *recovery key*. The server keeps that recovery key in a locked table and only hands it to a session that verified the email code or link in the last 15 minutes (`notesgo.get_vault_recovery`). Someone with only your phone or Google session can't use it. Trade-off: whoever controls your email **and** account can reset it, and the Supabase project owner (you) could technically decrypt with the stored recovery data.
  - Setting up, changing or resetting the password needs internet. Unlocking and editing work offline.
- **Archive**: keep old notes aside, out of My Notes. **Trash**: deleted notes stay for 1 month (30 days, `TRASH_DAYS`), then are deleted for good. *Undo* after delete or archive.
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
5. **Email codes for "Forgot password?"** (Secure folder):
   - Authentication → Sign In / Providers → **Email**: enabled.
   - Authentication → Emails → **Magic Link** template: add the code, for example `Your NotesGo code: {{ .Token }}`. This template is shared with myExpenses (same project). Adding a line for the code doesn't change how its links work.
   - Supabase's built-in mailer is limited to a few emails per hour, and on new projects it only sends to the project's team members. To send codes to friends you've shared the app with, add custom SMTP (Authentication → Emails → SMTP Settings), for example Gmail SMTP, Resend or Brevo.

## Run it

- **Locally**: `node server.js` → http://localhost:3000. Google sign-in needs http(s); it doesn't work from `file://`.
- **Hosted**: push to GitHub and enable Pages (Settings → Pages → Deploy from branch → `main` / root). Once you've opened it, it works offline.

The first sign-in needs internet. After that, the app opens and works offline.

## Files

| File | What it does |
|---|---|
| `index.html` | Layout and icons |
| `styles.css` | Styling, note colours, light/dark |
| `config.js` | Supabase URL, anon key, schema, trash (30 days)/auto-lock settings |
| `db.js` | IndexedDB storage on the device |
| `vault.js` | Secure-folder encryption (Web Crypto) |
| `sync.js` | Google login, push/pull sync (own and shared notes, share rows), Realtime |
| `app.js` | Screens, editor (text + checklist), multi-select, sharing, tags, colours, secure folder |
| `sw.js`, `manifest.json` | Offline cache and installable app (bump `CACHE` in `sw.js` when you change files) |
| `supabase/schema.sql` | Tables `notesgo.notes`, `notesgo.note_shares`, `notesgo.vaults`; Row Level Security, sharing rules, Realtime |
| `vendor/supabase.js` | Supabase library, bundled so the app works offline |
| `server.js` | Local static server |
