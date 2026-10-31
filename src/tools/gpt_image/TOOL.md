---
name: gpt_image
description: GPT Image 在线生图/改图；只有用户点名要用 GPT/在线/云端时才用。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": {
        "type": "string",
        "description": "画面描述。写清主体、构图、风格；唯一必填项。想要竖版/横版就把构图写进去"
      },
      "model": {
        "type": "string",
        "description": "模型 id，不填就用 config/models.json 的 models.image；一般不用填"
      },
      "background": {
        "type": "string",
        "enum": ["auto", "transparent", "opaque"],
        "description": "auto / transparent / opaque；不填就是 auto。要透明底就传 transparent"
      },
      "images": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "maxItems": 5,
        "description": "参考图列表，写媒体目录下的路径（如 inbound/xxx.jpg、gen/xxx.png），最多 5 张；传了就是改图，不传是纯文生图"
      }
    },
    "required": ["prompt"]
  }
}
---end-tool-schema

用 GPT Image 画图或改图。**只有用户明确要求用 GPT / 在线 / 云端生图时才用这个工具**；
没提就老老实实用 draw 走本地显卡，别自己替用户换通道。

参数原样交给那一侧的图片接口，不做加工：传了不生效就是服务端的事。
这条通道只认 prompt / model / background / images 四项——张数、尺寸、画质、审核强度、
输出格式、压缩率都不支持（传了也没用），所以根本没开放这些参数，别在回复里解释它们。

三条硬规矩：

- 图必须立刻用 say 的 media 发出去；一次只回一张，别计划着发多张
- 画完不要说分辨率、尺寸、画质之类的承诺——服务端不受这些参数控制
- 要改群友发的图，把那张图的引用放进 images（如 inbound/1793...jpg）

mask、seed、aspect_ratio 这类参数同样不支持，别传。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。
