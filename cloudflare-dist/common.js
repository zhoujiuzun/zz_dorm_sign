// 公共模块：接口地址、状态表、工具函数、月历、签到设置面板（用户页与管理页共用）

// FC 后端 API 地址。前端托管在 Cloudflare Pages，跨域调用此地址。
const API_BASE = "https://sign-bprgxfyexe.cn-beijing.fcapp.run";

const STATUS = {
  ok:           { cls: "d-ok",      text: "已签到" },
  not_yet:      { cls: "d-pending", text: "未到点" },
  no_task:      { cls: "d-none",    text: "无任务" },
  login_failed: { cls: "d-fail",    text: "登录失败" },
  error:        { cls: "d-fail",    text: "异常" },
  pending:      { cls: "d-pending", text: "未签" },
};

function $(id) { return document.getElementById(id); }
function pad(n) { return String(n).padStart(2, "0"); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function showToast(msg, kind) {
  const t = document.createElement("div");
  t.className = "toast" + (kind === "error" ? " toast-error" : "");
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, kind === "error" ? 3800 : 2200);
}

// 顶栏时钟（秒级跳动）
function startClock() {
  const tick = () => {
    const n = new Date();
    $("today").textContent = `${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日 ` +
      `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}
// 统一请求：有 body 走 POST JSON，否则 GET。网络错误返回 status 0。
async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  try {
    const r = await fetch(API_BASE + path, opt);
    let data = {};
    try { data = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: { error: "网络错误，请检查网络后重试" } };
  }
}

// 按钮忙碌态：请求期间禁用并换文案，防止重复点击
async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

// 近 7 天迷你条
function stripHtml(strip) {
  return (strip || []).map(s =>
    `<i class="tick ${s ? (STATUS[s] || STATUS.pending).cls : "d-none"}"></i>`).join("");
}
// 月历：拉 /api/user 渲染某人的日历。seq 防止快速切换时旧响应覆盖新的。
const Cal = {
  name: "", data: null, year: 0, month: 0, seq: 0,

  clear() { this.name = ""; this.data = null; this.seq++; },

  async load(name, keepMonth) {
    const same = name === this.name && !!this.data;
    this.name = name;
    const seq = ++this.seq;
    if (!same) {
      this.data = null;
      $("uc-okdays").textContent = "已签 -- 天";
      $("uc-faildays").textContent = "异常 -- 天";
      $("cal-body").innerHTML = '<tr><td colspan="7" class="cal-loading">加载中…</td></tr>';
    }
    const { status, data } = await api("/api/user?name=" + encodeURIComponent(name));
    if (seq !== this.seq) return;
    if (status !== 200) {
      if (!same) $("cal-body").innerHTML = '<tr><td colspan="7" class="cal-loading">加载失败</td></tr>';
      return;
    }
    this.data = data;
    if (!(same && keepMonth)) {
      [this.year, this.month] = data.today.split("-").map(Number);
    }
    $("uc-okdays").textContent = `已签 ${data.stats.ok_days} 天`;
    $("uc-faildays").textContent = `异常 ${data.stats.fail_days} 天`;
    this.render();
  },

  shift(delta) {
    const idx = this.year * 12 + this.month - 1 + delta;
    this.year = Math.floor(idx / 12);
    this.month = idx % 12 + 1;
    this.render();
  },

  bind() {
    $("prev-month").onclick = () => this.shift(-1);
    $("next-month").onclick = () => this.shift(1);
  },
  render() {
    const d = this.data;
    if (!d) return;
    const y = this.year, m = this.month;
    $("cal-title").textContent = `${y}年${m}月`;
    const [minY, minM] = d.min_date.split("-").map(Number);
    const [maxY, maxM] = d.today.split("-").map(Number);
    const cur = y * 12 + m - 1;
    $("prev-month").disabled = cur <= minY * 12 + minM - 1;
    $("next-month").disabled = cur >= maxY * 12 + maxM - 1;

    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;   // 周一为一周第一天
    const days = new Date(y, m, 0).getDate();
    const cells = Array(lead).fill(null);
    for (let i = 1; i <= days; i++) cells.push(i);
    while (cells.length % 7) cells.push(null);

    let html = "";
    for (let i = 0; i < cells.length; i += 7) {
      html += "<tr>";
      for (const dd of cells.slice(i, i + 7)) {
        if (dd == null) { html += '<td class="blank"></td>'; continue; }
        const date = `${y}-${pad(m)}-${pad(dd)}`;
        const rec = d.records[date];
        let cls = "d-none", title = `${date} 无记录`;
        if (date === d.today && !rec) { cls = "d-pending"; title = `${date} 未签`; }
        if (rec) {
          const s = STATUS[rec.status] || STATUS.pending;
          cls = s.cls;
          title = `${date} ${s.text}${rec.time ? " " + rec.time : ""}`;
          // 失败/异常时把原因带进悬浮提示
          if (rec.message && (rec.status === "login_failed" || rec.status === "error")) {
            title += "\n" + rec.message;
          }
        }
        html += `<td class="cell${date === d.today ? " is-today" : ""}" title="${esc(title)}">` +
                `<span class="stamp ${cls}">${dd}</span></td>`;
      }
      html += "</tr>";
    }
    $("cal-body").innerHTML = html;
  },
};
// 时间对话框：指定今天时刻 / 修改每天时段 共用。按需注入页面，两个页面不必各写一份。
const TimeDialog = {
  el: null,

  ensure() {
    if (this.el) return;
    const mask = document.createElement("div");
    mask.className = "login-mask";
    mask.hidden = true;
    mask.innerHTML =
      '<form class="login-box dialog" novalidate role="dialog" aria-modal="true" aria-labelledby="td-title">' +
        '<h2 id="td-title"></h2>' +
        '<p class="dialog-desc" id="td-desc"></p>' +
        '<div class="time-fields" id="td-fields"></div>' +
        '<div class="login-err" id="td-err" role="alert"></div>' +
        '<button type="submit" class="btn-primary" id="td-ok">保存</button>' +
        '<div class="dialog-foot">' +
          '<button type="button" class="btn-link" id="td-alt"></button>' +
          '<button type="button" class="btn-link" id="td-cancel">取消</button>' +
        "</div>" +
      "</form>";
    document.body.appendChild(mask);
    mask.addEventListener("click", e => { if (e.target === mask) this.close(); });
    mask.querySelector("#td-cancel").onclick = () => this.close();
    mask.addEventListener("keydown", e => { if (e.key === "Escape") this.close(); });
    this.el = mask;
  },

  close() { if (this.el) this.el.hidden = true; },
  // opts: {title, desc, fields:[{key,label,value,min,max}], submit(vals)->Promise<{status,data}>,
  //        alt:{label, run()->Promise<{status,data}>}, onDone(status, data)}
  open(opts) {
    this.ensure();
    const el = this.el;
    el.querySelector("#td-title").textContent = opts.title;
    el.querySelector("#td-desc").textContent = opts.desc || "";
    el.querySelector("#td-err").textContent = "";
    el.querySelector("#td-fields").innerHTML = opts.fields.map(f =>
      `<label class="time-field"><span>${esc(f.label)}</span>` +
      `<input type="time" class="time-input" data-key="${esc(f.key)}" value="${esc(f.value || "")}"` +
      ` min="${esc(f.min || "")}" max="${esc(f.max || "")}" step="60" required></label>`).join("");

    const ok = el.querySelector("#td-ok");
    const alt = el.querySelector("#td-alt");
    const finish = (btn, label, run) => withBusy(btn, label, run).then(({ status, data }) => {
      if (status === 200) { this.close(); opts.onDone(status, data); return; }
      if (status === 401) { this.close(); opts.onDone(status, data); return; }
      el.querySelector("#td-err").textContent = data.error || "保存失败，请重试";
    });

    el.querySelector("form").onsubmit = e => {
      e.preventDefault();
      const vals = {};
      for (const inp of el.querySelectorAll(".time-input")) {
        if (!inp.value) { el.querySelector("#td-err").textContent = "请选择时间"; return; }
        vals[inp.dataset.key] = inp.value;
      }
      finish(ok, "保存中…", () => opts.submit(vals));
    };
    alt.hidden = !opts.alt;
    if (opts.alt) {
      alt.textContent = opts.alt.label;
      alt.onclick = () => finish(alt, "处理中…", opts.alt.run);
    }
    el.hidden = false;
    el.querySelector(".time-input").focus();
  },
};
// 签到设置面板：学号 / 今天时刻 / 每天时段 + 立即签到 / 指定今天时刻 / 修改每天时段
// ctx: {token, sys:{start,end}, onChange(member), onExpired()}
const Settings = {
  render(box, m, ctx) {
    const t = m.today;
    const today = t.signed ? '<span class="tag tag-ok">今天已签到</span>'
      : `<b class="num">${esc(t.time)}</b>` + (t.manual ? '<span class="tag tag-accent">已指定</span>'
        : t.passed ? '<span class="tag tag-muted">已过点</span>' : '<span class="tag tag-pending">待签</span>');
    box.innerHTML =
      '<div class="kv-list">' +
        `<div class="kv kv-sid"><span class="k">学号</span><span class="v">${esc(m.student_id || "未获取")}</span></div>` +
        `<div class="kv"><span class="k">今天签到</span><span class="v">${today}</span></div>` +
        `<div class="kv"><span class="k">每天时段</span><span class="v"><b class="num">` +
          `${esc(m.window.start)}–${esc(m.window.end)}</b>` +
          `${m.window.custom ? "" : '<span class="tag tag-muted">默认</span>'}</span></div>` +
      "</div>" +
      '<div class="action-row">' +
        '<button type="button" class="btn-primary" data-act="now">立即签到</button>' +
        '<button type="button" class="btn-secondary" data-act="today">指定今天时刻</button>' +
        '<button type="button" class="btn-secondary" data-act="window">修改每天时段</button>' +
      "</div>";
    const btn = act => box.querySelector(`[data-act="${act}"]`);
    btn("now").disabled = btn("today").disabled = t.signed;
    btn("now").onclick = () => this.signNow(btn("now"), m, ctx);
    btn("today").onclick = () => this.editToday(m, ctx);
    btn("window").onclick = () => this.editWindow(m, ctx);
  },

  done(ctx, data) {
    if (data.message) showToast(data.message);
    ctx.onChange(data.member);
  },

  async signNow(button, m, ctx) {
    if (!confirm(`现在为「${m.nickname}」提交一次签到？`)) return;
    const { status, data } = await withBusy(button, "签到中…",
      () => api("/api/member/sign-now", { id: m.id, token: ctx.token }));
    if (status === 401) return ctx.onExpired();
    if (status !== 200) return showToast(data.error || "签到失败", "error");
    this.done(ctx, data);
  },
  editToday(m, ctx) {
    const sys = ctx.sys;
    TimeDialog.open({
      title: "指定今天的签到时刻",
      desc: `只对今天生效，明天起恢复按时段随机。可选 ${sys.start}–${sys.end}，须晚于现在。`,
      fields: [{ key: "time", label: "签到时刻", value: m.today.time, min: sys.start, max: sys.end }],
      submit: v => api("/api/member/sign-today", { id: m.id, token: ctx.token, time: v.time }),
      alt: m.today.manual ? {
        label: "取消指定",
        run: () => api("/api/member/sign-today", { id: m.id, token: ctx.token, time: "" }),
      } : null,
      onDone: (status, data) => status === 401 ? ctx.onExpired() : this.done(ctx, data),
    });
  },

  editWindow(m, ctx) {
    const sys = ctx.sys;
    TimeDialog.open({
      title: "修改每天的签到时段",
      desc: `系统每天在这个时段内随机挑一个时刻签到，须在 ${sys.start}–${sys.end} 之内。` +
            "从明天起生效，今天的时刻不变。",
      fields: [
        { key: "start", label: "最早", value: m.window.start, min: sys.start, max: sys.end },
        { key: "end", label: "最晚", value: m.window.end, min: sys.start, max: sys.end },
      ],
      submit: v => api("/api/member/sign-window", { id: m.id, token: ctx.token, start: v.start, end: v.end }),
      alt: m.window.custom ? {
        label: "恢复默认时段",
        run: () => api("/api/member/sign-window", { id: m.id, token: ctx.token, reset: true }),
      } : null,
      onDone: (status, data) => status === 401 ? ctx.onExpired() : this.done(ctx, data),
    });
  },
};
