/**
 * draw_remote 四通道适配器（gpt / wan / qwen / gemini）的公共类型与错误。
 *
 * 这一层不认识 fish.config.json，也不碰 prompt：通道选择、热开关与轮状态机在工具层
 * （src/tools/draw_remote/）。这里只负责「按给定通道把图画出来」，并把失败分成两类——
 * 上层据此决定本轮锁不锁（spec §3.3.5）：
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
export type DrawRemoteBackground = "auto" | "transparent" | "opaque";

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
  /** wan / qwen / gemini 不支持 transparent，发请求前拒绝。 */
  background?: DrawRemoteBackground;
  /** 媒体根目录；成品落 `<mediaRoot>/gen/`。 */
  mediaRoot: string;
  /** config/models.json：每次调用现读该通道 provider 的 baseUrl / userAgent / proxy。 */
  modelsPath: string;
  /** 凭据文件（config/auth.json）；缺省取 models.json 同目录的 auth.json。 */
  credentialsPath?: string;
  /**
   * 同步提交钩子：通道读完 models.json / auth.json、做完前置 OAuth 刷新之后，发起首个生成 POST
   * 之前被调用一次（不等待返回值）。这里抛错 = 请求不发出，错误原样上抛。
   */
  onSubmitted?: () => void;
  /** 宿主取消信号；与各通道内部请求超时经 AbortSignal.any 合并。 */
  signal?: AbortSignal;
  /** 单次生成请求的超时，缺省 180 秒。 */
  timeoutMs?: number;
  /** 注入的 fetch（测试 / 上层代理）；缺省各通道自己选直连或 provider 代理。 */
  fetchImpl?: typeof fetch;
}

export interface DrawRemoteRunResult {
  provider: DrawRemoteProviderId;
  model: string;
  /**
   * 成品图在 `<mediaRoot>/gen/` 下的文件名（`<ts>-<uuid>.<ext>`，与 generateGptImages / generateWanImage 同约定）。
   * 媒体引用写作 `gen/${file}`（OutboundPayload.media），幂等键用 `${file}`。
   */
  files: string[];
}

export type DrawRemoteErrorCode =
  /** 总开关关闭（工具层在 onSubmitted 里二次复核时抛）。 */
  | "disabled"
  /** models.json 缺该通道的 provider，或 auth.json 缺该通道的凭据。 */
  | "unconfigured"
  /** prompt 为空或超长（四通道同一上限 4000 字）。 */
  | "prompt"
  /** 参考图张数超出该通道上限（qwen 最多 3 张，其余最多 5 张）。 */
  | "bad_ref"
  /** 通道不支持透明背景（wan / qwen / gemini）。 */
  | "no_transparent"
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
 * 但凭据仍由通道自己从 authPath 读出来（它们本来就各读各的：OAuth 整块 token / API key）。
 */
export interface DrawRemoteChannelRequest {
  model: string;
  prompt: string;
  images?: readonly DrawRemoteReferenceImage[];
  aspectRatio?: DrawRemoteAspectRatio;
  background?: DrawRemoteBackground;
  mediaRoot: string;
  /** 凭据文件路径（config/auth.json）。 */
  authPath: string;
  /** models.json 里的 provider 条目名，同时也是 auth.json 里的凭据条目名。 */
  providerId: string;
  baseUrl?: string;
  userAgent?: string;
  proxy?: string;
  onSubmitted?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
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
