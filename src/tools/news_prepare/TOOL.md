---
name: news_prepare
description: 在新闻准备轮提交你挑选并改写的新闻，不直接发群消息。
---

只有输入是新闻准备任务时才能使用。先用 tool_search 搜索“新闻”加载本工具，再按候选清单独立选材。

- sections 必须覆盖输入中的全部 topic，顺序一致；不值得播报的 topic 使用空 items。
- 每条 summary 不超过 60 字，用自己的话概括；sourceRef 只能填同一 topic 候选的方括号编号。
- 全篇 sourceRef 不得重复，每个 topic 不超过任务给出的条数上限。
- closing 不超过 30 字，自然收尾；摘要和收尾都不要写 URL、来源名或额外字段。
- 本工具只保存备料结果。不要调用 say_words、say_media、say_meme 或 say_voice，宿主会按时发布。
