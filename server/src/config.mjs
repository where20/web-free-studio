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

/**
 * 第二个上游：Veda Studio（免账号，纯 HTTP 通道）。
 * 额度以 /api/quota 实时读数为准；下面是兜底默认值与本地闸门参数。
 */
export const VEDA = {
  origin: "https://veda.hanxiao.run",
  entryPage: "https://veda.hanxiao.run/",
  // 用一个伪账号 id 分组任务与在途统计，避免和 Paba 的账号池混在一起
  accountId: "veda",
  dailyCreditsFallback: 20,
  // i18n 明确声明：同一网络每天最多 30 条视频（与设备数无关）
  networkDailyVideos: 30,
  // 单机两卡，堆太多只会一起变慢；超过就拒绝，提示等出片
  maxActive: Number(process.env.VEDA_MAX_ACTIVE || 4),
  pollActiveMs: Number(process.env.VEDA_POLL_MS || 8_000),
  pollIdleMs: Number(process.env.VEDA_POLL_IDLE_MS || 60_000),
};

/**
 * 第三个上游：SiftQ MiniMax-H3（匿名试用，纯 HTTP 通道）。
 * 硬限制：图生视频、仅 9:16、6/10/15s、匿名每日 2 条（按真实出口 IP）。
 * 只用上游给的额度：本地账本记 2 条/天，429 如实上报，不伪造 XFF / 不轮换身份。
 */
export const SIFTQ = {
  origin: "https://siftq.com",
  entryPage: "https://siftq.com/minimax-h3/try",
  referer: "https://siftq.com/minimax-h3/try/zh",
  accountId: "siftq",
  dailyLimit: Number(process.env.SIFTQ_DAILY_LIMIT || 2),
  showcaseId: process.env.SIFTQ_SHOWCASE_ID || "case-mtqzygu8",
  defaultPrompt:
    "Animate the scene in the image with natural, faithful motion. " +
    "Keep the subject and setting consistent with the input image.",
  imageMaxBytes: Number(process.env.SIFTQ_IMAGE_MAX_BYTES || 20 * 1024 * 1024),
  maxActive: Number(process.env.SIFTQ_MAX_ACTIVE || 2),
  pollActiveMs: Number(process.env.SIFTQ_POLL_MS || 8_000),
  pollIdleMs: Number(process.env.SIFTQ_POLL_IDLE_MS || 60_000),
  paths: {
    submit: "/api/minimax-trial/showcase/video-generation",
    job: (id) => `/api/minimax-trial/video-generation/${encodeURIComponent(id)}`,
    content: (id) => `/api/minimax-trial/video-generation/${encodeURIComponent(id)}/content`,
  },
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
    minDuration: 4,
    maxDuration: 15,
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    // 与上游 /v1/models 的 modes 对齐
    modes: [
      { id: "text", label: "文生视频", hint: "只用提示词" },
      { id: "reference", label: "全能参考", hint: "参考图 / 参考视频 / 参考音频任意组合" },
      { id: "first", label: "图生视频", hint: "给一张首帧图" },
      { id: "frames", label: "首尾帧", hint: "给首帧 + 尾帧，补中间过程" },
    ],
    // 上游 limits：reference 9 / motion 3 / sound 3
    limits: { referenceImages: 9, referenceVideos: 3, referenceAudios: 3 },
    maxDataUrlBytes: 8 * 1024 * 1024,
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
