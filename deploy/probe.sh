#!/usr/bin/env bash
# ============================================================
# 权路巅峰 · 数据库迁移 第 0 步：环境探测
# ------------------------------------------------------------
# 只做检测，不改任何东西。跑完把输出发来，据此决定迁移方式。
# 用法：bash probe.sh
# ============================================================
set -u

echo "=============== 1. 系统 ==============="
. /etc/os-release 2>/dev/null && echo "系统: $PRETTY_NAME"
echo "内核: $(uname -r)"
echo "内存: $(free -m | awk '/^Mem:/{printf "%.1f GB\n", $2/1024}')"
echo "磁盘: $(df -h / | awk 'NR==2{print $2" 总共 / "$4" 可用"}')"
echo "CPU : $(nproc) 核"

echo
echo "=============== 2. apt 源是否可用 ==============="
if timeout 25 apt-get update -qq >/dev/null 2>&1; then
  echo "apt 源: 可用（境外源通畅）"
else
  echo "apt 源: 默认源不可达，需换国内镜像（迁移脚本会自动换）"
fi

echo
echo "=============== 3. 能否连 Supabase 数据库(5432) ==============="
# 用 /dev/tcp 探测，无需装任何东西
if timeout 12 bash -c 'cat < /dev/null > /dev/tcp/db.zgkovjgkkvxoajcqxwfw.supabase.co/5432' 2>/dev/null; then
  echo "5432: 通  → 可用 pg_dump 直接导数据（最省事）"
else
  echo "5432: 不通 → 需走 CSV 导出路线"
fi
echo "--- 备用：IPv4 直连探测 ---"
SBIP=$(timeout 10 getent hosts db.zgkovjgkkvxoajcqxwfw.supabase.co 2>/dev/null | awk '{print $1}' | head -1)
echo "解析到: ${SBIP:-失败}"
if [ -n "$SBIP" ]; then
  timeout 12 bash -c "cat < /dev/null > /dev/tcp/$SBIP/5432" 2>/dev/null \
    && echo "IPv4 5432: 通" || echo "IPv4 5432: 不通"
fi

echo
echo "=============== 4. 已装软件 ==============="
for c in psql pg_dump postgrest nginx python3 curl; do
  command -v $c >/dev/null 2>&1 && echo "  $c: 已装 ($(command -v $c))" || echo "  $c: 未装"
done

echo
echo "=============== 5. 80 端口占用 ==============="
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | grep -E ':80\s|:3000\s|:5432\s' || echo "  80/3000/5432 均空闲"
else
  netstat -tlnp 2>/dev/null | grep -E ':80\s|:3000\s|:5432\s' || echo "  80/3000/5432 均空闲"
fi

echo
echo "=============== 6. 现有服务 ==============="
systemctl is-active quanli-web 2>/dev/null | sed 's/^/  quanli-web: /'

echo
echo "=============== 探测结束 ==============="
echo "请把以上输出发给开发者，据此生成对应的迁移脚本。"
