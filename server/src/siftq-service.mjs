/**
 * SiftQ 接入编排层：额度闸门 → 提交 → 落库 → 轮询 → 即时镜像。
 *
 * 与 Veda 共用 store（任务库）与 events（SSE），但有三点不同：
 *   · 图生视频：必须带输入图（data URL / URL / 本地路径）
 *   · 只有 9:16、6/10/15s，上游 showcase 通道硬限制
 *   · 匿名每日 2 条，按真实出口 IP 计；上游无额度查询接口，只能本地账本 + 提交回执 remaining 校准
 *
 * 边界：429 直接 quota_exhausted，不做身份轮换 / XFF 伪造。
 */

import { SIFTQ } from "./config.mjs";
import { upsertTask, getTask, listTasks, logEvent, getUsage, bumpUsage, dayKey } from "./store.mjs";
import { emit } from "./events.mjs";
import {
  ensureDevice,
  siftqSubmit,
  siftqJob,
  siftqContent,
  toTaskRow,
  isTerminal,
  normalizeDuration,
  normalizeAspect,
  mirrorSiftq,
  SiftqError,
} from "./providers/siftq.mjs";

const bad = (msg, extra = {}) => new SiftqError(msg, { code: "validation", ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 近 60s 同参数复用，避免手抖重复提交扣掉 2 条里的一条 */
const recent = new Map();
const DEDUP_MS = 60_000;

function fingerprint(input) {
  return JSON.stringify([
    String(input.image || input.imageUrl || input.firstFrame || input.imageDataUrl || "").slice(0, 256),
    String(input.prompt || "").trim(),
    normalizeDurationSafe(input.duration),
    normalizeAspectSafe(input.aspect || input.aspectRatio),
  ]);
}

function normalizeDurationSafe(v) {
  try {
    return normalizeDuration(v);
  } catch {
    return String(v);
  }
}
function normalizeAspectSafe(v) {
  try {
    return normalizeAspect(v);
  } catch {
    return String(v);
  }
}

/** 上游回执里读到的剩余额度（提交后用它校准本地账本，只下调，不虚增） */
let lastKnownRemaining = null;

/** 今日本地已提交条数 */
async function submittedToday() {
  const today = dayKey();
  const rows = await listTasks({ provider: "siftq", limit: 2000 });
  return rows.filter(
    (t) => t.provider === "siftq" && t.status !== "failed" && dayKey(t.createdAt || Date.now()) === today,
  ).length;
}

async function activeSiftq() {
  const rows = await listTasks({ provider: "siftq", limit: 500 });
  return rows.filter((t) => !isTerminal(t.status)).length;
}

export async function siftqOverview() {
  const out = { provider: "siftq", origin: SIFTQ.origin, entryPage: SIFTQ.entryPage, ok: false };
  try {
    const device = await ensureDevice();
    const usage = await getUsage(SIFTQ.accountId);
    const submitted = await submittedToday();
    const active = await activeSiftq();
    // 本地账本与提交回执取更保守的那个（剩余额度只会更少，不会虚报）
    const localLeft = Math.max(0, SIFTQ.dailyLimit - submitted);
    const remaining =
      lastKnownRemaining != null ? Math.min(localLeft, lastKnownRemaining) : localLeft;
    out.ok = Boolean(device.clientId && device.visitorId);
    out.quota = {
      limit: SIFTQ.dailyLimit,
      used: submitted,
      remaining,
      source: "local_ledger", // 上游无匿名额度查询接口，如实标注
      day: usage.day,
    };
    out.local = { submittedToday: submitted, active, maxActive: SIFTQ.maxActive };
    out.identity = {
      mintedLocally: true,
      rotated: false, // 边界声明：固定单一身份，不轮换
    };
    out.constraints = { aspects: ["9:16"], durations: [6, 10, 15], mode: "image-to-video" };
  } catch (e) {
    out.error = e.message;
    out.code = e.code || "error";
  }
  return out;
}

/** 闸门：额度 / 在途 / 参数，任何一条不满足都早失败 */
export async function siftqPrecheck(input) {
  const image = input.image || input.imageUrl || input.firstFrame || input.imageDataUrl;
  if (!image) throw bad("SiftQ 是图生视频，必须提供输入图（image 字段）");
  if (input.aspect && normalizeAspectSafe(input.aspect) !== "9:16" && !String(input.aspect).match(/^9:16$|^9:21$|^720x1280$|^1080x1920$/i)) {
    normalizeAspect(input.aspect); // 抛 validation
  }
  normalizeDuration(input.duration ?? 6);

  const submitted = await submittedToday();
  if (submitted >= SIFTQ.dailyLimit) {
    const usage = await getUsage(SIFTQ.accountId);
    throw bad(
      `SiftQ 匿名额度今天已用完（${submitted}/${SIFTQ.dailyLimit} 条，按真实出口 IP 计）。` +
        `换设备/清 cookie/伪造 IP 都不会恢复——这是上游硬限制。请等明天，或改用 Veda / Paba 上游。`,
      { code: "quota_exhausted", resetsAt: nextMidnightMs(usage.day) },
    );
  }
  const active = await activeSiftq();
  if (active >= SIFTQ.maxActive) {
    throw bad(`已有 ${active} 条在生成中（本地上限 ${SIFTQ.maxActive}），等出片再提交`, {
      code: "too_many_pending",
    });
  }
}

function nextMidnightMs(day) {
  // 上游按 UTC 计匿名额度，次日 00:00 UTC 恢复（保守提示）
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next;
}

export async function siftqGenerate(input) {
  const fp = fingerprint(input);
  const hit = recent.get(fp);
  if (hit && Date.now() - hit.at < DEDUP_MS) {
    const row = await getTask({ accountId: SIFTQ.accountId, upstreamId: hit.upstreamId });
    if (row) return { deduped: true, upstreamId: hit.upstreamId, task: row };
  }

  await siftqPrecheck(input);

  // 本地任务 id 用时间戳+随机串，作为上游幂等键（防止重复扣额度）
  const { randomUUID } = await import("node:crypto");
  const idemKey = randomUUID().slice(0, 12);
  let sub;
  try {
    sub = await siftqSubmit({ ...input, idempotencyKey: idemKey });
  } catch (e) {
    if (e.code === "quota_exhausted") {
      await bumpUsage(SIFTQ.accountId, "fail");
      throw bad(`SiftQ 额度已耗尽（429）：${e.message}`, { code: "quota_exhausted" });
    }
    throw e;
  }

  if (Number.isInteger(sub.remaining)) lastKnownRemaining = sub.remaining;

  const row = {
    ...toTaskRow({ status: "queued", ...sub }),
    accountId: SIFTQ.accountId,
    provider: "siftq",
    upstreamId: sub.task_id,
    accessToken: sub.access_token,
    prompt: sub._payload?.prompt || input.prompt,
    model: "minimax-h3-siftq",
    duration: sub._payload?.duration,
    aspectRatio: sub._payload?.ratio || "9:16",
    imageBytes: sub._payload?.imageBytes,
    submittedLocally: true,
  };
  await upsertTask(row);
  await bumpUsage(SIFTQ.accountId, "reserve");
  recent.set(fp, { at: Date.now(), upstreamId: sub.task_id });

  await logEvent(
    "siftq_submitted",
    `[SiftQ] ${sub.task_id} ${row.duration}s 9:16 · 上游剩余 ${sub.remaining ?? "?"} 条`,
    { accountId: SIFTQ.accountId },
  );
  emit("task", { provider: "siftq", upstreamId: sub.task_id, status: row.status });
  return { deduped: false, upstreamId: sub.task_id, task: row, remaining: sub.remaining };
}

/** 拉单个任务并落库；成功时立刻镜像（上游 1–2 天后回收任务） */
export async function siftqSyncJob(upstreamId) {
  const prev = await getTask({ accountId: SIFTQ.accountId, upstreamId });
  if (!prev) return null;
  if (isTerminal(prev.status) && prev.asset?.video) return prev;

  let snap;
  try {
    snap = await siftqJob(upstreamId, prev.accessToken);
  } catch (e) {
    await upsertTask({
      ...prev,
      lastError: e.message,
      lastErrorAt: Date.now(),
      pollErrors: (prev.pollErrors || 0) + 1,
    });
    return prev;
  }

  // 强制保留本地主键与凭证：绝不相信 poll 快照会带回 upstreamId（丢了会建僵尸行）
  const row = {
    ...toTaskRow(snap),
    upstreamId: prev.upstreamId,
    accessToken: prev.accessToken,
    accountId: SIFTQ.accountId,
    provider: "siftq",
    prompt: prev.prompt,
  };
  const changed = row.status !== prev.status || row.stage !== prev.stage;
  const merged = await upsertTask({ ...row, asset: prev.asset || null });
  if (changed) emit("task", { provider: "siftq", upstreamId, status: merged.status });

  if (merged.status === "done" && !merged.asset?.video) {
    if ((merged.assetAttempts || 0) >= 3 && (merged.assetSkipUntil || 0) > Date.now()) return merged;
    try {
      const bytes = await siftqContent(upstreamId, prev.accessToken);
      const asset = await mirrorSiftq(upstreamId, bytes);
      const done = await upsertTask({
        ...merged,
        asset: { video: asset.file, bytes: asset.bytes, savedAt: Date.now() },
        assetAttempts: 0,
        assetError: null,
        assetSkipUntil: 0,
      });
      await logEvent("siftq_mirror_ok", `[SiftQ] ${upstreamId} 已落本地 ${(asset.bytes / 1048576).toFixed(1)}MB`, {
        accountId: SIFTQ.accountId,
      });
      emit("asset", { provider: "siftq", upstreamId, bytes: asset.bytes, video: `/assets/${asset.rel}` });
      return done;
    } catch (e) {
      const attempts = (merged.assetAttempts || 0) + 1;
      await upsertTask({
        ...merged,
        assetAttempts: attempts,
        assetError: e.message,
        assetSkipUntil: attempts >= 3 ? Date.now() + 30 * 60_000 : 0,
      });
      await logEvent("siftq_mirror_failed", `[SiftQ] ${upstreamId} 镜像失败（第 ${attempts} 次）：${e.message}`, {
        accountId: SIFTQ.accountId,
      });
    }
  } else if (changed && isTerminal(merged.status) && merged.status !== "done") {
    await bumpUsage(SIFTQ.accountId, "refund"); // 上游失败，退还本地账本
    await logEvent("siftq_failed", `[SiftQ] ${upstreamId} ${merged.status}：${merged.error || "上游未给原因"}`, {
      accountId: SIFTQ.accountId,
    });
  }
  return merged;
}

export async function siftqSyncAll() {
  const rows = await listTasks({ provider: "siftq", limit: 500 });
  const active = rows.filter((t) => !isTerminal(t.status) || (t.status === "done" && !t.asset?.video));
  let synced = 0;
  for (const t of active) {
    if ((t.assetSkipUntil || 0) > Date.now()) continue;
    await siftqSyncJob(t.upstreamId);
    synced += 1;
    await sleep(300);
  }
  return { synced, candidates: active.length };
}

/** 自适应轮询：有在途 8s，全空闲 60s */
export function startSiftqScheduler() {
  let timer = null;
  let busy = false;
  let stopped = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    let hasActive = false;
    try {
      const out = await siftqSyncAll();
      hasActive = out.candidates > 0;
    } catch {
      hasActive = false;
    } finally {
      busy = false;
      if (!stopped) {
        timer = setTimeout(tick, hasActive ? SIFTQ.pollActiveMs : SIFTQ.pollIdleMs);
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
