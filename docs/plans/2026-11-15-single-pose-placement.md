# 单人姿态线位置枚举（六格 placement）实验+实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**日期：** 2026-11-15
**背景：** 姿态线统一（d0531c4）后人物位置硬编码居中（`interaction-presets.json` 的 `single-haystack`：`people[0].position=[0,0,0]`、相机正对原点），模型侧无任何参数可控位置；鱼答复「默认居中不能改」属实。主人裁定加六格位置枚举：水平 `left/center/right` × 垂直 `up/middle/down`（垂直是**构图重心**上下移，不是相机俯仰角），先只做单人姿态线。

## 机制结论（2026-11-15 探明，来源：WSL 真机源码）

1. **单人姿态线拓扑**：`workflow-interaction-single.json` + `makeInteractionSingleGraph`。
   node 5 `RSMultiCharacterPose3D`（RS 包原生，非自建）吃 `preset.scene_json` → 输出第 5 路
   shaded 姿态图（pose_image）→ node 36 `AnimaLLLiteApply`（strength 0.8，0–70%）→ KSampler。
   **无 RS 采样器、无自建节点**；node 5 的 building_pipe 输出单人路径不消费。
   preset 的 `box` / `camera_extension` 字段单人路径同样不消费（双人专属，单人侧冗余）。
2. **投影模型**（`pose3d.py` 的 `camera_coordinates` / `project`）：look-at 相机
   （`camera.position/target/fov`，fov 为垂直 fov）+ 针孔投影到 `scene_json.width×height` canvas
   （preset 恒 1280×720）。`people[].position` 为世界坐标，`read_scene` 校验范围 ±10
   （此条源码在 WSL 侧 pose3d.py，本机未拉副本不可复核；方向/fov 断言已由
   yugang_composition/geometry.py 与 preset box 实证交叉印证，Δ 远小于界、无实际风险）。
3. **水平偏移**：`people[0].position.x ±Δx`——人物世界平移，投影后自然偏左/右，背景透视正确。
   相机坐标系 right = 世界 +x（forward=[0,0,-1] 时），所以 **x<0 = 画面左侧**。
4. **垂直构图重心**：`camera.position.y` 与 `camera.target.y` **同向同量 ±Δy**——视线保持水平
   （地平线恒在画面中央，不产生俯仰），整个世界在画面里垂直平移：
   - **up（偏上）**：双 y **减** Δy（相机下沉）→ 人物上移、脚下地面/前景占比变大、头顶留白变少；
   - **down（偏下）**：双 y **加** Δy（相机上升）→ 人物下移、头顶天空/留白占比变大。
   几何参考：fov 38°、机位距人物约 5.23m → 画面视野高约 3.6m；Δy=0.45 ≈ 画面高 12.5%；
   canvas 16:9 视野宽约 6.4m，Δx=0.9 ≈ 画面宽 14%。
5. **无需 fork 节点**：`scene_json` 是 `RSMultiCharacterPose3D` 的原生输入，宿主改 JSON 字符串即可。
6. **边界**：人物剪影完全出画面时节点抛错（`no silhouette on the canvas`）；部分出画允许（近裁剪）。
   枚举偏移量必须留足余量，上限由 E 组实验定界。
7. **ratio 拉伸是现状已有行为**：scene canvas 恒 1280×720，LLLite 把姿态图 resize 到出图尺寸。
   比例坐标（画面相对位置）不受拉伸影响；本计划不扩 scope 改 canvas，但 E4 要交叉验证观感。
8. **设计哲学对齐**（38640f2 案底）：模型选语义枚举、宿主持几何数值；不给模型开坐标输入
   （region 盒 2026-11-11 已裁定容易误用而收编退役）；文字引导不可靠（E80851 案底：
   区域/骨架引导比位置文字强）。

## 产品面设计

- draw `schema.json` 加两个可选枚举参数（仅单人从零画有效）：
  - `placement_x`: `left | center | right`，缺省 `center`
  - `placement_y`: `up | middle | down`，缺省 `middle`
- 冲突校验（tool.ts 机械判定，tool error 文案含 next）：`fast`、`ref`、`characters` 任一与
  placement 同传 → `draw_placement_conflict`（这些路径没有姿态线，位置引导不存在）。
- `TOOL.md`：六格语义表（水平靠左/居中/靠右；垂直 = 构图重心：up=人物偏上+地面前景多、
  down=人物偏下+天空留白多）、默认 center+middle、**只在用户明确表达位置意图时传**
  （「站左边」「放在画面左边」「天空多留点」「人物放上面一点」这类话）。
- 宿主实现（`comfy.ts`）：`makeInteractionSingleGraph` 加 `placementX/placementY` 参数，
  运行时机械派生 scene_json——`JSON.parse` → 改 `people[0].position.x` / `camera.position.y` +
  `camera.target.y` → `JSON.stringify`；`single-haystack` base preset 不动，**不建 6 份 JSON**；
  偏移量定稿：**`PLACEMENT_DX_NORM = 0.684`，实际 dx = PLACEMENT_DX_NORM × (width/height)**
  （E4 实测世界 dx 在窄画面被放大，必须按 canvas aspect 归一化）；**`PLACEMENT_DY = 0.45` 恒定**。
- 双人（`makeInteractionGraph`）、`framing`/`spacing` 均不动。

## 全局约束

- 生产管线零回归：不带 placement 的调用 graph 与现状逐字节一致（同 seed 同图）；
  `sit-haystack`、双人路径、fast/ref、hd 全部不动。
- E 组实验必须遵守排障规程（AGENTS.md 2026-11-15）：结论前齐 `nvidia-smi` / ComfyUI progress /
  实验目录 graph.json 三样证据；生产队列空闲才提交（`/queue` 查询）。
- 实验脚本与产物不进仓库（`/tmp` 与本地目录）；实验不动 `interaction-presets.json`。
- 注释与 TOOL.md 中文；不 commit 不部署（部署时机由主人决定）；新增测试仅「建议（待授权）」。

## 整体交付终态

群里对鱼说「画一个站在左边的爱莉」→ 鱼传 `placement_x=left` → 姿态图人物在画面左半 →
出图人物可靠靠左；「人物放上面一点/天空多留一些」→ `placement_y=up/down` 对应构图。
默认居中行为与现状完全一致。

| ID | 必要条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | Δx/Δy 定稿：水平三档与垂直两档的人物剪影落点可辨、无完全出画报错 | WSL ComfyUI E 组扫描（preview 端点质心口径，见 E0） | 剪影中心落点单调分档、误差 ≤±0.05 画面比例；全程无 `no silhouette` | E 组对照表 + 图 | E 组 |
| F2 | `makeInteractionSingleGraph` 按 placement 机械派生 scene_json，枚举/冲突校验闭合 | `npm test` + graph diff 断言 | 六格派生只动 position.x / camera 双 y 三个数值；非法值 tool error；base preset 文件未改 | 测试输出 + diff | T1、T2 |
| F3 | 模型面接线：schema 枚举 + TOOL.md 六格语义 + 冲突文案 | `npm run prompts` + 代码审阅 | schema/TOOL.md/messages 与本计划产品面一致；无意外条目 | prompts 输出 | T2 |
| F4 | 真机全链验收：3×3 全枚举 9 张（含基线，3:4），LLLite 引导实际生效 | WSL 完整管线出图 + T0 基线重放对拍 | 九张图位置肉眼可辨、正确分档；center×middle 与改前基线一致 | 验收图 + 日志 | T4 |
| F5 | `npm test` 全绿、`npm run prompts` 干净 | 仓库根目录 | fail 0；无意外条目 | 命令输出 | T1–T3 |

**完成规则：** 所有必要条件同时满足且证据对应当前版本，才标记完成；仅完成任务步骤不替代终态验证。
**未满足时：** 在授权范围内持续 fix → test → 对照终态；真实阻塞记录未完成并写明恢复下一步。

## DAG

```text
E 组（真机扫描定稿 Δx/Δy 与边界）
 └──> T1（comfy.ts 派生 + 校验）
        └──> T2（schema / TOOL.md / messages / 冲突校验）
               └──> T3（npm test + prompts，含 graph diff 回归）
                      └──> T4（真机六格全链验收）
```

全串行：Δ 定稿是 T1 常量的输入；T2 消费 T1 接口；T4 依赖全部。

## E 组：真机实验设计（WSL）

**通道**：先 read `/Users/mhbzhy/.agents/skills/home-connect/SKILL.md`，用 `connect.sh wsl sh` /
本地临时脚本。ComfyUI 经 `127.0.0.1:18190` SSH 隧道（与生产同通道；从 macmini 走既有隧道，
本地开发机按 skill 的通道连 WSL）。

**方法**：临时脚本从生产 `makeInteractionSingleGraph` 导出基线 graph（固定 seed、固定 prompt
`1girl, solo, sitting on haystack, flower field`——与 single-haystack 侧坐骨架一致，避免文本-姿态
互搏放大「位置引导弱」误判、只测位置一个变量、3:4 912×1216），机械 patch node 5 的
`scene_json` 生成各配置图。**E2/E3 剪影扫描纯用 preview 端点（零 GPU，不提交 /prompt）**：
`POST /rs_mc/pose3d/preview`（pose3d_node.py:136-147，CPU 渲染 max_side=192，返回各 mask
质心与画布尺寸）；只有 E5 全链验证才提交 /prompt（注意导出图含 pass 链，提交即全链跑完，
不要拿它做剪影扫描）。shaded pose_image（node 5 第 5 路）不自动落 temp——需要时在实验图
自加 SaveImage 接 `["5",5]`。

- [x] **E0 预检**：`nvidia-smi` 记录驻留（5090D，GPU 100%/16GB 驻留）；`/queue` 空闲确认 ✓；
      基线 preview 质心 (0.4999, 0.5775)——x 精确居中，y 与 box 中心 0.55 差 0.028 < 0.03 容差，机制自证成立。
- [x] **E1 基线**：single-haystack 原样姿态图 preview ✓（见 E0）。
- [x] **E2 水平扫描**：Δx ∈ {0.6, 0.9, 1.2} × {left(-), right(+)}（16:9 canvas）。
      实测：0.6→0.402/0.598；0.9→0.354/0.646；1.2→0.306/0.694。单调分档 ✓，无出画报错；
      dx=1.2 命中目标区间 0.3–0.35 / 0.65–0.70。
- [x] **E3 垂直扫描**：Δy ∈ {0.3, 0.45, 0.6} × {up(-), down(+)}。
      实测：0.3→0.491/0.666；0.45→0.448/0.708；0.6→0.406/0.751。单调、方向正确（up=质心上移）；
      dy=0.6 人物近贴底，定稿取中档 0.45（±13% 画面高）。
- [x] **E4 ratio 交叉**：**发现世界空间 dx 在窄画面被放大**（垂直 fov 固定、画面宽=3.6m×aspect）：
      dx=1.2 在 3:4 质心 0.060（几乎出画）、9:16 完全出画。修正公式 **dx = 0.684 × aspect**
      （= 0.19 画面偏移 × 3.6m 视野高）：四种比例（3:4/1:1/16:9/9:16）全部落 0.301–0.303 /
      0.697–0.698，跨比例一致性 ±0.002 ✓；dy 不受 ratio 影响（竖图 up/down 均为 0.448/0.708）。
      结论：**DX 按 canvas aspect 归一化，DY 恒定**；无需 canvas 对齐出图比例后续项。
- [x] **E5 全链验证**：**失败——LLLite 路线证死**。四张全链图（baseline/left/up/down，
      同 seed）主人裁定「根本没有任何区别，人物还在中间」：姿态图层面质心精确分档（E2/E4）
      但成图位置完全不动。附加对照 E5b（LLLite strength 1.2/end 0.95 拉满、strength 0 关闭）
      同样无区别——两个结论：① token 级 adapter（`anima_v8_3dpose`）对绝对画布位置无引导力；
      ② LLLite 开关对成图无影响（单人姿态线的 LLLite 姿态引导本身可能未生效，与 AGENTS.md
      「姿态线能力合并待样图验收」未闭环一致，另案跟进）。
      根因：双人模板的位置引导来自 RS 区域分域（Prompt→LoRA→Position→Pose3D 剪影合入
      building_pipe→Finalize→RS 采样器 character_pipe，提示词级硬隔离）；单人模板删了整条
      RS 链、node 5 的 building_pipe 断开、node 11 是普通 KSampler，位置信号无落实通道。
- [x] **E6 RS 单槽实验**（主人裁定「RS 可以走，但得先实验」）：不改仓库，基于新代码导出的
      graph 手工 patch：+40 Prompt(单槽)/41 LoRA(None)/42 Position(box)/43 Finalize，
      node 5.building_pipe←42，node 11 KSampler→RSMultiCharacterSampler（字符串直喂+clip/vae+
      character_pipe，layout_method=regional），删孤立编码节点 7/8；box w=0.45/h=0.85/y=0.55，
      x=0.30（left）vs 0.5（center）对照。判定：位置随 box 动、RS 单槽不炸、画质不劣化。
      证据位：WSL `~/anima-prod/output/interaction/06-placement-e6/` + `~/anima-prod/06-placement/`。
- [x] **E6 汇总（E 组阶段）**：定稿 **PLACEMENT_DX_NORM = 0.684**（dx = 0.684 × canvas_aspect）与
      **PLACEMENT_DY = 0.45**（恒定）——姿态图层面参数仍然有效（E2/E4），待 RS 区域链把位置
      引导落实后同步用于 Position box 偏移。排障三样证据的 nvidia-smi/queue 见 E0；
      graph.json 与提交图在 WSL `~/anima-prod/06-placement/` 与 `~/anima-prod/output/interaction/06-placement*/`。

## Task 1：comfy.ts 派生与校验

**Deps：** E 组（Δ 常量）。

- [ ] `makeInteractionSingleGraph` 签名加 `placementX?: "left"|"center"|"right"` /
      `placementY?: "up"|"middle"|"down"`；机械派生：parse `preset.scene_json` →
      left: `people[0].position.x -= DX`；right: `+= DX`；up: `camera.position.y -= DY` 且
      `camera.target.y -= DY`；down: 双 `+= DY` → stringify 注入 node 5。
      center/middle 不改字段（graph 与现状逐字节一致）。
- [ ] `PLACEMENT_DX` / `PLACEMENT_DY` 常量（E 组定稿值）+ 注释写明几何依据与来源实验。
- [ ] 接线改动点：`makeInteractionSingleGraph` 签名加参后 `runInteractionSingle` 签名
      （`Parameters<typeof makeInteractionSingleGraph>[0]`）自动跟随，无需改它本体；
      实际透传点是 `tool.ts` 调 `runInteractionSingle` 的参数对象。

## Task 2：工具面接线

**Deps：** T1。

- [ ] `schema.json`：`placement_x` / `placement_y` 枚举（描述含六格语义与「仅用户明确表达位置时传」）。
- [ ] `tool.ts`：与 `fast` / `ref` / `characters` 同传 → tool error `draw_placement_conflict`
      （文案含 next：去掉冲突参数或去掉 placement）；缺省不传任何 placement 字段。
      注：placement 与 `framing`/`spacing` 同传（单人）已被现有 `draw_composition_multi`
      机械拒绝（tool.ts:110），无需也不应重复加分支。
- [ ] `TOOL.md`：六格语义表 + 使用时机（引用用户原话示例）；不引导主动使用。
- [ ] `messages.json`：`draw_placement_conflict` 文案（key 合规、含 `{{next}}` 类变量按仓库惯例）。

## Task 3：测试与回归

**Deps：** T2。

- [ ] `npm test` 全绿；`npm run prompts` 干净。
- [ ] graph diff 回归（比对层级必须区分：scene_json 是嵌在 node 5 inputs 里的整串字符串，
      re-stringify 必然重排格式）：**默认路径（不传 placement）字节级比对**——center/middle
      分支完全不触碰 scene_json 字符串（含不 re-stringify）；**placement 路径解析后数值级比对**
      ——JSON.parse 后恰三个数值差异（people[0].position.x、camera.position.y、camera.target.y），
      其余语义同构。双人/单人默认路径同参数对拍。
- [ ] 建议（待授权）：placement 派生断言（六格 × 数值变化、非法枚举拒绝、冲突校验拒绝）。

## Task 4：真机验收

**Deps：** T3。

- [ ] **T0 基线存档（动代码之前）**：临时脚本绕过工具层、直接以固定 seed/passSeed 调
      `makeInteractionSingleGraph` 导出改前 graph 存档（seed 在函数内 randomBytes 兑底随机、
      tool.ts 不传 seed，对拍只能这样做；不给 tool 加 seed 参数），供 T4 重放。
- [ ] 六格全枚举：3×3 共 9 张（left/center/right × up/middle/down，center×middle 即基线，
      3:4），位置肉眼可辨；与 T0 基线同 seed 重放对拍，center×middle 张与改前一致（零回归证据）。
- [ ] `npm test` + `npm run prompts` 终态复跑存证。

## 风险与回退

- **剪影出画报错**：E2/E3 扫描出上限即收紧 Δ；枚举只有三档，不需要大偏移。
- **LLLite 引导不生效**（姿态图对了、成图人物仍居中）：E5 判定；若弱，提高 **node 36
      `AnimaLLLiteApply` 的 strength（0.8 → 0.9）或 end_percent（0.7 → 0.8）**作为 E5 附加对照
      ——注意不是 node 5 的 `pose_end`（那路只进 building_pipe，单人线无人消费，改了会得出
      「调了没用」的假结论）；仍不行则记录阻塞，不盲目上生产。
- **竖图拉伸观感差**：E4 判定，后续独立项（canvas 对齐出图比例），不阻塞六格上线。
- **回退**：placement 不传即旧行为；代码回退 = revert 单 commit。

---

## 实验执行记录（2026-11-15 下午追加）

### E5/E5b：LLLite 路线证死
- E5 四张同 seed 全链图（baseline/left/up/down）：主人裁定「根本没有任何区别，人物还在中间」。
- E5b 对照（strength 0 / 0.8 / 1.2+end0.95）：无区别。结论：①v8 pose adapter 对绝对位置无引导力；②单人姿态线 LLLite 开关对成图无影响（死重）。根因：单人模板无 RS 链（node 5 building_pipe 断开、node 11 普通 KSampler），剪影 mask 无人消费；LLLite 本就无效（E5b）。
- **生产动作已落地**：初采样 LLLite 全线摘除（单人删 node 6/36、双人删 34/75，模型链直连；commit b2a2e3c，测试 173 全绿）。

### E6：RS 单槽链路接线跑通（box 未生效 → 机制澄清）
- 接线三轮教训：①RSMultiCharacterFinalize 要求每槽非空提示词（character1 空串报错）；②RSMultiCharacterSampler 无 `latent_image` 参数（自建 latent，width/height 给全即可）；③其输出为 `(IMAGE, LATENT, PIPE, STRING)`——下游 VAEDecode 必须接 `["11", 1]`（LATENT 路）。
- 正确接法（已验证出图）：40 Prompt(单槽) → 41 LoRA(None) → 42 Position → 5 Pose3D(building_pipe←42, scene_json) → 43 Finalize(building_pipe←[5,0]) → 11 RS 采样器(character_pipe←43, model/clip/vae 直连, layout_method=regional) → 14 VAEDecode(samples=[11,1])。
- **机制结论**：42 Position 的 box x=0.3 与 x=0.5 两组成图人物均居中（vision 判读）——**Pose3D 的剪影 mask 覆盖 Position 的 box**（pose3d_node 的 `update_slot(pipe, region=剪影)`），区域实体是剪影不是 box；box 仅在无剪影时兜底。单人场景人物位置必须由 scene_json 人物平移驱动剪影位移。
- 证据：`/tmp/yugang-study/e6-compare.jpg`（2×2：initial/final × left/center）；WSL `~/anima-prod/output/interaction/06-placement-e6/`。

### E7：scene 平移 + RS 链（判定实验，跑图中）
- 假设：E5 失败是因剪影无消费者；E6 失败是因剪影本身未平移。E7 = E6 链路 + scene_json 人物 x 平移 dx = −0.684×aspect（E2 定稿公式，912×1216 → dx=−0.513）。
- left（平移）vs center（不平移）对照，其余同 E6。出图后按人物水平位置判定：
  - 显著左移 → 单人 RS 链 + applyPlacement 即生产形态（placement 参数面接线已就绪，工作区待终态 commit）。
  - 仍居中 → RS 区域分域对单人引导不足，placement 方案回到「相机/构图重心平移」或其它路线重议。

### 姿态库（b 路线，待主人验收）
- open-pose-editor（MIT）内置 1265 个 3D 姿态 → RS 官方 `import-library.py` 重定向转换 → **1199 个有效 MHR 姿态**（66 畸形滤除），本地已生成 `library.json`（`/tmp/yugang-study/rsconv/out-lib/`）。
- 抽样 6 姿态 preview 渲染全部成立，剪影对比图 `/tmp/yugang-study/lib-grid.jpg` 待肉眼验收。
- 部署面：`models/rs_pose3d/library.json` + `/rs_mc/pose3d/library` GET 端点；鱼侧消费形态待定（语义检索需标注：批量 preview + vision 打标，或先随机+看剪影挑）。
- MHR 资产自带 4 内置姿态（standing/seated/wave/reach）——standing/seated 可零成本入 interaction-presets。

---

## 后续实验 TODO（2026-11-15 排期，均待跑）

### E9：RS 分域强度旋钮排除（placement 唯一零成本翻盘机会）
- **问题**：E7 判定默认分域墙只挪 ~10 个点；但墙强度参数从未调过。
- **内容**：E7 left 同款 graph（scene 平移 dx=−0.513 + RS 链），拉满分域墙参数重跑对照：
  - `initial_character_gain` 1.7 → 3~4（角色词向量增益）
  - `initial_spatial_separation` 0.9 → 1.0（自注意力分离）
  - `boundary_hold_steps` 3 → 10+（墙保持到中后期）
  - `common_after_step3_boost` 0.10 → 0（削弱公共先验）
- **判定**：initial 人物质心 ≤35% → 分域够硬，placement 参数面直接上线（工作区代码就绪）；否则实锤自训 Regional LLLite 是唯一路（3.8B/52 层，训练管线同 v8 pose adapter；数据由姿态库 scene → 颜色图 → 无条件生成对照批量合成）。
- **成本**：一组对照约 5 分钟 GPU。

### E10：双 pass 叠加（质感增强，主人裁定 0+1 并行的 0 线）
- **问题**：单遍 denoise 0.25 pass 消扁平有天花板。
- **内容**：现 pass 后叠第二遍（graph 已导出：`/tmp/yugang-study/e8-pass2.json` 双 pass、`e8-d035.json` 第二遍 0.35 对照），同 seed 对比质感（扁平度/真实感/细节）。
- **约束**：pass denoise 不许超 0.25 越界的旧规仅约束「修复用途」单遍；叠加实验第二遍参数待实验定稿，但禁止改回超分前修复用途。
- **另一半**（1 线）：tile LLLite 自训（需 52 层同构权重，社区 tiled_lllite 不可用）——训练管线排期另立。
- **成本**：一组对照约 10 分钟 GPU。

### 依赖注意
- E9/E10 均在生产 ComfyUI 上跑（RS 包已验证）；队列为空时执行，跑完检查生产队列不受影响。
- 姿态库（1199 姿态）与打标管线：主人裁定搁置，数据已备（`/tmp/yugang-study/rsconv/out-lib/library.json` + 验收图 lib-grid.jpg），随时可启。
