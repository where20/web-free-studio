import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME, WEB_DIR, ASSET_DIR, UPSTREAM } from "./config.mjs";
import {
  snapshot,
  listAccounts,
  getAccount,
  upsertAccount,
  upsertTask,
  listTasks,
  logEvent,
  pruneTasks,
} from "./store.mjs";
import { laneFor, AuthError, ChallengeError } from "./lane.mjs";
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

async function pickAccount(requestedId) {
  const accounts = await listAccounts();
  if (requestedId) {
    const hit = accounts.find((a) => a.id === requestedId);
    if (!hit) throw new Error(`账号不存在：${requestedId}`);
    return hit;
  }
  const usable = accounts.filter((a) => a.status === "online");
  if (!usable.length) throw new Error("没有可用账号，请先授权（npm run account）");
  usable.sort((a, b) => (a.freeUsedToday || 0) - (b.freeUsedToday || 0));
  return usable[0];
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

export async function generate(input) {
  if (!input.prompt || !String(input.prompt).trim()) throw new Error("prompt 不能为空");
  const account = await pickAccount(input.accountId);
  const lane = laneFor(account);
  const payload = buildVideoPayload(input);
  const upstream = await lane.createVideo(payload);
  const upstreamId = upstream.request_id || upstream.id;
  const row = {
    accountId: account.id,
    upstreamId,
    status: upstream.status || "pending",
    queueState: upstream.queue_state,
    model: upstream.model || payload.model,
    tier: upstream.tier,
    tierCn: upstream.tier_cn,
    prompt: payload.prompt,
    duration: payload.duration,
    resolution: payload.resolution,
    aspectRatio: payload.aspect_ratio,
    seed: upstream.seed,
    billing: upstream.billing || null,
    upstreamCreatedAt: (upstream.created_at || Date.now() / 1000) * 1000,
    submittedLocally: true,
  };
  await upsertTask(row);
  await logEvent("submitted", `[${account.label}] ${upstreamId} ${payload.model} ${payload.duration}s`, {
    accountId: account.id,
  });
  emit("task", { accountId: account.id, upstreamId, status: row.status });
  return { accountId: account.id, upstreamId, raw: upstream };
}

export async function loginAccount(accountId, { timeoutMs = 300_000 } = {}) {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`账号不存在：${accountId}`);
  const browser = getBrowser(accountId, { headless: false });
  if (!(await browser.alive()) || browser.headless) {
    await browser.relaunch(false);
  }
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
  const browser = getBrowser(accountId, { headless: true });
  if (!(await browser.alive())) await browser.launch();
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
        return json(res, 200, {
          accounts: db.accounts.map(accountView),
          tasks: await listTasks({ limit: 300 }),
          log: db.log.slice(0, 120),
          runtime: { headless: RUNTIME.headless, syncIntervalMs: RUNTIME.syncIntervalMs },
          upstream: UPSTREAM.origin,
        });
      }

      if (p === "/api/accounts" && req.method === "POST") {
        const body = await readBody(req);
        const id = (body.id || `acct-${Date.now().toString(36)}`).replace(/[^\w-]/g, "");
        const account = await upsertAccount({
          id,
          label: body.label || id,
          status: "new",
          headless: true,
        });
        return json(res, 200, accountView(account));
      }

      const acctMatch = p.match(/^\/api\/accounts\/([^/]+)\/(login|sync|challenge|delete|cookies)$/);
      if (acctMatch) {
        const [, id, action] = acctMatch;
        if (action === "login") return json(res, 200, await loginAccount(id));
        if (action === "sync") return json(res, 200, await syncOne(id));
        if (action === "challenge") return json(res, 200, await solveChallengeFor(id));
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
      const code = e instanceof AuthError ? 401 : e instanceof ChallengeError ? 428 : 500;
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
