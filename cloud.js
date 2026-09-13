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
          req("PATCH", "game_users?id=eq."+eqv(userId), {
            login_count: (r.data[0].login_count||0) + 1,
            last_login_at: new Date().toISOString()
          }, null, 8000);
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
  function buildSummary(S){
    try{
      return {
        姓名: S.name || "",
        职务: (typeof rankTitle === "function") ? rankTitle(S.rank) : "",
        年龄: S.age || 0,
        年份: (S.year||0) + "年" + (S.month||0) + "月",
        政绩: Math.round(S.政绩||0),
        道德: Math.round(S.道德||0),
        结局: S.ending || ""
      };
    }catch(e){ return {}; }
  }

  function pushSave(userId, S){
    if(!isReady()){ markPending(); return Promise.resolve({ok:false, offline:true}); }
    setState("syncing");
    /* upsert：PostgREST 用 POST + resolution=merge-duplicates 实现。
       注意 jsonb 字段直接传对象，JSON.stringify 后即为其值。 */
    return req("POST", "game_saves", {
      user_id: userId,
      data: S,
      summary: buildSummary(S),
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



  function adminSetStatus(userId, status){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("PATCH", "game_users?id=eq."+eqv(userId), {status:status}, null, 10000)
      .then(function(res){
        if(res.error) return {ok:false, msg:res.error.message};
        return {ok:true};
      });
  }

  function adminResetPwd(userId, pwdHash){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("PATCH", "game_users?id=eq."+eqv(userId), {pwd_hash:pwdHash}, null, 10000)
      .then(function(res){
        if(res.error) return {ok:false, msg:res.error.message};
        return {ok:true};
      });
  }

  function adminDeleteUser(userId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    // 存档表设了 on delete cascade，删用户即连带清档
    return req("DELETE", "game_users?id=eq."+eqv(userId), null, null, 10000)
      .then(function(res){
        if(res.error) return {ok:false, msg:res.error.message};
        return {ok:true};
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
    adminList: adminList,
    adminSaves: adminSaves,
    adminSetStatus: adminSetStatus,
    adminResetPwd: adminResetPwd,
    adminDeleteUser: adminDeleteUser,
    adminLog: adminLog,
    adminLogs: adminLogs,
    ping: ping,
    statusText: statusText,
    hasPending: hasPending,
    state: state,
    on: function(fn){ if(typeof fn === "function") listeners.push(fn); }
  };
})();
