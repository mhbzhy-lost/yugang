---
name: config
description: 查看或修改自己的运行配置：fish.config.json 受控字段与 config/models.json 角色表；只有主人在私聊里能用，标「需重启」的改动要重启进程才生效。
---

查看和修改你自己的运行配置，两个能力：fish.config.json 的行为参数、config/models.json 的模型角色表。
只有主人在私聊里发起的轮次才能用，群里调用一律被拒。

- `read`：一次看清两边现状——受控字段的当前生效值（含生效时机）和角色表现状。
- `set`：改 fish.config.json 的一个受控字段，field + value 都必填；只认下面字段表的白名单，
  表外字段和不合法的值都会被拒绝、不落盘。
- `models_list` / `models_switch`：看或切 models 角色表（main / vision / image）；provider 与 model
  必须来自 `models_list` 的结果，别自己拼一个不存在的名字；image 是图片透传通道，模型名不校验。

主人没让改就别自己动。改完回话说清楚改了什么、什么时候生效；标「需重启」的字段
要提醒主人调 restart。每次改动都会留审计日志。

fish.config.json 受控字段白名单（生效时机逐字段标注）：

| 字段 | 类型 | 生效时机 | 说明与取值 |
| --- | --- | --- | --- |
| engagement | 字符串 | 热加载 | 搭话总开关，只认 legacy / next；next 的生效范围还叠加 engage.groups 白名单（开关 & 白名单双闸） |
| engage | 对象 | 热加载 | 自由交流窗口参数，只认八个键：closedMinutes 1–240（closed 分钟）、openMinutes 1–120（open 分钟）、windowSize 1–100（开窗积压注入上限）、mentionContextSize 1–30（@ 轮背景条数）、silenceThreshold 1–50（连续零出口 nudge 阈值）、windowRelaxCap 10–100（零出口超阈值后的积压放宽上限）、shardSeconds 5–120（open 态分片节拍，秒）、groups（群号字符串数组，白名单语义：engagement=next 只对这些群生效，空数组 = 任何群都不进 next，fail-safe）；未知键告警并忽略，全部非法才整块拒绝 |
| ammo | 对象 | 热加载 | B 站弹药管线参数，只认六个键：slots（HH:MM 时点字符串数组，去重保序，缺省 ["09:00","12:00","18:00","24:00"]，24:00 = 当天末尾）、browseMinutes 1–60（单次逛轮硬截止，分钟）、shareChance 0–1（open 窗分享外部弹药的随机门概率，每窗最多 1 条）、ttlHours 1–168（弹药入库后存活时长，小时）、dailyBudget 10–500（B 站每日请求总预算，次）、maxPicksPerRun 1–10（单次逛轮最多入库条数）；未知键告警并忽略，全部非法才整块拒绝 |
| news | 对象 | 热加载 | 新闻播报参数，只认五个键：at（HH:MM 播报时点，缺省 10:30）、targetGroup（纯数字群号，空串 = 不启用；必须是 GROUPS 白名单内的群号，域校验在运行时）、topics（topic 数组，每条只认 name / sources / keywords / exclude 四键，sources 枚举 60s/jiemian/huxiu/ithome/people/zhihu_daily/weibo_hot/baidu_hot，坏 topic 整条剔除并告警，显式给 topics 就整体覆盖缺省五 topic：AI/时政/军事/科技数码/趣闻二次元）、perTopicInput 1–20（每 topic 送模型输入上限，条）、perTopicOutput 1–5（每 topic 输出上限，条）；未知键告警并忽略，全部非法才整块拒绝 |
| ambientMinIntervalSeconds | 数值 | 热加载 | 5–3600，非 @ 消息的最短处理间隔（秒） |
| watchAmbientChance | 数值 | 热加载 | 0–1，特别关注者被搭话的概率 |
| sendPacingSeconds | 数值 | 热加载 | 0–60，出站配速：同会话相邻两条物理消息实际发送的最小间隔（秒），每条消息发送前生效，0 = 关闭 |
| compact | 对象 | 热加载 | 换页阈值：maxEntries 1–5000、maxChars 1000–200000 |
| memeCooldownMinutes | 数值 | 热加载 | 0–240，表情包跨轮冷却（分钟） |
| salvagePlainReply | 布尔 | 热加载 | 必答轮忘调出口工具时的正文兜底开关 |
| voices | 对象 | 热加载 | 人格 → 语音配置：url 必填，referWav / referText / referLanguage / speed（0.5–2）可选 |
| weeklyGroupId | 字符串 | 热加载 | 周报群号（纯数字），空串 = 不发；下次周报触发时按新值执行 |
| thinkingLevel | 字符串 | 需重启 | 思考档位，只认 off / minimal / low / medium / high / xhigh / max |
| toolTimeoutSeconds | 数值 | 需重启 | 5–600，单次工具调用超时（秒） |
