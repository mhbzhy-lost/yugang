# Regional LLLite 3.8B 训练数据管线

单人位置控制（placement）的硬条件路线：自训 3.8B（DeltaMix V8，52 层）Regional LLLite
adapter，输入纯色人形区域图硬约束人物位置。方案与实验依据见
`docs/plans/2026-11-15-regional-38b-training.md` 与 `docs/plans/2026-11-15-single-pose-placement.md`
（E5–E9/E20 证死全部软引导后的唯一出路）。

## 当前进度（2026-11-16）

- **姿态打标完成**：1199 条，有效 1157（96.5%），产物 `data/pose-tags-raw.json`
- **训练对构造完成**：412 姿态 × 4 随机变体 → 掩码校验滤除出界 → **1464 对**，
  配方 `data/manifest.json`（`random.seed(20261115)` 确定性可复现）
- **GPU 对照图生成完成**：1464/1464，fail=0（`gen-runner.py`，~20s/张）
- **v1 训练完成但数据错位**：8000 步 loss 平台 ~0.136（v8 对齐数据降到 0.0895），
  产物归档 WSL `out-v1/`。根因见下「v2 对齐修正」
- **v2 修正训练**：control 改从 target 实际人物分割导出（`segment-controls.py`），
  target/caption 复用，重训 8000 步（`train-v2.sh`，输出 `anima_regional_38b_v2`）

## v2 对齐修正（关键教训）

**v1 错在哪**：control 从 scene 参数渲染「意图位置」剪影，target 却是纯文本生成
（人物落点由文本/随机决定，caption 只有 pose tag 没有位置词）。两者**位置/尺度不对齐**
（样本：control 右侧小人偶 vs target 居中大人），LLLite 学不到「control 位置→人物位置」
映射，loss 降到 unconditional 生成地板 ~0.136 就降不动。

**v2 怎么修**：control 从 **target 图里实际人物分割导出**（rembg isnet-anime 动漫分割模型
→ alpha 掩码 → 白剪影黑底，与 target 逐像素同尺寸），剪影↔成图天然对齐。这才是
ControlNet/Regional 的正确训练信号。**target 与 caption 复用，不重跑生成**（最贵的 8.5h 不浪费），
分割 1464 张 ~6min + 重训 2h。

```bash
# 装分割依赖（训练 venv）+ 下模型（hf-mirror，github 不通）
venv/bin/pip install rembg onnxruntime scipy
curl -sL https://hf-mirror.com/skytnt/anime-seg/resolve/main/isnetis.onnx -o ~/.u2net/isnet-anime.onnx
# 分割导出对齐 control（--test 先验 3 张掩码）
venv/bin/python segment-controls.py        # → dataset/768x1024/condition-v2/
# 重训（conditioning_data_dir 指向 condition-v2）
bash train-v2.sh
```

## 数据资产（入 git）

| 文件 | 说明 |
|---|---|
| `data/pose-tags-raw.json` | 打标原始产物（1199 条，核心资产，数小时 vision 打标结果） |
| `data/manifest.json` | 1464 训练对配方（scene/caption/位置/姿态索引，seed 20261115） |

control 图与 GPU 对照图体积大且可确定性重建，不入 git。

## 管线顺序

```
1. tag-poses.ts        姿态打标（vision 模型，断点续跑，每 50 张落盘）
                       → pose-tags-raw.json
2. build-dataset.py    分层采样 + 场景随机化 + control 渲染 + manifest
                       → train-regional/{control/, manifest.json}
3. gen-runner.py       GPU 批量生成对照图（WSL ComfyUI :8188，纯文本无区域条件）
                       → train-regional/image/
4. segment-controls.py 从 target 分割实际人物 → 对齐 control（v2 修正，替代意图渲染）
                       → dataset/768x1024/condition-v2/
5. 训练                target/ + condition-v2/ + caption/ 三件套喂 sd-scripts
```

## 运行环境依赖（不在本仓库，在工作区/WSL）

这些脚本在 **`/tmp/yugang-study/` 工作区**运行，依赖以下外部资产（脚本内路径指向工作区）：

- **RS 包**：`/tmp/yugang-study/rsconv/pkg/comfyui-rs-multicharacter-sampler`
  （`pose3d._rasterize(scene, control_maps=True)` 颜色区域渲染来源）
- **姿态库**：`/tmp/yugang-study/rsconv/out-lib/library.json`
  （open-pose-editor 1265 → 1199 有效 MHR 姿态转换产物）
- **姿态渲染图**：`/tmp/yugang-study/pose-renders/`（`render-poses.py` 产物，打标输入）
- **Python venv**：`/tmp/yugang-study/rsconv/venv`（含 PIL + RS 包依赖）
- `tag-poses.ts` 经 `npx tsx` 从仓库根运行，读 `config/models.json` 的 visionFallback 模型

> 工作区 `/tmp` 易失（重启清空）。核心打标数据与 manifest 已收进本目录 `data/` 保全；
> RS 包/姿态库/渲染图可由 open-pose-editor 与 RS 包重新转换渲染。

## 重建 control 图

```bash
cd /tmp/yugang-study
rsconv/venv/bin/python render-controls.py   # 从 manifest + 姿态库确定性重建 1464 张
```

## 全量重建数据集（确定性）

```bash
cd /tmp/yugang-study
rsconv/venv/bin/python build-dataset.py     # seed 20261115，复现同一批 1464 对
```
