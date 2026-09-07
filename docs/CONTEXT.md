# 术语表 (CONTEXT.md)

本项目领域语言的权威定义。只记术语，不记实现细节。

## 签到 (Sign / 平安打卡)

学校"平安打卡"小程序中，学生在规定时间段内上报自己位置以证明在宿舍的行为。
对应接口 `dormSignRecord/stuSign`。

## OpenID

用户在该微信小程序下的**永久稳定**唯一标识——一旦获得便不再改变。通过它可向
`oauth/token` 换取 access_token，是本系统中代表"一个用户"的凭据。
因其不变，用户**一辈子只需提供一次**，这是"输入一次、永久自动签"成立的根基。

## 用户 (User)

本系统中由[OpenID](#openid)唯一标识。`name`（姓名）和 `account_no`（学号）仅用于
后台展示与分辨，**对签到流程无任何功能作用**——签到只依赖 OpenID 换来的 token。
因此注册一个用户在功能上只需要 OpenID。

## jsCode

微信 `wx.login()` 生成的临时登录码，绑定"当前微信号 + 本小程序 appid"。
后端 `openApi/getOpenidByJsCode` 用它换取该用户的 [OpenID](#openid)。
这是 OpenID 在流量中出现的唯一时机，也是采集 OpenID 必须截获的那条响应。

## 登记宿舍坐标 (Registered Dorm Coordinates)

学生在系统中登记的宿舍地理坐标，由签到任务详情接口 `getTaskByIdForApp` 的
`data.dormitoryRegisterVO.locationLat / locationLng` 返回，**每个用户各不相同**。
这是判定签到是否合法的基准点，而非某个全局写死的坐标。

## 允许半径 (Allowed Radius)

签到坐标与登记宿舍坐标之间允许的最大距离，由 `getTaskByIdForApp` 的
`data.locationAccuracy` 返回。实际签到时上报的"距离"小于此值才算"在打卡范围内"。

## 签到坐标 (Sign Coordinates)

签到时实际上报的经纬度 `signLat / signLng`。在官方小程序中来自手机实时 GPS；
在本自动签到系统中，取自该用户的[登记宿舍坐标](#登记宿舍坐标-registered-dorm-coordinates)。

## 任务 (Task)

一次签到活动，有 `signStartTime`（开始时间）等时间窗口约束。未到时间签到会被服务器拒绝
（返回"未到签到时间"）。待签到任务通过 `getListForApp` 列出。

## 签到时段 (Sign Window)

每天允许签到的时间范围：**21:00–22:30**。早于 21:00 服务器拒签。
自动签到的定时器须落在此窗口内多次尝试（每 25 分钟一次），脚本自动跳过已签到/未到时间者。

## 失败通知 (Failure Alert)

每天签到完成后，将"成功/失败汇总"通过 Server酱 推送给**管理员一人**（非每个熟人）。
配合公开[状态页](#状态页-status-page)构成双重兜底。OpenID 永久不变、不会失效，故通知主要
针对"签到被服务器拒绝"等异常，管理员据此排查（如时间窗变动、接口变更）。

## 状态页 (Status Page)

公开网页，展示每个用户的**昵称 + 最近一次签到结果 + 时间**，以及[签到历史](#签到历史-sign-history)。
**严禁回显 OpenID**——OpenID 等同登录凭据，只存后台名册，状态页只读不含 OpenID 的历史流水。

## 名册 (Roster)

存储于 OSS `users.json`，每人一条 `{openid, 昵称}`。注册接口写入、定时器读取。
含明文 OpenID，属敏感数据，仅后台函数可访问。

## 签到历史 (Sign History)

存储于 OSS `history.json`，每次签到追加一条 `{昵称, 日期, 时间, 结果}`，**永久保留**。
不含 OpenID，是[状态页](#状态页-status-page)唯一的数据来源。
