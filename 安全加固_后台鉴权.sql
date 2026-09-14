-- ============================================================
-- 后台服务端鉴权配套表
-- 在 Supabase → SQL Editor 执行（整段粘贴，点 Run）
-- ============================================================
-- 用途：
--   1) admin_guard —— 存放口令失败计数（防爆破）与短期会话
--   2) 收紧 admin_guard / admin_logs 对 anon 的权限，
--      这两张表只应由服务端的 service_role 读写
-- ============================================================

-- ---------- 1. 鉴权状态表 ----------
CREATE TABLE IF NOT EXISTS admin_guard (
  k           text PRIMARY KEY,
  v           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- 2. 开启 RLS 并只给服务端开口 ----------
ALTER TABLE admin_guard ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs  ENABLE ROW LEVEL SECURITY;

-- 若此前建过"允许所有人"的旧策略，先清掉，避免与下面的规则冲突
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('admin_guard','admin_logs')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

-- anon / authenticated 一律不给权限：
-- 后台日志与鉴权状态绝不能让访客读到，更不能写
REVOKE ALL ON admin_guard FROM anon, authenticated;
REVOKE ALL ON admin_logs  FROM anon, authenticated;

-- 日志的写入改由 Edge Function 用 service_role 完成，
-- 因此这里不再给 anon 任何 INSERT 权限。
-- 注意：Cloud.adminLog 走 anon 直写会失效，需把后台切到"服务端鉴权"模式。

-- service_role 走的是绕过 RLS 的通道，无需额外授权；
-- 上面的 REVOKE 不会影响到它。

-- ---------- 3. 校验 ----------
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname='public' AND tablename IN ('admin_guard','admin_logs');

-- 应返回空：说明两张表对 anon 完全不可见。
-- 再用 SQL Editor 试一次：
--   SELECT * FROM admin_guard;  -- 管理员视角仍可查（你是 postgres 角色）
-- 而用 anon key 调 REST：
--   /rest/v1/admin_guard?select=*
-- 应返回 401/403 或空。
-- ============================================================
