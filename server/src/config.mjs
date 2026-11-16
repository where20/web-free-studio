import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DATA_DIR = path.join(ROOT, "data");
export const PROFILE_DIR = path.join(DATA_DIR, "profiles");
export const ASSET_DIR = path.join(DATA_DIR, "assets");
export const DB_FILE = path.join(DATA_DIR, "db.json");
export const WEB_DIR = path.join(ROOT, "web");

export const UPSTREAM = {
  origin: "https://www.paba.tv",
  api: "https://www.paba.tv",
  videoPage: "https://www.paba.tv/#video",
  loginPage: "https://www.paba.tv/#video",
  challengePage: "https://www.paba.tv/__h3c/fresh.html",
  contentHost: "https://media.paba.tv",
};

export const RUNTIME = {
  port: Number(process.env.PORT || 8790),
  headless: process.env.HEADED === "1" ? false : true,
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 45_000),
  syncFastMs: Number(process.env.SYNC_FAST_MS || 20_000),
  listLimit: 40,
  challengeTimeoutMs: Number(process.env.CHALLENGE_TIMEOUT_MS || 150_000),
  mirrorPerSync: Number(process.env.MIRROR_PER_SYNC || 6),
  freeDailyLimit: Number(process.env.FREE_DAILY_LIMIT || 15),
  // 上游硬限制：免费档每账号最多 2 条「排队/生成中」（429 too_many_pending，实测）
  maxActivePerAccount: Number(process.env.MAX_ACTIVE_PER_ACCOUNT || 2),
  submitConcurrency: Number(process.env.SUBMIT_CONCURRENCY || 2),
  minSubmitIntervalMs: Number(process.env.MIN_SUBMIT_INTERVAL_MS || 4000),
  dedupWindowMs: Number(process.env.DEDUP_WINDOW_MS || 60_000),
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 180_000),
  debugPortBase: Number(process.env.CHROME_DEBUG_PORT || 9333),
};

/**
 * 模型白名单：只放免费档。
 * minimax-h3-flash 在 768p 全时长计费为 0（每日 15 条），其余模型都是按秒扣积分，暂时禁掉。
 */
export const FREE_MODELS = {
  "minimax-h3-flash": {
    id: "minimax-h3-flash",
    label: "MiniMax H3 Flash",
    note: "免费档 · 每天 15 次 · 普通排队",
    resolutions: ["768p"],
    maxDuration: 15,
  },
};

export function isFreeModel(id) {
  return Object.prototype.hasOwnProperty.call(FREE_MODELS, id);
}


export const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function chromePath() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}
