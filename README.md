# web-free-studio · 本机视频生成工作台

把 `www.paba.tv` 的视频生成能力落到本机：**多账号池、免费额度按消耗计账、提交排队、成片自动回本地**。

> 逆向分析与接口证据见 [`.analysis/REA-REPORT.md`](./.analysis/REA-REPORT.md)。
> 本项目**不复制上游任何代码与界面**，只是「自己账号的本地客户端 + 产物归档器」。

---

## 当前形态（v0.2）

| 能力 | 说明 |
|------|------|
| **只跑免费模型** | 白名单仅 `minimax-h3-flash`（768p、4–15s、0 元）；付费模型直接 400 拒绝，避免误扣积分 |
| **多账号池** | 每账号独立浏览器 profile（Cookie/设备态隔离）；支持新增、授权、停用、单独同步；提交时自动挑「消耗最少 + 在途最少」的账号 |
| **额度按消耗计** | 本地账本记「已消耗次数」，提交即扣 1，失败自动退还；同步时用上游当日免费条数校准（只上调） |
| **提交队列** | 全局并发 2、单账号串行 + 4s 最小间隔、同参数 60s 内幂等去重、单账号在途上限 2 |
| **原站入口** | 工作台右上角「打开原站 ↗」，随时对比/人工确认 |
| **产物回本地** | `data/assets/<日期>/<id>.mp4 + .jpg + .json`，工作台内直接播放 |

---

## 为什么必须走浏览器通道

实测同一份 Cookie：

| 通道 | 结果 |
|------|------|
| `curl`（含完整浏览器请求头） | ❌ `403 challenge_required` |
| 浏览器页内 `fetch` | ✅ `200` |

写接口按 **TLS 指纹 + Cloudflare Turnstile** 拦非浏览器客户端。读同步、CDN 下载仍走快路。

---

## 快速开始

```bash
cd ~/Desktop/REA/web-free-studio

npm run doctor          # 环境自检（Node ≥22 / Chrome / 上游可达）
npm run account         # 新增账号并授权：会打开 Chrome，登录完自动接管
npm start               # 启动本地服务 → http://localhost:8790
```

已有登录态迁移（跳过登录）：`npm run cookie -- <accountId> --file cookies.json`

---

## 队列与并发（为什么不会把账号打爆）

```
POST /api/generate
   ├─ 校验：prompt / 免费模型白名单 / 账号状态 / 当日额度 / 在途数
   ├─ 幂等：同参数 60s 内重复提交 → 直接复用上一个 job
   └─ 入队 → 全局最多 2 个 job 同时跑；单账号串行 + 间隔 4s
            ├─ 预扣 1 次额度
            ├─ 上游返回 429 too_many_pending → 立即失败并退还，不重试
            ├─ 上游 5xx/429 其它 → 退避重试（最多 3 次）
            └─ 成功 → 落库 + SSE 通知；失败 → 退还额度并记失败
```

| 参数 | 默认 | 含义 |
|------|------|------|
| `FREE_DAILY_LIMIT` | 15 | 每账号每天免费次数 |
| `MAX_ACTIVE_PER_ACCOUNT` | 2 | 单账号在途上限（**与上游硬限制一致**） |
| `SUBMIT_CONCURRENCY` | 2 | 全局同时提交数 |
| `MIN_SUBMIT_INTERVAL_MS` | 4000 | 单账号两次提交最小间隔 |
| `DEDUP_WINDOW_MS` | 60000 | 同参数去重窗口 |

---

## 限制清单（实测，别再踩）

| 限制 | 具体表现 | 本服务的处理 |
|------|----------|--------------|
| **免费档在途上限 2** | 第 3 条提交直接 `429 too_many_pending`，错误体还带 `open[]` 列出占位任务 | 提交前本地先拦；上游再拦则立即失败并退还额度，不重试 |
| **每日额度 15 次/账号** | 页面「今日剩 N 条」；按提交次数扣，不看时长 | 本地账本预扣 + 失败退还，用上游当日条数校准 |
| **免费队列很慢** | 实测排位 11→2 用掉约 20 分钟，ETA 常为空 | 有在途任务时同步提速到 20s；界面显示队列位次 |
| **TLS 指纹拦截** | 非浏览器客户端一律 403 | 写通道固定走真实浏览器 |
| **人机验证会扩散** | 触发后读接口也 403 | 统一走同一账号车道；验证页可人工点一下后自动重试 |
| **会话约 3 天** | `h3s` 过期后 401 | 账号置 `logged_out`，其余账号不受影响 |
| **同一 prompt 重复扣次** | 上游对重复提交返回 `409 duplicate_submission` | 本地 60s 幂等去重，先挡一层 |

---

## 命令

| 命令 | 作用 |
|------|------|
| `npm run doctor` | 自检：Node / Chrome / 数据目录 / 上游 |
| `npm run account -- --label 昵称` | 新增账号（独立 profile）并走登录授权 |
| `npm run account -- --backend ego` | 接管本机 ego 浏览器的登录态 |
| `npm run accounts` | 账号池状态 |
| `npm run login -- <id>` | 重新授权（会话过期时） |
| `npm start` | 启动服务（默认 `:8790`，自适应同步） |
| `npm run sync -- [id]` | 手动对账 |
| `npm run gen -- --prompt "..."` | 命令行提交（走同一套队列与额度校验） |
| `npm run challenge -- <id>` | 触发人机验证（开有头窗口） |

---

## HTTP 接口

```bash
# 提交（默认等结果；加 "async":true 立刻拿 jobId）
curl -s --noproxy '*' -X POST http://localhost:8790/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"少女立于朱红门廊前","duration":5,"aspectRatio":"9:16"}'

curl -s --noproxy '*' -X POST http://localhost:8790/api/sync -d '{}'   # 全量对账
curl -s --noproxy '*' http://localhost:8790/api/state                  # 状态（含额度/队列）
curl -s --noproxy '*' http://localhost:8790/api/queue                  # 队列与最近 job
curl -N --noproxy '*' http://localhost:8790/api/events                 # SSE
```

> 本机 `http_proxy` 会干扰 `curl 127.0.0.1`，加 `--noproxy '*'` 或用 `localhost`。

---

## 本地目录

```
data/
├─ db.json                       # accounts / tasks / usage / log（原子写）
├─ profiles/<accountId>/         # 每账号独立 Chrome profile
└─ assets/<YYYY-MM-DD>/
   ├─ <taskId>.mp4               # 成片
   ├─ <taskId>.jpg               # 缩略图
   └─ <taskId>.json              # 上游原始任务 JSON
```

---

## 排障

| 现象 | 处理 |
|------|------|
| `409 too_many_pending` | 该账号已有 2 条在排队，等出片；或换账号 |
| `403 challenge_required` | `npm run challenge -- <id>`，点完自动重试 |
| `401 / logged_out` | `npm run login -- <id>` 重新授权 |
| 免费任务长时间「排队」 | 正常（免费档 10–40 分钟），服务会自动同步并落盘 |
| 无头下验证过不去 | 人机验证需可见窗口，`challenge` 会自动切有头模式 |
| Chrome 起不来 | 设 `CHROME_PATH`，或 `LANE=ego` 改用 ego 浏览器 |
