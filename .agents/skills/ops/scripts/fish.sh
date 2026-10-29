#!/bin/bash
# 远程操作 macmini（macmini）上的鱼 —— 鱼的唯一生产现场。
# 本地 var/ 是迁移前旧副本，不要在本地起鱼；一切运维走本脚本。
set -euo pipefail
CONNECT="${HOME_MAC_CONNECT:-$HOME/.agents/skills/home-mac-connect/scripts/connect.sh}"
[ -x "$CONNECT" ] || { echo "找不到 home-mac-connect 的 connect.sh：$CONNECT"; exit 1; }
PREFIX='export PATH=/opt/homebrew/bin:$PATH; cd ~/yugang &&'
CMD="${1:-status}"
[ $# -gt 0 ] && shift || true

case "$CMD" in
  status)            exec "$CONNECT" -- "$PREFIX npm run ops status 2>&1" ;;
  digest)            exec "$CONNECT" -- "$PREFIX node scripts/ops.ts digest $* 2>&1" ;;
  usage)             exec "$CONNECT" -- "$PREFIX node scripts/ops.ts usage $* 2>&1" ;;
  probe)             exec "$CONNECT" -- "$PREFIX npm run probe 2>&1" ;;
  ping)              exec "$CONNECT" -- "$PREFIX npm run ping 2>&1" ;;
  log)               N="${1:-40}"; exec "$CONNECT" -- "cd ~/yugang && tail -n $N var/fish-console.log 2>&1" ;;
  ps)                exec "$CONNECT" -- 'ps aux | grep -E "src/index.ts|memes.ts" | grep -v grep' ;;
  deploy)            exec "$CONNECT" -- "$PREFIX npm run deploy 2>&1" ;;
  memes)             exec "$CONNECT" -- "$PREFIX npm run memes status 2>&1" ;;
  memes-import)      exec "$CONNECT" -- "$PREFIX nohup node scripts/memes.ts import > var/memes-import.log 2>&1 & echo 'import 已转后台，用 fish.sh memes-import-log 看进度'" ;;
  memes-import-log)  exec "$CONNECT" -- "cd ~/yugang && tail -n 8 var/memes-import.log 2>&1" ;;
  help|--help|-h)
    cat <<'EOF'
用法：fish.sh <子命令> [参数]   —— 全部在 macmini 的 ~/yugang 下执行
  status    数据目录/幂等表/原话簿概况
  digest [日期] [群号]   复盘某天某个群聊了什么
  usage [日期]           当天用量
  probe     QQ 侧验收（连 OneBot、报身份和群）
  ping      模型连通性 + 用量
  log [N]   鱼日志尾部（默认 40 行）
  ps        进程状态（鱼 / meme import）
  deploy    git pull + 平滑重启鱼（标准部署入口）
  memes     表情包库状态
  memes-import       后台收编 inbound 暂存图（ssh 断开不中断）
  memes-import-log   收编进度
  其它任意命令原样透传，如：fish.sh npm test
EOF
    ;;
  *)                 exec "$CONNECT" -- "$PREFIX $CMD $* 2>&1" ;;
esac
