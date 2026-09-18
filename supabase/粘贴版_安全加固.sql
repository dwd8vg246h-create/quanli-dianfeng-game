-- 权路巅峰 · 收回 game_users 整表写权限（粘贴版）
-- Supabase → SQL Editor → New query → 全选粘贴 → Run
-- 重复执行无副作用

-- 1) 收回写权限，保留登录注册必需的 SELECT / INSERT
revoke all on game_users from anon;
revoke all on game_users from authenticated;
grant select on game_users to anon;
grant insert on game_users to anon;

-- 2) 服务端管理密钥表
create table if not exists ql_admin_secret (
  id          int primary key default 1,
  secret_hash text,
  updated_at  timestamptz not null default now(),
  constraint ql_admin_secret_one_row check (id = 1)
);
insert into ql_admin_secret (id) values (1) on conflict (id) do nothing;
revoke all on ql_admin_secret from anon;
revoke all on ql_admin_secret from authenticated;

-- 3) 登录留痕（列存在才更新，避免缺列报错）
create or replace function ql_touch_login(p_user_id text, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_row int; v_sql text; v_sets text := '';
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='game_users' and column_name='login_count') then
    v_sets := v_sets || ', login_count = coalesce(login_count,0)+1';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='game_users' and column_name='last_login_at') then
    v_sets := v_sets || ', last_login_at = now()';
  end if;
  if p_ip is not null and exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='game_users' and column_name='last_ip') then
    v_sets := v_sets || ', last_ip = ' || quote_literal(p_ip);
  end if;
  if v_sets = '' then return jsonb_build_object('ok', true, 'rows', 0, 'note','无可更新列'); end if;
  v_sql := 'update game_users set ' || substr(v_sets, 3) || ' where id::text = ' || quote_literal(p_user_id);
  execute v_sql;
  get diagnostics v_row = row_count;
  return jsonb_build_object('ok', v_row > 0, 'rows', v_row);
end;
$$;

-- 4) 在线心跳（缺列时安全返回，不报错）
create or replace function ql_ping_active(p_user_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_row int;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='game_users'
                   and column_name='last_active_at') then
    return jsonb_build_object('ok', false, 'rows', 0, 'missing', true,
                              'msg','缺 last_active_at 列');
  end if;
  execute 'update game_users set last_active_at = now() where id::text = ' || quote_literal(p_user_id);
  get diagnostics v_row = row_count;
  return jsonb_build_object('ok', v_row > 0, 'rows', v_row);
end;
$$;

-- 5) 改密码：必须提供正确的旧哈希
create or replace function ql_set_pwd_hash(p_user_id text, p_old_hash text, p_new_hash text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_cur text; v_row int;
begin
  if p_old_hash is null or p_new_hash is null or length(p_new_hash) < 8 then
    return jsonb_build_object('ok', false, 'msg', '参数不合法');
  end if;
  select pwd_hash into v_cur from game_users where id::text = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'msg', '账号不存在');
  end if;
  if v_cur is null or v_cur <> p_old_hash then
    return jsonb_build_object('ok', false, 'msg', '原密码不正确');
  end if;
  update game_users set pwd_hash = p_new_hash where id::text = p_user_id;
  get diagnostics v_row = row_count;
  return jsonb_build_object('ok', v_row > 0, 'rows', v_row);
end;
$$;

-- 6) 管理操作：状态白名单 + 服务端密钥校验
create or replace function ql_admin_set_status(p_user_id text, p_status text, p_admin_token text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_secret text; v_row int; v_now text;
begin
  if p_status not in ('正常','冻结','注销') then
    return jsonb_build_object('ok', false, 'msg', '状态值不合法：'||coalesce(p_status,'null'));
  end if;
  select secret_hash into v_secret from ql_admin_secret where id = 1;
  if v_secret is not null then
    if p_admin_token is null or encode(digest(p_admin_token,'sha256'),'hex') <> v_secret then
      return jsonb_build_object('ok', false, 'msg', '服务端管理密钥校验未通过');
    end if;
  end if;
  update game_users set status = p_status where id::text = p_user_id;
  get diagnostics v_row = row_count;
  if v_row = 0 then
    return jsonb_build_object('ok', false, 'msg', '未匹配到该账号（0 行受影响）', 'rows', 0);
  end if;
  select status into v_now from game_users where id::text = p_user_id;
  return jsonb_build_object('ok', v_now = p_status, 'rows', v_row, 'status', v_now,
    'warn', case when v_secret is null then '未配置服务端管理密钥' else null end);
end;
$$;

-- 7) 授权：只给函数执行权
do $$
begin
  execute 'grant execute on function ql_touch_login(text,text) to anon';
  execute 'grant execute on function ql_ping_active(text) to anon';
  execute 'grant execute on function ql_set_pwd_hash(text,text,text) to anon';
  execute 'grant execute on function ql_admin_set_status(text,text,text) to anon';
exception when others then
  raise notice 'grant 失败（角色不存在时可忽略）：%', sqlerrm;
end $$;

-- 8) 校验：has_update 必须为 false，funcs 必须为 4
select has_table_privilege('anon','game_users','UPDATE') as has_update,
       has_table_privilege('anon','game_users','DELETE') as has_delete,
       has_table_privilege('anon','game_users','SELECT') as has_select,
       has_table_privilege('anon','game_users','INSERT') as has_insert;

select count(*) as funcs from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname in
   ('ql_touch_login','ql_ping_active','ql_set_pwd_hash','ql_admin_set_status');

select id, (secret_hash is not null) as secret_configured from ql_admin_secret;
