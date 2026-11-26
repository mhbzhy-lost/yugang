/**
 * draw_remote —— 统一远程生图（gpt / wan / qwen / gemini 四通道），出图经 outbox 机械直发。
 *
 * 与 draw（本地 SD）、qwen_draw（本地 Qwen）、wan_gif（动图）并列：这里只管「走远程接口把静态图画出来」。
 * 通道与模型不由模型选：每次执行现读 fish.config.json 的 drawRemote（热加载），入口与提交前各复核一次总开关。
 *
 * 状态机（按会话：{ round, pending, submitted, used }）与 draw 同规矩，外加一条——适配器用
 * DrawRemoteError.submitted 精确说明「生成请求发出去没有」，这里据此决定本轮锁不锁：
 *   submitted=false（没提交，或上游 400 / 403 / 429 这类确定性拒绝）→ 不锁轮，改参数 / 切通道后同轮可重试；
 *   submitted=true（5xx / 超时 / POST 之后断网或取消，结果不明）→ 锁轮，同轮重试报 draw_remote_uncertain。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { extname, resolve, sep } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { DRAW_REMOTE_DEFAULTS, type DrawRemoteConfig, type DrawRemoteProvider } from "../../fish-config.ts";
import { MODELS_CONFIG_PATH } from "../../paths.ts";
import {
  DrawRemoteError,
  isAbortError,
  MAX_REFERENCE_IMAGES_BY_PROVIDER,
  runDrawRemote,
  type DrawRemoteAspectRatio,
  type DrawRemoteBackground,
  type DrawRemoteReferenceImage,
} from "../../media/draw-remote/index.ts";
import { readBoundedFile, sniffImageMagic } from "../../media/image-ops.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import { enqueueOutbound, type OutboundPayload } from "../say-shared.ts";
import { fenceReadablePath } from "../fs-shared.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface DrawRemoteArgs {
  prompt: string;
  images?: string[];
  aspect_ratio?: DrawRemoteAspectRatio;
  background?: DrawRemoteBackground;
}

type RoundState = { round: unknown; pending: boolean; submitted: boolean; used: boolean };
const rounds = new Map<string, RoundState>();

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

export function createDrawRemoteTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = resolve(deps.mediaRoot);
  /** 热读当前配置：宿主注入的现读函数优先；没注入（离线 / 测试装配）按冻结的默认值，缺凭据留到执行期由适配器报。 */
  const configOf = (): DrawRemoteConfig => deps.drawRemote?.() ?? DRAW_REMOTE_DEFAULTS;
  const messages = deps.prompts.messages;
  /**
   * 本工具的回执文案：逐 key 字面取（prompt 审查的死文案扫描只认 messages["…"] 这种写法），
   * 缺 key 退化成 key 名——与其它工具 `messages["x"] ?? "x"` 的容错一致。
   */
  const templates = {
    disabled: messages["draw_remote_disabled"] ?? "draw_remote_disabled",
    round_missing: messages["draw_remote_round_missing"] ?? "draw_remote_round_missing",
    inflight: messages["draw_remote_inflight"] ?? "draw_remote_inflight",
    used: messages["draw_remote_used"] ?? "draw_remote_used",
    uncertain: messages["draw_remote_uncertain"] ?? "draw_remote_uncertain",
    prompt: messages["draw_remote_prompt"] ?? "draw_remote_prompt",
    bad_ref: messages["draw_remote_bad_ref"] ?? "draw_remote_bad_ref",
    no_transparent: messages["draw_remote_no_transparent"] ?? "draw_remote_no_transparent",
    unconfigured: messages["draw_remote_unconfigured"] ?? "draw_remote_unconfigured",
    done: messages["draw_remote_done"] ?? "draw_remote_done",
    done_fallback: messages["draw_remote_done_fallback"] ?? "draw_remote_done_fallback",
    failed: messages["draw_remote_failed"] ?? "draw_remote_failed",
    failed_uncertain: messages["draw_remote_failed_uncertain"] ?? "draw_remote_failed_uncertain",
    failed_internal: messages["draw_remote_failed_internal"] ?? "draw_remote_failed_internal",
  };
  const say = (key: keyof typeof templates, vars: Record<string, string> = {}): string => renderTemplate(templates[key], vars);
  const badRef = (ref: string): Error => new Error(say("bad_ref", { ref }));

  /**
   * 参考图安全围栏（全部在 onSubmitted 之前，任何一张不过整批拒）：路径只在媒体目录内、
   * 不跟随符号链接、按真实字节魔数定类型且与后缀一致、通道认这个类型、单张与聚合体积、张数。
   * 返回的 bytes 是原始文件内容，只在内存里过一遍直接交给适配器。
   */
  const prepareReferences = (provider: DrawRemoteProvider, rawImages: readonly string[]): DrawRemoteReferenceImage[] => {
    // 兼容模型把编号标签原样抄过来：[inbound/xxx.jpg]
    const refs = rawImages.map((raw) => (typeof raw === "string" ? raw.trim().replace(/^\[|\]$/g, "") : ""));
    const maxImages = MAX_REFERENCE_IMAGES_BY_PROVIDER[provider];
    // 超限点名第一张多余的：回执里的张数上限按通道如实写
    if (refs.length > maxImages) throw badRef(refs[maxImages] ?? "");
    const accepted = REFERENCE_MIME[provider];
    const totalLimit = TOTAL_REFERENCE_BYTES[provider];
    const images: DrawRemoteReferenceImage[] = [];
    let total = 0;
    for (const ref of refs) {
      const full = resolve(root, ref);
      // 词法越界（../、绝对路径、根本不在媒体目录下）与符号链接（最终分量是链接 / realpath 越界 / 不存在）一律 fail-closed
      const fence = ref && (full !== root && full.startsWith(root + sep)) ? fenceReadablePath(root, full) : undefined;
      if (!fence?.ok) throw badRef(ref);
      // 有界读取：超限 / 非普通文件直接 null，不先把大文件读进内存
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
      // 入口总闸（fish.config.json 的 drawRemote.enabled，热加载）：关闭时在 snapshot / 轮状态 / onLongWork /
      // 任何校验之前就走，不占位 rounds
      if (configOf().enabled === false) throw new Error(say("disabled"));
      const live = (await api.snapshot(LiveDoc, api.conversationId, context)) as { run?: { inputs?: unknown[] } } | undefined;
      const round = live?.run?.inputs?.[0];
      if (round === undefined) throw new Error(say("round_missing"));
      const previous = rounds.get(api.conversationId);
      if (previous?.pending) throw new Error(say("inflight"));
      if (previous?.round === round && previous.used) throw new Error(say("used"));
      if (previous?.round === round && previous.submitted) throw new Error(say("uncertain"));

      // 轮状态查完再读一次配置：通道、模型与参考图预检都以这一刻的现值为准（snapshot 期间主人可能已切换）
      const config = configOf();
      if (config.enabled === false) throw new Error(say("disabled"));
      const provider = config.provider;
      const model = config.models[provider] || DRAW_REMOTE_DEFAULTS.models[provider];
      // prompt 的空 / 超长（4000 字）由适配器统一预检并给出具体原因，这里只规整
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      const images = prepareReferences(provider, args.images ?? []);
      context.abortSignal?.throwIfAborted();

      const state: RoundState = { round, pending: true, submitted: false, used: false };
      rounds.set(api.conversationId, state);
      const started = Date.now();
      const run = deps.drawRemoteRun ?? runDrawRemote;
      try {
        const result = await run({
          provider,
          model,
          prompt,
          ...(images.length > 0 ? { images } : {}),
          ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}),
          ...(args.background !== undefined ? { background: args.background } : {}),
          mediaRoot: deps.mediaRoot,
          // 每次调用现读 models.json（及同目录的 auth.json）：主人改配置、换凭据零重启生效
          modelsPath: deps.modelsPath ?? MODELS_CONFIG_PATH,
          onSubmitted: () => {
            // 提交前二次复核：适配器读完 models.json / auth.json、做完前置刷新、即将 POST 的那一刻再读一次热值。
            // 关闭就在这里抛出阻止 POST，submitted 保持 false（重新打开后同轮可重试）
            if (configOf().enabled === false) {
              throw new DrawRemoteError(provider, "disabled", "draw_remote 已被热关闭（drawRemote.enabled=false），请求未发出", false);
            }
            state.submitted = true;
            deps.onLongWork?.("draw_remote", round);
          },
          signal: context.abortSignal,
        });
        // 出图后、入队前的取消闸：超时晚到的图不再入 outbox；submitted 保持 true（请求已发出），
        // 本轮重试吃 draw_remote_uncertain，不重 POST
        context.abortSignal?.throwIfAborted();
        const files = result.files.filter((file) => typeof file === "string" && file.length > 0);
        if (files.length === 0) throw new Error("draw_remote_empty");
        state.used = true;
        // 机械发图（主人裁定 2026-11-13）：出图即经 outbox 直发，不再让模型调 say_media。
        // 走 enqueueOutbound（同提交写 fish.outbound transcript + outbox，压缩 / 记忆看得到）；
        // 不占开口额度、不经模型文本校验（gen/ 路径宿主生成、可信）。
        const trigger = deps.triggerOf?.(round);
        const ref = (file: string): string => `gen/${file}`;
        const sent: string[] = [];
        try {
          for (const file of files) {
            // 多图逐张复核：前一张入队排队期间被取消，后一张不再入队
            context.abortSignal?.throwIfAborted();
            const payload: OutboundPayload = {
              items: [],
              media: ref(file),
              quote: false,
              ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
              ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
              at: Date.now(),
              key: `${api.conversationId}:draw_remote:${String(round)}:${file}`,
            };
            await enqueueOutbound(api, payload, context);
            sent.push(file);
          }
          console.log(
            `[fish] draw_remote ok: ${provider} ${model} / ${files.length} 张 / ${Date.now() - started}ms / 参考图${images.length}张`,
          );
          return { output: [{ type: "text", text: say("done", { provider, file: files.map(ref).join("、") }) }] };
        } catch (error) {
          // 取消不是「入队失败」：不回退成补发提示，原样上抛（晚到的结果已被超时看门狗丢弃）
          context.abortSignal?.throwIfAborted();
          // 入队失败回退提示模型手动 say_media 补发，图不丢；只点名没发出去的那几张
          const unsent = files.filter((file) => !sent.includes(file));
          console.error("[fish] draw_remote auto-send failed", error instanceof Error ? error.message : error);
          return { output: [{ type: "text", text: say("done_fallback", { provider, file: unsent.map(ref).join("、") }) }] };
        }
      } catch (error) {
        if (error instanceof DrawRemoteError) {
          // 精准维护锁：确定性拒绝（含 POST 之后被 4xx 拒）把钩子置上的 submitted 复位，本轮不锁死；
          // 结果不明保持 true。回执原因用适配器已脱敏、已清洗的原文
          state.submitted = error.submitted;
          const detail = error.message;
          console.error(`[fish] draw_remote failed(${error.code}${error.submitted ? ", submitted" : ""}): ${detail}`);
          switch (error.code) {
            case "disabled":
              throw new Error(say("disabled"));
            case "unconfigured":
              throw new Error(say("unconfigured", { reason: detail }));
            case "prompt":
              throw new Error(say("prompt", { reason: detail }));
            case "bad_ref":
              // 适配器层的张数防御（与 prepareReferences 同一张上限表，经工具调用正常走不到）：按整批张数点名
              throw badRef(`${images.length} 张`);
            case "no_transparent":
              throw new Error(say("no_transparent"));
            case "failed":
              throw new Error(say(error.submitted ? "failed_uncertain" : "failed", { reason: detail }));
          }
        }
        // 宿主取消 / 工具超时：AbortError 原样上抛，submitted 保持钩子记下的状态
        if (isAbortError(error)) throw error;
        // 其它异常：原始报错不出境；钩子触发过就按结果不明锁轮，否则本轮可重试
        console.error("[fish] draw_remote failed:", error instanceof Error ? error.message : error);
        throw new Error(
          say(state.submitted ? "failed_uncertain" : "failed", { reason: say("failed_internal") }),
        );
      } finally {
        state.pending = false;
      }
    },
  });
}
