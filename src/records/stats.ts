/**
 * 群周报：把原话簿里某群最近 7 天的流水聚成一段机械统计。
 *
 * 只统计，不总结——所有数字都从 chatlog 现算，不经模型。
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { localDay } from "./usage.ts";

export interface WeeklyStats {
  chatKey: string;
  totalIn: number;
  totalOut: number;
  perDay: { day: string; count: number }[];
  topSpeakers: { nickname: string; count: number }[];
  topHours: { hour: number; count: number }[];
  quietDay: string;
}

function recentWeekDays(now: number): string[] {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(localDay(now - i * 86_400_000));
  return days;
}

function chatlogFileFor(chatlogRoot: string, chatKey: string, day: string): string {
  return join(chatlogRoot, day, `${chatKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`);
}

function createStatsAccumulator(chatKey: string) {
  let totalIn = 0;
  let totalOut = 0;
  const perDay: { day: string; count: number }[] = [];
  const speakers = new Map<string, number>();
  const hours = new Map<number, number>();
  let dayCount = 0;

  return {
    beginDay(): void {
      dayCount = 0;
    },
    addLine(line: string): void {
      if (!line.trim()) return;
      try {
        const e = JSON.parse(line) as { from?: string; kind?: string; at?: number };
        if (e.kind === "in") {
          dayCount++;
          totalIn++;
          if (e.from) speakers.set(e.from, (speakers.get(e.from) ?? 0) + 1);
          if (typeof e.at === "number") {
            const h = new Date(e.at).getHours();
            hours.set(h, (hours.get(h) ?? 0) + 1);
          }
        } else if (e.kind === "out") {
          totalOut++;
        }
      } catch {
        // 坏行跳过
      }
    },
    finishDay(day: string): void {
      perDay.push({ day, count: dayCount });
    },
    finalize(): WeeklyStats | undefined {
      if (totalIn === 0) return undefined;
      const topSpeakers = [...speakers.entries()]
        .map(([nickname, count]) => ({ nickname, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      const topHours = [...hours.entries()]
        .map(([hour, count]) => ({ hour, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      const quietDay = perDay.reduce((min, d) => (d.count < min.count ? d : min), perDay[0]!).day;
      return { chatKey, totalIn, totalOut, perDay, topSpeakers, topHours, quietDay };
    },
  };
}

export function weeklyStats(chatlogRoot: string, chatKey: string, now = Date.now()): WeeklyStats | undefined {
  const days = recentWeekDays(now);
  const acc = createStatsAccumulator(chatKey);

  for (const day of days) {
    acc.beginDay();
    const file = chatlogFileFor(chatlogRoot, chatKey, day);
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        acc.addLine(line);
      }
    }
    acc.finishDay(day);
  }

  return acc.finalize();
}

/** 异步流式周报统计：逐行读取 7 天 chatlog，避免大文件同步 readFileSync 阻塞事件循环。 */
export async function weeklyStatsAsync(chatlogRoot: string, chatKey: string, now = Date.now()): Promise<WeeklyStats | undefined> {
  const days = recentWeekDays(now);
  const acc = createStatsAccumulator(chatKey);

  for (const day of days) {
    acc.beginDay();
    const file = chatlogFileFor(chatlogRoot, chatKey, day);
    let readable = false;
    try {
      await access(file);
      readable = true;
    } catch {
      readable = false;
    }
    if (readable) {
      const stream = createReadStream(file, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          acc.addLine(line);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      } finally {
        rl.close();
        stream.destroy();
      }
    }
    acc.finishDay(day);
  }

  return acc.finalize();
}

export function renderWeekly(stats: WeeklyStats): string[] {
  const day = stats.perDay.map((d) => `${d.day.slice(5)}:${d.count}`).join(" ");
  const speakers = stats.topSpeakers.map((s, i) => `${i + 1}.${s.nickname}(${s.count})`).join(" ");
  const hours = stats.topHours.map((h) => `${h.hour}点(${h.count})`).join(" ");
  return [
    "【本周群周报】",
    `七天发言 ${stats.totalIn} 条，我插了 ${stats.totalOut} 句嘴`,
    `逐日：${day}`,
    `话痨榜：${speakers || "没人说话"}`,
    `黄金时段：${hours}`,
    `最冷：${stats.quietDay.slice(5)}，都在装死`,
  ];
}
