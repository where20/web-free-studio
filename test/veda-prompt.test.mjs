/**
 * Veda prompt 规范化单测（node:test，零依赖）。
 * 跑法：node --test test/
 *
 * 重点覆盖踩过的坑：用户写全三段式但 description 无 [Shot N] → 上游 500。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePrompt } from "../server/src/providers/veda.mjs";

const DESC = "integrated_multimodal_description:";
const SND = "overall_soundscape:";
const MUS = "non_diegetic_music:";

test("纯文本 → 补全三段式，且 description 带 [Shot 1]", () => {
  const out = normalizePrompt("金色云海翻涌，镜头缓缓推近");
  assert.ok(out.includes(DESC));
  assert.ok(out.includes(SND));
  assert.ok(out.includes(MUS));
  assert.match(out, /integrated_multimodal_description:\s*\[Shot 1\]/);
});

test("三段式齐全但无 Shot 标记 → 补 [Shot 1]（本次修复的 bug）", () => {
  const input = [
    `${DESC} 金色云海翻涌，仙宫浮现，镜头推近`,
    `${SND} 高空风声与远处雷鸣`,
    `${MUS} 无音乐`,
  ].join("\n\n");
  const out = normalizePrompt(input);
  assert.match(out, /integrated_multimodal_description:\s*\[Shot 1\]/, "description 段应被补上 [Shot 1]");
  // 只补在 description 段，别污染音效段
  assert.ok(out.indexOf("[Shot 1]") < out.indexOf(SND));
});

test("三段式齐全 + 已有 [Shot 1] → 原样返回，不重复插入", () => {
  const input = [
    `${DESC} [Shot 1] 云海翻涌`,
    `${SND} 风声`,
    `${MUS} 无`,
  ].join("\n\n");
  const out = normalizePrompt(input);
  assert.equal((out.match(/\[Shot 1\]/g) || []).length, 1);
  assert.equal(out, input);
});

test("已有 [Shot 3] 也算数，不强行改成 [Shot 1]", () => {
  const input = [
    `${DESC} [Shot 3] 多镜头场景`,
    `${SND} 风声`,
    `${MUS} 无`,
  ].join("\n\n");
  const out = normalizePrompt(input);
  assert.ok(out.includes("[Shot 3]"));
  assert.equal((out.match(/\[Shot\s+\d+\]/g) || []).length, 1);
});

test("description 字段存在但其他段缺失 → 补 Shot 标记 + 缺失段", () => {
  const input = `${DESC} 云海翻涌，镜头推近`;
  const out = normalizePrompt(input, { soundscape: "自定义风声", music: "自定义配乐" });
  assert.match(out, /integrated_multimodal_description:\s*\[Shot 1\]/);
  assert.ok(out.includes(`${SND} 自定义风声`));
  assert.ok(out.includes(`${MUS} 自定义配乐`));
  assert.equal((out.match(/\[Shot 1\]/g) || []).length, 1);
});

test("空字符串 → 原样返回（长度校验交给 vedaSubmit 打在原文上）", () => {
  assert.equal(normalizePrompt(""), "");
  assert.equal(normalizePrompt("   "), "");
});

test("幂等：normalize 两次结果一致", () => {
  const input = `${DESC} 云海翻涌\n\n${SND} 风声`;
  const once = normalizePrompt(input);
  const twice = normalizePrompt(once);
  assert.equal(twice, once);
});
