/**
 * meme_import 的跨工具共享状态：本轮导入清单。
 *
 * 这份状态被三个工具共同消费：meme_import 写入（登记本轮可看的清单）、look 读取并回写
 * 「已看过」记录、meme_add 用「在清单里 + 看过」作为本地入库的机械凭据。全仓库只有这里
 * 这一份 Map：look / meme_add 只从本模块读取，不各自复制清单，轮结束由宿主清掉。
 */
export interface MemeImportManifest {
  roundId: string;
  refs: string[];
  /** 这一轮已经看过的 ref：逐张导入的机械凭据（没看过的不许 meme_add）。 */
  lookedRefs: string[];
  createdAt: number;
}

/** 单次登记与单轮 look 的硬上限。 */
export const MEME_IMPORT_MAX = 50;

/** 当前轮的导入清单：key 是 LiveDoc 的 round id（submission id），轮结束即删。 */
const manifests = new Map<string, MemeImportManifest>();

/** 登记（多批合并）：同一轮里继续拉下一批不会把上一批的授权作废，已经看过的记录也保留。 */
export function registerMemeImportRound(roundId: string, refs: readonly string[]): void {
  const existing = manifests.get(roundId);
  const merged = existing ? [...existing.refs] : [];
  for (const ref of refs) {
    if (!merged.includes(ref)) merged.push(ref);
  }
  manifests.set(roundId, {
    roundId,
    refs: merged,
    lookedRefs: existing ? [...existing.lookedRefs] : [],
    createdAt: existing?.createdAt ?? Date.now(),
  });
}

export function memeImportManifestOf(roundId: string): MemeImportManifest | undefined {
  return manifests.get(roundId);
}

export function memeImportRefs(roundId: string): readonly string[] {
  return manifests.get(roundId)?.refs ?? [];
}

/** 这张图是不是本轮清单里的（meme_add 的本地导入授权就靠它）。 */
export function memeImportHas(roundId: string, ref: string): boolean {
  return memeImportRefs(roundId).includes(ref);
}

/** 这张清单里的图这一轮看过没：只有看过的才允许 meme_add。 */
export function memeImportLooked(roundId: string, ref: string): boolean {
  return manifests.get(roundId)?.lookedRefs.includes(ref) ?? false;
}

/** 本轮已经看过几张清单里的图（重复看不重复计，不占额度）。 */
export function memeImportLookedCount(roundId: string): number {
  return manifests.get(roundId)?.lookedRefs.length ?? 0;
}

/** 记下「这张确实被 look 成功看过」；只在描述真的返回后才由 look 调用。 */
export function memeImportMarkLooked(roundId: string, ref: string): void {
  const manifest = manifests.get(roundId);
  if (!manifest) return;
  if (!manifest.refs.includes(ref)) return;
  if (!manifest.lookedRefs.includes(ref)) manifest.lookedRefs.push(ref);
}

/** 本轮 look 的额度：有清单就按清单张数（上限 50），没有清单返回 undefined（普通轮照旧 2 张）。 */
export function memeImportLookLimit(roundId: string): number | undefined {
  const manifest = manifests.get(roundId);
  if (!manifest) return undefined;
  return Math.min(manifest.refs.length, MEME_IMPORT_MAX);
}

/** round 结束 / 异常 / 中断都要清：清单（含已看记录）绝不跨轮、跨群存活。 */
export function clearMemeImportRound(roundId: string): void {
  manifests.delete(roundId);
}
