/**
 * 长期记忆的只读查看脚本。给 .agents/skills/ops 里的 skill 用，也可以自己敲。
 *
 *   npm run memory                                  # 列出所有人格的记忆条目数
 *   npm run memory -- --persona 长征机              # 打印该人格记忆摘要
 *   npm run memory -- --persona 长征机 --json       # 打印原始 JSON
 *   npm run memory -- --chat qq:group:659976571     # 便捷入口：经 fish.chats 的
 *                                                   # personas 解析该会话当前人格再查
 *
 * 记忆按人格隔离（一个人格一份，跨群/私聊共享）；--json 输出的 memoryKey 就是人格名。
 * 只读打开数据库（node:sqlite readOnly），不实例化鱼、不写库、不调模型——
 * 避免与线上进程并发写。数据目录与 scripts/ops.ts 一致：YUGANG_HOME 可覆盖，
 * 缺省仓库内 var/。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PERSONA_KEY, memoryKeyOf } from "../src/memory-scope.ts";
import type { MemoryState } from "../src/memory.ts";

const HOME = process.env.YUGANG_HOME ?? join(import.meta.dirname, "..", "var");
const DB_PATH = join(HOME, "fish.db");

const args = process.argv.slice(2);
const json = args.includes("--json");
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const rawPersona = valueOf("--persona");
const rawChat = valueOf("--chat");

if (rawPersona === undefined && rawChat === undefined) {
  if (json) {
    console.error("--json 需要配合 --persona <名> 或 --chat <chatKey>");
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

const db = new DatabaseSync(DB_PATH, { readOnly: true });

/**
 * session 级文档的当前值：documents 表的最新 incarnation join 最新 base 版本。
 * kind / key_value 都是 JSON 编码存储（encodeIndexedString），session 的 owner 是 0；
 * checkpointWhen 恒真，最新 base 就是完整值，不需要回放 delta。
 */
function sessionDocs(kind: string, family: number): { key: string; value: unknown }[] {
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

// 会话映射：chats 的键是映射键（chatKey 或 chatKey#人格，同群多人格会有多个），
// personas 的键是原始 chatKey → 当前人格名。记忆 key 与两者都无关，这里只用于
// 「该人格当前在哪些会话活跃」的展示与 --chat 解析。
const chatsDoc = sessionDocs("fish.chats", 0).map((doc) => doc.value as { chats?: Record<string, number>; personas?: Record<string, string> }).at(0);
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

const memories = sessionDocs("fish.memory", 1).map((doc) => ({
  persona: doc.key,
  state: doc.value as MemoryState,
}));

// 旧版按 chatKey 隔离的 fish.memory（session family 的 key 是 chatKey 形状）与更早的
// 会话级（conversation scope）fish.memory：明确报迁移/冲突，本脚本不静默选择任何一份
const legacyKeys = memories.filter((m) => CHAT_KEY_RE.test(m.persona));
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

if (rawPersona === undefined && rawChat === undefined) {
  if (memories.length === 0) {
    console.log("还没有任何人格的记忆（发生过一次成功压缩才会写入第一条）");
  }
  for (const { persona, state } of memories) console.log(summaryLine(persona, state));
} else {
  // --persona 直接是 memory doc key（人格名）；--chat 先剥 #人格 后缀，再经
  // fish.chats 的 personas 解析该会话当前人格（缺省「默认」）
  const chatKey = rawChat === undefined ? undefined : baseChatKeyOf(rawChat);
  const persona = rawPersona !== undefined ? memoryKeyOf(rawPersona) : personaOfChat(chatKey as string);
  if (rawChat !== undefined) console.log(`${chatKey} 当前人格：${persona}`);
  const entry = memories.find((m) => m.persona === persona);
  if (!entry) {
    console.log(`人格「${persona}」没有记忆（该人格发生过一次成功压缩才会写入）`);
    const chats = chatsByPersona.get(persona) ?? [];
    if (chats.length > 0) console.log(`该人格当前活跃会话：${chats.join("、")}`);
  } else if (json) {
    console.log(JSON.stringify({ memoryKey: entry.persona, ...entry.state }, null, 2));
  } else {
    console.log(summaryLine(persona, entry.state));
    for (const person of Object.values(entry.state.people)) {
      console.log(`  ${person.subject}  ${person.names.join("/") || "（无别名）"}`);
      for (const fact of person.facts) {
        const status = fact.invalidAt === undefined ? "有效" : `失效@${formatTime(fact.invalidAt)}`;
        console.log(`    [${fact.id}] ${fact.text}（来源 ${fact.source}${fact.by ? `，转述人 ${fact.by}` : ""}，${status}，命中 ${fact.hits}）`);
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
  }
}

db.close();
