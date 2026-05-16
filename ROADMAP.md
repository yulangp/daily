# daily — 后续改进路线

本次修复（2026-05-16）已落地 14 项问题，但还有几类需要外部资源或更大改动的工作没做完。下面按优先级列出建议方向。

---

## 1. 必做（部署前）

### 1.1 在 Firebase 控制台应用 `firebase-rules.json`

仓库根目录的 `firebase-rules.json` 给出了**架构匹配版本**的规则，主要做了：
- 根节点关闭默认读写（防止枚举）
- 各字段长度/类型 `.validate`
- 用户记录里禁止写入未声明字段

**部署方式**：Firebase 控制台 → Realtime Database → 规则 → 粘贴并发布。

⚠️ **关键限制**：因为本项目用**自定义账密**（非 Firebase Auth），规则中**无法用 `auth.uid` 做真正的访问控制**。当前规则只是"通过未知键名提高读取难度"，并非密码学级别的隔离。任何拿到 `coupleId` 或 `username` 字符串的人仍可读取该路径下数据。

要从根本上解决，见 §2.1。

### 1.2 验证旧用户的 PBKDF2 升级路径

旧用户首次登录时会**自动从 SHA-256 升级到 PBKDF2-100k**（无感知）。请在升级后用以下方式抽查：
- Firebase 控制台 → 数据库 → 找一个老用户记录
- 应出现新字段：`pwdAlgo: "pbkdf2-100k"`、`pwdSalt`、`pwdIter`
- 旧 `pwdHash` 字段会被新值覆盖

如果某用户长期不登录，记录仍是旧 SHA-256，没问题——下次登录会自动升级。

---

## 2. 应做（中期）

### 2.1 接入 Firebase Anonymous Auth

**动机**：让安全规则能用 `auth.uid` 真正隔离数据。

**步骤**：
1. Firebase 控制台 → Authentication → 启用「匿名」
2. 注册时调用 `firebase.auth().signInAnonymously()` 拿到 uid
3. 把 uid 写入 `daily_users/{username}/uid`，作为用户名→uid 的映射
4. 数据路径改成以 uid 为键：`daily_private/{uid}`、`daily_rooms/{cid}`，配套规则改成 `auth.uid === $uid`
5. 情侣绑定时 `daily_couples/{cid}` 存 `[uid1, uid2]`，房间规则改成
   ```
   ".read": "auth != null && (root.child('daily_couples/'+$cid+'/user1').val() === auth.uid || root.child('daily_couples/'+$cid+'/user2').val() === auth.uid)"
   ```

这是把 §1.1 的"伪安全"变成"真安全"的唯一可行路径。

### 2.2 图片改用 Firebase Storage

**现状问题**：图片以 base64 嵌入 `entries` 对象。
- 每次 listener 触发都重新下载所有图片
- Firebase RTDB 单次写入 16MB 上限会被很容易触发
- 移动端流量爆炸

**改造**：
1. Firebase 控制台 → Storage → 启用
2. 上传逻辑：保存条目前先 `storage.ref().put(blob)` → 拿到 `downloadURL`
3. `entry.images: string[]` 改成存 URL 而非 base64
4. 旧数据迁移脚本：扫描 `entries`，把 base64 的转上传后替换 URL
5. 增加 Storage 安全规则匹配 §2.1 的 uid 模型

### 2.3 客户端速率限制

邀请码已经从 6 → 8 位（10^6 → 10^12 组合），暴力枚举不再实际可行。但登录/注册接口仍可被脚本批量调用。

**短期**：在 `doAuth` 加客户端节流（连续 5 次失败后冷却 30 秒）。
**长期**：用 Firebase Functions（付费）或 Cloud Run 加服务端限流。

---

## 3. 可做（锦上添花）

### 3.1 忘记密码流程
当前没有重置机制。可选方案：
- **邮箱验证**：注册时收集邮箱，存到 `daily_users`，重置时发邮件（需 Firebase Functions + SendGrid，付费）
- **预生成恢复码**：注册时显示 6 个备用恢复码，让用户存到密码管理器，遗忘时用恢复码替代密码
- **伴侣解锁**：已绑定情侣时，伴侣端可帮忙触发重置

### 3.2 增量渲染
当前每次写入触发 `renderAll()` 全量重建。条目超过 500 条会卡。
- 引入轻量虚拟列表（feed 视图）
- 日历按月懒加载

### 3.3 分模块
2400 行单文件可读性差。可考虑切成：
- `auth.js` `sync.js` `image.js` `couple.js` `render.js` `app.js`
- 但要保留"零构建、可直接 `file://` 打开"的优势，需要用 ES modules + `<script type="module">`

### 3.4 错误上报
现在异常都进 `console.error`，用户报 bug 无法溯源。可以加 Sentry 免费版或自建简单日志收集。

### 3.5 移除 `<meta http-equiv="Content-Security-Policy">` 中的 `'unsafe-inline'`
当前因为大量 `onclick=` 内联事件必须保留。如果未来重构成 `addEventListener` 绑定 + CSP nonce/hash，可以拿到一个安全等级提升。

---

## 修复版本变更摘要（v3）

| 类别 | 变更 |
|------|------|
| 数据 | 删除改用墓碑（防复活）；30 天后自动清理 |
| 同步 | 写锁改用计数器 + 800ms 回声窗 + 15s 安全兜底 |
| 安全 | PBKDF2-100k + 16B 随机盐替换 SHA-256（旧用户登录自动升级） |
| 安全 | mood/time/thumbnail 字段全部 escape，防恶意 JSON 导入 |
| 安全 | 邀请码 6→8 位，crypto.getRandomValues |
| 安全 | CSP meta + Firebase CDN SRI（sha384） |
| 安全 | GitHub Token 风险提示文案 |
| 健壮 | localStorage 配额错误 toast（1 分钟去重） |
| 健壮 | 单条目 >4MB 警告；写入 >12MB 拦截 |
| 健壮 | SW 改 network-first（index.html 不再卡旧版本） |
| 健壮 | manifest icon `any` / `maskable` 拆分 |
| 文档 | `firebase-rules.json` + 本文 |
