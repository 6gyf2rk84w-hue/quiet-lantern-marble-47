-- Panel Tracker: Instagram connection + auto-log
-- Run this when we switch Instagram on (after the Meta app is made). Safe to run more than once.
-- People connect with Facebook sign-in; their Instagram professional account must be linked to a Facebook Page.

-- 1. Saved Instagram connections. Tokens are encrypted by the function.
--    Locked: nobody's app can read or change this table; only the instagram function can.
create table if not exists public.ig_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ig_user_id text,
  page_id text,
  username text,
  token text not null,
  expires_at timestamptz,
  status text not null default 'ok',
  connected_at timestamptz default now(),
  refreshed_at timestamptz default now(),
  checked_at timestamptz
);
alter table public.ig_accounts add column if not exists page_id text;
alter table public.ig_accounts enable row level security;
revoke all on public.ig_accounts from anon, authenticated;

-- One-time codes used while someone is on Facebook's sign-in screen (also locked)
create table if not exists public.ig_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.ig_states enable row level security;
revoke all on public.ig_states from anon, authenticated;

-- 2. What the app may know: your own @username and whether it still works (never the token)
create or replace function public.instagram_status()
returns table (username text, status text)
language sql stable security definer
set search_path = public
as $$
  select a.username, a.status from public.ig_accounts a where a.user_id = auth.uid()
$$;
revoke execute on function public.instagram_status() from public, anon;
grant execute on function public.instagram_status() to authenticated;

-- 3. Check everyone's new posts every 15 minutes (auto-log works even when the app is closed)
--    Replace PASTE-CRON-SECRET-HERE with the same CRON_SECRET you saved in the function's secrets.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'instagram-auto-log';
select cron.schedule(
  'instagram-auto-log',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := 'https://ttnvbmqtyxbqfyxadjdf.supabase.co/functions/v1/instagram',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE-CRON-SECRET-HERE'),
    body := '{"action":"sync"}'::jsonb
  );
  $job$
);
