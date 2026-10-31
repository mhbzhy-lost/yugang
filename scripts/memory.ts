/**
 * 长期记忆的只读查看脚本。给 .agents/skills/ops 里的 skill 用，也可以自己敲。
 *
 *   npm run memory                                  # 列出所有原始 chatKey 的记忆条目数
 *   npm run memory -- --chat qq:group:659976571     # 打印该会话记忆摘要
 *   npm run memory -- --chat qq:group:659976571 --json   # 打印原始 JSON
 *
 * 只读打开数据库（node:sqlite readOnly），不实例化鱼、不写库、不调模型——
 * 避免与线上进程并发写。数据目录与 scripts/ops.ts 一致：YUGANG_HOME 可覆盖，
 * 缺省仓库内 var/。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { memoryKeyOf } from "../src/memory-scope.ts";
import type { MemoryState } from "../src/memory.ts";

const HOME = process.env.YUGANG_HOME ?? join(import.meta.dirname, "..", "var");
const DB_PATH = join(HOME, "fish.db");

const args = process.argv.slice(2);
const json = args.includes("--json");
const chatIndex = args.indexOf("--chat");
const rawChat = chatIndex >= 0 ? args[chatIndex + 1] : undefined;

if (rawChat === undefined && json) {
  console.error("--json 需要配合 --chat <chatKey>");
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

// 会话映射：同一原始 chatKey 可能有多个 #人格 映射键，只用来显示人格列表，
// 不作为记忆 key（记忆永远按去后缀的原始 chatKey 隔离）。
const personasByChat = new Map<string, string[]>();
for (const doc of sessionDocs("fish.chats", 0)) {
  const chats = (doc.value as { chats?: Record<string, number> }).chats ?? {};
  for (const mappingKey of Object.keys(chats)) {
    const base = memoryKeyOf(mappingKey);
    const suffix = mappingKey.slice(base.length);
    const persona = suffix.startsWith("#") ? suffix.slice(1) : "默认";
    const list = personasByChat.get(base) ?? [];
    if (!list.includes(persona)) list.push(persona);
    personasByChat.set(base, list);
  }
}

// 旧 conversation 级 fish.memory（若存在）：明确报迁移/冲突，本脚本不静默选择任何一份
const legacy = db
  .prepare(`SELECT COUNT(*) AS n FROM documents WHERE kind = ? AND scope_kind = 'conversation' AND retired_at IS NULL`)
  .get(JSON.stringify("fish.memory")) as { n: number };
if (legacy.n > 0) {
  console.error(`发现 ${legacy.n} 个会话级 fish.memory（旧数据），本脚本不读取；如需合并请按 ops 文档停机备份后人工迁移`);
}

const memories = sessionDocs("fish.memory", 1).map((doc) => ({
  chatKey: doc.key,
  state: doc.value as MemoryState,
}));

const formatTime = (t: number | undefined) => (t === undefined ? "-" : new Date(t).toISOString());
const summaryLine = (chatKey: string, state: MemoryState) =>
  `${chatKey}  people=${Object.keys(state.people).length} lore=${state.lore.length} cards=${state.cards.length} lastExtractAt=${formatTime(state.lastExtractAt)}`;

if (rawChat === undefined) {
  if (memories.length === 0) {
    console.log("还没有任何会话的记忆（发生过一次成功压缩才会写入第一条）");
  }
  for (const { chatKey, state } of memories) {
    const personas = personasByChat.get(chatKey) ?? [];
    console.log(`${summaryLine(chatKey, state)}${personas.length > 0 ? `  人格：${personas.join("、")}` : ""}`);
  }
} else {
  // --chat 先去人格后缀：同一群不同人格查的是同一份记忆
  const chatKey = memoryKeyOf(rawChat);
  const entry = memories.find((m) => m.chatKey === chatKey);
  if (!entry) {
    console.log(`${chatKey} 没有记忆（发生过一次成功压缩才会写入）`);
    const personas = personasByChat.get(chatKey) ?? [];
    if (personas.length > 0) console.log(`该会话存在（人格：${personas.join("、")}），但记忆还没写过`);
  } else if (json) {
    console.log(JSON.stringify({ memoryKey: entry.chatKey, ...entry.state }, null, 2));
  } else {
    console.log(summaryLine(chatKey, entry.state));
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
