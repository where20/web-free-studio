import { planDuration } from "/Users/xiaoan/Desktop/REA/web-free-studio/server/src/providers/duration-plan.mjs";

const cases = [
  ["带货探店（刚才那条）", `明亮整洁的快餐店餐桌旁，一位年轻女性面对镜头亲切分享，语气像悄悄安利朋友，桌上摆放丰富的汉堡、炸鸡、薯条套餐，镜头在中景与产品特写之间自然切换，画面可用简洁促销字幕。口播台词：我偷偷跟你们说哦，这家快餐店的套餐是真实惠，满满一桌，汉堡炸鸡薯条管够，味道也在线，现在还有限时优惠，链接就在左下角，喜欢的自己看看，买着也放心。`],
  ["纯空镜（蝴蝶）", `微距镜头下一只蓝色蝴蝶停在白色雏菊上，翅膀缓慢开合，清晨露珠，景深柔和，无台词`],
  ["剧情短剧", `店内，女主推门进店，店员迎上来，两人对话三句后女主露出惊讶表情，切到产品特写，反转结局。台词：你说这个才二十？`],
  ["单品种草", `客厅里女生手拿保温杯，面对镜头安利保温效果，口播：这个杯子我用了半年，早上倒的水晚上还烫嘴。`],
];

for (const [name, prompt] of cases) {
  for (const prov of ["paba", "dreamina"]) {
    const r = planDuration(prov, { prompt, duration: 5 });
    console.log(`\n【${name}】${prov} → ${r.label} 目标 ${r.target}s / 单段 ${r.recommended}s（单段上限 ${r.singleMax}）${r.fits ? " ✅ 一段搞定" : " ⚠ 需拆 " + r.segments.map(s=>s.duration).join("+")}`);
    r.reasons.forEach((x) => console.log("   · " + x));
    (r.notes||[]).forEach((x) => console.log("   ※ " + x));
  }
}
