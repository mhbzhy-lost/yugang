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
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createFishModels } from "./models.ts";
import { describeModel, loadModelConfig } from "./model-config.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Conversation } from "@earendil-works/pi-durable";
import { openFish, type GroupProfile } from "./harness.ts";
import { OneBot } from "./qq/onebot.ts";
import { createGate, renderForModel } from "./qq/gate.ts";
import { absorbSecrets } from "./egress/absorb.ts";
import { resetRun, resetLook } from "./egress/ledger.ts";
import { createChatlog } from "./chatlog.ts";
import { createUsageLedger, sumUsage } from "./usage.ts";
import { UsageDoc } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;
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
  quietHours: process.env.QUIET_HOURS?.split("-").map(Number) as [number, number] | undefined,
  dailyQuota: Number(process.env.DAILY_QUOTA ?? "40"),
  cooldownMs: Number(process.env.COOLDOWN_MS ?? "90000"),
  ambientChance: Number(process.env.AMBIENT_CHANCE ?? "0.1"),
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
const lastMention = new Map<string, boolean>(); // 最近一次触发是否@了鱼：被@必回引用，让群里看得出鱼在回谁
// submissionId → 本轮触发消息：把引用目标绑在轮上，不被后续消息顶掉
const triggerOf = new Map<string, { messageId?: number | string; mentionsBot: boolean }>();
const conversations = new Map<string, Conversation>();

const fish = await openFish({
  storage: await openNodeSqliteStorage(join(HOME, "fish.db")),
  models,
  model: mainModel,
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
  triggerOf: (roundId) => triggerOf.get(String(roundId)),
  workspaceRoot: config.workspaceRoot,
  compact: {
    model: gateModel,
    maxEntries: Number(process.env.COMPACT_MAX_ENTRIES ?? "80"),
    maxChars: Number(process.env.COMPACT_MAX_CHARS ?? "12000"),
  },
  // outbox 里的消息由 fish.drain() 逐条交给这里；幂等表再加一层保险
  emit: async (conversationId, payload) => {
    if (!markSent(payload.key)) return;
    const chatKey = chatKeys.get(conversationId);
    if (!chatKey) return;

    if (chatKey.startsWith("qq:group:")) {
      const groupId = Number(chatKey.slice("qq:group:".length));
      const quote = (payload.quote || payload.quoteForce === true || lastMention.get(conversationId) === true)
        ? (payload.quoteId ?? lastMessageId.get(conversationId))
        : undefined;
      await onebot.sendGroup(groupId, payload.items, { quote });
      if (payload.media) await onebot.sendImageGroup(groupId, resolve(config.mediaRoot, payload.media));
    } else if (chatKey.startsWith("qq:private:")) {
      await onebot.sendPrivate(Number(chatKey.slice("qq:private:".length)), payload.items);
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

async function conversationFor(chatKey: string): Promise<Conversation> {
  let conv = conversations.get(chatKey);
  if (!conv) {
    const groupId = chatKey.startsWith("qq:group:") ? Number(chatKey.slice("qq:group:".length)) : undefined;
    const profile = groupId ? await profileFor(groupId) : undefined;
    conv = await fish.group(chatKey, profile);
    conversations.set(chatKey, conv);
    chatKeys.set(conv.id, chatKey);
  }
  return conv;
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
  prompts: fish.prompts,
  models,
  model: gateModel,
  master: config.master,
  groups: config.groups,
  quietHours: config.quietHours,
  dailyQuota: config.dailyQuota,
  cooldownMs: config.cooldownMs,
  ambientChance: config.ambientChance,
});

// 每个群的运行态：最近流水、上次开口时间、今天开口次数
const recent = new Map<string, { nickname: string; text: string }[]>();
const lastSpoke = new Map<string, number>();
const spokenToday = new Map<string, { day: string; count: number }>();
const today = () => new Date().toISOString().slice(0, 10);

onebot.onMessage((raw) => {
  void (async () => {
    const msg = raw;

    const bucket = recent.get(msg.chatKey) ?? [];
    bucket.push({ nickname: msg.nickname, text: msg.text });
    if (bucket.length > 30) bucket.splice(0, bucket.length - 30);
    recent.set(msg.chatKey, bucket);

    chatlog.append({ at: Date.now(), chat: msg.chatKey, from: msg.nickname, text: msg.text, kind: "in" });

    const stat = spokenToday.get(msg.chatKey);
    const count = stat && stat.day === today() ? stat.count : 0;

    const decision = await gate.decide({
      msg,
      recent: bucket.slice(0, -1),
      lastSpokeAt: lastSpoke.get(msg.chatKey) ?? 0,
      spokenToday: count,
    });
    if (!decision.enter) return;

    const conv = await conversationFor(msg.chatKey);

    // 压缩进行中：不再受理新提交（根治换页竞态把活跃轮吃掉的问题）。
    // 被 @ 的给一句机械回复（同样走 outbox 唯一出口），其余直接等下一轮。
    if (compacting.has(String(conv.id))) {
      if (msg.mentionsBot && msg.messageId !== undefined) {
        await fish.enqueue(conv.id, {
          items: [fish.prompts.messages["busy_reply"] ?? "缸里正在归档记忆，稍等一下再叫我"],
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

    // 群员插话走 follow-up：不打断正在跑的那一轮。
    // 把触发消息绑到 submission 上：鱼的回复引用本轮自己的触发消息，
    // 轮在跑时新消息进来也不会把引用目标顶掉（否则回复会串到别人的消息上）
    const submission = await conv.submit(
      { type: "input", content: renderForModel(msg, config.master) },
      ctx,
    );
    triggerOf.set(String(submission.id), {
      messageId: msg.messageId,
      mentionsBot: msg.mentionsBot,
    });

    const settled = await submission.wait(ctx);
    triggerOf.delete(submission.id);
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
const known = await fish.harness.snapshot((await import("./store.ts")).ChatsDoc, ctx);
for (const [chatKey, conversationId] of Object.entries(known?.chats ?? {})) {
  chatKeys.set(String(conversationId), chatKey);
}
await drainLoop();
const shown = describeModel(config.modelConfig);
console.log(`[鱼缸] 已连接，模型 ${shown.provider}/${shown.model}，工具 ${fish.toolNames.join("、")}`);
console.log(`[鱼缸] 凭据 ${shown.key}（${shown.keySource}）`);
