#!/usr/bin/env python3
"""按静音点把音频切成语音片段，输出每段的时间范围与切片文件，供逐段转写对齐。"""
import json
import re
import subprocess
import sys

FF = "/Users/xiaoan/.local/lib/python3.13/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1"


def detect_silences(src, noise="-32dB", dur="0.18"):
    p = subprocess.run(
        [FF, "-i", src, "-af", f"silencedetect=noise={noise}:d={dur}", "-f", "null", "/dev/null"],
        capture_output=True, text=True,
    )
    out = []
    starts = {}
    for line in p.stderr.splitlines():
        m = re.search(r"silence_start: ([\d.]+)", line)
        if m:
            starts["s"] = float(m.group(1))
            continue
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and "s" in starts:
            out.append((starts.pop("s"), float(m.group(1))))
    return out


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    min_speech = float(sys.argv[3]) if len(sys.argv) > 3 else 0.25
    sil = detect_silences(src)
    dur = float(subprocess.run(
        [FF, "-i", src, "-f", "null", "-"], capture_output=True, text=True
    ).stderr.split("Duration: ")[1].split(",")[0].split(":")[-1].strip()) if False else None
    # 用 ffprobe 取时长
    d = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src],
        capture_output=True, text=True).stdout.strip()
    total = float(d)

    # 语音段 = 静音段的补集
    segs = []
    cur = 0.0
    for s, e in sil:
        if s - cur > min_speech:
            segs.append((cur, s))
        cur = max(cur, e)
    if total - cur > min_speech:
        segs.append((cur, total))

    import os
    os.makedirs(outdir, exist_ok=True)
    meta = []
    for i, (a, b) in enumerate(segs):
        f = f"{outdir}/seg{i:02d}_{a:.2f}-{b:.2f}.wav"
        subprocess.run([FF, "-v", "error", "-ss", str(a), "-to", str(b), "-i", src,
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", f], check=True)
        meta.append({"idx": i, "start": round(a, 3), "end": round(b, 3),
                     "dur": round(b - a, 3), "file": f})
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
