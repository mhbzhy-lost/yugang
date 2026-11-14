---
name: config
description: 查看、探测或修改自己的运行配置：fish.config.json 受控字段与 config/models.json 四角色表；只有主人在私聊里能用，标「需重启」的改动要重启进程才生效。
---

查看和修改你自己的运行配置，两个能力：fish.config.json 的行为参数、config/models.json 的模型角色表。
只有主人在私聊里发起的轮次才能用，群里调用一律被拒。

- `read`：一次看清两边现状——受控字段的当前生效值（含生效时机）和角色表现状。
- `set`：改 fish.config.json 的一个受控字段，field + value 都必填；只认下面字段表的白名单，
  表外字段和不合法的值都会被拒绝、不落盘。field 可以写顶层字段（如 `video`），也可以写点路径
  （如 `video.dailyBudget`、`engage.byGroup.174408629.freeSeconds`）；点路径只改目标子键并保留同块其它配置。
  对象 value 直接传对象或 JSON 字符串都可以，例如 field=`video`、value=`{"dailyBudget":300}`，
  或 field=`video.dailyBudget`、value=300。
- `models_list` / `models_probe` / `models_switch`：看、真实探测或切 models 角色表
  （main / vision / vision_fallback / image）；provider 与 model 必须来自 `models_list` 的结果，别自己拼
  一个不存在的名字。切 main / vision / vision_fallback 前先用 models_probe 探测目标，成功才切换；
  它会发一次最小真实请求，不改角色表，失败就不要切。image 是图片透传通道，不用这个对话探测。
  vision_fallback 是主视觉失败后的兜底，image 切换时模型名不校验。

主人没让改就别自己动。改完回话说清楚改了什么、什么时候生效；标「需重启」的字段
要提醒主人调 restart。每次改动都会留审计日志。

fish.config.json 受控字段白名单（生效时机逐字段标注）：

| 字段 | 类型 | 生效时机 | 说明与取值 |
| --- | --- | --- | --- |
| engage | 对象 | 热加载 | 搭话参数（2026-11-06 起只有自由活动模式，开窗两态已退役），只认五个键：freeSeconds 15–3600（自由拍长，秒，缺省 60——多久进群看一眼；大群可拉到 1200 = 20 分钟）、freeBrowseChance 0–1（空拍的自主开口概率，缺省 0.03，0 = 恒关，宵禁内恒关）、freeBatchMax 1–200（单拍收集上限，条，缺省 50，超出丢最旧并留日志）、answerContextSize 1–100（可选，@ 轮背景条数；不设 = 全量未读补到已读标记，设了 = 最近 N 条再剔已读，受 recent 30 条实际容量约束）、byGroup（对象：群号 → 覆盖参数，键为该群单独覆盖的上述参数，未覆盖键/群回落全局——大群差异化调参的入口）；未知键告警并忽略，全部非法才整块拒绝。搭话群表直接取 .env GROUPS |
| video | 对象 | 热加载 | 视频浏览参数（现行 active 字段），只认两个键：browseMaxViewsPerRound 1–20（单个浏览轮内实际观看视频的次数上限，缺省 5）、dailyBudget 10–500（B 站每日请求总预算，次，缺省 60，热灌共享客户端）；主动门概率在 engage.freeBrowseChance（video.browseChance 已随开窗模式退役删除）；未知键告警并忽略，全部非法才整块拒绝 |
| ammo | 对象 | 热加载 | 已停用的旧 B 站弹药管线兼容字段：仍受理与校验（旧配置不报错），但不再驱动 worker 逛轮/弹药分享；仅 dailyBudget 在 video.dailyBudget 缺省时作回退。旧键：slots / browseMinutes / ttlHours / dailyBudget / maxPicksPerRun / refillTarget |
| news | 对象 | 热加载 | 新闻备料参数，只认六个键：at（HH:MM 开始备料时点，缺省 10:30）、preparationMinutes 1–30（备料窗口分钟数，缺省 10）、targetGroup（纯数字群号，空串 = 不启用；必须是 GROUPS 白名单内的群号，域校验在运行时）、topics（topic 数组，每条只认 name / sources / keywords / exclude 四键，sources 枚举 60s/jiemian/huxiu/ithome/people/zhihu_daily/weibo_hot/baidu_hot，坏 topic 整条剔除并告警，显式给 topics 就整体覆盖缺省五 topic：AI/时政/军事/科技数码/趣闻二次元）、perTopicInput 1–20（每 topic 送模型输入上限，条）、perTopicOutput 1–5（每 topic 输出上限，条）；未知键告警并忽略，全部非法才整块拒绝 |
| sendPacingSeconds | 数值 | 热加载 | 0–60，出站配速：同会话相邻两条物理消息实际发送的最小间隔（秒），每条消息发送前生效，0 = 关闭 |
| compact | 对象 | 热加载 | 换页只按 tokens：maxTokens 1000–1000000（缺省 100000）、byModel（provider 或 provider/model → 阈值，精确模型键优先；google-antigravity 缺省 90000）。完整轮次结束后才换页，不截断消息；旧 maxEntries/maxChars 已停用 |
| memeCooldownMinutes | 数值 | 热加载 | 0–240，表情包跨轮冷却（分钟） |
| salvagePlainReply | 布尔 | 热加载 | 必答轮忘调出口工具时的正文兜底开关 |
| gifAutoCollect | 布尔 | 热加载 | GIF 自动收录开关：缺省 false = 动图同静态图，ambient 轮不附收录标记、meme_add 只收主人点头轮的 inbound 动图；true 才恢复旧自动收行为 |
| drawEnabled | 布尔 | 热加载 | 本地画图总开关（资源闸）：缺省 true；false 时 draw 入口即拒、真正提交前再复核一次，热生效不重启，用来临时让出 GPU。COMFYUI_URL 仍只作连接地址 |
| voices | 对象 | 热加载 | 人格 → 语音配置：url 必填，referWav / referText / referLanguage / speed（0.5–2）可选 |
| weeklyGroupId | 字符串 | 热加载 | 周报群号（纯数字），空串 = 不发；下次周报触发时按新值执行 |
| thinking | 布尔 | 需重启 | 思考开关：false = 关思考，true = 该模型最低可用档。各 provider 的字段差异由 config/models.json 的 thinkingLevelMap 映射；关不掉时启动日志会告警 |
| toolTimeoutSeconds | 数值 | 需重启 | 5–600，单次工具调用超时（秒） |
