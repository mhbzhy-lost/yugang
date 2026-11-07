/**
 * 权威模板机械测试（docs/decisions/2026-11-04-model-input-templates.md §10 / 主计划 Task 7）。
 *
 * 权威输入只有一处：decisions 里的 `input-scene-matrix` 与 `input-template:*` 围栏块，
 * 由 `test/support/authoritative-templates.ts` 只读解析——本文件不抄任何期望模板。
 *
 * actual 一律从**生产导出的真实拼装入口**取得，不在测试里重写任何渲染/拼装逻辑：
 *  - answer / 私聊 / 三类合集 / 背景合集：`planRoundImages`(src/qq/round-images.ts) →
 *    `withContext`(src/qq/debounce.ts) → `rewriteRoundForwardImages` → `assembleRoundContent`
 *    → `appendVoiceHint` → `submitContentOf`（src/qq/round-input.ts），
 *    即 src/index.ts flushBurst(L1154-1185) + submitRound(L944-956) 的同一串调用；
 *  - open injection / shard / 零新增：真 `createEngageNext` 状态机（假时钟推进）触发
 *    onPhase(open, backlog) / onShard(items)，回调里调 `renderOpenMessageList` /
 *    `renderBrowseOpportunity`（与 index.ts L1277/L1298/L1335 同一入口）；
 *  - GIF：随 ambient 标准消息列表；新闻：`buildNewsCandidateInput` + `news-digest.md`
 *   （人格备料输入）；换页：`buildProfileHandoff`（src/compact.ts）。
 * 测试只提供固定内存输入（消息/合集/卡片/entry）与文案表，不做任何文本拼装。
 *
 * 比较口径（decisions §10）：多段模板按矩阵顺序以一个空行连接后 `assert.equal` 精确比较
 * 完整文本（换行、空行、全角/半角标点、顺序全部参与），不做 trim、空白归一化或包含式断言；
 * 图片场景另比 content blocks 的类型/顺序/base64/MIME（一个 text block 在前，压缩 image
 * blocks 按编号在后）。压缩用 `planRoundImages` 的 `shrink` 注入点给确定性结果
 * `compressed-1`（base64 Y29tcHJlc3NlZC0x / image/jpeg），绝不把原图字节交给模型。
 *
 * 已观测到的真实差异（保持失败、不迁就实现、不改权威模板，交回对应生产 repair）：
 *  1. answer_burst_voice：prompt/messages.md 的 `voice_hint` 仍是
 *     「（这一条必须用语音回：用 say_voice 发，别用文字。这是规则，不是建议）」，
 *     decisions §5.2 要求「[本轮要求] 必须使用 say_voice 回复，不要使用文字。」；
 *  2. news：2026-11-07 起改为人格备料候选输入，模型经 news_prepare 提交结构化选材，
 *     不再把宿主成品交给模型用 say_words 重发；
 *  3. history_forward：换页尾巴是被压缩页输入的**逐字投影**，合集父消息行带
 *     `[转发合集][这条消息@了你]` 机械标签（renderMessageLine；自带合集只有在 @ 时才会被
 *     展开，所以这一行必然同时带 @ 标签），decisions §7.2 的 history-forward-tail 该行
 *     没有任何标签。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadPrompts, renderTemplate } from "../src/prompt/index.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { DISABLED_TOOL_PACKAGES, mergeToolMessages } from "../src/tools/loader.ts";
import { withContext, type BurstMessage, type RecentChatMessage } from "../src/qq/debounce.ts";
import { planRoundImages, rewriteRoundForwardImages } from "../src/qq/round-images.ts";
import {
  appendAnswerRules,
  appendVoiceHint,
  assembleRoundContent,
  backgroundTextOf,
  renderBrowseOpportunity,
  renderOpenMessageList,
  submitContentOf,
  type RoundContentBlock,
} from "../src/qq/round-input.ts";
import { buildNewsCandidateInput } from "../src/external/news-broadcast.ts";
import { createEngageNext, type EngageShardItem } from "../src/qq/engage-next.ts";
import type { ShrinkResult } from "../src/media/shrink-image.ts";
import { openFish } from "../src/harness.ts";
import type { IncomingMessage } from "../src/qq/onebot.ts";
import type { ForwardAttachment, ModelMessage, QuotedMessage } from "../src/qq/model-input.ts";
import {
  AUTHORITATIVE_SCENE_COUNT,
  authoritativeDecisionsPath,
  authoritativeSceneText,
  loadAuthoritativeBlockJson,
  loadAuthoritativeScenes,
  loadAuthoritativeTemplate,
  type AuthoritativeScene,
} from "./support/authoritative-templates.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPTS = join(ROOT, "prompt");
const TOOL_ROOT = join(ROOT, "src", "tools");

/** 文案表 = 生产的合并视图（prompt/messages.md + active 工具包 messages，同 loader.ts L119-125）。 */
function productionMessages(): Record<string, string> {
  const prompts = loadPrompts(PROMPTS);
  const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
  const active = new Map([...manifests].filter(([name]) => !DISABLED_TOOL_PACKAGES.has(name)));
  mergeToolMessages(active, prompts.messages);
  return prompts.messages;
}

const messages = productionMessages();

/** 媒体根目录：inline 场景要求图片文件真实存在（planRoundImages 的 existsSync 闸）。 */
const mediaRoot = mkdtempSync(join(tmpdir(), "yg-tpl-media-"));
const JPG_REF = "inbound/1793782479412-17b764.jpg";
const GIF_REF = "inbound/1793781566470-911a90.gif";
mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
// 文件内容无关紧要：压缩走下面的确定性 stub，原图字节永不进入模型输入
writeFileSync(join(mediaRoot, JPG_REF), "fixture-bytes-never-sent-to-model");

/** 确定性压缩 stub（decisions §10 允许）：产出 `compressed-1` 的 base64 与 image/jpeg。 */
const shrinkStub = (_input: { file: string }): ShrinkResult => ({
  ok: true,
  buffer: Buffer.from("compressed-1"),
  mimeType: "image/jpeg",
});

const MASTER = "2928390812";
const GROUP = "qq:group:659976571";

/** 固定内存入站消息（真实形状见 src/qq/onebot.ts 的 IncomingMessage）。 */
function incoming(partial: Omit<Partial<IncomingMessage>, "chatKey" | "userId" | "nickname" | "text"> & {
  chatKey: string;
  userId: number;
  nickname: string;
  text: string;
  messageId: number;
}): IncomingMessage {
  return {
    mentionsBot: false,
    mentions: [],
    images: [],
    imageSegments: [],
    replyIds: [],
    ...(partial.chatKey.startsWith("qq:group:") ? { groupId: Number(partial.chatKey.slice("qq:group:".length)) } : {}),
    ...partial,
  } as IncomingMessage;
}

/** recent 流水里的一条（背景板）。 */
function recent(seq: number, messageId: number, userId: number, nickname: string, text: string): RecentChatMessage {
  return { arrivalSeq: seq, messageId, userId, nickname, text, at: seq };
}

/** burst（整组）里的一条。 */
function burstLine(
  seq: number,
  messageId: number,
  userId: number,
  nickname: string,
  text: string,
  extra: Partial<BurstMessage> = {},
): BurstMessage {
  return {
    arrivalSeq: seq,
    messageId,
    userId,
    nickname,
    text,
    at: seq,
    mentionsBot: false,
    replyIds: [],
    ...extra,
  };
}

interface AnswerRoundOptions {
  anchor: IncomingMessage;
  burst: readonly BurstMessage[];
  bucket?: readonly RecentChatMessage[];
  /** 主会话直读压缩图（inline）与否：false = fallback 视觉模型路径。 */
  inline: boolean;
  master?: string;
  watched?: (userId: number | string) => boolean;
  /** @ 且提到「合集/转发」时补展开的最近合集（index.ts L1170-1179 的展开结果）。 */
  recentForward?: ForwardAttachment;
  /** submitRound 的 0.3 语音门命中（index.ts L944-951）。 */
  voiceHint?: boolean;
  /** @ 轮确定性追加的 `video_answer_rule`（index.ts 的 answer 轮规范段）。 */
  answerRule?: boolean;
}

/**
 * answer 轮的真实拼装链（index.ts flushBurst L1154-1185 → submitRound L944-956）：
 * 每一步都是生产导出函数，测试不参与任何文本组装。
 */
function answerRound(options: AnswerRoundOptions): { text: string; submit: string | RoundContentBlock[]; blocks: readonly RoundContentBlock[] } {
  const plan = planRoundImages(options.anchor, options.burst, mediaRoot, options.inline, messages, shrinkStub);
  const round = withContext(options.anchor, options.bucket ?? [], plan.messages, {
    master: options.master ?? "",
    messages,
    backgroundLimit: 5, // engage.answerContextSize=5（模板按此定格；生产缺省=全量未读）
    seenSeq: 0, // 新会话：背景板全未读
    ...(options.watched ? { watched: options.watched } : {}),
  });
  const recentForward = options.recentForward
    ? rewriteRoundForwardImages(options.recentForward, plan.numbers, messages)
    : undefined;
  const assembled = assembleRoundContent(round.content, {
    ...(recentForward ? { recentForward } : {}),
    tags: plan.tags,
    lookHint: plan.lookHint,
  }, messages);
  // 规范段与语音段都由共享装配器拼：顺序与宿主一致（先 video_answer_rule，再语音提示）
  let text = assembled;
  if (options.answerRule === true) text = appendAnswerRules(text, [messages["video_answer_rule"] ?? ""]);
  if (options.voiceHint === true) text = appendVoiceHint(text, messages["voice_hint"] ?? "");
  return { text, submit: submitContentOf(text, plan.blocks), blocks: plan.blocks };
}

/** 可手动推进的假时钟（engage-next 的 tick 与 shard 节拍都用它，风格同 debounce.test.ts）。 */
function fakeClock(base: number) {
  let current = base;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  return {
    now: () => current,
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: current + ms, fn });
      return seq as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer as unknown as number);
    },
    advance(ms: number) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        current = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      current = target;
    },
  };
}

const OPEN_ITEM = { messageId: 2123920686, userId: 1066598141, nickname: "阿蓝", text: "并列第一这招最省事，谁也不好意思争" };
const masterOf = (userId: number): boolean => String(userId) === MASTER;
const notWatched = (): boolean => false;
/** 换页尾巴的历史行不涉及主人/特别关注标签（剖面卡片与尾巴都是机械投影）。 */
const notMaster = (): boolean => false;

/** 自由拍 shard（2026-11-06 合并）：真状态机 collectShard → 拍到期 onShard（submitShardRound 的渲染入口）。 */
function triggerFreeShard(): Triggered & { collected: boolean } {
  const clock = fakeClock(1_000);
  let text = "";
  const engage = createEngageNext({
    groups: () => [GROUP],
    busy: () => false,
    onShard: (chatKey, items) => {
      text = renderOpenMessageList(items, messages, masterOf, notWatched);
    },
    config: () => ({ freeSeconds: 60, freeBrowseChance: 0, freeBatchMax: 50 }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    tickMs: 1_000,
    random: () => 0.9,
  });
  engage.start();
  const item: EngageShardItem = { arrivalSeq: 7, at: 7, ...OPEN_ITEM };
  const collected = engage.collectShard(GROUP, item);
  clock.advance(61_000); // 首 tick 建相位，第二拍满 freeSeconds 提交
  const submit = submitContentOf(text, []);
  engage.stop();
  return { text, submit, via: "engage-next collectShard → onShard(items) → renderOpenMessageList → submitContentOf", collected };
}

/** 自由拍空拍自主轮（2026-11-06 合并）：空拍掷 freeBrowseChance 门，门开 onFreeIdle。 */
function triggerFreeBrowse(): Triggered & { gateOpen: boolean } {
  // 白天（2026-11-04 10:00）：宵禁（本地 00:00–08:00）内空拍不掷门
  const clock = fakeClock(stamp(10, 0));
  let text = "";
  let gateOpen = false;
  const engage = createEngageNext({
    groups: () => [GROUP],
    busy: () => false,
    onShard: () => {},
    onFreeIdle: (_chatKey, gate) => {
      gateOpen = gate.open;
      text = renderBrowseOpportunity(messages);
    },
    config: () => ({ freeSeconds: 60, freeBrowseChance: 1, freeBatchMax: 50 }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    tickMs: 1_000,
    random: () => 0, // 严格小于：0 < 1 → 门开；topic 取 VIDEO_TOPICS[0]
  });
  engage.start();
  clock.advance(61_000); // 空拍：收集器无消息 → 掷门 → onFreeIdle
  const submit = submitContentOf(text, []);
  engage.stop();
  return { text, submit, via: "engage-next 空拍 freeBrowseChance 门开 → onFreeIdle → renderBrowseOpportunity → submitContentOf", gateOpen };
}

/** 合集子消息（只有 API 真实给了 ID/QQ 才有对应字段）。 */
function child(position: number, nickname: string, text: string, extra: Partial<ForwardAttachment["children"][number]> = {}): ForwardAttachment["children"][number] {
  return { position, nickname, text, images: [], ...extra };
}

const FORWARD_CHILDREN = [
  child(1, "群友甲", "第一条", { userId: "10001" }),
  child(2, "群友乙", "第二条"),
];

/** 本地时区的固定时间戳：卡片时间头 formatStamp 的输入。 */
const stamp = (hour: number, minute: number): number => new Date(2026, 10, 4, hour, minute, 0).getTime();

const ctx = BACKGROUND_CONTEXT;

/** 从 pi.reset 的 user message 取 compact 实际写入的 handoff 文本。 */
function resetText(model: unknown): string {
  if (!Array.isArray(model)) return "";
  return model.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      const text = (block as { type?: unknown; text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
  }).join("");
}

interface HistoryHarnessOptions {
  submit: (root: Awaited<ReturnType<Awaited<ReturnType<typeof openFish>>["harness"]["root"]>>, setNow: (at: number) => void, faux: ReturnType<typeof fauxProvider>) => Promise<void>;
}

/** 真 harness 的换页入口：真实 submit 产出 fish.inbound/fish.outbound，再由真 compact 读 pi.reset。 */
async function compactHistoryScene(submit: HistoryHarnessOptions["submit"]): Promise<Triggered> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let current = stamp(10, 0);
  const fish = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-history-media-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-history-work-")),
    compact: { maxTokens: 1 },
    selfOf: () => ({ nickname: "Elysia", userId: "3768557204" }),
    now: () => current,
    emit: () => {},
    react: () => {},
  });
  try {
    const root = await fish.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });
    const setNow = (at: number): void => {
      current = at;
    };
    await submit(root, setNow, faux);
    faux.setResponses([fauxAssistantMessage('{"threads":[{"quote":"并列第一这招最省事","anchor":"2123920686","status":"open"}],"promises":[{"quote":"我待会儿去看看","status":"open"}],"mood":"轻松闲聊"}')]);
    const compacted = await fish.compact(root);
    assert.equal(compacted.compacted, true, "真实 compact 未触发");
    const view = await root.viewState(ctx);
    try {
      const reset = view.value.entries.find((entry) => entry.kind === "pi.reset");
      assert.ok(reset, "真实 compact 没有写入 pi.reset");
      return {
        text: resetText(reset.model),
        via: "openFish + root.submit(fish.inbound) + say_words/fish.outbound + fish.compact → pi.reset",
      };
    } finally {
      view.dispose();
    }
  } finally {
    await fish.close();
  }
}

/** 一个 scene 的真实入口触发结果。 */
interface Triggered {
  /** 实际提交给模型的文本（content 的 text block / 纯字符串 content）。 */
  text: string;
  /** conv.submit 的 content 原样形状：有压缩图时是 blocks 数组，否则是字符串。 */
  submit?: string | RoundContentBlock[];
  /** 真实入口说明（injection 与 shard 必须是两条不同路径）。 */
  via: string;
}

/** scene → 真实入口触发器（数量与矩阵一致，全部走生产导出实现）。 */
const TRIGGERS: Record<string, () => Triggered | Promise<Triggered>> = {
  // @ 轮：背景 1 条 + 锚点回复引用（decisions §4 标准群消息模板）
  answer_reply: () => {
    const quoted: QuotedMessage = {
      id: "1262165350",
      nickname: "Elysia",
      userId: "3768557204",
      text: "聘礼嘛，就是你要把姐姐领回家总得备点诚意呀，油豆腐就是你的报价啦，刚才那句「算了多来点」我可听见了，一盒起步不许赖账哦♪",
      images: [],
    };
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 1110691775,
      userId: 2627618651,
      nickname: "[有人@我]",
      text: "惹，我还以为爱莉姐姐要和我回家还要给我油豆腐呢",
      mentionsBot: true,
      replyIds: ["1262165350"],
      quoted,
      arrivalSeq: 2,
    });
    const bucket = [
      recent(1, 556542960, 2943084870, "最聪明的鱼", "那这榜挂着就是纯装饰，写全体并列第一，谁都不好意思说自己排第二"),
      recent(2, 1110691775, 2627618651, "[有人@我]", anchor.text),
    ];
    const round = answerRound({
      anchor,
      bucket,
      burst: [burstLine(2, 1110691775, 2627618651, "[有人@我]", anchor.text, { mentionsBot: true, replyIds: ["1262165350"], quoted })],
      inline: false,
      answerRule: true,
    });
    return { ...round, via: "planRoundImages → withContext → assembleRoundContent → submitContentOf" };
  },

  // 同一发送者合并组 + 特别关注 + 强制语音（decisions §5.2）
  answer_burst_voice: () => {
    const quoted: QuotedMessage = {
      id: "1416060502",
      nickname: "Elysia",
      userId: "3768557204",
      text: "哎呀，认错人啦，对不起呀小狐狸～那刚才那句领养宣言就当我在自我推销好了，不吃鱼食的小狐狸也一样欢迎哦♪",
      images: [],
    };
    const WATCHED = 2603803040;
    const burst = [
      burstLine(5, 1799917601, WATCHED, "ql今天玩什么", "推销到我心里了", { mentionsBot: true, replyIds: ["1416060502"], quoted }),
      burstLine(6, 690734310, WATCHED, "ql今天玩什么", `[图片 ${GIF_REF}]`),
    ];
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 690734310,
      userId: WATCHED,
      nickname: "ql今天玩什么",
      text: `[图片 ${GIF_REF}]`,
      images: [{ ref: GIF_REF }],
      arrivalSeq: 6,
    });
    const bucket = [
      recent(1, 2128404035, 2627618651, "[有人@我]", "[图片 inbound/1793781544076-6ff802.jpg]"),
      recent(2, 82804152, 1066598141, "阿蓝", "一只眼瞪成白圈，整张脸都停住了"),
      recent(3, 1838148262, 302789075, "鲸鲸", "这表情，像刚被人认错门牌"),
      recent(4, 748201561, 1066598141, "阿蓝", "被人叫错名字就这反应，改口都来不及"),
      recent(5, 1799917601, WATCHED, "ql今天玩什么", "推销到我心里了"),
      recent(6, 690734310, WATCHED, "ql今天玩什么", `[图片 ${GIF_REF}]`),
    ];
    const round = answerRound({
      anchor,
      bucket,
      burst,
      inline: true, // GIF 不 inline、不占编号；背景里的 jpg 不属本轮整组，不触发 look 提示
      watched: (userId) => String(userId) === String(WATCHED),
      answerRule: true, // @ 轮确定性追加的看视频规范
      voiceHint: true, // submitRound 的 0.3 语音门命中（主人/特别关注对象的 answer 轮）
    });
    return { ...round, via: "planRoundImages → withContext → assembleRoundContent → appendVoiceHint" };
  },

  // 主人私聊（decisions §5.3，index.ts L2624：私聊直接取 withContext().content）
  private_master: () => {
    const anchor = incoming({
      chatKey: `qq:private:${MASTER}`,
      messageId: 1425302217,
      userId: Number(MASTER),
      nickname: "MHB",
      text: "给你收5个视频的权限，去吧，只要是你喜欢的就行",
      mentionsBot: true, // 入站对私聊恒置 true；渲染层不打 @ 标签
    });
    const content = withContext(anchor, [], [], { master: MASTER, messages }).content;
    return { text: content, submit: submitContentOf(content, []), via: "withContext(private) → submitContentOf" };
  },

  // 主会话直读压缩图（decisions §5.4）：[图片#1] 编号 + 列表后压缩图标签 + image block
  inline_image: () => {
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 1064654139,
      userId: 2627618651,
      nickname: "[有人@我]",
      text: `[图片 ${JPG_REF}]`,
      images: [{ ref: JPG_REF }],
    });
    const round = answerRound({
      anchor,
      burst: [burstLine(1, 1064654139, 2627618651, "[有人@我]", `[图片 ${JPG_REF}]`)],
      inline: true,
      answerRule: true,
    });
    return { ...round, via: "planRoundImages(inline, 压缩 stub) → withContext → assembleRoundContent → submitContentOf" };
  },

  // fallback 视觉模型路径（decisions §5.4）：保留 inbound/ 路径 + look 提示，无 image block
  fallback_image: () => {
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 1064654139,
      userId: 2627618651,
      nickname: "[有人@我]",
      text: `[图片 ${JPG_REF}]`,
      images: [{ ref: JPG_REF }],
    });
    const round = answerRound({
      anchor,
      burst: [burstLine(1, 1064654139, 2627618651, "[有人@我]", `[图片 ${JPG_REF}]`)],
      inline: false,
      answerRule: true,
    });
    return { ...round, via: "planRoundImages(fallback) → withContext → assembleRoundContent(lookHint)" };
  },

  free_shard: () => triggerFreeShard(),
  free_browse: () => triggerFreeBrowse(),

  // 新闻准备（decisions §5.7：人格候选输入，不再是宿主成品 + say_words）
  news: () => {
    const candidates = buildNewsCandidateInput([{
      topic: "AI",
      items: [
        { title: "示例模型发布新能力", url: "https://example.com/news/ai-1", source: "people", publishedAt: "2026-11-04T01:00:00Z" },
        { title: "示例芯片开始量产", url: "https://example.com/news/chip-2", source: "ithome", publishedAt: "2026-11-04T02:00:00Z" },
      ],
    }]);
    const text = renderTemplate(loadPrompts(PROMPTS).newsDigest, { topics: candidates.prompt, max: "5" });
    return { text, submit: submitContentOf(text, []), via: "buildNewsCandidateInput → news-digest.md" };
  },

  // 自带合集且 @（decisions §5.9 forward-direct）：父消息标准行 + 后置附件 + 子图压缩 block
  forward_direct: () => {
    const forward: ForwardAttachment = {
      id: "fwd-direct",
      sourceMessageId: 1111529000,
      total: 12,
      // 子图槽位占位 [图片#0]（onebot #expandForward 的形状），子图 ref 由 #syncForwardImages 回填
      children: [child(1, "群友甲", "第一条", { userId: "10001" }), child(2, "群友乙", `第二条 [图片#0]`, { images: [JPG_REF] })],
      truncated: true,
    };
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 1111529000,
      userId: 2627618651,
      nickname: "[有人@我]",
      text: "看看这个",
      mentionsBot: true,
      forwardIds: ["fwd-direct"],
      forward,
    });
    const round = answerRound({
      anchor,
      burst: [burstLine(1, 1111529000, 2627618651, "[有人@我]", "看看这个", { mentionsBot: true, forward })],
      inline: true,
      answerRule: true,
    });
    return { ...round, via: "planRoundImages(合集子图换编) → withContext(后置附件) → assembleRoundContent → submitContentOf" };
  },

  // 引用合集并 @（decisions §5.9 forward-reply）：只有 @ 才展开；引用原文里的父消息与合集附件分开渲染
  forward_reply: () => {
    const quoted: QuotedMessage = {
      id: "1111528999",
      nickname: "阿蓝",
      userId: "1066598141",
      text: "",
      images: [],
      forward: {
        id: "fwd-reply",
        sourceMessageId: "1111528999",
        total: 2,
        children: [child(1, "群友甲", "第一条", { messageId: 9001, userId: "10001" }), child(2, "群友乙", "第二条")],
        truncated: false,
      },
    };
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 1111529001,
      userId: 2627618651,
      nickname: "[有人@我]",
      text: "这个合集呢",
      mentionsBot: true,
      replyIds: ["1111528999"],
      repliedForward: true,
      quoted,
    });
    const round = answerRound({
      anchor,
      burst: [burstLine(1, 1111529001, 2627618651, "[有人@我]", "这个合集呢", { mentionsBot: true, replyIds: ["1111528999"], quoted })],
      inline: false,
      answerRule: true,
    });
    return { ...round, via: "withContext(引用原文 + 被引合集附件后置)" };
  },

  // @ 且提到「合集/转发」→ 补展开最近合集（decisions §5.9 forward-recent）：没有来源 ID 就不伪造
  forward_recent: () => {
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 1111529100,
      userId: 2627618651,
      nickname: "[有人@我]",
      text: "看看上面的合集",
      mentionsBot: true,
    });
    const expanded: ForwardAttachment = { id: "fwd-recent", total: 2, children: FORWARD_CHILDREN, truncated: false };
    const round = answerRound({
      anchor,
      burst: [burstLine(1, 1111529100, 2627618651, "[有人@我]", "看看上面的合集", { mentionsBot: true })],
      inline: false,
      answerRule: true,
      recentForward: expanded,
    });
    return { ...round, via: "rewriteRoundForwardImages → assembleRoundContent(recentForward 最后一段)" };
  },

  // 背景里的合集只留短标记（decisions §5.9 forward-background）
  forward_background: () => {
    const forwardMsg = incoming({
      chatKey: GROUP,
      messageId: 1111529200,
      userId: 1066598141,
      nickname: "阿蓝",
      text: "",
      forwardIds: ["fwd-bg"],
    });
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 1111529201,
      userId: 2627618651,
      nickname: "[有人@我]",
      text: "别理那个，看我",
      mentionsBot: true,
      arrivalSeq: 2,
    });
    const bucket = [
      // 背景记账文本由生产入口 backgroundTextOf 产出（index.ts L2259）：合集只留短标记
      recent(1, 1111529200, 1066598141, "阿蓝", backgroundTextOf(forwardMsg, messages)),
      recent(2, 1111529201, 2627618651, "[有人@我]", anchor.text),
    ];
    const round = answerRound({
      anchor,
      bucket,
      burst: [burstLine(2, 1111529201, 2627618651, "[有人@我]", anchor.text, { mentionsBot: true })],
      inline: false,
      answerRule: true,
    });
    return { ...round, via: "backgroundTextOf(短标记) → withContext(背景行)" };
  },

  // 换页：剖面卡片 + 标准消息列表尾巴（decisions §7.2 history-reset）
  history_reset: () => compactHistoryScene(async (root, setNow, faux) => {
    const first = renderOpenMessageList(
      [{ messageId: 2123920686, userId: 1066598141, nickname: "阿蓝", text: "并列第一这招最省事" }],
      messages,
      notMaster,
      notWatched,
    );
    const last = renderOpenMessageList(
      [{ messageId: 2123920695, userId: 2627618651, nickname: "[有人@我]", text: "看完记得说说" }],
      messages,
      notMaster,
      notWatched,
    );
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "我待会儿去看看" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({
      type: "input",
      content: first,
      entry: { kind: "fish.inbound", data: { chatKey: GROUP, userId: "1066598141", nickname: "阿蓝", text: "并列第一这招最省事" } },
    }, ctx)).wait(ctx);
    setNow(stamp(10, 5));
    faux.setResponses([fauxAssistantMessage("收到")]);
    await (await root.submit({
      type: "input",
      content: last,
      entry: { kind: "fish.inbound", data: { chatKey: GROUP, userId: "2627618651", nickname: "[有人@我]", text: "看完记得说说" } },
    }, ctx)).wait(ctx);
  }),

  // 换页：当页模型实际见过合集时，尾巴在完整历史列表后保留该附件（decisions §7.2）
  history_forward: () => compactHistoryScene(async (root, setNow, faux) => {
    const forward: ForwardAttachment = { id: "fwd-hist", sourceMessageId: 2123920700, total: 2, children: FORWARD_CHILDREN, truncated: false };
    const anchor = incoming({
      chatKey: GROUP,
      messageId: 2123920700,
      userId: 1066598141,
      nickname: "阿蓝",
      text: "",
      mentionsBot: true,
      forwardIds: ["fwd-hist"],
      forward,
    });
    const round = withContext(anchor, [], [burstLine(1, 2123920700, 1066598141, "阿蓝", "", { mentionsBot: true, forward })], { master: "", messages }).content;
    faux.setResponses([fauxAssistantMessage("看到了")]);
    await (await root.submit({
      type: "input",
      content: round,
      entry: { kind: "fish.inbound", data: { chatKey: GROUP, userId: "1066598141", nickname: "阿蓝", text: "" } },
    }, ctx)).wait(ctx);
    setNow(stamp(10, 3));
    faux.setResponses([fauxAssistantMessage("记下了")]);
    await (await root.submit({
      type: "input",
      content: "并列第一这招最省事 [m:2123920686]\n我待会儿去看看",
      entry: { kind: "fish.inbound", data: { chatKey: GROUP, userId: "2627618651", nickname: "[有人@我]", text: "并列第一这招最省事 [m:2123920686]\n我待会儿去看看" } },
    }, ctx)).wait(ctx);
    setNow(stamp(10, 5));
    faux.setResponses([fauxAssistantMessage("好的")]);
    await (await root.submit({
      type: "input",
      content: "再补充一句",
      entry: { kind: "fish.inbound", data: { chatKey: GROUP, userId: "1066598141", nickname: "阿蓝", text: "再补充一句" } },
    }, ctx)).wait(ctx);
  }),
};

// ── 权威矩阵与 helper 严格性 ─────────────────────────────────────────────

test("权威矩阵：scene 全覆盖，模板与图片 block 都能只读解析", () => {
  const scenes = loadAuthoritativeScenes();
  assert.equal(scenes.length, AUTHORITATIVE_SCENE_COUNT, "矩阵 scene 数与 decisions §10 不一致");
  assert.equal(new Set(scenes.map((scene) => scene.scene)).size, scenes.length, "scene 有重复");
  for (const scene of scenes) {
    assert.ok(scene.templates.length > 0, `${scene.scene} 没有模板`);
    for (const id of scene.templates) {
      assert.ok(loadAuthoritativeTemplate(id).length > 0, `input-template:${id} 是空的`);
    }
    for (const id of scene.blocks) {
      const block = loadAuthoritativeBlockJson(id) as { type: string; data: string; mimeType: string };
      assert.equal(block.type, "image", `${id} 不是 image block`);
      assert.equal(block.data, "Y29tcHJlc3NlZC0x", `${id} 的 base64 不是 compressed-1`);
      assert.equal(block.mimeType, "image/jpeg", `${id} 的 MIME 不是 image/jpeg`);
    }
    assert.ok(TRIGGERS[scene.scene] !== undefined, `${scene.scene} 没有真实入口触发器`);
  }
  assert.equal(Object.keys(TRIGGERS).length, scenes.length, "触发器数量与矩阵 scene 数不一致");
});

test("helper 严格性：缺标记 / 重复标记 / 非法 JSON / 缺场景 / 占位残留 都直接失败", () => {
  const source = readFileSync(authoritativeDecisionsPath(), "utf8");
  const tempDoc = (mutate: (raw: string) => string): string => {
    const dir = mkdtempSync(join(tmpdir(), "yg-tpl-doc-"));
    const path = join(dir, "decisions.md");
    writeFileSync(path, mutate(source));
    return path;
  };

  assert.throws(
    () => loadAuthoritativeScenes(tempDoc((raw) => raw.replace('{"scene":"news","templates":["news"]},\n  ', ""))),
    /应为 14 个/,
    "矩阵缺场景没有失败",
  );
  assert.throws(
    () => loadAuthoritativeScenes(tempDoc((raw) => raw.replace('{"scene":"news","templates":["news"]}', '{"scene":"news",}'))),
    /不是合法 JSON/,
    "矩阵非法 JSON 没有失败",
  );
  assert.throws(
    () => loadAuthoritativeTemplate("group-reply", tempDoc((raw) => raw.replace("<!-- input-template:group-reply -->", "<!-- input-template:group-reply -->\n<!-- input-template:group-reply -->"))),
    /标记重复/,
    "重复标记没有失败",
  );
  assert.throws(
    () => loadAuthoritativeTemplate("group-reply", tempDoc((raw) => raw.replace("<!-- input-template:group-reply -->", ""))),
    /缺标记/,
    "缺标记没有失败",
  );
  assert.throws(
    () => loadAuthoritativeTemplate("group-reply", tempDoc((raw) => raw.replace("群里有新消息啦。", "<开场白>"))),
    /残留占位符/,
    "占位符残留没有失败",
  );
  assert.throws(
    () => loadAuthoritativeBlockJson("inline-image-block", tempDoc((raw) => raw.replace('"Y29tcHJlc3NlZC0x",', '"Y29tcHJlc3NlZC0x",,'))),
    /不是合法 JSON/,
    "图片 block 非法 JSON 没有失败",
  );
});

test("自由拍 shard 由真实路径触发；空拍自主轮走 onFreeIdle", () => {
  const shard = triggerFreeShard();
  assert.match(shard.via, /collectShard/, "shard 不是收集器路径");
  assert.equal(shard.collected, true, "collectShard 没收下消息");
  assert.ok(shard.text.length > 0, "shard 轮没有渲染出标准消息列表");
  // browse 授权不挂在 shard 上：freeBrowseChance=0 的拍不掷门，shard 文本无浏览语义
  const browse = triggerFreeBrowse();
  assert.equal(browse.gateOpen, true, "freeBrowseChance=1 时空拍门应打开");
  assert.match(browse.text, /主动交流|自由决定/, "自主轮模板未渲染");
});

/**
 * 已观测到的真实差异（只作为断言消息里的定位说明，不放宽比较、不跳过、不改权威模板）：
 * 每条都指向需要裁定的生产/文档 repair，测试保持失败直到 actual 与 decisions 一致。
 */
const REPAIR_NOTES: Record<string, string> = {
  answer_burst_voice:
    "生产 repair 需要：prompt/messages.md 的 voice_hint 与 decisions §5.2 的 [本轮要求] 语音段文案不一致（appendVoiceHint 只搬 messages[voice_hint]）",
  news:
    "生产 repair 需要：renderNewsBroadcast 的 {{source}} 用 NewsItem.source 枚举 id（people/ithome），decisions §5.7 要求中文来源署名（人民网/IT之家）；线上真实 entry 也是 id 形态（docs/reports/2026-11-04-turn-input-shapes.md §3.6）",
  history_forward:
    "生产/文档裁定需要：换页尾巴是逐字投影，合集父消息行必然带 [转发合集]（自带合集只有 @ 才展开，故还带 [这条消息@了你]）标签；decisions §7.2 history-forward-tail 的该行没有任何标签",
};

// ── 16 个 scene：真实入口触发 + 精确比对 ──────────────────────────────────

for (const scene of loadAuthoritativeScenes() as readonly AuthoritativeScene[]) {
  test(`scene ${scene.scene}：真实入口 content == decisions 权威模板（${scene.templates.join(" + ")}）`, async () => {
    const trigger = TRIGGERS[scene.scene];
    assert.ok(trigger !== undefined, `${scene.scene} 缺真实入口触发器`);
    const actual = await trigger();
    assert.ok(actual.via.length > 0, `${scene.scene} 没有记录真实入口`);
    assert.ok(actual.text.length > 0, `${scene.scene} 的真实入口没有产出 content`);

    // 精确比较完整文本：换行、空行、全角/半角标点与段落顺序全部参与
    assert.equal(actual.text, authoritativeSceneText(scene), REPAIR_NOTES[scene.scene] ?? "");

    if (scene.blocks.length > 0) {
      // 图片场景：一个 text block 在前，压缩 image blocks 按编号在后
      assert.ok(Array.isArray(actual.submit), `${scene.scene} 有图片却没有 blocks 形状的 content`);
      const blocks = actual.submit as RoundContentBlock[];
      assert.equal(blocks.length, 1 + scene.blocks.length, `${scene.scene} 的 block 数量不对`);
      assert.deepEqual(blocks[0], { type: "text", text: actual.text }, "第一个 block 必须是完整文本");
      scene.blocks.forEach((id, offset) => {
        assert.deepEqual(blocks[offset + 1], loadAuthoritativeBlockJson(id), `第 ${offset + 1} 个压缩 image block 与权威不一致`);
      });
    } else if (actual.submit !== undefined) {
      // 没有压缩图的轮次：content 是纯字符串，不许出现 image block
      //（换页头走 conversation.reset(head)，不是 submit content，触发器不给 submit）
      assert.equal(typeof actual.submit, "string", `${scene.scene} 不该带 blocks`);
    }
  });
}
