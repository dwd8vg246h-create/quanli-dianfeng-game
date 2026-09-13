-- ============================================================
-- 邮箱核验码表（配合 Edge Function 通道使用）
-- ------------------------------------------------------------
-- 走 Supabase Auth 内置邮件时不需要这张表；
-- 改为自建 Edge Function 下发（无 2 封/小时限速）时才需要。
-- ============================================================

create table if not exists mail_codes (
  id          bigserial primary key,
  email       text not null,
  code_hash   text not null,          -- 只存哈希，不存明文
  expires_at  timestamptz not null,
  tries       int not null default 0, -- 校验失败次数，超过 5 次作废
  used_at     timestamptz,
  ip          text default '',
  created_at  timestamptz not null default now()
);

create index if not exists idx_mail_email on mail_codes(email);
create index if not exists idx_mail_exp   on mail_codes(expires_at desc);

alter table mail_codes enable row level security;

-- 安全说明：
--   不向前端（anon）开放任何权限。
--   所有读写都发生在 Edge Function 内，
--   函数用 service_role 密钥访问，密钥不出现在网页里。
--   因此这里不建任何 policy —— 默认即为"全部拒绝"。
--
-- 若后续确认某条策略被误删导致函数也读不到，
-- 不要直接开放 anon，应改为在函数内使用 service_role。

-- 每日清理过期码（可选，需在控制台开启 pg_cron 扩展）
-- select cron.schedule('clean-mail-codes', '0 3 * * *',
--   $$delete from mail_codes where expires_at < now() - interval '1 day'$$);
