import type { MemoryState } from "./model.ts";

export function hasFact(state: MemoryState, id: string): boolean {
  return (
    (state.feedback ?? []).some((fact) => fact.id === id) ||
    Object.values(state.people).some((person) => person.facts.some((fact) => fact.id === id))
  );
}

/**
 * 真删除一条 fact（从数组移除，区别于 supersede 的 invalidAt 失效——那条审计链保留
 * 历史，这里是彻底清除）。删除通道只有主人的私聊 /记忆 删除 与 scripts/memory.ts 的
 * --delete；命中返回 true。调用方负责打日志（只带 id 与所在 doc，不打印内容）。
 */
export function deleteFactById(state: MemoryState, id: string): boolean {
  const feedback = state.feedback ?? [];
  const feedbackIndex = feedback.findIndex((fact) => fact.id === id);
  if (feedbackIndex >= 0) {
    feedback.splice(feedbackIndex, 1);
    return true;
  }
  for (const person of Object.values(state.people)) {
    const index = person.facts.findIndex((fact) => fact.id === id);
    if (index >= 0) {
      person.facts.splice(index, 1);
      return true;
    }
  }
  return false;
}

export type MemoryCommand =
  | { kind: "list" }
  | { kind: "view"; id: string }
  | { kind: "approve"; id: string; track: "公共" | "私有" }
  | { kind: "reject"; id: string; all: boolean }
  | { kind: "delete"; id: string }
  | { kind: "usage" };

/**
 * 解析 /记忆 指令（闸前机械通道，不进模型）：
 * `/记忆` 列表；`/记忆 查看 <父id>` 展开子项；`/记忆 同意 <父id|子项id> [公共|私有]`
 * （缺省私有——默认最小可见面，公开是主动决定）；
 * `/记忆 拒绝 <父id|全部>`；`/记忆 删除 <fact-id>`（真删除已入库的 fact，仅主人私聊通道生效）；
 * 其它 /记忆 开头的一律回用法。不是 /记忆 指令返回 undefined。
 */
export function parseMemoryCommand(text: string): MemoryCommand | undefined {
  if (text === "/记忆") return { kind: "list" };
  if (!text.startsWith("/记忆 ")) return undefined;
  const rest = text.slice("/记忆 ".length).trim();
  const view = /^查看\s+(\S+)$/.exec(rest);
  if (view) return { kind: "view", id: view[1] };
  const approve = /^同意\s+(\S+)(?:\s+(公共|私有))?$/.exec(rest);
  if (approve) return { kind: "approve", id: approve[1], track: approve[2] === "公共" ? "公共" : "私有" };
  if (rest === "拒绝 全部") return { kind: "reject", id: "all", all: true };
  const reject = /^拒绝\s+(\S+)$/.exec(rest);
  if (reject) return { kind: "reject", id: reject[1], all: false };
  const del = /^删除\s+(\S+)$/.exec(rest);
  if (del) return { kind: "delete", id: del[1] };
  return { kind: "usage" };
}

/**
 * 渲染用两层合并（只读，不改任何 doc）：公共 doc + 本会话私有 doc 合成一个 MemoryState。
 * 同主体事实/说法/卡片按归一化身份去重，重复时保留 hits/importance 更高（平手取更新）的
 * 那条；style 私有层优先（更贴当前会话）。合并只服务 memory section 渲染，写路径仍是
 * 两个 doc 各自 applyPatch、各自上限淘汰。
 */
