import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { Page, sleep } from "./cdp.mjs";
import { getBrowser } from "./chrome.mjs";
import { ASSET_DIR, UPSTREAM } from "./config.mjs";

export class AuthError extends Error {
  constructor(message = "未登录或登录已失效") {
    super(message);
    this.code = "unauthorized";
  }
}

export class ChallengeError extends Error {
  constructor(message = "该网络需要人机验证") {
    super(message);
    this.code = "challenge_required";
  }
}

export class UpstreamError extends Error {
  constructor(message, { status = 0, code = "", payload = null } = {}) {
    super(message);
    this.code = code || "upstream_error";
    this.status = status;
    this.payload = payload;
  }
}

export function jsFetchExpr(apiPath, { method = "GET", headers = {}, body = null } = {}) {
  const opts = {
    method,
    headers: { Accept: "application/json, text/plain, */*", ...headers },
    credentials: "include",
    cache: "no-store",
  };
  if (body !== null && body !== undefined) opts.body = body;
  return `(async () => {
    const r = await fetch(${JSON.stringify(apiPath)}, ${JSON.stringify(opts)});
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.length > 4000 ? text.slice(0, 4000) : text };
  })()`;
}

/** 两个后端共用的业务逻辑：只要求子类实现 exec(expr) */
class BaseLane {
  constructor(account) {
    this.account = account;
    this.accountId = account.id;
    this.locked = Promise.resolve();
  }

  get backend() {
    return this.account.backend || "chrome";
  }

  run(fn) {
    const next = this.locked.then(fn, fn);
    this.locked = next.catch(() => {});
    return next;
  }

  async api(apiPath, opts = {}) {
    const payload = await this.exec(jsFetchExpr(apiPath, opts));
    if (!payload || typeof payload.status !== "number") throw new UpstreamError("上游响应异常");
    const { status, json } = payload;
    if (status === 401) throw new AuthError(json?.error?.message);
    if (status === 403 && json?.error?.code === "challenge_required") {
      throw new ChallengeError(json.error.message);
    }
    if (status >= 400) {
      throw new UpstreamError(json?.error?.message || `HTTP ${status}`, {
        status,
        code: json?.error?.code,
        payload: json,
      });
    }
    return json;
  }

  async call(apiPath, opts = {}) {
    return this.run(async () => {
      try {
        return await this.api(apiPath, opts);
      } catch (e) {
        if (e instanceof ChallengeError) {
          const ok = await this.solveChallenge();
          if (!ok) throw e;
          return this.api(apiPath, opts);
        }
        throw e;
      }
    });
  }

  me() {
    return this.call("/auth/me");
  }
  listTasks(limit = 40) {
    return this.call(`/v1/videos?limit=${limit}`);
  }
  getTask(id) {
    return this.call(`/v1/videos/${encodeURIComponent(id)}`);
  }
  createVideo(payload, { idempotencyKey } = {}) {
    return this.call("/v1/videos/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey || crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    });
  }
  deleteTask(id) {
    return this.call(`/v1/videos/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  cancelTask(id) {
    return this.call(`/v1/videos/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  prices() {
    return this.call("/v1/videos/prices");
  }

  async mirror(task) {
    const id = task.request_id || task.id;
    const day = new Date((task.created_at || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
    const dir = path.join(ASSET_DIR, day);
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `${id}.mp4`);
    const thumbOut = path.join(dir, `${id}.jpg`);
    // 旁车元数据：每个成片旁边放一份上游原始 JSON，离线也查得到当时的参数
    const metaOut = path.join(dir, `${id}.json`);
    await fs.writeFile(metaOut, JSON.stringify(task, null, 1)).catch(() => {});

    let bytes = 0;
    const existed = await fs.stat(out).catch(() => null);
    if (existed && existed.size > 0) bytes = existed.size;
    else {
      const cdn = task.video?.cdn_url;
      bytes = cdn && cdn.startsWith(UPSTREAM.contentHost)
        ? await downloadTo(cdn, out)
        : await this.downloadViaLane(id, out);
    }

    let thumbBytes = 0;
    const thumb = task.video?.thumb_url;
    if (thumb) {
      const t = await fs.stat(thumbOut).catch(() => null);
      thumbBytes = t && t.size > 0 ? t.size : await downloadTo(thumb, thumbOut).catch(() => 0);
    }
    return { dir, video: out, thumb: thumbOut, meta: metaOut, bytes, thumbBytes };
  }

  async downloadViaLane(id, out) {
    const payload = await this.exec(
      `(async () => {
        const r = await fetch("/v1/videos/${id}/content", { credentials: "include" });
        if (!r.ok) return { error: r.status };
        const buf = new Uint8Array(await r.arrayBuffer());
        const chunk = 0x8000;
        let s = "";
        for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        return { b64: btoa(s), type: r.headers.get("content-type") };
      })()`,
      300_000,
    );
    if (!payload?.b64) throw new UpstreamError("内容下载失败");
    const buf = Buffer.from(payload.b64, "base64");
    await fs.writeFile(out, buf);
    return buf.length;
  }
}

/** 后端 A：本机 Chrome（每个账号独立 user-data-dir / 独立调试端口） */
export class ChromeLane extends BaseLane {
  constructor(account) {
    super(account);
    this.page = null;
  }

  get browser() {
    return getBrowser(this.accountId, { headless: this.account.headless !== false });
  }

  async ensurePage() {
    if (this.page && !this.page.closed) {
      try {
        await this.page.evaluate("1");
        return this.page;
      } catch {
        this.page = null;
      }
    }
    const browser = this.browser;
    if (!(await browser.alive())) await browser.launch();
    this.page = await Page.open(browser.port, UPSTREAM.videoPage);
    await this.waitOrigin();
    return this.page;
  }

  async waitOrigin(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.page.evaluate("({ href: location.href, ready: document.readyState })").catch(() => null);
      const v = r?.result?.value ?? r?.value;
      if (v && v.href?.startsWith(UPSTREAM.origin) && v.ready !== "loading") return true;
      await sleep(200);
    }
    throw new Error("页面未能进入 paba.tv 域");
  }

  async exec(expr) {
    const page = await this.ensurePage();
    const res = await page.evaluate(expr, { timeoutMs: 300_000 });
    return res?.result?.value ?? res?.value;
  }

  async solveChallenge({ timeoutMs = 150_000 } = {}) {
    const page = await this.ensurePage();
    await page.goto(UPSTREAM.challengePage, { timeoutMs: 45_000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await page
        .evaluate(`(() => { const m = document.getElementById('h3c-msg'); return { ok: m ? m.className.includes('ok') : false }; })()`)
        .catch(() => null);
      const v = r?.result?.value ?? r?.value;
      if (v?.ok) {
        await page.goto(UPSTREAM.videoPage, { timeoutMs: 45_000 });
        await sleep(400);
        return true;
      }
      await sleep(500);
    }
    return false;
  }
}

/**
 * 后端 B：ego-browser（ego-lite 常驻浏览器）。
 * 每个账号一个独立 taskSpace；在同一台机器上跑多份 ego 服务时可用 EGO_SERVER 前缀隔离。
 */
export class EgoLane extends BaseLane {
  constructor(account) {
    super(account);
    this.spaceName = `fs-${account.id}`;
  }

  get bin() {
    return process.env.EGO_BIN || "ego-browser";
  }

  execRaw(script, timeoutMs = 300_000) {
    const args = [];
    if (process.env.EGO_SERVER) args.push(`--ego-server-name=${process.env.EGO_SERVER}`);
    args.push("nodejs", "-e", script);
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        args,
        { timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, env: process.env },
        (err, stdout, stderr) => {
          const combined = `${stdout || ""}\n${stderr || ""}`;
          const line = combined
            .split("\n")
            .reverse()
            .find((l) => l.trimStart().startsWith("__FS__"));
          if (!line) {
            return reject(
              new Error(`ego-browser 未返回结果：${(stderr || stdout || err?.message || "").slice(0, 400)}`),
            );
          }
          try {
            resolve(JSON.parse(line.trimStart().slice("__FS__".length)));
          } catch {
            reject(new Error("ego-browser 返回结果解析失败"));
          }
        },
      );
    });
  }

  async exec(expr, timeoutMs = 300_000) {
    const script = `
const SPACE = ${JSON.stringify(this.spaceName)};
const EXPR = ${JSON.stringify(expr)};
const entry = (await listTaskSpaces()).find((s) => s.name === SPACE);
const task = entry ? await taskSpace(entry.id) : await taskSpace(SPACE);
let page = (await task.pages())[0];
if (!page) page = await task.newPage();
const cur = await page.url();
if (!String(cur).startsWith(${JSON.stringify(UPSTREAM.origin)})) {
  await page.goto(${JSON.stringify(UPSTREAM.videoPage)}, { timeout: 60000 });
}
const value = await page.evaluate(EXPR);
console.log("__FS__" + JSON.stringify(value === undefined ? null : value));
`;
    return this.execRaw(script, timeoutMs);
  }

  async solveChallenge({ timeoutMs = 150_000 } = {}) {
    const script = `
const SPACE = ${JSON.stringify(this.spaceName)};
const entry = (await listTaskSpaces()).find((s) => s.name === SPACE);
const task = entry ? await taskSpace(entry.id) : await taskSpace(SPACE);
let page = (await task.pages())[0] || (await task.newPage());
await page.goto(${JSON.stringify(UPSTREAM.challengePage)}, { timeout: 45000 });
const deadline = Date.now() + ${timeoutMs};
let ok = false;
while (Date.now() < deadline) {
  const v = await page.evaluate("(() => { const m = document.getElementById('h3c-msg'); return { ok: m ? m.className.includes('ok') : false }; })()");
  if (v && v.ok) { ok = true; break; }
  await page.waitForTimeout(500);
}
await page.goto(${JSON.stringify(UPSTREAM.videoPage)}, { timeout: 45000 });
console.log("__FS__" + JSON.stringify({ ok }));
`;
    const out = await this.execRaw(script, timeoutMs + 60_000);
    return Boolean(out?.ok);
  }
}

async function downloadTo(url, out) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new UpstreamError(`下载失败 ${res.status}`, { status: res.status });
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${out}.part`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, out);
  return buf.length;
}

const lanes = new Map();

export function laneFor(account) {
  const backend = account.backend || process.env.LANE || "chrome";
  const key = `${account.id}:${backend}`;
  const cur = lanes.get(key);
  if (cur) {
    cur.account = account;
    return cur;
  }
  const lane = backend === "ego" ? new EgoLane(account) : new ChromeLane(account);
  lanes.set(key, lane);
  return lane;
}

export async function closeLanes() {
  for (const [, lane] of lanes) {
    try {
      await lane.page?.close();
    } catch {}
  }
  lanes.clear();
}
