import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME, WEB_DIR, ASSET_DIR, UPSTREAM, FREE_MODELS } from "./config.mjs";
import {
  snapshot,
  listAccounts,
  getAccount,
  upsertAccount,
  upsertTask,
  listTasks,
  logEvent,
  pruneTasks,
  getUsage,
  consumedOf,
  countActive,
  dayKey,
} from "./store.mjs";
import { laneFor, AuthError, ChallengeError } from "./lane.mjs";
import { precheck, enqueue, waitJob, pickAccountId, queueStats, getJob } from "./queue.mjs";
import { getBrowser } from "./chrome.mjs";
import { syncAccount, syncAll } from "./sync.mjs";
import { addClient, emit } from "./events.mjs";
import { Page, sleep } from "./cdp.mjs";

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

export function buildVideoPayload(input) {
  const body = {
    channel_id: input.channelId || "",
    model: input.model || "minimax-h3-flash",
    model_v: 2,
    prompt: String(input.prompt || "").trim(),
    duration: Number(input.duration || 5),
    resolution: input.resolution || "768p",
    aspect_ratio: input.aspectRatio || "16:9",
  };
  if (input.tier) body.tier = input.tier;
  if (input.style) body.style = input.style;
  if (Number.isFinite(Number(input.seed))) body.seed = Number(input.seed);
  if (Array.isArray(input.referenceImages) && input.referenceImages.length) {
    body.reference_images = input.referenceImages;
  }
  if (input.firstFrame) body.first_frame = input.firstFrame;
  if (input.lastFrame) body.last_frame = input.lastFrame;
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

export async function loginAccount(accountId, { timeoutMs = 300_000 } = {}) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`账号不存在：${accountId}`);
  const browser = await ensureBrowser(accountId, { headless: false });
  const page = await Page.open(browser.port, UPSTREAM.loginPage);
  await logEvent("login_wait", `[${account.label}] 已打开登录页，等待人工授权…`, { accountId });
  emit("login", { accountId, phase: "awaiting_user" });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await page
      .evaluate(`fetch('/auth/me',{credentials:'include'}).then(r=>r.json()).catch(()=>({}))`)
      .catch(() => null);
    const v = r?.result?.value ?? r?.value;
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
export async function seedCookies(accountId, cookies) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`账号不存在：${accountId}`);
  if (!Array.isArray(cookies) || !cookies.length) throw new Error("cookies 为空");
  const browser = await ensureBrowser(accountId, { headless: true });
  const page = await Page.open(browser.port, "https://www.paba.tv/");
  await page.send("Network.enable");
  for (const c of cookies) {
    const params = {
      name: c.name,
      value: c.value,
      url: "https://www.paba.tv/",
      path: c.path || "/",
      secure: true,
      httpOnly: c.httpOnly !== false,
      sameSite: c.sameSite || "Lax",
    };
    if (c.expires && Number(c.expires) > 0) params.expires = Number(c.expires);
    await page.send("Network.setCookie", params);
  }
  await sleep(300);
  const me = await page
    .evaluate(`fetch('/auth/me',{credentials:'include'}).then(r=>r.json()).catch(()=>({}))`)
    .then((r) => r?.result?.value ?? r?.value);
  if (!me?.ok) {
    await logEvent("cookie_seed_failed", `[${account.label}] cookie 注入后仍未登录`, { accountId });
    throw new Error("cookie 无效或已过期");
  }
  await upsertAccount({
    id: accountId,
    status: "online",
    upstreamUserId: me.user_id,
    lastSeenAt: Date.now(),
    headless: true,
  });
  await logEvent("cookie_seeded", `[${account.label}] 已导入登录态 ${me.user_id}`, { accountId });
  await page.close();
  await syncAccount(await getAccount(accountId));
  return { ok: true, userId: me.user_id };
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
            maxDuration: m.maxDuration,
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

      const jobMatch = p.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const job = getJob(jobMatch[1]);
        if (!job) return json(res, 404, { error: "job 不存在" });
        return json(res, 200, job);
      }

      if (p === "/api/accounts" && req.method === "POST") {
        const body = await readBody(req);
        const id = (body.id || `acct-${Date.now().toString(36)}`).replace(/[^\w-]/g, "");
        const backend = body.backend || process.env.LANE || "chrome";
        if (backend === "ego") {
          const others = (await listAccounts()).filter(
            (a) => a.id !== id && a.backend === "ego" && a.status !== "removed",
          );
          if (others.length) {
            throw Object.assign(
              new Error(
                `ego 后端共用一个浏览器会话，只能接管 1 个账号（已有 ${others[0].label}）。第 2 个账号请用「浏览器登录」或「导入 Cookie」。`,
              ),
              { code: "validation" },
            );
          }
        }
        const account = await upsertAccount({
          id,
          label: body.label || id,
          status: "new",
          headless: true,
          backend,
          disabled: false,
        });
        await logEvent("account_added", `新增账号槽位 ${id}（${backend}）`, { accountId: id });
        if (body.login) {
          const out = startLogin(id);
          return json(res, 200, { account: accountView(await getAccount(id)), login: out });
        }
        return json(res, 200, accountView(account));
      }

      const acctMatch = p.match(/^\/api\/accounts\/([^/]+)\/(login|sync|challenge|delete|cookies|toggle)$/);
      if (acctMatch) {
        const [, id, action] = acctMatch;
        if (action === "login") return json(res, 200, startLogin(id));
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
          await upsertAccount({ id, status: "removed" });
          return json(res, 200, { ok: true });
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
          tasks: await listTasks({ accountId: url.searchParams.get("accountId") || undefined }),
        });
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
            : e.code === "validation"
              ? 400
              : e.code === "too_many_pending"
                ? 409
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
  const server = createServer();
  await new Promise((resolve) => server.listen(RUNTIME.port, resolve));
  return server;
}
