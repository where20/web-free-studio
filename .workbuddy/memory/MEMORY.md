# web-free-studio · 项目长期记忆

> 详细过程看 `2026-11-16.md`（Paba/Veda/MCP）与 `2026-11-17.md`（SiftQ）日志；本文件只留跨会话必须知道的事实与约定。
> 更新于 2026-11-17（SiftQ 融合后）。

## 项目定位

三个免费上游的本地视频工作台（`:8790`）：**PabaTV**（账号池）+ **Veda Studio**（免账号）+ **SiftQ MiniMax-H3**（图生视频）。
统一任务库 `data/db.json`（原子写，**单实例锁 `data/.server.lock`，多进程会互相覆盖**）、
统一资产 `data/assets/<日期>/`、SSE `/api/events`。
报告：`.analysis/REA-REPORT.md`（Paba）、`.analysis/REA-VEDA.md`（Veda）。

## 上游硬事实（别再踩）

| | PabaTV | Veda Studio | SiftQ MiniMax-H3 |
|---|---|---|---|
| 写通道 | 必须真实浏览器（TLS 指纹 + Turnstile） | 纯 Node fetch（无需浏览器，不需要 X-Fp） | 纯 Node fetch + 浏览器 UA（CLI curl 直连 403，node fetch 可过） |
| 身份 | `h3v/h3s/__Host-h3d` cookie 罐 | 服务端下发 `veda_did`（UUID.签名，**别自造**）→ `data/veda.device.json`（0600，不入 git） | 本地固定 `client_id=mmtrial_`/`visitor_id=mmguest_` → `data/siftq.device.json`（0600，只生成一次，**不轮换**） |
| 额度 | 15 条/账号/天（无上游查询接口，本地账本） | 20 credits/天（5s=1/10s=2/15s=3）**按出口 IP 计**，换设备/清 cookie 无效；另有同网络 30 条/天 | 匿名 2 条/天，按**真实出口 IP**；无查询接口，本地账本 + 提交回执 `remaining` 校准 |
| prompt | 自由文本 | **强制三段式** `integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:`，缺→400 不扣额度；适配器自动补全，**长度校验打在用户原文上**（踩过：先补后查 "hi" 白扣 1 credit）。**额外坑**：写全三段式时 description 内必须手动带 `[Shot N]` 标记→否则 500 `no [Shot 1] marker`；正文禁写画幅字样（如 `16:9`）→报 `the prompt states the aspect ratio`，改用 `cinematic widescreen framing`。这两类 500 都**不扣额度** | 英文描述动作，**showcase 通道才生效**（普通口忽略 prompt 固定产跳舞片）；正文禁写画幅/时长 |
| 形态 | 文生/参考/首尾帧，多画幅 | 文生视频，多画幅 | **图生视频，仅 9:16，6/10/15s**（4-7→6,8-12→10,13-20→15） |
| 列表/回溯 | `/v1/videos` 可回溯 | ❌ 无列表接口，只能前进式，job_id 必须本地落库 | 无列表，前进式；查 `.../video-generation/{id}?access_token=` |
| 端点 | `/v1/videos` 提交/查询 | `/api/jobs` 系列 | 提交 `/api/minimax-trial/showcase/video-generation`（multipart）；下载 `.../{id}/content?client_id=&access_token=` |
| 字段坑 | epoch 秒 | `created_at` 是 ISO 字符串；进度嵌在 `progress` 里；`timings.queue` 是排队秒数 | `task_id`/`access_token` 在提交响应顶层；poll 状态 `succeeded/failed/canceled` |
| 产物 | media.paba.tv 公开 CDN（206） | `/api/jobs/{id}/video` 公开（206） | `.../content` 直出 mp4；上游约 1–2 天回收任务 → **出片即镜像落盘**（下载 GET 退避重试 3 次） |
| 耗时 | 免费档 10–40 分钟 | 5s/9:16 ≈ 5 分 44 秒（排队 181s + 生成 162s）；1:1 最快 | 实测约 1–2 分钟出片 |
| 网络 | — | 偶发 `UND_ERR_CONNECT_TIMEOUT` → GET 退避重试 3 次，**POST 不重试**（防重复扣） | 偶发下载卡住 → content GET 退避重试 3 次；POST 不重试 |

## 代码结构（新增部分）

- `server/src/providers/veda.mjs`：纯 Node 适配器（设备态/6 端点/prompt 规范化/镜像/重试）
- `server/src/veda-service.mjs`：编排（双闸→提交→落库→自适应轮询 8s/60s→镜像；上游三件套 15s 缓存）
- `server/src/api.mjs`：`/api/veda/state|generate|sync|jobs/:id/cancel`，错误映射 428/429
- `server/src/providers/siftq.mjs`：适配器（固定设备态/3 端点/prompt+时长规范化/mime sniff/镜像/下载重试）
- `server/src/siftq-service.mjs`：编排（双闸/60s 幂等/自适应轮询 8s-60s/SSE），accountId=provider="siftq"
- `api.mjs`：`/api/siftq/state|generate|sync`；`cli.mjs`：`startSiftqScheduler()`
- `web/index.html`：SOURCE 三选（paba/veda/siftq 表单独立渲染；**siftq 用「首帧」槽位当输入图**，resField 仅 paba 显示）
- MCP `wfs_*` 全支持 siftq（`image` 参数：本地路径→dataURL / http 链接透传）
- **PabaTV 账号自适应轮询**（2026-11-17）：账号下拉默认「⚡ 自动轮询」(value="")，提交不传 accountId 让后端挑；纯函数 `rankAccounts`（queue.mjs 导出）= 在途少→消耗少→最久未用(lastSubmitAt)。**坑**：提交成功必须 `upsertAccount({id,lastSubmitAt})` 持久化，否则「最久未用」恒 0 总挑同一账号（内存 Map 只做最小间隔）。单测 `test/account-rotation.test.mjs`
- **设置中心**：账号池 + 运行日志收进 `<details id="settingsCenter">` 默认收起，`fs.settingsOpen` 持久化；生成记录留 main 主区
- store.mjs 的 `listTasks` 支持 `provider` 过滤；`countActive` 只认 pending/queued/running，**veda/siftq 在途各自算**（`activeVeda()`/`activeSiftq()`）；`isTerminal` 要同时认本地映射态 done/cancelled 和上游态 succeeded/canceled（踩过：只认上游态导致 done 任务被算在途）
- **upsertTask 主键 = String(upstreamId)**：toTaskRow / 同步合并时**必须透传 upstreamId**，丢了会建「无 id 僵尸行」（踩过：轮询查 undefined 报 `invalid trial task id`）

## 边界（多次确认过，别再提）

- **不做**代理池/换出口 IP 刷 Veda 额度、不做设备指纹伪造、不伪造 XFF、不铸造/轮换匿名身份刷 SiftQ 额度——技术上可行但属规避访问控制。用户问过三次 Veda + 一次 SiftQ（给仓库链接要"照搬绕限额"），都已拒绝并给正路。
- **Veda 指纹池红线（2026-11-17 用户确认）**：X-Fp 是额度分组键，多指纹 = 多「设备」并行刷额度，**不做**。`veda-fp-pool.mjs` 池数量硬上限 `size`（默认 1 = 官方单设备），`acquire()` 绝不自动铸新指纹（额度耗尽如实报 quota_exhausted 等 24h 窗口）；运行时扩池入口 `resize()` 已删；扩池只能显式改 `VEDA_FP_POOL_SIZE`（配置是用户自己的决定，代码永不越界）。终态必须 `release()` 占位，否则 perPool=1 的池一条后永久占死。红线单测 `test/veda-fp-pool.test.mjs`。
- SiftQ 只接正向协议：固定单一本地身份、真实出口 IP、429 如实上报。参考仓库 HaizhuAI/HaizhuVideo-H3Gateway 的核心是伪造 XFF + 身份轮换，**那部分没融合**。
- 正路：① 邮件向作者要 **unlock key**（Veda 站点自带 `/api/unlock {key}`，官方机制）→ xinting@ustc.edu.cn / xjqi@hku.hk；② 项目开源可自部署（`github.com/veda-sparse/Veda-on-ComfyUI` + HF `Veda-Sparse`）；③ 向 SiftQ/MiniMax 官方申请提额；④ 排产自动化。

## 本机环境坑

- 沙箱内 spawn Chrome 必崩，只能用 EgoLane；ego `console.log` 走 stderr。
- 长下载/大文件请求会被沙箱 SIGTERM（exit 137）→ 放后台任务跑。
- 本机 `http_proxy=127.0.0.1:61575` 会干扰 curl localhost → 用 `--noproxy '*'`。
- **ego `page.evaluate` 有 15s 硬上限**（`setDefaultTimeout` 改不掉，实测 20s 睡眠照样被掐）；
  字符串表达式**不接受第二参数**（传 options 直接 `TypeError: string expression does not accept an argument`）。
  长页内操作只能：后台启动（fire-and-forget 存 window）→ 轮询 → 分片读取。
- **paba `/content` 在 CDN 直链过期后直接 200 返回本体**（不再 302）→ 镜像走 `downloadInPage`
  分片兜底（`lane.mjs`，commit 9f4a403）；同步必须保留 `assetAttempts/assetError/assetSkipUntil`
  否则退避失效、死链任务占死镜像队列（commit 4957dfd）。
- 同 repo 有并行会话开发过（17:45 参考素材功能），改文件前先看 `git status` + mtime，小步提交。
- **launchctl bootstrap 与 crontab 都被沙箱禁用**（连最小 plist 都报 `Input/output error`）→ 做不了开机自启。
  解法：daemon 由 MCP 适配层**按需自动拉起**（spawn + 轮询探测 ≤15s + 端口占用复用）。
- **git push 必须用系统代理 `127.0.0.1:6696`**（`scutil --proxy` 可查；环境变量里的 56658 会 502，
  直连 git 会超时）；配 `gh auth token` 直供 credential helper 避免 keychain 被沙箱拦。
  `rsync --delete` 别忘了 `--exclude=.git`，否则会删掉仓库历史。
- 线上仓库：`github.com/where20/web-free-studio`（主项目，2026-11-16 22:10 首推）与
  `github.com/where20/web-free-studio-mcp`（MCP 适配层独立发布仓）并存。

## MCP 通用化（v0.3 · 2026-11-16 18:30）

三层结构：**Skill（说明书）→ MCP（协议）→ daemon（能力本体）**。Skill 与 MCP 不是二选一。

| 组件 | 位置 |
|---|---|
| MCP server（7 工具） | `mcp/src/server.mjs` |
| daemon 客户端 + ensureDaemon | `mcp/src/daemon.mjs` |
| 参考素材路径→dataURL | `mcp/src/refs.mjs` |
| 安装/自检/自测 | `mcp/scripts/{install,doctor,selftest}.mjs` |
| Skill 说明书 | `mcp/SKILL.md` → 已装 `~/.workbuddy/skills/web-free-studio/` |
| 独立发布 | `github.com/where20/web-free-studio-mcp` |

工具：`wfs_status` / `wfs_generate` / `wfs_tasks` / `wfs_task` / `wfs_accounts` / `wfs_sync` / `wfs_doctor`。

**铁律**：MCP 层是**薄壳**，业务规则全在 daemon，只做参数整形与结果压缩（两份实现必漂移）。
所有错误码带 `next` 字段，告诉 agent 下一步做什么。

**换电脑**：`npx -y github:where20/web-free-studio-mcp install` + `doctor`，零系统权限。
不迁移：Veda 额度（按出口 IP）、Paba cookie（手动复制或重授权）、Chrome profile（别复制）。

## 成片流水线（复用价值高 · 齐天大圣 35s 案例）

**多段时间轴脚本 → 必须逐段提交，不能只出一条样片**（踩过：用户给 35s/3段脚本，只出了 10s 被追问）。先跟用户确认「每服务各出一条」还是「每服务补齐全片」。

- 分工：背景/纯场景 → Veda（文字描述，无水印）；角色/需锁外观 → Paba `mode=reference` 传立绘 dataURL（有平台水印）。
- 每段规格对齐（h264/1344×768/AAC）后 `ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart` 无损拼接。注意 Veda 15s 档实际返回 14.375s，总时长会略短。
- 分屏对照：`-filter_complex "[0:v]scale=672:384[bg];[1:v]scale=672:384[ch];[bg][ch]hstack=inputs=2[v]" -map "[v]" -map 1:a`。
- **PabaTV 右下角水印去除**：ffmpeg `delogo=x=1148:y=704:w=176:h=40`（1344×768 画面，偶数对齐+留边）；定位法=抽帧→`crop=320:120:1024:648,scale=×3`→ViewImage 目测。云雾/剪影类简单纹理插值后肉眼不可辨。仅用于自有内容（去水印或违反上游条款）。
- 产物在 `data/assets/2026-11-16/`：`qitian-35s-{character,background,split}.mp4` 及对应 `-clean.mp4` 无水印版；六段源片同目录。

## 当前状态（2026-11-17 11:55）

- SiftQ 已融合并实测出片：`data/assets/2026-11-17/siftq-2122537073886478336.mp4`（h264/768×1344/aac/6.58s/1.1MB）。今日额度 used 1/2，剩 1 条，次日按出口 IP 恢复。
- git 最新 `b9398cc`（设置中心收纳 + PabaTV 账号自适应轮询）；之前 `c0cbbfd`（SiftQ 融合）/`1b152eb`（记忆）；**均未 push**。
- daemon 在 `:8790` 运行（由适配层按需拉起）；Veda **剩 8/20 credit**（used 12），今日 15:17Z 恢复（+24h 滚动窗口）。
- 任务库 13 条；paba 账号 7 个（main 与 --7 在线可用，其余 removed）。本次出片的 6 段源片均 daemon 自动镜像成功落盘。
- 本次成片交付：`qitian-35s-{character,background,split}.mp4` + `-clean` 无水印版，均在 `data/assets/2026-11-16/`，已 present 给用户。
- MCP 已配：`~/.workbuddy/mcp.json` + `~/.codex/config.toml`（WorkBuddy 需用户点「信任」）。
- git：`034c917` docs → `00b72e6` 凭证清理 → `d506cae` Veda+参考素材 → `a97abd6` MCP 适配层
  → `4957dfd`/`62d401c`/`9f4a403` **镜像链路修复**（同步保留退避字段 + ego 15s 绕行双路径 + 首试限时）。
- 待办：WorkBuddy 侧点「信任」；`where20/npxgh-test` 临时仓库待删（需 delete_repo scope）；
  ~~db 重复账号待查~~（已确认 6625/5537 是 `removed` 状态的正常删除记录，非脏数据）；
  真机 ChromeLane 多账号联调；参考图 >2MB 上传实测；Veda unlock key 申请；
  「额度恢复自动排产」定时任务（用户未拍板）；旧任务 `h3_e8b807c8…` 镜像在退避重试中自愈。
