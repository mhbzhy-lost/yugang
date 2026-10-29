/**
 * 群周报：把原话簿里某群最近 7 天的流水聚成一段机械统计。
 *
 * 只统计，不总结——所有数字都从 chatlog 现算，不经模型。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export function weeklyStats(chatlogRoot: string, chatKey: string, now = Date.now()): WeeklyStats | undefined {
  const fileFor = (day: string) => join(chatlogRoot, day, `${chatKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`);
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(localDay(now - i * 86_400_000));

  let totalIn = 0;
  let totalOut = 0;
  const perDay: { day: string; count: number }[] = [];
  const speakers = new Map<string, number>();
  const hours = new Map<number, number>();

  for (const day of days) {
    const file = fileFor(day);
    let count = 0;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { from?: string; kind?: string; at?: number };
          if (e.kind === "in") {
            count++;
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
      }
    }
    perDay.push({ day, count });
  }

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
}

export function renderWeekly(stats: WeeklyStats): string[] {
  const day = stats.perDay.map((d) => `${d.day.slice(5)}:${d.count}`).join(" ");
  const speakers = stats.topSpeakers.map((s, i) => `${i + 1}.${s.nickname}(${s.count})`).join(" ");
  const hours = stats.topHours.map((h) => `${h.hour}点(${h.count})`).join(" ");
  return [
    "【本周搬史群周报】",
    `七天发言 ${stats.totalIn} 条，我插了 ${stats.totalOut} 句嘴`,
    `逐日：${day}`,
    `话痨榜：${speakers || "没人说话"}`,
    `黄金时段：${hours}`,
    `最冷：${stats.quietDay.slice(5)}，都在装死`,
  ];
}
