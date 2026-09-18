# 权路巅峰 · 迁移到自有服务器

## 这次迁移解决什么

| 问题 | 迁移前 | 迁移后 |
|---|---|---|
| 网页打开慢/抽风 | GitHub Pages 在国内不稳 | 服务器在国内，首屏 0.5 秒 |
| 月带宽上限 | 100 GB（软限制） | 10M 跑满约 2716 GB/月 |
| 云端连通 | 浏览器直连 supabase.co，常被干扰 | 可走服务器反代，出海线路更稳 |

**不解决的**：Supabase 免费版那 5 GB 月流量配额照旧（反代只改善连通，流量仍从 Supabase 出，照样计费）。要突破它得升 Pro 或把数据库也搬走。

---

## 一、准备服务器

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y nginx curl python3
sudo mkdir -p /var/www/quanli-dianfeng

# CentOS / Rocky
sudo yum install -y nginx curl python3
```

放行 80 端口（云服务器还要在**安全组**里开，这步最容易漏）。

### ⚠️ 关于你这台「2G-4核-10」

- **CPU 4 核浪费**：静态页面 + 轻 API，CPU 几乎不耗
- **内存 2G 够跑 Nginx**：Nginx 本身只占几十 MB，绰绰有余
- **10 若是 10G 系统盘偏小**：装完系统 + Nginx 剩不了多少，建议至少 40G（后面要搬数据库时更明显）

只托管网页的话，2G 完全够。

---

## 二、三步部署

**① 放配置文件**

把 `nginx-quanli.conf` 放到 `/etc/nginx/conf.d/quanli.conf`。

**② 跑部署脚本**

```bash
sudo bash deploy.sh 你的IP或域名
```

用 IP 访问：

```bash
sudo bash deploy.sh 1.2.3.4
```

有域名：

```bash
sudo bash deploy.sh game.example.com
```

**③ 浏览器打开 `http://你的IP/`**

看到游戏界面即成功。后台在 `http://你的IP/admin.html`。

---

## 三、脚本自动做的两件关键事

### ① 域名白名单（不做这步必然打不开）

游戏内置安全校验，只允许这几个域名运行：

```js
allowedHosts: ["dwd8vg246h-create.github.io", "localhost", "127.0.0.1"]
```

**换域名后不在名单里，直接显示「未经授权的访问」。** 脚本会自动把你的 IP/域名加进去，无需改代码。

### ② Supabase 反向代理（默认开启）

浏览器只连你的服务器，服务器再去连 Supabase。国内直连 supabase.co 经常超时，走服务器出海通常更稳。

不想要就：

```bash
sudo bash deploy.sh 1.2.3.4 --no-proxy
```

---

## 四、缓存策略（踩过坑，别改）

`version.json` / `index.html` 一律 `no-cache`。

游戏靠版本文件判断更新，**一旦被缓存住就永远停在旧版本**，会出现「刷新一百次还是提示更新」的死循环。你之前遇到过，就是这个原因。

`no-cache` 不是不缓存——命中时返回 304，流量几乎为零。

---

## 五、更新游戏

我推了新版本后，服务器上重跑一次：

```bash
sudo bash deploy.sh 1.2.3.4
```

脚本会自动备份旧版（`/var/www/quanli-dianfeng.bak.时间戳`），健康检查失败则自动回滚。

---

## 六、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 显示「未经授权的访问」 | 白名单没注入成功，重跑脚本并确认输出含「白名单已含 你的IP」 |
| 整页显示源代码 | index.html 结构损坏，脚本第 2 步会拦截；若已发生请回滚备份 |
| 打不开，超时 | 云服务器**安全组**没开 80（最常见） |
| 能开但云同步失败 | 服务器连不上 Supabase，用 `--no-proxy` 重跑 |
| 国内服务器绑域名 | 需要**备案**；只用 IP 访问不用备案 |
| 想上 HTTPS | 有域名可 `certbot --nginx` 免费签；纯 IP 无法签正规证书 |

---

## 七、要不要连数据库一起搬

**现在不建议。**

- 2G 内存跑不了 Supabase 全套（官方最低 4G，全套是 11 个容器）
- 只搬 PostgreSQL + PostgREST 可行，但**登录鉴权要自己实现**，工作量最大
- 免费版 5GB 流量够约 1000 月活，你目前 498 账号还有余量

等确认这台服务器稳了、人数真上来了，再考虑第二步。到时候建议先把内存加到 4G。

---

## 八、回滚到 GitHub Pages

游戏本身没改，Pages 那份一直能访问：

```
https://dwd8vg246h-create.github.io/quanli-dianfeng-game/
```

两边共用同一个 Supabase 数据库，存档不丢，随时可切回。
