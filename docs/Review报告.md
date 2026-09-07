# 宿舍签到系统 · 代码审查报告

> 审查日期 2026-06-17 · 范围:后端 `sign/` + 本地工具集 + 配置/文档
> 系统**已上线运行**,故修复分两类:**本地可逆项已自动执行**;**需重部署 FC 的后端项**写成现成补丁待你确认。

## 总评

架构清晰、分层合理、隐私设计(openid 哈希成 member_id、历史不含 openid)和前端转义(`esc()`)都到位,无阻断性缺陷。隐患集中在四处:**鉴权强度、OSS 并发/读失败回写、定时签到同步 sleep 超时、历史按昵称聚合重名串档**。

## 严重度汇总

| # | 严重度 | 位置 | 问题 | 处置 |
|---|---|---|---|---|
| 1 | 🔴高 | web.py | 管理员密码硬编码默认 `loveyou520`;令牌可离线伪造(固定盐+密码纯函数) | 补丁待部署 |
| 2 | 🔴高 | oss_store.py | 读失败返回 `[]` 后又被写回 → 一次网络抖动可清空历史 | 补丁待部署 |
| 3 | 🔴高 | oss_store.py | 读-改-写非原子,无并发控制 → 定时器+注册+管理操作并发会丢数据 | 已记录(规模小,中期做) |
| 4 | 🔴高 | index.py / sign_core.py | 循环内 `sleep(1~15s)` 同步阻塞,多人同分钟会触发 FC 超时漏签 | 补丁待部署 |
| 5 | 🟠中 | web.py | 历史用昵称作聚合主键,真名重名两人串档 | 已记录(需数据迁移) |
| 6 | 🟠中 | _seed_demo.py | 按昵称识别演示数据,真人重名(张三/杨幂等)被 `--clear` 误删 | ✅已修复 |
| 7 | 🟠中 | dashboard.py | 用了 `urllib.error` 但未 import,靠隐式副作用才没崩 | ✅已修复 |
| 8 | 🟠中 | requirements.txt | 依赖不固定版本,FC 重建可能拉到 breaking 新版 | ✅已修复 |
| 9 | 🟠中 | sign_core.py | 模块导入即全局 monkeypatch `socket.getaddrinfo`,影响整个进程 | 已记录 |
| 10 | 🟠中 | web.py | `/register` 无频率限制,口令泄露后可刷接口枚举 | 已记录 |
| 11 | 🟠中 | manage_users.py | `del` 无确认/无备份,误删不可逆 | 已记录 |
| 12 | 🟢低 | 多处 | 代码重复、死代码、`except: pass` 静默吞错、BUILD.md 昵称步骤过时 | 已记录 |

<!-- APPEND-MARKER -->

## 已自动执行的修复(本地,可逆,无需重部署)

- **#6 演示数据误删**:`_seed_demo.py` 改为按 openid 前缀 `demo` 识别演示用户、历史记录打 `_demo: true` 标记;`--clear` 只按这两个标记删,真人即使叫"张三/杨幂"也不会被误删。环境变量缺失改为友好报错而非抛栈。
- **#7 dashboard 隐式导入**:补 `import urllib.error`。
- **#8 依赖固定版本**:`requests==2.32.3`、`oss2==2.18.6`。**注意**:此项要下次 `deploy.ps1` 重部署后才在线上生效。

## 需重部署 FC 才生效的修复(补丁就绪,待你确认)

> 这些动的是线上鉴权/存储/签到主逻辑,改完必须 `.\deploy.ps1` 才生效。
> **更新(2026-06-17):补丁 1/2/3 已应用到代码并通过自测,但尚未部署。下次 `deploy.ps1` 生效。**

### 补丁 1 — #1 鉴权重构(web.py)

要点:① `ADMIN_PASS` 缺失则拒绝登录(不给默认弱口令);② 令牌改用仅存环境变量的随机 `TOKEN_SECRET` 做 HMAC,去掉源码里可推导的固定盐。

```python
# web.py 顶部
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS")          # 不给默认值
TOKEN_SECRET = os.environ.get("TOKEN_SECRET", "")  # 新增:32+ 位随机串

def _make_token():
    hour = time.strftime("%Y%m%d%H")
    msg = f"{ADMIN_USER}:{hour}".encode()
    return hmac.new(TOKEN_SECRET.encode(), msg, hashlib.sha256).hexdigest()

def _login(body):
    data = json.loads(body) if body else {}
    if not ADMIN_PASS or not TOKEN_SECRET:
        return _resp(503, {"error": "管理功能未启用(缺 ADMIN_PASS/TOKEN_SECRET)"})
    if data.get("user") == ADMIN_USER and \
       hmac.compare_digest(data.get("pass", ""), ADMIN_PASS):
        return _resp(200, {"ok": True, "token": _make_token()})
    return _resp(401, {"error": "账号或密码错误"})
```
配套:`deploy.ps1` 增设 `$env:TOKEN_SECRET`(32 位随机),`s.yaml` 已有 `ADMIN_USER/PASS` 引用,补一行 `TOKEN_SECRET: ${env('TOKEN_SECRET')}`。

### 补丁 2 — #2 读失败禁止回写(oss_store.py)

最危险的隐藏 bug:一次偶发读失败 + 一次写 = 历史归零。让"文件不存在"与"读错误"分流。

```python
def _read_json(key, default):
    try:
        return json.loads(_get_bucket().get_object(key).read())
    except oss2.exceptions.NoSuchKey:
        return default                 # 文件不存在 → 正常返回默认
    except Exception:
        raise                          # 网络/解析错误 → 抛出,绝不让调用方拿默认值去覆盖写
```

### 补丁 3 — #4 去掉循环内大 sleep(index.py / sign_core.py)

把 `run_minute_sign` 里的 `time.sleep(random.uniform(1,15))` 降为 `uniform(0,3)`(或移除),并去掉 `sign_core` 任务循环里叠加的 `sleep(0.5,1.5)`。FC `timeout=300s`,多人同分钟时原 N×15s 易超时漏签。

### 已记录、建议中期处理(不出补丁,需设计/迁移)

- **#3 OSS 并发**:写操作用 OSS 条件写(If-Match ETag)+ 重试。当前规模(个位~几十人)概率低,可暂缓。
- **#5 历史聚合主键**:`history.json` 改存 `member_id` 而非昵称,根治重名串档。需迁移存量历史,谨慎。
- **#9 全局 getaddrinfo patch**:改用 requests 自定义 adapter 连 IP+Host 头,缩小副作用面。
- **#10 /register 频率限制**:加简单计数或 openid 格式预校验,防口令泄露后被刷。
- **#11 manage_users del**:删前 dump 一份旧 `users.json` 到本地备份。

## 值得肯定

openid → member_id 隐私哈希、前端 `esc()` 转义、`hmac.compare_digest` 比密码、凭据走 RAM 角色/环境变量注入、失败才推送的静默策略——方向都对。

