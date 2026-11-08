/**
 * bypass 暂存 —— 「帮我画一张图。bypass: 1girl, solo」的机械预处理。
 *
 * bypass: 段从进模型上下文的文本里剥离，由宿主按 submissionId 暂存（与
 * triggerOf 同生命周期），draw 出图时拼在最终 positive prompt 末尾。
 * 权限：主人（MASTER_QQ）或 BYPASS_GROUPS 名单内的群，其余不剥离。
 */
export const BYPASS_LIMIT = 200;

/** bypass 段：前置字符非 ASCII 字母数字（兼容中文句号等 CJK 标点紧邻、也挡住「xxbypass:」误配），支持中英文冒号，段取到行尾（文本已单行归一）。宿主入口也用它定位 bypass 段做记忆文本剥离。 */
export const BYPASS_RE = /(?<![a-z0-9])bypass[：:]\s*(.+)$/i;

/** 人物级 bypass（多角色轮专用）：附加到左右分区精修段。pbypass 先于 bypass 匹配（长前缀优先），
 *  避免单行内 bypass: 段把 pbypass: 的内容一并吞掉。 */
export const PBYPASS_RE = /(?<![a-z0-9])pbypass[：:]\s*(.+)$/i;

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

/** 剥离 bypass 段（含可选 pbypass 人物段）：无段或全空返回 null；
 *  stash=场景级（bypass:，单角色与多角色构图/收尾段）；pstash=人物级（pbypass:，多角色左右精修段）。
 *  各截断到 BYPASS_LIMIT 字符；clean 剥掉全部指令段。 */
export function splitBypass(text: string): { clean: string; stash: string; pstash?: string } | null {
  const pb = PBYPASS_RE.exec(text);
  const scope = pb ? text.slice(0, pb.index) : text;
  const bp = BYPASS_RE.exec(scope);
  if (!bp && !pb) return null;
  const stash = bp ? [...bp[1].trim()].slice(0, BYPASS_LIMIT).join("") : "";
  const pstash = pb ? [...pb[1].trim()].slice(0, BYPASS_LIMIT).join("") : undefined;
  if (!stash && !pstash) return null;
  const cut = Math.min(...[bp?.index ?? Infinity, pb?.index ?? Infinity].filter((v) => v !== Infinity));
  return { clean: text.slice(0, cut).trim(), stash, ...(pstash ? { pstash } : {}) };
}
