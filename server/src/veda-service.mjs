/**
 * Veda 接入编排层：闸门 → 提交 → 落库 → 轮询 → 镜像产物。
 *
 * 与 Paba 的 queue.mjs 刻意分开：
 *   · Paba 需要「账号池 + 浏览器通道 + 并发调度」，复杂度都在那边；
 *   · Veda 是单通道 + 网络级额度，提交一次就是一个上游 job，没有账号可挑。
 * 共用的只有 store（任务库）与 events（SSE）。
 */

import { VEDA } from "./config.mjs";
import { upsertTask, getTask, listTasks, logEvent, dayKey } from "./store.mjs";
import { emit } from "./events.mjs";
import {
  ensureDevice,
  vedaQuota,
  vedaConfig,
  vedaHealth,
  vedaSubmit,
  vedaJob,
  vedaCancel,
  toTaskRow,
  isTerminal,
  pickVideoUrl,
  mirrorVeda,
  VedaError,
} from "./providers/veda.mjs";

const bad = (msg, extra = {}) => new VedaError(msg, { code: "validation", ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 近 60s 内同参数直接复用，避免手抖重复扣额度 */
const recent = new Map();
const DEDUP_MS = 60_000;

function fingerprint(input) {
  return JSON.stringify([
    String(input.prompt || "").trim(),
    Number(input.duration || 5),
    input.aspect || input.aspectRatio || "16:9",
    input.mode || "raw",
    input.seed ?? null,
  ]);
}

/** 今天已提交条数（本地口径，只用于「同网络 30 条/天」这道闸） */
async function submittedToday() {
  const today = dayKey();
  const rows = await listTasks({ provider: "veda", limit: 2000 });
  return rows.filter(
    (t) =>
      t.provider === "veda" &&
      t.status !== "failed" &&
      dayKey(t.createdAt || Date.now()) === today,
  ).length;
}

/**
 * 在途数：Veda 的状态是 denoising/decoding 这类细分阶段，
 * store.countActive 只认 pending/queued/running，会把生成中的任务漏掉，所以这里自己算。
 */
async function activeVeda() {
  const rows = await listTasks({ provider: "veda", limit: 500 });
  return rows.filter((t) => !isTerminal(t.status)).length;
}

/** 上游三件套缓存 15s：页面切换来源时会打这个接口，网络抖的时候别让它卡住 UI */
let upstreamCache = { at: 0, quota: null, config: null, health: null, error: null };

async function upstreamTriple() {
  if (Date.now() - upstreamCache.at < 15_000) return upstreamCache;
  const [qRes, cRes, hRes] = await Promise.allSettled([vedaQuota(), vedaConfig(), vedaHealth()]);
  upstreamCache = {
    at: Date.now(),
    quota: qRes.status === "fulfilled" ? qRes.value : null,
    config: cRes.status === "fulfilled" ? cRes.value : null,
    health: hRes.status === "fulfilled" ? hRes.value : null,
    error: qRes.status === "rejected" ? qRes.reason : null,
  };
  return upstreamCache;
}

export async function vedaOverview() {
  const out = { provider: "veda", origin: VEDA.origin, entryPage: VEDA.entryPage, ok: false };
  const { quota, config: cfg, health, error } = await upstreamTriple();

  try {
    const active = await activeVeda();
    const submitted = await submittedToday();
    if (quota) {
      out.ok = true;
      out.quota = {
        limit: quota.limit,
        used: quota.used,
        remaining: quota.remaining,
        resetsAt: quota.resets_at,
        windowStart: quota.window_start,
        unlimited: quota.unlimited,
        costs: quota.costs || {},
      };
    } else {
      out.error = error?.message || "读取额度失败";
      out.code = error?.code || "error";
    }
    if (cfg) {
      out.config = {
        durations: cfg.durations || [],
        aspects: cfg.aspects || [],
        minPromptChars: cfg.min_prompt_chars,
        maxPromptChars: cfg.max_prompt_chars,
        turnstile: Boolean(cfg.turnstile_site_key),
        refs: Boolean(cfg.refs?.enabled),
        gpu: cfg.gpu,
        numGpus: cfg.num_gpus,
        numSteps: cfg.num_steps,
        backendOnline: cfg.backend_online,
      };
    }
    if (health) {
      out.health = {
        backend: health.backend,
        queueLen: health.queue_len,
        running: health.running,
        slotsTotal: health.slots_total,
        slotsFree: health.slots_free,
        waitS: health.wait_s,
        tasks: health.tasks_available || [],
        contentFilter: health.content_filter?.mode || null,
      };
    }
    out.local = {
      submittedToday: submitted,
      networkDailyLimit: VEDA.networkDailyVideos,
      active,
      maxActive: VEDA.maxActive,
    };
  } catch (e) {
    out.error = e.message;
    out.code = e.code || "error";
  }
  return out;
}

/** 闸门：任何一条不满足都早失败，别等提交后被上游拒 */
export async function vedaPrecheck(input, quota = null) {
  const q = quota || (await vedaQuota());
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw bad("prompt 不能为空");
  if (q.unlimited) return q;

  const duration = Number(input.duration || 5);
  const cost = q.costs?.[String(duration)] ?? 1;
  if ((q.remaining ?? 0) < cost) {
    throw bad(
      `Veda 额度不足：这条 ${duration}s 需要 ${cost} credit，当前只剩 ${q.remaining}。` +
        (q.resets_at ? `额度 ${new Date(q.resets_at).toLocaleString("zh-CN")} 恢复。` : ""),
      { code: "quota_exhausted" },
    );
  }

  const submitted = await submittedToday();
  if (submitted >= VEDA.networkDailyVideos) {
    throw bad(`该网络今天已提交 ${submitted} 条，达到上游同网络上限（${VEDA.networkDailyVideos} 条/天）`, {
      code: "quota_network",
    });
  }

  const active = await activeVeda();
  if (active >= VEDA.maxActive) {
    throw bad(`已有 ${active} 条在排队/生成中（本地上限 ${VEDA.maxActive}），等出片再提交`, {
      code: "too_many_pending",
    });
  }
  return q;
}

export async function vedaGenerate(input) {
  const fp = fingerprint(input);
  const hit = recent.get(fp);
  if (hit && Date.now() - hit.at < DEDUP_MS) {
    const row = await getTask({ accountId: VEDA.accountId, upstreamId: hit.jobId });
    if (row) return { deduped: true, upstreamId: hit.jobId, task: row, quota: await vedaQuota() };
  }

  const quota = await vedaPrecheck(input);
  const sub = await vedaSubmit(input);
  const jobId = sub.job_id;
  if (!jobId) throw new VedaError("上游没有返回 job_id", { code: "upstream_error", body: sub });

  const row = {
    ...toTaskRow({ ...sub, job_id: jobId }),
    accountId: VEDA.accountId,
    provider: "veda",
    prompt: sub._payload?.prompt || input.prompt,
    model: "minimax-h3-veda",
    submittedLocally: true,
    cost: quota.costs?.[String(sub._payload?.duration || 5)] ?? 1,
  };
  await upsertTask(row);
  recent.set(fp, { at: Date.now(), jobId });

  const after = await vedaQuota().catch(() => null);
  await logEvent(
    "veda_submitted",
    `[Veda] ${jobId} ${row.duration ?? input.duration}s ${row.aspectRatio || input.aspect || "16:9"} · 上游已用 ${after?.used ?? "?"}/${after?.limit ?? "?"}`,
    { accountId: VEDA.accountId },
  );
  emit("task", { provider: "veda", upstreamId: jobId, status: row.status });
  return { deduped: false, upstreamId: jobId, task: row, quota: after };
}

/** 拉单个任务并落库；done 时入镜像 */
export async function vedaSyncJob(upstreamId) {
  const prev = await getTask({ accountId: VEDA.accountId, upstreamId });
  if (!prev) return null;
  if (isTerminal(prev.status) && prev.asset?.video) return prev;

  let job;
  try {
    job = await vedaJob(upstreamId);
  } catch (e) {
    await upsertTask({
      ...prev,
      lastError: e.message,
      lastErrorAt: Date.now(),
      pollErrors: (prev.pollErrors || 0) + 1,
    });
    return prev;
  }

  const row = { ...toTaskRow(job), accountId: VEDA.accountId, provider: "veda", prompt: prev.prompt, cost: prev.cost };
  const changed =
    row.status !== prev.status ||
    row.stage !== prev.stage ||
    row.step !== prev.step ||
    row.queuePosition !== prev.queuePosition;

  const merged = await upsertTask({ ...row, asset: prev.asset || null, jobId: prev.jobId || null });
  if (changed) emit("task", { provider: "veda", upstreamId, status: merged.status, stage: merged.stage });

  if (merged.status === "done" && !merged.asset?.video) {
    const url = pickVideoUrl(job);
    if (!url) {
      await upsertTask({ ...merged, assetError: "上游未给出产物地址" });
      return merged;
    }
    if ((merged.assetAttempts || 0) >= 3 && (merged.assetSkipUntil || 0) > Date.now()) return merged;
    try {
      const asset = await mirrorVeda(upstreamId, url);
      const done = await upsertTask({
        ...merged,
        asset: { video: asset.file, bytes: asset.bytes, savedAt: Date.now() },
        assetAttempts: 0,
        assetError: null,
        assetSkipUntil: 0,
      });
      await logEvent("veda_mirror_ok", `[Veda] ${upstreamId} 已落本地 ${(asset.bytes / 1048576).toFixed(1)}MB`, {
        accountId: VEDA.accountId,
      });
      emit("asset", { provider: "veda", upstreamId, bytes: asset.bytes, video: `/assets/${asset.rel}` });
      return done;
    } catch (e) {
      const attempts = (merged.assetAttempts || 0) + 1;
      await upsertTask({
        ...merged,
        assetAttempts: attempts,
        assetError: e.message,
        assetSkipUntil: attempts >= 3 ? Date.now() + 30 * 60_000 : 0,
      });
      await logEvent("veda_mirror_failed", `[Veda] ${upstreamId} 镜像失败（第 ${attempts} 次）：${e.message}`, {
        accountId: VEDA.accountId,
      });
    }
  } else if (changed && isTerminal(merged.status) && merged.status !== "done") {
    await logEvent("veda_failed", `[Veda] ${upstreamId} ${merged.status}：${merged.error || "上游未给原因"}`, {
      accountId: VEDA.accountId,
    });
  }
  return merged;
}

export async function vedaSyncAll() {
  const rows = await listTasks({ provider: "veda", limit: 500 });
  const active = rows.filter((t) => !isTerminal(t.status) || (t.status === "done" && !t.asset?.video));
  let synced = 0;
  for (const t of active) {
    if ((t.assetSkipUntil || 0) > Date.now()) continue;
    await vedaSyncJob(t.upstreamId);
    synced += 1;
    await sleep(300);
  }
  return { synced, candidates: active.length };
}

export async function vedaCancelJob(upstreamId) {
  const out = await vedaCancel(upstreamId);
  const prev = await getTask({ accountId: VEDA.accountId, upstreamId });
  if (prev) await upsertTask({ ...prev, status: out?.status || "cancelled" });
  emit("task", { provider: "veda", upstreamId, status: "cancelled" });
  return { ok: true, upstream: out };
}

/** 自适应轮询：有在途任务 8s 一次，全空闲 60s 一次 */
export function startVedaScheduler() {
  let timer = null;
  let busy = false;
  let stopped = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    let hasActive = false;
    try {
      const out = await vedaSyncAll();
      hasActive = out.candidates > 0;
      if (!out.candidates) await ensureDevice().catch(() => {});
    } catch {
      hasActive = false;
    } finally {
      busy = false;
      if (!stopped) {
        timer = setTimeout(tick, hasActive ? VEDA.pollActiveMs : VEDA.pollIdleMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(tick, 5000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
