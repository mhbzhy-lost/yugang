/**
 * 运维脚本。给 .agents/skills/ops 里的 skill 用，也可以自己敲。
 *
 *   node scripts/ops.ts status
 *   node scripts/ops.ts digest [YYYY-MM-DD] [chatKey]
 *   node scripts/ops.ts usage [YYYY-MM-DD]
 *   node scripts/ops.ts probe
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withAccessToken } from "../src/qq/onebot.ts";
import { localDay } from "../src/usage.ts";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const CHATLOG = join(HOME, "chatlog");

const [command = "status", ...args] = process.argv.slice(2);

if (command === "status") {
  const sentPath = join(HOME, "sent.json");
  const sent = existsSync(sentPath) ? (JSON.parse(readFileSync(sentPath, "utf8")) as string[]).length : 0;
  const db = join(HOME, "fish.db");
  console.log(`数据目录   ${HOME}`);
  console.log(`幂等表     ${sent} 条`);
  console.log(`数据库     ${existsSync(db) ? `${(statSync(db).size / 1024 / 1024).toFixed(2)} MB` : "还没建"}`);

  const days = existsSync(CHATLOG) ? readdirSync(CHATLOG).sort() : [];
  console.log(`原话簿     ${days.length} 天${days.length ? `，最近 ${days.at(-1)}` : ""}`);

  const usageDir = join(HOME, "usage");
  const usageDays = existsSync(usageDir) ? readdirSync(usageDir).sort() : [];
  console.log(`用量       ${usageDays.length} 天${usageDays.length ? `，最近 ${usageDays.at(-1)}` : ""}`);
  for (const day of days.slice(-3)) {
    const files = readdirSync(join(CHATLOG, day));
    const lines = files.reduce((n, f) => n + readFileSync(join(CHATLOG, day, f), "utf8").split("\n").filter(Boolean).length, 0);
    console.log(`  ${day}  ${files.length} 个会话 / ${lines} 条`);
  }
} else if (command === "digest") {
  const day = args[0] ?? localDay(Date.now());
  const chat = args[1];
  const dir = join(CHATLOG, day);
  if (!existsSync(dir)) {
    console.log(`${day} 没有记录`);
    process.exit(0);
  }
  for (const file of readdirSync(dir)) {
    const key = file.replace(/\.jsonl$/, "");
    if (chat && !key.includes(chat)) continue;
    const entries = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { from: string; text: string; kind: string; at: number });

    const speakers = new Map<string, number>();
    for (const e of entries.filter((e) => e.kind === "in")) speakers.set(e.from, (speakers.get(e.from) ?? 0) + 1);
    const out = entries.filter((e) => e.kind === "out").length;

    console.log(`\n== ${key}  ${entries.length} 条（鱼说了 ${out} 条）`);
    console.log(
      `   最活跃：${[...speakers.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, n]) => `${name}×${n}`)
        .join("  ")}`,
    );
    const span = entries.length ? `${new Date(entries[0].at).toLocaleTimeString()} - ${new Date(entries.at(-1)!.at).toLocaleTimeString()}` : "";
    console.log(`   时段：${span}`);
    const sample = entries.filter((e) => e.kind === "in").slice(-8);
    for (const e of sample) console.log(`   ${e.from}: ${e.text.slice(0, 60)}`);
  }
} else if (command === "usage") {
  const day = args[0] ?? localDay(Date.now());
  const file = join(HOME, "usage", day, "usage.jsonl");
  if (!existsSync(file)) {
    console.log(`${day} 没有用量记录`);
    process.exit(0);
  }
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { chat: string; total: number; input: number; output: number; cacheRead: number; cost: number });

  const byChat = new Map<string, { total: number; input: number; output: number; cacheRead: number; cost: number }>();
  for (const row of rows) {
    const acc = byChat.get(row.chat) ?? { total: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    acc.total += row.total;
    acc.input += row.input;
    acc.output += row.output;
    acc.cacheRead += row.cacheRead;
    acc.cost += row.cost;
    byChat.set(row.chat, acc);
  }

  console.log(`\n== ${day} 用量`);
  for (const [chat, acc] of [...byChat.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${chat.padEnd(22)} ${String(acc.total).padStart(8)} tokens  (in ${acc.input} / out ${acc.output} / cache ${acc.cacheRead})  计费 ${acc.cost.toFixed(4)}`,
    );
  }
  const sum = [...byChat.values()].reduce((n, a) => n + a.total, 0);
  const cost = [...byChat.values()].reduce((n, a) => n + a.cost, 0);
  console.log(`  合计 ${sum} tokens / 计费 ${cost.toFixed(4)}`);
} else if (command === "probe") {
  const url = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
  const token = process.env.ONEBOT_TOKEN;
  const ws = new WebSocket(token ? withAccessToken(url, token) : url);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ action: "get_login_info", params: {}, echo: "1" }));
    ws.send(JSON.stringify({ action: "get_group_list", params: {}, echo: "2" }));
  });
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as { echo?: string; data?: any };
    if (frame.echo === "1") console.log(`✓ 身份：${frame.data?.nickname} (${frame.data?.user_id})`);
    if (frame.echo === "2") {
      const groups = (frame.data ?? []) as { group_id: number; group_name: string }[];
      console.log(`✓ 在 ${groups.length} 个群：${groups.map((g) => `${g.group_name}(${g.group_id})`).join("、")}`);
      ws.close();
      process.exit(0);
    }
  });
  ws.addEventListener("error", () => {
    console.error(`✗ 连不上 ${url}`);
    process.exit(1);
  });
  setTimeout(() => {
    console.error("✗ 超时");
    process.exit(1);
  }, 10_000).unref?.();
} else {
  console.error(`不认识的命令：${command}`);
  process.exit(1);
}

void resolve;
