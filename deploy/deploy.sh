#!/usr/bin/env bash
# ============================================================
# 权路巅峰 · 一键部署 / 更新脚本
#
# 用法：
#   sudo bash deploy.sh 你的域名或IP
#   sudo bash deploy.sh 1.2.3.4              # 用 IP 访问
#   sudo bash deploy.sh game.example.com     # 用域名访问
#   sudo bash deploy.sh 1.2.3.4 --no-proxy   # 不代理 Supabase（保持浏览器直连）
#
# 做什么：
#   1. 从 GitHub 仓库拉取最新 5 个文件
#   2. 校验 index.html 结构完好（防止出现"整页显示源码"的事故）
#   3. 把你的域名/IP 写进游戏的域名白名单（不做这步必然被拦截）
#   4. 按需把云端地址改成本机反代路径
#   5. 原子替换到站点目录并重载 Nginx
#   6. 健康检查，失败自动回滚
# ============================================================
set -euo pipefail

REPO="dwd8vg246h-create/quanli-dianfeng-game"
BRANCH="main"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
DEST="/var/www/quanli-dianfeng"
FILES=(index.html admin.html cloud.js version.json admin_version.json)

HOST="${1:-}"
PROXY=1
for a in "$@"; do [ "$a" = "--no-proxy" ] && PROXY=0; done

if [ -z "$HOST" ]; then
  echo "用法：sudo bash deploy.sh 你的域名或IP [--no-proxy]"
  exit 1
fi
HOST="${HOST#http://}"; HOST="${HOST#https://}"; HOST="${HOST%/}"

echo "==> 目标域名/IP : $HOST"
echo "==> 站点目录    : $DEST"
echo "==> Supabase 代理: $([ $PROXY -eq 1 ] && echo 开启 || echo 关闭)"

command -v curl >/dev/null || { echo "缺少 curl"; exit 1; }
command -v python3 >/dev/null || { echo "缺少 python3"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo
echo "==> [1/6] 拉取最新文件"
for f in "${FILES[@]}"; do
  code=$(curl -sS -m 60 -o "$TMP/$f" -w '%{http_code}' "$RAW/$f")
  [ "$code" = "200" ] || { echo "拉取 $f 失败（HTTP $code）"; exit 1; }
  printf '    %-20s %8d 字节\n' "$f" "$(wc -c < "$TMP/$f")"
done

echo
echo "==> [2/6] 校验文件结构"
head -c 15 "$TMP/index.html" | grep -qi '<!DOCTYPE' \
  || { echo "index.html 开头不是 <!DOCTYPE，疑似损坏，终止部署"; exit 1; }
python3 - <<'PY' "$TMP/index.html"
import json,sys,re
d=open(sys.argv[1],encoding='utf-8').read()
n_o,n_c=d.count('<script'),d.count('</script>')
assert n_o==n_c, f'script 标签不配对：开 {n_o} 闭 {n_c}'
assert d.rstrip().endswith('</html>'), '文件结尾缺少 </html>'
print(f'    script 块 {n_o} 个，配对正常；结尾 </html> 正常')
PY

echo
echo "==> [3/6] 注入域名白名单 + 云端地址"
python3 - "$TMP/index.html" "$HOST" "$PROXY" <<'PY'
import re,sys
p,host,proxy=sys.argv[1],sys.argv[2],sys.argv[3]=='1'
d=open(p,encoding='utf-8').read()
orig=d

# --- 白名单：不加这步，换域名后游戏直接显示"未经授权的访问" ---
m=re.search(r'allowedHosts\s*:\s*\[([^\]]*)\]',d)
assert m,'未找到 allowedHosts，白名单注入失败'
items=[x.strip().strip('"\'') for x in m.group(1).split(',') if x.strip()]
if host not in items:
    items.append(host)
d=d[:m.start()]+'allowedHosts: ['+', '.join(f'"{i}"' for i in items)+']'+d[m.end():]
print('    白名单现在允许：', ', '.join(items))

# --- 云端地址：开启代理时改为走本机反代 ---
if proxy:
    u=re.search(r'url\s*:\s*"https://[^"]*supabase\.co[^"]*"',d)
    assert u,'未找到 CLOUD_CONFIG.url'
    d=d[:u.start()]+'url: "/supabase"'+d[u.end():]
    print('    云端地址已改为：/supabase（经本机反代）')
else:
    print('    云端地址保持直连 Supabase')

assert d!=orig,'没有任何改动，注入可能失效'
open(p,'w',encoding='utf-8').write(d)
print(f'    注入完成，字节数 {len(orig)} -> {len(d)}')
PY

echo
echo "==> [4/6] 备份并部署"
mkdir -p "$DEST"
if [ -f "$DEST/index.html" ]; then
  BK="${DEST}.bak.$(date +%Y%m%d%H%M%S)"
  cp -a "$DEST" "$BK"
  echo "    已备份旧版到 $BK"
fi
NEW="${DEST}.new.$$"
mkdir -p "$NEW"
cp -a "$TMP"/index.html "$TMP"/admin.html "$TMP"/cloud.js \
      "$TMP"/version.json "$TMP"/admin_version.json "$NEW"/
rm -rf "$DEST"; mv "$NEW" "$DEST"
chown -R www-data:www-data "$DEST" 2>/dev/null \
  || chown -R nginx:nginx "$DEST" 2>/dev/null || true
chmod -R a+rX "$DEST"
echo "    已就位：$(ls -1 "$DEST" | tr '\n' ' ')"

echo
echo "==> [5/6] 校验 Nginx 配置并重载"
if command -v nginx >/dev/null; then
  nginx -t 2>&1 | sed 's/^/    /'
  systemctl reload nginx 2>/dev/null || nginx -s reload
  echo "    Nginx 已重载"
else
  echo "    未检测到 nginx，跳过（请先安装并放置 nginx-quanli.conf）"
fi

echo
echo "==> [6/6] 健康检查"
sleep 1
code=$(curl -sS -m 15 -o /tmp/_hc.html -w '%{http_code}' "http://127.0.0.1/index.html" || echo 000)
echo "    本地首屏 HTTP $code"
if [ "$code" != "200" ]; then
  echo "!! 首屏异常，回滚"; [ -n "${BK:-}" ] && { rm -rf "$DEST"; cp -a "$BK" "$DEST"; }
  exit 1
fi
head -c 200 /tmp/_hc.html | grep -qi '<!DOCTYPE html' \
  && echo "    返回内容是正常 HTML" \
  || { echo "!! 返回的不是 HTML，回滚"; [ -n "${BK:-}" ] && { rm -rf "$DEST"; cp -a "$BK" "$DEST"; }; exit 1; }
grep -q "\"$HOST\"" "$DEST/index.html" && echo "    白名单已含 $HOST" || echo "    !! 白名单未生效，请检查"

if [ $PROXY -eq 1 ]; then
  pc=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
       "http://127.0.0.1/supabase/rest/v1/" -H "apikey: x" || echo 000)
  echo "    Supabase 反代连通性：HTTP $pc"
  [ "$pc" = "000" ] && echo "    !! 服务器访问 Supabase 不通，请用 --no-proxy 重跑"
fi

VER=$(python3 -c "import json;print(json.load(open('$DEST/version.json')).get('v','?'))" 2>/dev/null || echo '?')
echo
echo "================ 部署完成 ================"
echo "  版本    : $VER"
echo "  访问    : http://$HOST/"
echo "  后台    : http://$HOST/admin.html"
echo "=========================================="
