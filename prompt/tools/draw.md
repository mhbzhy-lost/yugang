---
params:
  prompt: 画面描述。danbooru tag 为主（用 tags 工具查准词），可混自然语言，逗号分隔
  negative: 不要出现的东西，tag 写法，可留空
  preset: 画风预设：default=通用动漫（默认）；hsr=崩坏星穹铁道画风
---

用家里 Windows 显卡上的 Stable Diffusion 画一张图。

preset 选画风：默认通用动漫；要崩铁角色/画风时用 hsr；要神秘预设时选 secret。
尺寸、采样、步数都是定好的，不用管。画完拿到 gen/ 引用后必须立刻
用 say 的 media 参数发出去。一轮最多画一次；Windows 关机或超时就
改用 imggen。想画得准：先 tags 查词，再拼 prompt。
