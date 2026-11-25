/**
 * 自适应时长推荐（纯函数，零依赖）。
 *
 * 解决的问题：四个平台单段上限只有 15–20s，但「带货探店」「剧情短剧」这类内容
 * 本身需要 25–35s。用户凭感觉填 5s 或 15s，结果要么讲不完、要么白扣一次额度。
 *
 * 做法（规则引擎，无 AI）：
 *   ① 判内容类型 → 基准时长 + 合理区间（带货探店 28s / 25–35s 等）
 *   ② 按台词字数（4.5 字/秒）、镜头数（每镜 ≥3s）、场景数、卖点数做修正
 *   ③ 与平台单段上限取交集；装不下就给出等分拆段方案
 *   ④ 每条修正都写进 reasons —— 推荐值必须可解释，不能是黑箱
 */

/** 各平台单段时长能力（与 config.mjs / providers 的校验保持一致）
 *  presets 为空的平台是「连续档位」（任意整数秒都收），非空则只能取这些值。
 *  即梦后端允许 4–20，但实测通过的只有 5s / 15s，按已验证值收口到 15 更稳妥。 */
export const PLATFORM_LIMITS = {
  paba: { min: 4, max: 15, presets: [] },
  veda: { min: 5, max: 15, presets: [5, 10, 15] },
  siftq: { min: 6, max: 15, presets: [6, 10, 15] },
  dreamina: { min: 4, max: 15, presets: [] },
};

/**
 * 内容类型基准表。顺序即优先级（靠前的类型命中即采用）。
 * base/range 是行业常见成片长度：带转化的内容 25–35s，氛围空镜 5–12s。
 */
const PROFILES = [
  {
    id: "story",
    label: "剧情短剧",
    base: 32,
    range: [25, 45],
    words: ["剧情", "短剧", "剧本", "情节", "反转", "情景剧", "演绎", "对戏", "故事线", "多段剧情"],
  },
  {
    id: "tour",
    label: "带货探店",
    base: 28,
    range: [22, 35],
    words: ["探店", "试吃", "试喝", "试戴", "试穿", "到店", "进店", "店内", "门店", "逛店", "打卡", "团购", "套餐", "优惠券", "带货", "下单", "链接在", "小黄车"],
  },
  {
    id: "unboxing",
    label: "开箱",
    base: 18,
    range: [12, 22],
    words: ["开箱", "拆箱", "拆快递", "开盒", "拆包"],
  },
  {
    id: "comparison",
    label: "测评对比",
    base: 22,
    range: [18, 28],
    words: ["测评", "评测", "横评", "对比", "区别", "差别", "前后对比", "实测"],
  },
  {
    id: "tutorial",
    label: "教程步骤",
    base: 26,
    range: [20, 35],
    words: ["教程", "教学", "步骤", "流程", "教你", "怎么用", "怎么选", "新手", "上手", "操作方法"],
  },
  {
    id: "pitch",
    label: "单品种草",
    base: 20,
    range: [15, 25],
    words: ["种草", "安利", "推荐", "口播", "分享", "卖点", "单品", "好物", "入手"],
  },
  {
    id: "dance",
    label: "卡点舞蹈",
    base: 15,
    range: [10, 20],
    words: ["卡点", "舞蹈", "跳舞", "变装", "换装", "节奏点", "运镜卡点"],
  },
  {
    id: "ambience",
    label: "氛围空镜",
    base: 8,
    range: [5, 12],
    words: ["空镜", "氛围", "风景", "延时", "慢动作", "静物", "纯画面", "无台词", "产品特写", "背景图"],
  },
];

const DEFAULT_PROFILE = { id: "general", label: "通用画面", base: 10, range: [5, 15], words: [] };

/** 中文语速：口播文案约 4.5 字/秒（与 voiceover.mjs 的字数预算同一口径） */
export const CHARS_PER_SEC = 4.5;
/** 一个镜头最少给几秒，低于这个数会「一闪而过」 */
const SEC_PER_SHOT = 3;
/** 每多一个卖点/场景需要的额外秒数 */
const SEC_PER_POINT = 3;
const SEC_PER_SCENE = 3;

function cnLen(s) {
  return (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;
}

/**
 * 把任意秒数贴到平台真正接受的档位上。
 * Veda 只认 5/10/15、SiftQ 只认 6/10/15 —— 推荐值必须可直接提交，
 * 否则用户照抄后又会被 normalizeDuration 静默改档。
 */
export function snapDuration(v, limits) {
  const n = Number(v);
  const presets = limits.presets || [];
  if (!presets.length) {
    return Math.min(Math.max(Math.round(n), limits.min), limits.max);
  }
  let best = presets[0];
  for (const p of presets) {
    if (p < limits.min || p > limits.max) continue;
    if (Math.abs(p - n) < Math.abs(best - n)) best = p;
  }
  return best;
}

/** 内容类型识别：类型表按优先级遍历，命中即返回（长词天然不易误伤短词） */
export function detectProfile(prompt) {
  const p = String(prompt || "");
  for (const prof of PROFILES) {
    const hit = prof.words.find((w) => p.includes(w));
    if (hit) return { ...prof, hit };
  }
  return { ...DEFAULT_PROFILE, hit: "" };
}

/**
 * 抽出台词正文：支持「口播：xxx」「台词：xxx」「说：xxx」「唱：xxx」以及引号包裹的台词。
 * 台词字数直接决定「这条片子最短能多短」——说不完就是废片。
 */
export function extractScript(prompt) {
  const p = String(prompt || "");
  const labeled = p.match(/(?:口播|台词|文案|旁白|说|唱)\s*[：:]\s*([^\n。]*[。！？!?]?)/);
  if (labeled) return { text: labeled[1].trim(), from: "labeled" };
  const quoted = p.match(/["“「]([^"”」]{4,})["”」]/);
  if (quoted) return { text: quoted[1].trim(), from: "quoted" };
  return { text: "", from: "" };
}

/** 数镜头：数字+「镜头/个镜头」、分镜、切换、景别术语 */
export function countShots(prompt) {
  const p = String(prompt || "");
  const explicit = p.match(/(\d{1,2})\s*(?:个)?(?:镜头|分镜|段)/);
  if (explicit) return Math.max(1, Number(explicit[1]));
  const cues = (p.match(/分镜|镜头切换|切到|切换|特写|中景|全景|近景|空镜|转场/g) || []).length;
  // 出现两个以上景别/切换线索就认为至少两个镜头（「静物特写」这类单词仍算一个）
  return cues >= 2 ? Math.max(2, Math.ceil(cues / 2)) : 1;
}

/** 数场景切换：地点/空间变换词 */
export function countScenes(prompt) {
  const p = String(prompt || "");
  const marks = (p.match(/店内|门口|街道|厨房|后厨|客厅|卧室|户外|室内|天台|车里|办公室|柜台|餐桌|试衣间/g) || []);
  return new Set(marks).size || 1;
}

/** 数卖点：价格/优惠/赠品/服务承诺（有卖点就要留时间讲） */
export function countPoints(prompt) {
  const p = String(prompt || "");
  const marks = p.match(/限时|优惠|折扣|秒杀|满减|包邮|买一送一|赠|送|免费|价格|只要|不到|性价比|正品|售后|七天|顺丰|现货|新品|爆款/g) || [];
  return new Set(marks).size;
}

/**
 * 主入口：给出推荐时长 + 拆段方案 + 依据。
 * @param {string} provider paba | veda | siftq | dreamina
 * @param {object} input { prompt, duration }
 */
export function planDuration(provider = "paba", input = {}) {
  const prompt = String(input.prompt || "");
  const limits = PLATFORM_LIMITS[provider] || PLATFORM_LIMITS.paba;
  const reasons = [];
  const notes = [];

  if (!prompt.trim()) {
    return {
      ok: false, provider, profile: DEFAULT_PROFILE.id, label: DEFAULT_PROFILE.label,
      target: limits.presets[0], recommended: limits.presets[0],
      range: DEFAULT_PROFILE.range, singleMax: limits.max, fits: true,
      segments: [{ index: 1, duration: limits.presets[0] }],
      current: Number(input.duration) || null,
      reasons: ["还没有提示词，先写画面内容再推荐"], notes,
    };
  }

  const prof = detectProfile(prompt);
  reasons.push(`内容类型判定为「${prof.label}」${prof.hit ? `（命中「${prof.hit}」）` : ""}，行业常见长度 ${prof.range[0]}–${prof.range[1]}s，基准 ${prof.base}s`);

  let score = prof.base;

  // ① 台词决定下限：说不完就是废片
  const script = extractScript(prompt);
  let minByScript = 0;
  if (script.text) {
    const chars = cnLen(script.text);
    minByScript = Math.ceil(chars / CHARS_PER_SEC);
    reasons.push(`台词约 ${chars} 字，按 ${CHARS_PER_SEC} 字/秒至少需要 ${minByScript}s 才说得完`);
    if (minByScript > score) score = minByScript;
  } else if (/口播|台词|旁白|说|讲/.test(prompt) && !/无台词|没有台词|不要台词|不说话|不出声|静音/.test(prompt)) {
    notes.push("提到了口播但没写具体台词，先补台词再定时长更准");
  }

  // ② 镜头数：每镜至少 3s，否则一闪而过
  const shots = countShots(prompt);
  if (shots > 1) {
    const minByShots = shots * SEC_PER_SHOT;
    reasons.push(`约 ${shots} 个镜头，每镜按 ${SEC_PER_SHOT}s 算需要 ${minByShots}s`);
    if (minByShots > score) score = minByShots;
  }

  // ③ 场景数：每换一个空间，观众要重新认环境
  const scenes = countScenes(prompt);
  if (scenes > 1) {
    const plus = (scenes - 1) * SEC_PER_SCENE;
    score += plus;
    reasons.push(`${scenes} 个场景切换，每个换场 +${SEC_PER_SCENE}s（共 +${plus}s）`);
  }

  // ④ 卖点数：每个卖点要留出讲的时间
  const points = countPoints(prompt);
  if (points > 2) {
    const plus = (points - 2) * SEC_PER_POINT;
    score += plus;
    reasons.push(`${points} 个卖点，超出 2 个的部分每个 +${SEC_PER_POINT}s（共 +${plus}s）`);
  }

  // 收敛到「内容类型合理区间」——这一步只管内容需求，不受平台上限影响
  const lo = prof.range[0];
  const hi = prof.range[1];
  let target = Math.round(score);
  const clamped = Math.min(Math.max(target, lo), hi);
  if (clamped !== target) {
    reasons.push(`收敛到「${prof.label}」合理区间 ${lo}–${hi}s`);
    target = clamped;
  }

  // 单段可提交值：先贴到平台档位，装不下的部分靠拆段
  const singleMax = limits.max;
  const fits = target <= singleMax;
  const segments = [];

  if (!fits) {
    const count = Math.ceil(target / singleMax);
    const per = snapDuration(target / count, limits);
    for (let i = 0; i < count; i += 1) segments.push({ index: i + 1, duration: per });
    reasons.push(`内容需 ${target}s 但平台单段上限 ${singleMax}s，拆成 ${count} 段各 ${per}s 再拼接`);
  } else {
    segments.push({ index: 1, duration: snapDuration(target, limits) });
  }
  // 表单该填的值：装得下就填目标时长，装不下就填每段时长
  const recommended = segments[0].duration;

  if (prof.id === "tour") {
    notes.push("带货探店节奏：前 3s 抛钩子（最馋的一口/最低价），中段讲 2–3 个卖点，结尾 3s 给 CTA");
    notes.push("这类片子 25–35s（30s 左右）是转化甜区，短于 20s 往往讲不完卖点");
    if (!fits) notes.push(`${target}s 装不进单段 ${singleMax}s，建议按「钩子+产品」/「卖点+优惠+CTA」两段拍再拼接`);
  } else if (prof.id === "pitch") {
    notes.push("单品种草 15–20s 完播率最好，卖点控制在 2 个以内");
  } else if (prof.id === "ambience") {
    notes.push("纯画面 5–8s 足够，越长越容易掉完播");
  }

  return {
    ok: true,
    provider,
    profile: prof.id,
    label: prof.label,
    target, // 内容本身需要的总时长（不受平台限制）
    recommended, // 单段建议提交值 = min(target, 平台单段上限)
    range: [lo, hi],
    singleMax,
    fits, // 单段能否装下整条内容
    segments, // 拆段方案（fits 时只有一段）
    current: Number(input.duration) || null,
    reasons,
    notes,
  };
}
