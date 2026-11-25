/**
 * 即梦 Dreamina 生成编排层（独立模块，零侵入 Paba/Veda/SiftQ）。
 *
 * 只共用 store（任务库/账本）与 events（SSE），业务全在本文件与 providers/dreamina.mjs。
 * 生成走 agent 短剧会话通道：submit_run → get_thread 轮询 → query_artifact → 镜像。
 *
 * 边界：只接真实登录态，不伪造身份/不换出口 IP/不刷额度；额度耗尽如实上报。
 */

import { DREAMINA } from "./config.mjs";
import { listAccounts, getAccount, upsertAccount, upsertTask, getTask, listTasks, logEvent, bumpUsage, dayKey } from "./store.mjs";
import { emit } from "./events.mjs";
import { laneFor } from "./lane.mjs";
import {
  DreaminaError,
  submitRun,
  getThread,
  findRun,
  queryArtifact,
  toTaskRow,
  isTerminal,
  mirrorDreamina,
  normalizeResolution,
  rankDreaminaAccounts,
  coolingAccounts,
} from "./providers/dreamina.mjs";

const bad = (msg, extra = {}) => new DreaminaError(msg, { code: "validation", ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 近 60s 同参数去重，避免手抖重复提交扣额度 */
const recent = new Map();
const DEDUP_MS = 60_000;

function fingerprint(input) {
  return JSON.stringify([
    String(input.prompt || "").trim(),
    Number(input.duration || 10),
    String(input.aspect || "16:9"),
    normalizeResolution(input.resolution),
  ]);
}

/** 取一个可用的 dreamina 账号（严格按 provider 隔离；跳过冷却中的账号） */
async function pickDreaminaAccount() {
  const all = (await listAccounts()).filter((a) => (a.provider || "paba") === "dreamina");
  const online = all.filter((a) => a.status === "online" && !a.disabled);
  if (!online.length) throw bad("没有在线的即梦账号，请先在账号池接管/导入登录态", { code: "no_account" });

  const activeById = {};
  for (const a of online) {
    activeById[a.id] = (await listTasks({ accountId: a.id, limit: 200 })).filter((t) => !isTerminal(t.status)).length;
  }

  const ranked = rankDreaminaAccounts(online, activeById, { maxActive: DREAMINA.maxActive });
  if (ranked.length) return ranked[0];

  // 都不可用：区分「全部冷却中」和「全部在生成中」，别只给一句模糊的报错
  const cooling = coolingAccounts(online);
  if (cooling.length === online.length) {
    const mins = Math.max(1, Math.ceil(cooling[0].waitSec / 60));
    throw bad(
      `所有即梦账号都在限流冷却中（${cooling.map((c) => `${c.label} ${Math.ceil(c.waitSec / 60)}min`).join("、")}），约 ${mins} 分钟后可再提交；别急着连续重试，会延长冷却`,
      { code: "cooldown" },
    );
  }
  throw bad("所有即梦账号都在生成中，等出片再提交", { code: "too_many_pending" });
}

/** 今日提交条数（本地账本） */
async function submittedToday(accountId) {
  const rows = await listTasks({ provider: "dreamina", limit: 2000 });
  return rows.filter(
    (t) =>
      t.accountId === accountId &&
      t.status !== "failed" &&
      dayKey(t.createdAt || Date.now()) === dayKey(),
  ).length;
}

export async function dreaminaOverview() {
  const out = { provider: "dreamina", origin: DREAMINA.origin, ok: false };
  try {
    const accounts = (await listAccounts()).filter((a) => (a.provider || "paba") === "dreamina");
    const online = accounts.filter((a) => a.status === "online" && !a.disabled);
    const tasks = await listTasks({ provider: "dreamina", limit: 500 });
    const active = tasks.filter((t) => !isTerminal(t.status)).length;
    const done = tasks.filter((t) => t.status === "done").length;
    out.ok = online.length > 0;
    out.accounts = accounts.map((a) => ({
      id: a.id,
      label: a.label,
      status: a.status,
      upstreamUserId: a.upstreamUserId,
      threadBound: Boolean(a.dreaminaThreadId),
      cooldownUntil: Number(a.cooldownUntil) > Date.now() ? Number(a.cooldownUntil) : null,
      cooldownReason: Number(a.cooldownUntil) > Date.now() ? a.lastCooldownReason || "限流冷却" : null,
      submittedToday: a.status === "new" || a.status === "removed" ? 0 : null,
    }));
    out.session = {
      projectId: DREAMINA.projectId,
      threadId: DREAMINA.threadId,
      note: "复用已建短剧会话；可用 DREAMINA_PROJECT_ID / DREAMINA_THREAD_ID 环境变量覆盖",
    };
    out.quota = {
      localDailyLimit: DREAMINA.dailyCreditsFallback,
      active,
      done,
      upstream: "即梦点数由上游控制，本地只做保守账本；额度耗尽如实上报",
    };
    out.config = { maxActive: DREAMINA.maxActive, appId: DREAMINA.appId, agentName: DREAMINA.agentName };
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

export async function dreaminaPrecheck(input, account) {
  if (!input.prompt || !String(input.prompt).trim()) throw bad("prompt 不能为空");
  const d = Number(input.duration || 10);
  if (!Number.isFinite(d) || d < 4 || d > 20) throw bad("时长需在 4-20 秒之间");
  if (!account) throw bad("没有可用的即梦账号");
  if (account.status !== "online") throw bad(`账号 ${account.label} 当前 ${account.status}，先接管/授权`);

  const submitted = await submittedToday(account.id);
  if (submitted >= DREAMINA.dailyCreditsFallback) {
    throw bad(
      `即梦本地账本今日已提交 ${submitted}/${DREAMINA.dailyCreditsFallback} 条（保守闸门）。` +
        `上游点数不足会由 submit_run 返回额度错误，届时如实上报。`,
      { code: "quota_exhausted" },
    );
  }
}

export async function dreaminaGenerate(input) {
  const fp = fingerprint(input);
  const hit = recent.get(fp);
  if (hit && Date.now() - hit.at < DEDUP_MS) {
    const row = await getTask({ accountId: hit.accountId, upstreamId: hit.upstreamId });
    if (row) return { deduped: true, upstreamId: hit.upstreamId, task: row };
  }

  const account = input.accountId
    ? await getAccount(input.accountId)
    : await pickDreaminaAccount();
  if (!account || (account.provider || "paba") !== "dreamina") throw bad("账号不是即梦平台");
  await dreaminaPrecheck(input, account);

  const lane = laneFor(account);
  // 多账号时每个号必须绑定自己的会话（thread 属于具体账号，借用别人的会 404 或串会话）
  if (!account.dreaminaThreadId) {
    const peers = (await listAccounts()).filter(
      (a) => (a.provider || "paba") === "dreamina" && a.status === "online" && !a.disabled,
    );
    if (peers.length > 1) {
      throw bad(
        `账号「${account.label || account.id}」还没绑定自己的即梦会话（thread）。多账号必须各自绑定，否则会串会话/被上游拒绝。请在该账号接管时录入 agent_thread_id`,
        { code: "no_thread" },
      );
    }
  }

  // 从账号拿会话参数（如有），否则用配置默认
  const session = {
    projectId: account.dreaminaProjectId || DREAMINA.projectId,
    threadId: account.dreaminaThreadId || DREAMINA.threadId,
    workspaceId: account.dreaminaWorkspaceId || DREAMINA.workspaceId,
    consumerUid: account.upstreamUserId || "",
  };

  let sub;
  try {
    sub = await submitRun(lane, input, session);
  } catch (e) {
    if (e.code === "quota_exhausted") {
      await bumpUsage(account.id, "fail");
      throw bad(`即梦额度不足：${e.message}`, { code: "quota_exhausted" });
    }
    // 提交就撞上限流：同样给这个号上冷却，避免前端连点反复打
    if (/429|繁忙|busy|频率|超出限制|rate limit/i.test(String(e.message || ""))) {
      await upsertAccount({
        ...account,
        cooldownUntil: Date.now() + DREAMINA.accountCooldownMs,
        lastCooldownReason: "429 限流（提交阶段）",
      }).catch(() => {});
    }
    throw e;
  }

  const row = {
    ...toTaskRow({ status: "queued", state: 1 }),
    accountId: account.id,
    provider: "dreamina",
    upstreamId: sub.upstreamId,
    prompt: sub.prompt,
    model: "seedance-2.5-dreamina",
    duration: sub.duration,
    aspectRatio: sub.aspect,
    resolution: sub.resolution,
    submittedLocally: true,
  };
  await upsertTask(row);
  await bumpUsage(account.id, "reserve");
  await upsertAccount({ id: account.id, lastSubmitAt: Date.now() });
  recent.set(fp, { at: Date.now(), upstreamId: sub.upstreamId, accountId: account.id });

  await logEvent("dreamina_submitted", `[即梦] ${sub.upstreamId} ${sub.duration}s ${sub.aspect} · 会话 ${session.threadId.slice(0, 8)}`, {
    accountId: account.id,
  });
  emit("task", { provider: "dreamina", upstreamId: sub.upstreamId, status: "queued" });
  return { deduped: false, upstreamId: sub.upstreamId, accountId: account.id, task: row };
}

/** 同步单个 run：查 thread → 落库 → 完成时拿产物并镜像 */
export async function dreaminaSyncJob(upstreamId, accountId) {
  const prev = await getTask({ accountId, upstreamId });
  if (!prev) return null;
  if (isTerminal(prev.status) && prev.asset?.video) return prev;

  // 收口：标了「已完成」但 3 次都拿不到产物直链 → 上游实际是失败的（限流/回收），
  // 别再让它挂着「已完成但没有视频」，也别再反复重试。
  if (prev.status === "done" && !prev.asset?.video && (prev.assetAttempts || 0) >= 3) {
    const closed = await upsertTask({
      ...prev,
      status: "failed",
      stage: "生成失败",
      failReason: (typeof prev.failReason === "string" && prev.failReason)
        || `3 次拿不到产物直链（${prev.assetError || "上游未给视频"}），判为失败`,
      assetSkipUntil: 0,
      finishedAt: prev.finishedAt || Date.now(),
    });
    await bumpUsage(accountId, "refund");
    await logEvent("dreamina_failed", `[即梦] ${upstreamId} 无产物直链，收口判失败并退还额度`, { accountId }).catch(() => {});
    emit("task", { provider: "dreamina", upstreamId, status: "failed" });
    return closed;
  }

  const account = await getAccount(accountId);
  if (!account) return prev;
  const threadId = account.dreaminaThreadId || DREAMINA.threadId;
  const lane = laneFor(account);

  let snap;
  try {
    const thread = await getThread(lane, threadId);
    snap = findRun(thread, upstreamId);
  } catch (e) {
    await upsertTask({ ...prev, lastError: e.message, lastErrorAt: Date.now(), pollErrors: (prev.pollErrors || 0) + 1 });
    return prev;
  }
  if (!snap) {
    // 会话里查不到这条 run：可能被上游回收，也可能 thread 太老。
    // 不能按「最后一条 run」猜状态 —— 连续 3 次查不到就标 stale 收口，
    // 否则它会一直显示「生成中」并占住在途槽位。
    const miss = (prev.missCount || 0) + 1;
    const patch = {
      ...prev,
      missCount: miss,
      lastError: "上游会话里查不到该 run",
      lastErrorAt: Date.now(),
    };
    if (miss >= 3 && !isTerminal(prev.status)) {
      patch.status = "stale";
      patch.stage = "上游查不到";
      patch.failReason = prev.failReason || "上游会话里找不到这条 run（可能已被回收），本地保留记录可手动删除";
      patch.finishedAt = Date.now();
      await logEvent("dreamina_stale", `[即梦] ${upstreamId} 上游会话查不到，标记 stale`, { accountId }).catch(() => {});
      emit("task", { provider: "dreamina", upstreamId, status: "stale" });
    }
    return upsertTask(patch);
  }

  const row = { ...toTaskRow(snap), upstreamId, accountId, provider: "dreamina", prompt: prev.prompt, missCount: 0 };
  const changed = row.status !== prev.status || row.stage !== prev.stage;
  const merged = await upsertTask({ ...row, asset: prev.asset || null });
  if (changed) emit("task", { provider: "dreamina", upstreamId, status: merged.status });

  if (merged.status === "done" && merged.artifactId && !merged.asset?.video) {
    if ((merged.assetAttempts || 0) >= 3 && (merged.assetSkipUntil || 0) > Date.now()) return merged;
    try {
      const art = await queryArtifact(lane, merged.artifactId);
      const asset = await mirrorDreamina(upstreamId, art);
      const done = await upsertTask({
        ...merged,
        artifactId: merged.artifactId,
        asset: { video: asset.file, rel: asset.rel, bytes: asset.bytes, url: art.url, savedAt: Date.now() },
        assetAttempts: 0,
        assetError: null,
        assetSkipUntil: 0,
      });
      await logEvent("dreamina_mirror_ok", `[即梦] ${upstreamId} 已落本地 ${(asset.bytes / 1048576).toFixed(1)}MB`, { accountId });
      emit("asset", { provider: "dreamina", upstreamId, bytes: asset.bytes, video: `/assets/${asset.rel}` });
      return done;
    } catch (e) {
      const attempts = (merged.assetAttempts || 0) + 1;
      // 连续 3 次拿不到直链就不再死等：上游这条多半是失败的（限流/回收），
      // 继续重试只会让它一直是「已完成但没有产物」的僵尸行。
      if (attempts >= 3) {
        await upsertTask({
          ...merged,
          status: "failed",
          stage: "生成失败",
          failReason: merged.failReason || `产物查不到视频直链（${e.message}），上游可能已失败或回收`,
          assetAttempts: attempts,
          assetError: e.message,
          assetSkipUntil: 0,
          finishedAt: Date.now(),
        });
        await bumpUsage(accountId, "refund");
        await logEvent("dreamina_failed", `[即梦] ${upstreamId} 3 次拿不到产物直链，判失败并退还额度：${e.message}`, { accountId });
        emit("task", { provider: "dreamina", upstreamId, status: "failed" });
        return getTask({ accountId, upstreamId });
      }
      await upsertTask({
        ...merged,
        assetAttempts: attempts,
        assetError: e.message,
        assetSkipUntil: Date.now() + 30 * 60_000,
      });
      await logEvent("dreamina_mirror_failed", `[即梦] ${upstreamId} 镜像失败（第 ${attempts} 次）：${e.message}`, { accountId });
    }
  } else if (changed && merged.status === "failed") {
    await bumpUsage(accountId, "refund");
    await logEvent("dreamina_failed", `[即梦] ${upstreamId} 失败：${merged.failReason || "上游未给原因"}`, { accountId });
    // 限流类失败 → 这个号进冷却，后续提交自动切到别的号（多账号时才有意义）
    if (/限流|429|繁忙|频率|超出限制/i.test(String(merged.failReason || ""))) {
      const until = Date.now() + DREAMINA.accountCooldownMs;
      const acct = await getAccount(accountId);
      if (acct) {
        await upsertAccount({ ...acct, cooldownUntil: until, lastCooldownReason: "429 限流" });
        const mins = Math.round(DREAMINA.accountCooldownMs / 60000);
        await logEvent("dreamina_account_cooldown", `[即梦] ${acct.label || accountId} 进入限流冷却 ${mins} 分钟，期间不再派活`, { accountId });
      }
    }
  }
  return merged;
}

export async function dreaminaSyncAll() {
  const rows = await listTasks({ provider: "dreamina", limit: 500 });
  const active = rows.filter((t) => !isTerminal(t.status) || (t.status === "done" && !t.asset?.video));
  let synced = 0;
  for (const t of active) {
    // 退避中的任务先跳过；但「已试满 3 次仍无产物」的要放行去收口，别让它僵尸挂着
    if ((t.assetSkipUntil || 0) > Date.now() && (t.assetAttempts || 0) < 3) continue;
    await dreaminaSyncJob(t.upstreamId, t.accountId);
    synced += 1;
    await sleep(300);
  }
  return { synced, candidates: active.length };
}

/** 自适应调度：有在途 10s，全空闲 60s */
export function startDreaminaScheduler() {
  let timer = null;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    let hasActive = false;
    try {
      const out = await dreaminaSyncAll();
      hasActive = out.candidates > 0;
    } catch (e) {
      await logEvent("dreamina_scheduler_error", e.message).catch(() => {});
    } finally {
      busy = false;
      if (!stopped) {
        timer = setTimeout(tick, hasActive ? DREAMINA.pollActiveMs : DREAMINA.pollIdleMs);
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
