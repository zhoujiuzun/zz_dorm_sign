// 用户页：姓名 + 学号登录后，只看自己的签到记录，并管理自己的签到设置

const me = {
  id: localStorage.getItem("member_id") || "",
  token: localStorage.getItem("member_token") || "",
  name: localStorage.getItem("verified_name") || "",
  sys: { start: "21:00", end: "22:00" },
  settings: null,   // /api/member/profile 的 member
  day: null,        // /api/members 里自己的今日状态 {status, time}
  found: true,      // 名单里是否还有自己
  paused: false,
};
localStorage.removeItem("user_token");   // 旧版按姓名签发的令牌已作废

function forgetToken() {
  me.id = me.token = "";
  me.settings = me.day = null;
  localStorage.removeItem("member_id");
  localStorage.removeItem("member_token");
}

function showLogin() {
  $("main-content").hidden = true;
  $("user-chip").hidden = $("logout-btn").hidden = true;
  $("login-mask").hidden = false;
  $("login-err").textContent = "";
  $("login-name").value = me.name;
  $("login-sid").value = "";
  (me.name ? $("login-sid") : $("login-name")).focus();
}

$("login-form").onsubmit = async e => {
  e.preventDefault();
  const name = $("login-name").value.trim();
  const sid = $("login-sid").value.trim();
  if (!name || !sid) { $("login-err").textContent = "请填写姓名和学号"; return; }
  const { status, data } = await withBusy($("login-btn"), "登录中…",
    () => api("/api/user/login", { name, student_id: sid }));
  if (status !== 200) { $("login-err").textContent = data.error || "登录失败"; return; }
  Object.assign(me, { id: data.id, token: data.token, name: data.nickname });
  localStorage.setItem("member_id", me.id);
  localStorage.setItem("member_token", me.token);
  localStorage.setItem("verified_name", me.name);
  $("login-mask").hidden = true;
  enter();
};

$("logout-btn").onclick = () => { forgetToken(); Cal.clear(); showLogin(); };

function expired() {
  forgetToken();
  showToast("登录已过期，请重新登录", "error");
  showLogin();
}

function enter() {
  $("main-content").hidden = false;
  $("user-chip").textContent = me.name;
  $("user-chip").hidden = $("logout-btn").hidden = false;
  $("uc-name").textContent = `${me.name} 的签到日历`;
  Cal.load(me.name);
  loadMembers();
  loadSettings();
}

// 今日状态与暂停开关（公开列表里取自己那一行）
async function loadMembers() {
  const { status, data } = await api("/api/members");
  if (status !== 200) { $("foot").textContent = "加载失败，请刷新重试"; return; }
  me.paused = data.signing_enabled === false;
  $("signing-notice").hidden = !me.paused;
  const row = (data.members || []).find(x => x.id === me.id);
  me.found = !!row;
  me.day = row ? { status: row.today_status, time: row.today_time } : null;
  $("foot").textContent = "更新于 " + new Date().toLocaleString("zh-CN");
  render();
}

async function loadSettings() {
  const { status, data } = await api("/api/member/profile", { id: me.id, token: me.token });
  if (status === 401) return expired();
  if (status !== 200) {
    $("today-box").innerHTML = `<div class="tb-sub">${esc(data.error || "加载失败，请刷新重试")}</div>`;
    return;
  }
  me.sys = data.system_window;
  me.settings = data.member;
  render();
}

function render() {
  if (!me.found) {
    $("today-box").className = "today-block tone-warn";
    $("today-box").innerHTML = '<div class="tb-title">名单里没有找到你</div>' +
      '<div class="tb-sub">可能已停用自动签到或被移出，重新运行登记工具即可恢复</div>';
    return;
  }
  if (!me.settings) return;
  const v = { m: me.settings, day: me.day, paused: me.paused, showSid: true };
  const ctx = {
    token: me.token,
    sys: me.sys,
    onChange: m => { me.settings = m; render(); loadMembers(); Cal.load(me.name, true); },
    onExpired: expired,
  };
  Settings.today($("today-box"), v, ctx);
  Settings.info($("info-box"), v, ctx);
}

$("quit-btn").onclick = async () => {
  if (!confirm("确定停用自动签到吗？\n停用后系统不再为你签到，历史记录保留；重新运行登记工具即可恢复。")) return;
  const { status, data } = await withBusy($("quit-btn"), "处理中…",
    () => api("/api/member/self-delete", { id: me.id, token: me.token }));
  if (status === 401) return expired();
  if (status !== 200) return showToast(data.error || "操作失败", "error");
  showToast("已停用自动签到");
  forgetToken();
  Cal.clear();
  showLogin();
};

startClock();
Cal.bind();
if (me.id && me.token && me.name) enter(); else showLogin();

// 每分钟刷新状态与倒计时（页面在前台时）
setInterval(() => {
  if (document.visibilityState !== "visible" || !me.id || $("main-content").hidden) return;
  loadMembers();
  Cal.load(me.name, true);
}, 60000);
