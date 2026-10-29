/**
 * bypass 暂存 —— 「帮我画一张图。bypass: 1girl, solo」的机械预处理。
 *
 * bypass: 段从进模型上下文的文本里剥离，由宿主按 submissionId 暂存（与
 * triggerOf 同生命周期），draw 出图时拼在最终 positive prompt 末尾。
 * 权限：主人（MASTER_QQ）或 BYPASS_GROUPS 名单内的群，其余不剥离。
 */
export const BYPASS_LIMIT = 200;

/** bypass 段：前置字符非 ASCII 字母数字（兼容中文句号等 CJK 标点紧邻、也挡住「xxbypass:」误配），支持中英文冒号，段取到行尾（文本已单行归一）。 */
const BYPASS_RE = /(?<![a-z0-9])bypass[：:]\s*(.+)$/i;

/** 主人或 BYPASS_GROUPS 名单内的群才有权用 bypass。 */
export function bypassAllowed(
  userId: unknown,
  groupId: unknown,
  master: string,
  groups: readonly string[],
): boolean {
  if (master && String(userId ?? "") === master) return true;
  return groups.includes(String(groupId ?? ""));
}

/** 剥离 bypass 段：无段或段为空返回 null；stash 截断到 BYPASS_LIMIT 字符。 */
export function splitBypass(text: string): { clean: string; stash: string } | null {
  const m = BYPASS_RE.exec(text);
  if (!m) return null;
  const stash = [...m[1].trim()].slice(0, BYPASS_LIMIT).join("");
  if (!stash) return null;
  return { clean: text.slice(0, m.index).trim(), stash };
}
