-- Goals that learn: your past videos (kept private) + a combined-numbers function for the app.
-- Paste into Supabase → SQL Editor and press Run. Safe to run more than once.

-- 1. Past videos the goals learn from. Locked: nobody's app can read this table.
create table if not exists public.past_videos (
  id text primary key,
  month text not null,
  posted_at timestamptz,
  code text,
  link text,
  title text,
  real jsonb not null default '{}'::jsonb,
  goals jsonb,
  added_at timestamptz not null default now()
);
alter table public.past_videos enable row level security;
revoke all on public.past_videos from anon, authenticated;

-- Your past videos are added by the private copy of this file (not kept on GitHub).

-- 2. What the app gets: month totals only (videos, views, likes...) and how views spread across a month.
--    Nobody's videos, links or names. Videos in the app replace a past video of the same post.
create or replace function public.engine_num(t text)
returns numeric language sql immutable
as $$ select case when t ~ '^[0-9]+(\.[0-9]+)?$' then t::numeric end $$;

create or replace function public.engine_data()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  with app as (
    select v.data->>'month' as m,
           substring(v.data->>'link' from '/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)') as code,
           v.data->'real' as r
    from public.videos v
  ), old as (
    select p.month as m, p.code, p.real as r from public.past_videos p
    where p.code is null or not exists (select 1 from app where app.code = p.code)
  ), allv as (
    select x.m,
           public.engine_num(x.r->>'views') as views,
           public.engine_num(x.r->>'likes') as likes,
           public.engine_num(x.r->>'shares') as shares,
           public.engine_num(x.r->>'saves') as saves,
           public.engine_num(x.r->>'reposts') as reposts,
           public.engine_num(x.r->>'comments') as comments
    from (select m, r from app union all select m, r from old) x
    where x.m ~ '^[0-9]{4}-[0-9]{2}$'
  ), ok as (
    select * from allv where views > 0
  ), mon as (
    select m, count(*) as n, sum(views) as views, avg(views) as av,
      sum(likes) as likes,       sum(views) filter (where likes is not null) as likes_v,
      sum(shares) as shares,     sum(views) filter (where shares is not null) as shares_v,
      sum(saves) as saves,       sum(views) filter (where saves is not null) as saves_v,
      sum(reposts) as reposts,   sum(views) filter (where reposts is not null) as reposts_v,
      sum(comments) as comments, sum(views) filter (where comments is not null) as comments_v
    from ok group by m
  )
  select case when coalesce(public.app_role(), '') in ('owner','mod','user') then
    jsonb_build_object('months', coalesce(jsonb_object_agg(mon.m, jsonb_build_object(
      'n', mon.n, 'views', mon.views,
      'likes', coalesce(mon.likes, 0), 'likes_v', coalesce(mon.likes_v, 0),
      'shares', coalesce(mon.shares, 0), 'shares_v', coalesce(mon.shares_v, 0),
      'saves', coalesce(mon.saves, 0), 'saves_v', coalesce(mon.saves_v, 0),
      'reposts', coalesce(mon.reposts, 0), 'reposts_v', coalesce(mon.reposts_v, 0),
      'comments', coalesce(mon.comments, 0), 'comments_v', coalesce(mon.comments_v, 0),
      'spread', case when mon.n >= 2
        then (select jsonb_agg(round(ok.views / mon.av, 3) order by ok.views) from ok where ok.m = mon.m)
        else '[]'::jsonb end)), '{}'::jsonb))
  end
  from mon
$$;
revoke execute on function public.engine_data() from public, anon;
grant execute on function public.engine_data() to authenticated;

-- Check: your past videos by month
select month, count(*) as videos from public.past_videos group by month order by month;
