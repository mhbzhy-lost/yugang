---
params:
  prompt: 画面描述。danbooru tag 为主（用 tags 工具查准词），可混自然语言，逗号分隔
  negative: 不要出现的东西，tag 写法，可留空。只对本地画图生效
  preset: 画风预设：default=通用动漫（默认）；hsr=崩坏星穹铁道画风。只对本地画图生效
  highres: 要高分辨率/大图/超分时传 true；默认 false 出普通图。只对本地画图生效
---

画一张图发出去。这是唯一的生图工具，你不用挑通道：先在家里 Windows 显卡上
用 Stable Diffusion 画，画不出来（机器关机、排队超时、显存不够）会自动换成
在线模型服务再出一张，对你来说就是「调一次，拿到 gen/ 引用」。

prompt 写画面本身：想画得准就先 tags 查词，再拼 prompt。negative / preset /
highres 只有本地那一路认，兜底到在线模型时会被忽略——所以别把关键信息只写在
negative 里。用户提到高分辨率、大图、超分时 highres 传 true（更大也更慢）。

拿到 gen/ 引用后必须立刻用 say 的 media 参数发出去，只画不发等于白干。
一轮最多画一次；失败了不消耗次数，可以改描述重试。
