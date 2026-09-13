/* ============================================================
   云端存档同步（Supabase）
   ------------------------------------------------------------
   设计原则：**云永远不能拖垮本地**。

   游戏原本是纯 localStorage 单机网页。接入云端后，若网络不通
   （国内访问海外 Supabase 延迟 250–800ms，晚高峰可能超时），
   游戏必须照常能玩——进度先存本地，联网后再补传。

   因此：
     ① 所有云调用均异步，失败静默降级，绝不阻塞游戏流程
     ② 本地始终写入，云端作为一份可恢复的副本
     ③ 登录时双向比对，取较新的一份（防止换设备后进度倒退）
     ④ 未上传的进度进入待同步队列，联网后自动重试
   ============================================================ */
var Cloud = (function(){

  var URL = "", KEY = "", client = null, ready = false;
  var CFG_KEY = "qlp_cloud_cfg";
  var PENDING_KEY = "qlp_cloud_pending";
  var state = {
    mode: "off",        // off / local / online / syncing / error
    lastError: "",
    lastSyncAt: null,
    pending: false
  };
  var listeners = [];

  /* ---------- 状态通知 ---------- */
  function emit(){
    for(var i=0;i<listeners.length;i++){
      try{ listeners[i](state); }catch(e){}
    }
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

  /* ---------- 初始化 ---------- */
  /* 兼容两种调用：init({url,key}) 与 init(url, key)。
     此前的缺陷：只认对象形式，而调用方（initCloudAuto）写的是
     Cloud.init(cfg.url, cfg.key)——
     opts 收到的是字符串，opts.url 恒为 undefined，
     于是永远走不到配置分支，静默 setState("off") 返回 false。
     结果：即便填了 URL 和 key，云端也永远启用不了，
     且不报任何错，极难察觉。 */
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
    if(typeof window.supabase === "undefined" || !window.supabase.createClient){
      setState("error", "Supabase 客户端未加载");
      return false;
    }
    try{
      client = window.supabase.createClient(cfg.url, cfg.key, {
        auth:{ persistSession:false }
      });
      URL = cfg.url; KEY = cfg.key;
      ready = true;
      setState(state.pending ? "syncing" : "online");
      return true;
    }catch(e){
      ready = false;
      setState("error", e.message || "初始化失败");
      return false;
    }
  }

  function isReady(){ return ready && !!client; }
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

  /* ---------- 超时包装 ----------
     国内跨境访问可能长时间无响应，不能让玩家干等。 */
  function withTimeout(promise, ms){
    ms = ms || 8000;
    return new Promise(function(resolve, reject){
      var done = false;
      var t = setTimeout(function(){
        if(!done){ done = true; reject(new Error("请求超时")); }
      }, ms);
      promise.then(function(r){
        if(!done){ done = true; clearTimeout(t); resolve(r); }
      }, function(e){
        if(!done){ done = true; clearTimeout(t); reject(e); }
      });
    });
  }

  /* ============================================================
     注册
     ============================================================ */
  function register(empId, name, contact, pwdHash){
    if(!isReady()) return Promise.resolve({ok:false, offline:true, msg:"云端未启用，仅保存在本机。"});
    return withTimeout(
      client.from("game_users").insert({
        emp_id: empId,
        name: name || "",
        contact: contact || "",
        pwd_hash: pwdHash,
        status: "正常",
        login_count: 0
      }).select().single()
    ).then(function(res){
      if(res.error){
        // 工号重复是最常见的失败，须给出可行动的提示
        if(res.error.code === "23505"){
          return {ok:false, msg:"该工号已被注册，请换一个。"};
        }
        return {ok:false, msg:"建档失败：" + (res.error.message||"未知错误")};
      }
      return {ok:true, user:res.data};
    }).catch(function(e){
      return {ok:false, offline:true, msg:"云端不可达，已仅保存在本机。"};
    });
  }

  /* ============================================================
     登录：逐字段取回，避免 select * 在表结构变化后报错
     ============================================================ */
  function findUser(empId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("game_users")
        .select("id,emp_id,name,contact,pwd_hash,status,created_at,login_count")
        .eq("emp_id", empId)
        .limit(1)
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      if(!res.data || !res.data.length) return {ok:false, notFound:true};
      return {ok:true, user:res.data[0]};
    }).catch(function(e){
      return {ok:false, offline:true, msg:"云端不可达"};
    });
  }

  /* 按联系方式查找 —— 与游戏内 findUser(contact) 保持一致。
     游戏登录用的是联系方式而非工号，云端若按 emp_id 查会对不上。 */
  function findByContact(contact){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("game_users")
        .select("id,emp_id,name,contact,pwd_hash,status,created_at,login_count")
        .eq("contact", contact)
        .limit(1)
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      if(!res.data || !res.data.length) return {ok:false, notFound:true};
      return {ok:true, user:res.data[0]};
    }).catch(function(e){
      return {ok:false, offline:true, msg:"云端不可达"};
    });
  }

  /* 登录成功后的回执：更新登录次数与时间 */
  function touchLogin(userId){
    if(!isReady()) return;
    try{
      // 先用 rpc 递增最稳妥；此处退化为读-改-写，登录场景并发极低，可接受
      client.from("game_users").select("login_count")
        .eq("id", userId).single()
        .then(function(r){
          if(r.error || !r.data) return;
          client.from("game_users").update({
            login_count: (r.data.login_count||0) + 1,
            last_login_at: new Date().toISOString()
          }).eq("id", userId).then(function(){});
        });
    }catch(e){}
  }

  /* ============================================================
     存档：拉取 / 上传
     ============================================================ */
  function pullSave(userId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("game_saves").select("data,saved_at,version")
        .eq("user_id", userId).limit(1)
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      if(!res.data || !res.data.length) return {ok:true, empty:true};
      return {ok:true, data:res.data[0].data, savedAt:res.data[0].saved_at};
    }).catch(function(e){
      return {ok:false, offline:true, msg:"云端不可达"};
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
    return withTimeout(
      client.from("game_saves").upsert({
        user_id: userId,
        data: S,
        summary: buildSummary(S),
        saved_at: new Date().toISOString(),
        version: 1
      }, { onConflict: "user_id" }), 10000
    ).then(function(res){
      if(res.error){ markPending(); setState("error", res.error.message); return {ok:false, msg:res.error.message}; }
      clearPending();
      state.lastSyncAt = Date.now();
      setState("online");
      return {ok:true};
    }).catch(function(e){
      markPending();
      setState("error", "网络不通，进度已存本机");
      return {ok:false, offline:true};
    });
  }

  /* ---------- 联网重试 ---------- */
  function retryPending(userId, S){
    if(!isReady() || !hasPending()) return Promise.resolve({ok:false, nothing:true});
    return pushSave(userId, S);
  }

  /* ============================================================
     后台：用户列表 / 处置 / 日志
     ------------------------------------------------------------
     后台需要读全部用户，anon key 在 RLS 允许下可读。
     但**注销与删档属于高危操作**，此处同样调用，
     依赖服务端 RLS 收敛权限——若你收紧了 RLS，
     这些调用会失败并提示，不会静默改坏数据。
     ============================================================ */
  function adminList(){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("game_users")
        .select("id,emp_id,name,contact,status,created_at,login_count,last_login_at")
        .order("last_login_at", {ascending:false, nullsFirst:false})
        .limit(500), 10000
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true, users:res.data||[]};
    }).catch(function(e){
      return {ok:false, offline:true};
    });
  }

  function adminSetStatus(userId, status){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("game_users").update({status:status}).eq("id", userId)
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true};
    }).catch(function(e){ return {ok:false, offline:true}; });
  }

  function adminResetPwd(userId, pwdHash){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("game_users").update({pwd_hash:pwdHash}).eq("id", userId)
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true};
    }).catch(function(e){ return {ok:false, offline:true}; });
  }

  function adminDeleteUser(userId){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    // 存档表设了 on delete cascade，删用户即连带清档
    return withTimeout(
      client.from("game_users").delete().eq("id", userId)
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true};
    }).catch(function(e){ return {ok:false, offline:true}; });
  }

  function adminLog(action, target, detail){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("admin_logs").insert({
        action:action, target:target||"", detail:detail||""
      })
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true};
    }).catch(function(e){ return {ok:false, offline:true}; });
  }

  function adminLogs(){
    if(!isReady()) return Promise.resolve({ok:false, offline:true});
    return withTimeout(
      client.from("admin_logs").select("action,target,detail,created_at")
        .order("created_at", {ascending:false}).limit(200)
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true, logs:res.data||[]};
    }).catch(function(e){ return {ok:false, offline:true}; });
  }

  /* ---------- 连通性自检 ---------- */
  function ping(){
    if(!isReady()) return Promise.resolve({ok:false, msg:"未初始化"});
    var t0 = Date.now();
    return withTimeout(
      client.from("game_users").select("id").limit(1), 8000
    ).then(function(res){
      if(res.error) return {ok:false, msg:res.error.message};
      return {ok:true, ms:(Date.now()-t0)};
    }).catch(function(e){
      return {ok:false, msg:"超时或不可达"};
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
