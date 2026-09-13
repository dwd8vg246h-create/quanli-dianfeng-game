-- ============================================================
-- 权路巅峰 · 云端存档与用户后台 —— Supabase 建表脚本
-- 用法：Supabase 控制台 → SQL Editor → 粘贴执行
-- ============================================================

-- ---------- 1. 用户档案表 ----------
create table if not exists game_users (
  id            uuid primary key default gen_random_uuid(),
  emp_id        text unique not null,        -- 工号（登录用，唯一）
  name          text not null default '',    -- 姓名
  contact       text default '',             -- 联系方式
  pwd_hash      text not null,               -- 口令哈希（SHA-256，前端加盐后存）
  status        text not null default '正常', -- 正常 / 冻结 / 注销
  created_at    timestamptz not null default now(),
  login_count   int  not null default 0,
  last_login_at timestamptz,
  last_ip       text default ''
);
create index if not exists idx_users_emp   on game_users(emp_id);
-- 登录按联系方式匹配（与游戏内 findUser(contact) 一致）
create index if not exists idx_users_contact on game_users(contact);
create index if not exists idx_users_login on game_users(last_login_at desc);

-- ---------- 2. 存档表 ----------
-- 一个用户一条存档，用 upsert 覆盖写
create table if not exists game_saves (
  user_id     uuid primary key references game_users(id) on delete cascade,
  data        jsonb not null,               -- 完整游戏存档
  saved_at    timestamptz not null default now(),
  -- 由存档中提取的摘要字段，供后台列表直接展示，无需解析整个 jsonb
  summary     jsonb not null default '{}'::jsonb,
  version     int not null default 1
);
create index if not exists idx_saves_time on game_saves(saved_at desc);

-- ---------- 3. 后台操作留痕 ----------
create table if not exists admin_logs (
  id         bigserial primary key,
  action     text not null,                 -- 查阅 / 冻结 / 恢复 / 注销 / 重置口令 / 删档
  target     text default '',                -- 操作对象（工号）
  detail     text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_logs_time on admin_logs(created_at desc);

-- ============================================================
-- 行级安全（RLS）
-- ============================================================
alter table game_users  enable row level security;
alter table game_saves  enable row level security;
alter table admin_logs  enable row level security;

-- ---------- 用户表 ----------
-- 注册：匿名可插入（anon key 场景）
drop policy if exists "users_insert" on game_users;
create policy "users_insert" on game_users
  for insert to anon, authenticated with check (true);

-- 登录/查档：匿名可读（游戏为单机网页，靠工号+口令校验）
drop policy if exists "users_select" on game_users;
create policy "users_select" on game_users
  for select to anon, authenticated using (true);

-- 更新自己的记录（登录次数、最后登录）
drop policy if exists "users_update" on game_users;
create policy "users_update" on game_users
  for update to anon, authenticated using (true) with check (true);

-- ---------- 存档表 ----------
drop policy if exists "saves_all" on game_saves;
create policy "saves_all" on game_saves
  for all to anon, authenticated using (true) with check (true);

-- ---------- 日志：只允许追加，不允许改删 ----------
-- 审计记录不得随意删除，这是刻意的取舍（与游戏内管理员台一致）
drop policy if exists "logs_insert" on admin_logs;
create policy "logs_insert" on admin_logs
  for insert to anon, authenticated with check (true);
drop policy if exists "logs_select" on admin_logs;
create policy "logs_select" on admin_logs
  for select to anon, authenticated using (true);

-- ---------- 日志滚动保留（可选，需 pg_cron 或在后台手动调用）----------
-- 超过 500 条丢最旧的，避免无限增长
-- delete from admin_logs where id not in (
--   select id from admin_logs order by created_at desc limit 500
-- );

/* 在线心跳列（2026-09 追加）
   游戏端登录后每 2 分钟上报一次，后台据此统计在线人数。
   已有项目执行本句即可，不必重建表。 */
alter table game_users add column if not exists last_active_at timestamptz;
