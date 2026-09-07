"""
Server酱 推送
=============
每日签到完成后把汇总推送给管理员一人。
SendKey 从环境变量 SERVERCHAN_KEY 读取，绝不硬编码。
"""

import os
import requests


def push(title, content):
    """推送一条消息到 Server酱。无 key 时静默跳过，不影响签到主流程。"""
    key = os.environ.get("SERVERCHAN_KEY", "")
    if not key:
        return False
    url = f"https://sctapi.ftqq.com/{key}.send"
    try:
        resp = requests.post(
            url,
            data={"title": title, "desp": content},
            timeout=15,
        )
        return resp.status_code == 200
    except Exception:
        return False


def build_summary(results):
    """
    把每用户结果列表拼成 Markdown 推送正文。
    results: list[{nickname, date, time, status, message}]
    """
    label = {
        "ok": "✅ 成功",
        "no_task": "➖ 无任务",
        "not_yet": "⏳ 未到点",
        "login_failed": "🔑 登录失败",
        "error": "⚠️ 异常",
    }
    ok = sum(1 for r in results if r["status"] == "ok")
    fail = sum(1 for r in results if r["status"] in ("login_failed", "error"))
    lines = [f"**今日签到汇总** 共 {len(results)} 人 · {ok} 成功 · {fail} 异常", ""]
    for r in results:
        tag = label.get(r["status"], r["status"])
        t = f" {r['time']}" if r.get("time") else ""
        lines.append(f"- {r['nickname']}：{tag}{t}　{r.get('message', '')}")
    return "\n".join(lines)
