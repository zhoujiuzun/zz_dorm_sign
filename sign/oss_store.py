"""
OSS 存储层
==========
两个文件（均在私有桶 zhouhuanzhang，cn-beijing）：
  users.json   —— 名册 [{openid, nickname, created}]，含敏感 openid
  history.json —— 签到流水 [{nickname, date, time, status, message}]，永久保留，不含 openid

FC 内凭函数计算的 RAM 角色临时凭据访问，走内网 endpoint（免流量费）。
本地运行时回退到 AK/SK 环境变量 + 外网 endpoint。
"""

import os
import json
import time
import hashlib

import oss2


def _now():
    """本地时区的 'YYYY-MM-DD HH:MM:SS' 时间戳。"""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())

BUCKET_NAME = os.environ.get("OSS_BUCKET", "zhouhuanzhang")
# 内网 endpoint：FC 与 OSS 同处 cn-beijing 时走这个，免流量费
OSS_ENDPOINT = os.environ.get("OSS_ENDPOINT", "oss-cn-beijing-internal.aliyuncs.com")

USERS_KEY = "users.json"
HISTORY_KEY = "history.json"
BLACKLIST_KEY = "blacklist.json"
DELETED_KEY = "deleted.json"
SETTINGS_KEY = "settings.json"


def member_id(openid, nickname=""):
    """
    由 openid 派生的非敏感成员标识（前端用它定位成员，但拿不到 openid 本身）。
    无 openid 的孤儿历史项回退用昵称。

    使用 SHA256 前 12 位（约 48 位熵，2^48 ≈ 281 万亿）。
    在当前规模（几十人）下碰撞概率可忽略（< 10^-10）。
    若扩展到数千人以上，建议改用完整哈希或 UUID。
    """
    if openid:
        return "o" + hashlib.sha256(openid.encode("utf-8")).hexdigest()[:12]
    return "n" + hashlib.sha256(("nick:" + nickname).encode("utf-8")).hexdigest()[:12]


def _get_bucket():
    """优先用 FC 角色临时凭据；本地回退到 AK/SK 环境变量。"""
    sts_token = os.environ.get("ALIBABA_CLOUD_SECURITY_TOKEN")
    ak = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID")
    sk = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")

    if ak and sk and sts_token:
        auth = oss2.StsAuth(ak, sk, sts_token)
    elif ak and sk:
        auth = oss2.Auth(ak, sk)
    else:
        raise RuntimeError("缺少 OSS 凭据：未注入 FC 角色凭据，也无 AK/SK 环境变量")

    # 不传 region：StsAuth/Auth 走 v1 签名无需 region，且兼容老版本 oss2。
    return oss2.Bucket(auth, OSS_ENDPOINT, BUCKET_NAME)


def _read_json(key, default):
    """从 OSS 读取 JSON 文件。

    重要：只有"文件不存在"才返回 default；网络错误/JSON 损坏一律 **抛出**。
    否则一次偶发读失败会让调用方拿到空列表，紧接着的写操作就会用空数据
    覆盖掉原本完好的文件（如 append_history 把整个 history.json 清零）。
    """
    try:
        bucket = _get_bucket()
        content = bucket.get_object(key).read()
        return json.loads(content)
    except oss2.exceptions.NoSuchKey:
        return default
    except Exception as e:
        # 不返回 default：让错误冒泡，阻止"读失败 → 用默认值覆盖写"的数据丢失
        print(f"[OSS] 读取 {key} 失败: {e}")
        raise


def _write_json(key, data):
    """将数据以 JSON 格式写入 OSS，失败时返回 False。"""
    try:
        bucket = _get_bucket()
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        bucket.put_object(key, body)
        return True
    except Exception as e:
        print(f"[OSS] 写入 {key} 失败: {e}")
        return False


# ------------------------------------------------------------------
# 名册
# ------------------------------------------------------------------
def get_users():
    return _read_json(USERS_KEY, [])


def add_user(openid, nickname):
    """新增/更新一个用户。openid 已存在则更新昵称，返回 (created, total)。"""
    users = get_users()
    for u in users:
        if u.get("openid") == openid:
            u["nickname"] = nickname
            _write_json(USERS_KEY, users)
            return False, len(users)
    users.append({
        "openid": openid,
        "nickname": nickname,
        "created": _now(),
    })
    _write_json(USERS_KEY, users)
    return True, len(users)


# ------------------------------------------------------------------
# 历史
# ------------------------------------------------------------------
def get_history():
    return _read_json(HISTORY_KEY, [])


def append_history(records):
    """追加若干条签到记录（永久保留）。records: list[dict]。"""
    if not records:
        return
    history = get_history()
    history.extend(records)
    _write_json(HISTORY_KEY, history)


# ------------------------------------------------------------------
# 全局签到开关
# ------------------------------------------------------------------
def get_signing_enabled():
    """返回全局自动签到开关；设置文件尚不存在时默认启用。"""
    settings = _read_json(SETTINGS_KEY, {})
    if not isinstance(settings, dict):
        raise RuntimeError("settings.json 格式错误")
    return settings.get("signing_enabled", True) is not False


def set_signing_enabled(enabled):
    """更新全局自动签到开关。"""
    return _write_json(SETTINGS_KEY, {
        "signing_enabled": bool(enabled),
        "updated_at": _now(),
    })


# ------------------------------------------------------------------
# 黑名单
# ------------------------------------------------------------------
def get_blacklist():
    return _read_json(BLACKLIST_KEY, [])


def is_blacklisted(openid):
    return any(b.get("openid") == openid for b in get_blacklist())


# ------------------------------------------------------------------
# 已删除成员
# ------------------------------------------------------------------
def get_deleted():
    return _read_json(DELETED_KEY, [])


def is_deleted(openid):
    return any(d.get("openid") == openid for d in get_deleted())


def _find_by_id(collection, mid):
    """在集合中按 member_id 查找目标项。返回 (target_item, rest_items)。"""
    target = next((item for item in collection
                   if member_id(item.get("openid", ""), item.get("nickname", "")) == mid), None)
    if not target:
        return None, collection
    rest = [item for item in collection if item is not target]
    return target, rest


def move_to_blacklist(mid):
    """按成员 id 把某人从名册移入黑名单。返回 (ok, nickname)。"""
    users = get_users()
    target, users = _find_by_id(users, mid)
    if not target:
        return False, ""
    bl = get_blacklist()
    if not any(b.get("openid") == target.get("openid") for b in bl):
        bl.append({
            "openid": target.get("openid", ""),
            "nickname": target.get("nickname", "未命名"),
            "blocked_at": _now(),
        })
    _write_json(USERS_KEY, users)
    _write_json(BLACKLIST_KEY, bl)
    return True, target.get("nickname", "")


def restore_from_blacklist(mid):
    """按成员 id 把某人移出黑名单、恢复为正常成员。返回 (ok, nickname)。"""
    bl = get_blacklist()
    target, bl = _find_by_id(bl, mid)
    if not target:
        return False, ""
    _write_json(BLACKLIST_KEY, bl)
    add_user(target.get("openid", ""), target.get("nickname", "未命名"))
    return True, target.get("nickname", "")


def delete_from_blacklist(mid):
    """按成员 id 把某人从黑名单彻底删除（openid 一并丢弃）。返回 (ok, nickname)。"""
    return delete_permanently(mid, from_blacklist=True)


def delete_user(mid):
    """按成员 id 从名册移到已删除列表（软删除，保留 openid）。返回 (ok, nickname)。"""
    users = get_users()
    target, users = _find_by_id(users, mid)
    if not target:
        return False, ""
    deleted = get_deleted()
    if not any(d.get("openid") == target.get("openid") for d in deleted):
        deleted.append({
            "openid": target.get("openid", ""),
            "nickname": target.get("nickname", "未命名"),
            "deleted_at": _now(),
        })
    _write_json(USERS_KEY, users)
    _write_json(DELETED_KEY, deleted)
    return True, target.get("nickname", "")


def restore_from_deleted(mid):
    """按成员 id 把某人从已删除列表恢复为正常成员。返回 (ok, nickname)。"""
    deleted = get_deleted()
    target, deleted = _find_by_id(deleted, mid)
    if not target:
        return False, ""
    _write_json(DELETED_KEY, deleted)
    add_user(target.get("openid", ""), target.get("nickname", "未命名"))
    return True, target.get("nickname", "")


def hide_orphan(nickname):
    """把历史孤儿写进 deleted.json，使其从成员列表消失（历史记录保留）。

    孤儿是早期"硬删除"的遗留：openid 已随记录一起丢失，只剩 history.json
    里的签到流水，昵称因此被 _build_members_view 当作成员捞回列表。
    这类条目无法用 member_id 定位到任何名单，只能按昵称处理。

    openid 留空——真人若再来注册，会因 openid 对不上而按新人走注册流程，
    但沿用同一昵称，历史记录仍能对上。返回 (ok, nickname)。
    """
    nickname = (nickname or "").strip()
    if not nickname:
        return False, ""
    # 已在名册/黑名单里的人不是孤儿，拒绝，避免误把活跃成员藏掉
    if any(u.get("nickname") == nickname for u in get_users()):
        return False, ""
    if any(b.get("nickname") == nickname for b in get_blacklist()):
        return False, ""
    deleted = get_deleted()
    if any(d.get("nickname") == nickname for d in deleted):
        return True, nickname          # 已经藏起来了，幂等返回
    deleted.append({
        "openid": "",
        "nickname": nickname,
        "deleted_at": _now(),
        "orphan": True,
    })
    if not _write_json(DELETED_KEY, deleted):
        return False, ""
    return True, nickname


def restore_deleted_by_openid(openid):
    """按 openid 把某人从已删除列表恢复为正常成员（自助重新注册走这条）。

    沿用 deleted.json 里的旧昵称，不采用学校系统返回的新名字，
    这样 history.json（按昵称关联）里的历史记录才能继续对上。
    返回 (ok, nickname, total)。
    """
    deleted = get_deleted()
    target = next((d for d in deleted if d.get("openid") == openid), None)
    if not target:
        return False, "", 0
    nickname = target.get("nickname", "未命名")
    rest = [d for d in deleted if d.get("openid") != openid]
    _write_json(DELETED_KEY, rest)
    _created, total = add_user(openid, nickname)
    return True, nickname, total


def delete_permanently(mid, from_blacklist=True):
    """按成员 id 从黑名单或已删除列表彻底删除（openid 一并丢弃）。返回 (ok, nickname)。"""
    collection = get_blacklist() if from_blacklist else get_deleted()
    target, collection = _find_by_id(collection, mid)
    if not target:
        return False, ""
    key = BLACKLIST_KEY if from_blacklist else DELETED_KEY
    _write_json(key, collection)
    return True, target.get("nickname", "")
