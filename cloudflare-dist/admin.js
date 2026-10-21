// 管理页：顶部统计可点筛选；左侧列表选人，行右侧直接拉黑/删除；右侧详情管签到设置与日历

const S = {
  token: sessionStorage.getItem("admin_token") || "",
  view: "members",     // "members" | "inactive"
  group: "all",        // 统计卡筛选：all | ok | fail | pending
  members: null,       // /api/members
  inactive: [],        // /api/blacklist 的 inactive
  roster: {},          // id -> 签到设置（含学号），来自 /api/admin/roster
  sys: { start: "21:00", end: "22:00" },
  selected: "",
  filter: "",
};

function showLogin() {
  $("main-content").hidden = true;
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

// 管理令牌约 1-2 小时过期：接口回 401，或旧接口回 403「未授权」，都回到登录
function isExpired(status, data) {
  return status === 401 || (status === 403 && /未授权/.test(data.error || ""));
}

function expired() {
  S.token = "";
  sessionStorage.removeItem("admin_token");
  showToast("登录已过期，请重新登录", "error");
  showLogin();
}

$("logout-btn").onclick = () => { sessionStorage.removeItem("admin_token"); location.href = "/"; };
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
  const sw = $("signing-switch");
  sw.hidden = false;
  sw.setAttribute("aria-checked", String(!paused));
  sw.classList.toggle("off", paused);
  $("signing-label").textContent = paused ? "已暂停签到" : "自动签到中";
  $("cnt-members").textContent = S.members.members.length;
  $("cnt-inactive").textContent = S.inactive.length;
  document.querySelectorAll(".stat").forEach(s =>
    s.classList.toggle("active", S.view === "members" && S.group !== "all" && s.dataset.g === S.group));
  const missing = Object.values(S.roster).filter(x => !x.student_id).length;
  $("ids-tools").hidden = !missing || S.view !== "members";
  $("ids-missing").textContent = `${missing} 人还没有学号`;
}
// 与后端总览计数一致：ok / 失败 / 其余都算未签
function groupOf(m) {
  if (m.today_status === "ok") return "ok";
  return isFail(m.today_status) ? "fail" : "pending";
}

function findMember(id) {
  const a = S.members.members.find(x => x.id === id);
  if (a) return { m: a, active: true };
  const b = S.inactive.find(x => x.id === id);
  return b ? { m: b, active: false } : null;
}

function badgeOf(m) {
  if (m.status_type === "blacklisted") return '<span class="badge d-fail">已拉黑</span>';
  if (m.status_type === "deleted") return `<span class="badge d-deleted">${m.orphan ? "历史残留" : "已删除"}</span>`;
  if (m.orphan) return '<span class="badge d-deleted">历史残留</span>';
  const st = STATUS[m.today_status] || STATUS.pending;
  return `<span class="badge ${st.cls}">${st.text}</span>`;
}

const GROUP_TEXT = { ok: "今日已签", fail: "今日异常", pending: "今日未签" };

function renderList() {
  const kw = S.filter.trim().toLowerCase();
  const all = S.view === "members" ? S.members.members : S.inactive;
  const byGroup = S.view === "members" && S.group !== "all";
  let list = byGroup ? all.filter(m => groupOf(m) === S.group) : all;
  if (kw) {
    list = list.filter(m => m.nickname.toLowerCase().includes(kw) ||
      String(S.roster[m.id]?.student_id || "").includes(kw));
  }
  $("filter-tip").hidden = !byGroup;
  $("filter-text").textContent = byGroup ? `只看「${GROUP_TEXT[S.group]}」· ${list.length} 人` : "";
  if (!list.length) {
    $("list").innerHTML = `<div class="empty">${kw || byGroup ? "没有符合条件的成员" :
      S.view === "members" ? "还没有成员" : "暂无非活跃成员"}</div>`;
    return;
  }
  $("list").innerHTML = list.map(m => {
    const sid = S.roster[m.id]?.student_id;
    const time = m.today_status === "ok" && m.today_time ? `✓ ${m.today_time} 已签`
      : m.scheduled_time ? `预定 ${m.scheduled_time}` : "";
    const acts = actionsOf(m, S.view === "members").map((a, i) =>
      `<button type="button" class="btn btn-sm ${a.cls}" data-op="${i}">${a.label}</button>`).join("");
    return `<div class="row${m.id === S.selected ? " active" : ""}" role="listitem" data-id="${esc(m.id)}">` +
      `<button type="button" class="row-hit" aria-label="查看${esc(m.nickname)}">` +
      `<span class="ava" aria-hidden="true">${esc(m.nickname.slice(0, 1))}</span>` +
      `<span class="row-main"><span class="row-top"><span class="row-name">${esc(m.nickname)}</span>` +
      `${sid ? `<span class="row-sid">${esc(sid)}</span>` : ""}</span>` +
      `<span class="row-sub">${badgeOf(m)}` +
      `${time ? `<span class="row-time${m.today_status === "ok" ? " done" : ""}">${esc(time)}</span>` : ""}` +
      `<span class="ticks">${stripHtml(m.strip)}</span></span></span></button>` +
      `<div class="row-acts">${acts}</div></div>`;
  }).join("");
}

// 点行查看详情；点行右侧按钮直接拉黑 / 删除 / 恢复
$("list").onclick = e => {
  const row = e.target.closest("[data-id]");
  if (!row) return;
  const op = e.target.closest("[data-op]");
  if (op) {
    const hit = findMember(row.dataset.id);
    const a = hit && actionsOf(hit.m, hit.active)[+op.dataset.op];
    if (a) doOp(op, a);
    return;
  }
  S.selected = row.dataset.id;
  renderList();
  renderDetail();
  if (window.innerWidth < 900) $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
};

function renderDetail() {
  const hit = S.selected && findMember(S.selected);
  $("detail-empty").hidden = !!hit;
  $("detail-body").hidden = !hit;
  if (!hit) { S.selected = ""; Cal.clear(); return; }
  const { m, active } = hit;
  const r = S.roster[m.id];
  $("d-ava").textContent = m.nickname.slice(0, 1);
  $("uc-name").textContent = m.nickname;
  $("uc-sub").textContent = r?.student_id ? `学号 ${r.student_id}` : (active && !m.orphan ? "学号未获取" : "");
  const alert = $("uc-alert");
  alert.hidden = active && !m.orphan;
  alert.textContent = m.orphan ? "该成员账号信息已丢失，只剩历史记录，无法签到"
    : m.status_type === "deleted" ? "该成员已被删除，以下为历史记录（重新注册可自动恢复）"
    : "该成员已被拉黑，以下为历史记录（可在「非活跃」列表恢复）";

  const live = active && !!r;
  $("today-box").hidden = $("info-card").hidden = !live;
  if (live) {
    const v = { m: r, day: { status: m.today_status, time: m.today_time },
                paused: S.members.signing_enabled === false, showSid: false };
    const ctx = { token: S.token, sys: S.sys, onChange: x => { S.roster[x.id] = x; load(); }, onExpired: expired };
    Settings.today($("today-box"), v, ctx);
    Settings.info($("info-box"), v, ctx);
  }
  Cal.load(m.nickname, true);
}

// 每个成员可做的管理操作（显示在列表行右侧）
function actionsOf(m, active) {
  const n = m.nickname;
  if (active && m.orphan) {
    return [{ label: "清除残留", cls: "btn-danger", path: "/api/orphan/hide", body: { nickname: n },
              ask: `清除「${n}」的列表残留？历史签到记录保留。` }];
  }
  if (active) {
    return [
      { label: "拉黑", cls: "btn-danger", path: "/api/blacklist/add", body: { id: m.id },
        ask: `拉黑「${n}」？将停止为其签到，且不能自行重新注册。` },
      { label: "删除", cls: "btn-ghost", path: "/api/member/delete", body: { id: m.id },
        ask: `删除「${n}」？将停止为其签到，历史保留；重新注册可自动恢复。` },
    ];
  }
  const del = m.status_type === "deleted";
  return [
    ...(m.orphan ? [] : [{ label: "恢复", cls: "btn-primary", body: { id: m.id },
      path: del ? "/api/deleted/restore" : "/api/blacklist/restore",
      ask: `恢复「${n}」为正常成员？将重新参与自动签到。` }]),
    { label: "彻底删除", cls: "btn-danger", body: { id: m.id }, purge: true,
      path: del ? "/api/deleted/purge" : "/api/blacklist/delete",
      ask: `彻底删除「${n}」？openid 将丢失，无法恢复。` },
  ];
}

async function doOp(btn, a) {
  if (!confirm(a.ask)) return;
  const { status, data } = await withBusy(btn, "处理中…", () => api(a.path, { token: S.token, ...a.body }));
  if (isExpired(status, data)) return expired();
  if (status !== 200) return showToast(data.error || "操作失败", "error");
  showToast(`已${a.label}「${data.nickname || ""}」`);
  if (a.purge && a.body.id === S.selected) S.selected = "";
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

function setView(v, keep) {
  S.view = v;
  if (!keep) { S.group = "all"; S.filter = ""; $("search").value = ""; }
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.view === v);
    t.setAttribute("aria-selected", String(t.dataset.view === v));
  });
  renderOverview();
  renderList();
}

document.querySelectorAll(".tab").forEach(t => { t.onclick = () => S.members && setView(t.dataset.view); });
document.querySelectorAll(".stat").forEach(s => {
  s.onclick = () => {
    if (!S.members) return;
    const g = s.dataset.g;
    S.group = g === "all" || S.group === g ? "all" : g;   // 再点一次取消筛选
    setView("members", true);
  };
});
$("filter-clear").onclick = () => { S.group = "all"; setView(S.view, true); };
$("search").oninput = () => { S.filter = $("search").value; if (S.members) renderList(); };
$("back-btn").onclick = () => $("list-card").scrollIntoView({ behavior: "smooth", block: "start" });

$("signing-switch").onclick = async () => {
  const enabled = S.members.signing_enabled === false;
  if (!confirm(`确定${enabled ? "恢复" : "暂停"}所有人的自动签到吗？`)) return;
  const sw = $("signing-switch");
  sw.disabled = true;
  const { status, data } = await api("/api/signing", { token: S.token, enabled });
  sw.disabled = false;
  if (isExpired(status, data)) return expired();
  if (status !== 200) return showToast(data.error || "操作失败", "error");
  showToast(enabled ? "已恢复自动签到" : "已暂停自动签到");
  load();
};

startClock();
Cal.bind();
if (S.token) enter(); else showLogin();

setInterval(() => {
  if (document.visibilityState === "visible" && S.token && $("login-mask").hidden) load();
}, 60000);
