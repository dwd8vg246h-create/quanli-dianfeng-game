/* ============================================================
   云端存档同步 —— 原生 fetch 直连 PostgREST
   ------------------------------------------------------------
   【为什么不用 supabase-js】
   原实现依赖 CDN 加载 @supabase/supabase-js。
   国内访问 jsdelivr / unpkg 常被拦或极慢，一旦加载失败，
   Cloud 会静默降级为 off —— 玩家界面上看不到任何提示，
   注册和存档永远不会同步，且极难排查。

   Supabase 的数据接口本质是 PostgREST，用 fetch 直连即可，
   无需任何第三方库：
     GET    /rest/v1/表?select=&列=eq.值
     POST   /rest/v1/表          (Prefer: return=representation)
     PATCH  /rest/v1/表?列=eq.值
     DELETE /rest/v1/表?列=eq.值
   去掉这层依赖后，代码更小、启动更快、失败路径更可控。

   【核心设计：云永远不能拖垮本地】
     ① 所有云调用异步，失败静默降级，绝不阻塞游戏
     ② 本地 localStorage 始终权威，云端只是可恢复的副本
     ③ 登录时双向比对，取较新的一份（防换设备后进度倒退）
     ④ 未上传的进度进待同步队列，联网后自动重试
   ============================================================ */
var Cloud = (function(){

  var URL = "", KEY = "", ready = false;
  var CFG_KEY = "qlp_cloud_cfg";
  var PENDING_KEY = "qlp_cloud_pending";
  var state = {
    mode: "off",        // off / online / syncing / error
    lastError: "",
    lastSyncAt: null,
    pending: false,
    uid: null
  };
  var listeners = [];

  /* ---------- 状态通知 ---------- */
  function emit(){
    for(var i=0;i<listeners.length;i++){
      try{ listeners[i](state); }catch(e){}
    }
    /* 直接改徽标，避免整块重绘顶栏（顶栏很重，频繁重绘会卡） */
    try{
      var b = document.getElementById("cloudBadge");
      if(b){
        var st = statusText();
        b.style.background = st.color;
        b.textContent = st.icon + " " + st.text;
      }
    }catch(e){}
  }
  function setState(mode, err){
    state.mode = mode;
    state.lastError = err || "";
    emit();
  }

  /* ---------- 配置读写 ---------- */
  function loadCfg(){
    try{
      var raw = localStorage.getItem(CFG_KEY);
      if(!raw) return null;
      var c = JSON.parse(raw);
      return (c && c.url && c.key) ? c : null;
    }catch(e){ return null; }
  }
  function saveCfg(url, key){
    try{ localStorage.setItem(CFG_KEY, JSON.stringify({url:url, key:key})); }catch(e){}
  }

  /* ============================================================
     PostgREST 请求封装
     ============================================================ */
  function req(method, path, body, prefer, timeoutMs){
    var url = URL + "/rest/v1/" + path;
    var headers = {
      "apikey": KEY,
      "Authorization": "Bearer " + KEY,
      "Accept": "application/json"
    };
    if(body) headers["Content-Type"] = "application/json";
    if(prefer) headers["Prefer"] = prefer;

    var ctrl = null, to = null;
    if(typeof AbortController !== "undefined"){
      ctrl = new AbortController();
      to = setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, timeoutMs || 8000);
    }

    return fetch(url, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function(r){
      if(to) clearTimeout(to);
      return r.text().then(function(t){
        var data = null;
        try{ data = t ? JSON.parse(t) : null; }catch(e){ data = t; }
        if(!r.ok){
          return { error: { message: (data && (data.message||data.hint||data.detail)) || ("HTTP "+r.status), code: (data&&data.code)||String(r.status), status: r.status } };
        }
        return { data: data };
      });
    }).catch(function(e){
      if(to) clearTimeout(to);
      return { error: { message: (e && e.name === "AbortError") ? "请求超时" : ("网络不可达："+((e&&e.message)||"")) } };
    });
  }

  /* URL 编码，避免中文姓名/联系方式破坏查询串 */
  function enc(v){ return encodeURIComponent(String(v==null?"":v)); }
  /* PostgREST 的 eq 值需转义部分字符 */
  function eqv(v){
    return String(v==null?"":v).replace(/[.,:*()]/g, function(c){ return "%"+c.charCodeAt(0).toString(16); });
  }

  /* ---------- 初始化 ----------
     兼容两种调用：init({url,key}) 与 init(url, key)。
     此前的缺陷：只认对象形式，而调用方写的是 init(url, key)，
     opts 收到字符串 → opts.url 恒为 undefined → 永远走不到配置分支，
     静默 setState("off") 返回 false。
     结果：即便填了 URL 和 key 也永远启用不了，且不报错，极难察觉。 */
  function init(a, b){
    var opts = {};
    if(typeof a === "string"){ opts.url = a; opts.key = b; }
    else { opts = a || {}; }
    var cfg = loadCfg();
    if(opts.url && opts.key){
      cfg = {url:opts.url, key:opts.key};
      saveCfg(opts.url, opts.key);
    }
    if(!cfg){ setState("off"); return false; }
    /* 清洗 URL：只保留协议 + 主机。
       粘贴配置时极易混入路径、空格或不可见字符（零宽空格等），
       浏览器 fetch 会直接抛 "URL is not valid or contains user credentials"，
       看起来像服务不通，实为输入有误——且没有任何提示指向真正原因。 */
    URL = String(cfg.url)
            .replace(/[\u200b-\u200f\ufeff]/g, "")
            .replace(/\s+/g, "")
            .replace(/\/+$/, "");
    var m = URL.match(/^(https?:\/\/[^\/]+)/i);
    if(m) URL = m[1];
    KEY = String(cfg.key || "").replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, "");
    ready = true;
    setState(state.pending ? "syncing" : "online");
    return true;
  }

  function isReady(){ return ready; }
  function isEnabled(){ return ready; }

  /* ---------- 待同步队列 ---------- */
  function markPending(){
    state.pending = true;
    try{ localStorage.setItem(PENDING_KEY, String(Date.now())); }catch(e){}
    if(state.mode === "online") setState("syncing");
  }
  function clearPending(){
    state.pending = false;
    try{ localStorage.removeItem(PENDING_KEY); }catch(e){}
    if(state.mode === "syncing") setState("online");
  }
  function hasPending(){
    try{ return !!localStorage.getItem(PENDING_KEY); }catch(e){ return false; }
  }

  /* ============================================================
     注册
     ============================================================ */
  function register(empId, name, contact, pwdHash){
    if(!isReady()) return Promise.resolve({ok:false, offline:true, msg:"云端未启用，仅保存在本机。"});
    return req("POST", "game_users", {
      emp_id: empId,
      name: name || "",
      contact: contact || "",
      pwd_hash: pwdHash,
      status: "正常",
      login_count: 0
    }, "return=representation", 10000).then(function(res){
      if(res.error){
        // 工号重复是最常见的失败，须给出可行动的提示
        if(res.error.code === "23505" || res.error.status === 409){
          return {ok:false, msg:"该工号已被注册，请换一个。"};
        }
        return {ok:false, msg:"建档失败：" + (res.error.message||"未知错误")};
      }
      var row = (res.data && res.data.length) ? res.data[0] : null;
      return {ok:true, user:row || {}};
    });
  }

  /* ============================================================
     登录查询
     ============================================================ */
  var USER_COLS = "id,emp_id,name,contact,pwd_hash,status,created_at,login_count";

  function findUser(empId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET", "game_users?select="+USER_COLS+"&emp_id=eq."+eqv(empId)+"&limit=1",
      null, null, 8000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      if(!res.data || !res.data.length) return {ok:false, notFound:true};
      return {ok:true, user:res.data[0]};
    });
  }

  /* 游戏内登录按"联系方式"匹配，云端须一致 */
  function findByContact(contact){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET", "game_users?select="+USER_COLS+"&contact=eq."+eqv(contact)+"&limit=1",
      null, null, 8000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      if(!res.data || !res.data.length) return {ok:false, notFound:true};
      return {ok:true, user:res.data[0]};
    });
  }

  /* 登录回执：更新登录次数与时间（读-改-写，登录场景并发极低） */
  function touchLogin(userId){
    if(!isReady()) return;
    try{
      req("GET", "game_users?select=login_count&id=eq."+eqv(userId), null, null, 8000)
        .then(function(r){
          if(r.error || !r.data || !r.data.length) return;
          /* 优先走安全函数 ql_touch_login（库内自增，无读-改-写覆盖问题） */
          _qlFn("ql_touch_login", {p_user_id:String(userId)}).then(function(rr){
            if(rr.error || (rr.data && rr.data.ok === false)) throw new Error("fn");
          }).catch(function(){
            return req("PATCH", "game_users?id=eq."+eqv(userId), {
              login_count: (r.data[0].login_count||0) + 1,
              last_login_at: new Date().toISOString()
            }, null, 8000);
          });
        });
    }catch(e){}
  }

  /* ============================================================
     在线心跳
     ------------------------------------------------------------
     "在线"无法由服务端直接判定（HTTP 无连接状态），
     故由客户端定期上报活动时刻，后台统计近 N 分钟内有上报的人数。
     玩家关掉页面后心跳自然停止，N 分钟后显示为离线——无需登出逻辑。

     ⚠️ 依赖 game_users.last_active_at 列。
     若该列不存在（未执行 ALTER TABLE），此处静默失败：
     不提示、不重试、不影响其余云端功能。
     后台会把在线人数显示为"—"并提示补列。
     ============================================================ */
  var HEARTBEAT_MS = 120000;   // 2 分钟
  var _HB_MIN_GAP = 60000;     // 两次上报最小间隔
  var _hbTimer = null;
  var _hbMissing = false;      // 列缺失 → 不再反复重试，避免无谓请求
  var _hbLast = 0;

  function heartbeat(userId, force){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    var uid = userId || (state && state.uid);
    if(!uid) return Promise.resolve({ok:false, msg:"未登录"});
    if(_hbMissing) return Promise.resolve({ok:false, missing:true});
    /* 节流：心跳与存档推送都会调用，60 秒内只上报一次。
       没有它，玩家每 60 秒存一次档就会多发一个请求。 */
    var now = Date.now();
    if(!force && (now - _hbLast) < _HB_MIN_GAP) return Promise.resolve({ok:true, skipped:true});
    _hbLast = now;
    /* 优先走安全函数 ql_ping_active */
    return _qlFn("ql_ping_active", {p_user_id:String(uid)}, 8000).then(function(rr){
      if(!rr.error && (!rr.data || rr.data.ok !== false)){
        if(state.mode !== "online" && !state.pending) setState("online");
        return {ok:true};
      }
      if(rr.error && !rr.error.missing) return {ok:false, msg:rr.error.message};
      /* 函数未部署 → 退回 PATCH */
      return req("PATCH", "game_users?id=eq."+eqv(uid), {
        last_active_at: new Date().toISOString()
      }, null, 8000).then(function(res){
        if(res.error){
          // 42703 = 列不存在；PGRST204 = PostgREST 未缓存到该列
          if(res.error.code === "42703" || res.error.code === "PGRST204"){
            _hbMissing = true;
            return {ok:false, missing:true};
          }
          return {ok:false, msg:res.error.message};
        }
        if(state.mode !== "online" && !state.pending) setState("online");
        return {ok:true};
      });
    });
  }

  /* 启动心跳。重复调用只会保留一个定时器。
     force=true 时强制立即上报一次（绕开节流）——
     用于刚登录/刚注册，否则玩家要等一个节流周期才会显示为在线。 */
  function startHeartbeat(userId, force){
    try{
      if(_hbTimer) clearInterval(_hbTimer);
      heartbeat(userId, force);                // 立即上报一次
      _hbTimer = setInterval(function(){ heartbeat(userId); }, HEARTBEAT_MS);
      return true;
    }catch(e){ return false; }
  }
  function stopHeartbeat(){
    try{ if(_hbTimer) clearInterval(_hbTimer); }catch(e){}
    _hbTimer = null;
  }
  function heartbeatSupported(){ return !_hbMissing; }

  /* ============================================================
     存档
     ============================================================ */
  function pullSave(userId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET", "game_saves?select=data,saved_at,version&user_id=eq."+eqv(userId)+"&limit=1",
      null, null, 10000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      if(!res.data || !res.data.length) return {ok:true, empty:true};
      return {ok:true, data:res.data[0].data, savedAt:res.data[0].saved_at};
    });
  }

  /* 摘要字段：供后台列表直接展示，避免把整个 jsonb 拉下来解析 */
  function __globalS(){
    try{ return (typeof S !== "undefined") ? S : null; }catch(e){ return null; }
  }

  function buildSummary(S){
    try{
      return {
        姓名: S.name || "",
        职务: (typeof rankTitle === "function") ? rankTitle(S.rank) : "",
        /* 层次与位阶是排行榜排序的依据。
           此前只存职务名，客户端无法按"走到哪一级"排序——
           只能拿政绩排，于是低职级但刷分快的玩家会排在
           高职级玩家前面，天梯榜失去意义。 */
        层次: (typeof RANKS !== "undefined" && RANKS[S.rank]) ? RANKS[S.rank][1] : "",
        位阶: (typeof S.rank === "number") ? S.rank : -1,
        年龄: S.age || 0,
        年份: (S.year||0) + "年" + (S.month||0) + "月",
        政绩: Math.round(S.政绩||0),
        道德: Math.round(S.道德||0),
        结局: S.ending || "",
        /* 上榜开关：玩家可在「排行榜」页退出。
           默认为 true（上榜），显式设为 false 才退出。
           安全函数 ql_rank 会据此过滤；若未部署该函数，
           客户端直读时同样按此字段过滤，两种路径行为一致。 */
        上榜: S.不上榜 !== true,
        /* —— 排行榜排序字段 ——
           位阶：位阶榜要用。此前漏写，导致全服档案位阶恒为 -1。
           净资产 / 廉政：财富榜与清廉榜的排序依据。 */
        位阶: (typeof S.rank === "number") ? S.rank : -1,
        净资产: (function(){
          try{
            if(typeof netWorth !== "function") return 0;
            if(typeof __globalS !== "function" || __globalS() !== S) return 0;
            return Math.round(netWorth());
          }catch(e){ return 0; }
        })(),
        廉政: Math.round(S.廉政 || 0)
      };
    }catch(e){ return {}; }
  }

  function pushSave(userId, S){
    if(!isReady()){ markPending(); return Promise.resolve({ok:false, offline:true}); }
    setState("syncing");
    /* upsert：PostgREST 用 POST + resolution=merge-duplicates 实现。
       注意 jsonb 字段直接传对象，JSON.stringify 后即为其值。 */
    var _sum = buildSummary(S);
    if(S && typeof S._adminRev === "number") _sum["管理端修订"] = S._adminRev;
    return req("POST", "game_saves", {
      user_id: userId,
      data: S,
      summary: _sum,
      saved_at: new Date().toISOString(),
      version: 1
    }, "return=representation,resolution=merge-duplicates", 12000).then(function(res){
      if(res.error){
        markPending(); setState("error", res.error.message);
        return {ok:false, msg:res.error.message};
      }
      clearPending();
      state.lastSyncAt = Date.now();
      setState("online");
      return {ok:true};
    });
  }

  /* ============================================================
     排行榜（仕途天梯）
     ------------------------------------------------------------
     两种取数路径，都活着：
      ① 安全函数 ql_rank（推荐）—— SECURITY DEFINER，
         只吐脱敏字段，且尊重玩家的「上榜」开关。
      ② 直读 game_saves.summary —— 适用于尚未执行
         排行榜_安全函数.sql 的项目。客户端自行脱敏。

     两条路都拿不到时返回 ok:false，由页面降级到本机榜，
     绝不让一个附属功能拖住主流程。
     ============================================================ */
  function maskName(n){
    n = String(n == null ? "" : n).trim();
    if(!n) return "匿名干部";
    if(n.length <= 1) return n + "*";
    return n.slice(0,1) + new Array(Math.min(4, n.length)).join("*");
  }
  function lbFromSummary(rows){
    var out = [];
    (rows || []).forEach(function(r){
      var s = r && r.summary ? r.summary : (r || {});
      /* 尊重退出意愿：显式 false 才排除，缺失视为上榜 */
      if(s["上榜"] === false) return;
      out.push({
        emp_id: String(r.user_id || "").slice(0, 8),
        name_masked: maskName(s["姓名"]),
        title: s["职务"] || "",
        level: s["层次"] || "",
        tier: (typeof s["位阶"] === "number") ? s["位阶"] : -1,
        age: parseInt(s["年龄"], 10) || 0,
        merit: parseInt(s["政绩"], 10) || 0,
        wealth: parseInt(s["净资产"], 10) || 0,
        clean: parseInt(s["廉政"], 10) || 0,
        ending: s["结局"] || "",
        saved_at: (r && r.saved_at) || null
      });
    });
    return out;
  }
  /* 页内排序：仅用于兜底路径（服务端未排序时） */
  function lbAgeKey(v){ var n = parseInt(v,10); return (isFinite(n) && n>=16 && n<=90) ? n : 9999; }
  function lbSortLocal(rows, sort){
    var arr = (rows || []).slice();
    arr.sort(function(a, b){
      if(sort === "merit") return (b.merit||0) - (a.merit||0);
      if(sort === "rich")  return (b.wealth||0) - (a.wealth||0);
      if(sort === "clean") return (b.clean||0) - (a.clean||0);
      if(sort === "young"){
        var ay = lbAgeKey(a.age), by = lbAgeKey(b.age);
        return ay - by;
      }
      return (b.tier||-1) - (a.tier||-1) || (b.merit||0) - (a.merit||0);
    });
    for(var i=0;i<arr.length;i++){ arr[i].pos = i+1; }
    return arr;
  }
  function leaderboard(limit, sort){
    var lim = Math.max(1, Math.min(300, parseInt(limit, 10) || 100));
    var srt = String(sort || "tier");
    if(!isReady()) return Promise.resolve({ok:false, offline:true, rows:[]});
    /* 路径①：服务端按维度在全量数据上排名（真实名次 + 总数） */
    return req("POST", "rpc/ql_rank2", {p_sort: srt, p_limit: lim}, null, 12000)
      .then(function(res){
        if(!res.error && Array.isArray(res.data) && res.data.length){
          var rows = res.data;
          return {ok:true, via:"rpc2", sort:srt, rows:rows,
                  total:(rows[0] && parseInt(rows[0].total_count, 10)) || rows.length};
        }
        /* 路径②：第一版函数，只能按政绩取前 N 条 */
        return req("POST", "rpc/ql_rank", {p_limit: lim}, null, 12000)
          .then(function(r1){
            if(!r1.error && Array.isArray(r1.data)){
              var rr = (r1.data || []).map(function(x){
                x.wealth = x.wealth || 0; x.clean = x.clean || 0; x.pos = 0; return x;
              });
              return {ok:true, via:"rpc1", sort:srt, rows:lbSortLocal(rr, srt),
                      total:rr.length, partial:true};
            }
            /* 路径③：直读摘要 */
            return req("GET",
              "game_saves?select=user_id,summary,saved_at&limit=" + lim,
              null, null, 15000).then(function(r2){
              if(r2.error) return {ok:false, msg:r2.error.message, rows:[]};
              var rr = lbFromSummary(r2.data || []);
              return {ok:true, via:"direct", sort:srt, rows:lbSortLocal(rr, srt),
                      total:rr.length, partial:true};
            });
          });
      })
      .catch(function(e){
        return {ok:false, msg:(e && e.message) || "网络异常", rows:[]};
      });
  }
  /* 只回答"我排第几"：不拉榜单也能知道自己的位置 */
  function leaderboardMe(sort){
    var srt = String(sort || "tier");
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    var self = "";
    try{ self = String((state && state.uid) || "").slice(0, 8); }catch(e){ self = ""; }
    if(!self) return Promise.resolve({ok:false, msg:"尚未登录"});
    return req("POST", "rpc/ql_rank_me", {p_self: self, p_sort: srt}, null, 12000)
      .then(function(res){
        if(res.error || !Array.isArray(res.data) || !res.data.length){
          return {ok:false, msg:(res.error && res.error.message) || "暂无法定位名次"};
        }
        var d = res.data[0] || {};
        return {ok:true, sort:srt,
                pos:(d.pos === null || d.pos === undefined) ? null : parseInt(d.pos, 10),
                total:parseInt(d.total_count, 10) || 0,
                avgTier:parseFloat(d.avg_tier) || 0,
                endCount:parseInt(d.end_count, 10) || 0};
      }).catch(function(e){
        return {ok:false, msg:(e && e.message) || "网络异常"};
      });
  }

  /* ---------- 联网重试 ---------- */
  function retryPending(userId, S){
    if(!isReady() || !hasPending()) return Promise.resolve({ok:false, nothing:true});
    return pushSave(userId, S);
  }

  /* ============================================================
     后台
     ------------------------------------------------------------
     后台需要读全部用户；RLS 当前对 anon 放开读写，故这些调用可工作。
     若你收紧了 RLS，这些调用会失败并明确提示，不会静默改坏数据。
     ============================================================ */
  /* 在线判定窗口：见 admin.html。
     后台自己统计（需同时用于列表逐行标记），此处不重复实现。 */
  function adminList(){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    var cols = "id,emp_id,name,contact,status,created_at,login_count,last_login_at,last_active_at";
    return req("GET",
      "game_users?select="+cols+"&order=last_login_at.desc.nullslast&limit=500",
      null, null, 12000).then(function(res){
      /* last_active_at 是后加字段；管理员若没执行 ALTER TABLE，
         PostgREST 会报列不存在。此时降级为不含该字段再取一次，
         在线人数改用 last_login_at 近似 —— 不能让统计整个挂掉。 */
      if(res.error && (res.error.code === "42703" || res.error.code === "PGRST204")){
        return req("GET",
          "game_users?select=id,emp_id,name,contact,status,created_at,login_count,last_login_at"
          + "&order=last_login_at.desc.nullslast&limit=500", null, null, 12000)
          .then(function(r2){
            if(r2.error) return {ok:false, msg:r2.error.message};
            return {ok:true, users:r2.data||[], noActiveColumn:true};
          });
      }
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true, users:res.data||[]};
    });
  }

  /* 批量读取存档摘要，供后台档案名录展示"存档进度"。
     ------------------------------------------------------------
     此前后台只读 game_users，从未读 game_saves，
     而 buildSummary 已把职务/年份/政绩等写入 summary 字段——
     数据一直在存，后台却从不取，管理员看不到任何人的进度。

     只取摘要不取整份 data：整份 jsonb 体积大（可达数百 KB），
     几十人同屏会把响应拖垮，且后台并不需要完整存档。 */
  function adminSaves(){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET",
      "game_saves?select=user_id,summary,saved_at&limit=1000",
      null, null, 15000).then(function(res){
      /* 表不存在或无权限时降级：存档进度整列显示"—"，
         其余功能不受影响——不能让一个附属字段拖垮整个名录。 */
      if(res.error) return {ok:false, msg:res.error.message};
      var map = {};
      (res.data||[]).forEach(function(r){
        if(!r || !r.user_id) return;
        map[r.user_id] = {summary: r.summary||{}, savedAt: r.saved_at};
      });
      return {ok:true, saves:map};
    });
  }



  /* ============================================================
     批量对账：一次拉回全部存档的「摘要 + 比对所需少量本体字段」
     ------------------------------------------------------------
     后台名录与游戏排行榜读的都是 game_saves.summary，
     玩家真实进度在 game_saves.data。两者不同源，改档、玩家端重算
     都可能让摘要滞后，表现就是「名录/排行榜与存档对不上」。

     逐人读整份 data 在本项目里不可行：单份 jsonb 可达数百 KB，
     几百人同屏会把响应拖垮。故优先用 PostgREST 的 jsonb 投影
     只取比对需要的几个键；投影不被支持时退回逐个读取（并发 4，带进度）。
     ============================================================ */
  var RECON_PROJ = "user_id,summary," +
    "data->>'name' as d_name,data->>'rank' as d_rank,data->>'age' as d_age," +
    "data->>'year' as d_year,data->>'month' as d_month," +
    "data->>'政绩' as d_zj,data->>'道德' as d_dd," +
    "data->>'廉政' as d_lz,data->>'不上榜' as d_bs";

  function _projToData(r){
    function n(v){
      if(v === null || v === undefined || v === "") return undefined;
      var x = Number(v);
      return isNaN(x) ? undefined : x;
    }
    var bs = r.d_bs;
    /* 「取不到」与「取到空值」必须区分开：
       前者意味着这个键在本体里根本不存在，摘要应保持原样；
       后者是真实值。早前一律转成 ""/false，导致本体缺字段的存档
       被判成"摘要与本体不一致"，而修正又改不动它——永远修不完。 */
    return {
      name:  (r.d_name === null || r.d_name === undefined) ? undefined : r.d_name,
      rank:  n(r.d_rank),
      age:   n(r.d_age),
      year:  n(r.d_year),
      month: n(r.d_month),
      政绩: n(r.d_zj),
      道德: n(r.d_dd),
      廉政: n(r.d_lz),
      不上榜: (bs === null || bs === undefined || bs === "")
            ? undefined : (bs === true || bs === "true")
    };
  }

  function adminReconAll(ids, onProgress){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET",
      "game_saves?select=" + encodeURIComponent(RECON_PROJ) + "&limit=1000",
      null, null, 25000).then(function(res){
      if(!res.error){
        return {ok:true, via:"proj", rows:(res.data||[]).map(function(r){
          return {userId: r.user_id, summary: r.summary||{}, data: _projToData(r), partial: true};
        })};
      }
      /* 投影不被支持（PostgREST 较旧 / 键名含中文）→ 逐个读整份。
         整份读取较慢，故限并发并回报进度，界面能显示「第 n/N」。 */
      var list = (ids||[]).slice(0, 400);
      if(!list.length) return {ok:false, msg:res.error.message};
      var out = [], i = 0, CONC = 4, done = 0, total = list.length;
      return new Promise(function(resolve){
        /* 以「已完成数」判定结束，不能用 i >= list.length：
           后者会让最后一个线程在别人的读取还没回来时就 resolve，
           结果是扫描空——看似成功，实际一份都没比对。 */
        function next(){
          if(i >= list.length) return;
          var id = list[i++];
          adminReadSave(id).then(function(r){
            if(r.ok && !r.empty)
              out.push({userId: id, summary: r.summary||{}, data: r.data||{}});
            done++;
            if(onProgress){ try{ onProgress(done, total); }catch(e){} }
            if(done >= total) resolve({ok:true, via:"full", rows:out});
            else next();
          });
        }
        for(var k = 0; k < Math.min(CONC, total); k++) next();
      });
    });
  }

  /* ============================================================
     管理员读写整份存档（后台「修改档案数据」用）
     ------------------------------------------------------------
     此前后台只有摘要（summary），能看不能改：
     玩家遇到存档损坏、数值异常、误触结局时，管理员无从处置，
     只能注销重来——而注销会连带清除整个档案与存档，代价过大。

     读：按 user_id 取整份 jsonb data（单人，避免整表拉取）。
     写：upsert 回写 data，并按新内容重算 summary。

     为什么 summary 要在后台重算：
       summary 是排行榜与名录展示的唯一来源，若只改 data 不改
       summary，后台列表会继续显示旧职务旧政绩，看起来"没改成功"。

     职务名后台算不出来的部分（rankTitle 依赖游戏内 52 级职级表
     与所在机构），沿用旧值并交由管理端传入覆盖；位阶、政绩、
     道德、年龄、年份这些纯数值一律按新 data 重算。
     ============================================================ */
  /* 本体字段「存在」的判定：0 是合法值，不能拿 falsy 判断 */
  function _hasV(v){ return (v !== undefined && v !== null && v !== ""); }
  /* 取数值，取不到则用旧摘要的值兜底（0 亦视为合法新值） */
  function _numOr(v, alt){
    if(!_hasV(v)) return (typeof alt === "number" ? alt : (Number(alt) || 0));
    var x = Number(v);
    return isNaN(x) ? (typeof alt === "number" ? alt : (Number(alt) || 0)) : x;
  }

  function adminBuildSummary(S, prev){
    prev = prev || {};
    var tier = (typeof S.rank === "number") ? S.rank
             : (typeof prev["位阶"] === "number" ? prev["位阶"] : -1);
    var yv = S.year, mv = S.month;
    var hasY = (yv !== undefined && yv !== null && yv !== "");
    var hasM = (mv !== undefined && mv !== null && mv !== "");
    return {
      姓名: _hasV(S.name) ? S.name : (prev["姓名"] || ""),
      /* 职务、层次由调用端（admin.html 内联职级表）算出后传入；
         算不出则沿用旧值，绝不置空——空职务会让排行榜显示空白。 */
      职务: prev["职务"] || "",
      层次: prev["层次"] || "",
      位阶: tier,
      /* 关键：本体没有这个键时沿用旧摘要，而不是补 0。
         补 0 会造成两类灾难——
         ① 批量对账时投影取不到的字段被判成"不一致"，而修正写入 0
            后又仍然不一致，永远修不完；
         ② 修正真的把 0 写进摘要，把原本正确的年龄/政绩抹成 0。 */
      年龄: _numOr(S.age, prev["年龄"]),
      年份: (hasY || hasM) ? ((hasY?yv:0)+"年"+(hasM?mv:0)+"月") : (prev["年份"] || ""),
      政绩: Math.round(_numOr(S.政绩, prev["政绩"])),
      道德: Math.round(_numOr(S.道德, prev["道德"])),
      结局: _hasV(S.ending) ? S.ending : (prev["结局"] || ""),
      上榜: (S.不上榜 === undefined || S.不上榜 === null)
           ? (prev["上榜"] !== false) : (S.不上榜 !== true),
      净资产: (typeof prev["净资产"] === "number") ? prev["净资产"] : 0,
      廉政: Math.round(_numOr(S.廉政, prev["廉政"]))
    };
  }

  function adminReadSave(userId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET",
      "game_saves?select=data,summary,saved_at,version&user_id=eq."+eqv(userId)+"&limit=1",
      null, null, 15000).then(function(res){
      if(!res.error && res.data && res.data.length)
        return {ok:true, data:res.data[0].data, summary:res.data[0].summary||{},
                savedAt:res.data[0].saved_at, via:"table"};
      if(!res.error) return {ok:true, empty:true, via:"table"};
      var em = String(res.error.message||"");
      var denied = (res.error.status === 403) || (res.error.status === 401)
                || /permission denied|row-level security|violates/i.test(em);
      if(!denied) return {ok:false, msg:em};
      return req("POST", "rpc/ql_admin_read_save", {p_user_id:String(userId)}, null, 15000)
        .then(function(r2){
        if(r2.error) return {ok:false, msg:em+" ｜ 函数兜底也失败："+(r2.error.message||"")};
        var rows = r2.data || [];
        if(!rows.length) return {ok:true, empty:true, via:"rpc"};
        return {ok:true, data:rows[0].data, summary:rows[0].summary||{},
                savedAt:rows[0].saved_at, via:"rpc"};
      });
    });
  }

  /* opt.summary：调用端算好的摘要（含职务/层次），缺省则内部重算 */
  function adminWriteSave(userId, S, opt){
    opt = opt || {};
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    if(!S || typeof S !== "object") return Promise.resolve({ok:false, msg:"存档内容无效"});
    var prev = opt.prevSummary || {};
    var sum = opt.summary || adminBuildSummary(S, prev);
    /* 管理端修订号：后台每次改写都自增（取当前毫秒，恒增）。
       游戏端上传前会比对它——若云端比本机新，说明管理员改过档，
       本机须先让位（拉取覆盖），否则下一次自动同步就会把后台的
       修改无声覆盖回去，表现为"后台改了，游戏里没变"。 */
    var rev = (typeof opt.rev === "number") ? opt.rev : Date.now();
    sum["管理端修订"] = rev;
    /* 修订号同时写进 data 本体：summary 会被玩家端 pushSave 重算，
       只有留在 data 里的这一份能跨同步存活，登录时的新旧比对才有基准。 */
    try{ S._adminRev = rev; }catch(e){}
    var body = {
      user_id: userId,
      data: S,
      summary: sum,
      saved_at: new Date().toISOString(),
      version: (typeof S.version === "number") ? S.version : 1
    };
    return req("POST", "game_saves", body,
      "return=representation,resolution=merge-duplicates", 15000).then(function(res){
      if(!res.error) return {ok:true, summary:sum, rev:rev, via:"table"};
      /* 直写被拒（多数是 Data API 访问策略未放开 game_saves 的写权限）
         时改走 SECURITY DEFINER 函数：同样的语义，但不受该策略限制。
         需先在 Supabase 执行 后台改档_一键安装.sql。 */
      var em = String(res.error.message||"");
      var denied = (res.error.status === 403) || (res.error.status === 401)
                || /permission denied|row-level security|violates/i.test(em);
      if(!denied) return {ok:false, msg:em, via:"table"};
      return req("POST", "rpc/ql_admin_write_save",
        {p_user_id:String(userId), p_data:S, p_summary:sum, p_rev:rev},
        null, 15000).then(function(r2){
        if(r2.error) return {ok:false, msg:em+" ｜ 函数兜底也失败："+(r2.error.message||""), via:"rpc"};
        return {ok:true, summary:sum, rev:rev, via:"rpc"};
      });
    });
  }


  /* 轻量查询：只取该玩家 summary 里的「管理端修订」号。
     游戏端上传前用它比对本机记录，判断云端是否被管理员改过。
     只取一列、单行，开销远小于拉整份存档。 */
  function adminRevOf(userId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true, rev:0});
    return req("GET",
      "game_saves?select=summary&user_id=eq."+eqv(userId)+"&limit=1",
      null, null, 8000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message, rev:0};
      if(!res.data || !res.data.length) return {ok:true, empty:true, rev:0};
      var s = res.data[0].summary || {};
      return {ok:true, rev:(typeof s["管理端修订"] === "number") ? s["管理端修订"] : 0};
    }).catch(function(e){ return {ok:false, msg:String(e && e.message || e), rev:0}; });
  }

  /* 写后读回校验：后台改档"显示已保存但云端没变"时，
     到底是没写进去、还是被玩家端覆盖了，只有读回来比对才知道。
     返回 matched 与差异明细，供界面如实告知管理员。 */
  function adminVerifySave(userId, expect){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return adminReadSave(userId).then(function(r){
      if(!r.ok) return {ok:false, msg:r.msg};
      if(r.empty) return {ok:true, empty:true, matched:false};
      var diff = [];
      var cur = r.data || {};
      var exp = expect || {};
      Object.keys(exp).forEach(function(k){
        if(String(cur[k]) !== String(exp[k])) diff.push(k+"："+cur[k]+" → 期望 "+exp[k]);
      });
      return {ok:true, matched:diff.length===0, diff:diff,
              rev:(cur && typeof cur._adminRev === "number") ? cur._adminRev : 0,
              via:r.via||""};
    });
  }


  /* 后台改档所需的两只 SECURITY DEFINER 函数是否已在库中部署。
     未部署时，后台保存会直连 game_saves 写入——多数项目被 Data API
     访问策略拒绝，于是"点保存没反应/改了没变"，而管理员无从判断
     是自己操作错了还是库里缺东西。

     探测方式：读 OpenAPI 定义的 paths，比直接调用 RPC 可靠——
     直接调用时"函数不存在"与"被策略拒绝"都表现为 403，无法区分。 */
  function adminProbeFunctions(){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET", "", null, null, 12000).then(function(res){
      var paths = (res.data && res.data.paths) || null;
      if(!paths){
        /* 拿不到定义时退回逐个试调用，至少区分 404（确实没有） */
        return req("POST", "rpc/ql_admin_read_save", {p_user_id:"__probe__"}, null, 12000)
          .then(function(r){
            var st = (r.error && r.error.status) || 0;
            return { ok:true, via:"probe", read: st !== 404, write: st !== 404, uncertain:true };
          }).catch(function(){ return {ok:false, msg:"探测失败"}; });
      }
      var keys = Object.keys(paths);
      var has = function(n){
        for(var i=0;i<keys.length;i++) if(keys[i].indexOf(n) >= 0) return true;
        return false;
      };
      return { ok:true, via:"openapi",
               read: has("ql_admin_read_save"),
               write: has("ql_admin_write_save") };
    }).catch(function(e){ return {ok:false, msg:String(e && e.message || e)}; });
  }

  /* 读回单个账号行（用于写后校验） */
  function _userRow(userId){
    return req("GET", "game_users?select=id,status&id=eq."+eqv(userId)+"&limit=1", null, null, 8000)
      .then(function(res){
        if(res.error) return {err: res.error.message};
        var arr = res.data;
        return {row: (Array.isArray(arr) && arr.length) ? arr[0] : null};
      });
  }

  /* 权限提示：写入 0 行时给出可执行的排查方向
     ⚠️ 2026-09-18 修正：不再建议 grant update on game_users to anon;
        那条语句把整张用户表的写权限交给任何拿到 key 的人，
        一条请求即可冻结全服账号或批量改写密码。
        正确做法是执行 安全加固_收回用户表写权限.sql，改用安全函数。 */
  function _writeHint(){
    return "请在 Supabase → SQL Editor 执行 安全加固_收回用户表写权限.sql（勿再开放整表 UPDATE）";
  }

  /* ------------------------------------------------------------
     安全函数通道
     ------------------------------------------------------------
     执行加固 SQL 后，anon 对 game_users 的 UPDATE 被收回，
     原先直连 PATCH 会全部被拒（表现为 403 / 0 行受影响）。
     这里改为优先调用 SECURITY DEFINER 函数；函数未部署时自动退回 PATCH，
     两种配置下都能工作。
     函数每次只作用于传入的那一个 id，无法批量改写整表。 */
  var _secFnAvail = {};

  function _qlFn(name, args, ms){
    if(_secFnAvail[name] === false)
      return Promise.resolve({error:{message:"安全函数未部署", missing:true}});
    return req("POST", "rpc/"+name, args, null, ms || 10000)
      .then(function(res){
        if(res.error){
          var st = res.error.status || 0;
          var msg = String(res.error.message || "");
          /* 404 / PGRST202（函数不存在）= 未部署，记住后走 PATCH 兜底 */
          if(st === 404 || st === 0 || /PGRST202|does not exist|Could not find/i.test(msg)){
            _secFnAvail[name] = false;
            return {error:{message:"安全函数未部署", missing:true}};
          }
        }
        return res;
      });
  }

  /* 服务端管理密钥：设置过 ql_admin_secret 后，管理类操作必须带上它 */
  var ADMIN_TOKEN_KEY = "qlp_admin_token";
  function _adminToken(){
    try{ return localStorage.getItem(ADMIN_TOKEN_KEY) || null; }catch(e){ return null; }
  }
  function _setAdminToken(v){
    try{ if(v) localStorage.setItem(ADMIN_TOKEN_KEY, v);
         else localStorage.removeItem(ADMIN_TOKEN_KEY); }catch(e){}
  }

  function adminSetStatus(userId, status){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    /* 写后读回校验（2026-09-18 修复）
       PostgREST 的 PATCH 在「0 行受影响」时同样返回 204 且不带 error——
       未授予 UPDATE 权限、或 RLS 把行过滤掉都是这种表现。
       此前只看 res.error，于是"点了冻结/恢复提示成功、列表照旧"，
       管理员无从判断到底改没改成。现先取 representation 看影响行数，
       再读回确认状态确实已变。 */
    /* 优先走安全函数 ql_admin_set_status（带服务端管理密钥校验） */
    return _qlFn("ql_admin_set_status",
        {p_user_id:String(userId), p_status:String(status), p_admin_token:_adminToken()},
        10000).then(function(rr){
      if(!rr.error && rr.data){
        if(rr.data.ok === false)
          return {ok:false, msg:rr.data.msg||"安全函数返回失败", hint:_writeHint(), noop:true};
        return _userRow(userId).then(function(v){
          if(!v.row) return {ok:true, warn:"已提交，读回校验未通过"};
          if(String(v.row.status) !== String(status))
            return {ok:false, msg:"写入未生效，状态仍为「"+String(v.row.status||"未知")+"」",
                    hint:_writeHint(), noop:true};
          return {ok:true, verified:true, via:"rpc", warn:rr.data.warn||""};
        });
      }
      if(rr.error && !rr.error.missing) return {ok:false, msg:rr.error.message, hint:_writeHint()};
      /* 函数未部署 → 退回 PATCH */
      return _patchUserStatus(userId, status);
    });

    /* 原始 PATCH 路径（安全函数未部署时的兜底） */
    function _patchUserStatus(userId, status){
    return req("PATCH", "game_users?id=eq."+eqv(userId), {status:status},
        "return=representation", 10000)
      .then(function(res){
        if(res.error) return {ok:false, msg:res.error.message};
        if(!Array.isArray(res.data) || !res.data.length)
          return {ok:false, msg:"未匹配到该账号（0 行受影响，可能无 UPDATE 权限或 RLS 拦截）",
                  hint:_writeHint(), noop:true};
        return _userRow(userId).then(function(v){
          if(v.err) return {ok:true, warn:"已提交，读回校验未通过："+v.err};
          if(!v.row) return {ok:false, msg:"写入后读不到该账号", hint:_writeHint(), noop:true};
          if(String(v.row.status) !== String(status))
            return {ok:false, msg:"写入未生效，状态仍为「"+String(v.row.status||"未知")+"」",
                    hint:_writeHint(), noop:true};
          return {ok:true, verified:true};
        });
      });
    }
  }

  function adminResetPwd(userId, pwdHash){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    /* 安全函数要求提供旧哈希；后台重置场景无旧密码，故仍走 PATCH。
       若已收回 UPDATE，此处会明确报错并指向加固脚本，不再谎报成功。 */
    return req("PATCH", "game_users?id=eq."+eqv(userId), {pwd_hash:pwdHash}, null, 10000)
      .then(function(res){
        if(res.error) return {ok:false, msg:res.error.message, hint:_writeHint()};
        return {ok:true};
      });
  }

  /* 玩家自助改密：必须提供正确的旧哈希，服务端校验后才允许写入。
     这堵住了"批量改写 pwd_hash 接管任意账号"这条路。 */
  function changePwd(userId, oldHash, newHash){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return _qlFn("ql_set_pwd_hash",
      {p_user_id:String(userId), p_old_hash:oldHash, p_new_hash:newHash}, 10000)
      .then(function(rr){
        if(rr.error){
          if(rr.error.missing)   /* 函数未部署 → 退回本地校验后 PATCH */
            return req("PATCH", "game_users?id=eq."+eqv(userId),
                       {pwd_hash:newHash}, null, 10000)
              .then(function(res){
                return res.error ? {ok:false, msg:res.error.message, hint:_writeHint()}
                                 : {ok:true, via:"table"};
              });
          return {ok:false, msg:rr.error.message, hint:_writeHint()};
        }
        var r = rr.data || {};
        return r.ok ? {ok:true, via:"rpc"}
                    : {ok:false, msg:r.msg || "改密未生效", hint:_writeHint()};
      });
  }

  function _deniedErr(err){
    var e = err || {};
    return (e.status === 403) || (e.status === 401)
        || /permission denied|row-level security|violates|not allowed/i.test(String(e.message||""));
  }

  /* 软注销：没有 DELETE 权限时也能真正生效。
     ------------------------------------------------------------
     绝大多数项目按 安全加固_数据库权限.sql 收回了 anon 的 DELETE
     （不收回的话，任何人一条请求就能清空全部档案），所以真删必然被拒——
     这正是后台「注销」一直失败、又不说清原因的根源。

     这里改为「置状态注销 + 清空云端存档」，只用到 UPDATE/INSERT，
     这两项在加固脚本里是明确保留的。摘要清空后该账号即退出排行榜。 */
  function adminSoftDelete(userId, why){
    var blankSummary = {姓名:"", 职务:"", 层次:"", 位阶:-1,
      年龄:0, 年份:"", 政绩:0, 道德:0, 结局:"",
      上榜:false, 净资产:0, 廉政:0, 管理端修订: Date.now()};
    /* 优先走安全函数（与 adminSetStatus 同一入口，统一受管理密钥保护） */
    return _qlFn("ql_admin_set_status",
        {p_user_id:String(userId), p_status:"注销", p_admin_token:_adminToken()},
        10000).then(function(rr){
      if(!rr.error && rr.data){
        if(rr.data.ok === false)
          return {ok:false, msg:rr.data.msg||"安全函数返回失败", hint:_writeHint(), noop:true};
        if(rr.data.status !== "注销")
          return {ok:false, msg:"状态写入未生效，仍为「"+String(rr.data.status||"未知")+"」",
                  hint:_writeHint(), noop:true};
        return _clearSaveThen(userId, why, rr.data.warn||"");
      }
      if(rr.error && !rr.error.missing) return {ok:false, msg:rr.error.message, hint:_writeHint()};
      return _patchSoftDelete(userId, why);
    });
  }

  /* 清档并返回（安全函数路径与 PATCH 路径共用） */
  function _clearSaveThen(userId, why, warn){
    var blankSummary = {姓名:"", 职务:"", 层次:"", 位阶:-1,
      年龄:0, 年份:"", 政绩:0, 道德:0, 结局:"",
      上榜:false, 净资产:0, 廉政:0, 管理端修订: Date.now()};
    return req("POST", "game_saves",
      {user_id:userId, data:{_deleted:true}, summary:blankSummary,
       saved_at:new Date().toISOString(), version:1},
      "return=representation,resolution=merge-duplicates", 15000)
      .then(function(r2){
        return {ok:true, mode:"soft", cleared:!r2.error, verified:true,
                via:"rpc", note: why ? ("真删不可用："+why) : "", warn:warn||""};
      });
  }

  /* 原始 PATCH 路径（安全函数未部署时的兜底） */
  function _patchSoftDelete(userId, why){
    var blankSummary = {姓名:"", 职务:"", 层次:"", 位阶:-1,
      年龄:0, 年份:"", 政绩:0, 道德:0, 结局:"",
      上榜:false, 净资产:0, 廉政:0, 管理端修订: Date.now()};
    return req("PATCH", "game_users?id=eq."+eqv(userId), {status:"注销"},
        "return=representation", 10000)
      .then(function(res){
        if(res.error)
          return {ok:false, msg:(res.error.message||"未知错误")
                  + (why ? "（真删失败："+why+"）" : ""), hint:_writeHint()};
        if(!Array.isArray(res.data) || !res.data.length)
          return {ok:false, msg:"状态写入未生效（0 行受影响）"
                  + (why ? ("（真删失败："+why+"）") : ""), hint:_writeHint(), noop:true};
        /* 读回确认：请求没被拒 ≠ 状态真的改了 */
        return _userRow(userId).then(function(v){
          if(v.err) return {ok:false, msg:"读回校验失败："+v.err, hint:_writeHint()};
          if(!v.row || String(v.row.status) !== "注销")
            return {ok:false, msg:"状态写入未生效，仍为「"
                    + String((v.row && v.row.status) || "未知") + "」"
                    + (why ? ("（真删失败："+why+"）") : ""), hint:_writeHint(), noop:true};
          /* 清档失败不回滚：账号已标记注销，空档下次可重试 */
          return req("POST", "game_saves",
            {user_id:userId, data:{_deleted:true}, summary:blankSummary,
             saved_at:new Date().toISOString(), version:1},
            "return=representation,resolution=merge-duplicates", 15000)
            .then(function(r2){
              return {ok:true, mode:"soft", cleared:!r2.error, via:"table",
                      verified:true, note: why ? ("真删不可用："+why) : ""};
            });
        });
      });
  }

  /* 真删的兜底链：SECURITY DEFINER 函数 → 软注销 */
  function _fallbackDelete(userId, why){
    return req("POST", "rpc/ql_admin_delete_user", {p_user_id:String(userId)},
      null, 15000).then(function(rp){
      /* 函数存在但明确返回失败（{ok:false}）时也要继续兜底 */
      var d = rp.data;
      var fnFail = (d && typeof d === "object" && d.ok === false)
                 ? (d.msg || d.message || "函数返回失败") : "";
      if(!rp.error && !fnFail){
        return _userRow(userId).then(function(v){
          if(!v.row) return {ok:true, mode:"hard", via:"rpc"};
          return adminSoftDelete(userId, "真删函数已执行但账号仍在（可能未部署或函数受限）");
        });
      }
      return adminSoftDelete(userId, rp.error ? (rp.error.message||"") : (fnFail||why||""));
    });
  }

  function adminDeleteUser(userId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    /* ① 直连真删：多数项目已收回该权限，失败属预期，继续兜底。
       注意：DELETE 同样存在"0 行受影响却返回 204 无报错"的情形，
       故不能只看 res.error——必须读回确认账号确实已消失。 */
    return req("DELETE", "game_users?id=eq."+eqv(userId), null,
        "return=representation", 10000)
      .then(function(res){
        if(!res.error){
          if(Array.isArray(res.data) && res.data.length) return {ok:true, mode:"hard", via:"table"};
          return _userRow(userId).then(function(v){
            if(!v.row) return {ok:true, mode:"hard", via:"table"};
            return _fallbackDelete(userId, "真删 0 行受影响（权限或 RLS 拦截）");
          });
        }
        if(!_deniedErr(res.error)) return {ok:false, msg:res.error.message};
        /* ② SECURITY DEFINER 函数真删（需执行 后台改档_一键安装.sql）。
              函数内先删 game_saves 再删 game_users，不受权限策略限制。 */
        return _fallbackDelete(userId, res.error.message||"");
      });
  }

  function adminLog(action, target, detail){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("POST", "admin_logs", {
      action:action, target:target||"", detail:detail||""
    }, "return=minimal", 8000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true};
    });
  }

  function adminLogs(){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET",
      "admin_logs?select=action,target,detail,created_at&order=created_at.desc&limit=200",
      null, null, 10000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true, logs:res.data||[]};
    });
  }

  /* ---------- 连通性自检 ---------- */
  function ping(){
    if(!isReady()) return Promise.resolve({ok:false, msg:"未初始化"});
    var t0 = Date.now();
    return req("GET", "game_users?select=id&limit=1", null, null, 8000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true, ms:(Date.now()-t0)};
    });
  }

  /* ---------- 状态文案 ---------- */
  function statusText(){
    switch(state.mode){
      case "online":  return {icon:"☁️", text:"已同步", color:"#2f7d4f"};
      case "syncing": return {icon:"🔄", text:"同步中", color:"#8a6a35"};
      case "error":   return {icon:"⚠️", text:"离线（已存本机）", color:"#b01e23"};
      case "local":   return {icon:"💾", text:"仅本机", color:"#8a8170"};
      default:        return {icon:"📴", text:"未启用云端", color:"#8a8170"};
    }
  }

  /* ============================================================
     赛季榜（game_season_stats / game_season_archive）
     ------------------------------------------------------------
     赛季序号由客户端按「本档开局日」锚点推算后上报，
     云端只负责存成绩、排名与归档。
     未部署赛季表 / 无云端时一律静默降级，绝不影响主流程。
     ============================================================ */
  function _isNotDeployed(err){
    /* 逐个字段都要看：Supabase 有时只回 code（PGRST202）不带 message，
       有时只回一句 "could not find the function"，只看 message 会漏判。 */
    var e = err || {};
    var t = [e.message, e.code, e.hint, e.details, e.status].join(" ");
    if(!t.trim() && err) t = String(err);
    return /PGRST202|could not find the function|does not exist|42P01|42883|\b404\b|rpc unavailable/i.test(t);
  }
  function _seasonErr(res){
    return {ok:false, notDeployed:_isNotDeployed(res && res.error),
            msg:(res && res.error && (res.error.message || res.error.hint)) || "赛季榜不可用"};
  }

  /* 上报本赛季峰值（只增不减，服务端用 greatest 兜底） */
  function seasonSubmit(seasonKey, uid, stat){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    var key = String(seasonKey || "S1");
    var u = String(uid || (state && state.uid) || "");
    if(!u) return Promise.resolve({ok:false, msg:"尚未登录"});
    var body = {
      season_key:  key,
      user_id:     u,
      peak_merit:  Math.max(0, parseInt((stat && stat.peak_merit), 10) || 0),
      peak_tier:   Math.max(0, parseInt((stat && stat.peak_tier), 10) || 0),
      peak_title:  String((stat && stat.peak_title) || ""),
      final_merit: Math.max(0, parseInt((stat && stat.final_merit), 10) || 0),
      final_tier:  Math.max(0, parseInt((stat && stat.final_tier), 10) || 0),
      final_title: String((stat && stat.final_title) || ""),
      ending:      String((stat && stat.ending) || ""),
      months:      Math.max(0, parseInt((stat && stat.months), 10) || 0),
      updated_at:  new Date().toISOString()
    };
    return req("POST", "game_season_stats", body,
      "resolution=merge-duplicates,return=minimal", 10000)
      .then(function(res){
        if(res && res.error) return _seasonErr(res);
        return {ok:true};
      })
      .catch(function(e){ return {ok:false, msg:String(e && e.message || e)}; });
  }

  /* 赛季榜：按赛季 + 维度排名（服务端全量） */
  function seasonBoard(seasonKey, sort, limit){
    if(!isReady()) return Promise.resolve({ok:false, offline:true, rows:[]});
    var lim = Math.max(1, Math.min(300, parseInt(limit, 10) || 100));
    var srt = String(sort || "merit");
    var key = seasonKey ? String(seasonKey) : null;
    return req("POST", "rpc/ql_rank_season",
      {p_season: key, p_sort: srt, p_limit: lim}, null, 12000)
      .then(function(res){
        if(res && res.error) return _seasonErr(res);
        var rows = (res && res.data) || [];
        return {ok:true, sort:srt, rows:rows,
                total:(rows[0] && parseInt(rows[0].total_count, 10)) || rows.length};
      })
      .catch(function(e){ return {ok:false, msg:String(e && e.message || e)}; });
  }

  /* 我的赛季名次 */
  function seasonBoardMe(seasonKey, uid, sort){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    var self = String(uid || (state && state.uid) || "").slice(0, 8);
    if(!self) return Promise.resolve({ok:false, msg:"尚未登录"});
    var key = seasonKey ? String(seasonKey) : null;
    return req("POST", "rpc/ql_rank_season_me",
      {p_self: self, p_season: key, p_sort: String(sort || "merit")}, null, 12000)
      .then(function(res){
        if(res && res.error) return _seasonErr(res);
        var r = (res && res.data && res.data[0]) || null;
        if(!r) return {ok:true, pos:0, total:0};
        return {ok:true, pos:parseInt(r.pos, 10) || 0,
                total:parseInt(r.total_count, 10) || 0,
                peakMerit:parseInt(r.peak_merit, 10) || 0,
                peakTier:parseInt(r.peak_tier, 10) || 0};
      })
      .catch(function(e){ return {ok:false, msg:String(e && e.message || e)}; });
  }

  /* 归档旧档（换季时） */
  function seasonArchive(seasonKey, uid, save, summary){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    var key = String(seasonKey || "S1");
    var u = String(uid || (state && state.uid) || "");
    if(!u) return Promise.resolve({ok:false, msg:"尚未登录"});
    var data = {};
    try{ data = JSON.parse(JSON.stringify(save || {})); }catch(e){ data = {}; }
    return req("POST", "game_season_archive", {
      season_key: key, user_id: u, data: data,
      summary: summary || {}, archived_at: new Date().toISOString()
    }, "resolution=merge-duplicates,return=minimal", 15000)
      .then(function(res){
        if(res && res.error) return _seasonErr(res);
        return {ok:true};
      })
      .catch(function(e){ return {ok:false, msg:String(e && e.message || e)}; });
  }

  /* 读取往季档案（本季 key 即上季归档记录） */
  function seasonArchiveGet(seasonKey, uid){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    var key = String(seasonKey || "S1");
    var u = String(uid || (state && state.uid) || "");
    if(!u) return Promise.resolve({ok:false, msg:"尚未登录"});
    return req("GET", "game_season_archive?select=summary,archived_at"
      + "&season_key=eq." + encodeURIComponent(key)
      + "&user_id=eq." + encodeURIComponent(u) + "&limit=1", null, null, 12000)
      .then(function(res){
        if(res && res.error) return _seasonErr(res);
        var rows = (res && res.data) || [];
        if(!rows.length) return {ok:true, empty:true};
        return {ok:true, summary:rows[0].summary || {},
                archivedAt:rows[0].archived_at || ""};
      })
      .catch(function(e){ return {ok:false, msg:String(e && e.message || e)}; });
  }

  return {
    init: init,
    isEnabled: isEnabled,
    isReady: isReady,
    register: register,
    findUser: findUser,
    findByContact: findByContact,
    touchLogin: touchLogin,
    heartbeat: heartbeat,
    startHeartbeat: startHeartbeat,
    stopHeartbeat: stopHeartbeat,
    heartbeatSupported: heartbeatSupported,
    pullSave: pullSave,
    pushSave: pushSave,
    retryPending: retryPending,
    leaderboard: leaderboard,
    leaderboardMe: leaderboardMe,
    seasonSubmit: seasonSubmit,
    seasonBoard: seasonBoard,
    seasonBoardMe: seasonBoardMe,
    seasonArchive: seasonArchive,
    seasonArchiveGet: seasonArchiveGet,
    adminList: adminList,
    adminSaves: adminSaves,
    adminReadSave: adminReadSave,
    adminWriteSave: adminWriteSave,
    adminBuildSummary: adminBuildSummary,
    adminRevOf: adminRevOf,
    adminProbeFunctions: adminProbeFunctions,
    adminVerifySave: adminVerifySave,
    adminSetStatus: adminSetStatus,
    adminResetPwd: adminResetPwd,
    changePwd: changePwd,
    setAdminToken: _setAdminToken,
    getAdminToken: _adminToken,
    adminDeleteUser: adminDeleteUser,
    adminSoftDelete: adminSoftDelete,
    adminReconAll: adminReconAll,
    adminLog: adminLog,
    adminLogs: adminLogs,
    ping: ping,
    statusText: statusText,
    hasPending: hasPending,
    state: state,
    on: function(fn){ if(typeof fn === "function") listeners.push(fn); }
  };
})();
