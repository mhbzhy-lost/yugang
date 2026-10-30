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
scripts/fish.sh memes                # 表情包库状态（收图已改为鱼在对话里 meme_add，没有批量导入）
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
- 换模型不改代码：`MODEL_PROVIDER` / `MODEL_ID`，或改 `config/models.json` 的 `default`

## 诊断连不上 QQ

```bash
node scripts/ops.ts probe
```

`get_login_info` 超时基本都是：协议端没起、端口不对、token 不对。协议端的 WebUI 登录状态才是唯一可信来源。

## 不说话怎么排查（按顺序）

1. `node scripts/ops.ts digest <今天>` —— 群里有没有消息进来。没有 → 协议端或 WS 断了。
2. 有消息但没出站 —— 看进程日志里的 `[鱼缸]` 行；`这一轮没答上来` 表示模型调用失败。
3. 有 `这一轮没答上来` —— 检查模型 key / 余额 / base_url。
4. 都正常但话少 —— 是闸挡的：看 `[fish] gate <chatKey> <昵称> -> skip:sampled_out`（日志现在带 `HH:MM:SS`）。
   `rate_limited` = 限流挡的：同一群两条被处理消息之间至少隔 `ambientMinIntervalSeconds`（默认 60s，热加载）；
   `watched_rate_pass` = 特别关注者安静够久，直接放行；`watched` = 冷却没到但随机门抽中；
   `watched_sampled_out` = 关注者冷却没到且没抽中（`watchAmbientChance`）。
5. 私聊没反应 —— 只认 `MASTER_QQ`，陌生人一律不回。这是设计，不是 bug。

## 语音没声音怎么查

1. `lsof -i :9880` / `:9881` —— TTS 实例在不在；不在就 `launchctl kickstart -k gui/$(id -u)/com.yugang.tts`（或 `.sandrone`）
2. `tail ~/tts/tts.log` 有 `LookupError … Resource 'cmudict' not found` —— **NLTK 数据丢了**：
   `~/tts/GPT-SoVITS/.venv/bin/python -m nltk.downloader -d ~/nltk_data cmudict`
   （缺了会返回 200 + 0 字节空音频，日志里只有一行 `[鱼缸] 语音合成失败`）
3. 鱼日志有 `voice_off` —— 这个会话的人格在 `fish.config.json` 的 `voices` 里没有条目（没配就是没语音，不是 bug）
4. 鱼日志有 `voice_too_long` / `voice_with_media` / `say_media_used` —— 出口闸拦的，看 `prompt/tools/say.md`

## 合集（合并转发）看不了怎么查

- `skip:forward_ignored` = 没 @ 的合集被丢弃（设计如此，只缓存 id 10 分钟）
- 鱼说「看不了」但日志有 `补展开最近合集` = 展开了，内容在 user 消息最前面
- 背景栏里的合集永远是 `[转发合集（内容略）]`：防止连发十条把上下文撑爆，**这是设计**

## 重启 / 补发

启动时会自动 `drain()` 一次，把上次没发出去的消息补上，日志里会有一行 `补发 N 条`。
如果是 0 但群里确实少了消息，看 `var/fish.db` 里 `fish.outbox` 的队列——状态停在 `sending`
的消息是"崩在发送中途"的，按设计不重发。

## 改东西的规矩

- 改 prompt：只动 `prompt/` 下的 md；改完 `npm run prompts` 确认清单，再 `npm test`。
- 加能力：一个 `src/tools/<name>.ts` + 一个 `prompt/tools/<name>.md` + 注册一行，缺一个都起不来。
- 改行为前先想清楚：**prompt 就是这条鱼的全部行为定义**，代码只是它的边界。

## 不要做的事

- 不要为了省事把 `bash` / 通用 `read` / MCP 加回来（见 `AGENTS.md` 第 3 条）。
- 不要手工改 `var/` 里的 `fish.db`：transcript 和 pi-durable 的状态是一体的。
- 不要直接删 `var/sent.json`：那是幂等表，删了会导致崩溃恢复时重复发消息。
- 提交前看一眼 `git status`：`config/auth.json` 不该出现在列表里（它在 `.gitignore`，但别手滑 `git add -f`）。
