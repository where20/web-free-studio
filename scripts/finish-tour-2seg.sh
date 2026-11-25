#!/bin/zsh
# 接续：段1 已在跑（b8183893）→ 等它出片 → 提交段2 → 等出片 → 拼接
# 用法：./scripts/finish-tour-2seg.sh <段1 upstreamId>
set -u
cd /Users/xiaoan/Desktop/REA/web-free-studio || exit 1
API=http://127.0.0.1:8790
PROMPT_FILE=data/tmp-tour-2seg.json
SEG1_ID=${1:?需要段1 的 upstreamId}

log() { echo "[$(date +%H:%M:%S)] $*" >&2; }
post_json() { curl -s --noproxy '*' -X POST "$API$1" -H 'content-type: application/json' -d "$2"; }

task_of() {
  curl -s --noproxy '*' "$API/api/tasks?provider=dreamina&limit=40" | ID="$1" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const t=(JSON.parse(s).tasks||[]).find(x=>x.upstreamId===process.env.ID);
    console.log(t? t.status+"|"+(t.asset?.video||"") : "missing|");}catch{console.log("unknown|");}
});'
}

wait_done() {
  local id=$1 label=$2 st i
  for i in $(seq 1 120); do
    post_json /api/dreamina/sync '{}' >/dev/null
    st=$(task_of "$id")
    log "$label ${st%%|*}"
    case "$st" in
      done\|*) echo "$st"; return 0;;
      failed*|needs_input*|stale*|cancelled*|missing*) echo "$st"; return 1;;
    esac
    sleep 20
  done
  echo "timeout|"; return 2
}

submit_seg2() {
  local body out
  body=$(SEG=seg2 node -e 'const p=require("./'"$PROMPT_FILE"'")[process.env.SEG];console.log(JSON.stringify({accountId:"dm-main",prompt:p,duration:14,aspect:"9:16",resolution:"720P"}));')
  for try in 1 2 3; do
    out=$(post_json /api/dreamina/generate "$body")
    local id; id=$(OUT="$out" node -e 'try{const j=JSON.parse(process.env.OUT||"");process.stdout.write(j.upstreamId||"FAIL:"+(j.error||"unknown"))}catch{process.stdout.write("FAIL:bad-json")}')
    case "$id" in
      ????????-????-????-????-????????????) log "段2 已提交 $id"; echo "$id"; return 0;;
      *) log "段2 提交失败（$try/3）：${id#FAIL:}"; sleep 150;;
    esac
  done
  return 1
}

R1=$(wait_done "$SEG1_ID" "段1") || { log "ABORT 段1 未成功：$R1"; exit 3; }
F1=${R1#*|}; log "段1 出片 $F1"

sleep 20
ID2=$(submit_seg2) || { log "ABORT 段2 提交失败"; exit 4; }
R2=$(wait_done "$ID2" "段2") || { log "ABORT 段2 未成功：$R2"; exit 5; }
F2=${R2#*|}; log "段2 出片 $F2"

OUT="data/assets/$(date +%Y-%m-%d)/dreamina-tour-2x14-joined.mp4"
printf "file '%s'\nfile '%s'\n" "$PWD/$F1" "$PWD/$F2" > /tmp/concat-tour.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt -c copy -movflags +faststart "$OUT" \
  && log "JOINED $OUT" || { log "FFMPEG_FAIL"; exit 6; }
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT" >&2
echo "$OUT"
