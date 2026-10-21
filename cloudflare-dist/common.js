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

function isFail(st) { return st === "error" || st === "login_failed"; }
const WEEK = "日一二三四五六";

// 距今天 HH:MM 还有多久；已过返回空串
function countdown(hm) {
  const [h, mi] = hm.split(":").map(Number);
  const n = new Date();
  const diff = h * 60 + mi - (n.getHours() * 60 + n.getMinutes());
  if (diff <= 0) return "";
  return diff < 60 ? `还有 ${diff} 分钟` : `还有 ${Math.floor(diff / 60)} 小时 ${diff % 60} 分`;
}
// 月历：拉 /api/user 渲染某人的日历。seq 防止快速切换时旧响应覆盖新的。
const Cal = {
  name: "", data: null, year: 0, month: 0, seq: 0, sel: "",

  clear() { this.name = ""; this.data = null; this.sel = ""; this.seq++; },

  async load(name, keepMonth) {
    const same = name === this.name && !!this.data;
    this.name = name;
    const seq = ++this.seq;
    if (!same) {
      this.data = null;
      this.sel = "";
      $("cal-detail").innerHTML = "";
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
      this.sel = data.today;
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
    $("cal-body").onclick = e => {
      const b = e.target.closest("[data-date]");
      if (b) { this.sel = b.dataset.date; this.render(); }
    };
  },
  // 某天的状态说明（日历下方详情用）
  info(date) {
    const d = this.data, rec = d.records[date];
    if (rec) {
      const s = STATUS[rec.status] || STATUS.pending;
      return { cls: s.cls, text: s.text, time: rec.time || "", msg: isFail(rec.status) ? rec.message || "" : "" };
    }
    if (date === d.today) return { cls: "d-pending", text: "今天还没有记录", time: "", msg: "" };
    return { cls: "d-none", text: "无记录", time: "", msg: "" };
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
        if (dd == null) { html += "<td></td>"; continue; }
        const date = `${y}-${pad(m)}-${pad(dd)}`;
        if (date > d.today) { html += `<td><span class="stamp future">${dd}</span></td>`; continue; }
        const x = this.info(date);
        const cls = `stamp ${x.cls}${date === d.today ? " is-today" : ""}${date === this.sel ? " is-sel" : ""}`;
        const label = `${m}月${dd}日 ${x.text}${x.time ? " " + x.time : ""}`;
        html += `<td><button type="button" class="${cls}" data-date="${date}" aria-label="${esc(label)}"` +
                ` title="${esc(label + (x.msg ? "\n" + x.msg : ""))}">${dd}</button></td>`;
      }
      html += "</tr>";
    }
    $("cal-body").innerHTML = html;
    this.detail();
  },

  // 日历下方：选中那天的状态、时间和失败原因（手机上没有悬浮提示，点一下就能看）
  detail() {
    const box = $("cal-detail");
    if (!this.sel || !this.data) { box.innerHTML = ""; return; }
    const [y, m, dd] = this.sel.split("-").map(Number);
    const x = this.info(this.sel);
    box.innerHTML =
      `<span class="cd-date">${m}月${dd}日 周${WEEK[new Date(y, m - 1, dd).getDay()]}</span>` +
      `<span class="badge ${x.cls}">${esc(x.text)}</span>` +
      (x.time ? `<span class="cd-time">${esc(x.time)}</span>` : "") +
      (x.msg ? `<span class="cd-msg">${esc(x.msg)}</span>` : "");
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
      '<form class="dialog" novalidate role="dialog" aria-modal="true" aria-labelledby="td-title">' +
        '<h2 id="td-title"></h2>' +
        '<p class="dialog-desc" id="td-desc"></p>' +
        '<div class="time-fields" id="td-fields"></div>' +
        '<div class="form-err" id="td-err" role="alert"></div>' +
        '<button type="submit" class="btn btn-primary btn-block" id="td-ok">保存</button>' +
        '<div class="dialog-foot">' +
          '<button type="button" class="link-btn" id="td-alt"></button>' +
          '<button type="button" class="link-btn" id="td-cancel">取消</button>' +
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
      `<input type="time" class="input time-input" data-key="${esc(f.key)}" value="${esc(f.value || "")}"` +
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
// 签到设置（用户页与管理页共用）
//   today(): 今天的状态 + 立即签到 / 指定今天时刻    info(): 学号与每天时段
// v: {m: 设置, day: {status,time}|null, paused, showSid}
// ctx: {token, sys:{start,end}, onChange(member), onExpired()}
const Settings = {
  today(box, v, ctx) {
    const { m, day, paused } = v;
    const t = m.today;
    const signed = t.signed || (day && day.status === "ok");
    const failed = !signed && day && isFail(day.status);
    let tone = "wait", title = paused ? "假期暂停中" : "今天将自动签到", big = t.time, sub;
    if (signed) {
      [tone, title, big, sub] = ["ok", "今天已签到", (day && day.time) || "✓", "签到成功，明天见"];
    } else if (failed) {
      [tone, title, sub] = ["fail", "今天签到失败", "可以立即重签，或指定一个更晚的时刻"];
    } else if (t.passed) {
      [tone, title, sub] = ["warn", "今天的时刻已过", "还没有成功记录，可以立即签到"];
    } else {
      sub = paused ? "暂停期间不会自动签到，可以手动签到"
        : `${countdown(t.time) || "即将签到"} · ${t.manual ? "已指定时刻" : "时段内随机"}`;
    }
    box.className = `today-block tone-${tone}${paused && tone === "wait" ? " is-paused" : ""}`;
    box.innerHTML =
      `<div class="tb-title">${esc(title)}</div>` +
      `<div class="tb-time">${esc(big)}</div>` +
      `<div class="tb-sub">${esc(sub)}</div>` +
      (signed ? "" : '<div class="tb-actions">' +
        '<button type="button" class="btn btn-primary" data-act="now">立即签到</button>' +
        `<button type="button" class="btn btn-soft" data-act="today">${t.manual ? "改指定时刻" : "指定今天时刻"}</button>` +
        "</div>");
    if (signed) return;
    const now = box.querySelector('[data-act="now"]');
    now.onclick = () => this.signNow(now, m, ctx);
    box.querySelector('[data-act="today"]').onclick = () => this.editToday(m, ctx);
  },

  info(box, v, ctx) {
    const { m, showSid } = v;
    box.innerHTML =
      (showSid ? `<div class="kv"><span class="k">学号</span><span class="v">${esc(m.student_id || "未获取")}</span></div>` : "") +
      '<div class="kv"><span class="k">每天时段</span><span class="v">' +
        `<b class="num">${esc(m.window.start)}–${esc(m.window.end)}</b>` +
        `<span class="tag ${m.window.custom ? "tag-accent" : "tag-muted"}">${m.window.custom ? "自定义" : "默认"}</span>` +
        '<button type="button" class="link-btn" data-act="window">修改</button></span></div>' +
      '<p class="hint">每天在这个时段内随机挑一个时刻自动签到，修改从明天起生效。</p>';
    box.querySelector('[data-act="window"]').onclick = () => this.editWindow(m, ctx);
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
