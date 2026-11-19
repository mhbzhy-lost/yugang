# 群视频观看与正文兜底退役实施计划

日期：2026-11-19
状态：主会话串行实现已完成，验证通过，待提交与部署

## 目标与交付终态

1. 白名单群发送的 QQ 短视频、以文件方式上传的 MP4 等视频，能以宿主登记的附件引用进入鱼的消息上下文。用户要求观看时，鱼能调用现有 `video` 工具，复用 B 站视频下载后的解码、抽帧、去重和视觉描述流程，得到按时间点排列的画面描述。
2. 同一片苍穹下（184875934）是实际验收群。该群现在的人格为鲸鱼娘；能力对所有白名单群生效，不绑定人格、不修改自由拍拍长。
3. 删除普通 assistant 正文自动补发：无论私聊、被 @ 或其它轮次，没有调用 `say_*` 就不从普通正文生成出站消息。保留零出口轮日志和现有工具出口、宿主工作回执、新闻与画图等明确的机械出口。
4. 实现阶段交付可审阅的代码、文案、验证结果与部署说明。按仓库流程分两个逻辑提交准备；提交、推送、部署是否执行，以用户后续授权为准。本次计划不操作线上配置、不发布群消息。

## 已核实的事实

- 生产机在 2026-11-19 的群列表返回同一片苍穹下 = 184875934。
- 该群今天 17:18:53 的出站消息明确称视频文件看不了，并建议用户发 B 站链接。
- `get_group_root_files` 只读查询能找到《二次元女团MV视频制作.mp4》，大小 4,197,078 字节；`get_group_file_url` 成功返回 HTTPS QQ 下载地址。查询结果的 `upload_time` 为 0，不能据此认定具体上传时间。
- `src/qq/onebot.ts` 当前只将 `video` 段转成截断到 200 字符的 URL 文本；没有处理 `file` 消息段。notice 目前只调戳一戳处理后返回，群文件上传通知不进入消息链。
- 引用消息水合当前只保留文本、图片及分享卡片，因此回复一个视频时也会丢附件。
- `scripts/video-frames.py` 目前强制接收 BV/cid，下载视频轨后用 PyAV 解码、按时间点抽图、缩到 512 宽并做图像去重。
- `src/tools/video/tool.ts` 中已有抽样时间选择、抽帧子进程和 `describeImage` 调用，但与 B 站业务写在同一文件。B 站弹幕、评论、canonical 分享链接及去重登记必须继续保留。
- 普通正文泄漏路径是 `src/app/runtime.ts` 的 `salvagePlainReply()` 及其 settle 后调用；受 `fish.config.json` 的 `salvagePlainReply` 控制，默认 true。它提取 assistant text 首个非空行进入 outbox，语义上无法区分群聊答复与内部自述。
- 工作区已有其它未跟踪实验文件，本任务不修改或纳入它们。

## 产品行为与范围

### 群视频

- 支持直接 `video` 段、视频扩展名的 `file` 段、`group_upload` 视频上传通知，以及直接回复视频消息的引用水合。CQ 字符串形式沿用同一段归一逻辑，避免只覆盖数组消息。
- 视频文件候选扩展名为 mp4、mov、m4v、webm、mkv、avi；扩展名仅用于识别候选，实际是否可解码由 PyAV 判定。普通文档不获得读取能力。
- 入站只登记附件元信息，不自动下载、抽帧或调用视觉模型；查看仍由现有消息策略与 `video` 工具决定。
- 展示如 `[视频 qqvideo:<随机id> 文件名]` 的宿主生成引用。工具增加可选 `ref` 参数；保留现有 `url` 参数，执行时严格要求二者恰好一个。QQ 下载 URL、协议文件 id 和本地绝对路径不提供给模型。
- 文件上传通知进入同一个消息中间件，标记为非 @ 群消息；没有真实 message_id 时不伪造引用锚点，发送者、群号来自协议事件。与实际文件消息同时上报时，按群号和协议文件标识去重，避免两次注入。
- 支持先发视频、再说“看看刚才的视频”：附件元信息进入 recent、背景板、10 秒合并组、自由拍、直接引用链。工具授权只认当前会话已实际见过的附件或本轮注入附件；宿主按 conversationId 维护有界已见引用集合，本轮再绑定一次可读取快照。这样视频先在自由拍出现、随后 @ 请求观看时仍可用，跨群或未见过引用拒绝。
- 初期限制：QQ 单视频最多下载 100 MiB；解码覆盖前 30 分钟，最多 6 帧、宽度不超过 512。没有弹幕的视频使用均匀时间点；沿用相近帧去重。视频过短至少尝试一帧，不因三秒时间点合并规则得到空列表。
- 结果明确说明覆盖范围及关键画面；没有音频理解、台词转写。零帧可描述时返回明确工具失败，不把仅有文件名说成“看过”。部分帧失败可返回成功的帧并说明不完整。
- 既有 B 站预算只约束 B 站请求。QQ 与 B 站成功观看共同消耗每轮视频观看上限；QQ 引用不进入 BV 分享历史，也不产生可供群外转发的下载链接。

### 正文兜底

- 删除函数、调用及专用提取/导入/日志文案，清理已无消费者的参数。`mustAnswer` 等仍参与消息闸或积压处理的状态保留，不能因名字相似一并删除。
- 删除 `FishConfig` 的字段、校验器、受控字段条目、默认值以及 config 工具说明、示例配置。
- 旧本机配置残留该键时按明确退役项忽略并告警，不能导致其它配置失效，也不提供重新开启的执行路径。
- 对尚未发送的旧 `salvage:` outbox 项，部署时需只读检查并报告；本次不擅自修改线上数据库或补发历史内容。

## 文件职责与实现接口

| 文件 | 职责 |
| --- | --- |
| 新增 `src/media/inbound-video.ts` | QQ 视频附件元信息登记、随机引用生成、按群隔离、到期/数量清理、协议来源校验与有界下载。提供 register、按群解析 ref、下载到指定临时目录等窄接口；不接受模型提供的 URL 或路径。 |
| 新增 `src/media/video.ts` | 共用的视频抽样/抽帧/视觉描述层，封装子进程和时间格式。输入为 B 站 BV/cid 或已经受控下载的本地视频；输出 duration、coveredSeconds、成功帧描述及失败统计，不放模型文案。 |
| `scripts/video-frames.py` | 分离来源获取和共用解码函数；增加与 BV/cid 互斥的 `--input` 本地文件模式。返回统一 JSON 对象，包含时长、覆盖时长和帧列表。无显式 timestamps 时按时长在上限内均匀取样；B 站仍可传弹幕峰值时间点。统一短视频、损坏文件、无视频轨与清理行为。 |
| `src/qq/onebot.ts` | 增加视频/视频文件字段归一，处理 video/file/group_upload；通过协议元信息登记 ref。直接引用通过 get_msg 补水合视频附件；新增只供宿主调用的 get_file/get_group_file_url 解析方法，返回值不扩展模型工具面。 |
| `src/qq/model-input.ts`、`src/qq/round-input.ts` | 附件类型及视频标签渲染，直接引用与背景列表一致，文案消费模板。 |
| `src/qq/debounce.ts`、`src/qq/engage-next.ts` | 将附件元信息保留在 recent、burst、shard；不改定时/合并/宵禁规则。 |
| `src/app/runtime.ts` | 组装实际注入附件的 ref 集合，记录 conversationId 的已见集合，并与本轮 submission 绑定可读取快照；本轮绑定在 settle 清理，已见集合按附件 TTL/数量清理。透传受控视频解析依赖。删除正文兜底补发函数和调用，保留零出口观测。入口 `src/index.ts` 不加业务。 |
| `src/tools/types.ts`、`src/fish/types.ts`、`src/fish/tool-surface.ts` | 声明与透传宿主视频读取窄回调，显式传 conversationId/roundId/ref/AbortSignal；缺依赖时拒绝 QQ 视频读取，现有 B 站功能仍可用。 |
| `src/tools/video/tool.ts` | 将 source 分支与 B 站专属元信息分离，调用共用处理层；QQ 分支仅用宿主回调取得的文件，成功获得描述后登记观看数。保留 B 站图文动态与分享行为。 |
| `src/external/video-browse.ts` | 将每轮成功观看资源计数与 BV 专属已看集合区分，QQ 使用带来源前缀的资源 key，轮末统一清理；既有 BV 查询调用保留原语义。 |
| `src/tools/video/schema.json`、`TOOL.md`、`messages.json` | 文档化 url/ref 二选一、群视频使用及结果限制；补充来源不匹配、过大、过期、下载/解码/描述失败等回执。说明与 schema 仍只有工具包这一份。 |
| `prompt/messages.md`、`prompt/runtime.md` | 增加视频附件标签/上传事件模板及群视频引用使用说明；移除 salvage 专用文案及相关陈述。观看策略不改成逢视频必看。 |
| `src/fish-config.ts`、`src/tools/config/TOOL.md`、`fish.config.example`、`scripts/itbed/scenarios/*.json` | 正文兜底字段整体退役；删除现有场景配置中的旧字段，不新增场景或 fixture。本次不新增 fish.config 配置字段，不需要新环境变量或模型凭据。 |
| `AGENTS.md`、`.agents/skills/ops/SKILL.md` | 同步正文永不补发、群视频入口及诊断方式，防止后续维护按旧说明恢复兜底。涉及技能正文维护时先读取 writing-skills 规范。 |

### 协议归一与去重契约

- `group_upload` 消费 `{post_type:"notice", notice_type:"group_upload", group_id, user_id, time, file:{id,name,size,busid}}`；要求群号、发送者、非空 file.id，源数据缺必填项时只记录脱敏原因，不拼造群消息。归一化为 `{kind:"group-file", groupId, fileId:file.id, busid:file.busid, name:file.name, size:file.size}`。
- `message` 的 `file` 段使用 `data.file_id ?? data.id ?? data.file` 作为协议标识，文件名取 `data.name ?? data.file_name`，大小取 `data.file_size ?? data.size`，busid 取真实字段；只有 `data.file` 不是 URL/本地路径且确为协议标识时才允许作为 fileId。文件名也可来自 `data.file`（以 file_id 为身份字段）。群文件统一使用 `get_group_file_url({group_id,file_id,busid?})`，不在入站阶段调用会触发下载的 get_file。绝不把协议返回的宿主本地路径当容器文件直接读。
- `video` 段保留 `data.file` 协议标识及宿主可用的 HTTP(S) URL；观看时优先使用上报直链，缺直链时通过 NapCat 的 `get_file({file})` 获取可用 HTTP(S) 地址。实际协议没有依赖 get_video 这条假定接口。若协议只返回宿主本地路径则明确拒绝，不扩展为容器读宿主文件的能力。video 段本身即视频候选，不要求 URL 带扩展名。
- file/notice 文件名取 name/file_name 或 file 段的文件名；缺失且无法确认视频类型时忽略，不能调用 get_file 预下载任意未知文档来猜类型。video 段可保留空文件名。候选扩展名大小写不敏感，URL 查询参数或内部缓存名不用于猜扩展名。
- 去重键为 `groupId + fileId`，busid 作为可补充路由字段而非第二份附件身份；同群相同文件 id 的 notice/message 在 10 分钟内只注入一次，保留同一个随机 ref。重复上报若携带新的正文或 @，仍保留那条真实正文消息和真实 message_id，只去除重复上传事件；不丢掉用户观看指令。没有稳定共同标识时不按文件名合并，以免把不同视频误删。
- 引用路径对数组和 CQ 字符串使用同一段解析/归一函数，保留真实被引消息 id。notice 无 message_id，只以宿主 arrivalSeq 排序，不进入 quoteIds。

### 共用处理和计数契约

- 解码阶段固定允许的独立容器（MOV/MP4、Matroska/WebM、AVI、M4V），主输入使用已打开的 Python 文件对象。FFmpeg 仅开放 pipe 协议，关闭 MOV 外部数据引用，禁止伪装成视频的播放列表触发额外网络或本地文件读取。

- TypeScript 共用层输入为判别联合 `{kind:"bilibili", bvid, cid, timestamps, maxSeconds:1800}` 或 `{kind:"local", file, maxSeconds:1800, frameCount:6}`，只由宿主构造。
- Python 来源参数互斥：B 站用 `--bvid/--cid`，本地用 `--input`；统一输出 `{durationSeconds, coveredSeconds, frames:[{time,path,width}], failedFrames}`。调用侧与脚本同一改动同步切换，不能出现新脚本输出对象、旧调用侧仍按数组读取。
- B 站保留 BV/cid、最省轨下载、弹幕峰值加均匀采样、热评、图文动态、canonical 链接、video_pool 和现有预算语义；QQ 本地来源不经过 B 站网络适配器。
- 每轮资源计数 key 为 `bili:<BV>` 或 `qq:<ref>`；资源集合和 BV 已看集合分别维护，成功才写入，重复成功观看同一资源不增加计数。只有 B 站成功结果写 BV 集合及标题缓存，QQ 结果只写资源集合。
- `browseWindow/browseTopic`、`quoteIds`、QQ群附件读取快照分开维护；不复用 B 站主动轮字段或引用消息 id 作为文件读取凭据。沿用当前工具由调用侧策略决定观看的规则，不恢复已退役的工具内轮型授权闸。

### 附件登记、读取边界与生命周期

- 元信息存于 `MEDIA_ROOT` 下独立目录，按规范化 base chatKey 分桶；每条元信息使用随机文件名和严格结构，写入原子替换。固定结构至少含 `{version:1,ref,chatKey,groupId,sourceKind,protocolFileId,busid?,name,size?,registeredAt,expiresAt}`，会话已见索引为 `{version:1,conversationId,chatKey,entries:[{ref,seenAt,expiresAt}]}`。读取同时校验版本、群号、会话、文件标识和 TTL，不能仅因文件存在就接受。协议地址只存在宿主元信息中，避免截断签名 URL，也不进入模型输入。
- 元信息保留 24 小时，每群最多 200 项，超限移除最旧项；注册与解析时惰性清理。进程重启后可以继续解析未过期引用；失效 QQ 地址通过原协议文件标识重新取地址。
- ref 必须属于当前群，且为当前 conversation 实际注入过的附件。已见集合按 conversationId 隔离而非仅按群隔离；人格切换不会自动继承其它人格的已见授权。登记模块同时维护宿主专属的有界会话已见索引，在 submission 接受真实输入后、等待模型前记录附件引用；与附件元信息一起持久化并按 24 小时/每会话 200 项清理。重启只恢复该索引与未过期登记元信息的交集，不扫描普通文本标签、摘要或模型正文推导授权。每轮固定授权快照，轮结束清理；元信息存在本身不等于授权。
- 文件名仅展示清洗后的 basename，不能影响落盘路径。拒绝符号链接、目录、路径穿越及真实路径越界。
- 使用宿主窄接口 `registerSeenVideo(conversationId, attachments)`、`snapshotVisibleVideoRefs(conversationId, roundId)`、`resolveVideoForRound(conversationId, roundId, ref, signal)`、`clearRoundVideoSnapshot(roundId)`；解析时同时检查当前轮快照和可信会话索引，并校验协议元信息。首次提交时在接受输入与工具执行之间完成快照绑定；重试轮从同一可信输入刷新绑定。已被 submission 接受的真实输入保留已见状态，模型失败不把它伪装成从未注入；未接受输入不新增授权。
- 下载地址只允许宿主从 QQ 协议元信息取得的 HTTP(S) QQ 官方 CDN；只允许默认 80/443 端口。通过 Node 原生 http/https 请求实现手动重定向，最多三跳，每跳重验 URL、域边界和 DNS 全部 A/AAAA 地址；拒绝回环/私网/link-local/保留地址及映射 IPv6，连接的 lookup 固定返回已校验地址以避免再次解析重绑定。初始域名白名单覆盖实际核实的 QQ CDN：qq.com、qpic.cn、gtimg.com 的域/子域，使用 `host === domain || host.endsWith('.' + domain)` 并校验标准化域名；意外来源报明确错误，不静默放宽。
- 同时校验 Content-Length 与实际流式字节数，100 MiB 达限中止；不整段无界 arrayBuffer。下载、抽帧、描述共用工具取消信号，原工具 90 秒默认总超时保持有效；不为了支持群视频全局放宽超时。
- 刷新协议地址、下载、抽帧和视觉描述共用同一个 AbortSignal。协议 call 本身不支持取消时，新增窄方法将取消关联到 pending 请求移除，不改变其它 call 的语义；禁止仅 Promise.race 后任后台请求继续推进。最终返回和写观看计数前再次检查 signal.aborted；取消不登记观看、不返回成功。已见是输入可见性记录，与成功观看记录分开；取消观看不清掉此前合法已见身份。
- 临时下载文件与抽帧目录放在 `yg-video-*` 内，成功/失败/取消均 finally 清理；失败不持久化新的临时协议地址，清理内存引用。继续保留崩溃遗留目录一小时清理，并排除当前进程活跃作业目录，避免误删。
- 不开放任意 URL/本地路径读取，也不增加 shell 工具。

## 依赖与执行顺序

1. 正文兜底退役是独立修复，先完成代码和配置/文案清理；验证现有零出口观测仍在，形成第一份独立 diff。
2. 建立视频登记与共用解码/描述模块，明确两个来源使用同一份下载后处理。
3. 接入协议 video/file/group_upload 与直接引用水合，打通 recent/burst/shard/轮级 ref 授权。
4. 扩展 video 工具 schema、执行分支与统一观看计数，接入宿主窄依赖；补充所有模型可见文案。
5. 更新维护说明，执行完整验证与独立代码审阅，修复直到两个目标同时达到。群视频功能与兜底修复分别准备提交。

## 验收标准

1. 同一片苍穹下发短视频或上传 MP4 时，消息上下文中出现可用视频 ref；只有文件没有文字也不会当空消息丢弃。
2. 同时出现 message 和 upload notice 时不会重复注入；notice 缺 message_id 时不伪造 QQ ID。
3. 先发视频在自由拍被读到、随后 @ 说“看看刚才的视频”，直接回复视频说“看看”，自由拍包含视频，均能把已见引用传到工具；不同群和切人格不会串附件授权。重启恢复只信宿主持久化的会话已见索引与附件登记交集，摘要和手写标签不能授权。
4. 用真实《二次元女团MV视频制作.mp4》完成协议取址、有界下载、共用抽帧、视觉描述，至少得到一帧非空画面描述；不向 QQ 自动发测试消息。
5. 同一份已下载文件用通用解码函数处理；B 站模式也调用该函数。B 站元信息/弹幕/评论/图文动态/分享白名单及历史去重仍通过既有检查。
6. 超大、过期、伪造 ref、跨群、无视觉模型、坏视频、全帧失败、取消均明确失败；不能返回“成功看过”，不能残留作业或临时文件。
7. 观看数对 QQ 与 B 站合计生效；QQ 观看不污染 BV 集合、分享去重表和 B 站每日预算。
8. 所有轮型的 assistant 普通正文均不再触发 outbox；say_*、工作提示、画图直发等已定义出口保持原行为。旧 salvage 配置不能重新开启补发。
9. `npm test` 与 `npm run prompts` 通过，工具清单没有意外新增，video schema 与工具说明一致。

## 验证方法与命令

遵循当前会话约束：未经明确授权不新增测试、fixture 或压力场景。本计划只运行现有测试，并用已有真实视频做隔离功能验证；不编写额外临时测试驱动来替代这个限制。现有测试未覆盖的新边界，在交付说明中明确列出验证方式与剩余缺口。

- `npm test`：仓库现有全部测试。
- `npm run prompts`：核对 video/config 工具和中心文案；正文兜底文案没有残留，工具总数不变。
- `python3 -m py_compile scripts/video-frames.py`：Python 语法；生成的缓存不纳入提交。
- 在生产同款依赖的隔离临时目录，用真实视频运行 `python scripts/video-frames.py --input <受控下载文件> --out <临时帧目录>`，检查时长、帧数、尺寸与非空 JPEG；再经共用 TypeScript 层调用真实视觉模型。只产生本地临时验证结果，不触发消息发送或写线上 fish.db。
- 对 OneBot 新增入口、群隔离、授权、空文本视频、失败与清理分支做代码路径审阅，并结合已有测试结果与真实视频功能验证报告覆盖范围；不新增内存 WebSocket 驱动、永久或临时测试用例，也不添加 fixture。
- `git1 diff --check` 与指定文件 diff 审阅；核对没有把本机配置、签名下载地址、凭据、媒体文件或无关实验文件纳入改动。
- 用 `rg -n 'salvagePlainReply|salvage_skip|salvage_error|兜底补发' src prompt scripts test fish.config.example AGENTS.md .agents/skills/ops/SKILL.md` 审查残留；只允许退役兼容告警、历史说明和本计划，不能残留配置表/默认值/执行路径；专用函数消失后清理不再使用的 import。
- QQ 视频协议与视觉的只读功能验证属于本任务已授权的调查范围，主会话可经 home-connect 执行；reviewer 子代理的“禁止连接生产”仅限制 reviewer，不是用户对主任务的限制。真实新 group_upload 收件、notice/message 双报去重、CQ 字符串引用、重启恢复若无现有真实触发记录，则明确报告为尚未动态验证，只做代码路径审查，不冒充通过。
- 遗留 outbox 核查使用生产 `~/yugang/var/fish.db` 的只读连接，按活动 conversation 查 queued/sending 的 key 前缀 `salvage:`；输出仅含会话标识、key、状态和数量，不打印正文。生产不可达时明确标记“未核查”，不以本地旧库代替。
- 若后续授权部署：先只读核查 outbox 是否有遗留 salvage 项，再按两个提交发布。因为新增源文件，生产使用 `docker compose up -d --force-recreate fish`；验证只读收件、工具结果与没有正文兜底日志，不主动向群发测试消息。遇到旧 salvage 项先报告具体待处理数量，不直接改库。

## 独立审阅与修订记录

独立 reviewer 于 2026-11-19 完成只读审阅，指出两项阻塞及协议/取消/兼容细节。主会话已作以下修订：

1. 将仅本轮新附件授权改为宿主持久化会话已见索引与每轮不可变快照，明确版本、TTL、群/人格隔离、重启交集校验和失败回滚。
2. 删除所有新增临时消息/WebSocket 测试驱动，只使用既有测试、真实样本功能验证与代码路径审阅。
3. 补充 group_upload/file/video 字段、10 分钟稳定标识去重、引用和缺消息 id 处理。
4. 固定 Python/TypeScript 共用层契约、QQ/BV 两套观看登记与取消时序，明确 Node 逐跳取址和 DNS 固定连接方案。
5. 增加现有 itbed 配置旧字段清理、全仓残留扫描与只读 outbox 报告格式。
6. 区分 reviewer 的禁止生产访问与主会话已获授权的只读调查，明确不能凭代码审查声称真实新收件竞态已验证。

修订后的计划已消除所列阻塞，可供用户选择执行方式；业务实现尚未开始。

## 实施与验证结果

- 正文兜底函数、settle 调用、配置字段和专用文案均已删除；旧键只返回退役告警，零出口日志继续保留。
- QQ video/file/group_upload 和直接引用接入附件登记；video 工具新增 ref，两个来源共用下载后的解码和视觉描述。入站不下载文件；QQ群文件取址使用已验证的 get_group_file_url。
- 真实群样本《二次元女团MV视频制作.mp4》：4,197,078 字节，13.0417 秒，修复解码隔离后再次抽出 6 帧、全部宽 512，真实视觉描述 6/6 成功，完整链路约 9.7 秒。此前首次冷请求约 36.9 秒。
- 真实 B 站样本 BV1GJ411x7h7：212.32 秒，使用共用解码器抽出 6 帧，0 失败；在解码隔离修复后复验通过。
- 现有 npm test：173 项全部通过。npm run prompts、Python 语法和 git diff --check 通过；未新增测试或 fixture。
- 额外 TypeScript 检查：仓库 HEAD 已有 23 类诊断；本次与 HEAD 同参数对比没有新增类型诊断，不能宣称全仓类型检查全绿。
- 生产只读核查：15 个活动 outbox 文档，未发现 queued/sending 的 salvage: 项；未写线上 fish.db、未发 QQ 测试消息、未重启或部署线上鱼。
- 动态覆盖缺口：真实新 group_upload 与 message 双报顺序、CQ 字符串视频引用、新版本重启恢复没有专门触发；以代码审阅和既有测试作核对，不冒充实测通过。协议只提供宿主本地路径而无 HTTP(S) 地址时明确失败，不读取宿主任意路径。
- 独立审阅发现的解码器外部资源读取问题已修复：固定独立容器、主输入文件对象、FFmpeg pipe 协议白名单和关闭 MOV 外部数据引用；真实 QQ 与 B 站视频修复后复验通过。

## 风险与恢复

- QQ 视频下载地址有有效期；登记保留原协议文件标识，读取时刷新地址。仍无法取得则报告附件已过期，不要求用户转存 B 站来掩盖错误。
- 视觉描述与下载可能超过现有工具时限；取消链必须完整，超时即报失败。若真实样本暴露时限不足，再带阶段耗时证据单独讨论，不先调整全局阈值。
- 旧上传 notice 无法从现有原话簿恢复真实 message_id。已经发送的视频可通过只读协议接口取得实际文件作验证，不能伪造一条过去的群消息注入 transcript；发布后的真实收件验收需依赖新收件或用户重发。
- 关闭普通正文补发可能让忘调 say 的必答轮保持沉默，这是本次明确接受的行为；日志用来定位，但不会再拿普通正文补救。
- 恢复群视频功能可回滚其独立提交；正文兜底退役单独提交，视频回滚不应重新打开正文补发。
