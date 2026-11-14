#!/bin/sh
# 鱼缸容器入口。源码由 bind mount 提供，本脚本也来自源码——改它不需要重建镜像。
#
# 职责只有四件，业务逻辑一律不在这里（AGENTS.md：入口只注册）：
#   1. 依赖对齐：lockfile 变了才 npm ci（与宿主 scripts/lib/deps.ts 同思路）
#   2. 起 ComfyUI 的 loopback 转发（保住 comfy.ts 的防 SSRF 不变量）
#   3. 等协议端 WS 就绪（与 scripts/up.ts 同语义）
#   4. exec 鱼——让 node 成为主进程，SIGTERM 直达，优雅 drain 完 outbox 再退
#
# 不做的事：不拉协议端（兄弟容器）、不拉 TTS（宿主机 launchd + MPS）、不写业务文案。
set -eu

log() { echo "[entrypoint] $*"; }

# ── 1. 依赖对齐 ────────────────────────────────────────────────────
# node_modules 是 named volume（Linux 原生二进制），首次从镜像播种。
# 镜像重建不会更新已存在的 volume，所以这里按 lockfile 指纹自行对齐：
# 源码挂载让 package-lock.json 随时可能是新的，指纹不符就重装。
LOCK=/app/package-lock.json
STAMP=/app/node_modules/.yugang-lock.sha256
if [ -f "$LOCK" ]; then
  want=$(sha256sum "$LOCK" | cut -d' ' -f1)
  have=$(cat "$STAMP" 2>/dev/null || echo "")
  if [ "$want" != "$have" ]; then
    log "package-lock.json 变了，安装依赖（npm ci --omit=dev）…"
    if npm ci --omit=dev --no-audit --no-fund >/tmp/npm-ci.log 2>&1; then
      # npm ci 会先清空 node_modules，指纹必须装在之后写
      printf '%s\n' "$want" > "$STAMP"
      log "依赖安装完成"
    else
      log "✗ 依赖安装失败，末 20 行："
      tail -20 /tmp/npm-ci.log
      exit 1
    fi
  else
    log "依赖已是最新（lockfile 指纹一致）"
  fi
else
  log "✗ 找不到 $LOCK——源码挂载没生效？"
  exit 1
fi

# ── 2. ComfyUI 转发 ────────────────────────────────────────────────
# src/tools/draw/comfy.ts 硬校验端点必须是 http://127.0.0.1:<port>/，
# 那是防「模型把 draw 指向任意主机」的闸，不为部署便利放宽。
# 这里在容器内把同一个 loopback 端口转发到宿主机的 SSH 隧道，不变量字面继续成立。
if [ -n "${COMFYUI_URL:-}" ]; then
  comfy_port="${COMFYUI_URL##*:}"
  case "$comfy_port" in
    ''|*[!0-9]*) comfy_port=18190 ;;
  esac
  # 后台起；compose 的 init: true 负责收 socat fork 出的僵尸子进程。
  # 隧道没通时 socat 仍会监听，只是连接失败——draw 会以 tool 错误回报，不静默。
  socat TCP-LISTEN:"$comfy_port",bind=127.0.0.1,fork,reuseaddr \
        TCP:host.docker.internal:"$comfy_port" &
  log "ComfyUI 转发 127.0.0.1:$comfy_port → host.docker.internal:$comfy_port"
else
  log "未设 COMFYUI_URL，draw 不可用（跳过转发）"
fi

# ── 3. 等协议端 ────────────────────────────────────────────────────
ws_url="${ONEBOT_WS_URL:-ws://napcat:3001}"
log "等协议端就绪：$ws_url"
if ! node -e '
const url = process.argv[1];
const deadline = Date.now() + 300000;
const probe = () => new Promise((res) => {
  const ws = new WebSocket(url);
  const t = setTimeout(() => { try { ws.close(); } catch {} res(false); }, 2500);
  ws.addEventListener("open", () => { clearTimeout(t); try { ws.close(); } catch {} res(true); }, { once: true });
  ws.addEventListener("error", () => { clearTimeout(t); res(false); }, { once: true });
});
(async () => {
  while (Date.now() < deadline) {
    if (await probe()) { console.log("[entrypoint] 协议端就绪"); process.exit(0); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error("[entrypoint] ✗ 等不到协议端（5 分钟）。查 docker compose logs napcat");
  process.exit(1);
})();
' "$ws_url"; then
  exit 1
fi

# ── 4. 起鱼 ────────────────────────────────────────────────────────
# 与 npm start 逐字一致（--env-file-if-exists 容忍容器内没有 .env 文件：
# env 由 compose env_file 注入）。exec 让 node 接棒，不额外留 shell 层。
log "启动鱼缸"
exec node --env-file-if-exists=.env src/index.ts