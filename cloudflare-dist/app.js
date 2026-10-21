// 用户页：姓名 + 学号登录后，只看自己的签到记录，并管理自己的签到设置

const me = {
  id: localStorage.getItem("member_id") || "",
  token: localStorage.getItem("member_token") || "",
  name: localStorage.getItem("verified_name") || "",
  sys: { start: "21:00", end: "22:00" },
};
// 旧版按姓名签发的令牌已作废，清掉；之后凭学号登录
localStorage.removeItem("user_token");

function saveMe() {
  localStorage.setItem("member_id", me.id);
  localStorage.setItem("member_token", me.token);
  localStorage.setItem("verified_name", me.name);
}

function forgetToken() {
  me.id = me.token = "";
  localStorage.removeItem("member_id");
  localStorage.removeItem("member_token");
}

function showLogin(canCancel) {
  $("login-mask").hidden = false;
  $("login-err").textContent = "";
  $("login-name").value = me.name;
  $("login-sid").value = "";
  $("login-cancel").hidden = !canCancel;
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
  saveMe();
  $("login-mask").hidden = true;
  enter();
};
$("login-cancel").onclick = () => { $("login-mask").hidden = true; };
$("switch-btn").onclick = () => showLogin(true);

function expired() {
  forgetToken();
  showToast("登录已过期，请重新登录", "error");
  showLogin(false);
}
function enter() {
  $("main-content").hidden = false;
  $("switch-btn").hidden = false;
  $("uc-name").textContent = me.name;
  Cal.load(me.name);
  loadMembers();
  loadSettings();
}

// 自己的成员卡（状态、近 7 天、今日预定/实际时刻）
async function loadMembers() {
  const { status, data } = await api("/api/members");
  if (status !== 200) { $("foot").textContent = "加载失败，请刷新重试"; return; }
  $("signing-notice").hidden = data.signing_enabled !== false;
  const m = (data.members || []).find(x => x.id === me.id);
  $("members").innerHTML = m ? memberCard(m)
    : '<div class="empty">名单里没有找到你，可能已退出或被移出</div>';
  $("foot").textContent = "更新于 " + new Date().toLocaleString("zh-CN");
}

function memberCard(m) {
  const st = STATUS[m.today_status] || STATUS.pending;
  const time = m.today_status === "ok" && m.today_time
    ? `<span class="m-time done">✓ ${esc(m.today_time)} 已签</span>`
    : m.scheduled_time ? `<span class="m-time">预定 ${esc(m.scheduled_time)}</span>` : "";
  return '<div class="member active"><div class="m-card">' +
    `<span class="m-ava" aria-hidden="true">${esc(m.nickname.slice(0, 1))}</span>` +
    `<span class="m-main"><span class="m-top"><span class="m-name">${esc(m.nickname)}</span></span>` +
    `<span class="m-strip" aria-label="近 7 天">${stripHtml(m.strip)}</span>${time}</span>` +
    `<span class="m-side"><span class="m-badge ${st.cls}">${st.text}</span>` +
    `<span class="m-count"><b>${m.ok_days}</b>签 <b class="f">${m.fail_days}</b>异</span></span>` +
    "</div></div>";
}

async function loadSettings() {
  const { status, data } = await api("/api/member/profile", { id: me.id, token: me.token });
  if (status === 401) return expired();
  if (status !== 200) {
    $("settings").innerHTML = `<div class="empty-sm">${esc(data.error || "加载失败")}</div>`;
    return;
  }
  me.sys = data.system_window;
  renderSettings(data.member);
}
function renderSettings(member) {
  Settings.render($("settings"), member, {
    token: me.token,
    sys: me.sys,
    onChange: m => { renderSettings(m); loadMembers(); Cal.load(me.name, true); },
    onExpired: expired,
  });
}

$("quit-btn").onclick = async () => {
  if (!confirm("确定退出自动签到系统吗？\n退出后将停止为你自动签到，重新运行登记工具即可恢复。")) return;
  const { status, data } = await withBusy($("quit-btn"), "处理中…",
    () => api("/api/member/self-delete", { id: me.id, token: me.token }));
  if (status === 401) return expired();
  if (status !== 200) return showToast(data.error || "操作失败", "error");
  showToast("已退出自动签到系统");
  forgetToken();
  me.name = "";
  localStorage.removeItem("verified_name");
  Cal.clear();
  $("main-content").hidden = true;
  $("switch-btn").hidden = true;
  showLogin(false);
};

startClock();
Cal.bind();
if (me.id && me.token && me.name) enter(); else showLogin(false);

// 每分钟刷新一次状态（页面在前台时）
setInterval(() => {
  if (document.visibilityState === "visible" && me.id && !$("main-content").hidden) {
    loadMembers();
    Cal.load(me.name, true);
  }
}, 60000);
