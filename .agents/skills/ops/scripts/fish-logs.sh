#!/bin/bash
# 一次拉齐线上最近证据：QQ 消息、durable 事件、在途任务、鱼日志、协议端发送日志。
# 只读诊断，不写 fish.db、不重启进程。只能在本地开发机跑（经 home-connect 连 macmini）。
set -euo pipefail

CONNECT="${HOME_CONNECT:-$HOME/.agents/skills/home-connect/scripts/connect.sh}"
[ -x "$CONNECT" ] || { echo "找不到 home-connect 的 connect.sh：$CONNECT" >&2; exit 1; }

MINUTES=60
GROUP=""
LINES=250
usage() {
  cat <<'EOF'
用法：fish-logs.sh [-m 分钟] [-g 群号] [-n 行数]
  -m 分钟      回看窗口，默认 60；范围 1–1440
  -g 群号      只看这个群（如 659976571）；缺省看全部会话
  -n 行数      每个日志段最多输出行数，默认 250；范围 20–2000
示例：
  fish-logs.sh
  fish-logs.sh -m 30
  fish-logs.sh -m 30 -g 659976571
EOF
}
while getopts "m:g:n:h" opt; do
  case "$opt" in
    m) MINUTES="$OPTARG" ;;
    g) GROUP="$OPTARG" ;;
    n) LINES="$OPTARG" ;;
    h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ "$#" -eq 0 ] || { usage >&2; exit 2; }
[[ "$MINUTES" =~ ^[0-9]+$ ]] && (( MINUTES >= 1 && MINUTES <= 1440 )) || { echo "-m 必须是 1–1440 的数字" >&2; exit 2; }
[[ "$GROUP" =~ ^[0-9]*$ ]] && { [[ -z "$GROUP" ]] || (( ${#GROUP} >= 4 )); } || { echo "-g 必须是纯数字群号" >&2; exit 2; }
[[ "$LINES" =~ ^[0-9]+$ ]] && (( LINES >= 20 && LINES <= 2000 )) || { echo "-n 必须是 20–2000 的数字" >&2; exit 2; }

exec "$CONNECT" mac -- bash -s "$MINUTES" "$GROUP" "$LINES" <<'REMOTE'
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
MINUTES="${1:-60}"
GROUP="${2:-}"
LINES="${3:-250}"
BASE="$HOME/yugang"
DB="$BASE/var/fish.db"
CONSOLE="$BASE/var/fish-console.log"
PROTOCOL="$BASE/var/protocol/qq-console.log"
CHATLOG="$BASE/var/chatlog"

printf '== 鱼缸日志概览 ==\n'
printf '时间: %s  窗口: %s分钟  群过滤: %s  每段上限: %s行\n' \
  "$(date '+%F %T %z')" "$MINUTES" "${GROUP:-全部}" "$LINES"
printf '鱼进程:\n'
ps -eo pid,lstart,etime,command | grep -E 'node .*src/index\.ts' | grep -v grep || echo '(没找到活鱼进程)'
printf '\n'

# 1. 联合时间线：QQ 实际收发、durable 提交、任务起止、机械消息发送完成，按同一时间轴对齐。
MINUTES="$MINUTES" GROUP="$GROUP" LINES="$LINES" DB="$DB" node <<'NODE'
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const minutes = Number(process.env.MINUTES);
const group = process.env.GROUP;
const limit = Number(process.env.LINES);
const db = process.env.DB;
const now = Date.now();
const cutoff = now - minutes * 60_000;
const q = (sql) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 96 * 1024 * 1024 }) || "[]");
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = (s) => clip(s, 500);

// conversationId → chatKey：fish.chats 的最新 base 里有完整映射。
const chatDoc = q("select id, record from documents where kind='fish.chats' limit 1")[0];
const chatBase = chatDoc ? q(`select content from document_revisions where document_id=${Number(chatDoc.id)} and json_extract(content,'$.chats') is not null order by seq desc limit 1`)[0] : undefined;
const convChat = new Map();
try {
  const chats = JSON.parse(chatBase.content ?? "{}").chats ?? {};
  for (const [chat, conv] of Object.entries(chats)) convChat.set(String(conv), String(chat));
} catch {}
const chatOf = (conv) => convChat.get(String(conv)) ?? "";
const shortChat = (chat) => chat.replace(/^qq:group:/, "群").replace(/^qq:private:/, "私");
const hitChat = (chat) => !group || chat.includes(`qq:group:${group}`);

// 最近 chatlog：实际 QQ 到达/发送时间是统一时间线的锚。
const chatRows = [];
const root = process.env.HOME + "/yugang/var/chatlog";
const days = fs.existsSync(root) ? fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().slice(-2) : [];
for (const day of days) {
  const dir = path.join(root, day);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j.at !== "number" || j.at < cutoff || !hitChat(String(j.chat ?? ""))) continue;
        chatRows.push({ at: j.at, chat: String(j.chat ?? ""), kind: String(j.kind ?? ""), from: String(j.from ?? ""), text: String(j.text ?? "").replace(/\s+/g, " ").trim() });
      } catch {}
    }
  }
}
chatRows.sort((a, b) => a.at - b.at);

// 最近 durable entries 与 submissions/tasks：同一次提交多条 entry 共享 commit_seq，必须再按 id 排。
const entryRows = q("select id, commit_seq, record from entries where id >= ((select max(id) from entries) - 10000) order by id");
const parsedEntries = [];
const outboundByKey = new Map();
for (const row of entryRows) {
  let j;
  try { j = JSON.parse(row.record); } catch { continue; }
  if (j.kind === "fish.inbound" && j.data?.chatKey) convChat.set(String(j.conversationId), String(j.data.chatKey));
  if (j.kind === "fish.outbound" && j.data?.key) outboundByKey.set(String(j.data.key), j);
  const rawAt = Number(j.data?.at ?? j.model?.[0]?.timestamp ?? 0);
  parsedEntries.push({ id: Number(row.id), seq: Number(row.commit_seq), conv: Number(j.conversationId), rawAt, j });
}
const seqTime = new Map();
for (const x of parsedEntries) if (x.rawAt > 0 && !seqTime.has(x.seq)) seqTime.set(x.seq, x.rawAt);
const idTime = new Map();
for (const x of parsedEntries) if (x.rawAt > 0) idTime.set(x.id, x.rawAt);
function inferredAt(x) {
  if (x.rawAt > 0) return { at: x.rawAt, inferred: false };
  if (seqTime.has(x.seq)) return { at: seqTime.get(x.seq), inferred: true };
  let prev = -Infinity, next = Infinity, nextAt = 0;
  for (const y of parsedEntries) {
    if (y.conv !== x.conv || y.id === x.id || y.rawAt <= 0) continue;
    if (y.id < x.id && y.id > prev) prev = y.id;
    if (y.id > x.id && y.id < next) { next = y.id; nextAt = y.at = y.rawAt; }
  }
  if (prev === -Infinity && next === Infinity) return { at: 0, inferred: true };
  return { at: prev === -Infinity ? nextAt : idTime.get(prev) ?? nextAt, inferred: true };
}

const submissionConv = new Map();
const submissionAnchor = new Map();
for (const row of q("select id, conversation_id, record from submissions where id >= ((select max(id) from submissions) - 20000)")) {
  submissionConv.set(String(row.id), Number(row.conversation_id));
  try {
    const sub = JSON.parse(row.record);
    if (typeof sub.entry === "number" && idTime.has(sub.entry)) submissionAnchor.set(String(row.id), idTime.get(sub.entry));
  } catch {}
}
const taskRows = q("select id, conversation_id, kind, status, record from tasks where id >= ((select max(id) from tasks) - 20000)");
const parsedTasks = [];
for (const row of taskRows) {
  try { parsedTasks.push({ id: Number(row.id), conv: Number(row.conversation_id), kind: row.kind, status: row.status, j: JSON.parse(row.record) }); } catch {}
}

function entrySummary(x) {
  const j = x.j, m = j.model?.[0], c = m?.content;
  if (j.kind === "fish.inbound") return `${j.data?.nickname ?? j.data?.userId ?? ""}: ${clip(j.data?.text, 180)}`;
  if (j.kind === "fish.outbound") return `enqueue key=${j.data?.key ?? ""} ${clip(j.data?.items?.[0] ?? j.data?.media ?? j.data?.voice ?? "", 150)}`;
  if (j.kind === "fish.engage_tick") return `ambient ${clip(Array.isArray(c) ? c[0]?.text : c, 120)}`;
  if (Array.isArray(c)) {
    const parts = c.map((b) => {
      if (b?.type === "text") return clip(b.text || "(空正文)", 120);
      if (b?.type === "toolCall") return `call ${b.name}(${clip(JSON.stringify(b.arguments ?? {}), 160)})`;
      if (b?.type === "toolResult") return clip(b.content?.[0]?.text ?? "", 120);
      return b?.type ?? "";
    }).filter(Boolean);
    return parts.join(" | ");
  }
  if (typeof c === "string") return clip(c, 160);
  if (j.kind === "pi.system") return `sections=${Object.keys(m?.sections ?? {}).join(",") || "-"}`;
  return "";
}

// 机械消息发送完成序：sent.json 没有时间，只有插入序；用已知文案与 chatlog out 序列还原实际发送时间。
const messagesText = new Map();
try {
  const md = fs.readFileSync(process.env.HOME + "/yugang/prompt/messages.md", "utf8");
  for (const m of md.matchAll(/^([a-z][a-z0-9_]*):\s*(.+)$/gm)) messagesText.set(m[1], m[2].trim());
} catch {}
const sentObject = JSON.parse(fs.readFileSync(process.env.HOME + "/yugang/var/sent.json", "utf8"));
const sentEntries = Object.entries(sentObject).slice(-1000);
const consumedChat = new Set();
const lastSentAtByChat = new Map();
const sentEvents = [];
for (const [slot, key] of sentEntries) {
  let chat = "", expected = "", media = false, anchor = 0;
  const direct = /^(\d+):/.exec(key);
  const working = /^working:([a-z_]+):(\d+)$/.exec(key);
  const stage = /^stage:draw:(\d+):(multi-first|multi-second|sketch|refine)$/.exec(key);
  if (direct) {
    chat = chatOf(Number(direct[1]));
    const out = outboundByKey.get(key);
    if (out?.data) {
      anchor = Number(out.data.at ?? 0);
      expected = norm(out.data.items?.[0] ?? "");
      media = out.data.media !== undefined || out.data.voice !== undefined;
    }
  } else if (working) {
    chat = chatOf(submissionConv.get(working[2]));
    expected = norm(messagesText.get(`working_${working[1]}`) ?? "");
    anchor = submissionAnchor.get(working[2]) ?? Number.MAX_SAFE_INTEGER;
  } else if (stage) {
    chat = chatOf(submissionConv.get(stage[1]));
    // sent key 用连字符（multi-first），messages.md 的 key 是下划线（multi_first），查表前换一下。
    expected = norm(messagesText.get(`draw_stage_${stage[2].replace(/-/g, "_")}`) ?? "");
    anchor = submissionAnchor.get(stage[1]) ?? Number.MAX_SAFE_INTEGER;
  }
  if (!hitChat(chat)) continue;
  const ceiling = anchor + 10 * 60_000;
  const floor = Math.max(cutoff, anchor - 2_000, lastSentAtByChat.get(chat) ?? 0);
  let best = -1;
  for (let i = 0; i < chatRows.length; i++) {
    const r = chatRows[i];
    if (consumedChat.has(i) || r.chat !== chat || r.kind !== "out" || r.at < floor || r.at > ceiling) continue;
    const textMatches = expected && norm(r.text) === expected;
    if (!textMatches && !(media && !r.text)) continue;
    best = i;
    break;
  }
  if (best >= 0) {
    const r = chatRows[best];
    consumedChat.add(best);
    lastSentAtByChat.set(chat, r.at);
    sentEvents.push({ at: r.at, slot: Number(slot), key, chat, text: expected || r.text || (media ? "(附件)" : "") });
  }
}

const unified = [];
for (const r of chatRows) unified.push({ at: r.at, source: "QQ", chat: r.chat, detail: `${r.kind} ${r.kind === "out" ? "fish" : r.from}: ${r.text || "(空)"}` });
for (const x of parsedEntries) {
  const chat = chatOf(x.conv);
  if (!hitChat(chat)) continue;
  const { at, inferred } = inferredAt(x);
  if (!at || at < cutoff) continue;
  unified.push({ at, source: inferred ? "DB~" : "DB", chat, detail: `seq=${x.seq} id=${x.id} ${x.j.kind} ${entrySummary(x)}` });
}
for (const t of parsedTasks) {
  const chat = chatOf(t.conv);
  if (!hitChat(chat)) continue;
  const started = Number(t.j.startedAt ?? 0), ended = Number(t.j.endedAt ?? 0);
  if (started >= cutoff) unified.push({ at: started, source: "TASK", chat, detail: `task=${t.id} start ${t.kind}` });
  if (ended >= cutoff) unified.push({ at: ended, source: "TASK", chat, detail: `task=${t.id} end ${t.kind}/${t.status} ${t.j.state?.outcome?.status ?? ""} ${t.j.state?.outcome?.error?.message ?? ""}`.trim() });
}
for (const s of sentEvents) if (s.at >= cutoff) unified.push({ at: s.at, source: "SENT", chat: s.chat, detail: `slot=${s.slot} key=${s.key} ${s.text}` });

unified.sort((a, b) => a.at - b.at || a.source.localeCompare(b.source));
console.log(`== 联合时间线（${unified.length} 条；QQ=实际收发，DB=durable提交，DB~=推断时间，TASK=任务边界，SENT=发送完成序） ==`);
for (const x of unified.slice(-limit)) {
  console.log(new Date(x.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }), x.source.padEnd(4), shortChat(x.chat) || "-", clip(x.detail, 360));
}
if (unified.length === 0) console.log("(窗口内没有可联合的事件)");
const recentSent = sentEntries;
const unmatched = recentSent.filter(([slot, key]) => {
  const direct = /^(\d+):/.exec(key), working = /^working:([a-z_]+):(\d+)$/.exec(key), stage = /^stage:draw:(\d+):/.exec(key);
  const conv = direct ? Number(direct[1]) : submissionConv.get(working?.[2] ?? stage?.[1]);
  const chat = chatOf(conv);
  return hitChat(chat) && !sentEvents.some((s) => s.key === key);
});
console.log(`sent 匹配说明：窗口内匹配 ${sentEvents.length} 条；最近 key 中未匹配 ${unmatched.length} 条（无时间或附件文本无法唯一对应）`);
for (const [slot, key] of unmatched.slice(-20)) console.log(`  slot=${slot} ${key}`);
console.log("");
NODE

# 2. 最近 QQ 消息：按实际到达/发送时间排序，先给人眼能看的时间线。
MINUTES="$MINUTES" GROUP="$GROUP" LINES="$LINES" node <<'NODE'
const fs = require("fs");
const path = require("path");
const minutes = Number(process.env.MINUTES);
const group = process.env.GROUP;
const limit = Number(process.env.LINES);
const cutoff = Date.now() - minutes * 60_000;
const root = process.env.HOME + "/yugang/var/chatlog";
const days = fs.existsSync(root) ? fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().slice(-2) : [];
const rows = [];
for (const day of days) {
  const dir = path.join(root, day);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    if (group && !name.includes(`_${group}.jsonl`)) continue;
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j.at !== "number" || j.at < cutoff) continue;
        const text = String(j.text ?? "").replace(/\s+/g, " ").trim() || "(空)";
        rows.push({ at: j.at, chat: String(j.chat ?? ""), kind: String(j.kind ?? ""), from: String(j.from ?? ""), text });
      } catch {}
    }
  }
}
rows.sort((a, b) => a.at - b.at);
console.log(`== 最近 QQ 消息（${rows.length} 条，按实际时间排序） ==`);
for (const r of rows.slice(-limit)) {
  const chat = r.chat.replace(/^qq:group:/, "群").replace(/^qq:private:/, "私");
  const who = r.kind === "out" ? "fish" : r.from;
  console.log(new Date(r.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }), chat, r.kind, JSON.stringify(who), JSON.stringify(r.text.slice(0, 220)));
}
if (rows.length === 0) console.log("(窗口内没有消息)");
console.log("");
NODE

# 2. durable 最近事件与在途任务：把 assistant/tool/outbound 的落库顺序、时间和会话放在同一张表里。
MINUTES="$MINUTES" GROUP="$GROUP" LINES="$LINES" DB="$DB" node <<'NODE'
const { execFileSync } = require("child_process");
const minutes = Number(process.env.MINUTES);
const group = process.env.GROUP;
const limit = Number(process.env.LINES);
const db = process.env.DB;
const cutoff = Date.now() - minutes * 60_000;
const q = (sql) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) || "[]");

const recent = q("select commit_seq, record from entries where id >= ((select max(id) from entries) - 5000) order by commit_seq, id");
const convChat = new Map();
const parsed = [];
for (const row of recent) {
  let j;
  try { j = JSON.parse(row.record); } catch { continue; }
  if (j.kind === "fish.inbound" && j.data?.chatKey) convChat.set(String(j.conversationId), String(j.data.chatKey));
  const at = Number(j.data?.at ?? j.model?.[0]?.timestamp ?? 0);
  parsed.push({ seq: Number(row.commit_seq), conv: Number(j.conversationId), at, j });
}
const chatOf = (conv) => convChat.get(String(conv)) ?? "";
const hitGroup = (conv) => !group || chatOf(conv).includes(`qq:group:${group}`);
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function contentSummary(j) {
  const m = j.model?.[0];
  const c = m?.content;
  if (j.kind === "fish.inbound") return `${j.data?.nickname ?? j.data?.userId ?? ""}: ${clip(j.data?.text, 180)}`;
  if (j.kind === "fish.outbound") {
    const d = j.data ?? {};
    return `key=${d.key ?? ""} ${clip(d.items?.[0] ?? d.media ?? d.voice ?? "", 180)}`;
  }
  if (Array.isArray(c)) {
    const parts = c.map((b) => {
      if (b?.type === "text") return clip(b.text || "(空正文)", 140);
      if (b?.type === "toolCall") return `call ${b.name}(${clip(JSON.stringify(b.arguments ?? {}), 180)})`;
      if (b?.type === "toolResult") return clip(b.content?.[0]?.text ?? "", 140);
      return b?.type ?? "";
    }).filter(Boolean);
    return parts.join(" | ");
  }
  if (typeof c === "string") return clip(c, 180);
  if (j.kind === "pi.system") return `sections=${Object.keys(m?.sections ?? {}).join(",") || "-"}`;
  return "";
}
const events = parsed.filter((x) => x.at >= cutoff && hitGroup(x.conv));
console.log(`== durable 最近事件（${events.length} 条，按时间排序） ==`);
for (const x of events.slice(-limit)) {
  const time = x.at ? new Date(x.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "-";
  const chat = chatOf(x.conv).replace(/^qq:group:/, "群").replace(/^qq:private:/, "私");
  console.log(time, `seq=${x.seq}`, chat || `conv=${x.conv}`, x.j.kind, clip(contentSummary(x.j), 320));
}
if (events.length === 0) console.log("(窗口内没有匹配事件)");
console.log("");

const tasks = q("select id, conversation_id, kind, status, record from tasks where status in ('pending','running','waiting','sleeping') order by id");
console.log(`== 在途/等待任务（${tasks.length} 条） ==`);
for (const t of tasks) {
  let j;
  try { j = JSON.parse(t.record); } catch { continue; }
  const started = Number(j.startedAt ?? 0);
  const age = started ? Math.round((Date.now() - started) / 1000) : null;
  const chat = chatOf(Number(t.conversation_id)).replace(/^qq:group:/, "群").replace(/^qq:private:/, "私");
  const input = j.input ? clip(JSON.stringify(j.input), 260) : "";
  const checkpoint = j.state?.checkpoint ? clip(JSON.stringify(j.state.checkpoint), 260) : "";
  console.log(`id=${t.id}`, `age=${age ?? "-"}s`, chat || `conv=${t.conversation_id}`, `${t.kind}/${t.status}`, input || checkpoint);
}
if (tasks.length === 0) console.log("(没有非终态任务)");
console.log("");
NODE

# 3. sent.json 的发送完成顺序：机械提示不进 transcript，这里是它唯一的完成顺序证据。
LINES="$LINES" node <<'NODE'
const fs = require("fs");
const limit = Number(process.env.LINES);
const path = process.env.HOME + "/yugang/var/sent.json";
const j = JSON.parse(fs.readFileSync(path, "utf8"));
const rows = Object.entries(j).slice(-Math.min(Math.max(limit * 2, 80), 400));
console.log(`== sent.json 发送完成序（最近 ${rows.length} 个 key） ==`);
for (const [index, [slot, key]] of rows.entries()) console.log(`${Number(slot)} ${key}`);
console.log("");
NODE

# 4. 鱼控制台日志：按时间重新排序，避免多个进程追加导致文件顺序跳动。
MINUTES="$MINUTES" GROUP="$GROUP" LINES="$LINES" CONSOLE="$CONSOLE" node <<'NODE'
const fs = require("fs");
const minutes = Number(process.env.MINUTES);
const group = process.env.GROUP;
const limit = Number(process.env.LINES);
const cutoff = Date.now() - minutes * 60_000;
const lines = fs.readFileSync(process.env.CONSOLE, "utf8").split("\n");
const out = [];
let currentAt = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = /^\[?(\d{2}):(\d{2}):(\d{2})\]?/.exec(line.replace(/^\x1b\[[0-9;]*m/, ""));
  if (m) {
    const now = new Date();
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), Number(m[3]));
    if (at.getTime() > Date.now() + 5 * 60_000) at.setDate(at.getDate() - 1);
    currentAt = at.getTime();
  }
  if (currentAt < cutoff) continue;
  if (group && !line.includes(`qq:group:${group}`) && !/draw|Comfy|发送失败|保留 sending|补发|换页|配置/.test(line)) continue;
  out.push({ at: currentAt, i, line });
}
out.sort((a, b) => a.at - b.at || a.i - b.i);
console.log(`== 鱼日志（窗口内 ${out.length} 行，按时间排序后取末尾 ${Math.min(out.length, limit)} 行） ==`);
console.log(out.slice(-limit).map((x) => x.line).join("\n") || "(窗口内没有日志)");
console.log("");
NODE

# 4. 协议端日志：先看 mtime 是否新鲜；陈旧日志不拿旧内容冒充当前 NapCat 证据。
MINUTES="$MINUTES" LINES="$LINES" PROTOCOL="$PROTOCOL" node <<'NODE'
const fs = require("fs");
const minutes = Number(process.env.MINUTES);
const limit = Number(process.env.LINES);
const path = process.env.PROTOCOL;
const stat = fs.statSync(path);
const fresh = stat.mtimeMs >= Date.now() - minutes * 60_000;
console.log(`== NapCat 协议端日志 ==`);
console.log(`文件: ${path}`);
console.log(`mtime: ${stat.mtime.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}${fresh ? "" : "（早于查询窗口，不再输出旧日志）"}`);
if (fresh) {
  const lines = fs.readFileSync(path, "utf8").trimEnd().split("\n").slice(-Math.max(2000, limit * 6));
  const hit = lines.filter((line) => /发送 ->|接收 <-|error|warn|failed|失败|超时|timeout/i.test(line));
  console.log(`（取末尾 ${Math.min(hit.length, limit)} 行）`);
  console.log(hit.slice(-limit).join("\n") || "(最近没有发送/接收/错误行)");
}
NODE
REMOTE
