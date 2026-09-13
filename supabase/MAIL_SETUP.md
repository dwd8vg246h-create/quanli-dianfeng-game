# 邮箱核验码配置指南

代码已上线。默认走 **Supabase 内置邮件**，能发但**限速 2 封/小时**（项目级，全站共享）。
300 人用必须换自建通道。下面两条路，选一条。

---

## 路线一：内置邮件（零配置，仅供试用）

不用做任何事，现在已经能发。

**但要注意**：一小时内第 3 个玩家注册会失败，此时游戏**自动退回演示模式**（验证码直接显示在屏幕上）。
玩家仍能注册，只是核验形同虚设。

> 判断有没有触发：游戏建档页点"发送核验码"后，提示里若出现
> **"（已回退演示模式）"**，就是撞上限速了。

---

## 路线二：自建通道（推荐，无限速）

用 QQ 邮箱发信，免费、国内速度快。

### 第 1 步：拿到 QQ 邮箱授权码

1. 电脑登录 `mail.qq.com`
2. 设置 → 账户 → 往下找 **POP3/SMTP 服务** → 开启
3. 按提示发短信，会得到一个 **16 位授权码**（形如 `abcdefghijklmnop`）
4. **复制保存**——这就是 `SMTP_PASS`，**不是你的 QQ 密码**

<details>
<summary>用 163 / 126 邮箱？</summary>

设置 → POP3/SMTP → 开启 → 同样得到授权码。
服务器填 `smtp.163.com`，端口 465。
</details>

### 第 2 步：建验证码表

Supabase → **SQL Editor** → 粘贴 `schema_mailcode.sql` 全文 → **Run**

### 第 3 步：部署两个函数

需要装 Supabase CLI（电脑上操作，Node.js 环境）：

```bash
npm install -g supabase
supabase login
supabase link --project-ref zgkovjgkkvxoajcqxwfw
supabase functions deploy send-mail-code   --no-verify-jwt
supabase functions deploy verify-mail-code --no-verify-jwt
```

> `--no-verify-jwt` 不能省——发验证码时用户还没登录，没有 JWT 可验。

### 第 4 步：配置密钥

Supabase 控制台 → **Edge Functions** → **Secrets** → 逐条添加：

| 名称 | 值 |
|---|---|
| `SMTP_HOST` | `smtp.qq.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | 你的 QQ 邮箱全名 |
| `SMTP_PASS` | 第 1 步拿到的 16 位授权码 |
| `SMTP_FROM` | `权路巅峰 <你的邮箱>` |

`SUPABASE_URL` 和 `SERVICE_ROLE_KEY` 平台会自动注入，不用填。

### 第 5 步：切换通道

改 `game.html` 顶部的配置（约第 706 行）：

```js
var MAIL_CONFIG = {
  channel: "edge",      // auth → edge
  ...
};
```

改完执行：

```bash
node build.js && bash push_curl.sh
```

---

## 验证是否成功

建档页填邮箱 → 点发送 → 去邮箱看有没有 6 位验证码。

| 现象 | 说明 |
|---|---|
| 收到邮件，有 6 位码 | ✅ 成功 |
| 提示"（已回退演示模式）" | 还在内置通道（撞限速或未切换） |
| 提示"SMTP 未配置" | Secrets 没填全，回到第 4 步 |
| 提示"网络不可达" | 函数没部署成功，回到第 3 步 |

---

## 安全说明

- 验证码**只存哈希**（SHA-256），数据库泄露也拿不到明文
- `mail_codes` 表**不对前端开放任何权限**，读写全在服务端
- `SERVICE_ROLE_KEY` 只存在于服务端，**不会出现在网页里**
- 同一邮箱 **60 秒**只能发一次，防止被刷

---

## 费用

QQ 邮箱 SMTP 免费，每日发信上限约数百封。
300 人注册实际只消耗几百封，够用。
