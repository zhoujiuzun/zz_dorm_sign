// 管理后台：左侧成员列表（只做浏览与选择），右侧详情面板集中放全部操作

const S = {
  token: sessionStorage.getItem("admin_token") || "",
  view: "members",     // "members" | "inactive"
  members: null,       // /api/members
  inactive: [],        // /api/blacklist 的 inactive
  roster: {},          // id -> 签到设置（含学号），来自 /api/admin/roster
  sys: { start: "21:00", end: "22:00" },
  selected: "",
  filter: "",
};

function showLogin() {
  $("login-mask").hidden = false;
  $("login-err").textContent = "";
  $("login-pass").value = "";
  $("login-user").focus();
}

$("login-form").onsubmit = async e => {
  e.preventDefault();
  const user = $("login-user").value.trim();
  const password = $("login-pass").value;
  const { status, data } = await withBusy($("login-btn"), "登录中…",
    () => api("/api/login", { user, password }));
  if (status !== 200 || !data.token) { $("login-err").textContent = data.error || "登录失败"; return; }
  S.token = data.token;
  sessionStorage.setItem("admin_token", S.token);
  $("login-mask").hidden = true;
  enter();
};

// 管理令牌约 1-2 小时过期：任何接口回 401，或旧接口回 403「未授权」，都回到登录
function isExpired(status, data) {
  return status === 401 || (status === 403 && /未授权/.test(data.error || ""));
}

function expired() {
  S.token = "";
  sessionStorage.removeItem("admin_token");
  showToast("登录已过期，请重新登录", "error");
  showLogin();
}

$("logout-btn").onclick = () => {
  S.token = "";
  sessionStorage.removeItem("admin_token");
  location.href = "/";
};
function enter() {
  $("main-content").hidden = false;
  $("logout-btn").hidden = false;
  load();
}

async function load() {
  const [m, b, r] = await Promise.all([
    api("/api/members"),
    api("/api/blacklist"),
    api("/api/admin/roster", { token: S.token }),
  ]);
  if (isExpired(r.status, r.data)) return expired();
  if (m.status !== 200) { $("foot").textContent = "加载失败，请刷新重试"; return; }
  S.members = m.data;
  S.inactive = b.status === 200 ? b.data.inactive || [] : [];
  if (r.status === 200) {
    S.roster = {};
    for (const x of r.data.roster) S.roster[x.id] = x;
    S.sys = r.data.system_window;
  }
  renderOverview();
  renderList();
  renderDetail();
  $("foot").textContent = "更新于 " + new Date().toLocaleString("zh-CN");
}

function renderOverview() {
  const o = S.members.overview;
  $("ov-total").textContent = o.total;
  $("ov-ok").textContent = o.ok;
  $("ov-fail").textContent = o.fail;
  $("ov-pending").textContent = o.pending;
  const paused = S.members.signing_enabled === false;
  $("signing-notice").hidden = !paused;
  const t = $("signing-toggle-btn");
  t.hidden = false;
  t.textContent = paused ? "恢复签到" : "停止签到";
  $("cnt-members").textContent = S.members.members.length;
  $("cnt-inactive").textContent = S.inactive.length;
  const missing = Object.values(S.roster).filter(x => !x.student_id).length;
  $("ids-tools").hidden = !missing || S.view !== "members";
  $("ids-missing").textContent = `${missing} 人还没有学号`;
}
function currentList() {
  return S.view === "members" ? S.members.members : S.inactive;
}

function findMember(id) {
  const a = S.members.members.find(x => x.id === id);
  if (a) return { m: a, active: true };
  const b = S.inactive.find(x => x.id === id);
  return b ? { m: b, active: false } : null;
}

function badgeOf(m) {
  if (m.status_type === "blacklisted") return '<span class="m-badge d-fail">已拉黑</span>';
  if (m.status_type === "deleted") return `<span class="m-badge d-deleted">${m.orphan ? "历史残留" : "已删除"}</span>`;
  if (m.orphan) return '<span class="m-badge d-deleted">历史残留</span>';
  const st = STATUS[m.today_status] || STATUS.pending;
  return `<span class="m-badge ${st.cls}">${st.text}</span>`;
}

function renderList() {
  const kw = S.filter.trim().toLowerCase();
  const all = currentList();
  const list = !kw ? all : all.filter(m => m.nickname.toLowerCase().includes(kw) ||
    String(S.roster[m.id]?.student_id || "").includes(kw));
  if (!list.length) {
    $("list").innerHTML = `<div class="empty">${all.length ? "无匹配成员" : "暂无成员"}</div>`;
    return;
  }
  $("list").innerHTML = list.map(m => {
    const sid = S.roster[m.id]?.student_id;
    const time = m.today_status === "ok" && m.today_time ? `✓ ${m.today_time} 已签`
      : m.scheduled_time ? `预定 ${m.scheduled_time}` : "";
    return `<button type="button" role="listitem" class="member row${m.id === S.selected ? " active" : ""}"` +
      ` data-id="${esc(m.id)}">` +
      `<span class="m-ava" aria-hidden="true">${esc(m.nickname.slice(0, 1))}</span>` +
      `<span class="m-main"><span class="m-top"><span class="m-name">${esc(m.nickname)}</span>` +
      `${sid ? `<span class="m-sid">${esc(sid)}</span>` : ""}</span>` +
      `<span class="m-strip">${stripHtml(m.strip)}</span>` +
      `${time ? `<span class="m-time${m.today_status === "ok" ? " done" : ""}">${esc(time)}</span>` : ""}</span>` +
      `<span class="m-side">${badgeOf(m)}` +
      `<span class="m-count"><b>${m.ok_days}</b>签 <b class="f">${m.fail_days}</b>异</span></span></button>`;
  }).join("");
}

$("list").onclick = e => {
  const row = e.target.closest("[data-id]");
  if (!row) return;
  S.selected = row.dataset.id;
  renderList();
  renderDetail();
  if (window.innerWidth < 760) $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
};
function renderDetail() {
  const hit = S.selected && findMember(S.selected);
  $("detail-empty").hidden = !!hit;
  $("detail-body").hidden = !hit;
  if (!hit) { S.selected = ""; Cal.clear(); return; }
  const { m, active } = hit;
  // 拉黑/恢复后成员换了名单，标签页跟过去，保持选中
  if (active !== (S.view === "members")) setView(active ? "members" : "inactive", true);

  const r = S.roster[m.id];
  $("uc-name").textContent = m.nickname;
  $("uc-sub").textContent = r?.student_id ? `学号 ${r.student_id}` : (active && !m.orphan ? "学号未获取" : "");
  const alert = $("uc-alert");
  alert.hidden = active && !m.orphan;
  alert.textContent = m.orphan ? "该成员账号信息已丢失，只剩历史记录，无法签到"
    : m.status_type === "deleted" ? "该成员已被删除，以下为历史记录（重新注册可自动恢复）"
    : "该成员已被拉黑，以下为历史记录";

  $("settings-panel").hidden = !(active && r);
  if (active && r) {
    Settings.render($("settings"), r, {
      token: S.token,
      sys: S.sys,
      onChange: x => { S.roster[x.id] = x; load(); },
      onExpired: expired,
    });
  }
  renderManage(m, active);
  Cal.load(m.nickname, true);
}

function renderManage(m, active) {
  const acts = m.orphan && active ? [["清除残留", "btn-danger", "/api/orphan/hide", { nickname: m.nickname },
      `清除「${m.nickname}」的列表残留？历史签到记录保留。`]]
    : active ? [
      ["拉黑", "btn-danger", "/api/blacklist/add", { id: m.id }, `拉黑「${m.nickname}」？将停止为其签到，且不能自行重新注册。`],
      ["删除", "btn-secondary", "/api/member/delete", { id: m.id }, `删除「${m.nickname}」？将停止为其签到，历史保留；重新注册可自动恢复。`],
    ] : [
      ...(m.orphan ? [] : [["恢复", "btn-primary",
        m.status_type === "deleted" ? "/api/deleted/restore" : "/api/blacklist/restore", { id: m.id },
        `恢复「${m.nickname}」为正常成员？将重新参与自动签到。`]]),
      ["彻底删除", "btn-danger", m.status_type === "deleted" ? "/api/deleted/purge" : "/api/blacklist/delete",
        { id: m.id }, `彻底删除「${m.nickname}」？openid 将丢失，无法恢复。`, true],
    ];
  const box = $("manage");
  box.innerHTML = "";
  for (const [label, cls, path, body, ask, purge] of acts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.onclick = () => doOp(b, path, body, ask, purge);
    box.appendChild(b);
  }
}
async function doOp(btn, path, body, ask, purge) {
  if (!confirm(ask)) return;
  const { status, data } = await withBusy(btn, "处理中…", () => api(path, { token: S.token, ...body }));
  if (isExpired(status, data)) return expired();
  if (status !== 200) return showToast(data.error || "操作失败", "error");
  showToast(`已${btn.textContent}「${data.nickname || ""}」`);
  if (purge) S.selected = "";
  load();
}

$("backfill-btn").onclick = async () => {
  const { status, data } = await withBusy($("backfill-btn"), "补全中…",
    () => api("/api/admin/backfill-ids", { token: S.token }));
  if (isExpired(status, data)) return expired();
  if (status !== 200) return showToast(data.error || "补全失败", "error");
  showToast(`已补全 ${data.filled} 人` + (data.remaining ? `，还剩 ${data.remaining} 人` : ""));
  load();
};

function setView(v, keepFilter) {
  S.view = v;
  if (!keepFilter) { S.filter = ""; $("search").value = ""; }
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.view === v);
    t.setAttribute("aria-selected", t.dataset.view === v);
  });
  const missing = Object.values(S.roster).filter(x => !x.student_id).length;
  $("ids-tools").hidden = !missing || v !== "members";
  renderList();
}

document.querySelectorAll(".tab").forEach(t => { t.onclick = () => setView(t.dataset.view); });
$("search").oninput = () => { S.filter = $("search").value; renderList(); };

$("signing-toggle-btn").onclick = async () => {
  const enabled = S.members.signing_enabled === false;
  if (!confirm(`确定${enabled ? "恢复" : "停止"}所有用户的自动签到吗？`)) return;
  const { status, data } = await withBusy($("signing-toggle-btn"), "处理中…",
    () => api("/api/signing", { token: S.token, enabled }));
  if (isExpired(status, data)) return expired();
  if (status !== 200) return showToast(data.error || "操作失败", "error");
  showToast(enabled ? "已恢复自动签到" : "已停止自动签到");
  load();
};

startClock();
Cal.bind();
if (S.token) enter(); else showLogin();

setInterval(() => {
  if (document.visibilityState === "visible" && S.token && $("login-mask").hidden) load();
}, 60000);
