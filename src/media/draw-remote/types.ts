/**
 * draw_remote 四通道适配器（gpt / wan / qwen / gemini）的公共类型与错误。
 *
 * 这一层不认识 fish.config.json，也不碰 prompt：通道选择、热开关与轮状态机在工具层
 * （src/tools/draw_remote/）。这里只负责「按给定通道把图画出来」，并把失败分成两类——
 * 上层据此决定本轮锁不锁：
 *   submitted=false：生成请求没发出去，或上游确定性拒绝（4xx / 明确安全拒答）。
 *                    不锁轮，改参数或切通道后同轮可重试。
 *   submitted=true ：请求发出后结果不明（5xx / 超时 / 断网 / 落盘前取消）。
 *                    同轮重试由工具层报 draw_remote_uncertain，防重复出图。
 *
 * 宿主取消（AbortSignal）不是 DrawRemoteError：AbortError 原样上抛，是否已提交以调用方在
 * onSubmitted 里记下的状态为准。
 */

export type DrawRemoteProviderId = "gpt" | "wan" | "qwen" | "gemini";
export type DrawRemoteAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";

/** 单次远程生图 HTTP 请求默认超时（10 分钟）。 */
export const DRAW_REMOTE_TIMEOUT_MS = 600_000;
/** 异步后台任务的整体超时硬顶（比单次 HTTP 生成超时多留 60 秒余量）。 */
export const DRAW_REMOTE_JOB_TIMEOUT_MS = 660_000;

export type DrawRemoteStage = "prepare" | "post" | "parse" | "download";

/** 单阶段耗时遥测事件：ms 为该阶段独立耗时（非累计）。 */
export interface DrawRemoteStageEvent {
  stage: DrawRemoteStage;
  ms: number;
  status?: number;
  urls?: number;
  bytes?: number;
}

/** 同步预检入参：只校验输入与本机配置/凭据存在性，不发任何网络请求。 */
export interface DrawRemotePreflightRequest {
  provider: DrawRemoteProviderId;
  prompt: string;
  imagesCount: number;
  modelsPath: string;
  credentialsPath?: string;
}

/** 超时时长格式化：不足 1 秒保留 ms，否则取整秒。 */
export function formatTimeoutLabel(timeoutMs: number): string {
  return timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)} 秒`;
}

/** 严格校验 baseUrl：必须是合法 http(s) URL 且包含主机名。 */
export function isValidHttpUrl(raw: string | undefined): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/** 参考图：MIME 由上层按真实字节魔数核实过，bytes 是原始文件内容（只在内存里过一遍）。 */
export interface DrawRemoteReferenceImage {
  mimeType: string;
  bytes: Buffer;
}

export interface DrawRemoteRunRequest {
  provider: DrawRemoteProviderId;
  /** 通道模型名（fish.config.json 的 drawRemote.models 里选出来的那个）。 */
  model: string;
  prompt: string;
  images?: readonly DrawRemoteReferenceImage[];
  /** 画面比例；gpt 后端没有这个字段，安全忽略。 */
  aspectRatio?: DrawRemoteAspectRatio;
  /** 媒体根目录；成品落 `<mediaRoot>/gen/`。 */
  mediaRoot: string;
  /** config/models.json：每次调用现读该通道 provider 的 baseUrl / proxy。 */
  modelsPath: string;
  /** 凭据文件（config/auth.json）；缺省取 models.json 同目录的 auth.json。 */
  credentialsPath?: string;
  /**
   * 同步提交钩子：通道读完 models.json / auth.json 校验通过后，发起首个生成 POST
   * 之前被调用一次（不等待返回值）。这里抛错 = 请求不发出，错误原样上抛。
   */
  onSubmitted?: () => void;
  /** 宿主取消信号；与各通道内部请求超时经 AbortSignal.any 合并。 */
  signal?: AbortSignal;
  /** 单次生成请求的超时，缺省 600 秒（DRAW_REMOTE_TIMEOUT_MS）。 */
  timeoutMs?: number;
  /** 分阶段耗时回调（prepare / post / parse / download，用于日志可观测性）。 */
  onStage?: (event: DrawRemoteStageEvent) => void;
  /** 注入的 fetch（测试 / 上层代理）；缺省各通道自己选直连或 provider 代理。 */
  fetchImpl?: typeof fetch;
}

export interface DrawRemoteRunResult {
  provider: DrawRemoteProviderId;
  model: string;
  /**
   * 成品图在 `<mediaRoot>/gen/` 下的文件名（`<ts>-<uuid>.<ext>`）。
   * 媒体引用写作 `gen/${file}`（OutboundPayload.media），幂等键用 `${file}`。
   */
  files: string[];
}

export type DrawRemoteErrorCode =
  /** 总开关关闭（工具层在 onSubmitted 里二次复核时抛）。 */
  | "disabled"
  /** models.json 缺该通道的 provider / baseUrl，或 auth.json 缺该通道的 API key。 */
  | "unconfigured"
  /** prompt 为空或超长（四通道同一上限 4000 字）。 */
  | "prompt"
  /** 参考图张数超出该通道上限（qwen 最多 3 张，其余最多 5 张）。 */
  | "bad_ref"
  /** 上游请求失败：是否已提交看 submitted。 */
  | "failed";

export class DrawRemoteError extends Error {
  readonly code: DrawRemoteErrorCode;
  readonly provider: DrawRemoteProviderId;
  /** true = 生成请求已发出且结果不明（同轮不得重提）；false = 没提交或被确定性拒绝。 */
  readonly submitted: boolean;

  constructor(
    provider: DrawRemoteProviderId,
    code: DrawRemoteErrorCode,
    message: string,
    submitted: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DrawRemoteError";
    this.code = code;
    this.provider = provider;
    this.submitted = submitted;
  }
}

/**
 * index 解析完 models.json 之后交给单条通道的入参。通道不再读 models.json，
 * 但 API key 仍由通道自己从 authPath 读取。
 */
export interface DrawRemoteChannelRequest {
  model: string;
  prompt: string;
  images?: readonly DrawRemoteReferenceImage[];
  aspectRatio?: DrawRemoteAspectRatio;
  mediaRoot: string;
  /** 凭据文件路径（config/auth.json）。 */
  authPath: string;
  /** models.json 里的 provider 条目名，同时也是 auth.json 里的凭据条目名。 */
  providerId: string;
  baseUrl?: string;
  proxy?: string;
  onSubmitted?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStage?: (event: DrawRemoteStageEvent) => void;
  fetchImpl?: typeof fetch;
}

// ---------- 四条通道共用的错误判别 ----------

/** 媒体客户端给 HTTP 非 2xx 错误挂上的状态码；不是 HTTP 错误返回 undefined。 */
export function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** `AbortSignal.timeout()` 到期抛的 DOMException（name 为 TimeoutError）。 */
export function isTimeoutError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** fetch 被 AbortSignal 取消时抛的 DOMException（name 为 AbortError）；宿主取消与内部定时器超时都是它。 */
export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
