#!/bin/zsh
# 串行重拍带货探店 2×14s：段1 出片后才提交段2
# 目的：同一 thread 并发提交会触发即梦 agent 的 LLM 网关 429（伺服器忙碌中），必须串行。
# 约定：所有日志走 stderr，stdout 只输出「id / 状态行」，供 $(...) 捕获。
set -u
cd /Users/xiaoan/Desktop/REA/web-free-studio || exit 1
API=http://127.0.0.1:8790
PROMPT_FILE=data/tmp-tour-2seg.json
COOLDOWN=${1:-180}
RETRY_WAIT=${2:-900}   # 429 重试间隔（默认 15 分钟：账号级限流恢复慢）

log() { echo "[$(date +%H:%M:%S)] $*" >&2; }

post_json() { curl -s --noproxy '*' -X POST "$API$1" -H 'content-type: application/json' -d "$2"; }

# 查单条任务：输出 "status|assetPath"
task_of() {
  curl -s --noproxy '*' "$API/api/tasks?provider=dreamina&limit=40" | ID="$1" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try {
    const t=(JSON.parse(s).tasks||[]).find(x=>x.upstreamId===process.env.ID);
    console.log(t? t.status+"|"+(t.asset?.video||"") : "missing|");
  } catch { console.log("unknown|"); }
});'
}

# 最近 5 分钟内、同 prompt 的在途任务（提交超时后可能其实已成功，用来认领，避免重复扣）
recent_same_prompt() {
  curl -s --noproxy '*' "$API/api/tasks?provider=dreamina&limit=20" | KEY="$1" node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try {
    const now=Date.now();
    const t=(JSON.parse(s).tasks||[]).find(x=>x.prompt===process.env.KEY && now-(x.createdAt||0)<300000 && ["queued","running","pending"].includes(x.status));
    console.log(t? t.upstreamId : "");
  } catch { console.log(""); }
});'
}

submit_seg() { # $1=key → stdout: upstreamId 或 FAIL:<原因>
  local body
  body=$(SEG="$1" node -e 'const p=require("./'"$PROMPT_FILE"'")[process.env.SEG];console.log(JSON.stringify({accountId:"dm-main",prompt:p,duration:14,aspect:"9:16",resolution:"720P"}));')
  local out
  out=$(post_json /api/dreamina/generate "$body")
  printf '%s' "$out" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);if(j.upstreamId)return console.log(j.upstreamId);console.log("FAIL:"+(j.error||"unknown"));}
  catch(e){console.log("FAIL:bad-json "+s.slice(0,80));}
});'
}

prompt_key() { # 拿到段落的原始 prompt 文本（用于认领）
  SEG="$1" node -e 'process.stdout.write(require("./'"$PROMPT_FILE"'")[process.env.SEG])'
}

submit_with_retry() { # $1=key $2=label → stdout: upstreamId（成功）/ 空（失败）
  local key=$1 label=$2 id try
  local pk; pk=$(prompt_key "$key")
  for try in 1 2 3; do
    id=$(submit_seg "$key")
    case "$id" in
      FAIL:*)
        log "$label 提交失败（$try/3）：${id#FAIL:}"
        # 超时类失败常常其实已提交成功，先认领再重试，避免重复扣额度
        sleep 30
        local adopt; adopt=$(recent_same_prompt "$pk")
        if [ -n "$adopt" ]; then log "$label 已在上游找到刚提交的任务，认领 $adopt"; echo "$adopt"; return 0; fi
        log "$label 等 ${RETRY_WAIT}s 再试（429 账号级限流，退避要够长）"
        sleep "${RETRY_WAIT}"
        ;;
      ????????-????-????-????-????????????)
        log "$label 已提交 $id"
        echo "$id"; return 0
        ;;
      *)
        log "$label 返回异常：$id"; sleep 60
        ;;
    esac
  done
  return 1
}

wait_done() { # $1=id $2=label → stdout: "status|path"
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

log "冷却 ${COOLDOWN}s 后开始串行重拍"
sleep "$COOLDOWN"

ID1=$(submit_with_retry seg1 "段1") || { log "ABORT 段1 提交失败"; exit 2; }
R1=$(wait_done "$ID1" "段1") || { log "ABORT 段1 未成功：$R1"; exit 3; }
F1=${R1#*|}
log "段1 出片 $F1"

sleep 30
ID2=$(submit_with_retry seg2 "段2") || { log "ABORT 段2 提交失败"; exit 4; }
R2=$(wait_done "$ID2" "段2") || { log "ABORT 段2 未成功：$R2"; exit 5; }
F2=${R2#*|}
log "段2 出片 $F2"

OUT="data/assets/$(date +%Y-%m-%d)/dreamina-tour-2x14-joined.mp4"
printf "file '%s'\nfile '%s'\n" "$PWD/$F1" "$PWD/$F2" > /tmp/concat-tour.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt -c copy -movflags +faststart "$OUT" \
  && log "JOINED $OUT" || { log "FFMPEG_FAIL"; exit 6; }
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT" >&2
echo "$OUT"
