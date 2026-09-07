"""
名册管理工具（本地运行）
========================
直接读写 OSS 上的 users.json，用于查看 / 删除用户。
用本机 AccessKey 走外网 endpoint 访问私有桶。

用法（PowerShell，在项目根目录）：
  $env:ALIBABA_CLOUD_ACCESS_KEY_ID = "你的AK_ID"
  $env:ALIBABA_CLOUD_ACCESS_KEY_SECRET = "你的AK_SECRET"
  python manage_users.py list                 # 列出所有用户（openid 打码）
  python manage_users.py del <openid或昵称>    # 删除某用户
"""

import os
import sys
import json

import oss2

BUCKET = os.environ.get("OSS_BUCKET", "zhouhuanzhang")
# 本地访问用外网 endpoint（FC 内才用 internal）
ENDPOINT = os.environ.get("OSS_ENDPOINT_PUBLIC", "oss-cn-beijing.aliyuncs.com")
USERS_KEY = "users.json"


def _bucket():
    ak = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID")
    sk = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    if not ak or not sk:
        print("❌ 请先设置 ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET 环境变量")
        sys.exit(1)
    return oss2.Bucket(oss2.Auth(ak, sk), ENDPOINT, BUCKET)


def _load(b):
    try:
        return json.loads(b.get_object(USERS_KEY).read())
    except oss2.exceptions.NoSuchKey:
        return []


def _mask(oid):
    if not oid or len(oid) < 8:
        return "****"
    return oid[:4] + "****" + oid[-4:]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    b = _bucket()
    users = _load(b)

    if sys.argv[1] == "list":
        if not users:
            print("（名册为空）")
        for u in users:
            print(f"  {u.get('nickname','?'):<12} openid={_mask(u.get('openid'))}"
                  f"  created={u.get('created','')}")
        print(f"共 {len(users)} 人")

    elif sys.argv[1] == "del" and len(sys.argv) >= 3:
        target = sys.argv[2]
        before = len(users)
        users = [u for u in users
                 if u.get("openid") != target and u.get("nickname") != target]
        if len(users) == before:
            print(f"未找到匹配 '{target}' 的用户")
            return
        b.put_object(USERS_KEY,
                     json.dumps(users, ensure_ascii=False, indent=2).encode("utf-8"))
        print(f"✅ 已删除，剩余 {len(users)} 人")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
