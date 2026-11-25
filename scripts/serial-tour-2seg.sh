#!/bin/zsh
# 串行重拍带货探店 2×14s：段1 出片后才提交段2，避免打爆即梦 agent 的 LLM 网关（429）
# 用法：./scripts/serial-tour-2seg.sh
set -u
cd /Users/xiaoan/Desktop/REA/web-free-studio || exit 1
API=http://127.0.0.1:8790
PROMPT_FILE=data/tmp-tour-2seg.json
COOLDOWN=${1:-240}   # 429 冷却秒数（默认 4 分钟）

post_json() { # $1=path $2=body
  curl -s --noproxy '*' -X POST "$API$1" -H 'content-type: application/json' -d "$2"
}

task_of() { # $1=upstreamId → "status|assetPath"
  curl -s --noproxy '*' "$API/api/tasks?provider=dreamina&limit=30" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const t=(JSON.parse(s).tasks||[]).find(x=>x.upstreamId==="'"$1"'");
  console.log(t? t.status+"|"+(t.asset?.video||"") : "missing|");
});'
}

submit_seg() { # $1=key → upstreamId or FAIL:reason
  local key=$1
  local body
  body=$(node -e '
    const p=require("./'"$PROMPT_FILE"'")["'"$key"'"];
    console.log(JSON.stringify({accountId:"dm-main",prompt:p,duration:14,aspect:"9:16",resolution:"720P"}));
  ')
  local out
  out=$(post_json /api/dreamina/generate "$body")
  echo "$out" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s); if(j.upstreamId) return console.log(j.upstreamId);
    console.log("FAIL:"+(j.error||"unknown"));}catch(e){console.log("FAIL:bad-json "+s.slice(0,120));}
});'
}

wait_done() { # $1=id $2=label  最多等 40 分钟
  local id=$1 label=$2
  for i in $(seq 1 120); do
    post_json /api/dreamina/sync '{}' >/dev/null
    local st; st=$(task_of "$id")
    echo "[$(date +%H:%M:%S)] $label ${st%%|*}"
    case "$st" in
      done\|*) echo "$st"; return 0;;
      failed*|needs_input*|stale*|cancelled*) echo "$st"; return 1;;
    esac
    sleep 20
  done
  echo "timeout|"; return 2
}

submit_with_retry() { # $1=key $2=label
  local key=$1 label=$2 id
  for try in 1 2 3; do
    id=$(submit_seg "$key")
    case "$id" in
      FAIL:*) echo "[$(date +%H:%M:%S)] $label 提交失败（$try/3）：$id"; sleep 180;;
      *) echo "[$(date +%H:%M:%S)] $label 已提交 $id"; echo "$id"; return 0;;
    esac
  done
  return 1
}

echo "冷却 ${COOLDOWN}s 后开始串行重拍（429 限流需要时间恢复）"
sleep "$COOLDOWN"

ID1=$(submit_with_retry seg1 "段1") || { echo "ABORT 段1提交失败"; exit 2; }
R1=$(wait_done "$ID1" "段1") || { echo "ABORT 段1未成功：$R1"; exit 3; }
F1=${R1#*|}
echo "段1 出片 $F1"

sleep 20
ID2=$(submit_with_retry seg2 "段2") || { echo "ABORT 段2提交失败"; exit 4; }
R2=$(wait_done "$ID2" "段2") || { echo "ABORT 段2未成功：$R2"; exit 5; }
F2=${R2#*|}
echo "段2 出片 $F2"

OUT="data/assets/$(date +%Y-%m-%d)/dreamina-tour-2x14-joined.mp4"
printf "file '%s'\nfile '%s'\n" "$PWD/$F1" "$PWD/$F2" > /tmp/concat-tour.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt -c copy -movflags +faststart "$OUT" \
  && echo "JOINED $OUT" || { echo "FFMPEG_FAIL"; exit 6; }
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT"
echo "DONE"
