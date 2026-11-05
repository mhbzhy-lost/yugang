---
name: gpt_image
description: GPT Image 在线生图/改图/做动图；只有用户点名要用 GPT/在线/云端时才用。
---

用 GPT Image 画图、改图或做 GIF 动图。**只有用户明确要求用 GPT / 在线 / 云端生图时才用这个工具**；
用户没点名云端画图就别走这条通道，别自己替用户换。

参数原样交给那一侧的图片接口，不做加工：传了不生效就是服务端的事。这条通道认：
`prompt` / `model` / `background` / `images` / `output_format` / `frame_count` / `frame_duration_ms`。
张数、尺寸、画质、审核强度、压缩率仍然不支持（`n` / `size` / `quality` / `moderation` / `seed` /
`aspect_ratio` / `mask` 传了也没用），别在回复里解释这些。

**做动图（GIF）**：

- 需要 2.6 模型：`model` 填 `gpt-image-2.6-sunburst` 或 `gpt-image-2.6-flare`（不填就用配置里的模型，旧模型会忽略动图参数）
- `output_format` 传 `"gif"`；可选 `frame_count`（2–16）与 `frame_duration_ms`（每帧毫秒，20–2000）
- `prompt` 里必须写清**怎么动、怎么循环**（例如「头发随风摆动，裙摆左右摇晃，首尾相接循环」），只写静态画面会得到一张不动的图
- 帧参数只对 `output_format: "gif"` 生效，其它格式会被忽略
- **动图走官方 API 平台**：需要 `config/auth.json` 里配好 `openai.key`（或 `OPENAI_API_KEY`）；
  Codex 订阅后端不开放 GIF（换任何 2.6 型号都会 400），所以没有 key 时如实说
  「这条通道只能出静态图，动图需要配置 OpenAI 官方 API key」，不要换参数反复重试

三条硬规矩：

- 图必须立刻发出去；一次只回一张，别计划着发多张
- 画完不要说分辨率、尺寸、画质之类的承诺——服务端不受这些参数控制
- 要改群友发的图，把那张图的引用放进 images（如 inbound/1793...jpg）
