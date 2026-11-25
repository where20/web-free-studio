#!/bin/zsh
# 抽首帧/尾帧：分段生成时做「接力参考」用
#   - Paba 的 mode=first / frames 可直接把上一段尾帧当下一段首帧（真正锁画面）
#   - 即梦 agent 通道暂不支持图片输入，尾帧只能当人工参考或给 Paba 用
# 用法：./scripts/grab-frames.sh <video> [输出目录]
set -eu
V=${1:?需要视频文件}
OUTDIR=${2:-$(dirname "$V")}
FF=${FFMPEG_BIN:-/Users/xiaoan/.local/lib/python3.13/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1}
[ -f "$V" ] || { echo "文件不存在：$V" >&2; exit 1; }
mkdir -p "$OUTDIR"
BASE=$(basename "$V" .mp4)
"$FF" -y -loglevel error -i "$V" -frames:v 1 -q:v 2 "$OUTDIR/$BASE-first.jpg"
"$FF" -y -loglevel error -sseof -0.2 -i "$V" -frames:v 1 -q:v 2 "$OUTDIR/$BASE-tail.jpg"
echo "$OUTDIR/$BASE-first.jpg"
echo "$OUTDIR/$BASE-tail.jpg"
