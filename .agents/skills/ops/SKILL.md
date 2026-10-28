---
name: yugang-ops
description: 维护「鱼缸」这个 QQ 群机器人时使用：查状态、看原话簿、复盘某天某个群聊了什么、诊断连不上 QQ、以及改动前后的检查清单。用户提到鱼缸、鱼、QQ 机器人、掉线、不说话、群里聊了什么时都应该先加载这个技能。
---

# 鱼缸运维

这个仓库是 `/Users/user/鱼缸`（本 skill 在 `.agents/skills/ops/`，仓库根就是 `../..`）。
所有数据在 `var/`（可用 `YUGANG_HOME` 覆盖）。**先读 `AGENTS.md`**，那里是硬约束。

## 查状态

```bash
node scripts/ops.ts status
```

给出：数据目录、幂等表条数、数据库大小、原话簿有多少天、最近三天每个会话的条数。

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

输出里面有 provider / model / baseUrl / 凭据状态（只显示"已加载 / N 字符"和来源），
以及一次最小补全的耗时和用量。报 `没有拿到 key` 就是 `~/pi-config/pi/auth.json` 里没有这个 provider 的条目。

## 诊断连不上 QQ

```bash
node scripts/ops.ts probe
```

`get_login_info` 超时基本都是：协议端没起、端口不对、token 不对。协议端的 WebUI 登录状态才是唯一可信来源。

## 不说话怎么排查（按顺序）

1. `node scripts/ops.ts digest <今天>` —— 群里有没有消息进来。没有 → 协议端或 WS 断了。
2. 有消息但没出站 —— 看进程日志里的 `[鱼缸]` 行；`这一轮没答上来` 表示模型调用失败。
3. 有 `这一轮没答上来` —— 检查模型 key / 余额 / base_url。
4. 都正常但话少 —— 是闸挡的：`AMBIENT_CHANCE`、`DAILY_QUOTA`、`COOLDOWN_MS`、`QUIET_HOURS`。把 `AMBIENT_CHANCE` 临时调到 1 先确认链路通。
5. 私聊没反应 —— 只认 `MASTER_QQ`，陌生人一律不回。这是设计，不是 bug。

## 改东西的规矩

- 改 prompt：只动 `prompt/` 下的 md；改完 `npm run prompts` 确认清单，再 `npm test`。
- 加能力：一个 `src/tools/<name>.ts` + 一个 `prompt/tools/<name>.md` + 注册一行，缺一个都起不来。
- 改行为前先想清楚：**prompt 就是这条鱼的全部行为定义**，代码只是它的边界。

## 不要做的事

- 不要为了省事把 `bash` / 通用 `read` / MCP 加回来（见 `AGENTS.md` 第 3 条）。
- 不要手工改 `var/` 里的 `fish.db`：transcript 和 pi-durable 的状态是一体的。
- 不要直接删 `var/sent.json`：那是幂等表，删了会导致崩溃恢复时重复发消息。
