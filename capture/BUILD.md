# 采集工具打包说明

把 `capture.py` 打包成熟人可直接运行的管理员 exe。

## 1. 打包前必改两处

编辑 `capture.py` 顶部配置（或部署时用环境变量覆盖）：

- `REGISTER_URL` —— 你 FC HTTP 触发器的公网地址 + `/register`
- `REGISTER_SECRET` —— 与 FC 环境变量 `REGISTER_SECRET` 完全一致的口令

## 2. 安装打包依赖

```powershell
pip install mitmproxy requests pyinstaller
```

## 3. 打包（要求默认请求管理员权限）

```powershell
pyinstaller --onefile --uac-admin --name openid-capture `
  --collect-all mitmproxy `
  capture.py
```

- `--uac-admin`：exe 启动即请求管理员权限（证书静默安装的前提）。
- `--collect-all mitmproxy`：把 mitmproxy 全部资源打进 exe，熟人无需单独装。
- 产物在 `dist\openid-capture.exe`。

## 4. 给熟人的使用步骤

1. 关闭杀毒软件（exe 未签名，会被误报；装证书+改代理的行为像木马）。
2. 右键 `openid-capture.exe` →「以管理员身份运行」→ UAC 点「是」。
3. 打开电脑版微信并登录 → 在微信里打开「平安打卡」小程序并登录。
4. 看到「🎉 注册成功」即可关闭。工具会自动撤代理、删证书，恢复电脑原状。
   （名字自动从学校系统取真名，无需手动输入。）

## 已知限制

- **未签名 exe 会被 SmartScreen / 杀软拦**，故要求关杀软。若要免关，需自备代码签名证书后用 `signtool` 签名。
- 仅 Windows。
- openid 永久不变，故每位熟人此操作**一辈子只需一次**。
