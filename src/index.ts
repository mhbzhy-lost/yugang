/**
 * 鱼缸的入口：OneBot ⇄ pi-durable。
 *
 *   群消息 → 规则闸/打分闸 → conversation.submit() → agent loop
 *                                                      ├── thinking/正文/tool  ✗ 不出境
 *                                                      └── say / react / look
 *                                                            → 硬校验 → QQ
 *
 * 模型的正文、思考、tool 调用文本都不在这条链上。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { addFishProvider, createFishModels } from "./models.ts";
import { describeModel, loadFishModels } from "./model-config.ts";
import { cleanupStaleVideoTemps } from "./tools/video/tool.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Conversation } from "@earendil-works/pi-durable";
import { openFish, type GroupProfile } from "./harness.ts";
import { OneBot, orderByArrival, type IncomingMessage } from "./qq/onebot.ts";
import { DEFAULT_PERSONA_NAME, personaOf, pickVoice } from "./voice-route.ts";
import { createGate } from "./qq/gate.ts";
import {
  createDebouncer,
  withContext,
  DEBOUNCE_WINDOW_MS,
  lastPayload,
  type PendingBurst,
  type RecentChatMessage,
} from "./qq/debounce.ts";
import { replaceWatched, type WatchedMap } from "./qq/watch-state.ts";
import type { CompactResult } from "./compact.ts";
import { setLookDisabled } from "./tools/look/tool.ts";
import { clearMemeImportRound } from "./tools/meme_import/shared.ts";
import { hasMemeMd5, md5OfFile } from "./media/meme-store.ts";
import { absorbSecrets } from "./egress/absorb.ts";
import { resetRun, resetLook, ledgerOf } from "./egress/ledger.ts";
import { validateOutbound, DEFAULT_LIMITS } from "./egress/policy.ts";
import { createChatlog } from "./chatlog.ts";
import { localDay } from "./usage.ts";
import { weeklyStats, renderWeekly } from "./stats.ts";
import { createUsageLedger, sumUsage } from "./usage.ts";
import { bypassAllowed, splitBypass } from "./bypass.ts";
import { ChatsDoc, WatchDoc } from "./store.ts";
import { renderTemplate } from "./prompts.ts";
import { createConfigLoader } from "./fish-config.ts";
import { UsageDoc } from "@earendil-works/pi-durable";

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

// 收表情包等后台轮：这一轮只允许调工具，不许说话（say 会拒绝）
const silentRounds = new Set<string>();

// chatKey → userId → 已累计的发言次数：每第 3 条给一句「可以选择用语音回」的提示。
// 只是提示，不是门禁——用不用由鱼自己判断。
const voiceCredits = new Map<string, Map<string, number>>();

// 会话 id → 映射键（chatKey 或 chatKey#人格）。chatKeys 存的是剥离人格的 base 键
// （emit 要解析数字 id），人格相关的配置（音色）必须走这张表，否则重启后
// 人格身份丢失 → personaOf 回退「默认」→ 拿默认音色开口（长征机用爱莉声音说话）
const mappingKeys = new Map<string, string>();

/**
 * 背景栏里的合集只留一个短标记：一次展开是 10 条起，若上面十条全是合集，
 * 上下文会被瞬间撑爆。鱼看不到就看不到，没关系。
 */
function collapseForward(text: string): string {
  if (!/\[转发合集 \d+ 条\]/.test(text)) return text;
  const marker = fish.prompts.messages["forward_collapsed"] ?? "";
  return marker.length > 0 ? marker : "[收集]";
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
  // 空名单会直接删 key：否则「这个群有特别关注」永远为真
  replaceWatched(watchedByChat, baseChatKey(chatKey), people);
}

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
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
const mainModel = { provider: modelSelection.main.providerId, modelId: modelSelection.main.modelId };
const visionModel = { provider: modelSelection.vision.providerId, modelId: modelSelection.vision.modelId };

const onebot = new OneBot(config.onebotUrl, config.onebotToken, config.mediaRoot);
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
/** 会话是不是正被换页或静默收图轮占着：起新提交与起换页前都要先看它。 */
function conversationBusy(id: string | number): boolean {
  const key = String(id);
  return compacting.has(key) || ingestRounds.has(key);
}
const lastMention = new Map<string, boolean>();
// 本轮触发是否是回复某条消息：是则鱼的回应强制引用（回复链可读性）
const lastReply = new Map<string, boolean>(); // 最近一次触发是否@了鱼：被@必回引用，让群里看得出鱼在回谁
// submissionId → 本轮触发消息：把引用目标绑在轮上，不被后续消息顶掉；
// userId 是主动 @ 身份闸的唯一依据（不靠模型文本推断关系）。
const triggerOf = new Map<string, { messageId?: number | string; mentionsBot: boolean; userId?: number }>();
// submissionId → 本轮触发消息自带的 bypass 段；仅该轮 draw 可见，轮 settle 即删
const bypassOf = new Map<string, string>();
const conversations = new Map<string, Conversation>();

const fish = await openFish({
  storage: await openNodeSqliteStorage(join(HOME, "fish.db")),
  models,
  model: mainModel,
  // 思考档位：off|minimal|low|medium|high|xhigh|max。最低可用思考档是 low
  // （deepseek 的 minimal 映射为 null，等于不支持），缺省 off
  thinkingLevel: fishConfig().config.thinkingLevel,
  toolTimeoutSeconds: fishConfig().config.toolTimeoutSeconds,
  // 只有 video 单独放宽：要下视频、抽帧、逐帧过视觉模型
  toolTimeoutOverrides: { video: 90, gpt_image: 210 },
  // codex 订阅走 WebSocket（Node 的 WS 不吃 --use-env-proxy），过代理时在 main provider 写 transport: "sse"
  ...(modelSelection.transport ? { streamTransport: modelSelection.transport } : {}),
  // 表情包跨轮冷却：每个人格会话独立计时
  memeCooldownMs: () => Math.round(fishConfig().config.memeCooldownMinutes * 60_000),
  // 语音：按会话所在人格取配置（只认 fish.config 的 voices，没配就是没有语音）
  ttsOf: (conversationId) => voiceConfigFor(mappingKeys.get(String(conversationId)) ?? ""),
  // look / video 的视觉描述模型：models.vision；省略时与 models.main 相同
  visionModel,
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
  // model 管理工具写回同一个文件
  modelsPath: modelSelection.main.configSource,
  sdUrl: process.env.SD_WEBUI_URL,
  // （sdUrl 存在时见启动处的邻居保温定时器）
  tagsCsv: join(HOME, "danbooru.csv"),
  master: config.master,
  triggerOf: (roundId) => triggerOf.get(String(roundId)),
  silentOf: (roundId) => silentRounds.has(String(roundId)),
  // watch 的号码校验：从会话映射回群号，再拉全量成员（不要 limit，要能校验到每个人）
  onWatchChanged: (conversationId, people) => {
    const chatKey = chatKeyFor(conversationId);
    if (!chatKey) return;
    // 整份替换：删掉的人（含已退群、watch remove 掉的）立刻失去主动 @ 权限与随机门加权
    applyWatched(chatKey, people);
  },
  // 主动 @ 的身份闸（机械判定）：私聊没有 @ 这回事；群内只有主人或本群特别关注者能点名别人。
  // 成员名单必须从 chatKeys 映射回当前群号再拉，绝不采信模型给的号码。
  mentionPolicyOf: (conversationId, triggerUserId) => {
    const chatKey = chatKeyFor(conversationId);
    if (!chatKey || !chatKey.startsWith("qq:group:")) return "not_group";
    if (triggerUserId === undefined) return "not_privileged";
    const userId = String(triggerUserId);
    if (config.master && userId === config.master) return "allow";
    return watchedByChat.get(baseChatKey(chatKey))?.has(userId) ? "allow" : "not_privileged";
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
  // outbox 里的消息由 fish.drain() 逐条交给这里；幂等表再加一层保险
  emit: async (conversationId, payload) => {
    // 恢复轮强发：有意重启时还没真正发出的消息不走幂等去重（去重表可能已在崩溃前提前记了账）
    if (!recoveringDrain && sent.has(payload.key)) return;
    const chatKey = chatKeys.get(conversationId);
    if (!chatKey) return;

    if (chatKey.startsWith("qq:group:")) {
      const groupId = Number(chatKey.slice("qq:group:".length));
      // 引用只认本轮绑定的 quoteId：缺失就裸发，绝不回退 lastMessageId——
      // 那会拿后续消息当引用目标，正文与引用错位、整轮答非所问
      const quote = (payload.quote || payload.quoteForce === true || lastMention.get(conversationId) === true || lastReply.get(conversationId) === true)
        ? payload.quoteId
        : undefined;
      await onebot.sendGroup(groupId, payload.items, { quote, ...(payload.mentions && payload.mentions.length > 0 ? { mentions: payload.mentions } : {}) });
      if (payload.media) await onebot.sendImageGroup(groupId, resolve(config.mediaRoot, payload.media));
      if (payload.voice) {
        await onebot.sendVoiceGroup(groupId, readFileSync(resolve(config.mediaRoot, payload.voice)));
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
    markSent(payload.key);

    for (const text of payload.items) {
      chatlog.append({ at: payload.at, chat: chatKey, from: "fish", text, kind: "out" });
    }
  },
  react: async (conversationId, emoji, messageId) => {
    // 轮级绑定：只贴本轮触发的那条。会话级 lastMessageId 会被后到的消息顶掉，
    // 那一下就会贴到别人刚发的话上。本轮没绑到消息（例如静默轮）就不贴。
    if (messageId === undefined) return;
    await onebot.react(messageId, emoji);
  },
});

/** 群档案：只在第一次见到这个群时抓一次，之后由 transcript 记着。 */
async function profileFor(groupId: number): Promise<GroupProfile | undefined> {
  const info = await onebot.groupInfo(groupId);
  if (!info) return undefined;
  const members = await onebot.groupMembers(groupId);
  return {
    name: info.name,
    groupId: String(groupId),
    count: info.count || members.length,
    owner: info.owner,
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

async function conversationFor(chatKey: string): Promise<Conversation> {
  // 当前人格：非变更式读取（严禁对 snapshot() 结果赋值）
  const snapshot = await fish.harness.snapshot(ChatsDoc, ctx);
  const persona = snapshot?.personas?.[chatKey] ?? "默认";
  // 悬空人格名与 group() 同规则回退默认，内存缓存键才能对上持久化映射键
  const effective = persona !== "默认" && !fish.personas.includes(persona) ? "默认" : persona;
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
 * 上下文拼装与 5 秒连续发言合并都不在这里：状态机与 withContext 在 src/qq/debounce.ts，
 * 这里只负责把 flush / submit 接上，并做轮级清账与记账。
 */
/**
 * 动图自动收：gif 进群时起一个静默轮，把前 10 条上下文一起给鱼，
 * 由它判断这张图值不值得当表情包、调用 meme_add 打标入库。
 *
 * 边界：只认 .gif（白名单，避免把截图/照片也拖进模型）；md5 已在库里的跳过。
 */
async function maybeIngestGif(msg: IncomingMessage, bucket: { nickname: string; text: string }[]): Promise<void> {
  if (!msg.chatKey.startsWith("qq:group:")) return;
  if (!config.groups.length || !config.groups.includes(String(msg.groupId))) return;
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
    const header = renderTemplate(fish.prompts.messages["gif_ingest_header"] ?? "", { count: String(prior.length) });
    const context = prior.map((m) => `${m.nickname}: ${m.text}`).join("\n");
    const task = renderTemplate(fish.prompts.messages["gif_ingest_task"] ?? "", {
      ref: gif.ref,
      who: msg.nickname,
    });
    const content = [header, context, task].filter((line) => line.length > 0).join("\n");
    ingestRounds.add(String(conv.id));
    try {
      // 留痕：这一轮是收图轮，起止都打日志，否则「为什么不收」永远查不到
      console.log(`[鱼缸] 收图轮开始 ${gif.ref} md5=${md5.slice(0, 10)}`);
      const submission = await conv.submit({ type: "input", content }, ctx);
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

/**
 * 提交一轮，等它跑完，再记账与换页。
 *
 * 轮级清账（resetRun / resetLook / lastMention / lastReply / 语音计数）
 * 全部挪到这里、在真正 submit 之前做：以前是 gate 放行那一刻就清，同一组连续发言的
 * follow-up 进来会把这一轮的引用目标和记账提前抹掉。
 */
async function submitRound(input: {
  chatKey: string;
  conv: Conversation;
  content: string;
  /** 本轮触发消息：引用目标与主动 @ 的身份闸都只认它 */
  trigger: { messageId?: number | string; mentionsBot: boolean; userId?: number };
  /** 本轮是不是在回复别人（回复链要引用） */
  reply: boolean;
  /** bypass 段（画图指令）；只在这一轮可见，轮 settle 即删 */
  bypass?: string;
}): Promise<void> {
  const { chatKey, conv, trigger } = input;
  await absorbSecrets(conv);
  resetRun(conv.id);
  resetLook(conv.id);
  // 被@必回引用，让群里看得出鱼在回谁
  lastMention.set(conv.id, trigger.mentionsBot);
  lastReply.set(conv.id, input.reply);

  let content = input.content;
  // 每第 3 条（主人/关注对象，且过了闸门）追加一行提示，让鱼知道这条可以用语音。
  // 计数按「轮」加，不按消息加：同一组连续发言只算一次。
  if (voiceConfigFor(mappingKeys.get(String(conv.id)) ?? chatKey) && isVoiceVip(chatKey, trigger.userId)) {
    const perUser = voiceCredits.get(chatKey) ?? new Map<string, number>();
    const count = (perUser.get(String(trigger.userId)) ?? 0) + 1;
    perUser.set(String(trigger.userId), count);
    voiceCredits.set(chatKey, perUser);
    if (count % 3 === 0) {
      const hint = fish.prompts.messages["voice_hint"] ?? "";
      if (hint) content = content + "\n" + hint;
    }
  }

  // 触发消息绑在 submission 上：轮在跑时新消息进来也不会把引用目标顶掉
  // （否则回复会串到别人的消息上）
  const submission = await conv.submit({ type: "input", content }, ctx);
  triggerOf.set(String(submission.id), {
    messageId: trigger.messageId,
    mentionsBot: trigger.mentionsBot,
    userId: trigger.userId,
  });
  if (input.bypass !== undefined) bypassOf.set(String(submission.id), input.bypass);

  // 成功、失败、抛错都要把这一轮的绑定清掉
  const settled = await (async () => {
    try {
      return await submission.wait(ctx);
    } finally {
      triggerOf.delete(String(submission.id));
      bypassOf.delete(String(submission.id));
      // 导入清单只属于这一轮：成功、失败、抛错都在这里清掉
      clearMemeImportRound(String(submission.id));
    }
  })();
  if (settled.status !== "done") {
    const why = [settled.status, (settled as { reason?: string }).reason, (settled as { detail?: string }).detail]
      .filter(Boolean)
      .join(" · ");
    console.error(`[鱼缸] ${chatKey} 这一轮没答上来：${why}`);
    return;
  }

  await drainLoop();

  // 记账：pi-durable 的 pi.usage 是累计值，这里取差落盘
  const spent = await fish.harness.snapshot(UsageDoc, conv.id, ctx);
  const delta = usage.append(chatKey, sumUsage(spent), Date.now());
  if (delta) {
    console.log(`[鱼缸] ${chatKey} +${delta.total} tokens / ${delta.cost}`);
  }

  const compacted = await compactWithGuard(conv);
  if (compacted.compacted) {
    console.log(`[鱼缸] ${chatKey} 换页 ${compacted.entries}条/${compacted.chars}字`);
  }
}

/**
 * 换页的统一守卫：手动 `/压缩`、轮后自动换页共用，静默收图轮在跑时直接跳过
 * （那一轮正在用这个会话，换页会把它吃掉；计账不受影响，下一轮再压）。
 * 换页期间把 id 记进 compacting，flushBurst / 私聊据此回忙碌语而不是提交。
 */
async function compactWithGuard(conv: Conversation, force = false): Promise<CompactResult> {
  if (ingestRounds.has(String(conv.id))) return { compacted: false };
  compacting.add(String(conv.id));
  try {
    return await fish.compact(conv, force);
  } finally {
    compacting.delete(String(conv.id));
  }
}

/**
 * 5 秒静默到期：整组一起进模型。
 *
 * 锚点 = 这一组按收到顺序最后一条（A-B-A 里 B 只出现在背景，不可能顶掉 A）；整组里任意一条 @鱼
 * 就整组必答；引用只看锚点。提交前重新检查会话忙：换页 / 收图轮期间不提交旧上下文，
 * 被@的按既有 busy 语义回执，pending 已由状态机先摘掉，不会留下陈年 burst。
 */
async function flushBurst(burst: PendingBurst): Promise<void> {
  const anchor = burst.anchor;
  // 会话/人格只认首次 push 那一份：5 秒窗口里主人 /切换人格 也改不了这一组的落点
  const conv = (burst.binding as Conversation | undefined) ?? (await conversationFor(anchor.chatKey));

  // 换页 / 收图轮进行中：不再受理新提交（根治换页竞态把活跃轮吃掉的问题）
  if (conversationBusy(conv.id)) {
    console.log(`[鱼缸] ${anchor.chatKey} 会话忙，丢弃待定组 ${burst.messages.length}`);
    await sendBusyReplies(conv, burst.messages.filter((m) => m.mentionsBot).map((m) => m.messageId));
    return;
  }

  // 命中特别关注：在要回的那一行前面打标（机械匹配 QQ 号，不靠模型回忆）
  const watched = watchedByChat.get(anchor.chatKey)?.get(String(anchor.userId));
  const watchedNote = watched
    ? renderTemplate(fish.prompts.messages["watch_inline"] ?? "", { who: anchor.nickname, note: watched.note })
    : "";
  let content = withContext(anchor, recent.get(anchor.chatKey) ?? [], burst.messages, {
    master: config.master,
    messages: fish.prompts.messages,
    ...(watchedNote ? { watchedNote } : {}),
  });

  // @ 鱼 + 文字里提到合集/转发：把这个群最近一条没展开的合集拉出来（10 分钟内有效）。
  // 场景：先发合集（不 @，被闸丢弃）→ 再 @ 问「上面那个能看吗」。合集记录里明确标了它是什么。
  if (burst.messages.some((m) => m.mentionsBot && /合集|转发/.test(m.text))) {
    const pending = onebot.recentForward(anchor.chatKey, 10 * 60_000);
    if (pending) {
      const expanded = await onebot.expandForwardById(pending, anchor);
      if (expanded) {
        content = `${fish.prompts.messages["forward_recent_prefix"] ?? ""}\n${expanded}\n${content}`;
        console.log(`[鱼缸] ${anchor.chatKey} 补展开最近合集`);
      }
    }
  }

  // 整组里最近一条非空 bypass 段：指令后面又跟了两句普通闲聊时，只取最后一条会让 draw 静默失效
  const payload = lastPayload(burst.messages);
  await submitRound({
    chatKey: anchor.chatKey,
    conv,
    content,
    // 引用锚点与主动 @ 的身份闸都只认锚点；但整组里任意一条 @鱼，整组都必答
    trigger: { messageId: anchor.messageId, mentionsBot: burst.mustAnswer, userId: anchor.userId },
    reply: burst.quoteFromReply,
    ...(payload !== undefined ? { bypass: payload } : {}),
  });
}

async function handleCommand(msg: IncomingMessage): Promise<string | null> {
  if (!msg.text.startsWith("/") || String(msg.userId) !== config.master) return null;
  const conv = await conversationFor(msg.chatKey); // 切换前先定回执落点
  const list = fish.personas.join("、");
  const target = /^\/切换人格\s+(\S+)/.exec(msg.text);
  let text: string;
  let media: string | undefined;
  let opener: string | undefined;
  if (msg.text === "/查询可用人格") {
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
    const result = await compactWithGuard(conv, true);
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

const gate = createGate({
  master: config.master,
  groups: config.groups,
  dailyQuota: 0,
  cooldownMs: 0,
  // 非 @、非特别关注：同一群两条被处理消息的最短间隔（限流）
  ambientMinIntervalMs: fishConfig().config.ambientMinIntervalSeconds * 1000,
  // 特别关注者发言时的放行概率（走随机门，照顾到但不是必答）
  watchedChance: fishConfig().config.watchAmbientChance,
  // 每轮现取：改 fish.config.json 下一轮就生效，不用重启
  chances: () => {
    const c = fishConfig().config;
    return { minIntervalMs: c.ambientMinIntervalSeconds * 1000, watched: c.watchAmbientChance };
  },
});

// 启动装载特别关注名单：随机门与命中注入都要用，重启后立刻生效
{
  const chats = await fish.harness.snapshot(ChatsDoc, ctx);
  for (const [chatKey, conversationId] of Object.entries(chats?.chats ?? {})) {
    const watch = await fish.harness.snapshot(WatchDoc, Number(conversationId) as never, ctx);
    applyWatched(chatKey, watch?.people ?? []);
  }
}

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
startWeekly();

// 每个群的最近流水：背景栏与连续发言都从这里取。
// 流水带 userId / messageId / arrivalSeq：入站补充（查名片/下头像/拉合集）是异步的，
// 处理完成顺序可能倒过来，消费侧按收到顺序排（orderByArrival），模型才能看到自然的对话；
// 旧构造没有 arrivalSeq 时原地不动（即改版前的到达顺序）。
// userId 是背景行里「昵称(QQ号)」的来源，模型主动 @ 只从可信上下文抄号码。
const recent = new Map<string, RecentChatMessage[]>();
const lastSpoke = new Map<string, number>();
const spokenToday = new Map<string, { day: string; count: number }>();
const today = () => new Date().toISOString().slice(0, 10);

// 群消息按「群 + 发送者」攒 5 秒：同一个人还在打字就一直往后延，静默满 5 秒才整组提交。
// 窗口固定 5000ms，不设环境变量也不设最长等待；重启时没 flush 的窗口直接丢弃。
const debouncer = createDebouncer({
  windowMs: DEBOUNCE_WINDOW_MS,
  onFlush: (burst) => flushBurst(burst),
  onError: (error) => console.error("[鱼缸] 待定消息提交失败", error instanceof Error ? error.message : error),
});

onebot.onMessage((raw) => {
  void (async () => {
    const msg = raw;
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
        if (rendered) msg.text = msg.text.replace(`[卡片#${index}]`, rendered);
      }
    }

    const bucket = orderByArrival([
      ...(recent.get(msg.chatKey) ?? []),
      {
        userId: msg.userId,
        nickname: msg.nickname,
        text: collapseForward(msg.text),
        at: Date.now(),
        ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
        ...(msg.arrivalSeq !== undefined ? { arrivalSeq: msg.arrivalSeq } : {}),
      },
    ]);
    if (bucket.length > 30) bucket.splice(0, bucket.length - 30);
    recent.set(msg.chatKey, bucket);

    chatlog.append({ at: Date.now(), chat: msg.chatKey, from: msg.nickname, text: msg.text, kind: "in" });

    // bypass 段剥离：chatlog 已记原文；之后 gate 打分与模型上下文只见干净文本。
    const bypass = bypassAllowed(msg.userId, msg.groupId, config.master, config.bypassGroups)
      ? splitBypass(msg.text)
      : null;
    if (bypass) msg.text = bypass.clean || (fish.prompts.messages["bypass_placeholder"] ?? "(draw)");

    // 动图自动收：群里来了一张 gif，就让鱼看着「前 10 条上下文」决定要不要收进库。
    // 不走随机门（收图与开不开口无关），但它在静默轮里跑，不会冒话。
    void maybeIngestGif(msg, bucket);

    // 主人 / 指令：bypass 剥离后、闸前拦截——机械秒回，不进 gate、不进 conversation
    if ((await handleCommand(msg)) !== null) return;

    const stat = spokenToday.get(msg.chatKey);
    const count = stat && stat.day === today() ? stat.count : 0;

    const watched = watchedByChat.get(msg.chatKey)?.get(String(msg.userId));
    const decision = await gate.decide({
      msg,
      ...(watched ? { watched: true } : {}),
      recent: bucket.slice(0, -1),
      lastSpokeAt: lastSpoke.get(msg.chatKey) ?? 0,
      spokenToday: count,
    });
    // gate 判决留痕（不记正文）
    const verdict = (decision.enter ? "enter:" : "skip:") + decision.reason;
    console.log("[fish] gate " + msg.chatKey + " " + msg.nickname.slice(0, 12) + " -> " + verdict);

    // 连续发言窗口的输入：这条消息给模型看的文本（合集已折叠、bypass 已换成占位），
    // bypass 段作为 opaque 载荷跟着走。
    const burstText = collapseForward(msg.text);
    const push = (conv?: Conversation) => debouncer.push({
      msg,
      text: burstText,
      ...(bypass ? { payload: bypass.stash } : {}),
      // 只在新窗口上生效：首次 push 把当时的会话（人格）钉住，后面的 follow-up 改不动
      ...(conv ? { binding: conv } : {}),
    });

    if (!decision.enter) {
      // 被闸拦下的同发送者 follow-up 也要并进已有窗口：一组话不能被拆成两轮。
      // 不同发送者不碰别人的窗口，也就不会重置别人的计时。
      if (msg.chatKey.startsWith("qq:group:") && debouncer.pending(msg.chatKey, msg.userId)) push();
      return;
    }

    // 群消息：gate 放行不立即提交，等 5 秒静默把整组一起送进 loop（flushBurst）。
    // 会话在这里先定下来（人格按当下解析）并绑到窗口上：5 秒里 `/切换人格` 也改不了落点。
    if (msg.chatKey.startsWith("qq:group:")) {
      push(await conversationFor(msg.chatKey));
      return;
    }

    // 私聊：保持既有即时语义，不进 debounce
    const conv = await conversationFor(msg.chatKey);

    // 换页 / 收图轮进行中：不再受理新提交（根治换页竞态把活跃轮吃掉的问题）。
    // 被 @ 的给一句机械回复（同样走 outbox 唯一出口），其余直接等下一轮。
    if (conversationBusy(conv.id)) {
      if (msg.mentionsBot) await sendBusyReplies(conv, [msg.messageId]);
      return;
    }

    await submitRound({
      chatKey: msg.chatKey,
      conv,
      content: withContext(msg, bucket, [], { master: config.master, messages: fish.prompts.messages }),
      trigger: { messageId: msg.messageId, mentionsBot: msg.mentionsBot, userId: msg.userId },
      // 回复链：本轮触发本身是在回复某条消息，鱼的回应应引用触发那条
      reply: (msg.replyIds?.length ?? 0) > 0,
      ...(bypass ? { bypass: bypass.stash } : {}),
    });
  })().catch((error: unknown) => {
    console.error("[鱼缸] 处理消息失败", error instanceof Error ? error.message : error);
  });
});

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

// 先把持久化的群映射读出来，这样 drain 知道该往哪个群发
const known = await fish.harness.snapshot(ChatsDoc, ctx);
for (const [chatKey, conversationId] of Object.entries(known?.chats ?? {})) {
  // 存键可能是映射键（chatKey#人格）：剥离后缀再灌 chatKeys，
  // 否则重启后补发 Number("qq:group:123#鲸鱼娘")=NaN，丢消息且打断后续会话补发
  chatKeys.set(String(conversationId), baseChatKey(chatKey));
  mappingKeys.set(String(conversationId), chatKey);
}
// 重启遗言：restart 工具写下的 restart.pending.json，起来后补发那句，发完即删
const pendingPath = join(process.cwd(), "var", "restart.pending.json");
if (existsSync(pendingPath)) {
  try {
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { conversationId: string; text: string };
    const chatKey = [...chatKeys.entries()].find(([id]) => String(id) === pending.conversationId)?.[1];
    if (chatKey) {
      const conv = await conversationFor(chatKey);
      await fish.enqueue(conv.id, {
        items: [pending.text],
        at: Date.now(),
        key: `restart-pending:${pending.conversationId}:${Date.now()}`,
      });
      await drainLoop();
      console.log(`[鱼缸] 重启遗言已补发到 ${chatKey}`);
    } else {
      console.error(`[鱼缸] 重启遗言找不到会话：${pending.conversationId}`);
    }
    rmSync(pendingPath);
  } catch (error) {
    console.error("[鱼缸] 补发重启遗言失败", error instanceof Error ? error.message : error);
    try { rmSync(pendingPath); } catch {}
  }
}
// 有意重启的标记：把卡在 sending 的消息翻回 queued 一起补发（真崩溃不重发，语义不变）
const marker = join(process.cwd(), "var", "restart.marker");
let recoveringDrain = false;
if (existsSync(marker)) {
  const recovered = await fish.recoverStaleSends();
  rmSync(marker);
  if (recovered > 0) {
    console.log(`[鱼缸] 有意重启恢复：${recovered} 条 sending → queued`);
    recoveringDrain = true;
  }
}
await drainLoop();
recoveringDrain = false;

const shown = describeModel(config.modelConfig);
console.log(`[鱼缸] 已连接，模型 ${shown.provider}/${shown.model}，工具 ${fish.toolNames.join("、")}`);
console.log(`[鱼缸] 视觉 ${visionModel.provider}/${visionModel.modelId}，图片 ${modelSelection.image ? `${modelSelection.image.provider}/${modelSelection.image.modelId}` : "未配置"}`);
console.log(`[鱼缸] 凭据 ${shown.key}（${shown.keySource}）`);

// 优雅退出：deploy 发 SIGTERM 后先把 outbox 里已入队的消息发完再关——
// 在途生成轮会被中断（丢当轮），但绝不丢已承诺发送的消息（两阶段 sending 不重发）。
let closing = false;
process.on("SIGTERM", () => {
  if (closing) return;
  closing = true;
  console.log("[鱼缸] SIGTERM，冲刷后退出");
  void (async () => {
    try { const n = await fish.drain(); if (n > 0) console.log(`[鱼缸] 退出前补发 ${n} 条`); } catch { /* 尽力而为 */ }
    onebot.close(); // 先冲刷再断 WS：让协议端立即感知重连，不等它自己的超时
    try { await fish.close(); } catch { /* 尽力而为 */ }
    process.exit(0);
  })();
  setTimeout(() => process.exit(0), 15_000).unref?.();
});
