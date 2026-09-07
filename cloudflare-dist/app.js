// 月历看板 + 登录 + 黑名单管理

// FC 后端 API 地址。前端托管在 Cloudflare Pages，跨域调用此地址。
// 本地用 dashboard.py 时也走这个地址（已开 CORS）。
const API_BASE = "https://sign-bprgxfyexe.cn-beijing.fcapp.run";

const STATUS = {
  ok:           { cls: "d-ok",      text: "已签到" },
  not_yet:      { cls: "d-pending", text: "未到点" },
  no_task:      { cls: "d-none",    text: "无任务" },
  login_failed: { cls: "d-fail",    text: "登录失败" },
  error:        { cls: "d-fail",    text: "异常" },
  pending:      { cls: "d-pending", text: "未签" },
};

const state = {
  token: "",       // 管理员令牌（有此令牌才能拉黑/恢复/删除）
  view: "members", // 当前视图："members" 或 "blacklist"
  members: null,   // /api/members 响应
  blacklist: null, // /api/blacklist 响应
  filter: "",      // 搜索关键字
  user: null,      // 当前选中昵称
  userData: null,  // /api/user 响应
  signingEnabled: true,
  year: 0, month: 0,
  verifiedName: "", // 普通用户验证的姓名
  isAdmin: false,   // 是否管理员模式
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function pad(n) { return String(n).padStart(2, "0"); }

function showToast(msg) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// 姓名验证
function showNameVerify() {
  document.getElementById("name-verify-mask").hidden = false;
  document.getElementById("name-verify-err").textContent = "";
  document.getElementById("name-input").value = "";
  document.getElementById("name-input").focus();
}

function hideNameVerify() {
  document.getElementById("name-verify-mask").hidden = true;
}

document.getElementById("name-verify-btn").onclick = () => {
  const name = document.getElementById("name-input").value.trim();
  const err = document.getElementById("name-verify-err");
  if (!name) {
    err.textContent = "请输入姓名";
    return;
  }
  // 验证姓名是否存在
  fetch(API_BASE + "/api/user?name=" + encodeURIComponent(name))
    .then(r => r.json())
    .then(d => {
      if (d.nickname === name) {
        state.verifiedName = name;
        state.isAdmin = false;
        // 保存到 localStorage
        localStorage.setItem("verified_name", name);
        hideNameVerify();
        document.getElementById("main-content").hidden = false;
        document.getElementById("overview").hidden = true; // 普通用户隐藏总览
        document.getElementById("show-login-btn").hidden = false; // 保留登录按钮
        document.getElementById("tabs").hidden = true;
        document.getElementById("search").hidden = true;
        load();
        // 自动选中该用户
        selectUser(name);
      } else {
        err.textContent = "未找到该姓名，请确认后重试";
      }
    })
    .catch(() => {
      err.textContent = "未找到该姓名，请确认后重试";
    });
};

document.getElementById("name-input").onkeypress = (e) => {
  if (e.key === "Enter") {
    document.getElementById("name-verify-btn").click();
  }
};

// 登录
function showLogin() {
  document.getElementById("login-mask").hidden = false;
  document.getElementById("login-err").textContent = "";
  document.getElementById("switch-user-err").textContent = "";
  document.getElementById("login-user").value = "";
  document.getElementById("login-pass").value = "";
  document.getElementById("switch-user-name").value = "";
  // 默认显示普通用户切换面板
  document.getElementById("user-login-panel").hidden = false;
  document.getElementById("admin-login-panel").hidden = true;
}
function hideLogin() {
  document.getElementById("login-mask").hidden = true;
}

document.getElementById("show-login-btn").onclick = showLogin;

// 切换到管理员登录面板
document.getElementById("switch-to-admin").onclick = () => {
  document.getElementById("user-login-panel").hidden = true;
  document.getElementById("admin-login-panel").hidden = false;
  document.getElementById("login-user").focus();
};

// 切换到普通用户面板
document.getElementById("switch-to-user").onclick = () => {
  document.getElementById("user-login-panel").hidden = false;
  document.getElementById("admin-login-panel").hidden = true;
  document.getElementById("switch-user-name").focus();
};

// 切换到其他普通用户
document.getElementById("switch-user-btn").onclick = () => {
  const name = document.getElementById("switch-user-name").value.trim();
  const err = document.getElementById("switch-user-err");
  if (!name) {
    err.textContent = "请输入姓名";
    return;
  }
  // 验证姓名是否存在
  fetch(API_BASE + "/api/user?name=" + encodeURIComponent(name))
    .then(r => r.json())
    .then(d => {
      if (d.nickname === name) {
        // 如果当前是管理员，先退出管理员模式
        state.token = "";
        state.isAdmin = false;
        state.verifiedName = name;
        // 更新 localStorage
        localStorage.setItem("verified_name", name);
        hideLogin();
        document.getElementById("main-content").hidden = false;
        document.getElementById("overview").hidden = true;
        document.getElementById("show-login-btn").hidden = false;
        document.getElementById("signing-toggle-btn").hidden = true;
        document.getElementById("logout-btn").hidden = true;
        document.getElementById("tabs").hidden = true;
        document.getElementById("search").hidden = true;
        load();
        selectUser(name);
        showToast(`已切换到「${name}」`);
      } else {
        err.textContent = "未找到该姓名，请确认后重试";
      }
    })
    .catch(() => {
      err.textContent = "未找到该姓名，请确认后重试";
    });
};

document.getElementById("switch-user-name").onkeypress = (e) => {
  if (e.key === "Enter") {
    document.getElementById("switch-user-btn").click();
  }
};

document.getElementById("login-btn").onclick = () => {
  const user = document.getElementById("login-user").value.trim();
  const pass = document.getElementById("login-pass").value;
  const err = document.getElementById("login-err");
  fetch(API_BASE + "/api/login", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({user, password: pass}),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      state.token = d.token;
      state.isAdmin = true;
      state.verifiedName = "";
      // 不清除普通用户记忆
      hideLogin();
      document.getElementById("main-content").hidden = false;
      document.getElementById("overview").hidden = false; // 管理员显示总览
      document.getElementById("show-login-btn").hidden = true;
      document.getElementById("signing-toggle-btn").hidden = false;
      document.getElementById("logout-btn").hidden = false;
      document.getElementById("tabs").hidden = false;
      document.getElementById("search").hidden = false;
      load();
    } else {
      err.textContent = d.error || "登录失败";
    }
  }).catch(() => { err.textContent = "网络错误"; });
};

document.getElementById("login-cancel").onclick = hideLogin;

document.getElementById("logout-btn").onclick = () => {
  state.token = "";
  state.isAdmin = false;
  state.user = null;
  state.userData = null;
  // 不清除记忆的姓名，退出后自动恢复普通用户视图
  document.getElementById("main-content").hidden = true;
  document.getElementById("overview").hidden = true;
  document.getElementById("show-login-btn").hidden = false;
  document.getElementById("signing-toggle-btn").hidden = true;
  document.getElementById("logout-btn").hidden = true;
  document.getElementById("usercard").hidden = true;

  // 如果有保存的姓名，自动加载
  const savedName = localStorage.getItem("verified_name");
  if (savedName) {
    fetch(API_BASE + "/api/user?name=" + encodeURIComponent(savedName))
      .then(r => r.json())
      .then(d => {
        if (d.nickname === savedName) {
          state.verifiedName = savedName;
          state.isAdmin = false;
          document.getElementById("main-content").hidden = false;
          document.getElementById("overview").hidden = true;
          document.getElementById("show-login-btn").hidden = false;
          document.getElementById("tabs").hidden = true;
          document.getElementById("search").hidden = true;
          load();
          selectUser(savedName);
        } else {
          localStorage.removeItem("verified_name");
          showNameVerify();
        }
      })
      .catch(() => {
        showNameVerify();
      });
  } else {
    showNameVerify();
  }
};

// PLACEHOLDER_RENDER
function renderOverview() {
  const o = state.members?.overview;
  if (!o) return;
  updateTime();  // 显示当前时间
  document.getElementById("ov-total").textContent = o.total;
  document.getElementById("ov-ok").textContent = o.ok;
  document.getElementById("ov-fail").textContent = o.fail;
  document.getElementById("ov-pending").textContent = o.pending;
  renderSigningStatus();
}

function renderSigningStatus() {
  const paused = state.signingEnabled === false;
  document.getElementById("signing-notice").hidden = !paused;
  const toggle = document.getElementById("signing-toggle-btn");
  if (state.token) {
    toggle.hidden = false;
    toggle.textContent = paused ? "恢复签到" : "停止签到";
  }
}

function toggleSigning() {
  const enabled = !state.signingEnabled;
  const action = enabled ? "恢复" : "停止";
  if (!confirm(`确定${action}所有用户的自动签到吗？`)) return;
  fetch(API_BASE + "/api/signing", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: state.token, enabled}),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      state.signingEnabled = d.signing_enabled;
      renderSigningStatus();
      showToast(enabled ? "已恢复自动签到" : "已停止自动签到");
      load();
    } else {
      alert(d.error || "操作失败");
    }
  }).catch(() => alert("网络错误"));
}

function updateTime() {
  const now = new Date();
  const date = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  document.getElementById("today").textContent = `${date} ${time}`;
}

function switchView(v) {
  state.view = v;
  state.filter = "";
  document.getElementById("search").value = "";
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.view === v);
  });
  if (v === "members") {
    document.getElementById("view-title").textContent = "成员";
    document.getElementById("members").hidden = false;
    document.getElementById("blacklist").hidden = true;
    renderMembers();
  } else {
    document.getElementById("view-title").textContent = "黑名单";
    document.getElementById("members").hidden = true;
    document.getElementById("blacklist").hidden = false;
    renderBlacklist();
  }
}

document.querySelectorAll(".tab").forEach(t => {
  t.onclick = () => {
    // 只有管理员才能切换到黑名单
    if (t.dataset.view === "blacklist" && !state.isAdmin) {
      return;
    }
    switchView(t.dataset.view);
  };
});

// 通用成员卡片渲染函数
function _renderMemberCard(m, isBlacklist) {
  const st = STATUS[m.today_status] || STATUS.pending;
  const strip = (m.strip || []).map(s => {
    const c = s ? (STATUS[s] || STATUS.pending).cls : "d-none";
    return `<i class="tick ${c}"></i>`;
  }).join("");

  // 签到时刻：已签显示实际时间，未签显示今日预定时刻
  let timeLine = "";
  if (m.today_status === "ok" && m.today_time) {
    timeLine = `<span class="m-time done">✓ ${esc(m.today_time)} 已签</span>`;
  } else if (m.scheduled_time) {
    timeLine = `<span class="m-time">预定 ${esc(m.scheduled_time)}</span>`;
  }

  const el = document.createElement("div");
  el.className = "member";
  el.innerHTML =
    `<button class="m-card" data-nick="${esc(m.nickname)}">` +
      `<span class="m-ava">${esc(m.nickname.slice(0, 1))}</span>` +
      `<span class="m-main">` +
        `<span class="m-top"><span class="m-name">${esc(m.nickname)}</span>` +
        `<span class="m-badge ${st.cls}">${st.text}</span></span>` +
        `<span class="m-strip">${strip}</span>` +
        timeLine +
      `</span>` +
      `<span class="m-count"><b>${m.ok_days}</b>签 <b class="f">${m.fail_days}</b>异</span>` +
    `</button>`;

  // 管理员模式：添加操作按钮
  if (state.token) {
    if (isBlacklist) {
      const btns = document.createElement("div");
      btns.className = "bl-btns";
      const restore = document.createElement("button");
      restore.className = "btn-primary btn-sm";
      restore.textContent = "恢复";
      restore.onclick = e => { e.stopPropagation(); restoreMember(m.id, m.nickname); };
      const del = document.createElement("button");
      del.className = "btn-danger btn-sm";
      del.textContent = "删除";
      del.onclick = e => { e.stopPropagation(); deleteMember(m.id, m.nickname); };
      btns.appendChild(restore);
      btns.appendChild(del);
      el.appendChild(btns);
    } else {
      const btns = document.createElement("div");
      btns.className = "bl-btns";
      const blacklist = document.createElement("button");
      blacklist.className = "btn-danger btn-sm";
      blacklist.textContent = "拉黑";
      blacklist.onclick = e => { e.stopPropagation(); blacklistMember(m.id, m.nickname); };
      const del = document.createElement("button");
      del.className = "btn-danger btn-sm";
      del.textContent = "删除";
      del.onclick = e => { e.stopPropagation(); deleteMemberDirectly(m.id, m.nickname); };
      btns.appendChild(blacklist);
      btns.appendChild(del);
      el.appendChild(btns);
    }
  }

  el.querySelector(".m-card").onclick = () => selectUser(m.nickname);
  return el;
}

// PLACEHOLDER_MEMBERS
function renderMembers() {
  const box = document.getElementById("members");
  const all = state.members?.members || [];
  const kw = state.filter.trim().toLowerCase();

  // 普通用户只显示自己
  let list = all;
  if (state.verifiedName && !state.isAdmin) {
    list = all.filter(m => m.nickname === state.verifiedName);
  } else if (kw) {
    list = all.filter(m => m.nickname.toLowerCase().includes(kw));
  }

  document.getElementById("member-count").textContent = state.isAdmin ? "(" + all.length + ")" : "";
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + (all.length ? "无匹配成员" : "还没有成员注册") + "</div>";
    return;
  }
  list.forEach(m => {
    const el = _renderMemberCard(m, false);
    if (m.nickname === state.user) el.classList.add("active");
    box.appendChild(el);
  });
}

function blacklistMember(id, nick) {
  if (!confirm(`确定拉黑「${nick}」吗？该成员将无法自动签到。`)) return;
  fetch(API_BASE + "/api/blacklist/add", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: state.token, id}),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      showToast(`已拉黑「${nick}」`);
      load();
    } else {
      alert(d.error || "操作失败");
    }
  }).catch(() => alert("网络错误"));
}
// PLACEHOLDER_BLACKLIST
function renderBlacklist() {
  const box = document.getElementById("blacklist");
  const all = state.blacklist?.blacklist || [];
  const kw = state.filter.trim().toLowerCase();
  const list = kw ? all.filter(m => m.nickname.toLowerCase().includes(kw)) : all;

  document.getElementById("member-count").textContent = "(" + all.length + ")";
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + (all.length ? "无匹配黑名单" : "暂无黑名单成员") + "</div>";
    return;
  }
  list.forEach(m => {
    const el = _renderMemberCard(m, true);
    if (m.nickname === state.user) el.classList.add("active");
    box.appendChild(el);
  });
}

function restoreMember(id, nick) {
  if (!confirm(`恢复「${nick}」为正常成员？恢复后将重新参与自动签到。`)) return;
  fetch(API_BASE + "/api/blacklist/restore", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: state.token, id}),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      showToast(`已恢复「${nick}」`);
      load();
    } else {
      alert(d.error || "操作失败");
    }
  }).catch(() => alert("网络错误"));
}

function deleteMember(id, nick) {
  if (!confirm(`彻底删除「${nick}」？删除后该用户的 openid 将丢失，无法恢复。`)) return;
  fetch(API_BASE + "/api/blacklist/delete", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: state.token, id}),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      showToast(`已删除「${nick}」`);
      load();
    } else {
      alert(d.error || "操作失败");
    }
  }).catch(() => alert("网络错误"));
}

function deleteMemberDirectly(id, nick) {
  if (!confirm(`确定删除「${nick}」？删除后该成员将从名册中移除，停止自动签到。`)) return;
  fetch(API_BASE + "/api/member/delete", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: state.token, id}),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      showToast(`已删除「${nick}」`);
      load();
    } else {
      alert(d.error || "操作失败");
    }
  }).catch(() => alert("网络错误"));
}
// PLACEHOLDER_CAL
function selectUser(name) {
  state.user = name;
  document.querySelectorAll(".m-card").forEach(el =>
    el.parentElement.classList.toggle("active", el.dataset.nick === name));
  const card = document.getElementById("usercard");
  card.hidden = false;
  document.getElementById("uc-name").textContent = name;
  document.getElementById("uc-okdays").textContent = "已签 -- 天";
  document.getElementById("uc-faildays").textContent = "异常 -- 天";
  document.getElementById("cal-body").innerHTML =
    '<tr><td colspan="7" class="cal-loading">加载中…</td></tr>';

  // 检查该成员是否在黑名单中
  const isBlacklisted = state.blacklist?.blacklist?.some(b => b.nickname === name);
  const alert = document.getElementById("uc-blacklist-alert");
  if (isBlacklisted) {
    alert.hidden = false;
  } else {
    alert.hidden = true;
  }

  fetch(API_BASE + "/api/user?name=" + encodeURIComponent(name))
    .then(r => r.json())
    .then(d => {
      state.userData = d;
      const [y, m] = d.today.split("-").map(Number);
      state.year = y; state.month = m;
      renderUserCard();
    })
    .catch(() => {
      document.getElementById("cal-body").innerHTML =
        '<tr><td colspan="7" class="cal-loading">加载失败</td></tr>';
    });
}

function renderUserCard() {
  const d = state.userData;
  if (!d) return;
  document.getElementById("uc-okdays").textContent = "已签 " + d.stats.ok_days + " 天";
  document.getElementById("uc-faildays").textContent = "异常 " + d.stats.fail_days + " 天";
  renderCalendar();
}

function renderCalendar() {
  const d = state.userData;
  if (!d) return;
  const y = state.year, m = state.month;
  document.getElementById("cal-title").textContent = `${y}年${m}月`;

  const [minY, minM] = d.min_date.split("-").map(Number);
  const [maxY, maxM] = d.today.split("-").map(Number);
  const curIdx = y * 12 + (m - 1);
  document.getElementById("prev-month").disabled = curIdx <= minY * 12 + (minM - 1);
  document.getElementById("next-month").disabled = curIdx >= maxY * 12 + (maxM - 1);

  const first = new Date(y, m - 1, 1);
  let lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m, 0).getDate();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let dd = 1; dd <= daysInMonth; dd++) cells.push(dd);
  while (cells.length % 7 !== 0) cells.push(null);

  const body = document.getElementById("cal-body");
  body.innerHTML = "";
  for (let i = 0; i < cells.length; i += 7) {
    const tr = document.createElement("tr");
    for (let j = 0; j < 7; j++) {
      const dd = cells[i + j];
      const td = document.createElement("td");
      if (dd == null) { td.className = "blank"; tr.appendChild(td); continue; }
      const date = `${y}-${pad(m)}-${pad(dd)}`;
      const rec = d.records[date];
      let cls = "d-none", title = date + " 无记录";
      if (date === d.today && !rec) { cls = "d-pending"; title = date + " 未签"; }
      if (rec) {
        const s = STATUS[rec.status] || STATUS.pending;
        cls = s.cls;
        title = `${date} ${s.text}${rec.time ? " " + rec.time : ""}`;
      }
      td.className = "cell" + (date === d.today ? " is-today" : "");
      td.title = title;
      td.innerHTML = `<span class="stamp ${cls}">${dd}</span>`;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function shiftMonth(delta) {
  let idx = state.year * 12 + (state.month - 1) + delta;
  state.year = Math.floor(idx / 12);
  state.month = (idx % 12) + 1;
  renderCalendar();
}
// PLACEHOLDER_BOOT
function load() {
  fetch(API_BASE + "/api/members")
    .then(r => r.json())
    .then(d => {
      state.members = d;
      state.signingEnabled = d.signing_enabled !== false;
      renderOverview();
      if (state.view === "members") renderMembers();
      // 已选中的人，刷新其日历
      if (state.user && d.members.some(m => m.nickname === state.user)) {
        fetch(API_BASE + "/api/user?name=" + encodeURIComponent(state.user))
          .then(r => r.json())
          .then(u => { state.userData = u; renderCalendar(); })
          .catch(() => {});
      }
      document.getElementById("foot").textContent =
        "更新于 " + new Date().toLocaleString("zh-CN");
    })
    .catch(() => {
      document.getElementById("foot").textContent = "加载失败，请刷新重试";
    });

  // 只有管理员才加载黑名单
  if (state.isAdmin) {
    fetch(API_BASE + "/api/blacklist")
      .then(r => r.json())
      .then(d => {
        state.blacklist = d;
        if (state.view === "blacklist") renderBlacklist();
      })
      .catch(() => {});
  }
}

document.getElementById("prev-month").onclick = () => shiftMonth(-1);
document.getElementById("next-month").onclick = () => shiftMonth(1);
document.getElementById("signing-toggle-btn").onclick = toggleSigning;
const searchBox = document.getElementById("search");
if (searchBox) searchBox.oninput = () => {
  state.filter = searchBox.value;
  if (state.view === "members") renderMembers();
  else renderBlacklist();
};

// 启动时显示姓名验证界面，或自动加载已保存的姓名
const savedName = localStorage.getItem("verified_name");
if (savedName) {
  // 验证保存的姓名是否仍然有效
  fetch(API_BASE + "/api/user?name=" + encodeURIComponent(savedName))
    .then(r => r.json())
    .then(d => {
      if (d.nickname === savedName) {
        // 姓名仍然有效，自动登录
        state.verifiedName = savedName;
        state.isAdmin = false;
        document.getElementById("main-content").hidden = false;
        document.getElementById("overview").hidden = true;
        document.getElementById("show-login-btn").hidden = false; // 保留登录按钮
        document.getElementById("tabs").hidden = true;
        document.getElementById("search").hidden = true;
        document.getElementById("name-verify-mask").hidden = true;
        load();
        selectUser(savedName);
      } else {
        // 姓名失效，清除并显示验证界面
        localStorage.removeItem("verified_name");
        showNameVerify();
      }
    })
    .catch(() => {
      // 网络错误，清除并显示验证界面
      localStorage.removeItem("verified_name");
      showNameVerify();
    });
} else {
  showNameVerify();
}

setInterval(() => {
  if (state.isAdmin || state.verifiedName) {
    load();
  }
}, 60000);        // 每分钟刷新数据
setInterval(updateTime, 1000);   // 每秒更新时间显示
