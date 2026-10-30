---
params:
  prompt: 画面描述。danbooru tag 为主（用 tags 工具查准词），可混自然语言，逗号分隔
  negative: 不要出现的东西，tag 写法，可留空
  preset: 画风预设：default=通用动漫（默认）；hsr=崩坏星穹铁道画风
  highres: 要高分辨率/大图/超分时传 true；默认 false 出普通图，true 更大也更慢
---

在家里的 Windows 显卡上用 Stable Diffusion 画一张图发出去。这是本地生图通道：
快、免费、带画风预设，但机器关机或排队超时就会失败。

失败时直接把错误告诉用户、可以改描述重试，不要自己换成别的工具、也不要假装画好了。
用户明确要「用 GPT / 在线 / 云端画」时用 gpt_image，不是这里。

prompt 写画面本身：想画得准就先 tags 查词，再拼 prompt。拿到 gen/ 引用后必须
立刻用 say 的 media 参数发出去，只画不发等于白干。
一轮最多画一次；失败了不消耗次数。
