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
  // 本地同网络上限兜底（保留谨慎闸；真实额度按 X-Fp 指纹分池，见 providers/veda-fp-pool.mjs）
  networkDailyVideos: 30,
  // 指纹池大小：默认 1 = 与官方行为一致；显式设置 >1 才多池（每池独立 20 credits/天）
  fpPoolSize: Number(process.env.VEDA_FP_POOL_SIZE || 1),
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

/**
 * 第四个上游：即梦 Dreamina（字节 passport 登录体系，AI 剧本/短剧工作台）。
 * 与 PabaTV 最大的差异：身份走 /passport/web/account/info，cookie 是字节全家桶
 * （sessionid / sid_tt / uid_tt / ttwid…），域名 .capcut.com，且没有任务列表接口。
 * 只接管真实登录态，不伪造身份 / 不换出口 IP / 不刷额度。
 */
export const DREAMINA = {
  origin: "https://dreamina.capcut.com",
  novelPage: "https://dreamina.capcut.com/ai-tool/novel",
  accountId: "dreamina",
  // 生成端点待抓（当前账号点数 0、生成按钮 disabled，无法拿到真实提交请求）
  dailyCreditsFallback: 0,
  maxActive: Number(process.env.DREAMINA_MAX_ACTIVE || 2),
};

/**
 * 平台差异集中在这里；lane / cookies / sync / api 一律按 account.provider 取值。
 * 缺省一律 paba，保证既有账号行为零变化。
 */
export const PROVIDERS = {
  paba: {
    id: "paba",
    origin: "https://www.paba.tv",
    videoPage: "https://www.paba.tv/#video",
    loginPage: "https://www.paba.tv/#video",
    challengePage: "https://www.paba.tv/__h3c/fresh.html",
    contentHost: "https://media.paba.tv",
    cookieDomain: "www.paba.tv",
    cookieNames: ["h3v", "h3s", "__Host-h3d"],
    identityCookie: "h3v",
    cookieDomainRe: /paba\.tv$/,
    cookieSetUrl: "https://www.paba.tv/",
    mePath: "/auth/me",
    loginPath: "/auth/account/login",
    parseMe: (j) => ({ ok: j?.ok === true, user_id: j?.user_id }),
    hasListTasks: true,
  },
  dreamina: {
    id: "dreamina",
    origin: DREAMINA.origin,
    videoPage: DREAMINA.novelPage,
    loginPage: DREAMINA.novelPage,
    challengePage: null,
    contentHost: null,
    cookieDomain: ".capcut.com",
    cookieNames: ["sessionid", "sessionid_ss", "sid_tt", "uid_tt", "uid_tt_ss", "ttwid", "msToken"],
    identityCookie: "sessionid",
    cookieDomainRe: /capcut\.com$/,
    cookieSetUrl: "https://dreamina.capcut.com/",
    mePath:
      "/passport/web/account/info/?aid=513641&account_sdk_source=web&sdk_version=2.1.10-tiktok&language=zh-CN",
    loginPath: null, // 字节登录带滑块/验证码，走浏览器人工登录或 cookie 导入
    parseMe: (j) => ({ ok: Boolean(j?.data?.user_id_str), user_id: j?.data?.user_id_str }),
    hasListTasks: false,
    creditUrl: "https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit",
  },
};

export function providerConfig(accountOrId) {
  const id =
    typeof accountOrId === "string"
      ? accountOrId
      : accountOrId?.provider || "paba";
  return PROVIDERS[id] || PROVIDERS.paba;
}

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
