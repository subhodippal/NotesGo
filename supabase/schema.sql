-- NotesGo — Supabase schema (schema "notesgo" in the same project/OneDB as myExpenses)
-- 1. Run this file in Supabase Dashboard → SQL Editor. Safe to re-run (also upgrades older versions).
-- 2. Add "notesgo" under Project Settings → Data API → Exposed schemas (keep "myexpenses" there too).
-- 3. Authentication → URL Configuration → Redirect URLs: add the URL(s) NotesGo is served from,
--    e.g. https://<user>.github.io/NotesGo/ and http://localhost:3000/
-- 4. Secure folder "Forgot password?" (email code):
--    - Authentication → Sign In / Providers → Email: enabled.
--    - Authentication → Emails → "Magic Link" template: include the code, e.g.  Your NotesGo code: {{ .Token }}
--    - Supabase's built-in mailer only sends a few emails per hour (and on new projects only to
--      the project's team members). For other people, set up custom SMTP under Authentication → Emails.

create schema if not exists notesgo;
grant usage on schema notesgo to anon, authenticated, service_role;

-- Own copy of the updated_at trigger, so this schema doesn't depend on any other app.
create or replace function notesgo.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Notes
--   kind = 'text' (content) or 'checklist' (items: [{id, text, done}] checkboxes, mixed with
--   [{id, type: 'text', text}] paragraphs, in order).
--   Secure-folder notes have secure = true: title, content, items and tags are blank on the
--   server and the real data is in `cipher` (AES-GCM, encrypted on the device with a key
--   derived from the secure-folder password). The server never sees the password or key.
-- ---------------------------------------------------------------------------
create table if not exists notesgo.notes (
  id          uuid primary key,                     -- generated on the client so offline notes keep their id
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade, -- owner
  kind        text not null default 'text' check (kind in ('text', 'checklist')),
  title       text not null default '',
  content     text not null default '',
  items       jsonb not null default '[]'::jsonb,
  tags        text[] not null default '{}',
  color       text not null default 'default',
  pinned      boolean not null default false,
  archived    boolean not null default false,
  trashed     boolean not null default false,
  trashed_at  timestamptz,
  secure      boolean not null default false,
  cipher      text not null default '',             -- "v1.<keyId>.<iv>.<ciphertext>" (base64) for secure notes
  edited_by   text not null default '',             -- name of whoever edited last (shown on shared notes)
  edited_at   timestamptz not null default now(),   -- last edit on a device (used for sorting)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),   -- set by the server; sync cursor
  deleted     boolean not null default false         -- deleted forever (tombstone so other devices remove it)
);

-- Upgrades for tables created by an earlier version of this file.
alter table notesgo.notes add column if not exists kind text not null default 'text' check (kind in ('text', 'checklist'));
alter table notesgo.notes add column if not exists items jsonb not null default '[]'::jsonb;
alter table notesgo.notes add column if not exists edited_by text not null default '';

create index if not exists notes_user_updated_at_idx on notesgo.notes (user_id, updated_at);
create index if not exists notes_updated_at_idx on notesgo.notes (updated_at);

drop trigger if exists notes_touch_updated_at on notesgo.notes;
create trigger notes_touch_updated_at
  before insert or update on notesgo.notes
  for each row execute function notesgo.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Sharing: a note shared with someone by their Google email.
--   view → can read the note;  edit → can also change its title, text and checklist.
-- ---------------------------------------------------------------------------
create table if not exists notesgo.note_shares (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade, -- note owner
  note_id     uuid not null references notesgo.notes (id) on delete cascade,
  email       text not null check (email = lower(email) and position('@' in email) > 1),
  role        text not null default 'view' check (role in ('view', 'edit')),
  owner_name  text not null default '',            -- shown to the friend as "Shared by …"
  owner_email text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false        -- soft delete = access removed (friends' devices learn about it)
);

create unique index if not exists note_shares_note_email_idx on notesgo.note_shares (note_id, email);
create index if not exists note_shares_email_idx on notesgo.note_shares (email);
create index if not exists note_shares_updated_at_idx on notesgo.note_shares (updated_at);

drop trigger if exists note_shares_touch_updated_at on notesgo.note_shares;
create trigger note_shares_touch_updated_at
  before insert or update on notesgo.note_shares
  for each row execute function notesgo.touch_updated_at();

-- The current user's access to a note: 'owner', 'edit', 'view' or null.
-- SECURITY DEFINER so the policies can call it without recursing through each other's RLS.
create or replace function notesgo.note_role(p_note uuid)
returns text language sql stable security definer set search_path = notesgo as $$
  select case
    when exists (select 1 from notesgo.notes n where n.id = p_note and n.user_id = auth.uid()) then 'owner'
    else (
      select s.role from notesgo.note_shares s
      join notesgo.notes n on n.id = s.note_id
      where s.note_id = p_note and s.email = lower(auth.jwt() ->> 'email') and not s.deleted and not n.secure
      limit 1
    )
  end
$$;

-- People a note is shared with may only change its text; everything else stays the owner's.
create or replace function notesgo.guard_shared_edit()
returns trigger language plpgsql as $$
begin
  if auth.uid() is distinct from old.user_id then
    new.user_id    := old.user_id;
    new.tags       := old.tags;
    new.color      := old.color;
    new.pinned     := old.pinned;
    new.archived   := old.archived;
    new.trashed    := old.trashed;
    new.trashed_at := old.trashed_at;
    new.secure     := old.secure;
    new.cipher     := old.cipher;
    new.deleted    := old.deleted;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

drop trigger if exists notes_guard_shared_edit on notesgo.notes;
create trigger notes_guard_shared_edit
  before update on notesgo.notes
  for each row execute function notesgo.guard_shared_edit();

-- A friend can remove a note that was shared with them from their own list.
create or replace function notesgo.leave_share(p_note uuid)
returns void language sql security definer set search_path = notesgo as $$
  update notesgo.note_shares set deleted = true
  where note_id = p_note and email = lower(auth.jwt() ->> 'email');
$$;

-- ---------------------------------------------------------------------------
-- Secure folder settings (one row per user). Holds only the PBKDF2 salt and an
-- encrypted check value used to verify the password — never the password itself.
-- ---------------------------------------------------------------------------
create table if not exists notesgo.vaults (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  salt        text not null,
  iterations  integer not null check (iterations >= 100000),
  check_value text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table notesgo.vaults add column if not exists recovery_wrap text not null default ''; -- vault key wrapped with the recovery key

-- Email recovery for the Secure folder ("Forgot password?").
-- The recovery key lives here, in a table nobody can read directly (RLS on, no policies).
-- get_vault_recovery() hands it out only to a session that verified an email code in the
-- last 15 minutes, so a stolen Google session alone isn't enough to reset the password.
create table if not exists notesgo.vault_recovery (
  user_id     uuid primary key references notesgo.vaults (user_id) on delete cascade,
  rkey        text not null,
  updated_at  timestamptz not null default now()
);
alter table notesgo.vault_recovery enable row level security;
revoke all on notesgo.vault_recovery from anon, authenticated;

create or replace function notesgo.save_vault_recovery(p_rkey text, p_wrap text)
returns void language plpgsql security definer set search_path = notesgo as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update notesgo.vaults set recovery_wrap = p_wrap where user_id = auth.uid();
  if not found then raise exception 'no secure folder'; end if;
  insert into notesgo.vault_recovery (user_id, rkey) values (auth.uid(), p_rkey)
  on conflict (user_id) do update set rkey = excluded.rkey, updated_at = now();
end $$;

create or replace function notesgo.get_vault_recovery()
returns text language plpgsql stable security definer set search_path = notesgo as $$
declare k text;
begin
  if not exists (
    select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
    where a ->> 'method' in ('otp', 'magiclink', 'email/signup')
      and (a ->> 'timestamp')::bigint > extract(epoch from now())::bigint - 900
  ) then
    raise exception 'verify-email-first' using errcode = '42501';
  end if;
  select rkey into k from notesgo.vault_recovery where user_id = auth.uid();
  return k;
end $$;

drop trigger if exists vaults_touch_updated_at on notesgo.vaults;
create trigger vaults_touch_updated_at
  before insert or update on notesgo.vaults
  for each row execute function notesgo.touch_updated_at();

grant select, insert, update, delete on all tables in schema notesgo to authenticated, service_role;
revoke all on notesgo.vault_recovery from anon, authenticated; -- only through the functions above

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table notesgo.notes enable row level security;
alter table notesgo.note_shares enable row level security;
alter table notesgo.vaults enable row level security;

drop policy if exists "notes_own" on notesgo.notes;

drop policy if exists "notes_select" on notesgo.notes;
create policy "notes_select" on notesgo.notes
  for select using (auth.uid() = user_id or notesgo.note_role(id) in ('view', 'edit'));

drop policy if exists "notes_insert" on notesgo.notes;
create policy "notes_insert" on notesgo.notes
  for insert with check (auth.uid() = user_id);

drop policy if exists "notes_update" on notesgo.notes;
create policy "notes_update" on notesgo.notes
  for update using (auth.uid() = user_id or notesgo.note_role(id) = 'edit')
  with check (auth.uid() = user_id or notesgo.note_role(id) = 'edit');

drop policy if exists "notes_delete" on notesgo.notes;
create policy "notes_delete" on notesgo.notes
  for delete using (auth.uid() = user_id);

-- Shares: the note owner manages them; the friend can see their own share rows.
drop policy if exists "note_shares_select" on notesgo.note_shares;
create policy "note_shares_select" on notesgo.note_shares
  for select using (auth.uid() = user_id or email = lower(auth.jwt() ->> 'email'));

drop policy if exists "note_shares_insert" on notesgo.note_shares;
create policy "note_shares_insert" on notesgo.note_shares
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from notesgo.notes n where n.id = note_id and n.user_id = auth.uid() and not n.secure)
  );

drop policy if exists "note_shares_update" on notesgo.note_shares;
create policy "note_shares_update" on notesgo.note_shares
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and exists (select 1 from notesgo.notes n where n.id = note_id and n.user_id = auth.uid())
  );

drop policy if exists "note_shares_delete" on notesgo.note_shares;
create policy "note_shares_delete" on notesgo.note_shares
  for delete using (auth.uid() = user_id);

drop policy if exists "vaults_own" on notesgo.vaults;
create policy "vaults_own" on notesgo.vaults
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Functions are callable by signed-in users only.
revoke execute on all functions in schema notesgo from public, anon;
grant execute on all functions in schema notesgo to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime: lets other open devices (and friends) sync right away when a note changes.
-- Optional — without it the app still syncs on every change, on focus and every minute.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['notes', 'note_shares'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'notesgo' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table notesgo.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Make the API see new tables/functions right away.
notify pgrst, 'reload schema';
