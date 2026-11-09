# 角色 / 风格 LoRA 词表收敛进 tags 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 所有 LoRA 元数据（角色与风格）从 `draw` 剥离，只有一份数据表归 `tags` 持有；`tags` 是「查 danbooru 基础词 + 查角色 + 查风格 + 列词表」的唯一入口，`draw` 只做三件机械事：按 key 挂 LoRA、按 key 挂风格 LoRA、把表里的 `inject` 串原样拼进 positive。

**架构：** 三组 JSON（`ai-girls.json` / `honkai3rd.json` / `styles.json`）由共享模块 `src/tools/characters.ts` 严格加载校验；`tags` 用它回答「这是什么、触发词是什么、用哪个 LoRA、推荐权重多少、怎么挂」，**需要挑 LoRA 时直接拉一份平铺总表**（角色 / 风格 / 以后新增的任何 LoRA 都在同一张表里）；`draw` 的 `character` 与 `style` 都是纯 `string`，`schema.json` 里不出现任何枚举，`preset` 参数整体删除。

**技术栈：** TypeScript（pi-durable 工具包）、严格 JSON 数据文件、node:test。

## 全局约束

- 模型能看到的文字只有两个来源：`prompt/` 下的 markdown 与 `src/tools/<name>/TOOL.md`；`src/` 内不得新增 ≥12 汉字的 prompt 字面量（回执文案走各包 `messages.json` / `prompt/messages.md`）。
- **`draw` 包内不得出现任何角色/风格知识**：角色名、中文名、LoRA 文件名、角色外观 tag 都不得写进 `tool.ts` / `schema.json` / `TOOL.md`；它只知道「key 在表里 → 文件名与注入串是表里那一项」。
- **`character` / `characters[].character` / `style` 都是纯 `string`**：不加 `enum`，不加 `x-yugang-enum-from`，参数描述也不罗列清单；候选由 `tags` 运行时给出（tool 结果，不进 system prompt、不打穿前缀缓存）。
- **注入是机械的**：表里每条有一个 `inject` 字段（≤300 字符，`style` 组允许空串），`draw` 选中该 key 就把它**原样**拼在 positive 内置前缀之后、调用方 `prompt` 之前，不挑选、不改写；双人 RS 把同一串按人拼进 `characterN` 提示，并沿用既有的 `1girl`/`solo` 过滤。服装段不进 `inject`（爱莉希雅 16 套互相排斥），要哪套由模型从 `tags` 回执里抄进 `prompt`。8 个旧 AI 娘的 `inject` 必须与旧 `CHARACTERS.tags` 逐字一致。
- **`preset` 参数删除**：`hsr` 变成 `styles.json` 里的 `style` 条目（全局影响，节点 88）；`secret`（唯一作用是往 positive 追一句 `completely nude`）一并删除，内容类 tag 归 `prompt` 管。
- 角色/风格表是唯一事实源：LoRA 文件名只在 `src/tools/tags/*.json` 出现一次；同一文件可被多条共用（`aigrilsV1.0.safetensors` 服务 7 条）。
- LoRA 文件名必须带 `.safetensors` 后缀且与 Windows ComfyUI `models/loras/` 实际文件名逐字一致；建议权重必须落在 `LORA_WEIGHT_RANGE`（0.4–1.1）；`draw` 的 `lora_weight` 默认值仍为 0.8。
- 角色回执有长度预算：单段 `tags` ≤300 字符（逗号边界截断，超标启动失败），整条 ≤1200 字符；目录模式 ≤700 字符。
- 工具包仍是四件套；`schema.json` 必须是严格 JSON，`x-yugang-enum-from` 通道保持现状（只服务 `meme` 的 `mood`），本期不动 `types.ts` / `manifest.ts` / `loader.ts`。
- 不新增测试；新增测试或新 fixture 一律标「建议（待用户授权）」。每次改完跑 `npm test` 与 `npm run prompts`。

## 整体交付终态

角色与风格的唯一存放地是 `src/tools/tags/` 下的三份 JSON；`draw` 退化成「表里查得到就挂 LoRA + 拼注入串」的窄工具，不再有 `preset`。

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | `tags` 命中崩坏角色（4 条 + 中文别名）时一次返回 LoRA 文件名、建议权重、适配底模、来源链接、触发词、基础外观、服装段（≤1200 字符）**以及最多 3 条 danbooru 同名词条**；`hsr` 等风格也能查到；**不传 keyword（或传 `lora`）时返回全部 13 条 LoRA 的平铺总表** | 本地：`/tmp` 临时脚本以假 deps 调 `createTagsTool(...).execute({keyword})`，逐个打印并统计字符数 | 12 次查询全部命中正确条目；`elysia` ≤1200 字符且含 `elysia_(honkai_impact)`；`cyrene small` / `昔涟` / `小昔涟` / `艾莉希雅` 四个非约定俗成词到正确条目或候选；`tags()` 与 `tags("lora")` 均返回 13 行平铺且 ≤700 字符；`cat_ears` 走 CSV | 临时脚本 stdout（任务报告） | T1,T3 |
| F2 | `draw` 的 `character` / `characters[].character` / `style` 均无枚举；`preset` 与 `secret` 参数消失；`draw` 包内零角色知识；表外 key 以 tool 错误返回并引导先查 `tags` | 本地：`npm run prompts` + `grep -in "claude\|gemini\|grok\|elysia\|eden\|cyrene\|爱莉\|昔涟\|伊甸\|safetensors" src/tools/draw/tool.ts src/tools/draw/schema.json src/tools/draw/TOOL.md` | `npm run prompts` 中三处参数均无 enum、无 preset；grep 输出为空；`draw_character` / `draw_style` 为通用引导、不列清单 | `npm run prompts` + grep | T2,T4,T5 |
| F3 | 注入完全机械且可复现：positive = 工作流前缀 + 表内 `inject` + 调用方 `prompt`；8 个旧 AI 娘的 `inject` 与旧 `CHARACTERS.tags` 逐字一致 | 本地：`git show HEAD:src/tools/draw/tool.ts` 取旧 `lora`/`tags` 逐项 diff；读 `comfy.ts` 确认注入只来自 `lora.inject` | 8 个文件名与 8 个 `inject` 全部逐字相等；`comfy.ts` 中无其它 tag 来源；`MultiPart.role.tags` 改名 `inject` 且保留 `1girl/solo` 过滤 | diff 脚本输出 | T1,T2,T4 |
| F4 | LoRA 链正确：风格（节点 88）→ 角色（节点 93）→ 采样器；无风格时角色直接接 1/2；双人 RS 无风格，角色写 `characterN_lora` 与强度 | 本地：读 `src/tools/draw/comfy.ts` 的 `makeGraph` / `makeRsGraph` + 代码审阅 | `style` 在场时 88 的 model/clip 接 1/2、93 接 88 输出、7/11/14/42 与 4/5/11/42 接 93；两条都不在时无 88/93 节点；双人分支无 88 | 审阅记录 | T4 |
| F5 | 全量既有测试与 prompt 审查通过 | 本地：`npm test`、`npm run prompts` | `npm test` 0 失败；`npm run prompts` 无意外条目、无源码内嵌扫描告警 | 两条命令输出 | T5,T6 |
| F6 | 5 个 LoRA 文件在 Windows ComfyUI 侧就位 | Windows：`curl -s http://127.0.0.1:<端口>/object_info/LoraLoader` 解析 `lora_name` | 4 个角色文件 + `HSR Anima.safetensors` 全部在列；缺失记阻塞，不重启 ComfyUI | 枚举核对输出 | T6 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## DAG

```text
T1 (三份数据表) ──> T2 (共享加载器) ──> T3 (tags 接入)
                                   └──> T4 (draw 替换 preset)
T3, T4 ──> T5 (模型侧文案)
T3, T4, T5 ──> T6 (验证与 Windows 核对)
```

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3、T4（可并行，写路径不重叠）
- Wave 4：T5
- Wave 5：T6

**关键路径：** T1 → T2 → T4 → T5 → T6。

---

### Task 1：三份数据表

**Deps：** `none`

**WritePaths：**
- `src/tools/tags/ai-girls.json`
- `src/tools/tags/honkai3rd.json`
- `src/tools/tags/styles.json`

**Resources：** `none`

**Files：**
- Modify：`src/tools/tags/ai-girls.json`
- Modify：`src/tools/tags/honkai3rd.json`
- Create：`src/tools/tags/styles.json`

**接口契约：**
- Consumes：`git show HEAD:src/tools/draw/tool.ts` 的 `CHARACTERS`（8 条 `lora` + `tags`）与 `preset === "hsr"` 分支（`<lora:HSR Anima:0.7>`）。
- Produces：13 条，形状固定为
  ```json
  {
    "key": "elysia",
    "group": "honkai3rd",
    "name": "爱莉希雅（崩坏3 · 16 套）",
    "lora": "Elysia_Hi3_Part01_Anima-01.safetensors",
    "inject": "ElysiaHi3, Ely_One, elysia (honkai impact), blue eyes with pink pupils, long pink hair, low ponytail, pointy elf ears, feather hair ornament",
    "weight": 1.0,
    "base": "Anima",
    "source": "https://civitai.com/models/570873",
    "match": ["elysia", "エリシア", "爱莉希雅", "爱莉"],
    "sections": [{ "title": "Miss Pink Elf♪", "alias": ["miss pink elf", "ely_one"], "tags": "..." }]
  }
  ```
- `group` 只取 `aigirls` / `honkai3rd` / `style`；`lora` 必填；`inject` 在角色组必填非空、在 `style` 组允许空串；`sections` 在 `style` 组允许空数组（风格没有服装段）。
- `styles.json` 只有一条：`{"key": "hsr", "group": "style", "name": "崩坏星穹铁道画风", "lora": "HSR Anima.safetensors", "inject": "", "weight": 0.7, "base": "Anima", "source": "", "match": ["hsr", "崩铁", "星穹铁道", "honkai star rail"], "sections": []}`。

**终态关联：** `F1`、`F3`、`F4`。

**验收标准：** 三份 JSON 严格合法，共 13 条（8 + 4 + 1）；key 与 `match`（归一化后）全表唯一；单段 `tags` ≤300 字符；`inject` ≤300 字符。

- [ ] **步骤 1：核对旧取值**

`git show HEAD:src/tools/draw/tool.ts | sed -n '/^const CHARACTERS/,/^} as const;/p'` 取 8 组 `lora`/`tags`；`grep -n "HSR Anima" src/tools/draw/comfy.ts` 确认风格 LoRA 名。当前工作区已落盘的 `ai-girls.json`（8 条，含 `inject`）与 `honkai3rd.json`（4 条，含 `inject`）可直接复用。

- [ ] **步骤 2：写 `styles.json`**

按上方契约写入唯一一条 `hsr`，`inject` 为空串，`sections` 为空数组。

- [ ] **步骤 3：脚本校验三份数据**

```bash
python3 - <<'EOF'
import json
for f in ("ai-girls.json","honkai3rd.json","styles.json"):
    d=json.load(open(f"src/tools/tags/{f}"))
    print(f, len(d), [g["key"] for g in d], max((len(s["tags"]) for g in d for s in g["sections"]), default=0))
EOF
```

期望 8 / 4 / 1 条，单段最大 ≤300。

- [ ] **步骤 4：零回归比对**

`python3` 脚本把 8 条 `inject` 与 `git show HEAD:` 的 `tags` 逐字比对，输出 mismatch 列表（必须为空）。

---

### Task 2：共享加载器 `src/tools/characters.ts`

**Deps：** `T1`

**WritePaths：**
- `src/tools/characters.ts`

**Resources：** `none`

**Files：**
- Create：`src/tools/characters.ts`

**接口契约：**
- Consumes：`./tags/ai-girls.json`、`./tags/honkai3rd.json`、`./tags/styles.json`。
- Produces：
  ```ts
  export type EntryGroup = "aigirls" | "honkai3rd" | "style";
  export interface CharacterSection { readonly title: string; readonly tags: string; readonly alias?: readonly string[] }
  export interface CharacterEntry {
    readonly key: string; readonly group: EntryGroup; readonly name: string;
    readonly lora: string; readonly inject: string; readonly weight: number;
    readonly base: string; readonly source: string;
    readonly match: readonly string[]; readonly sections: readonly CharacterSection[];
  }
  export const CHARACTERS: readonly CharacterEntry[];
  export function findCharacter(raw: string): CharacterEntry | undefined;
  export function suggestCharacters(raw: string, limit?: number): readonly CharacterEntry[];
  export function findSection(entry: CharacterEntry, raw: string): CharacterSection | undefined;
  export function loraBook(key: string): { file: string; inject: string } | undefined;  // 仅 group !== "style"
  export function styleBook(key: string): { file: string; weight: number } | undefined; // 仅 group === "style"
  export function listCharacters(group?: EntryGroup): readonly CharacterEntry[];
  ```
- 匹配归一化 `normalize(s)`：`s.normalize("NFKC").toLowerCase().replace(/[_\\-\\s]+/g, " ").trim()`。
- `findCharacter` 三级：key 全等 → `match` 全等 → 模糊打分（输入 token 覆盖率 ≥0.5 且唯一最高分），否则 `undefined`；`suggestCharacters` 返回同分数排序前 `limit`（默认 3）。
- 启动期校验（抛错）：key 唯一且匹配 `^[a-z][a-z0-9_]*$`；`lora` 以 `.safetensors` 结尾；`inject` ≤300（角色组非空、style 组可空）；`weight` ∈ [0.4, 1.1]；`sections` 单段 `tags` ≤300；`match` 归一化后全表唯一；`group` 只认三个值。

**终态关联：** `F2`、`F3`、`F4`。

**验收标准：** 三处 import 无循环依赖；非法数据抛错；`loraBook("hsr")` 为 `undefined`，`styleBook("elysia")` 为 `undefined`。

- [ ] **步骤 1：写模块与校验**
- [ ] **步骤 2：自检**

`node --experimental-strip-types -e "import('./src/tools/characters.ts').then(m=>console.log(m.CHARACTERS.length, m.characterKeys(), m.styleKeys()))"`（或 `npx tsx -e`），期望 `13` + 12 个角色 key + `["hsr"]`。

- [ ] **步骤 3：验证失败路径**

临时把某条 `weight` 改 `2`、把某条 `match` 复制到另一条、把 `style` 的 `inject` 写成 301 字符，分别确认抛错后还原。

---

### Task 3：`tags` 变成唯一查询入口

**Deps：** `T2`

**WritePaths：**
- `src/tools/tags/tool.ts`
- `src/tools/tags/messages.json`
- `src/tools/tags/schema.json`

**Resources：** `none`

**Files：**
- Modify：`src/tools/tags/tool.ts`
- Modify：`src/tools/tags/messages.json`
- Modify：`src/tools/tags/schema.json`

**接口契约：**
- Consumes：`findCharacter`、`suggestCharacters`、`listCharacters`、`findSection`、CSV 行。
- **总表模式（唯一一级词表，平铺不分类）**：`keyword` 改为可选（`required` 删掉）；不传、空串、或传 `lora` / `lora表` / `词表` / `列表` / `list` 时，把三组条目**平铺**成一份不分标题的清单（按 `key` 排序，角色与风格混在一起）：
  ```
  【LoRA 总表】共 13 条
  claude · 克劳德小姐 · 0.8 | deepseek · 鲸鱼娘 · 0.8 | qwen · 千问娘 · 0.8
  glm · 智谱狐娘 · 0.8 | kimi · 月之暗面娘 · 0.8 | gpt · 白龙娘 · 0.8
  gemini · 四角星猫耳娘 · 0.8 | grok · 吸血鬼大小姐 · 0.8
  eden · 伊甸 · 1.0 | elysia · 爱莉希雅 · 1.0 | cyrene · 大昔涟 · 1.0
  cyrene_small · 小昔涟 · 1.0 | hsr · 崩坏星穹铁道画风 · 0.7
  查具体条目用 key 或中文名；draw 传 character=<key>（画风类传 style=<key>）
  ```
  预算 ≤700 字符，每条只给 `key · name · weight`，不分组标题、不列 LoRA 文件名与 tag；**主路径是不带 keyword**，不要求模型猜 `风格` / `角色` 这类类别词。`aigirls` / `honkai3rd` / `style` 仅作可选过滤，不写进 TOOL.md 主路径。
- **详情模式**：命中条目时输出
  ```
  【角色】{{name}}            ← style 组用【风格】
  LoRA: {{lora}} · 建议权重 {{weight}} · 底模 {{base}}
  来源：{{source}}
  [{{section.title}}] {{section.tags}}          ← 服装段累计到 1200 字符预算为止；命中 alias 时只输出该段
  [danbooru] {{tag}}（{{category}}，热度 {{count}}）   ← 最多 3 条，无命中整行省略
  {{hint}}：draw 传 character={{key}} 会自动挂 LoRA 并注入上面第一段；服装段想用就自己抄进 prompt
  同系列：{{siblings}}（同 group 其他条目，最多 4 个）
  ```
  新文案 key：`tags_character` / `tags_character_meta` / `tags_character_source` / `tags_character_danbooru` / `tags_character_more` / `tags_style_hint` / `tags_list` / `tags_suggest`；旧 `tags_ai_girls*` 删除。
- **候选回退**：CSV 也没结果且 `suggestCharacters` 非空时，输出 `没找到「{{keyword}}」，相近的条目：{{name}}（{{key}}） / …`，而不是 `tags_none`。
- **danbooru 叠加**：角色命中后仍查 CSV 取同名词条（名称/别名包含关键词）按热度前 3，仅作参考；CSV 缺失时既有 `rows.length === 0` 快速失败保持不变。

**终态关联：** `F1`。

**验收标准：** 8 次崩坏查询 + `claude` + `hsr` 全部命中；`elysia` ≤1200 字符；`tags("cyrene small")` / `tags("Cyrene_Small")` 命中 `cyrene_small`；`tags("昔涟")` 看到同系列 `cyrene_small`；`tags("艾莉希雅")` 返回候选；`tags()` 与 `tags("lora")` 均返回 13 行平铺且 ≤700 字符，含 `hsr · 崩坏星穹铁道画风`。

- [ ] **步骤 1：删 `AI_GIRLS` 常量，改查表 + 目录分支**
- [ ] **步骤 2：改 `schema.json`（`keyword` 可选）与 `messages.json` 文案**
- [ ] **步骤 3：12 次查询自检并记录字符数**

---

### Task 4：`draw` 用 `style` 取代 `preset`

**Deps：** `T2`

**WritePaths：**
- `src/tools/draw/tool.ts`
- `src/tools/draw/comfy.ts`
- `src/tools/draw/schema.json`
- `src/tools/draw/messages.json`

**Resources：** `none`

**Files：**
- Modify：`src/tools/draw/tool.ts`
- Modify：`src/tools/draw/comfy.ts`
- Modify：`src/tools/draw/schema.json`
- Modify：`src/tools/draw/messages.json`

**接口契约：**
- Consumes：`loraBook(key)`、`styleBook(key)`。
- Produces：
  - `DrawArgs`：删 `preset`，加 `style?: string`；`character?: string` 保持 string。
  - `ComfyDraw`：删 `preset`，加 `style?: { file: string; weight: number }`；`lora` 形状 `{ file: string; weight: number; inject: string }`。
  - `makeGraph`：`args.style` 存在时建节点 `88 = AnimaLoRARemapTagLoader("<lora:${style.file}:${style.weight}>")`，model/clip 接 1/2，所有消费方改接 88；`args.lora` 存在时建节点 93，上游取 `88`（有 style）或 `1`/`2`，消费方改接 93。注入点 `graph["4"].inputs.text` 用 `lora.inject`，顺序为 内置前缀 → inject → prompt（→ bypass）。
  - `makeRsGraph`：双人不接受 `style`（`tool.ts` 校验：`characters` 与 `style`/`ref` 互斥），角色 LoRA 仍写 `characterN_lora`，注入串走 `inject` 并过滤 `1girl`/`solo`。
  - `tool.ts`：`style` 未命中或命中非 `style` 组抛 `draw_style`；`character` 未命中或命中 `style` 组抛 `draw_character`；两者文案都是通用引导 + 渲染 `{{key}}`，不列清单。平铺总表里两种条目混排，靠这层组校验把误填变成显式错误（而不是静默把画风当角色挂）。

**终态关联：** `F2`、`F3`、`F4`。

**验收标准：** `grep -n "preset\|secret" src/tools/draw/` 为空；`grep -in "elysia\|cyrene\|hsr\|safetensors" src/tools/draw/tool.ts src/tools/draw/schema.json` 只允许出现正则与注释，不允许出现具体文件名/角色名；四种组合（仅风格 / 仅角色 / 风格+角色 / 都不传）的连线与 `makeGraph` 契约一致。

- [ ] **步骤 1：改 `comfy.ts`**

删 `preset` 字段与 `completely nude` 拼接；把 hsr 硬编码块改成 `args.style` 驱动的节点 88；`lora.tags` → `lora.inject`；93 的上游按 style 是否存在切换。

- [ ] **步骤 2：改 `tool.ts`**

删 `preset` 校验与 `--secret`；新增 `style` 查表（`styleBook`）；`characters` 分支的互斥判断改成「不支持 style 和 ref」；`lora_weight` 仍默认 0.8。

- [ ] **步骤 3：改 `schema.json`**

删 `preset` 节点，新增 `style`：`{"type":"string","description":"风格 LoRA 键：先用 tags 查风格（如崩铁画风），把 key 填这里；不填不挂"}`；`character`/`characters[].character` 描述里补「先用 tags 查，key 会挂 LoRA 并自动注入触发词」。

- [ ] **步骤 4：改 `messages.json`**

`draw_multi_unsupported` 改成「双人同框不支持风格（style）和改图（ref）」；新增 `draw_style`；`draw_character` 换成通用引导。

- [ ] **步骤 5：零回归比对**

`git show HEAD:src/tools/draw/tool.ts` 的 8 个 `lora`/`tags` 与表内 `lora`/`inject` 逐项 diff（必须全等），并把结果贴进任务报告。

---

### Task 5：模型侧文案

**Deps：** `T3`、`T4`

**WritePaths：**
- `src/tools/tags/TOOL.md`
- `src/tools/draw/TOOL.md`

**Resources：** `none`

**Files：**
- Modify：`src/tools/tags/TOOL.md`
- Modify：`src/tools/draw/TOOL.md`

**接口契约：**
- Consumes：T3 的目录/详情/候选行为、T4 的 `character`/`style` 语义。
- Produces：
  - `tags/TOOL.md`：**需要挑 LoRA（角色 / 画风 / 以后新增的任何类型）时不带 keyword 直接查，拿平铺总表；不要猜 `风格`、`角色` 这类类别词。** 返回字段（LoRA、建议权重、底模、来源、触发词、外观、服装、danbooru 参考），draw 怎么用（`character=` / `style=`）。
  - `draw/TOOL.md`：删「preset default/hsr」段落与角色罗列；写明「角色与风格都只走 `tags`；`character` 自动挂 LoRA 并注入触发词与基础外观；`style` 只挂风格 LoRA 不改 prompt；官方服装段要自己写进 prompt」。

**终态关联：** `F2`。

**验收标准：** 两份 TOOL.md 不含任何具体角色名/风格文件名；不出现 `preset`；`npm run prompts` 摘要无告警。

- [ ] **步骤 1：改 `tags/TOOL.md`**
- [ ] **步骤 2：改 `draw/TOOL.md`**
- [ ] **步骤 3：`grep -rin "preset\|claude\|elysia\|cyrene\|爱莉\|昔涟" src/tools/draw/TOOL.md` 必须为空**

---

### Task 6：整体验证

**Deps：** `T3`、`T4`、`T5`

**WritePaths：** 仓库内无写入（仅命令与 `/tmp` 脚本）

**Resources：** Windows ComfyUI 的 HTTP 端口（一次 curl），最多 1 个并发任务

**Files：**
- Modify：无

**接口契约：**
- Consumes：全部实现的最终状态。
- Produces：F1–F6 的证据。

**终态关联：** `F1`–`F6`。

**验收标准：** 六条必要条件逐项有证据，或写明真实阻塞与恢复下一步。

- [ ] **步骤 1：`npm test`**（记录 exit code 与失败数）
- [ ] **步骤 2：`npm run prompts`**（三处参数无 enum、无 preset，tags 摘要正确）
- [ ] **步骤 3：重跑 F1 的 12 次查询自检并保存输出**
- [ ] **步骤 4：重跑 F3 的逐字比对与 `grep -rn "lora.tags\|role.tags\|preset" src/tools/draw/` 为空**
- [ ] **步骤 5：Windows 侧核对 5 个文件**

`curl -s http://127.0.0.1:<端口>/object_info/LoraLoader` 的 `lora_name` 枚举里确认：`Eden_Hi3_Anima-01.safetensors`、`Elysia_Hi3_Part01_Anima-01.safetensors`、`cyrene_anima_v1_29b.safetensors`、`B0.9-Cyrene(ripple_of_past_reverie).safetensors`、`HSR Anima.safetensors`。缺失记阻塞，不重启 ComfyUI。

**建议（待用户授权）：** 新增 `test/characters-table.test.ts`，断言（a）13 条、key 与 `match` 唯一；（b）`loraBook("hsr")` 为 `undefined`、`styleBook("hsr")` 返回 `{file, weight:0.7}`；（c）`findCharacter("爱莉希雅")` 命中 `elysia`、`findCharacter("cyrene small")` 命中 `cyrene_small`；（d）`inject` 为空仅允许 `style` 组；（e）8 个 AI 娘的 `inject` 与旧 `CHARACTERS.tags` 全等。用户明确授权后再创建。

---

## 执行记录（2026-11-10）

- T1：`ai-girls.json`（8 条，含 `inject`）、`honkai3rd.json`（4 条）、`styles.json`（1 条 `hsr`）落盘；删除 `claude_aigirls`。
- T2：`src/tools/characters.ts` 建成；自检 `13` 条 = 12 角色 + 1 风格；8 个旧 `inject` 与 `git show HEAD:` 的 `tags` 逐字相等（mismatch = 空）。
- T3：`tags` 平铺总表 460 字符 / 详情最长 1128 字符（含 danbooru 与同系列）；`elysia herrscher` 只回对应服装段；`艾莉希雅` 错字命中 `elysia`；`cat_ears` 走 CSV。
- T4：`preset`/`secret` 删除，`style` 查表；节点链 88 → 93 → 采样器，`positive = 前缀 + inject + prompt`；RS 过滤 `1girl/solo`。
- T5：`tags/TOOL.md`、`draw/TOOL.md` 去掉 `preset` 与角色罗列。
- T6：`npm test` 174/174；`npm run prompts` 参数为 `[prompt, style?, ratio?, character?, characters?, lora_weight?, hand_repair?, ref?]`。
- F6 Windows：5 个文件全部在 `C:\Users\mhbzhy\sd-webui-forge-neo\models\Lora`，SHA256 全部匹配，`/object_info/LoraLoader` 枚举全部命中（Eden / Elysia / cyrene 29B remap / 小昔涟 / HSR Anima）。
- 真机 smoke（2026-11-10）：`COMFYUI_URL=http://127.0.0.1:18190 TAGS_CSV=… node scripts/real-model-smoke.ts s21`（临时副本，跑完删除）通过——真实模型序为 `tool_search → tags(爱莉希雅) → tags()总表 → tags(booru 词) → draw(character=elysia, lora_weight=1) → say_media`，出图角色特征正确（粉长发/尖耳/白裙）。
- 期间修掉两个真问题：`suggestCharacters` 对任意词都给候选（改为编辑距离 ≤2 才计入近似分）；smoke 的 `toolTimeoutOverrides` 缺 `draw: 600`（临时脚本里补）。
