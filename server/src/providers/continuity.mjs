/**
 * 分段生成的「连续性锚点」（纯函数，零依赖）。
 *
 * 问题：即梦 agent 的每次 run 是独立的，没有跨 run 的视觉记忆。
 * 实测证据：段2 写「同一张快餐店餐桌」时 agent 会反问
 * 「上一条视频的生成结果未确认，暂时无法以它作为连续画面的参考」。
 *
 * 所以跨段保持一致只能靠「文字锚点」：把人物/场景/影像特征写成固定文本块，
 * 逐段原样复制。描述越具体、越逐字相同，AI 出来的角色越接近。
 *
 * 图片/视频参考（尾帧接力）需要上游支持图片输入，agent 通道暂未接
 * （submit_run 的 message.content 里目前只有 text）。
 */

/** 人物外观线索（用于从首段提示词里抽锚点） */
const LOOK_RE = /((?:年轻|中年|二十|三十)[男女]?[性孩]?|女孩|女生|男孩|男生|女主|男主|博主|老板娘|店员)/;
const HAIR_RE = /([^，。；]{0,8}(?:发型|长发|短发|马尾|齐肩|卷发|直发|刘海)[^，。；]{0,10})/;
const WEAR_RE = /([^，。；]{0,6}(?:穿着|身穿|穿|身着)[^，。；]{0,20})/;
const MAKEUP_RE = /([^，。；]{0,6}(?:妆容|口红|唇|腮红|眼妆)[^，。；]{0,10})/;
const SCENE_RE = /([^，。；]{0,10}(?:店内|店|餐桌|厨房|街道|客厅|卧室|户外|办公室|柜台)[^，。；]{0,12})/;
const LIGHT_RE = /([^，。；]{0,8}(?:光|灯|暖调|冷调|逆光|顺光|自然光)[^，。；]{0,10})/;
const SHOT_RE = /([^，。；]{0,8}(?:镜头|机位|景深|特写|中景|全景|近景|推近|横移)[^，。；]{0,12})/;

function pick(re, s, max = 2) {
  const out = [];
  const g = new RegExp(re.source, "g");
  let m;
  while ((m = g.exec(s)) && out.length < max) {
    const v = (m[1] || "").trim().replace(/^[，。、；\s]+/, "");
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 从首段提示词里抽连续性锚点。
 * @returns {{subject:string[], scene:string[], look:string[], shot:string[], card:string}}
 */
export function extractAnchors(prompt) {
  const p = String(prompt || "");
  const subject = LOOK_RE.test(p) ? [p.match(LOOK_RE)[1]] : [];
  const look = [...pick(HAIR_RE, p), ...pick(WEAR_RE, p), ...pick(MAKEUP_RE, p)];
  const scene = pick(SCENE_RE, p, 2);
  // 景别/机位锚点里若混进人物描述（如「一位年轻女性面对镜头」）就剔掉，只留运镜与光线
  const shot = [
    ...pick(SHOT_RE, p, 3).filter((v) => !/[女男她他]|人物|人物出镜/.test(v)),
    ...pick(LIGHT_RE, p, 1),
  ];

  const lines = [];
  if (subject.length || look.length) {
    lines.push(`【人物锚点】${[...subject, ...look].join("，")}；发型、服装、妆容全程不变，不换人。`);
  }
  if (scene.length) lines.push(`【场景锚点】${scene.join("，")}；环境布局与桌面摆放保持与前一段一致。`);
  if (shot.length) lines.push(`【影像锚点】${shot.join("，")}；色调与机位高度与前一段统一。`);

  return { subject, scene, look, shot, card: lines.join("\n") };
}

/**
 * 把锚点卡注入提示词。已在文字里出现过的锚点不重复注入。
 * @param {string} prompt
 * @param {string|object} card extractAnchors 的返回值或字符串
 */
export function applyAnchors(prompt, card) {
  const text = String(prompt || "").trim();
  const block = typeof card === "string" ? card.trim() : String(card?.card || "").trim();
  if (!text) return text;
  if (!block) return text;
  // 已经有锚点卡就不再叠加（避免二次调用时越拼越长）
  if (text.includes("【人物锚点】")) return text;
  return `${block}\n${text}`;
}

/**
 * 把一段长脚本按「镜头数」拆成多段，每段自动带上同一张锚点卡。
 * 分段原则：每段 ≤ maxSec，按句号/换行切，不把一句话劈开。
 */
export function splitScript(script, { segments = 2, maxSec = 15, charsPerSec = 4.5 } = {}) {
  const text = String(script || "").trim();
  if (!text) return [];
  const sentences = text.split(/(?<=[。！？!?；;]|\n)/).map((s) => s.trim()).filter(Boolean);
  const budget = Math.floor(maxSec * charsPerSec); // 每段可容纳的中文字数
  const groups = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > budget * segments / segments && groups.length < segments - 1 && cur.length + s.length > budget) {
      groups.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) groups.push(cur);
  // 段数不足就按目标补齐说明；超出就合并尾部（避免碎成很多小节）
  while (groups.length > segments) {
    const last = groups.pop();
    groups[groups.length - 1] += last;
  }
  return groups.map((g, i) => ({
    index: i + 1,
    text: g,
    estSec: Math.min(maxSec, Math.max(3, Math.ceil((g.match(/[\u4e00-\u9fa5]/g) || []).length / charsPerSec))),
  }));
}
