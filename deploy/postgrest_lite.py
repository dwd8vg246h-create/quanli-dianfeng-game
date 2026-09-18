#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PostgREST 兼容层（精简版）
==================================================
为什么不用官方 PostgREST：
  官方只有 GitHub Releases 提供二进制，本机与镜像源均返回 403，
  下载不到，因此自行实现前端实际用到的那部分语法。

已覆盖（经盘点前端全部请求确认，仅用到这些）：
  GET    /rest/v1/<表>?select=a,b&<列>=eq.<值>&order=<列>.desc&limit=&offset=
  POST   /rest/v1/<表>            Prefer: return=representation
                                  resolution=merge-duplicates → upsert
  PATCH  /rest/v1/<表>?<列>=eq.<值>
  DELETE /rest/v1/<表>?<列>=eq.<值>
  POST   /rpc/<函数名>            body 为命名参数 json

安全：仅监听 127.0.0.1，外部经 Nginx 反代访问；
      表/列名走白名单校验（只接受 [A-Za-z0-9_]），防注入。
"""
import os, sys, json, re, traceback
import urllib.parse as up
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import psycopg2
    import psycopg2.extras
except Exception:
    sys.stderr.write("缺少 psycopg2，请先安装：apt install python3-psycopg2\n")
    raise

DSN = os.environ.get("QL_DSN", "postgresql://quanli:quanli@localhost:5432/quanli")
PORT = int(os.environ.get("QL_PORT", "3000"))
BIND = os.environ.get("QL_BIND", "127.0.0.1")
APIKEY = os.environ.get("QL_APIKEY", "")   # 留空=不校验（推荐，因已绑定回环）

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def conn():
    c = psycopg2.connect(DSN)
    c.autocommit = False
    return c


def safe_ident(s):
    if not IDENT.match(s or ""):
        raise ValueError("非法标识符: %r" % s)
    return s


def quote_ident(s):
    return '"' + safe_ident(s).replace('"', '""') + '"'


def pk_columns(cur, table):
    cur.execute("""
      select a.attname
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = ('public.'||%s)::regclass and i.indisprimary
      order by a.attname
    """, (table,))
    # cur 可能是 RealDictCursor（返回 dict）或普通游标（返回 tuple），两种都兼容
    return [(r["attname"] if isinstance(r, dict) else r[0]) for r in cur.fetchall()]


OPS = ("eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in")
OPVAL = re.compile(r"^(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$", re.S)


def parse_filters(qs):
    """返回 (where_sql, params)
    兼容两种写法：
      旧式（本游戏前端实际使用）：col=eq.value
      新式（PostgREST 官方）    ：col.op=value
    支持 eq / neq / gt / gte / lt / lte / like / ilike / is / in"""
    conds, params = [], []
    for raw_k, vals in qs.items():
        k = raw_k
        if k in ("select", "order", "limit", "offset"):
            continue
        op, v = "eq", vals
        # 新式：col.op=value
        if "." in k:
            maybe_op = k.split(".")[-1]
            if maybe_op in OPS:
                op = maybe_op
                k = k[: -(len(maybe_op) + 1)]
        # 旧式：col=eq.value（覆盖上一步的默认值）
        if isinstance(v, str):
            m = OPVAL.match(v)
            if m:
                op, v = m.group(1), m.group(2)
        col = quote_ident(k)
        if v is None:
            conds.append("%s is null" % col); continue
        if op == "eq":
            conds.append("%s = %%s" % col); params.append(v)
        elif op == "neq":
            conds.append("%s <> %%s" % col); params.append(v)
        elif op == "gt":
            conds.append("%s > %%s" % col); params.append(v)
        elif op == "gte":
            conds.append("%s >= %%s" % col); params.append(v)
        elif op == "lt":
            conds.append("%s < %%s" % col); params.append(v)
        elif op == "lte":
            conds.append("%s <= %%s" % col); params.append(v)
        elif op == "like":
            conds.append("%s like %%s" % col); params.append(v)
        elif op == "ilike":
            conds.append("%s ilike %%s" % col); params.append(v)
        elif op == "is":
            if str(v).lower() in ("null", "true", "false"):
                conds.append("%s is %s" % (col, v)); continue
            conds.append("%s is %%s" % col); params.append(v)
        elif op == "in":
            items = [x for x in str(v).strip("()").split(",") if x != ""]
            if not items:
                conds.append("false"); continue
            conds.append("%s in (%s)" % (col, ",".join(["%s"] * len(items))))
            params.extend(items)
    return (" where " + " and ".join(conds) if conds else ""), params


def parse_select(sel, table):
    if not sel or sel.strip() == "*":
        return "*"
    return ", ".join(quote_ident(c.strip()) for c in sel.split(",") if c.strip())


def parse_order(ordv):
    if not ordv:
        return ""
    parts = []
    for seg in ordv.split(","):
        seg = seg.strip()
        if not seg:
            continue
        desc = False
        if seg.endswith(".desc"):
            desc, seg = True, seg[: -len(".desc")]
        elif seg.endswith(".asc"):
            seg = seg[: -len(".asc")]
        if seg.endswith(".nullsfirst") or seg.endswith(".nullslast"):
            seg = seg.rsplit(".", 1)[0]
        parts.append("%s %s" % (quote_ident(seg), "desc" if desc else "asc"))
    return (" order by " + ", ".join(parts)) if parts else ""


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ql-postgrest-lite"

    def log_message(self, fmt, *a):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % a))

    # ---------- 基础 ----------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "apikey,authorization,content-type,prefer,accept,x-requested-with")
        self.send_header("Access-Control-Expose-Headers", "Content-Range,Content-Location")

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(b)
        except Exception:
            pass

    def _err(self, code, msg, detail=""):
        body = {"message": msg, "code": str(code)}
        if detail:
            body["details"] = detail[:400]
        self._json(code, body)

    def _auth_ok(self):
        if not APIKEY:
            return True
        k = self.headers.get("apikey") or ""
        au = self.headers.get("Authorization") or ""
        if au.lower().startswith("bearer "):
            k = k or au[7:].strip()
        return k == APIKEY

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- 读取 body ----------
    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return None
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return raw.decode("utf-8", "replace")

    def _prefer(self):
        return (self.headers.get("Prefer") or "").lower()

    # ---------- 路由 ----------
    def do_GET(self):
        try:
            if not self._auth_ok():
                return self._err(401, "无效的 API key")
            u = up.urlsplit(self.path)
            qs = {k: v[0] for k, v in up.parse_qs(u.query, keep_blank_values=True).items()}
            if u.path.startswith("/rest/v1/"):
                return self._table_get(u.path[len("/rest/v1/"):], qs)
            return self._err(404, "未支持的路径: " + u.path)
        except Exception as e:
            return self._err(400, str(e), traceback.format_exc())

    def do_POST(self):
        try:
            if not self._auth_ok():
                return self._err(401, "无效的 API key")
            u = up.urlsplit(self.path)
            body = self._body()
            if u.path.startswith("/rpc/"):
                return self._rpc(u.path[len("/rpc/"):], body)
            if u.path.startswith("/rest/v1/"):
                return self._table_insert(u.path[len("/rest/v1/"):], body)
            return self._err(404, "未支持的路径: " + u.path)
        except Exception as e:
            return self._err(400, str(e), traceback.format_exc())

    def do_PATCH(self):
        try:
            if not self._auth_ok():
                return self._err(401, "无效的 API key")
            u = up.urlsplit(self.path)
            qs = {k: v[0] for k, v in up.parse_qs(u.query, keep_blank_values=True).items()}
            body = self._body()
            if u.path.startswith("/rest/v1/"):
                return self._table_update(u.path[len("/rest/v1/"):], qs, body)
            return self._err(404, "未支持的路径: " + u.path)
        except Exception as e:
            return self._err(400, str(e), traceback.format_exc())

    def do_DELETE(self):
        try:
            if not self._auth_ok():
                return self._err(401, "无效的 API key")
            u = up.urlsplit(self.path)
            qs = {k: v[0] for k, v in up.parse_qs(u.query, keep_blank_values=True).items()}
            if u.path.startswith("/rest/v1/"):
                return self._table_delete(u.path[len("/rest/v1/"):], qs)
            return self._err(404, "未支持的路径: " + u.path)
        except Exception as e:
            return self._err(400, str(e), traceback.format_exc())

    # ---------- 表操作 ----------
    def _table_get(self, table, qs):
        table = safe_ident(table)
        sel = parse_select(qs.get("select"), table)
        where, params = parse_filters(qs)
        order = parse_order(qs.get("order"))
        lim = ""
        if qs.get("limit"):
            lim += " limit %d" % max(0, min(int(qs["limit"]), 100000))
        if qs.get("offset"):
            lim += " offset %d" % max(0, int(qs["offset"]))
        sql = "select %s from public.%s%s%s%s" % (sel, quote_ident(table), where, order, lim)
        c = conn()
        try:
            cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            rows = cur.fetchall()
            return self._json(200, [dict(r) for r in rows])
        finally:
            c.close()

    def _table_insert(self, table, body):
        table = safe_ident(table)
        rows = body if isinstance(body, list) else [body]
        if not rows or not isinstance(rows[0], dict):
            return self._err(400, "请求体需为对象或对象数组")
        cols = list(rows[0].keys())
        colsql = ", ".join(quote_ident(x) for x in cols)
        ph = ", ".join(["%s"] * len(cols))
        prefer = self._prefer()
        returning = "return=representation" in prefer
        upsert = "resolution=merge-duplicates" in prefer or "resolution=ignore-duplicates" in prefer
        ignore = "resolution=ignore-duplicates" in prefer

        c = conn()
        try:
            cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            out = []
            for r in rows:
                vals = [json.dumps(r[x], ensure_ascii=False)
                        if isinstance(r[x], (dict, list)) else r[x] for x in cols]
                base = "insert into public.%s (%s) values (%s)" % (quote_ident(table), colsql, ph)
                if upsert:
                    pks = pk_columns(cur, table)
                    conflict = ", ".join(quote_ident(p) for p in pks) if pks else ""
                    if not conflict:
                        return self._err(400, "该表无主键，无法 upsert: " + table)
                    if ignore:
                        base += " on conflict (%s) do nothing" % conflict
                    else:
                        upd = ", ".join("%s = excluded.%s" % (quote_ident(x), quote_ident(x))
                                        for x in cols if x not in pks)
                        base += " on conflict (%s) do update set %s" % (conflict, upd) if upd \
                            else " on conflict (%s) do nothing" % conflict
                if returning:
                    base += " returning *"
                cur.execute(base, vals)
                if returning:
                    out.extend([dict(x) for x in cur.fetchall()])
            c.commit()
            return self._json(201, out if returning else [])
        except Exception as e:
            c.rollback()
            return self._err(409, str(e).strip().split("\n")[0], traceback.format_exc())
        finally:
            c.close()

    def _table_update(self, table, qs, body):
        table = safe_ident(table)
        if not isinstance(body, dict):
            return self._err(400, "PATCH 请求体需为对象")
        where, params = parse_filters(qs)
        if not where:
            return self._err(400, "PATCH 必须带过滤条件，拒绝全表更新")
        sets, sv = [], []
        for k, v in body.items():
            sets.append("%s = %%s" % quote_ident(k))
            sv.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
        prefer = self._prefer()
        returning = "return=representation" in prefer
        sql = "update public.%s set %s%s" % (quote_ident(table), ", ".join(sets), where)
        if returning:
            sql += " returning *"
        c = conn()
        try:
            cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, sv + params)
            rows = [dict(x) for x in cur.fetchall()] if returning else []
            c.commit()
            return self._json(200, rows)
        except Exception as e:
            c.rollback()
            return self._err(409, str(e).strip().split("\n")[0], traceback.format_exc())
        finally:
            c.close()

    def _table_delete(self, table, qs):
        table = safe_ident(table)
        where, params = parse_filters(qs)
        if not where:
            return self._err(400, "DELETE 必须带过滤条件，拒绝全表删除")
        prefer = self._prefer()
        returning = "return=representation" in prefer
        sql = "delete from public.%s%s" % (quote_ident(table), where)
        if returning:
            sql += " returning *"
        c = conn()
        try:
            cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            rows = [dict(x) for x in cur.fetchall()] if returning else []
            c.commit()
            return self._json(200, rows)
        except Exception as e:
            c.rollback()
            return self._err(409, str(e).strip().split("\n")[0], traceback.format_exc())
        finally:
            c.close()

    # ---------- RPC ----------
    def _rpc(self, fn, body):
        fn = safe_ident(fn)
        args = body if isinstance(body, dict) else {}
        # 按函数签名排序参数：PostgREST 用命名参数
        c = conn()
        try:
            cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
              select p.proname, pg_get_function_identity_arguments(p.oid) as idargs,
                     pg_get_function_arguments(p.oid) as args,
                     t.typname as rettype, p.proretset as setof
              from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              left join pg_type t on t.oid = p.prorettype
              where n.nspname='public' and p.proname = %s
            """, (fn,))
            r = cur.fetchone()
            if not r:
                return self._err(404, "函数不存在: public.%s" % fn)
            argnames = []
            if r["args"]:
                for seg in r["args"].split(","):
                    seg = seg.strip()
                    if not seg:
                        continue
                    nm = seg.split(" ", 1)[0].strip().strip('"')
                    argnames.append(nm)
            vals = []
            for nm in argnames:
                v = args.get(nm)
                vals.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
            ph = ", ".join(["%s"] * len(vals))
            if r["setof"]:
                sql = "select * from public.%s(%s)" % (quote_ident(fn), ph)
            else:
                sql = "select public.%s(%s) as %s" % (quote_ident(fn), ph, quote_ident(fn))
            cur.execute(sql, vals)
            if r["setof"]:
                rows = [dict(x) for x in cur.fetchall()]
                c.commit()
                return self._json(200, rows)
            row = cur.fetchone()
            c.commit()
            v = dict(row)[fn] if row else None
            return self._json(200, v)
        except Exception as e:
            try:
                c.rollback()
            except Exception:
                pass
            return self._err(400, str(e).strip().split("\n")[0], traceback.format_exc())
        finally:
            c.close()


def main():
    srv = ThreadingHTTPServer((BIND, PORT), H)
    sys.stderr.write("postgrest-lite 监听 %s:%d\n" % (BIND, PORT))
    srv.serve_forever()


if __name__ == "__main__":
    main()
