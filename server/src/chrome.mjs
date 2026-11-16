import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromePath, PROFILE_DIR, RUNTIME } from "./config.mjs";
import { waitForChrome, listTargets, closeTab, sleep } from "./cdp.mjs";

const running = new Map(); // accountId -> Browser

export function portForAccount(accountId, index = 0) {
  let h = 0;
  for (const ch of accountId) h = (h * 31 + ch.charCodeAt(0)) % 200;
  return RUNTIME.debugPortBase + index * 100 + h;
}

export class Browser {
  constructor({ accountId, port, headless = RUNTIME.headless }) {
    this.accountId = accountId;
    this.port = port;
    this.headless = headless;
    this.profileDir = path.join(PROFILE_DIR, accountId);
    this.proc = null;
  }

  async ensureDirs() {
    await fs.mkdir(this.profileDir, { recursive: true });
  }

  async launch() {
    const bin = chromePath();
    if (!bin) throw new Error("未找到 Chrome/Chromium，请先安装 Google Chrome 或设置 CHROME_PATH");
    await this.ensureDirs();
    if (await this.alive()) {
      await this.stop();
    }
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble",
      "--restore-last-session=false",
      "--lang=zh-CN",
      "--window-size=1280,900",
      "about:blank",
    ];
    if (this.headless) args.unshift("--headless=new");
    this.proc = spawn(bin, args, { stdio: "ignore", detached: false });
    this.proc.on("exit", () => {
      this.proc = null;
    });
    await waitForChrome(this.port, 25_000);
    return this;
  }

  async alive() {
    try {
      await waitForChrome(this.port, 800);
      return true;
    } catch {
      return false;
    }
  }

  async stop() {
    // 1) 走浏览器级关闭，保证 profile 正常落盘
    try {
      const targets = await listTargets(this.port);
      for (const t of targets) {
        if (t.type === "page") await closeTab(this.port, t.id);
      }
    } catch {}
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close`, { method: "GET" });
    } catch {}
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {}
      await sleep(600);
      if (this.proc) {
        try {
          this.proc.kill("SIGKILL");
        } catch {}
      }
      this.proc = null;
    }
    // 等待端口释放，避免重启时 user-data-dir 锁冲突
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!(await this.alive())) return;
      await sleep(200);
    }
  }

  async relaunch(headless) {
    await this.stop();
    this.headless = headless;
    await this.launch();
    return this;
  }
}

export function getBrowser(accountId, { headless = RUNTIME.headless, port } = {}) {
  const key = accountId;
  const existed = running.get(key);
  if (existed && existed.headless === headless && existed.port === (port || existed.port)) {
    return existed;
  }
  const b = new Browser({
    accountId,
    port: port || existed?.port || portForAccount(accountId),
    headless,
  });
  running.set(key, b);
  return b;
}

export async function stopBrowser(accountId) {
  const b = running.get(accountId);
  if (!b) return;
  await b.stop();
  running.delete(accountId);
}

export async function stopAll() {
  for (const [, b] of running) {
    try {
      await b.stop();
    } catch {}
  }
  running.clear();
}
