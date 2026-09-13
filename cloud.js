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
  function adminList(){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return req("GET",
      "game_users?select=id,emp_id,name,contact,status,created_at,login_count,last_login_at"
      + "&order=last_login_at.desc.nullslast&limit=500", null, null, 12000).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true, users:res.data||[]};
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
    pullSave: pullSave,
    pushSave: pushSave,
    retryPending: retryPending,
    adminList: adminList,
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
