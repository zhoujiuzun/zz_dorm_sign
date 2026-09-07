# Cloudflare Pages 部署步骤

前端已改造为「纯静态 + 调 FC API」，待上传文件在 `cloudflare-dist/` 文件夹：
- index.html
- app.js（已指向线上 FC API）
- style.css

> 注（2026-06-17）：`cloudflare-dist/` 已删除（当前看板走本地 `dashboard.py`，未走 Cloudflare）。
> 若日后要部署到 Cloudflare，从 `sign/static/` 复制这 3 个文件即可重新生成（app.js 里把 API 地址指向线上 FC）。

后端 FC 已开启 CORS，前端可跨域调用。

---

## 方式 A：直接拖拽上传（最简单，推荐）

1. 注册/登录 Cloudflare：https://dash.cloudflare.com
   （没账号就用邮箱注册，免费）

2. 左侧菜单点 **Workers 和 Pages** → **创建** → **Pages** → **上传资产（Upload assets）**

3. 项目名称填：`dorm-sign`（或任意）

4. 把 `cloudflare-dist` 文件夹里的 **3 个文件**（不是文件夹本身，是里面的文件）拖进上传区

5. 点 **部署站点（Deploy site）**

6. 部署完成后得到一个网址，形如：
   `https://dorm-sign.pages.dev`

7. 打开这个网址，看板应该正常显示了！

---

## 方式 B：连接 GitHub（自动部署，适合以后改动）

1. 把 `cloudflare-dist` 里的文件推到一个 GitHub 仓库

2. Cloudflare Pages → **创建** → **连接到 Git** → 选该仓库

3. 构建设置：
   - 框架预设：**None**
   - 构建命令：留空
   - 输出目录：`/`（或文件所在目录）

4. 部署后同样得到 `xxx.pages.dev` 网址

5. 以后改动推到 GitHub，Cloudflare 自动重新部署

---

## 部署后验证

打开 `https://你的项目.pages.dev`，检查：

1. ✅ 看板正常渲染（不再下载文件）
2. ✅ 顶部时间在跳动
3. ✅ 成员列表、日历显示数据
4. ✅ 点右上角「登录」→ admin / loveyou520 → 能看到拉黑按钮
5. ✅ 切换「黑名单」标签正常

---

## 国内访问说明

- `xxx.pages.dev` 在国内**可能时快时慢**（Cloudflare 境外节点）
- 如果访问不稳定，两个改善方向：
  1. 绑定你的域名 `sign.zhztool.top`（备案后，Cloudflare 也支持自定义域名）
  2. 长期最稳：备案 + 阿里云 OSS

---

## 自定义域名（可选，备案后）

Cloudflare Pages 也能绑 `sign.zhztool.top`：

1. Pages 项目 → **自定义域** → 添加 `sign.zhztool.top`
2. 按提示在阿里云 DNS 加 CNAME 记录指向 Cloudflare
3. Cloudflare 自动签发 HTTPS 证书

注意：国内访问 Cloudflare 自定义域名仍可能不稳定，要国内秒开还是 OSS + 备案最佳。

---

## 改动前端后如何更新

如果以后我帮你改了前端（app.js / index.html / style.css）：
1. 我会重新生成 `cloudflare-dist`
2. 方式 A：重新拖拽上传覆盖
3. 方式 B：推到 GitHub 自动部署

---

## 当前架构总览

```
用户浏览器
    │
    ├── 访问 https://dorm-sign.pages.dev  （Cloudflare，前端页面）
    │         │
    │         └── fetch 调用 ↓ （跨域，已开 CORS）
    │
    └── https://sign-bprgxfyexe.cn-beijing.fcapp.run  （阿里云 FC，后端 API + 定时签到）
              │
              └── OSS（zhouhuanzhang）：users.json / history.json / blacklist.json
```

- 前端：Cloudflare Pages（免费、免备案）
- 后端 API + 定时签到：阿里云 FC（已运行）
- 数据：阿里云 OSS（已运行）
