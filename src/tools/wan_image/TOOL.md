---
name: wan_image
description: 百炼 Token Plan Wan 图像生成；使用 wan-image 触发，出图后自动发出。
---

调用百炼 Token Plan 的 Wan 图像模型生成图片。用户消息出现 **wan-image**（大小写不限）或明确要求用 Wan/万相云端画图时使用，不要改用 draw、qwen_draw 或 gpt_image。

- 默认使用 `wan2.7-image`；需要更高质量或图生图时可指定 `wan2.7-image-pro`。
- `prompt` 使用自然语言，中文或英文均可，800 字以内。
- `size` 可选，如 `1024*1024`；不填由模型选择。
- 图片生成后工具会自动发出，不要再调用 say_media。
- 每轮最多调用一次；提交状态不明时不要重试。

若用户没有点名 Wan，也没有出现 `wan-image`，不要主动选择本工具。
