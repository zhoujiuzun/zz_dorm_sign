"""
签到核心逻辑
============
从原 sign.py 重构，供 FC 定时函数与本地测试脚本共用。

关键修正（相对原脚本）：
  submit_sign 不再使用全局写死的坐标，而是取该用户登记宿舍坐标
  （getTaskByIdForApp 返回的 dormitoryRegisterVO.locationLat/locationLng），
  并用 haversine 计算签到坐标到登记坐标的真实距离填入 locationAccuracy，
  对标小程序 chunk_9 中的 getDistance 逻辑。

凭据全部从环境变量读取，不再硬编码。
"""

import os
import json
import time
import math
import base64
import hashlib
import random
import socket
from urllib.parse import urlparse

import requests
import urllib3

urllib3.disable_warnings()

# ------------------------------------------------------------------
# 专属签到时刻：每人每天一个固定时刻，落在 21:00–22:20 之间
#   哈希(openid+日期)：同人同天固定、人人不同、每天变化
#   供定时签到(index.py)与看板(web.py)共用
# ------------------------------------------------------------------
SIGN_WINDOW_START_MIN = 21 * 60   # 21:00
SIGN_WINDOW_SLOTS = 81            # 21:00..22:20


def target_minute(openid, date_str):
    """返回该人该天专属签到时刻的"当天分钟数"（如 1268 = 21:08）。"""
    h = hashlib.sha256(f"{openid}:{date_str}".encode("utf-8")).hexdigest()
    return SIGN_WINDOW_START_MIN + int(h, 16) % SIGN_WINDOW_SLOTS


def target_time_str(openid, date_str):
    """返回该人该天专属签到时刻的 HH:MM 字符串。"""
    m = target_minute(openid, date_str)
    return f"{m // 60:02d}:{m % 60:02d}"


# ------------------------------------------------------------------
# 配置（环境变量）
# ------------------------------------------------------------------
BASE_URL = os.environ.get("BASE_URL", "https://simp.csuft.edu.cn")
CLIENT_ID = os.environ.get("CLIENT_ID", "flysource_wise_wxapp")
CLIENT_SECRET = os.environ.get("CLIENT_SECRET", "")
TENANT_ID = os.environ.get("TENANT_ID", "000000")

# ------------------------------------------------------------------
# DNS 绕过：FC 容器内解析不了 simp.csuft.edu.cn（.edu.cn 域名），
# 但能直连其公网 IP。这里用 DoH（HTTPS 到 223.5.5.5，是 IP 无需 DNS）
# 拿到真实 IP，并拦截 socket.getaddrinfo 把该域名指过去。
# 写死 IP 作兜底（DoH 失败时用）。
# ------------------------------------------------------------------
_SCHOOL_HOST = urlparse(BASE_URL).hostname or "simp.csuft.edu.cn"
_SCHOOL_IP_FALLBACK = os.environ.get("SCHOOL_IP", "218.76.12.57")
_school_ip_cache = None


def _resolve_school_ip():
    global _school_ip_cache
    if _school_ip_cache:
        return _school_ip_cache
    try:
        r = requests.get(
            f"https://223.5.5.5/resolve?name={_SCHOOL_HOST}&type=A",
            timeout=8, verify=False)
        answers = r.json().get("Answer", [])
        for a in answers:
            if a.get("type") == 1 and a.get("data"):
                _school_ip_cache = a["data"]
                return _school_ip_cache
    except Exception:
        pass
    _school_ip_cache = _SCHOOL_IP_FALLBACK
    return _school_ip_cache


_orig_getaddrinfo = socket.getaddrinfo


def _patched_getaddrinfo(host, *args, **kwargs):
    if host == _SCHOOL_HOST:
        host = _resolve_school_ip()
    return _orig_getaddrinfo(host, *args, **kwargs)


socket.getaddrinfo = _patched_getaddrinfo

HEADERS_TEMPLATE = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 "
                  "MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows "
                  "WindowsWechat/WMPF XWEB/14655",
    "xweb_xhr": "1",
    "web-type": "wxapp",
    "tenant-id": TENANT_ID,
    "accept": "*/*",
    "referer": "https://servicewechat.com/wx0e47c34c9982aa09/7/page-frame.html",
    "Content-Type": "application/json",
}


# ------------------------------------------------------------------
# JWT / 签名工具
# ------------------------------------------------------------------
def decode_jwt(token):
    try:
        payload_b64 = token.split('.')[1]
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += '=' * padding
        return json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return None


def get_token_expiry(token):
    payload = decode_jwt(token)
    if payload and "exp" in payload:
        return payload["exp"]
    return None


def is_token_expired(token, buffer=300):
    exp = get_token_expiry(token)
    if exp is None:
        return False
    return time.time() >= exp - buffer


def generate_sign(url, timestamp, token):
    parsed = urlparse(url)
    url_path = parsed.path
    part1 = hashlib.md5(f"{timestamp}{token}".encode('utf-8')).hexdigest()
    sign_input = f"{url_path}?sign={part1}"
    part2 = hashlib.md5(sign_input.encode('utf-8')).hexdigest()
    ts_b64 = base64.b64encode(str(timestamp).encode('utf-8')).decode('utf-8')
    return f"{part2}1.{ts_b64}"


def make_basic_auth():
    return base64.b64encode(
        f"{CLIENT_ID}:{CLIENT_SECRET}".encode('utf-8')
    ).decode('utf-8')


def haversine(lat1, lng1, lat2, lng2):
    """两点间距离（米），对标小程序 getDistance。"""
    r = 6378137.0
    rad1, rad2 = math.radians(lat1), math.radians(lat2)
    dlat = rad1 - rad2
    dlng = math.radians(lng1) - math.radians(lng2)
    a = math.sin(dlat / 2) ** 2 + math.cos(rad1) * math.cos(rad2) * math.sin(dlng / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)), 2)


# ------------------------------------------------------------------
# 会话 / 登录 / Token
# ------------------------------------------------------------------
def create_session(token=None):
    session = requests.Session()
    session.verify = False
    basic_auth = make_basic_auth()
    headers = {**HEADERS_TEMPLATE, "Authorization": f"Basic {basic_auth}"}
    if token:
        headers["FlySource-Auth"] = token
    session.headers.update(headers)
    return session


def login_via_openid(openid):
    """用 OpenID 换 access_token（grant_type=wxapp，无验证码）。"""
    url = f"{BASE_URL}/api/flySource-auth/oauth/token"
    headers = {
        "Web-Type": "wxapp",
        "Tenant-Id": TENANT_ID,
        "Authorization": f"Basic {make_basic_auth()}",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    data = {
        "tenantId": TENANT_ID,
        "grant_type": "wxapp",
        "openid": openid,
        "scope": "all",
    }
    try:
        resp = requests.post(url, data=data, headers=headers, timeout=15, verify=False)
        result = resp.json()
        if resp.status_code == 200 and result.get("access_token"):
            # 同一响应里带真实姓名/学号，顺手取出（见解包 setLoginInfo）
            return {
                "success": True,
                "access_token": result["access_token"],
                "user_name": result.get("userName", ""),
                "account_no": result.get("accountNo", ""),
            }
        return {"success": False,
                "error": result.get("error_description", resp.text[:200])}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ------------------------------------------------------------------
# 任务接口
# ------------------------------------------------------------------
def get_task_list(session):
    url = f"{BASE_URL}/api/flySource-yxgl/dormSignTask/getListForApp"
    timestamp = int(time.time() * 1000)
    token = session.headers.get("FlySource-Auth", "")
    headers = {"FlySource-sign": generate_sign(url, timestamp, token)}
    try:
        resp = session.get(url, params={"current": 1, "size": 10},
                           headers=headers, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if data.get("code") == 401:
            return None
        return data
    except Exception:
        return None


def get_task_detail(session, task_id):
    url = f"{BASE_URL}/api/flySource-yxgl/dormSignTask/getTaskByIdForApp"
    timestamp = int(time.time() * 1000)
    token = session.headers.get("FlySource-Auth", "")
    headers = {"FlySource-sign": generate_sign(url, timestamp, token)}
    try:
        resp = session.get(url, params={"taskId": task_id},
                           headers=headers, timeout=30)
        return resp.json()
    except Exception:
        return None


# ------------------------------------------------------------------
# 签到提交（核心修正：坐标取自登记宿舍，距离用 haversine 实算）
# ------------------------------------------------------------------
def submit_sign(session, task_id, task_detail_data):
    url = f"{BASE_URL}/api/flySource-yxgl/dormSignRecord/stuSign"

    scan_type = task_detail_data.get("scanType", 1)
    dorm_info = task_detail_data.get("dormitoryRegisterVO", {}) or {}
    room_id = dorm_info.get("roomId", "")
    is_late_stu_take_photo = task_detail_data.get("isLateStuTakePhoto", 0)

    # 该用户登记宿舍坐标 —— 每人各不相同，非全局写死
    dorm_lat = dorm_info.get("locationLat")
    dorm_lng = dorm_info.get("locationLng")
    try:
        dorm_lat = float(dorm_lat)
        dorm_lng = float(dorm_lng)
    except (TypeError, ValueError):
        return {"code": 500, "msg": "任务详情缺少有效的登记宿舍坐标(dormitoryRegisterVO)"}

    # 在登记坐标附近做微小抖动作为签到坐标，并实算距离
    lat = dorm_lat + random.uniform(-0.00003, 0.00003)
    lng = dorm_lng + random.uniform(-0.00003, 0.00003)
    accuracy = haversine(lat, lng, dorm_lat, dorm_lng)

    sign_date = time.strftime("%Y-%m-%d", time.localtime())
    sign_data_dict = {
        "latitude": str(lat),
        "longitude": str(lng),
        "locationAccuracy": str(accuracy),
        "signDate": sign_date,
        "taskId": str(task_id),
        "fileId": "",
    }
    sign_str = json.dumps(sign_data_dict, separators=(',', ':'))
    stu_task_id = hashlib.md5(sign_str.encode('utf-8')).hexdigest()

    payload = {
        "taskId": str(task_id),
        "scanType": scan_type,
        "roomId": room_id,
        "isLateStuTakePhoto": is_late_stu_take_photo,
        "signLat": lat,
        "signLng": lng,
        "locationAccuracy": accuracy,
        "fileId": "",
        "stuTaskId": stu_task_id,
        "signType": 0,
        "scanCode": "",
    }

    timestamp = int(time.time() * 1000)
    token = session.headers.get("FlySource-Auth", "")
    headers = {"FlySource-sign": generate_sign(url, timestamp, token)}
    try:
        resp = session.post(url, json=payload, headers=headers, timeout=30)
        return resp.json()
    except Exception as e:
        return {"code": 500, "msg": str(e)}


# ------------------------------------------------------------------
# 单用户签到入口
# ------------------------------------------------------------------
def sign_one_user(openid):
    """
    用 openid 完成一次签到尝试。
    返回 {status, message}：
      status ∈ {ok, no_task, not_yet, login_failed, error}
    """
    login = login_via_openid(openid)
    if not login["success"]:
        return {"status": "login_failed",
                "message": f"登录失败: {login.get('error', '')}"}

    token = login["access_token"]
    session = create_session(token)

    tasks_res = get_task_list(session)
    if tasks_res is None:
        return {"status": "error", "message": "获取任务列表失败(可能认证失效)"}

    task_list = tasks_res.get("data", {}).get("records", [])
    if not task_list:
        return {"status": "no_task", "message": "当前没有待签到任务"}

    results = []
    any_ok = any_not_yet = False
    for task in task_list:
        task_id = task.get("taskId")
        task_name = task.get("taskName", "")

        detail_res = get_task_detail(session, task_id)
        if not detail_res or not detail_res.get("success"):
            results.append(f"{task_name}: 获取详情失败")
            continue

        result = submit_sign(session, task_id, detail_res.get("data", {}))
        code = result.get("code")
        msg = result.get("msg", "")
        if code == 200 or result.get("success"):
            any_ok = True
            results.append(f"{task_name}: 成功")
        elif "未到签到时间" in msg:
            any_not_yet = True
            results.append(f"{task_name}: 未到签到时间")
        else:
            results.append(f"{task_name}: {msg or '异常'}")

    if any_ok:
        status = "ok"
    elif any_not_yet:
        status = "not_yet"
    else:
        status = "error"
    return {"status": status, "message": "; ".join(results)}
