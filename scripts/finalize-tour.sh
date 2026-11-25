#!/bin/zsh
# 最终合成：等段2 出片 → 拼接 → 一次编码同时「去双水印 + 烧真实字幕」
# 用法：./scripts/finalize-tour.sh <段1文件> <段2 upstreamId> <ass文件> [输出名]
set -u
cd /Users/xiaoan/Desktop/REA/web-free-studio || exit 1
API=http://127.0.0.1:8790
F1=${1:?需要段1本地文件}
ID2=${2:?需要段2 upstreamId}
ASSF=${3:?需要 ass 字幕文件}
NAME=${4:-dreamina-tour-2x14-subbed.mp4}
FF=${FFMPEG_BIN:-/Users/xiaoan/.local/lib/python3.13/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1}

log() { echo "[$(date +%H:%M:%S)] $*" >&2; }
abspath() { case "$1" in /*) echo "$1";; *) echo "$PWD/$1";; esac; }

for i in $(seq 1 120); do
  curl -s --noproxy '*' -X POST "$API/api/dreamina/sync" -H 'content-type: application/json' -d '{}' >/dev/null
  ST=$(curl -s --noproxy '*' "$API/api/tasks?provider=dreamina&limit=40" | ID="$ID2" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const t=(JSON.parse(s).tasks||[]).find(x=>x.upstreamId===process.env.ID);
    console.log(t? t.status+"|"+(t.asset?.video||"") : "missing|");}catch{console.log("unknown|");}
});')
  log "段2 ${ST%%|*}"
  case "$ST" in
    done\|*) F2=${ST#*|}; [ -n "$F2" ] && break;;
    failed*|needs_input*|stale*|cancelled*|missing*) log "ABORT 段2 未成功：$ST"; exit 3;;
  esac
  sleep 20
done

A1=$(abspath "$F1"); A2=$(abspath "$F2")
[ -f "$A1" ] || { log "段1 不存在：$A1"; exit 4; }
[ -f "$A2" ] || { log "段2 不存在：$A2"; exit 4; }

printf "file '%s'\nfile '%s'\n" "$A1" "$A2" > /tmp/concat-tour.txt
OUT="data/assets/$(date +%Y-%m-%d)/$NAME"

# 一次编码：delogo 去右下 DreaminaAI + 左上 AI 标 → 再烧 ASS（避免两轮压缩）
VF="delogo=x=526:y=1224:w=184:h=44,delogo=x=10:y=10:w=44:h=32,ass=$(abspath "$ASSF")"
log "合成中（去水印 + 烧字幕，单次编码）"
"$FF" -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt \
  -vf "$VF" -c:v libx264 -crf 19 -preset medium -c:a aac -b:a 160k -movflags +faststart "$OUT" \
  || { log "FFMPEG_FAIL"; exit 5; }

D=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
S=$(ffprobe -v error -show_entries format=size -of default=nw=1:nk=1 "$OUT")
log "输出 ${D}s / ${S} bytes"
awk -v d="$D" 'BEGIN{exit !(d+0 < 25)}' && { log "ERROR 时长异常（<25s），拼接失败"; exit 7; }
log "DONE $OUT"
echo "$OUT"
