# Regional LLLite 3.8B 训练数据管线

单人位置控制（placement）的硬条件路线：自训 3.8B（DeltaMix V8，52 层）Regional LLLite
adapter，输入纯色人形区域图硬约束人物位置。方案与实验依据见
`docs/plans/2026-11-15-regional-38b-training.md` 与 `docs/plans/2026-11-15-single-pose-placement.md`
（E5–E9/E20 证死全部软引导后的唯一出路）。

## 当前进度（2026-11-16）

- **姿态打标完成**：1199 条，有效 1157（96.5%），产物 `data/pose-tags-raw.json`
- **训练对构造完成**：412 姿态 × 4 随机变体 → 掩码校验滤除出界 → **1464 对**，
  配方 `data/manifest.json`（`random.seed(20261115)` 确定性可复现）
- **control 区域图**：1464 张已由 `render-controls.py` 渲染（17MB，可由 manifest 确定性重建，
  不入 git；需要时按下方重建）
- **待办**：GPU 批量生成对照图（`gen-runner.py`，~1464 张 × ~15s ≈ 6h，等主人指定队列空闲窗口）
  → 训练（Sen-sou 参数起点，52 层配置参考归档的 v8 pose adapter）

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
4. 训练                image/ + control/ + caption/ 三件套喂 sd-scripts
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
