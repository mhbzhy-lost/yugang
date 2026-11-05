/**
 * config —— 统一配置工具：fish.config.json 受控字段 + config/models.json 角色表（仅主人私聊）。
 *
 * 两份受控配置、一个入口：
 *   ① fish.config.json 受控字段（白名单制）：校验规格与 parseFile 同源（../../fish-config.ts 的
 *      FISH_CONFIG_FIELDS），逐字段标注热加载 / 需重启，非法或越界的值直接拒绝、不落盘；
 *   ② config/models.json 的 models 角色表（main / vision / image）：写盘后由运维流程 restart 生效，
 *      main / vision 必须能在所选 provider 清单里查到，image 是图片透传通道不校验模型名；
 *   ③ 读现状：read / models_list 一次看清两份配置的当前生效值（含逐字段生效时机）。
 *
 * 身份闸是双重的（二者缺一即以 tool 错误拒绝，群内轮一律拒绝）：
 *   1. 触发者 = 主人：与 fs / restart 同源，机械判 triggerOf 的 userId（../fs-shared.ts）；
 *   2. 会话 = 主人私聊：chatKeyOf（FishOptions → packageDeps 接线）解析当前会话的原始 chatKey，
 *      必须等于 qq:private:<master>。chatKeyOf 缺失时无法机械判定，同样拒绝（fail closed）。
 * 无 MASTER_QQ 配置时 factory 返回 undefined，由注册方跳过（不进工具面）。
 * 全部操作打审计日志（一行一条进进程控制台，与 fs 工具组同风格）。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { loadFishConfig, FISH_CONFIG_FIELDS, type FieldCheck, type FishConfigFieldSpec } from "../../fish-config.ts";
import { getBiliClient } from "../../external/bili-client.ts";
import type { ModelsFile, ModelRole } from "../../model/config.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertTriggeredByMaster, type SnapshotApi } from "../fs-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface ConfigArgs {
  action: "read" | "set" | "models_list" | "models_switch";
  field?: string;
  value?: unknown;
  role?: "main" | "vision" | "image";
  provider?: string;
  model?: string;
}

const ROLES: readonly ModelRole[] = ["main", "vision", "image"];

/** config 工具的字段白名单：与 parseFile 同源（../../fish-config.ts 的 FISH_CONFIG_FIELDS，
 *  engage 块也在其中，终审 #7：不再另持一份字段集与校验）。 */
const CONFIG_FIELDS: readonly FishConfigFieldSpec[] = FISH_CONFIG_FIELDS;

/** 值的回执显示：字符串裸显，其余 JSON 化。 */
function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createConfigTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const p = deps.prompts;
  const fishConfigPath = join(process.cwd(), "fish.config.json");
  const modelsPath = resolve(deps.modelsPath ?? join(process.cwd(), "config", "models.json"));
  const lockedMessage = p.messages["config_locked"] ?? "config_locked";

  /** 双重身份闸：触发者 = 主人，且当前会话 = 主人私聊；群内轮与无法判定的轮一律拒绝。 */
  async function assertMasterPrivateRound(api: SnapshotApi, context: unknown): Promise<void> {
    await assertTriggeredByMaster(deps, api as never, context, lockedMessage);
    const chatKey = deps.chatKeyOf?.(String(api.conversationId));
    if (chatKey !== `qq:private:${deps.master}`) throw new Error(lockedMessage);
  }

  function effectLabel(effect: FishConfigFieldSpec["effect"]): string {
    // 文案 key 必须以字面量形式出现（test/prompts.test.ts 的 dead-copy 断言扫 messages["key"]）
    return effect === "hot"
      ? p.messages["config_effect_hot"] ?? effect
      : p.messages["config_effect_restart"] ?? effect;
  }

  function readModelsFile(): ModelsFile {
    try {
      return JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsFile;
    } catch (error) {
      throw new Error(renderTemplate(p.messages["models_bad_json"] ?? "{{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /** models 角色表现状（models_list 与 read 共用）。 */
  function modelsText(): string {
    const file = readModelsFile();
    const current = ROLES.map((role) => {
      const ref = file.models?.[role];
      return ref ? `${role}=${ref.provider}/${ref.model}` : `${role}=(未配置)`;
    }).join("; ");
    const available = Object.entries(file.providers ?? {}).map(
      ([name, provider]) => `- ${name}: ${(provider.models ?? []).map((m) => m.id).join(", ") || "(空)"}`,
    );
    return [
      `${p.messages["models_list_prefix"] ?? ""}${current}`,
      p.messages["models_list_available"] ?? "",
      ...available,
      p.messages["models_image_hint"] ?? "",
    ].filter((line) => line.length > 0).join("\n");
  }

  /** fish.config 受控字段现状（read action）：生效值 + 逐字段生效时机 + 现存告警。 */
  function fishConfigText(): string {
    const { config, source, problems } = loadFishConfig({ path: fishConfigPath });
    const lines = [
      `${p.messages["config_read_config_header"] ?? ""}（${source}）`,
      ...CONFIG_FIELDS.map((spec) => {
        const value = (config as Record<string, unknown>)[spec.name];
        return `- ${spec.name} = ${show(value)}（${effectLabel(spec.effect)}）`;
      }),
    ];
    if (problems.length > 0) {
      lines.push(renderTemplate(p.messages["config_read_problems"] ?? "{{problems}}", { problems: problems.join("；") }));
    }
    return lines.join("\n");
  }

  /** set：白名单校验（返回 FieldCheck）→ 安全域硬闸 → 整文件读改 → 原子写盘；读写失败直接抛回执文案。不存在的文件按空对象起底。 */
  function writeFishConfigField(spec: FishConfigFieldSpec, raw: unknown): FieldCheck {
    const result = spec.check(raw);
    if (!result.ok) return result;
    // 安全域硬闸（终验 #1/P0 修复）：engage.groups 只能与 .env GROUPS 的交集生效。
    // 含域外群号的整次设置直接以 tool error 拒绝（不部分写入）——先扩 GROUPS 再设置；
    // 状态机与 gate 侧另有交集机械兑底（src/index.ts 的 engageGroupsSafe）。
    if (spec.name === "engage") {
      const groups = (result.value as { groups?: unknown }).groups;
      const allowed = new Set((process.env.GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      const outside = (Array.isArray(groups) ? groups : []).map(String).filter((g) => !allowed.has(g));
      if (outside.length > 0) {
        throw new Error(`engage.groups 含 GROUPS 域外群号（${outside.join("、")}），先扩 GROUPS 再设置`);
      }
    }
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(fishConfigPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      // 文件不存在按空对象起底（首次 set 建档）；解析失败则拒绝写——不覆盖坏文件
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") current = {};
      else {
        throw new Error(renderTemplate(p.messages["config_read_failed"] ?? "{{error}}", {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    current[spec.name] = result.value;
    try {
      const tmp = `${fishConfigPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
      renameSync(tmp, fishConfigPath);
    } catch (error) {
      throw new Error(renderTemplate(p.messages["config_write_failed"] ?? "{{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    console.log(`[鱼缸] config set fish.config.json ${spec.name}=${show(result.value)} (${spec.effect})`);
    // ammo.dailyBudget 配置变更即灌入共享 bili 客户端（终验 #8）：热配置真正生效，
    // 不等下一次 scheduler tick；宿主侧启动/读路径的灌入在 src/index.ts（syncBiliBudget）
    if (spec.name === "ammo" && result.ok) {
      const budget = (result.value as { dailyBudget?: unknown }).dailyBudget;
      if (typeof budget === "number") getBiliClient().setDailyBudget(budget);
    }
    // 部分字段非法已回默认的（engage 块逐字段校验）：告警进审计日志与 set 回执（终审 #5/#7）
    for (const problem of result.problems ?? []) console.warn(`[鱼缸] 配置 ${problem}`);
    return result;
  }

  /** models 角色表写回：main / vision 必须能在所选 provider 清单里查到，image 是透传通道不校验；tmp + rename 原子写。 */
  function writeModelRole(role: ModelRole, provider: string, model: string): void {
    const file = readModelsFile();
    const entry = file.providers?.[provider];
    if (!entry) {
      throw new Error(renderTemplate(p.messages["models_unknown_provider"] ?? "{{providers}}", {
        provider,
        providers: Object.keys(file.providers ?? {}).join(", "),
      }));
    }
    // image 是图片透传通道，模型名不在 chat 清单里；main / vision 必须能在 provider 里查到
    if (role !== "image" && !(entry.models ?? []).some((m) => m.id === model)) {
      throw new Error(renderTemplate(p.messages["models_unknown_model"] ?? "{{models}}", {
        provider,
        model,
        models: (entry.models ?? []).map((m) => m.id).join(", ") || "(空)",
      }));
    }
    file.models = file.models ?? {};
    file.models[role] = { provider, model };
    try {
      const tmp = `${modelsPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
      renameSync(tmp, modelsPath);
    } catch (error) {
      throw new Error(renderTemplate(p.messages["models_write_failed"] ?? "{{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    console.log(`[鱼缸] config models ${role} -> ${provider}/${model}`);
  }

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<ConfigArgs>(manifest),
    execute: async (args, api, context) => {
      // 双重身份闸：主人触发 + 主人私聊会话（群内轮 tool error 拒绝）
      await assertMasterPrivateRound(api as never, context);

      if (args.action === "read") {
        console.log("[鱼缸] config read");
        return { output: [{ type: "text", text: `${fishConfigText()}\n\n${p.messages["config_read_models_header"] ?? ""}\n${modelsText()}` }] };
      }

      if (args.action === "models_list") {
        console.log("[鱼缸] config models_list");
        return { output: [{ type: "text", text: modelsText() }] };
      }

      if (args.action === "models_switch") {
        const role = args.role;
        const provider = args.provider?.trim();
        const model = args.model?.trim();
        if (!role || !provider || !model) throw new Error(p.messages["models_switch_missing"] ?? "models_switch_missing");
        if (!ROLES.includes(role)) throw new Error(p.messages["models_bad_role"] ?? "models_bad_role");
        writeModelRole(role, provider, model);
        return {
          output: [{
            type: "text",
            text: renderTemplate(p.messages["models_switch_done"] ?? "{{role}}", { role, provider, model }),
          }],
        };
      }

      // set：白名单外的字段与不合法的值都以 tool 错误拒绝，不落盘
      const field = args.field?.trim() ?? "";
      const spec = CONFIG_FIELDS.find((candidate) => candidate.name === field);
      if (!spec) throw new Error(renderTemplate(p.messages["config_unknown_field"] ?? "{{field}}", { field }));
      const result = writeFishConfigField(spec, args.value);
      if (!result.ok) throw new Error(renderTemplate(p.messages["config_bad_value"] ?? "{{reason}}", { field, reason: result.reason }));
      const lines = [renderTemplate(p.messages["config_set_done"] ?? "{{field}}", {
        field: spec.name,
        value: show(result.value),
        effect: effectLabel(spec.effect),
      })];
      // 部分字段非法已回默认：逐字段告警附在回执里（终审 #5，复用 read 的告警模板）
      if (result.problems?.length) {
        lines.push(renderTemplate(p.messages["config_read_problems"] ?? "{{problems}}", { problems: result.problems.join("；") }));
      }
      // news.targetGroup 域约束提示（外部计划 E8 接口位）：这里只做格式校验，
      // GROUPS 白名单域校验在运行时消费处（E7 播报编排）执行
      const targetGroup = spec.name === "news" ? (result.value as { targetGroup?: unknown } | undefined)?.targetGroup : undefined;
      if (typeof targetGroup === "string" && targetGroup !== "") {
        lines.push(renderTemplate(p.messages["config_news_targetgroup_domain"] ?? "{{group}}", { group: targetGroup }));
      }
      if (spec.effect === "restart") lines.push(p.messages["config_restart_reminder"] ?? "");
      return { output: [{ type: "text", text: lines.filter((line) => line.length > 0).join("\n") }] };
    },
  });
}
