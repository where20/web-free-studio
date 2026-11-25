import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnchors, applyAnchors } from "../server/src/providers/continuity.mjs";

const SEG1 = "明亮整洁的快餐店餐桌旁，一位年轻女性面对镜头，黑色齐肩直发、空气刘海，正红唇，穿着黑色方领蕾丝边上衣、珍珠纽扣，语气像悄悄安利朋友。桌上摆满汉堡、炸鸡、薯条套餐，镜头在中景与产品特写之间自然切换，暖白光，浅景深。";

test("从首段提示词抽出人物/场景/影像三类锚点", () => {
  const a = extractAnchors(SEG1);
  assert.ok(a.subject.length, "应识别出人物");
  assert.ok(a.card.includes("【人物锚点】"));
  assert.ok(a.card.includes("【场景锚点】"));
  assert.ok(a.card.includes("【影像锚点】"));
  assert.ok(/头发|直发|刘海/.test(a.card), "应带上发型细节");
  assert.ok(/上衣|穿着/.test(a.card), "应带上服装细节");
});

test("锚点卡可注入任意段落，且不重复注入", () => {
  const a = extractAnchors(SEG1);
  const seg2 = "餐盘整体推到汉堡横截面特写，热气升腾。";
  const once = applyAnchors(seg2, a);
  assert.ok(once.startsWith("【人物锚点】"));
  assert.ok(once.endsWith(seg2));
  const twice = applyAnchors(once, a);
  assert.equal(twice, once, "已有锚点卡不应再叠加");
});

test("空提示词/空卡片安全返回", () => {
  assert.equal(applyAnchors("", "【人物锚点】x"), "");
  assert.equal(applyAnchors("abc", ""), "abc");
  assert.equal(extractAnchors("").card, "");
});
