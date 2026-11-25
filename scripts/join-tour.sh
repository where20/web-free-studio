#!/bin/zsh
# 只做最后一环：等段2 出片 → 与段1 无损拼接 → 校验
# 用法：./scripts/join-tour.sh <段1文件> <段2 upstreamId>
set -u
cd /Users/xiaoan/Desktop/REA/web-free-studio || exit 1
API=http://127.0.0.1:8790
F1=${1:?需要段1本地文件路径}
ID2=${2:?需要段2 upstreamId}

log() { echo "[$(date +%H:%M:%S)] $*" >&2; }

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

[ -f "$F1" ] || { log "段1 文件不存在：$F1"; exit 4; }
[ -f "${F2:-}" ] || { log "段2 文件不存在：${F2:-}"; exit 4; }

# 两段必须同编码/同分辨率才能 -c copy，否则重编码
P1=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -of csv=p=0 "$F1")
P2=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -of csv=p=0 "$F2")
log "段1 $P1"
log "段2 $P2"

OUT="data/assets/$(date +%Y-%m-%d)/dreamina-tour-2x14-joined.mp4"
abspath() { case "$1" in /*) echo "$1";; *) echo "$PWD/$1";; esac; }
A1=$(abspath "$F1"); A2=$(abspath "$F2")
printf "file '%s'\nfile '%s'\n" "$A1" "$A2" > /tmp/concat-tour.txt
if [ "$P1" = "$P2" ]; then
  ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt -c copy -movflags +faststart "$OUT" \
    || { log "concat copy 失败，转重编码"; ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 160k -movflags +faststart "$OUT" || exit 5; }
else
  log "两段参数不一致 → 统一重编码拼接"
  ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 160k -movflags +faststart "$OUT" || exit 5
fi

D=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
S=$(ffprobe -v error -show_entries format=size -of default=nw=1:nk=1 "$OUT")
log "输出时长 ${D}s / ${S} bytes"
# 两段各约 14s，总时长不足 25s 说明只拼进了一段
awk -v d="$D" 'BEGIN{exit !(d+0 < 25)}' && { log "ERROR 时长异常（<25s），拼接没成功"; exit 7; }
log "JOINED $OUT"
echo "$OUT"
