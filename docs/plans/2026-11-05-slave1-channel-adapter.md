# 2026-11-05 slave1 部署 + 通道适配器抽象

> 状态：待 review / 待选择执行模式。执行开始后本文件的每个 T 项都要在
> `2026-11-05-slave1-channel-adapter.run.md` 留下实际命令与输出摘要。

## 0. 一句话结论

先把「QQ 输入 → 真正进入模型的消息」收敛到 `src/channels/qq` 适配器，并让通道可以按部署
开关（slave1 只跑钉钉路径，QQ 关闭）；再把同一份仓库部署到 slave1，用 launchd 常驻，
验收「进程活着 + 模型可用 + 没有任何 QQ 连接尝试」。

**外部阻塞（必须先处理）**：slave1 当前 TCP 栈不可用——

- `netstat -an -p tcp | grep -c TIME_WAIT` 恒为 **29037**（76 天未重启，采样 40 秒无变化）；
- 任意 `connect()`（含 `127.0.0.1`、`30.10.148.96`、`1.1.1.1`）返回 **errno 49
  Can't assign requested address**；`ping`（ICMP）正常；
- 因此 `curl`、`npm`、`brew`、模型 API 全部不可达。

T0 不解决，F4/F5 无法通过；这不是代码问题。

---

## 1. 目标与非目标

### 目标

1. 一条仓库同时维护两条通道路径：QQ（macmini 生产）与钉钉私聊（slave1，后续接入）。
2. 抽象出通道适配器契约；QQ 的「入站解析 → 模型可见消息」全部集中在 `src/channels/qq`。
3. 部署形态可配置：`CHANNELS` 决定进程启动哪些通道；没有 QQ 时进程不因「连不上 OneBot」退出。
4. slave1 上部署同一份仓库，QQ 关闭，进程常驻、模型可用、数据目录自建。

### 非目标（本次不做）

- 不实现钉钉 adapter（只留契约、注册表与接入点；下一轮按私聊消息实现）。
- 不在 slave1 上运行 QQ/NapCat，也不把 macmini 的 QQ 迁走。
- 不改 macmini 生产部署（`npm run deploy` 路径保持原样）。
- 不在 slave1 配置 TTS / SD / 60s / 视频抽帧依赖（`doctor` 的告警可接受）。
- 不新增测试与 fixture（见 §9「待授权建议」）。

---

## 2. 整体交付终态（F1–F6）

| 编号 | 终态条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
|---|---|---|---|---|---|
| F1 | 本地回归全绿 | 开发机 `npm test` + `npm run prompts` | 145 条现有测试 **0 fail**（新增测试不计入）；prompts 退出码 0 且工具包数量仍为 24 | `.run.md` 命令输出 | T1–T4 |
| F2 | QQ 转换逻辑集中在 `src/channels/qq` | `node scripts/verify-channels.ts` 的静态边界检查 | `src/qq/{onebot,model-input,round-input,round-images}.ts` 不存在；`src/app/runtime.ts`、`src/index.ts`、`src/compact.ts` 不再 import `channels/qq/*`；四个文件在 `src/channels/qq/` 存在 | `.run.md` 的 `F2 PASS` 行 | T2–T4 |
| F3 | 通道开关可机械判定 | 同一脚本用 `CHANNELS=none` / unset / `qq` / `foo` 调用 registry | none→0 个 adapter；unset→qq；`qq`→qq；`foo`→抛错且报出未知通道名 | `.run.md` 的 `F3 PASS` 行 | T1、T3 |
| F4 | slave1 代码与模型就绪 | slave1 上 `node -v`、`npm test`、`npm run ping`、配置文件权限 | Node ≥22；测试 0 fail；ping 拿到模型回复；`config/auth.json`、`.env` 权限 600 | `.run.md` 的 `F4 PASS` 行 | T6 |
| F5 | slave1 服务常驻且不连 QQ | `launchctl print`、日志、`var/fish.db`、60 秒存活 | job `state = running`；日志有「已连接」横幅与「通道 qq 未启用」；60 秒内无 `连不上 ws://`、无退出重启循环；`var/fish.db` 存在 | `.run.md` 的 `F5 PASS` 行 | T7 |
| F6 | 生产边界经主人确认（MANUAL） | 主人确认 | macmini 的鱼仍在正常说话；slave1 只作为钉钉落点待命 | `.run.md` 的人工确认记录 | T0、T7 |

**停滞判据**：同一 F 项连续 **2 轮**验收输出无实质变化（同一失败点、同一错误），判定停滞，
停止执行并在 `.run.md` 记录：未满足条件、最近证据、原因假设、恢复下一步。

### 一条验收命令（覆盖 F1–F5，F6 人工）

```bash
bash -c '
set -u
R=/Users/leshi.zhy/.agents/skills/mac-mini-slave1/scripts/slave1-remote.sh
echo "[F1] 本地回归"
npm test 2>&1 | tail -8 || exit 1
npm run prompts >/tmp/yg-prompts.log 2>&1 || { echo "prompts 失败"; exit 1; }
echo "prompts OK：$(grep -c "TOOL.md" /tmp/yg-prompts.log) 个工具包条目" || exit 1
echo "[F2/F3] 适配器边界与开关"
node scripts/verify-channels.ts || exit 1
echo "[F4] slave1 代码与模型"
"$R" ssh "cd ~/yugang && node --test \"test/*.test.ts\" 2>&1 | tail -6 && node scripts/ping.ts" || exit 1
echo "[F5] slave1 服务"
"$R" ssh "launchctl print gui/\$(id -u)/com.yugang.fish | grep -E \"state = running\" && grep -E \"已连接|通道\" var/log/fish.log | tail -5 && ls -l var/fish.db" || exit 1
echo "[F6] MANUAL：请主人确认 macmini 生产鱼仍在线"
'
```

---

## 3. 关键事实（本次已核对）

- 代码基线 `8112a22`，工作树干净；`npm test` = **145 pass / 0 fail**（2.6s）。
- 入口 `src/index.ts` 只有 `app.use/onFlush/onStart/onStop`；实现集中在 `src/app/runtime.ts`（2700 行）。
- QQ 输入转换的实际位置：
  - `src/qq/onebot.ts`（999 行）：OneBot 解析、图片/合集/引用水合、发送。
  - `src/qq/model-input.ts`（260 行）：消息行/列表/引用/合集渲染（含通道无关部分）。
  - `src/qq/round-input.ts`（126 行）：answer / ambient / injection / gif 轮的输入拼装。
  - `src/qq/round-images.ts`（127 行）：inline 附图编号与压缩。
  - `src/qq/debounce.ts` 的 `withContext()`：背景板 + 整组渲染，是「进入模型」的最后一段。
  - `src/app/runtime.ts` 的 `normalizeInbound`：卡片渲染、bypass 剥离、recent/chatlog 记账。
- 出站唯一出口：`FishOptions.emit`（runtime 内实现）→ `onebot.sendGroup/sendPrivate/...`；
  outbox 由 `src/fish/drain.ts` 驱动。
- 测试锁：`test/index-registration.test.ts`（入口只注册）、`test/harness-assembly.test.ts`（installer 顺序）、
  `test/model-input-templates.test.ts`（模板拼装）、`test/qq.test.ts`、`test/onebot.test.ts` 等。
- macmini 生产配置（只读核对）：`models.main = zai-coding-cn/glm-5.3-flash`（直连
  `open.bigmodel.cn`，无代理）；`image = openai-codex`、`vision_fallback = google-antigravity`
  走 `http://127.0.0.1:7897`；`MASTER_QQ=2928390812`。
- slave1：arm64 / macOS 26.3.2 / 用户 `slave` / brew 在 `/opt/homebrew/bin`（非交互 PATH 不含）/
  无 Node / 无 QQ / 无 Docker / 无法直连 GitHub/npm / 有 mihomo（监听 7897 等，但当前连不上）/
  磁盘 342Gi 可用。**TCP 栈阻塞见 §0。**

---

## 4. 设计

### 4.1 目录与边界

```
src/channels/
  types.ts        # ChannelMessage / ChannelAdapter / ChannelRenderer / GateDecision
  render.ts       # 通道无关的行与列表渲染（从 qq/model-input.ts 抽出）
  registry.ts     # CHANNELS 解析、适配器构造、chatKey 路由、start/stop
  qq/
    adapter.ts    # QQ 适配器：实现契约（组合下面各模块）
    onebot.ts     # 从 src/qq 移入
    model-input.ts# 从 src/qq 移入（QQ 专属：引用/合集/@ 标签）
    round-input.ts# 从 src/qq 移入 + 接收 debounce.ts 的 withContext
    round-images.ts# 从 src/qq 移入
    normalize.ts  # 新增：卡片渲染 / bypass 剥离等入站文本归一（从 runtime 抽出）
```

留在 `src/qq/` 的（本轮的明确边界）：`gate.ts`、`debounce.ts`（去掉渲染后只负责攒批）、
`engage-next.ts`、`curfew.ts`、`engage-mode.ts`、`bypass.ts`、`watch-state.ts`、
`voice-route.ts`、`runtime-text.ts`。这些是「QQ 群行为策略」，不是「输入到模型消息的转换」；
钉钉私聊不经过它们。运行时对它们的依赖用 `registry.has("qq")` 守卫，后续接入钉钉时再按需通道化。

### 4.2 契约（`src/channels/types.ts`）

```ts
export type ChannelId = "qq" | "dingtalk";
export type ChatScope = "group" | "private";

/** 归一后的入站消息。chatKey = `${ChannelId}:${ChatScope}:${id}`。 */
export interface ChannelMessage {
  chatKey: string;
  channel: ChannelId;
  scope: ChatScope;
  userId: string;              // QQ 号 / DingTalk staffId
  nickname: string;
  text: string;
  mentionsBot: boolean;
  messageId?: number | string;
  replyIds: string[];
  images: { ref: string }[];
  mentions?: { qq: string; name: string; kind: "bot" | "other" | "all" }[];
  quoted?: QuotedMessage;
  // QQ 扩展（其他通道不填）：groupId / cards / forward / forwardIds / repliedForward /
  // mediaOnly / arrivalSeq / imageSegments / atOthers / atOtherNames
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  owns(chatKey: string): boolean;
  start(onMessage: (msg: ChannelMessage) => void): Promise<void>;
  stop(): Promise<void>;
  selfId(): string;
  /** 记忆/画像的主体键：qq:123 / dingtalk:456。 */
  personSubject(userId: string): string;
  /** 入站准入：QQ 群窗/私聊主人；钉钉私聊白名单。 */
  gate(msg: ChannelMessage): GateDecision;
  /** 入站文本归一（卡片渲染、bypass 剥离）；宿主仍负责 recent/chatlog 记账。 */
  present(msg: ChannelMessage): { text: string; bypass?: { clean: string; stash: string } };
  /** 模型输入渲染：运行时只经这里拿进入模型的字符串与 image blocks。 */
  render: {
    planImages(anchor: ChannelMessage, messages: readonly ChannelMessage[], opts: ImagePlanOptions): RoundImagePlan;
    answer(anchor: ChannelMessage, history: readonly RecentChatMessage[], burst: readonly BurstMessage[], opts: ContextOptions): RoundContext;
    openList(items: readonly OpenMessage[], opts: OpenListOptions): string;
    openQuoted(items: readonly OpenMessage[], messages: MessageTable): string;
    gifIngest(history: readonly ModelMessage[], target: ModelMessage, messages: MessageTable): string;
    browseOpportunity(messages: MessageTable): string;
    assemble(base: string, extras: RoundExtras, messages: MessageTable): string;
    submitContent(content: string, blocks: readonly ImageBlock[]): string | ContentBlock[];
    appendVoiceHint(content: string, hint: string): string;
    appendAnswerRules(content: string, rules: readonly string[]): string;
  };
  send(chatKey: string, payload: OutboundPayload): Promise<SentMessageIds | void>;
  react(chatKey: string, messageId: number | string, emoji: string): Promise<void>;
  members?(chatKey: string): Promise<{ nickname: string; userId: string }[]>;
  groupInfo?(chatKey: string): Promise<GroupInfo | undefined>;
  expandPendingForward?(chatKey: string, anchor: ChannelMessage): Promise<ForwardAttachment | undefined>;
}
```

`IncomingMessage` 保留为 `ChannelMessage` 的别名（`src/channels/qq/onebot.ts` 导出），
QQ 代码与测试的类型名不用大改。

### 4.3 运行时接线（`src/app/runtime.ts`）

1. 单例 `onebot` 改为 `channels.get("qq")` 持有的适配器实例；构造参数
   （`mediaRoot`、`pacingSeconds`、`onSent`）由 registry 的 `qq` 选项传入。
2. `emit` / `react` / `groupMembersOf` / `selfOf.selfId` / 记忆 subject：
   按 `chatKey` 路由到 `channels.for(chatKey)`；没有适配器时记日志并返回（不误标 sent）。
3. `gate`：`channels.for(msg.chatKey)?.gate(msg)`；没有适配器返回
   `{ enter:false, reason:"channel_disabled" }`（GateDecision 增加该 reason）。
4. `start`：`connectOnebot` → `channels.start(dispatch)`；**仅在「已启用通道」启动失败时**
   `process.exit(1)`；一个通道都没启用时打一行「未启用任何通道」并继续。
5. `startEngage` / `startNews`：只在 `channels.has("qq")` 时启动；slave1 不跑开窗与新闻。
6. 启动横幅增加一行：`[鱼缸] 通道 qq：启用|未启用 · dingtalk：启用|未启用`。
7. `normalizeInbound` 的卡片渲染/bypass 剥离改调 `adapter.present(msg)`；宿主保留
   `lastWasFish` / recent / nameToQq / chatlog 记账（这些是跨轮事实，不属于渲染）。
8. 所有 QQ 专属 round 装配调用改为 `qq.render.*`，签名与现有函数一一对应，行为逐字不变。

### 4.4 `CHANNELS` 开关

- `.env` 新增 `CHANNELS`，缺省 **`qq`**（保证 macmini 行为不变）。
- 取值：逗号分隔的 `qq` / `dingtalk`；`none` 或空串 = 不启动任何通道。
- 未知名字：启动即抛错，错误信息列出「未知通道 x；可用：qq, dingtalk」。
- slave1 的 `.env`：`CHANNELS=none`。
- `.env.example` 增加说明（必填项不变）。

### 4.5 slave1 运行形态

- 单进程 `node --env-file-if-exists=.env src/index.ts`，launchd LaunchAgent 常驻。
- 无 QQ、无 OneBot 连接、无开窗、无新闻、无周报。
- 模型仍可用（`npm run ping`）；数据库 `var/fish.db` 自建；日志 `var/log/fish.log`。
- 后续钉钉 adapter 落地后，把 `CHANNELS=dingtalk` 并实现私聊入口即可，不需要再动部署骨架。

---

## 5. 任务拆分（DAG）

依赖边只指向上游的具体产物：

```
T1 ──> T2 ──> T3 ──> T4 ──> T5 ──┐
                                  ├──> T6b ──> T7
T0 ──> T6a ───────────────────────┘
```

- **T1** (`src/channels/types.ts` + `render.ts` + `registry.ts`)
  交付：契约类型、通道无关渲染、`parseChannels`/`createChannelRegistry`/`channels.for`；
  未接入 runtime，现有 import 不动。
  依赖：无。验收：`npm test` 仍 145 全绿（新文件不被引用，行为零变化）。
  停止条件：发现 `model-input.ts` 的通道无关部分与 QQ 专属部分无法机械拆分（例如 compact
  依赖 QQ 专用字段）→ 停下报告，不强行拆。
  预算 30 分钟。

- **T2**（迁移 QQ 转换模块）
  交付：`git mv src/qq/{onebot,model-input,round-input,round-images}.ts src/channels/qq/`；
  把 `debounce.ts` 的 `withContext` 移入 `round-input.ts`（debounce 只留攒批）；
  更新 `src/`、`scripts/`、`test/` 的所有 import；`src/compact.ts` 与
  `src/external/news-broadcast.ts` 改用 `channels/render.ts`。
  依赖：T1 的 `render.ts`（共享渲染）与 `types.ts`。
  验收：`npm test` 145 全绿；`npm run prompts` 无变化；`rg 'src/qq/(onebot|model-input|round-input|round-images)'` 为空。
  停止条件：测试出现非 import 的行为差异（渲染输出不一致）→ 回退该文件迁移并报告。
  预算 40 分钟。

- **T3**（QQ adapter + runtime 接线）
  交付：`src/channels/qq/adapter.ts` 实现 §4.2 契约；`normalize.ts` 承接卡片/bypass；
  runtime 按 §4.3 改造；`CHANNELS` 开关落地；`startEngage/startNews` 守卫；
  横幅增加通道行。
  依赖：T1 契约与 registry、T2 迁移后的模块。
  验收：`npm test` 145 全绿；`CHANNELS=none` 时进程能启动到横幅（本地可用临时 DB +
  `YUGANG_HOME=/tmp/yg-smoke` 验证，不碰本地 `var/`）；`CHANNELS=foo` 抛错。
  停止条件：任何一个现有测试因行为变化失败且 30 分钟内无法定位 → 回退 T3 的 runtime 接线，
  保留 adapter 文件，报告卡点（不带着红灯进 T4/T6）。
  预算 90 分钟。

- **T4**（文档与边界固化）
  交付：AGENTS.md 增加「通道适配器」一节（目录、契约、`CHANNELS`、哪些留在 `src/qq`、
  slave1 形态）；更新被移动文件的路径引用；`.env.example` 增加 `CHANNELS`；
  `scripts/verify-channels.ts`（F2/F3 的机械检查与开关自检）。
  依赖：T3 的最终目录与 runtime 依赖面。
  验收：`node scripts/verify-channels.ts` 全 PASS；`npm run prompts` 无意外条目。
  停止条件：verify 脚本需要读取 `.env`/凭据才能工作 → 改为只读 `process.env` 与源码，
  不引入密钥依赖；做不到则停下报告。
  预算 30 分钟。

- **T5**（本地总验收）
  交付：`.run.md` 记录 F1–F3 的完整命令与输出。
  依赖：T4。
  验收：§2 验收命令的前半段（F1–F3）全 PASS。
  预算 15 分钟。

- **T0**（slave1 TCP 栈修复，MANUAL，阻塞 T6/T7）
  交付：slave1 恢复 TCP 出站；记录修复方式与验证输出。
  做法（按顺序，需主人授权执行 sudo）：
  1. `sudo sysctl -w net.inet.ip.portrange.first=16384`（临时扩大临时端口范围，
     不动运行中的 VM；重启后失效）；
  2. 若仍 000：`sudo sysctl -w net.inet.tcp.msl=1000`（缩短 TIME_WAIT）；
  3. 仍不行且主人同意：重启 slave1（会终止正在运行的 Lima VM）。
  验证：`curl -m8 -o /dev/null -w '%{http_code}' https://open.bigmodel.cn` 返回非 `000`；
  `netstat -an -p tcp | grep -c TIME_WAIT` 不再等于 29037。
  停止条件：A+B 后仍全部 errno 49 → 停止，报告「slave1 需要管理员介入」，不继续 T6。
  预算 20 分钟。

- **T6a**（slave1 运行时准备，可与 T1–T5 并行）
  交付：slave1 上有可用 Node（≥22）与 `~/yugang` 目录骨架。
  做法：优先 `PATH=/opt/homebrew/bin:$PATH brew install node`；brew 不可用则从开发机
  rsync 本地 `/opt/homebrew/Cellar/node/26.8.1` 到 `~/node`，用 `~/node/bin/node`。
  依赖：T0（network 恢复）或本地 rsync 通道（rsync 走 SSH，不依赖目标机外网）。
  验收：`node -v` ≥22；`node --test` 能跑一个空测试。
  预算 20 分钟。

- **T6b**（代码与配置上机）
  交付：`~/yugang` 为 T5 的最终代码；`node_modules` 可用；`config/models.json`、
  `config/auth.json`、`.env`、`fish.config.json` 就位（含 `CHANNELS=none`）。
  依赖：T5（最终代码）、T6a（Node）、T0（模型连通）。
  做法：rsync 本地仓库（排除 `var/`、`.env`、`config/models.json`、`config/auth.json`、
  `node_modules/`）→ 单独传 `node_modules/`；从 macmini 经 home-connect 取
  `config/models.json` + `config/auth.json`（本地临时文件 → 上传 → `chmod 600`，任何环节不打印内容）。
  验收：F4 全通过。
  停止条件：`npm run ping` 失败且定位到 provider/代理配置（不是 TCP 栈）→ 先只保留
  `models.main/vision`，移除需要 7897 代理的 `image/vision_fallback`，重试 ping；
  仍失败则停止报告，不修改 macmini 的配置。
  预算 30 分钟。

- **T7**（launchd 常驻）
  交付：`~/Library/LaunchAgents/com.yugang.fish.plist`；服务启动、60 秒存活、日志正确。
  依赖：T6b。
  要点：`ProgramArguments = [node, --env-file-if-exists=.env, <repo>/src/index.ts]`；
  `WorkingDirectory = ~/yugang`；`RunAtLoad = true`；`KeepAlive = true`；
  `ThrottleInterval = 10`；stdout/stderr → `~/yugang/var/log/fish.{out,err}.log`；
  `EnvironmentVariables.PATH` 含 Node 所在目录。
  验收：F5 全通过；`launchctl print` 显示 `state = running`；日志无 `连不上 ws://`。
  回滚：`launchctl bootout gui/$(id -u)/com.yugang.fish`，保留目录与数据。
  预算 30 分钟。

**并行说明**：T0/T6a 与 T1–T5 无写路径重叠，可并行；T6b 必须等 T5 的最终代码。

---

## 6. slave1 部署 runbook（执行时照此落地）

1. **修复 TCP 栈**（T0）：见上；记录修复前/后的 `TIME_WAIT` 与 `curl` 状态码。
2. **Node**（T6a）：`PATH=/opt/homebrew/bin:$PATH brew install node`；失败则 rsync 本地
   Homebrew Cellar 的 node 到 `~/node`。
3. **仓库**（T6b）：
   ```bash
   R=/Users/leshi.zhy/.agents/skills/mac-mini-slave1/scripts/slave1-remote.sh
   "$R" rsync-upload ./ '~/yugang/'   # 实际执行时加 --exclude
   "$R" rsync-upload ./node_modules/ '~/yugang/node_modules/'
   ```
   （rsync 的 exclude 在包装脚本里不可直接追加时，先用本地 `tar` 打包含 exclusion 再上传。）
4. **配置**：从 macmini 取 `config/models.json`、`config/auth.json`；`.env` 写
   `CHANNELS=none`、`MASTER_QQ=2928390812`、`GROUPS=`；`fish.config.json` 由 example 复制，
   清空 `news.targetGroup`、`weeklyGroupId`、`voices`、`engage.freeGroups`。
5. **权限**：`.env`、`config/auth.json` 600；`var/log` 存在。
6. **launchd**：写 plist → `launchctl bootstrap gui/$(id -u) <plist>` →
   `launchctl kickstart -k gui/$(id -u)/com.yugang.fish`。
7. **验收**：跑 §2 的验收命令；F1–F5 全绿后停在 F6 等主人确认。

**日志检查**：`grep -E "已连接|通道|连不上" var/log/fish.out.log | tail`。
**停止**：`launchctl bootout gui/$(id -u)/com.yugang.fish`。
**重新部署**：重复第 3 步 rsync + `launchctl kickstart -k`；数据目录不覆盖。

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| slave1 TCP 栈需 root 修复 | T6/T7 全阻塞 | T0 前置；A/B/C 三方案按侵入性递增；失败即停并报告 |
| runtime 2700 行，接线点多 | T3 引入行为漂移 | 每个任务后跑 145 条测试；QQ 渲染函数签名逐字对应；红灯不进入下一任务 |
| 移动文件导致测试/脚本 import 断裂 | T2 红灯 | `git mv` + 全局 rg 校验；保留 `IncomingMessage` 别名；测试只改 import |
| slave1 无法 git pull | 部署不可重复 | 本次用 rsync；AGENTS 记录「slave1 用本地 rsync 部署，源码源仍是同一仓库」 |
| 模型代理（7897）在 slave1 状态未知 | `npm run ping` 失败 | 先只保留直连的 `main/vision`；代理角色失败就移除，不改 macmini |
| 钉钉私聊身份/白名单未定 | 后续接入返工 | 契约里 `gate` 由 adapter 决定；本次不写死钉钉策略 |
| 新测试未授权 | 边界回归靠手工命令 | `scripts/verify-channels.ts` 做静态检查；测试建议列在 §9 等授权 |

---

## 8. 文档更新清单（T4）

- `AGENTS.md`：
  - 新增「通道适配器（2026-11-05）」：目录、契约、`CHANNELS`、`src/qq` 保留策略、
    slave1 形态、钉钉接入点。
  - 更新被移动文件的路径引用（§1/§7/§17 等处的 `src/qq/onebot.ts` →
    `src/channels/qq/onebot.ts`）。
  - 明确「新增通道 = 实现 `ChannelAdapter` + registry 注册 + `.env.example` 说明」。
- `.env.example`：增加 `CHANNELS`（缺省 qq；none 关闭）。
- 本计划 + `.run.md`：执行证据。

---

## 9. 待授权建议（不包含在本次执行内）

- 建议新增 `test/channels-registry.test.ts`：覆盖 `parseChannels`（none/unset/qq/dingtalk/未知）
  与 `channels.for(chatKey)` 路由。
- 建议新增 `test/channel-boundary.test.ts`：静态断言 `src/app`、`src/compact.ts` 不 import
  `channels/qq/*`，防止边界回退。
- 以上均需主人明确授权后才创建；本次用 `scripts/verify-channels.ts` 做同等的运行时检查。

---

## 10. 执行模式（启动前由主人选择，不默认）

- **A. subagent 并发驱动**：T1→T2→T3→T4→T5 串行（强依赖），T0/T6a 并行；主会话只调度、
  整合与汇报。代价：更快，但需要处理 worktree 合并与冲突。
- **B. 主会话串行执行**：本会话 inline 逐任务执行，不派发 subagent。代价：上下文连续、
  改动可控，但受轮次与上下文预算限制。

用户选择前不得开始执行。
