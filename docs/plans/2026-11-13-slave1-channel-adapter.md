# 2026-11-13 slave1 通道适配器抽象（修订版）

> 状态：待 review / 待选择执行模式。本文件是 `2026-11-05-slave1-channel-adapter.md` 的修订版
> （旧版基线与部署前提已过时，以本文件为准；执行开始后每个 T 项在
> `2026-11-13-slave1-channel-adapter.run.md` 留下实际命令与输出摘要）。

## 0. 一句话结论

把「QQ 入站 → 进入模型的消息」收敛到 `src/channels/qq` 适配器并抽象通道契约，QQ 行为逐字不变；
钉钉 adapter 只留契约、注册表与接入点（协议待定，本轮不实现）。之后在本机（slave1）用
launchd 常驻，验收「进程活着 + 模型可用 + 零 QQ 连接尝试」。

### 与 2026-11-05 旧版的差异

| 项 | 旧版 | 本版 |
|---|---|---|
| 基线 | `8112a22` / 145 测试 | `60ac2b4` / 174 测试 |
| T0 TCP 栈修复 | 必需（当时 errno 49） | **删除**：本机网络直连可用（npm/git 已验证） |
| T6a 装 Node | 必需（当时无 Node） | **删除**：本机 Node v22.23.2 就绪 |
| 部署通道 | 开发机 rsync + slave1-remote.sh | **删除**：本机即目标机，`~/yugang` 已 git clone + `npm ci` + 174 测试全绿；部署走本机 commit/push + pull + launchd |
| 模型配置来源 | 从 macmini 取 models.json/auth.json | 待主人提供凭据（或指定复用本机已有 provider），**阻塞 T6，不阻塞 T1–T5** |

## 1. 目标与非目标

### 目标

1. 一条仓库同时维护两条通道路径：QQ（macmini 生产）与钉钉（slave1，协议待定）。
2. 抽象出通道适配器契约；QQ 的「入站解析 → 模型可见消息」全部集中在 `src/channels/qq`。
3. 部署形态可配置：`CHANNELS` 决定进程启动哪些通道；没有 QQ 时进程不因「连不上 OneBot」退出。
4. 本机部署同一份仓库，QQ 关闭（`CHANNELS=none`），launchd 常驻、模型可用、数据目录自建。

### 非目标（本次不做）

- 不实现钉钉 adapter（只留契约、注册表与接入点；协议定了再按消息形态实现）。
- 不在本机运行 QQ/NapCat，不把 macmini 的 QQ 迁走。
- 不改 macmini 生产部署（`npm run deploy` 路径保持原样）。
- 不配置 TTS / SD / 60s / 视频抽帧依赖（`doctor` 的告警可接受）。
- 不新增测试与 fixture（见 §9「待授权建议」）。

## 2. 整体交付终态（F1–F5）

| 编号 | 终态条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
|---|---|---|---|---|---|
| F1 | 本地回归全绿 | 本机 `npm test` + `npm run prompts` | 174 条现有测试 **0 fail**（新增测试不计入）；prompts 退出码 0 且工具包条目数不变 | `.run.md` 命令输出 | T1–T4 |
| F2 | QQ 转换逻辑集中在 `src/channels/qq` | `node scripts/verify-channels.ts` 静态边界检查 | `src/qq/{onebot,model-input,round-input,round-images}.ts` 不存在；`src/app/runtime.ts`、`src/index.ts`、`src/compact.ts` 不再 import `channels/qq/*`（经 registry/adapter 间接引用除外，见 T3 边界）；四个文件在 `src/channels/qq/` 存在 | `.run.md` 的 `F2 PASS` 行 | T2–T4 |
| F3 | 通道开关可机械判定 | 同一脚本用 `CHANNELS=none` / unset / `qq` / `foo` 调用 registry | none→0 个 adapter；unset→qq；`qq`→qq；`foo`→抛错且报出未知通道名 | `.run.md` 的 `F3 PASS` 行 | T1、T3 |
| F4 | 本机代码与模型就绪 | 本机 `node -v`、`npm test`、`npm run ping`、配置文件权限 | Node ≥22；测试 0 fail；ping 拿到模型回复；`config/auth.json`、`.env` 权限 600 | `.run.md` 的 `F4 PASS` 行 | T5 |
| F5 | 本机服务常驻且不连 QQ | `launchctl print`、日志、`var/fish.db`、60 秒存活 | job `state = running`；日志有横幅与「通道 qq 未启用」；60 秒内无 `连不上 ws://`、无退出重启循环；`var/fish.db` 存在 | `.run.md` 的 `F5 PASS` 行 | T6 |
| F6 | 生产边界经主人确认（MANUAL） | 主人确认 | macmini 的鱼仍在正常说话 | `.run.md` 的人工确认记录 | T6 |

**停滞判据**：同一 F 项连续 2 轮验收输出无实质变化（同一失败点、同一错误），判定停滞，
停止执行并在 `.run.md` 记录：未满足条件、最近证据、原因假设、恢复下一步。

### 一条验收命令（覆盖 F1–F5，F6 人工）

```bash
bash -c '
set -u
cd ~/yugang
echo "[F1] 本地回归"
npm test 2>&1 | tail -8 || exit 1
npm run prompts >/tmp/yg-prompts.log 2>&1 || { echo "prompts 失败"; exit 1; }
echo "prompts OK：$(grep -c "TOOL.md" /tmp/yg-prompts.log) 个工具包条目" || exit 1
echo "[F2/F3] 适配器边界与开关"
node scripts/verify-channels.ts || exit 1
echo "[F4] 本机代码与模型"
node -v && node scripts/ping.ts || exit 1
echo "[F5] 本机服务"
launchctl print gui/$(id -u)/com.yugang.fish | grep -E "state = running" \
  && grep -E "已连接|通道" var/log/fish.out.log | tail -5 && ls -l var/fish.db || exit 1
echo "[F6] MANUAL：请主人确认 macmini 生产鱼仍在线"
'
```

## 3. 关键事实（2026-11-13 已核对）

- 基线 `60ac2b4`（main，与 origin 同步），工作树干净；`npm test` = **174 pass / 0 fail**。
- 本机 = slave1（arm64 macOS，用户 `slave`）：Node v22.23.2、`~/yugang` 已 clone、`npm ci` 完成、
  网络直连 GitHub/npm 可用（无代理）。无 QQ / 无 NapCat / 无 Docker。
- 入口 `src/index.ts`（78 行）只 `app.use/onFlush/onStart/onStop`；实现集中在
  `src/app/runtime.ts`（2627 行）。
- QQ 输入转换的实际位置：
  - `src/qq/onebot.ts`（1038 行）：OneBot 解析、图片/合集/引用水合、发送。
  - `src/qq/model-input.ts`（279 行）：消息行/列表/引用/合集渲染（含通道无关部分）。
  - `src/qq/round-input.ts`（122 行）：answer / ambient / injection / gif 轮的输入拼装。
  - `src/qq/round-images.ts`（192 行）：inline 附图编号与压缩。
  - `src/qq/debounce.ts`（483 行）的 `withContext()`：背景板 + 整组渲染。
  - `src/app/runtime.ts` 的 `normalizeInbound`：卡片渲染、bypass 剥离、recent/chatlog 记账。
- 出站唯一出口：`FishOptions.emit`（runtime 内实现）→ `onebot.sendGroup/sendPrivate/...`；
  outbox 由 `src/fish/drain.ts` 驱动。
- `src/qq/` 另有 9 个「QQ 群行为策略」文件（gate / debounce 攒批 / engage-next / engage-mode /
  curfew / bypass / watch-state / voice-route / runtime-text），本轮留在原位。
- `src/tools/` 共 28 个目录；`npm run prompts` 输出 28 个工具包条目（T1–T4 后必须不变）。
- 测试锁（28 个 test 文件中与本次相关）：`index-registration`、`harness-assembly`、
  `model-input-templates`、`qq`、`onebot`、`gate*`、`debounce`、`quoted-images`、
  `reply-quote`、`startup`、`video-share`、`voice`。

## 4. 设计

（与旧版一致，未改动。）

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
5. `startEngage` / `startNews`：只在 `channels.has("qq")` 时启动；本机不跑开窗与新闻。
6. 启动横幅增加一行：`[鱼缸] 通道 qq：启用|未启用 · dingtalk：启用|未启用`。
7. `normalizeInbound` 的卡片渲染/bypass 剥离改调 `adapter.present(msg)`；宿主保留
   `lastWasFish` / recent / nameToQq / chatlog 记账（这些是跨轮事实，不属于渲染）。
8. 所有 QQ 专属 round 装配调用改为 `qq.render.*`，签名与现有函数一一对应，行为逐字不变。

### 4.4 `CHANNELS` 开关

- `.env` 新增 `CHANNELS`，缺省 **`qq`**（保证 macmini 行为不变）。
- 取值：逗号分隔的 `qq` / `dingtalk`；`none` 或空串 = 不启动任何通道。
- 未知名字：启动即抛错，错误信息列出「未知通道 x；可用：qq, dingtalk」。
- 本机的 `.env`：`CHANNELS=none`。
- `.env.example` 增加说明（必填项不变）。

### 4.5 本机（slave1）运行形态

- 单进程 `node --env-file-if-exists=.env src/index.ts`，launchd LaunchAgent 常驻。
- 无 QQ、无 OneBot 连接、无开窗、无新闻、无周报。
- 模型仍可用（`npm run ping`）；数据库 `var/fish.db` 自建；日志 `var/log/fish.{out,err}.log`。
- 后续钉钉 adapter 落地后，把 `CHANNELS=dingtalk` 并实现私聊入口即可，不需要再动部署骨架。

## 5. 任务拆分（DAG）

```
T1 ──> T2 ──> T3 ──> T4 ──> T5 ──> T6
```

（旧版 T0/T6a 已删除；部署不再是并行远程分支，而是本地顺序收尾。）

- **T1**（`src/channels/types.ts` + `render.ts` + `registry.ts`）
  交付：契约类型、通道无关渲染、`parseChannels`/`createChannelRegistry`/`channels.for`；
  未接入 runtime，现有 import 不动。
  验收：`npm test` 仍 174 全绿（新文件不被引用，行为零变化）。
  停止条件：发现 `model-input.ts` 的通道无关部分与 QQ 专属部分无法机械拆分（例如 compact
  依赖 QQ 专用字段）→ 停下报告，不强行拆。
  预算 30 分钟。

- **T2**（迁移 QQ 转换模块）
  交付：`git mv src/qq/{onebot,model-input,round-input,round-images}.ts src/channels/qq/`；
  把 `debounce.ts` 的 `withContext` 移入 `round-input.ts`（debounce 只留攒批）；
  更新 `src/`、`scripts/`、`test/` 的所有 import；`src/compact.ts` 与
  `src/external/news-broadcast.ts` 改用 `channels/render.ts`。
  验收：`npm test` 174 全绿；`npm run prompts` 条目数仍 28；`rg 'src/qq/(onebot|model-input|round-input|round-images)'` 为空。
  停止条件：测试出现非 import 的行为差异（渲染输出不一致）→ 回退该文件迁移并报告。
  预算 40 分钟。

- **T3**（QQ adapter + runtime 接线）
  交付：`src/channels/qq/adapter.ts` 实现 §4.2 契约；`normalize.ts` 承接卡片/bypass；
  runtime 按 §4.3 改造；`CHANNELS` 开关落地；`startEngage/startNews` 守卫；横幅增加通道行。
  验收：`npm test` 174 全绿；`CHANNELS=none` 时进程能启动到横幅（用
  `YUGANG_HOME=/tmp/yg-smoke` 临时 DB 验证，不碰 `var/`）；`CHANNELS=foo` 抛错。
  停止条件：任何一个现有测试因行为变化失败且 30 分钟内无法定位 → 回退 T3 的 runtime 接线，
  保留 adapter 文件，报告卡点（不带着红灯进 T4）。
  预算 90 分钟。

- **T4**（文档与边界固化）
  交付：AGENTS.md 增加「通道适配器」一节（目录、契约、`CHANNELS`、哪些留在 `src/qq`、
  本机形态）；更新被移动文件的路径引用；`.env.example` 增加 `CHANNELS`；
  `scripts/verify-channels.ts`（F2/F3 的机械检查与开关自检）。
  验收：`node scripts/verify-channels.ts` 全 PASS；`npm run prompts` 无意外条目。
  停止条件：verify 脚本需要读取 `.env`/凭据才能工作 → 改为只读 `process.env` 与源码；
  做不到则停下报告。
  预算 30 分钟。

- **T5**（本地总验收 + 配置就位）
  交付：`.run.md` 记录 F1–F3 的完整命令与输出；`config/models.json`、`config/auth.json`、
  `.env`（`CHANNELS=none`）、`fish.config.json`（从 example 复制，清空 `news.targetGroup`、
  `weeklyGroupId`、`voices`、`engage.freeGroups`）就位，权限 600。
  阻塞项：`models.json`/`auth.json` 需主人提供凭据或指定复用本机已有 provider；
  未到位时 F4 的 `npm run ping` 项跳过并在 `.run.md` 记录待办，其余照常推进。
  预算 30 分钟。

- **T6**（launchd 常驻）
  交付：`~/Library/LaunchAgents/com.yugang.fish.plist`；服务启动、60 秒存活、日志正确。
  要点：`ProgramArguments = [node, --env-file-if-exists=.env, <repo>/src/index.ts]`；
  `WorkingDirectory = ~/yugang`；`RunAtLoad = true`；`KeepAlive = true`；
  `ThrottleInterval = 10`；stdout/stderr → `~/yugang/var/log/fish.{out,err}.log`；
  `EnvironmentVariables.PATH` 含 `/opt/homebrew/bin`。
  依据：本机 launchd 实践（见 pi-remote-agent 运维经验）——重启服务用
  `launchctl kickstart -k`，不要 kill -TERM（KeepAlive.Crashed 不触发）。
  验收：F5 全通过；`launchctl print` 显示 `state = running`；日志无 `连不上 ws://`。
  回滚：`launchctl bootout gui/$(id -u)/com.yugang.fish`，保留目录与数据。
  预算 30 分钟。

## 6. 本机部署 runbook（执行时照此落地）

1. **代码**：T1–T4 完成后 commit（`refactor(channels): 收敛 QQ 输入转换到通道适配器`），
   push 到 origin/main；本机即工作树，无需搬运。
2. **配置**：`.env` 写 `CHANNELS=none`（其余 QQ 相关键留空）；`models.json`/`auth.json`
   由主人提供后写入并 `chmod 600`；`fish.config.json` 按 T5 清空无关字段。
3. **launchd**：写 plist → `launchctl bootstrap gui/$(id -u) <plist>` →
   `launchctl kickstart -k gui/$(id -u)/com.yugang.fish`。
4. **验收**：跑 §2 的验收命令；F1–F5 全绿后停在 F6 等主人确认。
5. **日志检查**：`grep -E "已连接|通道|连不上" var/log/fish.out.log | tail`。
6. **停止**：`launchctl bootout gui/$(id -u)/com.yugang.fish`。
7. **重新部署**：`git pull` + `launchctl kickstart -k`；数据目录不覆盖。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| runtime 2627 行，接线点多 | T3 引入行为漂移 | 每个任务后跑 174 条测试；QQ 渲染函数签名逐字对应；红灯不进入下一任务 |
| 移动文件导致测试/脚本 import 断裂 | T2 红灯 | `git mv` + 全局 rg 校验；保留 `IncomingMessage` 别名；测试只改 import |
| 基线与旧计划描述有出入（文件行数/新增模块） | 迁移清单遗漏 | T2 执行前先 `rg -l "from.*qq/(onebot|model-input|round-input|round-images)"` 全量列引用再动手 |
| 模型凭据未定 | F4 ping 无法全绿 | T5 只记待办不阻塞；凭据到位后单独补验 F4 |
| 钉钉协议未定 | 契约返工风险 | 契约里 `gate`/`render` 由 adapter 各自实现；钉钉接入点只留注册表项，不写死策略 |
| 新测试未授权 | 边界回归靠手工命令 | `scripts/verify-channels.ts` 做静态检查；测试建议列在 §9 等授权 |

## 8. 文档更新清单（T4）

- `AGENTS.md`：
  - 新增「通道适配器（2026-11-13）」：目录、契约、`CHANNELS`、`src/qq` 保留策略、
    本机形态、钉钉接入点。
  - 更新被移动文件的路径引用（`src/qq/onebot.ts` → `src/channels/qq/onebot.ts` 等）。
  - 明确「新增通道 = 实现 `ChannelAdapter` + registry 注册 + `.env.example` 说明」。
- `.env.example`：增加 `CHANNELS`（缺省 qq；none 关闭）。
- 本计划 + `.run.md`：执行证据。

## 9. 待授权建议（不包含在本次执行内）

- 建议新增 `test/channels-registry.test.ts`：覆盖 `parseChannels`（none/unset/qq/dingtalk/未知）
  与 `channels.for(chatKey)` 路由。
- 建议新增 `test/channel-boundary.test.ts`：静态断言 `src/app`、`src/compact.ts` 不 import
  `channels/qq/*`，防止边界回退。
- 以上均需主人明确授权后才创建；本次用 `scripts/verify-channels.ts` 做同等的运行时检查。

## 10. 执行模式（启动前由主人选择，不默认）

- **A. subagent 并发驱动**：T1→T2→T3→T4→T5→T6 强依赖串行，主会话派发 executor 逐任务执行、
  整合与汇报。代价：主会话上下文占用小，但每任务交接要写完整任务说明。
- **B. 主会话串行执行**：本会话 inline 逐任务执行，不派发 subagent。代价：上下文连续、
  改动可控，但受轮次与上下文预算限制。

用户选择前不得开始执行。
