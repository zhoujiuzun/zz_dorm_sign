# 宿舍自动签到系统 - 领域语言

## 核心概念

### Member（成员）
系统中的一个用户，由微信 openid 唯一标识。成员有三种状态，存储在三个独立的 JSON 文件中。

### Active Member（活跃成员）
存储在 `users.json`。参与每日自动签到的成员。具有：
- openid（微信唯一标识）
- nickname（真实姓名，从学校系统获取）
- created（注册时间）

### Blacklisted Member（被拉黑成员）
存储在 `blacklist.json`。因违规被管理员拉黑的成员。特征：
- 不参与自动签到
- **无法自己重新注册**（注册时返回 403 错误）
- 只能由管理员手动恢复为活跃成员
- 保留 openid 和历史记录

### Deleted Member（已删除成员）
存储在 `deleted.json`。被管理员从列表中移除但保留数据的成员。特征：
- 不参与自动签到
- 不显示在"活跃成员"列表中
- **可以自己重新注册**（自动恢复为活跃成员，使用旧昵称）
- 也可以由管理员手动恢复
- 保留 openid 和历史记录

### History Record（历史记录）
存储在 `history.json`。每次签到的永久记录，包含：
- nickname（签到时的昵称）
- date（签到日期）
- time（签到时间）
- status（签到状态：ok/error/login_failed）
- message（错误信息）

注意：历史记录**不含 openid**，按 nickname 关联。被删除或拉黑的成员，其历史记录永久保留。

### Member ID
由 openid 派生的非敏感标识符（SHA256 前 12 位），用于前端操作。前端不接触 openid。

### 状态转换规则

```
注册 → Active Member
Active Member --拉黑--> Blacklisted Member
Active Member --删除--> Deleted Member
Blacklisted Member --恢复--> Active Member
Blacklisted Member --彻底删除--> （openid 永久丢失）
Deleted Member --恢复/重新注册--> Active Member
Deleted Member --彻底删除--> （openid 永久丢失）
```

### 关键约束

1. **自动签到范围**：只有 Active Member 参与自动签到
2. **注册检查顺序**：
   - 如果 openid 在 blacklist.json → 拒绝（403 "已被拉黑"）
   - 如果 openid 在 deleted.json → 允许，自动恢复（使用旧昵称）
   - 否则 → 新注册
3. **昵称策略**：恢复时使用 deleted.json 中的旧昵称，不使用学校系统返回的新昵称
4. **历史保留**：任何状态变更都不删除 history.json 中的记录
