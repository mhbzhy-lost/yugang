# 外部信息源实现计划（B 站弹药管线 + 新闻播报管线）v2

> **给执行 agent：** 必须逐任务执行；只有终态全验证通过才算完成。执行方式：Subagent-Driven。**不部署**——完成后停在本地 commit，部署与配置由主人决策。

**目标：** ① 鱼每天四时点自己逛 B 站（游客 API + 营销号三层筛选），把有意思的视频做成小总结存进弹药库，open 窗经随机门每窗最多分享 1 条（b23 链接，URL 由宿主渲染）；② 每天 10:30 取当日新闻（自建 60s + RSS）按主人 topic 归纳，经 say_words 定时播报到指定群。两管线全时尊重宵禁与末条自言禁言。

**架构：** 统一 `src/external/` 模块（scheduler/job runner、bili-client 频控内核、RSS/60s 新闻客户端、不可信数据清洗）；独立后台 worker 会话（新轮类型 `worker`：say_* 机械禁用，模型只提交结构化 AmmoDraft）；弹药库/作业/播报全部 durable doc + 幂等键；分享经 `share.externalAmmoId` 机械绑定 canonical 记录。

**技术栈：** TypeScript / pi-durable docs / OneBot 既有出口 / fast-xml-parser（RSS，受限解析）/ Docker（macmini 上的 60s 服务，部署属运维、不在本计划代码内）。

## 全局约束（继承主线计划全部硬约束）

- 出口唯一族：新闻播报走 scheduled answer 轮的 `say_words`（入 outbox、有 transcript/sentmap 语义），**绝不直调 OneBot**（P0-3 裁定：采用 scheduled 轮方案而非裸 enqueue，保留人格化口吻与既有账本）
- 外部文本（标题/简介/热评/弹幕/RSS）= 不可信数据：统一清洗（长度/控制字符/bidi/URL scheme 白名单 http·https）、独立 `external` 行模板、链接一律由宿主从 canonical record 渲染（P0-5）
- 工具包契约：一目录一工具——`src/tools/bili_hot/`、`src/tools/bili_video/`、`src/tools/ammo_submit/` 分开建包，共享核心在 `src/external/bili-client.ts`（P1-1）
- 安全域：`news.targetGroup` 必须 ∈ `.env GROUPS`，config 工具只能改行为字段不能扩安全域（P1-7）
- 模型可见文案唯一源 prompt/；src/ 无大段字面量
- 不部署、不 commit（各任务产出由主会话统一 commit）

## 已裁定决策（对应审阅的 14 项必须决策）

1. **作业模型**：统一 `src/external/scheduler.ts`（可注入时钟/RNG）；B 站与新闻都是 job；worker 为独立后台会话，不复用群 conversation
2. **人格**：全局抓取池（弹药库 `fish.external_ammo` 会话级 doc、人格中立）；分享措辞由分享轮所在群的当前人格自然人格化
3. **硬截止**：逛轮 10 分钟 = job watchdog 强制收束（取消在途 submission、未提交候选丢弃）；错过时点：启动后当天该 slot 未跑且距其 ≤2h 则补跑一次（幂等 date+slot）
4. **持久存储**：`fish.external_ammo`（items: id/kind:"bili"/bvid/title/summary≤60字/topic/pickedAt/ttlAt/state: available|claimed|shared|expired）、`fish.external_jobs`（date+slot 状态机）、`fish.news_runs`（localDay+targetGroup 幂等，state + digest）
5. **B 站 API 契约**：仅白名单端点 popular/ranking/v2/view/dm list.so/reply main；buvid3 存 `var/bili-state.json`（finger/spi 获取，长期复用）；候选 ID=BV 号（正则校验）
6. **频控内核**：`bili-client` 串行锁 + 同端点 ≥2s 间隔 + 每日总预算计数（持久 `var/bili-budget.json`，缺省 60/天）+ -412/-352 当日熔断该端点；与现有 `video` 工具共用该客户端（P1-3/P2-1）
7. **筛选配置**：`var/bili-filters.json`（硬筛阈值/黑名单正则/软筛权重，mtime 热更新）；规则命中逐条落审计日志（仅元数据）
8. **T13 合并**：ammo 条目 `kind: debt|external`——旧账优先、外部最多 1 条且只占剩余预算；nudge 的 {{n}} 只统计 debt（P1-4）
9. **分享协议**：open 窗生成稳定 windowId，随机门结果窗进入时一次落库；`share` 参数扩展 `externalAmmoId`——校验「本窗门已开 ∧ 该 item available ∧ 本窗未分享过外部」后 claim，URL/b23 由宿主从 doc 渲染进 payload 前缀（P0-2）；v1 仅 `say_words` 一条（文字+canonical 链接），封面后置
10. **新闻发送语义**：scheduled answer 轮（人格=目标群当前人格；额度=该轮 3 次；T15 检查保留：末条自言则推迟，最多 30 分钟，仍自言则放弃当日并记日志——宁少勿扰）
11. **新闻配置**：`news` 块 { at:"10:30", targetGroup, topics:[{name, sources[], keywords[], exclude[]}], perTopicInput≤20, perTopicOutput≤5 }；sources 枚举：60s/jiemian/huxiu/ithome/people/zhihu_daily/weibo_hot/baidu_hot
12. **新闻模型与兜底**：总结用 main（不新增角色）；输出 NewsDigest 严格 JSON schema；全源失败→当日不发+日志；模型失败→重试 1 次后放弃当日；幂等 localDay+group，重复触发不重发
13. **Docker 运维**（部署项，代码侧只做客户端容错）：60s 镜像固定版本 digest、loopback 绑定 4399、restart always、healthcheck；RSS 解析响应 ≤2MB、单源超时 10s、实体展开限制；部署 runbook 写入计划附录，执行属主人部署阶段
14. **媒体边界**：B 站封面（后置功能）存 `mediaRoot/external/bili/<bvid>.jpg`（magic/大小校验、TTL 清理），不伪装成 inbound/（P2-2）

## 整体交付终态

| ID | 必须成立的条件 | 验证方法 | 判据 | 覆盖任务 |
| --- | --- | --- | --- | --- |
| FE1 | scheduler 按配置时点触发 job（四时点+10:30），错过补跑 ≤2h 幂等，硬截止收束；job 状态落 `fish.external_jobs` | 单测式内联验证（可注入时钟） | 时点/补跑/截止/幂等全路径正确 | E1 |
| FE2 | bili-client：白名单端点、串行+端点间隔、每日预算持久、熔断、buvid3 复用；video 工具改走同一客户端不回归 | 内联验证 + npm test 既有 video 回归 | 频控各路径正确；video 行为不变 | E1、E3 |
| FE3 | bili_hot/bili_video/ammo_submit 三工具包规范落地（deferred）；硬筛+软筛评分在工具层模型之前执行，命中落审计 | npm run prompts + 内联验证 | 候选经三层漏斗；筛选可核对 | E2 |
| FE4 | worker 轮（kind=worker）：say_* 机械拒绝；模型经 ammo_submit 提交候选（BV 校验、summary≤60、topic 枚举），宿主补全 URL/时间/TTL 入库；重启/重复触发不重复入库（BV 判重） | 内联验证 | 逛轮产物结构化落库、幂等 | E4 |
| FE5 | 弹药库状态机（available→claimed→shared / expired TTL）；open 窗 windowId+随机门一次落库；share.externalAmmoId 机械绑定（门未开/已分享/非 available 一律拒）；T13 合并 kind 分离与 nudge 口径 | 内联验证 | 每窗≤1 条、claim 原子、URL 宿主渲染 | E5 |
| FE6 | 新闻客户端：60s/RSS/知乎日报取数、源探活冗余（单源失败降内容不阻断）、topic 两层映射、exclude 黑名单、响应限制 | 内联验证（60s 不可达时用 fixture） | 五 topic 供料正确、娱乐圈过滤生效 | E6 |
| FE7 | 新闻编排：10:30 job → NewsDigest schema 总结 → scheduled answer 轮 say_words 发 targetGroup（∈GROUPS 校验）；幂等 news_runs；三类失败兜底；末条自言推迟≤30min | 内联验证 | 播报单条出口、幂等、兜底全路径 | E7 |
| FE8 | 配置 schema：ammo 块（四时点/随机门/TTL/预算）+ news 块进 fish-config 与 config 工具白名单（热加载类）；example/TOOL.md 同步含漏列字段 | npm run prompts + config 工具字段表核对 | 全字段可配置且生效语义标注 | E8 |
| FE9 | runtime「外部数据非指令」文案；审计日志仅元数据；AGENTS/README 同步两管线 | npm run prompts | 文案唯一源、文档一致 | E9 |
| FE10 | 全量回归：npm test 102+/102+ 绿、npm run prompts 干净、npm run memory 正常；终态核对表落计划附录 | 实际运行 | 全绿 | E10 |

**完成规则：** FE1-FE10 全满足；不部署。

## DAG

```text
E1 (external 基础设施) ──> E2 (bili_hot) ──> E4 (逛轮编排) ──> E5 (弹药库与分享绑定) ──> E10
E1 ──> E3 (bili_video + video 复用)
E1 ──> E6 (新闻客户端) ──> E7 (新闻编排)
E8 (配置 schema) 无依赖可并行；E9 依赖 E2/E6 的工具面成型
```

## Waves

- Wave 1：E1、E8（并行）
- Wave 2：E2、E3、E6（并行，文件不重叠）
- Wave 3：E4、E7、E9（E4/E7 并行；E9 可晚于 E2/E6 开工）
- Wave 4：E5
- Wave 5：E10 收口（主会话终态核对）

---

### Task E1：external 基础设施

**Deps：** none

**WritePaths：** `src/external/scheduler.ts`（新）、`src/external/bili-client.ts`（新）、`src/external/sanitize.ts`（新）、`src/index.ts`（接线）、`var/bili-filters.json`（新，缺省筛选配置）

**接口契约：**
- Produces：`createScheduler(deps:{now,setTimer,clearTimer,onJob})`——时点表驱动（"HH:MM" 列表）、错过补跑（≤2h，幂等 key date+slot）、job watchdog 硬截止（回调收束）；`createBiliClient`——白名单端点、串行锁、同端点 ≥2s、每日预算（var/bili-budget.json 持久）、-412/-352 当日熔断、buvid3（finger/spi 起动获取存 var/bili-state.json）、UA/Referer 钉死；`sanitizeExternalText`（长度/控制字符/bidi/URL scheme）；`var/bili-filters.json` 缺省内容（硬筛阈值与正则、软筛权重，按调研报告 A 节）
- Produces：`src/external/jobs.ts`（或并入 scheduler）：`fish.external_jobs` doc 读写

**验收：** 内联验证四路径（时点/补跑/截止/幂等）+ bili-client 频控路径；npm test 绿。

### Task E2：bili_hot 工具包

**Deps：** E1

**WritePaths：** `src/tools/bili_hot/TOOL.md`（新）、`src/tools/bili_hot/tool.ts`（新）、`src/tools/loader.ts`

**接口契约：**
- Produces：工具 `bili_hot`（deferred）：参数 `source: "popular"|"rank"`、`rid?`（常用分区枚举）、`limit 1-20`；实现=榜单取数 → 硬筛一票否决 → 软筛评分排序 → 返回紧凑行式（标题|UP|时长|播放/赞/币|发布相对时间|简介≤60|BV）；多抓 4 倍再筛（防筛空）；已入库 BV 过滤；规则命中审计日志
- 不可信数据全部过 `sanitizeExternalText`；TOOL.md 是唯一模型侧文档

**验收：** npm run prompts 新工具正确列出；内联验证漏斗与审计。

### Task E3：bili_video 工具与 video 复用

**Deps：** E1

**WritePaths：** `src/tools/bili_video/TOOL.md`（新）、`src/tools/bili_video/tool.ts`（新）、`src/tools/video/tool.ts`（改走 bili-client）、`src/tools/loader.ts`

**接口契约：**
- Produces：工具 `bili_video`：参数 `bvid`；返回单条完整卡片 + 可选热评前 5（≤50字/条）+ 可选高能弹幕 top N；UP 评级（card 端点：粉丝/等级/认证）并入软筛展示
- `video` 工具底层 B 站请求改经 bili-client（行为零变化，频控共享）

**验收：** npm test 既有 video 回归绿；内联验证。

### Task E4：逛轮编排（worker 会话）

**Deps：** E2、E3

**WritePaths：** `src/index.ts`、`src/engage-next.ts`（若 windowId 挂此）、`src/tools/ammo_submit/TOOL.md`（新）、`src/tools/ammo_submit/tool.ts`（新）、`src/tools/say-shared.ts`（worker 轮禁言）、`src/tools/types.ts`、`src/harness.ts`、`prompt/messages.md`（worker 触发语文案 key）

**接口契约：**
- Produces：轮类型 `worker`（RoundKind 扩展；say_* 在 worker 轮一律 tool 错误——复用 silentOf 同款机制）；scheduler 四时点（缺省 09:00/12:00/18:00/24:00 可配）起 worker 会话轮：触发语（messages.md key，语义「到点了，去 B 站刷一轮，10 分钟内用 bili_hot/bili_video 挑 1-3 条有意思的，用 ammo_submit 入库」）；worker 会话=独立 conversation（人格中立 doc）
- Produces：工具 `ammo_submit`（仅 worker 轮可用）：参数 {bvid, summary≤60, topic 枚举（二次元/游戏/军事/数码）}；宿主核验 BV 合法、经 bili-client 补全卡片字段、判重（BV 已在库拒绝）、写入 `fish.external_ammo`（ttlAt=pickedAt+48h 缺省可配）
- 硬截止：10 分钟 watchdog 收束（取消 submission，已入库保留）；错过补跑

**验收：** 内联验证全链（触发→工具→入库→判重→截止）；npm test 绿。

### Task E5：弹药库状态机与分享绑定

**Deps：** E4

**WritePaths：** `src/index.ts`、`src/engage-next.ts`、`src/tools/say-shared.ts`、`src/tools/say_words/TOOL.md`、`src/tools/say_words/tool.ts`、`prompt/messages.md`

**接口契约：**
- Produces：open 窗 windowId（稳定派生）+ 随机门结果窗进入时落库（`ammoShareChance` 缺省 0.2）；弹药 TTL 过期清理（惰性）
- Produces：`share` 参数扩展对象形态 `{ ammoId }`（或并列 `externalAmmoId`）：校验「门已开 ∧ item available ∧ 本窗未消费外部 ∧ 时段非宵禁」→ 原子 claim → payload 文本由宿主前缀 canonical `https://b23.tv/…`/BV 链接（模型文本只作推荐语，链接不许模型写）→ 发送成功置 shared
- Produces：T13 合并：`renderAmmoSection` 条目 kind=debt|external，debt 优先、external ≤1 条占剩余预算、nudge {{n}} 只数 debt；external 行独立模板（messages.md key）

**验收：** 内联验证（门/claim/互斥/TTL/合并口径）；npm test 绿。

### Task E6：新闻客户端

**Deps：** E1

**WritePaths：** `src/external/news-client.ts`（新）

**接口契约：**
- Produces：源枚举客户端（60s `http://127.0.0.1:4399`、界面/虎嗅/IT之家/人民网 RSS、知乎日报 API；RSS 用 fast-xml-parser 受限解析：≤2MB、10s 超时、实体限制）；源探活（单源失败降内容不阻断，健康状态内存+日志）；topic 两层映射（sources+keywords 优先、未命中兜底）+ exclude 黑名单（娱乐圈词表）；输出统一 `{title,url,source,publishedAt}` 列表按 topic
- dev dependency：fast-xml-parser（npm i，锁版本）

**验收：** 内联验证（60s 用本地 fixture mock；RSS 真源实测可用则测、不可达走失败路径）；npm test 绿。

### Task E7：新闻编排与播报

**Deps：** E6、E8

**WritePaths：** `src/index.ts`、`prompt/messages.md`（播报模板 key，即外部计划 v1 模板落地）、`prompt/`（总结提示词新文件接 src/prompts.ts）

**接口契约：**
- Produces：10:30 job → 取料（五 topic 缺省）→ main 模型按 NewsDigest 严格 JSON schema 归纳（标题级输入；schema：sections[{topic, items[{summary≤60, sourceRef}]}]，sourceRef=宿主持有的来源索引，URL 不进模型输出）→ 宿主渲染播报文本（模板 key + canonical 链接 + 来源署名）→ scheduled answer 轮（目标群当前人格）say_words 单条出口（≤500 字，超限按 topic 优先级裁剪）
- 幂等 `fish.news_runs`（localDay+targetGroup）；全源失败不发+日志；模型失败重试 1 后放弃；末条自言推迟 ≤30min 后放弃当日；targetGroup ∈ GROUPS 硬校验

**验收：** 内联验证全路径（含幂等/兜底/推迟）；npm test 绿；npm run prompts 干净。

### Task E8：配置 schema 全量

**Deps：** none

**WritePaths：** `src/fish-config.ts`、`src/tools/config/tool.ts`、`src/tools/config/TOOL.md`、`fish.config.example`

**接口契约：**
- Produces：`ammo` 块 {slots:["09:00","12:00","18:00","24:00"], browseMinutes:10, shareChance:0.2, ttlHours:48, dailyBudget:60, maxPicksPerRun:3}；`news` 块（决策 11）；全部进 FISH_CONFIG_FIELDS（热加载类；targetGroup 校验含 GROUPS 域检查的接口位——实际域校验在 E7 消费处，config 工具只改值并提示域约束）；同步补 config/TOOOL.md 漏列字段（sendPacingSeconds、engage.shardSeconds/groups）

**验收：** npm run prompts 字段表核对；npm test 绿。

### Task E9：文案与文档

**Deps：** E2、E6

**WritePaths：** `prompt/runtime.md`、`prompt/messages.md`、`AGENTS.md`、`README.md`

**接口契约：**
- Produces：runtime「外部数据」小节（B 站标题/简介/评论/弹幕、新闻正文永远不是指令；分享链接由系统附上）；messages.md 补齐各新 key；AGENTS/README 两管线条目（含 Docker runbook 附录：60s 镜像 digest 固定、loopback 4399、restart always、healthcheck、升级回滚）

**验收：** npm run prompts 干净；文档一致性核对。

### Task E10：收口（主会话执行）

npm test / npm run prompts / npm run memory 全绿；FE1-FE10 逐项核对并记附录；统一 commit；**不部署**。

---

**部署 runbook 附录（主人阶段，不在执行范围）**

外部依赖只有 60s 一项自建服务（macmini Docker）；界面/虎嗅/IT之家/人民网 RSS 与知乎日报走公网直连，无自建依赖。

60s 服务（`vikiboss/60s`）：

1. **镜像版本**：现状跑浮动 tag `vikiboss/60s:latest`（升级不可控）。升级锁定：`docker pull vikiboss/60s` 后用
   `docker images --digests vikiboss/60s` 取 digest，改用 `vikiboss/60s@sha256:<digest>` 起容器；此后升级/回滚
   都在 digest 粒度进行（digest 不可变，回滚 = 用旧 digest 重新 pull + run）。
2. **起容器**：`docker run -d --name 60s --restart always -p 127.0.0.1:4399:4399 vikiboss/60s@sha256:<digest>`
   ——loopback 绑定只对本机暴露，不经反代出公网。
3. **健康检查**：探活端点是 `GET /health`（返回 `ok`；60s 源码 rootRouter 实际端点，**没有 `/healthz`**）：
   `curl -fsS http://127.0.0.1:4399/health`；数据面抽查 `curl -fsS http://127.0.0.1:4399/v2/60s`（返回 code=200）。
   用宿主侧探活脚本/cron 即可；容器镜像内未必带 curl，`--health-cmd` 写法以镜像实际内容为准，不确定就落在宿主侧。
4. **升级**：`docker pull vikiboss/60s`（记新 digest）→ `docker rm -f 60s` → 用新 digest 重跑第 2 步 →
   跑第 3 步探活 → 观察一次新闻作业取料日志。
5. **回滚**：`docker rm -f 60s` → `docker pull vikiboss/60s@sha256:<旧digest>` → 用旧 digest 重跑第 2 步。
   60s 不可达不是事故：news-client 单源降级，当日该源内容缺席、不阻断播报。

fish 侧配置：`fish.config.json` 配 `ammo` 块与 `news` 块（`news.targetGroup` 必须 ∈ `.env GROUPS`）→
`config` 工具可热调 → 观察 `fish.external_jobs` / `fish.news_runs` 与审计日志。

**新增测试清单（待授权，暂同主线裁定不建）：** scheduler/bili-client 频控/筛选漏斗/ammo 状态机与 claim/news 幂等。
