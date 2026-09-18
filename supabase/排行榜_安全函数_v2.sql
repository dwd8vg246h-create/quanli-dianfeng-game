-- ============================================================
-- 排行榜安全函数 · 第二版（ql_rank2 / ql_rank_me）
-- ============================================================
-- 为什么要出第二版：
--   第一版 ql_rank 在服务端写死了 order by 政绩 desc limit N，
--   于是页面上的「按位阶 / 按年轻有为」切换，
--   只是在已取回的那 N 条里重新排一遍——
--   **那不是全服排名，只是这一页内部的排序**。
--
--   第二版把排序下推到服务端：
--     · ql_rank2  —— 按指定维度在全量数据上排名，返回真实名次 pos
--                    与全服总数 total_count
--     · ql_rank_me —— 只回答"我排第几"，无需把榜单拉全
--
-- 隐私约定（与第一版一致，未放宽）：
--   · 只吐脱敏字段：工号截断、姓名仅留姓、职务/层次/年龄/政绩
--   · 绝不返回：联系方式、密码哈希、完整存档 data、IP、UA
--   · 尊重退出意愿：summary->>'上榜' = false 的不进入任何榜单
--
-- 兼容：
--   未部署本文件时，客户端自动回落到 ql_rank（第一版），
--   再回落到直读摘要。三条路都活着，不会让榜单整个挂掉。
--
-- 撤销：
--   drop function if exists public.ql_rank2(text, int);
--   drop function if exists public.ql_rank_me(text, text);
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
          /* 四个可选维度：不匹配的分支恒为 null，
             靠 nulls last 让它整体失效，落到下面的兜底排序 */
          case when p_sort = 'merit'
               then coalesce(nullif(b.summary ->> '政绩', '')::int, 0) end desc nulls last,
          case when p_sort = 'young'
               then case when coalesce(nullif(b.summary ->> '年龄','')::int, 0)
                          between 22 and 90
                         then coalesce(nullif(b.summary ->> '年龄','')::int, 0)
                         else 999 end end asc  nulls last,
          case when p_sort = 'rich'
               then coalesce(nullif(b.summary ->> '净资产', '')::int, 0) end desc nulls last,
          case when p_sort = 'clean'
               then coalesce(nullif(b.summary ->> '廉政', '')::int, 0) end desc nulls last,
          /* 兜底：位阶降序 → 政绩降序 */
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
               then case when coalesce(nullif(b.summary ->> '年龄','')::int, 0)
                          between 22 and 90
                         then coalesce(nullif(b.summary ->> '年龄','')::int, 0)
                         else 999 end end asc  nulls last,
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

-- 授权：这是有意的——排行榜本就是公开信息，
-- 但函数体只吐脱敏字段，即便被直接调用也拿不到联系方式。
do $$
begin
  execute 'grant execute on function public.ql_rank2(text, int) to anon';
  execute 'grant execute on function public.ql_rank2(text, int) to authenticated';
  execute 'grant execute on function public.ql_rank_me(text, text) to anon';
  execute 'grant execute on function public.ql_rank_me(text, text) to authenticated';
exception when others then
  raise notice '授权跳过：%', SQLERRM;
end $$;

-- 校验：
--   select * from public.ql_rank2('tier', 20);
--   select * from public.ql_rank_me('你的工号前8位', 'tier');
