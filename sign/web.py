"""
HTTP 路由层
===========
处理 FC HTTP 触发器事件，三条路由：
  GET  /              状态页（静态 HTML）
  GET  /api/history   返回今日总览 + 每人状态 + 历史（不含 openid）
  POST /register      校验预共享口令后写名册（采集工具调用）

绝不在任何响应中回显 openid。
"""

import os
import json
import time
import hashlib
import hmac

import oss_store

# 日历窗口天数（约 6 个月历史）
CALENDAR_DAYS = 185

REGISTER_SECRET = os.environ.get("REGISTER_SECRET", "")
# 管理员账号/密码（公网部署，放环境变量）。ADMIN_PASS 无默认值：缺失则禁用管理功能。
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "")
# 令牌签发密钥：仅存于环境变量的随机串，令牌据此用 HMAC 签发，源码泄露也无法伪造。
TOKEN_SECRET = os.environ.get("TOKEN_SECRET", "")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def _admin_enabled():
    """管理功能是否就绪（密码与令牌密钥都已配置）。"""
    return bool(ADMIN_PASS) and bool(TOKEN_SECRET)


def _token_for_hour(h):
    """用 TOKEN_SECRET 对 (账号:小时) 做 HMAC 签发不透明令牌。"""
    msg = f"{ADMIN_USER}:{h}".encode("utf-8")
    return hmac.new(TOKEN_SECRET.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _make_token():
    """登录令牌（按自然小时签发，校验时容忍前一小时，约 1-2 小时有效）。"""
    hour = time.strftime("%Y%m%d%H", time.localtime())
    return _token_for_hour(hour)


def _check_token(data):
    """校验请求里的管理员令牌（写操作必须通过）。容忍前一小时的令牌（时钟漂移）。"""
    if not _admin_enabled():
        return False
    tok = (data.get("token") or "").strip()
    if not tok:
        return False
    current_hour = time.strftime("%Y%m%d%H", time.localtime())
    prev_hour = time.strftime("%Y%m%d%H", time.localtime(time.time() - 3600))
    for h in (current_hour, prev_hour):
        if hmac.compare_digest(tok, _token_for_hour(h)):
            return True
    return False


# ------------------------------------------------------------------
# FC HTTP 事件解析 / 响应构造
# ------------------------------------------------------------------
def _parse_event(event):
    """把 FC HTTP 事件统一解析为 (method, path, query, body)。"""
    if isinstance(event, (bytes, bytearray)):
        event = event.decode("utf-8")
    if isinstance(event, str):
        try:
            event = json.loads(event)
        except Exception:
            event = {}

    method = (event.get("httpMethod")
              or event.get("method")
              or event.get("requestContext", {}).get("http", {}).get("method")
              or "GET").upper()
    path = (event.get("rawPath")
            or event.get("path")
            or event.get("requestContext", {}).get("http", {}).get("path")
            or "/")
    query = event.get("queryParameters") or event.get("queryString") or {}

    body = event.get("body", "")
    if event.get("isBase64Encoded") and body:
        import base64
        try:
            body = base64.b64decode(body).decode("utf-8")
        except Exception:
            pass
    return method, path, query, body


def _resp(status, body, content_type="application/json; charset=utf-8"):
    """
    构造 HTTP 响应。

    CORS：不手动加 Access-Control-Allow-Origin —— FC 的 HTTP 触发器已自带 CORS
    （回显请求的 Origin）。手动再加会导致响应出现两个 Allow-Origin 头，
    浏览器判定非法并拦截响应体（表现为 200 但内容为空）。
    """
    if not isinstance(body, (str, bytes)):
        body = json.dumps(body, ensure_ascii=False)
    return {
        "statusCode": status,
        "headers": {"Content-Type": content_type},
        "body": body,
    }


# ------------------------------------------------------------------
# 路由
# ------------------------------------------------------------------
def handle(event):
    method, path, query, body = _parse_event(event)

    # CORS 预检：浏览器跨域 POST 前会先发 OPTIONS，直接放行
    if method == "OPTIONS":
        return _resp(200, "")

    if path in ("/", "/index.html"):
        return _serve_static("index.html", "text/html; charset=utf-8")
    if path == "/app.js":
        return _serve_static("app.js", "application/javascript; charset=utf-8")
    if path == "/style.css":
        return _serve_static("style.css", "text/css; charset=utf-8")
    if path == "/api/members":
        return _resp(200, _build_members_view())
    if path == "/api/blacklist":
        return _resp(200, _build_inactive_view())
    if path == "/api/user":
        name = (query.get("name") or "").strip()
        if not name:
            return _resp(400, {"error": "缺少 name"})
        return _resp(200, _build_user_view(name))
    if path == "/api/login" and method == "POST":
        return _login(body)
    if path == "/api/blacklist/add" and method == "POST":
        return _admin_op(body, "add")
    if path == "/api/blacklist/restore" and method == "POST":
        return _admin_op(body, "restore")
    if path == "/api/blacklist/delete" and method == "POST":
        return _admin_op(body, "delete")
    if path == "/api/member/delete" and method == "POST":
        return _admin_op(body, "member_delete")
    if path == "/api/deleted/restore" and method == "POST":
        return _admin_op(body, "deleted_restore")
    if path == "/api/deleted/purge" and method == "POST":
        return _admin_op(body, "deleted_purge")
    if path == "/api/orphan/hide" and method == "POST":
        return _hide_orphan(body)
    if path == "/api/signing" and method == "POST":
        return _set_signing_enabled(body)
    if path == "/register" and method == "POST":
        return _register(body)

    return _resp(404, {"error": "not found"})


def _login(body):
    try:
        data = json.loads(body) if body else {}
    except Exception:
        return _resp(400, {"error": "请求体非法 JSON"})
    if not _admin_enabled():
        return _resp(503, {"error": "管理功能未启用（服务端缺 ADMIN_PASS/TOKEN_SECRET）"})
    user = (data.get("user") or "").strip()
    pw = data.get("password") or ""
    if user == ADMIN_USER and hmac.compare_digest(pw, ADMIN_PASS):
        return _resp(200, {"ok": True, "token": _make_token()})
    return _resp(403, {"error": "账号或密码错误"})


def _admin_op(body, op):
    """拉黑 / 恢复 / 删除，均需管理员令牌。"""
    try:
        data = json.loads(body) if body else {}
    except Exception:
        return _resp(400, {"error": "请求体非法 JSON"})
    if not _check_token(data):
        return _resp(403, {"error": "未授权，请先登录"})
    mid = (data.get("id") or "").strip()
    if not mid:
        return _resp(400, {"error": "缺少成员 id"})
    if op == "add":
        ok, nick = oss_store.move_to_blacklist(mid)
    elif op == "restore":
        ok, nick = oss_store.restore_from_blacklist(mid)
    elif op == "delete":
        ok, nick = oss_store.delete_from_blacklist(mid)
    elif op == "member_delete":
        ok, nick = oss_store.delete_user(mid)
    elif op == "deleted_restore":
        ok, nick = oss_store.restore_from_deleted(mid)
    elif op == "deleted_purge":
        ok, nick = oss_store.delete_permanently(mid, from_blacklist=False)
    else:
        return _resp(400, {"error": "未知操作"})
    if not ok:
        return _resp(404, {"error": "未找到该成员"})
    return _resp(200, {"ok": True, "nickname": nick})


def _hide_orphan(body):
    """把历史孤儿从成员列表隐藏（按昵称，孤儿没有 openid 可用）。"""
    try:
        data = json.loads(body) if body else {}
    except Exception:
        return _resp(400, {"error": "请求体非法 JSON"})
    if not _check_token(data):
        return _resp(403, {"error": "未授权，请先登录"})
    nickname = (data.get("nickname") or "").strip()
    if not nickname:
        return _resp(400, {"error": "缺少昵称"})
    ok, nick = oss_store.hide_orphan(nickname)
    if not ok:
        return _resp(400, {"error": "该成员不是历史孤儿，或保存失败"})
    return _resp(200, {"ok": True, "nickname": nick})


def _set_signing_enabled(body):
    """管理员开启或停止全部用户的自动签到。"""
    try:
        data = json.loads(body) if body else {}
    except Exception:
        return _resp(400, {"error": "请求体非法 JSON"})
    if not _check_token(data):
        return _resp(403, {"error": "未授权，请先登录"})
    enabled = data.get("enabled")
    if not isinstance(enabled, bool):
        return _resp(400, {"error": "enabled 必须是布尔值"})
    if not oss_store.set_signing_enabled(enabled):
        return _resp(502, {"error": "保存签到状态失败，请稍后重试"})
    return _resp(200, {"ok": True, "signing_enabled": enabled})


def _serve_static(name, content_type):
    try:
        with open(os.path.join(STATIC_DIR, name), "r", encoding="utf-8") as f:
            return _resp(200, f.read(), content_type)
    except Exception:
        return _resp(404, "not found", "text/plain; charset=utf-8")


def _register(body):
    try:
        data = json.loads(body) if body else {}
    except Exception:
        return _resp(400, {"error": "请求体非法 JSON"})

    secret = data.get("secret", "")
    openid = (data.get("openid") or "").strip()

    if not REGISTER_SECRET or secret != REGISTER_SECRET:
        return _resp(403, {"error": "口令错误"})
    if not openid:
        return _resp(400, {"error": "缺少 openid"})

    # 黑名单 openid 拒绝注册（被拉黑的人无法自己恢复）
    if oss_store.is_blacklisted(openid):
        return _resp(403, {"error": "该用户已被拉黑，无法注册"})

    # 已删除的成员重新注册即自动恢复，沿用旧昵称以接上历史记录
    if oss_store.is_deleted(openid):
        ok, old_nickname, total = oss_store.restore_deleted_by_openid(openid)
        if ok:
            return _resp(200, {"ok": True, "created": False, "restored": True,
                               "total": total, "nickname": old_nickname,
                               "signing_enabled": oss_store.get_signing_enabled()})

    # 用 openid 登录，自动取真实姓名；登录失败说明 openid 无效，当场拒绝
    import sign_core
    login = sign_core.login_via_openid(openid)
    if not login.get("success"):
        return _resp(400, {"error": f"openid 无效或登录失败: {login.get('error', '')}"})
    name = login.get("user_name") or login.get("account_no") or "未命名"

    created, total = oss_store.add_user(openid, name)
    return _resp(200, {"ok": True, "created": created, "total": total,
                       "nickname": name,
                       "signing_enabled": oss_store.get_signing_enabled()})


# ------------------------------------------------------------------
# 历史聚合（状态页数据源，绝不含 openid）
# 拆为两个视图以支撑数百人规模：
#   _build_members_view()    —— 轻量摘要（列表用），不含完整 records
#   _build_user_view(name)   —— 单人完整日历（点开某人才拉）
# ------------------------------------------------------------------
def _compute_best(history):
    """每人每天保留"最好"的一条（成功优先）。返回 {(nick,date): rec}。"""
    rank = {"ok": 3, "not_yet": 2, "no_task": 1}
    best = {}
    for r in history:
        nick, date = r.get("nickname"), r.get("date")
        if not nick or not date:
            continue
        cur = best.get((nick, date))
        if cur is None or rank.get(r.get("status"), 0) > rank.get(cur.get("status"), 0):
            best[(nick, date)] = r
    return best


def _window(days):
    now = time.time()
    return [time.strftime("%Y-%m-%d", time.localtime(now - i * 86400))
            for i in range(days)]


def _counts_by_nick(best):
    """一次遍历 best，聚合每人的 (ok_days, fail_days)。

    替代原先"每个成员再各自全表扫描一遍 best"的做法：那样是
    O(成员数² × 历史天数)，几百人规模下单次请求上千万次迭代；
    这里一趟 O(成员数 × 天数) 算好，成员循环里直接查表。
    """
    counts = {}
    for (nick, _d), rec in best.items():
        ok_days, fail_days = counts.get(nick, (0, 0))
        st = rec.get("status")
        if st == "ok":
            ok_days += 1
        elif st in ("login_failed", "error"):
            fail_days += 1
        counts[nick] = (ok_days, fail_days)
    return counts


def _scheduled(openid, date_str):
    """该人该天的预定签到时刻 HH:MM；无 openid（历史孤儿）返回空。"""
    if not openid:
        return ""
    import sign_core
    return sign_core.target_time_str(openid, date_str)


def _build_members_view(strip_days=7):
    """成员摘要列表（轻量）：每人今日状态 + 近 strip_days 天迷你条 + 计数。"""
    users = oss_store.get_users()
    bl = oss_store.get_blacklist()
    deleted = oss_store.get_deleted()
    history = oss_store.get_history()
    today = time.strftime("%Y-%m-%d", time.localtime())
    best = _compute_best(history)

    # 成员 + 历史孤儿，但排除黑名单和已删除
    #
    # 孤儿 = history.json 里有记录、却不在任何名单里的昵称。多为早期"硬删除"
    # 的遗留：记录连 openid 一起被抹掉，历史却留着，于是昵称又被捞回列表。
    # 这类条目 openid 为空，无法参与签到，也无法用 member_id 定位到任何名单，
    # 因此标记 orphan=True，前端只给它"清除记录"这一个操作。
    bl_nicks = {b.get("nickname") for b in bl}
    deleted_nicks = {d.get("nickname") for d in deleted}
    known_nicks = {u.get("nickname", "未命名") for u in users}
    nicknames = [(u.get("nickname", "未命名"), u.get("openid", ""), False) for u in users]
    for (nick, _d) in best:
        if nick not in known_nicks and nick not in bl_nicks and nick not in deleted_nicks:
            nicknames.append((nick, "", True))
            known_nicks.add(nick)

    strip_win = _window(strip_days)
    counts = _counts_by_nick(best)
    members = []
    ov_ok = ov_fail = ov_pending = 0
    for nick, openid, is_orphan in nicknames:
        ok_days, fail_days = counts.get(nick, (0, 0))

        today_rec = best.get((nick, today))
        today_status = today_rec.get("status") if today_rec else "pending"
        today_time = today_rec.get("time", "") if today_rec else ""

        strip = []
        for d in reversed(strip_win):
            rec = best.get((nick, d))
            strip.append(rec.get("status") if rec
                         else ("pending" if d == today else None))

        if today_status == "ok":
            ov_ok += 1
        elif today_status in ("login_failed", "error"):
            ov_fail += 1
        else:
            ov_pending += 1

        members.append({
            "id": oss_store.member_id(openid, nick),
            "nickname": nick,
            "orphan": is_orphan,
            "today_status": today_status,
            "today_time": today_time,
            "scheduled_time": _scheduled(openid, today),
            "strip": strip,
            "ok_days": ok_days,
            "fail_days": fail_days,
        })

    return {
        "today": today,
        "signing_enabled": oss_store.get_signing_enabled(),
        "overview": {"total": len(nicknames), "ok": ov_ok,
                     "fail": ov_fail, "pending": ov_pending},
        "members": members,
    }


def _build_inactive_view(strip_days=7):
    """非活跃成员视图：黑名单 + 已删除（供管理员查看）。

    两类人都保留 openid 与历史；区别在能否自助回归：
      blacklisted —— 注册接口拒绝，只能管理员手动恢复
      deleted     —— 重新注册即自动恢复（沿用旧昵称）
    """
    bl = oss_store.get_blacklist()
    history = oss_store.get_history()
    today = time.strftime("%Y-%m-%d", time.localtime())
    best = _compute_best(history)
    strip_win = _window(strip_days)
    counts = _counts_by_nick(best)

    items = []
    for b in bl:
        nick = b.get("nickname", "未命名")
        openid = b.get("openid", "")
        ok_days, fail_days = counts.get(nick, (0, 0))

        today_rec = best.get((nick, today))
        today_status = today_rec.get("status") if today_rec else "pending"
        today_time = today_rec.get("time", "") if today_rec else ""

        strip = []
        for d in reversed(strip_win):
            rec = best.get((nick, d))
            strip.append(rec.get("status") if rec
                         else ("pending" if d == today else None))

        items.append({
            "id": oss_store.member_id(openid, nick),
            "nickname": nick,
            "status_type": "blacklisted",
            "today_status": today_status,
            "today_time": today_time,
            "strip": strip,
            "ok_days": ok_days,
            "fail_days": fail_days,
            "blocked_at": b.get("blocked_at", ""),
        })

    # 已删除成员
    for item in oss_store.get_deleted():
        nick = item.get("nickname", "未命名")
        openid = item.get("openid", "")
        ok_days, fail_days = counts.get(nick, (0, 0))

        today_rec = best.get((nick, today))
        today_status = today_rec.get("status") if today_rec else "pending"
        today_time = today_rec.get("time", "") if today_rec else ""

        strip = []
        for d in reversed(strip_win):
            rec = best.get((nick, d))
            strip.append(rec.get("status") if rec
                         else ("pending" if d == today else None))

        items.append({
            "id": oss_store.member_id(openid, nick),
            "nickname": nick,
            "status_type": "deleted",
            # 无 openid 的孤儿恢复出来也签不了到，前端据此只留"彻底删除"
            "orphan": not openid,
            "today_status": today_status,
            "today_time": today_time,
            "strip": strip,
            "ok_days": ok_days,
            "fail_days": fail_days,
            "deleted_at": item.get("deleted_at", ""),
        })

    return {"inactive": items}


def _build_user_view(name, days=CALENDAR_DAYS):
    """单人完整日历数据（点开某人时拉）。"""
    history = oss_store.get_history()
    today = time.strftime("%Y-%m-%d", time.localtime())
    best = _compute_best(history)
    window = _window(days)
    window_set = set(window)

    records = {}
    ok_days = fail_days = 0
    for (n, d), rec in best.items():
        if n != name or d not in window_set:
            continue
        st = rec.get("status")
        records[d] = {"status": st, "time": rec.get("time", "")}
        if st == "ok":
            ok_days += 1
        elif st in ("login_failed", "error"):
            fail_days += 1

    return {
        "nickname": name,
        "today": today,
        "min_date": window[-1],
        "stats": {"ok_days": ok_days, "fail_days": fail_days},
        "records": records,
    }
