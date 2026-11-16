# web-free-studio · 本机视频生成工作台

把 `www.paba.tv` 的视频生成能力落到本机：**多账号授权、命令行/HTTP 提交、成片自动回本地、界面实时可见**。

> 逆向分析与接口证据见 [`.analysis/REA-REPORT.md`](./.analysis/REA-REPORT.md)。
> 本项目**不复制上游任何代码与界面**，只是「自己账号的本地客户端 + 产物归档器」。

---

## 为什么需要「浏览器通道」

实测同一份 Cookie：

| 通道 | 结果 |
|------|------|
| `curl`（含完整浏览器请求头） | ❌ `403 challenge_required` |
| 浏览器页内 `fetch` | ✅ `200` |

写接口按 **TLS 指纹 + Cloudflare Turnstile** 拦非浏览器客户端，所以架构是：

```
本地 HTTP 服务  →  账号车道（每账号独立浏览器身份） →  paba.tv
```

读同步、资产下载仍走快路（CDN 直连）。

---

## 快速开始

```bash
cd ~/Desktop/REA/web-free-studio

npm run doctor          # 环境自检（Node ≥22 / Chrome / 上游可达）
npm run account         # 新增账号并授权：会打开 Chrome，登录完自动接管
npm start               # 启动本地服务 → http://localhost:8790
```

首次用已有登录态迁移（跳过登录）：

```bash
npm run cookie -- <accountId> --file cookies.json
```

`cookies.json` 形如：

```json
[{ "name": "h3v", "value": "...", "path": "/", "httpOnly": true, "expires": 1825990298 },
 { "name": "h3s", "value": "...", "path": "/", "httpOnly": true },
 { "name": "__Host-h3d", "value": "...", "path": "/", "httpOnly": true }]
```

---

## 命令

| 命令 | 作用 |
|------|------|
| `npm run doctor` | 自检：Node / Chrome / 数据目录 / 上游 |
| `npm run account -- --label 昵称` | 新增账号（独立 profile）并走登录授权 |
| `npm run account -- --backend ego` | 接管本机 ego 浏览器的登录态（无需再登录） |
| `npm run accounts` | 账号池状态、免费额度用量 |
| `npm run login -- <id>` | 重新授权（会话过期时） |
| `npm start` | 启动服务（默认 `:8790`，含 45s 自动同步） |
| `npm run sync -- [id]` | 手动对账（不带 id 为全量） |
| `npm run gen -- --prompt "..."` | 命令行提交一条生成 |
| `npm run challenge -- <id>` | 触发人机验证（会开有头窗口，点完自动继续） |

环境变量：`PORT` / `HEADED=1`（默认无头）/ `SYNC_INTERVAL_MS` / `MIRROR_PER_SYNC` / `LANE=chrome|ego` / `CHROME_PATH` / `EGO_SERVER`。

---

## HTTP 接口（给脚本 / 其它 Agent 用）

```bash
# 提交
curl -s --noproxy '*' -X POST http://localhost:8790/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"少女立于朱红门廊前，镜头缓慢推近","duration":5,"resolution":"768p","aspectRatio":"9:16"}'

# 全量对账 + 镜像
curl -s --noproxy '*' -X POST http://localhost:8790/api/sync -d '{}'

# 状态
curl -s --noproxy '*' http://localhost:8790/api/state

# 实时事件（SSE）
curl -N --noproxy '*' http://localhost:8790/api/events
```

> 本机 `http_proxy` 会干扰 `curl 127.0.0.1`，一律加 `--noproxy '*'` 或用 `localhost`。

---

## 本地目录

```
data/
├─ db.json                       # accounts / tasks / log（原子写）
├─ profiles/<accountId>/         # 每账号独立 Chrome profile（登录态在此）
└─ assets/<YYYY-MM-DD>/
   ├─ <taskId>.mp4               # 成片
   ├─ <taskId>.jpg               # 缩略图
   └─ <taskId>.json              # 上游原始任务 JSON（旁车元数据）
```

**同步策略**：以上游为唯一真相源。列表拉 40 条 → 逐条 upsert → 已 `done` 且本地无文件则镜像（每轮最多 6 条，避免一次拉几十个视频）。

---

## 账号与额度

- 每账号独立浏览器 profile，Cookie 互不干扰；单账号失效只降级该账号（`status=logged_out`）。
- 免费模型 `minimax-h3-flash` 每日 15 条，工作台按账号显示「免费已用」。
- 同账号请求**串行**执行，避免并发挤队列 / 触发风控。

---

## 排障

| 现象 | 处理 |
|------|------|
| `403 challenge_required` | 该网络触发人机验证：`npm run challenge -- <id>`，点完自动重试 |
| `401 / logged_out` | 会话过期：`npm run login -- <id>` 重新授权 |
| 免费任务长时间 `pending` | 正常（免费档排队 10–40 分钟），服务会自动同步成片 |
| 无头下验证过不去 | 人机验证需可见窗口，`challenge` 会自动切成有头模式 |
| Chrome 起不来 | 设 `CHROME_PATH`，或 `LANE=ego` 改用 ego 浏览器 |
