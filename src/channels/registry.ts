/**
 * 通道注册表：`CHANNELS` 环境变量解析、适配器构造与 chatKey 路由（计划 §4.3/§4.4）。
 *
 * - `CHANNELS` 缺省 `qq`（macmini 行为不变）；`none` 或空串 = 不启动任何通道。
 * - 未知通道名启动即抛错，错误信息列出可用名单。
 * - 钉钉 adapter 协议待定：注册位保留，factory 返回 undefined 并提示未实现。
 */
import type { ChannelAdapter, ChannelId } from "./types.ts";

const KNOWN_CHANNELS: readonly ChannelId[] = ["qq", "dingtalk"];

/** 解析 CHANNELS：返回按配置顺序去重后的通道名；`none`/空 → 空数组；未知名 → 抛错。 */
export function parseChannels(raw: string | undefined): ChannelId[] {
  const value = (raw ?? "qq").trim();
  if (value.length === 0 || value === "none") return [];
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter((name) => name.length > 0))];
  for (const name of names) {
    if (!(KNOWN_CHANNELS as readonly string[]).includes(name)) {
      throw new Error(`未知通道 ${name}；可用：${KNOWN_CHANNELS.join(", ")}`);
    }
  }
  return names as ChannelId[];
}

export interface ChannelRegistryOptions {
  /** QQ 适配器的构造参数（mediaRoot / pacingSeconds / onSent 等），由 runtime 传入。 */
  qq?: unknown;
}

export interface ChannelRegistry {
  /** 已启用且构造成功的适配器列表（按 CHANNELS 顺序）。 */
  readonly enabled: readonly ChannelAdapter[];
  has(id: ChannelId): boolean;
  get(id: ChannelId): ChannelAdapter | undefined;
  /** chatKey = `${ChannelId}:${ChatScope}:${id}` → 拥有它的适配器。 */
  for(chatKey: string): ChannelAdapter | undefined;
  /** 依次 start 所有已启用通道；任一失败即抛错（宿主据此退出）。 */
  start(dispatch: (msg: Parameters<ChannelAdapter["start"]>[0]) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 构造通道注册表。T1 阶段 QQ factory 尚未接线：传 `qq` 选项时抛「未实现」占位错误，
 * T3 由 `createQqAdapter` 落地；钉钉 factory 始终返回 undefined（协议待定）。
 */
export function createChannelRegistry(
  enabledIds: readonly ChannelId[],
  _options: ChannelRegistryOptions = {},
): ChannelRegistry {
  const adapters: ChannelAdapter[] = [];
  for (const id of enabledIds) {
    if (id === "qq") {
      // T3 接入：adapters.push(createQqAdapter(options.qq))
      throw new Error("qq adapter 尚未接线（T3）");
    }
    if (id === "dingtalk") {
      // 协议待定，先留白：配置了 dingtalk 也不构造实例，仅提示。
      console.warn("[channels] dingtalk adapter 协议待定，未启用");
      continue;
    }
  }
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter] as const));
  return {
    enabled: adapters,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    for: (chatKey) => adapters.find((adapter) => adapter.owns(chatKey)),
    async start(dispatch) {
      for (const adapter of adapters) await adapter.start(dispatch);
    },
    async stop() {
      for (const adapter of adapters) await adapter.stop();
    },
  };
}
