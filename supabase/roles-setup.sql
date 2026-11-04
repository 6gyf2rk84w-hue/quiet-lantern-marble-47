-- Panel Tracker roles: Owner, Mod, User, Viewer
-- Paste into Supabase → SQL Editor and press Run. Safe to run more than once.
-- It all runs as one step: if anything fails, nothing changes.
--
--   Owner  (you)  everything; changes roles; approves services; sees everyone's videos
--   Mod           Panels screen: adds and tests services, sees logins; only their own videos
--   User          Orders screen only: their own videos; approved services by name and price
--   Viewer        Orders screen only, look but don't touch
--   Panel websites and main sections: owner only.

-- 1. Clear the old access rules on the app's tables (new ones are added in step 6)
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('nodes','orders','members','creds','videos')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 2. Members can be mod, user or viewer
alter table public.members add column if not exists role text not null default 'viewer';
alter table public.members alter column role type text using role::text;
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.members'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.members drop constraint %I', c);
  end loop;
end $$;
alter table public.members alter column role set default 'viewer';
alter table public.members add constraint members_role_check check (role in ('mod','user','viewer'));

-- 3. Who is signed in: 'owner', 'mod', 'user', 'viewer', or nothing
create or replace function public.app_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then null
    when exists (select 1 from public.admins a where a.user_id = auth.uid()) then 'owner'
    else (select m.role from public.members m where m.user_id = auth.uid() limit 1)
  end
$$;
revoke execute on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated;

-- Owner adds a person by email with a role (the account must already exist in Supabase)
drop function if exists public.add_member(text);
drop function if exists public.add_member(text, text);
create function public.add_member(p_email text, p_role text default 'viewer')
returns text
language plpgsql security definer
set search_path = public
as $$
declare uid uuid;
begin
  if coalesce(public.app_role(), '') <> 'owner' then
    raise exception 'Only the owner can add people';
  end if;
  if p_role is null or p_role not in ('mod','user','viewer') then
    raise exception 'Pick Mod, User or Viewer';
  end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then
    raise exception 'No account with that email. Create it in Supabase first.';
  end if;
  if exists (select 1 from public.admins where user_id = uid) then
    raise exception 'That is the owner account';
  end if;
  insert into public.members (user_id, email, role)
  values (uid, lower(trim(p_email)), p_role)
  on conflict (user_id) do update set role = excluded.role, email = excluded.email;
  return 'ok';
end
$$;
revoke execute on function public.add_member(text, text) from public, anon;
grant execute on function public.add_member(text, text) to authenticated;

-- 4. New columns: owner approval on services; who each video belongs to
alter table public.orders add column if not exists approved boolean not null default false;
alter table public.orders add column if not exists order_id text;
alter table public.orders add column if not exists service_id text;

create table if not exists public.videos (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.videos add column if not exists owner uuid;
alter table public.videos alter column owner set default auth.uid();
update public.videos set owner = (select user_id from public.admins limit 1) where owner is null;
create index if not exists videos_owner_idx on public.videos (owner);

-- 5. Turn the locks on
alter table public.nodes enable row level security;
alter table public.orders enable row level security;
alter table public.members enable row level security;
alter table public.creds enable row level security;
alter table public.videos enable row level security;
grant select, insert, update, delete on public.nodes, public.orders, public.creds, public.videos to authenticated;
grant select, update, delete on public.members to authenticated;
revoke all on public.nodes, public.orders, public.creds, public.videos, public.members from anon;

-- 6. New access rules
-- Panel websites and main sections: owner and mods can see; only the owner can change
create policy "panels: owner and mods read" on public.nodes
  for select to authenticated using (public.app_role() in ('owner','mod'));
create policy "panels: owner adds" on public.nodes
  for insert to authenticated with check (public.app_role() = 'owner');
create policy "panels: owner changes" on public.nodes
  for update to authenticated using (public.app_role() = 'owner') with check (public.app_role() = 'owner');
create policy "panels: owner deletes" on public.nodes
  for delete to authenticated using (public.app_role() = 'owner');

-- Services: owner and mods see and manage them (users never read this table)
create policy "services: owner and mods read" on public.orders
  for select to authenticated using (public.app_role() in ('owner','mod'));
create policy "services: owner and mods add" on public.orders
  for insert to authenticated with check (public.app_role() in ('owner','mod'));
create policy "services: owner and mods change" on public.orders
  for update to authenticated using (public.app_role() in ('owner','mod')) with check (public.app_role() in ('owner','mod'));
create policy "services: owner and mods delete" on public.orders
  for delete to authenticated using (public.app_role() in ('owner','mod'));

-- Login credentials: owner and mods see; only the owner adds, changes or deletes
create policy "logins: owner and mods read" on public.creds
  for select to authenticated using (public.app_role() in ('owner','mod'));
create policy "logins: owner adds" on public.creds
  for insert to authenticated with check (public.app_role() = 'owner');
create policy "logins: owner changes" on public.creds
  for update to authenticated using (public.app_role() = 'owner') with check (public.app_role() = 'owner');
create policy "logins: owner deletes" on public.creds
  for delete to authenticated using (public.app_role() = 'owner');

-- Members: everyone can read their own row; only the owner sees the list and changes roles
create policy "members: own row or owner" on public.members
  for select to authenticated using (user_id = auth.uid() or public.app_role() = 'owner');
create policy "members: owner changes roles" on public.members
  for update to authenticated using (public.app_role() = 'owner') with check (public.app_role() = 'owner');
create policy "members: owner removes" on public.members
  for delete to authenticated using (public.app_role() = 'owner');

-- Videos: the owner sees all; everyone else only their own; viewers can't change anything
create policy "videos: owner or own" on public.videos
  for select to authenticated using (public.app_role() = 'owner' or (owner = auth.uid() and public.app_role() is not null));
create policy "videos: add own" on public.videos
  for insert to authenticated with check (owner = auth.uid() and public.app_role() in ('owner','mod','user'));
create policy "videos: change own" on public.videos
  for update to authenticated
  using (public.app_role() = 'owner' or (owner = auth.uid() and public.app_role() in ('mod','user')))
  with check (public.app_role() = 'owner' or (owner = auth.uid() and public.app_role() in ('mod','user')));
create policy "videos: delete own" on public.videos
  for delete to authenticated
  using (public.app_role() = 'owner' or (owner = auth.uid() and public.app_role() in ('mod','user')));

-- 7. Only the owner can approve a service (mods' changes can't flip it)
create or replace function public.guard_approval()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and coalesce(public.app_role(), '') <> 'owner' then
    if tg_op = 'INSERT' then
      new.approved := false;
    else
      new.approved := old.approved;
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists guard_approval on public.orders;
create trigger guard_approval before insert or update on public.orders
  for each row execute function public.guard_approval();

-- 8. What users can pick from: approved, Working services, by name and price only (no panel)
create or replace function public.service_catalog()
returns table (id text, stat text, name text, price text)
language sql stable security definer
set search_path = public
as $$
  select o.id::text, lower(trim(sec.title)), o.title, o.price::text
  from public.orders o
  join public.nodes site on site.id = o.node
  join public.nodes sec on sec.id = site.parent
  where sec.parent is null
    and o.approved
    and o.status = 'working'
    and public.app_role() in ('owner','mod','user')
  order by o.created_at
$$;
revoke execute on function public.service_catalog() from public, anon;
grant execute on function public.service_catalog() to authenticated;

-- Check: everyone and their role
select email, role from public.members order by role, email;
