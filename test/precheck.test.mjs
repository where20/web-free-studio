import test from "node:test";
import assert from "node:assert/strict";
import { precheckPrompt } from "../server/src/providers/precheck.mjs";

test("空 prompt → error", () => {
  const r = precheckPrompt("paba", { prompt: "  " });
  assert.equal(r.ok, false);
  assert.equal(r.level, "error");
  assert.ok(r.issues.some((i) => /为空/.test(i.msg)));
});

test("Paba：图生视频缺首帧 → error", () => {
  const r = precheckPrompt("paba", { prompt: "一只猫", mode: "first", hasFirstFrame: false });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /首帧/.test(i.msg)));
});

test("Veda：<32 汉字 → error（打在原文上）", () => {
  const short = precheckPrompt("veda", { prompt: "一只猫在窗台" }); // 6 字
  assert.equal(short.ok, false);
  assert.ok(short.issues.some((i) => /32 字/.test(i.msg)));
  const okv = precheckPrompt("veda", { prompt: "一只橘猫慵懒地趴在洒满阳光的窗台上伸懒腰打哈欠，毛发细节清晰，温暖治愈的居家氛围" });
  assert.equal(okv.ok, true);
});

test("Veda：正文写画幅 → warn（不阻断）", () => {
  const r = precheckPrompt("veda", { prompt: "一只橘猫慵懒地趴在洒满阳光的窗台上伸懒腰打哈欠，毛发细节清晰温暖的居家氛围，16:9" });
  assert.equal(r.ok, true); // 只是 warn
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /画幅/.test(i.msg)));
});

test("Veda：未写三段式 → info 提示会自动补", () => {
  const r = precheckPrompt("veda", { prompt: "一只橘猫慵懒地趴在洒满阳光的窗台上伸懒腰打哈欠，毛发细节清晰温暖的居家氛围" });
  assert.ok(r.issues.some((i) => i.level === "info" && /三段式/.test(i.msg)));
});

test("SiftQ：中文 prompt → error；缺输入图 → error", () => {
  const r = precheckPrompt("siftq", { prompt: "猫在窗台伸懒腰" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /英文/.test(i.msg)));
  assert.ok(r.issues.some((i) => /输入图/.test(i.msg)));
  const okS = precheckPrompt("siftq", { prompt: "The cat stretches on the windowsill", hasImage: true });
  assert.equal(okS.ok, true);
});

test("SiftQ：正文写画幅/时长 → warn", () => {
  const r = precheckPrompt("siftq", { prompt: "The cat stretches, 9:16, duration 6s", hasImage: true });
  assert.equal(r.ok, true);
  assert.equal(r.level, "warn");
});

test("即梦：>3000 字 → error；正常时给出实际发送预览", () => {
  const long = precheckPrompt("dreamina", { prompt: "字".repeat(3001) });
  assert.equal(long.ok, false);
  const okd = precheckPrompt("dreamina", { prompt: "橘猫在窗台伸懒腰", duration: 5 });
  assert.equal(okd.ok, true);
  assert.match(okd.normalized, /^使用seedance2\.5,生成5秒视频，16:9，720P。/);
});

test("即梦：文案相对时长偏长 → warn", () => {
  const r = precheckPrompt("dreamina", { prompt: "字".repeat(120), duration: 5 }); // 120字 vs 5s*4.5=22.5
  assert.equal(r.ok, true);
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /口播/.test(i.msg)));
});

test("即梦：正文写 768p/1080p → warn（agent 会反问改清晰度）", () => {
  const r = precheckPrompt("dreamina", { prompt: "女主角面对镜头介绍产品，1080p 高清", duration: 10 });
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.level === "warn" && /720P/.test(i.msg) && /1080P|768P|清晰度/.test(i.msg)));
});

test("即梦：有口播意图但缺台词 → warn（agent 必反问）", () => {
  const r = precheckPrompt("dreamina", {
    prompt: "一位年轻女性面对镜头亲切分享产品，语速紧凑清晰，嘴型与台词同步",
    duration: 10,
  });
  assert.equal(r.ok, true);
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /台词|口播/.test(i.msg) && /反问|补充/.test(i.msg)));
});

test("即梦：有台词（口播：…）→ 不再报缺台词", () => {
  const r = precheckPrompt("dreamina", {
    prompt: "一位女性面对镜头分享产品。口播：这款真的太好用了，赶紧下单",
    duration: 10,
  });
  assert.ok(!r.issues.some((i) => /没写具体台词/.test(i.msg)));
});

test("即梦：有引号包住的具体台词 → 不报缺台词", () => {
  const r = precheckPrompt("dreamina", {
    prompt: "女主面对镜头说：“今天给大家推荐这款，真的绝了”",
    duration: 10,
  });
  assert.ok(!r.issues.some((i) => /没写具体台词/.test(i.msg)));
});

test("即梦：短时长+多镜头 → warn", () => {
  const r = precheckPrompt("dreamina", {
    prompt: "镜头1大全景，镜头2中景人物，镜头3特写产品，镜头切换流畅",
    duration: 5,
  });
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => /镜头|分镜|节奏/.test(i.msg)));
});

test("即梦：正常画面描述+时长 → 无 error/warn（可能仅 info）", () => {
  const r = precheckPrompt("dreamina", { prompt: "橘猫在洒满阳光的窗台上伸懒腰，毛发清晰，镜头缓慢推近", duration: 10 });
  assert.equal(r.ok, true);
  assert.notEqual(r.level, "error");
});

test("即梦：台词标签后夹括号说明（口播台词（逐字口述）：…）→ 不报缺台词", () => {
  const r = precheckPrompt("dreamina", {
    prompt: "女主坐在餐桌旁分享。口播台词（逐字自然口述、嘴型与台词同步）：这个套餐真的很实惠，满满一桌。",
    duration: 14,
  });
  assert.ok(!r.issues.some((i) => /没写具体台词/.test(i.msg)), "括号说明不应导致漏判台词");
});

test("即梦：语速只算台词正文，不把画面描述算进去", () => {
  const long = "明亮整洁的快餐店餐桌旁，".repeat(8) + "口播台词：这个套餐真的很实惠，两个人吃到撑。";
  const r = precheckPrompt("dreamina", { prompt: long, duration: 14 });
  assert.ok(!r.issues.some((i) => /偏长/.test(i.msg)), "画面描述不应计入语速");
});

test("即梦：台词本身超长仍要 warn", () => {
  const script = "口播：" + "这个汉堡真的特别好吃肉质鲜嫩多汁配上脆爽生菜和特制酱料".repeat(4);
  const r = precheckPrompt("dreamina", { prompt: script, duration: 10 });
  assert.ok(r.issues.some((i) => /台词约/.test(i.msg) || /偏长/.test(i.msg)));
});
