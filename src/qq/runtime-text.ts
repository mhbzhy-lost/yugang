/**
 * runtime section 的模型可见动态裁剪（决策 18；2026-11-06 合并后只剩 free|legacy）。
 *
 * prompt/runtime.md 里的「自由活动群…」段是群搭话协议（段首是稳定锚，T1 契约）：
 * free（GROUPS 群）保留，legacy（私聊 / worker / 群外会话）裁掉——留着只会误导。
 * 按段首前缀定位、按空行分段裁剪，不引入新文案。找不到段（prompt 被改坏）时原样
 * 返回，不抛错。
 *
 * 单独成模块是为了让自检脚本能 import 它而不拉起 pi-durable / memory 整张依赖图。
 */

/** free 专属小节的段首前缀。 */
export const FREE_SECTION_PREFIX = "自由活动群";

export type RuntimeEngagement = "legacy" | "free";

/** 按段首前缀裁掉一个自然段（到下一个空行为止）；找不到该段时原样返回。 */
function stripSection(base: string, prefix: string): string {
  const lines = base.split("\n");
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start < 0) return base;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].trim() === "") {
      end = index;
      break;
    }
  }
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > 0 ? text : base;
}

/** 按搭话模式裁剪 runtime 协议：free 留自由活动段，legacy 裁掉。 */
export function runtimeTextOf(base: string, engagement: RuntimeEngagement): string {
  if (engagement === "legacy") return stripSection(base, FREE_SECTION_PREFIX);
  return base;
}
