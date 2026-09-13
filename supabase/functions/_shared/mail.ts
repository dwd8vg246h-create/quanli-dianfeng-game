// 共享模块：SMTP 发送 + 验证码哈希
// 依赖环境变量（在 Supabase 控制台 → Edge Functions → Secrets 里配置）：
//   SMTP_HOST  例如 smtp.qq.com
//   SMTP_PORT  465（SSL）或 587（STARTTLS）
//   SMTP_USER  发信邮箱全名
//   SMTP_PASS  授权码（不是登录密码）
//   SMTP_FROM  发件人显示名，例如 权路巅峰 <xxx@qq.com>

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** 只存哈希，不存明文——数据库泄露也不会直接得到验证码 */
export async function hashCode(email: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${email.toLowerCase()}|${code}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成 6 位数字验证码 */
export function genCode(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, "0");
}

export function env(name: string): string {
  return Deno.env.get(name) ?? "";
}

/** 通过 SMTP 发送纯文本邮件 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT") || "465");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const from = env("SMTP_FROM") || user;

  if (!host || !user || !pass) {
    throw new Error("SMTP 未配置：缺少 SMTP_HOST / SMTP_USER / SMTP_PASS");
  }

  // deno.land/x/smtp —— Deno 官方生态常用的 SMTP 客户端
  const { SMTPClient } = await import("https://deno.land/x/smtp@v0.7.0/mod.ts");
  const client = new SMTPClient({
    connection: {
      hostname: host,
      port,
      tls: port === 465,          // 465 = 直接 SSL；587 = STARTTLS
      auth: { username: user, password: pass },
    },
  });

  await client.send({
    from,
    to,
    subject,
    content: text,
    html: `<div style="font-family:sans-serif;line-height:1.8">
      <p>${text.replace(/\n/g, "<br>")}</p>
    </div>`,
  });
  await client.close();
}

/** 简单限流：同一邮箱 60 秒内只发一次 */
const lastSent = new Map<string, number>();
export function tooSoon(email: string): boolean {
  const now = Date.now();
  const t = lastSent.get(email) ?? 0;
  if (now - t < 60_000) return true;
  lastSent.set(email, now);
  return false;
}
