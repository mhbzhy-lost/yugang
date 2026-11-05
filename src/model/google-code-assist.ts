/**
 * Google Code Assist API（google-code-assist）：订阅制 Gemini 通道的 pi-ai 适配器。
 *
 * 走的是 cloudcode-pa.googleapis.com 的 v1internal 内部接口（Gemini CLI / Code Assist
 * 同款），不是公开的 generativelanguage API，差异集中在三处：
 *   1) 不用 @google/genai SDK：自己 fetch `POST {base}/v1internal:streamGenerateContent?alt=sse`，
 *      Authorization Bearer，SSE 用手写行缓冲解析（data 行累积、空行 flush 成一个 JSON 事件）
 *   2) 请求体是信封包裹：{ model, project?, request: { contents, systemInstruction, tools,
 *      toolConfig, generationConfig } }，其中 tools 用 legacy `parameters`（OpenAPI 3.03），
 *      pi-ai 的 convertTools(tools, true) 正好输出这个形状
 *   3) 响应也是信封：每个 SSE 事件是 { response: { candidates, usageMetadata } }，
 *      先解包 .response 再走与 google-generative-ai 适配器逐事件一致的归一化
 *
 * 两个 flavor（gemini / antigravity）共用这同一套协议实现，差异全部集中在四处常量：
 *   - baseUrl：antigravity 主用 daily-cloudcode-pa.sandbox.googleapis.com（配置可覆盖）
 *   - 必需请求头：antigravity 后端按 user-agent / x-goog-api-client / client-metadata 识别
 *     客户端，缺了会 403 license；流式另加 accept: text/event-stream
 *   - 请求信封：antigravity 多两个字段 body.userAgent="antigravity" 与 requestId（每次
 *     HTTP 请求新生成，重试也换新）
 *   - 项目发现的 metadata：antigravity 用 ideType ANTIGRAVITY
 * 其余（SSE 解析、信封解包、事件归一化）完全共用。
 *
 * 其余事件流（text/thinking 块切换、thoughtSignature 保留、functionCall id 生成、
 * usageMetadata 换算、calculateCost）逐段对照镜像
 * node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js。
 *
 * project 字段来自凭据里的 projectId：src/auth/google.ts 的 toAuth 把它放进私有头
 * x-yugang-ca-project，本适配器在出站前把头摘掉、转进信封；Google 后端对未知头敏感，
 * 出站只留 Content-Type 与 Authorization（antigravity flavor 另加它识别客户端的那三个头）。
 */
import { calculateCost, clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import {
  convertMessages,
  convertTools,
  getDisabledGoogleThinkingConfig,
  isThinkingPart,
  mapStopReasonString,
  resolveGoogleFunctionCallingMode,
  resolveGoogleThinkingLevel,
  retainThoughtSignature,
  supportsGoogleStrictToolSampling,
  toGoogleSdkThinkingLevel,
  toGoogleThinkingLevel,
  usesGoogleThinkingLevel,
  type GoogleApiThinkingLevel,
} from "@earendil-works/pi-ai/api/google-shared";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { headersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";

const DEFAULT_BASE_URL = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const PROJECT_HEADER = "x-yugang-ca-project";
const DEFAULT_MAX_RETRIES = 3;

/** 两个订阅通道共用本适配器，差异全部是常量级的（见文件头注释）。 */
export type CodeAssistFlavor = "gemini" | "antigravity";

function defaultBaseUrl(flavor: CodeAssistFlavor): string {
  return flavor === "antigravity" ? ANTIGRAVITY_BASE_URL : DEFAULT_BASE_URL;
}

/** antigravity 后端按这些头识别客户端，缺了会 403 license（实测值，勿改）。 */
const ANTIGRAVITY_CLIENT_METADATA = '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

function requestHeaders(flavor: CodeAssistFlavor, apiKey: string, streaming: boolean): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  if (flavor === "antigravity") {
    headers["user-agent"] = "antigravity/1.11.5 macos/arm64";
    headers["x-goog-api-client"] = "google-cloud-sdk vscode_cloudshelleditor/0.1";
    headers["client-metadata"] = ANTIGRAVITY_CLIENT_METADATA;
    if (streaming) headers["accept"] = "text/event-stream";
  }
  return headers;
}

/** antigravity 的信封每次 HTTP 请求都带新的 requestId（重试也换新）；userAgent 在 buildParams 里拼。 */
function encodeBody(params: Record<string, unknown>, flavor: CodeAssistFlavor): Record<string, unknown> {
  return flavor === "antigravity" ? { ...params, requestId: crypto.randomUUID() } : params;
}

type CodeAssistModel = Model<"google-code-assist">;
type GoogleModel = Model<"google-generative-ai">;

export interface GoogleCodeAssistOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleApiThinkingLevel;
  };
  /** 订阅通道：gemini（默认，gemini-cli）或 antigravity（AI Pro 现通道）。 */
  flavor?: CodeAssistFlavor;
}

// toolCallCounter：functionCall 没带 id 时生成唯一 id（对照 google 适配器的同名计数器）
let toolCallCounter = 0;

interface SseChunk {
  responseId?: string;
  candidates?: {
    content?: { parts?: SsePart[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface SsePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
}

/** SSE 行缓冲解析：data 行累积、空行 flush；TextDecoder stream:true 处理跨 chunk 的多字节。 */
async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let dataLines: string[] = [];
  const feed = function* (line: string): Generator<string> {
    if (line === "") {
      if (dataLines.length > 0) {
        yield dataLines.join("\n");
        dataLines = [];
      }
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // 其它行（event:/id:/注释）按 gemini-cli server.ts 的解析一样忽略
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield* feed(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  yield* feed(buffer.replace(/\r$/, ""));
  yield* feed("");
}

/** 从 options.headers 摘走 x-yugang-ca-project（值进信封 project 字段）；该头不转发出站。 */
function takeProjectHeader(headers: Record<string, string | null> | undefined): string | undefined {
  let project: string | undefined;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === PROJECT_HEADER && typeof value === "string" && value.length > 0) project = value;
  }
  return project;
}

/** 图格式类 400 判定：状态 400 且错误体提到 image/inline/media（toResponseError 会把响应体并进 message）。 */
function isImageFormat400(error: unknown): boolean {
  const err = error as { status?: number; message?: string } | null;
  return err?.status === 400 && /image|inline|media/i.test(err.message ?? "");
}

/** 信封里是否带 inlineData（剥图降级只对真的带图的请求有意义）。 */
function hasInlineData(params: unknown): boolean {
  const request = (params as { request?: { contents?: { parts?: unknown[] }[] } })?.request;
  return (request?.contents ?? []).some((content) => (content?.parts ?? []).some((part) => part && typeof part === "object" && "inlineData" in part));
}

/** 克隆信封并移除全部 inlineData part；只剩图的 content 整条丢掉，其余原样保留。 */
function stripInlineData<T extends { request?: { contents?: { parts?: unknown[] }[] } }>(params: T): T {
  const contents = (params.request?.contents ?? [])
    .map((content) => ({ ...content, parts: (content?.parts ?? []).filter((part) => !(part && typeof part === "object" && "inlineData" in part)) }))
    .filter((content) => (content?.parts?.length ?? 0) > 0);
  return { ...params, request: { ...params.request, contents } };
}

/** 把错误包成 retryProviderRequest 认识的形状（Error + status + headers），429/5xx 才会被重试。 */
async function toResponseError(provider: string, response: Response): Promise<Error & { status: number; headers: Headers }> {
  const text = await response.text().catch(() => "");
  const error = new Error(`${provider} 请求失败 (${response.status})${text ? `: ${text.slice(0, 400)}` : ""}`) as Error & {
    status: number;
    headers: Headers;
  };
  error.status = response.status;
  error.headers = response.headers;
  return error;
}

function buildParams(
  model: CodeAssistModel,
  context: TranscriptContext,
  options: GoogleCodeAssistOptions = {},
  project?: string,
  flavor: CodeAssistFlavor = "gemini",
) {
  const contents = convertMessages(model as unknown as GoogleModel, context);
  const initialSystemMessage = getInitialSystemMessage(context.messages);
  const currentTools = getCurrentTools(context.messages);
  const generationConfig: Record<string, unknown> = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;

  const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
  const functionCallingMode = currentTools.length > 0
    ? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
    : undefined;
  const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";

  const request: Record<string, unknown> = {
    contents,
    ...(systemInstruction && { systemInstruction: { parts: [{ text: sanitizeSurrogates(systemInstruction) }] } }),
    ...(currentTools.length > 0 && {
      // Code Assist 要求 legacy parameters（OpenAPI 3.03），不用 parametersJsonSchema
      tools: convertTools(currentTools, true, supportsStrictMode),
    }),
    ...(functionCallingMode !== undefined && {
      toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
    }),
  };

  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
    if (options.thinking.level !== undefined) thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
    else if (options.thinking.budgetTokens !== undefined) thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    generationConfig.thinkingConfig = thinkingConfig;
  } else if (model.reasoning && options.thinking && !options.thinking.enabled) {
    generationConfig.thinkingConfig = getDisabledGoogleThinkingConfig(model as unknown as GoogleModel);
  }

  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

  return {
    model: model.id,
    ...(project ? { project } : {}),
    request,
    // antigravity 的信封多 userAgent 字段（requestId 在 encodeBody 里每次请求新生成）
    ...(flavor === "antigravity" ? { userAgent: "antigravity" } : {}),
  };
}

export const stream = (model: CodeAssistModel, context: TranscriptContext, options?: GoogleCodeAssistOptions) => {
  const stream = new AssistantMessageEventStream();
  const normalizedContext = collapseSystemMessages(context);
  const flavor = options?.flavor ?? "gemini";
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: flavor === "antigravity" ? "antigravity-code-assist" : "google-code-assist",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    } as AssistantMessage;

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      if (options?.signal?.aborted) throw new Error("Request aborted");
      const project = takeProjectHeader(options?.headers);
      let params = buildParams(model, normalizedContext, options, project, flavor);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams;
      }
      const url = `${(model.baseUrl || defaultBaseUrl(flavor)).replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`;
      const attemptOnce = () => retryProviderRequest(
        async () => {
          const attempt = await (options?.fetch ?? globalThis.fetch)(url, {
            method: "POST",
            // gemini：出站只留这两个头（含 x-yugang-ca-project 在内的其余头都不转发）；
            // antigravity：另加它识别客户端的那三个头与流式 accept
            headers: requestHeaders(flavor, apiKey, true),
            body: JSON.stringify(encodeBody(params, flavor)),
            ...(options?.signal ? { signal: options.signal } : {}),
          });
          await options?.onResponse?.({ status: attempt.status, headers: headersToRecord(attempt.headers) }, model);
          if (!attempt.ok) throw await toResponseError(model.provider, attempt);
          if (!attempt.body) throw new Error("Google Code Assist response has no body");
          return attempt;
        },
        {
          maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
          maxRetryDelayMs: options?.maxRetryDelayMs,
          signal: options?.signal,
        },
      );
      let response: Awaited<ReturnType<typeof attemptOnce>>;
      try {
        response = await attemptOnce();
      } catch (error) {
        // inline 附图降级：图格式类 400（错误体提及 image/inline/media）时剥掉全部
        // inlineData 重试一次；403/429/5xx 走原有路径不变。剥图后文字仍在，不让整轮哑掉
        if (isImageFormat400(error) && hasInlineData(params)) {
          console.warn(`[fish] ${model.provider} inline image rejected, retry without images`);
          params = stripInlineData(params);
          response = await attemptOnce();
        } else {
          throw error;
        }
      }

      stream.push({ type: "start", partial: output });
      let currentBlock: null | { type: "text"; text: string; textSignature?: string } | { type: "thinking"; thinking: string; thinkingSignature?: string } = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;
      for await (const eventData of readSseEvents(response.body)) {
        if (!eventData) continue;
        const parsed = JSON.parse(eventData) as { response?: SseChunk } & SseChunk;
        await options?.onProviderStreamEvent?.(parsed, model);
        const chunk = parsed.response ?? parsed;
        output.responseId ||= chunk.responseId;
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined) {
              const isThinking = isThinkingPart(part);
              if (!currentBlock ||
                (isThinking && currentBlock.type !== "thinking") ||
                (!isThinking && currentBlock.type !== "text")) {
                if (currentBlock) {
                  if (currentBlock.type === "text") {
                    stream.push({
                      type: "text_end",
                      contentIndex: blocks.length - 1,
                      content: currentBlock.text,
                      partial: output,
                    });
                  } else {
                    stream.push({
                      type: "thinking_end",
                      contentIndex: blockIndex(),
                      content: currentBlock.thinking,
                      partial: output,
                    });
                  }
                }
                if (isThinking) {
                  currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
                  output.content.push(currentBlock);
                  stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
                } else {
                  currentBlock = { type: "text", text: "" };
                  output.content.push(currentBlock);
                  stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
                }
              }
              if (currentBlock.type === "thinking") {
                currentBlock.thinking += part.text;
                currentBlock.thinkingSignature = retainThoughtSignature(currentBlock.thinkingSignature, part.thoughtSignature);
                stream.push({
                  type: "thinking_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              } else {
                currentBlock.text += part.text;
                currentBlock.textSignature = retainThoughtSignature(currentBlock.textSignature, part.thoughtSignature);
                stream.push({
                  type: "text_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              }
            }
            if (part.functionCall) {
              if (currentBlock) {
                if (currentBlock.type === "text") {
                  stream.push({
                    type: "text_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.text,
                    partial: output,
                  });
                } else {
                  stream.push({
                    type: "thinking_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.thinking,
                    partial: output,
                  });
                }
                currentBlock = null;
              }
              // 没带 id（或撞了已有 id）时生成唯一 id，对照 google 适配器
              const providedId = part.functionCall.id;
              const needsNewId = !providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
              const toolCallId = needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId;
              const toolCall = {
                type: "toolCall",
                id: toolCallId,
                name: part.functionCall.name || "",
                arguments: part.functionCall.args ?? {},
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
              };
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
              stream.push({
                type: "toolcall_delta",
                contentIndex: blockIndex(),
                delta: JSON.stringify(toolCall.arguments),
                partial: output,
              });
              stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
            }
          }
        }
        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason;
          output.stopReason = mapStopReasonString(candidate.finishReason);
          if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
            output.stopReason = "toolUse";
          }
        }
        if (chunk.usageMetadata) {
          output.usage = {
            input: (chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
            output: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
            cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
            cacheWrite: 0,
            reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
            totalTokens: chunk.usageMetadata.totalTokenCount || 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          };
          calculateCost(model, output.usage);
        }
      }
      if (currentBlock) {
        if (currentBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output,
          });
        } else {
          stream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output,
          });
        }
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("Google stream ended without a finish reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        const errorMessage = output.rawStopReason
          ? `Provider stopped with: ${output.rawStopReason}`
          : "An unknown error occurred";
        throw new Error(errorMessage);
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        if ("index" in block) {
          delete block.index;
        }
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatProviderError(normalizeProviderError(error));
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};

export const streamSimple = (
  model: CodeAssistModel,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  flavor: CodeAssistFlavor = "gemini",
) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = {
    ...buildBaseOptions(model, context, options, apiKey),
    toolChoice: options?.toolChoice,
    flavor,
  };
  if (!options?.reasoning) {
    return stream(model, context, { ...base, thinking: { enabled: false } });
  }
  const clampedReasoning = clampThinkingLevel(model, options.reasoning);
  if (clampedReasoning === "off") {
    return stream(model, context, { ...base, thinking: { enabled: false } });
  }
  const resolvedLevel = resolveGoogleThinkingLevel(model as unknown as GoogleModel, clampedReasoning);
  if (usesGoogleThinkingLevel(model as unknown as GoogleModel)) {
    return stream(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: toGoogleThinkingLevel(resolvedLevel),
      },
    });
  }
  return stream(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets),
    },
  });
};

/**
 * 照抄 google-generative-ai.js 的 getGoogleBudget（那边没导出）：预算档模型的
 * thinkingLevel → thinkingBudget 换算，-1 = 服务端动态决定。
 */
function getGoogleBudget(model: CodeAssistModel, level: "minimal" | "low" | "medium" | "high", customBudgets?: Record<string, number>) {
  if (customBudgets?.[level] !== undefined) {
    return customBudgets[level];
  }
  if (model.id.includes("2.5-pro")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32768,
    };
    return budgets[level];
  }
  if (model.id.includes("2.5-flash-lite")) {
    const budgets = {
      minimal: 512,
      low: 2048,
      medium: 8192,
      high: 24576,
    };
    return budgets[level];
  }
  if (model.id.includes("2.5-flash")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24576,
    };
    return budgets[level];
  }
  return -1;
}

/**
 * 账户/项目发现（登录后做一次，best-effort）：loadCodeAssist 查 cloudaicompanionProject
 * 与 currentTier；没有 project 就 onboardUser 让服务端分配（longrunning operation，未 done
 * 就轮询，12 次 × 5s 封顶），完成后再 loadCodeAssist 一次。
 */
export interface CodeAssistDiscovery {
  projectId?: string;
  tier?: string;
}

const DISCOVERY_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
  pluginVersion: "2.0.0",
};

const ANTIGRAVITY_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

function parseLoadCodeAssist(value: unknown): CodeAssistDiscovery {
  const record = (value ?? {}) as { currentTier?: { id?: unknown }; cloudaicompanionProject?: unknown };
  const tier = typeof record.currentTier?.id === "string" ? record.currentTier.id : undefined;
  const raw = record.cloudaicompanionProject;
  const projectId = typeof raw === "string" && raw.length > 0
    ? raw
    : typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : undefined;
  return { ...(projectId ? { projectId } : {}), ...(tier ? { tier } : {}) };
}

export async function discoverProject(
  accessToken: string,
  flavor: CodeAssistFlavor = "gemini",
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CodeAssistDiscovery> {
  const baseUrl = defaultBaseUrl(flavor).replace(/\/+$/, "");
  const metadata = flavor === "antigravity" ? ANTIGRAVITY_METADATA : DISCOVERY_METADATA;
  const post = (path: string) =>
    fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: requestHeaders(flavor, accessToken, false),
      body: JSON.stringify({ metadata }),
      ...(signal ? { signal } : {}),
    });

  const load = async (): Promise<CodeAssistDiscovery> => {
    const first = await post("/v1internal:loadCodeAssist");
    if (!first.ok) throw new Error(`loadCodeAssist 失败 (${first.status})`);
    return parseLoadCodeAssist(await first.json());
  };

  const found = await load();
  if (found.projectId) return found;

  const onboard = await post("/v1internal:onboardUser");
  if (!onboard.ok) throw new Error(`onboardUser 失败 (${onboard.status})`);
  let operation = (await onboard.json()) as { done?: boolean; name?: string };
  for (let tries = 0; operation.done !== true && operation.name && tries < 12; tries++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetchImpl(`${baseUrl}/v1internal/${operation.name}`, {
      headers: requestHeaders(flavor, accessToken, false),
      ...(signal ? { signal } : {}),
    });
    if (!poll.ok) throw new Error(`onboard 轮询失败 (${poll.status})`);
    operation = (await poll.json()) as { done?: boolean; name?: string };
  }
  if (operation.done !== true) throw new Error("onboardUser 超时未完成");
  return load();
}

/** antigravity 专用：列出当前账户在该 project 下可用的模型（登录时打印用，best-effort）。 */
export interface AvailableModelInfo {
  displayName?: string;
  quotaInfo?: unknown;
}

export async function fetchAvailableModels(
  accessToken: string,
  project: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, AvailableModelInfo>> {
  const response = await fetchImpl(`${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: requestHeaders("antigravity", accessToken, false),
    body: JSON.stringify({ project }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`fetchAvailableModels 失败 (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as { models?: Record<string, AvailableModelInfo> };
  return json.models ?? {};
}

/** 装配给 createProvider 的 api 实现（ProviderStreams 形状）；flavor 缺省 gemini（现有调用不变）。 */
export function googleCodeAssistApi(options: { flavor?: CodeAssistFlavor } = {}): {
  id: Api;
  stream: (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => ReturnType<typeof stream>;
  streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => ReturnType<typeof streamSimple>;
} {
  const flavor = options.flavor ?? "gemini";
  return {
    id: (flavor === "antigravity" ? "antigravity-code-assist" : "google-code-assist") as Api,
    stream: (model, context, opts) => stream(model as CodeAssistModel, context, { ...(opts as GoogleCodeAssistOptions), flavor }),
    streamSimple: (model, context, opts) => streamSimple(model as CodeAssistModel, context, opts, flavor),
  };
}
