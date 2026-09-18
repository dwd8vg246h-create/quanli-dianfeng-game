#!/usr/bin/env bash
# ============================================================
# 权路巅峰 · 服务器一键部署（全自动，无需任何参数）
#
# 在服务器上执行这一行即可：
#   curl -fsSL https://raw.githubusercontent.com/dwd8vg246h-create/quanli-dianfeng-game/main/deploy/bootstrap.sh | sudo bash
#
# NAT 转发 / 自动探测不到公网 IP 时，把公网 IP 作为参数传入：
#   curl -fsSL .../bootstrap.sh -o /tmp/b.sh && sudo bash /tmp/b.sh 你的公网IP
#
# 自动完成：装 Nginx → 探测公网 IP → 写配置 → 拉游戏文件
#           → 注入域名白名单 → 启动 → 健康检查 → 失败回滚
# ============================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

REPO="dwd8vg246h-create/quanli-dianfeng-game"
RAW="https://raw.githubusercontent.com/${REPO}/main"
DEST="/var/www/quanli-dianfeng"
CONF="/etc/nginx/conf.d/quanli.conf"
SB_HOST="zgkovjgkkvxoajcqxwfw.supabase.co"

say(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok(){  printf '  \033[0;32m✓ %s\033[0m\n' "$*"; }
bad(){ printf '  \033[0;31m✗ %s\033[0m\n' "$*"; }
info(){ printf '  %s\n' "$*"; }

[ "$(id -u)" = 0 ] || { bad "请用 sudo 运行"; exit 1; }

say "1/8 安装 Nginx 与依赖"
if command -v nginx >/dev/null 2>&1; then
  ok "Nginx 已安装"
else
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq nginx curl python3 >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q nginx curl python3 >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q nginx curl python3 >/dev/null 2>&1
  else
    bad "未识别的包管理器，请手动安装 nginx curl python3"; exit 1
  fi
  command -v nginx >/dev/null 2>&1 && ok "Nginx 安装完成" || { bad "安装失败"; exit 1; }
fi

say "2/8 确定访问地址（NAT 环境支持）"
# NAT 转发下，服务器本机往往只有内网 IP（10.x / 172.x / 192.168.x），
# 直接用 ip addr 会拿到错误地址。必须用外部服务探测网关的公网 IP。
is_private(){ case "$1" in
  10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*|127.*|169.254.*) return 0;;
  *) return 1;; esac; }

PUBIP="${1:-}"
if [ -n "$PUBIP" ]; then
  PUBIP="${PUBIP#http://}"; PUBIP="${PUBIP#https://}"; PUBIP="${PUBIP%%:*}"
  ok "使用指定地址：$PUBIP"
else
  for svc in "https://api.ipify.org" "https://ifconfig.me/ip" \
             "https://ipecho.net/plain" "https://myip.ipip.net" \
             "https://v4.ident.me" "http://ip.3322.net"; do
    C=$(curl -fsS -m 8 "$svc" 2>/dev/null | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | head -1 || true)
    if [ -n "$C" ] && ! is_private "$C"; then PUBIP="$C"; break; fi
  done
  if [ -n "$PUBIP" ]; then
    ok "探测到公网 IP：$PUBIP"
  else
    # 回退到本机地址，但内网地址不能用于白名单
    C=$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1 || true)
    if [ -n "$C" ] && ! is_private "$C"; then
      PUBIP="$C"; ok "使用本机地址：$PUBIP"
    else
      bad "未能自动确定公网 IP（NAT 环境常见）"
      echo
      echo "  请按下面方式重跑，把你的公网 IP 直接告诉我："
      echo "    curl -fsSL .../deploy/bootstrap.sh | sudo bash -s 你的公网IP"
      echo "  或下载后执行："
      echo "    curl -fsSL .../deploy/bootstrap.sh -o /tmp/b.sh && sudo bash /tmp/b.sh 你的公网IP"
      echo
      exit 1
    fi
  fi
fi
info "注：游戏只校验 IP（hostname），不含端口，NAT 随机外部端口不受影响"

say "3/8 写入 Nginx 配置"
mkdir -p "$(dirname "$CONF")" "$DEST"
cat > "$CONF" <<NGINXCONF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root $DEST;
    index index.html;
    charset utf-8;
    client_max_body_size 8m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 6;
    gzip_proxied any;
    gzip_types text/plain text/css text/javascript application/javascript
               application/json image/svg+xml application/xml;

    # 必须 no-cache：游戏靠 version.json 判断更新，
    # 缓存住会永远停在旧版本（刷新一百次仍提示更新）。
    add_header Cache-Control "no-cache, must-revalidate" always;
    add_header X-Content-Type-Options nosniff always;

    location / { try_files \$uri \$uri/ /index.html; }

    location /supabase/ {
        proxy_pass https://$SB_HOST/;
        proxy_ssl_server_name on;
        proxy_set_header Host $SB_HOST;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_connect_timeout 15s;
        proxy_read_timeout 60s;
        add_header Cache-Control "no-store" always;
    }
}
NGINXCONF
# 清掉可能存在的 default_server 冲突
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
if [ -f /etc/nginx/conf.d/default.conf ] && [ "$CONF" != "/etc/nginx/conf.d/default.conf" ]; then
  mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled 2>/dev/null || true
fi
ok "配置已写入 $CONF"

say "4/8 拉取游戏文件"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in index.html admin.html cloud.js version.json admin_version.json; do
  code=$(curl -sS -m 90 -o "$TMP/$f" -w '%{http_code}' "$RAW/$f" || echo 000)
  [ "$code" = "200" ] || { bad "拉取 $f 失败（HTTP $code）"; exit 1; }
  printf '    %-20s %9d 字节\n' "$f" "$(wc -c < "$TMP/$f")"
done
ok "全部就绪"

say "5/8 校验文件结构（防止整页显示源码）"
head -c 15 "$TMP/index.html" | grep -qi '<!DOCTYPE' \
  || { bad "index.html 开头不是 <!DOCTYPE，终止部署"; exit 1; }
python3 - "$TMP/index.html" <<'PY'
import sys
d=open(sys.argv[1],encoding='utf-8').read()
a,b=d.count('<script'),d.count('</script>')
assert a==b, f'script 不配对：{a} vs {b}'
assert d.rstrip().endswith('</html>'), '缺少 </html>'
print('    script 块 %d 个，配对正常' % a)
PY
ok "结构完好"

say "6/8 注入域名白名单 + 云端地址"
python3 - "$TMP/index.html" "$PUBIP" <<'PY'
import re,sys
p,host=sys.argv[1],sys.argv[2]
d=open(p,encoding='utf-8').read(); orig=d
m=re.search(r'allowedHosts\s*:\s*\[([^\]]*)\]',d)
assert m,'未找到 allowedHosts'
items=[x.strip().strip('"\'') for x in m.group(1).split(',') if x.strip()]
for h in (host,'localhost','127.0.0.1'):
    if h not in items: items.append(h)
d=d[:m.start()]+'allowedHosts: ['+', '.join(f'"{i}"' for i in items)+']'+d[m.end():]
print('    白名单：'+', '.join(items))
u=re.search(r'url\s*:\s*"https://[^"]*supabase\.co[^"]*"',d)
if u:
    d=d[:u.start()]+'url: "/supabase"'+d[u.end():]
    print('    云端改走本机反代 /supabase')
assert d!=orig
open(p,'w',encoding='utf-8').write(d)
PY
ok "注入完成"

say "7/8 部署并启动"
if [ -f "$DEST/index.html" ]; then
  cp -a "$DEST" "${DEST}.bak.$(date +%Y%m%d%H%M%S)" && info "已备份旧版"
fi
NEW="${DEST}.new.$$"; mkdir -p "$NEW"
cp -a "$TMP"/index.html "$TMP"/admin.html "$TMP"/cloud.js \
   "$TMP"/version.json "$TMP"/admin_version.json "$NEW"/
rm -rf "$DEST"; mv "$NEW" "$DEST"
chmod -R a+rX "$DEST"
chown -R www-data:www-data "$DEST" 2>/dev/null \
  || chown -R nginx:nginx "$DEST" 2>/dev/null || true

nginx -t 2>&1 | sed 's/^/    /'
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx 2>/dev/null || true
else
  service nginx restart 2>/dev/null || nginx -s reload
fi
sleep 2
ok "Nginx 已启动"

say "8/8 健康检查"
CODE=$(curl -sS -m 15 -o /tmp/_hc.html -w '%{http_code}' "http://127.0.0.1/index.html" || echo 000)
if [ "$CODE" != "200" ]; then
  bad "首屏 HTTP $CODE，回滚"
  BK=$(ls -1dt ${DEST}.bak.* 2>/dev/null | head -1)
  [ -n "$BK" ] && { rm -rf "$DEST"; cp -a "$BK" "$DEST"; nginx -s reload 2>/dev/null || true; }
  exit 1
fi
ok "首屏 HTTP 200"
head -c 200 /tmp/_hc.html | grep -qi '<!DOCTYPE html' && ok "返回的是正常 HTML" \
  || { bad "返回内容异常"; exit 1; }
grep -q "\"$PUBIP\"" "$DEST/index.html" && ok "白名单已包含 $PUBIP" || bad "白名单未生效"

PC=$(curl -sS -m 25 -o /dev/null -w '%{http_code}' "http://127.0.0.1/supabase/rest/v1/" -H "apikey: x" || echo 000)
if [ "$PC" = "000" ]; then
  bad "服务器连不上 Supabase，将关闭反代改用直连"
  python3 - "$DEST/index.html" <<'PY'
import re,sys
p=sys.argv[1]; d=open(p,encoding='utf-8').read()
d=d.replace('url: "/supabase"','url: "https://zgkovjgkkvxoajcqxwfw.supabase.co"')
open(p,'w',encoding='utf-8').write(d)
PY
  info "已恢复直连，游戏可正常玩"
else
  ok "Supabase 反代连通（HTTP $PC）"
fi

VER=$(python3 -c "import json;print(json.load(open('$DEST/version.json')).get('v','?'))" 2>/dev/null || echo '?')
echo
echo "══════════════ 部署完成 ══════════════"
echo "  服务器监听: 内部 80 端口（已就绪）"
echo "  NAT 转发  : 内部端口填 80，外部端口用自动生成的那个"
echo ""
echo "  游戏   : http://$PUBIP:你的外部端口/"
echo "  后台   : http://$PUBIP:你的外部端口/admin.html"
echo "  版本   : $VER"
echo "  站点目录: $DEST"
echo "══════════════════════════════════════"
echo
echo "  把最后生成的外部端口号填进上面的地址即可访问。"
echo "  打不开先确认 NAT 规则的内网 IP 指向这台机器、内部端口为 80。"
