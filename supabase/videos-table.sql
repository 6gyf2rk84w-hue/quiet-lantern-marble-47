-- Orders Tracker: one table for the video cards, shared by everyone on the app.
-- Viewers can read it; you and your mods can add, change and delete.
create table if not exists public.videos (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.videos enable row level security;

drop policy if exists "videos read" on public.videos;
drop policy if exists "videos add" on public.videos;
drop policy if exists "videos change" on public.videos;
drop policy if exists "videos delete" on public.videos;

create policy "videos read" on public.videos for select using (public.is_admin() or public.is_member());
create policy "videos add" on public.videos for insert with check (public.is_editor());
create policy "videos change" on public.videos for update using (public.is_editor()) with check (public.is_editor());
create policy "videos delete" on public.videos for delete using (public.is_editor());
