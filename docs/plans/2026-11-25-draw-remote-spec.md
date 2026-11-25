# `draw_remote` 统一远程生图工具设计规范

## 1. 背景与目标

鱼缸当前的远程静态图能力分散在 `gpt_image`（Codex 订阅通道，返回路径让模型再调 `say_media`）和 `wan_image`（百炼 Token Plan，经 outbox 机械直发）两个独立工具中，且尚未接入 Google AI Pro（Antigravity）订阅里的 `gemini-3.1-flash-image`。

本规范将所有走远程 API 的静态生图能力收敛为统一工具 **`draw_remote`**，内部以可插拔 provider 适配 **`gpt`**、**`wan`**、**`gemini`** 三个通道，并由 `fish.config.json` 的 **`drawRemote`** 受控字段热切换，实现零重启切换通道、统一 outbox 机械直发、统一参考图安全围栏与防重提状态机。

## 2. 明确边界（做什么 / 不做什么）

- **合并进 `draw_remote`**：
  - 原 `gpt_image`（`openai-codex` 订阅生图/改图）→ `provider: "gpt"`
  - 原 `wan_image`（百炼 `qwen-token-plan-cn` 原生生图）→ `provider: "wan"`
  - 新增 `gemini-3.1-flash-image`（`google-antigravity` OAuth 生图/改图）→ `provider: "gemini"`
  - 移除旧工具包 `src/tools/gpt_image/`、`src/tools/wan_image/` 以及不再被任何模块引用的 `src/media/openai-image.ts`。
  - **显式退役的能力（需主人知悉）**：原 `gpt_image` 的官方 API 动图路径（`output_format=gif`、`frame_count`/`frame_duration_ms`、`auth.json` 的 `openai.key`、`OPENAI_BASE_URL`）与 `wan_image` 的 `size`/`n`/`enable_sequential` 参数随合并退役；动图统一走独立工具 `wan_gif`。
- **保持独立不动**：
  - `draw`：本地 WSL ComfyUI Anima 管线（受 `drawEnabled` GPU 闸控制）。
  - `qwen_draw`：本地 WSL ComfyUI Qwen-Image-2.1 管线（复用 `draw/comfy.ts` 与 `drawEnabled`）。
  - `wan_gif`：百炼 `wan3.0-video` 异步视频（20 分钟超时）+ ffmpeg 转 GIF；保留其 `deps.wanImage` 接线确保零回归。
- **不暴露给模型的东西**：
  - 模型不传 `provider` 或 `model` 参数；通道切换完全由主人在 `fish.config.json`（或私聊 `config` 工具）热控。

## 3. 工具契约（`src/tools/draw_remote/`）

遵循 `AGENTS.md` 第 2 条四件套规范（`TOOL.md` + `schema.json` + `messages.json` + `tool.ts`），在 `src/tools/loader.ts` 中以 `deferred: true` 注册。`createDrawRemoteTool` 恒返回有效 `ToolRegistration`（不因运行期缺凭据跳过注册，确保离线/无凭据测试环境与 `prompts.test.ts` 一致；缺凭据在执行期报 `draw_remote_unconfigured`）。

### 3.1 参数 Schema（`schema.json`，严格 JSON）

| 参数 | 类型 | 必填 | 约束与语义 |
|---|---|---|---|
| `prompt` | `string` | 是 | 画面描述（去首尾空白后非空，上限 4000 字；`wan` 通道上限 800 字，执行期预检） |
| `images` | `string[]` | 否 | 媒体目录内参考图路径（兼容首尾方括号 `[inbound/xxx.jpg]`，去掉方括号后再校验），`maxItems: 5`；单张 ≤ 10 MiB，经 `fenceReadablePath` 防目录穿越与符号链接，按真实文件魔数校验 MIME（`gpt` 认 png/jpg/webp/gif；`gemini` 认 png/jpg/webp 且总原始体积 ≤ 15 MiB 防超过 ~20 MB inline 载荷上限）。传了即走改图/图生图 |
| `aspect_ratio` | `string` | 否 | 枚举 `"1:1" \| "3:4" \| "4:3" \| "9:16" \| "16:9"`。`gemini` 透传 `generationConfig.imageConfig.aspectRatio`；`gpt` 与 `wan` 后端不支持该字段，安全忽略（提示词中写清构图） |
| `background` | `string` | 否 | 枚举 `"auto" \| "transparent" \| "opaque"`，缺省 `"auto"`。`gpt` 原生透传；`wan` 与 `gemini` 遇到显式 `"transparent"` 必须在发请求前明确报错拒绝（`draw_remote_no_transparent`），`"auto"`/`"opaque"` 忽略 |

### 3.2 通道能力矩阵与降级规则

| 通道 | `models.json` provider & 凭据 | 默认模型 | 参考图 `images` | `aspect_ratio` | `background=transparent` | 代理支持 |
|---|---|---|---|---|---|---|
| `gpt` | `openai-codex`（OAuth，锁内刷新） | `gpt-image-2.6-flare` | 支持（≤5 张，png/jpg/webp/gif） | 忽略 | 支持 | `createProxyFetch` |
| `wan` | `qwen-token-plan-cn`（API key + `baseUrl` 去 `/compatible-mode/v1`） | `wan2.7-image` | **预检拒绝**（`draw_remote_no_ref`） | 忽略 | **预检拒绝**（`draw_remote_no_transparent`） | `createProxyFetch`（先修其二进制响应支持） |
| `gemini` | `google-antigravity`（OAuth，锁内刷新 + 401 强刷重试一次） | `gemini-3.1-flash-image` | 支持（≤5 张，png/jpg/webp，总 ≤15 MiB） | 原生 `imageConfig.aspectRatio` | **预检拒绝**（`draw_remote_no_transparent`） | `createProxyFetch` |

> **代理二进制安全修复**：既有 `src/media/proxy-fetch.ts:70-82` 将响应体 `Buffer.concat(chunks).toString("utf8")` 后再构造 `new Response(text)`，会破坏 PNG/JPEG 二进制下载字节（`0x89` 变 `EF BF BD`）。本次一并将 `createProxyFetch` 改为保留原始 `Buffer` 构造 `Response`，文本与二进制响应均原样无损。

### 3.3 执行时序、`submitted` 防重提矩阵与出口语义

1. **入口总闸**：每次 `execute` 先热读 `deps.drawRemote?.() ?? DRAW_REMOTE_DEFAULTS`，若 `enabled === false` 立即抛 `draw_remote_disabled`（不触发 `onLongWork`，不占位 `rounds`）。
2. **轮状态检查**：按 `conversationId` 维护 `{ round, pending, submitted, used }`：
   - `round === undefined` → `draw_remote_round_missing`
   - `previous?.pending` → `draw_remote_inflight`
   - `previous?.round === round && previous.used` → `draw_remote_used`
   - `previous?.round === round && previous.submitted` → `draw_remote_uncertain`
3. **预检与能力校验（在 `submitted = true` 和 `onLongWork` 之前）**：
   - 校验 `prompt`（非空且不超限；`wan` 限 800 字，其余 4000 字）
   - 校验 `images` 路径围栏 / 魔数 MIME / 单张与聚合体积 / 张数上限
   - 校验通道能力闸（`wan` 拒 `images`、`wan`/`gemini` 拒 `background === "transparent"`）
4. **`onSubmitted` 同步提交钩子（仿 `src/tools/draw/tool.ts:135`）**：
   - 适配器完成 `models.json` provider 解析、`auth.json` 凭据读取与必要的前置 OAuth 刷新后，**在发起首个生成 HTTP POST 前同步调用 `onSubmitted()`**：
     - 再次热读 `enabled()`，若中途关闭则抛 `DrawRemoteDisabledError`（`submitted` 保持 `false`）；
     - 置 `state.submitted = true`；
     - 触发 `deps.onLongWork?.("draw_remote", round)`（发送 `prompt/messages.md` 的 `working_draw_remote`）。
   - 这样 `unconfigured`、前置参数错误、通道能力拒接与前置 OAuth 刷新失败都不会误发「稍等」提示，也不会锁死本轮。
5. **`submitted` 锁死边界矩阵（`DrawRemoteError.submitted: boolean`）**：
   - **`submitted = false`（不锁死本轮，可修正参数或切换通道后重试）**：`disabled`、`unconfigured`（点名缺的是 `models.json` provider 还是 `auth.json` 凭据）、`prompt`、`bad_ref`、`no_ref`、`no_transparent`、前置 OAuth 刷新失败、上游明确 4xx 确定性拒绝（400/403/413/422/429，含安全拒答与内容审核）。
   - **`submitted = true`（结果不明，本轮重试报 `draw_remote_uncertain` 防重复出图）**：上游 5xx、内部超时、发出生成 POST 后的网络异常、取消信号在 POST 发出后触发（含落盘/入队前 abort）。
6. **超时与取消**：工具外层超时覆盖 `draw_remote: 210` 秒；各 provider 内部请求超时 180 秒，与 `context.abortSignal` 经 `AbortSignal.any` 合并（注意：Gemini 实测偶发 65s，若 401 强刷重发最坏可能触达 210s 外层超时，超时即 abort）。多图落盘逐张复核 `signal?.throwIfAborted()`，取消后禁止写 `gen/` 或入 outbox。
7. **机械直发与家族隔离**：
   - 生成文件按真实字节魔数 `extensionOf(bytes)` 落盘到 `<mediaRoot>/gen/<ts>-<uuid>.<ext>`，随后逐张经 `enqueueOutbound` 自动发出（幂等键 `${conversationId}:draw_remote:${round}:${file}`，带触发消息引用锚点）；入队失败时回退文案提示模型改用 `say_media` 补发，图不丢。
   - **修复 `src/app/runtime.ts:596` 家族推导**：将 `tool.startsWith("draw_") ? "draw" : tool` 改为仅聚合本地变体 `const DRAW_VARIANTS = new Set(["draw_fast", "draw_interaction"]); const family = DRAW_VARIANTS.has(tool) ? "draw" : tool;`，避免 `draw_remote` 被吞进 `draw` 家族。
   - `src/zero-egress-nudge.ts` 的 `DIRECT_EGRESS_TOOL_FAMILIES` 用 `"draw_remote"` 替换 `"wan_image"`（`test/zero-egress-nudge.test.ts` 移除已删除的 `gpt_image` 断言，并新增 `draw_remote` 豁免测试）。
   - `draw_remote_failed` 回执文案附带引导（「请用 say_words 简单告知群友画图失败原因」），避免已发「稍等」且豁免零出口补跑时让群友干等。
8. **外部文本与错误脱敏**：所有上游错误正文与安全拒答文本在返回给模型前，先经秘密脱敏（抹除已知 `access`/`refresh`/`key`/`clientSecret` 及通用 `Bearer`/`sk-`）再经 `sanitizeExternalText`（`src/external/sanitize.ts`，守住硬约束 17）。

## 4. 热配置规范（`fish.config.json`）

在 `src/fish-config.ts` 新增受控热字段 `drawRemote`（`effect: "hot"`）：

```json
{
  "drawRemote": {
    "enabled": true,
    "provider": "gemini",
    "models": {
      "gpt": "gpt-image-2.6-flare",
      "wan": "wan2.7-image",
      "gemini": "gemini-3.1-flash-image"
    }
  }
}
```

- **校验规则（`checkDrawRemote`）**：
  - 必须是普通对象（非数组/null）。
  - **凭据禁写红线**：顶层或 `models` 内若出现大小写不敏感匹配 `apiKey` / `key` / `token` / `access` / `refresh` / `secret` 的键，整块返回 `{ ok: false, reason: "drawRemote.<path> 不得写入 fish.config.json，凭据放 config/auth.json" }`（同 `checkVoices` 规则）。
  - **点路径错误文案契约（配合 `src/tools/config/tool.ts:165-168` `targetProblem` 子串匹配）**：每个子字段报错必须字面包含完整路径：
    - `drawRemote.enabled 必须是 true/false`
    - `drawRemote.provider 仅支持 gpt / wan / gemini`
    - `drawRemote.models 必须是对象`
    - `drawRemote.models.<k> 必须是非空字符串`
    - `drawRemote.models.<k> 不是受控通道，已忽略`
    - `drawRemote.<k> 不是受控字段，已忽略`
  - `models` 浅合并默认表（只改一个通道不冲掉其余通道默认值）；`DRAW_REMOTE_DEFAULTS` 与其 `models` 均 `Object.freeze` 防止误改共享默认对象。
  - 文件整块校验失败（含所有键均非法）在 `loadFishConfig` 中记告警并回落默认；经 `config set` 修改时由 `config/tool.ts` 的 `targetProblem` 或 `!result.ok` 直接拒绝写盘，不破坏原文件。
- **主人私聊热切换**：将 `"drawRemote"` 加入 `src/tools/config/tool.ts:48` 的 `OBJECT_CONFIG_FIELDS`，原生支持两层点路径（`config set drawRemote.provider gpt`、`config set drawRemote.enabled false`、`config set drawRemote.models.gemini ...`）热生效，无需重启。
- **与 `config/models.json` 的关系**：
  - `draw_remote` 在每次调用时按 `modelsPath`（`deps.modelsPath ?? MODELS_CONFIG_PATH`）现读对应 provider 的端点与代理，并按同目录 `join(dirname(modelsPath), "auth.json")`（测试可显式传 `credentialsPath` 覆盖）现读凭据，零重启热生效。
  - `config/models.json` 的 `models.image` 与 `models.wan_image` 角色保持向后兼容（`wan_gif` 仍消费 `models.wan_image`、`test/models.test.ts` 不破）；`AGENTS.md` 同步注明远程生图模型选择已收归 `fish.config.json` 的 `drawRemote` 热配置。

## 5. Gemini 通道协议细节（已在线实测验证）

- **端点**：`POST ${baseUrl}/v1internal:generateContent`（`baseUrl` 读自 `config/models.json` 的 `providers["google-antigravity"].baseUrl`，缺省 `ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com"`，去尾斜杠；实测 `daily` 桶已验证文生图 1408×768 与图生图+`3:4` 896×1200）。
- **请求头**：`content-type: application/json`、`authorization: Bearer <access>`、`user-agent: <provider.userAgent?.trim() || antigravityUserAgent()>`。
- **projectId 来源**：优先读 `auth.json` 的 `google-antigravity.projectId`；缺失时按同一 `baseUrl`、`userAgent`、`proxyFetch` 调 `discoverProject` 兜底，仍拿不到抛 `DrawRemoteError(code="unconfigured", submitted=false)`。
- **请求体**：
  ```json
  {
    "project": "<projectId>",
    "model": "<model>",
    "userAgent": "antigravity",
    "requestId": "<uuid>",
    "request": {
      "contents": [{ "role": "user", "parts": [/* 可选 inlineData 参考图 */, { "text": "<prompt>" }] }],
      "generationConfig": {
        "responseModalities": ["IMAGE", "TEXT"],
        "imageConfig": { "aspectRatio": "3:4" }
      }
    }
  }
  ```
- **OAuth 刷新**：
  - 过期前 60s 内：在 `fileCredentialStore(credentialsPath).modify("google-antigravity", ...)` 跨进程文件锁内复查 `expires`，由 `refreshGoogleTokens` 刷新并原子回写（保留 `projectId`/`tier`/`email`）；
  - 未过期但首调返回 HTTP 401：在锁内按 `usedAccess` 复查（`current.access !== usedAccess` 说明已被其它进程刷新直接复用，否则强刷一次），最多重试 1 次。
- **响应提取**：遍历 `(json.response?.candidates ?? json.candidates)?.[0]?.content?.parts`，解码所有 `inlineData.data`，逐张核对 `signal?.throwIfAborted()` 与 `bytes.length >= 1024`，按 `extensionOf(bytes)` 落盘到 `<mediaRoot>/gen/`；若无图返回则提取 `finishReason`/文本拒答（经脱敏 + `sanitizeExternalText`）抛 `DrawRemoteError`（明确拒答/4xx 标 `submitted: false`，异常空包标 `submitted: true`）。

## 6. 验收标准

1. `npm test` 全部通过（含新建 `test/draw-remote-config.test.ts`、`test/draw-remote-media.test.ts`、`test/draw-remote.test.ts`，以及更新后的 `test/tools.test.ts`、`test/zero-egress-nudge.test.ts`、`test/prompts.test.ts`）。
2. `npm run prompts` 正常输出（31 个工具包，含 `draw_remote`，无 `gpt_image`/`wan_image`，无 key 冲突与死文案）。
3. `scripts/real-model-smoke.ts`、`README.md`、`.env.example`、`AGENTS.md`、`fish.config.example`、`prompt/runtime.md`、`prompt/messages.md` 同步收口，全仓源码与提示词无悬空 `gpt_image` / `wan_image` 工具引用。
