# interaction-study-lib —— T3a 离线矩阵编译 / 真实资产绑定 / Comfy 图构建

anima-interaction-v1 研究的本地构建模块（`scripts/experiments/interaction-study.ts` 入口）。
**只做离线编译与静态自查**：不接 GPU、不 POST、不接 QQ/远端；真实采样由
`interaction-study-run.py`（T3b，见 `contracts/runner.md`）消费本模块产物执行。

权威依据：`docs/plans/2026-11-11-anima-interaction-study.md`（§8.1）+
run-root `spec.json`（冻结契约）+ `preflight.json`（T0 实体绑定）+
`inputs/structure/structure_index.json`（T2b 真实渲染，权威 box 来源）。

## CLI（仓库根执行；根路径唯一来源 = `src/paths.ts::REPO_ROOT`）

```sh
node scripts/experiments/interaction-study.ts describe-matrix   # 纯机械展开：896 行 = 808 new + 88 reuse，seed 示例自检
node scripts/experiments/interaction-study.ts describe-prompts  # 44 case 的地板/公共/区域文本（机械可复核，不写盘）
node scripts/experiments/interaction-study.ts preflight         # 门 1–4 + 资产绑定 + 结构状态（只读）
node scripts/experiments/interaction-study.ts build             # 全量：run-root/manifest.json + graphs/**（808 图）
node scripts/experiments/interaction-study.ts build --dry-run   # 全部门禁与构图照跑，不写盘
node scripts/experiments/interaction-study.ts build --group W-S --seed 20261111 --weight 0.8
                                                                # 分批首批：stages/w-s-smoke/（4 图，job_id 与全矩阵一致）
node scripts/experiments/interaction-study.ts collect|deliver|report   # 动态转发 interaction-study-archive.ts（T7a）；未落盘时如实报缺
node scripts/experiments/interaction-study.ts verify            # 显式拒绝（F1–F10 验收由后续独立模块接入；无空实现）
```

`--run <dir>` 覆盖 run-root（默认 `<REPO_ROOT>/var/local-driver/anima-interaction-v1`）。

## 构建硬门（缺一即拒绝并列出具体缺项；绝不产假图/假 hash）

1. `spec.json` 存在，stage-seed 冻结示例自检通过（`DC-HAND-W|20261111|initial` → 599278462）；
2. 角色源表 `src/tools/tags/ai-girls.json` sha256 == spec 冻结值，且 4 角色 inject/lora/weight
   经 `src/tools/characters.ts::loraBook` 与活表逐字核对（表变 → 停跑建新 run）；
3. `preflight.json` 8 资产键带实测 64hex sha256；图内只出现 comfyRelativePath 真名
   （`oneObsessionAnima_v40.safetensors` / `qwen_3_06b_base.safetensors` / `qwen_image_vae.safetensors` /
   `aigrilsV1.0.safetensors` / `claude_girl_anima_lora_clean.safetensors` /
   `rs_reference/anima_pose/anima_3dpose_outline_7000.safetensors`，pose 相对名带 rs_reference/ 防呆）；
4. 正负地板已在 `floor.ts` 显式冻结（T3a 履行 spec 延迟冻结项；`--floor` 只接受逐字确认）；
5. 全量 build：结构索引 `schema=yugang.anima-interaction-v1.structure.structure_index`、
   main_40+single_4 全部 `status=rendered`、逐文件实字节 sha256 核对、box 值域/RS slot_box
   不变量、scene ≤100KB。**box 直接取 T2b 权威值（rendered owner visible mask + 8px），不重造几何**。
   分批 `--group W-S` 只依赖门 1–4（W-S 是纯文本 core 管线，无姿态/结构消费）。

revision 保护：目标 manifest.json 已存在且 spec/preflight/structure_index 三 hash 任一不同 →
拒绝覆盖，要求新 revision run-root；相同 → 幂等重建。

## manifest 合同（runner 直接消费；schema_version = `anima-interaction-manifest.v1`）

顶层：`schema_version / generated_at / generated_by / spec_sha256 / preflight_sha256 /
structure_index_sha256 / prompt_floor（真实冻结文本+来源）/ characters_snapshot（含
matched_key_counts 与 clip_strength_inert=true 证据——两份 LoRA 均 0 TE key，clip 强度按 spec
联动传值但为已记录的空操作）/ lora_clip_inert_note / execution（core_commit=生产 v0.44.0
2c75dc1b 主会话裁定值，preflight.execution.coreCommit 落盘后以其为准；rs/crop/kj commit、
T4 patch、glue/support 节点包、canvas、sampler、rs_routing、mechanical_choices）/ counts /
selection（分批时）/ jobs`。

每行（896 行 = 808 `sample_kind=new` + 88 `reuse`：R0×72、W-RS(0.8,0.8)×16）：

| 字段 | 语义 |
| --- | --- |
| `job_id / group / case_id / pair / action / framing / seed / stage / stage_seed / method / weights` | 机械身份；stage_seed = uint32be(SHA256(case\|seed\|stage))，method 不进派生 |
| `sample_kind / depends_on / reuse_of / parent` | reuse 行**不 POST**；graph_path/graph_hash 指向源行（B2 或 P1） |
| `graph_path / graph_hash` | `graphs/<job_id>.json`（相对 manifest 所在目录）；hash = 写盘实字节 sha256（写盘后复核） |
| `expected_width / expected_height` | 全部行 = 主输出尺寸 1024×768（R 组主输出是 Stitch 贴回后的父画布；内部修复 crop 画布 768² 记在 `structure_provenance.repair_crop_canvas`） |
| `input_files` | 冻结合同：`{target, source:{kind: structure\|parent_job\|run_root_file, path, job_id, output_node_id, sha256}}`。**target 与图内 LoadImage `image` 字段完全相等、无 subfolder**（build 已逐图核对）；structure 型带真实 sha256，**path = run-root 相对**（索引里的 repo-root 相对 path 由 build 从 REPO_ROOT 定位真文件后转换，不猜路径）；parent_job 型 sha256=null 不预填，带上游 job_id 与其 SaveImage output_node_id——runner 必须等父 job 闭合、按实际 PNG 核 hash 后上传隔离 input，再提交本行 |
| `structure_provenance` | 未上传但审计相关的结构文件（scene/pose_image/repair_core 等）path+sha256；R 行含 repair_flags（core_empty/support_empty = 机械事实，runner 按其做机械跳过并记原因，不据视觉判断） |
| `asset_hashes / prompts` | 该行实际消费资产的 64hex sha；实际条件文本（positive_public/negative/slot_a/slot_b）原样保存 |
| `expected_visibility` | T2b 出图前声明（expected_visible_contacts / expected_out_of_frame_parts） |
| `output_contract` | `image_node_ids`（SaveImage 节点 id）+ `metadata_node_ids`（`YugangStudyMetadata` 节点 id）+ spec 字段清单/generation_info_keep |
| `prompt_id / generation_info / execution_status` | build 期一律 null，runner 回填（results.jsonl / state.json 按 contracts/runner.md） |

## 图构建合同（全部消费真实冻结接口，无虚构节点/参数名）

- **B0/B1/B2、H、pose_grid、W-RS**（`RSMultiCharacterSampler`）：Prompt→LoRA(precision)→
  Position(权威 box)→[Pose3D(scene 内容 build 期实读内嵌，pose_control=auto)→Mask×2]→Finalize→
  Sampler。B1 = Mask(enabled=false) 清 Pose3D 自带轮廓、保留同一 box；B2 = Mask(enabled=true,
  margin=0, threshold=0.5, mask=owner 非矩形 union LoadImage→ImageToMask(red))。采样
  30 steps / cfg 4.0 / euler_ancestral / sgm_uniform / `layout_method=regional`（显式钉死，缺省是
  auto）/ `autosave=false`（落盘走 SaveImage，filename_prefix=`yugang-study/<job_id>`）/
  routing 九字段全冻结值。姿态原生 2B LLLite 只经 pose_pipe 内部挂一次（图内不出现
  ModelPatchLoader）；不接 RSCameraControl、不接 Interaction。
- **W-S**：core 直采（UNET/CLIP/VAE→LoraLoader(w,w)→CLIPTextEncode→EmptySD3LatentImage→
  KSampler(30/4/euler_ancestral/sgm_uniform, denoise 1)→VAEDecode→SaveImage）。无姿态 patch
  （规范未要求）、无结构消费。
- **W-G**：core LoraLoader 全局链（DC 两文件各一次独立权重；QG 单文件级权重一次，不伪造异权
  等价组）+ `RSMultiCharacterPose3D`（只渲染，不接 pipe）→ `ModelPatchLoader` +
  `AnimaLLLiteApply`（mask 不接=None，strength/start/end=0.8/0/0.7，只挂一次）→ 普通 KSampler。
- **R1/R2/R3**（计划 §8.1 R 接口修正 + T4/T4c 冻结形状）：父图 LoadImage +
  **T2c repair-v2 局部接触组** support/context → `InpaintCropImproved`（冻结参数全量显式，
  target 768²，padding "32"，mask_blend_pixels=32 为记录的机械选择）。mask 管线：
  glue 调用 1（owner_a/owner_b/native gray → crop 空间；owner 供 R3 pipe，native gray 仅
  保留来源**不接最终 noise_mask**）；glue 调用 2（同一 STITCHER，mask_owner_a=repair-v2
  core、mask_owner_b=repair-v2 support，nearest 二值映射）→ `YugangRepairMaskFalloff(core,
  support, ring_fraction=0.08)`（T4c 实际接口已核对：输出 uniform_mask[0]/gray_mask[1]/
  falloff_info[2]；uniform=最终 gray>0，R1/R2/R3 共享同一可编辑支撑）。R1 = 全局 LoRA
  （同文件一次）+ SetLatentNoiseMask(uniform) + KSampler，无 DD；R2 = + DD(strength=1) +
  SetLatentNoiseMask(gray)；R3 = DD + crop 空间 pipe（Prompt→LoRA 两槽不因同文件合并→
  Mask(region_mask=owner_*_crop)→Finalize）+ `YugangRSMaskedImg2Img`（全新无 pose MODEL、
  latent=VAEEncode+SetLatentNoiseMask(gray)、noise_mask=gray、denoise 实传、768²）。
  **R3 output0 已是 IMAGE（节点内 vae.decode）→ 直接 Stitch；仅 R1/R2 走 VAEDecode**。
  主输出 = 贴回后的父画布 **1024×768**（expected_width/height），内部修复 crop 画布 768²
  （记在 structure_provenance.repair_crop_canvas）。元数据：transform_json + **falloff_info**
  （study_metadata 节点为此加了 optional 输入，向后兼容）+ R3 generation_info。
  **R 依赖硬门**：`inputs/repair-v2/repair_index.json`（schema
  `yugang.anima-interaction-v1.structure.repair_index`，core_32 全部条目、实字节 sha）与
  Falloff 节点源必须真实存在；缺则 R 行**明确拒构**（manifest 行 graph_path=null +
  build_blocked 原因，counts.r_blocked 列明细），绝不偷退旧全身域；B/H/W/pose_grid/W-S
  不被 R 缺项阻断（ok=true + r_blocked）。核验实现在 `repair.ts`。
- **P1/P2**：父图 VAEEncode → core LoraLoader 链（P1 唯一 (文件,权重) 各一次；P2 逐角色链式，
  QG 同文件出现两次）→ KSampler(denoise=0.25, stage=pass seed)。**P-DC 复用只在 exact
  graph_hash 相等时发生；当前实现里 job_id 内嵌于 filename_prefix/upload target，P1/P2 字节
  必不同 → 复用 0、保留上限 16 全 new**（符合 spec new_max 语义，不再优化）。
- **元数据**：`YugangStudyMetadata`（`experiments/anima-interaction-v1/custom_nodes/
  yugang_study_support/`，非采样 OUTPUT 节点）把 RS sampler generation_info（output 3）/
  Pose3D scene_info（output 4）/ glue transform_json（output 3）以 `ui.study_metadata`
  字符串列表交给 /history；runner 从 history 保存原文，不从进度日志猜。W-S/P 图无字符串
  元数据源，metadata_node_ids=[]（如实，不放假节点）。

## 当前状态与剩余缺项（2026-11-11 T3c 收口）

已落盘（真实构建，非声明）：
- `run-root/manifest.json`（896 行）+ `graphs/**`（808 图）：**旧 revision 草稿，保留审计、不覆盖**。
  其中 R 组 200 图仍是旧接口（ThresholdMask(native gray)、R3 误接 VAEDecode、expected 768²、
  source.path repo-root 相对）——T3c 修复后**未重建**（dispatch 明令：修复域/图变化需新 revision，
  待 T2c repair_index 就绪后另派真实 build 产当前 revision）；
- `run-root/stages/w-s-smoke/`（首批 4 图 W-S@seed 20261111@w0.8 + 子 manifest，job_id/graph
  bytes 与全矩阵一致，T3c 未触碰、hash 复核通过）；
- `checks/build-*.json` 每次 build 的机械报告；
- T3c 修复后的代码：`graphs.ts`（R 新管线 + R3 IMAGE 直连 Stitch）、`build.ts`（R 行 build_blocked
  语义、expected=1024×768、source.path run-root 相对）、`repair.ts`（repair-v2/Falloff 硬门）、
  `study_metadata.py`（falloff_info optional 输入，py_compile 通过）；
- dry-run 验证：608 非 R new 图构建通过，R 200 行明确拒构（缺 repair_index，不回退旧全身域），
  88 reuse 行保留，B/H/W/WS 不受阻。

剩余缺项（非本模块可闭合）：
1. **T2c `inputs/repair-v2/repair_index.json` 未落盘**：R 组 200 行（R_calib 72 + R_repeat 128）
   当前拒构（counts.r_blocked 列明细）。T4c `YugangRepairMaskFalloff` 源与注册已就绪
   （repair_mask_falloff.py + __init__.py，接口已逐字段核对：core/support/ring_fraction →
   uniform_mask[0]/gray_mask[1]/falloff_info[2]）。T2c 就绪后另派真实 build（新 revision）。
2. **隔离实例未 boot**（preflight unclosed#4）：图未经 `/object_info` 核对，
   `YugangRSMaskedImg2Img`/`YugangMaskCropTransform`/`YugangRepairMaskFalloff`/`YugangStudyMetadata`
   注册未运行时验证；纯净 RS+T4 patch+Crop+KJ 未装（unclosed#2/#3，T0b 进行中）。
   **任何 GPU 提交前必须先过这道核验**。
3. `preflight.execution.coreCommit` 尚未由 T0b 落盘（manifest 已按主会话裁定值 2c75dc1b 记录并注明来源）。
4. w-s-smoke 子 manifest 与全量 manifest 的**已执行状态迁移**（吸收原图/prompt_id/图 hash）按
   主会话指示由后续整合，不在本轮造框架。
5. collect/deliver/report 依赖 T7a `interaction-study-archive.ts`（未落盘时入口如实报缺）。
6. 权重许可（preflight unclosed#5）、pip freeze（#11）仍开放，属 T0/合规记录。
