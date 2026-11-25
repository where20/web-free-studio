#!/bin/zsh
# 等两条 run 都出片 → 拼接 → 一次编码「去双水印 + 烧真实字幕」
# 用法：./scripts/finalize-two.sh <段1 upstreamId> <段2 upstreamId> <ass文件> [输出名]
set -u
cd /Users/xiaoan/Desktop/REA/web-free-studio || exit 1
API=http://127.0.0.1:8790
ID1=${1:?需要段1 upstreamId}
ID2=${2:?需要段2 upstreamId}
ASSF=${3:?需要 ass 字幕}
NAME=${4:-dreamina-tour-2x14-subbed.mp4}
FF=${FFMPEG_BIN:-/Users/xiaoan/.local/lib/python3.13/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1}

log() { echo "[$(date +%H:%M:%S)] $*" >&2; }
abspath() { case "$1" in /*) echo "$1";; *) echo "$PWD/$1";; esac; }

wait_one() {
  local id=$1 label=$2 st i
  for i in $(seq 1 120); do
    curl -s --noproxy '*' -X POST "$API/api/dreamina/sync" -H 'content-type: application/json' -d '{}' >/dev/null
    st=$(curl -s --noproxy '*' "$API/api/tasks?provider=dreamina&limit=40" | ID="$id" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const t=(JSON.parse(s).tasks||[]).find(x=>x.upstreamId===process.env.ID);
    console.log(t? t.status+"|"+(t.asset?.video||"") : "missing|");}catch{console.log("unknown|");}
});')
    log "$label ${st%%|*}"
    case "$st" in
      done\|*) if [ -n "${st#*|}" ]; then echo "${st#*|}"; return 0; fi ;;
      failed*|needs_input*|stale*|cancelled*|missing*) log "ABORT $label 未成功：$st"; return 1;;
    esac
    sleep 20
  done
  return 2
}

F1=$(wait_one "$ID1" "段1") || exit 3
F2=$(wait_one "$ID2" "段2") || exit 4
A1=$(abspath "$F1"); A2=$(abspath "$F2")
[ -f "$A1" ] && [ -f "$A2" ] || { log "文件缺失：$A1 / $A2"; exit 5; }

printf "file '%s'\nfile '%s'\n" "$A1" "$A2" > /tmp/concat-tour.txt
OUT="data/assets/$(date +%Y-%m-%d)/$NAME"
VF="delogo=x=526:y=1224:w=184:h=44,delogo=x=10:y=10:w=44:h=32,ass=$(abspath "$ASSF")"
log "合成中（去双水印 + 烧字幕，单次编码）"
"$FF" -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt \
  -vf "$VF" -c:v libx264 -crf 19 -preset medium -c:a aac -b:a 160k -movflags +faststart "$OUT" \
  || { log "FFMPEG_FAIL"; exit 6; }

D=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
S=$(ffprobe -v error -show_entries format=size -of default=nw=1:nk=1 "$OUT")
log "输出 ${D}s / ${S} bytes"
awk -v d="$D" 'BEGIN{exit !(d+0 < 25)}' && { log "ERROR 时长异常（<25s）"; exit 7; }
log "DONE $OUT"
echo "$OUT"
