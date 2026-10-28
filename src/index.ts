/**
 * 鱼缸的入口：OneBot ⇄ pi-durable。
 *
 *   群消息 → 规则闸/打分闸 → conversation.submit() → agent loop
 *                                                      ├── thinking/正文/tool  ✗ 不出境
 *                                                      └── say / react / draw / look
 *                                                            → 硬校验 → QQ
 *
 * 模型的正文、思考、tool 调用文本都不在这条链上。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Conversation } from "@earendil-works/pi-durable";
import { openFish, type GroupProfile } from "./harness.ts";
import { OneBot } from "./qq/onebot.ts";
import { createGate, renderForModel } from "./qq/gate.ts";
import { absorbSecrets } from "./egress/absorb.ts";
import { resetRun, resetLook } from "./egress/ledger.ts";
import { createChatlog } from "./chatlog.ts";

const ctx = BACKGROUND_CONTEXT;
const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
mkdirSync(HOME, { recursive: true });

const config = {
  onebotUrl: process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001",
  onebotToken: process.env.ONEBOT_TOKEN,
  provider: process.env.MODEL_PROVIDER ?? "deepseek",
  modelId: process.env.MODEL_ID ?? "deepseek-v4-flash",
  gateModel: {
    provider: process.env.GATE_PROVIDER ?? process.env.MODEL_PROVIDER ?? "deepseek",
    modelId: process.env.GATE_MODEL_ID ?? process.env.MODEL_ID ?? "deepseek-v4-flash",
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

const models = createModels();
const onebot = new OneBot(config.onebotUrl, config.onebotToken, config.mediaRoot);
const chatlog = createChatlog(join(HOME, "chatlog"));

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
const conversations = new Map<string, Conversation>();

const fish = await openFish({
  storage: await openNodeSqliteStorage(join(HOME, "fish.db")),
  models,
  model: { provider: config.provider, modelId: config.modelId },
  promptRoot: config.promptRoot,
  mediaRoot: config.mediaRoot,
  workspaceRoot: config.workspaceRoot,
  compact: {
    model: config.gateModel,
    maxEntries: Number(process.env.COMPACT_MAX_ENTRIES ?? "80"),
    maxChars: Number(process.env.COMPACT_MAX_CHARS ?? "12000"),
  },
  emit: async (conversationId, payload) => {
    if (!markSent(payload.key)) return;
    const chatKey = chatKeys.get(conversationId);
    if (!chatKey) return;

    if (chatKey.startsWith("qq:group:")) {
      const groupId = Number(chatKey.slice("qq:group:".length));
      const quote = payload.quote ? lastMessageId.get(conversationId) : undefined;
      await onebot.sendGroup(groupId, payload.items, { quote });
      if (payload.media) await onebot.sendImageGroup(groupId, payload.media);
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

const gate = createGate({
  prompts: fish.prompts,
  models,
  model: config.gateModel,
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
    await absorbSecrets(conv);
    resetRun(conv.id);
    resetLook(conv.id);
    if (msg.messageId !== undefined) lastMessageId.set(conv.id, msg.messageId);

    // 群员插话走 follow-up：不打断正在跑的那一轮
    const submission = await conv.submit(
      { type: "input", content: renderForModel(msg, config.master) },
      ctx,
    );

    const settled = await submission.wait(ctx);
    if (settled.status !== "done") {
      console.error(`[鱼缸] ${msg.chatKey} 这一轮没答上来：${settled.status}`);
      return;
    }

    const compacted = await fish.compact(conv);
    if (compacted.compacted) {
      console.log(`[鱼缸] ${msg.chatKey} 换页 ${compacted.entries}条/${compacted.chars}字`);
    }
  })().catch((error: unknown) => {
    console.error("[鱼缸] 处理消息失败", error instanceof Error ? error.message : error);
  });
});

await onebot.connect();
console.log(
  `[鱼缸] 已连接，模型 ${config.provider}/${config.modelId}，工具 ${fish.toolNames.join("、")}`,
);
