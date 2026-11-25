import test from "node:test";
import assert from "node:assert/strict";
import { providerConfig, PROVIDERS } from "../server/src/config.mjs";
import { findRun, isTerminal, rankDreaminaAccounts, coolingAccounts } from "../server/src/providers/dreamina.mjs";

test("默认 provider 是 paba，缺省/旧账号行为零变化", () => {
  assert.equal(providerConfig(undefined).id, "paba");
  assert.equal(providerConfig({}).id, "paba");
  assert.equal(providerConfig("unknown-provider").id, "paba");
  assert.equal(providerConfig({ provider: "paba" }).id, "paba");
});

test("Paba 平台配置保持历史值（回归保护）", () => {
  const p = PROVIDERS.paba;
  assert.equal(p.identityCookie, "h3v");
  assert.deepEqual(p.cookieNames, ["h3v", "h3s", "__Host-h3d"]);
  assert.equal(p.mePath, "/auth/me");
  assert.equal(p.loginPath, "/auth/account/login");
  assert.equal(p.cookieDomain, "www.paba.tv");
  assert.equal(p.hasListTasks, true);
  assert.deepEqual(p.parseMe({ ok: true, user_id: "s2a:1" }), { ok: true, user_id: "s2a:1" });
});

test("Dreamina 走字节 passport 体系", () => {
  const d = providerConfig({ provider: "dreamina" });
  assert.equal(d.id, "dreamina");
  assert.equal(d.identityCookie, "sessionid");
  assert.ok(d.cookieNames.includes("sessionid"));
  assert.ok(d.cookieNames.includes("sid_tt"));
  assert.ok(d.cookieNames.includes("uid_tt"));
  assert.ok(d.cookieDomainRe.test(".capcut.com"));
  assert.equal(d.cookieDomainRe.test("www.paba.tv"), false);
  assert.equal(d.hasListTasks, false);
  assert.equal(d.loginPath, null);
  assert.match(d.mePath, /passport\/web\/account\/info/);
});

test("Dreamina 身份接口归一化：有 user_id_str 才算登录", () => {
  const d = PROVIDERS.dreamina;
  assert.deepEqual(d.parseMe({ data: { user_id_str: "7711", screen_name: "u" } }), {
    ok: true,
    user_id: "7711",
  });
  assert.deepEqual(d.parseMe({ data: {} }), { ok: false, user_id: undefined });
  assert.deepEqual(d.parseMe({}), { ok: false, user_id: undefined });
});

test("两个平台的 cookie 不与对方域名串号", () => {
  assert.equal(PROVIDERS.paba.cookieDomainRe.test("dreamina.capcut.com"), false);
  assert.equal(PROVIDERS.dreamina.cookieDomainRe.test("www.paba.tv"), false);
  assert.equal(PROVIDERS.dreamina.cookieDomainRe.test("dreamina.capcut.com"), true);
  assert.equal(PROVIDERS.paba.cookieDomainRe.test("www.paba.tv"), true);
});

test("findRun 严格按 run_id 匹配：查不到就返回 null，不退回最后一条", () => {
  const thread = {
    run_list: [
      { run_id: "old-1", state: 3, entry_list: [] },
      { run_id: "new-2", state: 2, entry_list: [] },
    ],
  };
  // 命中自己的 run
  assert.equal(findRun(thread, "old-1").state, 3);
  // 查不到不能拿最后一条顶替（否则老任务会显示新任务的状态 / 镜像别人的视频）
  assert.equal(findRun(thread, "gone-3"), null);
  assert.equal(findRun({ run_list: [] }, "any"), null);
});

test("stale 视为终态，不再占在途槽位", () => {
  assert.equal(isTerminal("stale"), true);
  assert.equal(isTerminal("running"), false);
});

test("findRun：state=4 判失败；fail_reason 是对象时也要识别并归一化", () => {
  const busy = {
    code: 10001,
    message: "The server is busy. Please try again later.",
    detail: "agent execute failed: llm gateway HTTP 429",
  };
  const snap = findRun(
    { run_list: [{ run_id: "r1", state: 4, entry_list: [], fail_reason: busy }] },
    "r1",
  );
  assert.equal(snap.status, "failed");
  assert.match(snap.failReason, /上游繁忙/);
  assert.match(snap.failReason, /429|限流/);
});

test("findRun：state=3 但文案写着失败（限流）→ 不能当 done", () => {
  const entries = [
    { message: { role: "assistant", content: [{ type: "text", data: "视频生成失败：当前账号的请求频率超出限制。请稍后再试。" }] } },
  ];
  const snap = findRun({ run_list: [{ run_id: "r2", state: 3, entry_list: entries }] }, "r2");
  assert.equal(snap.status, "failed");
  assert.equal(snap.artifactId, null);
});

test("findRun：state=3 正常拿到产物 → done", () => {
  const entries = [
    { message: { role: "assistant", content: [{ sub_type: "biz/x_artifact_slots_part", data: JSON.stringify({ slots: [{ type: "video", artifact_id: "1501" }] }) }] } },
  ];
  const snap = findRun({ run_list: [{ run_id: "r3", state: 3, entry_list: entries }] }, "r3");
  assert.equal(snap.status, "done");
  assert.equal(snap.artifactId, "1501");
});

test("账号池排序：在线未冷却 → 在途少 → 最久未用", () => {
  const now = Date.now();
  const accts = [
    { id: "a", provider: "dreamina", status: "online", lastSubmitAt: 300 },
    { id: "b", provider: "dreamina", status: "online", lastSubmitAt: 100 },
    { id: "c", provider: "dreamina", status: "online", lastSubmitAt: 200 },
  ];
  // 都没在途：谁最久没提交谁先上
  assert.deepEqual(rankDreaminaAccounts(accts, {}, { maxActive: 1, now }).map((a) => a.id), ["b", "c", "a"]);
  // a 已有 1 条在途（maxActive=1）→ 排除
  assert.deepEqual(rankDreaminaAccounts(accts, { a: 1 }, { maxActive: 1, now }).map((a) => a.id), ["b", "c"]);
  // 多槽位时按在途数升序
  assert.deepEqual(rankDreaminaAccounts(accts, { a: 1, b: 2 }, { maxActive: 3, now }).map((a) => a.id), ["c", "a", "b"]);
});

test("账号池排序：冷却中的号被跳过，冷却到期自动恢复", () => {
  const now = 1_000_000;
  const accts = [
    { id: "hot", provider: "dreamina", status: "online", cooldownUntil: now + 60_000, lastSubmitAt: 0 },
    { id: "cool", provider: "dreamina", status: "online", lastSubmitAt: 500 },
  ];
  assert.deepEqual(rankDreaminaAccounts(accts, {}, { maxActive: 1, now }).map((a) => a.id), ["cool"]);
  // 到期后可再派
  assert.equal(rankDreaminaAccounts(accts, {}, { maxActive: 1, now: now + 61_000 }).length, 2);
  // 冷却摘要给出剩余秒数
  const c = coolingAccounts(accts, now);
  assert.equal(c.length, 1);
  assert.equal(c[0].id, "hot");
  assert.equal(c[0].waitSec, 60);
});

test("账号池排序：非即梦账号/离线/禁用一律不参与", () => {
  const now = Date.now();
  const accts = [
    { id: "paba1", provider: "paba", status: "online" },
    { id: "off", provider: "dreamina", status: "error" },
    { id: "dis", provider: "dreamina", status: "online", disabled: true },
    { id: "ok", provider: "dreamina", status: "online" },
  ];
  assert.deepEqual(rankDreaminaAccounts(accts, {}, { maxActive: 1, now }).map((a) => a.id), ["ok"]);
});
