# draw bypass 暂存机制 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 群消息形如「帮我画一张图。bypass: 1girl, solo」时，`bypass:` 之后的文本从 agent 上下文中剥离并由暂存机制保留，draw 出图时自动拼在最终 positive prompt 末尾，实现精细控制画图效果。

**架构：** 在 `index.ts onMessage` 内（chatlog.append 之后、gate.decide 之前）做机械剥离与权限判定；暂存放内存 Map（键 = 触发消息自己的 submissionId，与 `triggerOf` 同 set/delete 时机），经 `FishOptions`/`ToolDeps` 注入链透传到 draw，在 draw 的 prompt 组装点拼接。模型对机制零感知，`prompt/tools/` 零改动。

**技术栈：** TypeScript（node --test 直跑 .ts）、pi-durable 1.4.0、无新依赖。

## 全局约束

- prompt 硬约束：`src/` 不允许出现单条 ≥12 汉字的 prompt 字面量（`npm test` 的 prompt-lint 扫描）；模型可见文案一律进 `prompt/`；模板 `{{name}}` 严格替换，缺变量抛错。
- `prompt/messages.md` 新增 key 必须被 `src/` 代码引用（`test/prompts.test.ts` 死文案检查，正则 `messages\["([a-z0-9_]+)"\]`）。
- 配置入口是 `.env`（gitignore）；新增环境变量必须同步更新 `.env.example` 并说明用途。`.env` 内含 `ONEBOT_TOKEN` 等凭据，**不得读取其内容**，追加配置用 `grep -q … || echo … >> .env` 方式。
- bypass 仅对 **draw** 生效；imggen 及其它工具一律不注入、不改动其 prompt 文件。
- 权限（用户已定案）：发送者是主人（`MASTER_QQ`）**或**消息来自 `BYPASS_GROUPS` 名单内（初始 `10001`）的群；其余一律不剥离、不暂存、不拼接。
- 生命周期（用户已定案）：stash 绑定触发消息自己的 submissionId，**仅这条消息触发的轮内可用**，轮 settle 即删；后续任何消息的轮不可见；gate 拒入的消息不产生暂存。Map 键 set/delete 都必须 `String(submission.id)` 归一（`SubmissionId` 是数字品牌类型，SameValueZero 下 `42 !== "42"`，不归一则 delete 恒为 no-op）。stash 为进程内存态：重启即丢、不持久化、不报错（崩溃后该轮 draw 静默少拼，属接受取舍）。
- gate 的 recent 流水（群聊画像来源）保留消息原文，打分模型可见历史消息中的 bypass 字样——主 agent 上下文仍然干净，此为接受的取舍，不为 gate 单独剥离。
- stash 单独上限 200 字符（超出截断）；拼接位置为最终 positive prompt 末尾（`PRESET_POSITIVE + positive + PRESETS[preset] + ", " + stash`）；拼接后不做额外总长校验（SD WebUI 自行处理超长）。
- 对模型完全静默：不修改任何 `prompt/tools/*.md`、`persona.md`；画图回执 `draw_done` 不变。
- 纯 bypass 消息（剥离后剩余文本为空）用 `prompt/messages.md` 新 key `bypass_placeholder` 的文案替代进上下文（该文案需引导模型画图）。
- 未经用户授权不得新增测试；不得主动 git commit。
- 群消息进 user message 不进 system 的隔离原则不变；bypass 文本不进模型上下文、不进 system，只进 draw 的 HTTP 请求体。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 权限外消息（非主人且群不在 BYPASS_GROUPS）行为与现状完全一致：不剥离、不暂存、不拼接 | 代码审查权限判定路径 + `npm test` 既有 52 项回归 | 审查确认 `bypassAllowed` 为 false 时 `splitBypass` 不被调用、`bypassOf` 无 set；npm test 全绿 | 任务报告引用代码位置 + 测试输出 | T1、T2 |
| F2 | 权限内消息：chatlog 与 recent 流水保留原文；gate 打分与模型上下文只见剥离后文本；纯 bypass 消息进上下文的是 `bypass_placeholder` 文案；stash 超 200 字符被截断 | 代码审查剥离点位置（chatlog.append 之后、gate.decide 之前）+ `npm test` + `npm run prompts` | 审查确认顺序正确；占位文案出现在 prompts 清单且被 src 引用；测试全绿 | 任务报告 + `npm run prompts` 输出 | T1、T2、T4 |
| F3 | stash 仅在触发消息自己的轮内对 draw 可见：`bypassOf` 与 `triggerOf` 同 set/delete 时机且 set/delete 同用 `String(submission.id)` 键；轮结束即删；draw 将 stash 拼在最终 positive prompt 末尾；imggen 不受影响 | 代码审查 Map 生命周期与 draw 拼接点 + `npm test` 回归 | set 在 `conv.submit` 返回后、delete 在 `submission.wait` 返回后，且 delete 键与 set 键同为 `String(submission.id)`（数字品牌类型不归一则为 no-op）；draw 的 body.prompt 末尾拼接；imggen.ts 零改动 | 任务报告引用 index.ts 与 draw.ts 改动位置 | T2、T3 |
| F4 | prompt 一致性：`bypass_placeholder` 被且仅被 `src/index.ts` 引用一处；`prompt/tools/` 无新增/删除文件；`src/` 无新增内嵌 prompt 字面量 | `grep -rn 'messages\["' src/ | grep bypass_placeholder`（引用存在性）+ `npm run prompts`（清单与 messages 计数）+ `npm test`（prompt-lint 与死文案检查兜底） | grep 恰好命中 src/index.ts 一处；prompts 清单无意外条目；52 项全绿 | 上述命令输出 | T2、T4 |
| F5 | 部署配置就绪：`.env` 含 `BYPASS_GROUPS=10001`（不读取 .env 内容的前提下追加）；真机冒烟——群里发「画一张猫。bypass: 1girl, solo」出图且日志带 `(+bypass)` 标记、模型上下文无 bypass 文本 | `.env` 追加后 `grep -c '^BYPASS_GROUPS=' .env`（只查键名不显值）；真机冒烟需用户配合起鱼（NapCat + `npm run up`） | 键存在返回 1；真机出图且 `var/media/gen/` 有新文件（真机部分标注为部署后验证，不阻塞代码交付，需用户配合完成） | 命令输出；冒烟结果由用户确认 | T4 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。F5 的真机冒烟部分在用户完成部署后补验，代码交付以 F1–F4 为准。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## DAG

```text
T1 (src/bypass.ts 纯函数契约) ──> T2 (入站剥离 + 暂存通道接线) ──> T3 (draw 消费拼接) ──> T4 (验证与部署)
```

## Waves

- Wave 1：T1
- Wave 2：T2（等待 T1 的 `splitBypass`/`bypassAllowed` 接口契约）
- Wave 3：T3（等待 T2 产出的 `ToolDeps.bypassOf` 透传通道）
- Wave 4：T4（等待 T1–T3 全部合入）

**关键路径：** T1 → T2 → T3 → T4（纯串行链，无并行任务；总变更量小，串行成本可接受）。

---

### Task 1：bypass 纯函数模块

**Deps：** `none`

**WritePaths：**
- `src/bypass.ts`

**Resources：** `none`

**Files：**
- Create：`src/bypass.ts`

**接口契约：**
- Consumes：`none`
- Produces：
  - `export const BYPASS_LIMIT = 200`（stash 字符上限）
  - `export function bypassAllowed(userId: unknown, groupId: unknown, master: string, groups: readonly string[]): boolean`（主人或名单群返回 true；全部 `String()` 归一比对）
  - `export function splitBypass(text: string): { clean: string; stash: string } | null`（无段/空段返回 null；stash 截断到 200 字符）

**终态关联：** F1（权限判定的机械正确性）、F2（剥离与截断规则）。

**验收标准：**
- [ ] **步骤 1：核对剥离输入的真实形态**

读 `src/qq/onebot.ts` 的 `parseEvent()`（约 326 行起），确认入站 `text` 已做 `replace(/\s+/g, " ").trim()` 单行归一（约 357 行）；确认 `IncomingMessage` 的 `userId`/`groupId` 字段存在（读类型定义）。在报告中记录证据行号。

- [ ] **步骤 2：实现 `src/bypass.ts`**

```ts
/**
 * bypass 暂存 —— 「帮我画一张图。bypass: 1girl, solo」的机械预处理。
 *
 * bypass: 段从进模型上下文的文本里剥离，由宿主按 submissionId 暂存（与
 * triggerOf 同生命周期），draw 出图时拼在最终 positive prompt 末尾。
 * 权限：主人（MASTER_QQ）或 BYPASS_GROUPS 名单内的群，其余不剥离。
 */
export const BYPASS_LIMIT = 200;

/** bypass 段：前置字符非 ASCII 字母数字（兼容中文句号等 CJK 标点紧邻、也挡住「xxbypass:」误配），支持中英文冒号，段取到行尾（文本已单行归一）。 */
const BYPASS_RE = /(?<![a-z0-9])bypass[：:]\s*(.+)$/i;

/** 主人或 BYPASS_GROUPS 名单内的群才有权用 bypass。 */
export function bypassAllowed(
  userId: unknown,
  groupId: unknown,
  master: string,
  groups: readonly string[],
): boolean {
  if (master && String(userId ?? "") === master) return true;
  return groups.includes(String(groupId ?? ""));
}

/** 剥离 bypass 段：无段或段为空返回 null；stash 截断到 BYPASS_LIMIT 字符。 */
export function splitBypass(text: string): { clean: string; stash: string } | null {
  const m = BYPASS_RE.exec(text);
  if (!m) return null;
  const stash = [...m[1].trim()].slice(0, BYPASS_LIMIT).join("");
  if (!stash) return null;
  return { clean: text.slice(0, m.index).trim(), stash };
}
```

正则要点：`(?:^|\s)` 防止误配「xxbypass:」；大小写不敏感；同一文本只取第一个匹配。注释为代码注释（非字符串字面量），不触发 prompt-lint。

- [ ] **步骤 3：运行既有检查并记录结果**

运行：`npm test`（仓库根目录）。记录 exit code 与项数（预期 52 项全绿，本任务纯新增文件不影响既有项）。

- [ ] **建议（待用户授权）：新增测试**

`test/bypass.test.ts`（node:test）：断言 `splitBypass` 的标准剥离（「帮我画一张图。bypass: 1girl, solo」中文句号紧邻、无空格 → clean「帮我画一张图。」+ stash「1girl, solo」）、前带空格与行首用例、中文冒号、无段返回 null、空段返回 null、超 200 按码点截断、纯 bypass 消息 clean 为空串、前缀粘连不误配（「xxbypass: 1」不剥离）；断言 `bypassAllowed` 的主人命中/群命中/群不命中/陌生人私聊不命中。用户明确授权后再创建。

---

### Task 2：入站剥离与暂存通道接线

**Deps：** `T1`（理由：消费 T1 产出的 `splitBypass`/`bypassAllowed`/`BYPASS_LIMIT` 接口契约）

**WritePaths：**
- `src/index.ts`
- `src/harness.ts`
- `src/tools/index.ts`
- `prompt/messages.md`
- `.env.example`

**Resources：** `none`

**Files：**
- Modify：`src/index.ts`（config 块 `groups:` 约 48 行、`triggerOf` 定义处约 86 行、onMessage 约 287-384 行、openFish 调用处约 89/108 行传参）
- Modify：`src/harness.ts`（FishOptions 的 `triggerOf` 约 70 行旁、openFish 内 createTools 调用约 120 行）
- Modify：`src/tools/index.ts`（ToolDeps、createTools 内 createDrawTool 调用）
- Modify：`prompt/messages.md`（追加 `bypass_placeholder` key）
- Modify：`.env.example`（追加 `BYPASS_GROUPS` 模板行与说明）

**接口契约：**
- Consumes：T1 的 `splitBypass(text)`、`bypassAllowed(userId, groupId, master, groups)`
- Produces：`ToolDeps.bypassOf?: (roundId: unknown) => string | undefined`（与 `triggerOf` 并列的注入通道；经 `FishOptions.bypassOf` → openFish → createTools → createDrawTool 传递）；`prompt/messages.md` 的 `bypass_placeholder` key（被 `src/index.ts` 引用）

**终态关联：** F1（权限外的零影响路径）、F2（剥离位置/占位/截断接线）、F3（bypassOf 的 set/delete 时机）。

**验收标准：**
- [ ] **步骤 1：核对 messages.md 现有格式与 openFish 调用形态**

读 `prompt/messages.md` 头部确认 key 的书写格式（按现有格式追加）；读 `src/index.ts` openFish 调用处确认 `triggerOf` 的注入写法（本任务按同款写法加 `bypassOf`）。在报告中记录。

- [ ] **步骤 2：实现全部接线改动**

`src/index.ts` 五处：

1. config 块（`groups:` 下一行）追加：
```ts
  bypassGroups: (process.env.BYPASS_GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
```
2. `triggerOf` Map 定义旁追加：
```ts
/** submissionId → 本轮触发消息自带的 bypass 段；仅该轮 draw 可见，轮 settle 即删。 */
const bypassOf = new Map<string, string>();
```
3. onMessage 内 `chatlog.append(...)` 之后、`gate.decide(...)` 之前插入（先算 `decision` 之前的任何位置均可，但必须在 gate 前）：
```ts
    // bypass 段剥离：chatlog 已记原文；之后 gate 打分与模型上下文只见干净文本。
    const bypass = bypassAllowed(msg.userId, msg.groupId, config.master, config.bypassGroups)
      ? splitBypass(msg.text)
      : null;
    if (bypass) msg.text = bypass.clean || (fish.prompts.messages["bypass_placeholder"] ?? "(draw)");
```
（`fish` 为模块级 const（index.ts:89 `const fish = await openFish(...)`），onMessage 内可直接访问；同文件 compacting 分支已用 `fish.prompts.messages`。）
4. `triggerOf.set(String(submission.id), {...})` 之后紧跟一行：
```ts
    if (bypass) bypassOf.set(String(submission.id), bypass.stash);
```
5. `triggerOf.delete(submission.id)` 旁追加：
```ts
    bypassOf.delete(String(submission.id));
```
（键必须与 set 同样经 `String()` 归一：`SubmissionId` 是数字品牌类型，SameValueZero 下 `42 !== "42"`，不归一则 delete 恒为 no-op、stash 永不删除。delete 无条件执行：无 stash 时删除不存在的键是 no-op，保持机械简单。注：既有 `triggerOf.delete`（index.ts:348）存在同款存量问题，是否顺带修复由用户决定，本计划不改。）

`src/index.ts` 顶部 import：`import { bypassAllowed, splitBypass } from "./bypass.ts";`（按现有 import 风格调整）。

`src/index.ts` openFish 调用处（`triggerOf` 传参旁）追加：
```ts
    bypassOf: (round) => (round !== undefined ? bypassOf.get(String(round)) : undefined),
```

`src/harness.ts` 两处：

1. FishOptions 的 `triggerOf` 字段后追加：
```ts
  /** submissionId → 本轮触发消息自带的 bypass 段；仅 draw 消费，轮结束失效。 */
  bypassOf?: (roundId: unknown) => string | undefined;
```
2. openFish 内 `createTools({...})` 调用的参数追加 `bypassOf: options.bypassOf`。

`src/tools/index.ts` 两处：

1. ToolDeps 的 `triggerOf` 字段后追加：
```ts
  /** submissionId → 本轮触发消息自带的 bypass 段；仅 draw 消费。 */
  bypassOf?: (roundId: unknown) => string | undefined;
```
2. `createDrawTool({ prompts: deps.prompts, mediaRoot: deps.mediaRoot, baseUrl: deps.sdUrl })` 追加参数 `bypassOf: deps.bypassOf`。

`prompt/messages.md` 按现有格式追加 key（文案可微调，语义不变：引导模型画一张图、细节已另行指定）：
```text
bypass_placeholder: （一条画图指令：图片的细节发送者已单独指定，直接用 draw 画一张就好）
```

`.env.example` 按现有注释风格追加：
```text
# 允许 bypass: 画图注入的群号（逗号分隔）；主人（MASTER_QQ）始终允许。留空则仅主人可用
BYPASS_GROUPS=10001
```

- [ ] **步骤 3：运行既有检查并记录结果**

运行：`npm test`（预期全绿；死文案检查应因 `bypass_placeholder` 被 index.ts 引用而通过。审阅已确认 test/ 不 import src/index.ts，onMessage 改动不影响既有测试）。

- [ ] **建议（待用户授权）：新增测试**

`test/bypass.test.ts` 追加通道级用例：模拟「set 后可取、delete 后不可取」的 Map 生命周期（直接对 `bypassOf` 语义建模或经公开入口）；权限外消息不产生 set。用户明确授权后再创建。

---

### Task 3：draw 消费拼接

**Deps：** `T2`（理由：消费 T2 产出的 `ToolDeps.bypassOf` 通道与 createDrawTool 的透传参数）

**WritePaths：**
- `src/tools/draw.ts`

**Resources：** `none`

**Files：**
- Modify：`src/tools/draw.ts`（DrawDeps 接口、execute 内取轮标识处、body.prompt 组装处、draw ok 日志行）

**接口契约：**
- Consumes：T2 的 `ToolDeps.bypassOf`（经 createDrawTool 参数透传）
- Produces：`DrawDeps.bypassOf?: (roundId: unknown) => string | undefined`；最终请求 `body.prompt = PRESET_POSITIVE + positive + PRESETS[preset] + (stash ? ", " + stash : "")`

**终态关联：** F3（仅 draw 拼接、拼在最终 positive prompt 末尾、轮标识绑定）。

**验收标准：**
- [ ] **步骤 1：核对 draw 现有拼接点与轮标识取法**

读 `src/tools/draw.ts`，确认 `const round = live?.run?.inputs?.[0]`（约 108-112 行 DRAWN 检查处）与 `body = JSON.stringify({ prompt: PRESET_POSITIVE + positive + (PRESETS[...]) , ... })`（约 124-128 行）。在报告中记录行号。

- [ ] **步骤 2：实现拼接**

`DrawDeps` 追加：
```ts
  /** submissionId → 本轮触发消息自带的 bypass 段；拼在最终 positive prompt 末尾。 */
  bypassOf?: (roundId: unknown) => string | undefined;
```

execute 内，`const round = live?.run?.inputs?.[0];` 之后追加：
```ts
      const stash = round !== undefined ? deps.bypassOf?.(round) : undefined;
```

`body` 的 prompt 字段改为：
```ts
        prompt: PRESET_POSITIVE + positive + (PRESETS[args.preset ?? "default"] ?? "") + (stash ? `, ${stash}` : ""),
```

draw ok 日志行改为（运维可快速确认注入是否生效；chatlog 有完整原文审计）：
```ts
        console.log(`[fish] draw ok: ${positive.slice(0, 40)}${stash ? " (+bypass)" : ""}`);
```

不改动：参数 schema、校验上限、DRAWN 每轮一次逻辑、negative、超时与隧道逻辑、`prompt/tools/draw.md`、imggen.ts。

- [ ] **步骤 3：运行既有检查并记录结果**

运行：`npm test`（预期全绿；`test/tools.test.ts` 工具名清单不含本改动影响）。记录 exit 与项数。

- [ ] **建议（待用户授权）：新增测试**

`test/bypass.test.ts` 追加 draw 拼接用例：以 `fetchImpl` 假实现捕获请求 body，断言 stash 拼在 `PRESETS` 之后、末尾带 `, ${stash}`；无 stash 时 body 与现状逐字节一致。用户明确授权后再创建。

---

### Task 4：验证与部署配置

**Deps：** `T1`、`T2`、`T3`（理由：全部代码合入后才能做整体终态验证）

**WritePaths：**
- `.env`

**Resources：** `none`（真机冒烟依赖线上 NapCat/SD 后端，属用户配合项，不占本任务资源）

**Files：**
- Modify：`.env`（仅追加一行，禁止读取其内容——内含 ONEBOT_TOKEN）

**接口契约：**
- Consumes：T1–T3 的全部交付
- Produces：F1–F5 的验证证据；`.env` 的 `BYPASS_GROUPS` 键

**终态关联：** F1–F5 的整体核对。

**验收标准：**
- [ ] **步骤 1：全量测试与 prompt 审查**

运行：`npm test`、`npm run prompts` 与 `grep -rn 'messages\["' src/ | grep bypass_placeholder`（仓库根目录）。核对：52 项全绿；`prompt/tools/` 无新增/删除文件、内嵌扫描无违规；grep 恰好命中 `src/index.ts` 一处引用。记录各项输出。

- [ ] **步骤 2：终态逐项核对**

对照 F1–F4 逐条审查代码路径并在报告记录证据（文件:行号）；F5 的 `.env` 部分见步骤 3，真机部分标注「待用户部署后补验」。

- [ ] **步骤 3：追加 .env 配置（不读取文件内容）**

```bash
cd ~/yugang && grep -q '^BYPASS_GROUPS=' .env || printf '\nBYPASS_GROUPS=10001\n' >> .env
grep -c '^BYPASS_GROUPS=' .env   # 期望输出 1
```

（用 `printf` 前置换行，防 `.env` 末行无换行符时把新键拼进既有行；不读取、不显示任何既有内容。）

- [ ] **步骤 4：向用户报告真机冒烟步骤（不执行）**

说明：起鱼（NapCat 协议端 + `npm run up`）后在群 10001 发「画一张猫。bypass: 1girl, solo」，确认：出图、`var/media/gen/` 新文件、console 日志 `[fish] draw ok: … (+bypass)`、模型上下文无 bypass 文本（fish-console.log 或复盘工具核对）。此步由用户决定何时执行。

**停止条件（全部任务适用）：** 发现现场与计划前提矛盾（如 onMessage 结构、FishOptions 注入点与本计划描述显著不符）；需要写入声明 WritePaths 之外的文件；需要新增测试或修改 `.env` 中既有内容；需要重启线上服务或提交 git——一律停止并在输出中报告阻塞事实。
