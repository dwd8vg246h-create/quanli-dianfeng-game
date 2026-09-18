#!/usr/bin/env bash
# ============================================================
# 权路巅峰 · 数据库搬家（Supabase → 本机 PostgreSQL）
# ------------------------------------------------------------
# 前置：本目录需含
#   sql/*.sql            建表与函数（7 个，按固定顺序执行）
#   postgrest_lite.py    PostgREST 兼容层
#   serve.py             静态服务（已内置 /rest/v1 代理）
#   import_data.sql      【可选】全量数据；存在则导入，不存在则只建空库
#
# 用法：bash migrate.sh
# 重复执行无副作用（create database 已存在会跳过，SQL 全部幂等）
# ============================================================
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
PGV=""
LOG() { echo; echo "▶ $*"; }
DIE() { echo; echo "✗ $*"; exit 1; }

echo "════════════════════════════════════════════"
echo "  权路巅峰 · 数据库搬家"
echo "════════════════════════════════════════════"

# ---------- 1. apt 源 ----------
LOG "1/8 检查软件源"
if ! timeout 25 apt-get update -qq >/dev/null 2>&1; then
  echo "    默认源不可达，切换阿里云镜像…"
  CODENAME=$(. /etc/os-release 2>/dev/null && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
  [ -z "$CODENAME" ] && CODENAME="jammy"
  cat > /etc/apt/sources.list <<EOF
deb https://mirrors.aliyun.com/ubuntu/ ${CODENAME} main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ ${CODENAME}-security main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ ${CODENAME}-updates main restricted universe multiverse
EOF
  apt-get update -qq >/dev/null 2>&1 || DIE "换源后仍无法更新，请检查网络"
  echo "    ✓ 已切换到阿里云镜像（${CODENAME}）"
else
  echo "    ✓ 默认源可用"
fi

# ---------- 2. 安装 PostgreSQL + psycopg2 ----------
LOG "2/8 安装 PostgreSQL 与 psycopg2"
export DEBIAN_FRONTEND=noninteractive
if ! command -v psql >/dev/null 2>&1; then
  apt-get install -y -qq postgresql postgresql-contrib >/dev/null 2>&1 \
    || DIE "PostgreSQL 安装失败"
  echo "    ✓ PostgreSQL 已安装"
else
  echo "    ✓ PostgreSQL 已存在"
fi
if ! python3 -c "import psycopg2" 2>/dev/null; then
  apt-get install -y -qq python3-psycopg2 >/dev/null 2>&1 \
    || pip3 install psycopg2-binary -q -i https://pypi.tuna.tsinghua.edu.cn/simple >/dev/null 2>&1 \
    || DIE "psycopg2 安装失败（apt 与 pip 都不行）"
  echo "    ✓ psycopg2 已安装"
else
  echo "    ✓ psycopg2 已存在"
fi

# ---------- 3. 启动并建立库/角色 ----------
LOG "3/8 启动 PostgreSQL 并建立库与角色"
systemctl enable --now postgresql >/dev/null 2>&1 || service postgresql start >/dev/null 2>&1
for i in $(seq 1 30); do
  su postgres -c "pg_isready -q" >/dev/null 2>&1 && break
  sleep 1
done
su postgres -c "pg_isready -q" >/dev/null 2>&1 || DIE "PostgreSQL 未能启动"

run_psql() { su postgres -c "psql -v ON_ERROR_STOP=0 -q -f -" <<<"$1"; }

su postgres -c "psql -q -tc \"select 1 from pg_database where datname='quanli'\"" | grep -q 1 \
  || su postgres -c "psql -q -c 'create database quanli;'" >/dev/null 2>&1
echo "    ✓ 数据库 quanli 就绪"

su postgres -c "psql -q -d quanli" <<'SQL' >/dev/null 2>&1
do $$
begin
  if not exists (select 1 from pg_roles where rolname='quanli') then
    create role quanli login password 'quanli';
  end if;
  if not exists (select 1 from pg_roles where rolname='anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then
    create role authenticator nologin;
  end if;
end $$;
grant all on schema public to quanli, anon, authenticated;
grant all on all tables in schema public to quanli, anon, authenticated;
alter default privileges in schema public grant all on tables to quanli, anon, authenticated;
SQL
echo "    ✓ 角色 quanli / anon / authenticated 就绪"

# ---------- 4. 建表与函数 ----------
LOG "4/8 建表与函数（7 个脚本，顺序固定）"
ORDER="01_schema.sql 02_mailcode.sql 03_season.sql 04_rank.sql 05_rank_v2.sql 06_admin_edit.sql 07_security.sql"
for f in $ORDER; do
  fp="$BASE/sql/$f"
  [ -f "$fp" ] || { echo "    ! 缺少 $f，跳过"; continue; }
  if su postgres -c "psql -q -v ON_ERROR_STOP=1 -d quanli -f '$fp'" >/tmp/_sqllog 2>&1; then
    echo "    ✓ $f"
  else
    echo "    ✗ $f"
    tail -3 /tmp/_sqllog | sed 's/^/        /'
  fi
done
FN=$(su postgres -c "psql -tAc \"select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'ql_%'\"" 2>/dev/null | tr -d ' ')
TB=$(su postgres -c "psql -tAc \"select count(*) from pg_tables where schemaname='public'\"" 2>/dev/null | tr -d ' ')
echo "    结果：${TB:-0} 张表 / ${FN:-0} 个 ql_ 函数"

# ---------- 5. 导入数据 ----------
LOG "5/8 导入数据"
if [ -f "$BASE/import_data.sql" ]; then
  SZ=$(du -h "$BASE/import_data.sql" | cut -f1)
  echo "    发现 import_data.sql（$SZ），开始导入…"
  # 序列归位，避免 bigserial 主键冲突
  su postgres -c "psql -q -d quanli" <<'SQL' >>/tmp/_sqllog 2>&1
do $$
declare r record;
begin
  for r in select t.table_name, c.column_name
           from information_schema.tables t
           join information_schema.columns c
             on c.table_name=t.table_name and c.table_schema='public'
           where t.table_schema='public'
             and c.column_default like 'nextval%'
  loop
    begin
      execute format('select setval(pg_get_serial_sequence(%L,%L), coalesce((select max(%I) from %I),0)+1, false)',
                     r.table_name, r.column_name, r.column_name, r.table_name);
    exception when others then null;
    end;
  end loop;
end $$;
SQL
  if su postgres -c "psql -q -v ON_ERROR_STOP=1 -d quanli -f '$BASE/import_data.sql'" >/tmp/_implog 2>&1; then
    echo "    ✓ 数据导入完成"
  else
    echo "    ✗ 导入报错（前 5 行）："
    head -5 /tmp/_implog | sed 's/^/        /'
  fi
  su postgres -c "psql -tAc \"select 'game_users='||count(*) from game_users\"" 2>/dev/null | sed 's/^/        /'
  su postgres -c "psql -tAc \"select 'game_saves='||count(*) from game_saves\"" 2>/dev/null | sed 's/^/        /'
else
  echo "    ! 未发现 import_data.sql —— 只建空库"
  echo "      需要导数据时把该文件放到本目录再跑一次本脚本"
fi

# ---------- 6. 部署兼容层服务 ----------
LOG "6/8 部署 PostgREST 兼容层"
cp -f "$BASE/postgrest_lite.py" /opt/ql_postgrest.py
cat > /etc/systemd/system/ql-postgrest.service <<EOF
[Unit]
Description=Quanli PostgREST compatible layer
After=postgresql.service
Requires=postgresql.service

[Service]
Type=simple
Environment=QL_DSN=postgresql://quanli:quanli@127.0.0.1:5432/quanli
Environment=QL_PORT=3000
Environment=QL_BIND=127.0.0.1
ExecStart=/usr/bin/python3 /opt/ql_postgrest.py
Restart=always
RestartSec=3
StandardOutput=append:/var/log/ql-postgrest.log
StandardError=append:/var/log/ql-postgrest.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ql-postgrest >/dev/null 2>&1
sleep 2
systemctl is-active ql-postgrest | sed 's/^/    状态: /'

# ---------- 7. 更新静态服务并重启 ----------
LOG "7/8 更新静态服务（内含 /rest/v1 代理）"
SITEDIR=/var/www/quanli-dianfeng
if [ -d "$SITEDIR" ]; then
  cp -f "$BASE/serve.py" "$SITEDIR/serve.py"
  systemctl restart quanli-web >/dev/null 2>&1
  systemctl is-active quanli-web | sed 's/^/    状态: /'
else
  echo "    ! 未找到 $SITEDIR，跳过（请手动部署 serve.py）"
fi

# ---------- 8. 健康检查 ----------
LOG "8/8 健康检查"
echo -n "    兼容层直连 : "
C1=$(curl -s -o /dev/null -w '%{http_code}' -m 10 'http://127.0.0.1:3000/rest/v1/game_users?select=id&limit=1' 2>/dev/null)
echo "HTTP ${C1:-000} $([ "$C1" = "200" ] && echo ✓ || echo ✗)"
echo -n "    经网页代理 : "
C2=$(curl -s -o /dev/null -w '%{http_code}' -m 10 'http://127.0.0.1/rest/v1/game_users?select=id&limit=1' 2>/dev/null)
echo "HTTP ${C2:-000} $([ "$C2" = "200" ] && echo ✓ || echo ✗)"
echo -n "    游戏首页   : "
C3=$(curl -s -o /dev/null -w '%{http_code}' -m 10 'http://127.0.0.1/' 2>/dev/null)
echo "HTTP ${C3:-000} $([ "$C3" = "200" ] && echo ✓ || echo ✗)"

echo
echo "════════════════════════════════════════════"
echo "  完成"
echo "════════════════════════════════════════════"
echo "  游戏内「云端配置」填这两项："
echo "    地址 : http://103.236.98.220:39471"
echo "    密钥 : 任意填写即可（本机不校验，仅回环可达）"
echo
echo "  常用命令："
echo "    systemctl status ql-postgrest      # 兼容层状态"
echo "    tail -f /var/log/ql-postgrest.log  # 看日志"
echo "    su postgres -c 'psql -d quanli'    # 进数据库"
echo "════════════════════════════════════════════"
