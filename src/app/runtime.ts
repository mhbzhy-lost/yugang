/**
 * 鱼缸的运行时装配与实现（2026-11-05 从 src/index.ts 原样搬出）。
 *
 * src/index.ts 只剩注册：消息链、debounce flush、启动/退出钩子都从这里导出，
 * 入口按顺序接线。这里仍是同一个进程级单例（config / onebot / fish / 内存状态），
 * 后续可以按域继续拆（news / commands / rounds / inbound / lifecycle），
 * 拆的时候保持导出面不变即可。
 *
 *   群消息 → 规则闸/打分闸 → conversation.submit() → agent loop
 *                                                      ├── thinking/正文/tool  ✗ 不出境
 *                                                      └── say_* / react / look
 *                                                            → 硬校验 → QQ
 *
 * 模型的正文、思考、tool 调用文本都不在这条链上。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { addFishProvider, createFishModels } from "../model/models.ts";
import { describeModel, loadFishModels } from "../model/config.ts";
import { cleanupStaleVideoTemps } from "../tools/video/tool.ts";
import { isLookDisabled } from "../tools/look/tool.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Conversation, ConversationId, EntryId, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { openFish, SentmapDoc, type Fish, type GroupProfile } from "../harness.ts";
import { OneBot, orderByArrival, type IncomingMessage, type OneBotSendFailure } from "../qq/onebot.ts";
import { DEFAULT_PERSONA_NAME, personaOf, pickVoice } from "../qq/voice-route.ts";
import { createGate, type GateDecision } from "../qq/gate.ts";
import type { ForwardAttachment, ModelMessage } from "../qq/model-input.ts";
import { engageGroupsIncludes, createEngageNext, type EngageBacklogItem, type EngageShardItem } from "../qq/engage-next.ts";
import { engageModeOf } from "../qq/engage-mode.ts";
import {
  createDebouncer,
  withContext,
  DEBOUNCE_WINDOW_MS,
  lastPayload,
  type BurstMessage,
  type PendingBurst,
  type RecentChatMessage,
} from "../qq/debounce.ts";
import { replaceWatched, type WatchedMap } from "../qq/watch-state.ts";
import { MEMORY_ENGAGE_KIND, type CompactResult } from "../compact.ts";
import type { RoundKind, RoundTrigger } from "../tools/types.ts";
import { setLookDisabled } from "../tools/look/tool.ts";
import { clearMemeImportRound } from "../tools/meme_import/shared.ts";
import { hasMemeMd5, md5OfFile } from "../media/meme-store.ts";
import { shrinkForModel } from "../media/shrink-image.ts";
import { absorbSecrets } from "../egress/absorb.ts";
import { resetRun, resetLook, ledgerOf } from "../egress/ledger.ts";
import { validateOutbound, DEFAULT_LIMITS } from "../egress/policy.ts";
import { createChatlog } from "../records/chatlog.ts";
import { localDay } from "../records/usage.ts";
import { weeklyStats, renderWeekly } from "../records/stats.ts";
import { createUsageLedger, sumUsage } from "../records/usage.ts";
import { bypassAllowed, splitBypass, BYPASS_RE } from "../qq/bypass.ts";
import { ChatsDoc, MemoryPendingDoc, WatchDoc } from "../store.ts";
import { renderTemplate } from "../prompt/index.ts";
import { MEMORY_GIF_KIND, MEMORY_INBOUND_KIND, MEMORY_PENDING_CAP, MemoryEvalEntry, buildFeedbackPending, type EvalEventData, type EvalTargetSnapshot, type FeedbackContextItem, type MemoryInbound, parseMemoryCommand, publicizePatch } from "../memory/index.ts";
import { memoryKeyOf, pushScope, shiftScope } from "../memory/scope.ts";
import { beginNewsBroadcastRound, endNewsBroadcastRound, newsBroadcastDelivered, OutboundEntry, stripOutboundLinks, type OutboundPayload } from "../tools/say-shared.ts";
import { createConfigLoader } from "../fish-config.ts";
import { UsageDoc, defineDoc } from "@earendil-works/pi-durable";
// —— 外部信息源基础设施（docs/plans/2026-11-02-external-ammo.md；2026-11-04 模型输入计划 T3）——
// B 站弹药管线（worker 逛轮 / 空库补货 / 手动逛轮 / 全局分享挂点）已停用：旧源码
// （external/scheduler、external/ammo-store、ammo_list / ammo_submit 工具包、say-shared 的
// ammoId 链）保留作兼容，本文件不再接线。仍在的外部管线只有新闻播报（E7）：第二个
// scheduler 实例（news.at 时点，幂等账是 fish.news_runs，不写 external_jobs）。频控客户端见
// src/external/bili-client.ts（仍 active 的 video 工具共用，每日预算改由 video.dailyBudget 灌入），
// 不可信文本清洗见 src/external/sanitize.ts，新闻取料客户端见 src/external/news-client.ts，
// 视频浏览门与 viewed 登记见 src/external/video-browse.ts。
import { createScheduler, nodeTimers } from "../external/scheduler.ts";
import { createNewsClient, type NewsItem, type NewsTopicFeed } from "../external/news-client.ts";
import { sanitizeExternalText } from "../external/sanitize.ts";
import { getBiliClient } from "../external/bili-client.ts";
import { clearViewedVideos, videoBrowseGateOf, wireVideoBrowseHost } from "../external/video-browse.ts";
import { clearSeenLinks, recordSeenLinks } from "../egress/seen-links.ts";
import { shouldSendWorkingReceipt } from "../working-receipt.ts";
import type { Middleware } from "./app.ts";
import { planRoundImages, rewriteRoundForwardImages } from "../qq/round-images.ts";
import { appendAnswerRules, appendVoiceHint, assembleRoundContent, backgroundTextOf, renderBrowseOpportunity, renderGifIngestInput, renderOpenMessageList, renderOpenQuotedText, submitContentOf } from "../qq/round-input.ts";
import { NEWS_BROADCAST_MAX_CHARS, renderNewsBroadcast, renderNewsTask, type NewsDigest, type NewsDigestItem, type NewsDigestSection } from "../external/news-broadcast.ts";

// 每条入站消息的原始文本（卡片渲染 / bypass 剥离之前取）：记忆 entry 只存群友原话，
// 不把 card_bilibili / forward_collapsed 等宿主文案写进 fish.inbound。WeakMap 键是消息对象，
// flush 时按 anchor 取回，消息对象丢弃后条目自动回收。
const rawMemoryText = new WeakMap<IncomingMessage, string>();

/** 记忆用原始文本：去掉 [卡片#N] 占位与 bypass 指令，只留普通群友原话。 */
function memoryTextOf(text: string): string {
  const noCards = text.replace(/\[卡片#\d+\]/g, "");
  const m = BYPASS_RE.exec(noCards);
  return (m ? noCards.slice(0, m.index) : noCards).trim();
}

// chatKey → 昵称 → QQ 号：memory scope 要把背景里最近发言的人映射成 subject。
// 每条入站消息（含被闸挡掉的）都登记，登记得越全，映射越准。
const nameToQq = new Map<string, Map<string, string>>();

// 日志一行一个时间戳：gate 判定与发送记录以前没有时间，排查只能靠原话簿对齐
{
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const rawLog = console.log.bind(console);
  const rawError = console.error.bind(console);
  console.log = (...args: unknown[]) => rawLog(`[${stamp()}]`, ...args);
  console.error = (...args: unknown[]) => rawError(`[${stamp()}]`, ...args);
}

const ctx = BACKGROUND_CONTEXT;

// 可热更新的行为配置：fish.config.json > .env > 内置默认
const fishConfig = createConfigLoader();

// 收表情包等后台轮：这一轮只允许调工具，不许说话（say_* 会拒绝）
const silentRounds = new Set<string>();

// 会话 id → 映射键（chatKey 或 chatKey#人格）。chatKeys 存的是剥离人格的 base 键
// （emit 要解析数字 id），人格相关的配置（音色）必须走这张表，否则重启后
// 人格身份丢失 → personaOf 回退「默认」→ 拿默认音色开口（长征机用爱莉声音说话）
const mappingKeys = new Map<string, string>();

/**
 * 六个重耗时工具的「正在执行」文案（prompt/messages.md 的 working_*）：逐个显式取，
 * key 拼错只会拿到空文案不发，不报错。
 */
function workingTextOf(tool: string): string {
  switch (tool) {
    case "video": return fish.prompts.messages["working_video"] ?? "";
    case "draw": return fish.prompts.messages["working_draw"] ?? "";
    case "gpt_image": return fish.prompts.messages["working_gpt_image"] ?? "";
    case "meme_import": return fish.prompts.messages["working_meme_import"] ?? "";
    case "meme_add": return fish.prompts.messages["working_meme_add"] ?? "";
    case "restart": return fish.prompts.messages["working_restart"] ?? "";
    default: return "";
  }
}

/** 主人或这个群特别关注的人？（机械匹配 QQ 号，不看模型怎么说） */
function isVoiceVip(chatKey: string, userId: number | undefined): boolean {
  if (userId === undefined) return false;
  if (String(userId) === config.master) return true;
  return watchedByChat.get(baseChatKey(chatKey))?.has(String(userId)) ?? false;
}

/**
 * chatKey（可能带人格后缀）→ 该会话的语音配置。
 * 只有 fish.config 的 voices 里明确配了这个人格，才有语音能力——没有兜底。
 * 兜底就是串音：任何没配音色的人格都会去用默认音色（长征机用爱莉声音开口）。
 */
function voiceConfigFor(chatKey: string): { url: string; referWav?: string; referText?: string; referLanguage?: string } | undefined {
  return pickVoice(fishConfig().config.voices, chatKey);
}

// 特别关注：chatKey（不含人格后缀）→ userId → 备注。随机门用它提高被关注者的概率，
// 进模型前用它在那个人说话的那一行打标记，主动 @ 的身份闸也读它。
// 启动时从文档装载，watch 工具变更后即时**整份替换**（增量合并会让 remove 撤不掉）。
const watchedByChat = new Map<string, WatchedMap>();
function applyWatched(chatKey: string, people: { userId: string; name?: string; note: string }[]): void {
  // 主人不入特别关注名单（F9，双保险第二层）：watch add 已拒，装载/变更时再滤一次，
  // 旧文档里的脏数据也拦在镜像外。过滤后为空的群照常删 key（整份替换语义不变）。
  const kept = config.master ? people.filter((p) => p.userId !== config.master) : people;
  // 空名单会直接删 key：否则「这个群有特别关注」永远为真
  replaceWatched(watchedByChat, baseChatKey(chatKey), kept);
}

// 运行时数据目录：默认仓库 var/（按本文件位置解析，不依赖 cwd）；YUGANG_HOME 设置时完全胜出
const HOME = process.env.YUGANG_HOME ?? join(import.meta.dirname, "..", "var");
mkdirSync(HOME, { recursive: true });

cleanupStaleVideoTemps(); // 清掉上次被打断的抽帧临时目录（正常路径在 finally 里删）

const modelSelection = loadFishModels();

const config = {
  onebotUrl: process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001",
  onebotToken: process.env.ONEBOT_TOKEN,
  // 模型与凭据：只认 config/models.json 的 models 角色表 + 同目录 auth.json，见 src/model-config.ts
  modelConfig: modelSelection.main,
  mediaRoot: resolve(process.env.MEDIA_ROOT ?? join(HOME, "media")),
  promptRoot: resolve(process.env.PROMPT_ROOT ?? join(process.cwd(), "prompt")),
  workspaceRoot: resolve(process.env.WORKSPACE_ROOT ?? join(HOME, "workspace")),
  master: process.env.MASTER_QQ ?? "",
  groups: (process.env.GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  bypassGroups: (process.env.BYPASS_GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // 周报群：每周日 21 点把这一周的群画像发到这个群（留空 = 不发）
  weeklyGroupId: process.env.WEEKLY_GROUP_ID ?? "",
};
mkdirSync(config.mediaRoot, { recursive: true });

const models = createFishModels(modelSelection.main);
// 视觉模型可能是另一个 provider（例如主体走 codex 订阅、识图仍用 glm）：
// 把它也挂进同一个 Models，否则 getModel 拿不到 → 看图直接判「服务不稳」
if (modelSelection.vision.providerId !== modelSelection.main.providerId) {
  addFishProvider(models, modelSelection.vision);
  console.log(`[鱼缸] 视觉模型 provider 已挂载：${modelSelection.vision.providerId}/${modelSelection.vision.modelId}`);
}
// 视觉兜底同理：主视觉失败/被内容审核拒时换它再试一轮；不配就没有兜底
if (modelSelection.visionFallback
  && modelSelection.visionFallback.providerId !== modelSelection.main.providerId
  && modelSelection.visionFallback.providerId !== modelSelection.vision.providerId) {
  addFishProvider(models, modelSelection.visionFallback);
  console.log(`[鱼缸] 视觉兜底 provider 已挂载：${modelSelection.visionFallback.providerId}/${modelSelection.visionFallback.modelId}`);
}
const mainModel = { provider: modelSelection.main.providerId, modelId: modelSelection.main.modelId };
const visionModel = { provider: modelSelection.vision.providerId, modelId: modelSelection.vision.modelId };
const visionFallbackModel = modelSelection.visionFallback
  ? { provider: modelSelection.visionFallback.providerId, modelId: modelSelection.visionFallback.modelId }
  : undefined;

/** 搭话判定的唯一入口（next-only，2026-11 起）：该会话是否为 GROUPS 白名单群。
 *  gate / 状态机 / runtime 裁剪 / in-flight 登记全部走这里，不许各自判断；
 *  私聊与 worker 会话恒 false（不登记在途，runtime 的窗口协议小节照旧裁掉）。 */
function engageNextOf(chatKey: string): boolean {
  return engageGroupsIncludes(config.groups, chatKey);
}

/** 该群是否走自由活动模式（engage.freeGroups ∩ .env GROUPS，运行侧再滤一次域外群号）。
 *  只影响节拍与 prompt 裁剪，不收窄 engageNextOf（在途登记仍按 GROUPS 全量，否则 busy 恒 false）。 */
function freeModeOf(chatKey: string): boolean {
  return engageModeOf(chatKey, fishConfig().config.engage.freeGroups, config.groups) === "free";
}

// inline 直读开关（docs/plans/2026-11-01-inline-vision.md）：主/视觉同模型且通道在白名单。
// 白名单＝「确认能收 image block 的 api」：两个 Gemini 订阅通道真机验证过；
// openai-completions（zai/deepseek 等，pi-ai 映射为 image_url）2026-11-02 经主人决定
// 放开——describe 路径本就向该通道发 image_url，且附图已压到 ≤50KB；codex 适配器
// 不支持图片输入，保持排除。/关看图 同时关掉 inline 附图，开关每轮现算（可在线切换）
const INLINE_IMAGE_APIS = new Set(["google-code-assist", "antigravity-code-assist", "openai-completions"]);
const inlineVisionOn = (): boolean =>
  !isLookDisabled()
  && modelSelection.vision.providerId === modelSelection.main.providerId
  && modelSelection.vision.modelId === modelSelection.main.modelId
  && INLINE_IMAGE_APIS.has(modelSelection.main.api);

export const onebot = new OneBot(config.onebotUrl, config.onebotToken, config.mediaRoot, {
  // 出站配速下沉到 onebot 发送层（终验 #3）：每条物理消息实际发送前按会话等待，
  // 热读取 fishConfig（改配置下一拍生效）；0 = 关闭
  pacingSeconds: () => fishConfig().config.sendPacingSeconds,
  // 末条自言标记（决策 24，终验 #7）的置位错点 = 每条物理消息实际发送成功（不是整个 emit
  // 完成）：部分成功（文本发了、图挂了）也置 true——任一条成功即置位，末条至少有一条是鱼的话
  onSent: (chatKey) => lastWasFish.add(chatKey),
});
const chatlog = createChatlog(join(HOME, "chatlog"));
const usage = createUsageLedger(join(HOME, "usage"));

// 幂等表：崩溃重放时不重复发同一句
const sentPath = join(HOME, "sent.json");
const sent = new Set<string>(existsSync(sentPath) ? (JSON.parse(readFileSync(sentPath, "utf8")) as string[]) : []);
function markSent(key: string): boolean {
  if (sent.has(key)) return false;
  sent.add(key);
  writeFileSync(sentPath, JSON.stringify([...sent].slice(-5000)));
  return true;
}

// conversationId → 所在会话（剥离人格），用来做引用和贴表情
const chatKeys = new Map<string | number, string>();
// 换页（自动 / 手动 `/压缩`）中的会话：期间不受理新提交，被@只回机械忙碌语
const compacting = new Set<string>();
// 静默收图轮在跑的会话：同一会话不许并发提交 / 不许换页（两条路径共用 conversationBusy）
const ingestRounds = new Set<string>();
// 会话忙（换页 / 静默收图轮 / next 在途轮）的判定：起新提交与起换页前都要先看它。
// 在途轮登记见 nextInFlight（shard 到期与开窗注入据此退避，同一会话绝不并发提交）。
function conversationBusy(id: string | number): boolean {
  const key = String(id);
  return compacting.has(key) || ingestRounds.has(key) || nextInFlight.has(key);
}

// ── 携话 next（开窗两态）的轮级互斥（决策 8 + shard 修订）─────────────────
// 在途轮登记：conversationId → 在途轮的 kind 集合。submit 前登记、settle 的 finally 释放；
// 仅 GROUPS 群聊登记（私聊 / worker 会话不登记，行为与历史一致）。@ 轮（answer）也登记——
// shard 到期与开窗注入据此退避，不与必答轮并发；但 @ 轮自己的等待队列只等 ambient/injection
// 清零（两个必答轮并发提交是既有行为，不引入排队）。
const nextInFlight = new Map<string, Set<RoundKind>>();
// 等待在途 ambient/injection 轮清零的 @ 轮唤醒器：清零（或超时）时逐个唤醒
const ambientWaiters = new Map<string, Set<(ok: boolean) => void>>();
const EMPTY_KINDS: ReadonlySet<RoundKind> = new Set();

function registerInFlight(id: string | number, kind: RoundKind): void {
  const key = String(id);
  const kinds = nextInFlight.get(key) ?? new Set<RoundKind>();
  kinds.add(kind);
  nextInFlight.set(key, kinds);
}

function releaseInFlight(id: string | number, kind: RoundKind): void {
  const key = String(id);
  const kinds = nextInFlight.get(key);
  if (!kinds) return;
  kinds.delete(kind);
  if (kinds.size === 0) nextInFlight.delete(key);
  // 在途 ambient/injection 清零才唤醒等待的 @ 轮（其它在途 @ 轮不阻塞它们）
  if (!kinds.has("ambient") && !kinds.has("injection")) {
    const waiters = ambientWaiters.get(key);
    if (waiters) {
      ambientWaiters.delete(key);
      for (const wake of waiters) wake(true);
    }
  }
}

function hasAmbientInFlight(id: string | number): boolean {
  const kinds = nextInFlight.get(String(id)) ?? EMPTY_KINDS;
  return kinds.has("ambient") || kinds.has("injection");
}

/** @ 轮等待在途 ambient（shard）/ injection 轮清零：上限 timeoutMs，超时返回 false（转 busy_reply）。 */
async function waitAmbientClear(id: string | number, timeoutMs: number): Promise<boolean> {
  const key = String(id);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!hasAmbientInFlight(key)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const woken = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const waiters = ambientWaiters.get(key);
        if (waiters) {
          waiters.delete(finish);
          if (waiters.size === 0) ambientWaiters.delete(key);
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), remaining);
      const waiters = ambientWaiters.get(key) ?? new Set<(ok: boolean) => void>();
      waiters.add(finish);
      ambientWaiters.set(key, waiters);
    });
    if (!woken) return false;
  }
}

// ── 已读标记（决策 20）─────────────────────────────────────────────
// conversationId → 最后一条进入模型输入的消息 arrivalSeq。内存态（重启即无＝什么都
// 没看过，不会把没看过的当已读）；所有把群消息注入模型输入的路径统一维护：
// injection backlog / shard 轮注入后推进、@ 轮整组（burst 本体）照常注入并推进；
// 背景板去重（先取 N 再剔已读）由 T5 接入（withContext 的 seenSeq，flushBurst 对群轮恒传）。
// @ 轮整组不属背景板，不受标记影响。
const lastSeenByModel = new Map<string, number>();

function seenSeqOf(id: string | number): number {
  return lastSeenByModel.get(String(id)) ?? 0;
}

function advanceSeenSeq(id: string | number, seq: number | undefined): void {
  if (seq === undefined) return;
  const key = String(id);
  if (seq > (lastSeenByModel.get(key) ?? 0)) lastSeenByModel.set(key, seq);
}

/** 一批消息里最大的 arrivalSeq（推进已读标记用）。 */
function maxArrivalSeq(messages: readonly { arrivalSeq?: number }[]): number | undefined {
  let best: number | undefined;
  for (const message of messages) {
    if (message.arrivalSeq !== undefined && (best === undefined || message.arrivalSeq > best)) best = message.arrivalSeq;
  }
  return best;
}

/** 本轮注入窗口的合法引用目标（T4 quoteMsgId 消费）：渲染处现算的 [m:id] 集合。 */
function quoteIdsOf(messages: readonly { messageId?: number | string }[]): Set<string> {
  return new Set(messages.flatMap((m) => (m.messageId !== undefined ? [String(m.messageId)] : [])));
}

// ── 末条自言标记（决策 24，T15）─────────────────────────────
// chatKey → 群里最新一条消息是否鱼自己发的。内存态：emit 实际发送成功置 true，
// 任一入站消息置 false，重启归 false（宁松勿严）。ambient/injection 环境轮的出口校验
// 经 lastWasFishOf 读它；answer 轮豁免（有人 @ 必有入站，标记已翻 false）。
const lastWasFish = new Set<string>();

const lastMention = new Map<string, boolean>();
// 本轮触发是否是回复某条消息：是则鱼的回应强制引用（回复链可读性）
const lastReply = new Map<string, boolean>(); // 最近一次触发是否@了鱼：被@必回引用，让群里看得出鱼在回谁
// submissionId → 本轮触发消息（含轮类型 kind 与 quoteIds 窗口）：把引用目标绑在轮上，
// 不被后续消息顶掉；userId 是主动 @ 身份闸的唯一依据（不靠模型文本推断关系）。
// kind：answer = 必答 / 私聊轮；ambient = open 窗 shard 轮；injection = 开窗
// 积压注入轮（后两者无锚点消息）。quoteIds = 本轮注入窗口的消息 id（T4 quoteMsgId 消费），
// settle 的 finally 里随轮清除。
const triggerOf = new Map<string, RoundTrigger>();
// submissionId → 本轮触发消息自带的 bypass 段；仅该轮 draw 可见，轮 settle 即删
const bypassOf = new Map<string, string>();
// submissionId → 本轮 say_* 被调用的次数：识别「零出口轮」（模型裸文本回复，正文不出境，聊天对象零输出）。
// 与 triggerOf 同生命周期：submit 后置 0，settle 的 finally 里删，成功/失败/抛错都不泄漏；
// 只累计已登记的轮，收图轮等不经 submitRound 的提交不会留下孤儿条目。
const sayCalled = new Map<string, number>();
// submissionId → 本轮所在会话：重耗时工具的「正在执行」机械提示要落回当前会话的 outbox。
// 与 triggerOf 同生命周期：submitRound 登记轮的会话，settle 的 finally 里删；
// 收图轮等不经 submitRound 的提交不登记，这类轮本就不许说话，提示也天然不发。
const roundConv = new Map<string, Conversation>();
// 轮内去重：roundId → 本轮已发过提示的工具集合，「同轮同工具只发一次」在这里保证；
// 与 roundConv 同生命周期，settle 的 finally 里整份删。
const workingSent = new Map<string, Set<string>>();
// 窗口键（chatKey\0发送者）→ 本组是否有「必答」放行（private/mentioned）。
// gate 逐条放行时累积，flushBurst 整组消费并清掉：正文兜底只补必答轮——环境轮（free_pass）
// 零 say_* 的正文多是内心独白，是当年删兜底时的误发重灾区，只留零出口轮日志。
const burstMustAnswer = new Map<string, boolean>();

/** 与 debouncer 一致的窗口键：群 + 发送者唯一确定一个待定组。 */
function windowKey(chatKey: string, userId: number): string {
  // 与 debouncer 一致的窗口键：群 + 发送者唯一确定一个待定组（拼接式：模板内含 \u0000
  // 反斜杠会让 prompt-lint 的栅栏号配对错位，全文件陷入幻影字面量相，见 test/prompts）
  return chatKey + "\u0000" + userId;
}

/** 必答放行原因：只有以这些原因进闸的轮才允许正文兜底补发。 */
const MUST_ANSWER_REASONS: ReadonlySet<string> = new Set(["private", "mentioned"]);
const conversations = new Map<string, Conversation>();

let fish!: Fish;

export async function bootRuntime(): Promise<void> {
  fish = await openFish({
  storage: await openNodeSqliteStorage(join(HOME, "fish.db")),
  models,
  model: mainModel,
  // 思考档位：off|minimal|low|medium|high|xhigh|max。最低可用思考档是 low
  // （deepseek 的 minimal 映射为 null，等于不支持），缺省 off
  thinkingLevel: fishConfig().config.thinkingLevel,
  toolTimeoutSeconds: fishConfig().config.toolTimeoutSeconds,
  // 重耗时工具单独放宽：say_voice 要等 GPT-SoVITS 合成（默认超时 120s，覆盖 250s 含空响应重试一次的最坏 240s），
  // video 要下视频、抽帧、逐帧过视觉模型；全局 toolTimeoutSeconds 保持 30 不动
  toolTimeoutOverrides: { say_voice: 250, video: 90, gpt_image: 210 },
  // codex 订阅走 WebSocket（Node 的 WS 不吃 --use-env-proxy），过代理时在 main provider 写 transport: "sse"
  ...(modelSelection.transport ? { streamTransport: modelSelection.transport } : {}),
  // 表情包跨轮冷却：每个人格会话独立计时
  memeCooldownMs: () => Math.round(fishConfig().config.memeCooldownMinutes * 60_000),
  // 语音：按会话所在人格取配置（只认 fish.config 的 voices，没配就是没有语音）
  ttsOf: (conversationId) => voiceConfigFor(mappingKeys.get(String(conversationId)) ?? ""),
  // look / video 的视觉描述模型：models.vision；省略时与 models.main 相同
  visionModel,
  // 视觉兜底：models.vision_fallback；省略 = 无兜底
  ...(visionFallbackModel ? { visionFallbackModel } : {}),
  promptRoot: config.promptRoot,
  mediaRoot: config.mediaRoot,
  // 搜索凭据：与模型凭据同源（config/auth.json 的 deepseek 条目），缺了工具会以可读错误回应
  searchKey: (() => {
    try {
      return (JSON.parse(readFileSync("config/auth.json", "utf8") as { deepseek?: { key?: string } }).deepseek?.key) ?? undefined;
    } catch {
      return undefined;
    }
  })(),
  // gpt_image 通道：models.image 省略 = 该工具不可用（不隐式兜底模型名）
  gptImage: modelSelection.image
    ? {
        authPath: modelSelection.main.credentialsPath,
        provider: modelSelection.image.provider,
        model: modelSelection.image.modelId,
        ...(modelSelection.image.proxy ? { proxy: modelSelection.image.proxy } : {}),
      }
    : undefined,
  // config 工具写回 models 角色表用同一份文件
  modelsPath: modelSelection.main.configSource,
  // config 工具判定「主人私聊轮」用：与 chatKeyFor 同源（两种历史键写法都认）
  chatKeyOf: (conversationId) => chatKeyFor(conversationId),
  selfOf: (conversationId) => {
    const mapping = mappingKeys.get(String(conversationId)) ?? chatKeyFor(conversationId) ?? "";
    const persona = personaOf(mapping);
    return {
      nickname: persona === DEFAULT_PERSONA_NAME ? "Elysia" : persona,
      userId: onebot.selfId > 0 ? String(onebot.selfId) : "",
    };
  },
  sdUrl: process.env.SD_WEBUI_URL,
  // （sdUrl 存在时见启动处的邻居保温定时器）
  tagsCsv: join(HOME, "danbooru.csv"),
  master: config.master,
  triggerOf: (roundId) => triggerOf.get(String(roundId)),
  silentOf: (roundId) => silentRounds.has(String(roundId)),
  // 搭话模式（决策 18 + 自由活动模式）：next 保留「自由交流窗口」段、free 保留「自由活动群」段、
  // legacy（私聊 / worker / 群外会话）两段都裁掉；判定与自检脚本共用 engageModeOf
  engagementOf: (chatKey: string) => engageModeOf(chatKey, fishConfig().config.engage.freeGroups, config.groups),
  // 出口计数：say_* 的 execute 进入即回调；未登记的轮（收图轮）直接忽略，不留孤儿计数
  onSayCall: (roundId) => {
    const key = String(roundId);
    const count = sayCalled.get(key);
    if (count !== undefined) sayCalled.set(key, count + 1);
  },
  // 重耗时工具（video/draw/gpt_image/meme_import/meme_add/restart）execute 入口的机械提示：
  // 本轮第一次调用时经 outbox 唯一出口发一条拟人文案（prompt/messages.md 的 working_*），
  // 幂等键 working:<tool>:<submissionId> 防崩溃重放；拿不到轮标识或会话映射就不发、不报错。
  // restart 返回 Promise：工具会 await 它，保证提示在进程退出前入队并冲一次 outbox。
  onLongWork: (tool, submissionId) => {
    const round = submissionId === undefined || submissionId === null ? "" : String(submissionId);
    const conv = round === "" ? undefined : roundConv.get(round);
    const text = workingTextOf(tool);
    if (!round || conv === undefined || !text) return;
    // 回执只给正在等的人：自由交流 / 开窗注入 / 自己逛的轮里没人问，冒一句「稍等」像自言自语
    if (!shouldSendWorkingReceipt(triggerOf.get(round)?.kind, tool)) return;
    const sentTools = workingSent.get(round);
    if (sentTools?.has(tool)) return; // 同轮同工具只发一次
    if (sentTools) sentTools.add(tool);
    else workingSent.set(round, new Set([tool]));
    // 幂等键：崩溃重放不重复发（key 进 outbox 与 sent.json，宿主侧防重放）
    const payload = {
      items: [text],
      at: Date.now(),
      key: `working:${tool}:${round}`,
    };
    if (tool === "restart") {
      // restart：重生窗口内必须先入队再冲一次 outbox；失败只打日志，不阻塞重启
      return (async () => {
        try {
          await fish.enqueue(conv.id, payload);
          await drainLoop();
        } catch (error) {
          console.error("[fish] working send failed", error instanceof Error ? error.message : error);
        }
      })();
    }
    // 其余五个工具 fire-and-forget：入队完成后立即冲一次 outbox，失败只打日志
    void fish.enqueue(conv.id, payload)
      .then(() => drainLoop())
      .catch((error: unknown) => console.error("[fish] working drain failed", error instanceof Error ? error.message : error));
  },
  // watch 的号码校验：从会话映射回群号，再拉全量成员（不要 limit，要能校验到每个人）
  onWatchChanged: (conversationId, people) => {
    const chatKey = chatKeyFor(conversationId);
    if (!chatKey) return;
    // 整份替换：删掉的人（含已退群、watch remove 掉的）立刻失去主动 @ 权限与打标
    applyWatched(chatKey, people);
  },
  // 主动 @ 的身份闸（机械判定，按轮类型，决策 7）：私聊没有 @ 这回事。answer 轮
  // userId 是本轮触发者——只有主人或本群特别关注者「被点名」时可 @（语义零变化）；
  // ambient/injection 环境轮没有锚点身份，出口层对每个 @ 目标各调一次、userId 携带的是
  // 目标 QQ，白名单同为 {主人} ∪ 本群 watched——这是接受的放宽面（open 窗内普通群友可诱导
  // 鱼 @ 主人/watched），放行与越界拒绝都记审计日志。成员名单校验在出口层照旧。
  mentionPolicyOf: (conversationId, userId, kind) => {
    const chatKey = chatKeyFor(conversationId);
    if (!chatKey || !chatKey.startsWith("qq:group:")) return "not_group";
    if (userId === undefined) return "not_privileged";
    const id = String(userId);
    const allowed = (config.master && id === config.master)
      || (watchedByChat.get(baseChatKey(chatKey))?.has(id) ?? false);
    if (kind === "ambient" || kind === "injection") {
      console.log(`[鱼缸] 审计 ${chatKey} ${kind} 轮 @ ${id} → ${allowed ? "白名单" : "名单外"}`);
    }
    return allowed ? "allow" : "not_privileged";
  },
  // 末条自言标记（决策 24）的读取口：say_* 的 ambient/injection 轮据它判定「群里最新一条
  // 是不是鱼自己发的」，是则只放行带 share 的素材分享。标记由 emit/入站两处维护（见上）。
  lastWasFishOf: (conversationId) => {
    const chatKey = chatKeyFor(conversationId);
    return chatKey !== undefined && lastWasFish.has(chatKey);
  },
  groupMembersOf: async (conversationId) => {
    const chatKey = chatKeyFor(conversationId);
    if (!chatKey || !chatKey.startsWith("qq:group:")) return [];
    const groupId = Number(chatKey.slice("qq:group:".length));
    if (!Number.isFinite(groupId)) return [];
    return onebot.groupMembers(groupId, 10_000);
  },
  bypassOf: (roundId) => bypassOf.get(String(roundId)),
  workspaceRoot: config.workspaceRoot,
  compact: {
    model: mainModel,
    maxEntries: fishConfig().config.compact.maxEntries,
    maxChars: fishConfig().config.compact.maxChars,
    limits: () => fishConfig().config.compact,
  },
  // outbox 里的消息由 fish.drain() 逐条交给这里；幂等表再加一层保险。
  // 发送链记账（T6，/评 定位）：群文本/图片逐条返回实际 message_id 给 drain 写 fish.sentmap；
  // 部分失败时已成功 id 挂在错误上上抛（OneBotSendFailure 约定），只记成功条目。
  emit: async (conversationId, payload) => {
    // 幂等键去重：崩溃重放、重启确认重复入队都会撞上同一个 key，只真发一次
    if (sent.has(payload.key)) return;
    const chatKey = chatKeys.get(conversationId);
    if (!chatKey) return;

    const sentIds: (number | string)[] = [];
    const bail = (error: unknown): never => {
      const merged = [...sentIds, ...((error as OneBotSendFailure).sentIds ?? [])];
      if (merged.length > 0 && error instanceof Error) (error as OneBotSendFailure).sentIds = merged;
      throw error;
    };

    if (chatKey.startsWith("qq:group:")) {
      const groupId = Number(chatKey.slice("qq:group:".length));
      // 引用只认本轮绑定的 quoteId：缺失就裸发，绝不回退 lastMessageId——
      // 那会拿后续消息当引用目标，正文与引用错位、整轮答非所问
      const quote = (payload.quote || payload.quoteForce === true || lastMention.get(conversationId) === true || lastReply.get(conversationId) === true)
        ? payload.quoteId
        : undefined;
      const mentions = payload.mentions && payload.mentions.length > 0 ? payload.mentions : undefined;
      // 无字纯图（say_media / say_meme 的出口形态）：文本气泡不发，quote/@ 透传给图片消息
      if (payload.items.length > 0) {
        try {
          sentIds.push(...await onebot.sendGroup(groupId, payload.items, { quote, ...(mentions ? { mentions } : {}) }));
        } catch (error) {
          bail(error);
        }
      }
      if (payload.media) {
        try {
          const imageId = await onebot.sendImageGroup(groupId, resolve(config.mediaRoot, payload.media), {
            // 有文字时 quote/@ 已经在第一条文本上，图片不重复带
            ...(payload.items.length === 0 ? { quote, ...(mentions ? { mentions } : {}) } : {}),
          });
          if (imageId !== undefined) sentIds.push(imageId);
        } catch (error) {
          bail(error);
        }
      }
      if (payload.voice) {
        try {
          await onebot.sendVoiceGroup(groupId, readFileSync(resolve(config.mediaRoot, payload.voice)));
        } catch (error) {
          bail(error);
        }
      }
    } else if (chatKey.startsWith("qq:private:")) {
      const userId = Number(chatKey.slice("qq:private:".length));
      await onebot.sendPrivate(userId, payload.items);
      if (payload.media) await onebot.sendImagePrivate(userId, resolve(config.mediaRoot, payload.media));
      if (payload.voice) {
        await onebot.sendVoicePrivate(userId, readFileSync(resolve(config.mediaRoot, payload.voice)));
      }
    }

    // 记账必须在真的发完之后：先记账后发，发送抛错时这一条就被当成已发，
    // harness 把 outbox 放回 queued 也重试不出来（幂等表先把它拦了）。
    // 紧接着发送就记，不等下面的日志：日志写失败不能让 drain 重发一遍（宁可少一条日志，不要重复发言）。
    // 外部弹药落账挂点（takeAmmoShare / applyAmmoShared / 分享后补货）已随弹药管线停用摘除（T3）。
    markSent(payload.key);

    // 末条自言标记（决策 24）已下沉到 onebot 层逐条置位（构造参数 onSent）：置位错点
    // 从「整个 emit 完成」改为「每条物理消息实际发送成功」，部分成功也置 true；
    // 幂等重放的早退路径到不了发送层，不会覆盖入站刚清掉的标记。

    for (const text of payload.items) {
      chatlog.append({ at: payload.at, chat: chatKey, from: "fish", text, kind: "out" });
    }
    return sentIds;
  },
  react: async (conversationId, emoji, messageId) => {
    // 轮级绑定：只贴本轮触发的那条。会话级 lastMessageId 会被后到的消息顶掉，
    // 那一下就会贴到别人刚发的话上。本轮没绑到消息（例如静默轮）就不贴。
    if (messageId === undefined) return;
    await onebot.react(messageId, emoji);
  },
  });

  // 启动装载特别关注名单：锚点行打标与主动 @ 白名单都要用，重启后立刻生效。
  // 放在 boot 里（engage 启动之前），与迁移前的模块加载时点等价。
  const chats = await fish.harness.snapshot(ChatsDoc, ctx);
  for (const [chatKey, conversationId] of Object.entries(chats?.chats ?? {})) {
    const watch = await fish.harness.snapshot(WatchDoc, Number(conversationId) as never, ctx);
    applyWatched(chatKey, watch?.people ?? []);
  }
}

/** 群档案：只在第一次见到这个群时抓一次，之后由 transcript 记着。不采信群名/群主等 OneBot 外部文本。 */
async function profileFor(groupId: number): Promise<GroupProfile | undefined> {
  const info = await onebot.groupInfo(groupId);
  if (!info) return undefined;
  const members = await onebot.groupMembers(groupId);
  return {
    groupId: String(groupId),
    count: info.count || members.length,
    master: config.master,
    members,
  };
}


/** 映射键（chatKey#人格）→ 原始 chatKey：emit 按 Number() 解析群号/QQ 号，带后缀会 NaN。 */
function baseChatKey(key: string): string {
  const at = key.lastIndexOf("#");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * conversationId → 原始 chatKey。
 * chatKeys 的键历史上两种写法都有（conversationFor 用数字 id，重启装载用字符串），两种都认，
 * 否则主动 @ 与 watch 的成员校验在未重启的会话上会永远拿不到群号。
 */
function chatKeyFor(conversationId: string | number): string | undefined {
  return chatKeys.get(String(conversationId)) ?? chatKeys.get(conversationId);
}

/**
 * 该群当前人格（conversationFor 与 T13 弹药的记忆 doc key 共用同一份解析）：
 * ChatsDoc 现读，返回原始值与悬空回退后的生效值（回退规则与 group() 同）。
 */
async function personaOfChatKey(chatKey: string): Promise<{ persona: string; effective: string }> {
  const snapshot = await fish.harness.snapshot(ChatsDoc, ctx);
  const persona = snapshot?.personas?.[chatKey] ?? "默认";
  const effective = persona !== "默认" && !fish.personas.includes(persona) ? "默认" : persona;
  return { persona, effective };
}

async function conversationFor(chatKey: string): Promise<Conversation> {
  // 当前人格：非变更式读取（严禁对 snapshot() 结果赋值）；fish.group 拿原始值（悬空它自己回退）
  const { persona, effective } = await personaOfChatKey(chatKey);
  const mapKey = effective === "默认" ? chatKey : `${chatKey}#${effective}`;
  let conv = conversations.get(mapKey);
  if (!conv) {
    const groupId = chatKey.startsWith("qq:group:") ? Number(chatKey.slice("qq:group:".length)) : undefined;
    const profile = groupId ? await profileFor(groupId) : undefined;
    conv = await fish.group(chatKey, profile, persona);
    conversations.set(mapKey, conv);
    // 路由永远用原始 chatKey（剥离 #人格 后缀），否则 emit 解析不出数字 id
    chatKeys.set(conv.id, chatKey);
    mappingKeys.set(conv.id, mapKey);
  }
  return conv;
}

/**
 * 主人 / 指令通道：机械执行并经 outbox 回执，不进 gate、不进模型上下文。
 * 返回机械回复文本；null = 非指令（非主人或非 / 前缀），调用方走原链路。
 * 回执固定落「切换前」的当前人格会话（conversationFor 惰性获取，群没说过话则
 * 惰性建默认会话，属可接受副作用）；切换动作本身绝不预建目标人格会话。
 */
/**
 * 上下文拼装与 10 秒连续发言合并都不在这里：状态机与 withContext 在 src/qq/debounce.ts，
 * 这里只负责把 flush / submit 接上，并做轮级清账与记账。
 */
/**
 * 动图自动收：gif 进群时起一个静默轮，把前 10 条上下文一起给鱼，
 * 由它判断这张图值不值得当表情包、调用 meme_add 打标入库。
 *
 * 边界：只认 .gif（白名单，避免把截图/照片也拖进模型）；md5 已在库里的跳过。
 */
async function maybeIngestGif(msg: IncomingMessage, bucket: RecentChatMessage[]): Promise<void> {
  if (!msg.chatKey.startsWith("qq:group:")) return;
  if (!config.groups.length || !config.groups.includes(String(msg.groupId))) return;
  if (msg.messageId === undefined) return;
  const gifs = msg.images.filter((img) => typeof img.ref === "string" && img.ref.toLowerCase().endsWith(".gif"));
  if (gifs.length === 0) return;

  for (const gif of gifs) {
    const full = resolve(config.mediaRoot, gif.ref);
    let md5: string;
    try {
      md5 = md5OfFile(full);
    } catch {
      continue;
    }
    // 库里已有同一张（按 md5）就不再跑模型（读索引与 meme_add 共用同一个 helper）
    if (hasMemeMd5(config.mediaRoot, md5)) return;

    const conv = await conversationFor(msg.chatKey);
    // 会话正被换页 / 另一轮收图占着：不提交（换页会把活跃轮吃掉，两轮抢同一个会话更糟）
    if (conversationBusy(conv.id)) {
      console.log(`[鱼缸] 收图轮跳过 ${gif.ref}：会话忙`);
      return;
    }
    const prior = bucket.slice(0, -1).slice(-10);
    const history = prior.map((line): ModelMessage => ({
      ...(line.messageId !== undefined ? { messageId: line.messageId } : {}),
      userId: String(line.userId),
      nickname: line.nickname,
      text: line.text,
      mentionsBot: false,
      replyIds: [],
      master: String(line.userId) === config.master,
      watched: watchedByChat.get(baseChatKey(msg.chatKey))?.has(String(line.userId)) === true,
    }));
    const target: ModelMessage = {
      messageId: msg.messageId,
      userId: String(msg.userId),
      nickname: msg.nickname,
      text: msg.text,
      mentionsBot: msg.mentionsBot,
      replyIds: [...msg.replyIds],
      master: String(msg.userId) === config.master,
      watched: watchedByChat.get(baseChatKey(msg.chatKey))?.has(String(msg.userId)) === true,
      ...(msg.quoted ? { quoted: msg.quoted } : {}),
      ...(msg.forward ? { forward: msg.forward } : {}),
    };
    const content = renderGifIngestInput(history, target, fish.prompts.messages);
    ingestRounds.add(String(conv.id));
    try {
      // 留痕：这一轮是收图轮，起止都打日志，否则「为什么不收」永远查不到
      console.log(`[鱼缸] 收图轮开始 ${gif.ref} md5=${md5.slice(0, 10)}`);
      // 收图任务不是群友原话：专用 entry kind（fish.gif_ingest），不 pushScope，
      // 也不进 renderMemoryTranscript——不能触发记忆召回或抽取
      const submission = await conv.submit({ type: "input", content, entry: { kind: MEMORY_GIF_KIND } }, ctx);
      const roundId = String(submission.id);
      silentRounds.add(roundId);
      try {
        const settled = await submission.wait(ctx);
        const added = hasMemeMd5(config.mediaRoot, md5);
        const reason = settled.status === "done" ? (added ? "已入库" : "鱼判断不值得收") : `${settled.status}`;
        console.log(`[鱼缸] 收图轮结束 ${gif.ref} → ${reason}`);
      } finally {
        silentRounds.delete(roundId);
        clearMemeImportRound(roundId);
      }
    } catch (error) {
      console.error("[鱼缸] 收图轮失败", error instanceof Error ? error.message : error);
    } finally {
      ingestRounds.delete(String(conv.id));
      await drainLoop();
    }
    return; // 一条消息只收一张
  }
}


/** 会话忙（换页 / 收图轮）时：被@的给一句机械回复（同样走 outbox 唯一出口），其余直接等下一轮。 */
async function sendBusyReplies(conv: Conversation, messageIds: readonly (number | string | undefined)[]): Promise<void> {
  const items = [String(fish.prompts.messages["busy_reply"] ?? "[busy]")];
  let queued = false;
  for (const messageId of messageIds) {
    if (messageId === undefined) continue;
    await fish.enqueue(conv.id, {
      items,
      quote: true,
      quoteId: messageId,
      quoteForce: true,
      at: Date.now(),
      key: `busy:${messageId}`, // 幂等键：崩溃重放不重复发
    });
    queued = true;
  }
  if (queued) await drainLoop();
}

/** assistant entry 的可见正文：只拼 text block，thinking 与工具调用一概不碰。 */
function flattenAssistantText(model: unknown): string {
  if (!Array.isArray(model)) return "";
  return model
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ");
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 正文兜底补发（salvagePlainReply，仅必答轮）：一轮里一次 say_* 都没调但末条 assistant 有
 * 非空正文时，取正文首行硬截 120 字，过与 say_words 完全相同的出口校验（结构 + 溯源 + 重复）
 * 后经 outbox 补发。thinking / tool 文本永不涉及（只取 text block）；放弃与出错都留日志
 * （文案在 prompt/messages.md 的 salvage_skip / salvage_error），本函数自身也永不抛错；
 * 误发可在 fish.config.json 里把 salvagePlainReply 设为 false 关掉。
 *
 * 定位本轮不能扫 pi.user：记忆链路上线后 submitRound 的输入以 fish.inbound entry 落库，
 * 鱼自己的轮从不写 pi.user，扫 kind 永远找不到输入、兜底就静默失效（2026-11-01 私聊轮）。
 * settle 记录直接带本轮的输入 entry 与末条 assistant entry 的 id，按 id 直取；answer 取不到
 * 时退回按输入 entry 定位、取其后的末条 pi.assistant（与旧语义一致）。
 */
async function salvagePlainReply(
  conv: Conversation,
  chatKey: string,
  trigger: { messageId?: number | string; mentionsBot: boolean },
  round: { inputEntryId?: number; answerEntryId?: number },
): Promise<void> {
  // 早退可观测：放弃原因走 prompt/messages.md 的 salvage_skip（缺 key 时退化成裸原因，照样留日志）
  const skip = (reason: string): void => {
    const tpl = fish.prompts.messages["salvage_skip"] ?? "";
    console.log(`[鱼缸] ${chatKey} ${tpl ? renderTemplate(tpl, { reason }) : `兜底放弃：${reason}`}`);
  };
  try {
    const view = await conv.viewState(ctx);
    const entries = view.value.entries as readonly { id?: number; kind?: string; model?: unknown }[];
    view.dispose();
    // 优先按 settle 给出的 answer entry id 直取本轮末条 assistant（多轮工具调用时它就是最后一条回复）
    let text = "";
    const answered = entries.find((entry) => entry.id === round.answerEntryId);
    if (answered !== undefined) {
      text = flattenAssistantText(answered.model);
    } else {
      let anchor = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.id === round.inputEntryId) { anchor = i; break; }
      }
      if (anchor < 0) {
        skip(`找不到本轮 entry（input=${round.inputEntryId} answer=${round.answerEntryId}）`);
        return;
      }
      for (let i = anchor + 1; i < entries.length; i++) {
        if (entries[i]?.kind === "pi.assistant") text = flattenAssistantText(entries[i]?.model);
      }
    }
    const line = text.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
    if (!line) {
      skip("末条 assistant 没有正文");
      return;
    }
    const clipped = line.slice(0, 120);
    const ledger = ledgerOf(conv.id);
    const rejection = validateOutbound(
      { messages: [clipped] },
      {
        limits: { ...DEFAULT_LIMITS, mediaRoot: config.mediaRoot },
        now: Date.now(),
        recent: ledger.recent,
        secrets: ledger.secrets,
      },
    );
    if (rejection) {
      skip(rejection.code);
      return;
    }
    await fish.enqueue(conv.id, {
      items: [clipped],
      quote: trigger.mentionsBot,
      quoteId: trigger.messageId,
      quoteForce: trigger.mentionsBot,
      at: Date.now(),
      key: `salvage:${trigger.messageId ?? Date.now()}`, // 幂等键：崩溃重放不重复发
    });
    console.log(`[鱼缸] ${chatKey} 兜底补发 1 条`);
  } catch (error) {
    // 兜底本身不能拖垮主流程，但失败必须留痕（文案在 prompt/messages.md 的 salvage_error）
    const detail = error instanceof Error ? error.message : String(error);
    const tpl = fish.prompts.messages["salvage_error"] ?? "";
    console.error(`[鱼缸] ${chatKey} ${tpl ? renderTemplate(tpl, { error: detail }) : `兜底出错：${detail}`}`);
  }
}

/**
 * 提交一轮，等它跑完，再记账与换页。
 *
 * 轮级清账（resetRun / resetLook / lastMention / lastReply）
 * 全部挪到这里、在真正 submit 之前做：以前是 gate 放行那一刻就清，同一组连续发言的
 * follow-up 进来会把这一轮的引用目标和记账提前抹掉。
 */
async function submitRound(input: {
  chatKey: string;
  conv: Conversation;
  content: string;
  /** 本轮触发消息：引用目标与主动 @ 的身份闸都只认它；kind = 轮类型（缺省 answer） */
  trigger: {
    messageId?: number | string;
    mentionsBot: boolean;
    userId?: number;
    kind?: RoundKind;
    /** 视频浏览授权（T3）：仅 open 空窗的零新增主动轮携带，随 triggerOf 钉上；
     *  ambient shard 与其它轮不传 = 无授权（T4 的浏览/分享工具只认这两个字段）。 */
    browseWindow?: string;
    browseTopic?: string;
  };
  /** 本轮是不是在回复别人（回复链要引用） */
  reply: boolean;
  /** 本轮是否必答（闸放行原因 ∈ private/mentioned）：正文兜底只补必答轮 */
  mustAnswer?: boolean;
  /** bypass 段（画图指令）；只在这一轮可见，轮 settle 即删 */
  bypass?: string;
  /** 记忆：结构化入站 entry（fish.inbound，原始文本）与本轮在场人物（memory scope）。 */
  /** 不传（injection / shard 轮）= 不写 fish.inbound、不压 scope（背景板非对话输入） */
  memory?: { inbound: MemoryInbound; speakers: { subject: string; name: string }[] };
  /** inline 附图（已压缩的 image blocks，≤2 张）：按编号顺序附在唯一 text block 之后，
   * 与文本里的 [图片#N] / [图片#N 压缩图] 标签对齐（压缩与编号在 planRoundImages 完成） */
  imageBlocks?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
  /** entry kind：缺省 fish.inbound（写结构化数据）；injection / shard 轮传 fish.engage_tick */
  entryKind?: string;
  /** 本轮注入窗口的消息 id（T4 quoteMsgId 合法目标）；随 triggerOf 在 settle 清除 */
  quoteIds?: ReadonlySet<string>;
}): Promise<SettledSubmissionRecord["status"]> {
  const { chatKey, conv, trigger } = input;
  // 在途登记要在任何 await 之前（busy 检查与提交之间不开窗口）：仅 next 登记对称登记/释放
  const roundKind: RoundKind = trigger.kind ?? "answer";
  const trackInFlight = engageNextOf(chatKey);
  if (trackInFlight) registerInFlight(conv.id, roundKind);
  await absorbSecrets(conv);
  resetRun(conv.id);
  resetLook(conv.id);
  // 被@必回引用，让群里看得出鱼在回谁
  lastMention.set(conv.id, trigger.mentionsBot);
  lastReply.set(conv.id, input.reply);

  let content = input.content;
  // 语音提示的 0.3 概率门（仅 answer 轮，决策 7）：主人/特别关注对象过闸的轮里，三成概率追加一行
  // `[本轮要求] 必须使用 say_voice 回复`。只是提示，不是门禁——用不用由鱼自己判断（说没配音色就不提示）。
  // ambient/injection 环境轮一律不掷：零出口合法的轮不该被语音义务逼着开口。
  // 看视频的调用侧规范（2026-11-05，decisions 定案）：工具不再按轮类型卡人，改成在 @ 轮
  // 明确写一条要求——没被要求就别去看视频。确定性追加（不掷概率），与语音提示同为附加段。
  const watchRule = fish.prompts.messages["video_answer_rule"] ?? "";
  if (roundKind === "answer" && trigger.mentionsBot && watchRule.length > 0) {
    content = appendAnswerRules(content, [watchRule]);
  }
  if (roundKind === "answer" && voiceConfigFor(mappingKeys.get(String(conv.id)) ?? chatKey) && isVoiceVip(chatKey, trigger.userId) && Math.random() < 0.3) {
    const hint = fish.prompts.messages["voice_hint"] ?? "";
    // 附加段之间统一空一行（decisions §5.2：[本轮要求] 段前是空行）
    if (hint) content = appendVoiceHint(content, hint);
  }

  // inline 附图：flushBurst 的 planRoundImages 已完成选图、压缩与编号（失败的跳过、
  // 不占编号）；content = 一个 text block，压缩 image blocks 按编号顺序在后（decisions §5.4）
  const imageBlocks = [...(input.imageBlocks ?? [])];
  const submitContent = submitContentOf(content, imageBlocks);

  const scopeToken = input.memory !== undefined
    ? pushScope(String(conv.id), { speakers: input.memory.speakers, text: input.memory.inbound.text })
    : undefined;
  const entryKind = input.entryKind ?? MEMORY_INBOUND_KIND;
  let settled: SettledSubmissionRecord;
  // 轮内自愈：模型错误（如内容拦截 1301）时自动重试，第三次尝试前强制换页——
  // 摘要同源失败会走机械降级把可能的中毒内容清出活跃页，一次输入就能自愈，不依赖用户重发
  const MAX_MODEL_ATTEMPTS = 3;
  try {
    for (let attempt = 1; ; attempt++) {
      if (attempt === MAX_MODEL_ATTEMPTS) {
        const cleared = await compactWithGuard(conv, true, chatKey);
        if (cleared.compacted) {
          console.log(`[鱼缸] ${chatKey} 换页 ${cleared.entries}条/${cleared.chars}字 ·强制`);
        }
      }
      // 触发消息绑在 submission 上：轮在跑时新消息进来也不会把引用目标顶掉（否则回复会串到别人的消息上）。
      // entry 是记忆的唯一原始输入：chatKey / QQ / 昵称 / 原话，不带任何宿主文案；
      // 重试不重复落库，只有首次尝试携带 entry。injection / shard 轮不写 fish.inbound
      //（fish.engage_tick：背景板非对话输入，不进摘要与抽取）
      const submission = await conv.submit(
        {
          type: "input",
          content: submitContent,
          entry: attempt === 1
            ? (input.memory !== undefined ? { kind: entryKind, data: input.memory.inbound } : { kind: entryKind })
            : undefined,
        },
        ctx,
      );
      triggerOf.set(String(submission.id), {
        messageId: trigger.messageId,
        mentionsBot: trigger.mentionsBot,
        userId: trigger.userId,
        kind: roundKind,
        ...(input.quoteIds !== undefined && input.quoteIds.size > 0 ? { quoteIds: input.quoteIds } : {}),
        // 视频浏览授权（T3）：只随零新增主动轮钉上（T4 的 bili_hot/video/say_words 消费）
        ...(trigger.browseWindow !== undefined ? { browseWindow: trigger.browseWindow } : {}),
        ...(trigger.browseTopic !== undefined ? { browseTopic: trigger.browseTopic } : {}),
      });
      // 重耗时工具的机械提示要落回本轮会话：登记轮的会话，settle 的 finally 里删
      roundConv.set(String(submission.id), conv);
      if (input.bypass !== undefined) bypassOf.set(String(submission.id), input.bypass);
      // 零出口轮观测：本轮出口计数清零登记，与 triggerOf 同生命周期（见下方 finally）
      sayCalled.set(String(submission.id), 0);

      // 成功、失败、抛错都要把这一轮的绑定清掉
      settled = await (async () => {
      try {
        const result = await submission.wait(ctx);
        // 正常结束却一次 say_* 都没调：模型裸文本回复不出口，聊天对象什么都看不到——
        // answer 轮打一行宿主日志让这类轮立刻可见（收图轮不经 submitRound，天然不在观测范围），
        // 完整解释在 .agents/skills/ops/SKILL.md；ambient（shard）/ injection 轮零出口是
        // 合法沉默（F2/F3），不算异常不占观测日志
        if (result.status === "done" && (sayCalled.get(String(submission.id)) ?? 0) === 0) {
          if (roundKind === "answer") console.log(`[鱼缸] ${chatKey} 零出口轮：模型没调 say_*`);
          // 必答轮的兜底补发：配置可关（mtime 热加载，每次触发现读）；环境轮只留上面的观测日志。
          // done 变体的 settle 记录带本轮输入（entry）与末条 assistant（answer）的 entry id，兜底按 id 定位
          if (input.mustAnswer === true && fishConfig().config.salvagePlainReply) {
            const placed = result as { entry?: number; answer?: number };
            await salvagePlainReply(conv, chatKey, trigger, {
              inputEntryId: placed.entry,
              answerEntryId: placed.answer,
            });
          }
        }
        return result;
      } finally {
        triggerOf.delete(String(submission.id));
        // viewed 登记只活本轮（T3/T4）：done、没答上来、wait 抛错都整份清掉，
        // browse 轮的「实际看过」授权不跨轮残留
        clearViewedVideos(String(submission.id));
        // 本轮「见过的链接」白名单同一生命周期：出口侧只认本轮工具结果里的 URL，
        // 轮末整份清掉，跨轮不残留（不把上一轮的链接变成下一轮的通行证）
        clearSeenLinks(String(submission.id));
        bypassOf.delete(String(submission.id));
        // 导入清单只属于这一轮：成功、失败、抛错都在这里清掉
        clearMemeImportRound(String(submission.id));
        // 出口计数同样只活这一轮：done、没答上来、wait 抛错都不残留。
        // 沉默递进（旧 T8 nudge）的宿主上报已随 2026-11-04 模型输入计划 T3 摘除：
        // 空窗不再由连续沉默触发，engageNext 的 noteExit / silenceOf 在宿主侧无消费方，
        // 降为兼容源码（与 shareGateOf 同待遇）；sayCalled 仍只作本轮出口额度计数。
        sayCalled.delete(String(submission.id));
        // 机械提示的会话映射与轮内去重集合同样只活这一轮
        roundConv.delete(String(submission.id));
        workingSent.delete(String(submission.id));
      }
    })();
      // 模型错误且还有重试余量：轮内重试（第三次前已强制换页）；其它结果直接出循环
      const reason = (settled as { reason?: string }).reason;
      if (settled.status === "done" || reason !== "model_error" || attempt >= MAX_MODEL_ATTEMPTS) break;
      console.log(`[鱼缸] ${chatKey} 模型错误，轮内重试 ${attempt}/${MAX_MODEL_ATTEMPTS - 1}`);
    }
  } finally {
    // scope 队列满（scopeToken undefined）时本轮没压过 scope，不能弹掉别人的队首
    if (scopeToken !== undefined) shiftScope(String(conv.id), scopeToken);
    // 在途登记对称释放（仅 next 登记过）；ambient/injection 清零时唤醒等待的 @ 轮
    if (trackInFlight) releaseInFlight(conv.id, roundKind);
  }
  if (settled.status !== "done") {
    const why = [settled.status, (settled as { reason?: string }).reason, (settled as { detail?: string }).detail]
      .filter(Boolean)
      .join(" · ");
    console.error(`[鱼缸] ${chatKey} 这一轮没答上来：${why}`);
    // 轮内重试与强制换页都试过仍失败：再尝试一次常规自动换页（阈值满足时），保持既有行为
    const compacted = await compactWithGuard(conv, false, chatKey);
    if (compacted.compacted) {
      console.log(`[鱼缸] ${chatKey} 换页 ${compacted.entries}条/${compacted.chars}字`);
    } else {
      console.log(`[鱼缸] ${chatKey} 失败轮换页未执行：${compacted.reason ?? "skipped"} entries=${compacted.entries ?? "-"} chars=${compacted.chars ?? "-"}`);
    }
    return settled.status;
  }

  await drainLoop();

  // 记账：pi-durable 的 pi.usage 是累计值，这里取差落盘；基线按会话维度记，
  // 人格切换换了 conversation 后累计值回落不再被钳零丢账
  const spent = await fish.harness.snapshot(UsageDoc, conv.id, ctx);
  const delta = usage.append(chatKey, sumUsage(spent), Date.now(), String(conv.id));
  if (delta) {
    console.log(`[鱼缸] ${chatKey} +${delta.total} tokens / ${delta.cost}`);
  }

  const compacted = await compactWithGuard(conv, false, chatKey);
  if (compacted.compacted) {
    console.log(`[鱼缸] ${chatKey} 换页 ${compacted.entries}条/${compacted.chars}字`);
  }
  return settled.status;
}

/**
 * 换页的统一守卫：手动 `/压缩`、轮后自动换页共用，静默收图轮在跑时直接跳过
 * （那一轮正在用这个会话，换页会把它吃掉；计账不受影响，下一轮再压）。
 * 换页期间把 id 记进 compacting，flushBurst / 私聊据此回忙碌语而不是提交。
 * 摘要失败降级机械换页成功时在这里打告警（文案在 prompt/messages.md，不打印内容）。
 */
async function compactWithGuard(conv: Conversation, force = false, chatKey = ""): Promise<CompactResult> {
  if (ingestRounds.has(String(conv.id))) return { compacted: false };
  compacting.add(String(conv.id));
  try {
    const result = await fish.compact(conv, force);
    if (result.fallback) {
      const tpl = fish.prompts.messages["compact_fallback_log"] ?? "";
      const reason = result.detail ?? "";
      console.error(`[鱼缸] ${tpl ? renderTemplate(tpl, { chatKey, reason }) : `换页摘要失败 ${reason}`}`);
    }
    return result;
  } finally {
    compacting.delete(String(conv.id));
  }
}

/** @ 轮遇在途 ambient（shard）/ injection 轮的排队上限：超时转 busy_reply，不静默丢。 */
const ANSWER_WAIT_MS = 60_000;

/**
 * 10 秒静默到期：整组一起进模型。
 *
 * 锚点 = 这一组按收到顺序最后一条（A-B-A 里 B 只出现在背景，不可能顶掉 A）；整组里任意一条 @鱼
 * 就整组必答；引用只看锚点。会话忙分两级：换页 / 收图轮沿用既有语义（丢组 + 被@回忙碌语）；
 * 在途 ambient/injection 轮则分级——@ 轮（必答）排队等待 ≤60s（超时转忙碌语，
 * 消息不丢），非必答组静默丢弃（沿用环境轮遇忙即弃）。私聊不经这里，无在途登记。
 */
export async function flushBurst(burst: PendingBurst): Promise<void> {
  const anchor = burst.anchor;
  // 本组的必答标记整组消费一次（正文兜底判据）：窗口已随 timer 摘除，走哪条分支都不残留
  const mustAnswer = burstMustAnswer.get(windowKey(burst.chatKey, burst.userId)) ?? false;
  burstMustAnswer.delete(windowKey(burst.chatKey, burst.userId));
  // 会话/人格只认首次 push 那一份：10 秒窗口里主人 /切换人格 也改不了这一组的落点
  const conv = (burst.binding as Conversation | undefined) ?? (await conversationFor(anchor.chatKey));

  // 换页 / 收图轮进行中：不再受理新提交（根治换页竞态把活跃轮吃掉的问题）
  if (compacting.has(String(conv.id)) || ingestRounds.has(String(conv.id))) {
    console.log(`[鱼缸] ${anchor.chatKey} 会话忙，丢弃待定组 ${burst.messages.length}`);
    await sendBusyReplies(conv, burst.messages.filter((m) => m.mentionsBot).map((m) => m.messageId));
    return;
  }

  // next：在途 ambient（shard）/ injection 轮——@ 轮排队等待，非必答组静默丢弃
  if (hasAmbientInFlight(conv.id)) {
    if (!mustAnswer) {
      console.log(`[鱼缸] ${anchor.chatKey} 在途环境轮，丢弃待定组 ${burst.messages.length}`);
      return;
    }
    console.log(`[鱼缸] ${anchor.chatKey} 在途环境轮，@ 轮排队等待`);
    const cleared = await waitAmbientClear(conv.id, ANSWER_WAIT_MS);
    if (!cleared || compacting.has(String(conv.id)) || ingestRounds.has(String(conv.id)) || hasAmbientInFlight(conv.id)) {
      console.log(`[鱼缸] ${anchor.chatKey} @ 轮等待未清，转忙碌语`);
      await sendBusyReplies(conv, burst.messages.filter((m) => m.mentionsBot).map((m) => m.messageId));
      return;
    }
  }

  // 图片输入（decisions §5.4）：inline 模式把本轮图换成 [图片#N] 编号 + 末尾压缩图
  // 标签与 image block；fallback 保留 [图片 inbound/…] 路径并提示 look。GIF 与缺失
  // 文件不 inline（也不占额度），普通轮 ≤2 张，压缩失败的跳过不占编号。
  const plan = planRoundImages(anchor, burst.messages, config.mediaRoot, inlineVisionOn(), fish.prompts.messages);
  const roundContext = withContext(anchor, recent.get(anchor.chatKey) ?? [], plan.messages, {
    master: config.master,
    messages: fish.prompts.messages,
    // @（answer）轮背景（T5/决策 20）：上限缩为 engage.mentionContextSize（热加载）、
    // 先取 N 再剔除已进过模型的（lastSeenByModel），注入后随整组推进标记（下方
    // advanceSeenSeq）；[主人]/[特别关注] 标签由渲染器逐行机械打（master 优先互斥）
    backgroundLimit: fishConfig().config.engage.mentionContextSize,
    seenSeq: seenSeqOf(conv.id),
    // inline 编号表：引用原文里的图也要跟 [图片#N] 对齐（回复一张图说「收图」的场景）
    imageNumbers: plan.numbers,
    watched: (userId) => watchedByChat.get(baseChatKey(anchor.chatKey))?.has(String(userId)) === true,
  });
  // @ 鱼 + 文字里提到合集/转发：把这个群最近一条没展开的合集拉出来（10 分钟内有效）。
  // 场景：先发合集（不 @，被闸丢弃）→ 再 @ 问「上面那个能看吗」。补展开没有可确认
  // 的来源消息 ID，不伪造 [来自m:id]；子图不落盘（ref 为空），统一换回 [图片 未展开]。
  let recentForward: ForwardAttachment | undefined;
  if (burst.messages.some((m) => m.mentionsBot && /合集|转发/.test(m.text))) {
    const pending = onebot.recentForward(anchor.chatKey, 10 * 60_000);
    if (pending) {
      const expanded = await onebot.expandForwardAttachmentById(pending, anchor);
      if (expanded) {
        // 拉取失败/空合集也要可见：renderForwardAttachment 对空 children 渲染读取失败标记，不伪造条数
        recentForward = rewriteRoundForwardImages(expanded, plan.numbers, fish.prompts.messages);
        console.log(`[鱼缸] ${anchor.chatKey} 补展开最近合集`);
      }
    }
  }

  const content = assembleRoundContent(roundContext.content, {
    ...(recentForward ? { recentForward } : {}),
    tags: plan.tags,
    lookHint: plan.lookHint,
  }, fish.prompts.messages);

  // 整组里最近一条非空 bypass 段：指令后面又跟了两句普通闲聊时，只取最后一条会让 draw 静默失效
  const payload = lastPayload(burst.messages);
  // 记忆的原始输入与在场人物：entry 只存卡片渲染 / bypass 剥离之前的群友原话，
  // scope 带锚点 + 背景里最近发言的人（昵称经 nameToQq 映射回 QQ）
  const bucket = recent.get(anchor.chatKey) ?? [];
  const memoryInbound: MemoryInbound = {
    chatKey: anchor.chatKey,
    userId: String(anchor.userId),
    nickname: anchor.nickname,
    text: rawMemoryText.get(anchor) ?? memoryTextOf(anchor.text),
  };
  const speakers = [{ subject: `qq:${anchor.userId}`, name: anchor.nickname }];
  for (const name of bucket.slice(-4).map((m) => m.nickname)) {
    const qq = nameToQq.get(anchor.chatKey)?.get(name);
    if (qq && !speakers.some((s) => s.subject === `qq:${qq}`)) speakers.push({ subject: `qq:${qq}`, name });
  }
  await submitRound({
    chatKey: anchor.chatKey,
    conv,
    content,
    // 引用锚点与主动 @ 的身份闸都只认锚点；但整组里任意一条 @鱼，整组都必答。
    // burst 轮（@）一律 answer；open 态的非 @ 消息走 shard（ambient），不经这里
    trigger: { messageId: anchor.messageId, mentionsBot: burst.mustAnswer, userId: anchor.userId, kind: "answer" },
    reply: burst.quoteFromReply,
    mustAnswer,
    quoteIds: quoteIdsOf(roundContext.seen),
    ...(payload !== undefined ? { bypass: payload } : {}),
    ...(plan.blocks.length > 0 ? { imageBlocks: plan.blocks } : {}),
    memory: { inbound: memoryInbound, speakers },
  });
  // @ 轮整组（burst 本体）不属背景板：照常注入并推进已读标记（决策 20，T5 的背景去重消费）
  advanceSeenSeq(conv.id, maxArrivalSeq(burst.messages));
}

// ── 携话 next 的注入轮（injection / ambient shard，T3）─────────────────────

/**
 * 开窗积压查询（injection 轮的输入）：窗口 = (lastCloseSeq, 开窗时刻] 的 recent 流水，
 * 排除 pending burst 内消息（它们归 @ 轮的整组注入）、过滤 `/` 指令与纯 GIF 收图消息，
 * 超上限截最近 N。lastSeenByModel 去重在提交侧做（键是会话，得先解出会话）。
 * 上限热读 engage.windowSize（沉默递进 2×阈值的放宽已随 nudge 机制停用，2026-11-04 T3；
 * recent 流水上限仍是 max(30, windowRelaxCap) 兑底）。
 */
function engageBacklogOf(chatKey: string, afterSeq: number | undefined): readonly EngageBacklogItem[] {
  if (afterSeq === undefined) return [];
  // 旧流水没有序号：宁少勿答，不注入
  const pendingIds = new Set<string>();
  const pendingSeqs = new Set<number>();
  for (const burst of debouncer.pendingOf(chatKey)) {
    for (const message of burst.messages) {
      if (message.messageId !== undefined) pendingIds.add(String(message.messageId));
      if (message.arrivalSeq !== undefined) pendingSeqs.add(message.arrivalSeq);
    }
  }
  const cap = fishConfig().config.engage.windowSize;
  return (recent.get(chatKey) ?? [])
    .filter((m) => m.arrivalSeq !== undefined && m.arrivalSeq > afterSeq)
    .filter((m) => !((m.messageId !== undefined && pendingIds.has(String(m.messageId))) || (m.arrivalSeq !== undefined && pendingSeqs.has(m.arrivalSeq))))
    .filter((m) => !m.text.startsWith("/") && m.mediaOnly !== "gif")
    .slice(-cap);
}

/**
 * 零新增主动轮的提交（两条路径共用：开窗空窗 + 自由群空拍）。
 * decisions §5.6 固定模板四段逐字拼装，不预选具体视频、不注入编号、不附加元说明；
 * 走 injection 管线（fish.engage_tick、非必答、无 salvage、无 quoteIds），
 * browseWindow/browseTopic 钉上 trigger（浏览与分享授权的唯一来源）。
 * 遇忙放弃（宁少勿答，不重试不补发）。
 */
async function submitBrowseOpportunity(chatKey: string, gate: { windowId: string; topic: string }): Promise<void> {
  const conv = await conversationFor(chatKey);
  if (conversationBusy(conv.id)) {
    console.log(`[鱼缸] ${chatKey} 主动轮放弃（忙）`);
    return;
  }
  const content = renderBrowseOpportunity(fish.prompts.messages);
  console.log(`[鱼缸] ${chatKey} 主动轮提交（browse 门开）`);
  await submitRound({
    chatKey,
    conv,
    content,
    trigger: { mentionsBot: false, kind: "injection", browseWindow: gate.windowId, browseTopic: gate.topic },
    reply: false,
    entryKind: MEMORY_ENGAGE_KIND,
  });
}

/**
 * 开窗注入轮（injection，背景板语义）：open 进入瞬间把积压一轮注入。这些消息只是
 * 背景板——无必答、无 salvage、模型不必逐条回应也不必补回复任何人；遇忙放弃
 * （宁少勿答，积压不重放）；注入后已读标记只推进到本轮实际注入集合（fresh）的
 * maxArrivalSeq——提交等待期间新到的未注入消息不算已读，仍归下一窗（决策 3：之后归
 * shard，不重复注入）。entry kind = fish.engage_tick（不写 fish.inbound、不进摘要与
 * 抽取，但计入换页阈值）；不附 inline 图；quoteIds = 本轮注入的积压消息集。
 * 输入统一用标准群消息列表（decisions §5.5：与 shard 同一模板，不在 user input 区分
 * 窗口规则）；沉默递进 nudge、旧账/弹药栏与宵禁 footer 已停用（2026-11-04 T3）。
 * 空窗（零新增）不再由沉默/nudge/debt/ammo 触发：只在本窗 video.browseChance 门开时
 * 提交「主动交流机会」固定模板（decisions §5.6），并把 browseWindow/browseTopic 钉上
 * trigger（T4 浏览与分享授权的唯一来源）；ambient shard 与其它轮一律不携带。
 * 自由活动模式没有开窗事件：空拍门开走同一条 submitBrowseOpportunity。
 */
async function submitInjectionRound(chatKey: string, backlog: readonly EngageBacklogItem[]): Promise<void> {
  console.log(`[鱼缸] ${chatKey} 携话窗口 → open（积压 ${backlog.length} 条）`);
  if (backlog.length === 0) {
    // 零新增主动轮：门没开就整窗不提交（每窗只在开窗时掷过一次，不重掷、不补掷）；
    // 门开时同走 injection 管线（fish.engage_tick、非必答、无 salvage、无 quoteIds），
    // 遇忙放弃（宁少勿答，不重试不补发，下窗自然重掷）
    const gate = videoBrowseGateOf(chatKey);
    if (!gate?.open) return;
    await submitBrowseOpportunity(chatKey, { windowId: gate.windowId, topic: gate.topic });
    return;
  }
  const conv = await conversationFor(chatKey);
  // 状态机 busy 检查后的双保险：这中间起了轮 / 换页 / 收图就放弃（宁少勿答）
  if (conversationBusy(conv.id)) {
    console.log(`[鱼缸] ${chatKey} 注入放弃：忙（宁少勿答）`);
    return;
  }
  // 已读去重（决策 20）：剔除已进过模型的部分（重启后标记为空＝全未读，不会饿死注入）
  const fresh = backlog.filter((m) => m.arrivalSeq === undefined || m.arrivalSeq > seenSeqOf(conv.id));
  if (fresh.length === 0) return;
  const content = renderOpenMessageList(fresh, fish.prompts.messages,
    (userId) => Boolean(config.master && String(userId) === config.master),
    (userId) => watchedByChat.get(baseChatKey(chatKey))?.has(String(userId)) === true,
  );
  await submitRound({
    chatKey,
    conv,
    content,
    trigger: { mentionsBot: false, kind: "injection" },
    reply: false,
    entryKind: MEMORY_ENGAGE_KIND,
    quoteIds: quoteIdsOf(fresh),
  });
  // 已读标记只推进到本轮实际注入的 fresh 集合：若推进到 recent 末条，提交等待期间
  // 新到的未注入消息会被误标已读、永远饿死注入（终审 #1）
  advanceSeenSeq(conv.id, maxArrivalSeq(fresh));
}

/**
 * open 窗 shard 轮（ambient）：每 engage.shardSeconds 一拍，把这一拍收集的全部发送者
 * 消息合成一轮。输入与 injection 轮是同一份标准群消息列表（decisions §5.5：不在 user
 * input 区分 injection/shard，也不重复窗口规则），按真实接收顺序渲染。非必答：零出口
 * 合法、无 salvage、无强制引用；已读去重后注入、注入后推进标记；quoteIds = 本轮 shard
 * 消息集。shard 轮不携带 browseWindow/browseTopic——ambient 无浏览授权（T3）。
 * 提交前会话又忙（状态机检查后的竞态）就放回收集器并入下一拍（绝不丢、绝不并发提交）。
 */
async function submitShardRound(chatKey: string, items: readonly EngageShardItem[]): Promise<void> {
  if (items.length === 0) return;
  const conv = await conversationFor(chatKey);
  if (conversationBusy(conv.id)) {
    const held = items.every((item) => engageNext.collectShard(chatKey, item));
    if (held) console.log(`[鱼缸] ${chatKey} shard 在途退避，并入下一拍`);
    else console.log(`[鱼缸] ${chatKey} shard 退避失败（已关窗），丢弃`);
    return;
  }
  const fresh = items.filter((m) => m.arrivalSeq === undefined || m.arrivalSeq > seenSeqOf(conv.id));
  if (fresh.length === 0) return;
  const list = renderOpenMessageList(fresh, fish.prompts.messages,
    (userId) => Boolean(config.master && String(userId) === config.master),
    (userId) => watchedByChat.get(baseChatKey(chatKey))?.has(String(userId)) === true,
  );
  // 批内回复关系（2026-11-05）：列表里渲染 [回复了m:id]，被引原文按 @ 轮同款附在列表后
  const quoted = renderOpenQuotedText(fresh, fish.prompts.messages);
  const content = quoted.length > 0 ? `${list}\n\n${quoted}` : list;
  // 整拍里最近一条非空 bypass 段（整组语义：指令后面跟闲聊不丢指令）
  let payload: string | undefined;
  for (let index = fresh.length - 1; index >= 0; index--) {
    const stash = (fresh[index] as EngageShardItem).payload;
    if (stash !== undefined && stash.length > 0) {
      payload = stash;
      break;
    }
  }
  await submitRound({
    chatKey,
    conv,
    content,
    trigger: { mentionsBot: false, kind: "ambient" },
    reply: false,
    entryKind: MEMORY_ENGAGE_KIND,
    quoteIds: quoteIdsOf(fresh),
    ...(payload !== undefined ? { bypass: payload } : {}),
  });
  advanceSeenSeq(conv.id, maxArrivalSeq(fresh));
}
/**
 * 公共批准的前置步（AI 脱敏）：私聊 `/记忆 同意 <id> 公共` 在 applyPatch 之前，把待审
 * patch 的文本字段（facts/lore/cards 的 text；subject/keys/结构不动）交给便宜模型按
 * prompt/memory-publicize.md 改写——去掉指向来源群的身份信息，让表述在该人格任何会话
 * 都成立。模型与压缩抽取同源（memoryModel 链：compact.memoryModel ?? 主模型；现配置
 * 未配 memoryModel，实际与抽取同落主模型）。改写输出在 memory.ts 里重过机械过滤并
 * 强制结构同构，通过才写回待审 doc，随后的正式审批应用的就是改写后的文本（回执里的
 * digest 即改写后关键文本）；失败 fail closed，由调用方以错误回执终止，不降级、不原样入库。
 * 日志只带 id 与结果状态，不打印内容。
 */
async function publicizePendingForApproval(id: string): Promise<"ok" | "missing" | "failed"> {
  const views = await fish.pendingMemories();
  const found = views
    .flatMap((view) => view.entries.map((entry) => ({ persona: view.persona, entry })))
    .find((item) => item.entry.id === id);
  if (!found) return "missing";
  const result = await publicizePatch(found.entry.patch, {
    template: fish.prompts.memoryPublicize,
    complete: async (prompt) => {
      const model = models.getModel(mainModel.provider, mainModel.modelId);
      if (!model) throw new Error(`model_not_found:${mainModel.provider}/${mainModel.modelId}`);
      const message = await models.streamSimple(model, { messages: [{ role: "user", content: prompt }] }).result();
      return message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    },
  });
  if (result.status === "failed") {
    console.log(`[鱼缸] 记忆公共化脱敏 ${id} failed ${result.reason}`);
    return "failed";
  }
  await fish.harness.commit(async (tx) => {
    const pending = await tx.doc(MemoryPendingDoc, found.persona, found.persona);
    const entry = pending.entries.find((item) => item.id === id);
    if (entry) entry.patch = result.patch;
  }, ctx);
  console.log(`[鱼缸] 记忆公共化脱敏 ${id} ok`);
  return "ok";
}

// ── /评 指令（T6，决策 11b）：sentmap 定位、评价包装配与待审管道 ────────────────

/** /评 指令的形状（严格解析，方向必填）：/评 好|差 <文字>；不匹配返回 undefined（落入未知指令）。 */
function parseEvalCommand(text: string): { direction: "好" | "差"; masterText: string } | undefined {
  const hit = /^\/评\s+(好|差)\s+([\s\S]+)$/.exec(text.trim());
  if (!hit) return undefined;
  return { direction: hit[1] as "好" | "差", masterText: hit[2].trim() };
}

/** 会话结构化历史的一条：/评 评价包的上下文来源（只取结构化 entry，不从渲染文本反解析）。 */
interface StructuredTurn {
  entryId: number;
  role: "fish" | "member";
  qq: string;
  nickname: string;
  text: string;
  at?: number;
}

/** 会话的结构化历史：fish.inbound（群友原话）+ fish.outbound（鱼发的话），文本截 200 字。 */
async function structuredHistoryOf(conv: Conversation): Promise<StructuredTurn[]> {
  const view = await conv.viewState(ctx);
  try {
    const turns: StructuredTurn[] = [];
    for (const entry of view.value.entries) {
      if (entry.kind === MEMORY_INBOUND_KIND) {
        const data = entry.data as Partial<MemoryInbound> | undefined;
        const text = typeof data?.text === "string" ? data.text.trim().slice(0, 200) : "";
        if (!text) continue;
        turns.push({
          entryId: entry.id as number,
          role: "member",
          qq: typeof data?.userId === "string" ? data.userId : "",
          nickname: typeof data?.nickname === "string" ? data.nickname : "",
          text,
        });
      } else if (entry.kind === "fish.outbound") {
        const data = entry.data as Partial<OutboundPayload> | undefined;
        const text = (data?.items ?? [])
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .join(" / ")
          .slice(0, 200);
        if (!text) continue;
        turns.push({
          entryId: entry.id as number,
          role: "fish",
          qq: "",
          nickname: "",
          text,
          at: typeof data?.at === "number" ? data.at : undefined,
        });
      }
    }
    return turns;
  } finally {
    view.dispose();
  }
}

/** 最近一条 fish.outbound（/评 指向型的降级目标）：从 transcript 尾部倒找。 */
async function lastOutboundOf(conv: Conversation): Promise<{ entryId: number; data: OutboundPayload } | undefined> {
  const view = await conv.viewState(ctx);
  try {
    for (let index = view.value.entries.length - 1; index >= 0; index--) {
      const entry = view.value.entries[index];
      if (entry?.kind === "fish.outbound") {
        return { entryId: entry.id as number, data: entry.data as OutboundPayload };
      }
    }
    return undefined;
  } finally {
    view.dispose();
  }
}

/** 当日该会话的 chatlog 总条数（in+out，含鱼）：/评 范围型统计口径之一。 */
function chatlogCountToday(chatKey: string): number {
  const file = join(HOME, "chatlog", localDay(Date.now()), `${chatKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`);
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** outbound payload → 评价包的被评条目快照。 */
function outboundSnapshotOf(entryId: number, data: OutboundPayload): EvalTargetSnapshot {
  return {
    entryId,
    at: data.at,
    items: data.items,
    ...(data.media !== undefined ? { media: data.media } : {}),
    ...(data.voice !== undefined ? { voice: data.voice } : {}),
    ...(data.quoteId !== undefined ? { quoteId: data.quoteId } : {}),
  };
}

/**
 * /评 好|差 <文字>（主人，闸前机械通道）：装配评价包（决策 11b，好差同构）——被评条目
 * （含引用链）+ 前 20 条会话摘要（结构化快照）+ 涉及群员清单 + 群/人格/日期 + 主人原文，
 * 写入待审（同待审管道，不直接落库）；评价事件写 fish.eval entry（进抽取白名单、排除摘要）。
 * 指向型（回复引用鱼的消息）经 fish.sentmap 定位，查不到降级「最近一条 fish.outbound」
 * 并在回执注明 eval_unknown_target；范围型附当日统计（口径写进回执）。
 * 回执由 handleCommand 的通用尾部经 fish.enqueue 发出（不产生 outbound entry、不进 transcript）。
 */
async function runEvalCommand(
  conv: Conversation,
  msg: IncomingMessage,
  cmd: { direction: "好" | "差"; masterText: string },
): Promise<string> {
  const pointed = (msg.replyIds?.length ?? 0) > 0;

  // ① 定位：指向型经 sentmap → outbound entry（tx.entry 按 id 直取，换页后仍可回溯）；
  //    未命中（引的不是鱼的消息 / 机械消息 / 超出 30 天窗口）降级最近一条并标注
  let degraded = false;
  let target: { conv: Conversation; snapshot: EvalTargetSnapshot } | undefined;
  if (pointed) {
    const sentmap = await fish.harness.snapshot(SentmapDoc, ctx);
    const replyId = String(msg.replyIds?.[0] ?? "");
    const hit = replyId ? sentmap?.map[replyId] : undefined;
    if (hit) {
      const entry = await fish.harness.commit(
        (tx) => tx.entry(OutboundEntry, Number(hit.entryId) as EntryId),
        ctx,
      );
      const targetConv = await fish.harness.conversation(Number(hit.conversationId) as ConversationId, ctx);
      if (entry && targetConv) target = { conv: targetConv, snapshot: outboundSnapshotOf(Number(hit.entryId), entry.data) };
    }
    if (!target) {
      degraded = true;
      const last = await lastOutboundOf(conv);
      if (last) target = { conv, snapshot: outboundSnapshotOf(last.entryId, last.data) };
    }
  }

  // ② 评价发生的会话与人格：指向型 = 被评条目所在会话；范围型 = 指令所在会话
  const evalConv = target?.conv ?? conv;
  const evalChatKey = chatKeyFor(evalConv.id) ?? msg.chatKey;
  const persona = memoryKeyOf(mappingKeys.get(String(evalConv.id)) ?? evalChatKey);
  const at = Date.now();
  const day = localDay(at);

  // ③ 前 20 条会话摘要（结构化快照）：指向型以被评条目收尾，范围型取最近 20 条
  const history = await structuredHistoryOf(evalConv);
  const anchor = target !== undefined
    ? history.findIndex((turn) => turn.entryId === target!.snapshot.entryId)
    : -1;
  const window = target !== undefined && anchor >= 0
    ? history.slice(Math.max(0, anchor - 19), anchor + 1)
    : history.slice(-20);
  const context: FeedbackContextItem[] = window.map((turn) => ({
    ref: String(turn.entryId),
    role: turn.role,
    ...(turn.role === "member" ? { qq: turn.qq, nickname: turn.nickname } : {}),
    text: turn.text,
  }));

  // ④ 引用链：鱼当时回的那条原始消息（quoteId 从 recent 流水解析）。不可得时不静默省略：
  // 事件里用 quotedFromMissing 显式标注（终审 #6）。sentmap 覆盖口径（现状，本期不扩）：
  // sentmap 只记群内 say_* 出口的发送记录，私聊与语音出口不在内——指向型评价私聊/语音
  // 消息时按「未命中降级最近一条」走，引用链多数不可得，按缺失标注呈现
  const quoteTarget = target?.snapshot.quoteId;
  const quotedFrom = quoteTarget !== undefined
    ? (() => {
        const source = (recent.get(baseChatKey(evalChatKey)) ?? [])
          .find((item) => item.messageId !== undefined && String(item.messageId) === String(quoteTarget));
        return source
          ? { qq: String(source.userId), nickname: source.nickname, text: source.text.slice(0, 200) }
          : undefined;
      })()
    : undefined;

  // ⑤ 涉及群员清单（结构化快照，新到旧去重）：上下文成员 + 被引消息作者
  const members: { qq: string; nickname: string }[] = [];
  for (const turn of [...window].reverse()) {
    if (turn.role !== "member" || !turn.qq) continue;
    if (!members.some((member) => member.qq === turn.qq)) members.push({ qq: turn.qq, nickname: turn.nickname });
  }
  if (quotedFrom && !members.some((member) => member.qq === quotedFrom.qq)) {
    members.push({ qq: quotedFrom.qq, nickname: quotedFrom.nickname });
  }

  // ⑥ 当日统计（口径写进回执）：本会话（当前人格）今日发言条数 + chatlog 当日总条数
  const fishToday = history.filter((turn) => turn.role === "fish" && turn.at !== undefined && localDay(turn.at) === day).length;
  const statsLine = ["今日鱼发言 " + fishToday + " 条（本会话）", "会话流水 " + chatlogCountToday(evalChatKey) + " 条（chatlog 含鱼）"].join(" · ");

  // ⑦ 摘要与事件装配（好差同构，方向只是字段；截断在 buildFeedbackPending 里机械执行）
  const targetSummary = target
    ? (target.snapshot.items.find((item) => item.trim().length > 0)?.slice(0, 20)
      ?? (target.snapshot.media !== undefined ? "[图]" : target.snapshot.voice !== undefined ? "[语音]" : ""))
    : (pointed ? "最近无可评发言" : "当日整体表现");
  const event: EvalEventData = {
    direction: cmd.direction,
    masterText: cmd.masterText,
    targetSummary,
    degraded,
    ...(target ? { target: target.snapshot } : {}),
    // 引用链缺失的显式标注：对象展开不会被多余属性检查拒绝，也避免了在 event 类型上撒谎的强转；
    // 下游用 quotedFromMissing === true 区分「没有引用链」与「引用链查不到」
    ...(quotedFrom ? { quotedFrom } : { quotedFromMissing: true }),
    context,
    members,
    chatKey: evalChatKey,
    persona,
    day,
  };
  const pendingEntry = buildFeedbackPending({
    direction: cmd.direction,
    targetSummary,
    statsLine,
    // 引用链摘要与缺失标注互斥（终验 #6）：待审 feedback 结构保留 quotedFromMissing，
    // /记忆 列表据此补「被引消息不可回溯」
    ...(quotedFrom ? { quotedFrom: `${quotedFrom.nickname}：${quotedFrom.text.slice(0, 24)}` } : { quotedFromMissing: true as const }),
    context,
    originChatKey: baseChatKey(evalChatKey),
    chatKey: evalChatKey,
    persona,
    day,
    masterText: cmd.masterText,
    at,
  });

  // ⑧ 同一次提交落两处：待审 patch（跨人格唯一 id，同待审管道，未批准不落库）+ fish.eval
  // entry（书记性 entry，不进模型上下文；进抽取白名单、排除摘要）。待审淘汰与压缩链路同口径。
  await fish.harness.commit(async (tx) => {
    await tx.appendEntry(MemoryEvalEntry, evalConv.id, { data: event });
    const pending = await tx.doc(MemoryPendingDoc, persona, persona);
    pending.entries.push(pendingEntry);
    while (pending.entries.length > MEMORY_PENDING_CAP) {
      const evicted = pending.entries.shift();
      if (evicted !== undefined) console.log(`[鱼缸] 记忆待审淘汰 ${evicted.id} ${persona}`);
    }
  }, ctx);

  // ⑨ 回执文本（eval_receipt / eval_unknown_target 在 prompt/messages.md）；发送在 handleCommand 尾部
  const receipt = renderTemplate(fish.prompts.messages["eval_receipt"] ?? "", {
    direction: cmd.direction === "好" ? "好评" : "差评",
    type: pointed ? "指向型" : "范围型",
    target: pointed ? `「${targetSummary}」` : statsLine,
  });
  // 拼接式而非模板字面量（\n 在模板内会破坏 prompt-lint 的栅栏号配对）
  return degraded ? receipt + "\n" + (fish.prompts.messages["eval_unknown_target"] ?? "") : receipt;
}

async function handleCommand(msg: IncomingMessage): Promise<string | null> {
  if (!msg.text.startsWith("/")) return null;
  const isMaster = String(msg.userId) === config.master;
  // /评 特判（master 判定之前，T6 决策 11）：群内非主人回 eval_rejected；私聊非主人静默
  //（返回 null 落回闸前链路，gate 对陌生人私聊零回应，不违反私聊硬约束）
  if (!isMaster && (msg.text === "/评" || msg.text.startsWith("/评 "))) {
    if (!msg.chatKey.startsWith("qq:group:")) return null;
    const conv = await conversationFor(msg.chatKey);
    const rejected = fish.prompts.messages["eval_rejected"] ?? "";
    await fish.enqueue(conv.id, {
      items: [rejected],
      quote: true,
      quoteId: msg.messageId,
      quoteForce: true,
      at: Date.now(),
      key: `eval-rej:${msg.messageId ?? Date.now()}`, // 幂等键：崩溃重放不重复发
    });
    await drainLoop();
    return rejected;
  }
  if (!isMaster) return null;
  const conv = await conversationFor(msg.chatKey); // 切换前先定回执落点
  const list = fish.personas.join("、");
  const target = /^\/切换人格\s+(\S+)/.exec(msg.text);
  let text: string;
  let media: string | undefined;
  let opener: string | undefined;
  // /评 指令（主人，闸前机械通道，不进模型）：评价包装配见 runEvalCommand（决策 11b）
  const evalCommand = parseEvalCommand(msg.text);
  // /记忆 审批（闸前机械通道）：解析在 memory.ts 的 parseMemoryCommand，执行与文案装配
  // 都在 harness 的 memoryCommandReply（群内只回引导语；私聊全局单视图列表/同意/拒绝）
  const memoryCommand = parseMemoryCommand(msg.text);
  if (evalCommand) {
    text = await runEvalCommand(conv, msg, evalCommand);
  } else if (memoryCommand) {
    // 公共批准先过 AI 脱敏（仅私聊通道；群内 /记忆 无副作用，照旧只回引导语）。
    // 改写成功写回待审后走原审批（回执展示改写后文本）；失败 fail closed，直接回错误文案
    if (memoryCommand.kind === "approve" && memoryCommand.track === "公共" && !msg.chatKey.startsWith("qq:group:")) {
      if ((await publicizePendingForApproval(memoryCommand.id)) === "failed") {
        text = renderTemplate(fish.prompts.messages["cmd_memory_publicize_failed"] ?? "", { id: memoryCommand.id });
      } else {
        text = await fish.memoryCommandReply(msg.chatKey, memoryCommand);
      }
    } else {
      text = await fish.memoryCommandReply(msg.chatKey, memoryCommand);
    }
  } else if (msg.text === "/查询可用人格") {
    text = renderTemplate(fish.prompts.messages["cmd_personas"] ?? "", { list });
  } else if (msg.text === "/关看图") {
    setLookDisabled(true);
    text = fish.prompts.messages["cmd_look_off"] ?? "";
  } else if (msg.text === "/开看图") {
    setLookDisabled(false);
    text = fish.prompts.messages["cmd_look_on"] ?? "";
  } else if (msg.text === "/压缩") {
    // 强制换页当前会话（无视阈值）：混入的重内容（图块等）立即清掉。
    // 走统一守卫：换页期间到达的群消息/私聊会看到 compacting，不会与换页并发。
    const result = await compactWithGuard(conv, true, msg.chatKey);
    text = result.compacted
      ? renderTemplate(fish.prompts.messages["cmd_compacted"] ?? "", { entries: String(result.entries), chars: String(result.chars) })
      : (fish.prompts.messages["cmd_compact_skip"] ?? "");
  } else if (target) {
    const persona = target[1];
    if (fish.personas.includes(persona)) {
      // 切换只写状态：后续 conversationFor 按映射键换会话，不新建/不删除会话
      await fish.harness.commit(async (tx) => {
        const doc = await tx.doc(ChatsDoc);
        doc.personas ??= {};
        doc.personas[msg.chatKey] = persona;
      }, ctx);
      text = renderTemplate(fish.prompts.messages["cmd_switched"] ?? "", { persona });
      // 人设图存在才带（相对 mediaRoot 引用，无 media/ 层）；默认人格不配图
      media = existsSync(join(config.mediaRoot, "personas", `${persona}.png`)) ? `personas/${persona}.png` : undefined;
      // 人格书 frontmatter 里的开场白：回执之后由宿主机械补发，不进模型
      opener = fish.openers[persona];
    } else {
      text = renderTemplate(fish.prompts.messages["cmd_bad_persona"] ?? "", { persona, list });
    }
  } else {
    text = renderTemplate(fish.prompts.messages["cmd_unknown"] ?? "", { cmd: msg.text.split(/\s+/)[0] });
  }
  await fish.enqueue(conv.id, {
    items: [text],
    ...(media ? { media } : {}),
    quote: true,
    quoteId: msg.messageId,
    quoteForce: true,
    at: Date.now(),
    key: `cmd:${msg.messageId ?? Date.now()}`, // 幂等键：崩溃重放不重复发
  });
  // 开场白紧随回执（同一会话、同一 outbox，顺序即发送顺序）；无 opener 的人格不増发。
  // 不带图不引用；幂等键前缀区别于回执。
  if (opener) {
    await fish.enqueue(conv.id, {
      items: [opener],
      quote: false,
      at: Date.now(),
      key: `opener:${msg.messageId ?? Date.now()}`,
    });
  }
  await drainLoop();
  return text;
}

// 启动先把上次没发出去的消息补发掉
async function drainLoop(): Promise<void> {
  try {
    const sent = await fish.drain();
    if (sent > 0) console.log(`[鱼缸] 补发 ${sent} 条`);
  } catch (error) {
    console.error("[鱼缸] 补发失败", error instanceof Error ? error.message : error);
  }
}

// next 搭话开窗状态机：每 tick 现读 fishConfig()（窗口时长热改含无消息期都在 tick 里消化）；
// gate 的 isOpen 接它的相位，未跟踪/白名单外恒 closed。open 进入经 onPhase 提交 injection 轮
// （背景板）；open 态的 free_pass 消息由 onMessage 路由进它的 shard 收集器，每
// engage.shardSeconds（缺省 20 秒）一拍经 onShard 合并提交（ambient）；closed 进入只留相位日志。
const engageNext = createEngageNext({
  // 状态机群表 = .env GROUPS 全量（2026-11 起 legacy 下线，安全域即行为域）：
  // 不在 GROUPS 的群永不维护相位、永不开窗；gate 也只放行 GROUPS 群，两处同源。
  groups: () => config.groups.map((g) => "qq:group:" + g),
  recentOf: (chatKey) => recent.get(chatKey) ?? [],
  backlogOf: (chatKey, afterSeq) => engageBacklogOf(chatKey, afterSeq),
  busy: (chatKey) => {
    // 该群任一会话（含人格映射键）正被换页 / 收图 / 在途轮占着：开窗放弃积压注入、
    // shard 到期累积背压（宁少勿答）
    for (const conv of conversations.values()) {
      if (chatKeys.get(conv.id) === chatKey && conversationBusy(conv.id)) return true;
    }
    return false;
  },
  onPhase: (chatKey, phase, backlog) => {
    // open → injection 轮（背景板，日志在 submitInjectionRound 里）；closed → 相位日志
    if (phase === "open") return submitInjectionRound(chatKey, backlog);
    console.log(`[鱼缸] ${chatKey} 搭话窗口 → ${phase}`);
  },
  onShard: (chatKey, items) => submitShardRound(chatKey, items),
  // 自由活动模式（2026-11-05）：专用白名单 ∩ GROUPS 恒 open，60 秒一拍由状态机 tick 驱动；
  // 空拍时状态机掷自主门，门开才回调这里（同一拍内提交「主动交流机会」，忙则放弃，宁少勿答）
  freeOf: (chatKey) => freeModeOf(chatKey),
  onFreeIdle: (chatKey, gate) => submitBrowseOpportunity(chatKey, gate),
  // 让行：这一分钟有人在攒 @ 组时先让必答轮走，本拍顺延（消息不丢，最多多等一拍）
  yieldTo: (chatKey) => debouncer.pendingOf(chatKey).length > 0,
  config: () => {
    const c = fishConfig().config;
    // video.dailyBudget 的每 tick 热读点（T3）：弹药 scheduler 停用后仍在的 active 热加载路径
    syncBiliBudget();
    return {
      closedMinutes: c.engage.closedMinutes,
      openMinutes: c.engage.openMinutes,
      // shard 节拍（T14）：engage.shardSeconds，缺省 20 秒，每拍现读热生效
      shardSeconds: c.engage.shardSeconds,
      // 自由活动模式三键：拍长（秒）/ 空拍自主门概率 / 单拍收集上限，每拍现读热生效
      freeSeconds: c.engage.freeSeconds,
      freeBrowseChance: c.engage.freeBrowseChance,
      freeBatchMax: c.engage.freeBatchMax,
      // 旧分享门（E5，兼容保留）：弹药管线已停用，宿主不再消费 shareGateOf
      ammoShareChance: c.ammo.shareChance,
      // 视频浏览门（T3）：video.browseChance，开窗进入时一次挷落相位并选定 topic（热读：下一窗生效）
      videoBrowseChance: c.video.browseChance,
    };
  },
  log: (message) => console.log(`[鱼缸] ${message}`),
  onError: (error) => console.error("[鱼缸] 搭话开窗回调失败", error instanceof Error ? error.message : error),
});

// 视频浏览门接线（T3）：空窗零新增主动轮与 T4 的浏览/分享工具经这个单例读当前 open 窗的
// windowId/topic/门结果；未开窗/closed 的 chatKey 拿到 undefined，授权一律拒（fail closed）。
// 旧 ammo 分享门接线（wireAmmoShareHost）已随管线停用摘除：出口 ammoId claim 链恒 fail closed。
wireVideoBrowseHost({ gateOf: (chatKey) => engageNext.videoBrowseGateOf(chatKey) });

// ── B 站每日预算热加载（2026-11-04 模型输入计划 T3）──────────────────────────
// worker 逛轮 / 空库补货 / 手动逛轮 / 弹药分享挂点已随弹药管线停用整体摘除；
// 旧实现见 git 历史与保留的兼容源码（external/scheduler、external/ammo-store、ammo_* 工具包）。

/**
 * video.dailyBudget 热生效：共享 bili 客户端长驻进程（仍 active 的 video 工具用它），
 * 配置读取/变更都把当前值灌进去——启动一次、engage-next 每 tick 的配置热读点一次
 * （弹药 scheduler 停用后的唯一 active 热加载路径，不依赖已停用的 scheduler tick），
 * config 工具 set ammo 的旧变更路径照旧保留在工具内。旧 ammo.dailyBudget 只在
 * video.dailyBudget 缺省时作回退（见 fish-config.ts 的 loadFishConfig）。
 */
function syncBiliBudget(): void {
  getBiliClient().setDailyBudget(fishConfig().config.video.dailyBudget);
}
syncBiliBudget(); // 启动即灌一次：共享客户端在首次请求前就持有当前预算上限（缺省 60）

// ── 新闻播报 job（外部计划 Task E7，决策 10–12）：scheduler 第二实例 news.at 起播 ──────

const NEWS_JOB_TIMEOUT_MS = 45 * 60_000; // 硬截止：30 分钟推迟窗口 + 取料/归纳/播报余量
const NEWS_ABORT_MARGIN_MS = 60_000; // 抢跑余量：比 scheduler watchdog 早 60s abort 在途会话，保证 failed_timeout 落账前已收束
const NEWS_DEFER_MAX_MS = 30 * 60_000; // T15：末条自言最多推迟 30 分钟（决策 10，宁少勿扰）
const NEWS_DEFER_STEP_MS = 5 * 60_000; // 推迟重查步长（每 5 分钟重查）
const NEWS_RUNS_TTL_DAYS = 30; // fish.news_runs 只服务幂等与近期审计，写入时顺手清老账

/** fish.news_runs 账本（决策 4）：localDay+targetGroup 幂等，state + digest。 */
interface NewsRunRecord {
  localDay: string;
  targetGroup: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  /** 失败原因（成功时不写）。 */
  error?: string;
  /** 成品播报文本（≤500 字，审计用）。 */
  digest?: string;
}
interface NewsRunsState {
  /** key = newsRunKeyOf(localDay, targetGroup)。 */
  runs: Record<string, NewsRunRecord>;
}
const NewsRunsDoc = defineDoc<NewsRunsState>({
  kind: "fish.news_runs",
  version: 1,
  scope: "session",
  initial: () => ({ runs: {} }),
  checkpointWhen: () => true,
});

function newsRunKeyOf(day: string, group: string): string {
  return `${day} ${group}`;
}

async function readNewsRun(day: string, group: string): Promise<NewsRunRecord | undefined> {
  const doc = await fish.harness.snapshot(NewsRunsDoc, ctx);
  return doc?.runs?.[newsRunKeyOf(day, group)];
}

async function writeNewsRun(record: NewsRunRecord): Promise<void> {
  await fish.harness.commit(async (tx) => {
    const doc = await tx.doc(NewsRunsDoc);
    doc.runs ??= {};
    doc.runs[newsRunKeyOf(record.localDay, record.targetGroup)] = record;
    const horizon = localDay(Date.now() - NEWS_RUNS_TTL_DAYS * 86_400_000);
    for (const [key, run] of Object.entries(doc.runs)) {
      if (run.localDay < horizon) delete doc.runs[key];
    }
  }, ctx);
}

/** 新闻取料客户端：单源失败降内容不阻断，全源失败抛 NewsAllSourcesDownError（E6）。 */
const newsClient = createNewsClient({ log: (message) => console.log(`[鱼缸] ${message}`) });

/** 归纳输入：标题级 items 带宿主索引（[n] = sourceRef），URL 不进模型。 */
function buildNewsDigestInput(feeds: readonly NewsTopicFeed[]): { prompt: string; index: Map<string, NewsItem> } {
  const index = new Map<string, NewsItem>();
  const blocks: string[] = [];
  let seq = 0;
  for (const feed of feeds) {
    const lines: string[] = [];
    for (const item of feed.items) {
      const ref = String(seq++);
      index.set(ref, item);
      lines.push(`[${ref}] ${item.title}`);
    }
    blocks.push([`## ${feed.topic}`, ...lines].join("\n"));
  }
  return { prompt: blocks.join("\n\n"), index };
}

/** main 模型一次性调用（与记忆脱敏同款入口）：返回拼接后的纯文本输出。 */
async function completeNewsDigest(prompt: string): Promise<string> {
  const model = models.getModel(mainModel.provider, mainModel.modelId);
  if (!model) throw new Error(`model_not_found:${mainModel.provider}/${mainModel.modelId}`);
  const message = await models.streamSimple(model, { messages: [{ role: "user", content: prompt }] }).result();
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function newsStrOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 严格对象判定：非 null 非数组的 object 才算，否则 undefined（严格 schema 的形状闸）。 */
function newsObjOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** 键集合完全一致才算过：NewsDigest 严格 schema 的「不增」检查（未知字段拒绝）。 */
function newsKeysMatch(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/**
 * 严格解析 NewsDigest（终验 #10 修复）：
 *   - 未知字段拒绝：根对象只认 sections+closing，section 只认 topic+items，item 只认
 *     summary+sourceRef，键集合多一个、少一个都整体作废（调用方重试一次后放弃当日）；
 *   - sections 按输入 feed 顺序重建：模型乱序输出由宿主纠序，输入里的 topic 缺席、
 *     未知/重复 topic、未知/重复 sourceRef 一律整体作废（不增不减）；
 *   - 空 section 策略（与 prompt/news-digest.md 一致）：模型可以对没有可播条目的 topic
 *     给空 items——宿主丢弃空 section 并记一行日志（「无可播条目，已省略」，不算违约），
 *     全部 topic 都空才返回 undefined。
 */
function parseNewsDigest(
  raw: string,
  feeds: readonly NewsTopicFeed[],
  index: ReadonlyMap<string, NewsItem>,
  perTopicOutput: number,
): NewsDigest | undefined {
  // 容忍一层代码围栏：只取首个 { 到末个 } 之间的内容，其余一概不认
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const root = newsObjOf(parsed);
  if (root === undefined || !newsKeysMatch(root, ["sections", "closing"]) || !Array.isArray(root["sections"])) return undefined;
  const topicNames = new Set(feeds.map((feed) => feed.topic));
  const byTopic = new Map<string, NewsDigestSection>();
  for (const rawSection of root["sections"]) {
    const section = newsObjOf(rawSection);
    if (section === undefined || !newsKeysMatch(section, ["topic", "items"]) || !Array.isArray(section["items"])) return undefined;
    const topic = newsStrOf(section["topic"]);
    // topic 必须逐字命中输入（不增不减）：未知或重复 topic 都是 schema 违约，整体作废
    if (!topicNames.has(topic) || byTopic.has(topic)) return undefined;
    const seenRefs = new Set<string>();
    const items: NewsDigestItem[] = [];
    for (const rawItem of section["items"]) {
      if (items.length >= perTopicOutput) break; // 超上限的部分不采信（截断语义不变）
      const entry = newsObjOf(rawItem);
      if (entry === undefined || !newsKeysMatch(entry, ["summary", "sourceRef"])) return undefined;
      const ref = newsStrOf(entry["sourceRef"]).trim();
      if (!index.has(ref) || seenRefs.has(ref)) return undefined; // 未知/重复索引：违约
      const summary = sanitizeExternalText(newsStrOf(entry["summary"]), { maxLen: 60 });
      if (summary.length === 0 || /https?:\/\//i.test(summary)) return undefined; // URL 不进模型输出
      seenRefs.add(ref);
      items.push({ summary, sourceRef: ref });
    }
    byTopic.set(topic, { topic, items });
  }
  // 按输入 feed 顺序重建；输入里的 topic 少一个 section 都算「减」，整体作废
  const sections: NewsDigestSection[] = [];
  for (const feed of feeds) {
    const section = byTopic.get(feed.topic);
    if (section === undefined) return undefined;
    if (section.items.length === 0) {
      console.log(`[鱼缸] 新闻 ${feed.topic} 空条目，省略`);
      continue;
    }
    sections.push(section);
  }
  if (sections.length === 0) return undefined;
  // closing 同样剥 URL（终验 #7）：宿主渲染时链接只从 sourceRef 索引拼接，收尾句不许带链接
  const closing = stripOutboundLinks(sanitizeExternalText(newsStrOf(root["closing"]), { maxLen: 60 }));
  return { sections, closing };
}

/** 归纳（决策 12）：模型/解析失败重试 1 次，两次都失败抛错——调用方放弃当日。 */
async function digestNewsWithRetry(
  prompt: string,
  feeds: readonly NewsTopicFeed[],
  index: ReadonlyMap<string, NewsItem>,
  perTopicOutput: number,
): Promise<NewsDigest> {
  let reason = "digest_invalid";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw = "";
    try {
      raw = await completeNewsDigest(prompt);
    } catch (error) {
      reason = `digest_model:${error instanceof Error ? error.message.slice(0, 60) : "error"}`;
      continue;
    }
    const digest = parseNewsDigest(raw, feeds, index, perTopicOutput);
    if (digest !== undefined) return digest;
    reason = "digest_invalid";
  }
  throw new Error(reason);
}

/**
 * 宿主渲染成品播报：模板 key（news_header/news_topic/news_item/news_closing）逐行拼装，
 * canonical 链接由 sourceRef 索引现查（模型输出里没有 URL）；≤budget（缺省 500）字，
 * 超限按 topic 顺序裁剪；收尾句预算预留，只要头行之后放得下就保证在场。
 * 返回值附 links：实际进了播报的条目的 canonical URL（按 sourceRef 索引现查，顺序同播报），
 * 宿主登记进新闻轮闸，出口重建 payload 时只认这份列表——模型文本里的 URL 一律剥掉。
 */
const sleepUnref = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * T15 推迟（决策 10）：发送前查末条自言（lastWasFish），为 true 则每 5 分钟重查，
 * ≤30 分钟；会话忙（换页/收图/在途轮）一并等。窗口内仍不行返回 false——放弃当日，宁少勿扰。
 * cancelled 回调（新闻硬截止抢跑闸）返回 true 时立即放失败，不再等槽位。
 */
async function awaitNewsSlot(conv: Conversation, chatKey: string, cancelled?: () => boolean): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (cancelled?.() === true) return false;
    if (!lastWasFish.has(chatKey) && !conversationBusy(conv.id)) return true;
    if (Date.now() - startedAt >= NEWS_DEFER_MAX_MS) return false;
    console.log(`[鱼缸] 新闻推迟 ${chatKey}（自言或忙）`);
    await sleepUnref(NEWS_DEFER_STEP_MS);
  }
}

/**
 * 一次新闻播报作业（news scheduler 的 onJob）：
 *   ① targetGroup ∈ GROUPS 硬校验（不过则跳过并告警，不记 run）；
 *   ② 幂等：fish.news_runs（localDay+targetGroup）已有任意状态记录就不再触发；
 *   ③ 取料（全源失败抛错→当日不发）→ main 模型按 NewsDigest 严格 schema 归纳
 *     （失败重试 1 次后放弃当日）→ 宿主渲染 ≤500 字（超限按 topic 顺序裁剪，
 *     links = 实际进播报条目的 canonical 链接表）；
 *   ④ T15 末条自言推迟 ≤30 分钟，仍自言放弃当日；
 *   ⑤ scheduled answer 轮（目标群当前人格的 conversation）——出口被新闻轮闸机械收束
 *     （say-shared 登记）：只许一次 say_words，payload 由宿主重建（模型文本剥 URL，
 *     canonical 链接只按 sourceRef 索引拼接）；mustAnswer 关闭（裸文本兜底不发——
 *     播报必须带宿主链接，无出口记 failed，当日不再触发），零出口/发送失败不重发。
 *   ⑥ 硬截止抢跑闸：比 scheduler watchdog 早 NEWS_ABORT_MARGIN_MS 把对应 Conversation
 *     abort（abort 自带等待 idle），scheduler 落 failed_timeout 前在途轮已收束，
 *     不存在「已判失败还在发」的窗口。
 */
async function runNewsJob(slot: string, date: string): Promise<void> {
  const news = fishConfig().config.news;
  const group = String(news.targetGroup).trim();
  // 安全域（P1-7）：目标群必须 ∈ .env GROUPS；空目标群时调度器时点表为空，根本不会起作业
  if (group.length === 0 || !config.groups.includes(group)) {
    console.log(`[鱼缸] 新闻跳过 ${date} ${slot}（GROUPS 域外）`);
    return;
  }
  const key = newsRunKeyOf(date, group);
  const startedAt = Date.now();
  const prior = await readNewsRun(date, group);
  if (prior) {
    console.log(`[鱼缸] 新闻跳过 ${key}（已 ${prior.state}）`);
    return;
  }
  await writeNewsRun({ localDay: date, targetGroup: group, state: "running", startedAt });
  const fail = async (reason: string): Promise<void> => {
    const clipped = reason.slice(0, 120);
    await writeNewsRun({ localDay: date, targetGroup: group, state: "failed", startedAt, finishedAt: Date.now(), error: clipped });
    console.log(`[鱼缸] 新闻失败 ${key} ${clipped}`);
  };
  // 硬截止抢跑闸：到点先置 timedOut 并 abort 对应会话（在途轮收束、排队输入撤回），
  // 后续各阶段见到 timedOut 都直接放弃；conv 在 conversationFor 之后才存在，之前的阶段
  // 没有可发的出口，置位即可。scheduler 自己的 watchdog 晚 NEWS_ABORT_MARGIN_MS 才落账。
  let conv: Conversation | undefined;
  let timedOut = false;
  const guard = setTimeout(() => {
    timedOut = true;
    if (conv === undefined) return;
    console.log(`[鱼缸] 新闻硬截止 ${key}：abort 在途会话`);
    void conv.abort(ctx).catch((error: unknown) =>
      console.error("[鱼缸] 新闻 abort 失败", error instanceof Error ? error.message : error),
    );
  }, Math.max(1_000, NEWS_JOB_TIMEOUT_MS - NEWS_ABORT_MARGIN_MS));
  guard.unref?.();
  try {
    const feeds = await newsClient.collectForTopics(news.topics, { perTopicInput: news.perTopicInput });
    if (timedOut) throw new Error("news_timeout");
    // 空 topic 不进归纳：某个源全挂时（如 60s/微博同时不可用），军事/趣闻可能一条候选都没有。
    // 把空的 `## topic` 段喂给模型会诱发畸形 JSON（模型会试图补空 section，甚至输出两段
    // JSON 自我修正），严格解析必然 digest_invalid。空 topic 本来就会被丢弃，这里提前过滤，
    // 语义不变，只是不再让它污染模型输入。
    const present = feeds.filter((feed) => feed.items.length > 0);
    const { prompt, index } = buildNewsDigestInput(present);
    if (index.size === 0) throw new Error("no_items");
    // 归纳提示词（prompt/news-digest.md）：指令 + {{topics}} 标题块 + {{max}} 每 topic 上限
    const digestPrompt = renderTemplate(fish.prompts.newsDigest, { topics: prompt, max: String(news.perTopicOutput) });
    const digest = await digestNewsWithRetry(digestPrompt, present, index, news.perTopicOutput);
    if (timedOut) throw new Error("news_timeout");
    const broadcast = renderNewsBroadcast(date, digest, index, fish.prompts.messages);
    if (broadcast.text.length === 0) throw new Error("render_empty");
    const chatKey = `qq:group:${group}`;
    conv = await conversationFor(chatKey);
    if (!(await awaitNewsSlot(conv, chatKey, () => timedOut))) throw new Error(timedOut ? "news_timeout" : "defer_giveup");
    if (timedOut) throw new Error("news_timeout");
    // 新闻轮闸：登记本轮 + canonical 链接表，say_words 出口由宿主重建 payload、单次封顶
    beginNewsBroadcastRound(String(conv.id), broadcast.links);
    try {
      const outcome = await submitRound({
        chatKey,
        conv,
        content: renderNewsTask(fish.prompts.messages, broadcast.text),
        trigger: { mentionsBot: false, kind: "answer" },
        reply: false,
        mustAnswer: false,
        entryKind: MEMORY_ENGAGE_KIND,
      });
      if (timedOut) throw new Error("news_timeout");
      if (outcome !== "done") throw new Error(`round_${outcome}`);
      // 单出口闸核对：模型一次 say_words 都没调（零出口）不算播完——裸文本兜底已关，
      // 没有宿主重建的 canonical 链接就不该有「done」的播报账
      if (!newsBroadcastDelivered(String(conv.id))) throw new Error("news_no_exit");
    } finally {
      endNewsBroadcastRound(String(conv.id));
    }
    await writeNewsRun({ localDay: date, targetGroup: group, state: "done", startedAt, finishedAt: Date.now(), digest: broadcast.text });
    console.log(`[鱼缸] 新闻播完 ${key}`);
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(guard);
  }
}

// 第二实例（决策 1 的 job 模型 + 决策 11 的 news.at 时点）：错过 ≤2h 补跑是 scheduler
// 通用能力；幂等账在 fish.news_runs，不传 jobs（不写 external_jobs，避免与逛轮的
// date+slot 键互相覆盖），重启后的补跑重触发由 news_runs 挡住（重复触发不重发）
const newsScheduler = createScheduler({
  slots: () => (fishConfig().config.news.targetGroup.trim().length > 0 ? [fishConfig().config.news.at] : []),
  onJob: (slot, date) => runNewsJob(slot, date),
  now: () => new Date(),
  ...nodeTimers,
  jobTimeoutMs: () => NEWS_JOB_TIMEOUT_MS,
  log: (message) => console.log(`[鱼缸] news ${message}`),
});

const gate = createGate({
  master: config.master,
  groups: config.groups,
  // 开窗两态判定：接状态机相位；未跟踪 = closed（非 @ 恒 skip:next_pending）
  isOpen: (chatKey) => engageNext.isOpen(chatKey),
});

/** 群周报：周日 21 点整点档私聊发给主人一次，var/weekly.json 记住发过的周防止重发。 */
function startWeekly(): void {
  const weeklyPath = join(HOME, "weekly.json");
  const weekOf = (t: number) => {
    const d = new Date(t);
    const day = (d.getDay() + 6) % 7; // 周一为 0
    return localDay(t - day * 86_400_000);
  };
  setInterval(() => {
    void (async () => {
      const now = Date.now();
      const d = new Date(now);
      if (d.getDay() !== 0 || d.getHours() !== 21 || d.getMinutes() !== 0) return;
      const week = weekOf(now);
      const done = new Set(existsSync(weeklyPath) ? (JSON.parse(readFileSync(weeklyPath, "utf8")) as string[]) : []);
      const chatKey = `qq:private:${config.master}`;
      if (!config.master || done.has(`${chatKey}:${week}`)) return;
      const weeklyGroupId = fishConfig().config.weeklyGroupId ?? "";
      if (!weeklyGroupId) return;
      const groupKey = `qq:group:${weeklyGroupId}`;
      const stats = weeklyStats(join(HOME, "chatlog"), groupKey, now);
      if (!stats) return;
      const conv = await fish.group(chatKey);
      for (const line of renderWeekly(stats)) {
        await fish.enqueue(conv.id, { items: [line], at: now, key: `weekly:${week}:${line.slice(0, 8)}` });
      }
      done.add(`${chatKey}:${week}`);
      writeFileSync(weeklyPath, JSON.stringify([...done].slice(-200)));
      await drainLoop();
    })().catch((error: unknown) => {
      console.error("[鱼缸] 周报发送失败", error instanceof Error ? error.message : error);
    });
  }, 60_000).unref?.();
}

// 每个群的最近流水：背景栏与连续发言都从这里取。
// 流水带 userId / messageId / arrivalSeq：入站补充（查名片/下头像/拉合集）是异步的，
// 处理完成顺序可能倒过来，消费侧按收到顺序排（orderByArrival），模型才能看到自然的对话；
// 旧构造没有 arrivalSeq 时原地不动（即改版前的到达顺序）。
// userId 是背景行里「昵称(QQ号)」的来源，模型主动 @ 只从可信上下文抄号码。
export const recent = new Map<string, RecentChatMessage[]>();

// 流水上限：缺省 30 不变；开窗积压的放宽（engage.windowRelaxCap）需要流水兜底，
// 上限提升为 max(30, windowRelaxCap)。
const recentCap = () => Math.max(30, fishConfig().config.engage.windowRelaxCap);

// 群消息按「群 + 发送者」攒 10 秒：同一个人还在打字就一直往后延，静默满 10 秒才整组提交。
// 窗口固定 10000ms，不设环境变量也不设最长等待；重启时没 flush 的窗口直接丢弃。
// debounce 攒满后的整组提交走 app 的第二入口（index 里 app.onFlush(flushBurst) +
// setFlushSink）；默认直连 flushBurst，保证没接线时行为不变。
let flushSink: (burst: PendingBurst) => Promise<void> = (burst) => flushBurst(burst);
export function setFlushSink(sink: (burst: PendingBurst) => Promise<void>): void {
  flushSink = sink;
}

export const debouncer = createDebouncer({
  windowMs: DEBOUNCE_WINDOW_MS,
  onFlush: (burst) => flushSink(burst),
  onError: (error) => console.error("[鱼缸] 待定消息提交失败", error instanceof Error ? error.message : error),
});

/**
 * 一条入站消息在中间件链里携带的上下文（相当于 Express 的 req）。
 *
 * 只放消息链各段真的会读写的东西；runtime 的全局状态（fish/onebot/recent/…）仍在
 * 本模块里，由各段直接取，不塞进 ctx——避免 ctx 变成第二个杂物袋。
 */
export interface MessageCtx {
  msg: IncomingMessage;
  /** 背景流水（含本条）；normalize 段写，后续段只读。 */
  bucket: RecentChatMessage[];
  /** bypass 剥离结果；null = 这条没带 bypass 段。 */
  bypass: ReturnType<typeof splitBypass> | null;
  /** 给模型看的整组文本（合集折叠 / bypass 剥离之后）；gate 被拦的 follow-up 也用它并窗。 */
  burstText: string;
  /** gate 判决；gate 段写，后面两段只读。 */
  decision?: GateDecision;
}

/** 新消息的初始上下文；字段在 normalize 段里补齐。 */
export function createMessageCtx(msg: IncomingMessage): MessageCtx {
  return { msg, bucket: [], bypass: null, burstText: msg.text };
}

/**
 * ① 入站归一：末条自言、原始文本、卡片渲染、背景流水、昵称映射、chatlog、bypass 剥离。
 *
 * 顺序是行为契约：lastWasFish 最先清；原始文本必须在卡片渲染前取；chatlog 记 bypass
 * 剥离前的原文；背景流水也要在 bypass 剥离前落（背景行只陈述群友原话）。
 */
export const normalizeInbound: Middleware<MessageCtx> = async (ctx, next) => {
  const msg = ctx.msg;
  // 末条自言标记（决策 24）：任一入站消息都清掉本群的标记——有人说了话，
  // 群里最新一条就不再是鱼自己发的了。置顶在处理链最前，后续本条触发的
  // 机械回执 / drain 发送若真发出去，emit 会重新置回 true。
  lastWasFish.delete(msg.chatKey);
  // 记忆 entry 的原始文本：必须在卡片渲染（就地改写 msg.text）与 bypass 剥离之前取，
  // 只去掉 [卡片#N] 占位与 bypass 指令，不携带任何宿主渲染文案
  rawMemoryText.set(msg, memoryTextOf(msg.text));
  // 分享卡片：文本里只有 [卡片#N] 占位，这里按卡片内容渲染成可读文本
  // （B 站小程序卡片带 b23.tv 短链，鱼据此就能调 video 去看那条视频）
  if (msg.cards && msg.cards.length > 0) {
    for (const [index, card] of msg.cards.entries()) {
      const isBili = /bilibili\.com|b23\.tv/i.test(card.url ?? "");
      const template = (isBili ? fish.prompts.messages["card_bilibili"] : fish.prompts.messages["card_link"]) ?? "";
      const rendered = renderTemplate(template, {
        title: card.title ?? "",
        desc: card.desc ?? "",
        url: card.url ?? "",
      }).trim();
      if (rendered) {
        msg.text = msg.text.replace(`[卡片#${index}]`, rendered);
        // 引用原文里的卡片占位与正文共享同一个 cards 下标空间（onebot 水合时追加），
        // 同样换成可读文本；否则模型只能看到裸占位
        if (msg.quoted) msg.quoted.text = msg.quoted.text.replace(`[卡片#${index}]`, rendered);
      }
    }
  }

  const bucket = orderByArrival([
    ...(recent.get(msg.chatKey) ?? []),
    {
      userId: msg.userId,
      nickname: msg.nickname,
      text: backgroundTextOf(msg, fish.prompts.messages),
      at: Date.now(),
      ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
      ...(msg.arrivalSeq !== undefined ? { arrivalSeq: msg.arrivalSeq } : {}),
      ...(msg.mediaOnly ? { mediaOnly: msg.mediaOnly } : {}),
    },
  ]);
  const cap = recentCap();
  if (bucket.length > cap) bucket.splice(0, bucket.length - cap);
  recent.set(msg.chatKey, bucket);
  ctx.bucket = bucket;

  // 昵称 → QQ 映射：每条入站消息（含被闸挡掉的）都登记，memory scope 靠它把背景
  // 里最近发言的人映射成 subject（Later 从 name: 得到 QQ 时也靠它对齐）
  if (msg.nickname) {
    const names = nameToQq.get(msg.chatKey) ?? new Map<string, string>();
    names.set(msg.nickname, String(msg.userId));
    nameToQq.set(msg.chatKey, names);
  }

  chatlog.append({ at: Date.now(), chat: msg.chatKey, from: msg.nickname, text: msg.text, kind: "in" });

  // bypass 段剥离：chatlog 已记原文；之后 gate 打分与模型上下文只见干净文本。
  const bypass = bypassAllowed(msg.userId, msg.groupId, config.master, config.bypassGroups)
    ? splitBypass(msg.text)
    : null;
  if (bypass) msg.text = bypass.clean || (fish.prompts.messages["bypass_placeholder"] ?? "(draw)");
  ctx.bypass = bypass;

  // 连续发言窗口的输入：这条消息给模型看的文本——带结构化合集的用自身正文
  //（[转发合集] 标签与内容占位由渲染器负责），其余（旧形态文本 / 未展开合集
  // 记录）仍折叠成短标记；bypass 段作为 opaque 载荷跟着走。
  ctx.burstText = msg.forward !== undefined ? msg.text : backgroundTextOf(msg, fish.prompts.messages);

  await next();
};

/**
 * ② 动图自动收：群里来了一张 gif，就让鱼看着「前 10 条上下文」决定要不要收进库。
 * 不走随机门（收图与开不开口无关），但它在静默轮里跑，不会冒话；fire-and-forget，
 * 不阻塞后续消息链。
 */
export const ingestGifStage: Middleware<MessageCtx> = async (ctx, next) => {
  void maybeIngestGif(ctx.msg, ctx.bucket);
  await next();
};

/** ③ 主人 `/` 指令：bypass 剥离后、闸前机械拦截，不进 gate、不进 conversation。 */
export const commandsStage: Middleware<MessageCtx> = async (ctx, next) => {
  if ((await handleCommand(ctx.msg)) !== null) return;
  await next();
};

/** ④ 规则闸：判决留痕；被拦的同发送者 follow-up 并进已有窗口（一组话不拆两轮）。 */
export const gateStage: Middleware<MessageCtx> = async (ctx, next) => {
  const msg = ctx.msg;
  const decision = await gate.decide({ msg });
  // gate 判决留痕（不记正文）
  const verdict = (decision.enter ? "enter:" : "skip:") + decision.reason;
  console.log("[fish] gate " + msg.chatKey + " " + msg.nickname.slice(0, 12) + " -> " + verdict);
  ctx.decision = decision;

  if (!decision.enter) {
    if (msg.chatKey.startsWith("qq:group:") && debouncer.pending(msg.chatKey, msg.userId)) {
      debouncer.push({
        msg,
        text: ctx.burstText,
        ...(ctx.bypass ? { payload: ctx.bypass.stash } : {}),
      });
    }
    return;
  }
  await next();
};

/**
 * ⑤ 群消息去向：open 态 free_pass 进 shard 收集器；其余进按发送者的 10 秒窗口。
 * 不调 next —— 群消息到这一层就交给 debounce / shard，不再往下走。
 */
export const groupWindowStage: Middleware<MessageCtx> = async (ctx, next) => {
  const msg = ctx.msg;
  if (!msg.chatKey.startsWith("qq:group:")) {
    await next();
    return;
  }
  const decision = ctx.decision!;
  // next 的 open 态：free_pass（非 @）消息不进按发送者的合并窗口，改投 shard
  // 收集器（每 10 秒一拍、全部发送者合成一轮 ambient）。同发送者已有 @ 待定窗口
  // 时照旧并入——一组话不拆两轮；纯 GIF 交给静默收图轮，不进 shard 行。
  // 收集器不收（窗口已关 / 未跟踪的边缘竞态）：宁少勿答，留日志丢弃。
  if (decision.reason === "free_pass" && !debouncer.pending(msg.chatKey, msg.userId)) {
    if (msg.mediaOnly !== "gif") {
      const collected = engageNext.collectShard(msg.chatKey, {
        userId: msg.userId,
        nickname: msg.nickname,
        text: ctx.burstText,
        at: Date.now(),
        ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
        ...(msg.arrivalSeq !== undefined ? { arrivalSeq: msg.arrivalSeq } : {}),
        ...(ctx.bypass ? { payload: ctx.bypass.stash } : {}),
        // 批内回复关系（2026-11-05）：让一拍里的「谁在回谁」可见，被引原文随批附上
        replyIds: msg.replyIds,
        ...(msg.quoted !== undefined ? { quoted: msg.quoted } : {}),
      });
      if (!collected) {
        console.log("[fish] gate " + msg.chatKey + " " + msg.nickname.slice(0, 12) + " -> shard:closed_drop");
      }
    }
    return;
  }
  // 必答放行随窗口累积（flush 时整组消费）：任一条必答进闸，整组都算必答
  const key = windowKey(msg.chatKey, msg.userId);
  burstMustAnswer.set(key, (burstMustAnswer.get(key) ?? false) || MUST_ANSWER_REASONS.has(decision.reason));
  // 只在新窗口上生效：首次 push 把当时的会话（人格）钉住，后面的 follow-up 改不动
  debouncer.push({
    msg,
    text: ctx.burstText,
    ...(ctx.bypass ? { payload: ctx.bypass.stash } : {}),
    binding: await conversationFor(msg.chatKey),
  });
};

/**
 * ⑥ 私聊：保持既有即时语义，不进 debounce；换页/收图轮忙时被 @ 只回机械忙碌语。
 * 不调 next —— 私聊到这一层就提交完了。
 */
export const privateChatStage: Middleware<MessageCtx> = async (ctx, next) => {
  const msg = ctx.msg;
  if (msg.chatKey.startsWith("qq:group:")) {
    await next();
    return;
  }
  const conv = await conversationFor(msg.chatKey);

  // 换页 / 收图轮进行中：不再受理新提交（根治换页竞态把活跃轮吃掉的问题）。
  // 被 @ 的给一句机械回复（同样走 outbox 唯一出口），其余直接等下一轮。
  if (conversationBusy(conv.id)) {
    if (msg.mentionsBot) await sendBusyReplies(conv, [msg.messageId]);
    return;
  }

  const memoryInbound: MemoryInbound = {
    chatKey: msg.chatKey,
    userId: String(msg.userId),
    nickname: msg.nickname,
    text: rawMemoryText.get(msg) ?? memoryTextOf(msg.text),
  };
  const speakers = [{ subject: `qq:${msg.userId}`, name: msg.nickname }];
  for (const name of ctx.bucket.slice(-4).map((m) => m.nickname)) {
    const qq = nameToQq.get(msg.chatKey)?.get(name);
    if (qq && !speakers.some((s) => s.subject === `qq:${qq}`)) speakers.push({ subject: `qq:${qq}`, name });
  }

  // 主人私聊手动逛轮窄口已随弹药管线停用摘除（T3）：ammo_submit 已进 disabled 包，
  // 不再有任何轮钉 manualAmmoRun 上下文
  await submitRound({
    chatKey: msg.chatKey,
    conv,
    content: withContext(msg, ctx.bucket, [], { master: config.master, messages: fish.prompts.messages }).content,
    trigger: {
      messageId: msg.messageId,
      mentionsBot: msg.mentionsBot,
      userId: msg.userId,
      kind: "answer",
    },
    // 回复链：本轮触发本身是在回复某条消息，鱼的回应应引用触发那条
    reply: (msg.replyIds?.length ?? 0) > 0,
    mustAnswer: MUST_ANSWER_REASONS.has(ctx.decision!.reason),
    ...(ctx.bypass ? { bypass: ctx.bypass.stash } : {}),
    memory: { inbound: memoryInbound, speakers },
  });
};

/** OneBot 入口接线：把每条入站消息送进 app 的中间件链；错误在最外层统一留痕。 */
export function listenMessages(app: { dispatch(ctx: MessageCtx): Promise<void> }): () => void {
  return () => {
    onebot.onMessage((raw) => {
      void app.dispatch(createMessageCtx(raw)).catch((error: unknown) => {
        console.error("[鱼缸] 处理消息失败", error instanceof Error ? error.message : error);
      });
    });
  };
}

/** 启动：连 OneBot；连不上直接退出（协议端/地址/token 三件事自查）。 */
export async function connectOnebot(): Promise<void> {
  try {
    await onebot.connect();
  } catch {
    console.error(`[鱼缸] 连不上 ${config.onebotUrl}`);
    console.error("  1. 协议端启动了吗");
    console.error("  2. 地址和 token 对吗");
    console.error("  3. 跑 npm run probe 看详情");
    process.exit(1);
  }

  if (!config.master) {
    console.error("[鱼缸] 没设 MASTER_QQ");
    console.error("  私聊会被当成陌生人");
  }
}

/**
 * 启动恢复：群映射（drain 要知道往哪发）、历史重启文件清理、restart 通知、补发一次。
 * 必须在 OneBot 连上之后跑：restart 确认与补发都要真的发得出去。
 */
export async function restoreSessions(): Promise<void> {
  // 先把持久化的群映射读出来，这样 drain 知道该往哪个群发
  const known = await fish.harness.snapshot(ChatsDoc, ctx);
  for (const [chatKey, conversationId] of Object.entries(known?.chats ?? {})) {
    // 存键可能是映射键（chatKey#人格）：剥离后缀再灌 chatKeys，
    // 否则重启后补发 Number("qq:group:123#鲸鱼娘")=NaN，丢消息且打断后续会话补发
    chatKeys.set(String(conversationId), baseChatKey(chatKey));
    mappingKeys.set(String(conversationId), chatKey);
  }
  // 历史遗留的重启文件只清理不消费：sending 不再翻回 queued（发出多少不确定，宁可少发不重复），
  // 遗言（模型文本）不再补发
  for (const legacy of ["restart.marker", "restart.pending.json"]) {
    const legacyPath = join(process.cwd(), "var", legacy);
    if (existsSync(legacyPath)) {
      try { rmSync(legacyPath); } catch {}
      console.log(`[鱼缸] 已清理历史重启文件 ${legacy}`);
    }
  }
  // restart 工具留下的通知：定位触发重启的会话，启动成功后向它发一条固定机械确认
  // （restart_done，在 src/tools/restart/TOOL.md 的 tool-messages 块，经 outbox 唯一出口）。先入队再删文件：启动中途
  // 崩掉也不会重复确认——outbox 键由通知里的稳定 key 派生，幂等表会挡掉已发出的那一次
  const noticePath = join(process.cwd(), "var", "restart.notice.json");
  if (existsSync(noticePath)) {
    try {
      const notice = JSON.parse(readFileSync(noticePath, "utf8")) as { conversationId: string; key: string };
      const chatKey = [...chatKeys.entries()].find(([id]) => String(id) === notice.conversationId)?.[1];
      if (chatKey) {
        const conv = await conversationFor(chatKey);
        await fish.enqueue(conv.id, {
          items: [fish.prompts.messages["restart_done"] ?? "重启完成"],
          at: Date.now(),
          key: `restart-done:${notice.conversationId}:${notice.key}`,
        });
        console.log(`[鱼缸] 重启确认已排队到 ${chatKey}`);
      } else {
        console.error(`[鱼缸] 重启通知找不到会话：${notice.conversationId}`);
      }
      rmSync(noticePath);
    } catch (error) {
      console.error("[鱼缸] 处理重启通知失败", error instanceof Error ? error.message : error);
      try { rmSync(noticePath); } catch {}
    }
  }
  await drainLoop();
}

/** 启动横幅：deploy 脚本等「已连接」这行判断存活。 */
export function printBanner(): void {
  const shown = describeModel(config.modelConfig);
  console.log(`[鱼缸] 已连接，模型 ${shown.provider}/${shown.model}，工具 ${fish.toolNames.join("、")}`);
  console.log(`[鱼缸] 视觉 ${visionModel.provider}/${visionModel.modelId}，兜底 ${visionFallbackModel ? `${visionFallbackModel.provider}/${visionFallbackModel.modelId}` : "无"}，图片 ${modelSelection.image ? `${modelSelection.image.provider}/${modelSelection.image.modelId}` : "未配置"}`);
  console.log(`[鱼缸] 凭据 ${shown.key}（${shown.keySource}）`);
}

/** 开窗状态机 + 周报：都在 OneBot 连上之前起，与迁移前的模块加载时点一致。 */
export function startEngage(): void {
  startWeekly();
  // 开窗循环开始跳：每个 GROUPS 群从 closed 零计时起相位
  engageNext.start();
}

export function stopEngage(): void {
  // 先停开窗循环：退出后不再触发相位迁移回调
  engageNext.stop();
}

export function startNews(): void {
  newsScheduler.start();
}

export function stopNews(): void {
  // 停新闻调度：在途播报由 scheduler watchdog 收束，news_runs 幂等挡重启重发
  newsScheduler.stop();
}

/** 退出前冲刷 outbox（已承诺发送的消息不丢；在途生成轮会被中断）。 */
export async function drainOnStop(): Promise<void> {
  try {
    const sent = await fish.drain();
    if (sent > 0) console.log(`[鱼缸] 退出前补发 ${sent} 条`);
  } catch {
    // 尽力而为
  }
}

export function closeOnebot(): void {
  // 先冲刷再断 WS：让协议端立即感知重连，不等它自己的超时
  onebot.close();
}

export async function closeFish(): Promise<void> {
  try {
    await fish.close();
  } catch {
    // 尽力而为
  }
}

/**
 * 优雅退出：deploy 发 SIGTERM 后跑 app.stop()（它按注册逆序跑 onStop：
 * 停调度 → 停开窗 → 冲刷 → 断 WS → 关库），15 秒兜底强制退出。
 */
export function installSignals(stop: () => Promise<void>): void {
  let closing = false;
  process.on("SIGTERM", () => {
    if (closing) return;
    closing = true;
    console.log("[鱼缸] SIGTERM，冲刷后退出");
    void (async () => {
      try {
        await stop();
      } catch {
        // 收尾失败也继续退出
      }
      process.exit(0);
    })();
    setTimeout(() => process.exit(0), 15_000).unref?.();
  });
}
