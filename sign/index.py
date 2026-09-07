"""
FC 函数入口
===========
同一函数挂两种触发器，handler 按 event 形态分发：
  - 定时触发器（每分钟，21:00-22:20）→ run_minute_sign：只签"专属时刻=当前分钟"的人
  - HTTP 触发器 → web.handle：状态页 / 历史 API / 注册接口

每人每天有专属签到时刻（哈希 openid+日期，人人不同、每天不同），到点签一次即止，
不轮询、不复查。签成功静默记录，失败才推送告警。
"""

import os
import json
import time
import random

import oss_store
import notify
from sign_core import sign_one_user, target_minute



def _is_timer_event(event):
    if isinstance(event, (bytes, bytearray)):
        event = event.decode("utf-8")
    if isinstance(event, str):
        try:
            event = json.loads(event)
        except Exception:
            return False
    if not isinstance(event, dict):
        return False
    # 定时触发器有 triggerTime/triggerName，且没有 HTTP 字段
    has_http = any(k in event for k in
                   ("httpMethod", "rawPath", "requestContext", "path"))
    has_timer = "triggerTime" in event or "triggerName" in event
    return has_timer and not has_http


def run_minute_sign():
    """
    每分钟触发：只签"专属时刻 = 当前这一分钟"的人。
    大多数分钟无人匹配，直接空跑退出。

    注意：拉黑的成员已移到 blacklist.json、删除的成员已移到 deleted.json，
    两者都不在 users.json 里，所以 get_users() 天然只含活跃成员，无需额外过滤。
    """
    if not oss_store.get_signing_enabled():
        return {"due": 0, "ok": 0, "skipped": "signing_disabled"}

    users = oss_store.get_users()
    now = time.localtime()
    today = time.strftime("%Y-%m-%d", now)
    cur_min = now.tm_hour * 60 + now.tm_min   # 当前是当天第几分钟

    # 挑出专属时刻 = 当前分钟的人
    due = [u for u in users
           if u.get("openid") and target_minute(u["openid"], today) == cur_min]
    if not due:
        return {"due": 0, "ok": 0}

    results, records = [], []
    for u in due:
        # 同一分钟内多人时加小幅抖动错开请求；保持小值，避免 N 人 × 大 sleep
        # 把单分钟总耗时顶到 FC timeout(300s) 之上导致后面的人漏签。
        time.sleep(random.uniform(0, 3))
        openid = u["openid"]
        nick = u.get("nickname", "未命名")
        try:
            r = sign_one_user(openid)
        except Exception as e:
            r = {"status": "error", "message": f"异常: {e}"}

        now_t = time.strftime("%H:%M", time.localtime())
        rec = {"nickname": nick, "date": today, "time": now_t,
               "status": r["status"], "message": r.get("message", "")}
        records.append(rec)
        results.append(rec)

    # 成功/异常/登录失败 落历史（not_yet/no_task 是过程态不落）
    meaningful = [r for r in records
                  if r["status"] in ("ok", "error", "login_failed")]
    oss_store.append_history(meaningful)

    # 只在「有失败/异常」时推送告警——成功静默，不打扰
    bad = [r for r in results if r["status"] in ("error", "login_failed")]
    if bad:
        notify.push("⚠️ 宿舍签到异常", notify.build_summary(results))

    return {"due": len(due),
            "ok": sum(1 for r in results if r["status"] == "ok")}



def _inject_credentials(context):
    """把 FC 注入的角色临时凭据从 context.credentials 取出塞进环境变量，
    供 oss_store 使用。不依赖 FC 是否自动设置 ALIBABA_CLOUD_* 环境变量。"""
    creds = getattr(context, "credentials", None)
    if not creds:
        return
    # FC Python SDK 的属性名可能是 access_key_id 或 accessKeyId，两者都试
    ak = getattr(creds, "access_key_id", None) or getattr(creds, "accessKeyId", None)
    sk = getattr(creds, "access_key_secret", None) or getattr(creds, "accessKeySecret", None)
    token = getattr(creds, "security_token", None) or getattr(creds, "securityToken", None)
    if ak:
        os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"] = ak
    if sk:
        os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"] = sk
    if token:
        os.environ["ALIBABA_CLOUD_SECURITY_TOKEN"] = token


def handler(event, context):
    _inject_credentials(context)

    if _is_timer_event(event):
        result = run_minute_sign()
        return json.dumps(result, ensure_ascii=False)

    import web
    return web.handle(event)
