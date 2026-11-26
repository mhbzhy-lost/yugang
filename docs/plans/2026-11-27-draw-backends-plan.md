# `draw` 本地 danbooru 多模型后端解耦 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 将本地 `draw` 工具解耦为「统一 danbooru 工具面 + 共享 ComfyUI 执行引擎 + 可插拔本地模型后端（`DrawBackend`）」，支持通过 `fish.config.json` 的 `drawBackend` 热切换模型后端，并让角色/风格词表支持按模型族/后端映射 LoRA（Anima 变体同族复用，跨族角色自动降级纯 tag）。

**Architecture:** 先将 `src/tools/draw/comfy.ts` 拆为底模无关的共享执行引擎 `src/tools/draw/engine.ts`（统一 `runExclusive` 单飞锁、多架构节点逐字段清单核对、可配置 `stageNodes`）、零 IO 标识表 `backends/ids.ts`、后端注册表 `backends/registry.ts` 与 `backends/anima3.8b/` 内置默认后端（`comfy.ts` 保留全部 11 值 + 8 类型兼容重导出，`qwen_draw/comfy.ts` 同步复用同一 `runExclusive`）；同步扩展 `src/tools/characters.ts` 多底模 LoRA 解析；配置层在 `src/fish-config.ts` 新增热生效字段 `drawBackend`（只依赖零 IO 的 `ids.ts`）；最后重构 `src/tools/draw/tool.ts` 接入启动契约校验、严格能力预检与 `onSubmitted` 时序，去模型化 `TOOL.md`/`schema.json` 并完成宿主装配与全仓测试收口。

**Tech Stack:** Node.js >=22 (native TypeScript strip-types + `node:test`), `@earendil-works/pi-durable`, ComfyUI HTTP/WS API.

**Spec:** `docs/plans/2026-11-27-draw-backends-spec.md`

**Plan Review Record:** 2026-11-27 经独立只读重型评审（`pi-worker` `tier=heavy`, `readOnly=true`, model `glm-5.4`, taskId `73481775-01e4-428d-a7ad-35fbd5aa9137`），全部 4 条 Critical（C1 `DrawBuildRequest.fast` 保 `ref+fast` 叠加、C2 跨族降级角色不打穿构图与四模式矩阵测试、C3 `createDrawTool` 调用 `validateAllDrawBackends()` 与坏模板启动测试、C4 新增第三测试夹具 `fake_limited` 触达全部 7 类拒绝）及 S1–S6（零 IO `ids.ts`、统一 `qwen_draw` 单飞锁、钉死 `stageNodes`、全序校验优先级、导出快照与全量测试点、逐字段清单核对与未注册节点区分）与 Minor 清理项均已逐条合入本 Spec 与 Plan。

## Global Constraints

- 模型可见提示词只能位于 `prompt/` 与 `src/tools/<name>/TOOL.md` / `messages.json`，严禁在 `src/` 里新增模型可见长提示词；`messages.json` 的 key 不得与 `prompt/messages.md` 或其它工具包冲突，且 `test/prompts.test.ts` 的无死 key 校验必须全绿；不得移除或改名 `qwen_draw` 共用的 7 个 `draw_*` key（`draw_used`/`draw_inflight`/`draw_uncertain`/`draw_busy`/`draw_off`/`draw_disabled`/`draw_round_missing`）。
- Node 运行在 TypeScript strip-only 模式：禁止 `constructor(readonly x: ...)` 参数属性语法、禁止 `enum` 关键字。
- 分层红线：`src/tools/draw/backends/*` 与 `engine.ts` 严禁 import `src/fish-config.ts`；`src/fish-config.ts` 只允许 import 零 IO 的 `src/tools/draw/backends/ids.ts`，不得触发任何 workflow JSON 读取。
- `qwen_draw` 与 `draw_remote` 保持独立零破坏；`src/tools/draw/comfy.ts` 对外既有全部 11 个运行时值导出（`ComfyBusy`, `ComfyExecutionFailed`, `comfyUrl`, `execGraph`, `makeGraph`, `makeInteractionGraph`, `makeInteractionSingleGraph`, `runComfy`, `runInteraction`, `runInteractionSingle`, `uploadRefImage`）+ 8 个类型导出必须保持兼容且 `ComfyBusy` 与 `engine.ts` 同一 class。
- `drawEnabled` 继续作为 `draw` 与 `qwen_draw` 共用的唯一 GPU 资源闸，线上既有 `fish.config.json` 零迁移；不新增重复的 `draw.enabled` 开关。
- 现有 `src/tools/tags/{ai-girls,honkai3rd,styles}.json` 保持向后兼容、零改动（不破坏实验资源冻结 sha）；`loraBook`/`styleBook` 旧签名保持兼容。
- Git 操作优先使用 `git1`（不可用时回退 `git`）；commit 遵循 `type(scope): 中文祈使句`，禁止 AI 署名；始终显式列出 `git add` 文件路径，禁止 `git add -A`（严禁触碰工作区中无关的 `regional-training` 未提交文件）。

## Review Focus

1. **热切后端、全序严格能力预检与 `ref + fast` 组合（C1 & C4 & S4）**：同一 `createDrawTool` 实例不重建热切 `drawBackend`；覆盖 `ref + fast` 合法叠加与「后端无 fast 时拒 `ref + fast`」；用 3 个内存夹具（`fake_anima2b` / `fake_sdxl` / `fake_limited`）确保全部 7 类拒绝路径（未知后端、缺 `multi`/`ref`/`fast`、缺 `hd`、模式不支持 `style`、缺 `framing`/`spacing`、画风跨族无 LoRA）均真实可达，且均在 `onSubmitted` / `onLongWork` 前拒绝、`submitted=false`、同轮改参可重试。
2. **跨族降级角色不打穿构图（C2）**：`anima2b`/`anima2.9b`/`anima3.8b` 共享 `"anima"` LoRA 族（优先级 `backendId > loraFamily > legacy base`）；切到 `sdxl` 等无匹配 LoRA 的后端时，角色自动降级为「不挂 LoRA + 注入 `inject` tag」继续画（四模式 `single`/`fast`/`ref`/`multi` 均不抛 `invalid role` 且不丢 `inject`），画风（`style`）明确报 `draw_style_backend_unsupported`。
3. **多架构节点逐字段清单核对、统一单飞锁与启动拒启（C3 & S2 & S6）**：`engine.ts` 覆盖 `LoraLoader`/`LoraLoaderModelOnly`/`AnimaLoRARemapTagLoader`/`RSMultiCharacterLoRA`/`CheckpointLoaderSimple`/`CheckpointLoader`/`DualCLIPLoader`（逐字段核对 `clip_name1` 与 `clip_name2`）/`ControlNetLoader`/`CLIPVisionLoader`/`StyleModelLoader`/`UNETLoader`/`CLIPLoader`/`VAELoader`/`UpscaleModelLoader`/`ModelPatchLoader` + `extraModelFileFields`，区分「节点未注册（`{}`）」与「清单异常」；`draw` 与 `qwen_draw` 共用 `runExclusive` 锁；`createDrawTool` 启动必调 `validateAllDrawBackends()`，篡改模板启动即抛错。
4. **`anima3.8b` 迁移等价性、兼容门面与 `stageNodes`（C1 & S3 & S5）**：迁入 `backends/anima3.8b/` 后，`single`/`fast`/`ref`/`ref+fast`/`multi` 的节点图、地板词、`stageNodes`（`fast`/`ref` 为 `["43","91"]`，`single`/`multi` 为 `undefined`）、`workingVariant` 与迁前等价；`comfy.ts` 11 个值导出快照与 `ComfyBusy` 类同一性零回归。
5. **零 IO 配置分层与工具面无死 key（S1 & S5）**：`fish-config.ts` 只 import 零 IO `ids.ts`；`drawBackend` 非法值在 `loadFishConfig` 告警回默认、在 `config set` 拒绝落盘不破原文件，且 `config/TOOL.md` 与 `fish.config.example` 同步登记；`draw/schema.json` 移除 `placement_x`/`placement_y`，`draw/messages.json` 零死 key 且 6 条新文案变量完整匹配。

---

### Task 1: 词表多底模 LoRA 解析扩展（`src/tools/characters.ts`）

**Depends on:** `none` *(与 Task 2 文件完全无重叠，可并行执行)*

**Files:**
- Modify: `src/tools/characters.ts`（扩展 `CharacterEntry.loras?` 可选字段校验、导出 `LoraVariant` / `LoraTarget` / `ResolvedLora` / `ResolvedCharacter` / `ResolvedStyle` / `normalizeLoraFamily` / `parseCharacterEntry` / `resolveCharacter` / `resolveStyle`；保留 `loraBook` / `styleBook` 兼容）
- Create: `test/characters.test.ts`

**Interfaces:**
- Consumes: `src/tools/tags/{ai-girls,honkai3rd,styles}.json`
- Produces:
  - `export interface LoraVariant { readonly file: string; readonly weight?: number; }`
  - `export interface LoraTarget { readonly backendId: string; readonly loraFamily: string; }`
  - `export interface ResolvedLora { readonly file: string; readonly weight: number; }`
  - `export interface ResolvedCharacter { readonly inject: string; readonly lora?: ResolvedLora; }`
  - `export interface ResolvedStyle { readonly lora?: ResolvedLora; }`
  - `export function normalizeLoraFamily(base: string): string`
  - `export function parseCharacterEntry(raw: unknown, where: string): CharacterEntry`
  - `export function resolveCharacter(key: string, target: LoraTarget): ResolvedCharacter | undefined`
  - `export function resolveStyle(key: string, target: LoraTarget): ResolvedStyle | undefined`

- [ ] **Step 1: 编写 `test/characters.test.ts` 失败测试**

覆盖：
- 既有词表零回归：`loraBook("claude")` / `styleBook("hsr")` 与迁前一致；`byKey` 大小写/连字符/空白归一化同样作用于 `resolveCharacter` / `resolveStyle`；
- 同族匹配（Review Focus #2）：`resolveCharacter("claude", { backendId: "anima3.8b", loraFamily: "anima" })` 与 `{ backendId: "anima2b", loraFamily: "anima" }` 均命中 `claude_girl_anima_lora_clean.safetensors`；
- 跨族角色降级与画风识别：`resolveCharacter("claude", { backendId: "sdxl", loraFamily: "sdxl" })` 返回 `{ inject: "...", lora: undefined }`；`resolveStyle("hsr", { backendId: "sdxl", loraFamily: "sdxl" })` 返回 `{ lora: undefined }`，未知 key 或角色 key 走 `resolveStyle` 返回 `undefined`（style key 走 `resolveCharacter` 返回 `undefined`）；
- `backendId > loraFamily > legacy base` 优先级：对 `parseCharacterEntry` 构造的带 `loras: { anima, "anima2.9b", sdxl }` 条目，验证 `anima2.9b` 命中特化文件/权重、`anima2b` 命中 `anima`、`sdxl` 命中 `sdxl`、`krea` 返回 `lora: undefined`；
- 非法 `loras` 校验：`parseCharacterEntry` 对非对象、空对象、非法键名、非 `.safetensors` 或含路径分隔符的文件名、权重越界（<0.4 或 >1.1）均抛错。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/characters.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/tools/characters.ts` 多底模解析**

按 Spec §3.3 实现上述导出（`resolveCharacter` / `resolveStyle` 均复用 `byKey`；`resolveLoraForTarget` 抽为内部共用函数并导出给测试或经 `resolveCharacter`/`resolveStyle` 验证；若需对合成条目单测优先级，可导出轻量纯函数 `resolveEntryLora(entry: CharacterEntry, target: LoraTarget): ResolvedLora | undefined`）。

- [ ] **Step 4: 运行全量测试验证通过**

Run: `node --test test/characters.test.ts && npm test`
Expected: PASS（全量 0 fail）

- [ ] **Step 5: 提交 Task 1**

```bash
git1 add src/tools/characters.ts test/characters.test.ts
git1 commit -m "feat(draw): 扩展角色与风格词表支持按模型族解析 LoRA"
```

---

### Task 2: 共享 ComfyUI 引擎、`DrawBackend` 抽象、零 IO 标识表与 `anima3.8b` 后端迁移

**Depends on:** `none` *(与 Task 1 文件完全无重叠，可并行执行)*

**Files:**
- Create: `src/tools/draw/engine.ts`（抽离底模无关的 `Graph`/`Node`/`Link`/`ComfyBusy`/`ComfyExecutionFailed`/`DrawStage`/`ExecOpts`/`comfyUrl`/`execGraph`/`uploadRefImage`/`runExclusive`；扩展 `requireGraphLoras` 支持 `LoraLoader`/`LoraLoaderModelOnly`；扩展 `requireGraphModelFiles` 支持多字段逐字段核对、内置标准节点表 + `extraModelFileFields` 与区分「未注册节点」/「清单异常」；支持 `ExecOpts.stageNodes`）
- Create: `src/tools/draw/backends/ids.ts`（零 IO：`DEFAULT_DRAW_BACKEND = "anima3.8b"`、`DRAW_BACKEND_IDS = ["anima3.8b"] as const`、`DrawBackendId`）
- Create: `src/tools/draw/backends/types.ts`（Spec §3.1 全部类型）
- Create: `src/tools/draw/backends/anima3.8b/workflow.json`（从 `src/tools/draw/workflow.json` 迁入）
- Create: `src/tools/draw/backends/anima3.8b/workflow-interaction.json`（从 `src/tools/draw/workflow-interaction.json` 迁入）
- Create: `src/tools/draw/backends/anima3.8b/workflow-interaction-single.json`（从 `src/tools/draw/workflow-interaction-single.json` 迁入）
- Create: `src/tools/draw/backends/anima3.8b/interaction-presets.json`（从 `src/tools/draw/interaction-presets.json` **复制**一份，旧根文件暂留到 Task 4 随 `tool.ts` 改造一起 `git rm`，保证 Task 2 零触碰 `tool.ts` 且提交点全绿）
- Create: `src/tools/draw/backends/anima3.8b/index.ts`（实现 `anima38bBackend: DrawBackend`；内部构图函数接 `{ inject, lora? }`，LoRA 节点按 `role?.lora !== undefined` 判定而 `inject` 始终注入；支持 `ref + fast` 叠加；`validateTemplates(...)` 拆为纯函数便于坏模板单测；导出 `makeGraph`/`makeInteractionGraph`/`makeInteractionSingleGraph` 兼容包装；移除未使用 `applyPlacement` 死代码）
- Create: `src/tools/draw/backends/registry.ts`（`DRAW_BACKENDS`、`getDrawBackend(id, overrides?)` 返回 `DrawBackend | undefined`、`validateAllDrawBackends()`，加载时断言 `DRAW_BACKENDS` 键集与 `DRAW_BACKEND_IDS` 一致）
- Modify: `src/tools/draw/comfy.ts`（转为轻量兼容门面：重导出 `engine.ts` 与 `backends/anima3.8b/index.ts` 的全部 11 个运行时值与 8 个类型，保留 `runComfy`/`runInteraction`/`runInteractionSingle` 包装并走统一 `runExclusive`）
- Modify: `src/tools/qwen_draw/comfy.ts`（改用 `../draw/comfy.ts` 导出的 `runExclusive` 替换本地独立 `busy`，统一 ComfyUI 单飞锁，导入路径不变）
- Create: `test/draw-backends.test.ts`

**Interfaces:**
- Consumes: `node:crypto`, `node:fs`（严禁 import `src/fish-config.ts`）
- Produces:
  - `src/tools/draw/engine.ts`：`Graph`, `Node`, `Link`, `ComfyBusy`, `ComfyExecutionFailed`, `DrawStage`, `ExecOpts`, `DEFAULT_MODEL_FILE_FIELDS`, `comfyUrl`, `execGraph`, `uploadRefImage`, `runExclusive`
  - `src/tools/draw/backends/ids.ts`：`DEFAULT_DRAW_BACKEND`, `DRAW_BACKEND_IDS`, `type DrawBackendId`
  - `src/tools/draw/backends/types.ts`：Spec §3.1 全部类型
  - `src/tools/draw/backends/registry.ts`：`DRAW_BACKENDS`, `getDrawBackend`, `validateAllDrawBackends`
  - `src/tools/draw/backends/anima3.8b/index.ts`：`anima38bBackend`, `validateAnima38bTemplates`, `ANIMA38B_RATIO_SIZES`, `makeGraph`, `makeInteractionGraph`, `makeInteractionSingleGraph`, `InteractionPreset`, `ComfyDraw`, `InteractionDraw`, `MultiPart`
  - `src/tools/draw/comfy.ts`：保留全部 11 个既有值导出 + `runExclusive` + 8 个类型导出

- [ ] **Step 1: 编写 `test/draw-backends.test.ts` 失败测试**

覆盖（Review Focus #2, #3, #4）：
- **多架构逐字段清单核对**：本地 mock HTTP ComfyUI server 测试 `execGraph`：
  - `LoraLoader` / `LoraLoaderModelOnly` 缺文件在 `onSubmitted` 前拒绝，在场放行；
  - `CheckpointLoaderSimple` 与 `DualCLIPLoader`（`clip_name1` 与 `clip_name2` 分别缺任一均拒、全在场放行）与 `extraModelFileFields` 自定义加载节点；
  - `/object_info/{classType}` 返回 `{}` 时报 `ComfyUI node not registered`（区别于清单格式非法 `invalid ComfyUI model inventory`）；
  - 既有 `AnimaLoRARemapTagLoader` 与 `RSMultiCharacterLoRA` 继续生效；
- **统一单飞锁 `runExclusive`**：并发二次进入立即抛 `ComfyBusy`；内部抛错或 abort 后正确释放锁；`runComfy` / `runInteraction` / `runExclusive` 共用同一把锁；
- **`stageNodes` 可配置**：自定义 `stageNodes: ["50"]` 时 WS `executing` 节点 `"50"` 触发 `onStage("sketch")`；
- **`anima3.8b` 后端契约与四模式 × 降级矩阵**：
  - `validateAllDrawBackends()` 通过；`validateAnima38bTemplates` 对篡改节点类型的副本抛 `contract mismatch`；
  - `single`、`fast`、`ref`、`ref + fast`（叠加生效、`workingVariant === "draw_fast"`、`stageNodes` 含 `["43","91"]`）、`multi`（含 `framing="wide"`, `spacing="apart"`, `bypass`/`pbypass`, `hd`）全矩阵生成预期图；
  - **四模式跨族降级矩阵**（`single`/`fast`/`ref`/`multi` 均传 `{ inject: "claude_girl, orange hair", lora: undefined }`）：全部不抛错、`inject` 正常拼入正向词且无 LoRA 加载节点（`g["4"]`/`g["93"]`/pass 链不存在、`characterN_lora === "None"`）；
  - `stageNodes` 精确值：`fast`/`ref`/`ref+fast` 为 `["43", "91"]`，`single`/`multi` 为 `undefined`；
- **兼容门面快照与类同一性**：断言 `Object.keys(await import("../src/tools/draw/comfy.ts"))` 包含全部 11 个既有值导出（`ComfyBusy`, `ComfyExecutionFailed`, `comfyUrl`, `execGraph`, `makeGraph`, `makeInteractionGraph`, `makeInteractionSingleGraph`, `runComfy`, `runInteraction`, `runInteractionSingle`, `uploadRefImage`），且 `comfy.ComfyBusy === engine.ComfyBusy`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/draw-backends.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `engine.ts`、`backends/{ids,types,registry}.ts`、`backends/anima3.8b/*`，更新 `comfy.ts` 与 `qwen_draw/comfy.ts`**

按 Spec §3.1 与 §3.4 实现；删掉旧 `src/tools/draw/{workflow,workflow-interaction,workflow-interaction-single}.json`（暂保留旧 `src/tools/draw/interaction-presets.json` 给尚未改造的 `tool.ts` 过渡）。

- [ ] **Step 4: 运行全量测试验证通过**

Run: `node --test test/draw-backends.test.ts && npm test`
Expected: PASS（全量 0 fail）

- [ ] **Step 5: 提交 Task 2**

```bash
git1 add src/tools/draw/engine.ts src/tools/draw/backends/ids.ts src/tools/draw/backends/types.ts src/tools/draw/backends/registry.ts src/tools/draw/backends/anima3.8b/ src/tools/draw/comfy.ts src/tools/qwen_draw/comfy.ts test/draw-backends.test.ts
git1 rm src/tools/draw/workflow.json src/tools/draw/workflow-interaction.json src/tools/draw/workflow-interaction-single.json
git1 commit -m "feat(draw): 抽离共享 ComfyUI 引擎并迁入 anima3.8b 插件后端"
```

---

### Task 3: `fish.config.json` 新增 `drawBackend` 热配置与 `config` 工具接入

**Depends on:** `Task 2` *(只依赖零 IO 的 `src/tools/draw/backends/ids.ts`)*

**Files:**
- Modify: `src/fish-config.ts`（`FishConfig.drawBackend: string`、`checkDrawBackend`、`FISH_CONFIG_FIELDS` 新增 `{ name: "drawBackend", effect: "hot", check: checkDrawBackend }`、`DEFAULTS.drawBackend = DEFAULT_DRAW_BACKEND`）
- Modify: `src/tools/config/TOOL.md`（受控字段表补充 `drawBackend` 热加载说明，注明同进程热切多管线可能引起显存驻留/it/s 漂移）
- Modify: `fish.config.example`（补充 `drawBackend` 与 `_drawBackend` 注释）
- Create: `test/draw-config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_DRAW_BACKEND`, `DRAW_BACKEND_IDS` from `src/tools/draw/backends/ids.ts`（零 IO 纯常量）
- Produces:
  - `FishConfig.drawBackend: string`
  - `FISH_CONFIG_FIELDS` 中 `{ name: "drawBackend", effect: "hot", check: checkDrawBackend }`

- [ ] **Step 1: 编写 `test/draw-config.test.ts` 失败测试**

覆盖（Review Focus #5）：
- 缺省：`loadFishConfig()` 返回 `drawBackend === "anima3.8b"`，且 `drawEnabled === true` 不受影响；
- 合法值：`{ drawBackend: "anima3.8b" }` 零告警加载；
- 非法值：`{ drawBackend: "unknown_model" }` / `{ drawBackend: 123 }` / `{ drawBackend: "" }` 记告警（包含可用值列表）并回落默认 `"anima3.8b"`；
- 热加载：`createConfigLoader` 修改文件推进 mtime 后立即生效；
- `config` 工具：`createConfigTool` 执行 `action: "set"` 测试合法 `drawBackend = "anima3.8b"` 写盘成功且回执标热加载；非法 `drawBackend = "sdxl-missing"` 拒绝写盘且磁盘 `fish.config.json` 逐字节不变；
- 文档与模板同步断言：`src/tools/config/TOOL.md` 字段表与 `fish.config.example` 均已登记 `drawBackend`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/draw-config.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/fish-config.ts`、`src/tools/config/TOOL.md`、`fish.config.example`**

在 `src/fish-config.ts` 中只 import `src/tools/draw/backends/ids.ts`，实现 `checkDrawBackend` 并注册至 `FISH_CONFIG_FIELDS` 与 `DEFAULTS`；更新 `TOOL.md` 与 `fish.config.example`。

- [ ] **Step 4: 运行全量测试验证通过**

Run: `node --test test/draw-config.test.ts && npm test`
Expected: PASS（全量 0 fail）

- [ ] **Step 5: 提交 Task 3**

```bash
git1 add src/fish-config.ts src/tools/config/TOOL.md fish.config.example test/draw-config.test.ts
git1 commit -m "feat(config): 增加 drawBackend 本地画图后端热配置字段"
```

---

### Task 4: 重构 `draw` 工具面接入 `DrawBackend`、严格能力预检、去模型化文档与宿主装配

**Depends on:** `Task 1`, `Task 2`, `Task 3`

**Files:**
- Modify: `src/tools/draw/tool.ts`（`createDrawTool` 开头调 `validateAllDrawBackends()`（未传自定义 `drawBackends` 时）；接入 `getDrawBackend` / `deps.drawBackends` / `deps.drawBackend`、`resolveCharacter` / `resolveStyle`、Spec §3.2 全序严格能力预检、`onLongWork` 移入 `onSubmitted` 回调、`stageNodes` 存在时才传 `onStage`、统一 `runExclusive` + `execGraph` + `uploadRefImage`、清理旧 `interaction-presets.json` 直接读取）
- Delete: `src/tools/draw/interaction-presets.json`
- Modify: `src/tools/draw/schema.json`（移除废弃 `placement_x` / `placement_y`，更新 `style`/`fast`/`prompt` 描述去掉 V8/步数/姿态线忽略细节）
- Modify: `src/tools/draw/TOOL.md`（去 Anima 3.8B / V8 / 步数 / 姿态线忽略 style 描述，统一为 danbooru 工具面说明）
- Modify: `src/tools/draw/messages.json`（保留 7 个 `qwen_draw` 共用 key；移除死 key `draw_preset_unknown`；新增 Spec §3.6 规定的 6 条文案）
- Modify: `src/tools/types.ts`、`src/fish/types.ts`、`src/fish/tool-surface.ts`、`src/app/runtime.ts`（新增并透传 `drawBackend?: () => string`；`ToolPackageDeps` 新增测试可注入 `drawBackends` / `drawExec` / `drawUploadRef`；`runtime.ts` 注入 `drawBackend: () => fishConfig().config.drawBackend`）
- Modify: `AGENTS.md`、`README.md`（同步 `draw` 多后端插件架构、workflow 新路径与 `drawBackend` 热配置说明）
- Create: `test/draw-tool.test.ts`

**Interfaces:**
- Consumes: Task 1–3 全部导出
- Produces: 完整的后端无关 `draw` 工具面、宿主热配置接线与全绿测试集

- [ ] **Step 1: 编写 `test/draw-tool.test.ts` 失败测试**

准备 3 个内存夹具后端（Review Focus #1, #2, #5）：
- `fake_anima2b`：`loraFamily: "anima"`, `modes: { single: true, fast: true, ref: false, multi: false }`, `hd: false`, `styleModes: ["single", "fast"]`, `framing: false`, `spacing: false`
- `fake_sdxl`：`loraFamily: "sdxl"`, 四模式全 `true`, `hd: true`, `styleModes: ["single", "fast", "ref"]`, `framing: true`, `spacing: true`
- `fake_limited`：`loraFamily: "anima"`, `modes: { single: true, fast: false, ref: true, multi: true }`, `hd: true`, `styleModes: ["fast", "ref"]`, `framing: false`, `spacing: false`

覆盖场景：
1. **热切后端生效**：同一 `createDrawTool` 实例先后返回 `fake_anima2b` → `fake_sdxl`，验证各自命中对应 `buildGraph`、`ratioSizes`、`outputNode`、`deadline`；
2. **全部 7 类严格能力预检（均不发 `onLongWork`、不锁轮、同轮可重试）**：
   - 未知 `drawBackend` → `draw_backend_unknown`（文案不含未知 ID）；
   - `fake_anima2b` 传 `characters`（缺 `multi`）/ `ref`（缺 `ref`）/ `hd: true`（缺 `hd`）；
   - `fake_limited` 传 `fast: true`（缺 `fast`）/ `ref + fast: true`（缺 `fast`）/ `single + style`（模式不支持 `style` → `draw_style_mode_unsupported`）/ `characters + framing: "wide"` 或 `spacing: "apart"`（缺构图参数 → `draw_composition_unsupported`）；
   - `fake_sdxl` 传 `style: "hsr"`（跨族无画风 LoRA → `draw_style_backend_unsupported`）；
3. **跨模型族角色 LoRA 降级与 `ref + fast`**：
   - `fake_anima2b` 传 `character: "claude"` 与 `style: "hsr"` → 均带真实 Anima LoRA；
   - `fake_sdxl` 传 `character: "claude"` → `role.lora === undefined` 且 `role.inject` 非空，出图成功；
   - `fake_sdxl` 传 `ref + fast: true` → `buildGraph` 收到 `mode === "ref"` 且 `fast === true`；
4. **`drawEnabled` 双复核、`onLongWork` 时序与 `stageNodes`**：
   - 入口关闭即拒；`onSubmitted` 瞬间关闭拒且 `submitted=false`、`onLongWork` 调用 0 次，重新打开后同轮可重试成功；
   - 后端 `stageNodes` 为 `undefined` 时不向 `execGraph` 传 `onStage`；声明 `stageNodes` 时正确传递；
5. **取消围栏、outbox 机械直发与 Schema 清理**：
   - 成功经 `enqueueOutbound` 发出，入队失败回退提示 `say_media`；出图后已 abort 零落盘零入队；
   - 验证 `draw` manifest 的 parameters 不再含 `placement_x` / `placement_y`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/draw-tool.test.ts`
Expected: FAIL

- [ ] **Step 3: 重构 `src/tools/draw/*`、宿主装配与文档**

按 Spec §3.2、§3.5、§3.6 与 Files 清单逐一实现与删除，并用 `rg` 确认全仓无悬空 `placement_x`/`placement_y`/`draw_preset_unknown` 引用（历史 `docs/plans/` 除外）。

- [ ] **Step 4: 运行全量测试与提示词审查命令**

Run: `npm test && npm run prompts`
Expected: 全部测试 PASS（0 fail），`npm run prompts` exit 0 且无 key 冲突与死文案。

- [ ] **Step 5: 提交 Task 4**

```bash
git1 add src/tools/draw/tool.ts src/tools/draw/schema.json src/tools/draw/TOOL.md src/tools/draw/messages.json src/tools/types.ts src/fish/types.ts src/fish/tool-surface.ts src/app/runtime.ts AGENTS.md README.md test/draw-tool.test.ts
git1 rm src/tools/draw/interaction-presets.json
git1 commit -m "feat(draw): 切换工具面与宿主装配至多模型后端架构"
```

---

## Execution Parallelization Notes

- **Wave 1（可真并发，文件完全不相交，须使用各自独立 `git worktree`）**：
  - Group A = **Task 1**（`src/tools/characters.ts`, `test/characters.test.ts`）
  - Group B = **Task 2**（`src/tools/draw/engine.ts`, `src/tools/draw/backends/*`, `src/tools/draw/comfy.ts`, `src/tools/qwen_draw/comfy.ts`, `test/draw-backends.test.ts`；暂保留旧 `src/tools/draw/interaction-presets.json` 留给 Task 4 删除）
- **Wave 1 集成检查点**：两分支合并进集成工作树后先跑一次全量 `npm test` 确认绿灯再开 Wave 2。
- **Wave 2（串行集成，依赖 Wave 1）**：
  - **Task 3**（`src/fish-config.ts`, `src/tools/config/TOOL.md`, `fish.config.example`, `test/draw-config.test.ts`）→ **Task 4**（`src/tools/draw/{tool.ts,schema.json,TOOL.md,messages.json}`, 宿主装配, `AGENTS.md`/`README.md`, `test/draw-tool.test.ts`）
- **容器部署提醒**：Task 2/4 删改了 `src/tools/draw/` 下的源文件，线上容器部署按 `AGENTS.md` 走 `up -d --force-recreate fish`（必要时清理旧挂载缓存）。
