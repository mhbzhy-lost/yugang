# anima-interaction-v1 · structure/ — T2a 结构生成源 + 冻结几何

日期：2026-11-11。任务：T2a（`docs/plans/2026-11-11-anima-interaction-study.md` §3/§4.2/§8.1）。

**状态边界（先读）**：本目录是 **8 世界结构 / 40 投影 / 4 单人** 的**可执行结构生成源 + 冻结几何 JSON**。
T2a **未运行 GPU、未做真实 CPU 渲染验证、未解码看任何图、未评分**（那是 T2b）。所有几何由
**FK + 透视投影数值**（`pose3d.project` / `mhr.global_matrices`，纯 numpy）离线 authoring 冻结，
**不看出图调几何**。`render.py` 是 T2b 的真实 CPU 渲染程序，T2a 只写 + `py_compile` + `--dry-run`
规划核验（dry-run 在调用光栅器之前返回，不渲染）。`structure/frozen/` 与 run-root
`inputs/structure/` 的索引均为 **unrendered**，没有填任何不存在的 PNG/hash。

视觉验收永久归主人；本目录不含任何评分/选优/动作通过判定。这些是**构图引导**
（RS `pose_enforcement=false`，无接触/约束求解器），**不是**保证的姿态或接触。

---

## 1. 唯一事实源与资产指针（不复制第二份表）

| 事实 | 来源 | 本目录如何用 |
| --- | --- | --- |
| 角色 / LoRA 文件 / 权重 / inject | `src/tools/characters.ts` + `src/tools/tags/ai-girls.json`（sha256 `50de0db5…63a3`，selfcheck 现场核对） | 只按 **key** 引用（deepseek/claude/qwen/grok）；几何不携带任何 LoRA 文件名/权重 |
| 实验契约（40 case / 景别 / box 推导 / 灰度图 / 手指限制） | `var/local-driver/anima-interaction-v1/spec.json`（T1） | 相机/box/repair/visibility 全部按 spec 冻结值实现 |
| 真实实体（unet/clip/vae/lora/pose_lllite/**mhr_mesh**/mhr_license） | `var/local-driver/anima-interaction-v1/preflight.json#/assets/<key>`（T0，8 键均有真实 hash） | 渲染绑定 `mhr_mesh`（真实 `mhr-body.json.gz`）与 `pose_lllite`；本目录不填假 path/hash |
| 冻结 RS 几何源码 | RS `721d57ab98e80dc6854d4f49758bc9c456bb925c` 的 `pose3d.py`/`mhr.py`/`web/pose3d/mhr-body.json.gz` | `rs_bridge.py` 按 sha256 核验后 stage 导入（见 §3） |

冻结 RS 几何 sha256（`rs_bridge.FROZEN_SHA256`，与 preflight `productionRsPatch.identicalToFrozen` / `assets.mhr_mesh` 一致）：
`pose3d.py 890fd1cd…2cc5`、`mhr.py f7dde006…3adc0`、`mhr-body.json.gz cc07e6cd…9cbf19`。
实验 core 为 `2c75dc1b…`（4 个 Anima 关键文件与调研 `4d64a8bc…` 字节相同），RS 仍 `721d57ab…` 不变。

---

## 2. 文件接口（各文件做什么）

```
experiments/anima-interaction-v1/structure/
├── rs_bridge.py        # 定位+sha256核验+stage 导入冻结 RS pose3d/mhr/asset；失配即 raise，不混版本
├── geometry_core.py    # 数值核：FK control_points / 透视投影 / 相机取景拟合 / box 归一化 /
│                       #   repair core·support·context·gray 构造 / pattern-search IK(authoring 工具)
│                       #   —— 本文件自身从不调用光栅器；render.py 才喂真实 mask 给 repair 助手
├── frozen_poses.py     # 冻结 authoring 数据：4 动作姿态(IK 解出的关节角) + 指间相扣表 + 鲸尾 union 几何
│                       #   + 接触/遮挡/owner 标注 + DC/QG owner 绑定；纯数据，不维护角色/LoRA 表
├── build_geometry.py   # T2a 主发射器：产 frozen/geometry.json + frozen/source_index.json(unrendered)
│                       #   + run-root inputs/structure/{source_index.json,README.md}；只 FK/投影，不光栅
├── render.py           # T2b 真实 CPU 渲染程序（T2a 不运行）：驱动冻结 RS 光栅器产 PNG+sha256+正式索引
├── selfcheck.py        # T2a 数值/JSON/AST 自查（38 项）；不光栅、不看图、不评分
└── frozen/
    ├── geometry.json       # 冻结几何：8 worlds + 40 projections + 4 solo + 标注 + 自检
    └── source_index.json   # unrendered 源索引：44 case → scene 指针 + 相机 + FK-proxy box + planned files
```

run-root 落点（T2a 写 unrendered 索引；T2b 写真实 PNG）：
```
var/local-driver/anima-interaction-v1/inputs/structure/
├── source_index.json   # T2a: unrendered 44-case 源索引
├── README.md           # T2b 渲染落点说明
└── <case_id>/          # T2b 渲染后：scene.json/pose_image.png/owner_a.png/owner_b.png/
                        #   owner_*_full.png/repair_core.png/support.png/context.png/gray.png/
                        #   preview.png/structure_index.json（真实文件+sha256+权威 box）
```

---

## 3. 精确 CPU 运行命令与依赖

依赖：**numpy**（FK/投影/光栅）+ **Pillow≥10**（仅 render.py 存 PNG）。**无 torch、无 GPU、无 scipy、
无远端、无 pip 安装**。本机验证解释器 `/usr/local/bin/python3`（numpy 可用，PIL 12.3.0）。
RS 几何源码与真实 MHR 资产由 `rs_bridge.py` 从只读源（默认 `var/local-driver/.../checks/environment-code/rs/`，
含 `pose3d.py`/`mhr.py`/`mhr-body.json.gz`）按 sha256 核验后 stage 到
`$YUGANG_RS_STAGE`（缺省系统 temp `yugang-t2-rsgeom-stage`）导入；**不改快照、不改生产、不下载**。
可用 `YUGANG_RS_SRC` 指定其它冻结 RS 几何目录。

```sh
# 仓库根执行。T2a 已完成这两步（产物已落盘），列出供复现/审计：

# (A) 发射冻结几何 + unrendered 源索引（FK+投影数值，不光栅）
/usr/local/bin/python3 experiments/anima-interaction-v1/structure/build_geometry.py

# (B) 数值/JSON/AST 自查（38 项，全 PASS 退出 0；不光栅、不看图）
/usr/local/bin/python3 experiments/anima-interaction-v1/structure/selfcheck.py

# (C) 仅语法核验 T2b 渲染程序（T2a 不运行真实渲染）
/usr/local/bin/python3 -m py_compile experiments/anima-interaction-v1/structure/render.py

# ---- 以下由 T2b 执行（真实 CPU 渲染，需 preflight 绑定的真实 MHR 资产）----
# (D) 规划核验（不渲染，调用光栅器前返回）：
/usr/local/bin/python3 experiments/anima-interaction-v1/structure/render.py --dry-run \
    --out var/local-driver/anima-interaction-v1/inputs/structure
# (E) 真实渲染全部 44 case（产 PNG + sha256 + 正式 structure_index.json，覆盖 unrendered）：
/usr/local/bin/python3 experiments/anima-interaction-v1/structure/render.py \
    --geometry experiments/anima-interaction-v1/structure/frozen/geometry.json \
    --out var/local-driver/anima-interaction-v1/inputs/structure
# 单 case：--cases DC-HAND-W,DC-CARRY-M
```

---

## 4. 冻结几何内容（geometry.json）

- **canvas**：全 44 case 统一 `1024×768`（4:3），五景别共用；景别只由**参考相机距离/取景窗口**表达
  （`fit_camera` 解相机到目标距离 d，方位固定正面 +Z、fov 固定 38），**不改画幅**，**不接 RSCameraControl**。
- **scene 契约**：RS **version 2（原生 MHR 蒙皮体）**、`mask_mode=visible`（owner 可见二值轮廓，遮挡剔除）、
  `outline=true`（着色 3D 人体 **+ outline**，匹配 `anima_3dpose_outline` 训练分布）。每个 scene 都过冻结
  `pose3d.read_scene` 校验（44/44 PASS）。
- **8 世界结构** = 4 动作模板（HAND/HUG/KISS/CARRY 的冻结 body 变换 + 关节角）× 2 pair owner 绑定
  （DC: A=deepseek/B=claude；QG: A=qwen/B=grok）。**body 几何按动作共享**（同一 MHR 成年 rig，
  `scale=bulk=1.0`，符合 §3.1「成年/正常比例/不额外改体型」；rig 无 per-character morph，身份来自 LoRA/prompt
  而非几何）；world 实例的区别在 owner 绑定与标注。
- **40 投影** = 8 世界 × 5 景别（W/M/C/XU/XH），跨景别**世界姿态/接触/服装/相对位置/镜头朝向不变**，
  仅相机距离/取景窗口变。每 case 带相机参数、FK-proxy box、`expected_visible_contacts`、
  `expected_out_of_frame_parts`、`framing_caveat`（§3.4 边界，机械声明，非助手判定）。
- **4 单人** = SOLO-{deepseek,claude,qwen,grok}，中景站姿（M，1girl/solo），供 W-S；无 pair/无接触，
  repair 域 `not_applicable_no_contact`。
- **owner / 接触 / 遮挡**：每 world 带 `contact_group`（接触控制点 + 诚实限制）、`occlusion`（前后遮挡说明）、
  `owner_annotations`（每槽归属）。**owner 二值身份 mask 与灰度重绘强度图是不同资产**（render.py 分开产
  `owner_*.png` 与 `gray.png`）。

### 4.1 box（归一化中心）

契约（spec.fixed_parameters.box_derivation）：owner 参考投影**可见包络** → bbox 四边各扩 **8px** → 夹画布 →
归一化**中心 x/y/width/height**。B0/B1 同 box；B2 同投影来源的轮廓 union（`owner_*.png`），
`RSMultiCharacterMask margin=0/threshold=0.5`。
- **T2a**：geometry.json/source_index.json 给 **FK-proxy box**（控制点 + 体表白边 0.11，DC W/M 另含鲸尾），
  标 `source=fk_control_point_proxy`、`authoritative=pending_T2b_rendered_owner_visible_mask`。
- **T2b**：render.py 用 `box_from_mask` 从**渲染出的 owner visible mask** 算**权威 box**，写进正式 structure_index。

### 4.2 repair core/support/context/gray（render.py 产，参数冻结）

`core_radius_px=6`、`support_grow_px=48`、`ring_px=61`（=裁剪短边 768 的 8%）、`context_grow_px=96`，native 1024×768：
- **core** = owner_a 距 owner_b ≤6px 的接触核（**真实接触线在核心内**，二值）。
- **support** = 二值 union(owner_a,owner_b) 膨胀 48px（可编辑域）。
- **gray** = core=1 平台、外环 61px 线性衰减到 0、**支持域外=0**（连续灰度，**独立于 owner 二值 mask**）。
- **context** = support 膨胀 96px（独立上下文域，供 Crop & Stitch）。
- 出画/编辑域为空是**机械事实**（如 XH 头部裁剪使接触组落在取景窗外 → `support_empty=true`），
  **不改取景救图、不假造**。native 灰度由 T4 `YugangMaskCropTransform` 以同一变换重采样进 768×768 crop
  （灰度连续插值 + 支持域重夹限），实现 crop-space 的 8% 外环规格。

### 4.3 鲸尾（deepseek 同 owner occupancy union）

MHR rig **无尾骨**（127 骨全核），§4.2 禁止给人体加鲸尾骨架标签 / 把非人体附属物伪装 LLLite 骨架。
故鲸尾是**冻结世界几何**（`frozen_poses.TAIL_DEEPSEEK`：pelvis 锚点的锥形 polyline + 尾鳍，body-local 偏移），
T2b 投影+光栅成锥形圆盘，**union 进 owner_a 区域 mask（B2 非矩形轮廓）与 W/M box 包络**，
被 B 遮挡处扣除（单 owner）。**永不写进 pose_image / LLLite 骨架 / openpose**。QG 无尾。
grok 头饰段 **bat wings 是 HEADWEAR**，不擅自加大背翼，故**无背翼几何**（仅 owner 标注）。

---

## 5. 手指限制（如实记录，不装作已精确控指）

- **存在性已闭合为肯定**：真实 MHR 资产暴露 **54 controls，其中 34 个为逐指关节**
  （thumb0-3 / index1-3 / middle1-3 / ring1-3 / pinky0-3，双手）， backed by 127 骨全指链。
  `read_scene` 接受这些 control 名，`mhr.mannequin()` 按 extrinsic XYZ 施加 → **逐指可 authoring**。
- **但无保证**：**没有十指相扣预设**（仅 standing/seated/wave/reach），**没有接触/约束求解器**
  （`read_scene` 只做范围 clamp，不检测/阻止穿插，不强制真正交错）。RS 自报
  `controlnet_used=false / pose_enforcement=false`，DESCRIPTION 明示「composition guide, not exact pose
  enforcement」「exact joints and contacts are not guaranteed」。
- **本目录的 HAND**：`FINGER_INTERLOCK` 是**人工 authoring** 的逐指 curl（+Y 屈曲轴 + 交替侧向 splay 让两手指
  交错姿态），叠加在 IK 解出的**腕接近 + 相对姿态**上。冻结实测 **A.right_wrist↔B.left_wrist = 0.162 世界单位**
  （接近，非重合）。**这不是精确指间几何控制，不保证真正交错而非穿插**；实际十指表现交主人看图。
  额外可控手指网格（渲染分布匹配 LLLite）须**单列探索**，不静默混入原生 LLLite 消融。
- 其它动作冻结实测残差（honest evidence，非 pass/fail）：HUG 双手落对方背 ~0.21、胸腔间距 0.369；
  KISS 唇代理点 0.041（接近接触，唇非 MHR 控制点）；CARRY A 手承托 B 大腿 0.05、**B 双脚离地 ankle y=0.585**、
  B pelvis y=1.224（高于 A 0.924）、B 手搭 A 肩 0.06–0.07、B 膝绕 A 两侧(x=±)但 z 偏后(膝残差 0.33)。
  **A 臂展 <~0.55（肩 y1.42），无法低于 y~0.87，故 CARRY 的 B 必须坐高**——这是 FK 发现的硬约束，已据此冻结。

---

## 6. T2a 自检结果（selfcheck.py，38/38 PASS）

机械项（不判图）：44 scene 全过冻结 `read_scene`；相机全满足 distinct-target/nonvertical 闸；
scene 全 version2/visible/outline/1024×768；proxy box 全归一化在画布内；取景拟合全在 binding 轴容差内；
HAND/HUG/KISS/CARRY 残差由冻结关节角**复现**（含 CARRY B 离地）；MHR 34 指控制/54 控制；
手指限制文案含「不保证」「非精确指间」；`ai-girls.json` sha256 与记录一致；geometry 不携带 LoRA 文件名；
鲸尾 owner=deepseek/never_in pose_image·skeleton/QG 无尾/DC 尾=A；grok bat-wings 标注为头饰无背翼几何；
**AST 证明 build_geometry/geometry_core/frozen_poses/selfcheck 从不调用光栅器，唯 render.py 驱动 `_rasterize`**；
40 投影全声明 expected visibility；8 世界全带 contact_group；source_index 全 unrendered、无假 png sha256。

---

## 7. 移交 T2b / T3（本目录不扩）

- **T2b**：跑 `render.py`（§3 E）产真实 PNG + sha256 + **权威 box** + repair 域，写正式
  `inputs/structure/<case_id>/structure_index.json` 与根 `structure_index.json`，覆盖 unrendered 状态；
  机械核验（尺寸/hash/坐标/值域），**不接 GPU、不看图评分**。渲染须以后绑定 preflight 的真实 MHR 资产；
  缺失则明确 pending，**不假造图、不用火柴人替代 3D**。
- **T3**：消费 `geometry.json#/projections[case_id]`（scene/camera/box）与 T2b 正式 structure_index
  （真实文件+hash）展开 manifest；§8.1「图构建在真实渲染后消费，不各自重造几何」。
- **未闭合（诚实记录）**：① 真实渲染未做（T2b）；② HAND 腕距 0.162 非重合、指间交错非求解器保证；
  ③ box/包络权威值待渲染 mask；④ 灰度 crop-space 8% 外环由 T4 重采样实现；⑤ 相机取景为 FK 控制点 proxy
  拟合（体表白边 0.11 近似），权威景别仍需主人视觉复核（§3.2）。

许可：本目录代码 GPL-3.0-only（派生/复刻自冻结 RS GPL-3.0-only 与 CropAndStitch 坐标语义）；
stage 的 MHR 资产 Apache-2.0（(c) Meta Platforms，随附 MHR-LICENSE.txt/MHR-NOTICE.txt）。
未触碰生产 `src/tools/` 角色/LoRA 表、模板、模型、ComfyUI。
