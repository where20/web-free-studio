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
