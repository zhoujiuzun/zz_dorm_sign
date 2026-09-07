# 宿舍自动签到系统 · 架构图解

## 系统总览

```
┌─────────────────────────────────────────────────────────────────┐
│                          用户侧                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐         ┌──────────────┐                     │
│  │ PC 微信登录  │         │ 浏览器访问   │                     │
│  │ 小程序(一次) │         │ 看板(日常)   │                     │
│  └──────┬───────┘         └──────┬───────┘                     │
│         │                        │                              │
│         │ openid 抓包            │ HTTPS 访问                   │
│         ▼                        ▼                              │
│  ┌──────────────┐         ┌──────────────┐                     │
│  │ openid-      │         │ Cloudflare   │                     │
│  │ capture.exe  │         │ Pages        │                     │
│  └──────┬───────┘         │ (静态前端)   │                     │
│         │                 └──────┬───────┘                     │
│         │ POST /register         │ fetch API                    │
└─────────┼────────────────────────┼─────────────────────────────┘
          │                        │
          │                        │ ┌─────────────────────────┐
          │                        │ │ 前端托管在 Cloudflare   │
          │                        │ │ Pages，静态 HTML/JS/CSS │
          │                        │ │ 通过 HTTPS 跨域请求后端 │
          │                        │ │ API                     │
          │                        │ └─────────────────────────┘
          │                        │
          ▼                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                     阿里云 Function Compute                      │
│                     (cn-beijing, Python 3.10)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │                  单函数: sign                           │    │
│  │  handler: index.handler(event, context)                │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  触发器 1: HTTP 触发器                                           │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ URL: https://sign-bprgxfyexe.cn-beijing.fcapp.run   │       │
│  │                                                       │       │
│  │ 路由 (web.py):                                       │       │
│  │  • POST /register        → 注册新用户                │       │
│  │  • POST /api/login       → 管理员登录                │       │
│  │  • GET  /api/members     → 获取成员列表              │       │
│  │  • GET  /api/user        → 获取单个用户签到历史       │       │
│  │  • GET  /api/blacklist   → 获取黑名单                │       │
│  │  • POST /api/blacklist/add|restore|delete → 拉黑/恢复/彻删 │  │
│  │  • POST /api/member/delete, /api/deleted/restore|purge    │  │
│  │  • POST /api/orphan/hide → 软删/恢复/孤儿隐藏             │  │
│  │  • POST /api/signing     → 开启/停止自动签到          │       │
│  │  • GET  /*               → 静态文件(备用)             │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                  │
│  触发器 2 & 3: 定时触发器                                        │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ signWindowH21: 每分钟 (21:00-21:59)                 │       │
│  │ signWindowH22: 每分钟 (22:00-22:20)                 │       │
│  │                                                       │       │
│  │ 执行逻辑 (index.py: run_minute_sign):               │       │
│  │  1. 读取 users.json                                  │       │
│  │  2. 计算每人的"专属签到时刻"(hash算法)               │       │
│  │  3. 筛选"专属时刻 = 当前分钟"的用户                  │       │
│  │  4. 逐个执行签到流程                                 │       │
│  │  5. 记录结果到 history.json                          │       │
│  │  6. 失败时推送 Server酱通知                          │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                  │
│  核心模块:                                                       │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ sign_core.py: 签到核心逻辑                          │       │
│  │  • login_via_openid()    → 用 openid 换 token       │       │
│  │  • get_task_list()       → 获取签到任务列表         │       │
│  │  • get_task_detail()     → 获取任务详情(宿舍坐标)   │       │
│  │  • submit_sign()         → 提交签到                 │       │
│  │  • haversine()           → 计算坐标距离             │       │
│  │  • DNS bypass (DoH)      → 绕过 .edu.cn 解析问题   │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ oss_store.py: 数据持久化                            │       │
│  │  • get_users()           → 读取用户名册             │       │
│  │  • add_user()            → 添加用户                 │       │
│  │  • get_history()         → 读取签到历史             │       │
│  │  • append_history()      → 追加历史记录             │       │
│  │  • get_blacklist()       → 读取黑名单               │       │
│  │  • move_to_blacklist()   → 拉黑用户                 │       │
│  │  • delete_user()         → 软删除(移入 deleted)     │       │
│  │  • restore_from_deleted()→ 从软删除恢复             │       │
│  │  • hide_orphan()         → 隐藏历史孤儿             │       │
│  │  • get_signing_enabled() → 读取全局签到开关         │       │
│  └─────────────────────────────────────────────────────┘       │
│                      │                                          │
│                      │ 通过 RAM 角色授权                         │
│                      │ (内网访问，无需 AK/SK)                    │
└──────────────────────┼──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     阿里云 OSS (对象存储)                        │
│                     Bucket: zhouhuanzhang                        │
│                     Region: cn-beijing                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ users.json - 用户名册                                │      │
│  │ [{                                                    │      │
│  │   "openid": "oXXX...XXX",    // 敏感，永久凭据       │      │
│  │   "nickname": "张三"         // 真实姓名             │      │
│  │ }]                                                    │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ history.json - 签到历史                              │      │
│  │ [{                                                    │      │
│  │   "nickname": "张三",        // 不含 openid          │      │
│  │   "date": "2024-09-07",                              │      │
│  │   "time": "21:08",                                   │      │
│  │   "status": "ok",            // ok/error/login_failed│      │
│  │   "message": "成功"                                  │      │
│  │ }]                                                    │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ blacklist.json - 黑名单                              │      │
│  │ [{                                                    │      │
│  │   "openid": "oYYY...YYY",                            │      │
│  │   "nickname": "李四",                                │      │
│  │   "blocked_at": "2024-09-07 12:00:00"           │      │
│  │ }]                                                    │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ deleted.json - 软删除成员(可自助恢复)               │      │
│  │ [{                                                    │      │
│  │   "openid": "oZZZ...ZZZ",  // 孤儿为空             │      │
│  │   "nickname": "王五",                              │      │
│  │   "deleted_at": "2024-09-07 12:00:00",            │      │
│  │   "orphan": false        // 无 openid 的历史孤儿   │      │
│  │ }]                                                    │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ settings.json - 系统配置                               │      │
│  │ {                                                     │      │
│  │   "signing_enabled": true    // 是否启用自动签到     │      │
│  │ }                                                     │      │
│  └──────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────┐
│                     学校签到系统                                 │
│                     simp.csuft.edu.cn                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  后端通过以下 API 与学校系统交互:                                │
│                                                                  │
│  1. POST /api/system/oauth/token                                │
│     输入: openid (通过 grant_type=wxapp)                        │
│     输出: access_token, userName, accountNo                     │
│                                                                  │
│  2. GET /api/flySource-yxgl/dormSignTask/getListForApp          │
│     输入: access_token                                          │
│     输出: 签到任务列表                                          │
│                                                                  │
│  3. GET /api/flySource-yxgl/dormSignTask/getTaskByIdForApp      │
│     输入: taskId, access_token                                  │
│     输出: 任务详情 (含宿舍坐标 dormitoryRegisterVO)             │
│                                                                  │
│  4. POST /api/flySource-yxgl/dormSignRecord/stuSign             │
│     输入: taskId, signLat, signLng, locationAccuracy...         │
│     输出: 签到结果                                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────┐
│                     通知系统                                     │
│                     Server酱 (serverchan.com)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  当签到失败时，FC 通过 notify.py 推送通知:                       │
│                                                                  │
│  POST https://sctapi.ftqq.com/{SERVERCHAN_KEY}.send             │
│  输入: title, desp (Markdown 格式)                              │
│  输出: 推送到管理员微信                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 核心数据流

### 1. 用户注册流程

```
用户 PC 微信
    │
    │ 1. 登录小程序
    ▼
PC 抓包工具 (openid-capture.exe)
    │
    │ 2. MITM 拦截 getOpenidByJsCode 响应
    │    提取 openid
    │
    │ 3. POST /register
    │    {openid, register_secret}
    ▼
FC: web.py
    │
    │ 4. 验证 register_secret
    │ 5. 用 openid 调用学校 API 验证有效性
    │ 6. 获取真实姓名 (userName)
    │
    │ 7. 调用 oss_store.add_user()
    ▼
OSS: users.json
    │
    │ 8. 追加 {openid, nickname}
    └─→ 返回成功 {created: true, nickname}
```

### 2. 自动签到流程 (每晚 21:00-22:20)

```
定时触发器 (每分钟)
    │
    ▼
FC: index.py → run_minute_sign()
    │
    │ 1. 读取 OSS: users.json
    │ 2. 读取 OSS: settings.json (检查 signing_enabled)
    │ 3. 计算当前时间 (分钟数)
    │
    │ 4. 遍历所有用户，计算每人的"专属时刻"
    │    target_minute = hash(openid + date) % 81 + 1260
    │    (1260 = 21:00, 81 分钟窗口 = 21:00-22:20)
    │
    │ 5. 筛选出专属时刻 = 当前分钟的用户
    │
    ▼ 对每个匹配的用户:
    │
    │ 6. sign_core.login_via_openid(openid)
    │    ├─→ POST 学校 /oauth/token
    │    └─→ 返回 access_token, userName
    │
    │ 7. sign_core.get_task_list(session)
    │    ├─→ GET 学校 /getListForApp
    │    └─→ 返回任务列表 [{taskId, taskName}]
    │
    │ 8. 对每个任务:
    │    sign_core.get_task_detail(session, taskId)
    │    ├─→ GET 学校 /getTaskByIdForApp
    │    └─→ 返回 dormitoryRegisterVO {locationLat, locationLng}
    │
    │ 9. sign_core.submit_sign(session, taskId, detail)
    │    ├─→ 取用户宿舍坐标 (lat, lng)
    │    ├─→ 随机抖动 ±0.00003 度 (约 3 米)
    │    ├─→ 计算真实距离 haversine(签到坐标, 宿舍坐标)
    │    ├─→ POST 学校 /stuSign
    │    │   {taskId, signLat, signLng, locationAccuracy, ...}
    │    └─→ 返回签到结果 {code, msg}
    │
    │ 10. 收集结果
    │     {nickname, date, time, status, message}
    │
    ▼
OSS: history.json
    │
    │ 11. oss_store.append_history(records)
    │     追加签到记录 (不含 openid)
    │
    ▼
notify.py (如果有失败)
    │
    │ 12. 汇总失败/异常记录
    │ 13. POST Server酱 API
    │     推送通知到管理员微信
    │
    └─→ 完成
```

### 3. 看板访问流程

```
用户浏览器
    │
    │ 1. 访问 Cloudflare Pages
    │    https://zz-dorm-sign.pages.dev
    ▼
Cloudflare Pages
    │
    │ 2. 返回静态 HTML/JS/CSS
    │    (index.html, app.js, style.css)
    │
    ▼
浏览器执行 app.js
    │
    │ 3. 检查 localStorage.verified_name
    │    - 有 → 自动登录普通用户
    │    - 无 → 显示姓名验证弹窗
    │
    │ 4. 普通用户模式:
    │    └─→ fetch GET /api/user?name={姓名}
    │        返回该用户的签到历史和日历
    │
    │ 5. 管理员模式:
    │    ├─→ fetch POST /api/login {user, password}
    │    │   返回 {token}
    │    │
    │    ├─→ fetch GET /api/members (带 token)
    │    │   返回所有成员列表 + 总览统计
    │    │
    │    └─→ fetch GET /api/blacklist (带 token)
    │        返回黑名单
    │
    ▼
FC: web.py
    │
    │ 6. 根据不同 API 路由:
    │    - /api/login: 验证管理员账号密码，返回 HMAC 令牌
    │    - /api/members: 读取 OSS users.json + history.json
    │    - /api/user: 读取 OSS history.json，过滤单个用户
    │    - /api/blacklist: 读取 OSS blacklist.json
    │    - /api/member/*: 管理员操作 (拉黑/恢复/删除)
    │
    ▼
OSS 存储
    │
    │ 7. 读取相应的 JSON 文件
    │
    └─→ 返回 JSON 响应到前端
```

### 4. 管理员操作流程

```
管理员浏览器
    │
    │ 1. 点击"拉黑"按钮
    ▼
前端 app.js
    │
    │ 2. POST /api/blacklist/add
    │    {token, id: member_id}
    │
    ▼
FC: web.py → _admin_op()
    │
    │ 3. 验证 token (HMAC-SHA256)
    │ 4. 解析 member_id → openid
    │
    │ 5. oss_store.move_to_blacklist(member_id)
    │    ├─→ 从 users.json 移除
    │    └─→ 添加到 blacklist.json
    │
    ▼
OSS 存储
    │
    │ 6. 更新 users.json 和 blacklist.json
    │
    └─→ 返回成功 {ok: true}
    
    
定时签到时
    │
    │ 7. run_minute_sign() 只读取 users.json
    │    被拉黑的用户不在名册中 → 自动跳过
    │
    └─→ 黑名单用户不会被自动签到
```

## 关键技术点

### 1. 专属签到时刻算法

每个用户每天有一个固定的签到时刻，避免所有人同时签到：

```python
def target_minute(openid, date_str):
    """返回该人该天专属签到时刻的"当天分钟数"（如 1268 = 21:08）"""
    h = hashlib.sha256(f"{openid}:{date_str}".encode("utf-8")).hexdigest()
    return SIGN_WINDOW_START_MIN + int(h, 16) % SIGN_WINDOW_SLOTS
    # SIGN_WINDOW_START_MIN = 21 * 60 = 1260 (21:00)
    # SIGN_WINDOW_SLOTS = 81 (21:00-22:20，共 81 分钟)
```

**特点：**
- 同一人同一天：固定时刻
- 不同人：分散在 81 分钟窗口内
- 每天变化：避免固定模式

### 2. 坐标随机抖动

模拟真实 GPS 漂移：

```python
# 从学校系统获取用户宿舍坐标
dorm_lat = dorm_info.get("locationLat")  # 每人不同
dorm_lng = dorm_info.get("locationLng")

# 随机抖动 ±0.00003 度 (约 ±3 米)
lat = dorm_lat + random.uniform(-0.00003, 0.00003)
lng = dorm_lng + random.uniform(-0.00003, 0.00003)

# 计算真实距离填入 locationAccuracy
accuracy = haversine(lat, lng, dorm_lat, dorm_lng)
```

### 3. DNS 绕过 (DoH)

FC 容器内无法解析 `.edu.cn` 域名，使用阿里云 DoH 服务：

```python
def _resolve_school_ip():
    # 通过 HTTPS 请求 223.5.5.5 (无需 DNS)
    r = requests.get(
        f"https://223.5.5.5/resolve?name={_SCHOOL_HOST}&type=A",
        timeout=8, verify=False)
    # 返回 IP 地址，写死 218.76.12.57 兜底

# Monkeypatch socket.getaddrinfo
socket.getaddrinfo = _patched_getaddrinfo
```

### 4. 隐私保护

- **前端不暴露 openid**：使用 `member_id = sha256(openid)[:12]`
- **history.json 不含 openid**：只存储昵称
- **users.json 私有**：只有后端可访问

### 5. 请求签名

学校 API 需要签名防篡改：

```python
def generate_sign(url, timestamp, token):
    # 提取路径和查询参数
    parsed = urlparse(url)
    path_query = parsed.path + ("?" + parsed.query if parsed.query else "")
    
    # 拼接签名字符串
    str_to_sign = f"flySourceApi-{CLIENT_ID}{timestamp}{path_query}{token}"
    
    # MD5 签名
    return hashlib.md5(str_to_sign.encode('utf-8')).hexdigest()
```

## 成本分析

- **阿里云 FC**: 按调用次数计费，每晚 81 分钟 × 10 人 ≈ 81 次调用/天，几乎免费
- **阿里云 OSS**: 存储 < 1MB，流量极小，几乎免费
- **Cloudflare Pages**: 免费托管静态网站
- **Server酱**: 免费额度足够

**总成本**: < ¥1/月

## 安全注意事项

1. ⚠️ **openid 是永久凭据**，泄露等同于账号泄露
2. ⚠️ **管理员密码**存储在环境变量，需强密码
3. ⚠️ **OSS Bucket 必须私有**，禁止公开访问
4. ⚠️ **REGISTER_SECRET** 随采集工具分发，视为半公开
5. ✅ 后端通过 openid 验证有效性，防止伪造注册

## 监控与告警

- ✅ 签到失败自动推送 Server酱通知
- ✅ 看板显示每日签到状态
- ✅ 历史记录永久保存，可追溯
- ⏳ 建议添加: FC 日志监控、OSS 访问审计

## 扩展性

当前系统设计支持：
- ✅ 10-100 人规模
- ✅ 水平扩展：增加 FC 并发实例
- ✅ 数据迁移：OSS JSON → 关系数据库
- ✅ 多租户：按学校/宿舍楼分组

## 已知限制

1. 定时器触发间隔: 1 分钟 (不支持更精确)
2. FC 单次超时: 300 秒
3. OSS 单文件大小: 建议 < 5MB
4. 学校 API 限流: 未知，需观察
