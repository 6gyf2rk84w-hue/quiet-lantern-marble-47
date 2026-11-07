-- Order log: every order the app places, and how it ended (completed, partial or canceled).
-- Feeds the completion rate and finish time shown on each service. Private: only the "panel" function reads it.
-- Safe to run more than once.

create table if not exists public.panel_orders (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  site_id     text not null,
  panel_order text not null,                     -- the panel's own order number
  service     text not null,                     -- the panel's service id
  ref         text,                              -- the app's service (Panels screen) it was ordered through
  stat        text,
  video_id    text,
  qty         integer not null,
  cost        numeric,
  status      text not null default 'pending',   -- pending, in_progress, completed, partial, canceled
  remains     integer,
  start_count integer,
  placed_at   timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  checked_at  timestamptz,
  unique (site_id, panel_order)
);
create index if not exists panel_orders_ref on public.panel_orders (ref, status, finished_at desc);
create index if not exists panel_orders_open on public.panel_orders (user_id, status);
alter table public.panel_orders enable row level security;
revoke all on public.panel_orders from anon, authenticated;
grant select, insert, update, delete on public.panel_orders to service_role;
grant usage, select on sequence public.panel_orders_id_seq to service_role;

-- the panel function also reads the Panels services to look up live prices
grant select on public.orders, public.nodes to service_role;
grant select on public.panel_sites to service_role;
grant select, insert, update, delete on public.panel_keys to service_role;

select 'order log ready' as result;
