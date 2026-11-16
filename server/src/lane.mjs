import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { Page, sleep } from "./cdp.mjs";
import { getBrowser } from "./chrome.mjs";
import { ASSET_DIR, UPSTREAM } from "./config.mjs";
import { readCookies, writeCookies } from "./cookies.mjs";

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
  // 页内 fetch 必须自带超时：网络卡住时 evaluate 会一直挂着，把整个账号车道拖死
  return `(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(${JSON.stringify(apiPath)}, { ...${JSON.stringify(opts)}, signal: ctl.signal });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text: text.length > 4000 ? text.slice(0, 4000) : text };
    } catch (e) {
      return { status: 0, json: null, text: String(e && e.message || e), aborted: true };
    } finally {
      clearTimeout(timer);
    }
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

  /** 该账号当前保存的 cookie（用于注入浏览器） */
  async cookies() {
    return readCookies(this.accountId);
  }

  /** 从浏览器回读 cookie 并落盘（登录/换号后调用） */
  async captureCookies() {
    const rows = await this.readBrowserCookies();
    if (rows.length) await writeCookies(this.accountId, rows);
    return rows;
  }

  async api(apiPath, opts = {}) {
    const payload = await this.exec(jsFetchExpr(apiPath, opts));
    if (!payload || typeof payload.status !== "number") throw new UpstreamError("上游响应异常");
    if (payload.status === 0) {
      // 页内请求超时/被中断：后台重置页面，下次调用换新标签页
      this.resetPage?.().catch(() => {});
      throw new UpstreamError(`上游请求超时（${payload.text || "no response"}）`, {
        status: 0,
        code: "timeout",
        payload,
      });
    }
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
      try {
        bytes = cdn && cdn.startsWith(UPSTREAM.contentHost)
          ? await downloadTo(cdn, out)
          : await this.downloadViaLane(id, out);
      } catch (e) {
        // CDN 直链失效时回落到带 Cookie 的 /content（302 到新的 CDN 地址）
        if (cdn) bytes = await this.downloadViaLane(id, out);
        else throw e;
      }
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
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 600000);
        const r = await fetch("/v1/videos/${id}/content", { credentials: "include", signal: ctl.signal });
        clearTimeout(timer);
        if (!r.ok) return { error: r.status };
        const buf = new Uint8Array(await r.arrayBuffer());
        const chunk = 0x8000;
        let s = "";
        for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        return { b64: btoa(s), type: r.headers.get("content-type") };
      })()`,
      620_000,
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
    const jar = await this.cookies();
    if (jar.length) {
      await this.applyCookieJar(jar, this.page).catch(() => {});
      await this.page.reload({ timeoutMs: 30_000 }).catch(() => {});
      await this.waitOrigin();
    }
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

  async readBrowserCookies() {
    const page = await this.ensurePage();
    await page.send("Network.enable");
    const res = await page.send("Network.getAllCookies");
    return (res.cookies || [])
      .filter((c) => /paba\.tv$/.test(c.domain))
      .map((c) => ({
        name: c.name,
        value: c.value,
        path: c.path,
        domain: c.domain,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expires: c.expires > 0 ? Math.floor(c.expires) : undefined,
      }));
  }

  async applyCookieJar(jar, pageArg = null) {
    const page = pageArg || (await this.ensurePage());
    await page.send("Network.enable");
    for (const n of ["h3v", "h3s", "__Host-h3d"]) {
      await page.send("Network.deleteCookies", { name: n, url: "https://www.paba.tv/" }).catch(() => {});
    }
    for (const c of jar) {
      await page
        .send("Network.setCookie", {
          name: c.name,
          value: c.value,
          url: "https://www.paba.tv/",
          path: "/",
          httpOnly: true,
          secure: true,
          ...(c.expires ? { expires: c.expires } : {}),
        })
        .catch(() => {});
    }
  }

  async loginWithPassword(email, password) {
    const page = await this.ensurePage();
    await page.send("Network.enable");
    for (const n of ["h3v", "h3s", "__Host-h3d"]) {
      await page.send("Network.deleteCookies", { name: n, url: "https://www.paba.tv/" }).catch(() => {});
    }
    const res = await page.evaluate(
      jsFetchExpr("/auth/account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    const payload = res?.result?.value ?? res?.value;
    if (!payload || payload.status >= 400 || payload.json?.ok === false) {
      const msg = payload?.json?.error?.message || payload?.json?.error || "登录失败";
      throw Object.assign(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)), {
        code: payload?.json?.error?.code || "login_failed",
      });
    }
    const cookies = await this.readBrowserCookies();
    if (!cookies.some((c) => c.name === "h3v")) throw new Error("登录后没有拿到会话 cookie");
    await writeCookies(this.accountId, cookies);
    return payload.json;
  }

  async exec(expr, timeoutMs = 60_000) {
    const page = await this.ensurePage();
    const res = await page.evaluate(expr, { timeoutMs });
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
      let child = null;
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      // 硬超时：ego CLI 可能忽略 SIGTERM，必须自己兜一层 SIGKILL + reject
      const hard = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {}
        done(reject, new Error(`ego 调用超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      child = execFile(
        this.bin,
        args,
        { timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, env: process.env },
        (err, stdout, stderr) => {
          clearTimeout(hard);
          if (settled) return;
          const combined = `${stdout || ""}\n${stderr || ""}`;
          const line = combined
            .split("\n")
            .reverse()
            .find((l) => l.trimStart().startsWith("__FS__"));
          if (!line) {
            return done(
              reject,
              new Error(`ego-browser 未返回结果：${(stderr || stdout || err?.message || "").slice(0, 400)}`),
            );
          }
          try {
            done(resolve, JSON.parse(line.trimStart().slice("__FS__".length)));
          } catch {
            done(reject, new Error("ego-browser 返回结果解析失败"));
          }
        },
      );
    });
  }

  /** 页面卡死/被关时，重建该账号的 tab，再重试一次 */
  async resetPage() {
    const script = `
const SPACE = ${JSON.stringify(this.spaceName)};
const entry = (await listTaskSpaces()).find((s) => s.name === SPACE);
const task = entry ? await taskSpace(entry.id) : await taskSpace(SPACE);
for (const p of await task.pages()) { try { await p.close(); } catch {} }
const page = await task.newPage();
await page.goto(${JSON.stringify(UPSTREAM.videoPage)}, { timeout: 45000 });
console.log("__FS__" + JSON.stringify({ ok: true }));
`;
    return this.execRaw(script, 90_000);
  }

  async exec(expr, timeoutMs = 60_000) {
    try {
      return await this.execOnce(expr, timeoutMs);
    } catch (e) {
      // 页面忙/超时：后台重建标签页，本次直接失败，避免把车道拖成几分钟
      this.resetPage?.().catch(() => {});
      throw e;
    }
  }

  /** 当前浏览器里 paba.tv 的 cookie */
  async readBrowserCookies() {
    const script = `
const SPACE = ${JSON.stringify(this.spaceName)};
const entry = (await listTaskSpaces()).find((s) => s.name === SPACE);
const task = entry ? await taskSpace(entry.id) : await taskSpace(SPACE);
let page = (await task.pages())[0] || (await task.newPage());
await page.cdp("Network.enable");
const res = await page.cdp("Network.getAllCookies");
const rows = (res.cookies || []).filter((c) => /paba\.tv$/.test(c.domain)).map((c) => ({
  name: c.name, value: c.value, path: c.path, domain: c.domain,
  httpOnly: c.httpOnly, secure: c.secure, expires: c.expires > 0 ? Math.floor(c.expires) : undefined,
}));
console.log("__FS__" + JSON.stringify(rows));
`;
    const out = await this.execRaw(script, 60_000);
    return Array.isArray(out) ? out : [];
  }

  /** 用邮箱密码在该账号的环境里登录，成功后回读 cookie */
  async loginWithPassword(email, password) {
    const expr = jsFetchExpr("/auth/account/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = await this.execOnce(expr, 60_000, { clear: true });
    if (!payload || payload.status === 0) {
      throw new UpstreamError(`登录请求失败：${payload?.text || "无响应"}`);
    }
    if (payload.status >= 400 || payload.json?.ok === false) {
      const msg =
        payload.json?.error?.message ||
        payload.json?.error ||
        `登录失败（HTTP ${payload.status}）`;
      throw Object.assign(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)), {
        code: payload.json?.error?.code || "login_failed",
      });
    }
    const cookies = await this.readBrowserCookies();
    if (!cookies.some((c) => c.name === "h3v")) {
      throw new Error("登录后没有拿到会话 cookie");
    }
    await writeCookies(this.accountId, cookies);
    return payload.json;
  }

  async execOnce(expr, timeoutMs = 60_000, opts = {}) {
    const jar = opts.clear ? [] : await this.cookies();
    const inject = Boolean(opts.clear) || jar.length > 0;
    const script = `
const SPACE = ${JSON.stringify(this.spaceName)};
const EXPR = ${JSON.stringify(expr)};
const JAR = ${JSON.stringify(jar)};
const INJECT = ${inject ? "true" : "false"};
const entry = (await listTaskSpaces()).find((s) => s.name === SPACE);
const task = entry ? await taskSpace(entry.id) : await taskSpace(SPACE);
let page = (await task.pages())[0];
if (!page) page = await task.newPage();
const cur = await page.url();
if (!String(cur).startsWith(${JSON.stringify(UPSTREAM.origin)})) {
  await page.goto(${JSON.stringify(UPSTREAM.videoPage)}, { timeout: 60000 });
}
if (INJECT) {
  await page.cdp("Network.enable");
  for (const n of ["h3v", "h3s", "__Host-h3d"]) {
    try { await page.cdp("Network.deleteCookies", { name: n, url: "https://www.paba.tv/" }); } catch {}
  }
  for (const c of JAR) {
    try {
      await page.cdp("Network.setCookie", {
        name: c.name, value: c.value, url: "https://www.paba.tv/", path: "/",
        httpOnly: true, secure: true, ...(c.expires ? { expires: c.expires } : {}),
      });
    } catch {}
  }
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
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
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
