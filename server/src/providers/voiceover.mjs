/**
 * 本地口播文案生成器（零依赖、无 AI）。
 *
 * 输入：视频画面提示词（prompt）+ 时长
 * 输出：一段电商/短视频口播台词，按品类规则拼接，字数随时长收敛。
 *
 * 设计原则：
 *  - 不调用任何外部服务，纯规则拼接；
 *  - 从 prompt 提取主体、价格/数量/优惠/品质等卖点，套对应品类句式；
 *  - 输出是「可读的口播稿」，用户可再手改，定位是给个 80 分的起点，不是成品。
 */

// 品类识别词表。注意：避免单字易误伤（如"包邮"命中"包"、餐桌命中"餐"），
// 尽量用双字以上商品词；具体品类优先于通用。
const CATEGORIES = [
  {
    id: "food",
    label: "美食餐饮",
    words: ["汉堡", "炸鸡", "薯条", "美食", "餐厅", "奶茶", "咖啡", "火锅", "烧烤", "蛋糕", "零食", "水果", "小吃", "饮品", "套餐", "外卖", "预制菜", "礼盒食品", "生鲜", "卤味", "月饼", "粽子"],
  },
  {
    id: "beauty",
    label: "美妆护肤",
    words: ["精华液", "精华", "面霜", "口红", "粉底", "面膜", "护肤", "香水", "眼影", "修容", "防晒", "彩妆", "化妆品"],
  },
  {
    id: "fashion",
    label: "服饰穿搭",
    words: ["连衣裙", "裙子", "裤子", "鞋子", "球鞋", "上衣", "外套", "卫衣", "T恤", "唐装", "汉服", "穿搭", "背包", "手提包", "帽子", "围巾", "西装", "羽绒服"],
  },
  {
    id: "home",
    label: "家居日用",
    words: ["餐桌", "椅子", "沙发", "收纳", "厨房", "清洁", "炒锅", "水杯", "台灯", "被子", "枕头", "床垫", "餐巾", "保温杯", "垃圾桶", "拖把"],
  },
  {
    id: "digital",
    label: "数码科技",
    words: ["手机", "耳机", "电脑", "相机", "充电", "平板", "键盘", "音箱", "手表", "支架", "显示器", "鼠标", "移动电源"],
  },
  {
    id: "baby",
    label: "母婴亲子",
    words: ["宝宝", "婴儿", "儿童", "尿不湿", "奶粉", "推车", "玩具", "童装", "辅食", "奶瓶"],
  },
  {
    id: "pet",
    label: "宠物用品",
    words: ["猫咪", "狗狗", "宠物", "猫粮", "狗粮", "猫砂", "猫抓板", "狗窝", "宠物零食"],
  },
];

/**
 * 语气库：开场 hook + 号召 cta 按语气分（文案的「味」）。
 * 品类卖点描述（pitches）另见 PITCHES，按品类分（文案的「肉」）。
 */
export const TONES = {
  warm: {
    label: "温柔安利",
    hooks: ["我偷偷跟你说哦，", "这个我真的想安利给你，", "用了挺久，忍不住想分享，"],
    ctas: [
      "链接就在左下角，喜欢的话自己看看，不合适随时退，买着也放心。",
      "有需要的点下方小黄车，慢慢挑不着急，回购的人挺多的。",
    ],
  },
  urgent: {
    label: "急切促销",
    hooks: ["别划走，这个真的要抢！", "就今天，错过真没了！", "刷到就是缘分，赶紧下手！"],
    ctas: [
      "限时活动就在左下角，手慢就没啦，刷到赶紧囤！",
      "点下方小黄车马上抢，库存不多了，再犹豫就没了！",
    ],
  },
  calm: {
    label: "冷静测评",
    hooks: ["说句实在话，", "不吹不黑，客观聊聊，", "用下来总结一下，"],
    ctas: [
      "链接放在左下角，参数和真实评价自己对比看看，理性选择。",
      "感兴趣的可以点下方链接，适合自己的才值得入手。",
    ],
  },
  funny: {
    label: "幽默风趣",
    hooks: ["家人们谁懂啊，", "本来只想买一个，结果囤了一箱，", "这玩意儿真的会上瘾，"],
    ctas: [
      "链接甩左下角了，别问我为什么买这么多，问就是太香。",
      "点下方小黄车，手别抖，冲就完事了，回头谢我。",
    ],
  },
  bestie: {
    label: "闺蜜种草",
    hooks: ["宝子们，这个我必须按头安利，", "我闺蜜用完回来骂我，说怎么不早说，", "姐妹们先别买别的，看完这个再说，"],
    ctas: [
      "链接给你们放左下角啦，姐妹们冲，冲完记得回来夸我。",
      "点下方小黄车，咱就是说，闭眼入也不踩雷的那种。",
    ],
  },
  pro: {
    label: "专业带货",
    hooks: ["重点来了，", "从专业角度给大家拆一下，", "直接说核心卖点，"],
    ctas: [
      "链接在左下角，参数、规格、售后都写清楚了，按需下单。",
      "点下方小黄车看详情页，对比完再决定，品质有保障。",
    ],
  },
};
export const TONE_IDS = Object.keys(TONES);

// 品类卖点句（文案主体，按品类分）
const PITCHES = {
  food: [
    "味道是真材实料，吃着就是过瘾，",
    "分量给得足，一口下去满足感直接拉满，",
    "用料实在不糊弄，越吃越上头，",
  ],
  beauty: [
    "上脸很服帖，肤感清透不闷，",
    "成分扎实，坚持用下来状态肉眼可见地变好，",
    "质地好用不搓泥，日常上妆前打底也稳，",
  ],
  fashion: [
    "版型很正，上身显瘦还显气质，",
    "面料有质感，不塌不皱，做工细节到位，",
    "配色高级，日常通勤和出街都能打，",
  ],
  home: [
    "用起来顺手又耐用，细节设计很贴心，",
    "性价比很高，日常用下来省时省力，",
    "材质扎实，做工在线，看着就放心，",
  ],
  digital: [
    "性能给得很足，日常使用流畅不卡，",
    "做工和手感都在线，用着很舒服，",
    "续航和体验都稳，通勤出差带着正好，",
  ],
  baby: [
    "材质安全温和，宝宝用着放心，",
    "设计贴心，日常用起来省心省力，",
    "口碑一直很好，很多妈妈都在回购，",
  ],
  pet: [
    "品质放心，毛孩子爱吃爱用，",
    "用料干净，日常喂养很省心，",
    "性价比高，囤货也不心疼，",
  ],
  general: [
    "品质在线，用下来体验很好，",
    "细节做得到位，性价比也高，",
    "口碑一直不错，回购的人很多，",
  ],
};

/** 识别品类：命中多个时，取「命中关键词最长」的品类（长词更具体、更可信） */
export function detectCategory(prompt) {
  const p = String(prompt || "");
  let best = null; // { id, len }
  for (const c of CATEGORIES) {
    for (const w of c.words) {
      if (p.includes(w) && (!best || w.length > best.len)) {
        best = { id: c.id, len: w.length };
      }
    }
  }
  return best ? best.id : "general";
}

/** 从 prompt 提取卖点：价格 / 数量 / 优惠 / 品质 */
export function extractSellingPoints(prompt) {
  const p = String(prompt || "");
  const out = { price: null, count: null, perks: [], quality: [] };

  const price = p.match(/(\d+(?:\.\d+)?)\s*(?:元|块|块钱|毛)/);
  if (price) out.price = price[0].replace(/\s+/g, "");

  const count = p.match(/(\d+)\s*(个|件|瓶|盒|包|只|条|份|杯|袋)/);
  if (count) out.count = `${count[1]}${count[2]}`;

  const perkWords = ["限时", "秒杀", "满减", "包邮", "免配送", "买一送一", "第二件半价", "活动价", "折扣", "优惠"];
  out.perks = perkWords.filter((w) => p.includes(w));

  const qualityWords = ["正宗", "地道", "精选", "进口", "纯天然", "0添加", "手工", "现做", "新鲜", "真材实料", "原装"];
  out.quality = qualityWords.filter((w) => p.includes(w));

  return out;
}

/** 从 prompt 里粗提主体（第一小句，去掉镜头/运镜等描述词） */
export function extractSubject(prompt) {
  const p = String(prompt || "").trim();
  const first = p.split(/[，,。.;；\n]/)[0] || "";
  return first
    .replace(/镜头|运镜|特写|中景|近景|大全景|俯拍|仰拍|推近|环绕|跟随|慢镜|虚化|背景|光影|氛围|画面/g, "")
    .replace(/\s+/g, "")
    .slice(0, 24);
}

/** 中文口播语速约 4.5 字/秒，按目标时长给字数上限 */
function budgetChars(durationSec) {
  const sec = Math.max(4, Math.min(30, Number(durationSec) || 10));
  return Math.round(sec * 4.5);
}

/**
 * 主入口：生成口播文案
 * @param {string} prompt 视频画面提示词
 * @param {object} opts { duration, tone: "warm"|"urgent"|"calm" }
 * @returns {{ text, category, categoryLabel, tone, toneLabel, chars, budget, sellingPoints }}
 */
export function buildVoiceover(prompt, opts = {}) {
  const duration = Number(opts.duration) || 10;
  const toneId = TONES[opts.tone] ? opts.tone : "warm";
  const tone = TONES[toneId];
  const cat = detectCategory(prompt);
  const pitches = PITCHES[cat] || PITCHES.general;
  const sp = extractSellingPoints(prompt);
  const subject = extractSubject(prompt);
  const budget = budgetChars(duration);

  // 稳定伪随机：同 prompt+时长+语气 结果一致；不同语气盐值不同 → 句式轮换更分散
  let h = 0;
  const seedStr = `${prompt}|${duration}|${toneId}`;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  const pick = (arr, salt = 0) => arr[(h + salt) % arr.length];

  const hook = pick(tone.hooks, 0);
  const pitch = pick(pitches, 7);
  const cta = pick(tone.ctas, 13);

  // 卖点句：把提取到的价格/数量/优惠/品质拼进去
  const spParts = [];
  if (sp.quality.length) spParts.push(`${sp.quality.slice(0, 2).join("、")}`);
  if (sp.count) spParts.push(`一共${sp.count}`);
  if (sp.price) spParts.push(`只要${sp.price}`);
  if (sp.perks.length) spParts.push(sp.perks.slice(0, 2).join("、"));
  const spSentence = spParts.length ? `${spParts.join("，")}，` : "";

  const subjectBit = subject ? `${subject}，` : "";

  // 拼装：按「信息价值」从高到低逐段添加，直到预算用满但整句不破
  // 顺序：hook + 主体 + 卖点（核心）→ cta（号召）→ pitch（通用补充，最可省）
  const core = `${hook}${subjectBit}${spSentence}`; // 核心信息
  const shortCta = (cta.split(/[，,。！!]/)[0] || cta) + "。"; // 超短号召（第一分句）
  const tail = [
    `${core}${cta}`, // 1) 核心 + 完整 CTA
    `${core}${shortCta}`, // 2) 核心 + 超短 CTA
    `${core}${pitch}${shortCta}`, // 3) 核心 + pitch + 超短 CTA（更长）
    `${core}`.replace(/，$/, "。"), // 4) 只有核心
  ];
  // 从"信息最完整且不超预算"的版本选；都超则选最短的核心
  let text = tail.find((t) => t.length <= budget) || tail[3];
  // 若核心都超预算，退到 hook+主体
  if (text.length > budget + 8) text = `${hook}${subjectBit}`.replace(/，$/, "。");

  return {
    text: text.trim(),
    category: cat,
    categoryLabel: (CATEGORIES.find((c) => c.id === cat) || { label: "通用" }).label,
    tone: toneId,
    toneLabel: tone.label,
    chars: text.trim().length,
    budget,
    sellingPoints: sp,
  };
}

/**
 * 三种语气各出一版：warm / urgent / calm。
 * @returns {Array<{tone,toneLabel,text,chars,...}>}
 */
export function buildAllTones(prompt, opts = {}) {
  return TONE_IDS.map((tone) => buildVoiceover(prompt, { ...opts, tone }));
}
