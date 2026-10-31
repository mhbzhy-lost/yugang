/**
 * model —— 查看或切换各类能力使用的模型（仅主人）。
 *
 * 只改 config/models.json 的 models 角色表（main / vision / image），不碰 provider 定义，
 * 也不在运行时替换模型：写完由运维流程调 restart 生效，避免跑到一半换 provider。
 * main / vision 的模型必须在所选 provider 的清单里，image 是图片透传通道不校验模型名。
 *
 * 身份闸与 fs / restart 同源：只有主人触发的轮里能用，群友注入文本造不出主人身份；
 * 机械校验集中走 ../fs-shared.ts。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompts.ts";
import type { ModelsFile, ModelRole } from "../../model-config.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertTriggeredByMaster } from "../fs-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface ModelArgs {
  action: "list" | "switch";
  role?: "main" | "vision" | "image";
  provider?: string;
  model?: string;
}

const ROLES: readonly ModelRole[] = ["main", "vision", "image"];

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createModelTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const p = deps.prompts;
  const modelsPath = resolve(deps.modelsPath ?? join(process.cwd(), "config", "models.json"));

  function readFile(): ModelsFile {
    try {
      return JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsFile;
    } catch (error) {
      throw new Error(renderTemplate(p.messages["model_bad_json"] ?? "{{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<ModelArgs>(manifest),
    execute: async (args, api, context) => {
      // 身份闸：机械判定，看本轮触发消息的 userId 是不是主人（与 fs / restart 同源）
      await assertTriggeredByMaster(deps, api as never, context, p.messages["fs_locked"] ?? "fs_locked");

      const file = readFile();

      if (args.action === "list") {
        const current = ROLES.map((role) => {
          const ref = file.models?.[role];
          return ref ? `${role}=${ref.provider}/${ref.model}` : `${role}=(未配置)`;
        }).join("; ");
        const available = Object.entries(file.providers ?? {}).map(
          ([name, provider]) => `- ${name}: ${(provider.models ?? []).map((m) => m.id).join(", ") || "(空)"}`,
        );
        const text = [
          `${p.messages["model_list_prefix"] ?? ""}${current}`,
          p.messages["model_list_available"] ?? "",
          ...available,
          p.messages["model_image_hint"] ?? "",
        ].filter((line) => line.length > 0).join("\n");
        return { output: [{ type: "text", text }] };
      }

      const role = args.role;
      const provider = args.provider?.trim();
      const model = args.model?.trim();
      if (!role || !provider || !model) throw new Error(p.messages["model_switch_missing"] ?? "model_switch_missing");
      if (!ROLES.includes(role)) throw new Error(p.messages["model_bad_role"] ?? "model_bad_role");

      const entry = file.providers?.[provider];
      if (!entry) {
        throw new Error(renderTemplate(p.messages["model_unknown_provider"] ?? "{{providers}}", {
          provider,
          providers: Object.keys(file.providers ?? {}).join(", "),
        }));
      }
      // image 是图片透传通道，模型名不在 chat 清单里；main / vision 必须能在 provider 里查到
      if (role !== "image" && !(entry.models ?? []).some((m) => m.id === model)) {
        throw new Error(renderTemplate(p.messages["model_unknown_model"] ?? "{{models}}", {
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
        throw new Error(renderTemplate(p.messages["model_write_failed"] ?? "{{error}}", {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      console.log(`[鱼缸] model ${role} -> ${provider}/${model}`);
      return {
        output: [{
          type: "text",
          text: renderTemplate(p.messages["model_switch_done"] ?? "{{role}}", { role, provider, model }),
        }],
      };
    },
  });
}
