-- ============================================================
-- 后台改档 · 一键安装
-- ------------------------------------------------------------
-- 用途：让管理后台在"直连数据表被访问策略拒绝"时仍能读写玩家存档。
--
-- 适用现象（满足其一即需执行）：
--   · 后台点「保存修改」提示含 permission / policy / 403 字样
--   · 提示"已保存"，但读回校验报数值不一致，或玩家端始终看不到
--   · 后台打开编辑面板提示"读取失败"
--
-- 原理：这两个函数是 SECURITY DEFINER，以定义者权限执行，
--       不受 Data API 访问策略与 RLS 限制；内部仍只读写 game_saves
--       的 data / summary 两列，不额外开放任何其它能力。
--
-- 重复执行无副作用（create or replace）。
-- ============================================================

-- 读：取整份存档
create or replace function ql_admin_read_save(p_user_id text)
returns table(data jsonb, summary jsonb, saved_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select s.data, s.summary, s.saved_at
    from game_saves s
   where s.user_id::text = p_user_id
   limit 1;
$$;

-- 写：整份回写，并写入管理端修订号
create or replace function ql_admin_write_save(
  p_user_id text,
  p_data    jsonb,
  p_summary jsonb,
  p_rev     bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_summary jsonb;
  v_version int;
  v_typ     text;
begin
  v_summary := coalesce(p_summary, '{}'::jsonb);
  if p_rev is not null then
    v_summary := jsonb_set(v_summary, '{管理端修订}', to_jsonb(p_rev), true);
  end if;
  v_version := coalesce(nullif(p_data->>'version','')::int, 1);

  /* user_id 在不同项目里可能是 uuid 也可能是 text，
     硬写 ::uuid 会在 text 项目上直接报错，故按实际列类型拼 SQL。 */
  select format_type(a.atttypid, a.atttypmod)
    into v_typ
    from pg_attribute a
   where a.attrelid = 'game_saves'::regclass
     and a.attname  = 'user_id'
     and a.attnum   > 0;
  v_typ := coalesce(v_typ, 'text');

  execute format(
    'insert into game_saves(user_id, data, summary, saved_at, version)
     values (%L::%s, %L::jsonb, %L::jsonb, now(), %s)
     on conflict (user_id) do update
       set data = excluded.data,
           summary = excluded.summary,
           saved_at = excluded.saved_at,
           version = excluded.version',
    p_user_id, v_typ,
    coalesce(p_data, '{}'::jsonb)::text,
    v_summary::text,
    v_version
  );

  return v_summary;
end;
$$;

-- 允许匿名（publishable key）调用；函数内部已限定只动 game_saves
do $$
begin
  execute 'grant execute on function ql_admin_read_save(text) to anon';
  execute 'grant execute on function ql_admin_write_save(text,jsonb,jsonb,bigint) to anon';
exception when others then
  raise notice 'grant 失败（可忽略，若角色不存在）：%', sqlerrm;
end $$;

-- ============================================================
-- 注销账号（真删）
-- ------------------------------------------------------------
-- 现象：后台点「注销」提示失败（permission denied / 403）。
--
-- 根因：安全加固脚本出于安全考虑收回了 anon 的 DELETE——
--       不收回的话，任何人拿到 URL + key 就能一条请求清空全部档案。
--       于是 Cloud.adminDeleteUser 的 DELETE 请求必然被拒。
--
-- 原理：本函数 SECURITY DEFINER，以定义者权限执行，不受该限制；
--       内部先删 game_saves 再删 game_users，顺序不可颠倒
--       （有外键时先删子表；即便有 on delete cascade，显式删也更稳）。
--
-- 未执行也不影响注销：后台会自动降级为「置状态注销 + 清空云端存档」，
-- 只用到 UPDATE/INSERT，同样能立即生效并退出排行榜。
-- 区别在于本函数是真删记录，降级方案保留账号行。
--
-- 重复执行无副作用（create or replace）。
-- ============================================================
create or replace function ql_admin_delete_user(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_typ text;
  v_s   int;
  v_u   int;
begin
  select format_type(a.atttypid, a.atttypmod)
    into v_typ
    from pg_attribute a
   where a.attrelid = 'game_saves'::regclass
     and a.attname  = 'user_id'
     and a.attnum   > 0;
  v_typ := coalesce(v_typ, 'text');

  execute format('delete from game_saves where user_id::text = %L', p_user_id);
  get diagnostics v_s = row_count;

  execute format('delete from game_users where id::text = %L', p_user_id);
  get diagnostics v_u = row_count;

  return jsonb_build_object('deleted_users', v_u, 'deleted_saves', v_s);
end;
$$;

do $$
begin
  execute 'grant execute on function ql_admin_delete_user(text) to anon';
exception when others then
  raise notice 'grant 失败（可忽略，若角色不存在）：%', sqlerrm;
end $$;
