# 2026-11-13 通道适配器执行记录（T1–T6）

基线：`60ac2b4`（main）。分支：`feat/dingding`。本机：slave1（macOS arm64，Node v22.23.2）。

## T1 契约与注册表（commit：feat(channels): 增加通道适配器契约与注册表）

- 新增 `src/channels/types.ts`（ChannelAdapter/ChannelMessage/ChannelRenderer 契约，renderer
  签名对齐现有纯函数；gifIngest 已退役不进契约）、`src/channels/render.ts`（先转发
  `../qq/model-input.ts`）、`src/channels/registry.ts`（parseChannels + createChannelRegistry）。
- `npm test`：**174 pass / 0 fail**（新文件未被引用，行为零变化）。
- registry 自检（node -e import）：unset→`["qq"]`；none→`[]`；`qq,dingtalk` 保序；`foo` 抛
  「未知通道 foo；可用：qq, dingtalk」。

## T2 迁移（commit 65e0fa7：refactor(channels): 迁移 QQ 输入转换模块到 channels/qq）

- `git mv src/qq/{onebot,model-input,round-input,round-images}.ts src/channels/qq/`；
  model-input 内容上收为通道无关的 `src/channels/render.ts`（qq/model-input.ts 留门面）；
  debounce.ts 的 `withContext`/`backgroundFor`/`anchorIndex`/`burstMatcher` 及
  ContextOptions/SeenMessage/RoundContext 移入 `channels/qq/round-input.ts`（debounce 只剩
  攒批状态机 + lastPayload + isLaterArrival）。
- 全量 import 改写：src/、scripts/、test/ 共 21 个文件；compact.ts 与 news-broadcast.ts 直连
  `channels/render.ts`。
- `npm test`：**174 pass / 0 fail**；`npm run prompts`：**28 个工具包条目**（不变）；
  `rg 'src/qq/(onebot|model-input|round-input|round-images)'` 零命中。

## T3 QQ adapter + runtime 接线（commit 1a0785c：feat(channels): 接入 QQ 适配器与 CHANNELS 通道开关）

- 新增 `src/channels/qq/adapter.ts`（包装 onebot/gate 单例成 ChannelAdapter；QQ 出站仍由
  宿主 emit 直驱 OneBot——配速/末条自言/幂等都在那一层，adapter.send 留契约占位不双写）、
  `src/channels/qq/normalize.ts`（卡片渲染 + bypass 剥离，从 normalizeInbound 抽出）。
- runtime：`channelIds = parseChannels(process.env.CHANNELS)` + registry 构造；listenMessages/
  connectOnebot/startEngage/startNews 按 `channels.has("qq")` 守卫；横幅加通道行。
- 边界（与计划 §2 F2 括注一致）：runtime 经白名单（adapter/normalize/round-input/onebot/
  render 系）引用 channels/qq，QQ 单例路径未动——钉钉接入时再收敛为全路由。
- 验收：
  - `CHANNELS=none YUGANG_HOME=/tmp/yg-smoke node src/index.ts` → 起到横幅，
    「通道 qq 未启用…跳过 OneBot 连接」「通道 qq：未启用 · dingtalk：未启用」，无 ws 连接。
  - `CHANNELS=foo` → 启动即抛「未知通道 foo；可用：qq, dingtalk」。
  - 未设 CHANNELS → 照旧「连不上 ws://127.0.0.1:3001」退出（macmini 行为不变）。
- `npm test`：**174 pass / 0 fail**（修了一处内嵌文案扫描：registry 报错/日志改短于阈值）。

## T4 文档与边界固化（commit c61318f：docs(channels): 记录通道适配器边界与 CHANNELS 开关）

- AGENTS.md 新增「通道适配器（2026-11-13）」一节；`.env.example` 增加 CHANNELS 说明。
- `node scripts/verify-channels.ts`：**16 项全 PASS**（F2 迁移边界 + F3 开关判定）。

## T5 本地验收与配置

- F1：`npm test` 174/0；`npm run prompts` 28 条。
- F2/F3：`node scripts/verify-channels.ts` 全 PASS。
- 配置就位：`.env`（`CHANNELS=none`，QQ 侧键留空）、`fish.config.json`（自 example，结构里
  本就无 news.targetGroup/weeklyGroupId/voices/engage.freeGroups 键）、`config/models.json`
  （example 复制）、`config/auth.json`（**占位假 key**）。`.env`/`auth.json` 已 chmod 600。
- **待办（阻塞 F4）**：模型凭据未提供——`config/auth.json` 目前是 dummy，`npm run ping` /
  `scripts/ping.ts` 无法验证真实模型连通。凭据到位后替换 auth.json 并补跑 F4。

## T6 launchd 常驻

- plist：`~/Library/LaunchAgents/com.yugang.fish.plist`（node --env-file-if-exists=.env
  src/index.ts；WorkingDirectory=/Users/slave/yugang；RunAtLoad/KeepAlive/ThrottleInterval=10；
  日志 var/log/fish.{out,err}.log；PATH 含 /opt/homebrew/bin）。
- `launchctl bootstrap` + `kickstart -k` 启动；横幅正常、`var/fish.db` 自建、日志无
  「连不上 ws://」；60 秒存活检查见下（补记）。

## F6

待主人确认 macmini 生产鱼仍在线（本次改动未动 macmini 部署路径）。

## F5 存活检查（T6 收尾，15:45）

- `launchctl print`：`state = active`（60 秒观察窗口内持续 active，无重启循环）
- `var/log/fish.err.log`：`连不上|Error` 命中 0
- `var/log/fish.out.log` 横幅：`[鱼缸] 通道 qq：未启用 · dingtalk：未启用`
- `var/fish.db` 存在（122880 字节）→ **F5 PASS**

## 收尾状态

- F1 PASS（174/174 + prompts 28）；F2/F3 PASS（verify-channels 16 项）；F4 部分（代码/Node/配置就绪，`npm run ping` 因模型凭据为 dummy 占位跳过——**待办**）；F5 PASS；F6 待主人确认 macmini 生产鱼在线。

## F5 修正记录（15:47）

- 首轮 F5 误判：顶层 `state = spawn scheduled` + 每轮横幅重复，实为「启动→事件循环空→exit 0→KeepAlive 再拉起」循环（CHANNELS=none 时无 WS/定时器，Node 自然退出）。
- 修复：connectOnebot 在「未启用任何通道」时挂 1 小时空闲保活 timer（closeFish 清理），commit 1d72f1f；174 测试全绿。
- 复验：pid 恒 66288 持续 70 秒无重启，`连不上` 计数 0 → **F5 PASS（真值）**。
