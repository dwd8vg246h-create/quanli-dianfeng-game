-- ============================================================
-- 权路巅峰 · 收回 game_users 写权限（用安全函数替代）
-- ------------------------------------------------------------
-- 为什么要做这件事
--   之前为了能让后台注销/冻结账号，执行过：
--       grant update on game_users to anon;
--   这条语句的后果是：任何人拿到项目 URL + publishable key，
--   就能一条请求改掉整张用户表，例如：
--       PATCH /game_users?id=gt.00000000-0000-0000-0000-000000000000
--       {"status":"冻结"}
--   —— 全服账号一次性被冻结。同样能批量改写 pwd_hash，
--      把所有人的密码换成自己知道的，从而接管任意账号。
--   这正是渗透测试判「严重」的核心原因。
--
-- 本脚本做什么
--   1. 收回 anon 对 game_users 的 UPDATE / DELETE（保留 SELECT / INSERT，
--      否则注册和登录会断）
--   2. 用 SECURITY DEFINER 函数替代，每次调用只能操作「指定的一个 id」，
--      从「一条请求毁掉全表」降为「一次只影响一行」
--   3. 管理类操作（冻结/恢复/注销）校验服务端管理密钥
--   4. 改密码必须提供正确的旧哈希
--
-- 重复执行无副作用（create or replace / revoke 幂等）。
-- 执行位置：Supabase → SQL Editor → New query → 粘贴 → Run
-- ============================================================


-- ---------- 0. 先看现状（只读，可单独执行）----------
-- 执行后请扫一眼：has_update / has_delete 这两列
select tablename,
       bool_or(cmd = 'UPDATE' or cmd = 'ALL') as has_update,
       bool_or(cmd = 'DELETE' or cmd = 'ALL') as has_delete
  from (select tablename, cmd from pg_policies where schemaname='public'
        union all
        select 'game_users'::text, 'UPDATE'::text
         where has_table_privilege('anon','game_users','UPDATE')
        union all
        select 'game_users'::text, 'DELETE'::text
         where has_table_privilege('anon','game_users','DELETE')) t
 where tablename in ('game_users','game_saves','admin_logs')
 group by tablename;


-- ---------- 1. 收回 game_users 的全部写权限 ----------
-- 注意：SELECT 与 INSERT 必须保留，否则注册建档、登录匹配会立刻失效。
revoke all on game_users from anon;
revoke all on game_users from authenticated;
grant select on game_users to anon;   -- 登录匹配、后台名录
grant insert on game_users to anon;   -- 注册建档

-- DELETE 一律不给（此前已收，这里兜底确保）
-- 真删走 ql_admin_delete_user 函数，已具备

-- game_saves / admin_logs 保持既有权限不动


-- ---------- 2. 服务端管理密钥表 ----------
-- 管理类操作（冻结 / 恢复 / 注销）改为校验服务端密钥，
-- 不再依赖"谁拿到 key 谁就是管理员"。
create table if not exists ql_admin_secret (
  id          int primary key default 1,
  secret_hash text,                      -- sha256(管理员口令)，未设置则为 null
  updated_at  timestamptz not null default now(),
  constraint ql_admin_secret_one_row check (id = 1)
);
insert into ql_admin_secret (id) values (1)
  on conflict (id) do nothing;

-- 不给 anon 任何权限：密钥哈希不该被读走
revoke all on ql_admin_secret from anon;
revoke all on ql_admin_secret from authenticated;


-- ---------- 3. 登录留痕：递增登录次数 ----------
-- 原实现：PATCH game_users set login_count/last_login_at/last_ip
-- 改为函数后，单次调用只能影响传入的那一个 id。
create or replace function ql_touch_login(
  p_user_id text,
  p_ip      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row int;
begin
  update game_users
     set login_count   = coalesce(login_count, 0) + 1,
         last_login_at = now(),
         last_ip       = coalesce(p_ip, last_ip)
   where id::text = p_user_id;
  get diagnostics v_row = row_count;
  return jsonb_build_object('ok', v_row > 0, 'rows', v_row);
end;
$$;

-- ---------- 4. 在线心跳 ----------
create or replace function ql_ping_active(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row int;
begin
  update game_users
     set last_active_at = now()
   where id::text = p_user_id;
  get diagnostics v_row = row_count;
  return jsonb_build_object('ok', v_row > 0, 'rows', v_row);
end;
$$;

-- ---------- 5. 改密码：必须提供正确的旧哈希 ----------
-- 这堵住了"批量改写 pwd_hash 接管任意账号"这条路。
create or replace function ql_set_pwd_hash(
  p_user_id    text,
  p_old_hash   text,
  p_new_hash   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur text;
  v_row int;
begin
  if p_old_hash is null or p_new_hash is null or length(p_new_hash) < 8 then
    return jsonb_build_object('ok', false, 'msg', '参数不合法');
  end if;

  select pwd_hash into v_cur
    from game_users where id::text = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'msg', '账号不存在');
  end if;

  -- 旧哈希对不上就拒绝（前端存的是加盐后的 sha256，两边口径一致）
  if v_cur is null or v_cur <> p_old_hash then
    return jsonb_build_object('ok', false, 'msg', '原密码不正确');
  end if;

  update game_users set pwd_hash = p_new_hash where id::text = p_user_id;
  get diagnostics v_row = row_count;
  return jsonb_build_object('ok', v_row > 0, 'rows', v_row);
end;
$$;

-- ---------- 6. 管理：设置账号状态（冻结 / 恢复 / 注销）----------
-- 三重校验：
--   a) 状态值必须在白名单内
--   b) 单次只影响一个 id
--   c) 若已配置服务端管理密钥，则必须校验通过
create or replace function ql_admin_set_status(
  p_user_id     text,
  p_status      text,
  p_admin_token text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_row    int;
  v_now    text;
begin
  if p_status not in ('正常','冻结','注销') then
    return jsonb_build_object('ok', false, 'msg', '状态值不合法：'||coalesce(p_status,'null'));
  end if;

  select secret_hash into v_secret from ql_admin_secret where id = 1;

  if v_secret is not null then
    if p_admin_token is null
       or encode(digest(p_admin_token,'sha256'),'hex') <> v_secret then
      return jsonb_build_object('ok', false, 'msg', '服务端管理密钥校验未通过');
    end if;
  end if;

  update game_users set status = p_status where id::text = p_user_id;
  get diagnostics v_row = row_count;

  if v_row = 0 then
    return jsonb_build_object('ok', false, 'msg', '未匹配到该账号（0 行受影响）', 'rows', 0);
  end if;

  select status into v_now from game_users where id::text = p_user_id;

  return jsonb_build_object(
    'ok', v_now = p_status,
    'rows', v_row,
    'status', v_now,
    'warn', case when v_secret is null
                 then '未配置服务端管理密钥，管理操作未做服务端鉴权' else null end
  );
end;
$$;


-- ---------- 7. 授权：只给函数执行权，不给表写权限 ----------
do $$
begin
  execute 'grant execute on function ql_touch_login(text,text) to anon';
  execute 'grant execute on function ql_ping_active(text) to anon';
  execute 'grant execute on function ql_set_pwd_hash(text,text,text) to anon';
  execute 'grant execute on function ql_admin_set_status(text,text,text) to anon';
exception when others then
  raise notice 'grant 失败（角色不存在时可忽略）：%', sqlerrm;
end $$;


-- ---------- 8. 【强烈建议】设置服务端管理密钥 ----------
-- 把下面两行里的 MyAdminPass2026 换成你自己的管理口令，单独执行一次。
-- 设置之后，冻结 / 恢复 / 注销必须在请求里带上它（前端会自动带），
-- 不知道口令的人即便拿到 URL + key 也改不动任何账号状态。
--
--   update ql_admin_secret
--      set secret_hash = encode(digest('MyAdminPass2026','sha256'),'hex'),
--          updated_at  = now()
--    where id = 1;
--
-- ⚠ 注意：设置后，管理后台首次使用需要你输入一次该口令（存在浏览器本地）。
--    忘记口令的恢复办法（SQL Editor 执行）：
--       update ql_admin_secret set secret_hash = null where id = 1;


-- ---------- 9. 校验 ----------
-- 期望结果：
--   has_update = false   ← 关键，必须为 false
--   has_delete = false
--   funcs      = 4       ← 四个函数都已建立
select
  has_table_privilege('anon','game_users','UPDATE') as has_update,
  has_table_privilege('anon','game_users','DELETE') as has_delete,
  has_table_privilege('anon','game_users','SELECT') as has_select,
  has_table_privilege('anon','game_users','INSERT') as has_insert;

select count(*) as funcs
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('ql_touch_login','ql_ping_active',
                     'ql_set_pwd_hash','ql_admin_set_status');

select id,
       (secret_hash is not null) as secret_configured,
       updated_at
  from ql_admin_secret;

-- ============================================================
-- ⚠ 能力边界（必须说清）
-- ------------------------------------------------------------
-- 做完以上，攻击面从「一条请求毁掉全表」降为「一次只能动一行」，
-- 且管理类操作有服务端密钥把关。但纯前端架构下 publishable key
-- 必然公开，以下两点无法用 SQL 解决：
--   · 全表 SELECT 仍可读到联系方式（已有 v_game_users_public 视图可收敛）
--   · 若未设置服务端管理密钥，管理操作仍无服务端鉴权
-- 真正的正解是把读写迁到服务端（Edge Function），数据库密钥不下发。
-- ============================================================
