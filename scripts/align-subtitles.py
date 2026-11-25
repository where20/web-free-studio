#!/usr/bin/env python3
"""
用 faster-whisper 拿到字级时间戳，把台词精确对齐到 ASS 字幕。

输入：音频/视频路径 + 台词原文（分句用 | 分隔，或按标点自动分句）
输出：ASS 字幕文件（每句的 start/end 来自 ASR 词级时间戳，句内按字数比例分配）

用法：
  python3 scripts/align-subtitles.py <media> "<台词，用 | 分句>" <out.ass> [--max-chars 12]
"""
import argparse
import re
import sys

from faster_whisper import WhisperModel


def load_model():
    # base 模型在中文上够用且快；large-v3 更准但首次下载大
    for name, size, compute in (("small", "small", "int8"), ("base", "base", "int8")):
        try:
            return WhisperModel(name, device="cpu", compute_type=compute)
        except Exception:
            continue
    raise SystemExit("无法加载 whisper 模型")


def transcribe(model, media):
    segments, info = model.transcribe(
        media,
        language="zh",
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=200),
        beam_size=5,
    )
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append((w.start, w.end, w.word))
    return words, info


def normalize(text):
    return re.sub(r"[\s，。！？、,.!?;；：:「」『』\"'()（）\[\]【】…—-]", "", text)


def split_sentences(script):
    """台词按 | 或标点切句"""
    if "|" in script:
        parts = [p.strip() for p in script.split("|") if p.strip()]
    else:
        parts = [p for p in re.split(r"[。！？!?，,；;]+", script) if p.strip()]
    return parts


def assign(words, sentences):
    """把词级时间戳按顺序贪心分配给每个句子"""
    wnorm = [normalize(w[2]) for w in words]
    # 展开成字符级时间戳：每个词按字数均分其时长
    char_spans = []
    for (s, e, t), tn in zip(words, wnorm):
        if not tn or e is None or s is None:
            continue
        n = len(tn)
        step = (e - s) / n
        for i, ch in enumerate(tn):
            char_spans.append((s + i * step, s + (i + 1) * step, ch))

    joined = "".join(c[2] for c in char_spans)
    cursor = 0
    out = []
    for sent in sentences:
        sn = normalize(sent)
        if not sn:
            continue
        # 在 joined 里从 cursor 起找
        pos = joined.find(sn, cursor)
        if pos < 0:
            # 退而求其次：逐字滑窗匹配（容忍 ASR 误差）
            pos = -1
            for i in range(cursor, len(joined) - len(sn) + 1):
                if joined[i : i + len(sn)] == sn:
                    pos = i
                    break
        if pos < 0:
            # 找不到：按字符数比例估计
            out.append((sent, None, None))
            cursor = min(len(joined), cursor + len(sn))
            continue
        end = pos + len(sn)
        st = char_spans[pos][0]
        en = char_spans[end - 1][1]
        out.append((sent, st, en))
        cursor = end
    return out


def wrap(text, max_chars):
    """按字数折行，尽量在标点处断"""
    if len(text) <= max_chars:
        return text
    lines, cur = [], ""
    for ch in text:
        cur += ch
        if len(cur) >= max_chars and ch in "，、；:：,;":
            lines.append(cur)
            cur = ""
    if cur:
        if lines and len(cur) <= max_chars // 2 + 2 and lines[-1].endswith("，"):
            lines[-1] = lines[-1].rstrip("，") + chr(92) + "N" + cur
        else:
            lines.append(cur)
    return chr(92) + "N".join(lines)


def ass_time(t):
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("script", help="台词原文，用 | 分句")
    ap.add_argument("out")
    ap.add_argument("--max-chars", type=int, default=13)
    ap.add_argument("--play-w", type=int, default=720)
    ap.add_argument("--play-h", type=int, default=1280)
    ap.add_argument("--fontsize", type=int, default=34)
    ap.add_argument("--margin-v", type=int, default=104)
    ap.add_argument("--tail", type=float, default=0.45, help="每句字幕延长秒数")
    ap.add_argument("--lead", type=float, default=0.08)
    args = ap.parse_args()

    sentences = split_sentences(args.script)
    model = load_model()
    words, info = transcribe(model, args.media)
    if not words:
        raise SystemExit("ASR 没识别到语音")
    print(f"[ASR] {len(words)} 词 / {info.duration:.2f}s", file=sys.stderr)

    aligned = assign(words, sentences)
    # 未匹配上的句子按前后句比例插值
    total_chars = sum(len(normalize(s)) for s in sentences)
    filled = sum(len(normalize(s)) for s, a, b in aligned if a is not None)
    missing = total_chars - filled
    total_dur = words[-1][1] - words[0][0]
    cursor_end = None
    for i, (sent, a, b) in enumerate(aligned):
        if a is None:
            frac = len(normalize(sent)) / max(1, total_chars)
            dur = total_dur * frac
            if cursor_end is None:
                cursor_end = words[0][0]
            a = cursor_end
            b = a + dur
            cursor_end = b
        cursor_end = b

    lines = []
    prev_end = 0.0
    for sent, a, b in aligned:
        st = max(0.0, a - args.lead)
        en = b + args.tail
        if st < prev_end:
            st = prev_end + 0.02
        if en <= st:
            en = st + 0.6
        lines.append((st, en, wrap(sent, args.max_chars)))
        prev_end = en

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(
            "[Script Info]\nScriptType: v4.00+\n"
            f"PlayResX: {args.play_w}\nPlayResY: {args.play_h}\n"
            "WrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n"
        )
        f.write(
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Main,Heiti SC,{args.fontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0.6,0,1,2.2,0,2,48,48,{args.margin_v},1\n\n"
        )
        f.write("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
        for st, en, txt in lines:
            f.write(f"Dialogue: 0,{ass_time(st)},{ass_time(en)},Main,,0,0,0,,{txt}\n")
    print(f"[OK] {args.out}  {len(lines)} 句", file=sys.stderr)
    for st, en, txt in lines:
        print(f"  {st:6.2f} - {en:6.2f}  {txt}", file=sys.stderr)


if __name__ == "__main__":
    main()
