---
name: tags
description: 查 danbooru tag 的准确写法和热度；用 draw 画动漫图前先查词。
---
---tool-schema
{
  "parameters": {
    "type": "object",
    "properties": {
      "keyword": {
        "type": "string",
        "description": "英文关键词或猜的 tag，会自动转下划线匹配"
      }
    },
    "required": ["keyword"]
  }
}
---end-tool-schema

查 danbooru 词表：确认 tag 的准确写法和热度。画动漫图（draw 工具）前先查词，
中文概念自己翻成英文再来查（比如"猫耳"→ cat_ears）。

返回最热的十条，热度越高在 prompt 里越有效。查不到就换近义词。

这个工具是按需加载的：当前工具列表里没有它时，先用 tool_search 搜到并加载，
从下一次模型请求起才能调用。
