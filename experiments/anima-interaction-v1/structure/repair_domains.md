# repair_domains.py — R 修复输入 v2：按冻结动作定义的局部接触组（T2c）

日期：2026-11-11。任务：T2c（`docs/plans/2026-11-11-anima-interaction-study.md` §8.1「R 接口修正」）。
本文件只描述 `repair_domains.py` 的**实际磁盘实现**；本任务未真实运行 32 case 生成（T2d 另派），
未看任何图、未评分、未接 GPU/远端/新依赖。旧 416 PNG 与 `inputs/structure/` 原索引未改动（只读消费，
程序拒绝把 `--out` 放进 `--structure` 内）。

## 1. 为什么存在（真实机械证据）

T2b 核验（`checks/structure-render-verify.json` risk1）证明：旧 `render.py`/`geometry_core.build_repair_stack`
的 support = 全 body union(owner_a,owner_b) 膨胀 48px，覆盖 10.3–69.7% 画布（中位 43.1%），
DC-HAND-XH core=0 / support 69.2% —— 不是局部接触组；旧 core 只是 owner 邻近（A 距 B ≤6px），
不是语义接触。risk2 证明 native gray 的 crop 空间 8% 环在 T2b 不可证。因此 R 不放行旧域，
另产 `inputs/repair-v2/`。不改冻结世界姿态/相机/角色 owner/pose/box。

## 2. 输出（新 run-root 落点，不覆盖任何旧文件）

```
var/local-driver/anima-interaction-v1/inputs/repair-v2/
├── repair_index.json          # schema "yugang.anima-interaction-v1.structure.repair_index"（仅真实运行写）
└── <case_id>/                 # 32 个 R 核心 case（8 世界 × W/M/C/XU；XH 不跑 R，SOLO 无接触不进）
    ├── repair_core.png        # 二值：语义接触核（双方部件像素 + 待补空隙桥）
    ├── support.png            # 二值：接触组局部可编辑域（core ∪ 部件capsule∩owner，膨胀 48px）
    ├── context.png            # 二值：support 膨胀 96px（Crop & Stitch 独立上下文，含连接方向）
    ├── gray.png               # 连续灰度：结构参考（§6；非 crop 噪声图）
    └── repair_index.json      # 每 case：来源 hash/角色、部件表、全部 anchors 投影、数值 bbox、empty flags
```

文件型 shape 与旧 `structure_index.json` 每 case files 一致：`{path, sha256}`（path 相对仓库根，
`--out` 在仓库外时如实记绝对路径）。

## 3. 域定义（每个部件有列明的语义来源，机械可追溯）

部件像素域 = 冻结 rig FK 控制点（`geometry_core.control_points`）→ 冻结 `pose3d.project` 透视投影 →
屏幕空间 capsule：骨段采样 24 点（`SEG_SAMPLES`），每点半径用同一冻结投影链现算
（`project([wp, wp+camera_right*r])` 的像素距），画圆盘；相机后方（z≤0.05）点跳过。
world 半径是列明常量（`RADII`，世界单位）：finger 0.020 / hand 0.070 / limb 0.055 / shoulder 0.070 /
neck 0.050 / head 0.115 / torso 0.140 / pelvis 0.130 / thigh 0.085 / shin 0.060 / lip 0.050 ——
authoring 近似（同 `ENVELOPE_BODY_MARGIN=0.11` 性质），非对生成图调参。**没有 per-part 分割可用**
（冻结光栅器只出整人 mask），capsule∩owner 是部件归属的唯一机械近似。

每动作接触组（来源 = `frozen_poses.ACTION_TEMPLATES[*]` 的 `contact_group.controls` /
`authoring_targets` / `authoring_residuals` / `interlock_hands` / `occlusion`，与计划 §8.1 一致）：

| 动作 | 部件（每侧） | 空隙桥 pairs（core 必含） |
| --- | --- | --- |
| HAND | 相扣侧 shoulder→elbow + wrist + elbow→wrist 前臂 + 17 个 `FINGER_INTERLOCK` 指关节点 | A.right_wrist↔B.left_wrist（冻结腕距 0.1623 世界单位，非重合——空隙是待重建对象） |
| HUG | 双侧全臂（shoulder→elbow→wrist）+ 躯干列（chest→pelvis） | chest↔chest（0.369）+ 4 条 wrist↔对侧 chest（手落对方背 0.21 系残差） |
| KISS | neck + neck→head + head + lip_proxy（`head+0.10*forward−0.03*up`，冻结文档化代理，唇非 MHR 控制点） | head↔head（0.1478）+ lip_proxy↔lip_proxy（0.041） |
| CARRY | A：双臂 + neck/chest/双 clavicle（搭靠面）；B：pelvis + 双侧 hip→knee→ankle 腿链 + 双臂 | A.wrist↔B.knee ×2（承托 0.05 系）+ B.wrist↔A.shoulder ×2（搭肩 0.06–0.07）+ B.pelvis↔A.chest（背承重） |

CARRY 域允许较大，但每个部件都出自上表列明语义来源，不是覆盖率当视觉分数；索引逐 case 记录
core/support/context 的 pixels/bbox/coverage 供 T2d 机械核对，本程序不做阈值判定。

**core 不以 owner 交集取代**：core = 双方部件 capsule（膨胀 6px 容差）∩ 各自 owner **full** 轮廓
（`owner_*_full.png`：HUG/CARRY 的接触肢体绕到对方身后，visible mask 会静默缺掉这些像素，故用
full；口径写入每 case `owner_mask_basis`）∪ 每条冻结接触 pair 的屏幕空间桥 capsule（半径 8px，
覆盖两人之间待补的空隙/接缝），再膨胀 `core_radius_px=6`。
**support 不做全身 union**：种子 = core ∪（未膨胀部件 capsule ∩ owner full），膨胀 48px；
context = support 膨胀 96px（桥的走向天然含连接方向）。

**覆盖闸**：冻结 `contact_group.controls` 的每个控制点必须被部件/pairs 覆盖，HAND 另须覆盖相扣手
全部 17 个指关节；缺一即 `SystemExit`，绝不回退全身 union。

## 4. 出画/空域判据（真实失败 vs 投影证据，不机械 skip）

- 每个 anchor 记录 `world/px/depth/in_frame`；每条 pair 记录 `gap_world/gap_px/both_in_frame`。
- 预期接触在画内（任一 pair 双端 in_frame）而 core 或 support 为空 → **REAL FAILURE**：
  per-case `flags.failure` + 根索引 `failures[]` + 退出码 1，绝不借 skip 掩盖。core ⊄ support 同为真实失败。
- anchor 投影出画 → 投影坐标/深度即证据（`out_of_frame_anchors`），空域是机械事实，不改取景不假造。
  已知实例（dry-run 实测）：KISS C/XU 的 A.head/B.head 投影 y<0 出画（头部裁上边框），但 lip_proxy
  仍在画内（XU y=1.21 贴边）→ lip pair 照常进 core；CARRY XU 的 B 双 ankle 出画。
- 边界守卫：pair 一端略出画但 `gap_px ≤ 32` 且双端深度 >0.05 时仍桥接（防止 KISS 头对把接缝
  静默丢出 core）；圆盘光栅在画布边自然裁剪。
- 来源失败（渲染文件缺失 / sha256 失配 / 渲染 scene.json ≠ 冻结 scene_json）→ per-case
  `failed_source_error` + `failures[]`，不 fallback 合成 mask、不重造渲染器。

## 5. 输入与只读边界

- `frozen/geometry.json`（冻结世界/相机/scene_json，sha256 记入根索引；FK 直接消费冻结 people+camera）；
- 真实 T2b 渲染索引 `inputs/structure/structure_index.json` 与每 case 来源文件（角色逐一记录）：
  `scene.json`=等价闸（证明消费的相机/人体就是实际渲染的那份）、`owner_a/b.png`=只记 provenance 不消费、
  `owner_a/b_full.png`=部件交集消费；全部 sha256 核对。
- 不改：冻结 geometry/`geometry_core.py`/`render.py`/`frozen_poses.py`、旧 416 PNG、旧两级 structure_index、
  世界姿态/相机/owner/box。RS 冻结几何经 `rs_bridge` sha256 核验后只读导入（`pose3d.project`/
  `camera_coordinates`）。`import render` 仅复用 sha256/save 助手，绝不执行其 main/光栅。

## 6. gray 的地位（结构参考，非 crop 噪声图）

`gray.png` 沿用明确冻结算法 `geometry_core.falloff_from_core(core, ring_px=61, support)`：core=1 平台、
Chebyshev 外环线性衰减、support 外=0，native 1024×768 上的**结构参考**。risk2 已证明 crop 空间 8%
在 native 侧不可证：真实噪声 gray 由 T4c `YugangRepairMaskFalloff` 在实际 crop 尺寸上生成
（`round(min(H,W)*0.08)` Chebyshev 环），本文件不预猜 STITCHER 尺度、不冒充 crop noise_mask。

## 7. 运行（CPU；numpy + Pillow；无 GPU/远端/新依赖）

```sh
# 仓库根执行。dry-run：FK/投影规划 + 来源存在性/sha/scene 等价闸，不解码 mask、不写任何文件：
/usr/local/bin/python3 experiments/anima-interaction-v1/structure/repair_domains.py --dry-run

# 真实生成 32 case（T2d 另派执行；退出码 0=全部建成，1=有 failures）：
/usr/local/bin/python3 experiments/anima-interaction-v1/structure/repair_domains.py \
    --geometry experiments/anima-interaction-v1/structure/frozen/geometry.json \
    --structure var/local-driver/anima-interaction-v1/inputs/structure \
    --out var/local-driver/anima-interaction-v1/inputs/repair-v2

# 单 case：--cases DC-HAND-W,DC-CARRY-M（XH 会被拒绝：R 只消费 W/M/C/XU）
```

参数冻结在 `REPAIR_PARAMS`（core_radius_px=6 / capsule_dilate_px=6 / support_grow_px=48 / ring_px=61 /
context_grow_px=96 / bridge_radius_px=8，canvas 1024×768）。RS stage 环境变量与 render.py 相同
（`YUGANG_RS_STAGE`/`YUGANG_RS_SRC` 由 rs_bridge 处理）。

## 8. T2d / T3b 消费接口

- **T2d**（真实执行 + 机械核验）：跑 §7 真实生成，核对退出码、根/每 case `repair_index.json` 的
  domains pixels/bbox/coverage（预期显著小于 risk1 的 10.3–69.7%）、empty flags、`failures` 为空、
  anchors/pair 投影与冻结残差一致；不判图。
- **T3b/编译器**：`inputs/repair-v2/<case_id>/repair_core.png|support.png|context.png` 即 R 图的
  LoadImage 输入（文件型 source，sha256 从本索引取）；box 仍用旧 structure_index 的权威值（本任务
  不改 box）；T4c 在 crop 上做真实 falloff，不用这里的 gray.png 当噪声图。

## 9. 诚实限制与本轮已核验证据

1. capsule∩owner_full 是部件归属的几何近似（无 per-part 分割），半径/膨胀是列明常量非拟合值；
2. 唇/手掌不是 MHR 控制点，用冻结 lip_proxy 与 wrist 代理（沿袭 T2a 口径）；
3. HUG 0.21 手-背残差与 CARRY 膝 0.33 z 偏后是冻结 authoring 事实，域按冻结几何定义，不因此扩到全身；
4. 域是否「看起来对」永久归主人视觉验收，本目录不含任何评分。

本轮核验（py_compile + `--help` + dry-run，未真实生成）：32 case 选择正确、覆盖闸 4 动作全过、
failure_count=0；HAND 腕 pair gap_world=0.1624 复现冻结残差 0.1623（W gap_px=33.4 / XU 152.9）；
HUG 5 pairs、CARRY 5 pairs 的 gap_world 与冻结残差一致；KISS C/XU 头出画证据与 lip 贴边事实
如实记录（§4）。32 case 的实际域形状/像素数以 T2d 真实执行为准。

许可：GPL-3.0-only（派生自冻结 RS GPL-3.0-only 几何与本仓库 structure/ 同源代码）。
