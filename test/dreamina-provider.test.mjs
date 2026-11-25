import test from "node:test";
import assert from "node:assert/strict";
import { providerConfig, PROVIDERS } from "../server/src/config.mjs";

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
