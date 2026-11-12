# HANDOFF — Anima 交互管线（2026-11-13）

## 当前状态（已上线）

- **生产 ComfyUI 在 WSL**：`~/anima-prod`（端口 8188，单 GPU 串行；Windows 生产已停）。
  节点全注册：`YugangRSMaskedImg2Img`、`YugangStudyCameraProject`、`YugangRSSceneImg2Img`、`YugangStudyMetadata`。
  模型：`~/anima-prod/ComfyUI/models/{checkpoints,diffusion_models,unet,text_encoders,vae,loras,upscale_models,model_patches}`（UNETLoader 走 `diffusion_models`，不是 `checkpoints`）。
  2B = oneObsessionAnima_v40；V8 = DeltaMix 3.8B V8；qwen_3_06b_base / qwen_image_vae；姿态 patch 在 `model_patches/rs_reference/anima_pose/`。
- **实验实例在 WSL**：`~/anima-lab`（端口 8189，含全部守卫补丁与 noise_mask）。
- **鱼已部署**：mini pid **70349**（main 545ca18，含交互管线与 drawEnabled 热开关），draw 工具新增 `pipeline` / `preset` 参数，默认 RS 不变。
- **管线 v1 定稿**：CPU authoring（MHR FK 解接触世界 + 相机投影）→ B1 初采样（RS 装配 + LLLite 0.8/0–0.7 + LoRA 1.0 + 矩形框）→ AnimeSharp 超分 → **质感 pass 在最后 @2x 域**（scene img2img denoise 0.25 + 区域 pipe + 外部姿态 patch，Project 基础画布渲染姿态 + ImageScaleBy×2 规避 RS 2048 mask 上限）。
  单人 = 轻形态（KSampler + 链式 LoRA + LLLite，**无 RS**（不吃 N×N 偏置矩阵开销））。
- **负向**：`low quality, worst quality, score_1, score_2, score_3, early, old, shiny skin`（monochrome/lips 已删）。
- **drawEnabled=true 已恢复**（2026-11-13 主人发话放开，config 热切换不重启）；后续让出 GPU 仍只由主人指令原子切换。
- npm test 174/174 全绿；prompts 扫描干净。
- 采样总账 **275 次扩散**（旧线 217 + scene-v2 12 + finish-v3 8 + run2 3 + orderB 1 + 管线验证 2 + 3x 2 + 单人 2 + 生产 2 + 3x-passlast 2 + 计时 2）。

## 关键资产位置

| 物 | 位置 |
|---|---|
| 管线规格 | `experiments/anima-interaction-extension-v1/PIPELINE-V1.md` |
| RS 分叉（唯一事实源） | `/Users/leshi.zhy/comfyui-nodes/comfyui-rs-multicharacter-sampler/`（节点库，独立于鱼缸仓库；部署=整目录复制到 custom_nodes） |
| 自定义节点包 | `/Users/leshi.zhy/comfyui-nodes/{yugang_composition,yugang_interaction,yugang_study_support}/`（鱼缸仓库不保留节点源码） |
| 交互模板 | `src/tools/draw/workflow-interaction.json`（26 节点，含 pose ImageScaleBy×2） |
| 预设注册表 | `src/tools/draw/interaction-presets.json`（sit-haystack / single-haystack） |
| 离线 authoring | `experiments/anima-interaction-extension-v1/{contacts.py,geometry.py,run2-author.py,sit-author.py,single-author.py}`（scipy/MHR，在 Windows/WSL 嵌入式或系统 python 上跑） |
| 主人视觉判定账本 | `var/local-driver/anima-interaction-extension-v1/user-feedback.jsonl` + `.../stages/full-execution-v4/user-feedback.jsonl` + `.../pruned-core18-20261112/user-decisions.json` |
| 总结论表 | `Downloads/yugang-ab/47-Anima2B-双人交互-实时回收-20261112/RESEARCH-CONCLUSIONS.md` |
| 本次上线验证图 | `Downloads/yugang-ab/61-Anima2B-联合接触与镜头约束-20261112/生产上线-草垛/` |

## 后续任务（按优先级）

### 1. `RSMultiCharacterInteraction` 采样时间分层验证（1–2 次扩散）
- 原理（已读源码）：RS 自注意力分离有 hold_decay 时间表（hold 3 步后每步 −0.2，~第 8 步归零）；Interaction 节点只把**单人专属 cell** 的分离保持期 +3/+6 步，重叠区与背景不变。对症“中后期身份互染”（鲸尾长对方身上/一方特征丢失）。
- 设计：同 seed 同图单变量 A/B。基线已付费（DC-RUN2 direct 或 DC-HUG-M B1）。插 `RSMultiCharacterInteraction(delay6)` 到 building_pipe 链（Position→Interaction→Finalize）。
- 主人判：鲸尾/发花/发色归属是否改善。有效则纳入 v1 初采样；无效则记录出局。不改善朝向/背景/QG 同文件（那些另有专项）。

### 2. 构图按需 authoring 生产化
- 现状：`preset` 只有 sit-haystack/single-haystack 两个样例。**不是只能用草垛**——authoring 机器已验证可现做新世界（RUN2 夜湖/草垛/单人坐姿）。
- 要做：把“语义请求 → authoring → preset → makeInteractionGraph”接成生产路径（authoring 在 WSL 上以脚本/服务执行，scipy+MHR 在 lab 的 `sources/old-structure` 可用）。新姿态由主人给描述后离线编排，不允许多写死 key。
- 预设资产写入 `interaction-presets.json` 需经主人过目。

### 3. 朝向控制（新立项，结构性缺口）
- 已证：CARRY 朝向不受控、逐 case 随机落解（DC 几乎全错；QG 按景别漂移；近景概率更高但不保证）。2D 投影丢躯干朝向信息，调参不可修。
- 方向：显式朝向信号——参考图 img2img / 深度-法线通道 / 带朝向的 3D 渲染条件。属新一轮开发，不混入当前管线。

### 4. 双人身份隔离（LoRA 机制层）
- 已证：全局加载否决（跨体污染）；RS 区域更好但仍丢一方特征；权重组合无解。Interaction 节点验证（任务 1）若有效，为最便宜缓解；否则考虑身份锚点/参考图机制。

## 兼容与重训事项

### 52 层（DeltaMix 3.8B V8）
| 部件 | 状态与做法 |
|---|---|
| RS 区域装配/采样 | 可直接用（生产双人 RS 已在 V8 验证） |
| 角色 LoRA | 必须走 `AnimaLoRARemapTagLoader`（28→52 remap，生产节点在册），不能裸 LoraLoader |
| **LLLite 姿态** | **不兼容**（2B 训练的注意力注入权重，形状不匹配；AGENTS 已写死 remap≠姿态适配器兼容） |
| scene img2img 重装备 pass | 需开 V8 分支（guard 现在冻结“Anima 2B + 必须挂姿态 patch”；V8 无可用姿态 patch） |
| 推荐迁移路线 | **2B 定结构 → V8 转画风/收尾**（V8 不背姿态职责），对应原计划“先通用 masked img2img/区域模块，再 2B 定结构→V8 转画风，最后评估学习式适配器” |

### LLLite 重训（若决定让 V8 也拥有姿态条件）
- **数据公开**：`toyxyz/boorupose_outline_10k`（HF，10080 训练对 + 10 验证 + 10 测试，着色 3D 人体+互补色轮廓）。
- **方法公开**：kohya-ss/sd-scripts（LLLite 训练）+ kohya-ss/ComfyUI-Anima-LLLite（推理）。每模型训练文档 `docs/anima_3dpose_outline_7000.md` + `.training.json`。
- **许可**：CircleStone 非商业许可（衍生同约束）。
- 成本 = V8 架构是否被训练器支持 + 训练算力；不是改代码能绕过的。可作为独立训练项目评估，不与当前管线耦合。

### QG（Qwen/Grok 同 LoRA 文件）
- 同文件同权重时 RS 共享 hook，两槽无独立权重；身份区分全靠区域提示+owner 区域。隔离不足是机制问题，权重不可调。需要新的身份锚定机制（参考图/训练），不是调参能解决。

### 朝向与 V8 的关系
- 朝向缺口在 2B 已证；迁移 V8 不会自动修好（同一姿态信息丢失问题）。需要显式朝向信号（任务 3）。

## 运维约定（后续别再踩）

- **G0/G1**：`drawEnabled` 关闭只由主人控制；实验结束恢复也只看主人指令，绝不自动恢复。
- **进程**：WSL 实例用 `setsid nohup ... &` 启动；Windows 生产已退役（36932 已停）。**改节点代码后必须重启该实例**才生效（守卫生效后再跑）。
- **提交**：长任务一律后台 shell + 完成通知（harness 会叫醒主会话）；不要手搓等待链/stdin 管道（WSL↔Windows 互操作不可靠）、不要前台 sleep。
- **端口**：prod=8188（WSL）、lab=8189（WSL）、生产鱼在 mini（非本机）。`wf-run.py` 里 LAB 常量注意 8188/8189 别打错。
- **枚举**：UNETLoader 用 `diffusion_models` 目录；ModelPatchLoader 在 Linux 用正斜杠（Windows 用反斜杠）。
- **RS 上限**：3D mask 渲染 ≤2048/边，pass 姿态一律基础画布渲染 + ImageScaleBy×2，不写 scene_json_2x。
- **步数**：pass 的 steps=30 只是调度表，denoise 0.25 实际只跑尾部约 7–8 步；pass@3840 实测 824s（4K 域每步近百秒），pass@2560 实测 196s。
- **提交纪律**：未知提交不可重 POST；成功任务不重复提交；失败按简单清单单独触发。

## 参考文档
- 管线定稿：`experiments/anima-interaction-extension-v1/PIPELINE-V1.md`
- 分叉说明：`/Users/leshi.zhy/comfyui-nodes/FORK.md`
- 研究计划：`docs/plans/2026-11-11-anima-interaction-study.md`、`docs/plans/2026-11-12-anima-contact-camera-extension.md`
- 主人结论汇总：`Downloads/yugang-ab/47-…/RESEARCH-CONCLUSIONS.md`
