-- Panels setup: the list of panels people can connect, and each person's own panel keys.
-- Both tables are private: the app's phone code can't read them; only the "panel" function can.
-- Safe to run more than once.

create table if not exists public.panel_sites (
  id         text primary key,                 -- short id, also the secret name prefix (id ABC -> ABC_KEY)
  name       text not null,                    -- name shown in Connections
  domain     text not null,                    -- website, without https://
  api_url    text not null,                    -- the panel's API address
  signup_url text,                             -- "make an account" link
  key_url    text,                             -- page where the API key is made
  active     boolean not null default true,
  sort       int not null default 0
);
alter table public.panel_sites enable row level security;
revoke all on public.panel_sites from anon, authenticated;

create table if not exists public.panel_keys (
  user_id    uuid not null references auth.users(id) on delete cascade,
  site_id    text not null references public.panel_sites(id) on delete cascade,
  api_key    text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, site_id)
);
alter table public.panel_keys enable row level security;
revoke all on public.panel_keys from anon, authenticated;

-- Add panels with rows like this (your private copy of this file has yours filled in):
-- insert into public.panel_sites (id, name, domain, api_url, signup_url, key_url, sort) values
--   ('example', 'Example', 'example.com', 'https://example.com/api/v2', 'https://example.com/signup', 'https://example.com/account', 1)
-- on conflict (id) do update set name = excluded.name, domain = excluded.domain, api_url = excluded.api_url,
--   signup_url = excluded.signup_url, key_url = excluded.key_url, sort = excluded.sort;

select 'panels ready' as result, (select count(*) from public.panel_sites) as panels;
