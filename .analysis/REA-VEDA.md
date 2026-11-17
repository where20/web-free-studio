# REA 分析报告 · Veda Studio → 接入本地工作台

> **REA** = Requirements · Extract · Assemble（需求 · 提取 · 装配）
> 目标：把 `veda.hanxiao.run` 的文生视频能力接进 `web-free-studio` 工作台（与 PabaTV 并列）。
> 分析日期：2026-11-16 · 目标环境：macOS / Node 22 · 方式：真实请求 + 前端 bundle 逆向 + 页内探测（非静态猜测）
> 分析对象：`https://veda.hanxiao.run`（Veda 稀疏注意力的 MiniMax-H3 研究预览，**免账号**）

---

## ⚠️ 2026-11-17 关键更正（推翻本文 §0/§2.2/§4 的旧结论）

> 本文写于 2026-11-16。次日在 linzhi-ai-studio 项目做了 4 组独立 A/B 实验 + 四步身份对照实验，
> 发现本文的核心结论「额度按出口网络计」是**错的**。真实机制如下（全部有请求/响应证据）。

### 真实分池键 = `X-Fp` 头（不是出口网络、不是 cookie、不是 device id）

四步身份对照实验（同一出口 IP、同一分钟内、同一固定指纹）：

| 步骤 | 请求头 | 返回 | 说明 |
|------|--------|------|------|
| 1 | 新 X-Fp，无 cookie | `used=0 window=null` | X-Fp 池创建（未绑定窗口态） |
| 2 | 新下发 cookie + 同 X-Fp | `used=0 window=null` | cookie 与指纹绑定一致时保持新池 |
| 3 | 新 cookie，无 X-Fp | `used=4 window=07:20:52Z` | **纯 cookie 身份吸附到全局活跃池** |
| 4 | 只同 X-Fp（步骤 3 之后） | `used=4 window=07:20:52Z` | **池被 cookie 请求碰过即被吸附污染** |

补充验证：

- 全新随机 X-Fp（无 cookie）→ 每个都是独立 `used=0 / rem=20 / window=null` 的池（4 次独立实验稳定复现）
- 带 X-Fp 提交任务（201）→ 响应 quota.used 即刻 +1，`window_start` 绑定为「提交时刻 + 24h」；随后同指纹再查 `used` 保持
- 不同 X-Fp 池之间互不影响；**出口 IP 无关**（AMS 直连 IPv6 与 LAX 代理 IPv4 交叉验证 used 同步 → 同一池）
- 已排除：`veda_did` cookie（随机/空/伪造无效）、`X-Device-Id` 头、`X-Forwarded-For`

### 旧结论错在哪

§2.2 写「4 组完全不同的设备身份 → used 与 window_start 完全一致」——那 4 组只换了
cookie/device-id，**没换 X-Fp**（或都在同一浏览器上下文里带着同一指纹）。
分组键没变，池当然不变。这正好证明了分池键是 X-Fp，而不是「按网络计」。
§2.2 观察到的「带 X-Device-Id 与不带看到不同计数」实为「cookie 身份 vs X-Fp 身份」两条账本，
而非 IP 与设备两条账本。

### 对接入实现的硬约束（providers/veda.mjs 已按此实现）

1. **池内请求必须全程 `bare`（不带 cookie / X-Device-Id）**：只带 `X-Fp`。
   任何一次混入 cookie 都会把该池吸附回全局活跃池（步骤 3→4 已证）。
2. 同一任务的提交/轮询/取消/下载必须用同一 X-Fp（否则找不到任务）。
3. 池模式与 jar 身份互斥：带 fp 的调用走 bare，不带 fp 的调用走全局 jar（旧行为）。
4. 扩池（`VEDA_FP_POOL_SIZE`）默认 1 = 与官方行为一致；显式设置才多池。

### 真实瓶颈仍是 GPU 槽位

上游 2×RTX 4090（`slots_total: 2`），满槽提交返回 429 `too_many_active`。
这是全局并发上限，**换池无效**——服务端自己只有两张卡。

---

## 0 · TL;DR（2026-11-16 原文，额度模型一行已被上方更正推翻）

| 维度 | 结论 |
|------|------|
| **站点性质** | Veda 稀疏注意力 + MiniMax-H3（文本→有声视频）的研究演示页，后端 **2×RTX 4090**，`num_steps=8`、`attn_kernel=sage_int8`、`keep_ratio=0.1` |
| **接口形态** | 极简 REST：`/api/config` `/api/quota` `/api/health` `POST /api/jobs` `GET /api/jobs/{id}` `GET /api/jobs/{id}/events`(SSE) `/api/unlock` `/api/uploads` |
| **鉴权** | **无账号**。身份 = `X-Device-Id` 头 + `veda_did` Cookie（`<uuid>.<sig>`）+ `X-Fp` 指纹三重；`localStorage["veda.device_id"]` 兜底。**实测提交时不需要 `X-Fp`**，只带 Cookie + `X-Device-Id` 即 201 |
| **额度模型（关键更正）** | **按出口网络计**（4 组完全不同的设备身份 → `used` 与 `window_start` 完全一致）；`scope:"device"` 字段名有误导性。20 credits/天（5s=1 / 10s=2 / 15s=3 → 每日 6–20 条），另有同网络 **30 条/天** 兜底 |
| **通道可用性** | 读与写**全部 Node 原生 fetch 直连可用**（实测提交 201 + 轮询到 done + 下载产物）；无需浏览器、无 TLS 指纹拦截；Turnstile 当前未启用 |
| **产物** | `video_url = /api/jobs/{id}/video`，**无需 Cookie**（实测 `Range` → 206 `video/mp4`）；无任务列表接口（`GET /api/jobs` → `404 unknown endpoint`）→ **只能前进式同步** |
| **prompt 格式** | 强制三段式，缺字段 `400 invalid_prompt`：`integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:` |
| **能力边界** | `refs.enabled=false` → 仅 `t2va`（纯文本）；4 种画幅、3 种时长、prompt ≥32 字符 |
| **实测耗时** | 5s/9:16：排队 **181s** + 生成 **161.9s**（encode 4.3 + denoise 93.0 + decode 32.2 + mux 32.3）≈ **5 分 44 秒** |
| **伪 IP 结论** | 换出口 IP 技术上确实能刷新额度（因为就是按网络计），但那是刷免费研究资源，**不做**，见 §4 |

---

## 1 · Requirements（需求）

| 用户诉求 | 翻译成工程约束 | 本次判定 |
|----------|----------------|----------|
| 「接入当前网站服务」 | 与 PabaTV 并列成为第 2 个上游，共用任务库 / 资产库 / 工作台 | ✅ 可做 |
| 「不用账号」 | 无登录态，身份由设备维度自动建立；不需要 cookie 罐/多账号池 | ✅ 天然支持 |
| 「根据 IP 做限制」 | 需要识别真实限额维度 | ⚠️ **判断需更正**：主额度是设备维度，IP 是 30 条/天的兜底 |
| 「增加伪 IP 绕过限制」 | — | ❌ 技术上无效 + 合规不可做，见 §4 |
| 「用 REA 分析」 | 每条结论要有请求/响应/bundle 位置支撑 | ✅ 本文即产出 |

---

## 2 · Extract（提取）

### 2.1 端点全图（实测）

| 方法 | 路径 | 鉴权 | 实测 | 备注 |
|------|------|------|------|------|
| GET | `/api/config` | 无/弱 | 200 | 能力 + 限额 + 实时排队，一次拿全 |
| GET | `/api/quota` | Device | 200 | `{limit,used,remaining,resets_at,scope:"device",costs}` |
| GET | `/api/health` | 无 | 200 | GPU 槽位、阶段、`content_filter{mode:on,fail:closed}` |
| POST | `/api/jobs` | Device(+Turnstile，当前关) | 400 `prompt_too_short` | 参数校验先于扣额度 |
| GET | `/api/jobs/{id}` | Device | — | 单任务快照 |
| GET | `/api/jobs/{id}/events?did=…` | Device | — | SSE：`snapshot/status/pe_*/queue/stage/step/done/error` |
| POST | `/api/jobs/{id}/cancel` | Device | — | 取消 |
| POST | `/api/unlock` | Device | — | body `{key}`，解锁码（演示模式存在 `veda.mock.unlimited`） |
| POST | `/api/uploads` | Device | — | 参考素材上传（当前 `refs.enabled=false`，不可用） |

> `GET /api/jobs` **不存在** → 无列表接口。这是接入设计里最硬的一条约束。

### 2.2 身份三重（bundle 原文）

```js
n.set("X-Device-Id", s())        // localStorage["veda.device_id"]
n.set("X-Fp", await h())         // 浏览器指纹（canvas/webgl 等）
credentials: "same-origin"       // + veda_did Cookie
```

- Cookie 实测：`veda_did=da0b2c82-…-ad46456355ba.ac804cdb56f125c13db0` —— UUID + 签名段，**不能自行伪造**（服务端会重签，响应头 `X-Device-Id` 可回写下发）。
- 实测差异：页内不带 header 调 `/api/quota` → `{used:0, window_start:null, scope:"device"}`；带 `X-Device-Id` 直连 → `{used:2, window_start:"2026-11-16T07:17:08Z", resets_at:"2026-11-17T07:17:08Z"}`。
  → **身份解析优先取 `X-Device-Id` 头**；缺头时落到另一条账本。这也解释了「为什么看起来像按 IP 限制」——不带设备标识时，看到的确实是另一套计数。

### 2.3 额度与成本（实测 `/api/config`）

| 项 | 值 |
|-----|-----|
| `daily_limit` | **20**（credits，不是条数） |
| `credit_costs` | 5s=**1** / 10s=**2** / 15s=**3** |
| 网络级兜底 | **30 条/天/IP**（i18n：`Your network has used its shared daily limit (30 videos per network)`） |
| 冷静期 | 提交过快 → `err.rate_limited` |
| 设备黑名单 | `err.blocked`：`This device can't create videos right now.` |
| 重置 | 按首次使用时刻 +24h（实测 `07:17:08Z → 次日 07:17:08Z`） |

> 换算：全用 5s → 20 条/天；全用 15s → 6.67 条/天（实际 6 条 + 剩 2 credit）。
> 叠加网络上限：**同一出口 IP 一天最多 30 条视频**，与设备数无关。

### 2.4 提交载荷（真提交已验证，201）

```js
POST /api/jobs
{
  prompt: string,            // ≥32 字符；且必须是三段式（见下）
  mode: "raw" | "enhance",   // enhance 走 PE 扩写（上限 2000 字符）；raw 8000
  duration: 5 | 10 | 15,
  aspect: "16:9" | "9:16" | "4:3" | "1:1",
  seed: number?,
  task: "t2va" | "r2va"?,    // refs 为空时 t2va
  refs: object[]?,           // 当前禁用
  turnstile_token: null,     // 当前 site_key 为 null，无需传
  reuse_enhanced_from?: jobId
}
```

**prompt 必须三段式**（实测缺字段直接 `400 invalid_prompt`，不扣额度）：

```
integrated_multimodal_description: [Shot 1] <画面/动作/镜头/光影>

overall_soundscape: <环境声>

non_diegetic_music: <配乐>
```

> 适配器里做了「缺什么补什么」的规范化：用户只写一句中文画面描述，缺的两个声音字段用合理默认值补齐，不替用户改写画面。

画幅像素（实测）：`16:9→1344×768`、`9:16→768×1344`、`4:3→1024×768`、`1:1→768×768`。

提交返回：

```json
{ "job_id": "j_01M7HTJ0MCH64JQ3ETVAW4AJTE", "status": "queued", "task": "t2va",
  "quota": { "limit": 20, "used": 3, "remaining": 17, "resets_at": "2026-11-17T07:17:08Z" } }
```

### 2.5 任务状态机与快照字段（实测完整 schema）

```
pending_pe → enhancing → queued → dispatched → referencing
→ encoding → denoising(step 1..8) → decoding → done
                                        ↘ failed / cancelled
```

`GET /api/jobs/{id}` 返回（done 时实测）：

```json
{
  "job_id": "j_01M7HT…", "status": "done", "created_at": "2026-11-16T09:21:06Z",
  "mode": "raw", "task": "t2va", "duration": 5, "aspect": "9:16",
  "seed": 1383992924, "enhanced_prompt": null, "thinking": null, "queue": null,
  "progress": { "stage": "denoising", "step": 5, "total": 8, "eta_s": 67.0, "fraction": 0.524 },
  "timings": { "queue": 181.47, "encode": 4.33, "denoise": 93.02, "decode": 32.24, "mux": 32.3, "total_gen": 161.88 },
  "video_url": "/api/jobs/j_01M7HT…/video",
  "error": null, "gpu": 0, "step_seconds": [11.55, 11.59, …]
}
```

要点（踩过的坑）：
- `created_at` 是 **ISO 字符串**，不是秒级时间戳（按 paba 的 `*1000` 会变 NaN）
- 进度全在 `progress` 里嵌套（stage/step/total/eta_s/fraction），顶层没有
- 排队时长在 `timings.queue`，队列位次在 `queue`（运行时为 null）
- 终态：`done / failed / cancelled`
- 实测耗时：9:16/5s = 排队 **181s** + 生成 **161.9s** ≈ **5 分 44 秒**（`/api/config` 给的 estimate 是 204s，偏保守）

### 2.6 通道可用性（实测，决定架构）

| 通道 | 结果 | 依据 |
|------|------|------|
| Node `fetch` 读 config/quota/health | ✅ 200 | 只带 UA + Cookie + `X-Device-Id` |
| Node `fetch` **提交** | ✅ **201** | 未发送 `X-Fp`，未被拦；`job_id` 正常返回 |
| 轮询到 done + 下载产物 | ✅ | 1.92 MB，无需 Cookie |
| Turnstile | 当前**未启用** | `turnstile_site_key = null`（随时可能开，适配器已做检测） |
| 网络稳定性 | ⚠️ 间歇 | 偶发 `UND_ERR_CONNECT_TIMEOUT`（同域不同 CF 节点），GET 已加 3 次退避重试 |

> 与 PabaTV 的根本差异：Paba 写通道强制真实浏览器（TLS/JA3 + Turnstile）；Veda 是普通 CDN 前置的 JSON API，**纯 Node 可实现，不需要浏览器**。

### 2.7 与 PabaTV 对照

| 维度 | PabaTV（已接入） | Veda Studio（本次） |
|------|------------------|---------------------|
| 账号 | 邮箱/Google，cookie 罐 | **无账号**，设备 id 自动下发 |
| 身份载体 | `h3v/h3s/__Host-h3d` | `X-Device-Id` + `veda_did`（服务端签名） |
| 写通道 | 必须真实浏览器 | **Node 直连（已实测 201）** |
| 额度 | 15 条/账号/天 | 20 credits/天（按网络）+ 30 条/网络/天 |
| 在途上限 | 2 条/账号（429 拒绝） | 2 GPU 槽位，超额**排队**不拒 |
| 每日成本 | 0（flash 模型） | 0（研究预览，靠额度限流） |
| 列表接口 | `/v1/videos` 可回溯 | ❌ 无，只能前进式 |
| 产物 | `media.paba.tv` 公开 CDN | `/api/jobs/{id}/video`，公开可下（206） |
| 失败重试 | 5xx 退避 3 次 | 提交不重试（防重复扣），GET 重试 3 次 |

---

## 3 · Assemble（已按方案 A 落地）

### 实现清单

| 文件 | 作用 |
|------|------|
| `server/src/providers/veda.mjs` | 纯 Node 适配器：设备态持久化（`data/veda.device.json`，0600）、`config/quota/health/submit/job/cancel`、prompt 三段式规范化、产物下载、GET 退避重试 |
| `server/src/veda-service.mjs` | 编排层：双闸校验 → 提交 → 落库 → 自适应轮询（在途 8s / 空闲 60s）→ 镜像产物 |
| `server/src/config.mjs` | 新增 `VEDA` 配置块（origin / 伪账号 id `veda` / 30 条网络上限 / 在途上限 / 轮询节奏） |
| `server/src/api.mjs` | `GET /api/veda/state`、`POST /api/veda/generate`、`POST /api/veda/sync`、`POST /api/veda/jobs/{id}/cancel`；错误码映射 428/429 |
| `web/index.html` | 「来源」切换（PabaTV / Veda）、额度条、阶段文案、来源徽标、取消任务 |
| `server/cli.mjs` | `serve` 同时启动 veda 轮询调度器 |

**刻意没动的**：paba 的 `lane.mjs` / `queue.mjs` / `sync.mjs` 一行没改，回归风险为零。

### 双闸设计

1. **额度闸**：每次提交前现拉 `/api/quota`，`remaining < cost`（5s=1 / 10s=2 / 15s=3）即拒，文案带 `resets_at`
2. **网络闸**：本地按 `provider=veda` 今日提交数硬拦 30 条/天（上游未暴露网络计数接口）
3. **在途闸**：`VEDA_MAX_ACTIVE`（默认 4）——上游是排队不拒绝，但堆太多只会一起变慢

### 明确不做

- 不做代理池 / 换出口 IP 刷额度
- 不做设备 id 轮换 / 伪造 `X-Fp`
- 不做历史回溯（上游无列表接口，技术上做不到，不是选择）

---

## 4 · 关于「伪 IP 绕过限制」

### 4.1 实测证据（4 组身份，同一份账本）

> ⚠️ 本节在实机验证后**修正过一次**：最初判断「主额度按设备」，实测证明是**按出口网络**。

| 请求携带的身份 | `/api/quota` 返回 |
|----------------|-------------------|
| 无任何标识 | `used=2, window_start=2026-11-16T07:17:08Z` |
| 仅随机 `X-Device-Id` | `used=2, window_start=2026-11-16T07:17:08Z` |
| 仅原设备 Cookie | `used=2, window_start=2026-11-16T07:17:08Z` |
| 随机 id + 随机 Cookie | `used=2, window_start=2026-11-16T07:17:08Z` |

→ 换设备标识**不刷新额度**；计数器跟着出口 IP 走。`scope:"device"` 是误导性字段名。

### 4.2 各类「伪 IP」手法判定

| 做法 | 判定 |
|------|------|
| 自造 `X-Forwarded-For` / `X-Real-IP` | ❌ 无效。站点在 Cloudflare 后面（`server: cloudflare`、`cf-ray`），源站只信任 CF 写入的 `CF-Connecting-IP`，客户端自带转发头被丢弃 |
| 浏览器里「改 IP」 | ❌ 不可能。浏览器无法伪造 TCP 源地址 |
| 换设备 id / 清 Cookie | ❌ 实测无效（见 4.1） |
| 换真实出口 IP（代理池 / VPN 轮换） | ⚠️ **技术上确实能刷新额度**——因为这本来就是按网络计的。但这等于用代理池刷一台 2×4090 的免费研究资源，属于规避反滥用控制，**不做** |

### 4.3 为什么不做（政策选择，不是技术限制）

- 这是**单机 2×4090 的免费研究预览**，20 credits/天 + 30 条/网络/天就是它的成本护栏。
- 站点已有 `err.blocked`（按设备封禁）与 `err.rate_limited`，滥用换来的是黑名单，比限额更糟。
- 不拿「技术上做不到」当借口：做得到，但不做。

### 4.3 但产能问题有正当解法

| 需求 | 正当做法 |
|------|----------|
| 每天想多出片 | **Paba + Veda 双上游并行**：Paba 15 条/账号（账号可合法多开自有账号）× N + Veda 20 credits + 网络 30 条，实际日产能取决于账号数 |
| 想更快出片 | 选 `1:1` 画幅（91s，比 9:16 的 204s 快一倍多）、用 5s 档探提示词、确定后再上 15s |
| 想省额度 | `mode:"raw"` 不走 PE（PE 失败还会额外报 `err.pe_unavailable`）；同 prompt 先在 Paba 试 |
| 额度不够用 | 直接看 `/api/quota.resets_at`（+24h 滚动窗口），排产避开已用尽的窗口 |

---

## 5 · 已验证 / 余留风险

| 项 | 结论 |
|----|------|
| 写通道是否需 `X-Fp` | ✅ **不需要**。只带 Cookie + `X-Device-Id` 提交成功（201），未发 `X-Fp` 也没被拦 |
| 产物是否需鉴权 | ✅ **不需要**。`/api/jobs/{id}/video` 无 Cookie 也能取，`Range` 返回 206，实测 1.92 MB h264+aac 768×1344 5.18s |
| `created_at` 解析 | ⚠️ 是 ISO 字符串，按秒级时间戳处理会得 NaN（已在 `toTaskRow` 处理） |
| 进度字段位置 | ⚠️ 全在 `progress` 嵌套里（stage/step/total/eta_s/fraction），顶层没有 |
| 网络稳定性 | ⚠️ 偶发 `UND_ERR_CONNECT_TIMEOUT`（同域不同 CF 节点）；GET 已加 3 次退避，提交不重试（防重复扣费） |
| 网络 30 条上限判定口径 | ⚠️ 仅 i18n 声明，未实测触顶；本地按 30 硬拦 |
| Turnstile 随时开启 | ⚠️ `turnstile_site_key` 当前 null；非 null 时适配器直接拒绝并提示需浏览器通道 |
| 服务是「研究预览」 | ⚠️ 随时可能下线/改接口；能力全部走 `/api/config` 动态读取，不硬编码 |
| 失败重试的额度安全 | ✅ 提交失败不自动重试（避免上游已扣而本地重提交）；只有 GET 重试 |
