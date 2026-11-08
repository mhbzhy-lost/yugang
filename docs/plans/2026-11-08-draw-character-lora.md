# draw 角色 LoRA（AI 娘）实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 把 Windows SD WebUI 里的 AI 娘化 LoRA 迁移到 ComfyUI，并给 `draw` 工具加受控角色参数——模型指定支持的角色时自动挂 LoRA + 触发词出图。

**架构：** 复用 `makeGraph` 既有的动态注入先例（hsr preset 的 "88" `AnimaLoRARemapTagLoader` 节点），为角色 LoRA 新增 "93" 节点链式注入；角色名单是 tool.ts 内的受控映射常量 + schema.json 枚举，启动时双向一致性校验。Windows 侧只拷贝 LoRA 文件，ComfyUI 与 workflow.json 均零配置变更。

**技术栈：** TypeScript（pi-durable 工具包）、ComfyUI API（`/prompt`、`/object_info`、`/upload/image`）、AnimaLoRARemapTagLoader 自定义节点、`scripts/connect.sh` Windows 通道。

## 全局约束

- **安全边界（最高优先）**：draw 继续不接受模型传入工作流、节点、模型名或地址；`character` 只能取 schema.json 枚举白名单；`lora_weight` 窄区间（0.4–1.1，默认 0.8）机械校验，越界以 tool 错误返回；LoRA 文件名、触发词、特征 tags 全部来自 `CHARACTERS` 常量，模型无法注入。
- **workflow.json 与 `WORKFLOW_HASH` 不变**：角色 LoRA 走动态注入（"93" 节点模板硬编码在 comfy.ts），与既有 "88"（hsr）、"19"/"20"（ref）、"90"–"92"（超分）同一模式。
- **迁移语义 = 拷贝**：WebUI 侧原件不动；只把确认名单里的文件拷入 ComfyUI 的 `models/loras/`。
- **初期只收 AI 娘系角色**（大肥鱼/克劳德/GPT 娘/Gemini 娘等社区 AI 拟人），其他题材后续另行计划；最终名单以 T1 报告 + 主人确认为准。
- **Windows 操作只经 `/Users/mhbzhy/.agents/skills/home-windows-connect/SKILL.md` 描述的 `scripts/connect.sh windows -- <cmd>`**（LAN 优先→Tailscale，禁止自动走杭州中继）；不重启 Windows/WSL、不动防火墙/Tailscale/OpenSSH。
- `comfyUrl()` 的 `127.0.0.1` 强约束不放宽；联调脚本可直连 Windows 的 ComfyUI 临时地址（仅验证，不进生产路径）。
- 不 commit、不 push、不部署（主人已明确「不急部署」）。
- 新增测试仅作为「建议（待用户授权）」；既有断言可随本变更最小同步（需在任务报告中说明每一处）。
- 代码注释与 TOOL.md 文案中文；`prompt/`、`TOOL.md` 是模型侧文字唯一合法位置。
- 角色键名用小写英文（如 `claude`、`deepseek`），便于 schema 枚举与代码引用；不得与既有工具参数名冲突。

## 整体交付终态

draw 工具支持 AI 娘角色 LoRA 生图：模型传受控 `character` 参数即自动挂对应 LoRA（含触发词与特征 tags 机械注入），Windows ComfyUI 已具备对应文件并通过真机联调；仓库改动测试全绿、审查入口干净，处于「随时可部署」状态（部署本身不在本计划内）。

| ID | 必要条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | Windows 侦察报告落盘，含 WebUI 全部 AI 娘系 LoRA 四元组（文件名/大小/触发词线索/来源旁文件）与 ComfyUI 安装位置、端口、`models/loras/` 现状；主人确认最终名单 | 主人阅读 `/tmp/draw-lora-survey.md` 并逐角色确认 | 每个入选角色有：角色键名、lora 文件名、触发词、特征 tags 四要素，主人明示认可 | `/tmp/draw-lora-survey.md` + 会话确认记录 | T1 |
| F2 | 确认名单的全部 LoRA 文件已存在于 ComfyUI `models/loras/`，且 ComfyUI 已识别 | `connect.sh windows -- curl -s http://127.0.0.1:<端口>/object_info/LoraLoader`（在 Windows 本机执行）查 `lora_name` 枚举 | 每个入选文件名都出现在枚举里；报告记录原始 JSON 证据 | T2 任务报告 | T2 |
| F3 | `makeGraph` 支持结构化 `lora` 注入：新节点 "93"（AnimaLoRARemapTagLoader 模板）、与 hsr（"88"）/ref（"19"/"20"）正交可叠加、`lora.tags` 机械插入 positive 前部 | 代码审阅 + `npm test`（如授权则含新增注入断言） | 节点模板常量硬编码；非法 character / 越界 weight 以 tool 错误返回；四条组合路径（纯角色、角色+hsr、角色+ref、角色+hsr+ref）的连线正确 | T3 任务报告 + diff | T3 |
| F4 | schema.json 新增 `character` 枚举与 `lora_weight`，枚举与 `CHARACTERS` 键集一致且启动时双向校验；TOOL.md 使用指南同步（AI 娘角色优先走 character，官方 anime 角色仍走 tags 词表流程）；tags 工具可查 AI 娘角色官方 tag（含服装段落） | `npm run prompts` 输出人工核对 + 启动校验代码审阅 + 词表查询路径代码审阅 | prompts 清单无意外条目；构造键集漂移的临时场景使启动校验抛错（验证后还原）；ai-girls.json 为严格 JSON 且 8+1 角色齐全 | T3 任务报告 + `npm run prompts` 输出 | T3 |
| F5 | `npm test` 全绿、`npm run prompts` 干净 | 本地开发机仓库根目录执行两条命令 | fail 0；无意外条目、无内嵌扫描违规 | 命令输出（T3/T4 报告引用） | T3、T4 |
| F6 | 真机联调：带 character 的完整 graph 提交到 Windows ComfyUI 并返回合法 PNG | 本地起 SSH 隧道（或 Windows 本机 curl）向 ComfyUI `/prompt` 提交 makeGraph 产物，取回输出图 | 返回非空 PNG（8 字节签名 + IHDR），图中主体符合该角色特征（人工看图确认） | `/tmp/draw-lora-e2e.png` + T4 报告 | T4 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## DAG

```text
T1 (侦察: WebUI LoRA 清单 + ComfyUI 现状 + 主人确认名单)
 ├──> T2 (Windows: 拷贝 LoRA 到 ComfyUI + object_info 验证)
 └──> T3 (仓库: comfy.ts + tool.ts + schema.json + TOOL.md)
          T2 ──> T4 (真机联调: character 生图)
          T3 ──↗
```

- T2/T3 只依赖 T1 的名单产物（T3 要文件名/触发词/tags 数据，T2 要文件清单），二者写路径无交集，可并行。
- T4 依赖 T2（ComfyUI 有文件）与 T3（makeGraph 能产出注入后的 graph），缺一不可。

## Waves

- Wave 1：T1（含主人确认里程碑，名单未确认前不得进入 Wave 2）
- Wave 2：T2、T3（可并行派发）
- Wave 3：T4（等待 T2 与 T3 全部完成）

**关键路径：** T1 → T3 → T4（仓库实现与联调在关键路径上；T2 可与 T3 并行，不制约总工期）。

---

### Task 1：Windows LoRA 库存侦察（只读）

**Deps：** `none`

**WritePaths：** 无仓库写入。产出物在 `/tmp/draw-lora-survey.md`（报告）。

**Resources：** Windows 机器访问（`connect.sh` 通道，1 个并发）；无仓库资源。

**Files：**
- Create：`/tmp/draw-lora-survey.md`
- Modify：无
- Suggested Test（待用户授权）：无

**接口契约：**
- Consumes：`/Users/mhbzhy/.agents/skills/home-windows-connect/SKILL.md`（先 read 再用，`scripts/connect.sh windows -- <cmd>`；SD WebUI 可能跑在 WSL，必要时 `connect.sh wsl -- <cmd>`）
- Produces：`/tmp/draw-lora-survey.md`，必须含两章——①「候选清单」每行四元组 `角色键名建议 | lora 文件名 | 触发词线索 | 特征 tags 建议`（触发词线索来自 `.civitai.info`/`.json` 旁文件、文件名、训练集备注；找不到就写「无旁文件，需人工定」）+ 文件字节数 + 主题判断依据；②「环境事实」：SD WebUI 与 ComfyUI 各自安装路径（Windows 原生还是 WSL）、ComfyUI 监听端口、`models/loras/` 现有文件清单、ComfyUI 是否在线（`curl /system_stats` 结果）

**终态关联：** `F1`（本任务产出名单与环境事实，是全计划的数据源）。

**验收标准：**

- [ ] **步骤 1：通读 skill 并连通 Windows**

先 read `/Users/mhbzhy/.agents/skills/home-windows-connect/SKILL.md`，按其路由用 `scripts/connect.sh windows-check` 确认通道，再定位 SD WebUI 安装（典型 `models/Lora/` 或 WSL 内路径）与 ComfyUI 安装。禁止自动 fallback 杭州中继。

- [ ] **步骤 2：枚举 LoRA 与元数据**

列出 WebUI LoRA 目录全部 `*.safetensors`（文件名+字节数）；对每个文件查同名 `.civitai.info`/`.json` 旁文件提取触发词与训练说明；按「AI 娘系拟人」主题分类（deepseek/claude/gpt/gemini/grok/glm/doubao 等关键词 + 旁文件描述），非 AI 娘题材单独归类不计入候选。

- [ ] **步骤 3：核查 ComfyUI 环境**

确认 ComfyUI 安装路径、端口（`COMFYUI_URL` 生产为 macmini 隧道 `127.0.0.1:18190`，落到 Windows 侧真实端口需在此查实）、`models/loras/` 现状、`/system_stats` 与 `/object_info/LoraLoader` 是否可用。

- [ ] **步骤 4：写报告并回报主人确认**

报告落盘 `/tmp/draw-lora-survey.md` 后结束任务，输出中列出候选四元组表请主人勾选；**主人确认前不得进入 T2/T3**。

**建议（待用户授权）：** 无新增测试。

---

### Task 2：LoRA 文件迁移到 ComfyUI

**Deps：** `T1`（理由：消费 T1 报告「候选清单」中主人确认的文件名单与「环境事实」中的路径/端口；未确认名单不得拷贝）

**WritePaths：** 无仓库写入。写入目标为 Windows 上 ComfyUI 的 `models/loras/` 目录（经 connect.sh 远程操作）。

**Resources：** Windows 机器访问（1 个并发）；大文件拷贝走 `connect.sh large-check` 前置（LAN 优先，Tailscale 必须 direct）。

**Files：**
- Create：Windows ComfyUI `models/loras/<名单内文件>`（拷贝）
- Modify：无（WebUI 原件不动）
- Suggested Test（待用户授权）：无

**接口契约：**
- Consumes：T1 报告的确认名单（文件名→WebUI 全路径映射）与环境事实（ComfyUI loras 目录路径、端口）
- Produces：F2 事实——每个名单文件存在于 ComfyUI `models/loras/` 且 `/object_info/LoraLoader` 的 `lora_name` 枚举包含其文件名

**终态关联：** `F2`（T4 联调的前提）。

**验收标准：**

- [ ] **步骤 1：核对名单与路径**

从 `/tmp/draw-lora-survey.md` + 主人确认记录取名单；逐一核对源文件存在、目标目录可写；核对 ComfyUI 目标盘剩余空间 ≥ 名单文件总大小（`df` 或等价命令），不足即停止报告；发现名单文件在 WebUI 侧缺失时停止并报告，不跳过不代换。

- [ ] **步骤 2：拷贝**

`large-check` 通过后逐文件拷贝（WebUI loras → ComfyUI loras）；拷贝后逐文件比对字节数一致。

- [ ] **步骤 3：ComfyUI 识别验证**

Windows 本机 `curl -s http://127.0.0.1:<端口>/object_info/LoraLoader` 解析 `lora_name` 枚举，确认每个文件名在列；顺带 `curl /object_info/AnimaLoRARemapTagLoader` 确认自定义节点在场（生产 hsr preset 在用，预期必有；缺失即报告阻塞）。ComfyUI 默认自动扫描目录，若未出现则通过 API 触发刷新后重查一次；仍不出现即报告阻塞，不重启 ComfyUI 进程——重启需主人明确指示。

- [ ] **步骤 4：记录证据**

报告记录每个文件的拷贝结果与 object_info 枚举原文片段。

**建议（待用户授权）：** 无新增测试。

---

### Task 3：draw 角色 LoRA 仓库实现

**Deps：** `T1`（理由：消费 T1 报告「候选清单」中主人确认的四元组——角色键名、lora 文件名、触发词、特征 tags——作为 `CHARACTERS` 常量的数据源）

**WritePaths：**
- `src/tools/draw/comfy.ts`
- `src/tools/draw/tool.ts`
- `src/tools/draw/schema.json`
- `src/tools/draw/TOOL.md`
- `src/tools/draw/messages.json`
- `src/tools/tags/tool.ts`
- `src/tools/tags/TOOL.md`
- `src/tools/tags/ai-girls.json`
- `test/**`（仅限既有断言的最小同步；新增测试不在授权内）

**Resources：** 无（本任务不碰 Windows、不跑真机；联调在 T4）。

**Files：**
- Modify：`src/tools/draw/comfy.ts`（ComfyDraw 扩展 + makeGraph 注入）、`src/tools/draw/tool.ts`（CHARACTERS + 参数校验 + 一致性校验）、`src/tools/draw/schema.json`（character/lora_weight）、`src/tools/draw/TOOL.md`（使用指南）、`src/tools/draw/messages.json`（draw_character / draw_lora_weight 拒绝回执）；`src/tools/tags/tool.ts` + `src/tools/tags/TOOL.md`（AI 娘角色词表查询，主人 2026-11-08 确认增补）
- Create：`src/tools/tags/ai-girls.json`（AI 娘角色完整 tag 词表，数据源为本地已抓取的 `/tmp/draw-lora-meta/*.json`——两个 LoRA 作者 civitai 发布页全文缓存；收录 claude_girl 全套与 aigrils 8 角色的触发词/基础外观/头饰/上衣/下身/脚官方套装段落）
- Suggested Test（待用户授权）：`test/tools.test.ts` 新增 makeGraph 注入断言（"93" 节点、四条组合路径连线、text 注入顺序）与非法参数拒绝断言

**接口契约：**
- Consumes：T1 报告确认名单（角色键名/lora 文件名/触发词/特征 tags）；comfy.ts 现有 `ComfyDraw`、`makeGraph`、`WORKFLOW_HASH`；tool.ts 现有 `RATIO_SIZES`（已提升为 1216 长边档）、`defineTool`、manifest 依赖注入
- Produces：
  - `ComfyDraw.lora?: { file: string; weight: number; tags: string }`（tool.ts 查映射后传入；comfy.ts 不感知角色概念）
  - makeGraph 行为：有 `lora` 时创建节点 `"93": { class_type: "AnimaLoRARemapTagLoader", inputs: { model, clip, text: "<lora:<file>:<weight>>", default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } }`；model/clip 输入接 "88"（hsr 在场时）或 "1"/"2"（不在场时）；`["7","11","14","42"]` 的 model 线与 `["4","5","11","42"]` 的 clip 线改接 "93" 的输出；`lora.tags + ", "` 插入 `graph["4"].inputs.text` 的内置前缀之后、`args.prompt` 之前
  - `CHARACTERS: Record<string, { lora: string; trigger: string; tags: string }>` 常量（tool.ts，值来自 T1 名单；`tags` 已含 trigger，注入时整体前置）
  - 工具参数：`character`（枚举 = `Object.keys(CHARACTERS)`，不填 = 不挂 LoRA）、`lora_weight`（number，0.4–1.1，缺省 0.8，非数值或越界以 tool 错误返回）；非法 `character` 同样 tool 错误返回
  - 启动一致性校验：factory 创建时校验参数 Schema 的 `character` 枚举与 `CHARACTERS` 键集严格相等（枚举直接取 factory 首参 `manifest` 的参数 Schema，恒可得，不设第二读取路径），不等直接抛错——「对不上就起不来」
  - 拒绝回执（INV-EXIT，与失败落点同变更落地）：`draw_character`（非法角色名：写明触发条件与当前可用角色名单，`next:` 引导改传名单内值或不传）与 `draw_lora_weight`（数值越界：写明合法区间 0.4–1.1 与缺省 0.8，`next:` 引导传区间内值或不传）两个 key 落 `src/tools/draw/messages.json`（key 名 `[a-z][a-z0-9_]*`，不与中心文件及其它工具重复，撞车即启动失败）
  - `CHARACTERS` 的 `trigger`/`tags` 一律英文 danbooru tag（中文使用说明只进 TOOL.md；`src/` 内嵌扫描禁止单条 ≥12 汉字字面量）
- **AI 娘词表查询（tags 工具增补，主人确认）**：`src/tools/tags/ai-girls.json` 结构 `[{ key, name, source, trigger, sections: [{ title, tags }] }]`（key 与 CHARACTERS 键一致；sections 含基础外观/头饰/上衣/下身/脚等作者官方段落）；tags 工具在 danbooru.csv 检索外增加该词表命中——keyword 命中角色 key、中文名或别名时返回该角色全部 sections 的 tag 文本（严格 JSON，进 git；tags 的参数 Schema 不变）；tags 的 TOOL.md 增补一句「可查 AI 娘角色官方 tag」引导。draw 注入的基础外观与词表数据可重叠，但 CHARACTERS（机器注入用）与 ai-girls.json（模型查询用）各自完整、独立维护，不做启动一致性绑定
- 叠加语义：character 与 hsr preset、ref 改图全部正交（ref 路径删除 "6" 不影响 "93"；改图重绘同样吃到 LoRA）

**终态关联：** `F3`、`F4`、`F5`（仓库侧全部三条）。

**验收标准：**

- [ ] **步骤 1：核对现状与合同**

read comfy.ts / tool.ts / schema.json / TOOL.md 现状，确认 "88" 注入模式、节点 id 占用（"93" 未被占用）、manifest 依赖注入方式；与上述契约冲突时停下报告，不自行改契约。

- [ ] **步骤 2：实现**

按接口契约完成四处改动：comfy.ts（lora 结构 + "93" 注入）、tool.ts（CHARACTERS 用 T1 名单填值 + 参数校验 + 一致性校验）、schema.json（严格 JSON，character 枚举 + lora_weight 数值约束）、TOOL.md（中文指南：AI 娘角色优先 character 参数、特征 tags 已自动注入不要再画蛇添足叠外貌描述——与既有「官方 tag 不叠加」原则同款句式；非 AI 娘官方角色仍走 tags 词表流程）。

- [ ] **步骤 3：运行既有检查并记录结果**

运行：`npm test` 与 `npm run prompts`（仓库根目录）。
记录：exit code、已验证范围、既有断言若需同步（仅数字/名单级）逐处说明；出现与本改动无关的失败立即停止上报。

- [ ] **步骤 4：漂移校验自证**

临时把 schema.json 枚举改错一个值，运行能触发 factory 的测试（`test/tools.test.ts` boot 即触发 factory）确认启动校验抛错；改错/还原包裹在同一脚本 try/finally 内完成，前后各记一次 `git status --short` 证明无遗留漂移；还原后重跑 `npm test` 确认全绿。

**建议（待用户授权）：** 新增 makeGraph 注入断言与非法参数拒绝断言（见 Files 建议项）；授权后在 test/tools.test.ts 落地。

---

### Task 4：真机联调（character 生图验证）

**Deps：** `T2`（理由：ComfyUI 已有名单文件且 object_info 可见）、`T3`（理由：makeGraph 已支持 lora 注入）

**WritePaths：** `/tmp/draw-lora-e2e.ts`（联调脚本，仓库外）与 `/tmp/draw-lora-e2e.png`（出图证据）。无仓库写入。

**Resources：** Windows ComfyUI 在线（经 SSH 隧道或 Windows 本机发起）；1 个并发。

**Files：**
- Create：`/tmp/draw-lora-e2e.ts`（临时验证脚本，import 仓库 makeGraph 构造 graph，POST /prompt，轮询 history 取回 PNG）
- Modify：无
- Suggested Test（待用户授权）：无

**接口契约：**
- Consumes：T3 的 `makeGraph`（导出签名不变）；T2 的 ComfyUI 地址与端口；任一确认角色的四元组
- Produces：`/tmp/draw-lora-e2e.png`（带 character 注入的完整管线出图：LoRA → 初采样 → 超分 → 二次采样 → 脸修，PreviewImage 输出）

**终态关联：** `F6`（真机闭环）。

**验收标准：**

- [ ] **步骤 1：打通验证通道**

本地起 SSH 隧道映射 Windows ComfyUI 端口到 `127.0.0.1:<本地口>`，或在 Windows 本机执行验证脚本；`curl /system_stats` 确认在线。脚本运行方式用项目既有 TypeScript 执行通道（`npx tsx` 或项目 scripts 同款 node 直跑方式，以仓库 scripts/*.ts 现状为准）。

- [ ] **步骤 2：提交与取图**

脚本构造 `makeGraph({ prompt: <该角色一句简单画面>, width: 912, height: 1216, lora: { file: <名单文件>, weight: 0.8, tags: <trigger+tags> } })`，POST `/prompt`，轮询 `/history/<id>` 至完成，下载输出 PNG 到 `/tmp/draw-lora-e2e.png`（校验 PNG 8 字节签名 + IHDR）。

- [ ] **步骤 3：人工确认角色特征**

把 `/tmp/draw-lora-e2e.png` 路径回报主人看图确认主体符合该 AI 娘特征（发色/服饰等）；不像则调 weight（0.4–1.1 内）或回报触发词可疑，回 T3 修数据后重跑本步骤。

- [ ] **步骤 4：回归记录**

重跑 `npm test` + `npm run prompts`（确认联调期间仓库无意外漂移），记录输出。

**建议（待用户授权）：** 无新增测试。
