"""
本地看板（无需域名/备案）
==========================
双击或 `python dashboard.py` 运行：
  - 在 localhost 起一个小服务器，复用 sign/static 那套看板 UI
  - /api/history 由本地服务器去线上 FC 拉取后转发（服务端取数，无跨域、无强制下载头）
  - 自动打开浏览器

这样状态页能在浏览器正常渲染，且看板只在你本机可见，不暴露公网。
"""

import os
import webbrowser
import threading
import urllib.request
import urllib.error
import http.server

# 线上函数地址（部署后的 fcapp.run）
REMOTE = "https://sign-bprgxfyexe.cn-beijing.fcapp.run"
# 看板静态资源在 ../sign/static（本脚本位于 tools/ 子目录）
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sign", "static")
PORT = 8765

_CTYPE = {"html": "text/html", "js": "application/javascript", "css": "text/css"}


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.end_headers()
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            # 通用转发任意 /api/* 到线上（含查询串），服务端取数避免跨域/下载头
            try:
                with urllib.request.urlopen(REMOTE + self.path, timeout=30) as r:
                    self._send(200, r.read(), "application/json")
            except Exception as e:
                self._send(502, f'{{"error":"拉取线上数据失败: {e}"}}', "application/json")
            return
        fname = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
        fpath = os.path.join(STATIC, fname)
        if os.path.isfile(fpath):
            ext = fname.rsplit(".", 1)[-1]
            with open(fpath, "rb") as f:
                self._send(200, f.read(), _CTYPE.get(ext, "text/plain"))
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length) if length else b""
                req = urllib.request.Request(REMOTE + self.path, data=body,
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    self._send(200, r.read(), "application/json")
            except urllib.error.HTTPError as e:
                self._send(e.code, e.read(), "application/json")
            except Exception as e:
                self._send(502, f'{{"error":"请求失败: {e}"}}', "application/json")
            return
        self._send(404, "not found", "text/plain")

    def log_message(self, *a):
        pass


def main():
    url = f"http://127.0.0.1:{PORT}/"
    print(f"本地看板已启动：{url}")
    print("数据来源：线上签到系统。关闭此窗口即停止。")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
