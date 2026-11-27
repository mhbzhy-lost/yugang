# draw_remote 异步化改造 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 将 `draw_remote` 从同步阻塞工具改为异步受理工具（预检通过立即返回，后台最长等 10 分钟并记录分阶段耗时，成功后经 outbox 机械直发图片并写 transcript，失败静默只打日志），彻底消除工具超时与群聊阻塞。

**Architecture:** 拆分为四层改动：(1) `src/media/draw-remote/*` 统一放宽默认 HTTP 超时至 600s、补齐 `prepare`/`post`/`parse`/`download` 分阶段耗时回调与同步预检函数 `preflightDrawRemote`；(2) `Fish.enqueue` 扩展可选 `{ recordTranscript?: boolean }` 以在轮外单事务原子写入 `fish.outbound` + `fish.outbox`，并修补 `drain` 并发跳过竞态；(3) `src/tools/draw_remote/` 改为实例级每群单飞异步受理，取消 `onLongWork` 机械提示，后台任务挂整体超时硬顶（660s）与停机信号，完成后走宿主注入的 `deliverDrawRemote` 投递；(4) `src/app/runtime.ts` 与 `src/zero-egress-nudge.ts` 移除 `working_draw_remote`、210s 工具超时覆盖与零出口豁免，在 `drainOnStop()` 顶部切断后台任务并接入投递+冲刷链路。

**Tech Stack:** TypeScript (Node native test runner `node:test`), `@earendil-works/pi-durable`, OneBot outbox (`OutboxDoc` + `OutboundEntry`).

**Spec:** 本会话用户已拍板的 4 项架构决策（2026-11-27）：
1. 后台等待远程 API 的 HTTP 超时上限放宽到 **10 分钟（600s）**，并补分阶段耗时日志，防僵尸连接挂死（含前置 OAuth 刷新 / `discoverProject` 在内的整体任务硬顶 660s）。
2. 后台生图**成功**经 outbox 机械直发图片并记入 `fish.outbound` transcript；**失败**静默只打日志，不往群里发失败提示。
3. 取消宿主机械「稍等」提示（移除 `working_draw_remote` 与 `onLongWork` 调用），由模型在工具立即返回后本轮自行用 `say_words` 告知群友，并把 `draw_remote` 移出 `DIRECT_EGRESS_TOOL_FAMILIES`。
4. 并发限制：**每群同时最多 1 个在途**（按 `chatKeyOf` 归群，同群不同人格共享同一在途槽；不同群可并发），单轮最多提交 1 次；进程重启时内存中的在途任务直接中止放弃，绝不重 POST。

**Independent Plan Review:** 已由 `plan-reviewer`（Claude Opus 5.5 High，只读独立审查）完成审查。3 条 Critical（C1 生产必跑预检、C2 后台 660s 整体硬顶覆盖前置准备 + `prepare` 阶段日志、C3 `drawRemoteAbort.abort()` 提前至 `drainOnStop()` 第一行）与 S1–S7 / M1–M5 已全部采纳修订入本计划。
- 关于 S6（轮内重试/零出口补跑开新 submission）：有在途任务时 `inflight` 会直接拦截；若前一次已很快静默失败（如 4xx），允许新 submission 重试一次，按既定设计接受。
- 关于 M4（极快出图时图片可能略早于模型 `say_words` 到达）：异步语义下自然行为，可接受。

## Global Constraints

- 模型可见的工具说明、参数 Schema 与工具专属回执文案唯一来自 `src/tools/draw_remote/{TOOL.md,schema.json,messages.json}`，代码中不得写第二份。
- 中心 `prompt/messages.md` 与工具 `messages.json` 不得留死文案（`test/prompts.test.ts:129` 扫描每个 key 必须以 `messages["…"]` 字面量出现；移除 `working_draw_remote` 与旧同步态 `draw_remote_*` key）。
- 唯一出口是 outbox：轮外发图必须经 `fish.enqueue(convId, payload, { recordTranscript: true })` + `drainLoop()`，严禁工具返回后复用工具 `ToolExecutionApi` / `ToolContext` 提交事务，严禁直接调 `emit()`。
- 不得修改 `src/harness.ts` 的 `.install(...)` 顺序（受 `test/harness-assembly.test.ts` 锁死）与 `src/index.ts` 的注册链（受 `test/index-registration.test.ts` 锁死）。
- 凭据与密钥绝不进入日志、prompt 或 transcript；预检读取 `models.json`/`auth.json` 的 JSON 解析异常必须 catch 后报不含原文的 `unconfigured`；后台失败日志只能打印已脱敏的 `error.message`（绝不 `console.error(error)` 打印带未脱敏 `cause` 的错误对象）。
- Git 提交使用 `git1`（不可用时回退 `git`），commit 格式 `type(scope): 中文祈使句`，不含 AI 署名。

## Review Focus

1. **工具返回后原轮清理 `triggerOf` 导致引用锚点丢失**：工具在受理瞬间必须把 `trigger = deps.triggerOf?.(round)`、`conversationId`、`round` 全部快照到后台任务闭包，不得在后台回调里再查 `triggerOf`。
2. **停机时序竞态（C3）与后台晚到投递**：`index.ts` 的 `onStop` 逆序为 `stopNews → stopEngage → drainOnStop → closeOnebot → closeFish`。`drawRemoteAbort.abort()` 必须在 `drainOnStop()` 第一行触发（且 `deliverDrawRemote` 入队前复核 `drawRemoteAbort.signal.aborted`），防止 `closeOnebot` 之后仍有后台任务 enqueue 并调用 `drainLoop` 把 outbox 队首卡死在 `sending` 10 分钟。
3. **前置 OAuth 刷新 / `discoverProject` 挂死（C2）**：`gpt-image.ts` 与 `gemini.ts` 的 600s 定时器仅覆盖 POST 之后；后台必须构造整体硬超时信号 `AbortSignal.any([停机信号, AbortSignal.timeout(DRAW_REMOTE_TIMEOUT_MS + 60_000)])` 并在日志中明确区分「停机中止 / 整体超时 / 通道内超时」，保证群槽位永不永久锁死。
4. **生产环境预检必跑与配置缺失不撒谎（C1 / S2 / S3）**：生产 `runtime.ts:492` 始终注入 `drawRemoteRun`，预检入口必须一律走 `deps.drawRemotePreflight ?? preflightDrawRemote`（不得用是否传入 `drawRemoteRun` 分支）；未注入 `deliverDrawRemote` 或 `drawRemoteSignal?.aborted` 时同步直接报错，不得谎报 `accepted`。
5. **取消机械「稍等」后的必答轮静音回归与轮外 drain 并发跳过（M5）**：移除 `onLongWork` 与 `working_draw_remote` 后必须同步将 `"draw_remote"` 从 `DIRECT_EGRESS_TOOL_FAMILIES` 移出；同时 `src/fish/drain.ts` 的 `drain()` 需记录并发跳过时的补冲标记，避免后台 enqueue 撞上正在收尾的 `drainConversation` 导致图片滞留 10 分钟过期。

---

### Task 1: 通道层放宽 600s 超时、补齐分阶段耗时遥测与同步预检

**Depends on:** `none` *(与 Task 2 文件无重叠，可并行)*

**Files:**
- Modify: `src/media/draw-remote/types.ts:1-138`
- Modify: `src/media/wan-image.ts:15-100`
- Modify: `src/media/draw-remote/wan.ts:40-135`
- Modify: `src/media/gpt-image.ts:32-150`
- Modify: `src/media/draw-remote/gpt.ts:18-84`
- Modify: `src/media/draw-remote/gemini.ts:34-309`
- Modify: `src/media/draw-remote/index.ts:1-122`
- Test: `test/draw-remote-media.test.ts`

**Interfaces:**
- Consumes: 现有 `src/media/draw-remote/*` 与 `src/media/{wan,gpt}-image.ts`、`readCredentialFile` (`src/model/config.ts`)
- Produces:
  - `export const DRAW_REMOTE_TIMEOUT_MS = 600_000;`（导出自 `src/media/draw-remote/types.ts` 及 `index.ts`）
  - `export const DRAW_REMOTE_JOB_TIMEOUT_MS = 660_000;`（600s 生成 + 60s 前置准备余量，导出自 `types.ts` 及 `index.ts`）
  - `export type DrawRemoteStage = "prepare" | "post" | "parse" | "download";`
  - `export interface DrawRemoteStageEvent { stage: DrawRemoteStage; ms: number; status?: number; urls?: number; bytes?: number; }`
    - 语义：`ms` 为该**单阶段**耗时（非累计）；`prepare` 在凭据读取/刷新/`discoverProject` 完成后触发一次；`post` 在收到 HTTP 响应头后触发（含 4xx/5xx，带 `status`）；`parse` 在 `response.json()` 完成后触发（带 `urls` 或解析图片数）；`download` 在每张图下载并读完字节后各触发一次（带 `bytes`）。
  - `DrawRemoteRunRequest.onStage?: (event: DrawRemoteStageEvent) => void` & `DrawRemoteChannelRequest.onStage?: (event: DrawRemoteStageEvent) => void`
  - `export interface DrawRemotePreflightRequest { provider: DrawRemoteProviderId; prompt: string; imagesCount: number; modelsPath: string; credentialsPath?: string; }`
  - `export function validateDrawRemoteInput(provider: DrawRemoteProviderId, prompt: string, imagesCount: number): string`（返回去空白后的 prompt，失败抛 `DrawRemoteError` `prompt` / `bad_ref`）
  - `export function preflightDrawRemote(request: DrawRemotePreflightRequest): string`（校验输入 + 同步检查 `models.json` 与 `auth.json`，不发网络请求；缺配置或 JSON 解析失败一律 catch 后抛不含凭据原文的 `DrawRemoteError(..., "unconfigured", ..., false)`）

- [ ] **Step 1: 在 `test/draw-remote-media.test.ts` 新增失败用例**

新增覆盖以下断言的测试：
1. `DRAW_REMOTE_TIMEOUT_MS === 600_000`、`DRAW_REMOTE_JOB_TIMEOUT_MS === 660_000`；`runQwenChannel` / `runWanChannel` 透传 `request.timeoutMs` 给 `generateWanImage`（用短 `timeoutMs: 40` + 挂起 fetch，验证约 40ms 触发超时且错误文案包含 `40ms` 与 `post`，大于等于 1000ms 时显示整秒如 `2 秒`）。
2. `generateWanImage` 与 `runQwenChannel` 触发 `onStage` 回调，顺序汇报 `post`（单阶段 `ms >= 0`、`status: 200`）、`parse`（`urls: 2`）、`download`（2 张图各发 1 次，带 `bytes`）；4xx 时仍发 `post` 事件带 `status: 400`；下载阶段超时时错误文案点明阶段 `download`。
3. `generateGptImages` / `runGptChannel` 与 `generateGeminiImage` / `runGeminiChannel` 顺序汇报 `prepare`、`post`、`parse` 阶段耗时（单阶段 `ms >= 0`），且默认超时常量均为 `600_000`。
4. `preflightDrawRemote` 同步预检：
   - 空 prompt / 超 4000 字抛 `DrawRemoteError(provider, "prompt", ..., false)`；
   - 参考图超限（qwen 4 张 / gpt 6 张）抛 `DrawRemoteError(provider, "bad_ref", ..., false)`；
   - 缺 `models.json` provider、wan/qwen 缺 `baseUrl`、缺 `auth.json` key 或类型不匹配（wan/qwen 要求非空 `api_key`，gpt 要求 `oauth` 含非空 `access`/`refresh`/`accountId`，gemini 要求 `oauth` 含非空 `access`/`refresh`）均同步抛 `DrawRemoteError(provider, "unconfigured", ..., false)`；
   - `auth.json` 写坏成非法 JSON（内含敏感假密钥 `sk-secret-leak-test`）时，抛 `unconfigured` 且错误文案绝不包含该密钥原文（S3）；
   - 配置齐全返回去空白后的 prompt，不发起任何 `fetch`。

- [ ] **Step 2: 运行测试确认新增用例失败**

Run: `node --test test/draw-remote-media.test.ts`
Expected: FAIL（缺少 `DRAW_REMOTE_TIMEOUT_MS`、`preflightDrawRemote`、`onStage` 与 `wan.ts` 未透传 `timeoutMs`）。

- [ ] **Step 3: 实现 `types.ts`、`wan-image.ts`、`wan.ts`、`gpt-image.ts`、`gpt.ts`、`gemini.ts`、`index.ts`**

1. `src/media/draw-remote/types.ts`：
   - 导出 `DRAW_REMOTE_TIMEOUT_MS = 600_000`、`DRAW_REMOTE_JOB_TIMEOUT_MS = 660_000`、`DrawRemoteStage`、`DrawRemoteStageEvent`、`DrawRemotePreflightRequest`。
   - `DrawRemoteRunRequest` 与 `DrawRemoteChannelRequest` 增加 `onStage?: (event: DrawRemoteStageEvent) => void`，更新注释默认超时为 600 秒。
   - 导出辅助函数 `formatTimeoutLabel(timeoutMs: number): string`（`< 1000` 返回 `${timeoutMs}ms`，`>= 1000` 返回 `${Math.round(timeoutMs / 1000)} 秒`，统一 M1）。
2. `src/media/wan-image.ts`：
   - `WanImageRequest` 新增 `timeoutMs?: number`（缺省 `600_000`）与 `onStage?: (event: { stage: "post" | "parse" | "download"; ms: number; status?: number; urls?: number; bytes?: number }) => void`。
   - 用 `request.timeoutMs ?? 600_000` 替换硬编码 `180_000`。
   - 追踪 `stage: "post" | "parse" | "download"` 与每阶段起点 `stageStart`：
     - `doFetch(POST)` 返回后立即调 `onStage({ stage: "post", ms: Date.now() - stageStart, status: response.status })`（含非 2xx）；
     - `response.json()` 完成后调 `onStage({ stage: "parse", ms: Date.now() - stageStart, urls: urls.length })`；
     - 每张图 `doFetch(url)` + `arrayBuffer()` 完成后调 `onStage({ stage: "download", ms: Date.now() - stageStart, bytes: bytes.length })`。
   - `catch` 中将当前 `stage` 附到非空 Error 对象 `(error as { stage?: string }).stage = stage` 再原样 `throw`。
3. `src/media/draw-remote/wan.ts`：
   - `DEFAULT_TIMEOUT_MS = DRAW_REMOTE_TIMEOUT_MS`；将 `timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS` 与 `onStage: request.onStage` 透传给 `generateWanImage`。
   - 超时分支读取 `(error as { stage?: string }).stage`，生成文案：`${provider} 生图超时（${formatTimeoutLabel(timeoutMs)}${stage ? `，阶段：${stage}` : ""}），结果不明`。
4. `src/media/gpt-image.ts` & `src/media/draw-remote/gpt.ts`：
   - 默认超时统一改为 `DRAW_REMOTE_TIMEOUT_MS`（600_000）；`GptImageRequest` 增加可选 `onStage?: (event: { stage: "prepare" | "post" | "parse"; ms: number; status?: number; urls?: number }) => void`；在凭据读取+提前刷新完成后发 `prepare`，POST 返回后发 `post`（带 `status`），`response.json()` 后发 `parse`；`runGptChannel` 透传 `onStage` 并用 `formatTimeoutLabel` 格式化超时文案。
5. `src/media/draw-remote/gemini.ts`：
   - `DEFAULT_TIMEOUT_MS = DRAW_REMOTE_TIMEOUT_MS`；`GeminiImageRequest` 增加可选 `onStage`；在凭据读取+刷新+`discoverProject` 完成后发 `prepare`，最终 POST 响应返回后发 `post`（带 `status`），`response.json()` 后发 `parse`；`runGeminiChannel` 透传 `onStage` 并用 `formatTimeoutLabel` 格式化超时文案。
6. `src/media/draw-remote/index.ts`：
   - 抽出 `validateDrawRemoteInput(provider, prompt, imagesCount): string`，`runDrawRemote` 与 `preflightDrawRemote` 共用。
   - 实现 `preflightDrawRemote(request)`：调 `validateDrawRemoteInput` → `readProviderConfig` → 按通道做同步文件校验（所有 `readCredentialFile` 调用包 `try/catch`，任何解析异常统一转 `unconfigured` 不带原文；wan/qwen 校验剥掉 `COMPAT_PREFIX` 后的 `baseUrl` 与非空 `api_key`；gpt 校验 `oauth` 含非空 `access`/`refresh`/`accountId`；gemini 校验 `oauth` 含非空 `access`/`refresh`；不发任何网络请求）。
   - `runDrawRemote` 透传 `onStage: request.onStage`。

- [ ] **Step 4: 运行测试验证全部通过**

Run: `node --test test/draw-remote-media.test.ts`
Expected: PASS（原有与新增全部绿）。

- [ ] **Step 5: Commit**

```bash
git1 add src/media/draw-remote/ src/media/wan-image.ts src/media/gpt-image.ts test/draw-remote-media.test.ts
git1 commit -m "feat(draw_remote): 放宽通道超时至十分钟并补分阶段耗时与同步预检"
```

---

### Task 2: 扩展 `Fish.enqueue` 支持轮外原子写 transcript、修复 drain 并发跳过竞态并补齐异步投递依赖类型

**Depends on:** `none` *(与 Task 1 文件无重叠，可并行)*

**Files:**
- Modify: `src/fish/types.ts:65-75,180-191`
- Modify: `src/fish/output.ts:1-37`
- Modify: `src/fish/drain.ts:155-172`
- Modify: `src/tools/types.ts:137-146`
- Modify: `src/fish/tool-surface.ts:42-48`
- Test: `test/fish-enqueue-transcript.test.ts` (Create)

**Interfaces:**
- Consumes: `OutboundEntry`（定义于 `src/tools/say-shared.ts:42`，注意**不在** `src/store.ts`；`say-shared.ts` 不依赖 `src/fish/*`，无循环引用）、`OutboxDoc` (`src/store.ts`)、`OutboundPayload` (`src/tools/say-shared.ts`)
- Produces:
  - `Fish.enqueue(conversationId: ConversationId, payload: OutboundPayload, options?: { recordTranscript?: boolean }): Promise<void>`
  - `FishOptions.deliverDrawRemote?: (conversationId: ConversationId, payloads: readonly OutboundPayload[]) => Promise<void>`
  - `FishOptions.drawRemoteSignal?: AbortSignal`
  - `ToolPackageDeps.deliverDrawRemote?: (conversationId: ConversationId, payloads: readonly OutboundPayload[]) => Promise<void>`
  - `ToolPackageDeps.drawRemoteSignal?: AbortSignal`
  - `ToolPackageDeps.drawRemotePreflight?: typeof import("../media/draw-remote/index.ts").preflightDrawRemote`
  - `ToolPackageDeps.onDrawRemoteSettled?: (event: { conversationId: string; status: "ok" | "failed" | "aborted"; files?: string[]; error?: unknown }) => void`

- [ ] **Step 1: 创建 `test/fish-enqueue-transcript.test.ts` 编写失败用例**

测试覆盖：
1. 默认 `fish.enqueue(conv.id, payload)` 仅写入 `OutboxDoc`，不向会话 transcript 追加 `fish.outbound` entry（保持机械提示旧语义）。
2. `fish.enqueue(conv.id, payload, { recordTranscript: true })` 在同一次 commit 中同时写入 `OutboxDoc` 与 `fish.outbound` transcript entry（`entry.data` 含 `media` / `key` / `quoteId`），随后 `fish.drain()` 发出消息后 `SentmapDoc` 能成功关联到该 `entryId`。
3. `drain()` 并发跳过补冲（M5）：当会话 A 正在执行 `emit` 期间，另一条后台消息入队并调用 `fish.drain([conv.id])`；第一趟 `drain` 完成后应自动补冲新入队的那条消息，不会遗留在 `OutboxDoc` 中等待下一次事件。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/fish-enqueue-transcript.test.ts`
Expected: FAIL（`recordTranscript: true` 未写入 `fish.outbound` entry，且并发跳过未补冲）。

- [ ] **Step 3: 实现 `src/fish/output.ts`、`src/fish/drain.ts`、`src/fish/types.ts`、`src/tools/types.ts`、`src/fish/tool-surface.ts`**

1. `src/fish/output.ts`：从 `../tools/say-shared.ts` 导入 `OutboundEntry`，在 `enqueue(conversationId, payload, options)` 的 `state.harness.commit` 回调中，若 `options?.recordTranscript` 为真先执行 `await tx.appendEntry(OutboundEntry, conversationId, { data: payload })`，再 `doc.queue.push({ ...payload, status: "queued", attempts: 0 })`。
2. `src/fish/drain.ts`：在 `installDrain` 内增加局部 `const redrain = new Set<string>()`；当 `drain()` 遍历到某 `conversationId` 发现 `state.sending.has(key)` 时执行 `redrain.add(key); continue;`；在正在执行的会话的 `while` 循环中（`try/finally` 内）每次 `drainConversation` 返回且 `redrain.has(key)` 时清掉标记再复查一次 `drainConversation`（仅在未因发送异常中断且队列非空时继续），彻底消除轮外 enqueue 撞上 `drain` 收尾窗口的遗漏。
3. `src/fish/types.ts`：更新 `Fish.enqueue` 签名；在 `FishOptions` 新增 `deliverDrawRemote`、`drawRemoteSignal`。
4. `src/tools/types.ts`：在 `ToolPackageDeps` 新增 `deliverDrawRemote`、`drawRemoteSignal`、`drawRemotePreflight`、`onDrawRemoteSettled`。
5. `src/fish/tool-surface.ts`：在 `packageDeps` 中透传 `options.deliverDrawRemote`、`options.drawRemoteSignal`。

- [ ] **Step 4: 运行测试验证通过（含装配入口契约）**

Run: `node --test test/fish-enqueue-transcript.test.ts test/harness-assembly.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git1 add src/fish/output.ts src/fish/drain.ts src/fish/types.ts src/tools/types.ts src/fish/tool-surface.ts test/fish-enqueue-transcript.test.ts
git1 commit -m "feat(fish): 扩展轮外 enqueue 写 outbound 记录并修复并发 drain 补冲"
```

---

### Task 3: 将 `draw_remote` 工具包改为异步受理与每群单飞后台直发

**Depends on:** `Task 1`, `Task 2`

**Files:**
- Modify: `src/tools/draw_remote/messages.json:1-15`
- Modify: `src/tools/draw_remote/TOOL.md:1-33`
- Modify: `src/tools/draw_remote/tool.ts:1-258`
- Test: `test/draw-remote.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `DRAW_REMOTE_TIMEOUT_MS`, `DRAW_REMOTE_JOB_TIMEOUT_MS`, `preflightDrawRemote`, `runDrawRemote`, `DrawRemoteStageEvent`, `DrawRemoteError`, `errorMessage`, `isAbortError`, `isTimeoutError`
  - Task 2: `deps.deliverDrawRemote`, `deps.drawRemoteSignal`, `deps.drawRemotePreflight`, `deps.onDrawRemoteSettled`, `deps.chatKeyOf`
- Produces:
  - 异步 `createDrawRemoteTool(manifest, deps)`：同步预检（一律走 `deps.drawRemotePreflight ?? preflightDrawRemote`）+ `deliverDrawRemote` 可用性与 `drawRemoteSignal` 未中止校验通过后立即返回 `draw_remote_accepted`，不调 `onLongWork`；按群（`deps.chatKeyOf?.(convKey) ?? convKey`）限 1 个在途任务，后台挂 660s 整体硬超时与停机信号，画完走 `deliverDrawRemote` 直发，失败静默只打已脱敏 `message` 日志并在 `finally` 释放槽位。

- [ ] **Step 1: 重写并补充 `test/draw-remote.test.ts` 的异步行为失败用例**

在 `setup()` 中提供默认 `deliverDrawRemote`（把 payloads 收集进 `fixture.outbox`）与默认轻量 `drawRemotePreflight`（复用 `validateDrawRemoteInput`，不碰真实磁盘；同时单设用例验证未传 `drawRemotePreflight` 时默认真走 `preflightDrawRemote` 读临时 `models.json`/`auth.json`，覆盖 C1！）。覆盖以下全部场景（通过 `onDrawRemoteSettled` 确定性等待后台结束，零 `setTimeout` 竞态）：
1. **即时受理与不阻塞**：`drawRemoteRun` 挂起在一个手动 resolve 的 deferred Promise 上；调用 `tool.execute(...)` 立即返回 `draw_remote_accepted`（含当前 `provider` 名、提示用 `say_words` 告知群友、劝阻 `say_media`），且 `longWorks` 为空（绝不调用 `onLongWork`）。
2. **后台成功直发与快照引用锚点（Review Focus #1）**：在 `tool.execute` 返回后立刻把 `triggerOf` 置为返回 `undefined`（模拟原轮结束清理 `triggerOf` Map），然后 resolve deferred 返回两张图；后台通过 `deliverDrawRemote(convId, payloads)` 投递，每条 payload 保留受理时快照的 `quoteId: 5001`、`quoteForce: true`、`media: "gen/<file>"`、`key: "<conv>:draw_remote:<round>:<file>"`；完成后释放同群槽位，下一轮可继续画。
3. **每群单飞（含同群不同人格共享槽位 S7）+ 跨群真并发**：
   - 同一群（`chatKeyOf` 返回相同 `qq:group:1` 的两个不同 `conversationId`）在上一张仍在途时，第二个会话再调 `draw_remote` 同样抛 `draw_remote_inflight`；
   - 不同群（不同 `chatKeyOf` 或未注入 `chatKeyOf` 时的不同 `conversationId`）可同时各自有 1 个在途任务互不阻塞。
4. **单轮最多提交 1 次**：同一轮上一张即使瞬间画完释放了在途槽位，同轮再调用仍抛 `draw_remote_used`。
5. **同步预检失败不占槽、不锁轮（含 C1 / S2）**：
   - `drawRemote.enabled === false` → 抛 `draw_remote_disabled`；
   - 未注入 `deliverDrawRemote` → 同步抛 `draw_remote_unconfigured`，绝不回 `accepted`（S2）；
   - `drawRemoteSignal` 已经 `aborted` → 同步抛 `draw_remote_disabled`，绝不回 `accepted`（S2）；
   - `prompt` 为空或超 4000 字 → 抛 `draw_remote_prompt`；
   - 参考图越界/软链/非图/魔数不符/超 10MB/超通道上限/不支持 MIME → 抛 `draw_remote_bad_ref`；
   - 未覆盖 `drawRemotePreflight`、即使传入了 `drawRemoteRun` 桩时，缺 `models.json`/`auth.json` 仍真实触发 `preflightDrawRemote` 同步抛 `draw_remote_unconfigured`（C1 回归测试！）；
   - 以上失败后，同轮修正参数或重新打开开关均可立即重试成功。
6. **后台失败静默只打日志、释放槽位、不泄密（S4 / S5 / Review Focus #3）**：
   - 后台抛 `DrawRemoteError`（4xx/5xx/超时）、普通网络异常、`deliverDrawRemote` 抛错、返回空 `files`、或 `onSubmitted` 瞬间发现 `enabled === false` → **不向群里发任何失败文案**，只打印不含 `cause` 对象的错误消息，释放同群槽位，且 `onDrawRemoteSettled` 恰好触发一次（即使回调自身抛错也不会二次触发或造成 unhandledRejection）。
7. **停机取消信号与整体硬超时（Review Focus #2 / C2）**：
   - `drawRemoteSignal` 在后台执行中 abort → 传给 `drawRemoteRun` 的 `signal` 同步 aborted；即使桩无视 signal 晚到返回图片也不得调 `deliverDrawRemote`，槽位正常释放，状态为 `aborted`。
   - 传给 `drawRemoteRun` 的 `signal` 在整体硬顶超时触发时自动 abort（可通过内部可选注入 `jobTimeoutMs` 或短超时测试验证），不会让槽位永久卡死。
8. **热切配置与多通道参数透传**：连续多轮热切 `provider` / `models`，每次按受理瞬间热配置决定通道与参考图上限；不传 `aspect_ratio` 不透传。
9. **文案契约**：校验 `messages.json` 全部 key 为 `draw_remote_*`，包含 `draw_remote_accepted`（含 `{{provider}}`、`say_words`、`say_media`），且移除同步旧 key（`draw_remote_done` / `draw_remote_done_fallback` / `draw_remote_failed` / `draw_remote_failed_uncertain` / `draw_remote_failed_internal` / `draw_remote_uncertain`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/draw-remote.test.ts`
Expected: FAIL（现有实现仍是同步等待且依赖旧 key）。

- [ ] **Step 3: 更新 `messages.json`、`TOOL.md` 与 `tool.ts`**

1. `src/tools/draw_remote/messages.json` 保留并更新为以下 8 个 key（全部在 `tool.ts` 以字面量 `messages["…"]` 引用，无死文案）：
   - `draw_remote_disabled`: `"远程画图已被主人关闭，暂时用不了"`
   - `draw_remote_round_missing`: `"无法确认当前轮次，暂时不能画图"`
   - `draw_remote_inflight`: `"这个群还有一张远程画图正在画，等这张画完再提下一张"`
   - `draw_remote_used`: `"这轮已经提交过远程画图任务了，不用再画"`
   - `draw_remote_prompt`: `"画面描述不合适：{{reason}}"`
   - `draw_remote_bad_ref`: `"参考图 {{ref}} 用不了：只能是媒体目录里的图片文件（png/jpg/webp/gif，部分通道不认 gif），单张 10MB 以内、最多 5 张（qwen 通道最多 3 张），不能是目录外的路径或链接"`
   - `draw_remote_unconfigured`: `"远程画图还没配置好：{{reason}}"`
   - `draw_remote_accepted`: `"已交给在线画师（{{provider}}）后台绘制，画好会自动发到群里；现在用 say_words 简短告诉群友已经开始画了，不用等出图，也不要再调 say_media"`
2. `src/tools/draw_remote/TOOL.md`：更新说明为异步工具语义（提交后立刻返回、后台画完自动直发群里、提交后用 `say_words` 告知群友正在画、不要调 `say_media`、每群同时最多画一张、单轮最多提交一次）。
3. `src/tools/draw_remote/tool.ts`：
   - 将 `inflight = new Map<string, AbortController>()`（key 为群锁键 `deps.chatKeyOf?.(convKey) ?? convKey`）与 `lastRound = new Map<string, unknown>()`（key 为 `convKey`）放在 `createDrawRemoteTool` 闭包内（实例隔离）。
   - 同步阶段：
     1. 入口总闸 `configOf().enabled === false` → `disabled`；
     2. `deps.drawRemoteSignal?.aborted` → `disabled`（停机中拒绝受理，S2）；
     3. `!deps.deliverDrawRemote` → `unconfigured`（缺宿主异步投递回调时不谎报受理，S2）；
     4. `LiveDoc` 取 `round` → 缺则 `round_missing`；
     5. 同群在途 `inflight.has(slotKey)` → `inflight`；
     6. 同轮已提交 `lastRound.get(convKey) === round` → `used`；
     7. 二次热读 `config = configOf()`，检查 `enabled`、`provider`、`model`；
     8. `prepareReferences(provider, args.images ?? [])` 校验参考图；
     9. **同步预检（C1）**：一律调用 `const preflight = deps.drawRemotePreflight ?? preflightDrawRemote`，传入 `{ provider, prompt, imagesCount: images.length, modelsPath }`，捕获 `DrawRemoteError` 按 `prompt` / `bad_ref` / `unconfigured` 映射为对应回执文案抛给模型；
     10. `context.abortSignal?.throwIfAborted()`。
   - 受理与后台派发：
     - 快照 `trigger = deps.triggerOf?.(round)`、`conversationId = api.conversationId`、`started = (deps.now ?? Date.now)()`、`deliver = deps.deliverDrawRemote`。
     - 构造后台任务独立 `jobController = new AbortController()`，叠加停机信号 `deps.drawRemoteSignal` 与整体任务硬超时定时器 `jobTimer = setTimeout(() => { jobTimedOut = true; jobController.abort(new DOMException("draw_remote job timeout", "TimeoutError")); }, DRAW_REMOTE_JOB_TIMEOUT_MS)`（`unref?.()`，防阻挡进程退出，覆盖 C2）。
     - 登记 `inflight.set(slotKey, jobController)`、`lastRound.set(convKey, round)`。
     - 启动 `void (async () => { ... })().catch(() => {})` 后台任务（绝不依赖当前轮 `api` 或 `context.abortSignal`，S5）：
       - 记录 `let settled: { status: "ok" | "failed" | "aborted"; files?: string[]; error?: unknown } = { status: "failed" }` 与 `const stages: DrawRemoteStageEvent[] = []`；
       - 调用 `run({ provider, model, prompt: cleanedPrompt, images, aspectRatio, mediaRoot, modelsPath, timeoutMs: DRAW_REMOTE_TIMEOUT_MS, signal: jobController.signal, onStage: (ev) => stages.push(ev), onSubmitted: () => { if (configOf().enabled === false) throw new DrawRemoteError(provider, "disabled", "draw_remote 已被热关闭（drawRemote.enabled=false），请求未发出", false); } })`；
       - 完成后若 `jobController.signal.aborted` → 按 `jobTimedOut` 区分日志为整体超时或停机中止，不投递，`settled = { status: jobTimedOut ? "failed" : "aborted" }`；
       - 过滤 `files`（为空则抛 `new Error("draw_remote_empty")`）；
       - 构造每张图的 `OutboundPayload`（`items: []`, `media: "gen/" + file`, `quote: false`, 快照的 `quoteId`/`quoteForce`, `at: now()`, `key: "${convKey}:draw_remote:${String(round)}:${file}"`）；
       - 投递前再核 `jobController.signal.aborted`，调 `await deliver(conversationId, payloads)`；
       - 打成功日志：`[fish] draw_remote ok: ${provider} ${model} / ${files.length} 张 / ${now() - started}ms / 参考图${images.length}张` + 分阶段耗时摘要（如 `post=12340ms parse=12ms download=850ms`）；置 `settled = { status: "ok", files }`；
       - `catch (error)`：区分 `deps.drawRemoteSignal?.aborted`（停机中止）、`jobTimedOut`（整体硬顶超时）、`DrawRemoteError` 与其它异常，**只打印单行脱敏字符串（绝不传整个 `error` 对象进 `console.error`，S4）**，附总耗时与已记录阶段摘要，绝不向群里发失败消息；置 `settled`；
       - `finally`：`clearTimeout(jobTimer)`、解绑 `deps.drawRemoteSignal` 监听、仅当 `inflight.get(slotKey) === jobController` 时 `inflight.delete(slotKey)`，最后在 `try { deps.onDrawRemoteSettled?.({ conversationId: convKey, ...settled }); } catch {}` 中**恰好触发一次** settle 回调（S5）。
   - 立即返回 `{ output: [{ type: "text", text: say("accepted", { provider }) }] }`。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/draw-remote.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git1 add src/tools/draw_remote/ test/draw-remote.test.ts
git1 commit -m "feat(draw_remote): 改造为异步受理工具与每群单飞后台直发"
```

---

### Task 4: 宿主装配、移除机械「稍等」与零出口豁免、文档同步与全量验收

**Depends on:** `Task 2`, `Task 3`

**Files:**
- Modify: `src/zero-egress-nudge.ts:9-21`
- Modify: `prompt/messages.md:100-109`
- Modify: `src/app/runtime.ts:144-160,448-452,488-505,535-555,2509-2520`
- Modify: `test/zero-egress-nudge.test.ts:45-101`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Task 2 的 `Fish.enqueue(..., { recordTranscript: true })`、`FishOptions.deliverDrawRemote`、`FishOptions.drawRemoteSignal`；Task 3 的异步 `draw_remote` 工具包
- Produces: 完整的线上运行时接入、零死文案、零出口补跑保护与停机安全取消（`drainOnStop` 顶部先 abort）

- [ ] **Step 1: 先更新 `test/zero-egress-nudge.test.ts` 断言新契约（使其在改实现前失败）**

更新断言：
1. `assert.ok(!DIRECT_EGRESS_TOOL_FAMILIES.has("draw_remote"), "draw_remote 已改异步即时返回，不再豁免零出口补跑")`。
2. `shouldNudgeZeroEgress` 当 `workingTools: new Set(["draw_remote"])` 且 `sayCount: 0` 时返回 `true`。
3. `runtime.ts` 结构检查：
   - 保留 `DRAW_VARIANTS` 显式枚举检查；
   - 不再包含 `working_draw_remote` 与 `draw_remote: 210`；
   - 包含 `deliverDrawRemote`（内部含 `recordTranscript: true`、`drawRemoteAbort.signal.aborted` 守卫与 `drainLoop()`）和 `drawRemoteSignal`；
   - `drainOnStop` 函数体在 `fish.drain()` 之前先调用 `drawRemoteAbort.abort()`（覆盖 C3）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/zero-egress-nudge.test.ts`
Expected: FAIL（`DIRECT_EGRESS_TOOL_FAMILIES` 仍含 `draw_remote`，`runtime.ts` 仍有 `working_draw_remote` / `draw_remote: 210`）。

- [ ] **Step 3: 更新 `src/zero-egress-nudge.ts`、`prompt/messages.md`、`src/app/runtime.ts` 与 `AGENTS.md`**

1. `src/zero-egress-nudge.ts`：从 `DIRECT_EGRESS_TOOL_FAMILIES` 移除 `"draw_remote"`，同步顶部注释（说明 `draw_remote` 改为异步立即返回，需由模型本轮调用 `say_words` 告知群友）。
2. `prompt/messages.md`：移除已退役的 `working_draw_remote` 行。
3. `src/app/runtime.ts`：
   - `workingTextOf` 移除 `case "draw_remote":` 分支；
   - `toolTimeoutOverrides` 移除 `draw_remote: 210`，同步上方注释；
   - 在模块作用域定义 `const drawRemoteAbort = new AbortController();`；
   - 在 `openFish({ ... })` 中传入：
     - `drawRemoteSignal: drawRemoteAbort.signal`
     - `deliverDrawRemote: async (conversationId, payloads) => { if (drawRemoteAbort.signal.aborted) return; for (const payload of payloads) { if (drawRemoteAbort.signal.aborted) return; await fish.enqueue(conversationId, payload, { recordTranscript: true }); } if (!drawRemoteAbort.signal.aborted) await drainLoop(); }`
   - 在 `drainOnStop()` 第一行先调用 `drawRemoteAbort.abort();`，再执行 `fish.drain()`（C3：早于 `closeOnebot()` 切断后台新入队，绝不留 `sending` 队首卡死）；
   - 同步 `onLongWork` 注释（不再含 `draw_remote`）。
4. `AGENTS.md`：更新工具面说明、硬约束 4（`draw_remote` 异步直发）与第 15 节可观测性（`AGENTS.md:447` 移除 `draw_remote 210s（各通道内部请求 180s…）`，说明 `draw_remote` 改为异步受理立即返回、后台单次 HTTP 超时 600s / 整体硬顶 660s、成功经 outbox 机械直发并写 `fish.outbound` transcript、失败静默记日志、每群同时最多 1 个在途、不发 `working_draw_remote` 且不豁免零出口补跑）。

- [ ] **Step 4: 全量校验与测试**

Run: `npm run prompts && npm test`
Expected: `npm run prompts` 正常输出全部工具包清单（无死文案、无缺 key），`npm test` 全部测试通过，退出码 0。

- [ ] **Step 5: Commit**

```bash
git1 add src/zero-egress-nudge.ts prompt/messages.md src/app/runtime.ts test/zero-egress-nudge.test.ts AGENTS.md
git1 commit -m "feat(runtime): 接入 draw_remote 异步投递并移除同步超时与机械稍等提示"
```
