# 鱼缸 + NapCat + QQ 容器化实施计划

日期：2026-11-14
状态：已按独立 reviewer 意见修订（第 2 版），待主人选择执行方式
范围裁定：主人 2026-11-14 决定「鱼 + NapCat + QQ 进容器，语音留宿主机」。语音环境相对独立，不在本次范围。

> 第 1 版被 reviewer 判定「不能直接执行」，5 处阻塞级问题已全部纳入本版：
> B1 `sips` 图像链路、B2 配置原子写 vs 单文件挂载、B3 宿主 loopback 可达性、B4 开机自启链、B5 WAL 迁移。
> 另补 `deploy.ts` / `memory.ts` 两处双实例护栏，重排 S3–S5 顺序，改写 A6/A10/A16 判据。

## 1. 为什么做

macOS 上协议端是「把 NapCat 注入 QQ.app」的形态，依赖一串脆弱的系统条件。2026-11-14 的恢复过程实测踩到：

- **Gatekeeper 拒绝面包屑**：按 `(path, team, id)` 记账，一旦弹「已损坏」被点取消，此后不弹窗直接拒；进程冻在 exec 阶段（RSS 恒 32KB、日志 0 字节）
- **quarantine**：`ditto` 从快照取回 app 带回 347 个 `com.apple.quarantine`，清零后才能启动
- **App 管理权限**：改别的 app bundle 需要 `kTCCServiceSystemPolicyAppBundles`，SSH 侧无法获得，必须 GUI 授权
- **版本偏移表**：NapCat packet 后端按 QQ build 查表，`7.0.2-53644` 在表内、`7.0.3-54395` 不在；表外 build 能启动但图片链路断（rkey 全禁 → `download url has expired`）
- **NapCat 版本敏感**：工作版 4.18.41，装成 4.18.42 即被 AMFI 杀（`CODESIGNING Invalid Page`）
- **App Store 自动更新**会换掉 QQ build，随时可能再次踩表外

这些全是 macOS 注入形态特有的。Linux 容器跑官方 NapCat 镜像，上述条件一个都不存在。

上游依据（2026-11-14 核实）：`NapNeko/NapCat-Docker` 仍在维护（与被删的 `NapNeko/NapCatQQ` 是两个仓库），镜像 `mlikiowa/napcat-docker` 一天前有更新，提供 `linux/amd64` 与 `linux/arm64`。macmini 是 arm64，不需要 Rosetta。

## 2. 目标与非目标

### 目标（整体交付终态）

1. macmini 上 `docker compose up -d` 拉起 **napcat + fish + 60s**，重启后自动恢复（**含宿主机侧依赖的自启，见 §5 S0**）
2. 鱼在群里收发文字、**图片（模型真能看见内容）**、表情包正常；`draw` 文生图**与 ref 改图**都正常；`say_voice` 出声正常
3. 登录态、数据库（**含 WAL**）、媒体、记忆、用量、频控状态全部持久化，容器重建不丢
4. 现有安全不变量**一条不放宽**
5. 宿主机不再需要 QQ.app / NapCat 注入 / `scripts/protocol.ts`
6. 运维入口收敛，且**旧入口不会误起第二条鱼**

### 非目标

- **语音容器化**：GPT-SoVITS 继续宿主机 launchd + MPS。容器拿不到 Metal
- **ComfyUI 容器化**：仍在 Windows，经宿主机 SSH 隧道
- **新增测试**：未经授权不新增测试/fixture/压力场景。只跑既有 `npm test` / `npm run prompts` / `npm run smoke:news`
- **`scripts/protocol.ts` 定稿**：macOS 专属，容器化后退役（主人已裁定）

## 3. 目标架构

```
macmini (macOS 27.2.1, arm64, 宿主 uid 501)
├── OrbStack（已装，docker CLI /usr/local/bin/docker）
│   └── compose project: yugang   init: true   user: "501:501"
│       ├── napcat   官方镜像，Linux QQ + NapCat，WebUI 6099 / WS 3001
│       ├── fish     本仓构建，Node 26，跑 src/index.ts
│       └── 60s      vikiboss/60s（现为独立容器，收进 compose）
├── 宿主机保留（各自需要 launchd 自启，见 S0）
│   ├── GPT-SoVITS ×3（MPS）:9884 / :9887 / :9888
│   ├── ComfyUI SSH 隧道 → Windows :18190
│   └── provider 代理 :7897
└── 持久化
    ├── named volume  yugang-data → /data   （fish.db+wal+shm / chatlog / usage / workspace / bili-*.json / look-off.marker）
    ├── bind mount    ~/yugang/var/media → /media   （9.5G，宿主机可直接查看与投图）
    ├── bind mount    ~/yugang/config → /app/config （**目录**，含 auth.json + models.json）
    └── bind mount    ~/yugang/docker-runtime → /app/runtime-config （**目录**，含 fish.config.json）
```

### 3.1 宿主机依赖接法（B3：**已实测解决，零安全代价**）

四条依赖当前**都只监听宿主 loopback**（实测 `lsof`：ssh 隧道 `127.0.0.1:18190`、TTS `127.0.0.1:9884/9887/9888`、60s `127.0.0.1:4399`）。

**2026-11-14 实测结论：OrbStack 的 `host.docker.internal` 可直达宿主 loopback，功能级验证全部通过。**

| 服务 | TCP | 功能级 |
|---|---|---|
| 60s `:4399` | 可达 | `GET /health` → **HTTP 200, 2 bytes** |
| TTS `:9884/9887/9888` | 三个全可达 | `GET /` → HTTP 500（根路径非有效端点，服务活着） |
| ComfyUI `:18190` | 可达 | `GET /` → **HTTP 200, 20089 bytes**（容器内经 SSH 隧道真打到 Windows） |
| provider 代理 `:7897` | 可达 | **`CONNECT www.gstatic.com:443` → HTTP 200，隧道建立** |

因此：**不需要放宽任何服务监听面、不需要宿主侧 relay、不需要 `extra_hosts`**（写了反而会覆盖 OrbStack 自带映射、指向 VM 网关）。R10 风险消除。

复现脚本：`~/napcat-restore/probe-host-reach.sh`（TCP）、`~/napcat-restore/probe-functional.sh`（功能级）。

| 依赖 | 接法（实测通过后） | 改代码 |
|---|---|---|
| **ComfyUI** `:18190` | 容器内 socat：`127.0.0.1:18190` → 宿主 `:18190` | **不改**。`comfy.ts:83` 的 loopback 校验字面成立 |
| **TTS** `:988x` | `fish.config.json` 的 `voices[].url` 改宿主可达地址 | 不改代码，改配置 |
| **60s** `:4399` | compose 同网 `http://60s:4399` | 不改代码，改 env |
| **provider 代理** `:7897` | `config/models.json` 的 `providers.*.proxy` 改宿主可达地址 | 不改代码，改配置 |

上述接法已实测成立，无需备选方案。若将来 OrbStack 行为变化导致不可达，备选优先级：① OrbStack 宿主别名；② 宿主侧 socat relay 绑网桥地址（**不绑 0.0.0.0**）；③ 最后才考虑放宽监听面（**属安全代价，需主人单独批准**）。

ComfyUI 用转发而非放宽校验：那条校验是防「模型把 draw 指向任意主机」的 SSRF 闸，属安全不变量。

`voices[].referWav` 是宿主机绝对路径，由宿主机 TTS 进程自己读（`src/tts.ts:44-46` 作为 `refer_wav_path` 传服务端），**不经容器**，保持原值。

### 3.2 图像链路（B1：本版最大的新增工作量）

`sips` 是 macOS 专有二进制，**7 处调用、4 个文件**，容器里全部失效，且**失败路径全是静默降级**：

| 位置 | 作用 | 失效后果 |
|---|---|---|
| `src/qq/onebot.ts:709` | 入站 HEIC/HEIF/BMP/TIFF → JPEG | `return null`，图直接丢 |
| `src/media/shrink-image.ts:41,55` | **inline 直读的唯一压图实现** | `{ok:false,reason:"sips"}` → 上层「跳过不阻塞」→ **模型一张图都看不到且不报错** |
| `src/tools/look/tool.ts:349` | fallback 看图压缩 | 看图不可用 |
| `src/tools/draw/tool.ts:199,209` | `ref` 初图探测与归一化 | `return null` → img2img 不可用 |

`npm test` 挡不住：`test/model-input-templates.test.ts:99`、`test/quoted-images.test.ts:37` 都注入 `shrinkStub`。

**方案：新增 `src/media/image-ops.ts` 双后端抽象，4 处调用点改为调它。**

- 导出 `probeSize()` / `toJpeg()` / `toPngResized()` / `shrinkToFit()`
- `process.platform === "darwin"` → **原样保留现有 sips 参数**（生产路径零行为变化，避免回归）
- 其它平台 → `sharp`（linux/arm64 有 prebuilt libvips，含 HEIF 支持）
- 新增依赖 `sharp`。**这是本次唯一新增运行时依赖**，需主人确认（开放项 1）
- 失败仍返回原有 `{ok:false}` 形状，但**新增一行告警日志**，不再纯静默

不选 ffmpeg 做静图：HEIC 支持不可靠。不选 ImageMagick：多一个系统包且 CLI 语义要重写一遍。

### 3.3 部署形态：Docker 只做隔离，源码不 baked（主人 2026-11-14 裁定）

主人指出：鱼是快速迭代项目，每次部署都重建镜像太慢。改为：

| 层 | 放哪 | 更新方式 |
|---|---|---|
| 运行时环境（node / ffmpeg / socat / python+av / heif-convert） | 镜像 | 很少变，改 Dockerfile 才重建 |
| **源码**（src / prompt / scripts / docs） | **bind mount 宿主仓库 → `/app`** | `git pull` + `docker compose restart fish`，**秒级** |
| **node_modules** | **bind mount `.node_modules-linux/` → `/app/node_modules`** | lockfile 变了由 entrypoint 自动 `npm ci` |
| 数据 / 媒体 / 配置 | volume + bind mount | 不变 |

**为何依赖要另开一份目录**：仓库的 `node_modules/` 是 **macOS 二进制**（sharp），Linux 加载不了。所以宿主另开 `.node_modules-linux/`（已 gitignore）挂进 `/app/node_modules`。entrypoint 按 `package-lock.json` 的 sha256 指纹自行对齐（与宿主 `scripts/lib/deps.ts` 同思路）。

**零 named volume**（主人：「那就直接都外挂吧」）。镜像退化为**纯环境**：连 `npm ci` 都不在构建时跑，依赖首次由 entrypoint 装入（实测 107 包约 2s）。好处：无 volume 播种陷阱、`down -v` 不会误删任何东西、依赖在宿主可见可备份、镜像构建极快。

**连带好处**：仓库整目录挂载后，`fish.config.json` 是挂载目录里的普通文件，代码的 tmp+rename 原子写**天然可用**——B2 的 `EBUSY` 问题自动消失，且容器与宿主形态**共用同一份配置**（单一事实源）。`YUGANG_FISH_CONFIG` 覆盖作为能力保留（隔离测试需要它），生产 compose 不再使用。

**成本实测**：改 Dockerfile/lockfile 那次重建 250–330s（apt+pip+npm ci 全跑）；纯代码改动因层缓存约 15–20s。改成挂载后实测 **`restart` 到鱼重新「已连接」共 3 秒**，且鱼的 `read`/`grep` 看到的是真实仓库而非快照。

#### 部署命令分两条（VirtioFS 属性缓存，OrbStack 实测）

实测：宿主删除文件后，**长驻容器**内立刻查仍可见，**3 秒后**同步；而**新建容器**立刻就是干净的。所以：

```bash
# 日常改代码（只改文件内容）
git pull && docker compose restart fish                  # 实测 3 秒

# 删除 / 改名了源文件
git pull && docker compose up -d --force-recreate fish    # 新容器，无残留缓存
```

只改内容不受影响（读的是新 inode）；删/改名时旧文件可能残留 ~3s，用 `--force-recreate` 彻底避开。

## 4. 文件职责

### 新增

| 文件 | 职责 |
|---|---|
| `Dockerfile` | **只装运行时环境，不 baked 源码**（见 §3.3）。基底 node:26-slim 钉 digest；装 `ffmpeg`/`ffprobe`、`socat`、`python3-venv` + venv 内 `av`+`Pillow`、`procps`、`tzdata`、`ca-certificates`、`libheif-examples`+`libheif-plugin-libde265`（HEIC）；`npm ci --omit=dev` 只为给 node_modules volume 提供初值；uid/gid 501。**只拷 `package.json` `package-lock.json`** |
| `compose.yaml` | 三服务、网络、卷、端口、`restart: unless-stopped`、`init: true`、`user: "501:501"`、`TZ=Asia/Shanghai`、`LANG=C.UTF-8`。**`.:/app` 源码挂载 + `yugang-node-modules:/app/node_modules`**（见 §3.3）。**默认不写 `extra_hosts`**（见 §3.1） |
| `docker/entrypoint.sh` | **依赖对齐（lockfile 指纹变了才 `npm ci`）** → 起 socat（comfy）→ 等 napcat WS → `exec node --env-file-if-exists=.env src/index.ts`。`exec` 让信号直达；僵尸由 `init: true` 回收。**本脚本也来自源码挂载，改它不需重建镜像** |
| `docker/healthcheck.mjs` | 纯 node TCP/HTTP 探测（slim 镜像无 `nc`），供 compose healthcheck 与验收复用 |
| `.dockerignore` | 排除 `node_modules/ var/ .git/ .env config/auth.json config/models.json fish.config.json *.log .trash/` |
| `src/media/image-ops.ts` | 图像操作双后端（§3.2） |
| `docker-runtime/fish.config.json` | 宿主机侧运行目录，从现有 `fish.config.json` 迁入 |
| `docs/plans/2026-11-14-dockerize-fish-napcat.md` | 本计划 |

### 修改

| 文件 | 改什么 | 为什么 |
|---|---|---|
| **`src/paths.ts`** | **新增 `FISH_CONFIG_PATH` 的 env 覆盖**（`YUGANG_FISH_CONFIG`），与现有 5 个覆盖同模式 | B2：`FISH_CONFIG_PATH = join(REPO_ROOT,"fish.config.json")` 无覆盖入口，而该文件必须可写挂载。第 1 版「paths.ts 零改动」的断言不成立 |
| **`src/auth/credentials.ts` / `src/tools/config/tool.ts`** | 不改代码，但**挂载方式必须是目录** | B2：三处都是 `writeFileSync(tmp)` + `renameSync`（`credentials.ts:41`、`config/tool.ts:170,211`）。Linux 上 rename 覆盖 bind-mount **挂载点**返回 `EBUSY`。挂目录则 rename 在目录内正常 |
| `src/qq/onebot.ts` / `src/media/shrink-image.ts` / `src/tools/look/tool.ts` / `src/tools/draw/tool.ts` | 7 处 sips 调用改走 `image-ops` | B1 |
| **`src/tools/restart/tool.ts`** | 容器模式 drain 完 `process.exit(0)`，由重启策略拉起 | 现实现 `spawn("/bin/sh","-c","sleep 3 && npm run up …")` 会再开一条鱼 → pi-durable id 撞号（AGENTS.md §16 事故形态） |
| **`scripts/deploy.ts`** | 容器模式**明确拒绝**并提示用 compose 重建；宿主机侧新增「容器已在跑则拒绝」护栏 | 第 1 版漏了。它 `git fetch/reset --hard`（镜像无 `.git`）+ `pkill` + spawn 新鱼 + 拉 TTS；在宿主跑会用旧 `var/fish.db` 起**第二条鱼** |
| **`scripts/memory.ts:110`** | `pgrep -fl "yugang/src/index.ts"` 改为不依赖仓库路径的匹配 + 保留原三特征校验 | 容器 WORKDIR 非 `…/yugang` 时护栏失效 → 外部写库不拦，正是 §16 撞号形态 |
| `scripts/up.ts` | 容器模式跳过「拉协议端」与「TTS 跟随」 | 协议端是兄弟容器，TTS 在宿主机 |
| `scripts/doctor.ts` | 容器模式查容器内实际依赖（ffmpeg / venv python+av+Pillow / sharp / socat / napcat / TTS / 代理），不查 macOS 路径；`.env` 存在性检查改为「env 已注入」 | `doctor.ts:21` 查 `.env` 文件，而 compose `env_file` **不生成文件** → 必假阴性 |
| `scripts/down.ts` / `scripts/tts.ts` / `scripts/protocol.ts` | 容器模式明确拒绝 + 指向正确入口 | 依赖 `lsof` / `launchctl`+`plutil` / `/Applications/QQ.app`。（reviewer 指出价值偏低，但拒绝比静默失败好，成本极小） |
| **`scripts/migrate-memes.ts:67` / `scripts/retag-memes.ts:34`** | `join(DATA_HOME,"media",…)` 改用 `MEDIA_ROOT` | `YUGANG_HOME=/data` + `MEDIA_ROOT=/media` 时会读不存在的 `/data/media/memes` |
| `.env.example` | 新增 `YUGANG_CONTAINER` / `YUGANG_FISH_CONFIG` / `VIDEO_PYTHON` 容器取值；`ONEBOT_WS_URL` 容器内须 `ws://napcat:3001`；标注必填项 | AGENTS.md §9 |
| `AGENTS.md` | 新增「容器部署」节；§6 补 `YUGANG_FISH_CONFIG`；§14 注明语音在宿主机；§15 日志口径改 `docker compose logs`；命令表补 compose；部署节改掉 `npm run deploy` | 维护约束必须与实况一致 |
| `.agents/skills/ops/SKILL.md` | 排查口径、部署入口、日志位置全部改容器版 | 否则运维按旧口径排查会误判 |
| `package.json` | 新增 `sharp` 依赖 | §3.2 |

### 容器模式判定

单一开关 `YUGANG_CONTAINER=1`，由 compose 注入。**不用 `process.platform` 判容器**（避免 Linux 开发机被误判）；`image-ops` 的后端选择是例外，它确实按平台选实现。

### 明确不改

`src/tools/draw/comfy.ts`（loopback 校验）、`src/egress/*`、`src/qq/gate.ts`、`src/memory/*`、`voices[].referWav`。

**`scripts/lib/deps.ts` 不改**：reviewer 核实 `deps.ts:126-135` 对非 loopback 的 `SIXTY_BASE_URL` 已直接「外部 60s 不可达，跳过本地容器」返回 false，根本不调 docker。设 `http://60s:4399` 即天然安全。第 1 版这条改动是白做。

**出站媒体无需共享目录**：`src/qq/onebot.ts:425,434,485,500` 全部 `base64://`，fish 与 napcat 分容器安全。

## 5. 依赖顺序（已按 reviewer 意见重排）

```
S0 宿主机自启链（B4，必须最先做）
   TTS launchd 改 RunAtLoad=true 或独立 boot job
   ComfyUI SSH 隧道 autossh launchd job
   确认 OrbStack 开机自启条件（是否需 GUI 登录）
   ↓
S1 准入实验（不通过就不往下走）
   ① 容器→宿主 loopback 可达性 ✅ 已完成，六服务功能级全通
   ② 架构确认 ✅ 宿主 arm64 / docker aarch64-linux / 容器 aarch64，全程原生
   ③ node:26 镜像 + napcat 官方镜像 arm64 可拉、能起、报版本号 ✅ 已完成
   ④ packet 表覆盖镜像内 QQ build ✅ 已完成（R2 消除）
   ↓
S2 代码适配
   image-ops 双后端 + 4 处调用点 / paths.ts 覆盖 / restart / deploy / memory
   / up / doctor / down / tts / protocol / migrate-memes / retag-memes
   → 开发机 npm test + npm run prompts 全绿
   ↓
S3 镜像与编排骨架
   Dockerfile / .dockerignore / compose.yaml / entrypoint / healthcheck
   ↓
S4 停宿主机协议端（提前！同账号会互挤下线）
   停宿主机 QQ + NapCat → pgrep 断言为 0
   ↓
S5 起 napcat 容器并登录
   迁 onebot 配置与 token → 扫码 → 验 WS + get_login_info
   ↓
S6 宿主机依赖接线（提前到 fish 之前！模型请求就要走代理）
   comfy socat / TTS 地址 / 60s 同网 / 代理地址
   ↓
S7 数据迁移（B5）
   优雅停宿主机鱼 → wal_checkpoint(TRUNCATE) → 拷 DB 三件套 + 全部状态文件
   ↓
S8 起 fish 容器
   验横幅 → 验群收发
   ↓
S9 逐工具真实验收（A1–A20）
   ↓
S10 文档与运维口径
   AGENTS.md / ops skill / 退役说明
```

S2 与 S3 可并行起草。S4 必须在 S5 之前（同账号互挤）。S6 必须在 S8 之前（模型请求走代理）。

### 5.1 生产迁移 runbook（具体命令，待授权后执行）

前提：三组 commit 已推送、生产 `git fetch && git reset --hard FETCH_HEAD` 已拉到新代码。
每一步都有**验证门**，不过就停，不往下走。

```bash
# ── G0 前置检查与备份 ────────────────────────────────────
cd ~/yugang
git status --porcelain                 # 必须空
pgrep -f "node +(--[^ ]+ +)*[^ ]*src/index\.ts"   # 记下当前鱼 pid
cp fish.config.json ~/napcat-restore/fish.config.json.pre-container
cp .env ~/napcat-restore/.env.pre-container
mkdir -p data/napcat/{qq,config,plugins} .node_modules-linux

# ── G1 停宿主鱼（优雅，留时间 drain outbox）─────────────────
npm run down
pgrep -f "node +(--[^ ]+ +)*[^ ]*src/index\.ts" || echo "✓ 鱼已停"
# 门：必须为 0。不为 0 就停手——双实例写同一 SQLite 必然撞号

# ── G2 停宿主协议端（必须前置于扫码，同账号互挤）───────────
pkill -x QQ
pgrep -x QQ || echo "✓ QQ 已停"
nc -z 127.0.0.1 3001 && echo "✗ 3001 还在听" || echo "✓ 3001 已释放"

# ── G3 迁 onebot 配置（只拿 token 与网络配置，不拿登录态）────────
SRC="$HOME/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config"
ls "$SRC"                              # 先看有哪些文件
# 注意：macOS NapCat 4.18.41 与 Linux 4.18.42 的配置格式可能不同，
# 先 diff 结构再决定是拷文件还是只拄 token 手写入新配置。
# 门：容器起后 WebUI 里能看到 WS 服务已启用且 token 一致

# ── G4 先只起 napcat，扫码 ──────────────────────────────
docker compose build fish              # 纯环境镜像，实测 ~2s
docker compose up -d napcat sixty
docker compose logs -f napcat          # 等二维码；或浏览器开 http://127.0.0.1:6099
# 人工：用鱼号 3768557204 扫码
# 门：docker compose exec napcat 日志出现登录成功；宿主 nc -z 127.0.0.1 6099 通

# ── G5 宿主依赖接线（必须在起 fish 之前：模型请求就要走代理）────
# fish.config.json 的 voices[*].url → http://host.docker.internal:988x
#   （referWav 保持宿主绝对路径，由宿主 TTS 进程自己读）
# config/models.json 的 providers.*.proxy → http://host.docker.internal:7897
# 门：容器内功能级探测全通（参照 ~/napcat-restore/probe-functional.sh）

# ── G6 起 fish（数据零拷贝，var/ 原地）────────────────────
docker compose up -d fish
docker compose logs -f fish
# 门：出现「[鱼缸] 数据目录 /data（仓库根 /app）」与「已连接」
# 门：docker compose exec fish pgrep -f "node +(--[^ ]+ +)*[^ ]*src/index\.ts" | wc -l == 1

# ── G7 逐条验收 A1–A20（见 §7）──────────────────────────
docker compose exec fish node scripts/doctor.ts   # 必须「全都齐了」
node ~/napcat-restore/ob-probe.mjs                # 只读：get_login_info / get_status / 群列表
# 真实验收：群里 @ 鱼、发图（看 inbound 落盘）、要语音、要画图
```

**回滚（任一门失败）**：

```bash
docker compose down
bash ~/napcat-restore/restore-working.sh      # 如需重装宿主 QQ+NapCat
bash ~/napcat-restore/clear-quarantine.sh
bash ~/napcat-restore/fish-restart-logged.sh  # 断言 0 残留后起宿主鱼
```

数据原地未动，回滚不需反向拷贝。若容器期间改过 `voices[*].url` / `proxy`，回滚时改回 `127.0.0.1`。

## 6. 数据位置：**全部留宿主 bind mount，零迁移**（主人 2026-11-14 裁定）

第 1–2 版计划的「DB 进 named volume + WAL 五步迁移」**整节作废**。`var/` 原地不动，一条 `./var:/data` 挂载覆盖全部业务数据。

### 6.1 为何不拆、不搬

**库内实际构成**（生产只读盘点）：

| 表 | 行数 | 占用 |
|---|---|---|
| `entries`（transcript / tool call） | 51,569 | **353.4 MB（95%）** |
| `tasks` | 32,822 | 11.5 MB |
| `documents` + `document_revisions` | 111 / 400 | **约 350 KB** |

不可再生的只有那 ~350 KB：`fish.memory`×4 / `.private`×3 / `.pending`×4（主人逐条审批攒的长期记忆）、`fish.chats`×1（群→会话映射 + 人格）、`fish.outbox`×14、`fish.watch`×2、`fish.reminders`×2。其余 353 MB 是日志，丢了只丢最近对话上下文（原话簿 `chatlog` 8.2M 是独立文件，raw 消息还在）。

**记忆无法单独 mount**：它是 session 级 keyed document family（`src/memory/model.ts:4`），与 transcript 同一个 SQLite 文件。拆存储要动 AGENTS.md §16 那套审批事务（canonical SHA-256 fingerprint、双轨预检、changed 回滚、公共化只在内存 prepare），为 350 KB 冒这个风险不值得。若将来要额外保险，**在审批时导出一份 JSON 到宿主目录**（低频、不碰事务路径）即可，不拆库。

### 6.2 决定性证据：Time Machine 覆盖

`tmutil isexcluded` 实测：OrbStack 的 `~/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw`（逻辑 228G / 实占 18G）带 **`com.apple.metadata:com_apple_backup_excludeItem`**，判定 **`[Excluded]`**。父目录显示 `[Included]` 是误导——真正装数据的镜像文件被显式排除。

所以：**named volume 里的 fish.db 不在任何备份里**；bind mount 的 `~/yugang/var/` 一直在 TM 覆盖范围内。为保护 350 KB 去另建备份作业，不如让它待在 TM 已覆盖的地方。

### 6.3 性能实测（OrbStack，单次操作延迟，非饱和吞吐）

预置 2 万 entry + 111 doc，WAL + `synchronous=NORMAL`（与 pi-durable 一致）：

| 指标（ms） | named volume | bind mount |
|---|---|---|
| 单行 commit p50 / p95 | 0.007 / 0.014 | 0.017 / 0.035 |
| **点查读 p50 / p95** | 0.003 / 0.004 | **0.003 / 0.004** |
| **范围读 50 条 p50 / p95** | 0.015 / 0.044 | **0.015 / 0.043** |
| **模拟一轮 agent mean** | 0.236 | **0.239** |
| 模拟一轮 agent p95 | 0.958 | 0.605 |
| `synchronous=FULL` mean | 0.552 | 0.334 |

结论：**读完全无差**（SQLite 页缓存命中，VirtioFS 只在 cache miss 参与，而 agent 读的正是刚写过的热数据）；写慢 2.4 倍是相对数，**绝对值 10 微秒**。一轮 agent 的 DB 总开销 0.24 ms，模型调用是秒级——DB 占整轮延迟约 0.01%。

**注意**：`synchronous=FULL` 下 bind 反而更快，提示 OrbStack 的 fsync 可能穿透到宿主 APFS 页缓存就返回，**不是真正落盘**。这是断电风险的来源，但不影响性能结论；由 TM 小时级快照兜底。

（早期用「平均写入速率 0.0373 entries/秒 vs 压测 33 万行/秒」论证是**错的**——平均速率掩盖单次延迟。正确论据是绝对延迟 + 读走页缓存。colima 上曾测出 15.5× 吞吐差，那是本地 virtiofs 实现问题，OrbStack 只有 1.29×。）

### 6.4 挂载与配置

| 数据 | 容器内 | 方式 |
|---|---|---|
| `var/` 全部（fish.db / chatlog / usage / media / bili-*.json / look-off.marker / sent.json） | `/data` | **一条 `./var:/data`，零拷贝** |
| 媒体 | `/data/media` | `MEDIA_ROOT` 不覆盖，缺省从 `DATA_HOME/media` 派生 |
| 源码 | `/app` | `.:/app` bind（见 §3.3） |
| `node_modules` | `/app/node_modules` | **bind mount `.node_modules-linux/`**（Linux 原生二进制，与 macOS 那份分开） |
| `config/` + `fish.config.json` | 随仓库挂载 | 整目录挂载 → tmp+rename 天然可用，**不再需要 `YUGANG_FISH_CONFIG`** |
| `.env` | compose `env_file` | 不进镜像；doctor 改判「env 已注入」 |
| NapCat onebot 配置 | `./data/napcat/config` | 拷 token 与网络配置；**登录态不迁**（R1） |

**UID/GID**：`config/auth.json` 是 600 且属宿主 uid 501。容器以 root 跑会把 root 拥有的文件写进 media（影响宿主 meme-inbox 投图）；以 node(1000) 跑则读不到 auth.json。**裁定 `user: "501:501"`**。

**连带消除的风险**：B5（WAL 迁移丢数据）不存在——不搬库；R4（VirtioFS 锁语义）实测通过；回滚变成「停容器、起宿主鱼」，数据原地。

## 7. 验收标准

| 编号 | 验收项 | 判据 |
|---|---|---|
| A1 | 三服务常驻 | `docker compose ps` 三个 `Up` |
| A2 | **重启自愈** | 重启 macmini 后不手动干预，三服务 + **TTS 三实例 + ComfyUI 隧道**全部就绪。**若 OrbStack 需 GUI 登录，必须明确写进文档，不假装无人值守** |
| A3 | 鱼唯一实例 | 容器内 `pgrep -f src/index.ts` = 1；宿主机无鱼进程 |
| A4 | 协议端登录 | `get_login_info` → `user_id=3768557204`；`get_status` `online:true, good:true` |
| A5 | 群收发 | 白名单群 @ 鱼收到回复 |
| A6 | **图片入站落盘** | `/media/inbound/` 新文件且 `file` 认出有效 JPEG/PNG |
| **A6b** | **模型真能看见图**（B1 专项） | 群里发一张有明确内容的图并 @ 鱼，**鱼的回复必须描述出图里的实际内容**。落盘成功不算通过 |
| **A6c** | **HEIC 入站** | 发一张 HEIC，落盘为有效 JPEG 且模型能描述 |
| A7 | 表情包 | `meme` 命中并经 `say_meme` 发出 |
| A8 | 语音 | `say_voice` 经宿主机 TTS 合成，群里收到语音条 |
| A9 | 画图文生图 | `draw` 经 socat 打到 Windows ComfyUI，出图并自动直发 |
| **A9b** | **画图 ref 改图**（B1 专项） | 带 `ref` 的 `draw` 成功出图（验证 `draw/tool.ts` 的图像归一化在容器内可用） |
| A10 | 视频 | `video` 抽帧成功（容器内 venv python + av + Pillow 生效） |
| A11 | 新闻 | `http://60s:4399` 可达；`npm run smoke:news` 通过 |
| A12 | 记忆 | `/记忆` 待审可读；批准落库；容器重建后仍在 |
| A13 | 数据持久 | `down && up -d` 后 DB、媒体、记忆、用量、**bili 频控状态、look-off 开关**均在 |
| A14 | 时区 | 容器 `date` 为 Asia/Shanghai；`localDay()` 与宿主一致；宵禁 00:00–08:00 判定正确 |
| A15 | 中文路径 | 人格书名、`referWav`、媒体中文名不乱码 |
| A16 | 安全不变量 | `comfy.ts` loopback 校验原样；**开发机** `npm test` 全绿 + `npm run prompts` 内嵌扫描干净（镜像无 `test/` 且 `--omit=dev`，容器内跑不了） |
| A17 | 宿主机退役 | 无 QQ/NapCat 进程；`~/napcat-restore/` 备份仍在 |
| A18 | restart 工具 | 私聊 `restart` 后容器自动重启恢复，**不产生第二条鱼** |
| **A19** | **旧入口护栏** | 容器在跑时，宿主机 `npm run deploy` / `npm run up` **明确拒绝**，不起第二条鱼 |
| **A20** | **配置写回** | 私聊 `config set` 改一个受控字段 → 宿主机对应文件真的变了；OAuth 刷新后 `auth.json` 真的更新（验证目录挂载解了 rename） |

## 8. 验证命令

```bash
# 构建与起栈（macmini）
docker compose build && docker compose up -d
docker compose ps
docker compose logs -f fish

# 既有检查（开发机跑，不新增测试）
npm test
npm run prompts
npm run smoke:news

# 容器内体检（slim 无 nc，用 node 探测）
docker compose exec fish npm run doctor
docker compose exec fish date
docker compose exec fish pgrep -f src/index.ts
docker compose exec fish node docker/healthcheck.mjs

# 协议端只读探测（不发消息）
node ~/napcat-restore/ob-probe.mjs

# DB 完整性与 WAL
docker compose exec fish node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/fish.db');console.log(d.prepare('PRAGMA integrity_check').all())"
ls -l ~/yugang/var/fish.db-wal   # 迁移前须为 0 字节

# 图像后端（B1）
docker compose exec fish node -e "import('./src/media/image-ops.ts').then(m=>console.log(Object.keys(m)))"
```

## 9. 风险与对策

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | Linux QQ 登录态无法从 macOS 迁移 | 预期内。S5 暴露 WebUI 6099 到 `127.0.0.1`，扫一次码，登录态落持久卷 |
| ~~R2~~ | ~~官方镜像版本组合未知~~ | **已消除**：实测 NapCat 4.18.42 + Linux QQ 3.2.34-53644，packet 表含 `3.2.34-53644-arm64` 偏移与 `MoeHoo.linux.arm64.node`（§10.2）。A6/A6b/A6c 仍作硬验收 |
| R3 | 上游 NapCatQQ 已删库，镜像可能停更 | 钉 digest；保留 `~/napcat-restore/` macOS 工作现场作回滚 |
| R4 | SQLite 在 VirtioFS 上锁语义异常 | DB 放 named volume；迁移前后各 `integrity_check` |
| R5 | 容器内 restart 再开一条鱼 → id 撞号 | 改 `process.exit(0)` + 重启策略；A18 专项 |
| R6 | 时区/编码默认值 | 显式 `TZ` / `LANG`；A14/A15 专项 |
| R7 | 迁移期双实例 | S4 先停宿主机并 pgrep 断言 0；全程只允许一条鱼 |
| R8 | OAuth 刷新写回失败 | **挂目录**（非单文件）；A20 专项 |
| R9 | 镜像 Node 版本与生产不一致 | S1 验证标签后钉 digest |
| ~~R10~~ | ~~宿主 loopback 不可达~~ | **已消除**：2026-11-14 功能级实测六个服务全通（§3.1），零监听面改动 |
| **R11** | **`sharp` 新增原生依赖** | linux/arm64 有 prebuilt；macOS 后端仍走 sips，生产路径零变化。需主人确认（开放项 1） |
| **R12** | **入站图 `file://` 回退跨容器失效**（`onebot.ts:671-680`：无 `url` 时读本地文件，那是 napcat 容器内路径） | S5 实测生产 NapCat 是否恒给 `url`；若会给 `file://`，加共享只读挂载 |
| **R13** | **OAuth 重新登录通道**（回调 `http://localhost:51121/oauth-callback`） | 容器内登录需发布 51121 或用 `npm run login -- … --finish '<授权码>'`；写进 runbook |
| **R14** | **token 两端一致**（`scripts/token.ts:32-34` 在 darwin 写 macOS QQ 容器内的 onebot.json） | 容器形态下手工保证 `.env ONEBOT_TOKEN` 与 napcat 容器配置一致；写进 runbook |

## 10. 回滚

宿主机现场完整保留：

1. `docker compose down`
2. `bash ~/napcat-restore/restore-working.sh`（App Store QQ 7.0.2-53644 + NapCat 4.18.41 + 892B v1.7 加载器）
3. `bash ~/napcat-restore/clear-quarantine.sh`
4. `bash ~/napcat-restore/fish-restart-logged.sh`

数据回滚：迁移是**拷贝**不是移动，宿主机 `~/yugang/var/` 原样保留。容器期间新增数据需反向 `docker cp`（含 WAL 处理），真正决定回滚时再做。

**代码回滚**：`image-ops` 的 darwin 后端保留原 sips 参数，宿主机形态行为不变；`paths.ts` 新增覆盖不设值时行为不变。故代码改动对回滚路径无害。

## 10.1 镜像获取（S1 实测补充）

- **Docker Hub 从 macmini 直连不通**，但 **OrbStack 已配 `network_proxy: http://127.0.0.1:7897`**，daemon 侧拉取走代理
- `~/.orbstack/config/docker.json` 已配 registry-mirrors：`docker.1ms.run` / `docker.m.daocloud.io` / `dockerproxy.net`
- **坑：`docker manifest inspect` 是客户端侧操作**，在 Mac 上直连 `registry-1.docker.io`，**既不走 daemon 的 registry-mirrors 也不走 network_proxy** → 必然超时。**可行性验证要用 `docker pull`（daemon 侧），不能用 manifest inspect**
- 拉取一律显式 `--platform linux/arm64`

## 10.2 S1 准入实验结果（2026-11-14 全部通过）

| 项 | 结果 |
|---|---|
| 架构 | 宿主 `arm64` / docker `aarch64/linux` / 容器 `aarch64`——**全程原生，不走 Rosetta** |
| 宿主 loopback 可达 | 六服务功能级全通（§3.1），**零监听面改动** |
| `node:26-slim` | linux/arm64，digest `sha256:e6bedef21767…`，镜像内 node **v26.13.1**（生产 v26.0.0，同 major） |
| `mlikiowa/napcat-docker:latest` | linux/arm64，digest `sha256:696e9574a0f6…` |
| napcat 启动 | 隔离容器（临时目录、不发布端口、无凭据）稳定 Up 45s，**NapCat.Core 4.18.42**，二维码正常生成 |
| 镜像内 QQ | **`3.2.34-53644`**（Linux 版号段，build 与 macOS 工作版同为 53644） |
| **packet 表覆盖** | `"3.2.34-53644-arm64": { send:"4AABA5C", recv:"182C534" }`；`"3.2.34-53644": { appid:537391664, qua:"V1_LNX_NQ_3.2.34_53644_GW_B" }`；`native/packet/MoeHoo.linux.arm64.node` 1286824B |

镜像布局注意：`/app/napcat` 是 **entrypoint 运行时从 `/app/NapCat.Shell.zip` 解出来的**，直接 `--entrypoint sh` 进去看不到 `napcat.mjs`；查文件要 `unzip -p /app/NapCat.Shell.zip napcat.mjs`。

复现脚本：`~/napcat-restore/probe-napcat-boot.sh`。

## 11. 待主人决定

1. ~~是否同意新增 `sharp` 依赖~~ → **主人 2026-11-14 已裁定：用 sharp**
2. **镜像标签策略**：钉 digest（建议）还是跟具体版本标签
3. **60s 是否收进 compose**：建议收（会重建现有容器，短暂新闻不可用）
4. **宿主机 QQ.app 是否删除**：建议先只停不删，观察一周
5. **`/tmp/yugang` 草稿区是否持久化**：容器内是临时层，重建即丢。可挂 volume，不影响安全边界
6. **是否授权新增容器相关测试**：本计划默认不新增

## 12. 执行记录

- 2026-11-14 主人裁定：图像库用 **sharp**；执行方式 **主会话串行**
- 2026-11-14 S1 部分完成：架构确认 arm64 原生；宿主 loopback 可达性功能级全通（B3/R10 消除）；镜像拉取进行中
- 执行顺序微调：S1 准入实验提到 S0 之前——若可行性不成立，S0 的宿主机 launchd 改动就白做
- 2026-11-14 **S1 全部通过**（§10.2）：B3/R10 与 R2 两条风险消除，方案可行性确认
- 2026-11-14 S2 进行中：新增 `src/media/image-ops.ts`（同步门面 + 平台分派 + 共用规格常量 + 失败告警）与 `src/media/image-worker.ts`（sharp 后端）；4 处 sips 调用点已接线（shrink-image / look / draw / onebot），macOS 路径逐字未动
- **sharp 只有异步 API，而 4 处调用点全是同步契约**（现有测试注入同步 shrink 桩）。解法：Linux 侧用**一个 node+sharp worker 子进程干完整件事**，保住同步契约与现有测试。成本上比现状更省——现状本来就是逐档 spawn sips（最多 17 次）
- 2026-11-14 **worker 实测通过**（sharp 0.35.5 / libvips 8.18.7，HEIF 输入支持 true）。真实噪声图 3000×2000 / 6093174B：shrink → 600×400 JPEG **48323B**（≤50KB，阶梯真的下探）；look → 1280×853（长边精确）；init → **1216×800 PNG**（两边 16 对齐，972800 ≤ 像素预算 1011712）
- 2026-11-14 **S2 完成**，除 image-ops/worker 外还改了：
  - `src/paths.ts`：`FISH_CONFIG_PATH` 新增 `YUGANG_FISH_CONFIG` 覆盖（B2 必需）
  - `src/tools/restart/tool.ts`：容器模式不再 spawn 新鱼，直接退出由 restart 策略拉起（R5）
  - `scripts/up.ts`：容器模式跳过「拉协议端」与「TTS 跟随」
  - `scripts/deploy.ts`：**双向护栏**——容器内拒绝；宿主机侧检测到 `yugang-fish` 容器在跑也拒绝
  - `scripts/memory.ts`：pgrep 去掉硬编码 `yugang/` 前缀。改为要求 `src/index.ts` 是 **node 的脚本参数**（`node +(--[^ ]+ +)*[^ ]*src/index\.ts`）——第一版放得太宽误中类型检查进程（`node …/tsc --noEmit … src/index.ts`），导致 `test/memory-partial.test.ts:411` 失败；已用 grep -E 同口径验证 tsc 不算、三种真实鱼进程形态全命中
  - `scripts/down.ts` / `tts.ts` / `protocol.ts`：容器内明确拒绝并指向宿主机对应命令
  - `scripts/doctor.ts`：`.env` 检查改判「env 已注入」；跳过本地 napcat 包检查；**新增图像后端体检**（darwin 查 sips / 其它查 sharp）+ socat + ComfyUI loopback 连通
  - `scripts/migrate-memes.ts` / `retag-memes.ts`：索引路径改用 `MEDIA_ROOT`（容器里与 DATA_HOME 分开挂载）
  - `.env.example`：新增 `YUGANG_FISH_CONFIG` 与容器形态整节
- **`scripts/lib/deps.ts` 确认无需改动**：`ensureSixtyService` 开头先 `await health(baseUrl)`，可达就直接 return true；非 loopback 分支只在**不可达时**才走。reviewer 判断正确，该项从清单移除
- 2026-11-14 **护栏实测**：`YUGANG_CONTAINER=1` 下 down/tts/protocol/deploy 全部拒绝且退出码 1；宿主机模式不受影响；doctor 两种模式都正常不崩
- 2026-11-14 `npm test` **174/174 全绿**（image-ops 接线后）
- 2026-11-14 **S3 文件已写**：`Dockerfile`（node:26-slim 钉 digest `e6bedef21767…`，装 ffmpeg/socat/python3+venv(av,Pillow)/procps/tzdata，uid/gid 501，无构建步骤直跑 .ts）、`compose.yaml`（napcat 钉 digest `696e9574a0f6…` / fish / sixty，init:true，TZ+LANG，config 与 runtime-config **挂目录**，不写 extra_hosts）、`docker/entrypoint.sh`（socat 转发 → 等 WS → exec node）、`.dockerignore`
- `docker compose config` 解析通过；`sh -n docker/entrypoint.sh` 通过；healthcheck 正则 YAML 转义已验
- **构建在隔离目录 `~/yugang-build/` 进行**，不污染生产工作区（`deploy.ts` 见脏工作区会拒绝部署）。源码包严格排除凭据；打包时自查抓到漏网的 `config/auth.json.bak-*` 并收紧了排除模式
- 2026-11-14 `npm run prompts` 也通过：内嵌扫描干净、compaction 已禁用、全部 section 来自本项目扩展
- 2026-11-14 **S0 完成**（只读勘查后再动手，结果比预期好）：
  - **ComfyUI 隧道无需改动**：`com.yugang.comfyui-tunnel.plist` 本就是 `RunAtLoad=true` + `KeepAlive=true`，ssh 进程带 `ServerAliveInterval=30` / `ServerAliveCountMax=3` / `ExitOnForwardFailure=yes`，自启与自愈均具备
  - **TTS 补自启**：9 个 plist 全为 `RunAtLoad=false`（靠 up.ts/deploy.ts 拉）。已给**三个活跃实例**elysia4(9884) / kaltsit2coldB(9887) / sandrone2(9888) 改为 `RunAtLoad=true`；先 `cp` 备份为 `*.plist.bak-20261114`，**不 reload**（避免打断正在跑的实例，改后实测三个端口仍在监听）；6 个遗留 plist 未动。`KeepAlive={SuccessfulExit:false}` 崩溃自愈本来就有
  - **OrbStack 无需改动**：`orb config show` 的 `app.start_at_login: true`。注意 `launchctl list` 经 SSH 看不到它——SSH 会话不在 GUI 域
  - 完整自启链：重启 → 自动 GUI 登录（已实测 20s 恢复）→ OrbStack → docker daemon → `restart:unless-stopped` 容器 + TTS plist + 隧道 plist
- 2026-11-14 **镜像首次构建成功**（330s），容器内实测：node v26.13.1 / aarch64 Linux / uid 501:501 / TZ Asia-Shanghai CST 正确 / LANG C.UTF-8；ffmpeg ffprobe socat pgrep 全在；sharp 0.35.5；av 19.0.2 + Pillow 13.0.0；**worker 在容器内实跑通过**（shrink 600×400 48445B ≤50KB / look 1280×853 / init 1216×800 16 对齐）；挂载点属主全 501:501
- 2026-11-14 **发现并修复一个真实缺口：HEIC 解码**（B1 的另一半，差点漏过）：
  - `sharp.format.heif.input` 报 `{file:true,buffer:true,stream:true}`，**但 `fileSuffix` 只有 `[".avif"]`**——预编译包的 libheif 1.23.5 只带 AV1 解码器，**没有 libde265**
  - 用 macOS `sips` 造真 HEIC 样本（3265996B，sha256 三方一致排除传输截断），容器内解码报 **`bad seek to 3266028`**
  - **ffmpeg 也不行**：7.1.5 只解出网格首个瓦片 **512×512**，而不是拼好的 3000×2000（sips 把大图编成网格瓦片）
  - 两条可行路线均实测能正确拼出 **3000×2000**：apt 的 `heif-convert`（libheif-examples + libheif-plugin-libde265）/ python 的 `pillow-heif`。**选 apt 路线**：系统工具，与 ffmpeg/socat 同一模式，不引入 pip 依赖
  - 修法：Dockerfile 加装两个 apt 包；`image-worker.ts` 新增 `isHeif()`（**魔数判定 ftyp brand，不信扩展名**，AVIF 排除在外因为 sharp 自己能解）+ `prepareInput()`（HEIC 先转临时 **PNG 无损**再交 sharp，避免归一化阶段多一次有损编码），main 用 try/finally 清理临时文件
  - `doctor.ts` 同步新增 `heif-convert` 体检——这类「只丢 iPhone 原图、其它格式正常」的缺口只能靠体检发现
  - 魔数判定已验：真 HEIC 样本 brand=`heic` → true；JPEG → false。`npm test` 仍 174/174
  - **教训**：能力标志位（`input:true`）不等于实证。验收必须用**真实样本跑通链路**，不能查标志位就算过
- 2026-11-14 **HEIC 修复复验全通**：真 HEIC 走四个操作——jpeg → **3000×2000（整图非瓦片）**、shrink → 600×400 47543B、look → 1280×853、init → 1216×800 16 对齐；临时 PNG 无残留；普通 JPEG 未被误判
- 2026-11-14 主人要求**先本地测试**（本地有 docker）。本地 docker CLI 在但 daemon 未跑，已装 colima；以 `--cpu 4 --memory 6 --disk 40` 启动（docker 29.2.1 / arm64）
- 2026-11-14 **本地隔离测试栈**：项目名 `yugangtest`、独立容器名与端口（WebUI 16099）、假模型配置（指向 127.0.0.1:9 不可达，启动不发真请求）、假 QQ 号/token；扫描确认无任何真凭据
  - **坑 1**：colima 只挂 `~` 不挂 `/tmp`——测试栈放 `/tmp` 时 bind mount 内容为空且 EACCES。搬到 `~/yugang-localtest` 后正常。**本地环境差异，非设计缺陷**（OrbStack 全文件系统可见）
  - **坑 2**：colima 的 registry mirror `docker.m.daocloud.io` 对 `vikiboss/60s` 返回 403；用显式前缀 `dockerproxy.net/vikiboss/60s` 拉取后打标签解决（digest 与 macmini 那份一致）
  - **坑 3**：napcat 未登录就没有 onebot 配置、不开 WS 3001。为验管路加了**最小假 OneBot WS 服务**（`fakeob.mjs`，手写握手 + lifecycle connect 帧）——鱼是从入站帧的 `self_id` 学自己 QQ 号，不调 get_login_info
- 2026-11-14 **本地编排验证通过**（镜像内容之外的部分）：
  - 四服务 running；DNS 正常；`sixty:4399` `/health` **HTTP 200 ok**
  - **B2 得到实证**：`/app/config`、`/app/runtime-config`、`/data` 的 `writeFileSync(tmp)`+`renameSync` **全部成功**；`fish.config.json` 原子写回成功且内容未变
  - 四个挂载点以 uid 501 实际可写；**socat 端到端打通**（容器 `127.0.0.1:18190` → 宿主假 ComfyUI 返回 `FAKE-COMFY-OK`）
  - 时区与宿主**逐秒一致**；doctor 容器模式全绿（ffmpeg/python/sharp/socat/heif-convert/ComfyUI）
  - entrypoint 完整走通：等 WS → 协议端就绪 → 启动鱼缸 → node 接棒
  - **colima 也提供 `host.docker.internal`**（192.168.5.2），与 OrbStack 行为一致
- 2026-11-14 **主人裁定改变部署形态**：「鱼是快速迭代项目，每次部署都构建新镜像有些慢，可以仅用 docker 提供隔离环境，然后在容器里面快速部署」→ 已改为 **源码 bind mount + node_modules named volume**（见 §3.3）；Dockerfile 不再 `COPY . .`，entrypoint 新增 lockfile 指纹对齐，compose 去掉配置单文件挂载
- 2026-11-14 **主人质疑性能论据**：「确定不会影响 agent 和 tool call 的性能吗」——指出平均速率掩盖单次延迟。承认论据错误，重测**单次操作延迟分布**（§6.3）：读完全无差（页缓存），写绝对差 10 微秒，一轮 agent 的 DB 开销 0.24ms vs 模型调用秒级
- 2026-11-14 **主人裁定：「那就直接都外挂吧」**——零 named volume。依赖也外挂到宿主 `.node_modules-linux/`（与 macOS 那份分开，已 gitignore）；Dockerfile 去掉 `COPY package*.json` 与构建时 `npm ci`，**镜像退化为纯环境**
- 待办：最终形态本地复验（git pull + restart 秒级部署 / lockfile 变更自动装依赖 / 鱼完整启动）→ S4–S10。**commit 需主人授权**