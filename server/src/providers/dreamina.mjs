/**
 * 即梦 Dreamina 上游适配器（agent 短剧会话通道）。
 *
 * 与 PabaTV 的 /v1/videos 完全不同：即梦生成走 agent 对话，
 * 由 LLM 调 sandbox_generate_video 工具产出视频。全链路（2026-11-25 抓包确认）：
 *   1) POST agent/submit_run        提交用户消息 → 拿 run_id
 *   2) POST agent/get_thread        轮询 run.state（2=生成中 / 3=完成）
 *   3) POST asset/query_artifact    artifact_id → 视频直链 / 元数据
 *   4) GET  视频直链（系统代理 + 浏览器 UA）→ 落盘
 *
 * 全部请求在 ego 浏览器页面内用 fetch 发出（credentials:include + appid header），
 * 浏览器 SDK 自动补 msToken / X-Bogus 等签名，服务端不伪造身份/不换出口 IP/不刷额度。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DREAMINA, ASSET_DIR, providerConfig } from "../config.mjs";

export class DreaminaError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.code = extra.code || "dreamina_error";
    Object.assign(this, extra);
  }
}

/** 上游通用返回 {ret, errmsg, data}：ret!=='0' 即失败 */
function unwrap(json, ctx) {
  if (!json || typeof json !== "object") throw new DreaminaError(`${ctx}：响应为空`, { code: "bad_response" });
  if (json.ret !== undefined && String(json.ret) !== "0") {
    const code = /credit|quota|点数|余额/i.test(json.errmsg || "") ? "quota_exhausted" : "upstream_error";
    throw new DreaminaError(`${ctx}：${json.errmsg || "上游返回错误"}`, { code, ret: json.ret });
  }
  return json.data;
}

/**
 * 生成一段页内 fetch 表达式（给 lane.exec 用）。
 * 即梦接口在 mweb-api-sg.capcut.com，需带 appid header + credentials。
 */
export function jsFetchExpr(url, { method = "POST", body = null, headers = {} } = {}) {
  const opts = {
    method,
    headers: { Accept: "application/json", appid: DREAMINA.appId, ...headers },
    credentials: "include",
    cache: "no-store",
  };
  if (body !== null && body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return `(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(${JSON.stringify(url)}, { ...${JSON.stringify(opts)}, signal: ctl.signal });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text: text.length > 20000 ? text.slice(0, 20000) : text };
    } catch (e) {
      return { status: 0, json: null, text: String(e && e.message || e), aborted: true };
    } finally { clearTimeout(timer); }
  })()`;
}

/** 规范化 prompt：即梦 agent 通道把整段 prompt 交给 LLM 生成分镜 */
export function normalizePrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) throw new DreaminaError("prompt 不能为空", { code: "validation" });
  if (prompt.length > 3000) throw new DreaminaError("prompt 超过 3000 字", { code: "validation" });
  return prompt;
}

/** 规范化时长（即梦 agent 常见 5/10/15s） */
export function normalizeDuration(v) {
  const n = Number(v || 10);
  if (!Number.isFinite(n) || n < 4 || n > 20) {
    throw new DreaminaError("时长需在 4-20 秒之间", { code: "validation" });
  }
  return n;
}

/**
 * 构造 submit_run 请求（对标抓到的真实 body）。
 * session 参数来自 DREAMINA 配置（projectId/threadId/workspaceId）。
 */
export function buildSubmitRequest(input, session = {}) {
  const prompt = normalizePrompt(input.prompt);
  const duration = normalizeDuration(input.duration);
  const aspect = String(input.aspect || "16:9");
  const resolution = String(input.resolution || "1080P");

  const projectId = String(session.projectId || DREAMINA.projectId);
  const threadId = String(session.threadId || DREAMINA.threadId);
  const workspaceId = String(session.workspaceId || DREAMINA.workspaceId);
  const consumerUid = String(session.consumerUid || "");
  const runId = randomUUID();
  const messageId = randomUUID();

  // prompt 前缀带上规格（即梦 agent 靠自然语言理解，与抓到的样本一致）
  const finalPrompt = `使用seedance2.5,生成${duration}秒视频，${aspect}，${resolution}。${prompt}`;

  const babiParam = {
    generate_id: runId,
    user_message_id: messageId,
    section_id: runId,
    scene_lv1: "ai_agent",
    scene_lv2: "conversation",
    tool_id: "novel_agent",
    tab_name: "script_outline",
    enter_from: "novel_page_agent_create",
    edit_type: "novel",
  };

  const runExtra = {
    novel_ui_context: {
      version: 1,
      items: [
        {
          type: "project-settings",
          data: {
            projectId,
            ratio: aspect,
            resolution: resolution.toLowerCase(),
            videoModel: { key: "Seedance_2.5", name: "Dreamina Seedance 2.5" },
          },
        },
      ],
      v: 1,
      surface: "script",
    },
    novel_script_model_key: "GPT-6.1-Sol",
    babi_param: babiParam,
    client_extra: {
      url_path: "/novel/detail/script",
      generate_position: "in_agent_chat",
      edit_type: "novel",
      tab_name: "script_outline",
      placement_name: "novel",
      entrance_from: "novel_page_agent_create",
      stage: "script",
      is_user_prompt: 1,
    },
  };

  const body = {
    message: {
      role: "user",
      content: [
        { type: "text", data: finalPrompt, sub_type: "plain/text" },
        { type: "data", data: "{}", sub_type: "biz/general_agent_settings" },
      ],
      thread_id: threadId,
      run_id: runId,
      message_id: messageId,
      created_at: Date.now(),
    },
    agent_name: DREAMINA.agentName,
    project_id: Number(projectId),
    user_info: consumerUid
      ? { consumer_uid: consumerUid, workspace_id: workspaceId }
      : { workspace_id: workspaceId },
    entrance_from: "novel_page_agent_create",
    run_extra: JSON.stringify(runExtra),
    request_id: messageId,
    submit_type: 0,
  };

  const url = `${DREAMINA.apiBase}${DREAMINA.paths.submit}?babi_param=${encodeURIComponent(JSON.stringify(babiParam))}`;
  return { url, body, runId, messageId, prompt: finalPrompt, duration, aspect, resolution };
}

/** 从 lane.api 返回的 payload 中取 data，统一错误 */
function dataFrom(payload, ctx) {
  if (!payload || typeof payload.status !== "number") throw new DreaminaError(`${ctx}：响应异常`, { code: "bad_response" });
  if (payload.status === 0) throw new DreaminaError(`${ctx}：请求超时`, { code: "timeout" });
  if (payload.status >= 400) throw new DreaminaError(`${ctx}：HTTP ${payload.status}`, { code: "upstream_error", status: payload.status });
  return unwrap(payload.json, ctx);
}

/** 提交生成：返回 runId。lane 由调用方传入（ego lane 页内 fetch） */
export async function submitRun(lane, input, session = {}) {
  const req = buildSubmitRequest(input, session);
  const expr = jsFetchExpr(req.url, { method: "POST", body: req.body });
  const payload = await lane.exec(expr, 90_000);
  const data = dataFrom(payload, "提交生成");
  const run = data?.run || data;
  const runId = run?.run_id || req.runId;
  if (!runId) throw new DreaminaError("提交成功但没有 run_id", { code: "bad_response" });
  return { ...req, upstreamId: runId, raw: run };
}

/** 查会话状态：返回 run 列表（含 state / entry_list） */
export async function getThread(lane, threadId = DREAMINA.threadId) {
  const url = `${DREAMINA.apiBase}${DREAMINA.paths.thread}`;
  const body = { limit: 10, scopes: ["run_list.entry_list"], thread_id: threadId };
  const payload = await lane.exec(jsFetchExpr(url, { method: "POST", body }), 90_000);
  const data = dataFrom(payload, "查询会话");
  return data?.thread || {};
}

/** 在 thread 里找指定 run 的状态与 artifact_id */
export function findRun(thread, runId) {
  const runs = Array.isArray(thread?.run_list) ? thread.run_list : [];
  const run = runs.find((r) => r.run_id === runId) || runs[runs.length - 1];
  if (!run) return null;
  const entries = Array.isArray(run.entry_list) ? run.entry_list : [];
  let artifactId = null;
  let errorText = null;
  for (const e of entries) {
    for (const c of e?.message?.content || []) {
      if (c.sub_type === "biz/x_artifact_slots_part") {
        try {
          const slots = JSON.parse(c.data || "{}").slots || [];
          const video = slots.find((s) => s.type === "video");
          if (video) artifactId = String(video.artifact_id);
        } catch {}
      }
      if (e?.message?.role === "assistant" && c.type === "text" && /失败|error|can't|unable/i.test(c.data || "")) {
        errorText = String(c.data).slice(0, 300);
      }
    }
  }
  // run.state: 1=排队 2=生成中 3=完成 9=需要用户补充信息(问答终态)
  const state = run.state;
  // 找 agent 的反问文本（state=9 时没有视频产物）
  let question = null;
  if (state === 9) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const c = (entries[i]?.message?.content || []).find((x) => x.type === "text");
      if (c?.data) { question = String(c.data).slice(0, 500); break; }
    }
  }
  return {
    runId: run.run_id,
    state,
    status:
      state === 3 ? "done"
        : state === 9 ? "needs_input"
          : /fail|cancel/i.test(run.fail_reason || "") ? "failed"
            : "running",
    artifactId,
    failReason: run.fail_reason || errorText,
    question,
    completedAt: run.completed_at ? Number(run.completed_at) * 1000 : null,
    createdAt: run.created_at ? Number(run.created_at) * 1000 : null,
    entries: entries.length,
  };
}

/** 用 artifact_id 查视频直链与元数据 */
export async function queryArtifact(lane, artifactId) {
  const url = `${DREAMINA.apiBase}${DREAMINA.paths.queryArtifact}`;
  const body = { artifact_id: [String(artifactId)] };
  const payload = await lane.exec(jsFetchExpr(url, { method: "POST", body }), 90_000);
  const data = dataFrom(payload, "查询产物");
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] || {};
  let video = null;
  for (const c of row.content || []) {
    if (c.sub_type === "biz/x_data_video") {
      try {
        const parsed = JSON.parse(c.data || "{}");
        video = parsed.video || parsed;
        break;
      } catch {}
    }
  }
  if (!video || !video.url) throw new DreaminaError("产物里没有视频直链", { code: "bad_response" });
  return {
    artifactId: String(row.artifact_id || artifactId),
    assetId: video.asset_id,
    url: video.url,
    coverUrl: video.cover_url || null,
    renderTaskId: video.render_task_id || null,
    metadata: video.metadata || {},
  };
}

/** 任务行归一化（统一任务库字段） */
const STATE_LABEL = { 1: "排队", 2: "生成中", 3: "已完成", 9: "待补充信息" };

export function toTaskRow(snap) {
  return {
    status: snap.status || "running",
    stage: snap.state != null ? (STATE_LABEL[snap.state] || `state_${snap.state}`) : null,
    artifactId: snap.artifactId || null,
    failReason: snap.failReason || null,
    question: snap.question || null,
    upstreamCreatedAt: snap.createdAt || null,
    finishedAt: snap.completedAt || null,
    error: snap.failReason || null,
  };
}

export function isTerminal(status) {
  // needs_input 是终态：agent 在反问用户，不会再自己产出视频，停止轮询
  return ["done", "failed", "cancelled", "needs_input"].includes(status);
}

/** 下载视频直链：系统代理 + 浏览器 UA（直连/--noproxy 实测不通） */
export async function mirrorDreamina(upstreamId, art) {
  const { spawnSync } = await import("node:child_process");
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ASSET_DIR, day);
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `dreamina-${upstreamId}.mp4`);
  const rel = path.join(day, `dreamina-${upstreamId}.mp4`);

  const existed = await fs.stat(out).catch(() => null);
  if (existed && existed.size > 0) return { file: out, rel, bytes: existed.size };

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:6696";
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156 Safari/537.36";
  const tmp = `${out}.part`;
  const r = spawnSync("curl", [
    "-s", "-L", "-x", proxy, "-A", ua,
    art.url, "-o", tmp, "--max-time", "300", "-w", "%{http_code}",
  ], { encoding: "utf8", timeout: 310_000 });
  const code = String(r.stdout || "").trim();
  const st = await fs.stat(tmp).catch(() => null);
  if (code !== "200" || !st || st.size === 0) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new DreaminaError(`视频下载失败（HTTP ${code}）`, { code: "download_failed" });
  }
  await fs.rename(tmp, out);
  return { file: out, rel, bytes: st.size };
}

export { DREAMINA };
