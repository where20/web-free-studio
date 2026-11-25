#!/usr/bin/env node
/**
 * 去除 PabaTV 右下角平台水印（ffmpeg delogo 封装）。
 *
 * 原理：PabaTV 免费档水印是固定在右下角的静态标识，用 delogo 邻域插值覆盖即可。
 * 该区域通常是云雾/剪影等简单纹理，补后肉眼不可辨。仅用于自己账号生成的内容。
 *
 * 用法：
 *   node scripts/clean-watermark.mjs VIDEO [VIDEO...] [options]
 *
 * 选项：
 *   --preset paba-tv     预设水印框（默认；1344×768 右下角）
 *   --box x,y,w,h        自定义水印框（覆盖 preset）
 *   --crf N              输出画质，默认 18（越小越好）
 *   --suffix STR         输出后缀，默认 -clean
 *   --ffmpeg PATH        指定 ffmpeg 路径（默认自动探测 PATH + homebrew + imageio）
 *   --dry-run            只打印命令不执行
 *   --force              允许覆盖已存在的输出文件
 *
 * 示例：
 *   node scripts/clean-watermark.mjs a.mp4 b.mp4
 *   node scripts/clean-watermark.mjs a.mp4 --preset paba-tv --dry-run
 *   node scripts/clean-watermark.mjs a.mp4 --box 1148,704,176,40
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 预设：基准分辨率 + 水印框（x,y,w,h）。换算时按输入宽高等比缩放。
const PRESETS = {
  "paba-tv": { baseW: 1344, baseH: 768, box: [1148, 704, 176, 40] },
  // 即梦 Dreamina：右下角 "✦ DreaminaAI"（1280×720 实测白字边界 x938-1251 / y640-691，含图标+边距）
  "dreamina": { baseW: 1280, baseH: 720, box: [928, 632, 336, 72] },
};

function parseArgs(argv) {
  const opt = {
    preset: "paba-tv", box: null, crf: 18, suffix: "-clean",
    ffmpeg: null, dryRun: false, force: false, files: [],
  };
  const need = new Set(["--preset", "--box", "--crf", "--suffix", "--ffmpeg"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (need.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少参数`);
      if (a === "--preset") opt.preset = v;
      else if (a === "--box") opt.box = v.split(",").map(Number);
      else if (a === "--crf") opt.crf = Number(v);
      else if (a === "--suffix") opt.suffix = v;
      else if (a === "--ffmpeg") opt.ffmpeg = v;
    } else if (a === "--dry-run") opt.dryRun = true;
    else if (a === "--force") opt.force = true;
    else if (a.startsWith("-")) throw new Error(`未知选项：${a}`);
    else opt.files.push(a);
  }
  if (!opt.files.length) throw new Error("至少要给一个视频文件");
  return opt;
}

function findFfmpeg(explicit) {
  if (explicit) return explicit;
  const candidates = [
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    path.join(process.env.HOME || "", ".local/bin/ffmpeg"),
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (r.status === 0) return c;
  }
  return null;
}

/** 读视频宽高。失败返回 null（此时按预设原样处理）。 */
function probeSize(ffmpeg, file) {
  const ffprobe = ffmpeg.replace(/ffmpeg$/, "ffprobe");
  const r = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return null;
  const m = String(r.stdout || "").trim().match(/^(\d+),(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : null;
}

function resolveBox(opt, size) {
  let box = opt.box;
  const preset = PRESETS[opt.preset];
  if (!box) {
    if (!preset) throw new Error(`未知 preset：${opt.preset}`);
    box = preset.box.slice();
    // 输入分辨率与预设基准不同时，等比换算水印框
    if (size && (size.w !== preset.baseW || size.h !== preset.baseH)) {
      const sx = size.w / preset.baseW, sy = size.h / preset.baseH;
      box = [Math.round(box[0] * sx), Math.round(box[1] * sy),
             Math.round(box[2] * sx), Math.round(box[3] * sy)];
      console.log(`  ℹ 分辨率 ${size.w}×${size.h}，水印框换算为 ${box.join(",")}`);
    }
  }
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`水印框格式不对：${box.join(",")}（应为 x,y,w,h 四个非负数）`);
  }
  // delogo 要求偶数边界+留边，向下取偶
  const [x, y, w, h] = box.map((n) => Math.max(0, Math.floor(n / 2) * 2));
  return { x, y, w, h };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const ffmpeg = findFfmpeg(opt.ffmpeg);
  if (!ffmpeg) throw new Error("找不到 ffmpeg，用 --ffmpeg 指定路径");

  let ok = 0, skip = 0, fail = 0;
  for (const file of opt.files) {
    if (!fs.existsSync(file)) {
      console.error(`✗ 文件不存在：${file}`); fail++; continue;
    }
    const size = probeSize(ffmpeg, file);
    const { x, y, w, h } = resolveBox(opt, size);
    const ext = path.extname(file);
    const out = path.join(path.dirname(file),
      path.basename(file, ext) + opt.suffix + (ext || ".mp4"));
    if (fs.existsSync(out) && !opt.force && !opt.dryRun) {
      console.log(`⏭ 跳过（输出已存在，加 --force 覆盖）：${out}`); skip++; continue;
    }
    const args = ["-y", "-v", "error", "-i", file,
      "-vf", `delogo=x=${x}:y=${y}:w=${w}:h=${h}`,
      "-c:v", "libx264", "-crf", String(opt.crf), "-preset", "medium",
      "-c:a", "copy", "-movflags", "+faststart", out];
    if (opt.dryRun) {
      console.log(`[dry-run] ${ffmpeg} ${args.join(" ")}`); ok++; continue;
    }
    console.log(`→ ${file}  →  ${out}  (delogo ${x},${y},${w},${h})`);
    const r = spawnSync(ffmpeg, args, { stdio: "inherit" });
    if (r.status === 0) { console.log(`✓ ${out}`); ok++; }
    else { console.error(`✗ 失败：${file}`); fail++; }
  }
  console.log(`\n完成：成功 ${ok}，跳过 ${skip}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

try { main(); } catch (e) { console.error(`错误：${e.message}`); process.exitCode = 1; }
