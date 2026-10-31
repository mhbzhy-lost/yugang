---
name: yugang-ops
description: 维护「鱼缸」这个 QQ 群机器人时使用：查状态、看原话簿、复盘某天某个群聊了什么、诊断连不上 QQ、以及改动前后的检查清单。用户提到鱼缸、鱼、QQ 机器人、掉线、不说话、群里聊了什么时都应该先加载这个技能。
---

# 鱼缸运维

**生产现场在 macmini**（macmini，仓库 `~/yugang`）；本地开发机的 `var/` 是迁移前旧副本，**不要在本地起鱼**。日常运维一律用本 skill 的 `scripts/fish.sh`（内部经 home-mac-connect 的 connect.sh 在 macmini 上执行）：

```bash
scripts/fish.sh status               # 数据目录 / 幂等表 / 原话簿概况
scripts/fish.sh digest [日期] [群号] # 复盘某天某个群
scripts/fish.sh probe                # QQ 侧验收
scripts/fish.sh log 60               # 鱼日志尾部
scripts/fish.sh deploy               # git pull + 平滑重启（标准部署入口）
scripts/fish.sh memes                # 表情包库状态（本地批量导入：主人把图放进 media/meme-inbox/ 再让鱼逐批登记）
scripts/fish.sh help                 # 全部子命令（其它命令原样透传）
```

部署流程（见仓库 AGENTS.md「部署」）：本地开发 + `npm test` → commit/push → `fish.sh deploy`。

**`fish.sh` 只能在本地开发机跑**：它内部经 connect.sh ssh 到 macmini，macmini 上并没有
`home-mac-connect` 这个 skill（在 mini 上直接跑会报「找不到 connect.sh」）。

`deploy` 单次约 15–20 秒（优雅停机最多 16s + pull + 启动 + 等横幅），**用后台异步方式跑**，
不要和 npm test / git push 串在一条阻塞命令里干等；完成后再读日志确认横幅。

下文命令仅在 macmini 上直接操作或排查离线副本时使用。本地仓库 `~/yugang（本地开发机）`；
所有数据在 `var/`（可用 `YUGANG_HOME` 覆盖）。**先读 `AGENTS.md`**，那里是硬约束。

## 配置在哪

`.env`（gitignore，模板 `.env.example`）。四样必填：`ONEBOT_WS_URL` / `ONEBOT_TOKEN` /
`MASTER_QQ` / `GROUPS`。token 用 `npm run token` 生成（会同步写好 NapCat 的 `onebot.json`）。`npm start`、`probe`、`ops`、`ping` 都会自动加载它。
模块 key 不在 `.env` 里，在 `config/auth.json`。

**行为参数在 `fish.config.json`**（mini 仓库根，gitignore，模板 `fish.config.example`，mtime 热加载）：
`ambientMinIntervalSeconds` / `watchAmbientChance` / `thinkingLevel` / `compact` /
`memeCooldownMinutes` / `toolTimeoutSeconds` / `voices`（人格 → TTS 地址与参考音频）。
优先级：`fish.config.json` > `.env` > 内置默认；文件写坏时保留上一次的有效值。

音色只认 `voices`，`.env` 里的 `TTS_*` 已经删了——**没有任何兜底**，没配就是那个会话没有语音能力。

## 拉起 / 收掉

```bash
npm run doctor     # 体检
npm run up         # 等协议端 → 起鱼
npm run down       # 收掉
npm run protocol status   # 协议端装没装、WS 通不通
```

## 查状态

```bash
node scripts/ops.ts status
```

给出：数据目录、幂等表条数、数据库大小、原话簿有多少天、最近三天每个会话的条数。

## 看某天花在哪

```bash
node scripts/ops.ts usage              # 今天
node scripts/ops.ts usage 2026-05-01
```

按群排序列出 tokens（in/out/cache）和计费。数据来自 `var/usage/<day>/usage.jsonl`，
是每轮结束后从 `pi.usage` 取的**增量**——直接 sum 就能得到当天总额，重启不会重复计。

## 复盘某个群某天聊了什么

```bash
node scripts/ops.ts digest                # 今天，所有群
node scripts/ops.ts digest 2026-05-01     # 指定日期
node scripts/ops.ts digest 2026-05-01 42  # 只看群号含 42 的
```

输出每个人发言次数、活跃时段、最后 8 条群消息。用来判断"这条鱼昨天是不是话太多/太少"。

## 模型不通

```bash
npm run ping
```

输出包括 provider / model / baseUrl / 凭据状态（只有"已加载 / N 字符"和来源路径），
以及一次最小补全的耗时和用量。

- 报 `没有拿到 key` → 跑 `npm run creds show`；没有就 `npm run creds import`（写 `config/auth.json`，已被 gitignore）
- 报 `400 ... unsupported field "max_completion_tokens"` → `config/models.json` 里这个 provider 缺 `compat.maxTokensField: "max_tokens"`
- 换模型不改代码：编辑 `config/models.json` 的 `models.main` / `models.vision` / `models.image`，再让鱼 restart

## 诊断连不上 QQ

```bash
node scripts/ops.ts probe
```

`get_login_info` 超时基本都是：协议端没起、端口不对、token 不对。协议端的 WebUI 登录状态才是唯一可信来源。

## 不说话怎么排查（按顺序）

1. `node scripts/ops.ts digest <今天>` —— 群里有没有消息进来。没有 → 协议端或 WS 断了。
2. 有消息但没出站 —— 看进程日志里的 `[鱼缸]` 行；`这一轮没答上来` 表示模型调用失败。
3. 有 `这一轮没答上来` —— 检查模型 key / 余额 / base_url。
4. 都正常但话少 —— 是闸挡的：看 `[fish] gate <chatKey> <昵称> -> skip:<原因>`（日志带 `HH:MM:SS`）。
   `rate_limited` = 限流挡的：同一群两条被处理消息之间至少隔 `ambientMinIntervalSeconds`（默认 60s，热加载）；
   `watched_sampled_out` = 关注者冷却没到且随机门没抽中（`watchAmbientChance`）；
   `forward_ignored` = 没 @ 的合集被丢弃；`group_not_allowed` = 群不在 `GROUPS`；`stranger_private` = 陌生人私聊。
   放行是 `enter:`，常见值 `mentioned` / `replied_forward` / `rate_pass` / `watched` / `watched_rate_pass` / `private`。
5. 私聊没反应 —— 只认 `MASTER_QQ`，陌生人一律不回。这是设计，不是 bug。

## 语音没声音怎么查

1. `lsof -i :9880` / `:9881` —— TTS 实例在不在；不在就 `launchctl kickstart -k gui/$(id -u)/com.yugang.tts`（或 `.sandrone`）
2. `tail ~/tts/tts.log` 有 `LookupError … Resource 'cmudict' not found` —— **NLTK 数据丢了**：
   `~/tts/GPT-SoVITS/.venv/bin/python -m nltk.downloader -d ~/nltk_data cmudict`
   （缺了会返回 200 + 0 字节空音频，日志里只有一行 `[鱼缸] 语音合成失败`）
3. 鱼日志有 `voice_off` —— 这个会话的人格在 `fish.config.json` 的 `voices` 里没有条目（没配就是没语音，不是 bug）
4. 鱼日志有 `voice_too_long` / `voice_with_media` / `say_media_used` —— 出口闸拦的，看 `src/tools/say/TOOL.md`

## 合集（合并转发）看不了怎么查

- `skip:forward_ignored` = 没 @ 的合集被丢弃（设计如此，只缓存 id 10 分钟）
- 鱼说「看不了」但日志有 `补展开最近合集` = 展开了，内容在 user 消息最前面
- 背景栏里的合集永远是 `[转发合集（内容略）]`：防止连发十条把上下文撑爆，**这是设计**

## 答非所问怎么排查（5 秒合并相关）

闸放行的群消息不会立刻进模型，而是按「群 + 发送者」攒 5 秒静默（窗口固定 5000ms），静默满了才整组提交。
排查时按这几点看：

1. **它回得太快**：如果这轮没经过 5 秒延迟，可能是三条例外路径——主人的 `/` 指令（闸前机械回执）、私聊、
   群里 GIF 的静默收图轮。其余群消息都应该走窗口。
2. **话被拆成两轮 / 只回了半句**：同一发送者 5 秒内的新消息会并进同一窗口，整组一起提交；不同发送者各自独立窗口。
   日志里同一发送者短时间出现两次完整轮次，才是真的异常。
3. **回了 A 却引用到 B**：锚点固定是整组最后一条（`flushBurst` 的 `anchor`），A-B-A 里 B 只作背景，
   不同发送者碰不到锚点；引用错人应查 `fish.outbox` 里的 `quoteId` 与本轮触发消息是否一致。
4. **只回了最后一句、前面几句当没看见**：背景栏最多取锚点之前 10 条，更早的不进上下文（设计如此）。
5. **完全没回**：待定窗口只在内存里。日志 `[鱼缸] ... 换页中，丢弃待定组 N` = 撞上换页被主动丢弃；
   重启时没 flush 的窗口也会丢——宁可少答一句，不要补一句陈年旧话。

## 表情包导入排查

主人把一批图放进 `<MEDIA_ROOT>/meme-inbox/`（固定目录，不接受其它路径），然后让鱼导入。流程是
`meme_import` 登记 → 逐张 `look` → 结合群聊逐张 `meme_add`。出问题按顺序查：

1. `fish.sh memes` 看库存和索引路径；目录只看 `meme-inbox/` 的**直接子文件**，放进子目录不会扫到。
2. 日志 `[鱼缸] meme_import round=… 登记 N 张，跳过 M 个`：M > 0 时逐项原因由 tool 返回给模型
   （符号链接 / 不是文件 / 不是图片 / 太大 / 越界 / 读不到），也可以 `fish.sh log 60` 看上下文。
3. tool 报 `meme_import_master` = 这一轮不是主人触发的，导入只给主人；群友不能借这条路径收本地图。
4. `meme_add` 报 `meme_add_import_outside` = 这张不在**本轮**清单里。清单只活当前 round（换轮、异常、中断都清），
   要重新 `meme_import`；每批最多 50 张，`cursor` 续批，同一轮的清单会合并保留。
5. 看图额度：普通轮 `look` 最多 2 张，导入轮才按清单放宽（上限 50）。被 `/关看图` 关掉时连导入轮也看不了。
6. 重复图按 md5 去重，库里已有同一张就不会再入——这是预期行为，不是丢失。
7. 群里来的 `.gif` 走静默收图轮（日志 `[鱼缸] 收图轮开始/结束 … → 已入库 / 鱼判断不值得收`），这条豁免只限 `inbound/`；
   `meme-inbox/` 里的动图必须走清单，绕不过去。

## 重启 / 补发

启动时会自动 `drain()` 一次，把上次没发出去的消息补上，日志里会有一行 `补发 N 条`。
如果是 0 但群里确实少了消息，看 `var/fish.db` 里 `fish.outbox` 的队列——状态停在 `sending`
的消息是"崩在发送中途"的，按设计不重发。

## 改东西的规矩

- 改 prompt：人格与共享文案只动 `prompt/` 下的 md；工具说明动 `src/tools/<name>/TOOL.md`；改完 `npm run prompts` 确认清单（含 19 个工具包与 eager/deferred），再 `npm test`。
- 加能力：`src/tools/<name>/` 放 `TOOL.md` + `tool.ts`，并在 `src/tools/loader.ts` 的 factory 名单加一行，缺一个都起不来；除 `say` / `react` / `tool_search` 外的新工具默认 deferred，模型先 `tool_search` 搜到才能用。
- 改行为前先想清楚：**prompt（含 TOOL.md）就是这条鱼的全部行为定义**，代码只是它的边界。

## 不要做的事

- 不要为了省事把 `bash` / 通用 `read` / MCP 加回来（见 `AGENTS.md` 第 3 条）。
- 不要手工改 `var/` 里的 `fish.db`：transcript 和 pi-durable 的状态是一体的。
- 不要直接删 `var/sent.json`：那是幂等表，删了会导致崩溃恢复时重复发消息。
- 提交前看一眼 `git status`：`config/auth.json` 不该出现在列表里（它在 `.gitignore`，但别手滑 `git add -f`）。
