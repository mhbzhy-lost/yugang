# FORK.md —— comfyui-rs-multicharacter-sampler 分叉说明

## 唯一事实源

`experiments/anima-interaction-extension-v1/vendor/` 即 RS 插件的分叉完整源码树。
**今后所有改动直接改这里的文件**；部署 = 整目录复制到 ComfyUI/custom_nodes/comfyui-rs-multicharacter-sampler/。
不再维护 `experiments/anima-interaction-v1/patches/rs-img2img.patch`（仅留作历史 diff 记录，不再应用）。

## 上游

- raspie10032/ComfyUI_RS_MultiCharacter_Sampler @ 721d57ab98e80dc6854d4f49758bc9c456bb925c（冻结快照，2026-11 调研）
- 上游许可证随包（COPYING / LICENSE / THIRD_PARTY_NOTICES 等原样保留）。

## 分叉改动（相对上游）

1. `nodes.py`：RSMultiCharacterSampler 增加 `ALLOW_PIPE_POSE` 子类闸、`_initial_latent`（txt2img 零 latent 分支）与 `_sample_latent(..., noise_mask, denoise)` 钩子——为 img2img 子类提供起始点与掩码/强度通路。
2. `yugang_rs_img2img.py`（新增）：`YugangRSMaskedImg2Img`，区域身份隔离的局部重绘节点（接触修复用，已实测负结果，保留为工具箱）。
3. `__init__.py`：注册该节点。
4. 数值边界修复：`character_builder.py` slot_box 的 1e-9 → 1e-6 容差 + Finalize 的 box 中心严格不变量补偿（修 Windows 上归一化六舍五入把 left 压到 −5e-7 导致的拒采与 GBK 崩溃链）。

以上均以完整文件落在本目录，不再有“应用补丁”这一部署步骤。
