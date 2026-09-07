"""
OpenID 采集工具（本地运行，打包成 exe 发给熟人）
================================================
熟人在自己 Windows 电脑上以「管理员」运行：
  1. 把 mitmproxy CA 证书装入 LocalMachine 根证书库（管理员权限，静默无弹窗）
  2. 设置系统代理指向本机进程内的 mitmproxy
  3. 进程内启动 mitmproxy（DumpMaster 库方式，不依赖外部 mitmdump 命令，
     这样 PyInstaller 冻结成 exe 后也能跑），等待用户在「电脑版微信」打开小程序并登录
  4. 截获 getOpenidByJsCode 响应里的 openid → 带预共享口令 POST 到注册接口
  5. 自动撤销系统代理、删除证书，恢复电脑原状

打包成 exe 的说明见 BUILD.md。openid 永久不变，故每位熟人一辈子只需跑一次。
"""

import os
import sys
import json
import time
import asyncio
import threading
import subprocess
import urllib.request
import urllib.error

# ====================================================================
# 配置 —— 已内置线上真实值；如需改可用同名环境变量覆盖
# ====================================================================
REGISTER_URL = os.environ.get(
    "REGISTER_URL", "https://sign-bprgxfyexe.cn-beijing.fcapp.run/register")
REGISTER_SECRET = os.environ.get("REGISTER_SECRET", "63zTDrV2DML2dGev5eGg9FdN")

PROXY_HOST = "127.0.0.1"
PROXY_PORT = 8080

# openid 出现在这个接口的响应里
OPENID_API = "/api/flySource-base/openApi/getOpenidByJsCode"

# mitmproxy 首次运行生成的 CA 证书路径
MITM_CA = os.path.join(os.path.expanduser("~"), ".mitmproxy",
                       "mitmproxy-ca-cert.cer")
CERT_FRIENDLY_NAME = "mitmproxy"

# 进程间共享的状态（addon 与主线程同属一个进程，用模块级变量即可）
_DONE = threading.Event()
_RESULT = {"ok": False, "msg": ""}


def log(msg):
    print(msg, flush=True)


# ====================================================================
# 管理员权限
# ====================================================================
def is_admin():
    try:
        import ctypes
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


def relaunch_as_admin():
    """非管理员时尝试用 UAC 提权重启自身。"""
    try:
        import ctypes
        params = " ".join(f'"{a}"' for a in sys.argv[1:])
        ctypes.windll.shell32.ShellExecuteW(
            None, "runas", sys.executable, params, None, 1)
    except Exception:
        pass


# ====================================================================
# 证书：装入 / 删除 LocalMachine 根证书库（管理员权限下静默，无弹窗）
# ====================================================================
def install_cert():
    if not os.path.exists(MITM_CA):
        log(f"  ❌ 未找到证书：{MITM_CA}")
        return False
    r = subprocess.run(["certutil", "-addstore", "-f", "Root", MITM_CA],
                       capture_output=True, text=True)
    if r.returncode == 0:
        log("  ✅ 证书已安装")
        return True
    log(f"  ❌ 证书安装失败：{r.stdout} {r.stderr}")
    return False


def remove_cert():
    subprocess.run(["certutil", "-delstore", "Root", CERT_FRIENDLY_NAME],
                   capture_output=True, text=True)
    log("  ✅ 证书已清除")


# ====================================================================
# 系统代理：开启 / 关闭（改 HKCU Internet Settings）
# ====================================================================
import winreg

_INET_KEY = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"


def set_proxy(enable):
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, _INET_KEY, 0,
                         winreg.KEY_SET_VALUE)
    try:
        if enable:
            winreg.SetValueEx(key, "ProxyEnable", 0, winreg.REG_DWORD, 1)
            winreg.SetValueEx(key, "ProxyServer", 0, winreg.REG_SZ,
                              f"{PROXY_HOST}:{PROXY_PORT}")
            log(f"  ✅ 系统代理已指向 {PROXY_HOST}:{PROXY_PORT}")
        else:
            winreg.SetValueEx(key, "ProxyEnable", 0, winreg.REG_DWORD, 0)
            log("  ✅ 系统代理已关闭")
    finally:
        winreg.CloseKey(key)
    _refresh_inet()


def _refresh_inet():
    """通知系统代理设置已变更（否则部分程序不立即生效）。"""
    try:
        import ctypes
        internet = ctypes.windll.Wininet
        internet.InternetSetOptionW(0, 39, 0, 0)  # SETTINGS_CHANGED
        internet.InternetSetOptionW(0, 37, 0, 0)  # REFRESH
    except Exception:
        pass


# ====================================================================
# 上报 openid 到注册接口（标准库 urllib，免 requests 依赖）
# ====================================================================
def report_openid(openid):
    # 注册接口会用 openid 自动登录学校系统取真名入库，无需传昵称。
    body = json.dumps({
        "secret": REGISTER_SECRET,
        "openid": openid,
    }).encode("utf-8")
    req = urllib.request.Request(
        REGISTER_URL, data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    # 关键：本函数在 mitmproxy 的响应回调里被调用，此刻系统代理仍指向本机
    # mitmproxy(127.0.0.1:8080)。urllib 默认走系统代理 → 上报请求绕回 mitmproxy，
    # 而 mitmproxy 的事件循环正卡在这个同步 urlopen 里无法 accept → 自己等自己死锁
    # （表现为 timed out + Task ... IocpProactor.accept pending）。
    # 用空 ProxyHandler 强制直连 FC，绕开系统代理，彻底避免回环死锁。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=20) as r:
            txt = r.read().decode("utf-8", "replace")
        log("  🎉 注册成功！可以关闭本工具了。")
        try:
            res = json.loads(txt)
            who = res.get("nickname") or res.get("user_name")
            if who:
                log(f"     已登记：{who}")
            if res.get("signing_enabled") is False:
                log("     提示：当前为假期暂停状态，系统暂不会自动签到。")
        except Exception:
            pass
        return True
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        log(f"  ❌ 上报失败（HTTP {e.code}）：{detail}")
    except Exception as e:
        log(f"  ❌ 上报异常：{e}")
    return False


# ====================================================================
# mitmproxy addon —— 截获 openid 并上报，随后关停代理
# ====================================================================
class OpenIDCatcher:
    def response(self, flow):
        if OPENID_API not in flow.request.path:
            return
        try:
            data = json.loads(flow.response.get_text())
        except Exception:
            return
        openid = data.get("data")
        if not openid:
            log("  ⚠️ 命中接口但未取到 openid，请重试登录。")
            return
        log("  ✅ 已捕获 openid，正在上报...")
        _RESULT["ok"] = report_openid(openid)
        _RESULT["msg"] = "done"
        _DONE.set()


# ====================================================================
# 进程内运行 mitmproxy（DumpMaster），不依赖外部 mitmdump 命令
# ====================================================================
_master = None
_master_loop = None
_master_err = {"e": None}


def _run_master():
    """在独立线程里跑 mitmproxy 的 asyncio 事件循环。
    注意：DumpMaster 必须在「已运行的事件循环」里构造（mitmproxy 11 要求），
    故把构造放进协程内，再 run_until_complete。"""
    global _master, _master_loop
    from mitmproxy.tools.dump import DumpMaster
    from mitmproxy import options

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _master_loop = loop

    async def _amain():
        global _master
        opts = options.Options(
            listen_host=PROXY_HOST,
            listen_port=PROXY_PORT,
        )
        master = DumpMaster(opts, with_termlog=False, with_dumper=False)
        master.addons.add(OpenIDCatcher())
        _master = master
        await master.run()

    try:
        loop.run_until_complete(_amain())
    except Exception as e:
        _master_err["e"] = e
    finally:
        try:
            loop.close()
        except Exception:
            pass


def _wait_for_ca(timeout=20):
    """等 mitmproxy 启动后生成 CA 证书。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(MITM_CA):
            return True
        if _master_err["e"] is not None:
            return False
        time.sleep(0.3)
    return os.path.exists(MITM_CA)


def _stop_master():
    if _master is not None:
        try:
            _master.shutdown()  # 线程安全
        except Exception:
            pass


# ====================================================================
# 主流程编排
# ====================================================================
def orchestrate():
    if not is_admin():
        log("需要管理员权限来静默安装证书，正在尝试以管理员身份重新启动...")
        relaunch_as_admin()
        return 0

    log("=" * 48)
    log(" 宿舍签到 · OpenID 采集工具")
    log("=" * 48)

    log("\n[1/4] 启动本地抓包代理...")
    t = threading.Thread(target=_run_master, daemon=True)
    t.start()
    if not _wait_for_ca():
        log(f"  ❌ 代理启动失败：{_master_err['e']}")
        _stop_master()
        input("\n按回车键退出。")
        return 1

    log("\n[2/4] 安装证书 + 设置系统代理...")
    if not install_cert():
        _stop_master()
        input("\n按回车键退出。")
        return 1
    set_proxy(True)

    try:
        log("\n[3/4] 已就绪，请现在操作：")
        log("      ① 打开「电脑版微信」并登录")
        log("      ② 打开「平安打卡」小程序。★如果已经登录过，先在小程序里")
        log("         「退出登录」，再重新登录一次（必须走一遍全新登录才抓得到）")
        log("      然后回到本窗口等待提示（最多 5 分钟）。\n")
        if not _DONE.wait(timeout=300):
            log("  ⏱️ 超时未捕获。多半是小程序已登录、没触发登录请求。")
            log("     请在小程序里「退出登录」后重新登录，再跑一次本工具。")
    finally:
        log("\n[4/4] 清理...")
        set_proxy(False)
        remove_cert()
        _stop_master()
        log("  ✅ 已恢复电脑设置。")

    input("\n按回车键退出。")
    return 0 if _RESULT["ok"] else 1


if __name__ == "__main__":
    # 隐藏自检模式：只验证进程内 mitmproxy 能启动并生成 CA（不提权、不抓包、不改系统）
    # 用途：打包后 `openid-capture.exe --selftest` 确认 mitmproxy 资源已正确冻结进 exe。
    if "--selftest" in sys.argv:
        log("[selftest] 启动进程内 mitmproxy...")
        t = threading.Thread(target=_run_master, daemon=True)
        t.start()
        ok_ca = _wait_for_ca(timeout=25)
        # 确认端口已监听
        port_ok = False
        try:
            import socket
            with socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=3):
                port_ok = True
        except Exception:
            port_ok = False
        _stop_master()
        time.sleep(1)
        log(f"[selftest] CA 生成: {ok_ca}  端口监听: {port_ok}  "
            f"启动错误: {_master_err['e']}")
        sys.exit(0 if (ok_ca and port_ok) else 1)

    sys.exit(orchestrate())
