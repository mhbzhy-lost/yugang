# Anima V8（3.8B）LLLite 姿态适配器重训与验收计划

- 日期：2026-11-13
- 状态：**v3（执行期修订）**；主人已选 **主会话串行执行**。**Phase 0 已完成**（补丁+完整加载验证 V8=52/2B=28，fail-closed 零缺失）；Phase 1 环境/模型就绪；**数据集已下载**（12GB / 8 TAR 分片齐全，经主人代理 `127.0.0.1:7897` 走真实 huggingface.co、不换镜像）；**Phase 1 全部完成**：官方 prepare 校验 30300 文件 SHA256 通过，split_counts train 10080/val 10/test 10，分桶 TOML 绝对路径、train/test 隔离。**G-TRAIN 已授权执行**：停 lab+prod，GPU 余 ~27GB（足够训练）；prod 画图后端已停（鱼暂不能画图，训后需恢复）；**Phase 2 smoke 通过**（V8 首训：loss 0.136→0.079、权重 v2 block_count=52、配方全对、无 NaN/OOM）；**Phase 4 全量训练已启动**（8000 步、每 1000 步存档＋采样、预计 ~2.5–3h；nohup  detach，SSH 断不影响）
- v3 修订：执行发现回填——venv 不可用（无 ensurepip / sudo 需密码）改用 miniconda3 py3.12 env；数据集改用官方 `prepare_training.py`（自动产分桶 TOML、train/test 隔离）；llm_adapter baked 实测；数据集许可 = mixed-source-artwork（已知）；WSL 训练副本 full clone cb70b96。
- 关联：`docs/HANDOFF-anima-interaction-pipeline.md`「兼容与重训事项」
- 训练/验收地点：家中 WSL（RTX 5090 D 32GB）；代码改动在 sd-scripts 训练副本，不动 yugang 生产源码
- v2 修订：按独立审阅修复 S1–S4（引号 tilde 路径、epoch 保存粒度、smoke 步数被 epochs 覆盖、Phase3 守卫必做），并纳入 9 条建议（底模受控措辞、胜率分母、推理期 multiplier 先扫、warm-start、VRAM 预算与配方偏差、bnb 风险、数据集 train/test 隔离、metadata 可判定、Phase0 验证留在 CPU 阶段）。

---

## 0. 目标与整体交付终态

**目标**：为 V8（DeltaMix 3.8B，52 块）重训 LLLite 姿态适配器，使其姿态跟随能力大概等同现有 2B（28 块）适配器，并能被 ComfyUI core 节点链加载、通过 RS 守卫。

**为什么必须重训**：现适配器 `anima_3dpose_outline_7000.safetensors` 在 2B（28 块）上训；V8 是 52 块，RS 守卫按 `block_count`/`model_dim` 硬核对直接拒。LLLite 逐块模块不能像 LoRA 那样 remap，只能重训。

**整体交付终态**（全部满足才算交付，不以单次测试通过或自报完成为准）：
1. sd-scripts 加载器支持 V8，且 2B 回归不破坏。
2. 训出合法 v2 LLLite 权重：
   - **metadata 必备 key 齐全**：`version / cond_emb_dim / cond_dim / cond_resblocks / use_aspp / aspp_dilations / mlp_dim / target_layers / target_atomics / cond_in_channels`（trainer 自动写入，`anima_train_control_net_lllite.py:669-685`）；
   - **过 RS 守卫**（`block_count=52`、`model_dim=2048`）；
   - **ComfyUI core 节点链**（`ModelPatchLoader → AnimaLLLiteApply`）在 V8 上加载成功。
3. A/B 验收：留出姿态上 V8 姿态跟随不劣于 2B（主人按 §9 协议裁定）。
4. 交付物归档：权重 + 训练配置 + 验收报告（三联对比图、胜率、客观指标）+ 可复现命令。

**非目标 / 边界**：
- 验收通过前不改 yugang 生产 draw 管线、不接 RS 生产分支。
- `drawEnabled` / G0-G1 只由主人控制；本计划不擅自腾卡（见 §5 闸门 G-TRAIN）。
- 许可：CircleStone 非商业覆盖模型/衍生；数据集为 **mixed-source-artwork**（6220 Anima 生成 + 3860 Danbooru 衍生，上游版权/条款仍适用，见 `docs/SOURCES.md`），归档/再分发前复核条款（§10）。

---

## 1. 已核实事实（取证基础，全部真实来源）

| 事实 | 结论 | 来源 |
|---|---|---|
| V8 与 2B 架构 | 同 Anima(MiniTrainDIT)；**除 `num_blocks` 外 config 完全一致** | V8 checkpoint 形状逐项核实（WSL） |
| V8 config | `num_blocks=52`、`model_channels=2048`、`num_heads=16`（q_norm[128]→head_dim128）、`crossattn_emb_channels=1024`、`adaln_lora_dim=256`、in/out_channels=16、patch_spatial=2、llm_adapter 6 块 dim1024 | WSL safetensors header |
| 加载器 | `library/anima_utils.py:85` 写死 `num_blocks=28`；**全库无可用 Anima config 自动探测**——`anima_models.py:1563-1571` 的 `get_dit_config` 被注释，且按 `model_channels` 映射（2048→28、5120→36、1280→20），2B/V8 同为 2048 无法区分；加载 fail-closed（missing/unexpected 直接 raise，line 140-156） | 本地 clone 读取 |
| LLLite 训练器 | `anima_train_control_net_lllite.py:476` 调 `load_anima_model`；DiT 全冻结只训 LLLite；`named_modules()` 动态扫描深度无关 | 本地读取 |
| 模型文件 | 齐备（执行期复核 5 文件全在）：DiT/Qwen3/VAE/2B DiT/2B 适配器在 WSL；**llm_adapter baked 进 DiT 实测**（118 keys = 6 blocks + embed/norm/out_proj，V8/2B 一致；raw 键带 `model.diffusion_model.` 前缀，`--llm_adapter_path` 可省）；T5 tokenizer 用仓库自带 `configs/t5_old/` | WSL ls + safetensors header 实测 |
| 数据集 | `toyxyz/boorupose_outline_10k`（10080 训 + 10 验 + 10 测）；**8 TAR 分片 ~12.48GB**，官方 `prepare_training.py` 校验 SHA256 并解压、自动产按分辨率分桶的 `dataset_train/validation/test.toml`（train/test 天然隔离）；分辨率 ≤1024² 像素 / 长边 ≤1536 / 16 倍数（非全固定 1024²）；许可 mixed-source-artwork | HF README + prepare_training.py 实读 |
| 2B 配方 | cond_dim=128、cond_emb_dim=64、cond_resblocks=4、mlp_dim=64、use_aspp=true(1,2,4,8)、target_atomics=self_attn_q_pre,self_attn_kv_pre、cond_in_channels=3、version=2、1024²、sd-scripts commit 690ea7f、文件名示 ~7000 步 | **仅 WSL 权重 metadata**（本地 `anima_3dpose_outline_7000.{md,training.json}` 是 404 残片，不作来源） |
| 环境 | WSL 5090 D 32GB（现 ~20.6GB 被 prod+lab 占）；venv 不可用→**miniconda3 py3.12.16 env 已建**；**torch 2.11.0+cu128 已装、CUDA 可用**；requirements 已装（accelerate 1.15.0 / transformers 5.17.0 / diffusers 0.40.0 / bnb 0.50.2 / safetensors 0.8.0；huggingface-hub 被 requirements 降到 1.32.0） | WSL 实测 |
| 限制 | 不支持 blocks_to_swap/cpu_offload/deepspeed/fused_backward_pass（VRAM 须整装下）；T=1；bucket 步长16；cond HW=latent×8 | 训练文档 §8 |
| Clone | 本地研究 `~/anima-research/sd-scripts` 为 shallow；**WSL 训练副本 full clone**（`$HOME/anima-v8-train/sd-scripts`，HEAD `cb70b96`，`configs/qwen3_06b`+`t5_old` 已核在）；切 `690ea7f` 前须现场核对 | git log 实测 |
| 社区现成产物（执行前核查） | **无 V8/52块 LLLite 姿态适配器**：toyxyz 三个适配器均 51.1MB（outline_7000 实测 header `block_count=28`）；官方 Comfy-Org/kohya-ss `anima-lllite-pose-1` 实测 header `block_count=28`（小配方 cond_dim32/mlp32/resblocks3/无ASPP，2026-04-27）；HF 搜 DeltaMix/3.8b/v8/52/3dpose 只有底模/量化/角色微调，无 52块控制适配器。**重训确属必要，非重复社区劳动** | HF API + safetensors header 实测（2026-11-13） |

**关键推论**：Phase 0 实质 = 让加载器拿到 `num_blocks=52`（其余参数已核实一致，靠 fail-closed 校验兜底）。这是有界小改动，不是研究未知。

---

## 2. 文件职责与依赖关系

**sd-scripts 训练副本（WSL `$HOME/anima-v8-train/sd-scripts`）**
- `library/anima_utils.py` — **Phase 0 唯一代码改动点**（`load_anima_model` 的 `num_blocks` 自动探测）。推理与 LoRA 训练同走此函数，一处补丁全受益。
- `anima_train_control_net_lllite.py` — 训练入口（不改）。
- `anima_minimal_inference_control_net_lllite.py` — 快速出图（不改；**不经过 ComfyUI/RS 守卫**，仅用于 smoke/初筛，不作验收主通道）。
- `networks/control_net_lllite_anima.py` — LLLite 架构（不改，深度无关）。
- `configs/qwen3_06b/`、`configs/t5_old/` — 自带 tokenizer/config（full clone 必须包含）。

**数据 / 输出目录（WSL）**：`$HOME/anima-v8-train/{venv,sd-scripts,dataset_release,dataset,out,logs,accept}`。

**验收对照**：2B 适配器（WSL `~/anima-prod/ComfyUI/models/model_patches/rs_reference/anima_pose/anima_3dpose_outline_7000.safetensors`）vs V8 新权重。

**依赖链**：
```
Phase0(加载器+CPU验证) ─┐
Phase1(环境/数据)      ┴→ Phase2(smoke) → Phase3(权重验证) → Phase4(全量) → Phase5(A/B验收)
                          ↑ 闸门 G-TRAIN（主人拍板腾卡）在 Phase2 前
```
- Phase 0 / Phase 1 是 CPU/网络工作，**不需 GPU、不需等腾卡**，可先行；Phase 0 的加载验证只依赖 Phase 1 conda env，**留在 CPU 阶段做，不拖到 G-TRAIN 之后**。
- Phase 2–5 需 GPU，受 G-TRAIN 闸门约束。

---

## 3. Phase 0 — 加载器支持 V8（关键前置）

**改动文件**：`library/anima_utils.py` 的 `load_anima_model`。

**方案**：从 checkpoint 自动探测 `num_blocks`（而非写死 52），同时兼容 2B/V8 及未来深度：
1. 建模型前先 peek safetensors header 拿 keys（只读 header，不加载权重；纯文件 IO，与 `init_empty_weights`/权重加载无冲突）。
2. 剥前缀（`model.diffusion_model.` / `net.`，与 `rename_hook` 一致），**锚定 `re.match(r"blocks\.(\d+)\.")`** 取最大索引 +1 = `num_blocks`（锚定开头可排除 `llm_adapter.blocks.*` 的 6 个块——这是探测的关键陷阱）。
3. `dit_config["num_blocks"] = 探测值`；其余参数保持不变（已逐项核实与 V8 一致）。
4. 保留现有 fail-closed `load_state_dict` 严格校验兜底。

**补丁示意**（执行时按现场代码微调）：
```python
import json, struct, re
def _detect_num_blocks(dit_path):
    with open(dit_path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        hdr = json.loads(f.read(n))
    idx = set()
    for k in hdr:
        if k == "__metadata__": continue
        kk = k
        for pre in ("model.diffusion_model.", "net."):
            if kk.startswith(pre): kk = kk[len(pre):]
        m = re.match(r"blocks\.(\d+)\.", kk)   # 锚定开头，排除 llm_adapter.blocks.*
        if m: idx.add(int(m.group(1)))
    if not idx: raise RuntimeError("无法从 checkpoint 探测 num_blocks")
    return max(idx) + 1
# dit_config["num_blocks"] = _detect_num_blocks(dit_path)  # 替换写死的 28
```

**验收**：V8 加载无 missing/unexpected、`num_blocks=52`；2B 回归加载 `num_blocks=28` 无报错。

**✅ 已完成（2026-11-13 实测）**：补丁落地后完整加载 V8（1165 tensors）与 2B（685 tensors），均 `unexpected missing keys: 0, unexpected keys: 0`（fail-closed 严格校验通过），`num_blocks` 分别 52/28。**关键前置解除。**

**验证命令**（WSL，sd-scripts venv，**纯 CPU，在 Phase0/1 做**；CPU 加载较重，逐个加载及时释放）：
```bash
cd "$HOME/anima-v8-train/sd-scripts"
"$HOME/anima-v8-train/venv/bin/python" - <<'PY'
import os
from library import anima_utils
M=os.path.expanduser("~/anima-prod/ComfyUI/models/diffusion_models/")
for name,fn,expect in [("V8","DeltaMix 3.8B V8.safetensors",52),("2B","oneObsessionAnima_v40.safetensors",28)]:
    m=anima_utils.load_anima_model("cpu",M+fn,"torch",False,"cpu",dit_weight_dtype=None)
    assert m.num_blocks==expect, f"{name}: {m.num_blocks}!={expect}"
    print(name,"num_blocks",m.num_blocks,"OK"); del m
PY
```

---

## 4. Phase 1 — 环境与资产（WSL，无需 GPU）

> **路径纪律（S1）**：sd-scripts 全库无 `expanduser`，bash 双引号内 `~` 不展开、TOML 字符串是纯字面量。**所有路径一律 `$HOME`（bash 双引号内可展开）或绝对路径**；TOML 用下面 heredoc 生成让 `$HOME` 在写入时展开。

1. **full clone sd-scripts**（真实地址 `https://github.com/kohya-ss/sd-scripts`）到 `$HOME/anima-v8-train/sd-scripts`。默认用 main（调研 HEAD `cb70b96`）；如需严格复刻 2B 切 `690ea7f`，**因本地是 shallow，切前须 `git fetch` 相 commit 并现场核对 Phase0 补丁仍适用**。确认 `configs/qwen3_06b/`、`configs/t5_old/` 在。
2. **conda env + torch**（venv 不可用：无 ensurepip 且 sudo 需密码；用已有 miniconda3，base py3.14 过新故建独立 py3.12）：
   ```bash
   ~/miniconda3/bin/conda create -p "$HOME/anima-v8-train/venv" python=3.12 -y
   P="$HOME/anima-v8-train/venv/bin/python"
   "$P" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
   "$P" -m pip install -r requirements.txt
   ```
   **bnb 兼容验证**：`AdamW8bit` 依赖 bitsandbytes，requirements 未钉版本；sm_120/CUDA12.8 下须 `python -c "import bitsandbytes"` + 小规模优化器 step 验证，不行则备选 `AdamW`（§10）。
3. **核对模型文件** ✅ 已做：5 文件全在；V8 llm_adapter baked 实测（118 keys，带 `model.diffusion_model.` 前缀），`--llm_adapter_path` 可省。
4. **下数据集**（真实 HF 地址 `https://huggingface.co/datasets/toyxyz/boorupose_outline_10k`；8 TAR 分片 ~12.48GB，下载+解压需 ~35GB 磁盘）。**WSL 无法直连 HF（GFW：DNS 污染成 IPv6 假址、IPv4 超时）；经主人提供的代理 `http://127.0.0.1:7897` 下载，URL 仍是真实 huggingface.co、不换镜像**（命令前置 `export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897`，已实测该代理到真实 HF API 返回 200/0.49s）：
   ```bash
   "$HOME/anima-v8-train/venv/bin/hf" download toyxyz/boorupose_outline_10k --repo-type dataset \
     --local-dir "$HOME/anima-v8-train/dataset_release"
   ```
5. **官方 prepare_training.py 制备**（不手写 TOML）：校验档案+解压文件 SHA256、安全解压、**自动产按分辨率分桶的 `dataset_train.toml` / `dataset_validation.toml` / `dataset_test.toml`**（`enable_bucket=false`，每 WxH 一个 `[[datasets]]`，`image_dir=<split>/<WxH>/target`、`conditioning_data_dir=<split>/<WxH>/condition`），train/test 天然隔离；另产 `dataset.toml`（train-only 别名）与 `preparation_receipt.json`：
   ```bash
   "$HOME/anima-v8-train/venv/bin/python" "$HOME/anima-v8-train/dataset_release/prepare_training.py" \
     --output "$HOME/anima-v8-train/dataset" --batch-size 1 --caption-dropout 0.0
   ```
   **核对清单**：receipt `split_counts` = train 10080 / validation 10 / test 10；训练用 `dataset/dataset_train.toml`；10 个 test 姿态在 `dataset/test/`（§9 留出集从此取，严禁混入训练）。

**验证 ✅ 全部通过（2026-11-13）**：torch 2.11.0+cu128 CUDA 可用（5090）；bnb AdamW8bit step 通过；`preparation_receipt.json` split_counts = train 10080 / val 10 / test 10，verified_files=30300（SHA256 全校验）；dataset_train.toml 绝对路径、分桶、train/test 隔离；模型文件 5 个齐。**Phase 0/1 完成。**

---

## 5. Phase 2 — Smoke（小子集，验机制）

**闸门 G-TRAIN（前置，主人拍板）**：训练要腾 GPU。**粗预算**：3.8B bf16 冻结权重 ≈7.6GB + LLLite(fp32) + 激活(gradient_checkpointing) + 优化器，估总 ~16–24GB；现 prod+lab 占 ~20GB，**大概率需至少停 lab、可能连 prod**。停哪个 / `drawEnabled` 是否关，**由主人决定**，本计划不擅自操作。未获准不进 Phase2。

- 取 ~50–100 对子集：从制备好的 `dataset/train/<WxH>/{target,condition}` + 同名 `.txt` 拷入子集目录，按 prepare 脚本的分分辨率格式写小 TOML；复刻 2B 配方（§8）指向 V8，跑 ~100 步。
- **smoke 命令必须删 `--max_train_epochs`**（S3：trainer `epochs` 无条件覆盖 `steps`，`anima_train_control_net_lllite.py:544-548`）；用 `--max_train_steps=100`。
- **机械检查**：载 52 块；loss 下降；无 NaN；**VRAM 峰值 < 闸门后可用显存**；存出 v2 权重且 metadata 必备 key 齐全（§0）。
- **VRAM 降级梯**（若 OOM，因无 offload，逐级试并记录峰值；**batch 已是 1，降 batch 是 no-op，跳过**）：
  1. `--full_bf16`（**注意：会把 LLLite 本体也切 bf16，偏离 2B 的 fp32-LLLite 配方**）；
  2. 降 resolution（1024→896→768，bucket 步长16，**偏离 1024² 配方**）；
  3. 降 `--lllite_mlp_dim`/`--cond_emb_dim`（容量偏差）。
  **凡降级都记录为配方偏差，供 §9 A/B 解读**（偏差可能影响与 2B 的可比性）。

**验证命令**：§8 命令去掉 `--max_train_epochs`、改 `--max_train_steps=100` + 子集 TOML；训后跑权重检查（§6）。

**✅ 已通过（2026-11-13）**：64 对子集 100 步，SMOKE_EXIT=0；载 52 块零缺失；avr_loss 0.136→0.079；无 NaN/OOM（~27GB 空闲）；~1.14s/步@1024²；存权重 183MB，metadata 实测 version=2、block indices 0..51（52 块）、cond_dim128/emb64/resblocks4/mlp64/ASPP/QKV 全对、fp32。**V8 训练机制完全验证。**

---

## 6. Phase 3 — 权重验证（ComfyUI core 必做，S4）

> **节点辨析**：验收主通道是 **ComfyUI core** 的 `ModelPatchLoader → AnimaLLLiteApply`（`comfy_extras.nodes_model_patch`，RS 守卫 `anima_pose_control.py:14` 只认 `comfy.ldm.anima.lllite` 的 patch 类）。**不要**误用 kohya 自定义节点 `AnimaLLLiteApply_sdscripts`（`ComfyUI-Anima-LLLite/nodes.py:282`，走 `model_function_wrapper`，不产生守卫要求的 patches 结构，必被拒）。

**必做项**：
1. 权重放入 WSL ComfyUI `models/model_patches/`。
2. core 节点链 `ModelPatchLoader + AnimaLLLiteApply` 挂 V8，**RS 守卫核对 `block_count=52`、`model_dim=2048` 须过**（守卫要求四类 patch 组齐全、targets 固定，`anima_pose_control.py:16-31`）。
3. **WSL 侧核对**：core LLLite 加载器是否深度无关（`adapter.block_count/model_dim` 从何派生，core 源码不在本地）；2B QKV-only 适配器生产已过守卫，推断 core 对 QKV-only 权重也注册完整 patch 组，**V8 上须实测确认**。
4. **metadata 必备 key 齐全**（§0 清单）。
5. 出 1 张姿态条件图确认能生成。

**快速出图（仅初筛，不作验收通过依据）**：`anima_minimal_inference_control_net_lllite.py`（不经过守卫）：
```bash
python anima_minimal_inference_control_net_lllite.py \
  --dit "$HOME/anima-prod/ComfyUI/models/diffusion_models/DeltaMix 3.8B V8.safetensors" \
  --vae "$HOME/anima-prod/ComfyUI/models/vae/qwen_image_vae.safetensors" \
  --text_encoder "$HOME/anima-prod/ComfyUI/models/text_encoders/qwen_3_06b_base.safetensors" \
  --lllite_weights "$HOME/anima-v8-train/out/<name>-last.safetensors" \
  --control_image "<测试姿态.png>" --prompt "1girl, standing" \
  --image_size 1024 1024 --infer_steps 30 --guidance_scale 3.5 \
  --save_path "$HOME/anima-v8-train/accept/"
```
**通过判据 = core 节点链加载 + 守卫过 + 出图**（minimal inference 只辅助，不能替代守卫）。

---

## 7. Phase 4 — 全量训练

- 全 10080 对，复刻 2B 配方（§8）。**保存/采样用 step 粒度**（S2：batch=1 时每 epoch=10080 步，epoch 级保存第一个 checkpoint 在 10080 步，够不到 2B ~7000 步参考、看不到 emergence）：
  - `--save_every_n_steps=1000`、`--sample_every_n_steps=500`、`--save_last_n_steps=6`（控盘）；
  - `--max_train_epochs=10` 仅作上限；参考 2B ~7000 步量级，**以采样观察姿态跟随收敛挑最优 checkpoint**（docs §3.2：线画跟随第 1 个 epoch 内就出现），不盲跑满。
- 长任务用 `nohup`/`bash_async`，日志落 `$HOME/anima-v8-train/logs`。
- 采样 `prompts.txt` 每行带 `--cn <姿态图>`，`--sample_at_first`，观察 emergence。

---

## 8. 训练配方（2B metadata → V8 flag，完整命令）

> 路径一律 `$HOME`（双引号内展开）；**smoke 变体 = 本命令去掉 `--max_train_epochs`、改 `--max_train_steps=100` + 子集 TOML**（S3）。

```bash
accelerate launch --num_cpu_threads_per_process 1 anima_train_control_net_lllite.py \
  --pretrained_model_name_or_path="$HOME/anima-prod/ComfyUI/models/diffusion_models/DeltaMix 3.8B V8.safetensors" \
  --qwen3="$HOME/anima-prod/ComfyUI/models/text_encoders/qwen_3_06b_base.safetensors" \
  --vae="$HOME/anima-prod/ComfyUI/models/vae/qwen_image_vae.safetensors" \
  --dataset_config="$HOME/anima-v8-train/dataset/dataset_train.toml" \
  --output_dir="$HOME/anima-v8-train/out" --output_name="anima_v8_3dpose" \
  --save_model_as=safetensors \
  --cond_emb_dim=64 --lllite_cond_dim=128 --lllite_cond_resblocks=4 \
  --lllite_use_aspp --lllite_mlp_dim=64 \
  --lllite_target_layers=self_attn_qkv --attn_mode torch \
  --learning_rate=1e-4 --optimizer_type="AdamW8bit" --lr_scheduler="constant" \
  --timestep_sampling="shift" --discrete_flow_shift=3.0 \
  --max_train_epochs=10 \
  --save_every_n_steps=1000 --sample_every_n_steps=500 --save_last_n_steps=6 \
  --mixed_precision="bf16" --gradient_checkpointing \
  --cache_latents --cache_text_encoder_outputs \
  --vae_chunk_size=64 --vae_disable_cache
```
- 映射：cond_dim128→`--lllite_cond_dim=128`；cond_emb64→`--cond_emb_dim=64`（共享嵌入宽度，与 trunk 宽度独立）；resblocks4→`--lllite_cond_resblocks=4`；ASPP→`--lllite_use_aspp`（默认 dilations 1,2,4,8 与 2B 一致）；mlp64→`--lllite_mlp_dim=64`；Q+K+V→`--lllite_target_layers=self_attn_qkv`（≡`self_attn_q_pre,self_attn_kv_pre`）。
- `lr=1e-4` 为文档推荐起点（2B metadata 未含 lr）；`--llm_adapter_path`/`--t5_tokenizer_path` 省略（DiT 内置 + 仓库自带）。
- **`--attn_mode torch` 必传**：trainer 默认 `attn_mode=None`，主入口只把 `sdpa→torch`、不处理 `None`，attention 前向会拒 `None`（smoke 首跑实测踩坑，已加此 flag 修复）。

---

## 9. Phase 5 — A/B 验收协议（主人裁定，对照实验）

**支点**：只有单一变量受控，主人的判断才能归因到某个旋钮。

- **锚点 = 应有姿态**（条件图，3D 人体那张），唯一参照。
- **阶段1 验收（2B vs V8）的底模说明**：A=2B 底模+2B 适配器、B=V8 底模+V8 适配器，**底模必然不同——这正是实验目的**。明文约定：**底模差异是受控对比的一部分，评判只针对姿态贴合度、不评画风**。
- **受控变量清单**（除被试变量外全部固定）：prompt、seed、分辨率、条件姿态、**LLLite multiplier、sigma 窗口(start/end percent)、infer_steps、guidance_scale、flow_shift**。
  - **A/B 出图走 ComfyUI core 节点**（`ModelPatchLoader+AnimaLLLiteApply`），以便固定 multiplier/窗口并对齐生产（HANDOFF 管线 v1：LLLite 0.8、窗口 0–0.7）；minimal inference 默认 flow_shift=5.0 且无 start/end percent 参数，**不作 A/B 主出图通道**。
- **多留出姿态**：用数据集 10 个 test 姿态（Phase1 已隔离），每张出「锚点 + A + B」，累计胜率。
- **胜率定义**：`wins/(wins+losses)`，**平局另计**（不进分母）；盲测 + 随机左右，判完揭晓。
- **客观交叉**：姿态估计器（DWPose 一类，anime 域先验证可用）对生成图提姿态、与条件姿态算关键点误差（PCK/OKS），与主观对照；一致高置信，打架就查；不可用则退化纯人眼三联对比。
- **调参优先级（零成本先行）**：
  1. **先做推理期 `--lllite_multiplier`（ComfyUI 节点 multiplier）扫描**——零训练成本，先排除「只是强度没调好」；
  2. 再谈重训；**调参轮用 `--network_weights <prev.safetensors>` 热启动**（trainer:255），不必每轮全量重训 10080 对。
- **阶段2 调参**：A=V8 配置甲、B=V8 配置乙 → 逐旋钮逼近。
- **症状→旋钮映射**（主人描述症状，我归因调参）：

| 症状 | 失效模式 | 调参方向（先零成本后重训） |
|---|---|---|
| 姿势没跟上 | 条件太弱 | 先 ↑推理 multiplier；再 ↑cond_dim/注入目标/epoch |
| 姿势对但画面崩、油 | 条件太强压底模 | 先 ↓推理 multiplier；再 ↓lr |
| 大动作对、细节错 | 条件细节/感受野不足 | 分辨率 / ASPP / 训练量 |
| 换姿势就不行 | 过拟合 | ↓epoch / 加数据多样性 |

- **通过阈值（建议，主人最终裁定）**：V8 对 2B 胜率 ≥40%（wins/(wins+losses)）且无灾难性失效（姿态完全脱靶）。
- **迭代预算**：调参 1–3 轮；每轮「我提改动→（热启动）重训→重测→给主人看」。三联图归档 `$HOME/anima-v8-train/accept/`。

---

## 10. 风险与应对

| 风险 | 应对 |
|---|---|
| VRAM OOM（无 offload） | §5 降级梯（batch 已 1 跳过）；记录配方偏差；峰值<闸门后可用显存 |
| bitsandbytes 兼容 | ✅ 已验证：bnb 0.50.2 在 5090(sm_120) 真实 `AdamW8bit` step 通过，无需降级 AdamW |
| config 不匹配 | fail-closed 自动 raise；Phase0 逐项核对 |
| 质量不及 2B | §9 调参迭代（先推理 multiplier 扫描，再热启动重训，1–3 轮） |
| GPU 争卡 | G-TRAIN 主人闸门 + 粗预算，不擅自腾卡 |
| 许可 | CircleStone 非商业覆盖模型/衍生；数据集 = mixed-source-artwork（已知，`docs/SOURCES.md`），归档/再分发前复核上游条款 |
| 姿态估计器 anime 域不准 | 先验证，不行退化纯人眼三联对比 |
| 5090 torch 兼容 | sm_120 需 CUDA12.8+ torch，Phase1 验证 |
| VRAM 降级偏离 2B 配方 | full_bf16/降分辨率/降容量均记录为偏差，供 A/B 解读 |
| 切旧 commit 690ea7f | 本地 shallow，切前 fetch + 现场核对补丁适用 |

---

## 11. 验证命令汇总

- Phase0：§3 加载断言（V8=52 / 2B=28，纯 CPU）。
- Phase1：`torch.cuda.is_available()` + 5090；bnb 可用；数据集对数=10080、caption 配对、test 隔离；模型文件存在。
- Phase2：smoke（`--max_train_steps=100`，无 epochs）+ loss/NaN/VRAM/metadata 检查。
- Phase3：ComfyUI core 节点链加载 + RS 守卫（block_count=52 / dim2048）+ 出图 + metadata key。
- Phase4：全量训练日志 + step 级采样图。
- Phase5：§9 三联对比 + 胜率(wins/(wins+losses)) + 客观指标，主人裁定。

---

## 12. 执行方式（主人已选：主会话串行执行）

- 主人已选 **主会话串行执行**（2026-11-13）；Phase 0/1（CPU/网络）进行中，G-TRAIN 腾卡在 Phase2 前等主人拍板。
- 每阶段满足验收才进下一阶段；未达交付终态持续「修复→验证→对照终态」；执行期发现（conda 替代 venv、官方 prepare 脚本、数据集许可等）实时回填本计划。