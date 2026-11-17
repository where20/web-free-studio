/**
 * Veda Studio 适配器（veda.hanxiao.run）
 *
 * 与 PabaTV 的根本差异：这里没有账号，也没有 TLS 指纹拦截。
 *   · 身份 = X-Fp 头（额度分组键，见 veda-fp-pool.mjs）+ X-Device-Id 头 + veda_did Cookie（辅助）
 *   · 额度 = /api/quota 实时读数，按 X-Fp 指纹分池，每池 20 credits/天（本地不做 credits 猜账）
 *   · 通道 = 纯 Node fetch 即可，不需要浏览器（Turnstile 一旦上线会返回 403，届时降级）
 *
 * 设计原则：把「上游事实」和「本地账本」分开。
 *   上游事实（额度/排队/槽位）一律现拉；本地只记「我今天提交了几条、还有几条在途」。
 *
 * 2026-11-17 更正（推翻 2026-11-16 的「按出口网络计」结论）：
 *   额度真正按 X-Fp 分池。旧实验「4 组不同设备身份 used 一致」是因为只换了
 *   cookie/device-id、没换 X-Fp —— 分组键没变，池当然不变。出口 IP 无关。
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

/**
 * 统一请求：自动带设备态、自动吸收服务端下发的设备态。
 *
 * 身份优先级（2026-11-17 四步对照实验实测）：
 *   veda_did Cookie > X-Fp > 无身份默认池。
 *   · 带 cookie（无论新旧）→ 吸附到 cookie 身份的池（今天实测 used=4 全局池）
 *   · 只带 X-Fp（无 cookie）→ X-Fp 对应的独立池
 *   · ⚠️ 池一旦被「cookie 请求」碰过就会被吸附污染 —— 池内请求必须全程 bare（不带 cookie/deviceId）。
 *
 * @param {object} opts
 * @param {string|null} opts.fp   X-Fp 指纹（额度分组键，见 veda-fp-pool.mjs）
 * @param {boolean}     opts.bare 不带 cookie/deviceId（池模式必开，防止池被旧 cookie 吸附）
 */
async function call(pathname, { method = "GET", body = null, timeoutMs = 30_000, fp = null, bare = false } = {}) {
  const state = bare ? null : await loadJar();
  const headers = {
    "user-agent": UA,
    accept: "application/json",
    origin: VEDA.origin,
    referer: VEDA.origin + "/",
  };
  if (state?.cookie) headers.cookie = state.cookie;
  if (state?.deviceId) headers["x-device-id"] = state.deviceId;
  // X-Fp 是额度分组键：只在无 cookie 时生效（见上方优先级说明）
  if (fp) headers["x-fp"] = fp;
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

    // bare 模式不吸收设备态：池专属的 cookie 存进全局 jar 反而会污染其他池
    if (!bare && absorb(res)) await saveJar().catch(() => {});

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

/** 读某指纹池的额度；带 fp = 走该池（bare 无 cookie）；不带 = 全局 jar 身份 */
export function vedaQuota(fp = null) {
  return fp
    ? call("/api/quota", { fp, bare: true })
    : call("/api/quota");
}

export function vedaHealth() {
  return call("/api/health");
}

/**
 * 上游要求 prompt 必须是三段式（缺字段直接 400 invalid_prompt）：
 *   integrated_multimodal_description: [Shot 1] …
 *   overall_soundscape: …
 *   non_diegetic_music: …
 * 且 description 段内必须带 [Shot N] 标记（否则 500 `no [Shot 1] marker`，不扣额度）。
 * 这里只做「缺什么补什么」的规范化，不替用户改写画面描述。
 */
const REQUIRED_FIELDS = [
  "integrated_multimodal_description:",
  "overall_soundscape:",
  "non_diegetic_music:",
];
const DESC_FIELD = "integrated_multimodal_description:";
/** 任意 Shot 标记都算数：[Shot 1]、[Shot 2]… 都满足上游的格式要求 */
const SHOT_MARKER_RE = /\[Shot\s+\d+\]/i;

/**
 * 保证 description 段内含 [Shot N]，没有就在字段名后补 [Shot 1]。
 * 幂等：已有任意 [Shot N] 时原样返回，不重复插入。
 */
function ensureShotMarker(text) {
  if (!text.includes(DESC_FIELD)) return text;
  if (SHOT_MARKER_RE.test(text)) return text;
  return text.replace(DESC_FIELD, `${DESC_FIELD} [Shot 1]`);
}

export function normalizePrompt(input, { soundscape = "", music = "" } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return raw;
  const missing = REQUIRED_FIELDS.filter((f) => !raw.includes(f));
  // 三段式齐全也要过 ensureShotMarker：这是踩过的坑——用户自己写全三段式，
  // 但 description 里没写 [Shot 1]，daemon 旧逻辑直接 return raw，上游 500。
  if (!missing.length) return ensureShotMarker(raw);

  const desc = raw.includes(DESC_FIELD)
    ? raw
    : `${DESC_FIELD} [Shot 1] ${raw}`;
  const lines = [ensureShotMarker(desc)];
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

  // fp = 本任务绑定的指纹池（提交/轮询/下载全程沿用，bare 无 cookie，见 veda-fp-pool.mjs）
  const bare = Boolean(input.fp);
  const out = await call("/api/jobs", { method: "POST", body: payload, timeoutMs: 45_000, fp: input.fp || null, bare });
  return { ...out, _payload: payload, _cfg: cfg, _fp: input.fp || null };
}

export function vedaJob(jobId, fp = null) {
  return fp
    ? call(`/api/jobs/${encodeURIComponent(jobId)}`, { fp, bare: true })
    : call(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function vedaCancel(jobId, fp = null) {
  return fp
    ? call(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {}, fp, bare: true })
    : call(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
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

/**
 * 下载产物到 data/assets/<日期>/veda-<jobId>.mp4
 *
 * 2026-11-17 实测：上游出片后带宽很慢（8MB 的片子要十几分钟），单次长请求经常中途断。
 * 策略：Range 分块续传（服务端实测支持 206 + accept-ranges: bytes）+ 失败重试。
 * ⚠️ 服务端 HEAD 返回 405，不能用 HEAD 探大小；从首次响应的 content-range 里拿 total。
 */
export async function mirrorVeda(jobId, url, fp = null) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ASSET_DIR, day);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `veda-${jobId}.mp4`);

  const baseHeaders = {
    "user-agent": UA,
    accept: "video/mp4,*/*",
    referer: VEDA.origin + "/",
    ...(fp
      ? { "x-fp": fp } // 池模式：只带 X-Fp，绝不带 cookie（带旧 cookie 会把请求吸附回 cookie 身份的池）
      : {}),
  };

  let have = 0;
  let total = 0;
  for (let i = 0; i < 120; i++) {
    const headers = { ...baseHeaders };
    if (have > 0) headers.range = `bytes=${have}-`;
    let buf = null;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(4 * 60_000) });
      if (!res.ok && res.status !== 206) {
        throw new VedaError(`产物下载失败 ${res.status}`, { code: "mirror_failed", status: res.status });
      }
      const cr = res.headers.get("content-range");
      if (cr) total = Number(cr.split("/")[1]) || total;
      if (have > 0 && res.status === 200) {
        // 服务端不支持续传、每次都回全量 → 直接重写文件，不能追加
        await fs.writeFile(file, Buffer.alloc(0));
        have = 0;
      }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= 119) throw e;
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    if (!buf.length) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    await fs.appendFile(file, buf);
    have += buf.length;
    if (total && have >= total) break;
  }
  const bytes = (await fs.stat(file)).size;
  if (bytes < 1024) throw new VedaError(`产物异常（${bytes}B）`, { code: "mirror_failed" });
  return { file, bytes, rel: `${day}/veda-${jobId}.mp4` };
}
