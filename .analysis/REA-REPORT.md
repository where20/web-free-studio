# REA 分析报告 · PabaTV 视频生成 → 本地落地服务

> **REA** = Requirements · Extract · Assemble（需求 · 提取 · 装配）
> 目标：把 `www.paba.tv/#video` 的视频生成能力，落成一套**在本机跑、账号可多开、产物自动回本地**的服务。
> 分析日期：2026-11-16 · 目标环境：macOS / Node 22 · 分析方式：运行时抓包 + 前端 bundle 逆向 + 真实请求验证（非静态猜测）
> 分析对象：`https://www.paba.tv`（自有账号 `s2a:3976`，并非第三方公开 API）

---

## 0 · TL;DR

| 维度 | 结论 |
|------|------|
| **产品本体** | 一个 hash 路由的单页 AI 创作站：视频 / 图像 / 音频 / 对象 / 画布工作台，视频页背后是 `MiniMax H3` 系列模型池 |
| **接口形态** | 自研 REST：`/v1/*`（业务）+ `/auth/*`（账号）。**不是 OpenAI 兼容协议**，但结构清晰、字段扁平 |
| **鉴权** | 纯 Cookie：`h3v`（身份，≈1 年）、`h3s`（会话，≈3 天）、`__Host-h3d`（设备）。**无 CSRF token、无签名头** |
| **写入口令** | POST 会先过 **Cloudflare Turnstile** 人机验证（`/__h3c/fresh.html` → `/__h3c/verify` 换 Cookie），且**按 TLS 指纹识别**：curl 一律 `403 challenge_required`，浏览器内 `fetch` 一次通过 |
| **关键结论 1** | **读通道**可以纯 HTTP + Cookie 直连（`/auth/me`、`/v1/videos`、`/v1/videos/{id}`、CDN 直链） |
| **关键结论 2** | **写通道必须走真实浏览器**（TLS/JA3 指纹 + Turnstile）。这决定了落地架构不是「纯代理」，而是「代理 + 浏览器执行器」 |
| **产物回流** | `GET /v1/videos/{id}/content` 带 Cookie → `302` 到 `media.paba.tv`（公开 CDN、支持 Range）→ 本地直接 `curl` 即可镜像，无需鉴权 |
| **免费额度与并发** | 8 个视频模型；`minimax-h3-flash` 768p 全时长 0 元（每日 15 条），**且每账号最多 2 条在排队/生成中**（第 3 条 `429 too_many_pending`） |
| **落地形态** | 本地服务 `:8790`：账号池（每账号独立浏览器 profile）+ 双通道执行器 + 任务状态机 + 资产镜像（`data/assets/日期/ID.mp4|.jpg|.json`）+ SSE 实时工作台 |
| **可验证状态** | ✅ 读同步、✅ 通过服务提交、✅ 成片落盘 11 MB 已实测；⚠️ 免费队列排队 10+ 位，成片延迟 10–40 分钟 |

---

## 1 · Requirements（需求）

### 1.1 使用方要什么

| 诉求 | 翻译成工程约束 |
|------|----------------|
| 「视频生成服务落地到本地」 | 本机常驻 HTTP 服务，提供比网页更顺手的接口（命令行/工作台/给别的 Agent 调） |
| 「登录可以授权（多个账号）」 | 账号池：每账号独立登录态与独立浏览器容器，互不串号；单账号失效不能拖垮全池 |
| 「操作和生成的内容要同步到本地」 | 双向：**提交动作**落本地库（含 prompt/参数/幂等键）；**上游成片**镜像到本地磁盘并建索引 |
| 「用 REA 分析」 | 先证据后结论：每个判断都要有抓包/响应/源码位置支撑 |

### 1.2 非功能约束（从上游行为反推）

| 类别 | 约束 | 证据 |
|------|------|------|
| **反自动化** | 写接口校验 TLS 指纹 + Turnstile，纯 HTTP 客户端不可用 | curl 全头模拟 → `403 challenge_required`；同 Cookie 浏览器内 `fetch` → `200` |
| **挑战会扩散** | 触发一次后，**读接口也会被一并拦**，需要重新过验证 | 连续请求后 `/auth/me`、`/v1/videos` 全部 `403` |
| **幂等** | 重复提交返回 `409 duplicate_submission`，需二次确认 | bundle：`submitKey("video", Q)` + `confirm_duplicate` |
| **队列慢** | 免费档「普通排队」，实测排位 11 且 ETA 为空 | 任务 `queue_position: 11, queue_eta_seconds: null` |
| **额度按账号按天** | 视频页显示「免费 · 今日剩 15 条」；`billing.free=true` 逐条记账 | `/v1/videos` 返回 `billing:{cost:0,free:true}` |
| **内容审核** | 成片带 `moderation: "passed"` 字段 | 单任务响应 |
| **会话短** | `h3s` 约 3 天过期 → 账号会周期性掉线 | cookie 有效期实测 |

---

## 2 · Extract（提取）

### 2.1 端点全图（实测，非推测）

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
|------|------|------|------|------|
| GET | `/auth/me` | 当前身份 | Cookie | `{ok,user_id,accounts,...}`；**未登录也回 200**，靠 `ok` 判断 |
| GET | `/auth/config` | 站点能力开关 | 否 | 注册/Google OAuth/密码登录/邀请码 |
| POST | `/auth/account/login` | 邮箱密码登录 | 否 | body `{email,password,invitation_code?}` |
| POST | `/auth/account/send-verify-code` | 邮箱验证码 | 否 | 响应带 `countdown`；可能返回 `428 + pow` 要求算力证明 |
| GET | `/auth/oauth/google/start` | Google 授权入口 | 否 | 带 `?back=` 回跳 |
| GET | `/v1/models` | 模型目录 + 能力矩阵 | Cookie | 8 个视频模型，含 modes / ratios / resolutions / duration / styles / tiers / features |
| GET | `/v1/videos?limit=N` | 任务列表（含队列水位） | Cookie | `queue:{running,pending,done}` |
| GET | `/v1/videos/{id}` | 单任务状态 | Cookie | 轮询主接口 |
| POST | `/v1/videos/generations` | **提交生成** | Cookie + 指纹 | 需 `Idempotency-Key`，可能 `403 challenge_required` |
| POST | `/v1/videos/{id}/cancel` | 取消排队 | Cookie | 已开始生成则不可取消 |
| POST | `/v1/videos/{id}/jump` | 插队/升级 | Cookie | bundle 内 `jumpQueue()` |
| DELETE | `/v1/videos/{id}` | 删除任务 | Cookie | 也用于「清空已结束」 |
| GET | `/v1/videos/{id}/content` | 取成片 | Cookie | **302 → CDN**；无 Cookie 直接 401 |
| GET | `/v1/videos/prices` | 价目表 | 否 | 按 `模型/分辨率/秒数` 三维定价 |
| GET | `/v1/estimate?...` | 预估 | Cookie | 免费额度也用这个口子 |
| GET | `/v1/queue/channels` | 自定义队列通道 | Cookie | 当前空数组 |
| GET | `/v1/featured-shots` | 灵感/示例镜头 | 否 | 9.3 KB 条目池 |
| POST | `/v1/telemetry/environment` | 环境上报 | 否 | 客户端指纹上报 |
| — | `/v1/objects/*`、`/v1/audio/*`、`/v1/workbench/*`、`/v1/assist/*`、`/v1/community` | 图像 / 音频 / 画布工程 / AI 助手 / 社区 | Cookie | 与视频同构，可后续扩展 |
| — | `/__h3c/fresh.html` + `POST /__h3c/verify` | **人机验证** | 否 | Turnstile token 换 Cookie |

### 2.2 提交体结构（从 bundle 逐字段还原）

```jsonc
{
  "channel_id": "",              // 队列通道，空=默认
  "model": "minimax-h3-flash",
  "model_v": 2,                  // 协议版本（前端常量 NCM.PROTOCOL）
  "prompt": "……",
  "duration": 4,                 // 4–15 秒，受 frame_rule 约束
  "resolution": "768p",
  "aspect_ratio": "16:9",
  "tier": "sol",                 // 可选：极速档
  "style": "combat",             // 可选：风格 ID
  "seed": 621716979,             // 可选
  "preview": true,               // 实时预览（草稿）
  "fast_preview": false,
  "first_frame": "<data>",       // 图生视频
  "last_frame": "<data>",        // 首尾帧
  "reference_images": ["<data>"],
  "reference_videos": [{ "data": "<data>", "with_audio": true, "duration": 5 }],
  "reference_audios": ["<data>"],
  "guides": [{ "frame_idx": 0, "image": "<data>", "duration": 3 }]
}
```

请求头：`Content-Type: application/json` + `Idempotency-Key: <uuid>`。
大于 256 KB 的请求体前端会切到 `XMLHttpRequest` 上传进度 + gzip，本地服务可直接用普通 POST（参考图走 data URL）。

### 2.3 任务对象（响应 / 列表项同构，节选实测字段）

```jsonc
{
  "id": "h3_261905ed744905c44b80aab97d12499b",
  "request_id": "h3_...",            // 与 id 相同，下载路径用它
  "status": "pending|running|done|failed|draft",
  "queue_state": "upstream",
  "queue_position": 11,
  "queue_eta_seconds": null,
  "model": "minimax-h3-flash", "model_key": "fl2va",
  "tier": "sol", "tier_cn": "极速",
  "prompt": "……",
  "duration": 15, "resolution": "768p", "requested_resolution": "768p",
  "aspect_ratio": "16:9", "width": 1344, "height": 768, "frames": 362,
  "billing": { "cost": 0, "free": true },
  "moderation": "passed",
  "created_at": 1794456906, "started_at": 1794458514.1, "finished_at": 1794458640.8,
  "video": {
    "url": "/v1/videos/h3_.../content",
    "cdn_url": "https://media.paba.tv/h3/node/ln_xxx/sol.mp4",
    "thumb_url": "https://media.paba.tv/h3/thumbs/xxx.jpg",
    "duration": 15, "resolution": "768p"
  }
}
```

### 2.4 模型能力矩阵（`/v1/models` 摘要）

| 模型 | 分辨率 | 时长 | 大致价格 | 备注 |
|------|--------|------|----------|------|
| `minimax-h3-flash` | 768p | 4–15s | **0 元**（每日 15 条） | 普通排队，主力免费档 |
| `minimax-h3-flash-vip` | 768p | 4–15s | 1 元/秒 | 免排队 |
| `minimax-h3` | 576p / 768p | 4–15s | 3 / 5 元/秒 | 画质档 |
| `dreamina-seedance-2-0-fast` | 480p / 720p | 4–15s | ≈13 / 28 元/秒 | 长视频成本陡增 |
| `wan3.0-video` / `-prime` | 480p+ | — | 见价目表 | — |
| `happyhorse-1.1` / `1.0` | — | — | 见价目表 | — |

- **modes**：`text`（文生视频）/ `reference`（全能参考）/ `first`（图生视频）/ `frames`（首尾帧）
- **frame_rule**：`fps 24, base 5, step 17, out_base 1, out_step 8` → 时长不是任意值都能落帧，需按规则吸附
- **features**：`live_preview / draft_preview / seed / count[1,2] / motion / negative`
- **styles**：18+ 个风格（武打、兵器格斗、动漫动作、镜头运动、动态壁纸、低多边形、360 环绕、16 位像素…），带「需首帧图 / 需参考图」前置条件

### 2.5 反爬与验证链（本节是全案的技术分水岭）

```
POST /v1/videos/generations
   │
   ├─ 200 ────────────────────────────► 成功，进队列
   │
   └─ 403 {code:"challenge_required"}
            │
            ▼
      前端弹 <dialog>，内嵌 iframe /__h3c/fresh.html
            │  Cloudflare Turnstile（sitekey 0x4AAAAAAFqqk90sgLbzMVhY）
            ▼
      POST /__h3c/verify {token}  →  服务端种 Cookie（设备信誉）
            │
            ▼
      前端 postMessage({h3c:"ok"}) → 自动重发原请求
```

**实测结论（同一份 Cookie 三路对照）**：

| 通道 | 请求头 | 结果 |
|------|--------|------|
| `curl` 仅 Cookie | UA + Origin + Referer + sec-ch-ua 全套 | ❌ `403 challenge_required` |
| `curl` 全浏览器头 | 同上 + sec-fetch-* | ❌ `403 challenge_required` |
| 浏览器页内 `fetch` | 浏览器自带的完整指纹 | ✅ `200` 且任务创建成功 |

→ 差异不在 Cookie，也不在常见请求头，而在 **TLS/HTTP2 指纹**。因此任何「纯 Node/curl 代理」方案在写侧都会失败。
**这条结论直接决定了本地服务的架构：读写分通道。**

### 2.6 免费额度与排队实测

| 观察 | 数据 |
|------|------|
| 单日免费额度 | 视频页「今日剩 N 条」；提交后 `billing.free=true, cost=0`；实测上限 15 次/账号 |
| **单账号在途上限** | **2 条**。第 3 条提交直接 `429 too_many_pending`，错误体还回 `open[]` 列出占位任务 |
| 队列水位 | 同一时刻 `{running:4, pending:7, done:18564}` |
| 单任务排位 | 提交后 `queue_position=12 → 11`（约 2 分钟挪 1 位）；另一条 20 分钟内从 11 走到 2 |
| 成片耗时段 | 历史任务 `started_at → finished_at ≈ 126 秒`；免费档总耗时 **10–40 分钟** |

**429 响应体（实测原文）**

```json
{ "error": {
    "message": "免费档已有 2 条视频在排队或生成中，等其中一条完成再提交（付费模型另算）",
    "type": "too_many_pending",
    "open": [{ "request_id": "h3_...", "status": "pending", "prompt": "…" }]
} }
```

→ 这是**服务端强制的每账号并发闸门**，本地再做多账号池才有意义：单账号堆任务只会全部变慢。
落地实现把该闸门设为「提交前本地先拦（`MAX_ACTIVE_PER_ACCOUNT=2`）+ 上游返回则立即失败并退还额度，不重试」。

---

## 3 · Assemble（装配）

### 3.1 架构一句话

> **本地服务 = 账号池（每个账号一套浏览器身份）+ 双通道执行器（读走 HTTP 快路，写走浏览器慢路）+ 本地任务库与资产库 + 同步器**。

```
┌──────────────────────────── 本机 :8790 ────────────────────────────┐
│  web/index.html      工作台（提交 / 记录 / 账号 / 日志，SSE 实时）    │
│         │                                                          │
│  server/src/api.mjs   HTTP API + SSE + 静态资产                     │
│         │                                                          │
│  ┌──────┴────────┐        ┌──────────────────────┐                 │
│  │ sync.mjs      │        │ store.mjs (data/db)  │                 │
│  │ 对账/镜像      │◄──────►│ accounts/tasks/log   │                 │
│  └──────┬────────┘        └──────────────────────┘                 │
│         │                                                          │
│  ┌──────┴─────────────────────────────────────────┐                │
│  │ lane.mjs  账号车道（串行化，按账号队列）          │                │
│  │  ├ ChromeLane：spawn Chrome，独立 --user-data-dir│                │
│  │  └ EgoLane   ：ego-browser 常驻浏览器（taskSpace）│                │
│  └──────┬──────────────────────────────────────────┘                │
│         │  Runtime.evaluate → 页内 fetch（真实指纹）                │
└─────────┼──────────────────────────────────────────────────────────┘
          ▼
   www.paba.tv  /v1/*  /auth/*      （Turnstile 挑战可人工点一下）
          │
          ▼  /v1/videos/{id}/content  →302→  media.paba.tv（公开 CDN）
   data/assets/2026-11-12/<id>.mp4 + .jpg + .json
```

### 3.2 关键设计决策

| 决策 | 选择 | 理由（对应证据） |
|------|------|------------------|
| 写通道 | **真实浏览器内 `fetch`**，不用 Node 直连 | curl 无论如何都是 403（§2.5） |
| 读通道 | 同样走浏览器，但可切换 HTTP 快路 | 挑战一旦触发，读口也会被拦，统一通道更省心 |
| 多账号 | **一账号一 profile + 一调试端口**（ChromeLane）；或一账号一 `taskSpace`（EgoLane） | Cookie 在 profile 内隔离，天然不串号 |
| 同账号并发 | **串行队列 + 在途上限 2**（`MAX_ACTIVE_PER_ACCOUNT`） | 上游 `429 too_many_pending` 明写只允许 2 条（§2.6）；并发只会互相挤队列 |
| 全局并发 | **2**（`SUBMIT_CONCURRENCY`） | 免费档提交本身要 2–4s 且要过浏览器通道，堆并发没有收益 |
| 额度记法 | **本地账本按「消耗次数」预扣，失败退还，同步时用上游当日条数校准（只上调）** | 上游没有额度查询接口（`prices.trial` 常为空），只能自己记账 + 事后对账 |
| 重复提交 | 同参数 60s 内幂等去重；上游 `409 duplicate_submission` 视为已存在 | bundle `submitKey()` 语义 |
| 模型范围 | **白名单只放 `minimax-h3-flash`** | 其余模型按秒扣积分（§2.4），本地误调会造成真实扣费 |
| 挑战处理 | 捕获 `403 challenge_required` → 自动打开 `__h3c/fresh.html` → 等真人过验证 → 自动重试原请求 | 与前端 `mailPost` 的重试语义一致（§2.5） |
| 幂等 | 本地生成 `Idempotency-Key` 并留档；命中 `409 duplicate_submission` 视为已提交 | bundle `submitKey()` |
| 产物回流 | 优先 `cdn_url`（公开、Range），失败回落 `/content`（带 Cookie，302 跟随） | 两条路都实测可用；CDN 免鉴权更稳 |
| 落盘布局 | `data/assets/<YYYY-MM-DD>/<taskId>.{mp4,jpg,json}` | 日期分区便于清理；`.json` 旁车保留上游原始参数 |
| 状态机 | 本地只存 `pending/running/done/failed` + 上游 `queue_state/position`，**以上游为准** | 上游是唯一真相源，本地做镜像不做裁判 |
| 前端 | 单文件原生 JS，**不复制上游 UI** | 只借用能力，不搬版面与代码 |

### 3.3 代码地图

| 文件 | 职责 | 关键实现 |
|------|------|----------|
| `server/cli.mjs` | 命令入口 | `doctor / account add / login / serve / sync / gen / challenge / cookie` |
| `server/src/config.mjs` | 配置与常量 | 端口 8790、45s 同步周期、每轮最多镜像 6 条、Chrome 路径探测 |
| `server/src/store.mjs` | 本地库 | 原子写（tmp+rename）、accounts/tasks/log 三表 |
| `server/src/cdp.mjs` | 零依赖 CDP | 全局 `WebSocket` + `Runtime.evaluate`，建页/导航/执行 |
| `server/src/chrome.mjs` | 浏览器生命周期 | 每账号独立端口（9333+hash）、headless↔headed 热切换（人工验证需要） |
| `server/src/lane.mjs` | 账号车道 | `BaseLane`（业务）+ `ChromeLane` / `EgoLane`（执行），挑战自动重试、镜像下载 |
| `server/src/sync.mjs` | 对账器 | 列表→落库→镜像→额度统计，失败只降级该账号 |
| `server/src/api.mjs` | HTTP 面 | `/api/state`、`/api/generate`、`/api/sync`、账号动作、`/api/events`(SSE)、`/assets/*` |
| `web/index.html` | 工作台 | 提交表单 + 记录网格（本地视频直放）+ 账号池 + 日志 |

### 3.4 对外接口（可直接给别的 Agent / 脚本调）

| 接口 | 说明 |
|------|------|
| `POST /api/generate` | `{accountId?, prompt, model?, duration?, resolution?, aspectRatio?, style?, seed?}` → `{upstreamId}` |
| `POST /api/sync` | 全量对账（可带 `accountId` 只同步单账号） |
| `POST /api/accounts/:id/login` | 打开有头浏览器，等人工完成登录后自动接管 |
| `POST /api/accounts/:id/challenge` | 触发人机验证并等待通过 |
| `POST /api/accounts/:id/cookies` | 导入已有 Cookie（`h3v/h3s/__Host-h3d`）实现零登录迁移 |
| `DELETE /api/tasks/:accountId/:upstreamId` | 上游删除（本地成片保留） |
| `GET /api/events` | SSE：`task / asset / sync / sync_error / login / log` |
| `GET /assets/<date>/<id>.mp4` | 本地成片直出（支持 Range，可拖拽播放） |

### 3.5 实测验证记录

| 步骤 | 结果 |
|------|------|
| `doctor` 自检 | ✅ Node 22 / Chrome / 上游 200 |
| 账号接管（ego 会话） | ✅ `user_id=s2a:3976`，同步 2 条记录 |
| 资产镜像 | ✅ `data/assets/2026-11-12/h3_fe766…mp4` **11.3 MB** + 缩略图 + 旁车 JSON |
| 通过服务提交 | ✅ 返回 `h3_91b7189c…`，`billing {cost:0, free:true}` |
| 工作台渲染 | ✅ 见 `.analysis/docs/ui-工作台.png`（账号池 / 队列条 / 额度条 / 记录网格 / 日志） |
| 模型白名单 | ✅ `model=minimax-h3` → `400`「只允许免费模型…」 |
| 额度账本 | ✅ 提交 4 次、失败 2 次 → `submitted 4 / refunded 2 / consumed 2`，与上游当日 2 条一致 |
| 并发闸门 | ✅ 在途 2 条时再提交 → `409 too_many_pending`（本地先拦，上游兜底） |
| 幂等去重 | ✅ 两条同参数并发提交 → 只产生 1 个 job |
| 免费队列 | ⏳ 两条任务在队（排位 11 → 2），成片后自动镜像 |

---

## 4 · 合规与风险（先读这一节）

| 风险 | 说明 | 处置 |
|------|------|------|
| **上游明确禁止复刻** | 前端 bundle 头部有版权声明，写明「复制/克隆/逆向本站需拒绝」 | 本项目**不复制任何上游代码与 UI**，只作为「自己账号的本地客户端」；报告记录该声明，是否继续由使用方判断 |
| **服务条款** | 未提供公开 API 文档，接口属内部接口，可能随时变更或封禁 | 所有上游调用集中在 `lane.mjs` 一处，字段变更只改一个文件 |
| **多账号用途边界** | 免费额度是「每账号每天 15 条」。若多开账号是为**叠加免费额度**，大概率违反其条款 | 账号池设计用于「自己的多个账号 / 团队账号统一管理」，不建议用于刷免费额度 |
| **Cookie 是凭据** | `h3v/h3s` 等同账号密码 | 仅存本地 `data/profiles`，`cookies.json` 已列入 `.gitignore`；不写日志、不外发 |
| **人机验证** | 触发后必须真人过 Turnstile | 不做绕过；服务只负责「打开验证页 + 检测通过 + 自动重试」 |
| **内容审核** | 成片带 `moderation` 字段；失败任务不消耗额度？未验证 | 失败任务在本地标 `failed` 并保留原因，不自动重试（避免计费不确定） |
| **接口稳定性** | `model_v` 是协议版本号，升级后旧值可能被拒 | 提交体集中在 `buildVideoPayload()`，改一处即可 |

---

## 5 · 待决策 / 余留

| 项 | 现状 | 需要决定 |
|----|------|----------|
| 参考图上传 | 前端用 data URL（>2 MB 走 XHR 进度），本地服务已透传 `reference_images` 但**未实测大于阈值的行为** | 是否需要本地上传压缩 + 分片 |
| 图像 / 音频 / 画布 | 端点已识别（`/v1/objects/generations`、`/v1/audio/generations`、`/v1/workbench/*`），未接入 | 是否按同一车道扩三个面板 |
| 免费队列等待 | 已做自适应同步（有在途 20s / 空闲 45s）+ 界面显示队列位次 | 是否需要「出片后系统通知」 |
| 上游无额度查询口 | `prices.trial` 实测为空，拿不到「剩余次数」 | 只能本地账本 + 当日条数校准；若上游改口径需重测 |
| 多账号真机验证 | 本沙箱只能跑通 `EgoLane`（单账号）；`ChromeLane` 每账号独立 profile 需在本机终端验证 | 需要一次真机多账号联调 |
| 排队加速 | 存在 `jump`/`tier` 档位 | 是否开放付费档按钮（会产生真实费用） |
| 成本闸门 | 目前不限制模型 | 是否需要「非免费模型需二次确认」的硬开关 |

---

## 6 · 原始数据索引

`.analysis/raw/` 下均为**实测抓取**（Cookie 值已脱敏，文件权限 600）：

| 文件 | 内容 |
|------|------|
| `models.json` | `/v1/models` 完整响应（8 模型 × 能力矩阵，25 KB） |
| `videos.json` | `/v1/videos?limit=3` 响应（含队列水位与成片 CDN 结构） |
| `single.json` | 单任务响应（34 字段全量） |
| `featured-shots.json` / `assist-models.json` | 灵感池 / 助手模型 |
| `app-0530866e16fe.js` | 主 bundle 2.9 MB（提交体、幂等、挑战重试均出自此文件） |
| `app-a9962238ed68.js` | 附属 bundle 68 KB |
| `fresh.js` / `fresh.html` | 人机验证页与换 Cookie 逻辑 |
| `cookies.json` | 登录态（`h3v/h3s/__Host-h3d`），**仅本地** |
| `submit.json` / `submit-resp.json` | 提交体样例与 403 响应（证明写侧拦截） |

复现要点：任何「curl 能写」的结论都必须重测 —— 本次同 Cookie 三路对照中，只有浏览器内 `fetch` 通过。
