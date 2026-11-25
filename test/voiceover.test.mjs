import test from "node:test";
import assert from "node:assert/strict";
import {
  detectCategory,
  extractSellingPoints,
  extractSubject,
  buildVoiceover,
} from "../server/src/providers/voiceover.mjs";

test("品类识别：命中关键词归到对应品类", () => {
  assert.equal(detectCategory("快餐店餐桌旁的汉堡套餐"), "food");
  assert.equal(detectCategory("一瓶精华液置于大理石台面"), "beauty");
  assert.equal(detectCategory("唐装少女在门廊前起舞"), "fashion");
  assert.equal(detectCategory("猫粮和猫砂放在角落"), "pet");
  assert.equal(detectCategory("完全无关的抽象描述"), "general");
});

test("品类识别：长词优先，避免单字误伤（包邮不判成服饰、预制菜判美食）", () => {
  assert.equal(detectCategory("预制菜礼盒，顺丰包邮，现做现发"), "food"); // 不能因"包邮"判成服饰
  assert.equal(detectCategory("餐桌旁的水杯，清洁方便"), "home"); // 餐桌/水杯归一
  assert.equal(detectCategory("连衣裙顺丰包邮"), "fashion");
});

test("卖点提取：价格/数量/优惠/品质", () => {
  const sp = extractSellingPoints("现在只要64.8元，整整7+3的组合份，足足有4个汉堡，限时包邮，真材实料");
  assert.equal(sp.price, "64.8元");
  assert.equal(sp.count, "4个");
  assert.ok(sp.perks.includes("限时"));
  assert.ok(sp.perks.includes("包邮"));
  assert.ok(sp.quality.includes("真材实料"));
});

test("主体提取：取第一小句且去掉运镜词", () => {
  const s = extractSubject("镜头缓慢推近，一位少女身着唐装，背景宫灯流转");
  assert.ok(!s.includes("镜头"));
  assert.ok(!s.includes("推近"));
  assert.ok(s.length <= 24);
});

test("口播生成：含品类、卖点、号召，字数不超预算太多", () => {
  const out = buildVoiceover("快餐店汉堡套餐，只要64.8元，4个汉堡，限时包邮", { duration: 10 });
  assert.equal(out.category, "food");
  assert.ok(out.text.length > 0);
  assert.ok(/64\.8|4个|限时|包邮/.test(out.text), "应包含至少一个卖点");
  assert.ok(out.chars <= out.budget + 12, `字数 ${out.chars} 不应远超预算 ${out.budget}`);
});

test("口播生成：稳定（同输入同输出）", () => {
  const a = buildVoiceover("猫粮，限时活动价", { duration: 10 });
  const b = buildVoiceover("猫粮，限时活动价", { duration: 10 });
  assert.equal(a.text, b.text);
});

test("口播生成：短时长字数更少", () => {
  const short = buildVoiceover("汉堡套餐只要9.9元，限时包邮", { duration: 5 });
  const long = buildVoiceover("汉堡套餐只要9.9元，限时包邮", { duration: 15 });
  assert.ok(short.text.length <= long.text.length + 5);
  assert.ok(short.budget < long.budget);
});

test("口播生成：空 prompt 不崩，退回通用模板", () => {
  const out = buildVoiceover("", { duration: 10 });
  assert.equal(out.category, "general");
  assert.ok(out.text.length > 0);
});

test("多种语气各出一版：都非空，语气标签/开场不同", async () => {
  const { buildAllTones, TONE_IDS } = await import("../server/src/providers/voiceover.mjs");
  const versions = buildAllTones("汉堡套餐，只要64.8元，4个汉堡，限时包邮", { duration: 15 });
  assert.equal(versions.length, TONE_IDS.length);
  assert.ok(TONE_IDS.length >= 6, "至少 6 种语气");
  assert.deepEqual(versions.map((v) => v.tone), TONE_IDS);
  for (const v of versions) {
    assert.ok(v.text.length > 0);
    assert.ok(v.toneLabel);
  }
  // 每版文案必须互不相同（语气差异）
  const texts = new Set(versions.map((v) => v.text));
  assert.equal(texts.size, versions.length, "每種语气应产出不同文案");
});

test("tone 参数生效：相同 prompt 不同语气，开场/号召不同", async () => {
  const { buildVoiceover } = await import("../server/src/providers/voiceover.mjs");
  const warm = buildVoiceover("猫粮，限时活动价", { duration: 15, tone: "warm" });
  const urgent = buildVoiceover("猫粮，限时活动价", { duration: 15, tone: "urgent" });
  const calm = buildVoiceover("猫粮，限时活动价", { duration: 15, tone: "calm" });
  assert.equal(warm.tone, "warm");
  assert.equal(urgent.tone, "urgent");
  assert.notEqual(warm.text, urgent.text);
  assert.notEqual(warm.text, calm.text);
  // 未知 tone 回退 warm
  const bogus = buildVoiceover("猫粮", { duration: 10, tone: "xxx" });
  assert.equal(bogus.tone, "warm");
});

test("特征提取：真实产品特征进文案，不含纯优惠词", async () => {
  const { extractFeatures, buildVoiceover } = await import("../server/src/providers/voiceover.mjs");
  assert.deepEqual(extractFeatures("实木美甲桌，带收纳抽屉，限时包邮只要299元"), ["带收纳抽屉"]);
  assert.deepEqual(extractFeatures("法式耳环，925银针，买一送一"), ["925银针"]);
  assert.deepEqual(extractFeatures("手工羊毛毡小熊玩偶，限量发售"), []); // 限量发售是纯优惠
  // 文案里必须出现真实特征
  const v = buildVoiceover("实木美甲桌，带收纳抽屉，限时包邮只要299元", { duration: 15, tone: "warm" });
  assert.ok(v.text.includes("带收纳抽屉"), "真实特征应进文案：" + v.text);
});

test("新品类识别：饰品/家电/玩偶", async () => {
  const { detectCategory } = await import("../server/src/providers/voiceover.mjs");
  assert.equal(detectCategory("法式耳环，925银针"), "accessory");
  assert.equal(detectCategory("大容量加湿器，静音夜灯"), "appliance");
  assert.equal(detectCategory("手工羊毛毡小熊玩偶"), "toy");
});

test("有真实特征时不再塞通用模板句（差异化）", async () => {
  const { buildVoiceover } = await import("../server/src/providers/voiceover.mjs");
  // 两个不同产品、同品类(home)，文案主体/特征必须不同
  const a = buildVoiceover("实木书桌，带抽屉，包邮", { duration: 15, tone: "warm" });
  const b = buildVoiceover("沙发，可拆洗，包邮", { duration: 15, tone: "warm" });
  assert.notEqual(a.text, b.text);
  assert.ok(a.text.includes("实木书桌"));
  assert.ok(b.text.includes("沙发"));
});
