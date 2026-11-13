/**
 * local-driver —— 本地真实模型模拟测试：QQ 输入输出换成日志文件。
 *
 * 与生产（macmini）的差别只有两点：
 *   1. 入站：不连 OneBot，从一个「剧本」JSONL 文件逐条读群消息（构造标准
 *      消息列表提交，走 openFish 的完整 agent loop：真实模型、真实工具、
 *      真实出口校验与额度）；
 *   2. 出站：emit / react 不发 QQ，追加写 var/local-driver/outbound.jsonl
 *      （结构化：{at, items, media, quote, mentions, key}），另有每轮的
 *      transcript 摘要与 token 用量写 rounds.jsonl。
 *
 * 覆盖：模型行为、工具调用（say_words 等出口、draw、look 锁死、remind）、出口闸、
 * inline 附图（剧本可带 images 路径，真实压缩/抽帧管线）、记忆 pushScope。
 * 不覆盖：gate / 开窗 / shard / debounce 状态机（纯逻辑层，另有 146 项单测）。
 *
 * 用法：
 *   node scripts/local-driver.ts                          # 交互内置剧本（两轮）
 *   node scripts/local-driver.ts scripts/itbed/<剧本名>.jsonl
 *
 * 剧本格式（JSONL，每行一条）：
 *   {"from": 10001, "name": "群友A", "text": "@鱼 你好", "mention": true}
 *   {"from": 10002, "name": "群友B", "text": "看这张图 [图片 inbound/xxx.jpg]"}
 *   {"from": 10002, "name": "群友B", "text": "看这个动图 [图片 inbound/yyy.gif]"}
 *   {"from": 10002, "name": "群友B", "text": "...", "images": ["inbound/xxx.jpg"], "reply": 5001}
 * mention=true 表示这条 @ 了鱼（必答轮）；缺省 ambient 轮（非必答、零出口合法）。
 *
 * 隔离：临时 ROOT（chdir），不碰真实 var/、不连 QQ、不发网络请求到协议端。
 * 凭据用仓库根 config/models.json + config/auth.json（本地 qoder-pool）。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { loadFishModels } from "../src/model/config.ts";
import { openFish } from "../src/harness.ts";
import { planRoundImages, planInlineImages } from "../src/channels/qq/round-images.ts";
import { assembleRoundContent, submitContentOf, appendAnswerRules, renderOpenMessageList, renderOpenQuotedText, renderBrowseOpportunity } from "../src/channels/qq/round-input.ts";
import { gifTagOf, imageTagOf } from "../src/channels/qq/model-input.ts";
import type { BurstMessage } from "../src/qq/debounce.ts";
import { withContext } from "../src/channels/qq/round-input.ts";
import type { QuotedMessage, ForwardAttachment } from "../src/channels/qq/model-input.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DRIVER_HOME = join(ROOT, "var", "local-driver");
const FIXTURES = join(DRIVER_HOME, "fixtures");
const MASTER = "2928390812";

/** 剧本一条（群友消息）。quoted / forward 结构与生产同形（src/qq/model-input.ts）。 */
interface ScriptLine {
  from: number;
  name: string;
  text: string;
  /** 这条 @ 了鱼（answer 轮）缺省 false（ambient 轮）。 */
  mention?: boolean;
  /** 这条 @ 的其他人（渲染「接收对象是…，不是你」）。 */
  mentionTargets?: string[];
  /** 结构化引用原文（列表后附 [引用原文]）。 */
  quoted?: QuotedMessage;
  /** 自带合集（@ 了鱼才展开）。 */
  forward?: ForwardAttachment;
  /** 空拍自主门轮：true = 直接提交 [主动交流机会]（不经掷门，测试确定性触发）。 */
  browse?: boolean;
  /** 自主轮 topic（缺省「二次元」）。 */
  topic?: string;
}

const DEFAULT_SCRIPT: ScriptLine[] = [
  { from: 10001, name: "遐蝶小姐的狗", text: "在吗", mention: true },
  { from: 10002, name: "大肥鱼V4.1F", text: "今天天气不错啊" },
  { from: 10003, name: "中间学派", text: "鱼在忙什么", mention: true },
];
function nowIso(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  if (process.env.DEBUG_FETCH) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("qoder")) {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body) {
          const parsed = JSON.parse(body);
          // 掐掉大头：messages 只留结构
          const slim = { ...parsed, messages: (parsed.messages ?? []).map((m) => ({ role: m.role, content: typeof m.content === "string" ? `(${m.content.length}字)` : (m.content ?? []).map((b) => b.type), cache_control: m.cache_control })) };
          console.log("⇢ qoder 请求（掐概）:", JSON.stringify({ url: String(input), ...slim }, null, 1).slice(0, 1800));
        }
      }
      return realFetch(input, init);
    };
  }
  const scriptPath = process.argv[2];
  const script: ScriptLine[] = scriptPath
    ? readFileSync(scriptPath, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => {
      const parsed = JSON.parse(l) as ScriptLine;
      // quoted 归一化：images 缺省补 []（renderQuotedOriginal 直接 .map）
      if (parsed.quoted && !parsed.quoted.images) parsed.quoted = { ...parsed.quoted, images: [] };
      if (parsed.quoted?.forward) {
        parsed.quoted.forward = { ...parsed.quoted.forward, children: parsed.quoted.forward.children.map((c) => ({ ...c, images: c.images ?? [] })) };
      }
      if (parsed.forward) {
        parsed.forward = { ...parsed.forward, children: parsed.forward.children.map((c) => ({ ...c, images: c.images ?? [] })) };
      }
      return parsed;
    })
    : DEFAULT_SCRIPT;

  // 隔离 ROOT：prompt 指向真实（行为定义就是它们），媒体/工作区/数据落临时目录
  const tmpRoot = mkdtempSync(join(tmpdir(), "yg-driver-"));
  const mediaRoot = join(tmpRoot, "media");
  for (const d of ["inbound", "gen", "memes", "meme-inbox"]) mkdirSync(join(mediaRoot, d), { recursive: true });
  // fixture 拷进临时 inbound（剧本引用 inbound/photo.jpg / inbound/anim.gif）
  if (existsSync(FIXTURES)) {
    for (const f of readdirSync(FIXTURES)) cpSync(join(FIXTURES, f), join(mediaRoot, "inbound", f));
  }
  const workspaceRoot = join(tmpRoot, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(DRIVER_HOME, { recursive: true });
  const outboundLog = join(DRIVER_HOME, "outbound.jsonl");
  const roundsLog = join(DRIVER_HOME, "rounds.jsonl");
  for (const f of [outboundLog, roundsLog]) if (existsSync(f)) writeFileSync(f, "");

  // 真实模型（本地 config/models.json → qoder-pool）
  const selection = loadFishModels();
  const models = createModels();
  const mainProvider = selection.main;
  // createFishModels 需要凭据形状；这里直接用 loadFishModels 的完整配置建 provider
  const { createFishModels } = await import("../src/model/models.ts");
  const fishModels = createFishModels(mainProvider);

  const outbound: unknown[] = [];
  const fish = await openFish({
    storage: await (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(join(tmpRoot, "fish.db")),
    models: fishModels,
    model: { provider: mainProvider.providerId, modelId: mainProvider.modelId },
    mediaRoot,
    workspaceRoot,
    promptRoot: join(ROOT, "prompt"),
    emit: (_cid, payload) => {
      const record = { at: nowIso(), ...payload };
      appendFileSync(outboundLog, JSON.stringify(record) + "\n");
      outbound.push(record);
      console.log(`  ↳ 出站: ${JSON.stringify(payload.items ?? payload.media ?? payload.voice ?? "<非文本>")}`);
    },
    react: (_cid, emoji, messageId) => {
      const record = { at: nowIso(), react: emoji, messageId };
      appendFileSync(outboundLog, JSON.stringify(record) + "\n");
      console.log(`  ↳ 贴表情: ${emoji}（→ m:${messageId ?? "-"}）`);
    },
    master: MASTER,
    // 主模型直读图：qoder-pool 的 openai-completions 通道吃 image_url（已真机验证）
    visionModel: { provider: mainProvider.providerId, modelId: mainProvider.modelId },
    inlineVisionOn: () => true,
    triggerOf: (roundId) => scriptTrigger.get(String(roundId)),
  } as never);

  const scriptTrigger = new Map<string, unknown>();
  const ctx = BACKGROUND_CONTEXT;
  const conv = await fish.group("qq:group:local", {
    groupId: "888888",
    count: 6,
    master: MASTER,
    members: [
      { nickname: "遐蝶小姐的狗", userId: "10001" },
      { nickname: "大肥鱼V4.1F", userId: "10002" },
      { nickname: "中间学派", userId: "10003" },
    ],
  });

  console.log(`本地驱动就绪：模型 ${mainProvider.providerId}/${mainProvider.modelId}，剧本 ${script.length} 条`);
  console.log(`出站日志：${outboundLog}\n`);

  let messageId = 5000;
  let arrivalSeq = 100;
  for (const [index, line] of script.entries()) {
    messageId += 1;
    arrivalSeq += 1;
    const id = messageId;
    const isAnswer = line.mention === true;

    // 空拍自主门轮（browse: true）：确定性触发，不掷 freeBrowseChance 骰子
    if (line.browse === true) {
      const topic = line.topic ?? "二次元";
      const content = renderBrowseOpportunity(fish.prompts.messages);
      console.log(`  ↳ 主动交流机会（topic: ${topic}）`);
      const submission = await conv.submit(
        { type: "input", content, entry: { kind: "fish.engage_tick", data: { chatKey: "qq:group:local", browse: true, topic } } },
        ctx,
      );
      scriptTrigger.set(String(submission.id), { messageId: id, mentionsBot: false, userId: MASTER, kind: "injection", browseWindow: `free-driver-${id}`, browseTopic: topic });
      const settled = await submission.wait(ctx);
      await fish.drain([conv.id]);
      const view = await conv.viewState(ctx);
      const entries = view.value.entries as readonly { id?: number; kind?: string; model?: unknown }[];
      view.dispose();
      let bare = "";
      for (const entry of entries) {
        if (entry.kind !== "pi.assistant") continue;
        const blocks = (entry.model as { content?: { type: string; text?: string }[] }[] | undefined)?.[0]?.content ?? [];
        bare = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
      }
      if (bare) console.log(`  ↳ 裸回复（未走出口）: ${bare.split("\n").find((l) => l.trim())?.slice(0, 100) ?? ""}`);
      appendFileSync(roundsLog, JSON.stringify({ at: nowIso(), status: settled.status, from: "browse", text: `主动交流机会 topic=${topic}`, bare: bare.slice(0, 200) }) + "\n");
      console.log(`  ↳ 轮结束: ${settled.status}`);
      continue;
    }
    console.log(`\n── [${index + 1}/${script.length}] ${line.name}(${line.from})${isAnswer ? " @鱼" : ""}: ${line.text.slice(0, 60)}`);

    // 生产渲染路径，按轮类型分流（与 runtime 一致）：
    //   answer 轮 → flushBurst 装配（planRoundImages + withContext + assembleRoundContent + answer 规范段）
    //   ambient 轮 → submitShardRound 装配（planInlineImages + renderOpenMessageList + GIF 双边收录标记）
    const IMAGE_REF = /\[图片 (inbound\/[^\]\s]+)\]/g;
    const isMaster = String(line.from) === MASTER;
    let content: string;
    let blocks: { type: "image"; data: string; mimeType: string }[] = [];
    let entryKind = "fish.inbound";
    if (isAnswer) {
      const burst: BurstMessage[] = [{
        arrivalSeq,
        messageId: id,
        userId: line.from,
        nickname: line.name,
        text: line.text,
        mentionsBot: true,
        replyIds: line.quoted ? [String(line.quoted.id)] : [],
        ...(line.mentionTargets ? { mentionTargets: line.mentionTargets } : {}),
        ...(line.quoted ? { quoted: line.quoted } : {}),
        ...(line.forward ? { forward: line.forward } : {}),
        at: Date.now(),
      }];
      const anchor = {
        chatKey: "qq:group:local",
        userId: line.from,
        nickname: line.name,
        text: line.text,
        mentionsBot: true,
        messageId: id,
        arrivalSeq,
        images: [] as { ref: string }[],
        imageSegments: [] as unknown[],
        replyIds: line.quoted ? [String(line.quoted.id)] : [],
        quoted: line.quoted,
        forward: line.forward,
        at: Date.now(),
      };
      const plan = planRoundImages(anchor as never, burst, mediaRoot, true, fish.prompts.messages);
      const roundContext = withContext(anchor as never, [], burst, {
        master: MASTER,
        messages: fish.prompts.messages,
        // 2026-11-06 合并：@ 轮背景缺省全量未读；driver 无 recent 流水，bucket 为空即无背景
        seenSeq: 0,
        imageNumbers: plan.numbers,
        watched: () => false,
      });
      content = appendAnswerRules(
        assembleRoundContent(roundContext.content, { tags: plan.tags, lookHint: plan.lookHint }, fish.prompts.messages),
        [fish.prompts.messages["video_answer_rule"] ?? ""],
      );
      blocks = plan.blocks as typeof blocks;
      if (blocks.length > 0) console.log(`  ↳ inline 附图 ${blocks.length} 个 block（${plan.gifFrames.size} 张 GIF）`);
    } else {
      // ambient 轮（shard 同款）：直发图行内编号，GIF 加双边收录标记
      const refs: string[] = [];
      for (const match of line.text.matchAll(IMAGE_REF)) refs.push(match[1] ?? "");
      for (const ref of line.quoted?.images ?? []) refs.push(ref);
      const plan = planInlineImages(refs, mediaRoot, true, fish.prompts.messages);
      // GIF 双边收录标记只在 gifAutoCollect 开着时附（线上由 fish.config.json 门控，缺省 false）；
      // 本地驱动不加载 fish.config，按缺省不附
      const collectHint = "";
      let text = line.text;
      for (const [ref, n] of plan.numbers) {
        const frames = plan.gifFrames.get(ref);
        let tag: string;
        if (frames !== undefined) {
          tag = gifTagOf(n, ref, frames, fish.prompts.messages);
          if (collectHint.length > 0) tag = `${tag}${collectHint}`;
        } else {
          tag = imageTagOf(n, ref, fish.prompts.messages);
        }
        text = text.split(`[图片 ${ref}]`).join(tag);
      }
      const item = {
        messageId: id,
        userId: line.from,
        nickname: line.name,
        text,
        replyIds: line.quoted ? [String(line.quoted.id)] : [],
        ...(line.quoted ? { quoted: line.quoted } : {}),
        ...(line.mentionTargets ? { mentionTargets: line.mentionTargets } : {}),
      };
      const list = renderOpenMessageList([item], fish.prompts.messages, (u) => String(u) === MASTER, () => false);
      const quoted = renderOpenQuotedText([item], fish.prompts.messages, plan.numbers, plan.gifFrames);
      const sections = [list];
      if (quoted.length > 0) sections.push(quoted);
      if (plan.tags.length > 0) sections.push(plan.tags.join("\n"));
      content = sections.filter((s) => s.length > 0).join("\n\n");
      blocks = plan.blocks as typeof blocks;
      entryKind = "fish.engage_tick";
      if (blocks.length > 0) console.log(`  ↳ inline 附图 ${blocks.length} 个 block（${plan.gifFrames.size} 张 GIF）`);
    }

    const submit = submitContentOf(content, blocks);
    const submission = await conv.submit(
      { type: "input", content: submit, entry: { kind: entryKind, data: { chatKey: "qq:group:local", userId: String(line.from), nickname: line.name, text: line.text } } },
      ctx,
    );
    scriptTrigger.set(String(submission.id), { messageId: id, mentionsBot: isAnswer, userId: line.from, kind: isAnswer ? "answer" : "ambient" });
    const settled = await submission.wait(ctx);
    await fish.drain([conv.id]);
    // 零出口轮的可观测化：取本轮末条 assistant 的正文（生产里 answer 轮有 salvagePlainReply
    // 兜底补发，ambient 轮本来允许沉默；driver 都打出来供观察，不冒充真实出口）
    const view = await conv.viewState(ctx);
    const entries = view.value.entries as readonly { id?: number; kind?: string; model?: unknown }[];
    view.dispose();
    let bare = "";
    for (const entry of entries) {
      if (entry.kind !== "pi.assistant") continue;
      const blocks = (entry.model as { content?: { type: string; text?: string }[] }[] | undefined)?.[0]?.content ?? [];
      bare = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
    }
    if (bare) console.log(`  ↳ 裸回复（未走出口）: ${bare.split("\n").find((l) => l.trim())?.slice(0, 100) ?? ""}`);
    appendFileSync(roundsLog, JSON.stringify({ at: nowIso(), status: settled.status, from: line.name, text: line.text.slice(0, 60), bare: bare.slice(0, 200) }) + "\n");
    console.log(`  ↳ 轮结束: ${settled.status}`);
  }

  console.log(`\n完成。出站 ${outbound.length} 条 → ${outboundLog}`);
  await fish.close();
}

main().catch((error) => {
  console.error("驱动失败:", error instanceof Error ? error.message : error);
  process.exit(1);
});
