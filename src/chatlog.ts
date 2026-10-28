/**
 * 原话簿：按群按天把流水写进 var/chatlog/。
 *
 * 只记「谁说了什么」和「鱼说了什么」，不记 thinking 和 tool 结果。
 * 这是给运维 skill 做 digest 用的，鱼自己看不到（它没有读文件的工具）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ChatlogEntry {
  at: number;
  chat: string;
  from: string;
  text: string;
  kind: "in" | "out";
}

export function createChatlog(root: string) {
  return {
    append(entry: ChatlogEntry): void {
      try {
        const day = new Date(entry.at).toISOString().slice(0, 10);
        const dir = join(root, day);
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          join(dir, `${entry.chat.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`),
          `${JSON.stringify(entry)}\n`,
        );
      } catch (error) {
        console.error("[鱼缸] 原话簿写入失败", error instanceof Error ? error.message : error);
      }
    },
  };
}
