# `draw` 本地 danbooru 多模型后端解耦设计规范

## 1. 背景与目标

当前本地 `draw` 工具与单个底模 **Anima 3.8B（DeltaMix 3.8B V8）** 深度耦合：启动契约写死 UNET 文件名与固定节点 ID，LoRA 加载器写死 28→52 层重映射节点 `AnimaLoRARemapTagLoader`，分辨率表、地板词、模式路由与预设名硬编码在 `tool.ts` / `comfy.ts`，角色/风格词表只有单一 `lora` 字段，无法在 Anima 2B / 2.9B / 3.8B / SDXL / Krea 等「严格使用 danbooru 词表的本地 ComfyUI 模型」之间自由热切换。

本规范将 `draw` 拆解为 **「统一 danbooru 工具面 + 共享 ComfyUI 执行内核 + 可插拔本地模型后端（`DrawBackend`）」** 三层架构，并引入 `fish.config.json` 热配置字段 **`drawBackend`** 实现零重启切换：

- **保持独立不动**：`qwen_draw`（本地自然语言 Qwen-Image-2.1 管线）与 `draw_remote`（云端远程生图）继续独立，不合并。
- **零回归迁移**：现有 Anima 3.8B（直出/fast/ref/ref+fast + 单人姿态线 + 双人 RS 姿态线）完整迁入首个内置后端 `anima3.8b` 作为默认后端，现有 `qwen_draw` 与 `scripts/experiments/*` 的导出兼容保持不断。
- **即插即用扩展**：后续接入 `anima2b`、`anima2.9b`、`sdxl`、`krea` 等新后端时，只需在 `src/tools/draw/backends/<id>/` 放入各自专属的单人/快速/改图/双人 workflow JSON 与适配器，并在 `backends/ids.ts` 与 `backends/registry.ts` 登记，无需修改 `tool.ts`、执行内核、`fish-config.ts` 或 `runtime.ts`。

## 2. 架构分层

```
模型（鱼）──▶ draw 统一工具面（src/tools/draw/tool.ts + TOOL.md + schema.json + messages.json）
                │  • 稳定 danbooru 参数面（不暴露底模名、步数、节点与预设）
                │  • 启动时调用 validateAllDrawBackends() 守住「缺位即拒启」
                │  • drawEnabled 资源闸（入口 + 提交前二次复核）
                │  • round 状态机（pending / submitted / used / uncertain）
                │  • 热读 drawBackend → 按后端 capabilities 严格能力预检
                │  • 角色/风格词表按 (backendId, loraFamily) 解析
                │  • 参考图安全围栏 + 预处理（normalizeInitImage）
                │  • outbox 机械直发
                ▼
         DrawBackend 标识与注册表
           ├── backends/ids.ts       （零 IO：DEFAULT_DRAW_BACKEND + DRAW_BACKEND_IDS，供 fish-config.ts 纯导入）
           ├── backends/registry.ts  （DRAW_BACKENDS + getDrawBackend + validateAllDrawBackends，启动校验键集一致）
           ├── backends/anima3.8b/   （内置默认：迁入 3 个 V8 workflow + interaction-presets.json）
           └── backends/<future>/    （anima2b / anima2.9b / sdxl / krea，各自独立 workflow 集）
                ▼
         共享 ComfyUI 执行引擎（src/tools/draw/engine.ts，经 comfy.ts 向后兼容导出）
           • loopback URL 强校验 + 统一单飞锁 runExclusive（draw 与 qwen_draw 共用）+ /queue 空闲闸
           • 可扩展多架构模型/LoRA 清单核对（逐字段核对 + 区分未注册节点与清单异常）
           • /upload/image 上传 + /prompt 提交 + 可配置 WS 阶段跟踪 + /history 轮询 + /view PNG 强校验
```

## 3. 核心契约

### 3.1 `DrawBackend` 接口（`src/tools/draw/backends/types.ts`）

```ts
export type DrawMode = "single" | "fast" | "ref" | "multi";
export type DrawRatio = "1:1" | "3:4" | "4:3" | "2:3" | "3:2" | "9:16" | "16:9";
export type DrawWorkingVariant = "draw" | "draw_fast" | "draw_interaction";

export interface DrawLoraRef {
  readonly file: string;
  readonly weight: number;
}

export interface DrawRoleInput {
  readonly inject: string;
  /** 当前后端族无匹配 LoRA 时为 undefined（角色自动降级为仅注入外观 tag） */
  readonly lora?: DrawLoraRef;
}

export interface DrawMultiPart {
  readonly text: string;
  readonly role?: DrawRoleInput;
}

export interface DrawCapabilities {
  /** 每个模式是否有对应 workflow：false 时工具层在提交前直接明确拒绝，不做隐式降级 */
  readonly modes: Readonly<Record<DrawMode, boolean>>;
  readonly hd: boolean;
  /** 允许挂全局 style LoRA 的模式列表（如 anima3.8b 为 ["fast", "ref"]） */
  readonly styleModes: readonly DrawMode[];
  readonly framing: boolean;
  readonly spacing: boolean;
}

export interface DrawBuildRequest {
  readonly mode: DrawMode;
  /** 是否开启快速步数档：mode==="fast" 时为 true；mode==="ref" 且用户传了 fast:true 时亦为 true（保 ref+fast 叠加能力） */
  readonly fast: boolean;
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly hd: boolean;
  readonly seed?: number;
  readonly role?: DrawRoleInput;
  readonly style?: DrawLoraRef;
  readonly parts?: readonly DrawMultiPart[];
  readonly refInputName?: string;
  readonly refStrength?: number;
  readonly framing?: "normal" | "wide";
  readonly spacing?: "together" | "apart";
  readonly bypass?: string;
  readonly pbypass?: string;
}

export interface DrawBuiltGraph {
  readonly graph: Graph;
  readonly outputNode: string;
  readonly outputType: "temp" | "output";
  /** 必须小于 runtime.ts 的 draw 工具外层超时（1800s） */
  readonly deadline: number;
  /** 对应 prompt/messages.md 中的 working_* 提示变体 */
  readonly workingVariant: DrawWorkingVariant;
  /** 可选：触发 onDrawStage("sketch") 的 ComfyUI 节点 ID 集合；未声明时不挂 WS 阶段跟踪 */
  readonly stageNodes?: readonly string[];
}

export interface DrawBackend {
  readonly id: string;
  /** LoRA 兼容族（如 "anima" / "sdxl" / "krea"）；Anima 2B / 2.9B / 3.8B 共享 "anima" 族 */
  readonly loraFamily: string;
  /** 本底模的 7 种比例对应宽高（像素，必须为 8 的倍数） */
  readonly ratioSizes: Readonly<Record<DrawRatio, readonly [number, number]>>;
  readonly capabilities: DrawCapabilities;
  /** 可选：本后端额外自定义加载节点的模型清单映射（class_type → required 字段名数组），与内置默认表合并 */
  readonly extraModelFileFields?: Readonly<Record<string, readonly string[]>>;
  /** 启动期结构契约校验：校验本后端全部 workflow JSON 关键节点在场、类型正确及模型字段覆盖 */
  validateStartup(): void;
  /** 构建本后端的 ComfyUI 图与执行参数 */
  buildGraph(request: DrawBuildRequest): DrawBuiltGraph;
}
```

- **启动期契约校验调用点**：`createDrawTool`（在 `loadToolSurface` / 启动阶段必经）开头调用 `validateAllDrawBackends()`，确保任意已注册后端的 workflow 节点缺位或类型错位在启动即拒启；且 `registry.ts` 加载时校验 `DRAW_BACKENDS` 键集与 `backends/ids.ts` 的 `DRAW_BACKEND_IDS` 一一对应。
- **`anima3.8b` 后端 `stageNodes` 与 `workingVariant` 精确约定**：
  - `mode === "fast"` 或 (`mode === "ref"` 且 `fast === true`)：`workingVariant = "draw_fast"`，`stageNodes = ["43", "91"]`
  - `mode === "ref"` 且 `fast === false`：`workingVariant = "draw"`，`stageNodes = ["43", "91"]`
  - `mode === "single"` 或 `mode === "multi"`：`workingVariant = "draw_interaction"`，`stageNodes = undefined`（不挂 WS 阶段跟踪，与迁前零差异）。
- **跨族降级角色在构图器内的处理**：内部构图函数接收 `DrawRoleInput`（`{ inject, lora? }`）。LoRA 节点创建与校验只看 `role?.lora !== undefined`；正向提示词注入看 `role !== undefined`（`role.inject` 始终拼入，不因 `lora` 为 `undefined` 而静默丢弃或抛 `invalid role`）。

### 3.2 严格能力声明与全序校验（零隐式降级）

工具层 `execute` 按以下**确定全序**校验（全部在 `onSubmitted` 与 `onLongWork` 之前，失败时 `submitted` 保持 `false`、不锁轮）：

1. **入口总闸与轮次基础校验**：
   - `!enabled()` → `draw_disabled`
   - 既有基础参数校验（原序保持零回归）：`prompt` 类型与长度（≤1000，允许空串）、`!deps.comfyUrl`（`draw_off`）、`hd`/`fast`/`character`/`style`/`ref` 类型、`fast && (hd || characters)`（`draw_fast_scope`）、`framing`/`spacing` 枚举（`draw_composition`）、单人传 `framing`/`spacing`（`draw_composition_multi`）、`characters` 互斥与结构校验（`draw_characters_conflict` / `draw_multi_unsupported`（双人含 `style` 或 `ref`）/ `draw_characters_count` / `draw_multi_sides` / `draw_region_retired` / `draw_multi_length`）。
2. **轮状态检查**：
   - `round === undefined` → `draw_round_missing`
   - `previous?.pending` → `draw_inflight`
   - `previous?.round === round && previous.used` → `draw_used`
   - `previous?.round === round && previous.submitted` → `draw_uncertain`
3. **热读后端**：
   - `backendId = deps.drawBackend?.() ?? DEFAULT_DRAW_BACKEND`
   - `backend = getDrawBackend(backendId, deps.drawBackends)`（未命中返回 `undefined`）→ 抛 `draw_backend_unknown`（不向模型暴露内部底模 ID）
4. **推导 `mode` 与 `fast`**：
   - `mode = characters !== undefined ? "multi" : ref !== undefined ? "ref" : fast === true ? "fast" : "single"`
   - `isFast = fast === true`
5. **按 `backend.capabilities` 严格能力校验（不做隐式降级）**：
   - `!backend.capabilities.modes[mode]` → `draw_mode_unsupported`（带面向模型的可读模式名 `{{mode}}`）
   - `isFast && !backend.capabilities.modes.fast` → `draw_mode_unsupported`（拦截 `ref + fast` 但后端不支持快速模式的情况）
   - `hd === true && !backend.capabilities.hd` → `draw_hd_unsupported`
   - `style !== undefined && !backend.capabilities.styleModes.includes(mode)` → `draw_style_mode_unsupported`（双人传 `style` 已在第 1 步由 `draw_multi_unsupported` 拦下；`anima3.8b` 在 `single` 模式传 `style` 改为明确拒绝，不再静默忽略）
   - `(framing !== undefined && !backend.capabilities.framing) || (spacing !== undefined && !backend.capabilities.spacing)` → `draw_composition_unsupported`
6. **比例解析**：
   - `ratio = args.ratio ?? "3:4"`，查 `backend.ratioSizes[ratio]`；不在表内 → `draw_ratio`。
7. **词表解析（按 `{ backendId: backend.id, loraFamily: backend.loraFamily }`）**：
   - 角色（`character` / `characters[].character`）：`resolveCharacter(key, target)` 返回 `undefined` → `draw_character`；命中但 `lora === undefined` → 保留 `inject` 自动降级纯 tag。
   - 画风（`style`）：`resolveStyle(key, target)` 返回 `undefined` → `draw_style`；命中但 `lora === undefined` → `draw_style_backend_unsupported`。
8. **参考图预处理与单飞执行**：
   - `mode === "ref"` 时执行 `prepareRef(args.ref, context.abortSignal)`；
   - 在 `runExclusive` 锁内上传参考图（如有）→ 调用 `backend.buildGraph(...)` → 调用 `execGraph(...)`。
   - `onSubmitted` 在 `execGraph` 真正 `POST /prompt` 前同步触发：再次热读 `enabled()`（关闭抛 `DrawDisabledError` 且 `submitted` 保持 `false`）→ `state.submitted = true` → 同步调用 `deps.onLongWork?.(built.workingVariant, round)`（不 await）。

### 3.3 角色与风格词表多底模解析（`src/tools/characters.ts`）

- **数据向后兼容**：现有 `src/tools/tags/{ai-girls,honkai3rd,styles}.json` 的 `{ key, group, name, lora, inject, weight, base, source, match, sections }` 保持零改动、顶层 `lora` 必填约束不变（避免影响 `tags/tool.ts` 及冻结实验资源校验）。
- **可选多底模覆盖字段 `loras`**：条目可新增可选字段：
  ```json
  "loras": {
    "anima": { "file": "claude_girl_anima_lora_clean.safetensors", "weight": 1.0 },
    "anima2.9b": { "file": "claude_girl_anima29b.safetensors", "weight": 0.9 },
    "sdxl": { "file": "claude_girl_sdxl.safetensors", "weight": 0.85 }
  }
  ```
  校验规则：`loras` 若存在必须为非空普通对象，键名符合 `/^[a-z0-9][a-z0-9._-]*$/`，每项 `file` 必须以 `.safetensors` 结尾且符合安全文件名正则，`weight` 可选（缺省沿用条目 `weight`），若提供须在 `0.4–1.1`。
- **`normalizeLoraFamily(base)`**：对 `base` 做 trim + lower-case 归一化（例如 `"Anima"` → `"anima"`，`"SDXL"` → `"sdxl"`；对 SDXL 子系列如 Illustrious/NoobAI 等非 `"sdxl"` 字面 `base`，应通过显式 `loras` 键声明对应族）。
- **解析函数（对称签名，均复用 `byKey` 归一化）**：
  - `resolveCharacter(key, target: LoraTarget): ResolvedCharacter | undefined`（未知或 style 组返回 `undefined`；命中返回 `{ inject, lora? }`）
  - `resolveStyle(key, target: LoraTarget): ResolvedStyle | undefined`（未知或非 style 组返回 `undefined`；命中返回 `{ lora? }`）
  - LoRA 查找优先级：`entry.loras?.[target.backendId]` → `entry.loras?.[target.loraFamily]` → (`normalizeLoraFamily(entry.base) === target.loraFamily` 时取 `{ file: entry.lora, weight: entry.weight }`) → `undefined`。
- **`loraBook` / `styleBook` 保持既有签名与行为**，保障 `scripts/experiments/*` 与 `src/tools/tags/tool.ts` 零破坏。

### 3.4 共享 ComfyUI 执行引擎扩展（`src/tools/draw/engine.ts`）

从 `src/tools/draw/comfy.ts` 抽离 `src/tools/draw/engine.ts`，`comfy.ts` 作为轻量兼容门面重导出全部既有 11 个运行时值导出 + 8 个类型导出，且 `src/tools/qwen_draw/comfy.ts` 同步改用同一 `runExclusive` 锁，消除 `draw` 与 `qwen_draw` 并发过 `/queue` 闸的 TOCTOU 竞态：

1. **统一单飞锁 `runExclusive<T>(fn: () => Promise<T>): Promise<T>`**：正在执行时第二次调用立即抛 `ComfyBusy`，正常返回/抛错/abort 均在 `finally` 释放。
2. **`requireGraphLoras` 扩展**：扫描以下节点的 LoRA 文件并在提交前向 `/object_info/LoraLoader` 核对：
   - `AnimaLoRARemapTagLoader`（解析 `inputs.text` 中的 `<lora:file:weight>`）
   - `RSMultiCharacterLoRA` / `RSMultiCharacterPrompts`（`characterN_lora` 非 `"None"`）
   - `LoraLoader` / `LoraLoaderModelOnly`（`inputs.lora_name` 非 `"None"`）
3. **`requireGraphModelFiles` 扩展（逐字段核对 + 后端可扩展）**：
   - 内置标准表 `DEFAULT_MODEL_FILE_FIELDS: Record<string, readonly string[]>`：
     - `UNETLoader`: `["unet_name"]`
     - `CLIPLoader`: `["clip_name"]`
     - `DualCLIPLoader`: `["clip_name1", "clip_name2"]`
     - `VAELoader`: `["vae_name"]`
     - `CheckpointLoaderSimple`: `["ckpt_name"]`
     - `CheckpointLoader`: `["ckpt_name"]`
     - `ControlNetLoader`: `["control_net_name"]`
     - `CLIPVisionLoader`: `["clip_name"]`
     - `StyleModelLoader`: `["style_model_name"]`
     - `UpscaleModelLoader`: `["model_name"]`
     - `ModelPatchLoader`: `["name"]`
   - `ExecOpts` 支持可选 `extraModelFileFields?: Readonly<Record<string, readonly string[]>>` 与内置表合并；
   - 按 `(classType, fieldName)` 逐字段查 `/object_info/${classType}`：若返回的 JSON 不含 `info[classType]`，明确报错 `ComfyUI node not registered: ${classType}`（与清单格式异常 `invalid ComfyUI model inventory` 区分）。
4. **可配置阶段跟踪**：`ExecOpts.stageNodes?: readonly string[]`，仅在调用方传入 `onStage` 且 `stageNodes` 非空（或省略时兼容默认 `["43", "91"]`）时触发 `onStage("sketch")`。

### 3.5 `fish.config.json` 热配置与宿主装配

- **零 IO 后端标识清单 `src/tools/draw/backends/ids.ts`**：仅导出 `DEFAULT_DRAW_BACKEND = "anima3.8b"` 与 `DRAW_BACKEND_IDS = ["anima3.8b"] as const`（纯常量，零 `fs`/JSON 读取，防止 `src/fish-config.ts` 引入任何 workflow IO 或循环依赖；硬约束：所有 `backends/*` 模块严禁 import `src/fish-config.ts`）。
- **新增受控热字段 `drawBackend`**（`src/fish-config.ts`，`effect: "hot"`）：
  - 与既有 `drawEnabled` 并列，不重复定义 `enabled`（线上 `fish.config.json` 零迁移）。
  - `checkDrawBackend(raw)`：校验为字符串且命中 `DRAW_BACKEND_IDS`，非法时明确报错列出可用值（`drawBackend 仅支持 anima3.8b`）。
  - 注释说明：同进程热切多套 ComfyUI 管线时可能出现显存驻留/it/s 漂移，属 ComfyUI dynamic VRAM 特性（参见 `AGENTS.md` 排障规程）。
- **宿主注入**：
  - `FishOptions`（`src/fish/types.ts`）与 `ToolPackageDeps`（`src/tools/types.ts`）新增 `drawBackend?: () => string`；`ToolPackageDeps` 另增测试注入钩子 `drawBackends?: ReadonlyMap<string, DrawBackend>`、`drawExec?: typeof execGraph`、`drawUploadRef?: typeof uploadRefImage`。
  - `src/app/runtime.ts` 注入 `drawBackend: () => fishConfig().config.drawBackend`，`src/fish/tool-surface.ts` 透传。
  - `src/tools/config/TOOL.md` 与 `fish.config.example` 同步登记 `drawBackend`。

### 3.6 `draw` 工具面去模型化与文案契约

- **`src/tools/draw/schema.json`**：
  - 删除废弃的 `placement_x` 与 `placement_y`。
  - `style.description` 与 `fast.description` 去掉「V8」「28 步 + 8 步」「1.2x」「姿态线忽略」等 Anima 3.8B 实现细节（`style` 改为说明「部分模式或底模不支持画风，会以回执告知」）。
- **`src/tools/draw/TOOL.md`**：
  - 保留全部 danbooru 提示词纪律、查 `tags` 词表规则、角色/服装注入、双人区分描述、`framing`/`spacing`、`hd`/`fast`/`ref` 意图与 outbox 机械直发约定。
  - 移除 V8 / 步数 / CFG / single-haystack / RS 剪影 / 「姿态线忽略 style」等旧描述，改为说明本地画图底模由主人热配置控制、若当前底模不支持某项模式或参数会直接回执拒绝。
- **`src/tools/draw/messages.json`**：
  - **严格保留既有 7 个被 `qwen_draw` 共用的 key**（`draw_used`/`draw_inflight`/`draw_uncertain`/`draw_busy`/`draw_off`/`draw_disabled`/`draw_round_missing`）。
  - 移除不再消费的死 key `draw_preset_unknown`。
  - 新增 6 条文案（所有 `{{var}}` 严格匹配 `tool.ts` 传参）：
    - `draw_backend_unknown`: `"当前配置的本地画图后端不可用，请联系主人检查 drawBackend 配置"`（无变量，不向模型泄露内部底模名）
    - `draw_mode_unsupported`: `"当前本地画图模型暂不支持{{mode}}模式，请调整参数后重试"`（变量 `{{mode}}`：单人从零画 / 快速 / 改图 / 双人同框）
    - `draw_hd_unsupported`: `"当前本地画图模型暂不支持高清模式（hd），去掉 hd 后可重试"`
    - `draw_style_mode_unsupported`: `"当前模式不支持全局画风（style），请去掉 style 或切换支持画风的模式（如 fast / ref）"`
    - `draw_style_backend_unsupported`: `"当前本地画图模型没有「{{key}}」对应的画风 LoRA，请去掉 style 或在 prompt 中用英文画风词描述"`（变量 `{{key}}`）
    - `draw_composition_unsupported`: `"当前本地画图模型暂不支持双人构图参数（framing / spacing），去掉后再试"`

## 4. 验收标准

1. `npm test` 全量通过（含新建 `test/characters.test.ts`、`test/draw-backends.test.ts`、`test/draw-config.test.ts`、`test/draw-tool.test.ts` 及全部既有测试）。
2. `npm run prompts` exit 0，无 key 冲突与死文案，`draw` schema 不再含 `placement_x`/`placement_y`。
3. `src/tools/draw/comfy.ts` 运行时值导出快照（11 个值）与 `ComfyBusy` 类同一性零回归，`qwen_draw` 共用同一 `runExclusive` 锁且既有测试全绿。
4. `AGENTS.md`、`README.md`、`fish.config.example`、`src/tools/config/TOOL.md` 同步收口（含容器部署需 `up -d --force-recreate fish` 的提醒）。
