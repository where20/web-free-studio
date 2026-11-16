# web-free-studio · 项目长期记忆

> 详细过程看 `2026-11-16.md` 日志；本文件只留跨会话必须知道的事实与约定。
> 更新于 2026-11-16 晚（Veda 接入完成版）。

## 项目定位

两个免费上游的本地视频工作台（`:8790`）：**PabaTV**（账号池）+ **Veda Studio**（免账号）。
统一任务库 `data/db.json`（原子写，**单实例锁 `data/.server.lock`，多进程会互相覆盖**）、
统一资产 `data/assets/<日期>/`、SSE `/api/events`。
报告：`.analysis/REA-REPORT.md`（Paba）、`.analysis/REA-VEDA.md`（Veda）。

## 上游硬事实（别再踩）

| | PabaTV | Veda Studio |
|---|---|---|
| 写通道 | 必须真实浏览器（TLS 指纹 + Turnstile） | **纯 Node fetch 即可**（实测 201，不需要 X-Fp） |
| 身份 | `h3v/h3s/__Host-h3d` cookie 罐 | 服务端下发 `veda_did`（UUID.签名，**别自造**）→ `data/veda.device.json`（0600，不入 git） |
| 额度 | 15 条/账号/天（无上游查询接口，本地账本） | 20 credits/天（5s=1/10s=2/15s=3）**按出口 IP 计**，换设备/清 cookie 无效；另有同网络 30 条/天 |
| prompt | 自由文本 | **强制三段式** `integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:`，缺→400 不扣额度；适配器自动补全，**长度校验必须打在用户原文上**（踩过：先补后查导致 "hi" 白扣 1 credit） |
| 列表/回溯 | `/v1/videos` 可回溯 | ❌ 无列表接口，只能前进式，job_id 必须本地落库 |
| 产物 | media.paba.tv 公开 CDN | `/api/jobs/{id}/video` 公开（206 Range） |
| 字段坑 | epoch 秒 | `created_at` 是 ISO 字符串；进度嵌在 `progress` 里；`timings.queue` 是排队秒数 |
| 耗时 | 免费档 10–40 分钟 | 5s/9:16 ≈ 5 分 44 秒（排队 181s + 生成 162s）；1:1 最快 |
| 网络 | — | 偶发 `UND_ERR_CONNECT_TIMEOUT`（CF 节点质量不均）→ GET 退避重试 3 次，**POST 不重试**（防重复扣） |

## 代码结构（新增部分）

- `server/src/providers/veda.mjs`：纯 Node 适配器（设备态/6 端点/prompt 规范化/镜像/重试）
- `server/src/veda-service.mjs`：编排（双闸→提交→落库→自适应轮询 8s/60s→镜像；上游三件套 15s 缓存）
- `server/src/api.mjs`：`/api/veda/state|generate|sync|jobs/:id/cancel`，错误映射 428/429
- `web/index.html`：SOURCE 切换（paba/veda 表单独立渲染；resField 仅 paba 显示）
- store.mjs 的 `listTasks` 支持 `provider` 过滤；`countActive` 只认 pending/queued/running，**veda 在途要自己算**（`activeVeda()`，含 denoising 等细分阶段）

## 边界（多次确认过，别再提）

- **不做**代理池/换出口 IP 刷 Veda 额度、不做设备指纹伪造——技术上可行但属规避访问控制。用户问过三次，已拒绝并给正路。
- 正路：① 邮件向作者要 **unlock key**（站点自带 `/api/unlock {key}`，是官方机制）→ xinting@ustc.edu.cn / xjqi@hku.hk；② 项目开源可自部署（`github.com/veda-sparse/Veda-on-ComfyUI` + HF `Veda-Sparse`）；③ 排产自动化。

## 本机环境坑

- 沙箱内 spawn Chrome 必崩，只能用 EgoLane；ego `console.log` 走 stderr。
- 长下载/大文件请求会被沙箱 SIGTERM（exit 137）→ 放后台任务跑。
- 本机 `http_proxy=127.0.0.1:61575` 会干扰 curl localhost → 用 `--noproxy '*'`。
- 同 repo 有并行会话开发过（17:45 参考素材功能），改文件前先看 `git status` + mtime，小步提交。
- **launchctl bootstrap 与 crontab 都被沙箱禁用**（连最小 plist 都报 `Input/output error`）→ 做不了开机自启。
  解法：daemon 由 MCP 适配层**按需自动拉起**（spawn + 轮询探测 ≤15s + 端口占用复用）。
- **git push 必须走代理**（直连超时），但代理偶发 `Empty reply from server` → 重试即可。
  `rsync --delete` 别忘了 `--exclude=.git`，否则会删掉仓库历史。

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

## 当前状态（2026-11-16 18:30）

- daemon 在 `:8790` 运行（由适配层按需拉起）；Veda 剩 15/20 credit，明日 15:17 恢复（+24h 滚动窗口）。
- 7 个 paba 账号、7 条任务（含本次 MCP 验证提交的 veda 任务 `j_01M7HYD7HTDP3X2S05SEY8DTW0`）。
- MCP 已配：`~/.workbuddy/mcp.json` + `~/.codex/config.toml`（WorkBuddy 需用户点「信任」）。
- git：`034c917` docs → `00b72e6` 凭证清理 → `d506cae` Veda+参考素材 → `a97abd6` **MCP 适配层**。
- 待办：WorkBuddy 侧点「信任」；`where20/npxgh-test` 临时仓库待删（需 delete_repo scope）；
  db.json 里 `6625`/`5537` 疑似重复账号记录待查；真机 ChromeLane 多账号联调；
  参考图 >2MB 上传实测；Veda unlock key 申请；「额度恢复自动排产」定时任务（用户未拍板）。
