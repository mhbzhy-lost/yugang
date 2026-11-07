/**
 * installToolSurface：扫描工具包、合并文案、校验必需 key、给每个工具套
 * 超时与链接登记包装（2026-11-05 从 harness.ts 拆出）。
 *
 * 这是装配链第一步：后面的 extensions / harness 都要消费 `tools` 与 `surface.manifests`。
 */
import { LiveDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import { REJECTION_CODES } from "../egress/policy.ts";
import { loadToolSurface, type ToolSurface } from "../tools/loader.ts";
import { withSeenLinkHarvest, withToolTimeout } from "../tools/timeout.ts";
import type { ToolPackageDeps } from "../tools/types.ts";
import type { FishBase } from "./base.ts";

export interface ToolSurfaceParts {
  surface: ToolSurface;
  /** name → 原始注册（未包超时/登记），核心工具校验用。 */
  registered: Map<string, ToolRegistration>;
  /** 实际挂给扩展的工具（已包超时 + 已包 seen-link 登记）。 */
  tools: readonly ToolRegistration[];
}

export async function installToolSurface(base: FishBase): Promise<ToolSurfaceParts> {
  const { options, prompts, mediaRoot, limits, now, models } = base;

  // 最终 loader：扫描 src/tools/<name>/TOOL.md + tool.ts，严格一一对应后调 factory 注册；
  // say_* 四工具 / react / tool_search eager，其余已启用工具 deferred。依赖不满足（无 master、
  // 无出口限额等）的 factory 返回 undefined：不进 agent.tools、agent.deferred、tool_catalog。
  const packageDeps: ToolPackageDeps = {
    prompts,
    mediaRoot,
    limits,
    now,
    ...(models ? { models } : {}),
    visionModel: options.visionModel ?? options.model,
    ...(options.visionFallbackModel ? { visionFallbackModel: options.visionFallbackModel } : {}),
    ...(options.searchKey === undefined ? {} : { searchKey: options.searchKey }),
    ...(options.master === undefined ? {} : { master: options.master }),
    ...(options.modelsPath === undefined ? {} : { modelsPath: options.modelsPath }),
    ...(options.chatKeyOf ? { chatKeyOf: options.chatKeyOf } : {}),
    // 同一条链路两用：watch 校验关注对象、say_* 校验主动 @ 的目标
    ...(options.groupMembersOf ? { groupMembersOf: options.groupMembersOf, membersOf: options.groupMembersOf } : {}),
    ...(options.onWatchChanged ? { onWatchChanged: options.onWatchChanged } : {}),
    ...(options.gptImage ? { gptImage: options.gptImage } : {}),
    ...(options.sdUrl === undefined ? {} : { sdUrl: options.sdUrl }),
    ...(options.tagsCsv === undefined ? {} : { tagsCsv: options.tagsCsv }),
    ...(options.triggerOf ? { triggerOf: options.triggerOf } : {}),
    ...(options.bypassOf ? { bypassOf: options.bypassOf } : {}),
    ...(options.mentionPolicyOf ? { mentionPolicyOf: options.mentionPolicyOf } : {}),
    // 末条自言禁言（决策 24）：宿主事实回调，say_* 的 ambient/injection 轮素材分享校验消费
    ...(options.lastWasFishOf ? { lastWasFishOf: options.lastWasFishOf } : {}),
    ...(options.ttsOf ? { ttsOf: options.ttsOf } : {}),
    ...(options.newsPrepare ? { newsPrepare: options.newsPrepare } : {}),
    ...(options.silentOf ? { silentOf: options.silentOf } : {}),
    ...(options.onSayCall ? { onSayCall: options.onSayCall } : {}),
    ...(options.onLongWork ? { onLongWork: options.onLongWork } : {}),
    ...(options.memeCooldownMs !== undefined ? { memeCooldownMs: options.memeCooldownMs } : {}),
    ...(options.reminderTask ? { reminderTask: options.reminderTask } : {}),
    ...(options.inlineVisionOn ? { inlineVisionOn: options.inlineVisionOn } : {}),
    // 宿主侧 limits 与 react 是 FishOptions 硬性要求，这里只是统一交给 factory
    react: options.react,
  };
  const surface = await loadToolSurface(packageDeps);

  // 启动必要 key 校验：作用于合并后的视图（中心 prompt/messages.md + 各工具 TOOL.md 的
  // tool-messages 块，loadToolSurface 已就地并入 prompts.messages），清单与迁移前一致
  for (const code of [
    ...REJECTION_CODES,
    "say_sent",
    "say_once",
    "busy_reply",
    "tool_catalog_header",
    "tool_catalog_line",
    "tool_search_ok",
    "tool_search_line",
    "tool_search_none",
    "tool_search_empty",
    "tool_search_bad_limit",
    "memory_section_header",
    "memory_people_header",
    "memory_lore_header",
    "memory_cards_header",
    "cmd_memory_group",
    "cmd_memory_usage",
    "cmd_memory_empty",
    "cmd_memory_list_header",
    "cmd_memory_entry",
    "cmd_memory_more",
    "cmd_memory_ok",
    "cmd_memory_missing",
    "cmd_memory_no_origin",
    "cmd_memory_rejected",
    "cmd_memory_rejected_all",
    "cmd_memory_deleted",
    "cmd_memory_delete_missing",
    "cmd_memory_supersede_note",
    "cmd_memory_zero_extract",
    "memory_feedback_missing_quote",
  ]) {
    if (!prompts.messages[code]) throw new Error(`缺少文案 key：${code}（中心或 TOOL.md）`);
  }

  const registered = new Map(surface.tools.map((tool) => [tool.name, tool]));
  for (const name of ["say_words", "say_media", "say_meme", "say_voice", "react", "tool_search"]) {
    if (!registered.has(name)) throw new Error(`核心工具未注册：${name}`);
    if (registered.get(name)!.deferred === true) throw new Error(`核心工具必须是 eager：${name}`);
  }

  // 单次工具调用超时（默认 30 秒）：卡住的通常是某一个工具，不是整轮。
  // withToolTimeout 用展开拷贝包装：deferred / callers / parameters / description 原样保留。
  // withSeenLinkHarvest 在工具返回后把 URL 登记进本轮白名单（say_words 出口校验消费）。
  const toolTimeoutMs = (options.toolTimeoutSeconds ?? 30) * 1000;
  const toolTimeoutMessage = prompts.messages["tool_timeout"] ?? "tool_timeout";
  const tools: readonly ToolRegistration[] = surface.tools.map((tool) => {
    const override = options.toolTimeoutOverrides?.[tool.name];
    const wrapped = withToolTimeout(tool, override === undefined ? toolTimeoutMs : override * 1000, toolTimeoutMessage);
    return withSeenLinkHarvest(wrapped, async (api, context) => {
      const live = (await (api as { snapshot: (doc: unknown, id: string, c: unknown) => Promise<unknown>; conversationId: string })
        .snapshot(LiveDoc, (api as { conversationId: string }).conversationId, context)) as { run?: { inputs?: unknown[] } } | undefined;
      return live?.run?.inputs?.[0];
    });
  });

  return { surface, registered, tools };
}
