import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME, WEB_DIR, ASSET_DIR, UPSTREAM, FREE_MODELS, PROFILE_DIR, providerConfig } from "./config.mjs";
import {
  snapshot,
  listAccounts,
  getAccount,
  upsertAccount,
  upsertTask,
  getTask,
  listTasks,
  logEvent,
  pruneTasks,
  removeTask,
  getUsage,
  consumedOf,
  countActive,
  dayKey,
} from "./store.mjs";
import { laneFor, AuthError, ChallengeError } from "./lane.mjs";
import { precheck, enqueue, waitJob, pickAccountId, queueStats, getJob } from "./queue.mjs";
import { readCookies, writeCookies, deleteCookies, writeCred, readCred, maskCookies } from "./cookies.mjs";
import { getBrowser, stopBrowser } from "./chrome.mjs";
import { syncAccount, syncAll } from "./sync.mjs";
import { addClient, emit } from "./events.mjs";
import { Page, sleep } from "./cdp.mjs";
import { vedaOverview, vedaGenerate, vedaSyncAll, vedaCancelJob } from "./veda-service.mjs";
import { siftqOverview, siftqGenerate, siftqSyncAll } from "./siftq-service.mjs";
import { dreaminaOverview, dreaminaGenerate, dreaminaSyncAll } from "./dreamina-service.mjs";
import { buildVoiceover, buildAllTones } from "./providers/voiceover.mjs";
import { precheckPrompt } from "./providers/precheck.mjs";
import { planDuration } from "./providers/duration-plan.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

async function serveStatic(res, baseDir, relPath) {
  const full = path.resolve(baseDir, "." + path.posix.normalize("/" + relPath));
  if (!full.startsWith(baseDir)) return json(res, 403, { error: "forbidden" });
  const stat = await fs.stat(full).catch(() => null);
  if (!stat || !stat.isFile()) return json(res, 404, { error: "not found" });
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": ext === ".mp4" || ext === ".jpg" ? "public, max-age=86400" : "no-store",
    "Accept-Ranges": "bytes",
  });
  fssync.createReadStream(full).pipe(res);
}

function accountView(a) {
  const { headless, ...rest } = a;
  return rest;
}

const bad = (msg) => Object.assign(new Error(msg), { code: "validation" });

const isDataUrl = (v) => typeof v === "string" && /^data:[a-z0-9.+/-]+;base64,/i.test(v);

/**
 * 组装提交体。参考素材（参考图/视频/音频、首帧/尾帧）都是 data URL，
 * 与上游前端一致；模式校验在本地先做一遍，避免白扣一次额度。
 */
export function buildVideoPayload(input) {
  const model = FREE_MODELS[input.model] ? input.model : "minimax-h3-flash";
  const cfg = FREE_MODELS[model];
  const mode = ["text", "reference", "first", "frames"].includes(input.mode) ? input.mode : "text";
  const prompt = String(input.prompt || "").trim();

  const refImages = (input.referenceImages || []).filter(isDataUrl);
  const refVideos = (input.referenceVideos || []).filter((v) => v && isDataUrl(v.data));
  const refAudios = (input.referenceAudios || []).filter(isDataUrl);
  const firstFrame = isDataUrl(input.firstFrame) ? input.firstFrame : null;
  const lastFrame = isDataUrl(input.lastFrame) ? input.lastFrame : null;

  const hasRef = refImages.length || refVideos.length || refAudios.length;
  if (mode === "reference" && !hasRef) throw bad("全能参考至少要接一个参考图 / 参考视频 / 参考音频");
  if (mode === "first" && !firstFrame) throw bad("图生视频需要一张首帧图片");
  if (mode === "frames" && (!firstFrame || !lastFrame)) throw bad("首尾帧需要首帧和尾帧两张图片");
  if (mode === "text" && (hasRef || firstFrame || lastFrame)) {
    throw bad("文生视频不使用参考素材，请切到「全能参考」或「图生视频」");
  }
  if (refImages.length > cfg.limits.referenceImages) throw bad(`参考图最多 ${cfg.limits.referenceImages} 张`);
  if (refVideos.length > cfg.limits.referenceVideos) throw bad(`参考视频最多 ${cfg.limits.referenceVideos} 个`);
  if (refAudios.length > cfg.limits.referenceAudios) throw bad(`参考音频最多 ${cfg.limits.referenceAudios} 个`);

  const totalBytes = [...refImages, ...refVideos.map((v) => v.data), ...refAudios, firstFrame, lastFrame]
    .filter(Boolean)
    .reduce((sum, v) => sum + v.length, 0);
  if (totalBytes > 24 * 1024 * 1024) throw bad("参考素材总大小超过 24MB，先压缩或减少数量");

  const duration = Math.min(cfg.maxDuration, Math.max(cfg.minDuration, Number(input.duration || 5)));
  const body = {
    channel_id: input.channelId || "",
    model,
    model_v: 2,
    prompt,
    duration,
    resolution: input.resolution || cfg.resolutions[0],
    aspect_ratio: input.aspectRatio || "16:9",
  };
  if (input.tier) body.tier = input.tier;
  if (input.style) body.style = input.style;
  if (Number.isFinite(Number(input.seed))) body.seed = Number(input.seed);

  if (mode === "first") body.first_frame = firstFrame;
  else if (mode === "frames") {
    body.first_frame = firstFrame;
    body.last_frame = lastFrame;
  } else if (mode === "reference") {
    if (refImages.length) body.reference_images = refImages;
    if (refVideos.length) {
      body.reference_videos = refVideos.map((v) => ({
        data: v.data,
        with_audio: Boolean(v.withAudio),
        ...(v.duration ? { duration: Number(v.duration) } : {}),
      }));
    }
    if (refAudios.length) body.reference_audios = refAudios;
  }
  return body;
}

/**
 * 提交入口：统一走提交队列（默认等待结果，便于 CLI 直接拿 upstreamId）。
 * 传 { async: true } 立刻返回 jobId，由 SSE/轮询跟进。
 */
export async function generate(input) {
  const payload = buildVideoPayload(input);
  const accountId = input.accountId || (await pickAccountId());
  await precheck({ accountId, payload });
  const { jobId, deduped } = await enqueue({ accountId, payload, label: input.label || "" });
  if (input.async) return { jobId, accountId, deduped, status: "queued" };
  const job = await waitJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (job.status === "failed") {
    throw Object.assign(new Error(job.error || "提交失败"), { code: job.code || "error" });
  }
  if (job.status !== "submitted") throw new Error("提交超时，任务仍在队列中");
  return { jobId, accountId, upstreamId: job.upstreamId, deduped, status: "submitted" };
}

async function ensureBrowser(accountId, { headless }) {
  const browser = getBrowser(accountId, { headless });
  try {
    const task = (async () => {
      const alive = await browser.alive();
      if (!alive) await browser.launch();
      else if (!headless && browser.headless) await browser.relaunch(false); // 需要可见窗口（人工登录/验证）
      return browser;
    })();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("启动超时（30s）")), 30_000),
    );
    return await Promise.race([task, timeout]);
  } catch (e) {
    throw Object.assign(
      new Error(
        `本机 Chrome 起不来：${e.message}。可改用「导入 Cookie」接入，或在普通终端运行 npm run account。`,
      ),
      { code: "chrome_unavailable" },
    );
  }
}

/**
 * ego 后端版授权：在 ego 浏览器该账号专属 taskSpace 里打开登录页并聚焦，
 * 由用户人工登录；Node 侧轮询身份接口，成功后回读 cookie 落盘 + 同步。
 * 不启动本机 Chrome —— 本机 Chrome 在部分环境 CDP 一起来就断（见 loginAccount 的 chrome 分支）。
 */
async function loginAccountEgo(account, { timeoutMs = 300_000 } = {}) {
  const cfg = providerConfig(account);
  const lane = laneFor(account); // EgoLane（backend=ego）
  if (typeof lane.execRaw !== "function" || typeof lane.readBrowserCookies !== "function") {
    throw Object.assign(new Error("当前车道不支持 ego 授权"), { code: "ego_unavailable" });
  }
  // 单次 evaluate 自带 15s 超时（ego 的 evaluate 有硬上限），避免把车道挂死
  const meExpr = `(async()=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),15000);try{const r=await fetch(${JSON.stringify(cfg.mePath)},{credentials:'include',cache:'no-store',signal:c.signal});const x=await r.text();try{return JSON.parse(x)}catch{return null}}catch{return null}finally{clearTimeout(t)}})()`;
  const script = `
const SPACE = ${JSON.stringify(lane.spaceName)};
const entry = (await listTaskSpaces()).find((s) => s.name === SPACE);
const task = entry ? await taskSpace(entry.id) : await taskSpace(SPACE);
let page = (await task.pages())[0] || (await task.newPage());
const cur = String(await page.url() || "");
if (!cur.startsWith(${JSON.stringify(cfg.origin)})) {
  await page.goto(${JSON.stringify(cfg.loginPage)}, { timeout: 60000 });
}
try { await page.focus(); } catch {}
const parseMe = ${cfg.parseMe.toString()};
const deadline = Date.now() + ${timeoutMs};
let me = null;
while (Date.now() < deadline) {
  const raw = await page.evaluate(${JSON.stringify(meExpr)});
  const v = raw && typeof raw === "object" ? raw : null;
  const parsed = v ? parseMe(v) : null;
  if (parsed && parsed.ok) { me = Object.assign({}, v, parsed); break; }
  await page.waitForTimeout(2000);
}
console.log("__FS__" + JSON.stringify({ ok: !!me, me }));
`;
  let out;
  try {
    out = await lane.execRaw(script, timeoutMs + 60_000);
  } catch (e) {
    throw Object.assign(new Error(`ego 授权窗口起不来：${e.message}`), { code: "ego_unavailable" });
  }
  if (!out?.ok) throw new Error("登录等待超时（ego 窗口内未完成登录）");
  // 回读浏览器 cookie 落盘。execRaw 不注入旧 cookie，避免刚登录的新态被冲掉
  const rows = await lane.readBrowserCookies();
  if (rows.length) await writeCookies(account.id, rows, account.provider);
  await upsertAccount({
    id: account.id,
    status: "online",
    upstreamUserId: out.me.user_id,
    lastSeenAt: Date.now(),
    lastError: null,
    needsChallenge: false,
    cookieUpdatedAt: Date.now(),
  });
  await logEvent("login_ok", `[${account.label}] ego 授权成功：${out.me.user_id}`, { accountId: account.id });
  emit("login", { accountId: account.id, phase: "ok", userId: out.me.user_id });
  await syncAccount(await getAccount(account.id));
  return { ok: true, userId: out.me.user_id };
}

export async function loginAccount(accountId, { timeoutMs = 300_000 } = {}) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`账号不存在：${accountId}`);
  if ((account.backend || "chrome") === "ego") {
    return loginAccountEgo(account, { timeoutMs });
  }
  const cfg = providerConfig(account);
  const browser = await ensureBrowser(accountId, { headless: false });
  const page = await Page.open(browser.port, "about:blank");
  try {
    await page.goto(cfg.loginPage, { timeoutMs: 45_000 });
  } catch (e) {
    throw Object.assign(new Error(`登录页没能加载：${e.message}`), { code: "chrome_unavailable" });
  }
  // 把窗口拎到前台，否则用户看不到"打开了"
  await page.send("Page.bringToFront").catch(() => {});
  if (process.platform === "darwin") {
    try {
      spawn("open", ["-a", "Google Chrome"], { stdio: "ignore", detached: true }).unref();
    } catch {}
  }
  await logEvent("login_wait", `[${account.label}] 已打开登录页，等待人工授权…`, { accountId });
  emit("login", { accountId, phase: "awaiting_user" });

  let deadStrikes = 0;
  const meExpr = `fetch(${JSON.stringify(cfg.mePath)},{credentials:'include'}).then(r=>r.json()).catch(()=>({}))`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await page.evaluate(meExpr).catch(() => null);
    const raw = r?.result?.value ?? r?.value;
    const v = raw ? cfg.parseMe(raw) : raw;
    if (!v) {
      deadStrikes += 1;
      if (page.closed || deadStrikes >= 4) {
        throw Object.assign(new Error("登录窗口已关闭或浏览器被系统结束，授权中断"), {
          code: "chrome_unavailable",
        });
      }
    } else {
      deadStrikes = 0;
    }
    if (v && v.ok) {
      await upsertAccount({
        id: accountId,
        status: "online",
        upstreamUserId: v.user_id,
        lastSeenAt: Date.now(),
        headless: true,
        needsChallenge: false,
      });
      await logEvent("login_ok", `[${account.label}] 授权成功：${v.user_id}`, { accountId });
      emit("login", { accountId, phase: "ok", userId: v.user_id });
      await browser.relaunch(true);
      await syncAccount(await getAccount(accountId));
      return { ok: true, userId: v.user_id };
    }
    await sleep(2000);
  }
  emit("login", { accountId, phase: "timeout" });
  throw new Error("登录等待超时");
}

const loginInFlight = new Map();

/**
 * 非阻塞版登录：立刻返回，浏览器窗口留给用户操作，
 * 登录成功后通过 SSE(login) + 状态同步体现。CLI 仍用阻塞版。
 */
export function startLogin(accountId) {
  if (loginInFlight.has(accountId)) return { ok: true, phase: "awaiting_user", reused: true };
  const task = loginAccount(accountId)
    .catch(async (e) => {
      const acct = await getAccount(accountId).catch(() => null);
      if (!acct || acct.status === "removed") return; // 已删除的槽位不要复活
      await upsertAccount({ id: accountId, lastError: e.message, status: "new" }).catch(() => {});
      emit("login", { accountId, phase: "error", message: e.message });
      await logEvent("login_failed", `[${accountId}] ${e.message}`, { accountId, code: e.code }).catch(() => {});
    })
    .finally(() => loginInFlight.delete(accountId));
  loginInFlight.set(accountId, task);
  return { ok: true, phase: "awaiting_user" };
}

export async function syncOne(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`账号不存在：${accountId}`);
  return syncAccount(account);
}

/**
 * 导入已有登录态：把 h3v / h3s / __Host-h3d 等 cookie 注入该账号专属 profile。
 * 适合「浏览器里已经登录过」的账号迁移，避免再走一次 OAuth。
 */
/** 手动导入 cookie：直接落盘 + 通过车道校验，不依赖本机 Chrome */
export async function seedCookies(accountId, cookies) {
  const account = await getAccount(accountId);
  if (!account || account.status === "removed") throw bad(`账号不存在：${accountId}`);
  if (!Array.isArray(cookies) || !cookies.length) throw bad("cookies 为空");
  const cfg = providerConfig(account);
  if (!cookies.some((c) => c.name === cfg.identityCookie)) {
    throw bad(`缺少 ${cfg.identityCookie}（身份 cookie），请导入完整登录态（${cfg.cookieNames.join(" / ")}）`);
  }
  await writeCookies(accountId, cookies, account.provider);
  const lane = laneFor(account);
  const me = await lane.me();
  if (!me?.ok) {
    await deleteCookies(accountId);
    await logEvent("cookie_seed_failed", `[${account.label}] cookie 校验失败`, { accountId });
    throw bad(`cookie 无效或已过期（${cfg.id} 身份接口返回未登录）`);
  }
  await upsertAccount({
    id: accountId,
    status: "online",
    upstreamUserId: me.user_id,
    lastSeenAt: Date.now(),
    lastError: null,
    cookieUpdatedAt: Date.now(),
  });
  await logEvent("cookie_seeded", `[${account.label}] 已导入登录态 ${me.user_id}`, { accountId });
  await syncAccount(await getAccount(accountId));
  return { ok: true, userId: me.user_id };
}

/** 账号密码登录：车道内 POST /auth/account/login，成功后自动存 cookie */
export async function loginWithPassword(accountId, { email, password, remember = true } = {}) {
  const account = await getAccount(accountId);
  if (!account) throw bad(`账号不存在：${accountId}`);
  if (!email || !password) throw bad("邮箱和密码都要填");
  const lane = laneFor(account);
  let payload;
  try {
    payload = await lane.loginWithPassword(email, password);
  } catch (e) {
    await logEvent("password_login_failed", `[${account.label}] ${e.message}`, { accountId });
    throw e;
  }
  if (remember) await writeCred(accountId, { email, password });
  const me = await lane.me();
  if (!me?.ok) throw bad("登录返回成功但没有拿到会话，请改用 cookie 导入");
  await upsertAccount({
    id: accountId,
    status: "online",
    upstreamUserId: me.user_id,
    lastSeenAt: Date.now(),
    lastError: null,
    email,
    cookieUpdatedAt: Date.now(),
  });
  await logEvent("password_login_ok", `[${account.label}] 账号密码登录成功 ${me.user_id}`, { accountId });
  await syncAccount(await getAccount(accountId));
  return { ok: true, userId: me.user_id };
}

/** 修改账号信息（备注 / 后端 / 启停） */
export async function updateAccount(accountId, patch = {}) {
  const account = await getAccount(accountId);
  if (!account) throw bad(`账号不存在：${accountId}`);
  const next = {};
  if (typeof patch.label === "string" && patch.label.trim()) next.label = patch.label.trim().slice(0, 40);
  if (patch.backend === "ego" || patch.backend === "chrome") next.backend = patch.backend;
  if (typeof patch.disabled === "boolean") next.disabled = patch.disabled;
  if (typeof patch.note === "string") next.note = patch.note.slice(0, 200);
  const updated = await upsertAccount({ id: accountId, ...next });
  await logEvent("account_updated", `[${updated.label}] 账号信息已更新`, { accountId });
  return JSON.parse(JSON.stringify(updated));
}

/** 账号详情（用于编辑弹窗） */
export async function accountDetail(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw bad(`账号不存在：${accountId}`);
  const cookies = await readCookies(accountId);
  const cred = await readCred(accountId);
  return {
    id: account.id,
    label: account.label,
    backend: account.backend || "ego",
    disabled: Boolean(account.disabled),
    note: account.note || "",
    status: account.status,
    upstreamUserId: account.upstreamUserId || "",
    email: account.email || cred?.email || "",
    hasPassword: Boolean(cred?.password),
    cookies: maskCookies(cookies),
    cookieCount: cookies.length,
    cookieUpdatedAt: account.cookieUpdatedAt || null,
    usage: null,
  };
}

/** 启动时给还没有 cookie 文件的 ego 账号补一份（趁浏览器还是它自己的登录态） */
export async function ensureCookieJars() {
  const accounts = await listAccounts();
  for (const a of accounts) {
    if (a.status !== "online" || a.backend === "chrome" || a.disabled) continue;
    const jar = await readCookies(a.id);
    if (jar.length) continue;
    try {
      const rows = await laneFor(a).captureCookies();
      if (rows.length) await logEvent("cookie_snapshot", `[${a.label}] 已快照 ${rows.length} 条 cookie`, { accountId: a.id });
    } catch (e) {
      await logEvent("cookie_snapshot_failed", `[${a.label}] ${e.message}`, { accountId: a.id });
    }
  }
}

export async function solveChallengeFor(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`账号不存在：${accountId}`);
  const browser = getBrowser(accountId, { headless: false });
  if (!(await browser.alive()) || browser.headless) await browser.relaunch(false);
  const lane = laneFor(account);
  lane.page = null;
  const ok = await lane.solveChallenge({ timeoutMs: RUNTIME.challengeTimeoutMs });
  await upsertAccount({
    id: accountId,
    needsChallenge: !ok,
    status: ok ? "online" : account.status,
    lastChallengeAt: Date.now(),
  });
  await logEvent(ok ? "challenge_ok" : "challenge_failed", `[${account.label}] 人机验证${ok ? "通过" : "未完成"}`, {
    accountId,
  });
  await browser.relaunch(true);
  if (ok) await syncAccount(await getAccount(accountId));
  return { ok };
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (p === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        res.write(`retry: 3000\n\n`);
        const off = addClient(res);
        const hb = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {}
        }, 20_000);
        req.on("close", () => {
          clearInterval(hb);
          off();
        });
        return;
      }

      if (p === "/api/state") {
        const db = await snapshot();
        const accounts = [];
        for (const a of db.accounts) {
          const usage = await getUsage(a.id);
          accounts.push({
            ...accountView(a),
            usage: {
              day: usage.day,
              consumed: consumedOf(usage),
              limit: RUNTIME.freeDailyLimit,
              left: Math.max(0, RUNTIME.freeDailyLimit - consumedOf(usage)),
              submitted: usage.submitted,
              failed: usage.failed,
              refunded: usage.refunded,
            },
            active: await countActive(a.id),
          });
        }
        return json(res, 200, {
          accounts,
          tasks: await listTasks({ limit: 300 }),
          log: db.log.slice(0, 120),
          queue: queueStats(),
          models: Object.values(FREE_MODELS).map((m) => ({
            id: m.id,
            label: m.label,
            note: m.note,
            modes: m.modes,
            ratios: m.ratios,
            resolutions: m.resolutions,
            minDuration: m.minDuration,
            maxDuration: m.maxDuration,
            limits: m.limits,
          })),
          limits: {
            freeDailyLimit: RUNTIME.freeDailyLimit,
            maxActivePerAccount: RUNTIME.maxActivePerAccount,
            submitConcurrency: RUNTIME.submitConcurrency,
            minSubmitIntervalMs: RUNTIME.minSubmitIntervalMs,
          },
          runtime: { headless: RUNTIME.headless, syncIntervalMs: RUNTIME.syncIntervalMs },
          upstream: UPSTREAM.origin,
          siteEntry: UPSTREAM.videoPage,
        });
      }

      if (p === "/api/queue") return json(res, 200, queueStats());

      /* ---------- Veda Studio（免账号，纯 HTTP 通道） ---------- */
      if (p === "/api/veda/state") return json(res, 200, await vedaOverview());

      if (p === "/api/veda/generate" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, await vedaGenerate(body));
      }

      if (p === "/api/veda/sync" && req.method === "POST") {
        return json(res, 200, await vedaSyncAll());
      }

      const vedaJobMatch = p.match(/^\/api\/veda\/jobs\/([^/]+)\/cancel$/);
      if (vedaJobMatch && req.method === "POST") {
        return json(res, 200, await vedaCancelJob(vedaJobMatch[1]));
      }

      /* ---------- SiftQ MiniMax-H3（匿名试用，图生视频，9:16） ---------- */
      if (p === "/api/siftq/state") return json(res, 200, await siftqOverview());

      if (p === "/api/siftq/generate" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, await siftqGenerate(body));
      }

      if (p === "/api/siftq/sync" && req.method === "POST") {
        return json(res, 200, await siftqSyncAll());
      }

      /* ---------- 口播文案生成（本地规则拼接，零依赖，不调外部 AI） ---------- */
      if (p === "/api/voiceover" && req.method === "POST") {
        const body = await readBody(req);
        if (body.allTones) {
          return json(res, 200, { versions: buildAllTones(body.prompt, { duration: body.duration }) });
        }
        return json(res, 200, buildVoiceover(body.prompt, { duration: body.duration, tone: body.tone }));
      }

      /* ---------- 提交前预检 / 提示词体检（本地规则，零依赖） ---------- */
      if (p === "/api/precheck" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, precheckPrompt(body.provider, body));
      }

      // 自适应时长推荐：按提示词判内容类型 → 推荐时长 + 拆段方案 + 依据
      if (p === "/api/duration-plan" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, planDuration(body.provider || "paba", body));
      }

      /* ---------- 即梦 Dreamina（agent 短剧会话通道，独立模块） ---------- */      if (p === "/api/dreamina/state") return json(res, 200, await dreaminaOverview());

      if (p === "/api/dreamina/generate" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, await dreaminaGenerate(body));
      }

      if (p === "/api/dreamina/sync" && req.method === "POST") {
        return json(res, 200, await dreaminaSyncAll());
      }

      // 兜底：用系统默认浏览器打开登录页（受控 Chrome 起不来时，人工登录 + 导出 Cookie）
      if (p === "/api/open-site") {
        const target = url.searchParams.get("url") || UPSTREAM.loginPage;
        const allowed = ["https://www.paba.tv", "https://dreamina.capcut.com"];
        if (!allowed.some((prefix) => target.startsWith(prefix))) {
          return json(res, 400, { error: "只允许打开已接入的平台（PabaTV / 即梦）" });
        }
        const cmd =
          process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
        try {
          spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
          return json(res, 200, { ok: true, opened: target });
        } catch (e) {
          return json(res, 500, { error: `打开失败：${e.message}` });
        }
      }

      const jobMatch = p.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const job = getJob(jobMatch[1]);
        if (!job) return json(res, 404, { error: "job 不存在" });
        return json(res, 200, job);
      }

      if (p === "/api/accounts" && req.method === "POST") {
        const body = await readBody(req);
        const label = String(body.label || "").trim();
        if (!label) throw Object.assign(new Error("账号备注不能为空"), { code: "validation" });
        if (/^\d{1,6}$/.test(label) && !body.id) {
          throw Object.assign(new Error(`备注「${label}」看起来是误填，换个能认出来的名字`), { code: "validation" });
        }
        let id = String(body.id || "").replace(/[^\w-]/g, "").replace(/^-+|-+$/g, "");
        if (!id) id = `acct-${Date.now().toString(36)}`;
        const backend = body.backend || process.env.LANE || "chrome";
        const provider = ["paba", "dreamina"].includes(body.provider) ? body.provider : "paba";
        // id 必须全局唯一：Dreamina 账号请带 dm- 前缀（前端自动加），避免 cookie/usage 文件与 Paba 串号
        const existing = await getAccount(id);
        if (existing && (existing.provider || "paba") !== provider) {
          throw Object.assign(new Error(`id「${id}」已被 ${existing.provider || "paba"} 占用，请换一个备注`), {
            code: "validation",
          });
        }
        const account = await upsertAccount({
          id,
          label,
          status: "new",
          headless: true,
          backend,
          provider,
          disabled: false,
          lastError: null,
          removedAt: null,
        });
        await logEvent("account_added", `新增账号槽位 ${id}（${provider} / ${backend}）`, { accountId: id });
        if (body.login) {
          const out = startLogin(id);
          return json(res, 200, { account: accountView(await getAccount(id)), login: out });
        }
        return json(res, 200, accountView(account));
      }

      const acctMatch = p.match(
        /^\/api\/accounts\/([^/]+)\/(login|sync|challenge|delete|cookies|toggle|detail|update|login-password)$/,
      );
      if (acctMatch) {
        const [, id, action] = acctMatch;
        if (action === "login") return json(res, 200, startLogin(id));
        if (action === "detail") return json(res, 200, await accountDetail(id));
        if (action === "update" && req.method === "POST") {
          const body = await readBody(req);
          return json(res, 200, await updateAccount(id, body));
        }
        if (action === "login-password" && req.method === "POST") {
          const body = await readBody(req);
          return json(res, 200, await loginWithPassword(id, body));
        }
        if (action === "sync") return json(res, 200, await syncOne(id));
        if (action === "challenge") return json(res, 200, await solveChallengeFor(id));
        if (action === "toggle" && req.method === "POST") {
          const body = await readBody(req);
          const a = await getAccount(id);
          if (!a) throw new Error("账号不存在");
          const next = await upsertAccount({ id, disabled: Boolean(body.disabled) });
          await logEvent("account_toggled", `${a.label} ${next.disabled ? "已停用" : "已启用"}`, { accountId: id });
          return json(res, 200, accountView(next));
        }
        if (action === "cookies" && req.method === "POST") {
          const body = await readBody(req);
          return json(res, 200, await seedCookies(id, body.cookies));
        }
        if (action === "delete" && req.method === "POST") {
          const body = await readBody(req).catch(() => ({}));
          const acct = await getAccount(id);
          if (!acct) throw new Error("账号不存在");
          await stopBrowser(id).catch(() => {});
          await upsertAccount({ id, status: "removed", removedAt: Date.now(), disabled: true });
          let purged = false;
          if (body.purge) {
            await fs.rm(path.join(PROFILE_DIR, id), { recursive: true, force: true }).catch(() => {});
            purged = true;
          }
          await logEvent(
            "account_removed",
            `已删除账号 ${acct.label}${purged ? "（含浏览器 profile）" : "（保留 profile，可重新授权）"}`,
            { accountId: id },
          );
          return json(res, 200, { ok: true, purged });
        }
      }

      if (p === "/api/sync" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const out = body.accountId ? [await syncOne(body.accountId)] : await syncAll();
        return json(res, 200, { results: out });
      }

      if (p === "/api/generate" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, await generate(body));
      }

      if (p === "/api/tasks" && req.method === "GET") {
        return json(res, 200, {
          tasks: await listTasks({
            accountId: url.searchParams.get("accountId") || undefined,
            provider: url.searchParams.get("provider") || undefined,
          }),
        });
      }

      // 去水印：对本地产物跑 ffmpeg delogo（preset 按平台），输出 -clean.mp4，记到 asset.clean
      const wmMatch = p.match(/^\/api\/tasks\/([^/]+)\/watermark-off$/);
      if (wmMatch && req.method === "POST") {
        const upstreamId = decodeURIComponent(wmMatch[1]);
        const row = await getTask({ accountId: null, upstreamId });
        if (!row) return json(res, 404, { error: "任务不存在" });
        const src = row.asset?.video;
        if (!src) return json(res, 400, { error: "这条任务还没有本地成片，先等出片镜像" });
        const provider = row.provider || "paba";
        const preset = provider === "dreamina" ? "dreamina" : "paba-tv";
        const scriptPath = path.join(WEB_DIR, "..", "scripts", "clean-watermark.mjs");
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync(process.execPath, [scriptPath, src, "--preset", preset, "--force"], { encoding: "utf8" });
        if (r.status !== 0) {
          return json(res, 500, { error: `去水印失败：${(r.stderr || r.stdout || "").slice(-300)}` });
        }
        const cleanPath = src.replace(/\.mp4$/i, "-clean.mp4");
        const st = await fs.stat(cleanPath).catch(() => null);
        if (!st) return json(res, 500, { error: "去水印未产出文件" });
        const rel = cleanPath.split("/assets/")[1];
        const updated = await upsertTask({ ...row, asset: { ...(row.asset || {}), clean: { video: cleanPath, rel, bytes: st.size, at: Date.now() } } });
        await logEvent("watermark_off", `${upstreamId} 去水印完成（${preset}）`, { accountId: row.accountId });
        emit("task", { upstreamId, provider, cleaned: true });
        return json(res, 200, { ok: true, clean: { rel, bytes: st.size }, preset });
      }

      // 纯本地删除：删任务记录 + 本地视频/封面/元数据；不动上游（适用于失败/已完成/任意平台）
      const localDelMatch = p.match(/^\/api\/tasks\/local\/([^/]+)$/);
      if (localDelMatch && req.method === "DELETE") {
        const upstreamId = decodeURIComponent(localDelMatch[1]);
        const row = await getTask({ accountId: null, upstreamId });
        if (!row) return json(res, 404, { error: "任务不存在" });
        const removed = await removeTask(upstreamId);
        const files = [];
        if (row.asset?.video) files.push(row.asset.video);
        if (row.asset?.thumb) files.push(row.asset.thumb);
        if (row.asset?.meta) files.push(row.asset.meta);
        if (row.asset?.clean?.video) files.push(row.asset.clean.video);
        let freed = 0;
        for (const f of files) {
          try {
            const st = await fs.stat(f).catch(() => null);
            if (st) { freed += st.size; await fs.rm(f, { force: true }); }
          } catch {}
        }
        await logEvent("task_local_deleted", `${upstreamId} 已从本地删除${freed ? `（释放 ${(freed / 1048576).toFixed(1)}MB）` : ""}`, {
          accountId: row.accountId,
        });
        emit("task", { upstreamId, deleted: true, provider: row.provider });
        return json(res, 200, { ok: true, freed, files: files.length });
      }

      const taskMatch = p.match(/^\/api\/tasks\/([^/]+)\/([^/]+)$/);
      if (taskMatch && req.method === "DELETE") {
        const [, accountId, upstreamId] = taskMatch;
        const account = await getAccount(accountId);
        if (!account) throw new Error("账号不存在");
        const lane = laneFor(account);
        const out = await lane.deleteTask(upstreamId);
        await logEvent("deleted", `${upstreamId} 已从上游删除`, { accountId });
        return json(res, 200, { ok: true, upstream: out });
      }

      if (p.startsWith("/assets/")) {
        return serveStatic(res, ASSET_DIR, p.slice("/assets/".length));
      }

      if (p === "/" || p === "/index.html") {
        return serveStatic(res, WEB_DIR, "index.html");
      }

      if (p.startsWith("/static/")) {
        return serveStatic(res, WEB_DIR, p.slice("/static/".length));
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      const code =
        e instanceof AuthError
          ? 401
          : e instanceof ChallengeError
            ? 428
            : e.code === "challenge_required"
              ? 428
              : e.code === "quota_exhausted" || e.code === "quota_network"
                ? 429
                : e.code === "validation"
                  ? 400
                  : e.code === "too_many_pending"
                    ? 409
                    : e.code === "login_failed"
                      ? 401
                      : e.code === "chrome_unavailable"
                        ? 503
                        : 500;
      return json(res, code, { error: e.message, code: e.code || "error" });
    }
  });
  return server;
}

export async function startServer() {
  await pruneTasks();
  await ensureCookieJars().catch(() => {});
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error(`端口 ${RUNTIME.port} 已被占用：可能已有实例在跑（多实例会互相覆盖本地库，必须先停旧的）`));
        return;
      }
      reject(e);
    });
    server.listen(RUNTIME.port, resolve);
  });
  return server;
}
