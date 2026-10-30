---
params:
  prompt: 画面描述。danbooru tag 为主（用 tags 工具查准词），可混自然语言，逗号分隔
  negative: 不要出现的东西，tag 写法，可留空。只对本地画图生效
  preset: 画风预设：default=通用动漫（默认）；hsr=崩坏星穹铁道画风。只对本地画图生效
  highres: 要高分辨率/大图/超分时传 true；默认 false 出普通图。只对本地画图生效
  engine: 生图通道。local=本地显卡 Stable Diffusion（默认）；gpt=在线 GPT Image 2。只有用户明确要求用在线/GPT 生图时才传 gpt
---

画一张图发出去。这是唯一的生图工具。

默认走本地：先在家里 Windows 显卡上用 Stable Diffusion 画，画不出来（机器关机、
排队超时、显存不够）会自动换在线 GPT Image 2 再出一张，对你来说就是「调一次，
拿到 gen/ 引用」。

只有用户明确说要「用 GPT 画」「用在线画」「用云端画」时才把 engine 传 gpt，
直接走在线那一路。别自己替用户换通道，也别在用户没提的时候解释通道。

prompt 写画面本身：想画得准就先 tags 查词，再拼 prompt。negative / preset /
highres 只有本地那一路认，走在线时会被忽略——所以别把关键信息只写在 negative 里。
用户提到高分辨率、大图、超分时 highres 传 true（更大也更慢）。

拿到 gen/ 引用后必须立刻用 say 的 media 参数发出去，只画不发等于白干。
一轮最多画一次；失败了不消耗次数，可以改描述重试。
