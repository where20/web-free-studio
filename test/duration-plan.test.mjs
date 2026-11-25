import { test } from "node:test";
import assert from "node:assert/strict";
import { planDuration, detectProfile, extractScript, countShots, PLATFORM_LIMITS } from "../server/src/providers/duration-plan.mjs";

const TOUR_PROMPT = `明亮整洁的快餐店餐桌旁，一位年轻女性面对镜头亲切分享，语气像悄悄安利朋友，桌上摆放丰富的汉堡、炸鸡、薯条套餐，镜头在中景与产品特写之间自然切换，画面可用简洁促销字幕。口播台词：我偷偷跟你们说哦，这家快餐店的套餐是真实惠，满满一桌，汉堡炸鸡薯条管够，味道也在线，现在还有限时优惠，链接就在左下角，喜欢的自己看看，买着也放心。`;
const AMBIENCE_PROMPT = `微距镜头下一只蓝色蝴蝶停在白色雏菊上，翅膀缓慢开合，清晨露珠，景深柔和，无台词`;
const STORY_PROMPT = `店内，女主推门进店，店员迎上来，两人对话三句后女主露出惊讶表情，切到产品特写，反转结局。台词：你说这个才二十？`;

test("带货探店识别为 tour，且推荐落在 22-35s 甜区", () => {
  const r = planDuration("dreamina", { prompt: TOUR_PROMPT });
  assert.equal(r.profile, "tour");
  assert.equal(r.label, "带货探店");
  assert.ok(r.target >= 22 && r.target <= 35, `内容目标 ${r.target} 应落在 22-35`);
  assert.equal(r.recommended, r.segments[0].duration, "表单建议值应等于每段时长");
  assert.ok(r.recommended <= r.singleMax);
});

test("带货探店 30s 超过单段上限 → 给出拆段方案且每段不超上限", () => {
  const r = planDuration("paba", { prompt: TOUR_PROMPT });
  const sum = r.segments.reduce((a, s) => a + s.duration, 0);
  assert.equal(r.singleMax, PLATFORM_LIMITS.paba.max);
  if (!r.fits) {
    assert.ok(r.segments.length >= 2);
    for (const s of r.segments) assert.ok(s.duration <= PLATFORM_LIMITS.paba.max, `段长 ${s.duration} 超上限`);
    assert.ok(Math.abs(sum - r.target) <= r.segments.length, "拆段总和应接近内容目标时长");
  }
});

test("同一提示词：即梦单段上限更高，拆段数不多于 Paba", () => {
  const paba = planDuration("paba", { prompt: TOUR_PROMPT });
  const dm = planDuration("dreamina", { prompt: TOUR_PROMPT });
  assert.ok(dm.segments.length <= paba.segments.length);
});

test("空镜/无台词内容推荐短时长（≤12s）", () => {
  const r = planDuration("paba", { prompt: AMBIENCE_PROMPT });
  assert.equal(r.profile, "ambience");
  assert.ok(r.target <= 12, `空镜推荐 ${r.target}s 偏长`);
  assert.equal(r.fits, true);
});

test("剧情短剧推荐长于单品种草", () => {
  const story = planDuration("dreamina", { prompt: STORY_PROMPT });
  const pitch = planDuration("dreamina", { prompt: "客厅里女生手拿保温杯面对镜头安利，口播：这个杯子我用了半年，早上倒的水晚上还烫嘴。" });
  assert.equal(story.profile, "story");
  assert.ok(story.target > pitch.target, `剧情 ${story.target}s 应长于种草 ${pitch.target}s`);
});

test("台词字数决定时长下限：字数多则推荐值不低于字数/语速", () => {
  const long = "口播：" + "这个汉堡真的特别好吃肉质鲜嫩多汁配上脆爽生菜和特制酱料一口下去特别满足" .repeat(2);
  const r = planDuration("dreamina", { prompt: long });
  const chars = (long.match(/[\u4e00-\u9fa5]/g) || []).length;
  assert.ok(r.target >= Math.ceil(chars / 4.5) || r.target === r.range[1], "应被台词下限抬高或已到区间上限");
});

test("推荐值永远落在平台能力区间内", () => {
  for (const prov of Object.keys(PLATFORM_LIMITS)) {
    const lim = PLATFORM_LIMITS[prov];
    for (const p of [TOUR_PROMPT, AMBIENCE_PROMPT, STORY_PROMPT]) {
      const r = planDuration(prov, { prompt: p });
      assert.ok(r.recommended >= lim.min && r.recommended <= lim.max, `${prov} 单段推荐 ${r.recommended} 越界`);
      if (lim.presets.length) {
        assert.ok(lim.presets.includes(r.recommended), `${prov} 推荐 ${r.recommended} 不在档位 ${lim.presets.join("/")} 内`);
      }
      assert.ok(r.target >= r.range[0] && r.target <= r.range[1], `${prov} 目标 ${r.target} 越区间`);
    }
  }
});

test("空提示词不抛错，给出可执行提示", () => {
  const r = planDuration("paba", { prompt: "" });
  assert.equal(r.ok, false);
  assert.ok(r.reasons[0].includes("先写画面内容"));
});

test("每次推荐都带可解释依据", () => {
  const r = planDuration("dreamina", { prompt: TOUR_PROMPT });
  assert.ok(r.reasons.length >= 2);
  assert.ok(r.reasons.some((s) => s.includes("内容类型")));
});

test("detectProfile 长词优先、不误判空镜为带货", () => {
  assert.equal(detectProfile("探店打卡，试吃三款").id, "tour");
  assert.equal(detectProfile("微距空镜，无台词").id, "ambience");
  assert.equal(detectProfile("随便拍点什么").id, "general");
});

test("extractScript 支持标签式与引号式台词", () => {
  assert.ok(extractScript("口播：今天这个真划算。").text.includes("划算"));
  assert.ok(extractScript('她对镜头说"这款真的可以"然后走开').text.includes("这款"));
  assert.equal(extractScript("无台词画面").text, "");
});

test("countShots 识别显式镜头数与景别线索", () => {
  assert.equal(countShots("3个镜头，从远到近"), 3);
  assert.ok(countShots("中景切特写，再切全景，最后空镜转场") > 1);
  assert.equal(countShots("静物特写"), 1);
  assert.ok(countShots("切到产品特写") >= 2);
});

test("无台词不会被误判成「提了口播没写台词」", () => {
  const r = planDuration("paba", { prompt: "微距空镜，翅膀缓慢开合，无台词" });
  assert.ok(!r.notes.some((n) => n.includes("没写具体台词")));
});
