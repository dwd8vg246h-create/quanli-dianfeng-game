// ============================================================
// admin-guard —— 后台管理服务端鉴权
// ------------------------------------------------------------
// 为什么要它：
//   admin.html 是纯静态页面，口令校验跑在浏览器里。
//   任何人拿到链接都能打开页面；而"首次打开者自设口令"的逻辑
//   等于把门钥匙交给第一个推门的人。
//   数据库密钥（publishable key）又必须写在前端，
//   拿到 key 的人可以完全绕开页面，直接调 PostgREST 读写档案。
//
//   所以鉴权只能放在服务端：
//   - 口令存在环境变量 ADMIN_TOKEN，不下发到任何客户端
//   - 数据库操作用 SERVICE_ROLE_KEY，也在服务端
//   - 前端只拿到一个短期 session，口令本身不反复传输
// ============================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
// Supabase 运行时注入的是 SUPABASE_SERVICE_ROLE_KEY，
// 两种写法都兼容，免得部署后报"未配置"却查不出原因。
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || "";
const ADMIN_ORIGIN = Deno.env.get("ADMIN_ORIGIN") || ""; // 可选，留空不校验来源

const MAX_FAIL = 5;              // 连续失败次数上限
const LOCK_MS = 10 * 60 * 1000;  // 锁定时长：10 分钟
const SESS_MS = 60 * 60 * 1000;  // 会话有效期：1 小时

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-token, x-admin-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* ---------- PostgREST 通道（服务端持有 service_role） ---------- */
async function db(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method === "POST" || method === "PATCH") headers["Prefer"] = "return=representation";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) return { ok: false as const, status: res.status, msg: text.slice(0, 300) };
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: true as const, data };
}

/* ---------- 状态表：失败计数与会话都放这里 ----------
   用一张通用 kv 表，避免为鉴权再建多张表。 */
async function kvGet(k: string) {
  const r = await db("GET", `admin_guard?select=v&k=eq.${encodeURIComponent(k)}&limit=1`);
  if (!r.ok) return null;
  const arr = r.data as Array<{ v: Record<string, unknown> }>;
  return arr && arr.length ? arr[0].v : null;
}
async function kvSet(k: string, v: Record<string, unknown>) {
  await db("POST", "admin_guard", { k, v, updated_at: new Date().toISOString() });
}
async function kvDel(k: string) {
  await db("DELETE", `admin_guard?k=eq.${encodeURIComponent(k)}`);
}

/* ---------- 恒定时间比较：避免按逐字节响应差推测口令 ---------- */
function safeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

async function hash(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function clientOf(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") || "unknown";
  const ua = req.headers.get("user-agent") || "unknown";
  return { ip, ua };
}

/* ---------- 审计：成功与失败都记，失败更要记 ---------- */
async function audit(action: string, target: string, detail: string) {
  await db("POST", "admin_logs", { action, target, detail });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, msg: "仅支持 POST" }, 405);

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, msg: "服务端未配置 SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);
  }
  if (!ADMIN_TOKEN) {
    return json({ ok: false, msg: "服务端未设置环境变量 ADMIN_TOKEN，鉴权不可用" }, 500);
  }
  // 来源校验：设了 ADMIN_ORIGIN 才启用，留空则不限制（便于手机上直接用）
  if (ADMIN_ORIGIN) {
    const from = req.headers.get("origin") || req.headers.get("referer") || "";
    if (!from.startsWith(ADMIN_ORIGIN)) {
      await audit("越权访问", "admin-guard", `来源不在白名单：${from.slice(0, 120)}`);
      return json({ ok: false, msg: "来源不在白名单" }, 403);
    }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, msg: "请求体解析失败" }, 400); }

  const action = String(body.action || "");
  const { ip, ua } = clientOf(req);
  const fp = await hash(ip + "|" + ua.slice(0, 80));

  /* ---------- 锁定检查：爆破口令的主要防线 ---------- */
  const st = await kvGet("fail:" + fp);
  const until = Number(st?.locked_until || 0);
  if (until && Date.now() < until) {
    const min = Math.ceil((until - Date.now()) / 60000);
    await audit("口令尝试", "admin-guard", `锁定中，剩余 ${min} 分钟（${ip}）`);
    return json({ ok: false, msg: `连续失败过多，请 ${min} 分钟后再试`, locked: true }, 429);
  }

  /* ---------- 登录：用口令换短期会话 ---------- */
  if (action === "login") {
    const token = String(body.token || "");
    if (!safeEqual(await hash(token), await hash(ADMIN_TOKEN))) {
      const fails = Number(st?.fails || 0) + 1;
      const lockUntil = fails >= MAX_FAIL ? Date.now() + LOCK_MS : 0;
      await kvSet("fail:" + fp, { fails, locked_until: lockUntil, ip, at: Date.now() });
      await audit("口令错误", "admin-guard", `第 ${fails} 次失败（${ip}）${lockUntil ? "，已锁定" : ""}`);
      return json({
        ok: false,
        msg: lockUntil ? `连续失败 ${MAX_FAIL} 次，已锁定 10 分钟` : `口令有误，还可尝试 ${MAX_FAIL - fails} 次`,
      }, 401);
    }
    await kvDel("fail:" + fp);
    const session = crypto.randomUUID();
    await kvSet("sess:" + session, { fp, ip, expires: Date.now() + SESS_MS });
    await audit("管理登录", "admin-guard", `已签发会话（${ip}）`);
    return json({ ok: true, session, expires: Date.now() + SESS_MS });
  }

  /* ---------- 其余动作一律凭会话 ---------- */
  const session = String(body.session || "");
  if (!session) return json({ ok: false, msg: "缺少会话" }, 401);
  const sess = await kvGet("sess:" + session);
  if (!sess) {
    await audit("无效会话", "admin-guard", `会话不存在或已过期（${ip}）`);
    return json({ ok: false, msg: "会话无效，请重新登录", relogin: true }, 401);
  }
  if (Number(sess.expires || 0) < Date.now()) {
    await kvDel("sess:" + session);
    return json({ ok: false, msg: "会话已过期，请重新登录", relogin: true }, 401);
  }
  // 会话与签发时的指纹须一致：会话被复制到别的设备即失效
  if (sess.fp !== fp) {
    await kvDel("sess:" + session);
    await audit("会话异常", "admin-guard", `指纹不符，已作废（${ip}）`);
    return json({ ok: false, msg: "会话与来源不符，已作废", relogin: true }, 401);
  }

  const p = (body.params || {}) as Record<string, unknown>;
  const id = String(p.id || "");

  try {
    switch (action) {
      case "list": {
        const r = await db("GET", "game_users?select=*&order=created_at.desc&limit=2000");
        if (!r.ok) return json({ ok: false, msg: r.msg }, 502);
        // 口令哈希不下发：后台名录与统计都不需要它
        const users = ((r.data as Array<Record<string, unknown>>) || []).map((u) => {
          const c = { ...u }; delete c.pwd_hash; return c;
        });
        return json({ ok: true, users });
      }
      case "saves": {
        const r = await db("GET", "game_saves?select=user_id,summary,updated_at&limit=2000");
        if (!r.ok) return json({ ok: false, msg: r.msg }, 502);
        const saves: Record<string, unknown> = {};
        for (const s of (r.data as Array<Record<string, unknown>>) || []) {
          saves[String(s.user_id)] = s;
        }
        return json({ ok: true, saves });
      }
      case "logs": {
        const r = await db("GET", "admin_logs?select=action,target,detail,created_at&order=created_at.desc&limit=200");
        if (!r.ok) return json({ ok: false, msg: r.msg }, 502);
        return json({ ok: true, logs: r.data || [] });
      }
      case "setStatus": {
        const status = String(p.status || "");
        if (!id || !status) return json({ ok: false, msg: "参数不全" }, 400);
        const r = await db("PATCH", `game_users?id=eq.${encodeURIComponent(id)}`, { status });
        await audit(status === "冻结" ? "冻结" : "恢复", id, r.ok ? "成功" : "失败：" + r.msg);
        return json({ ok: r.ok, msg: r.ok ? "" : r.msg });
      }
      case "resetPwd": {
        const pwdHash = String(p.pwdHash || "");
        if (!id || !pwdHash) return json({ ok: false, msg: "参数不全" }, 400);
        const r = await db("PATCH", `game_users?id=eq.${encodeURIComponent(id)}`, { pwd_hash: pwdHash });
        await audit("重置口令", id, r.ok ? "成功" : "失败：" + r.msg);
        return json({ ok: r.ok, msg: r.ok ? "" : r.msg });
      }
      case "deleteUser": {
        // 注销不可逆：必须回传工号二次确认，防止误点或脚本批量删
        const empId = String(p.empId || "");
        const r0 = await db("GET", `game_users?select=emp_id&id=eq.${encodeURIComponent(id)}&limit=1`);
        const row = ((r0.ok ? r0.data : []) as Array<{ emp_id: string }>)[0];
        if (!row) return json({ ok: false, msg: "档案不存在" }, 404);
        if (!empId || empId !== String(row.emp_id)) {
          return json({ ok: false, msg: "工号校验不一致，已拒绝注销" }, 400);
        }
        await db("DELETE", `game_saves?user_id=eq.${encodeURIComponent(id)}`);
        const r = await db("DELETE", `game_users?id=eq.${encodeURIComponent(id)}`);
        await audit("注销", empId, r.ok ? "成功" : "失败：" + r.msg);
        return json({ ok: r.ok, msg: r.ok ? "" : r.msg });
      }
      case "log": {
        await audit(String(p.action || "操作"), String(p.target || ""), String(p.detail || ""));
        return json({ ok: true });
      }
      case "logout": {
        await kvDel("sess:" + session);
        return json({ ok: true });
      }
      default:
        return json({ ok: false, msg: "未授权的动作：" + action }, 400);
    }
  } catch (e) {
    return json({ ok: false, msg: String((e as Error).message || e).slice(0, 200) }, 500);
  }
});
