---
name: draw
description: 本地 Stable Diffusion 画图/改图，快且免费；出图后必须立刻用 say 发出。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": {
        "type": "string",
        "description": "画面描述。danbooru tag 为主（用 tags 工具查准词），可混自然语言，逗号分隔"
      },
      "negative": {
        "type": "string",
        "description": "不要出现的东西，tag 写法，可留空"
      },
      "preset": {
        "type": "string",
        "enum": ["default", "hsr", "secret"],
        "description": "画风预设：default=通用动漫（默认）；hsr=崩坏星穹铁道画风"
      },
      "highres": {
        "type": "boolean",
        "description": "要高分辨率/大图/超分时传 true；默认 false 出普通图，true 更大也更慢。只对从零画生效，带 ref 时忽略"
      },
      "ref": {
        "type": "string",
        "description": "要重画的初图：只能填这一轮消息里出现过的 inbound/…，或自己之前画出来的 gen/…；不填就是从零画"
      },
      "strength": {
        "type": "number",
        "description": "重画幅度 0.1–0.9，默认 0.45，只对改图生效"
      }
    },
    "required": ["prompt"]
  }
}
---end-tool-schema

在本地的 Windows 显卡上用 Stable Diffusion 画一张图发出去。这是本地生图通道：
快、免费、带画风预设，但机器关机或排队超时就会失败。

两种画法：
- 从零画：不填 ref，按 prompt 描述直接画。
- 改图：填 ref，prompt 写「想要的样子」，不用复述原图。strength 0.3 左右只换
  画风/保构图，0.6 以上改动大，默认 0.45。ref 只认这一轮消息里出现过的
  inbound/… 和自己画过的 gen/…，别的路径会被拒；透明底会被填成灰底。

看不到图的内容就别猜原图长什么样，要看先 look。

失败时直接把错误告诉用户、可以改描述重试，不要自己换成别的工具、也不要假装画好了。
用户明确要「用 GPT / 在线 / 云端画」时用 gpt_image，不是这里。

prompt 写画面本身：想画得准就先 tags 查词，再拼 prompt。拿到 gen/ 引用后必须
立刻用 say 的 media 参数发出去，只画不发等于白干。
一轮最多画一次；失败了不消耗次数。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。
