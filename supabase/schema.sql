-- Job Agent · database schema for Supabase
-- Run once: Supabase dashboard → SQL Editor → New query → paste → Run.
-- One generic table of JSON documents, grouped by "collection" (jobs, settings, courses ...).
-- Every row belongs to one user (owner). Row Level Security makes sure each user
-- can read and write only their own rows. Nobody else (including the site owner
-- using the public key) can see another user's data.

create table if not exists public.docs (
  owner       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  version     integer     not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (owner, collection, id)
);

alter table public.docs enable row level security;

drop policy if exists "own rows: select" on public.docs;
drop policy if exists "own rows: insert" on public.docs;
drop policy if exists "own rows: update" on public.docs;
drop policy if exists "own rows: delete" on public.docs;
create policy "own rows: select" on public.docs for select using (owner = auth.uid());
create policy "own rows: insert" on public.docs for insert with check (owner = auth.uid());
create policy "own rows: update" on public.docs for update using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own rows: delete" on public.docs for delete using (owner = auth.uid());

-- version + updated_at on every change
create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then new.version := old.version + 1; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.docs_touch();

-- merge a patch into a document (creates it if missing). Runs as the calling user, so RLS applies.
create or replace function public.doc_merge(p_collection text, p_id text, p_patch jsonb)
returns void language sql security invoker as $$
  insert into public.docs(owner, collection, id, data)
  values (auth.uid(), p_collection, p_id, p_patch)
  on conflict (owner, collection, id)
  do update set data = public.docs.data || excluded.data;
$$;

-- live updates for the page
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
