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
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createFishModels } from "./models.ts";
import { describeModel, loadModelConfig } from "./model-config.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Conversation } from "@earendil-works/pi-durable";
import { openFish, type GroupProfile } from "./harness.ts";
import { OneBot, type IncomingMessage } from "./qq/onebot.ts";
import { DEFAULT_PERSONA_NAME, personaOf, pickVoice } from "./voice-route.ts";
import { createGate, renderForModel } from "./qq/gate.ts";
import { setLookDisabled } from "./tools/look.ts";
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

/** 主人或本会话特别关注的人？ */
function isVoiceVip(msg: IncomingMessage): boolean {
  if (String(msg.userId) === config.master) return true;
  return watchedByChat.get(msg.chatKey)?.has(String(msg.userId)) ?? false;
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
// 进模型前用它在那个人说话的那一行打标记。启动时从文档装载，watch 工具变更后即时同步。
const watchedByChat = new Map<string, Map<string, { name?: string; note: string }>>();
function applyWatched(chatKey: string, people: { userId: string; name?: string; note: string }[]): void {
  const key = baseChatKey(chatKey);
  if (people.length === 0) {
    watchedByChat.delete(key);
    return;
  }
  watchedByChat.set(key, new Map(people.map((p) => [String(p.userId), { ...(p.name ? { name: p.name } : {}), note: p.note }])));
}

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
mkdirSync(HOME, { recursive: true });

const config = {
  onebotUrl: process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001",
  onebotToken: process.env.ONEBOT_TOKEN,
  // 模型与凭据：从 ~/pi-config 抄（provider 条目 + auth.json 的 key），见 src/model-config.ts
  modelConfig: loadModelConfig(),
  gateModel: {
    provider: process.env.GATE_PROVIDER ?? "",
    modelId: process.env.GATE_MODEL_ID ?? "",
  },
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

const models = createFishModels(config.modelConfig);
const mainModel = { provider: config.modelConfig.providerId, modelId: config.modelConfig.modelId };
const gateModel = {
  provider: config.gateModel.provider || mainModel.provider,
  modelId: config.gateModel.modelId || mainModel.modelId,
};

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

// conversationId → 最近一条触发消息 + 所在会话，用来做引用和贴表情
const chatKeys = new Map<string, string>();
const lastMessageId = new Map<string, number | string>();
// 压缩进行中的会话：期间不受理新提交，被@只回机械忙碌语
const compacting = new Set<string>();
const lastMention = new Map<string, boolean>();
// 本轮触发是否是回复某条消息：是则鱼的回应强制引用（回复链可读性）
const lastReply = new Map<string, boolean>(); // 最近一次触发是否@了鱼：被@必回引用，让群里看得出鱼在回谁
// submissionId → 本轮触发消息：把引用目标绑在轮上，不被后续消息顶掉
const triggerOf = new Map<string, { messageId?: number | string; mentionsBot: boolean }>();
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
  toolTimeoutOverrides: { video: 90 },
  // 表情包跨轮冷却：每个人格会话独立计时
  memeCooldownMs: () => Math.round(fishConfig().config.memeCooldownMinutes * 60_000),
  // 语音：按会话所在人格取配置（只认 fish.config 的 voices，没配就是没有语音）
  ttsOf: (conversationId) => voiceConfigFor(mappingKeys.get(String(conversationId)) ?? ""),
  // look / video 的视觉描述模型：缺省用主模型自身；可经 VISION_PROVIDER/VISION_MODEL_ID 换专职视觉模型
  visionModel: process.env.VISION_MODEL_ID
    ? { provider: process.env.VISION_PROVIDER ?? config.modelConfig.providerId, modelId: process.env.VISION_MODEL_ID }
    : undefined,
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
  modelscopeKey: process.env.MODELSCOPE_KEY,
  sdUrl: process.env.SD_WEBUI_URL,
  // （sdUrl 存在时见启动处的邻居保温定时器）
  tagsCsv: join(HOME, "danbooru.csv"),
  master: config.master,
  triggerOf: (roundId) => triggerOf.get(String(roundId)),
  silentOf: (roundId) => silentRounds.has(String(roundId)),
  // watch 的号码校验：从会话映射回群号，再拉全量成员（不要 limit，要能校验到每个人）
  onWatchChanged: (conversationId, userIds) => {
    const chatKey = chatKeys.get(String(conversationId));
    if (!chatKey) return;
    // 只带了 id，备注靠重新读文档太绕：这里增量维护，新 id 先占位，备注由下次启动装载补齐
    const key = baseChatKey(chatKey);
    const map = watchedByChat.get(key) ?? new Map();
    for (const id of userIds) if (!map.has(id)) map.set(id, { note: "" });
    watchedByChat.set(key, map);
  },
  groupMembersOf: async (conversationId) => {
    const chatKey = chatKeys.get(String(conversationId));
    if (!chatKey || !chatKey.startsWith("qq:group:")) return [];
    const groupId = Number(chatKey.slice("qq:group:".length));
    if (!Number.isFinite(groupId)) return [];
    return onebot.groupMembers(groupId, 10_000);
  },
  bypassOf: (roundId) => bypassOf.get(String(roundId)),
  workspaceRoot: config.workspaceRoot,
  compact: {
    model: gateModel,
    maxEntries: fishConfig().config.compact.maxEntries,
    maxChars: fishConfig().config.compact.maxChars,
    limits: () => fishConfig().config.compact,
  },
  // outbox 里的消息由 fish.drain() 逐条交给这里；幂等表再加一层保险
  emit: async (conversationId, payload) => {
    // 恢复轮强发：有意重启时还没真正发出的消息不走幂等去重（去重表可能已在崩溃前提前记了账）
    if (!markSent(payload.key) && !recoveringDrain) return;
    const chatKey = chatKeys.get(conversationId);
    if (!chatKey) return;

    if (chatKey.startsWith("qq:group:")) {
      const groupId = Number(chatKey.slice("qq:group:".length));
      // 引用只认本轮绑定的 quoteId：缺失就裸发，绝不回退 lastMessageId——
      // 那会拿后续消息当引用目标，正文与引用错位、整轮答非所问
      const quote = (payload.quote || payload.quoteForce === true || lastMention.get(conversationId) === true || lastReply.get(conversationId) === true)
        ? payload.quoteId
        : undefined;
      await onebot.sendGroup(groupId, payload.items, { quote });
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

    for (const text of payload.items) {
      chatlog.append({ at: payload.at, chat: chatKey, from: "fish", text, kind: "out" });
    }
  },
  react: async (conversationId, emoji) => {
    const messageId = lastMessageId.get(conversationId);
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
 * 群消息进模型前的上下文拼装。
 *
 * 随机门会丢掉绝大多数闲聊，只把抽中的那条送进 loop——鱼的视野里就只剩一句话，
 * 答起来自然呆。这里把抽中那条**前面 10 条**当背景补进去，并明确标出要回的是最后一条：
 * 否则一次读 6 条，它分不清该接哪句。
 *
 * 只补背景，不改判定：进不进 loop 仍然只由闸门决定，补的这几条不进历史累计。
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
      md5 = createHash("md5").update(readFileSync(full)).digest("hex");
    } catch {
      continue;
    }
    // 库里已有同一张（按 md5）就不再跑模型
    try {
      const index = JSON.parse(readFileSync(join(config.mediaRoot, "memes", "index.json"), "utf8")) as { md5?: string }[];
      if (index.some((e) => e.md5 === md5)) return;
    } catch {
      /* 没有索引就当空库 */
    }

    const conv = await conversationFor(msg.chatKey);
    const prior = bucket.slice(0, -1).slice(-10);
    const header = renderTemplate(fish.prompts.messages["gif_ingest_header"] ?? "", { count: String(prior.length) });
    const context = prior.map((m) => `${m.nickname}: ${m.text}`).join("\n");
    const task = renderTemplate(fish.prompts.messages["gif_ingest_task"] ?? "", {
      ref: gif.ref,
      who: msg.nickname,
    });
    const content = [header, context, task].filter((line) => line.length > 0).join("\n");
    try {
      // 留痕：这一轮是收图轮，起止都打日志，否则「为什么不收」永远查不到
      console.log(`[鱼缸] 收图轮开始 ${gif.ref} md5=${md5.slice(0, 10)}`);
      const submission = await conv.submit({ type: "input", content }, ctx);
      const roundId = String(submission.id);
      silentRounds.add(roundId);
      try {
        const settled = await submission.wait(ctx);
        let added = false;
        try {
          const index = JSON.parse(readFileSync(join(config.mediaRoot, "memes", "index.json"), "utf8")) as { md5?: string }[];
          added = index.some((e) => e.md5 === md5);
        } catch {
          /* 没有索引就当没加 */
        }
        const reason = settled.status === "done" ? (added ? "已入库" : "鱼判断不值得收") : `${settled.status}`;
        console.log(`[鱼缸] 收图轮结束 ${gif.ref} → ${reason}`);
      } finally {
        silentRounds.delete(roundId);
      }
    } catch (error) {
      console.error("[鱼缸] 收图轮失败", error instanceof Error ? error.message : error);
    } finally {
      await drainLoop();
    }
    return; // 一条消息只收一张
  }
}


function withContext(msg: IncomingMessage, bucket: readonly { nickname: string; text: string }[]): string {
  const base = renderForModel(msg, config.master);
  if (!msg.chatKey.startsWith("qq:group:")) return base;
  const prior = bucket.slice(0, -1).slice(-10);
  if (prior.length === 0) return base;
  const header = renderTemplate(fish.prompts.messages["ctx_header"] ?? "", { count: String(prior.length) });
  const marker = fish.prompts.messages["ctx_target"] ?? "";
  const context = prior.map((m) => `${m.nickname}: ${m.text}`).join("\n");
  // 命中特别关注：在要回的那一行前面打标（机械匹配 QQ 号，不靠模型回忆）
  const watched = watchedByChat.get(msg.chatKey)?.get(String(msg.userId));
  const watchNote = watched
    ? renderTemplate(fish.prompts.messages["watch_inline"] ?? "", { who: msg.nickname, note: watched.note })
    : "";
  return [header, context, marker, watchNote, base].filter((line) => line.length > 0).join("\n");
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
    // 强制换页当前会话（无视阈值）：混入的重内容（图块等）立即清掉
    const result = await fish.compact(conv, true);
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

// 每个群的运行态：最近流水、上次开口时间、今天开口次数
const recent = new Map<string, { nickname: string; text: string }[]>();
const lastSpoke = new Map<string, number>();
const spokenToday = new Map<string, { day: string; count: number }>();
const today = () => new Date().toISOString().slice(0, 10);

onebot.onMessage((raw) => {
  void (async () => {
    const msg = raw;

    const bucket = recent.get(msg.chatKey) ?? [];
    bucket.push({ nickname: msg.nickname, text: collapseForward(msg.text) });
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
    const score = decision.enter && decision.score !== undefined ? " score=" + decision.score : "";
    console.log("[fish] gate " + msg.chatKey + " " + msg.nickname.slice(0, 12) + " -> " + verdict + score);
    if (!decision.enter) return;

    const conv = await conversationFor(msg.chatKey);

    // 压缩进行中：不再受理新提交（根治换页竞态把活跃轮吃掉的问题）。
    // 被 @ 的给一句机械回复（同样走 outbox 唯一出口），其余直接等下一轮。
    if (compacting.has(String(conv.id))) {
      if (msg.mentionsBot && msg.messageId !== undefined) {
        await fish.enqueue(conv.id, {
          items: [String(fish.prompts.messages["busy_reply"] ?? "[busy]")],
          quote: true,
          quoteId: msg.messageId,
          quoteForce: true,
          at: Date.now(),
          key: `busy:${msg.messageId}`,
        });
        await drainLoop();
      }
      return;
    }

    await absorbSecrets(conv);
    resetRun(conv.id);
    resetLook(conv.id);
    if (msg.messageId !== undefined) lastMessageId.set(conv.id, msg.messageId);
    lastMention.set(conv.id, msg.mentionsBot);
    // 回复链：本轮触发本身是在回复某条消息，鱼的回应应引用触发那条（对方能看到在回谁）
    lastReply.set(conv.id, (msg.replyIds?.length ?? 0) > 0);

    // 群员插话走 follow-up：不打断正在跑的那一轮。
    // 把触发消息绑到 submission 上：鱼的回复引用本轮自己的触发消息，
    // 轮在跑时新消息进来也不会把引用目标顶掉（否则回复会串到别人的消息上）
    // 每第 3 条（主人/关注对象，且过了闸门）追加一行提示，让鱼知道这条可以用语音
    let content = withContext(msg, bucket);
    // @ 鱼 + 文字里提到合集/转发：把这个群最近一条没展开的合集拉出来（10 分钟内有效）。
    // 场景：先发合集（不 @，被闸丢弃）→ 再 @ 问「上面那个能看吗」。合集记录里明确标了它是什么。
    if (msg.mentionsBot && /合集|转发/.test(msg.text)) {
      const pending = onebot.recentForward(msg.chatKey, 10 * 60_000);
      if (pending) {
        const expanded = await onebot.expandForwardById(pending, msg);
        if (expanded) {
          content = `${fish.prompts.messages["forward_recent_prefix"] ?? ""}\n${expanded}\n${content}`;
          console.log(`[鱼缸] ${msg.chatKey} 补展开最近合集`);
        }
      }
    }
    const voiceOwner = String(conv.id);
    if (voiceConfigFor(mappingKeys.get(voiceOwner) ?? msg.chatKey) && isVoiceVip(msg)) {
      const perUser = voiceCredits.get(msg.chatKey) ?? new Map<string, number>();
      const count = (perUser.get(String(msg.userId)) ?? 0) + 1;
      perUser.set(String(msg.userId), count);
      voiceCredits.set(msg.chatKey, perUser);
      if (count % 3 === 0) {
        const hint = fish.prompts.messages["voice_hint"] ?? "";
        if (hint) content = content + "\n" + hint;
      }
    }

    const submission = await conv.submit({ type: "input", content }, ctx);
    triggerOf.set(String(submission.id), {
      messageId: msg.messageId,
      mentionsBot: msg.mentionsBot,
      userId: msg.userId,
    });
    if (bypass) bypassOf.set(String(submission.id), bypass.stash);

    const settled = await submission.wait(ctx);
    triggerOf.delete(String(submission.id));
    bypassOf.delete(String(submission.id));
    if (settled.status !== "done") {
      const why = [settled.status, (settled as { reason?: string }).reason, (settled as { detail?: string }).detail]
        .filter(Boolean)
        .join(" · ");
      console.error(`[鱼缸] ${msg.chatKey} 这一轮没答上来：${why}`);
      return;
    }

    await drainLoop();

    // 记账：pi-durable 的 pi.usage 是累计值，这里取差落盘
    const spent = await fish.harness.snapshot(UsageDoc, conv.id, ctx);
    const delta = usage.append(msg.chatKey, sumUsage(spent), Date.now());
    if (delta) {
      console.log(`[鱼缸] ${msg.chatKey} +${delta.total} tokens / ${delta.cost}`);
    }

    const compacted = await (async () => {
      compacting.add(String(conv.id));
      try {
        return await fish.compact(conv);
      } finally {
        compacting.delete(String(conv.id));
      }
    })();
    if (compacted.compacted) {
      console.log(`[鱼缸] ${msg.chatKey} 换页 ${compacted.entries}条/${compacted.chars}字`);
    }
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
