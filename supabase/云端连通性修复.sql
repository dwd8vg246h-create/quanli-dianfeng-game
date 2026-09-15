-- ============================================================
-- 云端连通性体检 + 一键修复
-- Supabase → SQL Editor → 全选 → Run
-- ------------------------------------------------------------
-- 症状：游戏里注册 / 登录 / 云存档 / 排行榜全线失败，
--       接口一律返回 403 policy_default_denied。
--
-- 含义：PostgREST 收到了请求，但行级安全（RLS）拦下了它 ——
--       表上启用了 RLS，却没有一条策略允许匿名角色通过。
--       注意：连「不读任何表」的 ql_ping() 也被拦，
--       说明卡点在权限层，不在具体数据。
--
-- 本脚本做三件事：体检 → 修权限 → 自检。
-- 只改权限，不动数据。附【还原】段。
-- ============================================================


-- ============================================================
-- 第 1 步：体检（只看结果，不改任何东西）
-- ============================================================

-- 1.1 两张表的 RLS 开关状态
--     relrowsecurity = t 表示 RLS 已启用（启用后必须有 policy 才能访问）
select relname                        as 表名,
       relrowsecurity                 as 已启用RLS,
       relforcerowsecurity            as 强制RLS
from pg_class
where relname in ('game_users', 'game_saves');

-- 1.2 现有策略（若为空，且上一步 RLS=t，那就是 403 的直接原因）
select tablename as 表名,
       policyname as 策略名,
       cmd        as 操作,
       roles      as 适用角色
from pg_policies
where tablename in ('game_users', 'game_saves')
order by tablename, cmd;

-- 1.3 匿名角色的表级权限（RLS 之外还有一层，两层都要过）
select table_name as 表名,
       privilege_type as 权限
from information_schema.role_table_grants
where grantee = 'anon'
  and table_name in ('game_users', 'game_saves')
order by table_name, privilege_type;

-- 1.4 安全函数是否健在
select routine_name as 函数名
from information_schema.routines
where routine_schema = 'public'
  and routine_name like 'ql\_%'
order by routine_name;


-- ============================================================
-- 第 2 步：修复
-- ============================================================

-- 2.1 模式使用权（没有它，后面所有授权都不生效）
grant usage on schema public to anon, authenticated;

-- 2.2 game_users —— 注册要写，名录不能读
--     不给 SELECT 策略：拖库失效，登录一律走 ql_login。
alter table game_users enable row level security;

drop policy if exists ql_users_insert_anon on game_users;
create policy ql_users_insert_anon
  on game_users for insert to anon
  with check (true);

drop policy if exists ql_users_select_none on game_users;
-- 刻意不建 select 策略：匿名直读名录应当被拒。

grant insert on game_users to anon;
revoke select, update, delete on game_users from anon;

-- 2.3 game_saves —— 存档要读写，排行榜只读脱敏后的结果
alter table game_saves enable row level security;

drop policy if exists ql_saves_insert_anon on game_saves;
create policy ql_saves_insert_anon
  on game_saves for insert to anon
  with check (true);

drop policy if exists ql_saves_update_anon on game_saves;
create policy ql_saves_update_anon
  on game_saves for update to anon
  using (true) with check (true);

-- 排行榜走 ql_rank2 / ql_rank_me（SECURITY DEFINER，服务端脱敏），
-- 故不开放匿名直读；若你尚未部署排行榜函数，先跑
--   排行榜_安全函数_v2.sql
-- 再跑本脚本。
drop policy if exists ql_saves_select_anon on game_saves;

grant insert, update on game_saves to anon;
revoke select, delete on game_saves from anon;

-- 2.4 安全函数重新授权（新建函数默认把 EXECUTE 给了 PUBLIC，
--     这里定向只给匿名与登录角色，避免被滥用）
do $$
begin
  if exists (select 1 from pg_proc where proname = 'ql_ping') then
    execute 'revoke all on function public.ql_ping() from public';
    execute 'grant execute on function public.ql_ping() to anon, authenticated';
  end if;

  if exists (select 1 from pg_proc where proname = 'ql_login') then
    execute 'revoke all on function public.ql_login(text,text,text) from public';
    execute 'grant execute on function public.ql_login(text,text,text) to anon, authenticated';
  end if;

  if exists (select 1 from pg_proc where proname = 'ql_touch') then
    execute 'revoke all on function public.ql_touch(uuid) from public';
    execute 'grant execute on function public.ql_touch(uuid) to anon, authenticated';
  end if;

  if exists (select 1 from pg_proc where proname = 'ql_rank2') then
    execute 'revoke all on function public.ql_rank2(text,int) from public';
    execute 'grant execute on function public.ql_rank2(text,int) to anon, authenticated';
  end if;

  if exists (select 1 from pg_proc where proname = 'ql_rank_me') then
    execute 'revoke all on function public.ql_rank_me(text,text) from public';
    execute 'grant execute on function public.ql_rank_me(text,text) to anon, authenticated';
  end if;

  if exists (select 1 from pg_proc where proname = 'ql_rank') then
    execute 'revoke all on function public.ql_rank(int) from public';
    execute 'grant execute on function public.ql_rank(int) to anon, authenticated';
  end if;
end $$;


-- ============================================================
-- 第 3 步：自检（跑完看这两行）
-- ============================================================
-- 3.1 应看到 game_users 只有 INSERT、game_saves 有 INSERT+UPDATE
select table_name as 表名, string_agg(privilege_type, ',' order by privilege_type) as 匿名可用权限
from information_schema.role_table_grants
where grantee = 'anon'
  and table_name in ('game_users', 'game_saves')
group by table_name;

-- 3.2 浏览器验证（不带任何登录态）：
--   ✅ 应成功：游戏内注册新号 → 登录 → 云存档 → 排行榜出数据
--   ❌ 应失败（这是对的）：
--      https://zgkovjgkkvxoajcqxwfw.supabase.co/rest/v1/game_users?select=*
--      返回 403，而不是一串玩家档案


-- ============================================================
-- 【还原】若修复后出现异常，执行下面几行立刻回到宽松状态：
-- ============================================================
-- alter table game_users disable row level security;
-- alter table game_saves disable row level security;
-- grant select, insert, update on game_users to anon;
-- grant select, insert, update on game_saves to anon;
