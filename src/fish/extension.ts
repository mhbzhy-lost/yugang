/**
 * 人格扩展（2026-11-05 从 harness.ts 拆出）：一个 Extension = 运行时的 section 清单。
 *
 * 默认人格 fish + 每本人格书一个 fish:<名>；工具实例共享，会话按名只选其一。
 * `harness.ts` 的 installExtensions 调这里的 makeFishExtension。
 */
import { defineExtension, section, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompt/index.ts";
import type { ToolManifest } from "../tools/types.ts";
import type { EngagementMode } from "../fish-config.ts";
import { renderToolCatalog } from "../tools/catalog.ts";
import { MemoryDoc, MemoryPrivateDoc, WatchDoc } from "../store.ts";
import { mergeMemoryStates, renderMemorySection } from "../memory/index.ts";
import { peekScope, privateMemoryKeyOf } from "../memory/scope.ts";

export function makeFishExtension(
  name: string,
  persona: string,
  parts: {
    tools: readonly ToolRegistration[];
    prompts: PromptSet;
    manifests: readonly ToolManifest[];
    /** conversationId → 原始 chatKey（人格后缀已去掉）；root 会话没有记忆，返回 undefined */
    memoryKeyOf: (conversationId: string) => string | undefined;
    /** conversationId → 原始 chatKey：私有层 doc key（人格名@chatKey）由它现算 */
    chatKeyOf: (conversationId: string) => string | undefined;
    /** 携话模式现取（热）：runtime 的「自由交流窗口」小节仅 next 注入（决策 18，T3 接线）。 */
    engagementOf: (chatKey: string) => EngagementMode;
  },
): Extension {
  return defineExtension({
    name,
    tools: parts.tools,
    sections: [
      // 运行时协议：能力边界、输入信任、出口、错误处理、渐进加载；人格无关，不随人格换页。
      // 「自由交流窗口」小节是 next 专属的窗口协议，legacy 下动态裁掉（见 runtimeTextOf）
      section("runtime", (input) => runtimeTextOf(parts.prompts.runtime, parts.engagementOf(parts.chatKeyOf?.(String(input.conversationId)) ?? "")), { tag: false }),
      section("persona", () => persona, { tag: false }),
      // 工具目录：每次请求由 trusted manifest 现渲染，只列已启用工具的 name + 顶部摘要；
      // 「目录 ≠ 已加载」的行为说明在 prompt/runtime.md，这里不内嵌提示词
      section("tool_catalog", () => renderToolCatalog(parts.manifests, parts.prompts.messages), { tag: true }),
      // 运维书：只给主人用的管理工具怎么用（模型切换 + 重启）
      section("ops", () => parts.prompts.ops, { tag: true }),
      // 手工维护的人物档：比对话记忆更牢，和 handoff 互补
      section("people", () => parts.prompts.people, { tag: true }),
      // 特别关注名单：会话级文档，每次请求重新渲染（换页不动它），空名单不占位
      section("watched", async (input, context) => {
        const snapshot = await input.read.snapshot(WatchDoc, input.conversationId, context);
        const people = snapshot?.people ?? [];
        if (people.length === 0) return undefined;
        const header = parts.prompts.messages["watch_section_header"] ?? "";
        const lines = people.map((p) => `${p.name ? `${p.name}(${p.userId})` : p.userId}：${p.note}`);
        return [header, ...lines].filter((line) => line.length > 0).join("\n");
      }, { tag: true }),
      // 长期记忆：只经这一个 system section 注入，绝不进 user message。只读 session
      // family（不 commit、不写 lastUsedAt）；当前会话可见 = 公共 doc + 本会话私有 doc
      // 合并渲染（mergeMemoryStates，总预算 ≤900 字不变）；私有层绝不注入非来源会话。
      // 没有可渲染内容时不占位。改动这里或 renderMemoryTranscript 的白名单前必读
      // src/memory.ts 的安全边界注释：记忆抽取只读结构化原始 entry，必须继续排除
      // pi.system、宿主任务文案和工具结果，否则「记忆 → 抽取 → 记忆」的自我污染闭环会复活。
      section("memory", async (input, context) => {
        const memoryKey = parts.memoryKeyOf(String(input.conversationId));
        if (!memoryKey) return undefined;
        const chatKey = parts.chatKeyOf(String(input.conversationId));
        const [pub, priv] = await Promise.all([
          input.read.snapshot(MemoryDoc, memoryKey, context),
          chatKey === undefined
            ? Promise.resolve(undefined)
            : input.read.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(memoryKey, chatKey), context),
        ]);
        if (!pub && !priv) return undefined;
        return renderMemorySection(mergeMemoryStates(pub, priv), peekScope(String(input.conversationId)), parts.prompts.messages);
      }, { tag: true }),
    ],
  });
}


/** runtime.md 里 next 专属小节的段首前缀（T1 契约：稳定段首，动态裁剪的定位锚）。 */
const ENGAGE_RUNTIME_PREFIX = "自由交流窗口：";

/**
 * runtime 的模型可见动态裁剪（决策 18）：engagement≠next 时把「自由交流窗口」整段
 * 裁掉——那是 next 的窗口协议，legacy 下看到只会误导。按段首前缀定位、按空行分段
 * 裁剪，不引入新文案；找不到该段（prompt 被改坏）时原样返回，缺省（未接回调）= legacy。
 */
export function runtimeTextOf(base: string, engagement: EngagementMode): string {
  if (engagement === "next") return base;
  const lines = base.split("\n");
  const start = lines.findIndex((line) => line.startsWith(ENGAGE_RUNTIME_PREFIX));
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
