# web-free-studio · 本机视频生成工作台

把 **两个免费上游** 的视频生成能力落到本机：`www.paba.tv`（账号池）与 `veda.hanxiao.run`（免账号）。
统一任务库、统一资产归档、统一工作台。

> 逆向分析与接口证据见 [`.analysis/REA-REPORT.md`](./.analysis/REA-REPORT.md)（Paba）与 [`.analysis/REA-VEDA.md`](./.analysis/REA-VEDA.md)（Veda）。
> 本项目**不复制上游任何代码与界面**，只是「自己账号/设备的本地客户端 + 产物归档器」。

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

## 第二个上游 · Veda Studio（免账号）

工作台左上「来源」切到 **Veda Studio · 免账号** 即可用。它是 Veda 稀疏注意力 + MiniMax-H3 的研究预览（单机 2×RTX 4090），**不需要登录**，纯 HTTP 通道，不用开浏览器。

| 能力 | 说明 |
|------|------|
| **免账号** | 身份 = 服务端下发的 `veda_did` + `X-Device-Id`，落在 `data/veda.device.json`（0600） |
| **三段式 prompt 自动补全** | 上游强制 `integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:`；只写一句中文描述也行，缺的字段按默认补 |
| **额度双闸** | 20 credits/天（5s=1 / 10s=2 / 15s=3，**按出口网络计**）+ 同网络 30 条/天，提交前现拉 `/api/quota` 拦 |
| **在途闸** | 默认最多 4 条（上游 2 个 GPU 槽位，超出排队不拒绝，但会一起变慢） |
| **产物回本地** | `data/assets/<日期>/veda-<jobId>.mp4`，工作台内直接播 |
| **前进式同步** | 上游**没有列表接口**，只能靠本地存的 `job_id` 跟进；历史无法回溯 |

| 参数 | 值 |
|------|-----|
| 时长 | 5s / 10s / 15s（1 / 2 / 3 credit） |
| 画幅 | 16:9（1344×768）、9:16（768×1344）、4:3（1024×768）、1:1（768×768） |
| prompt | ≥32 字符，raw 上限 8000；`enhance` 模式走上游扩写，上限 2000 |
| 实测耗时 | 5s/9:16 = 排队 ~3 分钟 + 生成 ~2.7 分钟 ≈ **5 分 44 秒** |
| 参考图 | 上游当前 `refs.enabled=false`，只能文生视频（带声） |

> **额度是按出口 IP 计的**，不是按设备：换 cookie / 换设备 id 实测都不刷新额度（见 REA-VEDA.md §4）。
> 本项目**不做**代理池轮换、设备指纹伪造这类绕过，只在上游给的额度内排队使用。

---

## 为什么 Paba 必须走浏览器通道

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

## 新增账号（界面顶栏「＋ 新增账号」）

| 方式 | 需要 Chrome？ | 做法 |
|------|---------------|------|
| **粘贴 Cookie** | ❌ 不需要 | 填备注 + 粘贴 `h3v / h3s / __Host-h3d` 三条 cookie → 立即校验 `/auth/me` 并接管 |
| **邮箱密码** | ❌ 不需要 | 填邮箱 + 密码，服务在浏览器环境里调 `/auth/account/login` 换会话，成功后自动存 cookie |
| **浏览器登录** | ✅ 需要 | 弹出 Chrome 走 Google / 邮箱验证码；Chrome 起不来时会自动切到 Cookie 页 |
| **接管 ego 会话** | ❌ 不需要 | 直接接管 ego 浏览器当前已登录的会话 |

> **多账号怎么共存**：每个账号一份独立 cookie 罐（`data/accounts/<id>.cookies.json`，权限 0600）。
> 每次调用前通过 CDP `Network.setCookie` 把该账号的 cookie 注入浏览器、用完保持隔离，
> 所以**一个浏览器就能托管多个账号**，不再需要「一个账号一个 profile」。
> 账号密码（可选）同样只落本地 `data/accounts/<id>.cred.json`（0600）。

每条账号右侧都有 **编辑**：改备注 / 换执行后端 / 重新粘贴 Cookie / 用密码重登 / 停用。

### 账号数与吞吐的关系

| 账号数 | 每日免费次数 | 最大在途/并发 |
|--------|--------------|---------------|
| 1 | 15 | 2 |
| 2 | 30 | 4 |
| N | N×15 | N×2 |

单账号被上游硬限制在「每天 15 次、最多 2 条在途」，所以**加账号是唯一能扩额度与并发的方式**；但多开账号若只是为了叠加免费额度，大概率违反其条款（见 `.analysis/REA-REPORT.md` 合规一节）。


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

### Veda 专用接口

```bash
curl -s --noproxy '*' http://localhost:8790/api/veda/state             # 额度 + 能力 + 排队

# 提交（prompt 只写一句中文也行，服务自动补三段式）
curl -s --noproxy '*' -X POST http://localhost:8790/api/veda/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"少女立于朱红门廊前，晨雾缓缓漂过红柱","duration":5,"aspect":"9:16"}'

curl -s --noproxy '*' -X POST http://localhost:8790/api/veda/sync      # 对账 + 镜像产物
curl -s --noproxy '*' -X POST http://localhost:8790/api/veda/jobs/<jobId>/cancel
```

> 本机 `http_proxy` 会干扰 `curl 127.0.0.1`，加 `--noproxy '*'` 或用 `localhost`。

---

## 本地目录

```
data/
├─ db.json                       # accounts / tasks / usage / log（原子写）
├─ veda.device.json              # Veda 设备态（cookie + device id，0600）
├─ profiles/<accountId>/         # 每账号独立 Chrome profile
└─ assets/<YYYY-MM-DD>/
   ├─ <taskId>.mp4               # 成片（paba）
   ├─ veda-<jobId>.mp4           # 成片（veda）
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
| Cookie 粘贴后提示无效 | cookie 过期或 `h3v` 缺失；重新登录后复制完整三条 |
| 同一个浏览器里两个账号串号 | 不会：每次调用前按账号注入 cookie；若仍异常，编辑账号重新粘贴一次 |
| 免费任务长时间「排队」 | 正常（免费档 10–40 分钟），服务会自动同步并落盘 |
| 成片显示「待镜像」很久 | 免费档 CDN 偶尔只有几 KB/s，镜像已改为**后台队列**（不阻塞同步）；失败 3 次后 30 分钟内不再重试 |
| 启动报「端口已被占用」 | 本地库是多进程共享文件，**只能跑一个实例**；先停旧实例再启动 |
| 无头下验证过不去 | 人机验证需可见窗口，`challenge` 会自动切有头模式 |
| Chrome 起不来 | 设 `CHROME_PATH`，或 `LANE=ego` 改用 ego 浏览器 |
| Veda：`quota_exhausted`（429） | 今日 20 credit 用完，按 `resets_at` 等（+24h 滚动窗口）。额度按出口 IP 计，换设备/清 cookie 都无效 |
| Veda：`quota_network`（429） | 同一网络今天已提交 30 条，触及上游网络上限，等重置 |
| Veda：`invalid_prompt` | 上游要求三段式。正常提交不会遇到（服务自动补），只有手写 `raw` 又漏字段才会 |
| Veda：画面描述太短 | ≥32 字符（按你写的原文算，不是补全后的） |
| Veda：`challenge_required` | 上游开了 Turnstile，纯 HTTP 通道不可用，需等其关闭或改走浏览器通道 |
| Veda：偶发 `连不上 Veda: UND_ERR_CONNECT_TIMEOUT` | Cloudflare 各节点质量不均；GET 已自动退避重试 3 次，持续失败看本机网络/代理 |
