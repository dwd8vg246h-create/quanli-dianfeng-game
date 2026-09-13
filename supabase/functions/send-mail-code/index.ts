// 发送邮箱核验码
// 部署：supabase functions deploy send-mail-code --no-verify-jwt
// （必须 --no-verify-jwt，因为发送验证码时用户尚未登录）

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json, sendMail, genCode, hashCode, env, tooSoon } from "../_shared/mail.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ message: "仅支持 POST" }, 405);

  let email = "";
  try {
    const body = await req.json();
    email = String(body.email || "").trim().toLowerCase();
  } catch {
    return json({ message: "请求体格式有误" }, 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ message: "邮箱格式不正确" }, 400);
  }
  if (tooSoon(email)) {
    return json({ message: "发送过于频繁，请 60 秒后再试" }, 429);
  }

  // 用 service_role 访问数据库 —— 该密钥只存在于服务端，不会下发到网页
  const supabase = createClient(
    env("SUPABASE_URL") || Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SERVICE_ROLE_KEY")!,
  );

  const code = genCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 分钟有效

  const { error: dbErr } = await supabase
    .from("mail_codes")
    .insert({ email, code_hash: await hashCode(email, code), expires_at: expires });
  if (dbErr) return json({ message: "验证码入库失败：" + dbErr.message }, 500);

  try {
    await sendMail(
      email,
      "【权路巅峰】建档核验码",
      `您的核验码是：${code}\n\n10 分钟内有效。若非本人操作，请忽略此邮件。`,
    );
  } catch (e) {
    return json({ message: "邮件发送失败：" + (e as Error).message }, 500);
  }

  // 不回传验证码本身，只回传成功状态
  return json({ ok: true, message: "核验码已发送，请查收（留意垃圾邮件）" });
});
