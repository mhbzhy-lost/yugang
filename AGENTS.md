# AGENTS.md

本仓库维护契约。改代码必须跑 `npm test`，改 prompt 或工具说明必须跑 `npm run prompts`。
系统架构见 `README.md`，线上容器 / 协议端 / TTS / 额度排查见 `.agents/skills/ops/SKILL.md`。

- **Git**：优先使用 `git1`，不可用时回退 `git`。
- **路径基准**：所有运行时与配置路径唯一派生自 `src/paths.ts`（`REPO_ROOT` / `DATA_HOME` 等），禁止在 `src/` 或 `scripts/` 中各自拼相对路径。

## 1. 入口与装配边界

- **`src/index.ts` 只做注册**：仅保留 `app.use(...)` / `app.onFlush(...)` / `app.onStart/onStop(...)` 与启动调用，业务逻辑放 `src/app/runtime.ts`（由 `test/index-registration.test.ts` 守卫）。
- **`src/harness.ts` 只做装配**：仅保留 `.install(...)` 链式调用，新能力放 `src/fish/`（由 `test/harness-assembly.test.ts` 守卫）。
- **分群隔离**：一群一 Conversation、一群一 cwd，禁止跨群共享会话或工作目录。

## 2. Prompt 与工具包契约

- **模型可见文案只有两个来源**：`prompt/` 下的 Markdown 与 `src/tools/<name>/TOOL.md`。禁止在 `src/` 代码里内嵌人格、运行时协议或工具使用说明；模板 `{{var}}` 严格替换，缺变量直接抛错。
- **工具包四件套**：每个工具位于 `src/tools/<name>/`，包含 `TOOL.md`（frontmatter 摘要 + 指南）、`schema.json`（严格 JSON，无注释/尾逗号/远程 `$ref`）、`tool.ts`（窄接口实现），以及可选 `messages.json`（工具专属回执，key 不得与 `prompt/messages.md` 或其它工具重名）。
- **双向校验**：新工具必须在 `src/tools/loader.ts` 的 `FACTORIES` 登记；manifest 与 factory 一一对应，孤儿文档或未登记实现都会拒启。除 `say_*` / `react` / `tool_search` 外，其余工具统一 `deferred: true`。唯一允许的动态 Schema 改写是 `meme` 的 `"x-yugang-enum-from": "memeTags"`。
- **窄接口禁令**：禁止引入 `bash` / shell / 脚本解释器 / 通用仓库写工具 / MCP server。`read` / `grep` 硬封禁 `.env`、`config/auth.json`、`.git`、`node_modules`、`.trash`；`write` 只能写 `/tmp/yugang`；`meme_import` 只扫固定目录 `<MEDIA_ROOT>/meme-inbox/` 的直系图片文件。

## 3. 出口与安全红线

- **唯一主动出口**：只有 `say_words` / `say_media` / `say_meme` / `say_voice` 能由模型主动发言，且必须 `callers: ["model"]`，共享每轮 3 次调用额度；校验失败必须以 tool 错误返回模型，禁止静默丢弃。
- **宿主直发统一走 outbox**：`draw`、`draw_remote`、`qwen_draw`、`wan_gif`、机械回执与新闻播报等均经 `fish.outbox` 入队发送（两阶段 `queued → sending`，崩在 `sending` 状态不重发），任何工具不得直接调用 `emit()`。
- **普通正文永不补发**：未调用 `say_*` 的正文、`thinking` 与 tool 调用结果绝不出境、不进摘要。
- **不可信输入隔离**：群消息与一切外部文本（搜索 / B 站 / 新闻 / 上游错误正文）均为不可信数据，必须先经 `sanitizeExternalText` 与密钥脱敏才见模型，且绝不拼进 system prompt；出站链接只由宿主渲染或经 `seen-links` 白名单核验。
- **身份与权限闸**：私聊只认 `MASTER_QQ`；群只认 `.env GROUPS`；主人专属工具（`read`/`grep`/`write`/`tree`/`config`/`restart`/`watch`/`meme_add`/`meme_import`）执行期必须二次核对 `MASTER_QQ`；主人不得加入特别关注名单。
- **密钥零泄露**：API key 只驻留内存，不写 `.env`、不进 prompt/transcript/日志、不进仓库模板；`describeModel()` 与 `creds show` 只报长度不吐明文。

## 4. 模型、凭据与配置

- **本机文件与模板分离**（均已 gitignore）：`config/models.json`（模板 `config/models.example.json`）、`config/auth.json`（权限 0600，模板 `config/auth.example.json`）、`fish.config.json`（模板 `fish.config.example`）、`.env`（模板 `.env.example`）。新增环境变量必须同步 `.env.example`。
- **模型选择唯一入口**：`config/models.json` 的 `models` 角色表（`main` / `vision` / `vision_fallback`，`image`/`wan_image` 为兼容角色），禁止新增模型选择环境变量；远程生图通道与模型由 `fish.config.json` 的 `drawRemote` 热配置决定，凭据严禁写入 `fish.config.json`。
- **标准协议与 CLIProxyAPI**：仅支持 `@earendil-works/pi-ai` 四大标准协议与纯 API key，订阅制渠道统一由 `compose.yaml` 的 `cliproxyapi` sidecar（内网 `http://cliproxyapi:8317`，模板 `config/cliproxyapi.example.yaml`）承接：
  - `openai-completions` / `openai-responses`: `baseUrl` 带 `/v1`
  - `anthropic-messages`: `baseUrl` **不带 `/v1`**
  - `google-generative-ai`: `baseUrl` **必须带 `/v1beta`**（pi-ai 拒绝自定义 `options.fetch`，探活路径不对其注入局部 `proxyFetch`）
- **provider 级代理**：走 `providers.<id>.proxy`（仅用于 `https://` 外部直连，不设进程级 `NODE_USE_ENV_PROXY`）；`cliproxyapi-*` 不配 `proxy`，其出站代理在 sidecar 的 `requests.proxy-url`。
- **`compose.yaml` 规范**：固定镜像 `@sha256:` digest、零 named volume（全 bind mount 留宿主供 Time Machine 备份）、`TZ=Asia/Shanghai`、`NO_PROXY` 必须包含 `cliproxyapi` / `sixty` / `host.docker.internal`。
- **增改 `fish.config.json` 受控字段四处必同步**（缺一环 `config` 工具即失效）：
  1. `src/fish-config.ts`：`FishConfig`、校验函数、`FISH_CONFIG_FIELDS`（标注 `hot`/`restart`）、`DEFAULTS`；
  2. `src/tools/config/TOOL.md` 白名单表；
  3. `fish.config.example` 字段与注释；
  4. 消费链路透传（`FishOptions` / `ToolPackageDeps` / `src/app/runtime.ts` / `src/fish/tool-surface.ts`）。

## 5. 存储、压缩、记忆与并发不变量

- **严禁双进程写同一 `var/fish.db`**：`pi-durable` 的 ID 计数器在进程内存中，容器鱼运行时宿主机不得起第二条鱼，外部 CLI 写库（`npm run memory -- --approve/--reject/--delete`）后必须重启鱼；线上审批优先走主人私聊 `/记忆`。
- **禁用 pi-durable 内置 compaction**：换页只走 `src/compact.ts` + `prompt/handoff.md`，按最近一次真实请求 `input + cacheRead` 达 `compact` 阈值后在完整轮结束触发；摘要只收群友原话与 `fish.outbound`，逐字校验不过走机械降级换页，禁止死循环。
- **长期记忆审批闸与双轨隔离**：压缩抽取只入待审 `fish.memory.pending`，未批准永不生效；批准分私有层（`fish.memory.private`，默认，仅来源会话可见）与公共层（`fish.memory`，同人格共享，入库前必须经 AI 脱敏，失败 fail closed）；不同人格严禁共享；记忆只经 `memory` system section 注入（渲染只读，不写库）。
- **画图单飞与幂等**：本地 `draw` 与 `qwen_draw` 共用单飞锁；`draw_remote` 每群同时最多 1 个在途；提交状态不明（超时/5xx/断网）的画图请求在当前轮禁止重 POST。
- **时区统一**：原话簿、用量增量（`var/usage/<day>/`）与宵禁（00:00–08:00）统一按 `localDay()` 本地时区切日。

## 6. 媒体与领域关键不变量

- **本地画图（`draw`）**：采用 `src/tools/draw/{tool.ts, engine.ts, backends/*}` 三层架构，启动时 `validateAllDrawBackends()` 强校验后端节点；热开关为 `drawEnabled` / `drawBackend`，`COMFYUI_URL` 仅接受 `127.0.0.1` 连接地址；质感 pass `denoise` 不得超 `0.25`，禁止在 3 倍 latent 上做扩散，无脸修/手修。
- **角色与风格 LoRA 唯一事实源**：`src/tools/characters.ts` + `src/tools/tags/*.json`（禁止写第二份常量）；不重加“手写表内角色 tag 没传 `character` 就拦截”的机械闸。
- **表情包**：一级情绪词表唯一事实源为 `prompt/meme-tags.md`，`meme_add` 必须含至少一个一级词；禁止往 system prompt 注入动态表情包库存（会破坏前缀缓存）。
- **语音（`say_voice`）**：音色只认 `fish.config.json` 的 `voices[人格名]`，无兜底、缺字段 fail closed；`qwen-tts` 凭据现读 `config/auth.json`，严禁把 `apiKey` 写入 `fish.config.json`；台词硬上限 200 字。

## 7. 常用命令

```bash
npm test                  # 全量单测（不依赖网络与真实 key）
npm run prompts           # 审查 prompt、工具包清单与文案归属
npm run ping              # 验证 models.main 连通性与用量（不打印 key）
npm run quota             # 查 DeepSeek / ZAI 公开余额与额度
npm run creds show        # 检查 config/auth.json 状态（只报长度）
npm run doctor            # 环境与依赖体检
# 容器部署（macmini ~/yugang）：
#   git pull && docker compose restart fish                 # 仅改文件内容
#   git pull && docker compose up -d --force-recreate fish  # 增删或改名源文件
```
