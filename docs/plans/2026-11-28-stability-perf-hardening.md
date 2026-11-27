# 鱼缸全仓性能与稳定性加固 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order (or Wave 1 Tasks 1–6 in parallel across isolated git worktrees, followed by Wave 2 Task 7 after integrating Wave 1). Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start Wave 2 before all Wave 1 tasks' tests pass and merge cleanly.

**Goal:** 修复全仓审查确认的全部运行期稳定性与性能问题（4 项 P0、18 项 P1、12 项 P2、6 项 P3），在不引入重启补偿复杂度的前提下消除崩溃、死锁、永久失联、内存/磁盘泄漏、事件循环冻结、流式破坏与重试风暴。

**Architecture:** 按严格互不重叠的文件所有权将改动分为两波：Wave 1 包含 6 个可独立测试、源文件零重叠的子系统任务（Auth/Model/Proxy、Async Media/Stores、External/Bili/Video、Memory/Prompt/Egress/Fish、Tools/Config/TTS、OneBot/Compact/Stats）；Wave 2（Task 7）在 Wave 1 合并后完成 `src/app/runtime.ts` 集成、可测状态模块抽取、断线快速丢弃与重连 `drain` 接线以及媒体热路径全异步切换（删除旧 `spawnSync` 包装）。

**Tech Stack:** Node.js >= 22（原生 TS 类型剥离运行，`node --test`）、`@earendil-works/pi-ai` / `pi-durable` 1.5.2、`https-proxy-agent` 9.1.0、`sharp` ^0.35.5、`fast-xml-parser` 5.11.2。

**Spec:** [audit_report.md](file:///Users/mhbzhy/.gemini/antigravity/brain/57c5d7e8-bede-490c-a2a5-32fef2996771/audit_report.md)（基于 `HEAD = 7fbe910`，已按用户裁定移除重启丢消息补发与复杂停机排空补偿）。

## Global Constraints

- **Node 直接执行 TS**：无 `tsconfig.json` / build 步骤，验收命令为 `npm test`（`node --test "test/*.test.ts"`，基线 325 pass / 0 fail）及 `npm run prompts`。
- **架构守卫不变量**：禁止改动 `src/index.ts` 与 `src/harness.ts`（`test/index-registration.test.ts` 与 `test/harness-assembly.test.ts` 严格锁定注册顺序与行数）；保持 `src/app/runtime.ts` 中 `async function compactWithGuard(` 的函数名与结构（`test/round-guard.test.ts` 与 `test/round-image-strip.test.ts` 依赖该函数名切片）；模型可见文案严禁写死在 `src/`，新增或复用工具回执一律走 `prompt/messages.md` 或各自 `messages.json`。
- **用户设计口径**：重启丢消息可接受，**不做**复杂重启补发或停机等待排空补偿；凡改键类型或删外置冗余状态以「减复杂度」为原则。
- **Git 纪律**：Git 操作优先 `git1`（不可用时回退 `git`）；commit 格式为 `type(scope): 中文祈使句`（≤50 字、无结尾句号、禁止任何 AI 署名）；在独立工作分支 / worktree 中执行，不直接脏改 `main`。
- **文件所有权隔离**：Wave 1 并发执行时，每个 Task 严格只修改自身 `Files` 列表中的源文件与测试文件，严禁越界编辑其他 Task 负责的文件。

## Review Focus

1. **跨容器锁崩溃回收**：`config/auth.json.lock` 的 `owner.host` 为已销毁容器随机 hostname，或同 `host` + 同 `pid` 但不同 `bootId`（重启 PID 复用）时，按规则安全自动回收，绝不永久等锁 30s 失败；且所有持锁刷新上限均严格 ≤15s（归属 Task 1）。
2. **走代理长流式生成与半包断流**：经 `createProxyFetch` 访问 SSE 模型时，必须在收到响应头立即流式吐出事件且保留 body 阶段逐 chunk 空闲超时；上游在 JSON 半包处断链抛出的错误必须命中 `pi-durable` `isRetryableAssistantError(...) === true`（归属 Task 1）。
3. **OneBot 断线、半开与畸形帧**：首次 `connect()` 失败仍按原样 reject，首次连上后断开/心跳超时自动退避重连且不并发多条 WS；收到含 `null` 段或抛错的异常帧时不得产生 `UnhandledPromiseRejection`（挂 `process.on("unhandledRejection")` 实测）（归属 Task 6）。
4. **并发换页与多轮抢占**：同一群并发进入 `compactWithGuard` 时按会话串行排队，非 `force` 拿锁后复判阈值，`force` 排在非 `force` 后不因前者 `below_threshold` 被误并掉；队列非空期间 `compacting` 持续保持；`/压缩` 遇忙以 `busy_reply` 拒绝（归属 Task 7）。
5. **异常/取消路径零残留**：`wan_gif` 无论成功/失败/取消均不残留 `.mp4`/半成品 `.gif`；`spawnCapture` 超时在子进程忽略 `SIGTERM` 时升级 `SIGKILL` 并仅在 `close` 后返回；`image-worker` `heif-convert` 临时目录由父进程创建并在 `finally` 兜底清理；`meme-store` 索引损坏备份拒写绝不清空全库（归属 Task 2）。

---

## Wave 1（Tasks 1–6：源文件与新增测试完全互斥，支持并行或串行）

### Task 1: Auth、Model 与 Proxy 流式稳定性加固

**Depends on:** `none`（Wave 1 并行候选组）

**Files:**
- Modify: `src/auth/credentials.ts`
- Modify: `src/auth/google.ts`
- Modify: `src/auth/openai.ts`
- Modify: `scripts/creds.ts`
- Modify: `src/media/proxy-fetch.ts`
- Modify: `src/model/config.ts`
- Modify: `src/model/google-code-assist.ts`
- Modify: `src/model/models.ts`
- Modify: `src/model/probe.ts`
- Modify: `src/model/quota.ts`
- Test (Modify): `test/models.test.ts`, `test/quota.test.ts`, `test/antigravity-adapt.test.ts`
- Test (Create): `test/auth-credentials.test.ts`, `test/proxy-fetch.test.ts`

**Interfaces:**
- Consumes: 既有 `src/auth/*`、`src/model/*`、`src/media/proxy-fetch.ts`
- Produces:
  - `createProxyFetch(proxyUrl: string, options?: ProxyFetchOptions): typeof fetch`（扩展既有 `options` 对象，支持 `idleTimeoutMs?: number`、`maxResponseBytes?: number`）
  - `ModelProbeOptions` 新增 `signal?: AbortSignal`
  - `createFishModels(config, options?: { registerGlobalProxy?: boolean })` 支持探活路径隔离局部 `fetch` 与局部 `oauth.refresh` 而不修改全局 `scopedProxies`
  - `buildProvider` 对配置了 `config.transport` 的 provider 自动注入默认 `transport` 到 `stream`/`streamSimple`

- [ ] **Step 1: 为 P0-3、P0-4、P1-1/2/4/5、P2-8/9 编写失败测试**
  - 在 `test/auth-credentials.test.ts` 覆盖：
    1. `fileCredentialStore.read()` / `list()` 将 `{ key: "sk-x" }` 与 `"sk-x"` 归一化为 `{ type: "api_key", key: "sk-x" }`；
    2. `reclaimStaleLock`：① 同 `host` + 同 `process.pid` 但不同 `bootId`（重启 PID 复用）**立即回收**；② 异机 `owner.host` 且 `owner.at`/`mtimeMs` 已过 `LOCK_STALE_MS` 自动回收；③ 未过期活锁继续等待；
    3. `google.ts` / `openai.ts` `refreshTokens` 拒绝非对象 JSON、`expires_in: NaN/0/-1`，并在未传 `signal` 时于默认超时中止（可传可测短超时选项或 mock `fetchImpl` 验证 signal 已带超时）。
  - 在 `test/proxy-fetch.test.ts` 覆盖：
    1. `createProxyFetch` 在本地 HTTP CONNECT 代理 mock 下，服务端分片推送 SSE 且未关闭连接时，客户端在收到首 chunk 即可读出，不必等 `end`；
    2. body 阶段超过 `idleTimeoutMs` 无新字节时主动中断流；收到新字节自动续期；
    3. 透传 `x-should-retry`、`retry-after-ms`、`retry-after`、`content-type` 响应头，且不透传 `content-encoding`（请求发送 `accept-encoding: identity`）；
    4. `maxResponseBytes` 超限时拒绝并销毁流；同 `proxyUrl` 复用 `keepAlive: true` 的 `HttpsProxyAgent`。
  - 在 `test/antigravity-adapt.test.ts` 覆盖：
    1. `google-code-assist` 默认内层重试次数为 `0`（429/503 默认单次请求，重试权交由外层 `pi-durable`；注：在注释中明确接受外层固定退避取舍）；`isImageFormat400` 剥图仅重试 1 次且不触发内层重试；
    2. `readSseEvents` 跳过 `[DONE]`、识别行内 `parsed.error` 并抛错、早退时调用 `reader.cancel()`；EOF 残留半包 JSON 抛出的错误消息经实测满足 `isRetryableAssistantError({ stopReason: "error", errorMessage }) === true`（使用命中正则的措辞，如 `"stream ended without completion (incomplete SSE chunk)"`）；
    3. `discoverProject` 的 `5000ms` 轮询响应 `AbortSignal` 立即退出。
  - 在 `test/models.test.ts` 与 `test/quota.test.ts` 覆盖：
    1. `probeModelConfig` 不覆写全局 `scopedProxies`，且同时将局部 `proxyFetch` 注入到模型流、`discoverProject` 与 OAuth `refresh`；`safeError` 抹除 `oauthClient.secret` 及 JSON 引号形式 `"refresh_token": "..."`；
    2. `providerProxyHosts` 包含 `daily-cloudcode-pa.googleapis.com` 与 `chatgpt.com`；
    3. `readCredentialFile` 遇损坏 JSON 不泄原文、非有限 `expires` 不令 `describeModel` 抛 `RangeError`；`loadProviderConfig` 缺 `models` 数组报语义错；
    4. `quota.ts` 在 `auth.json` 损坏时将该 provider 标记为 `error` 而不打崩整批 `queryQuotas()`。

- [ ] **Step 2: 运行新增测试确认 RED**
  - Run: `node --test test/auth-credentials.test.ts test/proxy-fetch.test.ts test/antigravity-adapt.test.ts test/models.test.ts test/quota.test.ts`
  - Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现 Auth 层修复（`credentials.ts`, `google.ts`, `openai.ts`, `scripts/creds.ts`）**
  - `src/auth/credentials.ts`：新增 `normalizeCredential(raw)`，将裸非空字符串与缺 `type` 但含非空 `key` 字符串的条目归一为 `{ type: "api_key", key }`；`load()` 与 `fileCredentialStore.read/list` 均走归一化。`LockOwner` 增加进程级常量 `BOOT_ID = randomUUID()` 字段 `bootId?: string`；`reclaimStaleLock` 在 `if (owner)` 中：
    1. 若 `owner.host === hostname()` 且 `owner.pid === process.pid` 且 `owner.bootId && owner.bootId !== BOOT_ID` → 必为同 PID 重启残留，**立即回收**；
    2. 若 `Date.now() - Math.max(owner.at || 0, before.mtimeMs) >= LOCK_STALE_MS` → 超过过期阈值，**允许回收**（并在注释写明不变量：所有持锁刷新任务超时 ≤15s ≪ `LOCK_STALE_MS` 120s）；
    3. 否则（未过期）：若 `owner.host !== hostname()` 返回 `false`；若 `processAlive(owner.pid)` 返回 `false`；其余（本机死进程）立即回收。
  - `scripts/creds.ts`：写入 `{ type: "api_key", key }`。
  - `src/auth/google.ts` & `src/auth/openai.ts`：`refreshTokens` 默认绑定 15s 超时（与入参 `signal` 用 `AbortSignal.any` 合并）；解析 token 校验 `json && typeof json === "object" && !Array.isArray(json)` 及 `typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0`；`openai.ts` `loginWithDeviceCode` 改用 `timers/promises` `setTimeout(waitMs, undefined, { signal })` 并在 `expired_token` / `access_denied` 时立即抛出终态错误。

- [ ] **Step 4: 实现 `src/media/proxy-fetch.ts` 流式重构与连接池复用**
  - 保持既有 `createProxyFetch(proxyUrl, options?: ProxyFetchOptions)` 签名并新增 `maxResponseBytes?: number`。
  - 按 `proxyUrl` 缓存 `new HttpsProxyAgent(proxyUrl, { keepAlive: true })`（不人为压低 `maxSockets`，避免长 SSE 阻塞同代理普通请求）。
  - 保留 `Request` 输入的 `method`/`headers`/`body`，默认附带 `accept-encoding: identity`；使用外层建连定时器覆盖 `CONNECT` 握手至收到 `response` 头。
  - 在 `httpsRequest` 的 `response` 回调中**立即 `resolve`**：
    - 透传响应头（跳过 hop-by-hop 头及 `content-encoding`，确保保留 `content-type`、`retry-after`、`retry-after-ms`、`x-should-retry`、`content-length` 等）；
    - `nullBodyStatus(status)` 时 body 为 `null` 并 `response.resume()`；
    - 否则构建流式 `ReadableStream` 读取 `response`：每收到 chunk 续期 `idleTimeoutMs` 空闲计时器（超时 `response.destroy(timeoutErr)`）；若设 `maxResponseBytes` 且累计超限则 `response.destroy(limitErr)`；`cancel()` 或 `init.signal` 中止时销毁 `request` 与 `response`。

- [ ] **Step 5: 实现 Model 层修复（`google-code-assist.ts`, `models.ts`, `probe.ts`, `quota.ts`, `config.ts`）**
  - `src/model/google-code-assist.ts`：`DEFAULT_MAX_RETRIES = 0`（注释说明交由外层 `pi-durable` 单点退避，消除 48× 放大）；`isImageFormat400` 降级分支显式 `maxRetries: 0`；`readSseEvents` 在 `finally` 中 `if (!done) await reader.cancel().catch(() => {})`，EOF 残留未闭合 `buffer` 时抛出命中 `pi-ai` `RETRYABLE_PROVIDER_ERROR_PATTERN` 的错误（如 `"Google stream ended without completion (incomplete SSE chunk)"`）；主循环跳过 `eventData === "[DONE]"`、检测 `parsed.error` 并抛含状态码与消息的错；`discoverProject` 为 `fetch` 补 20s 超时并用 `timers/promises` `setTimeout(5000, undefined, { signal })`。
  - `src/model/models.ts`：`providerProxyHosts` 补齐 `daily-cloudcode-pa.googleapis.com` 与 `chatgpt.com`；`createFishModels` / `buildProvider` 支持 `{ registerGlobalProxy?: boolean }`（默认 `true`）；当 `registerGlobalProxy === false` 且配置了 `config.proxy` 时，不写全局 `scopedProxies`，而是为该 provider 局部包装 `oauth.refresh`（透传 `proxyFetch`）与 `stream`/`streamSimple`（透传 `options.fetch = proxyFetch`）；当 `config.transport` 已配置时在包装层为未显式传 `transport` 的调用注入默认 `transport`。
  - `src/model/probe.ts`：`ModelProbeOptions` 加 `signal?: AbortSignal` 并与 `AbortSignal.timeout(options.timeoutMs ?? 25_000)` 合并；`probeModelConfig` 传 `{ registerGlobalProxy: false }`；`safeError` 补齐 `config.oauthClient?.secret` 并复用 `redactSecrets`（补 JSON 引号键名脱敏正则）。
  - `src/model/quota.ts`：为所有 `fetchImpl` 调用加 15s 超时信号；将 `queryProvider` 中的 `readCredentialFile` 移入 `try/catch` 内并脱敏错误。
  - `src/model/config.ts`：`readCredentialFile` 捕获 `JSON.parse` 仅抛不含原文的错误、校验 `parsed` 为非数组对象及 `expires` 为有限数字；`describeModel` 对非有限 `expires` 安全展示 `"未知"`；`loadProviderConfig` 校验 `Array.isArray(provider.models)`。

- [ ] **Step 6: 运行测试验证 GREEN 并提交**
  - Run: `node --test test/auth-credentials.test.ts test/proxy-fetch.test.ts test/antigravity-adapt.test.ts test/models.test.ts test/quota.test.ts && npm test`
  - Expected: 全部 PASS，0 fail。
  - Commit: `fix(model): 修复凭据锁与格式校验并重构代理流式与重试策略`

---

### Task 2: 媒体子进程强杀、异步图像底座与远程生图/存储加固

**Depends on:** `none`（Wave 1 并行候选组）

**Files:**
- Modify: `src/media/spawn-capture.ts`
- Modify: `src/media/image-ops.ts`
- Modify: `src/media/image-worker.ts`
- Modify: `src/media/shrink-image.ts`
- Modify: `src/media/gif-frames.ts`
- Modify: `src/media/wan-video.ts`
- Modify: `src/media/describe.ts`
- Modify: `src/media/video.ts`
- Modify: `src/media/meme-store.ts`
- Modify: `src/media/inbound-video.ts`
- Modify: `src/media/gpt-image.ts`
- Modify: `src/media/wan-image.ts`
- Modify: `src/media/draw-remote/gemini.ts`
- Modify: `src/media/draw-remote/gpt.ts`
- Modify: `src/media/draw-remote/wan.ts`
- Test (Modify): `test/gif-frames.test.ts`, `test/draw-remote-media.test.ts`
- Test (Create): `test/media-hardening.test.ts`

**Interfaces:**
- Consumes: 既有 `src/media/*`
- Produces:
  - `spawnCapture(command, args, options)`：`signal?.aborted` 时不 spawn 直接返回 `null`；已启动子进程遇 `signal`/超时/`stdout`或`stderr`超限时先 `SIGTERM`、1500ms 后 `SIGKILL`，收到 `exit` 后最多等 2s `close` 超时销毁 stdio，统一在进程结束后 settle
  - 新增异步图像 API（Wave 1 暂保留旧同步导出确保全仓测试绿，Wave 2 Task 7 切换全量调用方并删旧同步函数）：
    - `image-ops.ts`: `readFileHead(path: string, bytes: number): Buffer`, `shrinkViaWorkerAsync(file: string, signal?: AbortSignal): Promise<WorkerResult>`, `lookShrinkViaWorkerAsync(file: string, signal?: AbortSignal): Promise<Buffer | null>`, `normalizeInitViaWorkerAsync(file: string, signal?: AbortSignal): Promise<Buffer | null>`, `toJpegViaWorkerAsync(file: string, signal?: AbortSignal): Promise<Buffer | null>`（调 `spawnCapture` 显式传 `maxBytes: 64 * 1024 * 1024`，并由父进程建 `tempDir` 在 `finally` 清理 `heif-convert` 临时文件）
    - `shrink-image.ts`: `shrinkForModelAsync(input: { file: string; signal?: AbortSignal }): Promise<ShrinkResult>`, `inlineImageOfAsync(file: string, shrink?: (input: { file: string }) => ShrinkResult | Promise<ShrinkResult>, signal?: AbortSignal): Promise<InlineImageResult>`
    - `gif-frames.ts`: `extractGifFramesAsync(file: string, maxFrames: number, opts?: { shrink?: (input: { file: string }) => ShrinkResult | Promise<ShrinkResult>; signal?: AbortSignal }): Promise<GifFramePlan | null>`（可注入 `shrink` 兼容同步与异步测试桩）
  - `WanGifRequest` 支持可选 `proxy?: string`

- [ ] **Step 1: 为 P1-6(media)/8/10/12/13、P2-1/4/12 编写失败测试**
  - 在 `test/media-hardening.test.ts` 覆盖：
    1. `spawnCapture`：已中止 `signal` 不拉起子进程；对忽略 `SIGTERM` 的子进程超时后升级 `SIGKILL` 并在真正退出后才 resolve；`stderr` 超限同样终止子进程；
    2. `generateWanGif` 成功/失败/取消均不残留 `.mp4`（失败不残留 `.gif`）；已中止 `signal` 立即 reject 不空等 15s；`readWanGifRef` 拒绝伪装扩展名与符号链接；
    3. `addMeme` 当 `memes/index.json` 损坏时备份 `.corrupt.*` 并抛错，绝不清空原库；`checkMemeSource` 使用 `readFileHead` 仅读 16B；
    4. `describeImage` 429 退避期间响应 `AbortSignal` 立即中止；`describeVideoFrames` 并发 ≤ 2；`extractVideoFrames` 损坏 JSON 抛 `video_decode_failed`；
    5. `InboundVideoStore.bind()` 命中内存缓存不重复全扫 200 文件；
    6. `shrinkViaWorkerAsync` / `inlineImageOfAsync` / `extractGifFramesAsync` 异步可用且不阻塞事件循环定时器，父进程创建的 `heif` 临时目录在失败/超后被清理。
  - 在 `test/draw-remote-media.test.ts` 覆盖：
    1. `gpt` / `wan` 参考图总字节超 20MB 时拒绝；
    2. `gpt-image` / `wan-image` / `gemini` 第 2 张失败时回滚删除第 1 张已写文件，响应体超上限拒绝且 `!ok` 调 `body.cancel()`；
    3. `gpt-image` 将 `signal` 透传给 `store.modify` 且 `timeoutMs` 覆盖前置刷新。

- [ ] **Step 2: 运行测试确认 RED**
  - Run: `node --test test/media-hardening.test.ts test/draw-remote-media.test.ts test/gif-frames.test.ts`
  - Expected: 新增用例 FAIL。

- [ ] **Step 3: 加固 `spawn-capture.ts` 并提供异步图像底座（`image-ops.ts`, `image-worker.ts`, `shrink-image.ts`, `gif-frames.ts`）**
  - `src/media/spawn-capture.ts`：入口先判 `if (signal?.aborted) return null;` 不拉进程；改为显式监听 `signal` 与内部 `timeoutMs`，触发时执行 `terminate()`（`child.kill("SIGTERM")` + 1500ms 后 `child.kill("SIGKILL")`）；`stderr` 超 `maxBytes` 时同样 `terminate()`；`child.on("error")` 仅在 `!child.pid` 时立即 `finish(null)`；收到 `exit` 后若 2s 内未收到 `close` 则销毁 `stdout`/`stderr` 并 `finish`；清理全部定时器与监听器。
  - `src/media/image-ops.ts`：导出 `readFileHead(file, maxBytes)`（`openSync` + `readSync` + `closeSync`）；实现 `runWorkerAsync`：通过 `mkdtempSync(join(tmpdir(), "yugang-img-"))` 创建调用级临时目录经参数传给 `image-worker.ts`，调用 `spawnCapture(process.execPath, [WORKER, op, JSON.stringify({ ...args, tempDir })], { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024, signal })`，在 `finally` 中 `rmSync(tempDir, { recursive: true, force: true })`（彻底避免 `heif-convert` `spawnSync` 期间被 `SIGKILL` 遗留临时文件）。
  - `src/media/image-worker.ts`：魔数嗅探改 `readFileHead(file, 32)`；`isHeif` 品牌名 `.toLowerCase()`；`heif-convert` 输出优先落在传入的 `tempDir`；`opShrink` 先将原图解码并缩至一次 `1280px` 中间 Buffer 再逐档下探。
  - `src/media/shrink-image.ts` & `src/media/gif-frames.ts`：新增 `shrinkForModelAsync` / `inlineImageOfAsync` / `extractGifFramesAsync`（走 `spawnCapture` 调 `sips`/`ffprobe`/`ffmpeg` 与 `shrinkViaWorkerAsync`，可注入函数支持 `T | Promise<T>`），头部魔数改用 `readFileHead`。

- [ ] **Step 4: 修复 `wan-video.ts`, `describe.ts`, `video.ts`, `meme-store.ts`, `inbound-video.ts` 与 `draw-remote` 底层**
  - `src/media/wan-video.ts`：总超时设为 `1_150_000ms`（严格短于 `wan_gif` 1200s 工具超时）；临时 `.mp4` 写入 `os.tmpdir()` 并在 `finally` 中 `rmSync(tempVideo, { force: true })`；失败/取消时清理未完成 `output`；封装 `sleepCancellable(ms, signal)`（入口判 `signal.aborted`，到期 `removeEventListener`）；流式有界下载视频（50MB 上限）且 `!ok` 调 `body?.cancel()`；`readWanGifRef` 用 `lstatSync` 拒绝符号链接并用 `sniffImageMagic(readFileHead(real, 16))` 核验真实魔数；支持 `request.proxy`。
  - `src/media/describe.ts`：429 退避改用可中止睡眠 `sleepCancellable(waitMs, signal)`。
  - `src/media/video.ts`：`describeVideoFrames` 以并发度 2 运行；`extractVideoFrames` 包裹 `JSON.parse`/`lstatSync`/`realpathSync` 与类型校验，失败统一抛 `video_decode_failed`，抽帧超时取 `75_000ms`（< 90s 工具总超时）。
  - `src/media/meme-store.ts`：`checkMemeSource` 改用 `readFileHead(real, 16)`；新增 `loadMemeIndexForWrite(root)`：文件不存在返回 `[]`，存在但 JSON 损坏或非数组时备份至 `index.json.corrupt.<ts>` 并抛语义错阻止 `addMeme` 清空全库。
  - `src/media/inbound-video.ts`：按 `conversationId` 维护内存缓存（写盘时同步更新），`bind()` 命中缓存时不再对 200 文件反复执行同步 stat/read。
  - `src/media/gpt-image.ts`, `wan-image.ts`, `draw-remote/{gemini,gpt,wan}.ts`：流式有界读响应（JSON 48MB / 图片 25MB）与 `!ok` 调 `body?.cancel()`；先校验全部图片再落盘，或在 `catch` 回滚删已落盘文件；`gpt`/`wan` 加参考图总字节上限 `20 * 1024 * 1024`；`gpt-image.ts` 将 `{ signal: combinedSignal }` 透传给 `store.modify` 并将 `AbortSignal.timeout(timeoutMs)` 提前到入口覆盖前置刷新与 `discoverProject`。

- [ ] **Step 5: 运行测试验证 GREEN 并提交**
  - Run: `node --test test/media-hardening.test.ts test/draw-remote-media.test.ts test/gif-frames.test.ts && npm test`
  - Expected: 全部 PASS，0 fail。
  - Commit: `fix(media): 强化子进程回收与异步图像底座并修复媒体存储泄漏`

---

### Task 3: External 外部服务与 B 站/视频工具加固

**Depends on:** `none`（Wave 1 并行候选组）

**Files:**
- Modify: `src/external/bili-client.ts`
- Modify: `src/external/news-client.ts`
- Modify: `src/external/news-job.ts`
- Modify: `src/external/deepseek-search.ts`
- Modify: `src/external/scheduler.ts`
- Modify: `src/tools/video/tool.ts`
- Modify: `src/tools/bili_video/tool.ts`
- Modify: `src/tools/bili_search/tool.ts`
- Test (Modify): `test/bili-search.test.ts`, `test/deepseek-search.test.ts`, `test/news-preparation.test.ts`, `test/video-share.test.ts`
- Test (Create): `test/scheduler-hardening.test.ts`

**Interfaces:**
- Consumes: 既有 `src/external/*`、`src/tools/{video,bili_video,bili_search}/tool.ts`
- Produces:
  - `BiliClient` 各请求方法支持可选 `signal?: AbortSignal` 参数（保持原调用向后兼容）

- [ ] **Step 1: 为 P1-7/13(external)、P2-10(video/bili)、P2-12(news)、P3-3/5/6 编写失败测试**
  - 在 `test/bili-search.test.ts` 覆盖：
    1. `bili-client` 响应头返回 200 但响应体挂死超过 `timeoutMs` 时超时中断并释放全局 `enqueue` 锁，后续请求正常执行；
    2. 响应体超 4MB 上限拒绝并 `cancel()`；缺 `code` 的 `{}` 响应拒绝而非当成功 `code=0`；
    3. 外部 `AbortSignal` 取消时排队/间隔等待立即退出且不消耗预算；
    4. `bili_search` 在 `api.commit` 期间遇 `AbortError` 时调用 `release()` 归还额度并上抛。
  - 在 `test/news-preparation.test.ts` 与 `test/deepseek-search.test.ts` 覆盖：
    1. `news-client` 与 `deepseek-search` 在 `!res.ok` 和 `content-length` 超限路径调用 `res.body.cancel()`；
    2. `news-client` `parseRss` 正确通过 `textOf` 解析带属性的 `<title>`/`<link>` 混合节点，并支持 GBK 等声明编码；
    3. `news-job` `collect()` 抛错或返回空数组时触发退避等待而非零延迟紧循环打爆 4 次机会。
  - 在 `test/video-share.test.ts` 覆盖：
    1. `video` 参数/次数校验失败时不触发 `onLongWork`；`b23.tv` 展开后调用 `res.body.cancel()`；`opus` 计入观看次数且图片下载有字节上限；`AbortError` 原样上抛不被吞成 `"视频没打开"`；
    2. `bili_video` 与 `video` 透传 `context.abortSignal` 到 `BiliClient`。
  - 在 `test/scheduler-hardening.test.ts` 覆盖：
    1. `createScheduler` 无 `deps.jobs` 时按 `JOBS_TTL_DAYS` 裁剪 `memory` Map；`stop()` 后再调 `cycle()` 直接返回；`"24:00"` 与 `newsScheduledStartAt` 语义一致。

- [ ] **Step 2: 运行测试确认 RED**
  - Run: `node --test test/bili-search.test.ts test/deepseek-search.test.ts test/news-preparation.test.ts test/video-share.test.ts test/scheduler-hardening.test.ts`
  - Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现 `src/external/*` 加固**
  - `src/external/bili-client.ts`：为各接口与 `send()` 增可选 `signal?: AbortSignal`（进入 `enqueue` 前、轮到执行时、`spacingWait` 内与 `doFetch` 均监听取消）；将 `clearTimeout(timer)` 移至有界读体（4MB 上限 + `reader.cancel()`）完成后的统一 `finally`；严格校验 `typeof envelope["code"] === "number"`；预算与 `buvid3` 改 `mkdirSync + tmp + renameSync` 原子写；按 `mtimeMs` 缓存 `compileFilterPatterns`。
  - `src/external/news-client.ts` & `src/external/deepseek-search.ts`：在 `!res.ok` 与 `content-length` 超限抛错前均执行 `await res.body?.cancel().catch(() => {})`；`news-client.ts` `parseRss` 对 `title`/`link`/`description` 统一走 `textOf`（支持数组取首项），并根据 `Content-Type` / XML `encoding` 声明创建 `TextDecoder`（失败回退 `utf-8`）。
  - `src/external/news-job.ts`：`collect()` 异常或空料重抓前加可取消退避（15s / 30s，不晚于 `publishAt`）；`stop()` 重置 `expired` 与候选项缓存。
  - `src/external/scheduler.ts`：无 `deps.jobs` 时按 `JOBS_TTL_DAYS` 清理 `memory` Map；`cycle()` 首行加 `if (stopped) return;`；将 `"24:00"` 统一归一为次日 00:00（与 `newsScheduledStartAt` 一致）。

- [ ] **Step 4: 实现 `video` / `bili_video` / `bili_search` 工具加固**
  - `src/tools/video/tool.ts`：`onLongWork` 后移至参数与 `maxViews` 校验之后；`b23.tv` 展开后立即 `await res.body?.cancel().catch(() => {})`；透传 `context.abortSignal` 到 `BiliClient`；`opus` 分支对图片下载设 15MB 上限并记入 `recordVideoResource`；`catch` 中若为 `AbortError` 或 `signal?.aborted` 原样重抛。
  - `src/tools/bili_video/tool.ts`：`buildBiliVideoReport` 接收并透传 `signal` 到全部 `BiliClient` 调用。
  - `src/tools/bili_search/tool.ts`：`api.commit` 异常分支若 `context.abortSignal?.aborted` 则调用 `release()` 归还额度并重抛。

- [ ] **Step 5: 运行测试验证 GREEN 并提交**
  - Run: `node --test test/bili-search.test.ts test/deepseek-search.test.ts test/news-preparation.test.ts test/video-share.test.ts test/scheduler-hardening.test.ts && npm test`
  - Expected: 全部 PASS，0 fail。
  - Commit: `fix(external): 修复 B 站读体锁死、新闻流释放与视频工具取消透传`

---

### Task 4: Memory、Prompt、Egress 与 Fish 装配子模块加固

**Depends on:** `none`（Wave 1 并行候选组）

**Files:**
- Modify: `src/memory/extract.ts`
- Modify: `src/memory/publicize.ts`
- Modify: `src/memory/pending.ts`
- Modify: `src/memory/merge.ts`
- Modify: `src/memory/patch.ts`
- Modify: `src/memory/render.ts`
- Modify: `src/prompt/index.ts`
- Modify: `src/egress/seen-links.ts`
- Modify: `src/egress/absorb.ts`
- Modify: `src/egress/policy.ts`
- Modify: `src/fish/group.ts`
- Modify: `src/fish/drain.ts`
- Modify: `src/fish/extension.ts`
- Modify: `src/fish/startup.ts`
- Modify: `src/fish/memory-admin.ts`
- Modify: `src/fish/tool-surface.ts`
- Test (Modify): `test/memory-partial.test.ts`, `test/prompts.test.ts`, `test/policy.test.ts`, `test/durable.test.ts`, `test/startup.test.ts`, `test/fish-assembly.test.ts`

**Interfaces:**
- Consumes: 既有 `src/memory/*`、`src/prompt/index.ts`、`src/egress/*`、`src/fish/*`
- Produces:
  - `seen-links.ts`: `recordSeenLinks`/`seenLinksOf`/`clearSeenLinks` 内部统一 `String(round)`，兼容 `number | string`
  - `PublicizeDeps`: `complete: (prompt: string, signal?: AbortSignal) => Promise<string>`（供 Task 7 对接）
  - `extractMemories` 支持可选 `signal?: AbortSignal`，默认绑定 `AbortSignal.timeout(180_000)`（**不传** `timeoutMs` 以免压缩 code-assist 120s 首包/空闲超时）
  - `absorb.ts`: `absorbSecrets` 跟踪 `headId` 自动感知换页并截断 `thinking` 至 4000 字符；另导出 `recordTurnSecret(conversationId: string | number, text: string): void`（O(1) 增量写入 `ledger.secrets`，无 SQLite 扫描），由 `tool-surface.ts` 工具返回钩子增量调用

- [ ] **Step 1: 为 P1-3(memory)/16(seen-links)/17(group+absorb)/18(publicize)、P2-1(policy)/3(drain)/5/6/11(LCS)、P3-1/2/4 编写失败测试**
  - 在 `test/memory-partial.test.ts` 覆盖：
    1. `publicSafeText` 拦截带零宽字符 `\u200B` 的手机号与注入短语；`publicizePatch` 将默认 180s 超时 `signal` 透传给 `deps.complete(prompt, signal)`；
    2. `MEMORY_PENDING_CAP` 为有限值（200）且超限时淘汰最旧待审；
    3. `mergeMemoryStates` 深拷贝内部数组/对象不共享引用且结果一致；
    4. `readExpire` 拒绝 `<4` 字极短引用词；`personBlock` 截断 emoji 不产生孤立 UTF-16 代理项；
    5. `extractMemories` 调用 `models.streamSimple` 时传入超时 `signal` 且未把 `timeoutMs` 缩至 60s。
  - 在 `test/prompts.test.ts` 覆盖：
    1. `renderTemplate("{{toString}}", {})` 与 `renderTemplate("{{a}}", { a: undefined as never })` 均抛缺变量错；
    2. `parseMessageTable` 遇到重复 key 抛错；
    3. `auditPrompts` 包含 `meme-tags.md` 与 `meme-retag.md`。
  - 在 `test/policy.test.ts` 覆盖：
    1. `recordSeenLinks(42, ["https://a.test"])` 后调用 `clearSeenLinks("42")` 彻底清空；
    2. `absorbSecrets` 在 `view.head.id` 变更（换页）后重置游标从 0 扫描，且 `thinking` 截断至 4000 字符；`recordTurnSecret` 同轮增量写入立刻能被 `findProvenanceLeak` 命中；
    3. `longestCommonSubstring` 在达到 `minOverlap` 时早退且对超长输入无 `Uint16Array` 溢出；`validateMedia` 仅读文件头 16B。
  - 在 `test/durable.test.ts`、`test/fish-assembly.test.ts`、`test/startup.test.ts` 覆盖：
    1. `installGroup` 首次失败 reject 后不永久缓存坏 Promise，下次重试可成功；
    2. `drain()` 对两个独立会话并发派发 `emit`（A 会话慢时不阻塞 B 会话），rejected 结果记录日志；
    3. `section("memory")` 无 `scope` 时不触发 `MemoryDoc` 快照读取；
    4. `installStartupMigrations` 将多会话 `configure` 合并进单次事务提交。

- [ ] **Step 2: 运行测试确认 RED**
  - Run: `node --test test/memory-partial.test.ts test/prompts.test.ts test/policy.test.ts test/durable.test.ts test/startup.test.ts test/fish-assembly.test.ts`
  - Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现 Memory 与 Prompt 层加固**
  - `src/memory/publicize.ts`：`publicSafeText` 先执行 `stripInvisible(value).trim()`（与 `safeShort` 共用核心过滤逻辑）；`PublicizeDeps.complete` 签名扩展为 `(prompt: string, signal?: AbortSignal) => Promise<string>`，内部默认传入 `AbortSignal.timeout(180_000)`。
  - `src/memory/extract.ts`：`models.streamSimple` 传入 `{ signal: options?.signal ?? AbortSignal.timeout(180_000) }`（不覆写 `timeoutMs`）；`readExpire` 要求 `quote.length >= 4`。
  - `src/memory/pending.ts`：`MEMORY_PENDING_CAP = 200`；`aggregatePendingItems` 改用 `structuredClone` 或字段级拷贝减少重复 `JSON.parse(JSON.stringify)`。
  - `src/memory/merge.ts`：`mergeFacts` / `mergeByIdentity` 用 `Map<string, number>` 预索引实现 $O(N+M)$ 并对 `keys`/`subjects`/`meta` 深拷贝。
  - `src/memory/patch.ts`：`evictFacts` / `evictList` 单次排序截断。
  - `src/memory/render.ts`：`personBlock` 预计算 `sectionSafe(display)` 并用 `[...str].slice(0, n).join("")` 码点安全截断。
  - `src/prompt/index.ts`：先排查 `renderTemplate` 全部调用点确认无合法 `undefined` 依赖，再改 `!Object.hasOwn(vars, name) || vars[name] === undefined`；`parseMessageTable` 拒绝重复 key；`auditPrompts` 补 `meme-tags.md`、`meme-retag.md`。

- [ ] **Step 4: 实现 Egress 与 Fish 装配层加固**
  - `src/egress/seen-links.ts`：三个导出函数内部统一 `const key = String(round);`。
  - `src/egress/absorb.ts`：`seen` 存储 `{ headId: unknown; count: number }`，当 `headId !== view.head?.id` 时 `from = 0`；`thinking` 文本截断至 4000 字符；新增 O(1) 的 `recordTurnSecret(conversationId, text)` 写入对应会话 ledger。
  - `src/fish/tool-surface.ts`：在既有工具返回包装钩子（`withSeenLinkHarvest` 附近）对工具返回文本顺带调用 `recordTurnSecret(api.conversationId, text)`，零额外 SQLite 读取即可覆盖同轮工具结果防泄漏。
  - `src/egress/policy.ts`：`validateMedia` 改为 `openSync + readSync(16B) + closeSync`；`longestCommonSubstring(a, b, stopAt?)` 使用 `Uint32Array` 并在 `best >= stopAt` 时立刻返回，`findProvenanceLeak` 传入 `minOverlap`。
  - `src/fish/group.ts`：`groups.set(key, promise)` 挂 `.catch(() => { if (groups.get(key) === promise) groups.delete(key); })`。
  - `src/fish/drain.ts`：`drain()` 对不同 `conversationId` 改用 `Promise.allSettled(ids.map(...))` 并对 `rejected` 打 `console.error` 日志（保留每会话自身单飞锁）；`outboundEntryIdOf` 倒序遍历 `view.entries`；当 `emit` 抛出标记 `notSent: true`（确定尚未送出，如 `OneBot 未连接`）的错误时直接丢弃队首，避免重连后该群卡死 `sending` 600s。
  - `src/fish/extension.ts`：启动期预渲染静态 `tool_catalog` 文本；`section("memory")` 先判 `const scope = peekScope(String(input.conversationId)); if (!scope) return undefined;` 再读文档。
  - `src/fish/memory-admin.ts`：渲染循环中每条 `entry` 只调一次 `effectivePendingPatch(entry)`。
  - `src/fish/startup.ts`：合并多会话 `configure` 至单次 `harness.commit(...)`。

- [ ] **Step 5: 运行测试验证 GREEN 并提交**
  - Run: `node --test test/memory-partial.test.ts test/prompts.test.ts test/policy.test.ts test/durable.test.ts test/startup.test.ts test/fish-assembly.test.ts && npm test`
  - Expected: 全部 PASS，0 fail。
  - Commit: `fix(core): 加固记忆过滤、出口防泄漏与并发 drain 性能`

---

### Task 5: 核心工具、配置热更新与 TTS 加固

**Depends on:** `none`（Wave 1 并行候选组）

**Files:**
- Modify: `src/fish-config.ts`
- Modify: `src/tts.ts`
- Modify: `src/tools/config/tool.ts`
- Modify: `src/tools/draw/engine.ts`
- Modify: `src/tools/draw/tool.ts`
- Modify: `src/tools/qwen_draw/tool.ts`
- Modify: `src/tools/wan_gif/tool.ts`, `src/tools/wan_gif/messages.json`
- Modify: `src/tools/grep/tool.ts`
- Modify: `src/tools/read/tool.ts`
- Modify: `src/tools/look/tool.ts`
- Modify: `src/tools/tags/tool.ts`
- Modify: `src/tools/remind/task.ts`, `src/tools/remind/tool.ts`, `src/tools/remind/messages.json`
- Modify: `src/tools/say_voice/tool.ts`
- Modify: `src/tools/meme_add/tool.ts`
- Test (Modify): `test/draw-config.test.ts`, `test/draw-remote-config.test.ts`, `test/draw-tool.test.ts`, `test/draw-backends.test.ts`, `test/tools.test.ts`, `test/voice.test.ts`, `test/characters.test.ts`

**Interfaces:**
- Consumes: 既有 `src/tools/say-shared.ts`（`peekSayRound`、`throwIfSayCancelled`）、`src/media/describe.ts`（`signal` 参数）、`src/media/wan-video.ts`（`readWanGifRef`）
- Produces:
  - `fish-config.ts`: 修正 `engage.byGroup.<group>.<key>` 告警前缀；`createConfigLoader` 仅修 `existsSync+statSync` TOCTOU（**不加 TTL**，保持立即可见热加载契约）
  - `draw/engine.ts`: `submitAndWait` 在 `/history` 为空时先查 `/queue` 再复查 `/history` 防完成竞态，连续失踪快速释放 `runExclusive`

- [ ] **Step 1: 为 P1-8(tool)/9/11/12/18(config)、P2-7/10(remind+say_voice)/11(configLoader)、P3-6 编写失败测试**
  - 在 `test/draw-config.test.ts` 覆盖：
    1. `config set engage.byGroup.174408629.freeSeconds 1` 必须被拒绝且保留原配置，不静默删除原键；
    2. `config set compact.byModel.google-antigravity/gemini-3.1-pro 80000` 正确写入模型键而非按 `.` 拆层；
    3. `createConfigLoader` 遇文件删除不抛 `ENOENT`，且修改后下一次读取立刻拿到新值（不破坏热加载测试）。
  - 在 `test/draw-tool.test.ts` 覆盖：
    1. `submitAndWait` 当 `/queue` 与复查 `/history/<id>` 连续 3 次均不含 `<id>` 时迅速报错释放锁，不等满 `deadline`；当任务在查完 `/queue` 后刚进入 `/history` 时正常取图不误判；
    2. `qwen_draw` 参数非法时不触发 `onLongWork`。
  - 在 `test/tools.test.ts` 与 `test/characters.test.ts` 覆盖：
    1. `grep` 默认跳过 `var/` 目录，遇高危嵌套量词如 `(a+)+b` 报 `grep_bad_regex`；
    2. `read` 传 `startLine: 1` 读取超大文件时同样受大小/输出上限保护（复用 `fs_too_big`）；
    3. `look` 透传 `context.abortSignal` 给 `describeImage`；
    4. `tags` 在无 `danbooru.csv` 时仍可查询 `lora` 与内置角色/风格；
    5. `remind` 任务在 `!conv` 或终态异常时清理 `RemindersDoc` 死条目；非法 `action` 拒绝而不落入 `cancel`；
    6. `wan_gif` 传错参考图返回 `messages.json` 里的 `wan_gif_ref_bad` 文案且不触发 `onLongWork` / 不锁死 `submitted`；`meme_add` 非主人/参数非法时不触发 `onLongWork`。
  - 在 `test/voice.test.ts` 覆盖：
    1. 本轮已用满 3 次 `say_*` 额度后调 `say_voice`，在调用 `ttsSynthesize` **之前**即抛 `say_once`，不浪费合成也不生成 `.wav`。

- [ ] **Step 2: 运行测试确认 RED**
  - Run: `node --test test/draw-config.test.ts test/draw-remote-config.test.ts test/draw-tool.test.ts test/draw-backends.test.ts test/tools.test.ts test/voice.test.ts test/characters.test.ts`
  - Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现 `fish-config.ts` 与 `config/tool.ts` 修复**
  - `src/fish-config.ts`：`checkEngageBlock` 去掉 `specs` 文本里重复的 `engage.`（全局拼接 `engage.${key} ...`，`byGroup` 拼接 `engage.byGroup.${group}.${key} ...`，非法群号文案包含 `engage.byGroup.${group}`）；`createConfigLoader` 改用 `try { statSync(path).mtimeMs } catch { 0 }` 修 TOCTOU（**不加 TTL 缓存**，确保 `drawEnabled` 与热配置即时生效）。
  - `src/tools/config/tool.ts`：`segments` 对 `compact.byModel.*` 从第 3 段起合并剩余段；原子写改 `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp` 并在 `finally` 中 `rmSync(tmp, { force: true })`。

- [ ] **Step 4: 实现 `draw`, `qwen_draw`, `wan_gif`, `grep`, `read`, `look`, `tags`, `remind`, `say_voice`, `tts`, `meme_add` 加固**
  - `src/tools/draw/engine.ts`：`submitAndWait` 在 `/history/${promptId}` 为空时每 3 轮（约 4.5s）执行：先查 `GET /queue`，若 `promptId` 不在 `queue_running`/`queue_pending` 再立刻复查一次 `/history/${promptId}`（防止作业恰好在两次请求间隙完成）；仅当两处皆无才计 1 次 miss，连续 3 次 miss 抛 `ComfyExecutionFailed("ComfyUI job vanished from queue")` 释放单飞锁。
  - `src/tools/draw/tool.ts`：在 `await prepareRef(...)` 后、写 `rounds` 前再次复查 `rounds.get(api.conversationId)` 防并发窗口。
  - `src/tools/qwen_draw/tool.ts` & `src/tools/meme_add/tool.ts`：将 `deps.onLongWork?.(...)` 后移至参数/身份/轮状态校验通过之后。
  - `src/tools/wan_gif/tool.ts` & `messages.json`：将 `readWanGifRef` 提前到 `try` / `onLongWork` / `state.submitted = true` 之前；第 22/27-31/60 行所有模型可见文案统一迁入 `src/tools/wan_gif/messages.json` 并通过 `deps.prompts.messages` 读取；确定性参数/4xx 拒绝不锁 `submitted`。
  - `src/tools/grep/tool.ts`：`walk` 跳过 `var` 与 `dist`（除非用户显式传入子路径位于其中），加文件数上限（1000）与总读取字节上限（20MB）；增加尽力而为的嵌套量词检测（命中抛 `grep_bad_regex`）+ 预算上限双保险；`glob` 改线性通配符匹配函数。
  - `src/tools/read/tool.ts`：分段模式同样校验 `st.size <= 2 * 1024 * 1024`（超限复用 `fs_too_big`）并限制单次返回总字符数 ≤ `READ_CAP`。
  - `src/tools/look/tool.ts`：`describeImage(deps, data, outMime, context.abortSignal)`；`metadata` 分支写入 `OutboxDoc` 前后复检 `throwIfSayCancelled(context)`。
  - `src/tools/tags/tool.ts`：按 `csvPath` 建缓存，预存 `nameLower` / `aliasesLower`；`related()` 分桶（精确/前缀/包含）避免 `unshift` 与全量排序；把 `rows.length === 0` 校验移入第 3 步 danbooru 分支。
  - `src/tools/remind/task.ts`, `tool.ts`, `messages.json`：在 `!conv` 分支与 `conv.submit`/`submission.wait` 终态 `catch` 中从 `RemindersDoc` 移除 `selfId`；`remind/tool.ts` 显式校验 `args.action === "cancel"`（非法值走 `messages.json` 新 key `remind_bad_action`）。
  - `src/tools/say_voice/tool.ts` & `src/tts.ts`：合成前先 `peekSayRound(...)`；若后续 `validateOutbound` / `chargeSayRound` / `enqueueOutbound` 失败则 `rmSync` 删除刚生成的 `.wav`；`tts.ts` 下载音频加 25MB 字节上限。

- [ ] **Step 5: 运行测试验证 GREEN 并提交**
  - Run: `node --test test/draw-config.test.ts test/draw-remote-config.test.ts test/draw-tool.test.ts test/draw-backends.test.ts test/tools.test.ts test/voice.test.ts test/characters.test.ts && npm test && npm run prompts`
  - Expected: 全部 PASS，0 fail，`npm run prompts` 退出码 0。
  - Commit: `fix(tools): 加固配置校验、画图队列探活、文件检索边界与工具取消`

---

### Task 6: OneBot 协议稳定性、Compact 单扫优化与异步周报统计

**Depends on:** `none`（Wave 1 并行候选组）

**Files:**
- Modify: `src/qq/onebot.ts`
- Modify: `src/compact.ts`
- Modify: `src/records/stats.ts`
- Test (Modify): `test/onebot.test.ts`, `test/compact.test.ts`

**Interfaces:**
- Consumes: 既有 `src/qq/onebot.ts`、`src/compact.ts`、`src/records/stats.ts`
- Produces:
  - `OneBotOptions` 新增可选 `shouldDownloadMedia?: (frame: OneBotEvent) => boolean`（未传兼容原行为）、`reconnect?: boolean`（默认 `true`）、`heartbeatTimeoutMs?: number`（默认 `90_000`）、`onReconnect?: () => void`
  - `OneBot` 未连接时抛出的错误带 `notSent = true` 标记（供 `drain.ts` 确定丢弃队首而非锁死 `sending` 600s）
  - `src/records/stats.ts` 新增异步流式 `weeklyStatsAsync(chatlogRoot: string, chatKey: string, now?: number): Promise<WeeklyStats | undefined>`（保留同步 `weeklyStats` 兼容脚本）

- [ ] **Step 1: 为 P0-1、P1-3(compact)/16(onebot)/17(memberName)、P2-1(sendImage)/2(compact)/11(stats) 编写失败测试**
  - 在 `test/onebot.test.ts` 覆盖：
    1. 首次 `connect()` 连不上时仍按原样 reject；首次连上后连接断开时自动按指数退避重连并触发 `onReconnect`（`close()` 显式停机后不再重连），且不并发创建重复 WS；
    2. 超过 `heartbeatTimeoutMs` 无帧且探测失败时主动断链触发重连；
    3. 挂载 `process.on("unhandledRejection", ...)` 实测：收到含 `null` 消息段的异常帧时 `#onFrame` 捕获异常不触发任何未处理 rejection；
    4. 未连接时调用 `sendGroup` 抛出带 `notSent: true` 的错误；
    5. `shouldDownloadMedia` 返回 `false` 时不下载入站图片；
    6. `#memberName` 并发调用合并为单次 `get_group_member_list` RPC，RPC 失败返回 `[]` 时不写入 5 分钟缓存；
    7. `sendImageGroup` 在 `#pacedSend` 配速等待完成后才读取文件并发送。
  - 在 `test/compact.test.ts` 覆盖：
    1. 未达换页阈值时 `maybeCompact` 仅调用 **1 次** `conversation.context` 即短路返回；触发换页时同样仅读 1 次 `view` 复用全部统计与渲染；
    2. `buildProfile` 调用 `models.streamSimple` 时传入超时 `AbortSignal`（180s，不覆写 `timeoutMs` 且不误截断正常 100k token 页）；
    3. `weeklyStatsAsync` 流式统计与 `weeklyStats` 结果一致。

- [ ] **Step 2: 运行测试确认 RED**
  - Run: `node --test test/onebot.test.ts test/compact.test.ts`
  - Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现 `src/qq/onebot.ts` 重连、容错与性能修复**
  - 首次 `connect()` 保持失败即 reject 语义（`connectOnebot` 仍按原样退出），加握手超时（15s）、清理握手临时监听器、挂常驻 `error` 处理器；首次成功连接后标记 `#everConnected = true`。
  - 后续 `close` 且非主动 `#closed` 时启动单一指数退避重连定时器（1s → 30s + jitter），重连成功后触发 `onReconnect?.()`。
  - 记录 `#lastActivityAt`（收到任意帧或 `meta_event` 更新），定期检查超过 `heartbeatTimeoutMs`（默认 90s）无帧时发 `get_status` 探测，失败则关闭当前 WS 触发重连；`close()` 清理所有定时器。
  - `message` 监听改为 `(event) => { void this.#onFrame(event.data).catch((err) => console.error("[鱼缸] OneBot 帧处理异常", err)); }`；`parseEvent` 对 `seg` 做 `if (!seg || typeof seg !== "object") continue;` 守卫。
  - 未连接分支抛出的 `Error("OneBot 未连接")` 附加 `(err as Error & { notSent?: boolean }).notSent = true`。
  - 入站图片下载前检查 `this.#shouldDownloadMedia?.(frame) ?? true`。
  - `#memberName` 增加 `#memberLoading` 单飞 Map；`groupMembers()` 失败返回空数组时不写入 `#memberCache`。
  - `sendImageGroup` / `sendImagePrivate` 改为在 `#pacedSend` 回调内异步 `readFile` 再编码 base64。

- [ ] **Step 4: 实现 `src/compact.ts` 单次上下文扫描与超时，`src/records/stats.ts` 异步流式统计**
  - `src/compact.ts`：`maybeCompact` 仅调用一次 `const view = await conversation.context(ctx)`，优先倒序扫描 `view.entries` 算 `latestRequestTokens`；未超阈值直接返回；超阈值则把同一 `view` 传给 `renderCountedEntries` / `extractPreviousProfile` / `renderMemoryTranscript`；`buildProfile` 传入 `{ signal: AbortSignal.timeout(180_000) }`（不覆写 `timeoutMs`，不截断正常页 transcript）。
  - `src/records/stats.ts`：新增 `weeklyStatsAsync`（用 `createReadStream` + `readline.createInterface` 逐行流式解析），保持 `weeklyStats` 向后兼容。

- [ ] **Step 5: 运行测试验证 GREEN 并提交**
  - Run: `node --test test/onebot.test.ts test/compact.test.ts && npm test`
  - Expected: 全部 PASS，0 fail。
  - Commit: `fix(qq): 增加 OneBot 断线重连与帧容错并优化换页扫描`

---

## Wave 2（Task 7：Runtime 集成与全路径异步图像处理切换）

### Task 7: Runtime 稳定性集成与媒体热路径全异步切换

**Depends on:** `Task 1`, `Task 2`, `Task 3`, `Task 4`, `Task 5`, `Task 6`（全部 Wave 1 合并后执行）

**Files:**
- Create: `src/app/runtime-helpers.ts`（独立无副作用模块：原子 `sent`/`weekly` 文件读写、媒体 TTL 清理、会话级 `compact` 串行排班器，方便单测直测而不触发 `runtime.ts` 顶层副作用）
- Modify: `src/app/runtime.ts`
- Modify: `src/tools/types.ts`（`RoundTrigger` 新增 `reply?: boolean`）
- Modify: `src/tools/say-shared.ts`（导出 `isQuoteForced(trigger)`：`Boolean(trigger?.mentionsBot || trigger?.reply)`）
- Modify: `src/tools/say_words/tool.ts`, `src/tools/say_media/tool.ts`, `src/tools/say_meme/tool.ts`, `src/tools/draw/tool.ts`, `src/tools/qwen_draw/tool.ts`, `src/tools/wan_gif/tool.ts`, `src/tools/look/tool.ts`, `src/tools/draw_remote/tool.ts`（统一使用 `isQuoteForced(trigger)`；其中 `draw`/`look` 同文件顺带完成异步图像切换）
- Modify: `src/qq/round-images.ts`
- Modify: `src/qq/onebot.ts`（切换 `toJpegViaWorker` → `toJpegViaWorkerAsync`）
- Modify: `src/tools/meme_import/tool.ts`（切换 `inlineImageOf`/`extractGifFrames` → 异步版）
- Modify: `src/tools/config/tool.ts`（透传 `signal: context.abortSignal` 到 `probeFishModel`）
- Modify: `src/media/image-ops.ts`, `src/media/shrink-image.ts`, `src/media/gif-frames.ts`（移除已无调用方的同步 `spawnSync` 包装）
- Test (Modify): `test/gif-frames.test.ts`, `test/quoted-images.test.ts`, `test/model-input-templates.test.ts`, `test/meme-import.test.ts`, `test/round-guard.test.ts`, `test/round-image-strip.test.ts`
- Test (Create): `test/runtime-hardening.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `ModelProbeOptions.signal`
  - Task 2: `shrinkViaWorkerAsync`, `lookShrinkViaWorkerAsync`, `normalizeInitViaWorkerAsync`, `toJpegViaWorkerAsync`, `shrinkForModelAsync`, `inlineImageOfAsync`, `extractGifFramesAsync`
  - Task 4: `PublicizeDeps.complete(prompt, signal)`
  - Task 6: `OneBotOptions.shouldDownloadMedia`, `OneBotOptions.onReconnect`, `weeklyStatsAsync`
- Produces:
  - `src/qq/round-images.ts`: `planInlineImages` / `planRoundImages` 全面异步化（并发上限 2，可注入测试桩兼容 `T | Promise<T>`），全仓媒体热路径零 `spawnSync`

- [ ] **Step 1: 为 P0-2、P1-3(runtime)/6(cutoff)/14/15/16/17、P2-11 编写失败测试**
  - 在 `test/runtime-hardening.test.ts` 覆盖：
    1. `runtime-helpers.ts` 的 `loadJsonSafe` / `writeJsonAtomic` / `BoundedSentSet`：损坏 `sent.json`/`weekly.json` 告警回退空态不崩、原子落盘不留 `.tmp`、内存集合严格封顶 5000；
    2. `runtime-helpers.ts` 的会话级 `createCompactQueue`：
       - 同会话并发 2 次非 `force` 串行排队，第 2 次拿锁后复判阈值不再重复换页；
       - `force` 排在非 `force` 后：若前者返回 `below_threshold`，后者仍继续执行 `force` 换页；若前者已成功换页，后者直接复用该次成功结果；
       - 队列未排空前 `isCompacting(id)` 始终为 `true`；
    3. `cleanupExpiredMedia(mediaRoot, ttlMs)` 只删 `inbound/`、`gen/`、`voice/` 下超期文件，绝不触碰 `memes/`、`meme-inbox/`、`inbound-video/`；
    4. 源码回归断言：`src/media/image-ops.ts`、`src/media/shrink-image.ts`、`src/media/gif-frames.ts` 不含 `spawnSync`；`src/app/runtime.ts` 不含 `burstMustAnswer`、`lastMention`、`lastReply`、裸 `chatKeys.get(conversationId)`、`mappingKeys.set(conv.id`；`compactWithGuard` 实际调用 `compactQueue` 且保留 `async function compactWithGuard(` 声明；`runSubmission` `finally` 包含 `drawStageSent.delete`。

- [ ] **Step 2: 运行新增测试确认 RED**
  - Run: `node --test test/runtime-hardening.test.ts`
  - Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现 `src/app/runtime-helpers.ts` 与 `src/app/runtime.ts` 稳定性集成**
  - 创建 `src/app/runtime-helpers.ts`：导出 `readJsonSafe`、`writeJsonAtomic`、`createSentStore(path, cap = 5000)`、`createCompactQueue()`、`cleanupExpiredMedia(mediaRoot, ttlMs)`。
  - 更新 `src/tools/types.ts`、`src/tools/say-shared.ts` 及出口工具：`RoundTrigger` 增 `reply?: boolean`，`isQuoteForced(trigger)` 统一返回 `Boolean(trigger?.mentionsBot || trigger?.reply)`；`runtime.ts` 在构造 trigger 时写入 `reply` 并彻底删除 racy 的 `lastMention` / `lastReply` 会话级 Map。
  - 更新 `src/app/runtime.ts`：
    - `sent.json` / `weekly.json` 接入 `createSentStore` / `readJsonSafe` / `writeJsonAtomic`；
    - 统一 `chatKeys`、`mappingKeys` 全部 `set`/`get` 使用 `String(id)`，`emit` 查 `chatKeys.get(String(conversationId))`；
    - 保留 `async function compactWithGuard(` 原名与结构，内部委托 `compactQueue` 按 `String(conv.id)` 串行排班（`compacting` 在队列非空期间始终为 true）；`/压缩` 遇 `conversationBusy(conv.id)` 复用 `busy_reply` 拒绝；
    - `runSubmission` `finally` 补 `drawStageSent.delete(subId)`；`publicizePendingForApproval` 对接 `complete(prompt, signal)` 将 `signal` 透传给 `models.streamSimple`；
    - 删除外置 `burstMustAnswer` Map，直接在 `flushBurst` 读 `burst.mustAnswer`；在 `flushBurst` / `submitShardRound` 过忙检查后立即占位 `inFlight`（覆盖 `planRoundImages` 与 `expandForwardAttachmentById`，异常释放）；`conversationFor` 加 `conversationLoading` 单飞 Map；
    - 为 `OneBot` 注入 `shouldDownloadMedia`（仅白名单群与 `MASTER_QQ` 私聊）与 `onReconnect: () => { void drainLoop().catch(() => {}); }`；`normalizeInbound` 对未授权来源提前返回不写 `nameToQq`/`recent`/`chatlog`，`nameToQq` 单群上限 2000；增加每日一次的 `cleanupExpiredMedia` 定时器（`unref()` 并在 `stopEngage` 清理）；
    - `startWeekly` 改为 30s 轮询 + 周日 21:00–23:59 时间窗 + `weeklyInProgress` 防重入标志 + `weeklyStatsAsync`，保存 timer 句柄在 `stopEngage` 清理；
    - 删掉 `runtime.ts:51` 未使用的 `shrinkForModel` import；
    - **严格保持停机简洁**：不引入重启补发或停机等待在途 `draw_remote` 补偿。

- [ ] **Step 4: 全路径切换异步图像处理并删除旧 `spawnSync` 包装**
  - `src/qq/round-images.ts`：`planInlineImages` 与 `planRoundImages` 改为 `async`（并发度 2，兼容同步/异步测试注入桩），调用 `inlineImageOfAsync` / `extractGifFramesAsync`。
  - 更新全部 5 处生产调用方：
    1. `src/app/runtime.ts`（`flushBurst`、`submitShardRound` `await planRoundImages` / `await planInlineImages`）
    2. `src/qq/onebot.ts`（`downloadImage` 调 `await toJpegViaWorkerAsync(...)`）
    3. `src/tools/draw/tool.ts`（`normalizeInitImage` 调 `await normalizeInitViaWorkerAsync(..., signal)`）
    4. `src/tools/look/tool.ts`（`shrink` 调 `await lookShrinkViaWorkerAsync(..., context.abortSignal)`）
    5. `src/tools/meme_import/tool.ts`（inline 附图循环调 `await inlineImageOfAsync` / `await extractGifFramesAsync`）
  - `src/tools/config/tool.ts`：`models_probe` 透传 `signal: context.abortSignal` 到 `probeFishModel`。
  - 删除 `src/media/image-ops.ts`、`src/media/shrink-image.ts`、`src/media/gif-frames.ts` 中已无调用方的同步 `spawnSync` 包装函数，并更新 `test/gif-frames.test.ts`、`test/quoted-images.test.ts`、`test/model-input-templates.test.ts`、`test/meme-import.test.ts`。

- [ ] **Step 5: 运行全量验证并提交**
  - Run: `npm test && npm run prompts`
  - Expected: `npm test` 全部 PASS（原 325 + 新增全部通过，0 fail），`npm run prompts` 退出码 0，且 `test/index-registration.test.ts`、`test/harness-assembly.test.ts`、`test/round-guard.test.ts`、`test/round-image-strip.test.ts` 全部通过。
  - Commit: `fix(runtime): 修复运行时竞态泄漏并完成全链路异步图像处理`

---

## Independent Plan Review Notes

- **Reviewer**：`plan-reviewer`（Swarm `claude-opus-5-5-high`，只读审查，对照 `HEAD = 7fbe910` 源码与 `pi-ai` / `pi-durable` 实现）
- **已采纳并合入计划的关键修改**：
  - **C1**：EOF 半包错误文案改为命中 `pi-ai` `RETRYABLE_PROVIDER_ERROR_PATTERN` 并直接断言 `isRetryableAssistantError === true`；
  - **C2**：取消 `createConfigLoader` 500ms TTL（仅修 `existsSync+statSync` TOCTOU），保全热配置即时生效契约与既有测试；
  - **C3**：`RoundTrigger` 新增 `reply?: boolean` + `say-shared.ts` `isQuoteForced(trigger)`，无回归替代可变 `lastMention`/`lastReply`；
  - **C4**：在 `absorb.ts` 增 O(1) `recordTurnSecret` 并接入 `src/fish/tool-surface.ts`，避免热路径重复扫描 SQLite；
  - **C5**：`compactWithGuard` 明确为按会话串行排班（`force` 不被非 `force` 吞掉），并保留 `async function compactWithGuard(` 声明供切片测试使用；
  - **S1–S14 & M1–M6**：修正 `bootId` 回收判定方向与 ≤15s 持锁不变量注释、保留 `createProxyFetch` body 空闲超时/去 `content-encoding`/默认 `maxSockets`、探活同时隔离 `oauth.refresh` 与 `discoverProject`、后台超时放宽至 180s 且不缩 `timeoutMs`/不误裁 transcript、未连接错标 `notSent` 丢弃队首 + `onReconnect` 触发 `drainLoop`、抽取无副作用 `runtime-helpers.ts`、父进程管 `heif` 临时目录 + `runWorkerAsync` 传 64MB `maxBytes`、`wan-video` 总超时收紧至 1150s、周报防重入与时间窗收窄、明确文案 key 与 `/queue`→`/history` 查序。
- **已知并记录的取舍（S2）**：`google-code-assist` 将默认内层重试降为 `0` 后，由外层 `pi-durable` 固定 2/4/8s 退避统一调度（不再读内层 `retry-after` 头），以此彻底消除 4×4×3=48× 重试风暴，保持简单可控。
