"""
本地测试脚本
============
填一个真实 openid，验证「能否换出 token + 完成签到」。
这是上线前唯一必做的功能验证（确认逆向出的签到链路正确）。

用法：
  1. 设置环境变量 CLIENT_SECRET（小程序密钥），可选 BASE_URL
  2. python test_sign.py <openid>
     或直接运行后按提示粘贴 openid

注意：21:00 之前服务器会拒签（返回"未到签到时间"），属正常。
"""

import os
import sys

# 让脚本能 import sign/ 下的模块（本脚本位于 tools/ 子目录，故回上一级）
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sign"))

import sign_core  # noqa: E402


def main():
    if not sign_core.CLIENT_SECRET:
        print("❌ 未设置环境变量 CLIENT_SECRET，无法构造 Basic 认证。")
        print("   PowerShell:  $env:CLIENT_SECRET = '你的密钥'")
        return 1

    openid = sys.argv[1] if len(sys.argv) > 1 else input("粘贴 openid：").strip()
    if not openid:
        print("❌ 未提供 openid")
        return 1

    print(f"\nBASE_URL = {sign_core.BASE_URL}")
    print("① 用 openid 换 token ...")
    login = sign_core.login_via_openid(openid)
    if not login["success"]:
        print(f"❌ 登录失败：{login.get('error')}")
        print("   openid 可能填错，或 CLIENT_SECRET 不对。")
        return 1
    print("   ✅ 换出 access_token 成功——openid 有效。")

    print("② 执行签到 ...")
    result = sign_core.sign_one_user(openid)
    icon = {"ok": "✅", "no_task": "➖", "not_yet": "⏳",
            "login_failed": "🔑", "error": "⚠️"}.get(result["status"], "?")
    print(f"   {icon} [{result['status']}] {result['message']}")

    if result["status"] in ("ok", "no_task", "not_yet"):
        print("\n🎉 链路验证通过：openid 能登录、签到接口可用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
