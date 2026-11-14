# 鱼缸**运行时环境**镜像（linux/arm64，macmini 原生架构）。
#
# 关键设计：镜像只装环境，**不 baked 源码**。
# 鱼是快速迭代的项目，源码由 compose 从宿主仓库 bind mount 进 /app，
# 部署 = 宿主 git pull + docker compose restart fish（秒级），不重建镜像。
# 只有运行时依赖（系统包 / python 包 / node 依赖）变了才需要重建本镜像。
#
# 其它要点：
#   • Node 26 直接跑 .ts（原生类型剥离），**没有构建步骤**，与 npm start 完全一致
#   • SQLite 走 node:sqlite 内置，无原生编译；唯一原生依赖是 sharp（按架构取预编译包）
#   • node_modules 也外挂，但指向宿主上**独立的 Linux 依赖目录**
#     （`.node_modules-linux/`，已 gitignore）——不能用仓库的 `node_modules/`，
#     那份是 macOS 二进制，sharp 加载不了。依赖由 entrypoint 按 lockfile 指纹安装
#   • uid/gid 钉 501：与 macmini 宿主用户一致，bind mount 的仓库与媒体权限才对得上
#
# digest 固定（2026-11-14 实测 linux/arm64）：升级时改 digest，不用浮动 tag。
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

# 系统依赖：
#   ffmpeg/ffprobe  src/media/gif-frames.ts 抽帧
#   socat           ComfyUI 端点只认 127.0.0.1（防 SSRF 的安全不变量），靠它转发到宿主机隧道
#   python3+venv    scripts/video-frames.py 需要 av + Pillow
#   procps          pgrep：scripts/memory.ts 的活鱼护栏、运维排查
#   tzdata          TZ=Asia/Shanghai（宵禁 00:00–08:00 与 localDay() 切日都依赖本地时区）
#   ca-certificates HTTPS 出站
#   libheif-examples + libheif-plugin-libde265
#                   HEIC 解码。sharp 预编译包的 libheif **只带 AV1、没有 libde265**，
#                   `format.heif.input` 报 true 但喂 HEIC 会 `bad seek`（2026-11-14 实测）；
#                   ffmpeg 也只解网格首个瓦片。heif-convert 能正确拼整图。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg socat python3 python3-venv procps tzdata ca-certificates \
      libheif-examples libheif-plugin-libde265 \
 && rm -rf /var/lib/apt/lists/*

# 视频抽帧 venv：Debian 的 python 受 PEP 668 保护，不能直接 pip install 到系统环境。
# 路径由 compose 的 VIDEO_PYTHON 显式指向，不依赖 homedir() 兜底。
RUN python3 -m venv /opt/video-venv \
 && /opt/video-venv/bin/pip install --no-cache-dir av Pillow

# 与宿主 macmini 用户同 uid/gid：bind mount 的仓库与 var/media 属 501，
# 用 root 跑会把新文件写成 root 所有，宿主机侧就动不了了。
RUN groupadd -g 501 yugang \
 && useradd -u 501 -g 501 -m -d /home/yugang -s /bin/sh yugang

WORKDIR /app

# 镜像里**既无源码也无依赖**：两者全部由宿主 bind mount 提供。
# 依赖首次由 entrypoint 的 npm ci 装入 `.node_modules-linux/`（实测 107 包约 2s）。
# 好处：镜像纯环境、构建极快、无 volume 播种陷阱、依赖在宿主可见可备份。
RUN mkdir -p /data /app \
 && chown -R 501:501 /data /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    YUGANG_CONTAINER=1 \
    VIDEO_PYTHON=/opt/video-venv/bin/python

USER 501:501

# entrypoint 来自 bind mount 的源码（不在镜像里），用 sh 显式执行，
# 这样改 entrypoint 脚本也不需要重建镜像。
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]