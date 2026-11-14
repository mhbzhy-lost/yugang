#!/bin/bash
# 远程操作 macmini（macmini）上的鱼 —— 鱼的唯一生产现场。
# 本地 var/ 是迁移前旧副本，不要在本地起鱼；一切运维走本脚本。
set -euo pipefail
if [ -n "${HOME_CONNECT:-}" ]; then
  CONNECT="$HOME_CONNECT"
  CONNECT_MODE=unified
elif [ -n "${HOME_MAC_CONNECT:-}" ]; then
  # 历史覆盖入口直接接受 --；不把统一入口的 mac 子命令加给它。
  CONNECT="$HOME_MAC_CONNECT"
  CONNECT_MODE=direct
else
  CONNECT="$HOME/.agents/skills/home-connect/scripts/connect.sh"
  CONNECT_MODE=unified
fi
[ -x "$CONNECT" ] || { echo "找不到 home-connect 的 connect.sh：$CONNECT"; exit 1; }
remote() {
  if [ "$CONNECT_MODE" = direct ]; then exec "$CONNECT" -- "$@"; fi
  exec "$CONNECT" mac -- "$@"
}
PREFIX='export PATH=/opt/homebrew/bin:$PATH; cd ~/yugang &&'
CMD="${1:-status}"
[ $# -gt 0 ] && shift || true

case "$CMD" in
  status)            remote "$PREFIX npm run ops status 2>&1" ;;
  digest)            remote "$PREFIX node scripts/ops.ts digest $* 2>&1" ;;
  usage)             remote "$PREFIX node scripts/ops.ts usage $* 2>&1" ;;
  probe)             remote "$PREFIX npm run probe 2>&1" ;;
  ping)              remote "$PREFIX npm run ping 2>&1" ;;
  log)               N="${1:-40}"; remote "cd ~/yugang && /usr/local/bin/docker compose logs --tail $N fish 2>&1" ;;
  ps)                remote 'ps aux | grep -E "src/index.ts|memes.ts" | grep -v grep' ;;
  deploy)            remote "cd ~/yugang && git fetch origin main && git reset --hard FETCH_HEAD && /usr/local/bin/docker compose restart fish 2>&1" ;;
  memes)             remote "$PREFIX npm run memes status 2>&1" ;;
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
  其它任意命令原样透传，如：fish.sh npm test
EOF
    ;;
  *)                 remote "$PREFIX $CMD $* 2>&1" ;;
esac
