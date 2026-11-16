# 回退 native QQ + NapCat（鱼留 docker）实施计划

日期：2026-11-16（第 2 版，已按独立 reviewer 意见修订）
状态：待主人裁定 §2 决策点 + 选择执行方式
触发：Linux QQ（容器 NapCat）风控严重，2026-11-16 一天两次掉登录态（ErrCode 3 / ErrCode 1），
反复扫码不可持续。主人裁定回退 mac native QQ + NapCat（此前配置且验证工作过），**鱼仍留 docker**。

> 第 1 版被 reviewer 判定 5 处阻塞级问题，本版全部纳入：
> B1 运行期 WS 断线无重连（鱼失聪）；B2 硬锁路径假设错误 + 无锁后运行时复验；
> B3 restore 先启动后清 quarantine 顺序错误；B4 回滚缺 LaunchAgent 卸载（KeepAlive 复活）；
> B5 回滚 git checkout 前提不成立（compose 改动会提交）。另纳入全部建议级意见。

## 1. 目标与非目标

### 目标（整体交付终态）
1. macmini 宿主跑 **native QQ 7.0.2-53644 + NapCat 4.18.41**（注入形态），登录态稳定
2. **fish + sixty 仍在 docker**，fish 经 `ws://host.docker.internal:3001` 连宿主 native NapCat
3. 容器 napcat 退役（compose 移除），不再与 native QQ 同账号互挤
4. **版本锁死**：App Store 自动更新关 + 版本决定物 `chflags -R uchg` 硬锁（范围见 S5），杜绝 build 漂移
5. **整机重启自愈**：重启后 fish 自动接上（登录态存活前提）；**运行期 native QQ 重启后需人工 `docker compose restart fish`**（方案 c，写进 ops skill）
6. 鱼群收发文字/图片/表情包/记忆正常，安全不变量一条不放宽
7. 运维口径与文档同步（AGENTS.md / ops skill / .env.example）

### 非目标
- 鱼容器化回退（fish/sixty 容器形态不动）
- 语音/ComfyUI（已在宿主，不动）
- 新增测试（未经授权不新增；§2 若选代码改动则跑既有 npm test 验证）
- 删除 native QQ 快照（保留回滚现场）

## 2. 决策点（主人 2026-11-16 裁定：方案 c 接受人工 restart）：运行期 WS 断线

**reviewer 阻塞 B1（已核实代码）**：`src/qq/onebot.ts:190-194` 的 `close` 事件只 reject pending、
清表，**无重连、无退出**；`src/app/runtime.ts:2490-2501` `connectOnebot()` 只在**启动**连不上时
`process.exit(1)`。全仓无 reconnect。后果：fish 运行中 native QQ/NapCat 一旦重启（崩溃、S7 KeepAlive
拉起、GUI 注销、风控重登），WS 断开后 **fish 进程不死、永久失聪**，`restart: unless-stopped` 不触发
（进程没退），fish healthcheck（只 pgrep）恒绿。**S7 的「QQ 自愈」反而制造「鱼失聪」**，目标 5 不成立。
此缺口容器形态也存在，但容器 napcat 稳定；回退 native 后 QQ 重启频率升高，缺口被放大。

三选一（**与第 1 版「src/ 零改动」声明冲突，故须主人裁定**）：

| 方案 | 做法 | 代价 | 推荐 |
|---|---|---|---|
| **a 最小代码改动** | OneBot `close`（非主动关闭）→ `process.exit(1)`，交容器 restart 策略 + entrypoint「等协议端」逻辑端到端自愈。加 `#closing` 标志区分优雅退出（优雅 close 不 exit）。约 10 行 | 属 src/ 改动，需跑既有 `npm test` 验证；与现有「启动失败 exit」设计一致 | **★ 推荐** |
| b 宿主看门狗 | launchd 监测 3001 断开/QQ 重启 → `docker compose restart fish` | 不改 src/，但多一个宿主 daemon；每次重拉鱼容器 drain outbox 较重；监测逻辑本身要维护 | 备选 |
| c 接受人工 restart | QQ 重启后人工 `docker compose restart fish`，写进 ops skill | 零改动，但与目标 5 矛盾，运维负担 | 不推荐 |

**主人裁定方案 c**：零 src/ 改动。运行期 native QQ 重启后 fish 会失聪，需人工
`docker compose restart fish` 恢复——此处置写进 ops skill（「鱼不说话先探 3001；QQ 重启后 restart fish」）。
整机重启自愈（A2）仍成立（fish 容器也重启）；运行期自愈（A11）改为验证人工 restart 流程。
S7 KeepAlive 仍保 QQ 崩溃自拉，但鱼不会自动重连，须人工 restart fish。「src/ 零改动」声明保留。

## 3. 目标架构

```
macmini (macOS, arm64, uid 501)
├── 宿主 native（本次恢复）
│   ├── QQ.app 7.0.2-53644（App Store 版，_MASReceipt 在）        ← chflags -R uchg 硬锁
│   ├── NapCat 4.18.41 代码（…/Data/Documents/napcat）            ← 锁只读代码，排除运行期可写子目录（S5 勘察）
│   ├── 892B loadNapCat.js（…/Data/Documents/loadNapCat.js）      ← 硬锁
│   ├── NapCat 配置（…/Data/Library/Application Support/QQ/NapCat/config/onebot11_<uin>.json）← **不锁**（运行期可写）
│   │     WS server：127.0.0.1:3001，token=.env ONEBOT_TOKEN
│   ├── NapCat WebUI：127.0.0.1:6099
│   └── LaunchAgent com.yugang.qq-native（gui/501 域，RunAtLoad，KeepAlive={SuccessfulExit=false}）
├── OrbStack docker（保留）
│   ├── fish   ONEBOT_WS_URL=ws://host.docker.internal:3001
│   └── sixty  不变
└── 宿主依赖（不变）：TTS 已下线 / ComfyUI 隧道 :18190 / 代理 :7897
```

**关键路径事实（reviewer B2 核实，`scripts/lib/onebot-config.ts:26-40` 实测）**：
NapCat 4.18.41 在 darwin 的真实配置目录是
`~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config/`
（per-uin `napcat_<uin>.json` / `onebot11_<uin>.json`），**不是 Documents/napcat/config**。
`npm run token`（宿主跑）在 darwin 恰好写这个目录——回退后该工具链重新可用，token 轮换不受硬锁影响。

**接线**：OrbStack `host.docker.internal` 直达宿主 loopback（dockerize §3.1 功能级实测同类成立），
native NapCat 监听 `127.0.0.1:3001` 即可被 fish 容器经 `host.docker.internal:3001` 访问，
**不放宽监听面到 0.0.0.0**，不写 extra_hosts。

## 4. 已验证事实（勘察 + 代码核实，无占位）

| 项 | 结论 |
|---|---|
| 工作版快照 | `~/napcat-restore/QQ.app.mas-7.0.2-53644-working`（7.0.2/53644，收据在）+ `napcat-working`（4.18.41）+ `working-loadNapCat.js`（892B）齐全 |
| 恢复脚本 | `restore-working.sh`（停 QQ→留档→ditto QQ→ditto NapCat→cp 加载器→launchctl asuser 启动）+ `clear-quarantine.sh`（递归清 quarantine）完整 |
| 上次恢复 | `qq-restored.log` 证明 2026-11-14 晚 native QQ 正常收发（或然证据，非本次顺序成立的证明） |
| App Store 自动更新 | 已禁（`com.apple.commerce AutoUpdate=0`、`AutoUpdateRestartRequired=0`） |
| 硬锁手段 | `chflags -R uchg` 实测：改名/删除/内容改写全拒；`nouchg` 解锁可改 |
| NapCat 自更新 | napcat-working 无 update/autoUpdate/checkUpdate 机制，纯静态 |
| 宿主 loopback 可达 | dockerize §3.1 功能级实测 host.docker.internal 直达宿主 127.0.0.1（与具体服务无关） |
| **WS 无重连** | `onebot.ts:190-194` close 只 reject pending；`runtime.ts:2490` 仅启动失败 exit（B1） |
| **NapCat 配置路径** | darwin = Application Support/QQ/NapCat/config（onebot-config.ts:26-40），非 Documents/napcat（B2） |
| .env | ONEBOT_TOKEN（有值不打印）/ PROTOCOL_QQ=3768557204 / MASTER_QQ=2928390812；ONEBOT_WS_URL 不在 .env |
| compose 现状 | fish ONEBOT_WS_URL=ws://napcat:3001 + depends_on [napcat,sixty]；napcat 钉 digest，6099 发布宿主 |
| native 自启 | 无 QQ/NapCat LaunchAgent（需新建） |
| 版本敏感 | build 53644 在 packet 表内、54395 不在（表外图片链路断）；NapCat 4.18.41 工作、4.18.42 被 AMFI 杀 |
| Gatekeeper | 改别 app bundle 需 kTCCServiceSystemPolicyAppBundles，SSH 侧无法获得须 GUI 授权；拒绝按 (path,team,id) 面包屑记账（拒一次永久拒） |
| launchctl 域 | SSH 会话不在 GUI 域，`launchctl load` 不进 Aqua；须 `bootstrap gui/501`（dockerize S0 实测） |

## 5. 依赖顺序（每步验证门，不过就停）

```
S0 前置探测 + 备份（停任何东西之前！把 R1 风险提前暴露）
   cp compose.yaml / .env → ~/napcat-restore/{compose.yaml,.env}.pre-native-revert
   cp -R Application Support/QQ/NapCat/config → ~/napcat-restore/napcat-config.pre-native-revert
   SSH 侧 App 管理权限无损探测：ditto 快照到 /tmp 临时目录验 quarantine 行为 /
     对 /Applications 做可回滚写测试，确认 TCC 现状
   门：探测通过；受阻→先请主人 GUI 授权（runbook 见 R1），再进 S1
   确认 App Store AutoUpdate=0（已做）
   ↓
S1 停容器协议端 + 鱼（必须前置：同账号互挤 + 避免失聪窗口）
   docker update --restart=no yugang-napcat   # 防窗口期全栈 up 拉活
   docker compose stop napcat
   docker compose stop fish                   # 优雅 SIGTERM drain outbox
   门：napcat/fish 非 Up；宿主 nc -z 127.0.0.1 6099 释放
   注：stop 的容器 unless-stopped 不会自动拉起（daemon/整机重启也保持 stopped）
   ↓
S2 恢复 native QQ + NapCat（先清 quarantine 后启动！B3）
   bash restore-working.sh 的步骤 1-5（停 QQ→留档→ditto QQ→ditto NapCat→cp 加载器）
   bash clear-quarantine.sh                   # 必须在启动前（ditto 带回 347 quarantine）
   启动 QQ（restore 步骤 6 的 launchctl asuser，或 GUI）
   门：QQ.app 7.0.2/53644；Documents/napcat package.json 4.18.41；加载器 892B；pgrep -x QQ 在
   ⚠ 首启失败禁止盲目重试（面包屑记账）：先查 quarantine 是否清零 / 查拒绝面包屑，
     必要时主人 GUI 授权。restore-working.sh 第 6 步原在清 quarantine 前——本步骤拆开重排。
   ↓
S3 扫码登录 native QQ
   WebUI http://127.0.0.1:6099 或 QQ 界面扫码（主人手机 QQ）
   门：NapCat 日志登录成功（get_login_info 需 WS+token，留到 S4 门）
   核对 napcat_<uin>.json packet 后端与 build 53644 匹配（表外症状=图片链路静默断）
   ↓
S4 配 native NapCat onebot11 WS server（正确路径！B2）
   写 Application Support/QQ/NapCat/config/onebot11_<uin>.json：
     network type=wsServer, host=127.0.0.1, port=3001, token=.env ONEBOT_TOKEN（不打印）
     （或宿主 npm run token 写 token + WebUI 配 WS server）
   门：宿主 nc -z 127.0.0.1 3001 通；get_login_info user_id=3768557204；
       **容器内带 token WS 握手探测 host.docker.internal:3001 通**（R5 提前暴露）
   ↓
S5 版本硬锁（收窄范围 + 锁后运行时复验！B2）
   先勘察 Documents/napcat 运行期可写子目录（logs/cache/插件产物），排除在 -R 之外
   chflags -R uchg /Applications/QQ.app
   chflags -R uchg Documents/napcat 的只读代码（napcat.mjs/package.json/native/ 等，排除可写子目录）
   chflags uchg Documents/loadNapCat.js
   （Application Support/QQ/NapCat/config 不锁——运行期可写）
   门：ls -lO 见 uchg；touch bundle 内文件被拒；
       **锁后完整重启 QQ+NapCat（pkill→重拉→登录态自动接上→3001 通→群收发一条）通过**
   ↓
S6 改 compose + 起 fish
   compose.yaml：移除 napcat service；fish depends_on 去 napcat；
     fish ONEBOT_WS_URL → ws://host.docker.internal:3001
   docker compose up -d fish sixty
   门：fish「已连接」+ 三群自由活动启动；get_status online:true,good:true
   ↓
S7 native 开机自启（gui 域 + 弱 KeepAlive！B4 联动）
   新建 ~/Library/LaunchAgents/com.yugang.qq-native.plist：
     Label com.yugang.qq-native；ProgramArguments 绝对路径
       [/Applications/QQ.app/Contents/MacOS/QQ, --no-sandbox, -q, 3768557204]
     RunAtLoad=true；KeepAlive={SuccessfulExit=false}（故意 pkill 不复活，崩溃才拉）
   launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.yugang.qq-native.plist
   门：launchctl print gui/501/com.yugang.qq-native 存在（SSH 的 load 不进 GUI 域，不用 load）
   ↓
S8 逐条验收（§8，含 A11 人工 restart 处置演练）
   ↓
S9 文档同步
   AGENTS.md 容器节：QQ/NapCat native 宿主、fish/sixty docker、版本锁死、token 轮换走 npm run token
   ops skill：协议端排查口径（qq-restored.log / WebUI 6099 / pgrep QQ）；
     entrypoint「查 docker compose logs napcat」提示已退役→实际查 native；
     healthcheck 盲区（鱼不说话先探 3001）；**QQ 重启后需 docker compose restart fish**（方案 c）
   .env.example：ONEBOT_WS_URL 说明同步（AGENTS §9）
```

顺序约束：S0 探测在停任何东西前；S1 先停双端；S2 先清后启；S4 配好 WS 才 S6；S5 在 S4 后（配置目录虽不锁，但锁后复验需 WS 已就绪）；S7 弱 KeepAlive 保回滚可 pkill。

## 6. 文件职责

### 修改
| 文件 | 改什么 | 为什么 |
|---|---|---|
| `compose.yaml` | 移除 napcat service；fish depends_on 去 napcat；fish ONEBOT_WS_URL=ws://host.docker.internal:3001 | 协议端改宿主 native |
| `AGENTS.md` | 容器节注明 QQ/NapCat native + 版本锁死 + token 轮换 npm run token + QQ 重启后人工 restart fish | 与实况一致 |
| `.agents/skills/ops/SKILL.md` | 协议端排查口径 native；entrypoint 误导文案；healthcheck 盲区 | 运维不误判 |
| `.env.example` | ONEBOT_WS_URL 容器取值说明同步 | AGENTS §9 |

### 新增（宿主侧）
| 文件 | 职责 |
|---|---|
| `~/napcat-restore/harden-versions.sh` | S5 一键硬锁（收窄范围 + 排除可写子目录），含解锁说明 |
| `~/Library/LaunchAgents/com.yugang.qq-native.plist` | S7 native QQ 自启（gui 域 RunAtLoad + KeepAlive SuccessfulExit=false） |
| `~/napcat-restore/qq-version-watch.sh`（可选第 4 层） | 查 QQ build ≠53644 告警/自动恢复 |

### 明确不改
- fish/sixty 容器形态、**src/ 全部零改动**（方案 c）、安全不变量（comfy loopback 等）
- native QQ 快照（保留回滚）

## 7. 风险与对策

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | SSH 侧 Gatekeeper/TCC 拒改启 QQ.app | S0 无损前置探测（停协议端前暴露）；受阻主人 GUI 授权（runbook：GUI Terminal 跑 restore+clear-quarantine）；不自动接受新指纹；首启失败不重试 |
| R2 | 同账号互挤 | S1 先停容器 napcat+fish 并断言；docker update --restart=no 防窗口拉活 |
| R3 | native QQ 无开机自启 | S7 LaunchAgent gui 域 bootstrap；需 GUI 登录（与 OrbStack 同条件，dockerize S0 实测自动登录） |
| R4 | fish reach 不到宿主 3001 | host.docker.internal 直达 loopback 已实测；S4 容器内带 token 握手门 |
| R5 | token 不一致 | S4 用 .env token 写 Application Support 配置；S4 握手门提前暴露 |
| R6 | 版本漂移 | App Store 已关 + chflags 硬锁（版本决定物）+ 可选看门狗 |
| R7 | 硬锁后 NapCat 运行异常 | S5 先勘察可写子目录排除；锁后完整重启复验门（收发一条） |
| R8 | 硬锁后无法手动升级 | 文档注明 chflags -R nouchg 三对象解锁流程 |
| R9 | native 仍风控掉线 | native 是此前稳定形态；掉线后重启需人扫码（A2 前提=登录态存活）；仍掉则回滚或查账号风控 |
| R10 | 鱼双实例 | fish 单容器；§2 选 a 的 exit→restart 不产生第二实例（restart 策略串行） |
| R11 | 运行期 QQ 重启鱼失聪 | 方案 c：人工 docker compose restart fish；ops skill 写明处置；A11 演练人工流程 |

## 8. 验收标准

| 编号 | 项 | 判据 |
|---|---|---|
| A1 | native 协议端常驻 | pgrep -x QQ；NapCat 4.18.41；get_login_info user_id=3768557204 |
| A2 | 整机重启自愈 | 重启 macmini（GUI 登录、**登录态存活**）后 native QQ 自启 + fish 自启 + 「已连接」，无人工干预 |
| A3 | 鱼唯一实例 | 容器 pgrep src/index.ts=1；宿主无鱼进程 |
| A4 | 群收发 | 白名单群 @ 鱼收到回复 |
| A5 | 图片入站+模型可见 | 发图 @ 鱼，inbound 落盘且鱼描述图内容（验表内 build 图片链路） |
| A6 | 表情包/记忆 | meme 命中发出；/记忆 待审可读、批准落库 |
| A7 | 版本锁死 | ls -lO QQ.app 见 uchg；AutoUpdate=0；touch bundle 内文件被拒 |
| A8 | 容器 napcat 退役 | compose ps 无 napcat；compose.yaml 无 napcat service |
| A9 | 数据持久 | fish.db/记忆/媒体原地（var/ 挂载不变） |
| A10 | 安全不变量 | comfy loopback 原样；src/ 零改动，开发机 npm test 全绿 |
| **A11** | **运行期人工 restart 处置**（方案 c） | 运行期 pkill QQ→KeepAlive 拉起→人工 docker compose restart fish→鱼恢复收发（验证人工流程有效） |

## 9. 验证命令

```bash
pgrep -x QQ
/usr/bin/plutil -p /Applications/QQ.app/Contents/Info.plist | grep CFBundleVersion   # 53644
nc -z 127.0.0.1 3001 && echo WS在
node ~/napcat-restore/ob-probe.mjs                       # get_login_info/get_status/群列表
ls -lO /Applications/QQ.app | head -1                    # uchg
defaults read com.apple.commerce AutoUpdate              # 0
launchctl print gui/501/com.yugang.qq-native | head -3   # 自启在 GUI 域
docker compose exec fish sh -c 'python3 -c "import socket;socket.create_connection((\"host.docker.internal\",3001),5);print(\"OK\")"'
docker compose logs --tail 20 fish | grep 已连接
docker compose exec fish pgrep -f src/index.ts | wc -l   # 1
# A11 演练：pkill -x QQ → 观察 KeepAlive 拉起 + fish 自动恢复
```

## 10. 回滚（B4/B5 修复）

```bash
# 1 先卸 LaunchAgent（否则 pkill 被 KeepAlive 复活，与容器 napcat 互挤）
launchctl bootout gui/501/com.yugang.qq-native
mv ~/Library/LaunchAgents/com.yugang.qq-native.plist ~/napcat-restore/   # 防下次登录再加载
pkill -x QQ
# 2 解锁三对象（下次 restore ditto 覆盖需要）
chflags -R nouchg /Applications/QQ.app
chflags -R nouchg ~/Library/Containers/com.tencent.qq/Data/Documents/napcat
chflags nouchg ~/Library/Containers/com.tencent.qq/Data/Documents/loadNapCat.js
# 3 恢复 compose（用 S0 备份，不用 git checkout——compose 改动会提交，B5）
cp ~/napcat-restore/compose.yaml.pre-native-revert ~/yugang/compose.yaml
# 4 起容器协议端 + 鱼
cd ~/yugang && docker compose up -d napcat fish sixty
# 5 文档口径还原（AGENTS/ops skill/.env.example）
```

数据原地（var/、data/napcat/qq bind mount 全程未动），零拷贝。
**预期可能重扫码**：native QQ 在线期间容器 Linux QQ 服务端会话可能已被顶掉/过期，
回滚后容器 napcat 大概率需重新扫码（不许诺无缝）。