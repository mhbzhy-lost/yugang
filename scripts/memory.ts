/**
 * 长期记忆的查看与审批脚本。给 .agents/skills/ops 里的 skill 用，也可以自己敲。
 *
 *   npm run memory                                  # 每人格：公共 doc + 各私有 doc 摘要
 *   npm run memory -- --persona 长征机              # 该人格公共 doc 详情（--json 原始 JSON）
 *   npm run memory -- --persona 长征机 --json
 *   npm run memory -- --chat qq:group:659976571     # 便捷入口：经 fish.chats 的
 *                                                    # personas 解析该会话当前人格再查
 *   npm run memory -- --pending [--json]            # 待审队列（全人格，最旧在前）
 *   npm run memory -- --approve <id> [公共|私有]     # 同意一条（缺省私有；写库）；公共先经
 *                                                    # AI 脱敏（prompt/memory-publicize.md）
 *   npm run memory -- --reject <id|全部>             # 拒绝（写库）
 *   npm run memory -- --delete <fact-id>              # 真删除一条已入库 fact（写库）
 *   # 以上三个写操作在有活鱼时会被拒绝，必须加 --force 且写完重启鱼（见下）
 *
 * 记忆双层 + 审批闸：公共层 fish.memory（key=人格名，跨会话共享）、私有层
 * fish.memory.private（key=人格名@chatKey，仅来源会话）、待审库 fish.memory.pending
 * （压缩链路只入待审，未批准内容不进任何记忆 doc）。写通道只有两处：本脚本的
 * --approve/--reject/--delete 与主人私聊的 /记忆 指令；缺省轨道是私有（最小可见面）。
 * --delete 与私聊 /记忆 删除 同语义：在该人格公共层与全部私有层 doc 里按全局唯一
 * id 定位，从数组真删除（区别于 supersede 的 invalidAt 失效），日志只带 id 与所在 doc。
 *
 * 查看走 node:sqlite 只读连接（不实例化鱼）；--approve/--reject/--delete 经 pi-durable 的
 * createSession 打开同一 fish.db 写 doc。**与线上鱼同库写入是危险操作**：pi-durable 的 id
 * 计数器是进程内存值，外部写完不回灌，线上进程下一次提交会撞号、会话被判损坏而整群静默
 * （2026-11-05 事故）。所以检测到活鱼时写操作直接拒绝，必须确认风险加 --force，且**写完后
 * 必须重启鱼**；更推荐主人在私聊用 /记忆 让线上进程自己写。数据目录与 scripts/ops.ts 一致：
 * YUGANG_HOME 可覆盖，缺省仓库内 var/。
 *
 * 公共批准与私聊 /记忆 同语义：apply 前先把 patch 文本字段交给便宜模型按
 * prompt/memory-publicize.md 做 AI 脱敏（模型与压缩抽取同源，脚本同用主模型，参照
 * scripts/compact-all.ts 先例 loadFishModels + createFishModels）；改写输出重过机械过滤并
 * 强制结构同构，失败 fail closed——该次批准以错误退出终止，不降级、不原样入库；
 * 日志只带 id 与结果状态，不打印内容。私有批准不经脱敏。
 */
import { DATA_HOME as HOME, PROMPT_ROOT } from "../src/paths.ts";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type Session } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadFishModels } from "../src/model/config.ts";
import { createFishModels } from "../src/model/models.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import { DEFAULT_PERSONA_KEY, memoryKeyOf, privateMemoryKeyOf } from "../src/memory/scope.ts";
import { approvePending, rejectPending, deleteFactById, hasFact, summarizePatch, formatAgeShort, signalsSuffix, MEMORY_ZERO_EXTRACT_PAGES, publicizePatch, type MemoryPatch, type MemoryState, type PendingMemoryEntry, type PendingMemoryState } from "../src/memory/index.ts";
import { MemoryDoc, MemoryPendingDoc, MemoryPrivateDoc } from "../src/store.ts";


const DB_PATH = join(HOME, "fish.db");

const args = process.argv.slice(2);
const json = args.includes("--json");
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const rawPersona = valueOf("--persona");
const rawChat = valueOf("--chat");
const pending = args.includes("--pending");
const rawApproveId = valueOf("--approve");
const rawRejectId = valueOf("--reject");
const rawDeleteId = valueOf("--delete");
if (
  (args.includes("--approve") && rawApproveId === undefined) ||
  (args.includes("--reject") && rawRejectId === undefined) ||
  (args.includes("--delete") && rawDeleteId === undefined)
) {
  console.error("--approve 需要 <id> [公共|私有]；--reject 需要 <id|全部>；--delete 需要 <fact-id>");
  process.exit(1);
}
// 同意的轨道：显式「公共」才公共，缺省私有（与 /记忆 同意 一致）
const approveTrack: "公共" | "私有" = (() => {
  const index = args.indexOf("--approve");
  const track = index >= 0 ? args[index + 2] : undefined;
  return track === "公共" ? "公共" : "私有";
})();

const writeMode = rawApproveId !== undefined || rawRejectId !== undefined || rawDeleteId !== undefined;if (writeMode && (rawPersona !== undefined || rawChat !== undefined || pending)) {
  console.error("--approve / --reject / --delete 是独立的写操作，不与 --persona / --chat / --pending 组合");
  process.exit(1);
}
if (!writeMode && rawPersona === undefined && rawChat === undefined && !pending) {
  if (json) {
    console.error("--json 需要配合 --persona <名> / --chat <chatKey> / --pending");
    process.exit(1);
  }
} else if (rawPersona !== undefined && rawChat !== undefined) {
  console.error("--persona 与 --chat 二选一");
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`找不到 ${DB_PATH}（数据目录可用 YUGANG_HOME 覆盖；压缩发生过才会有记忆）`);
  process.exit(1);
}

/**
 * 同库并发写入的硬护栏（2026-11-05 线上事故）：pi-durable 的 id 计数器是**进程内存值**，
 * 只在启动时从库读一次。外部脚本一写库，线上进程的计数器就过期，它下一次提交会撞号
 * （`ID xxx already belongs to document`），会话随即被判损坏、整群静默直到重启。
 * 所以：有活鱼时写操作必须显式 --force，且写完必须重启鱼；更推荐让线上进程自己写
 * （主人私聊的 /记忆 是同一套审批语义，不进模型）。
 */
function liveFishProcesses(): string[] {
  try {
    const out = execFileSync("pgrep", ["-fl", "yugang/src/index.ts"], { encoding: "utf8" });
    return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return []; // pgrep 无匹配时退出码 1
  }
}

if (writeMode) {
  const live = liveFishProcesses();
  if (live.length > 0 && !args.includes("--force")) {
    console.error(
      [
        `检测到 ${live.length} 个正在运行的鱼进程：`,
        ...live.map((line) => `  ${line}`),
        "",
        "外部写库会让它的 id 计数器过期，下一次提交撞号后该会话会被判定损坏、整群静默。",
        "推荐：主人在私聊发 /记忆 让线上进程自己写（同一套审批语义）。",
        "确实要用脚本：写完必须重启鱼，并加 --force 表示已知风险。",
      ].join("\n"),
    );
    process.exit(2);
  }
  if (live.length > 0) {
    console.error("⚠ 已按 --force 写库：写完必须重启鱼（fish.sh deploy），否则它下一次提交会撞号。");
  }
}

/** 只读查看：审批写操作之外的一切都走这条通道。 */
function readDb(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

/**
 * session 级文档的当前值：documents 表的最新 incarnation join 最新 base 版本。
 * kind / key_value 都是 JSON 编码存储（encodeIndexedString），session 的 owner 是 0；
 * checkpointWhen 恒真，最新 base 就是完整值，不需要回放 delta。
 */
function sessionDocs(db: DatabaseSync, kind: string, family: number): { key: string; value: unknown }[] {
  const rows = db
    .prepare(
      `SELECT d.key_value AS key_value, r.content AS content
       FROM documents d
       JOIN document_revisions r
         ON r.document_id = d.id AND r.kind = 'base'
         AND r.seq = (SELECT MAX(r2.seq) FROM document_revisions r2
                      WHERE r2.document_id = d.id AND r2.kind = 'base')
       WHERE d.kind = ? AND d.scope_kind = 'session' AND d.owner_id = 0
         AND d.family = ? AND d.retired_at IS NULL
       ORDER BY d.id`,
    )
    .all(JSON.stringify(kind), family) as { key_value: string; content: string }[];
  return rows.map((row) => ({ key: JSON.parse(row.key_value) as string, value: JSON.parse(row.content) }));
}

/** chatKey 形状（scheme:… 前缀）：用来识别旧 chatKey 级 memory key 与剥离映射键后缀。 */
const CHAT_KEY_RE = /^[a-z][a-z0-9]*:/i;
/** chatKey（可能带 #人格 后缀的映射键）→ 原始 chatKey。 */
const baseChatKeyOf = (mappingKey: string): string => {
  const hash = mappingKey.lastIndexOf("#");
  return hash > 0 ? mappingKey.slice(0, hash) : mappingKey;
};

// ---------------------------------------------------------------- 写通道（--approve / --reject）

/**
 * 审批写操作：经 pi-durable 的 createSession 在同一 fish.db 上 commit doc。
 * id 先用只读连接在全人格待审 doc 里定位（含人格书已删的残留 doc），随后在 commit 内
 * 重读该 doc 再按 id 找条目（写侧原子），条目被并发批掉时按 not found 处理。
 */
async function runApproval(): Promise<void> {
  const db = readDb();
  let persona: string | undefined;
  let pendingEntry: PendingMemoryEntry | undefined;
  try {
    const docs = sessionDocs(db, "fish.memory.pending", 1) as { key: string; value: PendingMemoryState }[];
    const id = rawApproveId ?? rawRejectId;
    if (rawRejectId === "全部") {
      persona = docs.find((doc) => doc.value.entries.length > 0)?.key;
    } else {
      const hostDoc = docs.find((doc) => doc.value.entries.some((entry) => entry.id === id));
      persona = hostDoc?.key;
      pendingEntry = hostDoc?.value.entries.find((entry) => entry.id === id);
    }
  } finally {
    db.close();
  }

  // 公共批准先做 AI 脱敏（与私聊 /记忆 同意 <id> 公共 同语义）：改写输出重过机械过滤、
  // 强制结构同构才放行；模型或输出不合格一律 fail closed——不降级、不原样入库。
  // 模型与压缩抽取同源（memoryModel 链；脚本同用主模型，参照 compact-all 先例）。
  // 日志只带 id 与结果状态。放在开写会话之前：失败时不碰 fish.db。
  let publicized: MemoryPatch | undefined;
  if (rawApproveId !== undefined && approveTrack === "公共" && pendingEntry) {
    const prompts = loadPrompts(PROMPT_ROOT);
    const mainConfig = loadFishModels().main;
    let modelInstance: Models | undefined; // lazy：patch 没有可改写文本时不去碰 models.json
    const result = await publicizePatch(pendingEntry.patch, {
      template: prompts.memoryPublicize,
      complete: async (prompt) => {
        modelInstance ??= createFishModels(mainConfig);
        const model = modelInstance.getModel(mainConfig.providerId, mainConfig.modelId);
        if (!model) throw new Error(`model_not_found:${mainConfig.providerId}/${mainConfig.modelId}`);
        const message = await modelInstance.streamSimple(model, { messages: [{ role: "user", content: prompt }] }).result();
        return message.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      },
    });
    if (result.status === "failed") {
      console.error(`[鱼缸] 记忆公共化脱敏 ${rawApproveId} failed：${result.reason}（fail closed，未写库；可重试或改批私有）`);
      process.exitCode = 1;
      return;
    }
    publicized = result.patch;
    console.log(`[鱼缸] 记忆公共化脱敏 ${rawApproveId} ok`);
  }

  const storage = await openNodeSqliteStorage(DB_PATH);
  const session: Session = createSession(storage);
  const context = BACKGROUND_CONTEXT;
  try {
    if (rawApproveId !== undefined) {
      const target = persona === undefined
        ? { status: "missing" as const }
        : await session.commit(async (tx) => {
            const pendingDoc = await tx.doc(MemoryPendingDoc, persona, persona);
            const entry = pendingDoc.entries.find((item) => item.id === rawApproveId);
            if (!entry) return { status: "missing" as const };
            if (approveTrack === "私有" && !entry.originChatKey) return { status: "no_origin" as const, id: rawApproveId };
            // 公共轨道：把脱敏后的 patch 写回待审条目（同一 commit 内），approvePending 应用的就是改写后文本
            if (publicized) entry.patch = publicized;
            const targetKey = approveTrack === "私有" ? privateMemoryKeyOf(persona, entry.originChatKey) : persona;
            const targetDoc = await tx.doc(approveTrack === "私有" ? MemoryPrivateDoc : MemoryDoc, targetKey, targetKey);
            const applied = approvePending(pendingDoc, rawApproveId, targetDoc, Date.now());
            if (applied.status === "missing") return { status: "missing" as const };
            // draft 代理在事务 settle 后不可读：要带出事务的数据先拷成纯值
            return { status: "ok" as const, originChatKey: String(applied.entry.originChatKey), digest: summarizePatch(applied.entry.patch) };
          }, context);
      if (target.status === "missing") {
        console.error(`没有这条待审：${rawApproveId}`);
        process.exitCode = 1;
      } else if (target.status === "no_origin") {
        console.error(`这条没有来源会话，落不了私有，显式加「公共」再试：${target.id}`);
        process.exitCode = 1;
      } else {
        const where = approveTrack === "私有" ? `私有 ${privateMemoryKeyOf(persona!, target.originChatKey)}` : `公共 ${persona}`;
        console.log(`已并入${approveTrack}记忆（${where}）：${target.digest}`);
      }
      return;
    }

    // --reject <id|全部>：单条按 id 全局定位，全部扫掉每个人格的待审 doc
    const rejectId = rawRejectId === "全部" ? "all" : rawRejectId!;
    let removed = 0;
    const db2 = readDb();
    let personas: string[];
    try {
      personas = rejectId === "all"
        ? sessionDocs(db2, "fish.memory.pending", 1).map((doc) => doc.key)
        : [persona!].filter(Boolean);
    } finally {
      db2.close();
    }
    for (const key of personas) {
      removed += await session.commit(async (tx) => {
        const pendingDoc = await tx.doc(MemoryPendingDoc, key, key);
        return rejectPending(pendingDoc, rejectId);
      }, context);
    }
    if (removed === 0) {
      console.error(`没有这条待审：${rejectId}`);
      process.exitCode = 1;
    } else {
      console.log(`已拒绝 ${removed} 条待审`);
    }
  } finally {
    await session.close(context);
  }
}

/**
 * 真删除一条已入库 fact（--delete）：与私聊 /记忆 删除 同语义。先用只读连接在全部
 * 公共层与私有层 doc 里按全局唯一 id 定位（含人格书已删的残留 doc），再经
 * pi-durable 在同一 fish.db 上 commit 删除；日志只带 id 与所在 doc，不打印内容。
 */
async function runDelete(): Promise<void> {
  const id = rawDeleteId!;
  const db = readDb();
  let target: { token: typeof MemoryDoc | typeof MemoryPrivateDoc; key: string } | undefined;
  try {
    for (const doc of sessionDocs(db, "fish.memory", 1) as { key: string; value: MemoryState }[]) {
      if (hasFact(doc.value, id)) {
        target = { token: MemoryDoc, key: doc.key };
        break;
      }
    }
    if (!target) {
      for (const doc of sessionDocs(db, "fish.memory.private", 1) as { key: string; value: MemoryState }[]) {
        if (hasFact(doc.value, id)) {
          target = { token: MemoryPrivateDoc, key: doc.key };
          break;
        }
      }
    }
  } finally {
    db.close();
  }

  if (!target) {
    console.error(`没有这条记忆：${id}`);
    process.exit(1);
  }
  const storage = await openNodeSqliteStorage(DB_PATH);
  const session: Session = createSession(storage);
  const context = BACKGROUND_CONTEXT;
  try {
    const removed = await session.commit(async (tx) => {
      const doc = await tx.doc(target!.token, target!.key, target!.key);
      return deleteFactById(doc, id);
    }, context);
    if (removed) console.log(`[鱼缸] 记忆删除 ${id} ${target.key}`);
    else {
      console.error(`没有这条记忆：${id}`);
      process.exitCode = 1;
    }
  } finally {
    await session.close(context);
  }
}

if (rawDeleteId !== undefined) {
  await runDelete();
} else if (writeMode) {
  await runApproval();
} else {
  // ---------------------------------------------------------------- 只读查看
  const db = readDb();

  // 会话映射：chats 的键是映射键（chatKey 或 chatKey#人格，同群多人格会有多个），
  // personas 的键是原始 chatKey → 当前人格名。记忆 key 与两者都无关，这里只用于
  // 「该人格当前在哪些会话活跃」的展示与 --chat 解析。
  const chatsDoc = sessionDocs(db, "fish.chats", 0).map((doc) => doc.value as { chats?: Record<string, number>; personas?: Record<string, string> }).at(0);
  const personas: Record<string, string> = chatsDoc?.personas ?? {};
  const personaOfChat = (chatKey: string): string => personas[chatKey] ?? DEFAULT_PERSONA_KEY;

  // 人格 → 当前活跃的会话（原始 chatKey，按字母序）
  const chatsByPersona = new Map<string, string[]>();
  for (const mappingKey of Object.keys(chatsDoc?.chats ?? {})) {
    const base = baseChatKeyOf(mappingKey);
    const persona = personaOfChat(base);
    const list = chatsByPersona.get(persona) ?? [];
    if (!list.includes(base)) list.push(base);
    chatsByPersona.set(persona, list);
  }
  for (const list of chatsByPersona.values()) list.sort();

  const publicMemories = sessionDocs(db, "fish.memory", 1).map((doc) => ({
    persona: doc.key,
    state: doc.value as MemoryState,
  }));
  // 私有层 doc：key = 人格名@chatKey（从最后一个 @ 拆；人格名含 @ 会拆错，起人格名时避开）
  const privateMemories = sessionDocs(db, "fish.memory.private", 1).map((doc) => {
    const at = doc.key.lastIndexOf("@");
    return { persona: doc.key.slice(0, at), chatKey: doc.key.slice(at + 1), key: doc.key, state: doc.value as MemoryState };
  });

  // EXPIRE 待审展示用的 factId → 原文表（公共层 + 全部私有层，只读）
  const factTextById = new Map<string, string>();
  for (const memory of [...publicMemories, ...privateMemories]) {
    for (const person of Object.values(memory.state.people)) {
      for (const fact of person.facts) if (!factTextById.has(fact.id)) factTextById.set(fact.id, fact.text);
    }
  }

  // 旧版按 chatKey 隔离的 fish.memory（session family 的 key 是 chatKey 形状）与更早的
  // 会话级（conversation scope）fish.memory：明确报迁移/冲突，本脚本不静默选择任何一份
  const legacyKeys = publicMemories.filter((m) => CHAT_KEY_RE.test(m.persona));
  const legacyConversation = db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE kind = ? AND scope_kind = 'conversation' AND retired_at IS NULL`)
    .get(JSON.stringify("fish.memory")) as { n: number };
  if (legacyKeys.length > 0 || legacyConversation.n > 0) {
    const parts = [
      ...(legacyKeys.length > 0 ? [`${legacyKeys.length} 个 chatKey 级 fish.memory（${legacyKeys.map((m) => m.persona).slice(0, 3).join("、")}${legacyKeys.length > 3 ? " 等" : ""}）`] : []),
      ...(legacyConversation.n > 0 ? [`${legacyConversation.n} 个会话级 fish.memory`] : []),
    ];
    console.error(`发现旧版${parts.join("、")}，与当前按人格隔离的语义不兼容，本脚本不读取；如需合并请按 ops 文档停机备份后人工迁移`);
  }

  const formatTime = (t: number | undefined) => (t === undefined ? "-" : new Date(t).toISOString());
  const summaryLine = (persona: string, state: MemoryState) => {
    const chats = chatsByPersona.get(persona) ?? [];
    const chatNote = chats.length > 0 ? `  会话：${chats.join("、")}` : "  会话：（当前没有活跃会话）";
    return `${persona}  people=${Object.keys(state.people).length} lore=${state.lore.length} cards=${state.cards.length} lastExtractAt=${formatTime(state.lastExtractAt)}${chatNote}`;
  };

  if (pending) {
    // 待审队列（fish.memory.pending）：全人格单视图，最旧在前；--json 时输出原始 doc
    const docs = sessionDocs(db, "fish.memory.pending", 1)
      .map((doc) => ({ persona: doc.key, state: doc.value as PendingMemoryState }))
      .filter((doc) => doc.state.entries.length > 0);
    if (json) {
      console.log(JSON.stringify(docs.map((doc) => ({ persona: doc.persona, ...doc.state })), null, 2));
    } else if (docs.length === 0) {
      console.log("还没有任何待审记忆（发生过一次有内容的成功压缩才会进待审）");
    } else {
      console.log(`待审队列（上限 MEMORY_PENDING_CAP，当前观察期不设限）：`);
      for (const { persona, state } of docs) {
        const entries = [...state.entries].sort((a, b) => a.at - b.at);
        // 零提取头部提示（T11）：与 /记忆 同款文案语义，达阈值（常量 5）才显示
        const pub = publicMemories.find((m) => m.persona === persona);
        const streak = pub?.state.zeroStreak ?? 0;
        console.log(`${persona}  ${entries.length} 条  最早 ${formatAgeShort(Date.now() - entries[0].at)}前${streak >= MEMORY_ZERO_EXTRACT_PAGES ? `  近 ${streak} 页压缩零提取` : ""}`);
        for (const entry of entries) {
          // 建议轨道只看来源：私聊来的最小可见面默认私有，群聊来的公共也合理（最终由主人定）；
          // signal 标签（T11）是机械重算的计数：已知人物/事实冲突
          const suggest = entry.originChatKey.startsWith("qq:private:") ? "私有" : "公共或私有";
          console.log(`  [${entry.id}] ${entry.originChatKey || "（无来源）"} · ${formatAgeShort(Date.now() - entry.at)}前 · ${summarizePatch(entry.patch)}${signalsSuffix(entry.signals)} · 建议 ${suggest}`);
          // 淘汰条目必须带原事实与依据原话：主人靠这两样判断语义相关性
          for (const note of entry.patch.expire ?? []) {
            console.log(`     淘汰：${note.id} ${factTextById.get(note.id) ?? "-"}（依据「${note.quote}」）`);
          }
        }
      }
    }
  } else if (rawPersona === undefined && rawChat === undefined) {
    if (publicMemories.length === 0 && privateMemories.length === 0) {
      console.log("还没有任何人格的记忆（待审被批准后才会写入记忆 doc）");
    }
    for (const { persona, state } of publicMemories) {
      console.log(summaryLine(persona, state));
      for (const priv of privateMemories.filter((item) => item.persona === persona)) {
        console.log(`  私有 ${priv.chatKey}  people=${Object.keys(priv.state.people).length} lore=${priv.state.lore.length} cards=${priv.state.cards.length}`);
      }
    }
    const knownPersonas = new Set(publicMemories.map((m) => m.persona));
    for (const priv of privateMemories) {
      if (!knownPersonas.has(priv.persona)) {
        console.log(`${priv.persona}（只有私有层）`);
        console.log(`  私有 ${priv.chatKey}  people=${Object.keys(priv.state.people).length} lore=${priv.state.lore.length} cards=${priv.state.cards.length}`);
      }
    }
  } else {
    // --persona 直接是 memory doc key（人格名）；--chat 先剥 #人格 后缀，再经
    // fish.chats 的 personas 解析该会话当前人格（缺省「默认」）
    const chatKey = rawChat === undefined ? undefined : baseChatKeyOf(rawChat);
    const persona = rawPersona !== undefined ? memoryKeyOf(rawPersona) : personaOfChat(chatKey as string);
    if (rawChat !== undefined) console.log(`${chatKey} 当前人格：${persona}`);
    const entry = publicMemories.find((m) => m.persona === persona);
    const privs = privateMemories.filter((item) => item.persona === persona);
    if (!entry && privs.length === 0) {
      console.log(`人格「${persona}」没有记忆（待审被批准后才会写入）`);
      const chats = chatsByPersona.get(persona) ?? [];
      if (chats.length > 0) console.log(`该人格当前活跃会话：${chats.join("、")}`);
    } else if (json) {
      console.log(JSON.stringify({ memoryKey: persona, ...(entry?.state ?? { version: 1, people: {}, lore: [], cards: [] } as MemoryState), private: privs.map((priv) => ({ key: priv.key, ...priv.state })) }, null, 2));
    } else {
      if (entry) {
        console.log(summaryLine(persona, entry.state));
        for (const person of Object.values(entry.state.people)) {
          console.log(`  ${person.subject}  ${person.names.join("/") || "（无别名）"}`);
          for (const fact of person.facts) {
            const status = fact.invalidAt === undefined
              ? "有效"
              : `失效@${formatTime(fact.invalidAt)}${fact.supersededBy ? ` → ${fact.supersededBy}` : ""}`;
            const from = fact.fromChat ? `，来自 ${fact.fromChat}` : "";
            console.log(`    [${fact.id}] ${fact.text}（来源 ${fact.source}${fact.by ? `，转述人 ${fact.by}` : ""}${from}，${status}，命中 ${fact.hits}）`);
          }
          if (person.style) console.log(`    风格：${person.style}`);
          if (person.catchphrases.length > 0) console.log(`    口头禅：${person.catchphrases.join(" / ")}`);
        }
        for (const lore of entry.state.lore) {
          console.log(`  说法 [${lore.kind}] ${lore.keys.join("/")} → ${lore.text}（命中 ${lore.hits}）`);
        }
        for (const card of entry.state.cards) {
          const subjects = card.subjects.length > 0 ? `；subjects: ${card.subjects.join("/")}` : "";
          console.log(`  卡片 [${card.importance}] ${card.text}（keys: ${card.keys.join("/")}${subjects}）`);
        }
      } else {
        console.log(`${persona}  （公共层还没有内容）`);
      }
      for (const priv of privs) {
        console.log(`  私有 ${priv.chatKey}  people=${Object.keys(priv.state.people).length} lore=${priv.state.lore.length} cards=${priv.state.cards.length}`);
        for (const lore of priv.state.lore) {
          console.log(`    说法 [${lore.kind}] ${lore.keys.join("/")} → ${lore.text}（命中 ${lore.hits}）`);
        }
        for (const card of priv.state.cards) {
          console.log(`    卡片 [${card.importance}] ${card.text}（keys: ${card.keys.join("/")}）`);
        }
      }
    }
  }
  db.close();
}
