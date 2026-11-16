/**
 * 极简 CDP 客户端（零依赖，Node 22 自带全局 WebSocket）。
 * 只覆盖本项目需要的部分：建页、导航、执行 JS。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(port, p, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method });
  if (!res.ok) throw new Error(`CDP ${method} ${p} -> ${res.status}`);
  return res.json();
}

export async function waitForChrome(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await jget(port, "/json/version");
    } catch (e) {
      lastErr = e;
      await sleep(200);
    }
  }
  throw new Error(`Chrome 调试端口 ${port} 未就绪：${lastErr?.message || "timeout"}`);
}

export async function listTargets(port) {
  return jget(port, "/json/list");
}

export async function newTab(port, url = "about:blank") {
  // Chrome 111+ 要求 PUT
  try {
    return await jget(port, `/json/new?${encodeURIComponent(url)}`, "PUT");
  } catch {
    return await jget(port, `/json/new?${encodeURIComponent(url)}`);
  }
}

export async function closeTab(port, id) {
  try {
    return await jget(port, `/json/close/${id}`);
  } catch {
    return null;
  }
}

export class Page {
  constructor(wsUrl, targetId) {
    this.wsUrl = wsUrl;
    this.targetId = targetId;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
  }

  static async open(port, url) {
    const target = await newTab(port, url);
    const page = new Page(target.webSocketDebuggerUrl, target.id);
    await page.connect();
    return page;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 15_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error("CDP 连接失败"));
      });
      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error("CDP 已断开"));
        this.pending.clear();
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
        } catch {
          return;
        }
        if (!msg.id) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
        else p.resolve(msg.result);
      });
    });
  }

  send(method, params = {}, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error("CDP 已断开"));
    const id = ++this.seq;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(payload);
    });
  }

  async goto(url, { timeoutMs = 45_000, waitFor = null } = {}) {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.evaluate(
        `(() => ({ ready: document.readyState, href: location.href }))()`,
      ).catch(() => null);
      if (r?.result?.value?.ready === "complete" && r.result.value.href === url) return true;
      await sleep(250);
    }
    throw new Error(`导航超时：${url}`);
  }

  /**
   * 在页面上下文执行表达式（支持 Promise）。
   * 返回 { value } 或抛错。
   */
  async evaluate(expression, { timeoutMs = 120_000, awaitPromise = true } = {}) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description || d.text || "页面执行异常");
    }
    return res.result;
  }

  async close() {
    try {
      await this.send("Page.close", {}, 5000);
    } catch {}
    try {
      this.ws.close();
    } catch {}
    this.closed = true;
  }
}

export { sleep };
