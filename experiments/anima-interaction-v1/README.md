# anima-interaction-v1 · T4 本地隔离原型：RS masked img2img 二开 + Crop 坐标胶水节点

日期：2026-11-11。任务：T4（`docs/plans/2026-11-11-anima-interaction-study.md` §2.1/§5.2）。

**状态边界（先读）**：本目录只是**本地静态原型**。未运行真实 GPU、未提交任何采样、未安装到远端
ComfyUI、未修改生产代码/模型/模板/LoRA 表、未写 T0（preflight）/T1（spec.json）/T3（runner、
interaction-study.ts / run.py）文件。全部验证仅为 py_compile / AST / `git apply --check` 级静态检查；
「跑通/验收」由 T6 真实运行另证，本 README 不声称任何运行时行为已验证。没有新建软件单元测试、
fixture、mock、合成环境或测试图。

## 1. 选型依据（真实冻结源码，短记录）

固定快照（批准 TEMP，只读）：

| 包 | commit | 备注 |
| --- | --- | --- |
| ComfyUI_RS_MultiCharacter_Sampler | `721d57ab98e80dc6854d4f49758bc9c456bb925c`（tag v1.1.3） | `comfy-composition-survey-rs-20261111` |
| ComfyUI core | `4d64a8bc072b81c9b47321789b4d83fb7348ae2a` | `comfy-composition-survey-core-20261111`（sparse，经 `git1 show HEAD:path` 读取） |
| ComfyUI-Inpaint-CropAndStitch | `6005efc02f7745649118edd89cdd084c2b9bd3ae`（3.0.20） | `comfy-composition-survey-crop-code-20261111`（no-checkout，经 `git1 show` 读取） |

结论与出处：

1. **RS 主 Sampler 没有局部 img2img 入口**：`nodes.py::RSMultiCharacterSampler.INPUT_TYPES`
   （74–106 行）无 image/latent/denoise/noise_mask 参数；`generate()` 在 452–457 行固定构造
   **零 latent**，`_sample_latent`（503–515 行）固定 `denoise=1.`、不传 `noise_mask`。→ 必须二开。
2. **RS Detailer 不满足双方接触联合求解**：`detailer.py::_sample_crop`（41–79 行）确实用
   `common_ksampler + {"samples","noise_mask"} + denoise` 做 masked img2img，但它是**逐检测 crop、
   单次只匹配一个角色槽的 LoRA hook**（`lora_hook`/`lora_runtime` 单数，`match_characters` 按
   crop 选角色），无法在一个接触 crop 内同时保两个角色的区域提示/归属路由。→ 不复用，改为在
   主 Sampler 链上开最小入口。
3. **没有现成 wrapper 可安全复用**：RS `progressive.py`/`anima_ref_frame.py` 的 SAMPLER_SAMPLE
   wrapper 都服务于参考帧/渐进分辨率，不暴露 latent/denoise/mask 输入。core 侧
   `comfy.sample.sample`（`comfy/sample.py`）本身已接受 `denoise`、`noise_mask` 并转发为
   `KSampler.sample(..., denoise_mask=...)`；core `samplers.py` 634–642 行证实 `denoise_mask`
   逐步作用于 inner model，且 `model_options["denoise_mask_function"]`（DifferentialDiffusion 的
   通道，`model_patcher.py::set_model_denoise_mask_function` 663–664 行写入 `model_options`）在
   同一处被消费。→ 二开只是把这两个已有参数接到 RS 采样链，不重写扩散算法。
4. **clone 不丢灰度门**：`model_patcher.py::clone`（435 行起）用 `deepcopy_list_dict` 复制
   `model_options`（函数按引用保留），RS 的 `work = model.clone()` 与 routing wrapper
   （`add_wrapper_with_key(SAMPLER_SAMPLE/DIFFUSION_MODEL, ...)`）都不触碰
   `denoise_mask_function`；`engine.py::AnimaRouting.sample`（50–88 行）对 `*args` 透传，
   `denoise_mask` 原样到达 inner model。区域 LoRA 的 precision 路径
   （`regional_lora.py::condition_pair` → `comfy.hooks.set_mask_for_conditioning`）作用在
   conditioning 的 `mask` 元数据上，与 latent `noise_mask` 是两个通道，互不覆盖。
   （以上为静态源码核实；运行时组合行为归 T6。）
5. **owner 归属 mask 与灰度强度图分离**：RS `layout.py::character_masks`（65–92 行）把
   `region_mask` 以 `interpolate(mode="area") > .5` **二值化**为归属支撑（源码注释即声明
   binary support），这是设计而非缺陷；灰度重绘强度必须走 latent `noise_mask`
   （core `SetLatentNoiseMask` 形态 `(-1,1,H,W)`，`samplers.py::CFGGuider.sample` 1298–1315 行
   经 `comfy.utils.reshape_mask` bilinear 缩放到 latent 分辨率、保留灰度、逐 channel 复制）。
   本二开严禁把灰度塞进 owner 通道，反之亦然。
6. **latent/image 形状**：RS 主 Sampler 对 Anima 固定 `(1,4,H/8,W/8)` + `fix_empty_latent_channels`
   （5D latent_dimensions=3 时 unsqueeze 时间维）；`detailer.py::_sample_crop` 62–66 行给出
   `vae.encode` 输出的实测约束：4D 或 5D（5D 时 `shape[2]==1`）、batch 1。新节点按同一约束校验，
   不用假张量声称跑通。
7. **Crop STITCHER 字段**：`inpaint_cropandstitch.py::InpaintCropImproved.inpaint_crop` 组装
   `canvas_to_orig_x/y/w/h`、`canvas_image`、`cropped_to_canvas_x/y/w/h`、
   `cropped_mask_for_blend`、`downscale_algorithm`/`upscale_algorithm`（每字段为按 batch 的 list）；
   `crop_magic_im` 的链条 = 原图 edge-fill 进 canvas（cto 偏移）→ 窗口裁剪（ctc）→ 按
   `target > crop ⇒ upscale_algorithm，否则 downscale_algorithm` 用 PIL resize（`rescale_m` 同
   `_get_pil_resampling` 映射）到 target。胶水节点严格复刻这条链，不做图像语义推断。

## 2. 交付物与许可

```
experiments/anima-interaction-v1/
├── patches/rs-img2img.patch                      # 对隔离 RS 副本的最小二开补丁（GPL-3.0-only）
├── custom_nodes/yugang_interaction/              # 独立胶水节点包（GPL-3.0-only，见包内 LICENSE）
│   ├── __init__.py                               # NODE_CLASS_MAPPINGS 注册
│   ├── mask_crop_transform.py                    # YugangMaskCropTransform
│   └── LICENSE
└── README.md                                     # 本文件
```

许可：补丁修改/派生自 GPL-3.0-only 的 RS 包（源文件头 `SPDX-License-Identifier: GPL-3.0-only`
保留，新文件同许可）；胶水节点复刻 GPL-3.0 CropAndStitch 的坐标/缩放语义并与其同进程加载，
取 GPL-3.0-only（保守兼容）。两个上游包的其余资产许可（ANIMA-*-LICENSE 等）不受本目录影响，
部署时随各自仓库保留。生产 `src/tools/` 的 LoRA/角色表、模板、模型一律未动。

## 3. rs-img2img.patch：内容、应用与回滚

**固定 base**：RS 仓库 commit `721d57ab98e80dc6854d4f49758bc9c456bb925c`（tag v1.1.3）。
补丁以该 commit 的树为 a/ 侧生成（`git1 diff HEAD`，工作副本 = 快照 + 本改动）。

**改动面（最小可审查）**：`2 files changed, 14 insertions(+), 8 deletions(-)` + 1 个新文件：

| 文件 | 改动 |
| --- | --- |
| `nodes.py` | ① `apply_pipe_pose` 调用加 `getattr(self, "ALLOW_PIPE_POSE", True)` 门（原类缺省 True，行为不变）；② 零 latent 构造抽成可覆写方法 `_initial_latent`（返回 `(latent, None, 1.)`，与原行为逐语句一致）；③ `_sample_latent` 增加缺省参数 `noise_mask=None, denoise=1.` 并把 `comfy.sample.sample` 的 `denoise=1.` 改为 `denoise=denoise`、新增 `noise_mask=noise_mask`（缺省值下与冻结行为完全等价） |
| `__init__.py` | 注册 `YugangRSMaskedImg2Img`（import + NODE_CLASS_MAPPINGS + 显示名；自动进入既有 `shared_pipe_inputs` 循环） |
| `yugang_rs_img2img.py`（新增） | `class YugangRSMaskedImg2Img(RSMultiCharacterSampler)`，见 §4 |

不改动：`engine.py`、`regional_lora.py`、`character_builder.py`、`layout.py`、`detailer.py`、
pose/reference 全链。原 `RSMultiCharacterSampler` 的零 latent 初采样分支语义不变。

**应用（只许应用到隔离实验副本，禁止生产 custom_nodes 与本地快照）**：

```sh
# 1) 建隔离副本并核对 base
git clone <隔离 RS 仓库或快照> /path/to/experiment/custom_nodes/ComfyUI_RS_MultiCharacter_Sampler
cd /path/to/experiment/custom_nodes/ComfyUI_RS_MultiCharacter_Sampler
git rev-parse HEAD   # 必须输出 721d57ab98e80dc6854d4f49758bc9c456bb925c，否则停止并记录 diff

# 2) 先 check 再 apply
git apply --check /path/to/yugang/experiments/anima-interaction-v1/patches/rs-img2img.patch
git apply /path/to/yugang/experiments/anima-interaction-v1/patches/rs-img2img.patch

# 3) 胶水节点包整目录放入同一隔离实例的 custom_nodes/（与 RS 包平级）
cp -R /path/to/yugang/experiments/anima-interaction-v1/custom_nodes/yugang_interaction \
      /path/to/experiment/custom_nodes/yugang_interaction
```

**回滚**：`git apply -R <patch>`（或直接丢弃隔离副本重建）；胶水节点包整目录删除即可，
无状态、无迁移。生产实例从未安装二者，无需回滚。

## 4. 节点接口冻结（供 T3 构图消费；本任务不写 T3 文件）

### 4.1 `YugangRSMaskedImg2Img`（RS 补丁内，class_type 即注册名）

- CATEGORY `RS MultiCharacter`；`FUNCTION="generate"`；`OUTPUT_NODE=False`（不 autosave；
  落盘由 runner 的 SaveImage/上游链负责）。
- RETURN_TYPES `("IMAGE", "LATENT", "RS_MC_CHARACTER_PIPE", "STRING")`，
  RETURN_NAMES `("image", "latent", "character_pipe", "generation_info")`——与父 Sampler 同构，
  image 已在节点内 `vae.decode`，generation_info 为父级 summary JSON 追加 `yugang_img2img` 块。

INPUT_TYPES（冻结）：

| 组 | 参数 | 类型/缺省 |
| --- | --- | --- |
| required | model / clip / vae | MODEL / CLIP / VAE |
| required | character_pipe | `RS_MC_CHARACTER_PIPE,NAI_CONTEXT`（**crop 画布坐标系**重建的 pipe：两角色槽、box/region_mask 归一化到 crop） |
| required | prompt / negative_prompt | STRING multiline |
| required | width / height | INT，缺省 768，64–4096，step16（必须等于输入 latent×8 / image 尺寸，不符即报错，不静默缩放） |
| required | seed | INT 0–2^64-1，control_after_generate |
| required | steps / cfg | INT 30（2–100）/ FLOAT 4.0（1–20） |
| required | sampler_name / scheduler | 枚举，缺省 `euler_ancestral` / `sgm_uniform` |
| required | denoise | FLOAT，缺省 0.45，0.01–1.0，step 0.01（真实传入 `comfy.sample.sample`） |
| optional | image | IMAGE（batch1 RGB，尺寸=width×height；与 latent 二选一，都给/都不给均报错） |
| optional | latent | LATENT（`{"samples": 4D/5D}`；5D 时 `shape[2]==1`；可携带 `noise_mask` 键，即 SetLatentNoiseMask 形态） |
| optional | noise_mask | MASK `[1,H,W]` 像素空间灰度（= width×height，值域 [0,1]）；缺此输入且 latent 无 noise_mask 时报错——修复阶段必须显式给 mask |
| optional | prompt_syntax | ComfyUI/NovelAI，缺省 ComfyUI |
| optional | region_feather … boundary_decrement | 与父 Sampler 同名同缺省（0.04 / 0.05 / 0.1 / 1.7 / 0.9 / 3 / 0.2） |
| optional | layout_method | `regional`/`auto`，缺省 `regional`（无 MOSS native） |
| hidden | workflow_prompt / unique_id | PROMPT / UNIQUE_ID |

机械闸（fail-closed，全部报错不降级）：

- MODEL 带 `rs_3d_pose` plan 或 Anima LLLite patches（`validate_model_patches` 为真）→ 拒绝；
  必须使用**全新未挂 pose 的 MODEL**（R1/R2/R3 同）。
- pipe 仍带 `pose3d_json` 且 mode=auto、strength>0 → 拒绝（禁止旧全景 scene 重渲染到 crop）；
  masks_only/strength 0 允许并记录。
- 角色 reference（任何 strength>0）或 model 带 ref-frame/image-reference plan → 拒绝。
- `noise_mask` 为灰度（存在非 {0,1} 值）而 MODEL 无 `denoise_mask_function`（即上游没接
  core `DifferentialDiffusion`）→ 拒绝，不静默退化为硬 mask 混合。
- 尺寸/值域/有限性任一不符 → 拒绝（见上表）。

`ALLOW_PIPE_POSE=False`：即使 pipe 带 pose3d_json（masks_only 情形）也不调用 `apply_pipe_pose`。

generation_info 的 `yugang_img2img` 块（冻结字段）：
`node / stage="repair" / start_kind（image+vae|latent）/ requested_denoise / input_latent_shape /
declared_canvas / noise_mask{source(input|latent_dict|input_over_latent_dict), pixel_shape,
mode(binary|gray), min, max} / differential_diffusion_hook(bool) / pose_disabled(true) /
pipe_pose3d_present / lllite_patches_on_model(false) / effective{width,height,denoise,
layout_method, lora_application(requested/effective/fallback_reason 沿用父级 audit)}`。
父级 summary 原有字段（settings、routing_audit、regional_loras audit、mask_slots/box_slots 等）
全部保留——满足「requested/effective/输入尺寸/denoise/是否 mask+DD/pose disabled，不静默 fallback」。

保留的父级机制（未复制、直接继承）：角色 prompt/UC 区域条件化（`text_region_caption`/
`regional_negatives`）、`character_masks` 归属路由（含二值化语义）、`RegionalLoras` precision
路由与 hook 共享缓存、`AnimaRouting` 采样/前向 wrapper、`build_record` 元数据与 enriched pipe。
双人在**同一 crop 内联合求解**（一次采样、两槽路由），不是逐人 Detailer，也不是两个全球 LoRA，
不是采样后 RGB 混合。

### 4.2 `YugangMaskCropTransform`（`custom_nodes/yugang_interaction/`，独立包）

- class_type `YugangMaskCropTransform`；CATEGORY `yugang_interaction`；`FUNCTION="transform"`。
- INPUT_TYPES required（冻结）：`stitcher(STITCHER)`、`mask_owner_a(MASK)`、`mask_owner_b(MASK)`、
  `mask_gray(MASK)`。三个 MASK 均为**原画布坐标系** `[B,H,W]`（B 必须等于 stitcher batch；
  H/W 必须等于 `canvas_to_orig_h/w`，不符报错，不静默 rescale）。crop 输出尺寸不另设参数，
  从 `cropped_mask_for_blend` 形状读取（与 crop 节点输出严格一致）。
- RETURN_TYPES `("MASK","MASK","MASK","STRING")`，RETURN_NAMES
  `("owner_a_crop","owner_b_crop","gray_crop","transform_json")`；输出 batch 与 stitcher 一致，
  CPU float32，尺寸 = crop 输出尺寸（冻结实验里 768×768）。
- 变换链（与 `crop_magic_im` 同参数同方向规则）：pad 进 canvas（零填充，cto 偏移）→ ctc 窗口
  裁剪 → PIL `F` 模式 resize 到 target。**owner：nearest + clamp[0,1]**；**gray：stitcher 方向
  感知算法（upscale_algorithm/downscale_algorithm，缺省 bicubic/bilinear）连续插值 + clamp[0,1]
  + 支撑域重夹限**（`gray>0` 的二值支撑用同一连续核变换后 `>0` 阈值，逐点相乘）；若 stitcher
  算法为 nearest（非连续）→ 以 bilinear 替代并在 JSON 记 `gray_algorithm_substituted=true`，
  不静默。不做 fill/invert/expand/hipass/outpaint/preresize，不做任何图像语义判断。
- STITCHER 消费契约（必需键，缺一报错）：`cropped_to_canvas_x/y/w/h`、`canvas_image`、
  `cropped_mask_for_blend`、`canvas_to_orig_x/y/w/h`、`downscale_algorithm`、
  `upscale_algorithm`；全部为按 batch 的 list，长度必须一致。
- `transform_json`（冻结字段）：`node / source{stitcher_node, stitcher_package, stitcher_commit} /
  chain / batch_size / per_batch[{batch, canvas{w,h}, canvas_to_orig{x,y,w,h},
  cropped_to_canvas{x,y,w,h}, target{w,h}, direction(upscale|downscale), stitcher_algorithm,
  owner_interpolation="nearest", gray_interpolation, gray_algorithm_substituted,
  gray_support_reclamped=true, input_mask_size, gray_input_range, gray_output_range,
  owner_a_output_binary, owner_b_output_binary}]`。

### 4.3 R1/R2/R3 graph 形状说明（不执行的接线描述，供 T3）

冻结 crop 参数（计划 §2.4，R1/R2/R3 全同，同一 STITCHER、同一贴回 alpha）：
`mask_fill_holes=false, mask_expand_pixels=0, mask_invert=false, mask_hipass_filter=0,
preresize=false, extend_for_outpainting=false, context_from_mask_extend_factor=1.2,
output_resize_to_target_size=true, output_target_width=768, output_target_height=768,
output_padding=32`；`mask_blend_pixels` 取 T1 spec 冻结值（同一 run 内 R1/R2/R3 一致）。
采样固定：30 steps、CFG 4.0、`euler_ancestral` + `sgm_uniform`；repair denoise ∈
{0.30, 0.45, 0.60}；seed 按 §4.1 stage-seed 派生（stage=repair_grid/repair_repeat）。

```text
公共前段：
  父图(B2, 1024×768) ─→ InpaintCropImproved(support=二值可编辑域并集, context=上列冻结参数)
                          ├─ STITCHER ─────────────────────────────┐
                          ├─ cropped_image (768×768)               │
                          └─ cropped_mask(仅上下文参考，不当灰度用) │
  原画布 ownerA/ownerB/gray MASK ─→ YugangMaskCropTransform(STITCHER)
                          ├─ owner_a_crop / owner_b_crop（binary，供 pipe 区域/审计）
                          ├─ gray_crop（R2/R3 的 noise_mask；R1 用其二值化 uniform 版）
                          └─ transform_json（存档）

R1（普通 core KSampler，全球 LoRA，同文件只 load 一次）：
  全新 MODEL → LoraLoader(每唯一文件一次) → DifferentialDiffusion 不接
  cropped_image → VAEEncode → SetLatentNoiseMask(mask=R1 uniform binary) → KSampler(denoise=r)
  → VAEDecode → InpaintStitchImproved(STITCHER) → SaveImage
  （positive = 公共+两角色提示合并文本；无区域路由——这是 R1 的对照意义本身）

R2（同 R1 + 灰度 + DD）：
  全新 MODEL → LoraLoader(同上) → DifferentialDiffusion(strength=1.0)
  cropped_image → VAEEncode → SetLatentNoiseMask(mask=gray_crop) → KSampler(denoise=r)
  → VAEDecode → InpaintStitchImproved(同一 STITCHER) → SaveImage

R3（RS 区域身份路由的局部 img2img，本补丁节点）：
  全新 MODEL（未挂 pose；R2 同款 DD 接法）→ DifferentialDiffusion(strength=1.0)
  crop 画布 pipe：RSMultiCharacterPrompt ×2 → RSMultiCharacterLoRA(两槽，同文件不合并)
    → RSMultiCharacterPosition(box=crop 坐标，由 owner_*_crop/transform_json 机械导出)
    → [RSMultiCharacterMask(enabled=false) 清 pose 轮廓，如 pipe 复用自 B2] → RSMultiCharacterFinalize
  YugangRSMaskedImg2Img(model=DD 后的全新 MODEL, clip, vae, character_pipe=crop pipe,
    latent 或 image=cropped_image, noise_mask=gray_crop, denoise=r,
    width=height=768, 30 steps, CFG4, euler_ancestral/sgm_uniform, layout_method=regional)
    → image → InpaintStitchImproved(同一 STITCHER) → SaveImage
    → generation_info 原样存档（含 yugang_img2img 块）
```

R3 的 MODEL 若由 R2 同一 `DifferentialDiffusion` 输出复用，属同一 graph 内合法共享；
初采样的 pose MODEL **不得**接入（节点会机械拒绝）。P 组不属于本任务。

## 5. 静态检查记录（全部通过；命令可在仓库根重放）

工作副本（批准 TEMP，实验用，非交付物）：
`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/opencode/yugang-t4-workspace-20261111/`
（`rs/` = 快照 721d57ab 全树 + 本补丁；`fresh/` = patch 回环验证用全新 clone）。

| # | 检查 | 命令要点 | 结果 |
| --- | --- | --- | --- |
| 1 | 快照基线核对 | 三个快照 `git1 rev-parse HEAD` | `721d57ab…` / `4d64a8b…` / `6005efc…`，与计划一致 |
| 2 | 改后 RS 三文件语法 | `python3 -m py_compile rs/__init__.py rs/nodes.py rs/yugang_rs_img2img.py` | `PY_COMPILE_OK` |
| 3 | 补丁生成 | 副本内 `git1 add -A && git1 diff HEAD > patches/rs-img2img.patch` | 358 行；tracked 面 `2 files changed, 14 insertions(+), 8 deletions(-)` + 新文件 |
| 4 | 补丁回环 | 全新 clone（HEAD=721d57ab）上 `git1 apply --check` → `git1 apply` | `APPLY_CHECK_OK` / `APPLY_OK` |
| 5 | 回环一致性 | apply 后三文件 `shasum -a 256` 与工作副本比对 | 三文件 `MATCH`（sha256 见下方日志） |
| 6 | apply 后语法 | 全新副本上再 `py_compile` 三文件 | `APPLY_PY_COMPILE_OK` |
| 7 | 胶水节点语法 | `python3 -m py_compile __init__.py mask_crop_transform.py` | `GLUE_PY_COMPILE_OK` |
| 8 | 胶水节点 AST | ast 解析类属性/方法齐备（INPUT_TYPES/transform/RETURN_TYPES…） | `GLUE_AST_OK` |

关键 sha256（apply 后 = 工作副本）：
`__init__.py 269b1e3554e4f3cd75dfb504c48110b451eb1ca87f935276f59f5035cca49993`、
`nodes.py 5992e38759cd330dbe29b5c90327a280ce3973e57bd042bcf8fba1e62457552e`、
`yugang_rs_img2img.py bc5413d73d7b53039d04547e3ee1d171190f044cadc706385f0a152392e0b6d7`。

未做的检查（边界）：没有 import 级验证（本机无 torch/comfy/Pillow≥10 运行环境，且不建合成
env）；没有 `/object_info` 核对（归 T0 隔离实例）；没有任何真实采样、张量 fixture 或视觉输出。

## 6. 未闭合点（移交 T0/T3/T6，本任务不扩）

1. **运行时组合行为**：DD `denoise_mask_function` + RS routing wrapper + precision LoRA hooks
   三者在真实采样循环内的组合，仅有静态源码依据（§1 第 4 条），须 T6 首轮冒烟证实（含
   `reshape_mask` bilinear 后灰度在 latent 分辨率的实际分布）。
2. **Anima VAE 4D/5D 实测**：`vae.encode(crop_image)` 的实际 ndim/shape 与
   `spacial_compression_encode()` 是否恒为 8，须 T0 在隔离实例用真实权重核对；本实现按冻结
   RS/detailer 源码约束校验（4D 或 5D 单帧、batch1、×8），不符即报错。
3. **crop pipe 的构建**：R3 的 character_pipe 必须在 crop 坐标系重建（box 归一化到 768×768；
   若复用 B2 pipe 需按 §4.3 清 pose 轮廓）；builder 链的坐标换算属 T3 graph 构建，
   `transform_json` 已提供全部机械字段。
4. **`mask_blend_pixels` 与 support/gray 的具体栅格化**：归 T1 spec/T2 结构夹具冻结；本目录
   不预设数值（计划已冻结的 crop 参数见 §4.3）。
5. **隔离实例安装核验**（`/object_info` 出现两个新 class_type、PIL≥10 的 `Image.Resampling`、
   RS 包 Python≥3.11）：归 T0。
6. 新节点在 `npm test` 的 prompt 扫描范围之外（非 `src/`），对既有鱼测试无影响；本任务未跑
   `npm test`（未改任何 `src/`/prompt 文件）。
