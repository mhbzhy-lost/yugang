/**
 * 鱼缸的入口：OneBot ⇄ pi-durable。
 *
 * 数据流：
 *   群消息 → 规则闸 → conversation.submit() → pi-durable 跑 agent
 *                                                 ↓ 唯一出口：say() 工具
 *                                              校验 → fish.outbound → QQ
 *
 * 模型的正文、思考、tool 调用文本都不在这条链上。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openFish } from "./harness.ts";
import { OneBot } from "./qq/onebot.ts";
import { createGate, renderForModel } from "./qq/gate.ts";
import { absorbSecrets } from "./egress/absorb.ts";
import type { Conversation } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;
const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
mkdirSync(HOME, { recursive: true });

const config = {
  onebotUrl: process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001",
  onebotToken: process.env.ONEBOT_TOKEN,
  provider: process.env.MODEL_PROVIDER ?? "deepseek",
  modelId: process.env.MODEL_ID ?? "deepseek-v4-flash",
  mediaRoot: resolve(process.env.MEDIA_ROOT ?? join(HOME, "media")),
  promptRoot: resolve(process.env.PROMPT_ROOT ?? join(process.cwd(), "prompt")),
  workspaceRoot: resolve(process.env.WORKSPACE_ROOT ?? join(HOME, "workspace")),
  ambientChance: Number(process.env.AMBIENT_CHANCE ?? "0.06"),
  cooldownMs: Number(process.env.COOLDOWN_MS ?? "90000"),
  keywords: (process.env.KEYWORDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  groups: (process.env.GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};
mkdirSync(config.mediaRoot, { recursive: true });

const models = createModels(); // provider 由 pi-ai 的凭据/配置决定，见 README

const onebot = new OneBot(config.onebotUrl, config.onebotToken);

// 幂等表：崩溃重放时不重复发同一句
const sentPath = join(HOME, "sent.json");
const sent = new Set<string>(existsSync(sentPath) ? (JSON.parse(readFileSync(sentPath, "utf8")) as string[]) : []);
function markSent(key: string): boolean {
  if (sent.has(key)) return false;
  sent.add(key);
  writeFileSync(sentPath, JSON.stringify([...sent].slice(-5000)));
  return true;
}

const fish = await openFish({
  storage: await openNodeSqliteStorage(join(HOME, "fish.db")),
  models,
  model: { provider: config.provider, modelId: config.modelId },
  promptRoot: config.promptRoot,
  workspaceRoot: config.workspaceRoot,
  mediaRoot: config.mediaRoot,
  compact: {
    model: process.env.COMPACT_PROVIDER
      ? { provider: process.env.COMPACT_PROVIDER, modelId: process.env.COMPACT_MODEL_ID ?? config.modelId }
      : undefined,
    maxEntries: Number(process.env.COMPACT_MAX_ENTRIES ?? "80"),
    maxChars: Number(process.env.COMPACT_MAX_CHARS ?? "12000"),
  },
  emit: async (conversationId, payload) => {
    if (!markSent(payload.key)) return;
    const chatKey = chatKeyOf(conversationId);
    if (chatKey?.startsWith("qq:group:")) {
      await onebot.sendGroup(Number(chatKey.slice("qq:group:".length)), payload.text, payload.media);
    } else if (chatKey?.startsWith("qq:private:")) {
      await onebot.sendPrivate(Number(chatKey.slice("qq:private:".length)), payload.text);
    }
  },
});

const chatKeys = new Map<string, string>(); // conversationId → chatKey
const conversations = new Map<string, Conversation>();

async function conversationFor(chatKey: string): Promise<Conversation> {
  let conv = conversations.get(chatKey);
  if (!conv) {
    conv = await fish.group(chatKey);
    conversations.set(chatKey, conv);
    chatKeys.set(conv.id, chatKey);
  }
  return conv;
}
function chatKeyOf(conversationId: string): string | undefined {
  return chatKeys.get(conversationId);
}

const gate = createGate({
  ambientChance: config.ambientChance,
  cooldownMs: config.cooldownMs,
  keywords: config.keywords,
  groups: config.groups,
});

onebot.onMessage((msg) => {
  void (async () => {
    if (!gate.shouldEnter(msg)) return;
    const conv = await conversationFor(msg.chatKey);
    // 上一轮的思考/工具结果先入库，供这一轮的溯源校验比对
    await absorbSecrets(conv);
    const submission = await conv.submit({ type: "input", content: renderForModel(msg, onebot.selfId) }, ctx);
    const settled = await submission.wait(ctx);
    if (settled.status !== "done") {
      console.error(`[鱼缸] ${msg.chatKey} 这一轮没答上来：${settled.status}`);
      return;
    }
    // 只有这一轮正常结束时才考虑换页：压缩读数要在一个稳定的边界上
    const compacted = await fish.compact(conv);
    if (compacted.compacted) {
      console.log(`[鱼缸] ${msg.chatKey} 换页 ${compacted.entries}条/${compacted.chars}字`);
    }
  })().catch((error: unknown) => {
    console.error("[鱼缸] 处理消息失败", error instanceof Error ? error.message : error);
  });
});

await onebot.connect();
console.log(`[鱼缸] 已连接 OneBot，模型 ${config.provider}/${config.modelId}，工具 ${fish.toolNames.join("、")}`);
