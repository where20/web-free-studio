import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, DB_FILE, PROFILE_DIR, ASSET_DIR } from "./config.mjs";

const EMPTY = {
  version: 1,
  createdAt: null,
  accounts: [],
  tasks: [],
  usage: {},
  log: [],
};

let cache = null;
let writeChain = Promise.resolve();

async function ensureDirs() {
  for (const d of [DATA_DIR, PROFILE_DIR, ASSET_DIR]) {
    await fs.mkdir(d, { recursive: true });
  }
}

export async function load() {
  if (cache) return cache;
  await ensureDirs();
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    cache = { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    cache = { ...EMPTY, createdAt: new Date().toISOString() };
    await flush();
  }
  return cache;
}

export async function flush() {
  writeChain = writeChain.then(async () => {
    const tmp = path.join(DATA_DIR, `.db.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(cache, null, 1));
    await fs.rename(tmp, DB_FILE);
  });
  return writeChain;
}

/** 只读快照，避免调用方直接改内存 */
export async function snapshot() {
  const db = await load();
  return JSON.parse(JSON.stringify(db));
}

export async function update(mutator) {
  const db = await load();
  const ret = await mutator(db);
  await flush();
  return ret;
}

export async function logEvent(kind, message, extra = {}) {
  return update((db) => {
    db.log.unshift({ at: Date.now(), kind, message, ...extra });
    db.log = db.log.slice(0, 400);
  });
}

/* ---------- accounts ---------- */

export async function upsertAccount(patch) {
  return update((db) => {
    const i = db.accounts.findIndex((a) => a.id === patch.id);
    if (i >= 0) {
      db.accounts[i] = { ...db.accounts[i], ...patch, updatedAt: Date.now() };
      return db.accounts[i];
    }
    const acct = {
      id: patch.id,
      label: patch.label || patch.id,
      createdAt: Date.now(),
      status: "new",
      ...patch,
    };
    db.accounts.push(acct);
    return acct;
  });
}

export async function getAccount(id) {
  const db = await load();
  return db.accounts.find((a) => a.id === id) || null;
}

export async function listAccounts() {
  const db = await load();
  return db.accounts.map((a) => ({ ...a }));
}

/* ---------- tasks ---------- */

// 上游任务 id 全局唯一，直接用它做主键（同一任务可能被不同账号槽位抓过）
export function taskKey(_accountId, upstreamId) {
  return String(upstreamId);
}

export async function upsertTask(task) {
  return update((db) => {
    const key = taskKey(task.accountId, task.upstreamId);
    const i = db.tasks.findIndex((t) => taskKey(t.accountId, t.upstreamId) === key);
    if (i >= 0) {
      db.tasks[i] = { ...db.tasks[i], ...task, updatedAt: Date.now() };
      return db.tasks[i];
    }
    const row = { createdAt: Date.now(), ...task };
    db.tasks.unshift(row);
    return row;
  });
}

export async function listTasks({ accountId, limit = 200 } = {}) {
  const db = await load();
  let rows = db.tasks;
  if (accountId) rows = rows.filter((t) => t.accountId === accountId);
  return rows
    .slice()
    .sort((a, b) => (b.upstreamCreatedAt || b.createdAt) - (a.upstreamCreatedAt || a.createdAt))
    .slice(0, limit)
    .map((t) => ({ ...t }));
}

export async function getTask({ accountId, upstreamId }) {
  const db = await load();
  return (
    db.tasks.find((t) => t.upstreamId === upstreamId) ||
    db.tasks.find((t) => t.accountId === accountId && t.upstreamId === upstreamId) ||
    null
  );
}

export async function pruneTasks() {
  return update((db) => {
    // 按 upstreamId 去重：保留「有本地资产」或「更新时间较新」的那条
    const keep = new Map();
    for (const t of db.tasks) {
      const prev = keep.get(t.upstreamId);
      if (!prev) {
        keep.set(t.upstreamId, t);
        continue;
      }
      const better =
        (t.asset?.video && !prev.asset?.video) ||
        (!t.asset?.video === !prev.asset?.video && (t.updatedAt || 0) > (prev.updatedAt || 0));
      if (better) keep.set(t.upstreamId, t);
    }
    db.tasks = [...keep.values()]
      .sort((a, b) => (b.upstreamCreatedAt || b.createdAt) - (a.upstreamCreatedAt || a.createdAt))
      .slice(0, 4000);
  });
}

/* ---------- 每日免费额度账本（按「消耗次数」计） ---------- */

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function usageKey(accountId, day = dayKey()) {
  return `${accountId}:${day}`;
}

function blankUsage(accountId, day) {
  return { accountId, day, submitted: 0, failed: 0, refunded: 0, updatedAt: Date.now() };
}

/** 消耗次数 = 已提交成功 - 已退还 */
export function consumedOf(row) {
  if (!row) return 0;
  return Math.max(0, (row.submitted || 0) - (row.refunded || 0));
}

export async function getUsage(accountId, day = dayKey()) {
  const db = await load();
  return db.usage[usageKey(accountId, day)] || blankUsage(accountId, day);
}

export async function listUsage(day = dayKey()) {
  const db = await load();
  return Object.values(db.usage).filter((u) => u.day === day);
}

/**
 * 记一笔额度变化。
 * kind: "reserve" 预扣（提交前）/ "refund" 退还（提交失败）/ "fail" 仅记失败次数
 */
export async function bumpUsage(accountId, kind, day = dayKey()) {
  return update((db) => {
    const key = usageKey(accountId, day);
    const row = (db.usage[key] ||= blankUsage(accountId, day));
    if (kind === "reserve") row.submitted += 1;
    if (kind === "refund") row.refunded += 1;
    if (kind === "fail") row.failed += 1;
    row.updatedAt = Date.now();
    return { ...row, consumed: consumedOf(row) };
  });
}

/** 用户在上游页面手动提交过任务时，用上游当日免费条数校准本地账本（只上调，不下调） */
export async function reconcileUsage(accountId, upstreamFreeCount, day = dayKey()) {
  return update((db) => {
    const key = usageKey(accountId, day);
    const row = (db.usage[key] ||= blankUsage(accountId, day));
    if (upstreamFreeCount > consumedOf(row)) {
      row.submitted = upstreamFreeCount + (row.refunded || 0);
      row.reconciledAt = Date.now();
      row.updatedAt = Date.now();
    }
    return { ...row, consumed: consumedOf(row) };
  });
}

/** 该账号当前在途任务数（排队/生成中），用于限制并发提交 */export async function countActive(accountId) {
  const db = await load();
  return db.tasks.filter(
    (t) =>
      t.accountId === accountId &&
      ["pending", "queued", "running", "submitting"].includes(t.status),
  ).length;
}
