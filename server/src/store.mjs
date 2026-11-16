import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, DB_FILE, PROFILE_DIR, ASSET_DIR } from "./config.mjs";

const EMPTY = {
  version: 1,
  createdAt: null,
  accounts: [],
  tasks: [],
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

export function taskKey(accountId, upstreamId) {
  return `${accountId}:${upstreamId}`;
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
    db.tasks.find((t) => t.accountId === accountId && t.upstreamId === upstreamId) || null
  );
}

export async function pruneTasks() {
  return update((db) => {
    db.tasks = db.tasks.slice(0, 4000);
  });
}
