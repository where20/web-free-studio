/**
 * 提交队列：所有「生成」请求都排这里，不让并发直接把账号和免费额度打爆。
 *
 * 约束（对应上游的真实限制）：
 *  1) 全局并发 SUBMIT_CONCURRENCY       —— 同时最多几条在提交
 *  2) 单账号串行 + 最小间隔              —— 同一账号不会并发提交，避免触发风控
 *  3) 单账号在途上限 MAX_ACTIVE_PER_ACCOUNT —— 排队里堆太多只会一起变慢
 *  4) 每日免费额度 FREE_DAILY_LIMIT      —— 按「消耗次数」预扣，失败退还
 *  5) 幂等去重 DEDUP_WINDOW_MS           —— 同参数短时间重复提交直接复用
 */

import { RUNTIME, isFreeModel, FREE_MODELS } from "./config.mjs";
import {
  getAccount,
  upsertAccount,
  upsertTask,
  bumpUsage,
  getUsage,
  consumedOf,
  countActive,
  logEvent,
} from "./store.mjs";
import { laneFor, ChallengeError, AuthError, UpstreamError } from "./lane.mjs";
import { readCookies } from "./cookies.mjs";
import { emit } from "./events.mjs";

const jobs = new Map();
const pending = [];
const busyAccounts = new Set();
const lastSubmitAt = new Map();
let running = 0;
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fingerprint(payload) {
  return JSON.stringify([
    payload.model,
    payload.prompt,
    payload.duration,
    payload.resolution,
    payload.aspect_ratio,
    payload.style || "",
    payload.seed ?? null,
    payload.first_frame ? 1 : 0,
    (payload.reference_images || []).length,
  ]);
}

export function queueStats() {
  return {
    queued: pending.length,
    running,
    concurrency: RUNTIME.submitConcurrency,
    activeAccounts: [...busyAccounts],
    jobs: [...jobs.values()]
      .slice(-50)
      .reverse()
      .map((j) => ({
        id: j.id,
        accountId: j.accountId,
        status: j.status,
        upstreamId: j.upstreamId || null,
        error: j.error || null,
        attempts: j.attempts,
        queuedAt: j.queuedAt,
        finishedAt: j.finishedAt || null,
      })),
  };
}

export function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const { payload, ...rest } = j;
  return { ...rest, prompt: payload.prompt };
}

/** 入队前先做「能不能提交」的硬校验，早失败比排队后失败好 */
const bad = (msg) => Object.assign(new Error(msg), { code: "validation" });

export async function precheck({ accountId, payload }) {
  if (!payload.prompt) throw bad("prompt 不能为空");
  if (!isFreeModel(payload.model)) {
    throw bad(`当前只允许免费模型：${Object.keys(FREE_MODELS).join(" / ")}（付费模型会按秒扣积分，已禁用）`);
  }
  const account = accountId ? await getAccount(accountId) : null;
  if (accountId && !account) throw bad(`账号不存在：${accountId}`);
  if (account && account.disabled) throw bad(`账号 ${account.label} 已被停用`);
  if (account && account.status !== "online") {
    throw bad(`账号 ${account.label} 当前状态 ${account.status}，先授权/验证再提交`);
  }
  if (account) {
    // 没有登录态的账号不能提交，否则会借用浏览器里别人的会话（串号）
    if ((account.backend || "ego") !== "chrome" && !(await readCookies(account.id)).length) {
      throw bad(`账号 ${account.label} 还没有登录态，先在「编辑」里粘贴 Cookie 或用密码登录`);
    }
    const usage = await getUsage(account.id);
    if (consumedOf(usage) >= RUNTIME.freeDailyLimit) {
      throw bad(`账号 ${account.label} 今日免费额度已用完（${consumedOf(usage)}/${RUNTIME.freeDailyLimit}）`);
    }
    const active = await countActive(account.id);
    if (active >= RUNTIME.maxActivePerAccount) {
      throw bad(
        `账号 ${account.label} 已有 ${active} 条在排队/生成中（上限 ${RUNTIME.maxActivePerAccount}），等出片再提交`,
      );
    }
  }
}

export async function enqueue({ accountId, payload, label = "" }) {
  const fp = fingerprint(payload);
  const now = Date.now();
  for (const j of jobs.values()) {
    if (j.fingerprint === fp && now - j.queuedAt < RUNTIME.dedupWindowMs && j.status !== "failed") {
      return { jobId: j.id, deduped: true, job: getJob(j.id) };
    }
  }

  const id = `job-${++seq}-${now.toString(36)}`;
  const job = {
    id,
    accountId: accountId || null,
    payload,
    fingerprint: fp,
    label,
    status: "queued",
    attempts: 0,
    queuedAt: now,
    error: null,
    upstreamId: null,
  };
  jobs.set(id, job);
  pending.push(job);
  emit("job", { id, status: "queued", accountId: job.accountId });
  pump();
  return { jobId: id, deduped: false, job: getJob(id) };
}

function pump() {
  if (running >= RUNTIME.submitConcurrency) return;
  for (let i = 0; i < pending.length; i++) {
    const job = pending[i];
    if (job.accountId && busyAccounts.has(job.accountId)) continue;
    // 账号未指定时先解析，避免同一个账号被并发占用
    pending.splice(i, 1);
    run(job);
    i -= 1;
    if (running >= RUNTIME.submitConcurrency) return;
  }
}

async function run(job) {
  running += 1;
  job.status = "running";
  emit("job", { id: job.id, status: "running" });

  let accountId = job.accountId;
  try {
    if (!accountId) {
      accountId = await pickAccountId();
      job.accountId = accountId;
    }
    busyAccounts.add(accountId);

    // 单账号最小提交间隔
    const last = lastSubmitAt.get(accountId) || 0;
    const wait = RUNTIME.minSubmitIntervalMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);

    const account = await getAccount(accountId);
    if (!account) throw new Error("账号不存在");
    if (account.status !== "online") throw new Error(`账号状态 ${account.status}`);

    // 预扣一次额度
    const usage = await bumpUsage(accountId, "reserve");
    if (consumedOf(usage) > RUNTIME.freeDailyLimit) {
      await bumpUsage(accountId, "refund");
      throw new Error(`免费额度已用完（${RUNTIME.freeDailyLimit} 次/天）`);
    }

    const lane = laneFor(account);
    let upstream = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      job.attempts = attempt;
      try {
        upstream = await lane.createVideo(job.payload);
        break;
      } catch (e) {
        lastErr = e;
        // 认证/人机验证/上游容量限制都不该重试
        if (e instanceof ChallengeError || e instanceof AuthError) break;
        if (e instanceof UpstreamError) {
          const type = e.payload?.error?.type;
          if (type === "too_many_pending" || type === "duplicate_submission") break;
          if (e.status === 429 || e.status >= 500) {
            await sleep(2000 * attempt);
            continue;
          }
        }
        break;
      }
    }

    if (!upstream) {
      await bumpUsage(accountId, "refund");
      await bumpUsage(accountId, "fail");
      throw lastErr || new Error("提交失败");
    }

    const upstreamId = upstream.request_id || upstream.id;
    job.upstreamId = upstreamId;
    job.status = "submitted";
    job.finishedAt = Date.now();
    const submittedAt = Date.now();
    lastSubmitAt.set(accountId, submittedAt);
    // 持久化「最近提交时间」：pickAccountId 的「最久未用」轮询维度靠它生效
    // （内存 Map 只在本进程有效，重启后丢失；账号字段才是跨重启的真值）
    await upsertAccount({ id: accountId, lastSubmitAt: submittedAt }).catch(() => {});

    await upsertTask({
      accountId,
      upstreamId,
      status: upstream.status || "pending",
      queueState: upstream.queue_state,
      queuePosition: upstream.queue_position,
      queueEtaSeconds: upstream.queue_eta_seconds,
      model: upstream.model || job.payload.model,
      tier: upstream.tier,
      tierCn: upstream.tier_cn,
      prompt: job.payload.prompt,
      duration: job.payload.duration,
      resolution: job.payload.resolution,
      aspectRatio: job.payload.aspect_ratio,
      seed: upstream.seed,
      billing: upstream.billing || null,
      upstreamCreatedAt: (upstream.created_at || Date.now() / 1000) * 1000,
      submittedLocally: true,
      jobId: job.id,
    });

    const after = await getUsage(accountId);
    await logEvent(
      "submitted",
      `[${account.label}] ${upstreamId} ${job.payload.model} ${job.payload.duration}s · 今日第 ${consumedOf(after)} 次`,
      { accountId },
    );
    emit("task", { accountId, upstreamId, status: "pending" });
    emit("job", { id: job.id, status: "submitted", upstreamId, accountId });
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
    job.code = e.payload?.error?.type || e.code || "error";
    job.finishedAt = Date.now();
    const code = e.code;
    if (code === "challenge_required") {
      const { upsertAccount } = await import("./store.mjs");
      await upsertAccount({ id: job.accountId, status: "challenge", needsChallenge: true, lastError: e.message });
    }
    await logEvent("submit_failed", `提交失败：${e.message}`, { accountId: job.accountId, code });
    emit("job", { id: job.id, status: "failed", error: e.message, accountId: job.accountId });
  } finally {
    if (job.accountId) busyAccounts.delete(job.accountId);
    running -= 1;
    pump();
  }
}

/**
 * 轮询排序（纯函数，便于单测）：
 *   在途少 → 今日消耗少 → 最久未提交（last）
 * 消耗维度天然拉平各账号用量；消耗/在途相同时用 last 打破平局，
 * 保证每次提交都轮到下一个账号，而不是总挑同一个。
 */
export function rankAccounts(scored) {
  return scored
    .slice()
    .sort((a, b) => a.active - b.active || a.consumed - b.consumed || a.last - b.last);
}

/** 未指定账号时的自适应轮询选择：在线可用账号里按 rankAccounts 挑第一个 */
export async function pickAccountId(provider = "paba") {
  const { listAccounts } = await import("./store.mjs");
  // 严格按 provider 隔离：Paba 排产绝不挑到 Dreamina 账号（域名/cookie 不通用）
  const accounts = (await listAccounts()).filter(
    (a) => (a.provider || "paba") === provider && a.status === "online" && !a.disabled,
  );
  if (!accounts.length) throw new Error("没有可用账号，请先授权");
  const scored = [];
  for (const a of accounts) {
    if ((a.backend || "ego") !== "chrome" && !(await readCookies(a.id)).length) continue;
    const usage = await getUsage(a.id);
    const active = await countActive(a.id);
    if (consumedOf(usage) >= RUNTIME.freeDailyLimit) continue;
    if (active >= RUNTIME.maxActivePerAccount) continue;
    scored.push({ id: a.id, active, consumed: consumedOf(usage), last: a.lastSubmitAt || 0 });
  }
  if (!scored.length) throw new Error("所有账号都已到额度/在途上限，等出片后再提交");
  return rankAccounts(scored)[0].id;
}

export async function waitJob(id, timeoutMs = RUNTIME.jobTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = getJob(id);
    if (!j) return null;
    if (j.status === "submitted" || j.status === "failed") return j;
    await sleep(400);
  }
  return getJob(id);
}
