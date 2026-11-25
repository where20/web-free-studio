#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromePath, RUNTIME, DATA_DIR, ASSET_DIR } from "./src/config.mjs";
import { listAccounts, upsertAccount, logEvent, load, getUsage } from "./src/store.mjs";
import { loginAccount, syncOne, solveChallengeFor, generate, startServer, seedCookies } from "./src/api.mjs";
import { startScheduler, syncAll } from "./src/sync.mjs";
import { startVedaScheduler } from "./src/veda-service.mjs";
import { startSiftqScheduler } from "./src/siftq-service.mjs";
import { startDreaminaScheduler } from "./src/dreamina-service.mjs";
import { stopAll } from "./src/chrome.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function flag(name, fallback = undefined) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = rest[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function positional() {
  return rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
}

async function doctor() {
  const bin = chromePath();
  const node = process.version;
  const dirs = await Promise.all(
    [DATA_DIR, ASSET_DIR].map(async (d) => {
      try {
        await fs.mkdir(d, { recursive: true });
        return `${d} ok`;
      } catch (e) {
        return `${d} FAIL ${e.message}`;
      }
    }),
  );
  const upstream = await fetch("https://www.paba.tv/", { method: "HEAD" })
    .then((r) => `${r.status}`)
    .catch((e) => `ERR ${e.message}`);
  console.log(
    [
      `node        ${node} ${Number(node.slice(1).split(".")[0]) >= 22 ? "✅" : "❌ 需要 >= 22"}`,
      `chrome      ${bin || "❌ 未找到，可用 CHROME_PATH 指定"} `,
      `data dirs   ${dirs.join(" | ")}`,
      `upstream    https://www.paba.tv -> ${upstream}`,
      `headless    ${RUNTIME.headless ? "on（HEADED=1 可关）" : "off"}`,
      `api port    ${RUNTIME.port}`,
      `sync every  ${RUNTIME.syncIntervalMs}ms`,
    ].join("\n"),
  );
}

async function accountAdd() {
  const label = flag("label") || positional()[0] || `acct-${Date.now().toString(36)}`;
  const id = String(flag("id") || label)
    .toLowerCase()
    .replace(/[^\w-]/g, "-");
  const cookieFile = flag("cookies");
  const backend = flag("backend") || process.env.LANE || "chrome";
  await upsertAccount({ id, label, status: "new", headless: true, backend });
  console.log(`▶ 已创建账号槽位 ${id}（${label}）· 执行后端 ${backend}`);

  if (backend === "ego") {
    const r = await syncOne(id);
    if (r.error) throw new Error(r.error);
    console.log(`✅ 已接管 ego 会话，同步 ${r.synced} 条记录`);
    return;
  }

  if (typeof cookieFile === "string") {
    const raw = JSON.parse(await fs.readFile(cookieFile, "utf8"));
    const cookies = Array.isArray(raw) ? raw : raw.cookies;
    const out = await seedCookies(id, cookies);
    console.log(`✅ 已导入登录态 user_id=${out.userId}`);
    return;
  }

  console.log("  即将打开 Chrome 登录页，请用该账号完成登录（Google 或邮箱验证码），完成后自动继续。");
  const out = await loginAccount(id);
  console.log(`✅ 授权成功 user_id=${out.userId}`);
}

async function main() {
  await load();
  switch (cmd) {
    case "doctor":
      return doctor();

    case "serve": {
      // 本地库是单文件，多个实例会互相覆盖；用 pid 锁挡住
      const lockFile = path.join(DATA_DIR, ".server.lock");
      try {
        const prev = JSON.parse(await fs.readFile(lockFile, "utf8"));
        let alive = false;
        try { process.kill(prev.pid, 0); alive = true; } catch {}
        if (alive) {
          console.error(`✖ 已有实例在运行（pid ${prev.pid}，端口 ${prev.port}）。先停掉它再启动。`);
          process.exit(1);
        }
      } catch {}
      await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, port: RUNTIME.port, at: Date.now() }));
      const server = await startServer();
      const stopScheduler = startScheduler();
      const stopVeda = startVedaScheduler();
      const stopSiftq = startSiftqScheduler();
      const stopDreamina = startDreaminaScheduler();
      console.log(`▶ 本地工作台  http://localhost:${RUNTIME.port}`);
      console.log(`▶ SSE 事件    http://localhost:${RUNTIME.port}/api/events`);
      const shutdown = async () => {
        console.log("\n… 收尾中");
        stopScheduler();
        stopVeda();
        stopSiftq();
        stopDreamina();
        server.close();
        await stopAll();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    case "account": {
      const sub = rest[0];
      if (sub === "add") return accountAdd();
      if (sub === "list" || !sub) {
        const rows = await listAccounts();
        if (!rows.length) return console.log("（暂无账号，运行 npm run account 添加）");
        for (const a of rows) {
          const usage = await getUsage(a.id);
          const consumed = Math.max(0, (usage.submitted || 0) - (usage.refunded || 0));
          console.log(
            `${a.id.padEnd(14)} ${String(a.disabled ? "disabled" : a.status).padEnd(10)} user=${(a.upstreamUserId || "-").padEnd(12)} 已消耗 ${consumed}/${RUNTIME.freeDailyLimit} 次 ${a.lastError ? "err=" + a.lastError : ""}`,
          );
        }
        return;
      }
      throw new Error(`未知子命令 account ${sub}`);
    }

    case "login": {
      const id = positional()[0];
      if (!id) throw new Error("用法：npm run login -- <accountId>");
      const out = await loginAccount(id);
      console.log(`✅ ${id} 授权成功 user_id=${out.userId}`);
      return;
    }

    case "sync": {
      const id = positional()[0];
      if (id) {
        const r = await syncOne(id);
        console.log(JSON.stringify(r, null, 1));
      } else {
        const r = await syncAll();
        console.log(JSON.stringify(r, null, 1));
      }
      return;
    }

    case "challenge": {
      const id = positional()[0];
      if (!id) throw new Error("用法：npm run challenge -- <accountId>");
      const r = await solveChallengeFor(id);
      console.log(r.ok ? "✅ 验证通过" : "❌ 未完成验证");
      return;
    }

    case "cookie": {
      const id = positional()[0];
      const file = flag("file");
      if (!id || !file) throw new Error("用法：npm run cookie -- <accountId> --file cookies.json");
      const raw = JSON.parse(await fs.readFile(String(file), "utf8"));
      const out = await seedCookies(id, Array.isArray(raw) ? raw : raw.cookies);
      console.log(`✅ 登录态已导入 user_id=${out.userId}`);
      return;
    }

    case "generate": {
      const prompt = flag("prompt");
      if (!prompt) throw new Error('用法：npm run gen -- --prompt "..." [--model minimax-h3-flash] [--duration 5]');
      const out = await generate({
        accountId: flag("account"),
        prompt,
        model: flag("model"),
        duration: flag("duration"),
        resolution: flag("resolution"),
        aspectRatio: flag("ratio"),
        style: flag("style"),
        seed: flag("seed"),
      });
      console.log(JSON.stringify(out, null, 1));
      return;
    }

    default:
      console.log(`web-free-studio · 本地视频生成工作台

  npm run doctor            环境自检
  npm run account           新增账号并授权（多账号各自独立 profile）
  npm run accounts          查看账号池
  npm run login -- <id>     重新授权某账号
  npm start                 启动本地服务（默认 8790）
  npm run sync              全量对齐上游
  npm run gen -- --prompt "..."   命令行提交一条生成
  npm run challenge -- <id> 触发人机验证（会开有头窗口）

环境变量：
  PORT / HEADED=1 / SYNC_INTERVAL_MS / CHROME_PATH / LANE=chrome|ego
  FREE_DAILY_LIMIT（默认 15）/ MAX_ACTIVE_PER_ACCOUNT（默认 2，与上游一致）
  SUBMIT_CONCURRENCY（默认 2）/ MIN_SUBMIT_INTERVAL_MS（默认 4000）/ DEDUP_WINDOW_MS（默认 60000）`);
  }
}

main().catch(async (e) => {
  console.error("✖", e.message);
  if (e.code === "challenge_required") {
    console.error("  → 该网络被要求人机验证，运行 npm run challenge -- <accountId> 后重试");
  }
  await logEvent("cli_error", String(e.message)).catch(() => {});
  process.exit(1);
});
