---
name: draw
description: 本地 Stable Diffusion 画图/改图，快且免费；出图后必须立刻发出。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": {
        "type": "string",
        "description": "画面描述。danbooru tag 为主（先查词表拿准词），可混自然语言，逗号分隔"
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

---tool-messages
draw_prompt: 画面描述得有内容，1000 字以内
draw_used: 这轮画过了，先把画发出去
draw_failed: 画图没成功（本地和备用通道都没出图）
draw_done: gen/{{file}} — 画好了，用 say_media 发出去
draw_off: 本地画图没配置地址，用不了
draw_ref_outside: 只能改这一轮群里的图（inbound/…）或你自己画过的图（gen/…）：{{ref}}
draw_ref_missing: 找不到这张图：{{ref}}
draw_ref_type: 这张不是能重画的图片格式：{{ref}}
draw_ref_big: 这张图太大，改不动：{{ref}}
draw_ref_broken: 这张图读不出来（格式坏了或者转换失败）：{{ref}}
draw_strength: 重画幅度只能在 0.1 到 0.9 之间
---end-tool-messages

在本地的 Windows 显卡上用 Stable Diffusion 画一张图发出去。这是本地生图通道：
快、免费、带画风预设，但机器关机或排队超时就会失败。

两种画法：
- 从零画：不填 ref，按 prompt 描述直接画。
- 改图：填 ref，prompt 写「想要的样子」，不用复述原图。strength 0.3 左右只换
  画风/保构图，0.6 以上改动大，默认 0.45。ref 只认这一轮消息里出现过的
  inbound/… 和自己画过的 gen/…，别的路径会被拒；透明底会被填成灰底。

看不到图的内容就别猜原图长什么样。

失败时直接把错误告诉用户、可以改描述重试，不要自己换成别的工具、也不要假装画好了。
这里只走本地显卡；用户点名云端/在线画图时不在此处。

prompt 写画面本身：想画得准就先查词表，再拼 prompt。拿到 gen/ 引用后必须
立刻把图发出去，只画不发等于白干。
一轮最多画一次；失败了不消耗次数。
