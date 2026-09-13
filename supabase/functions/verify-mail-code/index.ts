// 校验邮箱核验码
// 部署：supabase functions deploy verify-mail-code --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json, hashCode, env } from "../_shared/mail.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ message: "仅支持 POST" }, 405);

  let email = "", code = "";
  try {
    const body = await req.json();
    email = String(body.email || "").trim().toLowerCase();
    code = String(body.code || "").trim();
  } catch {
    return json({ message: "请求体格式有误" }, 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ message: "邮箱格式不正确" }, 400);
  if (!/^\d{6}$/.test(code)) return json({ message: "核验码为 6 位数字" }, 400);

  const supabase = createClient(
    env("SUPABASE_URL") || Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await supabase
    .from("mail_codes")
    .select("id, code_hash, expires_at, tries, used_at")
    .eq("email", email)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: false })
    .limit(5);

  if (error) return json({ message: "查询失败：" + error.message }, 500);
  if (!data || data.length === 0) return json({ message: "核验码已过期，请重新获取" }, 400);

  const want = await hashCode(email, code);
  const hit = data.find((r: { code_hash: string }) => r.code_hash === want);

  if (!hit) {
    await supabase.from("mail_codes").update({ tries: (data[0].tries || 0) + 1 }).eq("id", data[0].id);
    return json({ message: "核验码有误，请重新录入" }, 400);
  }

  await supabase.from("mail_codes").update({ used_at: new Date().toISOString() }).eq("id", hit.id);
  return json({ ok: true, message: "核验通过" });
});
