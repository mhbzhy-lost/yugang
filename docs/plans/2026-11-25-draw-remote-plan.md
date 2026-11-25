# `draw_remote` 统一远程生图 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 将远程静态生图能力（`gpt_image` + `wan_image` + 新增 `gemini-3.1-flash-image`）合并为统一工具 `draw_remote`，由 `fish.config.json` 的 `drawRemote` 热配置控制通道切换与总开关，并统一经 outbox 机械直发。

**Architecture:** 底层先修 `src/media/proxy-fetch.ts` 二进制响应破损并在 `src/media/draw-remote/` 实现统一三通道适配器（`gpt` / `wan` / `gemini` + 独立脱敏 + `onSubmitted` 提交钩子）；配置层在 `src/fish-config.ts` 与 `src/tools/config/tool.ts` 注册热生效 `drawRemote` 块；工具层新建 `src/tools/draw_remote/` 四件套；最后统一清理旧工具包、修复 `runtime.ts` 家族推导并完成全仓脚本/提示词/测试收口，同时保持 `draw`、`qwen_draw`、`wan_gif` 独立无回归。

**Tech Stack:** Node.js >=22 (native TypeScript strip-types + `node:test`), `@earendil-works/pi-durable`, `https-proxy-agent` (`src/media/proxy-fetch.ts`), `fileCredentialStore` (`src/auth/credentials.ts`).

**Spec:** `docs/plans/2026-11-25-draw-remote-spec.md`

**Plan Review Record:** 2026-11-25 经独立只读重型评审（`pi-worker` `tier=heavy`, `readOnly=true`, model `glm-5.4`, taskId `0b36d33f-e73c-4e8a-b1ef-8b039267ea9d`），全部 4 条 Critical（C1 `onSubmitted` 时序、C2 `runtime.ts:596` 家族推导吞并 `draw_remote`、C3 `proxy-fetch.ts` UTF-8 破坏二进制图片、C4 `DrawRemoteError.submitted` 边界矩阵）及 S1–S6 / M1–M5 均已逐条合入本 Spec 与 Plan。

## Global Constraints

- 模型可见提示词只能位于 `prompt/` 与 `src/tools/<name>/TOOL.md` / `messages.json`，严禁在 `src/` 里新增模型可见长提示词；`messages.json` 的 key 不得与 `prompt/messages.md` 或其它工具包冲突，且 `test/prompts.test.ts` 的无死 key 校验必须全绿。
- 凭据不得写入 `fish.config.json`（`checkDrawRemote` 大小写不敏感拒绝 `apiKey`/`key`/`token`/`access`/`refresh`/`secret`）；所有上游错误正文与拒答文本必须先脱敏再经 `sanitizeExternalText`（`src/external/sanitize.ts`）方可见模型。
- Node 运行在 TypeScript strip-only 模式：禁止 `constructor(readonly x: ...)` 参数属性语法、禁止 `enum` 关键字。
- `qwen_draw`（本地 ComfyUI）、`draw`（本地 ComfyUI）与 `wan_gif`（视频转 GIF）保持独立零破坏；`config/models.json` 既有 `models.image` / `models.wan_image` 保持兼容不拒启。
- Git 操作优先使用 `git1`（不可用时回退 `git`）；commit 遵循 `type(scope): 中文祈使句`，禁止 AI 署名；始终显式列出 `git1 add` 文件路径，禁止宽泛 `git1 add -A`。

## Review Focus

1. **热切到缺凭据/缺配置通道不误发回执不锁轮（C1）**：把 `drawRemote.provider` 热切到 `models.json` 缺 provider 或 `auth.json` 缺凭据的通道时，必须在 `onSubmitted` 前即抛 `DrawRemoteError(code="unconfigured", submitted=false)`，不触发 `onLongWork`、不置 `submitted = true`，修复或切回后同轮可重试成功。
2. **能力越界与确定性 4xx 不锁轮、5xx/超时/POST 后断网锁轮（C4）**：`wan` 传 `images`、`wan`/`gemini` 传 `background="transparent"`、`wan` 超 800 字、前置 OAuth 刷新失败、以及上游 4xx/安全拒答均 `submitted=false`（不锁死本轮）；上游 5xx、超时、POST 后网络错误或落盘前 abort 保持 `submitted=true`（同轮重试报 `draw_remote_uncertain`）。
3. **代理下载二进制无损 & 取消围栏（C3）**：`createProxyFetch` 返回原始 `Buffer` 构造的 `Response`，`wan` 通过代理下载 PNG 后魔数 `89 50 4e 47` 逐字节无损；`context.abortSignal` 在落盘或入队前触发中止时，零文件写入 `<mediaRoot>/gen/`、零消息入 outbox。
4. **`runtime.ts` 家族隔离与 `config` 两层点路径精准拦错（C2 & S3）**：`runtime.ts:596` 仅把 `draw_fast`/`draw_interaction` 归入 `"draw"` 家族，`draw_remote` 独立为 `"draw_remote"` 家族（同轮 `draw` + `draw_remote` 各自发回执、各自受 `DIRECT_EGRESS_TOOL_FAMILIES` 豁免）；`config set drawRemote.models.gemini ""` 或 `config set drawRemote.apiKey x` 被 `targetProblem` / `!ok` 精准拦截拒绝写盘。
5. **参考图围栏与 Gemini 401 锁内强刷（S2）**：`images` 中含 `../`、外部符号链接、非法后缀/魔数（如给 `gemini` 传 `.gif`）、单张 >10 MiB、`gemini` 聚合 >15 MiB 或超过 5 张，一律在 `onSubmitted` 前整批按 `draw_remote_bad_ref` 拒掉；Gemini 过期并发只刷一次、未过期 401 按 `usedAccess` 锁内强刷一次重试成功。

---

### Task 1: `fish.config.json` 的 `drawRemote` 热配置与 `config` 工具接入

**Depends on:** `none` *(与 Task 2 文件完全无重叠，可并行执行)*

**Files:**
- Modify: `src/fish-config.ts`（`DrawRemoteProvider` / `DrawRemoteConfig` / `DRAW_REMOTE_DEFAULTS` / `checkDrawRemote` / `FISH_CONFIG_FIELDS` / `DEFAULTS` / `loadFishConfig`）
- Modify: `src/tools/config/tool.ts:48`（`OBJECT_CONFIG_FIELDS` 加入 `"drawRemote"`）
- Modify: `src/tools/config/TOOL.md`（受控字段表补充 `drawRemote` 热生效说明；调整 `models_switch` 注释说明远程生图改由 `drawRemote` 控制）
- Modify: `fish.config.example`（补充 `drawRemote` 示例）
- Create: `test/draw-remote-config.test.ts`

**Interfaces:**
- Consumes: `src/fish-config.ts` 既有 `FieldCheck`、`FishConfigFieldSpec`、`FISH_CONFIG_FIELDS`、`loadFishConfig`、`createConfigLoader`；`src/tools/config/tool.ts` 的 `createConfigTool`
- Produces:
  - `export type DrawRemoteProvider = "gpt" | "wan" | "gemini";`
  - `export interface DrawRemoteConfig { readonly enabled: boolean; readonly provider: DrawRemoteProvider; readonly models: Readonly<Record<DrawRemoteProvider, string>>; }`
  - `export const DRAW_REMOTE_DEFAULTS: DrawRemoteConfig`（`Object.freeze` 冻结：`enabled: true`, `provider: "gemini"`, `models: Object.freeze({ gpt: "gpt-image-2.6-flare", wan: "wan2.7-image", gemini: "gemini-3.1-flash-image" })`）
  - `FishConfig.drawRemote: DrawRemoteConfig`
  - `FISH_CONFIG_FIELDS` 中 `{ name: "drawRemote", effect: "hot", check: checkDrawRemote }`

- [ ] **Step 1: 编写 `drawRemote` 配置校验、热加载与 `config` 工具点路径测试**

在 `test/draw-remote-config.test.ts` 编写测试：
- 缺省值：`loadFishConfig()` 返回 `drawRemote` 等于 `DRAW_REMOTE_DEFAULTS`（且共享默认不可变）；
- 局部覆盖：`{ drawRemote: { provider: "gpt", models: { gpt: "gpt-image-2.6-sunburst" } } }` 解析后保留 `enabled: true` 及 `wan`/`gemini` 默认模型；
- 非法值与完整路径文案契约：验证 `provider: "dalle"`、`enabled: "yes"`、`models: { gemini: "" }`、`models: { unknown: "x" }`、`extra: 1` 产出的 `problems` 字面包含 `drawRemote.provider` / `drawRemote.enabled` / `drawRemote.models.gemini` / `drawRemote.models.unknown` / `drawRemote.extra`；全非法对象返回 `{ ok: false }`；
- 凭据红线：顶层或 `models` 下含 `apiKey` / `API_KEY` / `key` / `token` / `access` / `refresh` / `secret` 时整块返回 `{ ok: false }`；
- 热加载：`createConfigLoader` 在文件修改 `drawRemote.provider` 为 `"wan"` 并推进 mtime 后立即返回 `"wan"`；
- `config` 工具级测试（Review Focus #4）：通过 `createConfigTool` 执行 `action: "set"` 测试 `drawRemote.provider = "gpt"`（成功写盘、回执热生效）、`drawRemote.models.gemini = "gemini-3.1-flash-image"`（两层点路径成功）、`drawRemote.models.gemini = ""`（被 `targetProblem` 拦截拒绝写盘）、`drawRemote.apiKey = "sk-x"`（被拒绝且不落盘）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/draw-remote-config.test.ts`
Expected: FAIL（`DRAW_REMOTE_DEFAULTS` / `drawRemote` 未定义）

- [ ] **Step 3: 实现 `src/fish-config.ts`、`src/tools/config/tool.ts`、`src/tools/config/TOOL.md`、`fish.config.example`**

- `src/fish-config.ts`：定义 `DrawRemoteProvider`、`DrawRemoteConfig`、`DRAW_REMOTE_DEFAULTS`（冻结）、`checkDrawRemote(raw)`（先递归扫顶层与 `models` 敏感键拒绝；再逐项校验 `enabled`/`provider`/`models`，错误文案严格含完整点路径 `drawRemote.<field>` 供 `config/tool.ts` `targetProblem` 精准匹配；`loadFishConfig` 合并 `drawRemote` 与 `drawRemote.models`）。
- `src/tools/config/tool.ts:48`：`OBJECT_CONFIG_FIELDS` 加入 `"drawRemote"`。
- `src/tools/config/TOOL.md` & `fish.config.example`：补充 `drawRemote` 热配置说明与示例。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/draw-remote-config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 1**

```bash
git1 add src/fish-config.ts src/tools/config/tool.ts src/tools/config/TOOL.md fish.config.example test/draw-remote-config.test.ts
git1 commit -m "feat(config): 增加 drawRemote 远程生图热配置字段"
```

---

### Task 2: `proxy-fetch` 二进制修复与 `src/media/draw-remote/` 三通道适配器层

**Depends on:** `none` *(与 Task 1 文件完全无重叠，可并行执行；`DrawRemoteProvider` 类型可在 `types.ts` 定义为 `"gpt" | "wan" | "gemini"`，Task 3 集成时复用同构字面量联合)*

**Files:**
- Modify: `src/media/proxy-fetch.ts:54-85`（保留原始 `Buffer` 而非 `toString("utf8")` 构造 `Response`，使文本与二进制下载均无损）
- Modify: `src/media/wan-image.ts`（`WanImageRequest` 补可选 `proxy?: string`、`fetchImpl?: typeof fetch`、`onSubmitted?: () => void`，生成与下载均走 `doFetch`）
- Modify: `src/media/gpt-image.ts`（`GptImageRequest` 补可选 `onSubmitted?: () => void`，在完成凭据读取与刷新后、发起生成 POST 前同步调用）
- Create: `src/media/draw-remote/redact.ts`（独立秘密脱敏辅助，不反向依赖 `src/model/quota.ts`）
- Create: `src/media/draw-remote/types.ts`
- Create: `src/media/draw-remote/gemini.ts`
- Create: `src/media/draw-remote/gpt.ts`
- Create: `src/media/draw-remote/wan.ts`
- Create: `src/media/draw-remote/index.ts`
- Create: `test/draw-remote-media.test.ts`

**Interfaces:**
- Consumes:
  - `generateGptImages`, `extensionOf` from `src/media/gpt-image.ts`
  - `generateWanImage` from `src/media/wan-image.ts`
  - `createProxyFetch` from `src/media/proxy-fetch.ts`
  - `fileCredentialStore`, `type OAuthCredential` from `src/auth/credentials.ts`
  - `refreshTokens as refreshGoogleTokens` from `src/auth/google.ts`
  - `ANTIGRAVITY_BASE_URL`, `antigravityUserAgent`, `discoverProject` from `src/model/google-code-assist.ts`
  - `readCredentialFile`, `type ModelsFile` from `src/model/config.ts`
  - `sanitizeExternalText` from `src/external/sanitize.ts`
- Produces:
  - `export type DrawRemoteProviderId = "gpt" | "wan" | "gemini";`
  - `export type DrawRemoteAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";`
  - `export type DrawRemoteBackground = "auto" | "transparent" | "opaque";`
  - `export interface DrawRemoteReferenceImage { mimeType: string; bytes: Buffer; }`
  - `export interface DrawRemoteRunRequest { provider: DrawRemoteProviderId; model: string; prompt: string; images?: readonly DrawRemoteReferenceImage[]; aspectRatio?: DrawRemoteAspectRatio; background?: DrawRemoteBackground; mediaRoot: string; modelsPath: string; credentialsPath?: string; onSubmitted?: () => void; signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch; }`
  - `export interface DrawRemoteRunResult { provider: DrawRemoteProviderId; model: string; files: string[]; }`
  - `export type DrawRemoteErrorCode = "disabled" | "unconfigured" | "prompt" | "no_ref" | "no_transparent" | "failed";`
  - `export class DrawRemoteError extends Error`（显式字段 `readonly code: DrawRemoteErrorCode; readonly provider: DrawRemoteProviderId; readonly submitted: boolean;`）
  - `export interface GeminiImageRequest { authPath: string; provider: string; baseUrl?: string; userAgent?: string; model: string; prompt: string; images?: readonly DrawRemoteReferenceImage[]; aspectRatio?: DrawRemoteAspectRatio; mediaRoot: string; onSubmitted?: () => void; timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch; proxy?: string; }`
  - `export async function generateGeminiImage(request: GeminiImageRequest): Promise<string[]>`
  - `export async function runDrawRemote(request: DrawRemoteRunRequest): Promise<DrawRemoteRunResult>`

- [ ] **Step 1: 编写 `proxy-fetch` 二进制无损测试与三通道适配器失败测试**

在 `test/draw-remote-media.test.ts` 编写测试：
- **`proxy-fetch` 二进制无损（Review Focus #3）**：启一个本地 HTTP CONNECT 代理测试桩或直接验证 `proxy-fetch.ts` 返回 `Response.arrayBuffer()` 对含 `0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a` 非 UTF-8 字节的 PNG 逐字节完全一致，同时 `response.json()` 仍正常；
- **Gemini 文生图 & 图生图**：临时 `models.json`（含 `google-antigravity` 自定义 `baseUrl`/`userAgent`）与 `auth.json`（含 `projectId`）；验证 POST `{baseUrl}/v1internal:generateContent` 请求体含 `project`、`model`、`userAgent: "antigravity"`、`requestId`、`responseModalities: ["IMAGE", "TEXT"]`、`imageConfig: { aspectRatio: "3:4" }`、参考图 `inlineData`；确认 `onSubmitted` 在 POST 前同步触发 1 次；返回 base64 JPEG 落盘 `gen/*.jpg`；
- **Gemini `projectId` 缺失兜底 & OAuth 刷新（Review Focus #5）**：缺 `projectId` 时按同 `baseUrl`/`userAgent` 调 `loadCodeAssist` 获取；过期凭据并发 2 次只打 1 次 `oauth2.googleapis.com/token` 并原子回写；未过期但首调 401 时按 `usedAccess` 锁内强刷一次重试成功（不重复用旧 token）；前置 OAuth 刷新失败抛 `DrawRemoteError(code="failed", submitted=false)` 且 `onSubmitted` 未调用；
- **Gemini 异常、确定性拒绝与脱敏（Review Focus #2）**：HTTP 400/429 或安全拒答抛 `DrawRemoteError(code="failed", submitted=false)`；HTTP 500（响应含 Bearer token 与恶意标签）抛 `DrawRemoteError(code="failed", submitted=true)` 且消息已脱敏并经 `sanitizeExternalText` 清洗；<1024 字节图片拒落盘；
- **取消围栏（Review Focus #3）**：`fetchImpl` 返回后 `AbortController.abort()` 触发时，抛 AbortError 且 `<mediaRoot>/gen/` 无任何文件写入；
- **GPT 通道**：读 `openai-codex` 配置与 OAuth 凭据，透传 `model`、`background: "transparent"`、`images`（现拼 `dataUrl` 走 `/edits`），忽略 `aspectRatio`，`onSubmitted` 在生成 POST 前同步调用；缺凭据抛 `DrawRemoteError(code="unconfigured", submitted=false)`（提示缺 `auth.json` 凭据）；HTTP 400 标 `submitted=false`，500 标 `submitted=true`；
- **Wan 通道**：读 `qwen-token-plan-cn` API key 与 `baseUrl`（去 `/compatible-mode/v1`），生成 POST 与图片 URL 下载均走注入 `fetchImpl` 且 PNG 魔数字节无损；`prompt > 800` 抛 `code="prompt", submitted=false`；`images` 非空抛 `code="no_ref", submitted=false`；`background="transparent"` 抛 `code="no_transparent", submitted=false`；`gemini` 传 `background="transparent"` 同样抛 `code="no_transparent", submitted=false`；以上均不触发 `onSubmitted`、不发任何 HTTP 请求；
- **配置缺失（Review Focus #1）**：`models.json` 缺对应 provider 时抛 `DrawRemoteError(code="unconfigured", submitted=false)`（明确指出缺 `models.json` provider），不触发 `onSubmitted`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/draw-remote-media.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `proxy-fetch.ts` 二进制修复、`wan-image.ts`、`gpt-image.ts` 与 `src/media/draw-remote/*`**

- `src/media/proxy-fetch.ts`：`reply` 保存 `body: Buffer`（`Buffer.concat(chunks)`），`new Response(nullBodyStatus(reply.status) ? null : new Uint8Array(reply.body), ...)`。
- `src/media/wan-image.ts`：新增可选 `proxy`、`fetchImpl`、`onSubmitted`，生成请求与图片下载均走 `doFetch`；`onSubmitted?.()` 在 POST 前同步触发；落盘前逐张复核 `signal.throwIfAborted()`；HTTP 4xx/5xx 保留状态码供上层区分 `submitted`。
- `src/media/gpt-image.ts`：新增可选 `onSubmitted`，在凭据校验与刷新完成后、POST 前同步调用 `request.onSubmitted?.()`；落盘循环每张前 `request.signal?.throwIfAborted()`。
- `src/media/draw-remote/{redact,types,gemini,gpt,wan,index}.ts`：完整实现三通道与统一调度入口，默认从 `join(dirname(modelsPath), "auth.json")` 读凭据（`credentialsPath` 可显式覆盖），全部上游错误先脱敏再 `sanitizeExternalText`。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/draw-remote-media.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 2**

```bash
git1 add src/media/proxy-fetch.ts src/media/wan-image.ts src/media/gpt-image.ts src/media/draw-remote/redact.ts src/media/draw-remote/types.ts src/media/draw-remote/gemini.ts src/media/draw-remote/gpt.ts src/media/draw-remote/wan.ts src/media/draw-remote/index.ts test/draw-remote-media.test.ts
git1 commit -m "feat(media): 增加 draw_remote 三通道适配器并修复代理二进制下载"
```

---

### Task 3: `src/tools/draw_remote/` 工具包实现与工具级测试

**Depends on:** `Task 1`, `Task 2`

**Files:**
- Create: `src/tools/draw_remote/TOOL.md`
- Create: `src/tools/draw_remote/schema.json`
- Create: `src/tools/draw_remote/messages.json`
- Create: `src/tools/draw_remote/tool.ts`
- Modify: `src/tools/types.ts`（`ToolPackageDeps` 新增 `drawRemote?: () => DrawRemoteConfig`、`drawRemoteRun?: typeof runDrawRemote`；移除 `gptImage`；保留 `wanImage` 给 `wan_gif`）
- Create: `test/draw-remote.test.ts`

**Interfaces:**
- Consumes:
  - `DrawRemoteConfig`, `DRAW_REMOTE_DEFAULTS` from `src/fish-config.ts`
  - `runDrawRemote`, `DrawRemoteError`, `type DrawRemoteReferenceImage` from `src/media/draw-remote/index.ts`
  - `enqueueOutbound`, `fenceReadablePath`, `sniffImageMagic`, `manifestParameters`, `toolFullDescription`, `renderTemplate`
- Produces:
  - `export function createDrawRemoteTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration`（恒返回 `ToolRegistration`）

- [ ] **Step 1: 编写 `test/draw-remote.test.ts` 失败测试**

覆盖以下场景：
1. **热切换生效**：同一 `createDrawRemoteTool` 实例不重建，第一次 `drawRemote()` 返回 `provider: "gemini"`，第二次热切返回 `provider: "gpt"`（自定义模型），验证分别路由到对应 provider 与模型；
2. **`enabled: false` 总闸（入口 & 提交前二次复核）**：入口关闭即抛 `draw_remote_disabled`（不调 `onLongWork`、不置 `submitted`）；入口开启但 `onSubmitted` 触发瞬间热配置翻为 `false`，同样抛 `draw_remote_disabled` 且 `submitted` 保持 `false`（重新打开后同轮可成功）；
3. **机械直发 outbox & 入队回退**：成功后调用 `enqueueOutbound` 自动发图（带 `quoteId`/`quoteForce` 与幂等键 `${conv}:draw_remote:${round}:${file}`），回执含 `gen/<file>`、当前通道名与「不要再调 say_media」；入队失败返回回退文案引导 `say_media` 补发；
4. **`submitted` 防重提边界（Review Focus #1 & #2）**：
   - 并发二次调用 → `draw_remote_inflight`；
   - 同轮成功后二次调用 → `draw_remote_used`；
   - `DrawRemoteError(submitted=false)`（`unconfigured`、`no_ref`、`no_transparent`、`prompt`、上游 400）→ 不锁死本轮（且不发 `onLongWork`），修正后同轮可重试成功；
   - `DrawRemoteError(submitted=true)`（上游 500/超时）→ 锁死本轮，同轮重试报 `draw_remote_uncertain`；
5. **参考图安全围栏（Review Focus #5）**：支持去首尾方括号 `[inbound/a.png]`；`../etc/passwd`、指向外部的符号链接、`.txt` 非图片、魔数与后缀不符、0 字节文件、>10 MiB 单张、6 张图片、以及 `gemini` 通道下传 `.gif` 或聚合 >15 MiB 均在 `onSubmitted` 前按 `draw_remote_bad_ref` 拒掉；
6. **取消围栏（Review Focus #3）**：`drawRemoteRun` 返回后 `context.abortSignal` 已中止时，不调用 `enqueueOutbound`、直接抛取消异常。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/draw-remote.test.ts`
Expected: FAIL（`src/tools/draw_remote/tool.ts` 不存在）

- [ ] **Step 3: 创建 `src/tools/draw_remote/{TOOL.md,schema.json,messages.json,tool.ts}` 并更新 `src/tools/types.ts`**

- `TOOL.md`：说明何时选 `draw_remote`（远程 API 画图/改图）vs `draw`（本地二次元 SD）/ `qwen_draw`（本地 Qwen）/ `wan_gif`（动图），明确「通道由主人热配置控制、出图自动发出不要再调 `say_media`」。
- `schema.json`：严格 JSON，含 `prompt`（必填）、`images`（`maxItems: 5`）、`aspect_ratio`、`background`。
- `messages.json`：全部 `draw_remote_*` key，每条 key 在 `tool.ts` 字面引用；`draw_remote_failed` 明确引导模型用 `say_words` 告知群友失败；`draw_remote_done` 带 `{{provider}}` 与 `{{file}}`；`draw_remote_done_fallback` 在 outbox 入队失败时提示 `say_media` 补发。
- `tool.ts`：实现完整预检、按魔数读参考图、`onSubmitted` 二次复核热开关 + 置 `submitted` + 触发 `onLongWork`、错误按 `DrawRemoteError.submitted` 精准复位、`enqueueOutbound` 机械直发。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/draw-remote.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 3**

```bash
git1 add src/tools/draw_remote/TOOL.md src/tools/draw_remote/schema.json src/tools/draw_remote/messages.json src/tools/draw_remote/tool.ts src/tools/types.ts test/draw-remote.test.ts
git1 commit -m "feat(tools): 增加 draw_remote 统一远程生图工具包"
```

---

### Task 4: 宿主装配、旧工具移除、家族推导修复与全仓收口

**Depends on:** `Task 3`

**Files:**
- Delete: `src/tools/gpt_image/`（目录内 4 文件）
- Delete: `src/tools/wan_image/`（目录内 4 文件）
- Delete: `src/media/openai-image.ts`
- Modify: `src/tools/loader.ts`（`FACTORIES` 移除 `gpt_image`/`wan_image`、加入 `draw_remote: createDrawRemoteTool`，注释更新为 31 个工具包）
- Modify: `src/fish/types.ts` & `src/fish/tool-surface.ts`（移除 `gptImage`，透传 `drawRemote`、`drawRemoteRun`；保留 `wanImage` 给 `wan_gif`）
- Modify: `src/app/runtime.ts`（`workingTextOf` 换 `draw_remote` → `working_draw_remote`；`:596` 家族推导改为显式 `DRAW_VARIANTS` 避免吞并 `draw_remote`；`toolTimeoutOverrides` 换 `draw_remote: 210` 替代 `gpt_image`/`wan_image`；注入 `drawRemote: () => fishConfig().config.drawRemote`；移除 `gptImage` 构造；保留 `wanImage` 给 `wan_gif`）
- Modify: `src/zero-egress-nudge.ts`（`DIRECT_EGRESS_TOOL_FAMILIES` 将 `"wan_image"` 改为 `"draw_remote"`）
- Modify: `prompt/messages.md`（`working_gpt_image` 改为 `working_draw_remote`；注释 `:116` 同步 `draw / draw_remote`）
- Modify: `prompt/runtime.md:23`（`gpt_image` → `draw_remote`）
- Modify: `src/qq/model-input.ts` & `src/qq/round-images.ts`（注释 `gpt_image` → `draw_remote`）
- Modify: `scripts/real-model-smoke.ts`（迁移原 S10 `gpt_image` 引用到 `draw_remote`、移除已删 `gptImage` option、超时表换 `draw_remote: 210`、确保 `modelsPath` 指向隔离副本）
- Modify: `README.md`、`.env.example`、`AGENTS.md`（同步工具面清单、热配置规则、超时表、移除过期工具计数与退役 `OPENAI_BASE_URL` 说明）
- Modify: `test/tools.test.ts`（deferred 清单去掉 `gpt_image`/`wan_image`，加入 `draw_remote`）
- Modify: `test/zero-egress-nudge.test.ts`（更新断言：`draw_remote` 豁免零出口补跑，移除 `gpt_image`；补充 `runtime.ts` 源码断言确认 `draw_remote` 不再被 `startsWith("draw_")` 吞并）

**Interfaces:**
- Consumes: Task 1–3 的全部导出
- Produces: 完整集成后的工具面（31 工具包，含 `draw_remote`、`draw`、`qwen_draw`、`wan_gif`）与全绿测试集

- [ ] **Step 1: 先更新 `test/tools.test.ts` 与 `test/zero-egress-nudge.test.ts` 断言并运行确认失败**

- `test/tools.test.ts`：deferred 清单替换 `gpt_image`/`wan_image` → `draw_remote`。
- `test/zero-egress-nudge.test.ts`：移除 `gpt_image`、`DIRECT_EGRESS_TOOL_FAMILIES` 验证含 `"draw_remote"`，并增加断言核对 `src/app/runtime.ts` 不再使用 `tool.startsWith("draw_")`（确保 `draw_remote` 独立成家族）。

Run: `node --test test/tools.test.ts test/zero-egress-nudge.test.ts`
Expected: FAIL

- [ ] **Step 2: 清理旧工具包并完成宿主装配、家族推导修复与全仓文档/脚本同步**

按上方 Files 清单逐一修改与删除，删除前用 `grep` 核对全仓 `src/`、`scripts/`、`prompt/`、`test/` 不留任何悬空 `gpt_image` / `wan_image` / `openai-image` 引用（`models.wan_image` 与 `wan_gif` 兼容引用除外）。

- [ ] **Step 3: 运行全量测试与提示词审查命令**

Run: `npm test && npm run prompts`
Expected: 全部测试 PASS（0 fail），`npm run prompts` exit 0 且无 key 冲突与死文案。

- [ ] **Step 4: 提交 Task 4**

```bash
git1 add src/tools/loader.ts src/fish/types.ts src/fish/tool-surface.ts src/app/runtime.ts src/zero-egress-nudge.ts prompt/messages.md prompt/runtime.md src/qq/model-input.ts src/qq/round-images.ts scripts/real-model-smoke.ts README.md .env.example AGENTS.md test/tools.test.ts test/zero-egress-nudge.test.ts
git1 rm -r src/tools/gpt_image src/tools/wan_image src/media/openai-image.ts
git1 commit -m "refactor(draw_remote): 切换宿主装配并清理旧远程生图工具"
```

---

## Execution Parallelization Notes

- **Wave 1（可真并发，文件完全不相交）**：
  - Group A = **Task 1**（`src/fish-config.ts`, `src/tools/config/tool.ts`, `src/tools/config/TOOL.md`, `fish.config.example`, `test/draw-remote-config.test.ts`）
  - Group B = **Task 2**（`src/media/proxy-fetch.ts`, `src/media/wan-image.ts`, `src/media/gpt-image.ts`, `src/media/draw-remote/*`, `test/draw-remote-media.test.ts`）
- **Wave 2（串行集成，依赖 Wave 1）**：
  - **Task 3**（`src/tools/draw_remote/*`, `src/tools/types.ts`, `test/draw-remote.test.ts`）→ **Task 4**（清理旧包 + 宿主装配 + 提示词/脚本/全仓测试收口）
