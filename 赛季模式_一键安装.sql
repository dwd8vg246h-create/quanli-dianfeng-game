-- ============================================================
-- 赛季模式 · 一键安装
-- ============================================================
-- 规则（由后台设定，此处为默认）：
--   · 每两个月一个赛季：1-2月=S1，3-4月=S2，… 11-12月=S6
--   · 赛季切换时，旧存档归档为「往季档案」，可回看但不参与新赛季
--   · 赛季榜按「赛季内峰值」计名次：
--       记录本赛季达到过的最高政绩 / 最高位阶，
--       即便后来被查办降级，峰值仍保留
--
-- 隐私约定（与既有榜单一致）：
--   · 只吐脱敏字段，不返回联系方式 / 密码哈希 / 完整存档
--   · 尊重退出意愿：summary->>'上榜' = false 的不进入赛季榜
--
-- 撤销：
--   drop table if exists public.game_season_archive;
--   drop table if exists public.game_season_stats;
--   drop table if exists public.game_seasons;
--   drop function if exists public.ql_rank_season(text, text, int);
--   drop function if exists public.ql_rank_season_me(text, text, text);
-- ============================================================

-- ---------- 1. 赛季表 ----------
create table if not exists public.game_seasons (
  season_key  text primary key,          -- '2026-S5'
  seq         int  not null,             -- 第几季（1 起）
  started_at  timestamptz not null,
  ends_at     timestamptz not null,
  status      text not null default 'active',   -- active / closed
  note        text default ''
);

-- ---------- 2. 赛季成绩（峰值 + 终值）----------
create table if not exists public.game_season_stats (
  season_key  text not null,
  user_id     uuid not null,
  peak_merit  int  not null default 0,   -- 赛季内最高政绩
  peak_tier   int  not null default 0,   -- 赛季内最高位阶
  peak_title  text not null default '',  -- 峰值时的职务名
  final_merit int  not null default 0,   -- 赛季末快照
  final_tier  int  not null default 0,
  final_title text not null default '',
  ending      text not null default '',  -- 赛季内最终结局
  months      int  not null default 0,   -- 赛季内经历月数
  updated_at  timestamptz not null default now(),
  primary key (season_key, user_id)
);
create index if not exists idx_season_stats on public.game_season_stats(season_key);

-- ---------- 3. 往季档案（赛季切换时归档的整份存档，供回看）----------
create table if not exists public.game_season_archive (
  season_key  text not null,
  user_id     uuid not null,
  data        jsonb not null,
  summary     jsonb not null default '{}'::jsonb,
  archived_at timestamptz not null default now(),
  primary key (season_key, user_id)
);
create index if not exists idx_season_archive on public.game_season_archive(season_key);

-- ---------- 4. 权限 ----------
-- 与既有榜单一致：赛季信息本就是公开的，
-- 但函数体只吐脱敏字段，即便被直接调用也拿不到联系方式。
do $$
begin
  execute 'revoke all on public.game_seasons from anon, authenticated';
  execute 'grant select on public.game_seasons to anon';
  execute 'revoke all on public.game_season_stats from anon, authenticated';
  execute 'grant select, insert, update on public.game_season_stats to anon';
  execute 'revoke all on public.game_season_archive from anon, authenticated';
  execute 'grant select, insert on public.game_season_archive to anon';
exception when others then
  raise notice '授权跳过：%', SQLERRM;
end $$;

alter table public.game_seasons       enable row level security;
alter table public.game_season_stats  enable row level security;
alter table public.game_season_archive enable row level security;

drop policy if exists "seasons_read" on public.game_seasons;
create policy "seasons_read" on public.game_seasons
  for select to anon, authenticated using (true);

drop policy if exists "season_stats_all" on public.game_season_stats;
create policy "season_stats_all" on public.game_season_stats
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "season_arch_all" on public.game_season_archive;
create policy "season_arch_all" on public.game_season_archive
  for all to anon, authenticated using (true) with check (true);

-- ---------- 5. 赛季榜：按指定赛季 + 维度排名 ----------
create or replace function public.ql_rank_season(
  p_season text default null,
  p_sort   text default 'merit',
  p_limit  int  default 100
)
returns table(
  pos          bigint,
  emp_id       text,
  name_masked  text,
  title        text,
  level        text,
  tier         int,
  merit        int,
  peak_merit   int,
  peak_tier    int,
  months       int,
  ending       text,
  updated_at   timestamptz,
  total_count  bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with cur as (
    select coalesce(p_season, (select season_key from public.game_seasons
                               order by seq desc limit 1)) as k
  ),
  base as (
    select st.*, s.summary
    from public.game_season_stats st
    join cur on st.season_key = cur.k
    left join public.game_saves s on s.user_id = st.user_id
    where coalesce((s.summary ->> '上榜')::boolean, true) is true
  ),
  ranked as (
    select
      b.*,
      row_number() over (
        order by
          case when p_sort = 'merit'
               then b.peak_merit end desc nulls last,
          case when p_sort = 'tier'
               then b.peak_tier end desc nulls last,
          case when p_sort = 'months'
               then b.months end desc nulls last,
          case when p_sort = 'final'
               then b.final_merit end desc nulls last,
          /* 兜底：峰值位阶 → 峰值政绩 */
          b.peak_tier desc,
          b.peak_merit desc
      )                       as pos,
      count(*) over ()        as total_count
    from base b
  )
  select
    r.pos,
    left(r.user_id::text, 8),
    case
      when coalesce(r.summary ->> '姓名', '') = '' then '匿名干部'
      else left(r.summary ->> '姓名', 1)
           || repeat('*', greatest(1, least(3, length(r.summary ->> '姓名') - 1)))
    end,
    coalesce(r.peak_title, ''),
    coalesce(r.summary ->> '层次', ''),
    r.peak_tier,
    r.peak_merit,
    r.peak_merit,
    r.peak_tier,
    r.months,
    coalesce(r.ending, ''),
    r.updated_at,
    r.total_count
  from ranked r
  order by r.pos
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
$$;

-- 只回答"我本赛季排第几"
create or replace function public.ql_rank_season_me(
  p_self   text default null,
  p_season text default null,
  p_sort   text default 'merit'
)
returns table(
  pos         bigint,
  total_count bigint,
  peak_merit  int,
  peak_tier   int
)
language sql
security definer
set search_path = public
stable
as $$
  with cur as (
    select coalesce(p_season, (select season_key from public.game_seasons
                               order by seq desc limit 1)) as k
  ),
  base as (
    select st.*
    from public.game_season_stats st
    join cur on st.season_key = cur.k
  ),
  ranked as (
    select
      b.user_id,
      b.peak_merit,
      b.peak_tier,
      row_number() over (
        order by
          case when p_sort = 'merit' then b.peak_merit end desc nulls last,
          case when p_sort = 'tier'  then b.peak_tier  end desc nulls last,
          case when p_sort = 'months' then b.months    end desc nulls last,
          case when p_sort = 'final' then b.final_merit end desc nulls last,
          b.peak_tier desc,
          b.peak_merit desc
      ) as pos
    from base b
  )
  select
    r.pos,
    (select count(*) from base),
    r.peak_merit,
    r.peak_tier
  from ranked r
  where left(r.user_id::text, 8) = nullif(coalesce(p_self, ''), '')
  limit 1;
$$;

do $$
begin
  execute 'grant execute on function public.ql_rank_season(text, text, int) to anon';
  execute 'grant execute on function public.ql_rank_season(text, text, int) to authenticated';
  execute 'grant execute on function public.ql_rank_season_me(text, text, text) to anon';
  execute 'grant execute on function public.ql_rank_season_me(text, text, text) to authenticated';
exception when others then
  raise notice '授权跳过：%', SQLERRM;
end $$;

-- ---------- 6. 预置赛季（当前季 + 上一季，便于立即验证）----------
-- 赛季号：seq = (年-2026)*6 + floor((月-1)/2) + 1
insert into public.game_seasons(season_key, seq, started_at, ends_at, status, note)
values
  ('2026-S5', 5, '2026-09-01 00:00:00+08', '2026-10-31 23:59:59+08', 'active', '双月赛季'),
  ('2026-S6', 6, '2026-11-01 00:00:00+08', '2026-12-31 23:59:59+08', 'active', '双月赛季')
on conflict (season_key) do nothing;

-- 校验：
--   select * from public.game_seasons order by seq;
--   select * from public.ql_rank_season('2026-S5','merit',20);
--   select * from public.ql_rank_season_me('工号前8位','2026-S5','merit');
