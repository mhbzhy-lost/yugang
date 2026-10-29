/**
 * 一次性运维：把所有会话全部压缩换页（reset + handoff 摘要）。
 *
 *   node --env-file-if-exists=.env scripts/compact-all.ts
 *
 * 用途：部署新版前清掉带图历史（图片块留在 transcript 会让每轮请求撞
 * 网关视觉管线的间歇 500）。**必须先停鱼再跑**（同一个 fish.db 不能
 * 双进程并发写）；跑完接着 `npm run deploy` 即可。
 *
 * 实现：以极小阈值（1 条即触发）打开一个临时 fish 实例，对 chats 映射
 * 里的每个会话调 fish.compact（含摘要模型调用），然后关闭。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadModelConfig } from "../src/model-config.ts";
import { createFishModels } from "../src/models.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openFish } from "../src/harness.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const cfg = loadModelConfig();
const gateModel = {
  provider: process.env.GATE_PROVIDER ?? cfg.providerId,
  modelId: process.env.GATE_MODEL_ID ?? cfg.modelId,
};

const fish = await openFish({
  storage: await openNodeSqliteStorage(join(HOME, "fish.db")),
  models: createFishModels(cfg),
  model: { provider: cfg.providerId, modelId: cfg.modelId },
  promptRoot: process.env.PROMPT_ROOT ?? "prompt",
  mediaRoot: join(HOME, "media"),
  workspaceRoot: join(HOME, "workspace"),
  master: process.env.MASTER_QQ ?? "",
  // 极小阈值：任何有内容的会话都会触发换页
  compact: { model: gateModel, maxEntries: 1, maxChars: 1 },
  emit: () => {},
  react: () => {},
});

try {
  const snapshot = await fish.harness.snapshot(
    // 复用 openFish 暴露的 harness；chats 映射经 fish.drain 的同源文档读取
    (await import("../src/store.ts")).ChatsDoc,
    BACKGROUND_CONTEXT,
  );
  const chats = Object.entries(snapshot?.chats ?? {});
  console.log(`共 ${chats.length} 个会话映射键`);
  let done = 0;
  for (const [key, conversationId] of chats) {
    const conv = await fish.harness.conversation(conversationId, BACKGROUND_CONTEXT);
    if (!conv) {
      console.log(`  跳过 ${key}（会话不存在）`);
      continue;
    }
    const result = await fish.compact(conv);
    console.log(`  ${key}: ${result.compacted ? `已换页（${result.entries}条/${result.chars}字）` : `未换页（${result.reason}）`}`);
    if (result.compacted) done++;
  }
  console.log(`完成：${done}/${chats.length} 个会话已换页`);
} finally {
  await fish.close();
}
