/**
 * 特别关注名单的内存镜像。
 *
 * 文档（fish.watch）是权威值，这里只维护一份「宿主侧视图」：随机门的概率、上下文里的
 * 「特别关注」标注、主动 @ 的身份闸都读它。所以写入必须是**整份替换**——
 * 以前按 id 增量合并，`watch remove` 之后旧条目还留在内存里：名单上已经没人了，
 * 那个人照样能让鱼主动 @ 别人（撤销要等重启才生效）。
 *
 * 纯函数，不碰存储：装载、watch 工具变更通知、测试都用同一套规则。
 */
import type { WatchedPerson } from "../store.ts";

export interface WatchedEntry {
  name?: string;
  note: string;
}

/** 一个群的镜像：QQ 号 → 备注。 */
export type WatchedMap = Map<string, WatchedEntry>;

/** 文档里的人数太多了会挤占上下文（watch 侧写入时也截过 20）。 */
const MAX_PEOPLE = 20;

/**
 * 名单 → 镜像。空名单返回 undefined（调用方据此删掉这个群的 key，
 * 留着空 Map 会让「这个群有特别关注」的判断永远为真）。
 */
export function watchedMapFor(people: readonly WatchedPerson[]): WatchedMap | undefined {
  const map: WatchedMap = new Map();
  for (const person of people.slice(-MAX_PEOPLE)) {
    const userId = String(person.userId ?? "").trim();
    if (!userId) continue;
    map.set(userId, { ...(person.name ? { name: person.name } : {}), note: person.note });
  }
  return map.size > 0 ? map : undefined;
}

/**
 * 用文档里的新名单整体替换内存镜像（撤销立即生效）。
 * `store` 的 key 是剥离人格后缀的 base chatKey。
 */
export function replaceWatched(
  store: Map<string, WatchedMap>,
  chatKey: string,
  people: readonly WatchedPerson[],
): void {
  const next = watchedMapFor(people);
  if (next) store.set(chatKey, next);
  else store.delete(chatKey);
}
