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

---tool-messages
tags_empty: 词表还没就绪或关键词为空
tags_none: 词表里没有「{{keyword}}」，换英文关键词试试
---end-tool-messages

查 danbooru 词表：确认 tag 的准确写法和热度。画动漫图（draw 工具）前先查词，
中文概念自己翻成英文再来查（比如"猫耳"→ cat_ears）。

返回最热的十条，热度越高在 prompt 里越有效。查不到就换近义词。
