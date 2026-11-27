/**
 * draw_remote —— 异步远程生图（gpt / wan / qwen / gemini 四通道），出图经 outbox 机械直发。
 *
 * 与 draw（本地 SD）、qwen_draw（本地 Qwen）、wan_gif（动图）并列：这里只管「把远程静态生图异步派给后台」。
 * 通道与模型不由模型选：每次执行现读 fish.config.json 的 drawRemote（热加载），入口、预检与后台真正 POST 前
 * 各复核一次总开关。
 *
 * 异步语义（2026-11-27 拍板）：
 *   - 同步阶段做完总开关 / 停机态 / 投递能力 / 群单飞 / 同轮防重 / 参考图安全围栏 / 同步预检（models.json + auth.json）后
 *     立即返回 draw_remote_accepted，释放当前群聊轮次；由模型本轮自行 say_words 告知群友（不再发 working_draw_remote）。
 *   - 每群（按 chatKeyOf 归群，缺失退回 conversationId）同时最多 1 个在途任务，不同群可并发；单轮最多提交 1 次。
 *   - 后台任务拥有独立 AbortController（叠加停机信号与 660s 整体硬超时），不绑定当前轮的 context.abortSignal；
 *     画好后通过宿主注入的 deliverDrawRemote 写入 fish.outbound + outbox 并立即冲刷；
 *     失败静默只打已脱敏日志（绝不往群里发失败提示、绝不打印未脱敏 cause），finally 释放群槽位。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { extname, resolve, sep } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { DRAW_REMOTE_DEFAULTS, type DrawRemoteConfig, type DrawRemoteProvider } from "../../fish-config.ts";
import { MODELS_CONFIG_PATH } from "../../paths.ts";
import {
  DRAW_REMOTE_JOB_TIMEOUT_MS,
  DRAW_REMOTE_TIMEOUT_MS,
  DrawRemoteError,
  errorMessage,
  MAX_REFERENCE_IMAGES_BY_PROVIDER,
  preflightDrawRemote,
  runDrawRemote,
  type DrawRemoteAspectRatio,
  type DrawRemoteReferenceImage,
  type DrawRemoteStageEvent,
} from "../../media/draw-remote/index.ts";
import { cleanUpstreamText } from "../../media/draw-remote/redact.ts";
import { readBoundedFile, sniffImageMagic } from "../../media/image-ops.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { OutboundPayload } from "../say-shared.ts";
import { fenceReadablePath } from "../fs-shared.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface DrawRemoteArgs {
  prompt: string;
  images?: string[];
  aspect_ratio?: DrawRemoteAspectRatio;
}

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
/** gemini 的参考图走 inline 载荷：原始字节合计上限（给约 20MB 的 inline 上限留余量）。 */
const TOTAL_REFERENCE_BYTES: Readonly<Partial<Record<DrawRemoteProvider, number>>> = { gemini: 15 * 1024 * 1024 };

/** 真实魔数 → MIME。bmp / tiff / heic 不收：远程通道不认，这里也不替它转码。 */
const MIME_BY_MAGIC: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** 后缀 → MIME：与魔数对不上（改过扩展名的文件）按 bad_ref 拒，不信扩展名也不只信扩展名。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/**
 * 各通道认的参考图类型（四通道都支持改图，差别只在类型与张数）。wan2.7-image 与 gemini 不收 gif；
 * 张数上限与适配器共用同一张表（MAX_REFERENCE_IMAGES_BY_PROVIDER）：这里先拦并点名第几张，那边是不经工具层时的防御。
 */
const REFERENCE_MIME: Readonly<Record<DrawRemoteProvider, readonly string[]>> = {
  gpt: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  wan: ["image/png", "image/jpeg", "image/webp"],
  qwen: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  gemini: ["image/png", "image/jpeg", "image/webp"],
};

function formatStages(stages: readonly DrawRemoteStageEvent[]): string {
  if (stages.length === 0) return "stages=none";
  return stages
    .map((ev) => {
      const parts = [`${ev.stage}=${ev.ms}ms`];
      if (ev.status !== undefined) parts.push(`http=${ev.status}`);
      if (ev.urls !== undefined) parts.push(`n=${ev.urls}`);
      if (ev.bytes !== undefined) parts.push(`bytes=${ev.bytes}`);
      return parts.join(":");
    })
    .join(" ");
}

export function createDrawRemoteTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = resolve(deps.mediaRoot);
  /** 热读当前配置：宿主注入的现读函数优先；没注入（离线 / 测试装配）按冻结的默认值，缺凭据留到预检期报。 */
  const configOf = (): DrawRemoteConfig => deps.drawRemote?.() ?? DRAW_REMOTE_DEFAULTS;
  const now = (): number => (deps.now ?? Date.now)();
  const messages = deps.prompts.messages;
  /** 实例级状态（不污染模块全局）：每群在途槽位（按 chatKeyOf 归群）+ 每会话末次受理轮。 */
  const inflight = new Map<string, AbortController>();
  const lastRound = new Map<string, unknown>();

  /**
   * 本工具的回执文案：逐 key 字面取（prompt 审查的死文案扫描只认 messages["…"] 这种写法），
   * 缺 key 退化成 key 名——与其它工具 `messages["x"] ?? "x"` 的容错一致。
   */
  const templates = {
    disabled: messages["draw_remote_disabled"] ?? "draw_remote_disabled",
    round_missing: messages["draw_remote_round_missing"] ?? "draw_remote_round_missing",
    inflight: messages["draw_remote_inflight"] ?? "draw_remote_inflight",
    used: messages["draw_remote_used"] ?? "draw_remote_used",
    prompt: messages["draw_remote_prompt"] ?? "draw_remote_prompt",
    bad_ref: messages["draw_remote_bad_ref"] ?? "draw_remote_bad_ref",
    unconfigured: messages["draw_remote_unconfigured"] ?? "draw_remote_unconfigured",
    accepted: messages["draw_remote_accepted"] ?? "draw_remote_accepted",
  };
  const say = (key: keyof typeof templates, vars: Record<string, string> = {}): string => renderTemplate(templates[key], vars);
  const badRef = (ref: string): Error => new Error(say("bad_ref", { ref }));

  /**
   * 参考图安全围栏（全部在同步受理之前，任何一张不过整批拒）：路径只在媒体目录内、
   * 不跟随符号链接、按真实字节魔数定类型且与后缀一致、通道认这个类型、单张与聚合体积、张数。
   * 返回的 bytes 是原始文件内容，只在内存里过一遍直接交给后台适配器。
   */
  const prepareReferences = (provider: DrawRemoteProvider, rawImages: readonly string[]): DrawRemoteReferenceImage[] => {
    const refs = rawImages.map((raw) => (typeof raw === "string" ? raw.trim().replace(/^\[|\]$/g, "") : ""));
    const maxImages = MAX_REFERENCE_IMAGES_BY_PROVIDER[provider];
    if (refs.length > maxImages) throw badRef(refs[maxImages] ?? "");
    const accepted = REFERENCE_MIME[provider];
    const totalLimit = TOTAL_REFERENCE_BYTES[provider];
    const images: DrawRemoteReferenceImage[] = [];
    let total = 0;
    for (const ref of refs) {
      const full = resolve(root, ref);
      const fence = ref && (full !== root && full.startsWith(root + sep)) ? fenceReadablePath(root, full) : undefined;
      if (!fence?.ok) throw badRef(ref);
      const bytes = readBoundedFile(fence.real, MAX_REFERENCE_BYTES);
      if (!bytes || bytes.length === 0) throw badRef(ref);
      const magic = sniffImageMagic(bytes.subarray(0, 16));
      const mime = magic ? MIME_BY_MAGIC[magic.ext] : undefined;
      if (!mime || mime !== MIME_BY_EXT[extname(full).toLowerCase()] || !accepted.includes(mime)) throw badRef(ref);
      total += bytes.length;
      if (totalLimit !== undefined && total > totalLimit) throw badRef(ref);
      images.push({ mimeType: mime, bytes });
    }
    return images;
  };

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<DrawRemoteArgs>(manifest),
    execute: async (args, api, context) => {
      // 入口总闸与停机态检查：关闭或停机时直接拒，不占位
      if (configOf().enabled === false) throw new Error(say("disabled"));
      if (deps.drawRemoteSignal?.aborted) throw new Error(say("disabled"));
      const deliver = deps.deliverDrawRemote;
      if (!deliver) {
        throw new Error(say("unconfigured", { reason: "宿主未装配异步出图投递回调" }));
      }

      const live = (await api.snapshot(LiveDoc, api.conversationId, context)) as { run?: { inputs?: unknown[] } } | undefined;
      const round = live?.run?.inputs?.[0];
      if (round === undefined) throw new Error(say("round_missing"));

      const convId = api.conversationId;
      const convKey = String(convId);
      const slotKey = deps.chatKeyOf?.(convKey) ?? convKey;
      if (inflight.has(slotKey)) throw new Error(say("inflight"));
      if (lastRound.get(convKey) === round) throw new Error(say("used"));

      // 轮状态查完再读一次配置：通道、模型与参考图预检都以这一刻的现值为准
      const config = configOf();
      if (config.enabled === false) throw new Error(say("disabled"));
      if (deps.drawRemoteSignal?.aborted) throw new Error(say("disabled"));
      const provider = config.provider;
      const model = config.models[provider] || DRAW_REMOTE_DEFAULTS.models[provider];
      const rawPrompt = typeof args.prompt === "string" ? args.prompt : "";
      const images = prepareReferences(provider, args.images ?? []);
      const modelsPath = deps.modelsPath ?? MODELS_CONFIG_PATH;

      // 同步预检（始终执行，不按是否注入 drawRemoteRun 分支）：校验 prompt、models.json 与 auth.json
      const preflight = deps.drawRemotePreflight ?? preflightDrawRemote;
      let cleanedPrompt: string;
      try {
        cleanedPrompt = preflight({
          provider,
          prompt: rawPrompt,
          imagesCount: images.length,
          modelsPath,
        });
      } catch (error) {
        if (error instanceof DrawRemoteError) {
          switch (error.code) {
            case "disabled":
              throw new Error(say("disabled"));
            case "unconfigured":
              throw new Error(say("unconfigured", { reason: error.message }));
            case "prompt":
              throw new Error(say("prompt", { reason: error.message }));
            case "bad_ref":
              throw badRef(`${images.length} 张`);
            case "failed":
              throw new Error(say("unconfigured", { reason: error.message }));
          }
        }
        throw error;
      }

      // 最后一刻再核对本轮取消与群并发槽位（snapshot / 预检期间无异步让出，此处作防御）
      context.abortSignal?.throwIfAborted();
      if (inflight.has(slotKey)) throw new Error(say("inflight"));

      // 快照引用锚点：工具返回后原轮会清空 triggerOf，后台必须使用此处的只读快照
      const trigger = deps.triggerOf?.(round);
      const snapshotQuoteId = trigger?.messageId;
      const snapshotQuoteForce = trigger ? trigger.mentionsBot : undefined;
      const aspectRatio = args.aspect_ratio;
      const started = now();
      const run = deps.drawRemoteRun ?? runDrawRemote;
      const jobController = new AbortController();
      let jobTimedOut = false;

      const onShutdownAbort = (): void => {
        jobController.abort(deps.drawRemoteSignal?.reason ?? new DOMException("draw_remote shutdown", "AbortError"));
      };
      deps.drawRemoteSignal?.addEventListener("abort", onShutdownAbort, { once: true });

      const jobTimeoutMs = deps.drawRemoteJobTimeoutMs ?? DRAW_REMOTE_JOB_TIMEOUT_MS;
      const jobTimer = setTimeout(() => {
        if (jobController.signal.aborted) return;
        jobTimedOut = true;
        jobController.abort(new DOMException(`draw_remote job timeout (${jobTimeoutMs}ms)`, "TimeoutError"));
      }, jobTimeoutMs);
      jobTimer.unref?.();

      inflight.set(slotKey, jobController);
      lastRound.set(convKey, round);

      // 后台独立异步执行：不碰当前轮的 api/context，不触发 onLongWork；失败静默只打已脱敏日志
      void (async () => {
        const stages: DrawRemoteStageEvent[] = [];
        let settled: { status: "ok" | "failed" | "aborted"; files?: string[]; error?: unknown } = { status: "failed" };
        try {
          const result = await run({
            provider,
            model,
            prompt: cleanedPrompt,
            ...(images.length > 0 ? { images } : {}),
            ...(aspectRatio !== undefined ? { aspectRatio } : {}),
            mediaRoot: deps.mediaRoot,
            modelsPath,
            timeoutMs: DRAW_REMOTE_TIMEOUT_MS,
            signal: jobController.signal,
            onStage: (ev) => {
              stages.push(ev);
            },
            onSubmitted: () => {
              if (configOf().enabled === false) {
                throw new DrawRemoteError(provider, "disabled", "draw_remote 已被热关闭（drawRemote.enabled=false），请求未发出", false);
              }
            },
          });

          if (jobController.signal.aborted) {
            const elapsed = now() - started;
            if (jobTimedOut) {
              console.error(
                `[fish] draw_remote background timeout: ${provider} ${model} / ${elapsed}ms / ${formatStages(stages)}`,
              );
              settled = { status: "failed" };
            } else {
              console.log(
                `[fish] draw_remote background aborted(shutdown): ${provider} ${model} / ${elapsed}ms / ${formatStages(stages)}`,
              );
              settled = { status: "aborted" };
            }
            return;
          }

          const files = result.files.filter((file) => typeof file === "string" && file.length > 0);
          if (files.length === 0) throw new Error("draw_remote_empty");

          const payloads: OutboundPayload[] = files.map((file) => ({
            items: [],
            media: `gen/${file}`,
            quote: false,
            ...(snapshotQuoteId !== undefined ? { quoteId: snapshotQuoteId } : {}),
            ...(snapshotQuoteForce !== undefined ? { quoteForce: snapshotQuoteForce } : {}),
            at: now(),
            key: `${convKey}:draw_remote:${String(round)}:${file}`,
          }));

          if (jobController.signal.aborted) {
            settled = { status: jobTimedOut ? "failed" : "aborted" };
            return;
          }

          await deliver(convId, payloads);
          if (jobController.signal.aborted) {
            const elapsed = now() - started;
            if (jobTimedOut) {
              console.error(
                `[fish] draw_remote background timeout: ${provider} ${model} / ${elapsed}ms / ${formatStages(stages)}`,
              );
              settled = { status: "failed" };
            } else {
              console.log(
                `[fish] draw_remote background aborted(shutdown): ${provider} ${model} / ${elapsed}ms / ${formatStages(stages)}`,
              );
              settled = { status: "aborted" };
            }
            return;
          }
          console.log(
            `[fish] draw_remote ok: ${provider} ${model} / ${files.length} 张 / ${now() - started}ms / 参考图${images.length}张 / ${formatStages(stages)}`,
          );
          settled = { status: "ok", files };
        } catch (error) {
          const elapsed = now() - started;
          const stageSummary = formatStages(stages);
          if (deps.drawRemoteSignal?.aborted && !jobTimedOut) {
            console.log(
              `[fish] draw_remote background aborted(shutdown): ${provider} ${model} / ${elapsed}ms / ${stageSummary}`,
            );
            settled = { status: "aborted", error };
          } else if (jobTimedOut) {
            console.error(
              `[fish] draw_remote background failed(job_timeout): ${provider} ${model} / ${elapsed}ms / ${stageSummary}`,
            );
            settled = { status: "failed", error };
          } else if (error instanceof DrawRemoteError) {
            // 只打印已脱敏的 error.message，绝不传整个 error 对象（cause 链里可能有未脱敏上游正文）
            console.error(
              `[fish] draw_remote background failed(${error.code}${error.submitted ? ", submitted" : ""}): ${provider} ${model} / ${elapsed}ms / ${stageSummary} / ${error.message}`,
            );
            settled = { status: "failed", error };
          } else {
            const safeMessage = cleanUpstreamText(errorMessage(error), []);
            console.error(
              `[fish] draw_remote background failed(internal): ${provider} ${model} / ${elapsed}ms / ${stageSummary} / ${safeMessage}`,
            );
            settled = { status: "failed", error };
          }
        } finally {
          clearTimeout(jobTimer);
          deps.drawRemoteSignal?.removeEventListener("abort", onShutdownAbort);
          if (inflight.get(slotKey) === jobController) inflight.delete(slotKey);
          try {
            deps.onDrawRemoteSettled?.({ conversationId: convKey, ...settled });
          } catch {
            // 观察回调异常不影响后台收尾
          }
        }
      })().catch(() => {});

      return { output: [{ type: "text", text: say("accepted", { provider }) }] };
    },
  });
}
