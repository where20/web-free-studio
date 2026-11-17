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
import { VedaFpPool } from "./providers/veda-fp-pool.mjs";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";

/**
 * 指纹池（2026-11-17 破解：X-Fp 是额度分组键，每指纹独立 20 credits/天）。
 * 默认 size=1（与官方行为一致）；VEDA_FP_POOL_SIZE 环境变量显式扩池。
 * 持久化 data/veda.fp-pool.json（0600），重启不丢账。
 */
const fpPool = new VedaFpPool({
  size: Number(process.env.VEDA_FP_POOL_SIZE || 1),
  persistFile: path.join(DATA_DIR, "veda.fp-pool.json"),
});

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

/**
 * 多池额度汇总：并行查每个指纹池 + 回写本地视图。
 * 上游额度接口单次可能要 10-20s，并行 + 15s 缓存避免 UI 卡顿。
 */
async function poolQuota() {
  const readOne = async (p) => {
    try {
      const q = await vedaQuota(p.fp);
      await fpPool.report(p.id, q);
      return { id: p.id, fp: p.fp.slice(0, 12) + "…", ...q };
    } catch {
      return null;
    }
  };
  const raw = await fpPool.load();
  const results = await Promise.all(raw.map((p) => readOne(p)));
  const ok = results.filter(Boolean);
  if (!ok.length) return null;
  const total = ok.reduce((n, q) => n + (q.remaining ?? 0), 0);
  const limit = ok.reduce((n, q) => n + (q.limit ?? 0), 0);
  const best = ok.reduce((a, b) => ((b.remaining ?? 0) > (a.remaining ?? 0) ? b : a));
  return {
    limit,
    used: limit - total,
    remaining: total,
    resets_at: best.resets_at || null,
    window_start: best.window_start || null,
    unlimited: best.unlimited || false,
    costs: best.costs || {},
    pools: ok,
    poolCount: ok.length,
  };
}

async function upstreamTriple() {
  if (Date.now() - upstreamCache.at < 15_000) return upstreamCache;
  const [qRes, cRes, hRes] = await Promise.allSettled([poolQuota(), vedaConfig(), vedaHealth()]);
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
        // 指纹池明细（X-Fp 分池机制，见 veda-fp-pool.mjs）
        poolCount: quota.poolCount || 1,
        pools: (quota.pools || []).map((p) => ({
          id: p.id,
          fp: p.fp,
          used: p.used,
          remaining: p.remaining,
          resetsAt: p.resets_at || null,
        })),
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
  const q = quota || (await poolQuota());
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw bad("prompt 不能为空");
  if (q.unlimited) return q;

  const duration = Number(input.duration || 5);
  const cost = q.costs?.[String(duration)] ?? 1;
  if ((q.remaining ?? 0) < cost) {
    throw bad(
      `Veda 额度不足：这条 ${duration}s 需要 ${cost} credit，当前只剩 ${q.remaining}（${q.poolCount || 1} 个设备池合计）。` +
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
    if (row) return { deduped: true, upstreamId: hit.jobId, task: row, quota: await poolQuota() };
  }

  const quota = await vedaPrecheck(input);

  // 槽位自检：上游 2×RTX 4090，满槽时提交只会 429 too_many_active（与额度无关，换池没用）
  const health = await vedaHealth().catch(() => null);
  if (health && Number.isFinite(Number(health.slots_total)) && Number(health.slots_total) > 0) {
    if (Number(health.slots_free ?? 0) <= 0) {
      throw bad(
        `Veda 生成槽位已满（0/${health.slots_total}，队列 ${health.queue_len ?? "?"}，` +
          `预计等待 ${Math.round(Number(health.wait_s) || 30)}s）。这是上游 2 张 GPU 的并发上限，与额度无关 —— 等出片再提交。`,
        { code: "slots_full" },
      );
    }
  }

  // 从池里取一个可用指纹：本任务的提交/轮询/下载全程绑定它
  const slot = await fpPool.acquire();
  const sub = await vedaSubmit({ ...input, fp: slot.fp });
  const jobId = sub.job_id;
  if (!jobId) {
    // 提交失败 → 退回这次 acquire 的占位，避免池空转
    const pools = await fpPool.load();
    const p = pools.find((x) => x.id === slot.id);
    if (p) p.issued = Math.max(0, (p.issued || 1) - 1);
    await fpPool.save();
    throw new VedaError("上游没有返回 job_id", { code: "upstream_error", body: sub });
  }

  const row = {
    ...toTaskRow({ ...sub, job_id: jobId }),
    accountId: VEDA.accountId,
    provider: "veda",
    prompt: sub._payload?.prompt || input.prompt,
    model: "minimax-h3-veda",
    submittedLocally: true,
    cost: quota.costs?.[String(sub._payload?.duration || 5)] ?? 1,
    // 绑定本任务的指纹池 id：轮询/下载时用它取回完整指纹（见 vedaSyncJob）
    fpPoolId: slot.id,
  };
  await upsertTask(row);
  recent.set(fp, { at: Date.now(), jobId });

  // 用提交响应里的 quota 回写该池的本地视图
  if (sub.quota) await fpPool.report(slot.id, sub.quota);

  const after = await poolQuota().catch(() => null);
  await logEvent(
    "veda_submitted",
    `[Veda] ${jobId} 池#${slot.id} ${row.duration ?? input.duration}s ${row.aspectRatio || input.aspect || "16:9"} · 该池已用 ${sub.quota?.used ?? "?"}/${sub.quota?.limit ?? "?"}`,
    { accountId: VEDA.accountId },
  );
  emit("task", { provider: "veda", upstreamId: jobId, status: row.status });
  return { deduped: false, upstreamId: jobId, task: row, quota: after };
}

/** 取回某任务绑定的完整指纹（轮询/下载必须与提交同指纹，否则上游找不到任务） */
async function taskFp(row) {
  if (row?.fpPoolId == null) return null;
  const pools = await fpPool.load();
  return pools.find((p) => p.id === row.fpPoolId)?.fp || null;
}

/** 拉单个任务并落库；done 时入镜像 */
export async function vedaSyncJob(upstreamId) {
  const prev = await getTask({ accountId: VEDA.accountId, upstreamId });
  if (!prev) return null;
  if (isTerminal(prev.status) && prev.asset?.video) return prev;

  const fp = await taskFp(prev);
  let job;
  try {
    job = await vedaJob(upstreamId, fp);
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
      const asset = await mirrorVeda(upstreamId, url, fp);
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
  const prev = await getTask({ accountId: VEDA.accountId, upstreamId });
  const fp = await taskFp(prev);
  const out = await vedaCancel(upstreamId, fp);
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
