/**
 * SiftQ MiniMax-H3 适配器（siftq.com/minimax-h3/try）
 *
 * 只封装上游「正向」协议：单一固定匿名身份 + 真实出口 IP + 本地额度账本。
 * 刻意不做的部分（边界）：
 *   · 不伪造 X-Forwarded-For（额度键，伪造即为规避访问控制）
 *   · 不铸造/轮换 client_id、visitor_id（它们是浏览器 localStorage 里的会话标识，固定一份即可）
 *   · 429 不换身份重投，直接返回 quota_exhausted 让调用方等恢复
 * 上游硬限制：图生视频、仅 9:16、6/10/15s、匿名每日 2 条（按出口 IP）。
 * 提交必须走 showcase 通道，prompt 才会真实生效。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ASSET_DIR, SIFTQ } from "../config.mjs";

const deviceFile = path.join(DATA_DIR, "siftq.device.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class SiftqError extends Error {
  constructor(message, { code = "error", status = 0, body = null } = {}) {
    super(message);
    this.name = "SiftqError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/* ---------------- 设备态：一份固定的匿名会话标识 ---------------- */

let jar = null;
let jarLoading = null;

async function loadJar() {
  if (jar) return jar;
  if (jarLoading) return jarLoading;
  jarLoading = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(deviceFile, "utf8"));
      // 兼容旧字段：只用已存在的固定 id，绝不重新铸造来绕额度
      jar = { clientId: raw.clientId || null, visitorId: raw.visitorId || null };
    } catch {
      jar = { clientId: null, visitorId: null };
    }
    return jar;
  })();
  return jarLoading;
}

async function saveJar() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(deviceFile, JSON.stringify(jar, null, 1), { mode: 0o600 });
}

/**
 * 生成一次性的匿名会话标识（等价于真实浏览器首次访问时写入 localStorage）。
 * 只在本地文件不存在时调用一次；之后永远复用，绝不轮换。
 */
export async function ensureDevice() {
  const state = await loadJar();
  if (state.clientId && state.visitorId) return { ...state, minted: false };
  const { randomUUID } = await import("node:crypto");
  if (!state.clientId) state.clientId = `mmtrial_${randomUUID()}`;
  if (!state.visitorId) state.visitorId = `mmguest_${randomUUID()}`;
  await saveJar();
  return { ...state, minted: true };
}

async function sessionHeaders() {
  const state = await ensureDevice();
  return {
    accept: "application/json",
    "user-agent": UA,
    referer: SIFTQ.referer,
    "x-minimax-trial-client": state.clientId,
  };
}

/* ---------------- 统一请求：只对 GET 重试 ---------------- */

async function call(pathname, { method = "GET", body = null, headers = {}, timeoutMs = 60_000 } = {}) {
  const base = {
    ...(await sessionHeaders()),
    ...headers,
  };
  if (body && !(body instanceof FormData)) base["content-type"] = "application/json";

  // POST 一旦发出就可能扣额度，绝不重试；GET 是只读的，可以退避重试
  const attempts = method === "GET" ? 3 : 1;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(SIFTQ.origin + pathname, {
        method,
        headers: base,
        body: body
          ? body instanceof FormData
            ? body
            : JSON.stringify(body)
          : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = new SiftqError(`连不上 SiftQ：${e.cause?.code || e.message}`, { code: "network" });
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 600 * i));
        continue;
      }
      throw lastErr;
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }

    if (!res.ok) {
      const code = data?.error?.type || data?.error || `http_${res.status}`;
      const msg = data?.error?.message || data?.message || `上游返回 ${res.status}`;
      const err = new SiftqError(msg, { code, status: res.status, body: data });
      // 429 = 匿名额度耗尽（按真实出口 IP），如实上报，不换身份重投
      if (res.status === 429 || code === "rate_limit_error") {
        err.code = "quota_exhausted";
      }
      if (res.status >= 500 && i < attempts) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 600 * i));
        continue;
      }
      throw err;
    }
    return data;
  }
  throw lastErr || new SiftqError("上游请求失败", { code: "network" });
}

/* ---------------- 输入图片 ---------------- */

function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
  return null; // 上游对错误标注的 MIME 会 502，未知类型直接拒
}

export function isImageRef(v) {
  return typeof v === "string" && (/^data:image\//i.test(v) || /^https?:\/\//i.test(v));
}

/** data URL / http(s) URL / 本地绝对路径 → { bytes, filename, mime } */
export async function resolveImage(ref) {
  let buf = null;
  let filename = "reference.jpg";
  if (/^data:image\//i.test(ref)) {
    const m = ref.match(/^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i);
    if (!m) throw new SiftqError("图片 data URL 格式不正确", { code: "validation" });
    buf = Buffer.from(m[2], "base64");
    filename = `reference.${m[1].toLowerCase().replace("jpeg", "jpg")}`;
  } else if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new SiftqError(`输入图下载失败 ${res.status}`, { code: "input_image" });
    buf = Buffer.from(await res.arrayBuffer());
    try {
      const u = new URL(ref);
      filename = path.basename(u.pathname) || "reference.jpg";
    } catch {}
  } else {
    // 本地文件路径（MCP 适配层会先做路径→data URL，这里兜底）
    buf = await fs.readFile(ref).catch(() => null);
    if (!buf) throw new SiftqError("找不到输入图片文件", { code: "validation" });
    filename = path.basename(ref);
  }
  if (!buf?.length) throw new SiftqError("输入图片为空", { code: "validation" });
  if (buf.length > SIFTQ.imageMaxBytes) {
    throw new SiftqError(`输入图超过 ${Math.round(SIFTQ.imageMaxBytes / 1048576)}MB 上限`, { code: "validation" });
  }
  const mime = sniffImageMime(buf);
  if (!mime) throw new SiftqError("只支持 JPEG / PNG / WebP 输入图", { code: "validation" });
  return { bytes: buf, filename, mime };
}

/* ---------------- 参数规范化 ---------------- */

const DURATION_ALIASES = { 4: 6, 5: 6, 6: 6, 7: 6, 8: 10, 9: 10, 10: 10, 11: 10, 12: 10, 13: 15, 14: 15, 15: 15, 16: 15, 20: 15 };

export function normalizeDuration(value) {
  if (value == null || value === "") return 6;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new SiftqError(`时长不合法：${value}`, { code: "validation" });
  const out = DURATION_ALIASES[Math.round(n)];
  if (!out) throw new SiftqError("时长只支持 6 / 10 / 15 秒（4–7→6，8–12→10，13–20→15）", { code: "validation" });
  return out;
}

export function normalizeAspect(value) {
  const v = String(value || "9:16").trim().toLowerCase().replace(/\s/g, "");
  // 上游 showcase 通道写死 9:16，其他画幅会被静默产出竖屏——直接拒，别骗用户
  const ok = ["9:16", "9:21", "720x1280", "1080x1920"];
  if (!ok.includes(v)) {
    throw new SiftqError("SiftQ 试用通道仅支持 9:16 竖屏（上游硬限制）", { code: "validation" });
  }
  return "9:16";
}

/* ---------------- 提交 / 查询 / 下载 ---------------- */

/**
 * 提交图生视频。走 showcase 通道（唯一让 prompt 生效的通道）。
 * 429 直接抛 quota_exhausted —— 这是对上游额度的尊重，不绕。
 */
export async function siftqSubmit(input) {
  const imageRef = input.image || input.imageUrl || input.firstFrame || input.imageDataUrl;
  if (!imageRef || !isImageRef(imageRef)) {
    throw new SiftqError("SiftQ 是图生视频，必须提供一张输入图（image / firstFrame）", { code: "validation" });
  }
  const image = await resolveImage(imageRef);
  const duration = normalizeDuration(input.duration);
  const ratio = normalizeAspect(input.aspect || input.aspectRatio);
  const prompt = String(input.prompt || "").trim() || SIFTQ.defaultPrompt;
  const state = await ensureDevice();

  const form = new FormData();
  form.set("visitorId", state.visitorId);
  form.set("channelCode", "direct");
  form.set("sourceHost", "siftq.com");
  form.set("showcase_id", SIFTQ.showcaseId);
  form.set("ratio", ratio);
  form.set("duration", String(duration));
  form.set("client_id", state.clientId);
  form.set("prompt", prompt);
  form.set("image", new Blob([image.bytes], { type: image.mime }), image.filename);

  // 幂等键由本地任务 id 派生（若调用方给了），避免自己手抖重复提交
  const headers = {};
  if (input.idempotencyKey) headers["idempotency-key"] = `wfs_${input.idempotencyKey}`;

  const out = await call(SIFTQ.paths.submit, { method: "POST", body: form, headers, timeoutMs: 120_000 });
  const upstreamId = String(out?.task_id ?? out?.taskId ?? "");
  if (!upstreamId) throw new SiftqError("上游没有返回 task_id", { code: "upstream_error", body: out });
  return {
    task_id: upstreamId,
    access_token: out.access_token ?? out.accessToken ?? null,
    remaining: Number.isInteger(out.remaining) ? out.remaining : Number.isInteger(out.remaining_count) ? out.remaining_count : null,
    _payload: { prompt, duration, ratio, imageBytes: image.bytes.length },
  };
}

/** 查询任务：上游状态是 queued / running / succeeded / failed / canceled */
export async function siftqJob(upstreamId, accessToken) {
  const q = accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : "";
  return call(`${SIFTQ.paths.job(upstreamId)}${q}`);
}

/** 下载成片字节（上游任务约 1–2 天后回收，出片即镜像落盘） */
export async function siftqContent(upstreamId, accessToken) {
  const state = await ensureDevice();
  const q = new URLSearchParams({ client_id: state.clientId });
  if (accessToken) q.set("access_token", accessToken);
  const url = `${SIFTQ.origin}${SIFTQ.paths.content(upstreamId)}?${q.toString()}`;
  const headers = await sessionHeaders();

  // 下载是只读的，网络抖动可安全重试（实测偶发卡住/超时）
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        if (res.status === 404)
          throw new SiftqError("上游任务已过期（约 1–2 天回收）", { code: "expired", status: 404 });
        const err = new SiftqError(`成片下载失败 ${res.status}`, { code: "mirror_failed", status: res.status });
        if (res.status >= 500 && i < 3) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 800 * i));
          continue;
        }
        throw err;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new SiftqError(`成片异常（${buf.length}B）`, { code: "mirror_failed" });
      return buf;
    } catch (e) {
      if (e instanceof SiftqError && e.code !== "mirror_failed") throw e; // 404 不重试
      lastErr = e;
      if (i < 3) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr || new SiftqError("成片下载失败", { code: "mirror_failed" });
}

/* ---------------- 状态映射与落盘 ---------------- */

// 同时认「上游原态」和「本地映射态」：toLocalStatus 会把 succeeded→done、canceled→cancelled
const TERMINAL = new Set(["succeeded", "failed", "canceled", "done", "cancelled"]);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

/** 上游 succeeded → 本地 done，其余原样透传（前端 badge 已有 queued/running/failed/cancelled） */
export function toLocalStatus(status) {
  if (status === "succeeded") return "done";
  if (status === "canceled") return "cancelled";
  return status || "queued";
}

/**
 * 把上游快照映射成本地任务行（字段名对齐 Veda/Paba，前端不用改渲染）。
 * 必须透传 upstreamId —— store 的 taskKey 用它做主键，丢了会生成无 id 的僵尸行。
 */
export function toTaskRow(snap) {
  const status = toLocalStatus(snap.status);
  const row = {
    provider: "siftq",
    status,
    stage: snap.status && status === "running" ? "generating" : null,
    error: snap.error ? (typeof snap.error === "string" ? snap.error : JSON.stringify(snap.error)) : null,
  };
  if (snap.upstream_id || snap.upstreamId || snap.task_id || snap.taskId) {
    row.upstreamId = String(snap.upstream_id || snap.upstreamId || snap.task_id || snap.taskId);
  }
  if (snap.access_token || snap.accessToken) row.accessToken = snap.access_token || snap.accessToken;
  return row;
}

/** 落盘到 data/assets/<日期>/siftq-<upstreamId>.mp4 */
export async function mirrorSiftq(upstreamId, bytes) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ASSET_DIR, day);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `siftq-${upstreamId}.mp4`);
  await fs.writeFile(file, bytes);
  return { file, bytes: bytes.length, rel: `${day}/siftq-${upstreamId}.mp4` };
}
