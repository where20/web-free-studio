/**
 * 提交前预检 / 提示词优化建议（纯函数，零依赖）。
 *
 * 定位：在把 prompt 交给对应平台前，按各平台的硬规则做一次本地体检，
 * 返回 { ok, level, issues:[{level,msg}], normalized } ——
 *   error  = 平台大概率会拒/白扣额度，建议改；
 *   warn   = 可能被静默降级或体验不佳，提示但不阻断；
 *   info   = 自动处理了的说明（如 Veda 自动补三段式）。
 * 不修改用户原文（normalized 只是「服务端实际会怎么发」的预览）。
 */

const CHINESE_RE = /[\u4e00-\u9fa5]/;

/** 统计中文字数（口播字数预算用） */
function cnLen(s) {
  return (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;
}

/** 提取 prompt 里显式写的画幅/时长（各平台正文里禁写这些） */
function detectInlineSpecs(prompt) {
  const p = String(prompt);
  const ratio = /\b(16:9|9:16|4:3|3:4|1:1|21:9)\b/.test(p);
  const dur = /\b\d{1,2}\s*秒(s|钟)?\b/.test(p) || /时长\s*\d/.test(p);
  const res = /\b(720p|768p|1080p|2k|4k)\b/i.test(p);
  return { ratio, dur, res };
}

/**
 * 预检主入口
 * @param {string} provider paba | veda | siftq | dreamina
 * @param {object} input { prompt, duration, mode, hasImage, hasFirstFrame, hasRef }
 * @returns {{ ok, level, issues, normalized, chars }}
 */
export function precheckPrompt(provider, input = {}) {
  const prompt = String(input.prompt || "").trim();
  const issues = [];
  const add = (level, msg) => issues.push({ level, msg });
  let normalized = prompt;

  if (!prompt) {
    add("error", "提示词为空，先写画面描述");
    return { ok: false, level: "error", issues, normalized, chars: 0 };
  }

  const specs = detectInlineSpecs(prompt);
  const cn = cnLen(prompt);

  if (provider === "paba") {
    if (input.mode === "first" && !input.hasFirstFrame) add("error", "图生视频模式需要上传首帧图");
    if (input.mode === "frames" && (!input.hasFirstFrame || !input.hasImage)) add("error", "首尾帧模式需要首帧+尾帧两张图");
    if (input.mode === "reference" && !input.hasRef) add("error", "全能参考模式至少要接一个参考素材");
    if (prompt.length > 2000) add("warn", "提示词较长，Paba 免费档可能理解跑偏，建议精简到 500 字内聚焦单一画面");
  } else if (provider === "veda") {
    // Veda 强制三段式，服务端会自动补；但长度校验打在用户原文上
    if (cn < 32) add("error", `Veda 要求画面描述≥32 字（当前 ${cn} 字），太短会被上游拒（不扣额度）`);
    if (!/integrated_multimodal_description/.test(prompt)) {
      add("info", "Veda 会自动补成三段式（画面/环境声/配乐），无需手写");
    }
    if (specs.ratio) add("warn", "Veda 正文里写了画幅，上游可能报错，画幅请用上方下拉选，正文去掉 16:9 等字样");
  } else if (provider === "siftq") {
    if (CHINESE_RE.test(prompt)) add("error", "SiftQ 只认英文 prompt，请把动作描述改成英文");
    if (!input.hasImage) add("error", "SiftQ 是图生视频，必须先在下方「首帧」上传输入图");
    if (specs.ratio || specs.dur || specs.res) add("warn", "SiftQ 正文禁写画幅/时长/分辨率（固定 9:16，时长用下拉），请去掉这些字样");
  } else if (provider === "dreamina") {
    if (prompt.length > 3000) add("error", `即梦提示词上限 3000 字（当前 ${prompt.length} 字）`);
    if (specs.ratio || specs.res) {
      add("info", "即梦会自动在开头加「使用seedance2.5,生成N秒…」，规格以表单下拉为准，正文里的画幅/清晰度可留可去");
    }
    if (input.duration && cn > Number(input.duration) * 4.5 + 40) {
      add("warn", `文案约 ${cn} 字，按 ${input.duration}s 口播（~4.5 字/秒）偏长，可能说不完或语速过快`);
    }
    // 预览即梦最终会发出去的 prompt（加规格前缀）
    normalized = `使用seedance2.5,生成${input.duration || 10}秒视频，16:9，720P。${prompt}`;
  }

  const hasError = issues.some((i) => i.level === "error");
  const hasWarn = issues.some((i) => i.level === "warn");
  const level = hasError ? "error" : hasWarn ? "warn" : "ok";
  return { ok: !hasError, level, issues, normalized, chars: prompt.length, cnChars: cn };
}
