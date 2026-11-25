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

// 品类句式库（hook 开场 / pitch 卖点 / cta 号召）
const PHRASES = {
  food: {
    hooks: ["我偷偷跟你说哦，", "真的别踩坑了，", "这个我必须安利一下，"],
    pitches: [
      "味道是真材实料，吃着就是过瘾，",
      "分量给得足，一口下去满足感直接拉满，",
      "用料实在不糊弄，越吃越上头，",
    ],
    cta: ["链接就在左下角，刷到赶紧囤，不吃随时退，过期还能自动退。", "点下方小黄车带走，趁活动赶紧冲，手慢就没啦。"],
  },
  beauty: {
    hooks: ["姐妹们听我一句劝，", "用了这么多我真的想推这个，", "这个真的值得反复回购，"],
    pitches: [
      "上脸很服帖，肤感清透不闷，",
      "成分扎实，坚持用下来状态肉眼可见地变好，",
      "质地好用不搓泥，日常上妆前打底也稳，",
    ],
    cta: ["链接在左下角，想要同款的自己拍，用完回来谢我。", "点下方小黄车下单，今天还有活动价，别错过。"],
  },
  fashion: {
    hooks: ["这身真的绝了，", "姐妹们这套我太喜欢了，", "谁穿谁好看的那种，"],
    pitches: [
      "版型很正，上身显瘦还显气质，",
      "面料有质感，不塌不皱，做工细节到位，",
      "配色高级，日常通勤和出街都能打，",
    ],
    cta: ["同款链接放左下角了，尺码齐全，喜欢的冲。", "点下方小黄车看详情，趁有活动价赶紧入。"],
  },
  home: {
    hooks: ["家里有这个真的省心，", "这个好物我用了很久才敢推，", "生活品质直接提升一档，"],
    pitches: [
      "用起来顺手又耐用，细节设计很贴心，",
      "性价比很高，日常用下来省时省力，",
      "材质扎实，做工在线，看着就放心，",
    ],
    cta: ["链接就在左下角，需要的话自己拍，早买早享受。", "点下方小黄车带走，家里缺这个的赶紧补上。"],
  },
  digital: {
    hooks: ["这个真的有点东西，", "用过就知道值不值，", "参数党看过来，"],
    pitches: [
      "性能给得很足，日常使用流畅不卡，",
      "做工和手感都在线，用着很舒服，",
      "续航和体验都稳，通勤出差带着正好，",
    ],
    cta: ["链接在小黄车，想换设备的可以重点看看。", "点下方链接看详细参数，活动价很香，别犹豫。"],
  },
  baby: {
    hooks: ["当妈的都知道这个有多重要，", "给宝宝用的东西不能将就，", "这个真的让带娃轻松不少，"],
    pitches: [
      "材质安全温和，宝宝用着放心，",
      "设计贴心，日常用起来省心省力，",
      "口碑一直很好，很多妈妈都在回购，",
    ],
    cta: ["链接放左下角了，有需要的宝妈直接拍。", "点下方小黄车，趁活动囤一点，用得上。"],
  },
  pet: {
    hooks: ["养猫养狗的都懂，", "主子用过就回不去了，", "这个真的要给毛孩子安排上，"],
    pitches: [
      "品质放心，毛孩子爱吃爱用，",
      "用料干净，日常喂养很省心，",
      "性价比高，囤货也不心疼，",
    ],
    cta: ["链接在左下角，铲屎官们赶紧给主子囤起来。", "点下方小黄车带走，趁活动多备几份。"],
  },
  general: {
    hooks: ["这个真的值得说一下，", "我不允许你还不知道，", "真心推荐给你，"],
    pitches: [
      "品质在线，用下来体验很好，",
      "细节做得到位，性价比也高，",
      "口碑一直不错，回购的人很多，",
    ],
    cta: ["链接就在左下角，感兴趣的自己看看。", "点下方小黄车了解详情，趁活动入手更划算。"],
  },
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
 * @param {object} opts { duration, tone: "warm"|"urgent"|"calm", seed }
 * @returns {{ text, category, categoryLabel, chars, sellingPoints }}
 */
export function buildVoiceover(prompt, opts = {}) {
  const duration = Number(opts.duration) || 10;
  const cat = detectCategory(prompt);
  const lib = PHRASES[cat] || PHRASES.general;
  const sp = extractSellingPoints(prompt);
  const subject = extractSubject(prompt);
  const budget = budgetChars(duration);

  // 稳定的伪随机：同 prompt+时长 结果一致（避免每次点都变）
  let h = 0;
  const seedStr = `${prompt}|${duration}`;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  const pick = (arr, salt = 0) => arr[(h + salt) % arr.length];

  const hook = pick(lib.hooks, 0);
  const pitch = pick(lib.pitches, 7);
  const cta = pick(lib.cta, 13);

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
    chars: text.trim().length,
    budget,
    sellingPoints: sp,
  };
}
