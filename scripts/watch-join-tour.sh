#!/bin/zsh
# 盯两段 14s 出片 → 自动无损拼接成 28s
set -u
cd /Users/xiaoan/Desktop/REA/web-free-studio || exit 1
SEG1=477e6fc1-ec0e-4414-9d8e-ff5e5edf6495
SEG2=0bb28d23-8a61-4d66-82a9-8094dc1425da

state() {
  curl -s --noproxy '*' "http://127.0.0.1:8790/api/tasks?provider=dreamina&limit=6" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const want=["'"$SEG1"'","'"$SEG2"'"];
  const t=JSON.parse(s).tasks||[];
  const out=want.map(id=>{const x=t.find(y=>y.upstreamId===id);return x?x.status+"|"+(x.asset?.video||"")+"|"+(x.failReason||x.question||""):"missing||";});
  console.log(out.join("\n"));
});'
}

for i in $(seq 1 120); do
  curl -s --noproxy '*' -X POST http://127.0.0.1:8790/api/dreamina/sync -H 'content-type: application/json' -d '{}' >/dev/null
  S=$(state)
  L1=$(echo "$S" | sed -n 1p); L2=$(echo "$S" | sed -n 2p)
  echo "[$(date +%H:%M:%S)] seg1=${L1%%|*} seg2=${L2%%|*}"
  BAD=$(echo "$S" | grep -E '^(failed|needs_input|cancelled|missing)' || true)
  if [ -n "$BAD" ]; then echo "ABORT: $BAD"; exit 2; fi
  F1=$(echo "$L1" | cut -d'|' -f2); F2=$(echo "$L2" | cut -d'|' -f2)
  if [ -n "$F1" ] && [ -n "$F2" ]; then
    OUT="data/assets/$(date +%Y-%m-%d)/dreamina-tour-2x14-joined.mp4"
    mkdir -p "$(dirname "$OUT")"
    printf "file '%s'\nfile '%s'\n" "$PWD/$F1" "$PWD/$F2" > /tmp/concat-tour.txt
    ffmpeg -y -loglevel error -f concat -safe 0 -i /tmp/concat-tour.txt -c copy -movflags +faststart "$OUT" \
      && echo "JOINED $OUT" || { echo "FFMPEG_FAIL"; exit 3; }
    ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT"
    exit 0
  fi
  sleep 20
done
echo "TIMEOUT"
exit 4
