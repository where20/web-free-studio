/**
 * Veda Studio 适配器（veda.hanxiao.run）
 *
 * 与 PabaTV 的根本差异：这里没有账号，也没有 TLS 指纹拦截。
 *   · 身份 = X-Device-Id 头 + veda_did Cookie（服务端下发，带签名段，不要自己造）
 *   · 额度 = /api/quota 实时读数；实测按「出口网络」计，本地不做 credits 猜账
 *   · 通道 = 纯 Node fetch 即可，不需要浏览器（Turnstile 一旦上线会返回 403，届时降级）
 *
 * 设计原则：把「上游事实」和「本地账本」分开。
 *   上游事实（额度/排队/槽位）一律现拉；本地只记「我今天提交了几条、还有几条在途」。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ASSET_DIR, VEDA } from "../config.mjs";

const deviceFile = path.join(DATA_DIR, "veda.device.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export class VedaError extends Error {
  constructor(message, { code = "error", status = 0, body = null } = {}) {
    super(message);
    this.name = "VedaError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** 设备态：只存服务端给的 cookie 与 device id，不伪造任何标识 */
let jar = null;
let jarLoading = null;

async function loadJar() {
  if (jar) return jar;
  if (jarLoading) return jarLoading;
  jarLoading = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(deviceFile, "utf8"));
      jar = { deviceId: raw.deviceId || null, cookie: raw.cookie || null };
    } catch {
      jar = { deviceId: null, cookie: null };
    }
    return jar;
  })();
  return jarLoading;
}

async function saveJar() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(deviceFile, JSON.stringify(jar, null, 1), { mode: 0o600 });
}

function absorb(res) {
  let changed = false;
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith("veda_did=")) {
      const next = c.split(";")[0];
      if (jar.cookie !== next) {
        jar.cookie = next;
        changed = true;
      }
    }
  }
  const did = res.headers.get("x-device-id");
  if (did && jar.deviceId !== did) {
    jar.deviceId = did;
    changed = true;
  }
  return changed;
}

/** 统一请求：自动带设备态、自动吸收服务端下发的设备态 */
async function call(pathname, { method = "GET", body = null, timeoutMs = 30_000 } = {}) {
  const state = await loadJar();
  const headers = {
    "user-agent": UA,
    accept: "application/json",
    origin: VEDA.origin,
    referer: VEDA.origin + "/",
  };
  if (state.cookie) headers.cookie = state.cookie;
  if (state.deviceId) headers["x-device-id"] = state.deviceId;
  if (body) headers["content-type"] = "application/json";

  // 只对 GET 重试：POST 一旦发出去就可能已扣额度，重试会有重复扣费风险
  const attempts = method === "GET" ? 3 : 1;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(VEDA.origin + pathname, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = new VedaError(`连不上 Veda：${e.cause?.code || e.message}`, { code: "network" });
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 600 * i));
        continue;
      }
      throw lastErr;
    }

    if (absorb(res)) await saveJar().catch(() => {});

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }

    if (!res.ok) {
      const code = data?.error || `http_${res.status}`;
      const msg = data?.message || `上游返回 ${res.status}`;
      const err = new VedaError(msg, { code, status: res.status, body: data });
      // 5xx 是上游抖动，GET 可以再试；4xx 是确定性拒绝，直接抛
      if (res.status >= 500 && i < attempts) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 600 * i));
        continue;
      }
      throw err;
    }
    return data;
  }
  throw lastErr || new VedaError("上游请求失败", { code: "network" });
}

/** 首次调用时让服务端下发设备标识（不消耗额度） */
export async function ensureDevice() {
  const state = await loadJar();
  if (state.cookie && state.deviceId) return state;
  await call("/api/quota");
  return jar;
}

export function vedaConfig() {
  return call("/api/config");
}

export function vedaQuota() {
  return call("/api/quota");
}

export function vedaHealth() {
  return call("/api/health");
}

/**
 * 上游要求 prompt 必须是三段式（缺字段直接 400 invalid_prompt）：
 *   integrated_multimodal_description: [Shot 1] …
 *   overall_soundscape: …
 *   non_diegetic_music: …
 * 这里只做「缺什么补什么」的规范化，不替用户改写画面描述。
 */
const REQUIRED_FIELDS = [
  "integrated_multimodal_description:",
  "overall_soundscape:",
  "non_diegetic_music:",
];

export function normalizePrompt(input, { soundscape = "", music = "" } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return raw;
  const missing = REQUIRED_FIELDS.filter((f) => !raw.includes(f));
  if (!missing.length) return raw;

  const desc = raw.includes("integrated_multimodal_description:")
    ? raw
    : `integrated_multimodal_description: [Shot 1] ${raw}`;
  const lines = [desc];
  if (!raw.includes("overall_soundscape:")) {
    lines.push(`overall_soundscape: ${soundscape || "Natural ambience that matches the scene, close to the subject."}`);
  }
  if (!raw.includes("non_diegetic_music:")) {
    lines.push(`non_diegetic_music: ${music || "A soft sustained pad at a slow tempo, fading out before the last frame."}`);
  }
  return lines.join("\n\n");
}

/** 提交一个任务，返回上游 job 快照（含 job_id / quota） */
export async function vedaSubmit(input) {
  const cfg = await vedaConfig();
  const raw = String(input.prompt || "").trim();
  // 校验必须打在「用户原文」上：先补三段式再校验等于把下限作废
  // （踩过：prompt="hi" 被包装成 200+ 字符后直接提交成功，白扣 1 credit）
  if (raw.length < (cfg.min_prompt_chars || 32)) {
    throw new VedaError(
      `画面描述太短：${raw.length} 字符，至少要 ${cfg.min_prompt_chars || 32} 个字符才能生成`,
      { code: "validation" },
    );
  }
  const prompt = normalizePrompt(input.prompt, input);
  const duration = Number(input.duration || 5);
  const aspect = String(input.aspect || input.aspectRatio || "16:9");
  const allowedDur = (cfg.durations || []).map((d) => d.value);
  const allowedAspect = (cfg.aspects || []).map((a) => a.value);

  if (!allowedDur.includes(duration)) {
    throw new VedaError(`时长只支持 ${allowedDur.join(" / ")} 秒`, { code: "validation" });
  }
  if (!allowedAspect.includes(aspect)) {
    throw new VedaError(`画幅只支持 ${allowedAspect.join(" / ")}`, { code: "validation" });
  }
  const maxChars = cfg.max_prompt_chars?.[input.mode === "enhance" ? "enhance" : "raw"] || 8000;
  if (prompt.length > maxChars) {
    throw new VedaError(`prompt 超过 ${maxChars} 字符上限（当前 ${prompt.length}）`, { code: "validation" });
  }
  if (cfg.turnstile_site_key) {
    throw new VedaError("上游已启用 Turnstile 人机验证，纯 HTTP 通道不可用，需要浏览器通道", {
      code: "challenge_required",
    });
  }

  const payload = {
    prompt,
    mode: input.mode === "enhance" ? "enhance" : "raw",
    duration,
    aspect,
  };
  if (Number.isFinite(Number(input.seed))) payload.seed = Number(input.seed);

  const out = await call("/api/jobs", { method: "POST", body: payload, timeoutMs: 45_000 });
  return { ...out, _payload: payload, _cfg: cfg };
}

export function vedaJob(jobId) {
  return call(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function vedaCancel(jobId) {
  return call(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** 上游 created_at 是 ISO 字符串（实测 "2026-11-16T09:21:06Z"），也兼容秒级时间戳 */
function toMs(v) {
  if (!v) return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const ASPECT_PX = {
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1024, 768],
  "1:1": [768, 768],
};

/** 把上游 job 快照映射成本地任务行（字段名对齐 paba 那套，前端不用改渲染） */
export function toTaskRow(job) {
  const p = job.progress || {};
  const aspect = job.aspect || null;
  const px = ASPECT_PX[aspect] || [];
  return {
    provider: "veda",
    upstreamId: job.job_id,
    status: job.status,
    stage: p.stage || job.stage || null,
    queuePosition: job.queue?.position ?? job.queue_position ?? null,
    queueEtaSeconds: p.eta_s ?? job.eta_s ?? null,
    queueSeconds: job.timings?.queue ?? null,
    step: p.step ?? null,
    stepsTotal: p.total ?? null,
    progress: p.fraction ?? null,
    duration: job.duration ?? null,
    aspectRatio: aspect,
    resolution: px.length ? `${px[0]}x${px[1]}` : null,
    width: px[0] ?? null,
    height: px[1] ?? null,
    seed: job.seed ?? null,
    gpu: job.gpu ?? null,
    moderation: job.moderation ?? null,
    upstreamCreatedAt: toMs(job.created_at),
    startedAt: toMs(job.started_at),
    finishedAt: toMs(job.finished_at),
    error: job.error ? (typeof job.error === "string" ? job.error : JSON.stringify(job.error)) : null,
  };
}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

/** 上游产物地址（形态已知：见 REA-VEDA.md §2.7） */
export function pickVideoUrl(job) {
  const cand = [
    job?.video_url,
    job?.videoUrl,
    job?.video?.url,
    job?.video,
    job?.output?.url,
    job?.result?.url,
    job?.url,
  ].find((v) => typeof v === "string" && v.length);
  if (!cand) return null;
  if (/^https?:\/\//.test(cand)) return cand;
  return VEDA.origin + (cand.startsWith("/") ? cand : `/${cand}`);
}

/** 下载产物到 data/assets/<日期>/veda-<jobId>.mp4 */
export async function mirrorVeda(jobId, url) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ASSET_DIR, day);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `veda-${jobId}.mp4`);

  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "video/mp4,*/*", referer: VEDA.origin + "/" },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new VedaError(`产物下载失败 ${res.status}`, { code: "mirror_failed", status: res.status });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new VedaError(`产物异常（${buf.length}B）`, { code: "mirror_failed" });
  await fs.writeFile(file, buf);
  return { file, bytes: buf.length, rel: `${day}/veda-${jobId}.mp4` };
}
