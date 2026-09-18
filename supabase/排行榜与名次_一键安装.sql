-- ============================================================
-- 排行榜 + 我的名次 · 一键安装（幂等，可重复执行）
-- 用法：Supabase 后台 → SQL Editor → 全选粘贴 → 点 Run
-- 底部无红字 = 成功
--
-- 什么时候需要跑这个：
--   排行榜能出名单，但「我的名次」一栏显示
--   「暂不可用 / 未部署 / 尚未上榜」——多半是 ql_rank_me 没装上。
--   本脚本同时补 ql_rank2（服务端全量排名）与 ql_rank_me（我只回答"我第几"）。
-- ============================================================

create or replace function public.ql_rank2(
  p_sort  text default 'tier',
  p_limit int  default 100
)
returns table(
  pos          bigint,
  emp_id       text,
  name_masked  text,
  title        text,
  level        text,
  tier         int,
  age          int,
  merit        int,
  wealth       int,
  clean        int,
  ending       text,
  saved_at     timestamptz,
  total_count  bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select s.user_id, s.summary, s.saved_at
    from public.game_saves s
    where s.summary is not null
      and coalesce((s.summary ->> '上榜')::boolean, true) is true
  ),
  ranked as (
    select
      b.user_id,
      b.summary,
      b.saved_at,
      row_number() over (
        order by
          
          case when p_sort = 'merit'
               then coalesce(nullif(b.summary ->> '政绩', '')::int, 0) end desc nulls last,
          case when p_sort = 'young'
               then coalesce(nullif(b.summary ->> '年龄', '')::int, 999) end asc  nulls last,
          case when p_sort = 'rich'
               then coalesce(nullif(b.summary ->> '净资产', '')::int, 0) end desc nulls last,
          case when p_sort = 'clean'
               then coalesce(nullif(b.summary ->> '廉政', '')::int, 0) end desc nulls last,
          
          coalesce(nullif(b.summary ->> '位阶', '')::int, -1) desc,
          coalesce(nullif(b.summary ->> '政绩', '')::int, 0) desc
      )                       as pos,
      count(*) over ()        as total_count
    from base b
  )
  select
    r.pos,
    left(r.user_id::text, 8)                                          as emp_id,
    case
      when coalesce(r.summary ->> '姓名', '') = '' then '匿名干部'
      else left(r.summary ->> '姓名', 1)
           || repeat('*', greatest(1, least(3, length(r.summary ->> '姓名') - 1)))
    end                                                               as name_masked,
    coalesce(r.summary ->> '职务', '')                                as title,
    coalesce(r.summary ->> '层次', '')                                as level,
    coalesce(nullif(r.summary ->> '位阶', '')::int, -1)               as tier,
    coalesce(nullif(r.summary ->> '年龄', '')::int, 0)                as age,
    coalesce(nullif(r.summary ->> '政绩', '')::int, 0)                as merit,
    coalesce(nullif(r.summary ->> '净资产', '')::int, 0)              as wealth,
    coalesce(nullif(r.summary ->> '廉政', '')::int, 0)                as clean,
    coalesce(r.summary ->> '结局', '')                                as ending,
    r.saved_at,
    r.total_count
  from ranked r
  order by r.pos
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
$$;

-- 只回答"我排第几"：不返回任何他人数据

create or replace function public.ql_rank_me(
  p_self text default null,
  p_sort text default 'tier'
)
returns table(
  pos          bigint,
  total_count  bigint,
  avg_tier     numeric,
  end_count    bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select s.user_id, s.summary
    from public.game_saves s
    where s.summary is not null
      and coalesce((s.summary ->> '上榜')::boolean, true) is true
  ),
  ranked as (
    select
      b.user_id,
      row_number() over (
        order by
          case when p_sort = 'merit'
               then coalesce(nullif(b.summary ->> '政绩', '')::int, 0) end desc nulls last,
          case when p_sort = 'young'
               then coalesce(nullif(b.summary ->> '年龄', '')::int, 999) end asc  nulls last,
          case when p_sort = 'rich'
               then coalesce(nullif(b.summary ->> '净资产', '')::int, 0) end desc nulls last,
          case when p_sort = 'clean'
               then coalesce(nullif(b.summary ->> '廉政', '')::int, 0) end desc nulls last,
          coalesce(nullif(b.summary ->> '位阶', '')::int, -1) desc,
          coalesce(nullif(b.summary ->> '政绩', '')::int, 0) desc
      ) as pos
    from base b
  ),
  agg as (
    select
      count(*)                                                          as total_count,
      avg(coalesce(nullif(b.summary ->> '位阶', '')::int, -1))          as avg_tier,
      count(*) filter (where coalesce(b.summary ->> '结局', '') <> '')  as end_count
    from base b
  )
  select
    r.pos,
    a.total_count,
    round(a.avg_tier, 1),
    a.end_count
  from agg a
  left join ranked r
    on r.user_id is not null
   and left(r.user_id::text, 8) = nullif(coalesce(p_self, ''), '')
  limit 1;
$$;


-- 授权：排行榜本就是公开信息，函数体只吐脱敏字段。
do $$
begin
  execute 'grant execute on function public.ql_rank2(text, int) to anon';
  execute 'grant execute on function public.ql_rank2(text, int) to authenticated';
  execute 'grant execute on function public.ql_rank_me(text, text) to anon';
  execute 'grant execute on function public.ql_rank_me(text, text) to authenticated';
exception when others then
  raise notice '授权跳过：%', SQLERRM;
end $$;
