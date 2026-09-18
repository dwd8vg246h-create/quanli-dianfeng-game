#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
权路巅峰 · 加固版静态服务
============================================================
相比 python3 -m http.server，本服务补上了这些：

 1. 后台鉴权      /admin.html 需 HTTP Basic 认证（服务端强制，绕不过去）
 2. 目录列举      已关闭（原版会暴露 setup.sh、zip 包等全部文件）
 3. 文件白名单    只放行游戏必需文件，其余一律 404
 4. 路径穿越      拒绝 ../ 等穿越尝试
 5. 暴力破解      连续 5 次口令错误，该 IP 封禁 15 分钟
 6. 频次限制      普通 240 次/分，后台 30 次/分
 7. 安全响应头    X-Content-Type-Options / X-Frame-Options / Referrer-Policy
 8. 隐藏指纹      不返回 Server 版本号
 9. API 代理      /rest/v1/ 转发给本机 127.0.0.1:3000 的 PostgREST 兼容层，
                  与网页同源，浏览器无需跨域；该端口不对外暴露

用法：python3 serve.py [端口]
口令存于同目录 .adminpass（sha256 哈希，由 secure.sh 生成）
============================================================
"""
import os, sys, time, hashlib, hmac, base64
import urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 80

# ---- 只放行这些文件（白名单，不在表中的一律 404）----
PUBLIC = {
    "/":                ("index.html", "text/html; charset=utf-8"),
    "/index.html":      ("index.html", "text/html; charset=utf-8"),
    "/version.json":    ("version.json", "application/json; charset=utf-8"),
    "/cloud.js":        ("cloud.js", "application/javascript; charset=utf-8"),
}
# ---- 这些需要 Basic 认证 ----
PRIVATE = {
    "/admin.html":         ("admin.html", "text/html; charset=utf-8"),
    "/admin_version.json": ("admin_version.json", "application/json; charset=utf-8"),
}
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".png":  "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
}

# ---- 限流 / 封禁状态（内存）----
HITS = {}          # ip -> [时间戳...]
API_HITS = {}      # ip -> [时间戳...]（API 代理限流）
ADMIN_HITS = {}    # ip -> [时间戳...]
FAILS = {}         # ip -> (失败次数, 首次时间)
BANNED = {}        # ip -> 解封时间戳
MAX_FAIL, BAN_SEC, FAIL_WIN = 5, 15 * 60, 10 * 60
RATE_PUB, RATE_ADMIN, WIN = 240, 30, 60

# ---- API 代理：转发给本机 PostgREST 兼容层（仅回环，不对公网开放）----
API_UPSTREAM = "http://127.0.0.1:3000"
API_PREFIX   = "/rest/v1/"
RATE_API     = 600          # 每分钟请求数（存档同步较频繁，给得比网页宽）
API_TIMEOUT  = 25


def _pass_hash():
    """读取口令哈希文件；不存在则视为未设置（此时后台一律拒绝）。"""
    p = os.path.join(BASE, ".adminpass")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _now(): return time.time()


def _clean(d, win):
    t = _now()
    for k in list(d.keys()):
        v = d[k]
        if isinstance(v, list):
            d[k] = [x for x in v if t - x < win]
            if not d[k]: del d[k]


def _rate_ok(bucket, ip, limit, win=WIN):
    _clean(bucket, win)
    arr = bucket.setdefault(ip, [])
    if len(arr) >= limit:
        return False
    arr.append(_now())
    return True


def _banned(ip):
    t = _now()
    if ip in BANNED:
        if t < BANNED[ip]:
            return True
        del BANNED[ip]
    return False


def _note_fail(ip):
    t = _now()
    n, first = FAILS.get(ip, (0, t))
    if t - first > FAIL_WIN:
        n, first = 0, t
    n += 1
    if n >= MAX_FAIL:
        BANNED[ip] = t + BAN_SEC
        FAILS.pop(ip, None)
    else:
        FAILS[ip] = (n, first)


class H(BaseHTTPRequestHandler):
    server_version = "web"
    sys_version = ""

    def log_message(self, fmt, *a):
        try:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % a))
        except Exception:
            pass

    # ---------- 工具 ----------
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _unauth(self):
        self._send(401, b"Unauthorized",
                   extra=[("WWW-Authenticate", 'Basic realm="Quanli Admin"')])

    def _check_auth(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(h[6:]).decode("utf-8", "ignore")
            _, _, pw = raw.partition(":")
        except Exception:
            return False
        want = _pass_hash()
        if not want:
            return False                      # 未设置口令 → 一律拒绝
        got = hashlib.sha256(pw.encode("utf-8")).hexdigest()
        return hmac.compare_digest(got, want)

    # ---------- 主流程 ----------
    def _handle(self):
        ip = self.client_address[0]
        path = self.path.split("?", 1)[0].split("#", 1)[0]

        if _banned(ip):
            return self._send(429, b"Too many failed attempts, try later.")

        if path.startswith(API_PREFIX):
            return self._proxy_api()

        if path in PRIVATE:
            if not _rate_ok(ADMIN_HITS, ip, RATE_ADMIN):
                return self._send(429, b"Rate limit exceeded.")
            if not self._check_auth():
                _note_fail(ip)
                return self._unauth()
            return self._serve(PRIVATE[path])

        if path in PUBLIC:
            if not _rate_ok(HITS, ip, RATE_PUB):
                return self._send(429, b"Rate limit exceeded.")
            return self._serve(PUBLIC[path])

        # 白名单之外：拒绝（含 ../ 穿越、目录列举、.sh/.zip 等）
        self._send(404, b"Not Found")

    # ---------- API 代理 ----------
    def _proxy_api(self):
        """把 /rest/v1/ 请求转发给本机 PostgREST 兼容层。
        与网页同源，因此浏览器不会产生跨域预检问题。"""
        ip = self.client_address[0]
        if not _rate_ok(API_HITS, ip, RATE_API):
            return self._send(429, b"Rate limit exceeded.")

        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n > 0 else None

        hdrs = {}
        for k in ("apikey", "Authorization", "Prefer", "Accept", "Content-Type"):
            v = self.headers.get(k)
            if v:
                hdrs[k] = v
        # 不去重 X-Forwarded-For：上游只看回环地址，没必要伪造
        try:
            req = urllib.request.Request(API_UPSTREAM + self.path,
                                         data=body, headers=hdrs, method=self.command)
            with urllib.request.urlopen(req, timeout=API_TIMEOUT) as r:
                raw = r.read()
                ct = r.headers.get("Content-Type", "application/json; charset=utf-8")
                return self._send(r.status, raw, ct)
        except urllib.error.HTTPError as e:
            raw = b""
            try:
                raw = e.read()
            except Exception:
                pass
            return self._send(e.code, raw or b"{}", "application/json; charset=utf-8")
        except Exception as e:
            return self._send(502, ("API 不可达：%s" % e).encode("utf-8"))

    def _serve(self, item):
        name, ctype = item
        fp = os.path.join(BASE, name)
        if not os.path.isfile(fp):
            return self._send(404, b"Not Found")
        try:
            with open(fp, "rb") as f:
                body = f.read()
        except Exception:
            return self._send(500, b"Read error")
        ext = os.path.splitext(name)[1].lower()
        self._send(200, body, MIME.get(ext, ctype))

    do_GET = _handle
    do_HEAD = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_DELETE = _handle
    do_PUT = _handle


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    srv.daemon_threads = True
    sys.stderr.write("serving %s on :%d\n" % (BASE, PORT))
    sys.stderr.write("admin auth: %s\n" % ("ON" if _pass_hash() else "OFF(未设口令)"))
    srv.serve_forever()
