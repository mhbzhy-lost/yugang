---
name: model
description: 查看或切换各类能力使用的模型（main/vision/image）；只有主人能切换，改完要 restart。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["list", "switch"],
        "description": "list 看当前角色和可用模型；switch 切换某个角色的模型"
      },
      "role": {
        "type": "string",
        "enum": ["main", "vision", "image"],
        "description": "switch 必填：main 主对话 / vision 看图看视频 / image 在线画图"
      },
      "provider": {
        "type": "string",
        "description": "switch 必填：config/models.json 里 providers 的名字"
      },
      "model": {
        "type": "string",
        "description": "switch 必填：该 provider 下的模型 id；image 可写任意图片模型名"
      }
    },
    "required": ["action"]
  }
}
---end-tool-schema

查看和切换你自己各类能力使用的模型。

只在主人明确要求换模型时用；`list` 可以随时看。切换只改 `config/models.json` 的
`models` 角色表，写完要 `restart` 才生效。provider 与 model 必须来自 `list` 的结果，
别自己拼一个不存在的名字。image 是图片通道，模型名不校验。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。
