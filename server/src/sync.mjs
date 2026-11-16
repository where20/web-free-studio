import { laneFor, ChallengeError, AuthError } from "./lane.mjs";
import { RUNTIME } from "./config.mjs";
import {
  upsertAccount,
  upsertTask,
  listAccounts,
  logEvent,
  getTask,
  getUsage,
  consumedOf,
  listTasks,
  reconcileUsage,
} from "./store.mjs";
import { emit } from "./events.mjs";

function normalizeField(t) {
  return {
    accountId: null,
    upstreamId: t.request_id || t.id,
    status: t.status,
    queueState: t.queue_state,
    queueClass: t.queue_class,
    queuePosition: t.queue_position,
    queueEtaSeconds: t.queue_eta_seconds,
    queueText: t.queue_text,
    model: t.model,
    modelKey: t.model_key,
    tier: t.tier,
    tierCn: t.tier_cn,
    prompt: t.prompt || "",
    duration: t.duration,
    resolution: t.resolution,
    requestedResolution: t.requested_resolution,
    aspectRatio: t.aspect_ratio,
    seed: t.seed,
    width: t.width,
    height: t.height,
    frames: t.frames,
    moderation: t.moderation,
    billing: t.billing || null,
    upstreamCreatedAt: (t.created_at || 0) * 1000,
    startedAt: t.started_at ? t.started_at * 1000 : null,
    finishedAt: t.finished_at ? t.finished_at * 1000 : null,
    video: t.video || null,
  };
}

// 同一时刻只允许一个同步在跑：ego/Chrome 的同一标签页被两个进程并发操作会互相卡死
let syncLock = Promise.resolve();
function withSyncLock(fn) {
  // 兜底看门狗：单次同步超过 150s 直接判失败，避免一个卡住的调用把后续同步全堵死
  const run = () =>
    Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => setTimeout(() => reject(new Error("同步超时（150s）")), 150_000)),
    ]);
  const next = syncLock.then(run, run);
  syncLock = next.catch(() => {});
  return next;
}

/* ---------- 资产镜像后台队列（不阻塞同步；免费档 CDN 有时只有几 KB/s） ---------- */
const mirrorQueue = [];
const mirrorPending = new Set();
let mirrorRunning = 0;
const MIRROR_CONCURRENCY = 1;

function enqueueMirror(account, task, row, prev) {
  const key = `${account.id}:${row.upstreamId}`;
  if (mirrorPending.has(key)) return false;
  mirrorPending.add(key);
  mirrorQueue.push({ account, task, row, prev });
  pumpMirror();
  return true;
}

function pumpMirror() {
  while (mirrorRunning < MIRROR_CONCURRENCY && mirrorQueue.length) {
    const job = mirrorQueue.shift();
    mirrorRunning += 1;
    runMirror(job).finally(() => {
      mirrorRunning -= 1;
      mirrorPending.delete(`${job.account.id}:${job.row.upstreamId}`);
      pumpMirror();
    });
  }
}

async function runMirror({ account, task, row, prev }) {
  try {
    const asset = await laneFor(account).mirror(task);
    await upsertTask({
      ...row,
      asset: { video: asset.video, thumb: asset.thumb, meta: asset.meta, bytes: asset.bytes, savedAt: Date.now() },
      assetAttempts: 0,
      assetError: null,
      assetSkipUntil: 0,
    });
    await logEvent("mirror_ok", `${row.upstreamId} 已落本地 ${(asset.bytes / 1048576).toFixed(1)}MB`, {
      accountId: account.id,
    });
    emit("asset", {
      accountId: account.id,
      upstreamId: row.upstreamId,
      bytes: asset.bytes,
      video: `/assets/${asset.video.split("/assets/")[1]}`,
    });
  } catch (e) {
    const attempts = ((prev && prev.assetAttempts) || 0) + 1;
    await upsertTask({
      ...row,
      assetAttempts: attempts,
      assetError: e.message,
      assetSkipUntil: attempts >= 3 ? Date.now() + 30 * 60 * 1000 : 0,
    });
    await logEvent("mirror_failed", `${row.upstreamId} 镜像失败（第 ${attempts} 次）：${e.message}`, {
      accountId: account.id,
    });
  }
}

/** 单账号一批同步：拉列表 → 落库 → 镜像已完成资产 */
export function syncAccount(account, opts = {}) {
  return withSyncLock(() => syncAccountInner(account, opts));
}

async function syncAccountInner(account, { limit = RUNTIME.listLimit, mirror = true, maxMirror } = {}) {
  const lane = laneFor(account);
  const started = Date.now();
  let synced = 0;
  let queued = 0;
  const downloaded = 0;
  const mirroredBytes = 0;

  try {
    const me = await lane.me();
    if (me && me.ok) {
      await upsertAccount({
        id: account.id,
        upstreamUserId: me.user_id,
        status: "online",
        lastSeenAt: Date.now(),
        needsChallenge: false,
      });
    } else {
      await upsertAccount({ id: account.id, status: "logged_out" });
      throw new AuthError("登录态失效，请重新授权该账号");
    }

    const res = await lane.listTasks(limit);
    const rows = Array.isArray(res?.data) ? res.data : [];
    for (const t of rows) {
      const base = normalizeField(t);
      const prev = await getTask({ accountId: account.id, upstreamId: base.upstreamId });
      const row = { ...base, accountId: account.id };
      if (prev?.asset?.video) {
        row.asset = prev.asset;
      }
      await upsertTask(row);
      synced += 1;

      const skipMirror =
        (prev?.assetAttempts || 0) >= 3 && (prev?.assetSkipUntil || 0) > Date.now();
      if (mirror && base.status === "done" && base.video && !row.asset?.video && !skipMirror) {
        if (enqueueMirror(account, t, row, prev)) queued += 1;
      }
    }

    const freeToday = rows.filter(
      (t) =>
        t.billing?.free &&
        (t.created_at || 0) * 1000 >= startOfToday(),
    ).length;
    await reconcileUsage(account.id, freeToday);
    const usage = await getUsage(account.id);

    await upsertAccount({
      id: account.id,
      status: "online",
      lastSyncAt: Date.now(),
      lastSyncMs: Date.now() - started,
      upstreamFreeToday: freeToday,
      freeUsedToday: Math.max(consumedOf(usage), freeToday),
      lastQueue: res?.queue || null,
      lastError: null,
      needsChallenge: false,
    });

    emit("sync", {
      accountId: account.id,
      synced,
      queued,
      downloaded,
      mirroredBytes,
      freeUsedToday: freeToday,
      queue: res?.queue || null,
    });

    return { accountId: account.id, synced, downloaded, mirroredBytes, freeUsedToday: freeToday };
  } catch (e) {
    const status = e instanceof ChallengeError ? "challenge" : e instanceof AuthError ? "logged_out" : "error";
    await upsertAccount({
      id: account.id,
      status,
      lastError: e.message,
      lastErrorAt: Date.now(),
      needsChallenge: status === "challenge",
    });
    await logEvent("sync_failed", `[${account.label}] ${e.message}`, {
      accountId: account.id,
      code: e.code,
    });
    emit("sync_error", { accountId: account.id, message: e.message, status });
    return { accountId: account.id, error: e.message, status };
  }
}

export async function syncAll(opts = {}) {
  const accounts = await listAccounts();
  const out = [];
  for (const a of accounts) {
    if (a.status === "new" || a.status === "removed" || a.disabled) continue;
    out.push(await syncAccount(a, opts));
  }
  return out;
}

/**
 * 自适应同步：有任务在排队/生成时用快节奏（默认 20s），
 * 全空闲时退回慢节奏（默认 45s），避免空转和无谓的上游请求。
 */
export function startScheduler({ intervalMs = RUNTIME.syncIntervalMs, fastMs = RUNTIME.syncFastMs } = {}) {
  let timer = null;
  let busy = false;
  let stopped = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    let hasActive = false;
    try {
      await syncAll();
      const tasks = await listTasks({ limit: 200 });
      hasActive = tasks.some((t) => ["pending", "queued", "running"].includes(t.status));
    } catch (e) {
      await logEvent("scheduler_error", e.message);
    } finally {
      busy = false;
      if (!stopped) {
        timer = setTimeout(tick, hasActive ? fastMs : intervalMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(tick, 3000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
